'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, nativeTheme } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const settings = require('./settings');
const ws = require('./workspace');
const ai = require('./ai');
const agent = require('./agent');
const terminal = require('./terminal');
const { defaultManager: bg } = require('./bgproc');
const { platformInfo } = require('./platform');

const APP_ROOT = path.join(__dirname, '..', '..');
const SERVE_ALLOW = ['src/renderer/', 'node_modules/monaco-editor/', 'node_modules/@xterm/', 'node_modules/marked/', 'node_modules/dompurify/', 'build/'];
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let root = null;
let allowClose = false;
const runs = new Map(); // runId -> AbortController
const approvals = new Map(); // approvalId -> resolve
const watchers = new Map(); // dir -> FSWatcher
let completionAbort = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function aiConfig(override) {
  const s = settings.load();
  return { ...s, ...(override || {}) };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  const s = settings.load();
  nativeTheme.themeSource = s.theme === 'light' ? 'light' : 'dark';
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Cursor Clone',
    backgroundColor: s.theme === 'light' ? '#ffffff' : '#181818',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://bundle/src/renderer/index.html');

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F12' || (ctrl && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    send('app:beforeClose'); // renderer asks about unsaved files, then calls app:closeConfirmed
  });
  win.webContents.on('render-process-gone', () => {
    allowClose = true;
  });
  win.on('closed', () => {
    win = null;
  });
  buildMenu();
}

function buildMenu() {
  const cmd = (label, command, accelerator, extra = {}) => ({
    label, accelerator, registerAccelerator: false, click: () => send('menu', command), ...extra,
  });
  const recent = settings.load().recentFolders.map((f) => ({ label: f, click: () => send('menu', { cmd: 'openRecent', path: f }) }));
  const template = [
    {
      label: '&File',
      submenu: [
        cmd('New File', 'newFile', 'CmdOrCtrl+N'),
        cmd('Open Folder...', 'openFolder', 'CmdOrCtrl+Shift+O'),
        cmd('Open File...', 'openFile', 'CmdOrCtrl+O'),
        { label: 'Open Recent', submenu: recent.length ? recent : [{ label: '(none)', enabled: false }] },
        { type: 'separator' },
        cmd('Save', 'save', 'CmdOrCtrl+S'),
        cmd('Save All', 'saveAll', 'CmdOrCtrl+Alt+S'),
        cmd('Close Editor', 'closeTab', 'CmdOrCtrl+W'),
        cmd('Close Folder', 'closeFolder'),
        { type: 'separator' },
        cmd('Settings', 'settings', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { label: 'Exit', accelerator: process.platform === 'win32' ? 'Alt+F4' : 'CmdOrCtrl+Q', click: () => win && win.close() },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        cmd('Undo', 'undo', 'CmdOrCtrl+Z'),
        cmd('Redo', 'redo', 'CmdOrCtrl+Y'),
        { type: 'separator' },
        { role: 'cut', registerAccelerator: false },
        { role: 'copy', registerAccelerator: false },
        { role: 'paste', registerAccelerator: false },
        { type: 'separator' },
        cmd('Find', 'find', 'CmdOrCtrl+F'),
        cmd('Replace', 'replace', 'CmdOrCtrl+H'),
        cmd('Find in Files', 'searchFiles', 'CmdOrCtrl+Shift+F'),
      ],
    },
    {
      label: '&View',
      submenu: [
        cmd('Command Palette...', 'commandPalette', 'CmdOrCtrl+Shift+P'),
        cmd('Go to File...', 'quickOpen', 'CmdOrCtrl+P'),
        { type: 'separator' },
        cmd('Toggle Sidebar', 'toggleSidebar', 'CmdOrCtrl+B'),
        cmd('Toggle AI Chat', 'toggleChat', 'CmdOrCtrl+L'),
        cmd('Toggle Terminal', 'toggleTerminal', 'CmdOrCtrl+`'),
        { type: 'separator' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { role: 'togglefullscreen' },
        { label: 'Toggle Developer Tools', accelerator: 'F12', registerAccelerator: false, click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    {
      label: '&AI',
      submenu: [
        cmd('Open Chat', 'toggleChat', 'CmdOrCtrl+L'),
        cmd('New Chat', 'newChat', 'CmdOrCtrl+Shift+L'),
        cmd('Inline Edit (Selection)', 'inlineEdit', 'CmdOrCtrl+K'),
        cmd('Toggle Autocomplete', 'toggleAutocomplete'),
        { type: 'separator' },
        cmd('AI Settings...', 'settings'),
      ],
    },
    {
      label: '&Terminal',
      submenu: [cmd('New Terminal', 'newTerminal', 'CmdOrCtrl+Shift+`'), cmd('Kill Terminal', 'killTerminal')],
    },
    {
      label: '&Help',
      submenu: [
        cmd('Keyboard Shortcuts', 'shortcuts'),
        { label: 'About', click: () => dialog.showMessageBox(win, { type: 'info', title: 'About', message: `Cursor Clone ${app.getVersion()}`, detail: `An open-source AI code editor for any OpenAI-compatible API.\nElectron ${process.versions.electron} · ${process.platform} ${process.arch}` }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------
async function openWorkspace(dir) {
  const abs = path.resolve(dir);
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw new Error(`${abs} is not a folder`);
  closeWatchers();
  if (root !== abs) await bg.reset(); // background processes belong to the old folder
  root = abs;
  settings.addRecentFolder(abs);
  buildMenu();
  if (win) win.setTitle(`${path.basename(abs)} — Cursor Clone`);
  return abs;
}

function closeWatchers() {
  for (const w of watchers.values()) { try { w.close(); } catch { /* ignore */ } }
  watchers.clear();
}

function watchDirs(dirs) {
  const wanted = new Set(dirs);
  for (const [d, w] of watchers) {
    if (!wanted.has(d)) { try { w.close(); } catch { /* ignore */ } watchers.delete(d); }
  }
  for (const d of wanted) {
    if (watchers.has(d)) continue;
    try {
      let timer = null;
      const names = new Set();
      const w = fs.watch(d, { persistent: false }, (_ev, filename) => {
        if (filename) names.add(filename.toString());
        clearTimeout(timer);
        timer = setTimeout(() => {
          send('fs:changed', { dir: d, files: [...names].map((n) => path.join(d, n)) });
          names.clear();
        }, 200);
      });
      w.on('error', () => { try { w.close(); } catch { /* ignore */ } watchers.delete(d); });
      watchers.set(d, w);
    } catch { /* dir vanished or no permission */ }
  }
}

function initialFolderFromArgs() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && a !== '.');
  for (const a of args) {
    try { if (fs.statSync(a).isDirectory()) return path.resolve(a); } catch { /* not a dir */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function handle(channel, fnc) {
  ipcMain.handle(channel, async (_e, ...args) => fnc(...args));
}

// Forward background-process events to the UI (foreground agent commands stay hidden).
bg.on('output', (ev) => { if (!ev.hidden) send('bg:output', { id: ev.id, text: ev.text }); });
bg.on('status', (info) => send('bg:status', info));
bg.on('exit', (info) => send('bg:exit', info));
bg.on('removed', (ev) => send('bg:removed', ev));

function registerIpc() {
  handle('app:info', () => ({
    ...platformInfo(),
    version: app.getVersion(),
    electron: process.versions.electron,
    hasPty: terminal.hasPty(),
    canEncrypt: settings.canEncrypt(),
    root,
    initialFolder: initialFolderFromArgs(),
  }));
  ipcMain.on('app:closeConfirmed', () => {
    allowClose = true;
    if (win) win.close();
  });
  handle('app:setTitle', (t) => win && win.setTitle(t));
  handle('settings:get', () => settings.load());
  handle('settings:set', (partial) => {
    const s = settings.save(partial || {});
    if (partial && partial.theme) nativeTheme.themeSource = partial.theme === 'light' ? 'light' : 'dark';
    return s;
  });

  handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:saveAs', async (defaultPath) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultPath || root || undefined });
    return r.canceled ? null : r.filePath;
  });
  handle('dialog:confirm', async ({ message, detail, buttons }) => {
    const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons || ['OK', 'Cancel']).length - 1, noLink: true });
    return r.response;
  });

  handle('workspace:open', (dir) => openWorkspace(dir));
  handle('workspace:close', async () => { await bg.reset(); root = null; closeWatchers(); if (win) win.setTitle('Cursor Clone'); return null; });
  handle('workspace:root', () => root);

  handle('fs:readDir', (dir) => ws.readDir(dir));
  handle('fs:readFile', (p) => ws.readText(p));
  handle('fs:writeFile', (p, content) => ws.writeText(p, content));
  handle('fs:createFile', async (p) => {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, '', { flag: 'wx' });
  });
  handle('fs:createDir', (p) => fsp.mkdir(p, { recursive: true }));
  handle('fs:rename', async (from, to) => {
    if (await ws.exists(to)) throw new Error(`${path.basename(to)} already exists`);
    await fsp.rename(from, to);
  });
  handle('fs:delete', async (p) => {
    try { await shell.trashItem(p); } catch { await fsp.rm(p, { recursive: true, force: true }); }
  });
  handle('fs:exists', (p) => ws.exists(p));
  handle('fs:stat', async (p) => { const s = await fsp.stat(p); return { isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs }; });
  handle('fs:listFiles', () => (root ? ws.listFiles(root) : []));
  handle('fs:search', (query, opts) => (root ? ws.searchText(root, query, opts || {}) : { results: [], truncated: false }));
  handle('fs:watch', (dirs) => watchDirs(Array.isArray(dirs) ? dirs : []));
  handle('path:join', (...parts) => path.join(...parts));
  handle('path:relative', (from, to) => path.relative(from, to));

  // ---- AI -----------------------------------------------------------------
  handle('ai:chat', async (runId, payload) => {
    const ctrl = new AbortController();
    runs.set(runId, ctrl);
    const emit = (ev) => send('ai:event', { runId, ...ev });
    let approvalSeq = 0;
    const requestApproval = (req) => new Promise((resolve) => {
      const approvalId = `${runId}:${++approvalSeq}`;
      approvals.set(approvalId, resolve);
      const onAbort = () => { if (approvals.delete(approvalId)) resolve({ approved: false, feedback: 'Run was cancelled.' }); };
      ctrl.signal.addEventListener('abort', onAbort, { once: true });
      emit({ type: 'approval', approvalId, ...req });
    });
    try {
      const result = await agent.runChat({
        cfg: aiConfig(payload.cfg),
        mode: payload.mode,
        messages: payload.messages,
        context: payload.context,
        overlays: payload.overlays || {},
        root,
        signal: ctrl.signal,
        emit,
        requestApproval,
        bg,
        prefs: () => settings.load(),
      });
      return result;
    } catch (e) {
      return { error: e.message || String(e), messages: e.partial ? e.partial.messages : [], changes: e.partial ? e.partial.changes : [] };
    } finally {
      runs.delete(runId);
    }
  });
  handle('ai:cancel', (runId) => {
    const c = runs.get(runId);
    if (c) c.abort();
  });
  handle('ai:approve', (approvalId, decision) => {
    const r = approvals.get(approvalId);
    if (r) {
      approvals.delete(approvalId);
      r(decision);
    }
  });
  handle('ai:complete', async (req) => {
    if (completionAbort) completionAbort.abort();
    const ctrl = new AbortController();
    completionAbort = ctrl;
    try {
      const text = await ai.completeCode(aiConfig(), { ...req, signal: ctrl.signal });
      return { text };
    } catch (e) {
      if (ctrl.signal.aborted) return { text: '', cancelled: true };
      return { text: '', error: e.message };
    }
  });
  handle('ai:cancelComplete', () => { if (completionAbort) completionAbort.abort(); });
  handle('ai:models', (override) => ai.listModels(aiConfig(override)));
  handle('ai:test', async (override) => {
    const cfg = aiConfig(override);
    const t0 = Date.now();
    const r = await ai.chatOnce(cfg, { messages: [{ role: 'user', content: 'Reply with the single word: OK' }], maxTokens: 20, temperature: 0 });
    return { ok: true, reply: (r && r.content) || '', ms: Date.now() - t0 };
  });
  handle('ai:revert', async (changes) => {
    for (const c of changes || []) {
      if (root && !ws.isInside(root, c.path)) continue;
      if (c.before == null) await fsp.rm(c.path, { force: true });
      else await ws.writeText(c.path, c.before);
    }
    return true;
  });

  // ---- Background processes -------------------------------------------------
  handle('bg:list', () => bg.list());
  handle('bg:start', (command) => bg.start(String(command || ''), { cwd: root || require('os').homedir(), origin: 'user' }));
  handle('bg:stop', (id) => bg.stop(id));
  handle('bg:restart', (id) => bg.restart(id));
  handle('bg:remove', (id) => bg.remove(id));
  handle('bg:detach', (id) => bg.detach(id, 'user'));
  handle('bg:output', (id) => bg.output(id));

  // ---- Terminal -------------------------------------------------------------
  handle('term:create', (opts) => terminal.create({ ...(opts || {}), cwd: (opts && opts.cwd) || root || require('os').homedir(), shell: settings.load().terminalShell }, send));
  ipcMain.on('term:write', (_e, id, data) => terminal.write(id, data));
  ipcMain.on('term:resize', (_e, id, cols, rows) => terminal.resize(id, cols, rows));
  handle('term:kill', (id) => terminal.kill(id));

  handle('shell:openExternal', (url) => { if (/^https?:\/\//i.test(url)) return shell.openExternal(url); });
  handle('shell:showItemInFolder', (p) => shell.showItemInFolder(p));
  handle('shell:openPath', (p) => shell.openPath(p));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && process.env.CURSOR_CLONE_MULTI !== '1') {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle('app', async (req) => {
      const url = new URL(req.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.normalize(path.join(APP_ROOT, rel));
      const relCheck = ws.toPosix(path.relative(APP_ROOT, file));
      if (!ws.isInside(APP_ROOT, file) || !SERVE_ALLOW.some((p) => relCheck.startsWith(p))) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const data = await fsp.readFile(file);
        return new Response(data, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    registerIpc();
    createWindow();
  });

  app.on('before-quit', () => bg.stopAll());
  app.on('window-all-closed', () => {
    bg.stopAll();
    terminal.killAll();
    for (const c of runs.values()) c.abort();
    app.quit();
  });
}
