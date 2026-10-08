'use strict';
// End-to-end smoke test of the real Electron app against the mock OpenAI server.
// Run: npm run test:e2e   (headless Linux: xvfb-run -a npm run test:e2e)
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
], { models: Array.from({ length: 80 }, (_, i) => `model-${String(i).padStart(3, '0')}`) }).then((srv) => {
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
      // Screenshots are diagnostics only; don't fail the run if capture isn't supported.
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
      } catch (e) {
        log.push(`NOTE screenshot ${name} failed: ${e.message}`);
      }
    };
    const srv = await srvPromise;
    try {
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) { await sleep(250); ready = await js('!!(window.__app && window.__app.chat && window.__app.root)'); }
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
      check(first && first.body.tools && first.body.tools.length === 12, 'agent tools sent');
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
      // ---- Bug 1 & 4: Settings default-model picker is scrollable and selectable
      await js(`window.__app.saveSettings({ autocompleteEnabled: false }).then(() => true)`);
      await js('window.__app.openSettings(); true');
      await sleep(300);
      await js(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Fetch models').click(); true`);
      let popupReady = false;
      for (let i = 0; i < 20 && !popupReady; i++) { await sleep(200); popupReady = await js(`document.querySelectorAll('.mp-popup .mp-item').length >= 80`); }
      check(popupReady, 'settings model picker lists all 80 models from /models');
      const scroll = await js(`(() => { const l = document.querySelector('.mp-popup .mp-list'); const r = { overflow: getComputedStyle(l).overflowY, scrollable: l.scrollHeight > l.clientHeight }; l.scrollTop = 400; r.scrolled = l.scrollTop > 0; return r; })()`);
      check(scroll.overflow === 'auto' && scroll.scrollable && scroll.scrolled, `model list scrolls (${JSON.stringify(scroll)})`);
      await js(`[...document.querySelectorAll('.mp-popup .mp-item')].find((e) => e.textContent.startsWith('model-042')).click(); true`);
      await sleep(100);
      check(await js(`document.querySelector('.modal .mp-input').value`) === 'model-042', 'clicking a model selects it as default');
      // typing filters the list
      await js(`(() => { const i = document.querySelector('.modal .mp-input'); i.focus(); i.value = 'model-07'; i.dispatchEvent(new Event('input')); return true; })()`);
      await sleep(400);
      check(await js(`document.querySelectorAll('.mp-popup .mp-item').length`) === 11, 'typing filters the model list (10 matches + "use typed")');
      await js(`document.querySelector('.modal .mp-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      check(await js(`!!document.querySelector('.modal') && !document.querySelector('.mp-popup')`), 'Esc closes only the dropdown, not Settings');
      await js(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Save').click(); true`);
      await sleep(400);
      check(await js('window.__app.settings.model') === 'model-042', 'default model saved from the list');
      await shot('8-settings-models');

      // ---- Bug 3: choose the model in the chat window itself (per chat)
      await js(`window.__app.chat.newChat(); true`);
      await sleep(200);
      check(await js('window.__app.chat.modelPicker.value') === 'model-042', 'new chat starts with the default model');
      await js(`(() => { const p = window.__app.chat.modelPicker; p.input.focus(); p.open(); return true; })()`);
      await sleep(500);
      const opensUp = await js(`(() => { const p = document.querySelector('.mp-popup'); return p && p.getBoundingClientRect().bottom <= document.querySelector('#chat-model').getBoundingClientRect().top + 4; })()`);
      check(opensUp, 'chat model dropdown opens upward from the composer');
      check(await js(`!!document.querySelector('.mp-popup .mp-tag')`), 'default model is tagged in the chat list');
      await js(`[...document.querySelectorAll('.mp-popup .mp-item')].find((e) => e.textContent.startsWith('model-007')).click(); true`);
      await sleep(100);
      check(await js('window.__app.chat.currentModel()') === 'model-007', 'chat model switched from the chat panel');
      check((await js(`document.querySelector('#status-model').textContent`)).includes('model-007'), 'status bar shows the chat model');
      srv.queue.push({ content: 'pong' });
      const before = srv.requests.length;
      await js(`window.__app.chat.setMode('ask'); window.__app.chat.send('ping'); true`);
      let got = null;
      for (let i = 0; i < 30 && !got; i++) { await sleep(200); got = srv.requests.slice(before).find((r) => r.url === '/v1/chat/completions'); }
      check(got && got.body.model === 'model-007', `chat request uses the chat's model (${got && got.body.model})`);
      check(await js('window.__app.settings.model') === 'model-042', 'choosing a chat model does not change the default');
      await sleep(500);

      // ---- Bug 2: Plan mode → Implement plan
      await js(`window.__app.chat.newChat(); true`);
      srv.queue.push({ toolCalls: [{ name: 'read_file', args: { path: 'src/math.js' } }] });
      srv.queue.push({ content: '## Goal\nAdd subtract.\n\n## Plan\n- [ ] 1. Add `sub` to src/math.js\n- [ ] 2. Export it' });
      const planStart = srv.requests.length;
      await js(`window.__app.chat.setMode('plan'); window.__app.chat.send('add a subtract function'); true`);
      let planBtn = false;
      for (let i = 0; i < 30 && !planBtn; i++) { await sleep(200); planBtn = await js(`!!document.querySelector('#btn-implement-plan')`); }
      check(planBtn, 'plan response shows "Implement plan" button');
      const planReq = srv.requests.slice(planStart).find((r) => r.url === '/v1/chat/completions');
      check(planReq && planReq.body.tools.length === 7 && /PLAN mode/.test(planReq.body.messages[0].content), 'plan mode sends read-only tools + plan prompt');
      await shot('9-plan');
      srv.queue.push({ content: 'Implemented.' });
      const implStart = srv.requests.length;
      await js(`document.querySelector('#btn-implement-plan').click(); true`);
      let implReq = null;
      for (let i = 0; i < 30 && !implReq; i++) { await sleep(200); implReq = srv.requests.slice(implStart).find((r) => r.url === '/v1/chat/completions'); }
      check(implReq && implReq.body.tools.length === 12 && /Implement the plan above/.test(implReq.body.messages[implReq.body.messages.length - 1].content) && /## Plan/.test(JSON.stringify(implReq.body.messages)),
        'Implement plan switches to Agent mode with the plan in context');
      check(await js(`document.querySelector('#chat-mode').value`) === 'agent', 'mode selector switched to Agent');
      await sleep(600);

      // ---- Bug 5: auto-scroll follows streaming output; scrolling up pauses it
      await js(`window.__app.chat.newChat(); window.__app.chat.setMode('ask'); true`);
      const slowStream = (lines, delay) => (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let i = 0;
        const t = setInterval(() => {
          if (i < lines) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Line ${i} of a long streamed answer that keeps growing.\n\n` } }] })}\n\n`);
          else { res.write('data: [DONE]\n\n'); res.end(); clearInterval(t); }
          i++;
        }, delay);
      };
      srv.queue.push(slowStream(80, 40));
      await js(`window.__app.chat.send('stream please'); true`);
      const dists = [];
      for (let i = 0; i < 10; i++) { await sleep(250); dists.push(await js(`(() => { const l = document.querySelector('#chat-messages'); return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight); })()`)); }
      const overflowed = await js(`(() => { const l = document.querySelector('#chat-messages'); return l.scrollHeight > l.clientHeight * 1.5; })()`);
      check(overflowed && dists.every((d) => d < 40), `chat stays scrolled to the newest output while streaming (distances ${dists.join(',')})`);
      await sleep(2000);
      srv.queue.push(slowStream(60, 40));
      await js(`window.__app.chat.send('again'); true`);
      await sleep(400);
      await js(`(() => { const l = document.querySelector('#chat-messages'); l.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true })); l.scrollTop = 0; return true; })()`);
      await sleep(800);
      const upDist = await js(`(() => { const l = document.querySelector('#chat-messages'); return l.scrollTop; })()`);
      check(upDist < 50, `scrolling up pauses auto-scroll (scrollTop ${upDist})`);
      check(await js(`!document.querySelector('#chat-jump').classList.contains('hidden')`), '"Latest" button appears while scrolled up');
      await shot('10-scrolled-up');
      await js(`document.querySelector('#chat-jump').click(); true`);
      await sleep(600);
      check(await js(`(() => { const l = document.querySelector('#chat-messages'); return l.scrollHeight - l.scrollTop - l.clientHeight < 40; })()`), '"Latest" button jumps back and re-pins to the bottom');
      await sleep(2500);
      // ---- Multiple-choice questions: ask_user tool
      await js(`window.__app.chat.newChat(); window.__app.chat.setMode('agent'); true`);
      srv.queue.push({ toolCalls: [{ name: 'ask_user', args: { questions: [
        { question: 'Which database should we use?', options: ['PostgreSQL', 'SQLite', 'MySQL'] },
        { question: 'Which features do you need?', options: ['Auth', 'Search', 'Export'], multi_select: true },
      ] } }] });
      srv.queue.push({ content: 'Got it: SQLite with Auth and Export.' });
      const askStart = srv.requests.length;
      await js(`window.__app.chat.send('set up the backend'); true`);
      let qCard = false;
      for (let i = 0; i < 30 && !qCard; i++) { await sleep(200); qCard = await js(`!!document.querySelector('.approval.question .qform')`); }
      check(qCard, 'ask_user shows a multiple-choice card');
      check(await js(`document.querySelectorAll('.approval.question input[type=radio]').length === 3 && document.querySelectorAll('.approval.question input[type=checkbox]').length === 3`), 'single-select uses radios, multi-select uses checkboxes');
      check(await js(`document.querySelector('.approval.question .qsubmit').disabled`), 'submit disabled until something is chosen');
      await shot('11-ask-user');
      await js(`(() => {
        const labels = [...document.querySelectorAll('.approval.question .qopt')];
        const pick = (t) => labels.find((l) => l.textContent.endsWith(t)).querySelector('input').click();
        pick('SQLite'); pick('Auth'); pick('Export');
        const other = document.querySelectorAll('.approval.question .qother')[1];
        other.value = 'Dark mode'; other.dispatchEvent(new Event('input'));
        document.querySelector('.approval.question .qsubmit').click();
        return true;
      })()`);
      let followUp = null;
      for (let i = 0; i < 30 && !followUp; i++) { await sleep(200); followUp = srv.requests.slice(askStart).filter((r) => r.url === '/v1/chat/completions')[1]; }
      const toolAns = followUp && followUp.body.messages.find((m) => m.role === 'tool');
      check(toolAns && /Which database should we use\?\s+Answer: SQLite/.test(toolAns.content) && /Answer: Auth; Export; Dark mode/.test(toolAns.content), 'selected answers are returned to the AI');
      await sleep(600);
      check(await js(`(() => { const f = document.querySelector('.tool .qform.readonly'); return !!f && [...f.querySelectorAll('input:checked')].map((i) => i.value).join(',') === 'SQLite,Auth,Export'; })()`), 'answered questions stay visible (read-only) in history');

      // ---- Multiple-choice questions written as plain text → quick reply
      await js(`window.__app.chat.newChat(); window.__app.chat.setMode('ask'); true`);
      srv.queue.push({ content: 'A couple of questions first:\n\n1. **Which test framework do you prefer?**\n   A) Jest\n   B) Vitest\n   C) Mocha\n\n2. Should I add CI?\n   A) Yes, GitHub Actions\n   B) No\n\nLet me know!' });
      await js(`window.__app.chat.send('add tests'); true`);
      let quick = false;
      for (let i = 0; i < 30 && !quick; i++) { await sleep(200); quick = await js(`document.querySelectorAll('.quick-reply .qblock').length === 2`); }
      check(quick, 'plain-text MCQs become clickable answers');
      await shot('12-quick-reply');
      srv.queue.push({ content: 'Great, Vitest with GitHub Actions.' });
      const qrStart = srv.requests.length;
      await js(`(() => {
        const labels = [...document.querySelectorAll('.quick-reply .qopt')];
        labels.find((l) => l.textContent.endsWith('Vitest')).querySelector('input').click();
        labels.find((l) => l.textContent.endsWith('Yes, GitHub Actions')).querySelector('input').click();
        document.querySelector('.quick-reply .qsubmit').click();
        return true;
      })()`);
      let qrReq = null;
      for (let i = 0; i < 30 && !qrReq; i++) { await sleep(200); qrReq = srv.requests.slice(qrStart).find((r) => r.url === '/v1/chat/completions'); }
      const lastUser = qrReq && qrReq.body.messages.filter((m) => m.role === 'user').pop();
      check(lastUser && /1\. Which test framework do you prefer\?\s+→ Vitest/.test(lastUser.content) && /2\. Should I add CI\?\s+→ Yes, GitHub Actions/.test(lastUser.content), 'quick reply sends the chosen answers');
      await sleep(600);
      check(await js(`!document.querySelector('.quick-reply')`), 'quick reply disappears once answered');
      // ---- Background processes: AI starts a dev server in the background
      fs.writeFileSync(path.join(workspace, 'server.js'), "const http=require('http');const s=http.createServer((q,r)=>r.end('hello from bg'));s.listen(0,()=>console.log('listening on http://localhost:'+s.address().port))");
      fs.writeFileSync(path.join(workspace, 'slow.js'), "console.log('build step 1');setInterval(()=>console.log('still building'),200)");
      await js(`window.__app.saveSettings({ autoApproveCommands: true }).then(() => true)`);
      await js(`window.__app.chat.newChat(); window.__app.chat.setMode('agent'); true`);
      srv.queue.push({ toolCalls: [{ name: 'run_command', args: { command: 'node server.js', background: true, wait_for: 'listening' } }] });
      srv.queue.push({ content: 'The server is running.' });
      const bgStart = srv.requests.length;
      await js(`window.__app.chat.send('start the server'); true`);
      let bgReq = null;
      for (let i = 0; i < 50 && !bgReq; i++) { await sleep(200); bgReq = srv.requests.slice(bgStart).filter((r) => r.url === '/v1/chat/completions')[1]; }
      const bgTool = bgReq && bgReq.body.messages.filter((m) => m.role === 'tool').pop();
      check(bgTool && /Process bg-\d+ .*running — http:\/\/localhost:\d+/.test(bgTool.content) && /Output matched "listening"/.test(bgTool.content), `AI starts a server in the background and gets its URL (${bgTool && bgTool.content.split('\n')[0]})`);
      const procId = bgTool && /(bg-\d+)/.exec(bgTool.content)[1];
      const url = bgTool && /(http:\/\/localhost:\d+)/.exec(bgTool.content)[1];
      check(url && (await (await fetch(url)).text()) === 'hello from bg', 'background server is actually serving');
      await sleep(600);
      check((await js(`document.querySelector('#status-bg').textContent`)) === '⚙ 1 running', 'status bar shows the running process');
      check(await js(`document.querySelector('#proc-count').textContent === '1'`), 'Processes tab shows a running count');
      await js(`[...document.querySelectorAll('.tool .proc-link')].pop().click(); true`);
      await sleep(800);
      check(await js(`document.querySelector('#panel').classList.contains('view-processes') && !!document.querySelector('.proc-row.selected')`), 'process link opens the Processes panel with it selected');
      check((await js(`document.querySelector('.proc-row.selected .proc-meta').textContent`)).includes(url), 'detected URL shown in the process list');
      const logText = `(() => { const t = window.__app.processes.xterm; if (!t) return ''; const b = t.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); s += (l.isWrapped ? '' : '\\n') + l.translateToString(true); } return s; })()`;
      let logOk = false;
      for (let i = 0; i < 30 && !logOk; i++) { await sleep(200); logOk = /listening on/.test(await js(logText)); }
      const logDiag = logOk ? '' : ` [diag: ${JSON.stringify(await js(`(async () => { const pv = window.__app.processes; const o = await window.api.bg.output(pv.selected); return { selected: pv.selected, view: pv.view, head: document.querySelector('#proc-log-head').textContent, outLen: o && o.text.length, outStart: o && o.text.slice(0, 80), bufLines: pv.xterm && pv.xterm.buffer.active.length, logBox: (() => { const r = document.querySelector('#proc-log').getBoundingClientRect(); return [r.width, r.height]; })() }; })()`))}]`;
      check(logOk, `live output shown in the log viewer${logDiag}`);
      await shot('13-processes');
      await js(`[...document.querySelectorAll('.proc-row.selected .cb-btn')].find((b) => b.textContent === 'Stop').click(); true`);
      let stopped = false;
      for (let i = 0; i < 25 && !stopped; i++) { await sleep(200); stopped = await js(`(() => { const p = window.__app.processes.procs.get(${JSON.stringify(procId)}); return !!p && p.status === 'stopped'; })()`); }
      check(stopped, 'Stop button stops the process');
      let refused = false;
      try { await fetch(url, { signal: AbortSignal.timeout(2000) }); } catch { refused = true; }
      check(refused, 'stopped server no longer accepts connections');
      check(await js(`document.querySelector('#status-bg').classList.contains('hidden')`), 'status bar indicator hides when nothing runs');

      // ---- "Send to background" on a long foreground command
      srv.queue.push({ toolCalls: [{ name: 'run_command', args: { command: 'node slow.js' } }] });
      srv.queue.push({ content: 'Continuing while it builds.' });
      const sbStart = srv.requests.length;
      await js(`window.__app.chat.send('run the slow build'); true`);
      let bgBtn = false;
      for (let i = 0; i < 40 && !bgBtn; i++) { await sleep(200); bgBtn = await js(`!!document.querySelector('.tool .bg-btn')`); }
      check(bgBtn, '"Send to background" button appears on a running command');
      await sleep(500);
      await js(`document.querySelector('.tool .bg-btn').click(); true`);
      let sbReq = null;
      for (let i = 0; i < 40 && !sbReq; i++) { await sleep(200); sbReq = srv.requests.slice(sbStart).filter((r) => r.url === '/v1/chat/completions')[1]; }
      const sbTool = sbReq && sbReq.body.messages.filter((m) => m.role === 'tool').pop();
      check(sbTool && /build step 1/.test(sbTool.content) && /still running in the background as bg-\d+ \(the user sent it to the background\)/.test(sbTool.content), 'AI continues after the command is sent to the background');
      await sleep(500);
      const slowId = sbTool && /(bg-\d+)/.exec(sbTool.content)[1];
      check(await js(`(() => { const p = window.__app.processes.procs.get(${JSON.stringify(slowId)}); return !!p && !p.hidden && p.status === 'running'; })()`), 'detached command is listed as a running background process');
      await js(`window.api.bg.stop(${JSON.stringify(slowId)}).then(() => true)`);

      // ---- User-started background process that fails → error notice
      await js(`window.__app.processes.runInBackground(); true`);
      await sleep(300);
      await js(`(() => { const i = document.querySelector('.modal input'); i.value = 'node -e "console.log(1); process.exit(2)"'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
      let toastSeen = false;
      for (let i = 0; i < 30 && !toastSeen; i++) { await sleep(200); toastSeen = await js(`[...document.querySelectorAll('.toast.error')].some((t) => /exited with code 2/.test(t.textContent))`); }
      check(toastSeen, 'a background process that fails shows an error notice');
      check(await js(`[...document.querySelectorAll('.proc-row .proc-meta')].some((m) => /You · exited \\(2\\)/.test(m.textContent))`), 'user-started process listed with its exit code');
      await js(`window.__app.saveSettings({ autoApproveCommands: false }).then(() => true)`);
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
