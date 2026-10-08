// App bootstrap: wires the editor, explorer, chat, terminal, commands and keybindings together.
import { $, $$, h, basename, relativePath, toast, quickPick, contextMenu, setStatus } from './util.js';
import { loadMonaco, Editors } from './editor.js';
import { Explorer } from './explorer.js';
import { SearchView } from './search.js';
import { Chat } from './chat.js';
import { InlineAI } from './inline.js';
import { TerminalPanel } from './terminal.js';
import { ProcessesView } from './processes.js';
import { openSettings } from './settings.js';

const app = {
  root: null,
  settings: null,
  info: null,
  monaco: null,
  quickOpenCache: null,
  lastFocus: 'editor',
  ui: { contextMenu, quickPick },
};
window.__app = app; // handy for debugging from DevTools

// ------------------------------------------------------------------ layout
const layout = {
  load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('layout') || '{}'); } catch { /* ignore */ }
    this.state = { sidebar: true, chat: true, panel: false, sidebarW: 260, chatW: 420, panelH: 260, ...saved };
    this.apply();
  },
  save() { try { localStorage.setItem('layout', JSON.stringify(this.state)); } catch { /* ignore */ } },
  apply() {
    const st = this.state;
    document.body.classList.toggle('no-sidebar', !st.sidebar);
    document.body.classList.toggle('show-chat', st.chat);
    document.body.classList.toggle('show-panel', st.panel);
    $('#act-chat').classList.toggle('active', st.chat);
    const r = document.documentElement.style;
    r.setProperty('--sidebar-w', `${st.sidebarW}px`);
    r.setProperty('--chat-w', `${st.chatW}px`);
    r.setProperty('--panel-h', `${st.panelH}px`);
    if (app.terminal) requestAnimationFrame(() => app.terminal.fit());
  },
  toggleSidebar(on = !this.state.sidebar) { this.state.sidebar = on; this.apply(); this.save(); },
  toggleChat(on = !this.state.chat) { this.state.chat = on; this.apply(); this.save(); if (on) setTimeout(() => app.chat.focus(), 0); },
  togglePanel(on = !this.state.panel) { this.state.panel = on; this.apply(); this.save(); },
  showView(name) {
    this.toggleSidebar(true);
    $$('#activitybar .act[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('#sidebar .view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  },
  initResizers() {
    const drag = (el, onMove, cls) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        el.classList.add('dragging');
        document.body.classList.add(cls);
        const move = (ev) => { onMove(ev); this.apply(); };
        const up = () => {
          el.classList.remove('dragging');
          document.body.classList.remove(cls);
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          this.save();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    };
    drag($('#resize-sidebar'), (e) => { this.state.sidebarW = Math.max(160, Math.min(600, e.clientX - 46)); }, 'resizing');
    drag($('#resize-chat'), (e) => { this.state.chatW = Math.max(300, Math.min(window.innerWidth - 400, window.innerWidth - e.clientX)); }, 'resizing');
    drag($('#resize-panel'), (e) => {
      const main = $('#main').getBoundingClientRect();
      this.state.panelH = Math.max(80, Math.min(main.height - 120, main.bottom - e.clientY));
    }, 'resizing-row');
  },
};
app.layout = layout;

// ------------------------------------------------------------------ settings
app.saveSettings = async (partial) => {
  app.settings = await window.api.settings.set(partial);
  document.body.classList.toggle('light', app.settings.theme === 'light');
  app.editors?.applySettings(app.settings);
  app.terminal?.applyTheme(app.settings.theme);
  app.inline?.updateStatus();
  if (app.chat) app.chat.syncModelPicker();
  else updateModelStatus();
  return app.settings;
};
app.openSettings = () => openSettings(app);

function updateModelStatus() {
  const s = app.settings;
  const model = (app.chat && app.chat.currentModel()) || s.model || 'no model';
  let host = s.baseURL;
  try { host = new URL(s.baseURL).host; } catch { /* keep raw */ }
  $('#status-model').textContent = `⚙ ${model} @ ${host}`;
}
app.updateModelStatus = updateModelStatus;

const cleanIpcError = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Models supported by the API (GET /models), cached per endpoint.
 * `override` lets the Settings dialog query unsaved connection details.
 */
let modelCache = null;
app.loadModels = async (force = false, override = null) => {
  const s = { ...app.settings, ...(override || {}) };
  const key = `${s.baseURL}|${s.apiKey}|${JSON.stringify(s.extraHeaders || {})}`;
  if (!force && modelCache && modelCache.key === key) return { models: modelCache.models };
  try {
    const models = await window.api.ai.models(override || undefined);
    modelCache = { key, models };
    if (!override) app.settings = await window.api.settings.set({ modelList: models });
    return { models };
  } catch (e) {
    const sameEndpoint = !override || override.baseURL === app.settings.baseURL;
    return { models: sameEndpoint ? app.settings.modelList || [] : [], error: cleanIpcError(e) };
  }
};

// ------------------------------------------------------------------ workspace
app.allFiles = async () => {
  if (!app.root) return [];
  if (!app.quickOpenCache) app.quickOpenCache = window.api.fs.listFiles();
  return app.quickOpenCache;
};

async function openFolder(dir) {
  if (!dir) dir = await window.api.dialog.openFolder();
  if (!dir) return;
  if (app.editors && !(await app.editors.confirmDirty(app.editors.tabs))) return;
  if (app.processes && app.root && dir !== app.root && !(await app.processes.confirmStopAll('Opening another folder'))) return;
  try {
    dir = await window.api.workspace.open(dir);
  } catch (e) {
    toast(`Cannot open folder: ${e.message}`, 'error');
    return;
  }
  for (const t of [...app.editors.tabs]) app.editors.removeTab(t);
  app.terminal.killAll();
  layout.togglePanel(false);
  app.root = dir;
  app.quickOpenCache = null;
  await app.explorer.setRoot(dir);
  $('#status-folder').textContent = `📁 ${basename(dir)}`;
  app.chat.loadAll();
  app.settings = await window.api.settings.get();
  renderRecent();
  restoreOpenTabs();
}

async function closeFolder() {
  if (!(await app.editors.confirmDirty(app.editors.tabs))) return;
  if (!(await app.processes.confirmStopAll('Closing the folder'))) return;
  for (const t of [...app.editors.tabs]) app.editors.removeTab(t);
  await window.api.workspace.close();
  app.root = null;
  app.quickOpenCache = null;
  await app.explorer.setRoot(null);
  $('#status-folder').textContent = '';
  app.chat.loadAll();
  renderRecent();
}

function saveOpenTabs() {
  if (!app.root) return;
  const tabs = app.editors.tabs.filter((t) => t.path).map((t) => t.path);
  const active = app.editors.getActive()?.path || null;
  try { localStorage.setItem(`tabs:${app.root}`, JSON.stringify({ tabs, active })); } catch { /* ignore */ }
}

async function restoreOpenTabs() {
  let st = null;
  try { st = JSON.parse(localStorage.getItem(`tabs:${app.root}`) || 'null'); } catch { /* ignore */ }
  if (!st) return;
  for (const p of st.tabs || []) {
    if (await window.api.fs.exists(p)) await app.editors.open(p, { focus: false });
  }
  if (st.active && app.editors.find(st.active)) app.editors.activate(app.editors.find(st.active), false);
}

function renderRecent() {
  const box = $('#recent-list');
  box.innerHTML = '';
  const list = (app.settings.recentFolders || []).slice(0, 8);
  if (!list.length) return;
  box.append(h('h4', {}, 'RECENT'));
  for (const f of list) box.append(h('div', { class: 'recent', title: f, onclick: () => openFolder(f) }, f));
}

async function openFiles() {
  const files = await window.api.dialog.openFile();
  for (const f of files) await app.editors.open(f);
}

async function quickOpen() {
  if (!app.root) { openFolder(); return; }
  const files = await app.allFiles();
  const items = files.map((p) => {
    const rel = relativePath(app.root, p);
    return { label: basename(p), description: rel, rel, value: p };
  });
  const pick = await quickPick({ placeholder: 'Search files by name', items, matchOn: (it) => it.rel });
  if (pick) app.editors.open(pick, { preview: false });
}

// ------------------------------------------------------------------ commands
const commands = [
  { id: 'openFolder', label: 'File: Open Folder…', kb: 'Ctrl+Shift+O', run: () => openFolder() },
  { id: 'openFile', label: 'File: Open File…', kb: 'Ctrl+O', run: openFiles },
  { id: 'newFile', label: 'File: New File', kb: 'Ctrl+N', run: () => (app.root ? app.explorer.newFile() : app.editors.newUntitled()) },
  { id: 'newUntitled', label: 'File: New Untitled File', run: () => app.editors.newUntitled() },
  { id: 'save', label: 'File: Save', kb: 'Ctrl+S', run: () => app.editors.save() },
  { id: 'saveAs', label: 'File: Save As…', kb: 'Ctrl+Shift+S', run: () => app.editors.saveAs() },
  { id: 'saveAll', label: 'File: Save All', kb: 'Ctrl+Alt+S', run: () => app.editors.saveAll() },
  { id: 'closeTab', label: 'View: Close Editor', kb: 'Ctrl+W', run: () => app.editors.close() },
  { id: 'closeFolder', label: 'File: Close Folder', run: closeFolder },
  { id: 'quickOpen', label: 'Go to File…', kb: 'Ctrl+P', run: quickOpen },
  { id: 'commandPalette', label: 'Show All Commands', kb: 'Ctrl+Shift+P', run: () => commandPalette() },
  { id: 'toggleSidebar', label: 'View: Toggle Sidebar', kb: 'Ctrl+B', run: () => layout.toggleSidebar() },
  { id: 'toggleChat', label: 'AI: Toggle Chat (adds selection)', kb: 'Ctrl+L', run: () => toggleChatWithSelection() },
  { id: 'newChat', label: 'AI: New Chat', kb: 'Ctrl+Shift+L', run: () => { layout.toggleChat(true); app.chat.newChat(); } },
  { id: 'inlineEdit', label: 'AI: Inline Edit / Generate', kb: 'Ctrl+K', run: () => app.inline.start() },
  { id: 'toggleAutocomplete', label: 'AI: Toggle Tab Autocomplete', run: () => app.inline.toggleAutocomplete() },
  { id: 'agentMode', label: 'AI: Switch to Agent Mode', run: () => { app.chat.setMode('agent'); layout.toggleChat(true); } },
  { id: 'planMode', label: 'AI: Switch to Plan Mode', run: () => { app.chat.setMode('plan'); layout.toggleChat(true); } },
  { id: 'askMode', label: 'AI: Switch to Ask Mode', run: () => { app.chat.setMode('ask'); layout.toggleChat(true); } },
  { id: 'pickModel', label: 'AI: Choose Model for This Chat…', run: () => { layout.toggleChat(true); app.chat.modelPicker.input.focus(); app.chat.modelPicker.open(); } },
  { id: 'terminalToChat', label: 'AI: Add Terminal Output to Chat', run: () => terminalToChat() },
  { id: 'explainFile', label: 'AI: Explain Current File', run: () => quickPrompt('Explain what this file does, its key parts, and anything notable.', 'ask') },
  { id: 'findBugs', label: 'AI: Find Bugs in Current File', run: () => quickPrompt('Review this file for bugs, edge cases and security issues. List concrete problems with line references.', 'ask') },
  { id: 'writeTests', label: 'AI: Write Tests for Current File', run: () => quickPrompt('Write unit tests for this file using the project\'s existing test framework (detect it). Create the test file(s).', 'agent') },
  { id: 'toggleTerminal', label: 'View: Toggle Terminal', kb: 'Ctrl+`', run: () => toggleTerminal() },
  { id: 'newTerminal', label: 'Terminal: New Terminal', kb: 'Ctrl+Shift+`', run: () => app.terminal.create() },
  { id: 'killTerminal', label: 'Terminal: Kill Terminal', run: () => app.terminal.kill() },
  { id: 'runBackground', label: 'Background: Run Command in Background…', run: () => app.processes.runInBackground() },
  { id: 'showProcesses', label: 'Background: Show Processes', run: () => app.processes.show('processes') },
  { id: 'searchFiles', label: 'Search: Find in Files', kb: 'Ctrl+Shift+F', run: () => { layout.showView('search'); app.search.focus(app.editors.selectionInfo()?.text?.split('\n')[0]); } },
  { id: 'showExplorer', label: 'View: Show Explorer', kb: 'Ctrl+Shift+E', run: () => { layout.showView('explorer'); app.explorer.el.focus(); } },
  { id: 'revealFile', label: 'File: Reveal Active File in Explorer', run: () => { const t = app.editors.getActive(); if (t?.path) { layout.showView('explorer'); app.explorer.reveal(t.path); } } },
  { id: 'find', label: 'Edit: Find', kb: 'Ctrl+F', run: () => editorAction('actions.find') },
  { id: 'replace', label: 'Edit: Replace', kb: 'Ctrl+H', run: () => editorAction('editor.action.startFindReplaceAction') },
  { id: 'gotoLine', label: 'Go to Line…', kb: 'Ctrl+G', run: () => editorAction('editor.action.gotoLine') },
  { id: 'format', label: 'Format Document', kb: 'Shift+Alt+F', run: () => editorAction('editor.action.formatDocument') },
  { id: 'undo', label: 'Edit: Undo', run: () => editorAction('undo') },
  { id: 'redo', label: 'Edit: Redo', run: () => editorAction('redo') },
  { id: 'toggleEol', label: 'Change End of Line Sequence (LF/CRLF)', run: () => app.editors.toggleEol() },
  { id: 'settings', label: 'Preferences: Open Settings', kb: 'Ctrl+,', run: () => app.openSettings() },
  { id: 'toggleTheme', label: 'Preferences: Toggle Light/Dark Theme', run: () => app.saveSettings({ theme: app.settings.theme === 'light' ? 'dark' : 'light' }) },
  { id: 'shortcuts', label: 'Help: Keyboard Shortcuts', run: () => commandPalette() },
];
const byId = Object.fromEntries(commands.map((c) => [c.id, c]));

function runCommand(id, arg) {
  if (typeof id === 'object' && id) {
    if (id.cmd === 'openRecent') return openFolder(id.path);
    return undefined;
  }
  const c = byId[id];
  if (!c) return undefined;
  try {
    return Promise.resolve(c.run(arg)).catch((e) => toast(e.message || String(e), 'error'));
  } catch (e) {
    toast(e.message || String(e), 'error');
  }
  return undefined;
}

async function commandPalette() {
  const pick = await quickPick({ placeholder: 'Type a command', items: commands.map((c) => ({ label: c.label, keybinding: c.kb, value: c.id })) });
  if (pick) runCommand(pick);
}

function editorAction(id) {
  const ed = app.editors.editor;
  if (!app.editors.getActive()) return;
  ed.focus();
  if (id === 'undo' || id === 'redo') ed.trigger('menu', id, null);
  else ed.getAction(id)?.run();
}

function toggleChatWithSelection() {
  const hasSel = app.lastFocus === 'editor' && app.editors.selectionInfo();
  if (hasSel) {
    app.chat.addSelection();
    layout.toggleChat(true);
    return;
  }
  if (layout.state.chat && document.activeElement !== $('#chat-input')) { app.chat.focus(); return; }
  layout.toggleChat();
}

async function toggleTerminal() {
  if (layout.state.panel && app.processes.view === 'processes') { app.processes.show('terminal'); await app.terminal.ensure(); return; }
  if (layout.state.panel) {
    if (app.terminal.host.contains(document.activeElement)) { layout.togglePanel(false); app.editors.editor.focus(); } else app.terminal.focus();
    return;
  }
  await app.terminal.ensure();
}

function terminalToChat() {
  const out = app.terminal.recentOutput(120);
  if (!out) { toast('No terminal output to add.'); return; }
  layout.toggleChat(true);
  const input = $('#chat-input');
  input.value = `${input.value ? input.value + '\n\n' : ''}Terminal output:\n\`\`\`\n${out}\n\`\`\`\n`;
  input.focus();
}

function quickPrompt(text, mode) {
  if (!app.editors.getActive()) { toast('Open a file first.'); return; }
  layout.toggleChat(true);
  app.chat.setMode(mode);
  app.chat.includeActive = true;
  app.chat.send(text);
}

// ------------------------------------------------------------------ keybindings
const KEYMAP = {
  'ctrl+s': 'save', 'ctrl+shift+s': 'saveAs', 'ctrl+alt+s': 'saveAll', 'ctrl+w': 'closeTab', 'ctrl+n': 'newFile', 'ctrl+o': 'openFile',
  'ctrl+shift+o': 'openFolder', 'ctrl+p': 'quickOpen', 'ctrl+shift+p': 'commandPalette', 'f1': 'commandPalette', 'ctrl+b': 'toggleSidebar',
  'ctrl+l': 'toggleChat', 'ctrl+shift+l': 'newChat', 'ctrl+k': 'inlineEdit', 'ctrl+`': 'toggleTerminal', 'ctrl+shift+`': 'newTerminal',
  'ctrl+shift+f': 'searchFiles', 'ctrl+shift+e': 'showExplorer', 'ctrl+,': 'settings', 'ctrl+g': 'gotoLine',
};

function keyId(e) {
  let k = e.key.toLowerCase();
  if (e.code === 'Backquote') k = '`';
  if (k === ' ') k = 'space';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  if (!['control', 'shift', 'alt', 'meta'].includes(k)) parts.push(k);
  return parts.join('+');
}

function onGlobalKey(e) {
  if (e.isComposing) return;
  const id = keyId(e);
  let cmd = KEYMAP[id];
  if (!cmd) return;
  const inTerminal = app.terminal && app.terminal.host.contains(document.activeElement);
  const inModal = document.querySelector('.modal-backdrop');
  // Leave shell-meaningful keys to the terminal.
  if (inTerminal && ['ctrl+k', 'ctrl+l', 'ctrl+w', 'ctrl+n', 'ctrl+o', 'ctrl+g', 'ctrl+s'].includes(id)) return;
  if (inModal && cmd !== 'save') return;
  // Inline edit widget handles its own keys.
  if (e.target.closest && e.target.closest('.inline-edit')) return;
  if (cmd === 'gotoLine' && !app.editors.getActive()) return;
  e.preventDefault();
  e.stopPropagation();
  runCommand(cmd);
}

// ------------------------------------------------------------------ boot
async function boot() {
  app.info = await window.api.app.info();
  window.__platform = app.info.platform;
  document.body.classList.add(`platform-${app.info.platform}`);
  app.settings = await window.api.settings.get();
  document.body.classList.toggle('light', app.settings.theme === 'light');
  layout.load();
  layout.initResizers();

  try {
    app.monaco = await loadMonaco();
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:20px;color:#f66">Failed to load the editor: ${e && e.message}</pre>`;
    return;
  }
  app.editors = new Editors(app.monaco, app);
  app.explorer = new Explorer(app);
  app.search = new SearchView(app);
  app.terminal = new TerminalPanel(app);
  app.processes = new ProcessesView(app);
  app.chat = new Chat(app);
  app.inline = new InlineAI(app);
  updateModelStatus();

  // Editor-level bindings so Monaco's own chords (Ctrl+K …) don't swallow ours.
  const { KeyMod, KeyCode } = app.monaco;
  app.editors.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyK, () => runCommand('inlineEdit'));
  app.editors.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyL, () => runCommand('toggleChat'));
  app.editors.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => runCommand('save'));
  app.editors.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyP, () => runCommand('quickOpen'));
  app.editors.editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, () => runCommand('commandPalette'));
  app.editors.editor.addCommand(KeyCode.F1, () => runCommand('commandPalette'));
  app.editors.editor.addAction({
    id: 'cursor-clone.addToChat', label: 'Add Selection to AI Chat', contextMenuGroupId: '0_ai', contextMenuOrder: 1,
    run: () => { app.chat.addSelection(); layout.toggleChat(true); },
  });
  app.editors.editor.addAction({
    id: 'cursor-clone.inlineEdit', label: 'Edit with AI (Ctrl+K)', contextMenuGroupId: '0_ai', contextMenuOrder: 2,
    run: () => app.inline.start(),
  });
  app.editors.onChange(() => {
    const s = app.inline.session;
    if (s && s.tab !== app.editors.getActive()) app.inline.cancel();
    saveOpenTabs();
    app.explorer.render();
  });

  window.addEventListener('keydown', onGlobalKey, true);
  window.api.on('menu', (cmd) => runCommand(cmd));
  window.api.on('app:beforeClose', async () => {
    if (await app.editors.confirmDirty(app.editors.tabs) && await app.processes.confirmStopAll('Closing the app')) {
      saveOpenTabs();
      window.api.app.closeConfirmed();
    }
  });

  // Activity bar & misc buttons
  $$('#activitybar .act[data-view]').forEach((b) => b.addEventListener('click', () => {
    const active = b.classList.contains('active') && layout.state.sidebar;
    if (active) layout.toggleSidebar(false);
    else layout.showView(b.dataset.view);
  }));
  $('#act-chat').onclick = () => layout.toggleChat();
  $('#act-settings').onclick = () => app.openSettings();
  $('#btn-open-folder').onclick = () => openFolder();
  $('#status-model').onclick = () => app.openSettings();
  $('#status-eol').onclick = () => app.editors.toggleEol();
  $('#status-folder').onclick = () => openFolder();
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  $('#chat-input').addEventListener('focus', () => { app.lastFocus = 'chat'; });

  renderRecent();
  app.chat.loadAll();
  app.chat.renderContext();

  const initial = app.info.initialFolder || app.info.root || (app.settings.recentFolders || [])[0];
  if (initial && (await window.api.fs.exists(initial))) await openFolder(initial);

  if (!app.settings.apiKey && /api\.openai\.com/.test(app.settings.baseURL)) {
    setTimeout(() => toast('Welcome! Configure your OpenAI-compatible provider in Settings (Ctrl+,) to enable AI features.', 'info', 8000), 600);
  }
  setStatus('Ready');
}

boot().catch((e) => {
  console.error(e);
  toast(`Startup error: ${e.message}`, 'error');
});

