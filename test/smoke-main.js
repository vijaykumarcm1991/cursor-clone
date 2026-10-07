'use strict';
// End-to-end smoke test of the real Electron app against the mock OpenAI server.
// Run: npx electron test/smoke-main.js --ozone-platform=headless --no-sandbox --disable-gpu
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-server');

const outDir = process.env.SMOKE_OUT || path.join(os.tmpdir(), 'cursor-clone-smoke');
fs.mkdirSync(outDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-userdata-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ws-'));
fs.mkdirSync(path.join(workspace, 'src'));
fs.writeFileSync(path.join(workspace, 'src', 'math.js'), 'function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n');
fs.writeFileSync(path.join(workspace, 'README.md'), '# Demo project\n');
process.argv.push(workspace);
process.env.CURSOR_CLONE_MULTI = '1';
app.setPath('userData', userData);

const log = [];
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(cond, msg) {
  log.push(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failed = true;
}

fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model: 'mock-model', autocompleteEnabled: false }));
require('../src/main/main.js'); // must load before app 'ready' (registers the app:// scheme)

const srvPromise = mock.start([
  { content: 'I will fix the bug.', toolCalls: [{ name: 'read_file', args: { path: 'src/math.js' } }] },
  { toolCalls: [{ name: 'edit_file', args: { path: 'src/math.js', old_string: 'return a - b;', new_string: 'return a + b;' } }] },
  { content: 'Fixed `add` to use **addition**.\n\n```js src/math.js\nfunction add(a, b) {\n  return a + b;\n}\n```' },
]).then((srv) => {
  require('../src/main/settings').save({ baseURL: srv.baseURL });
  return srv;
});

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (ev) => {
    const level = ev.level ?? ev.params?.level;
    const message = ev.message ?? ev.params?.message;
    if (level === 'error' || level === 3) errors.push(message);
    log.push(`[console:${level}] ${message}`);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    };
    const srv = await srvPromise;
    try {
      await sleep(3500);
      check(await js('!!window.monaco && !!window.__app.editors'), 'Monaco editor loaded');
      check(await js('window.__app.root') === workspace, 'workspace opened from CLI argument');
      check(await js('document.querySelectorAll("#tree .tree-row").length') >= 2, 'explorer shows files');
      await js(`window.__app.editors.open(${JSON.stringify(path.join(workspace, 'src', 'math.js'))}).then(() => true)`);
      await sleep(800);
      check(await js('window.__app.editors.getActive().model.getLanguageId()') === 'javascript', 'opened file with JS language mode');
      check(await js('document.querySelectorAll(".view-lines .view-line").length') > 0, 'editor renders lines');
      await shot('1-editor');

      // Agent chat round-trip with approval
      await js(`window.__app.layout.toggleChat(true); document.querySelector('#chat-mode').value = 'agent'; document.querySelector('#chat-input').value = 'fix the add function'; document.querySelector('#btn-send').click();`);
      let approved = false;
      for (let i = 0; i < 40 && !approved; i++) {
        await sleep(250);
        approved = await js(`(() => { const b = [...document.querySelectorAll('.approval button')].find(b => b.textContent === 'Accept'); if (b) { b.click(); return true; } return false; })()`);
        if (i === 4) await shot('2-approval');
      }
      check(approved, 'edit approval card appeared and was accepted');
      await sleep(1500);
      check(fs.readFileSync(path.join(workspace, 'src', 'math.js'), 'utf8').includes('return a + b;'), 'agent edit written to disk');
      check(await js('window.__app.editors.getActive().model.getValue().includes("return a + b;")'), 'open editor reloaded with agent change');
      check(await js('!!document.querySelector(".changes")'), 'changes summary with revert shown');
      check(await js('!!document.querySelector(".codeblock .cb-head")'), 'markdown code block rendered with actions');
      check(await js('document.querySelectorAll(".tool.ok").length') >= 2, 'tool cards marked as succeeded');
      await shot('3-chat-done');

      // Requests carried system prompt + tools + context
      const first = srv.requests.find((r) => r.url === '/v1/chat/completions');
      check(first && first.body.model === 'mock-model', 'request used configured model');
      check(first && first.body.tools && first.body.tools.length === 8, 'agent tools sent');
      check(first && /<context>/.test(first.body.messages[first.body.messages.length - 1].content), 'active file context attached');

      // Terminal
      await js('window.__app.terminal.create().then(() => true)');
      await sleep(1500);
      check(await js('window.__app.terminal.terms.length') === 1, 'terminal created');
      const termCmd = process.platform === 'win32' ? 'echo "smoke-$(40+2)"' : 'echo smoke-$((40+2))';
      await js(`window.__app.terminal.onInput(window.__app.terminal.active, ${JSON.stringify(termCmd + '\r')})`);
      let termOk = false;
      for (let i = 0; i < 20 && !termOk; i++) { await sleep(300); termOk = /smoke-42/.test(await js('window.__app.terminal.recentOutput(40)')); }
      check(termOk, 'terminal executes commands');
      await shot('4-terminal');

      // Command palette + settings dialog render
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }))`);
      await sleep(300);
      check(await js('!!document.querySelector(".quickpick")'), 'command palette opens with Ctrl+Shift+P');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await js('document.querySelector(".quickpick input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      await js('window.__app.openSettings(); true');
      await sleep(300);
      check(await js('!!document.querySelector(".modal .form")'), 'settings dialog opens');
      await shot('5-settings');
      await js(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Cancel').click(); true`);
      // Ctrl+K inline edit on a selection
      srv.queue.push({ content: '```js\nfunction add(a, b) {\n  return a * b;\n}\n```' });
      await js(`(() => { const ed = window.__app.editors.editor; ed.focus(); ed.setSelection(new monaco.Range(1, 1, 3, 2)); window.__app.inline.start(); return true; })()`);
      await sleep(300);
      check(await js('!!document.querySelector(".inline-edit textarea")'), 'inline edit widget opens');
      await js(`(() => { const ta = document.querySelector('.inline-edit textarea'); ta.value = 'multiply instead'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
      await sleep(1500);
      check(await js('window.__app.editors.getActive().model.getValue().startsWith("function add(a, b) {\\n  return a * b;\\n}\\n\\nmodule")'), 'inline edit applied in place (fences stripped)');
      check(await js('document.querySelectorAll(".ai-added-line").length') > 0, 'inline edit result highlighted');
      await shot('6-inline-edit');
      await js(`document.querySelector('.inline-edit textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      await sleep(200);
      check(await js('window.__app.editors.getActive().model.getValue().includes("return a + b;")'), 'Esc rejects inline edit and restores original');
      check(await js('!document.querySelector(".inline-edit")'), 'inline edit widget closed');

      // Ghost-text autocomplete
      srv.queue.push({ content: 'return a - b;' });
      await js(`window.__app.saveSettings({ autocompleteEnabled: true, autocompleteDelay: 50 }).then(() => true)`);
      await js(`(() => { const ed = window.__app.editors.editor; const m = ed.getModel(); m.pushEditOperations([], [{ range: new monaco.Range(6, 1, 6, 1), text: 'function sub(a, b) {\\n  ' }], () => null); ed.setPosition({ lineNumber: 7, column: 3 }); ed.focus(); ed.trigger('test', 'editor.action.inlineSuggest.trigger', {}); return true; })()`);
      let ghost = false;
      for (let i = 0; i < 20 && !ghost; i++) { await sleep(200); ghost = await js('!!document.querySelector(".ghost-text, .ghost-text-decoration")'); }
      check(ghost, 'autocomplete ghost text shown');
      await shot('7-autocomplete');
      await js(`window.__app.editors.editor.trigger('test', 'editor.action.inlineSuggest.commit', {}); true`);
      await sleep(200);
      check(await js('window.__app.editors.getActive().model.getLineContent(7)') === '  return a - b;', 'Tab accepts the completion');
    } catch (e) {
      check(false, `exception: ${e.stack || e.message}`);
    }
    const realErrors = errors.filter((m) => !/Autofill|DevTools|Electron Security Warning/.test(m || ''));
    check(realErrors.length === 0, `no console errors (${realErrors.length})`);
    fs.writeFileSync(path.join(outDir, 'log.txt'), log.join('\n'));
    console.log(log.filter((l) => /^(PASS|FAIL)/.test(l) || /console:(error|3)/.test(l)).join('\n'));
    console.log(`screenshots: ${outDir}`);
    await srv.close();
    app.exit(failed ? 1 : 0);
  });
});
