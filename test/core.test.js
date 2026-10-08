'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ai = require('../src/main/ai');
const agent = require('../src/main/agent');
const ws = require('../src/main/workspace');
const platform = require('../src/main/platform');
const mock = require('./mock-server');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-clone-test-'));
}

test('streamChat parses SSE content and fragmented tool calls', async () => {
  const srv = await mock.start([{ content: 'Hello world!', toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }]);
  try {
    const cfg = { baseURL: srv.baseURL + '/', apiKey: 'test-key', model: 'm' };
    let text = '';
    let done;
    for await (const ev of ai.streamChat(cfg, { messages: [{ role: 'user', content: 'hi', _display: 'x' }] })) {
      if (ev.type === 'content') text += ev.text;
      if (ev.type === 'done') done = ev;
    }
    assert.strictEqual(text, 'Hello world!');
    assert.strictEqual(done.toolCalls.length, 1);
    assert.strictEqual(done.toolCalls[0].function.name, 'read_file');
    assert.deepStrictEqual(JSON.parse(done.toolCalls[0].function.arguments), { path: 'a.txt' });
    // UI-only fields are stripped before sending
    assert.strictEqual(srv.requests[0].body.messages[0]._display, undefined);
    assert.strictEqual(srv.requests[0].body.stream, true);
  } finally {
    await srv.close();
  }
});

test('API errors surface the server message', async () => {
  const srv = await mock.start([]);
  try {
    await assert.rejects(ai.chatOnce({ baseURL: srv.baseURL, apiKey: 'wrong', model: 'm' }, { messages: [{ role: 'user', content: 'x' }] }), /401.*Invalid API key/);
  } finally {
    await srv.close();
  }
});

test('servers that ignore stream:true (plain JSON) still work', async () => {
  const srv = await mock.start([(req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'plain json' }, finish_reason: 'stop' }] }));
  }]);
  try {
    const r = await ai.chatOnce({ baseURL: srv.baseURL, apiKey: 'test-key', model: 'm' }, { messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(r.content, 'plain json');
  } finally {
    await srv.close();
  }
});

test('listModels and FIM completion', async () => {
  const srv = await mock.start([]);
  try {
    const cfg = { baseURL: srv.baseURL, apiKey: 'test-key', model: 'm', autocompleteMode: 'fim' };
    assert.deepStrictEqual(await ai.listModels(cfg), ['mock-a', 'mock-b']);
    const text = await ai.completeCode(cfg, { prefix: 'function add(a, b) {\n  ', suffix: '\n}', path: 'a.js' });
    assert.strictEqual(text, 'return a + b;');
  } finally {
    await srv.close();
  }
});

test('chat-mode autocomplete strips fences and cursor markers', async () => {
  const srv = await mock.start([{ content: '```js\nreturn a + b;<|CURSOR|>\n```' }]);
  try {
    const cfg = { baseURL: srv.baseURL, apiKey: 'test-key', model: 'm', autocompleteMode: 'chat' };
    const text = await ai.completeCode(cfg, { prefix: 'function add(a, b) {\n  ', suffix: '\n}', path: 'a.js' });
    assert.strictEqual(text, 'return a + b;');
  } finally {
    await srv.close();
  }
});

test('applyEdit handles CRLF files, uniqueness and replace_all', () => {
  const crlf = 'line one\r\nline two\r\nline three\r\n';
  const r = agent.applyEdit(crlf, 'line one\nline two', 'LINE ONE\nLINE TWO');
  assert.ok(r.ok);
  assert.strictEqual(r.content, 'LINE ONE\r\nLINE TWO\r\nline three\r\n');
  const dup = 'a\na\n';
  assert.strictEqual(agent.applyEdit(dup, 'a', 'b').ok, false);
  assert.strictEqual(agent.applyEdit(dup, 'a', 'b', true).content, 'b\nb\n');
  assert.strictEqual(agent.applyEdit('x', 'nope', 'y').ok, false);
  // tolerant of trailing whitespace differences
  assert.ok(agent.applyEdit('foo   \nbar\n', 'foo\nbar', 'baz').ok);
  // "$&" in replacement must be literal
  assert.strictEqual(agent.applyEdit('v = 1', '1', '"$&"').content, 'v = "$&"');
});

test('resolveIn refuses paths outside the workspace', () => {
  const root = tmpdir();
  assert.strictEqual(ws.resolveIn(root, 'src/a.ts'), path.join(root, 'src', 'a.ts'));
  assert.strictEqual(ws.resolveIn(root, '.'), path.resolve(root));
  assert.throws(() => ws.resolveIn(root, '../escape.txt'), /outside the workspace/);
  assert.throws(() => ws.resolveIn(root, path.resolve(root, '..', 'x')), /outside the workspace/);
});

test('walk/search/find honour ignores and .gitignore', async () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'const needle = 1;\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'needle');
  fs.writeFileSync(path.join(root, 'logs', 'a.log'), 'needle');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]));
  fs.writeFileSync(path.join(root, '.gitignore'), 'logs/\n*.dat\n');
  const files = (await ws.listFiles(root)).map((f) => ws.relPath(root, f)).sort();
  assert.deepStrictEqual(files, ['.gitignore', 'src/main.ts']);
  const { results } = await ws.searchText(root, 'NEEDLE');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].rel, 'src/main.ts');
  assert.strictEqual(results[0].line, 1);
  assert.deepStrictEqual(await ws.findFiles(root, '*.ts'), ['src/main.ts']);
  assert.deepStrictEqual(await ws.findFiles(root, 'src/**/*.ts'), ['src/main.ts']);
});

test('runCommand captures output and exit codes on this platform', async () => {
  const r = await platform.runCommand('echo hello', { cwd: os.tmpdir() });
  assert.match(r.output, /hello/);
  assert.strictEqual(r.code, 0);
  const bad = await platform.runCommand('exit 3', { cwd: os.tmpdir() });
  assert.strictEqual(bad.code, 3);
});

test('runCommand times out and kills the process', async () => {
  const cmd = platform.isWin ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const t0 = Date.now();
  const r = await platform.runCommand(cmd, { cwd: os.tmpdir(), timeoutMs: 500 });
  assert.ok(r.timedOut);
  assert.ok(Date.now() - t0 < 10000);
});

test('agent loop: tools, approvals, file changes, context', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'app.js'), 'function greet() {\r\n  return "hi";\r\n}\r\n');
  const srv = await mock.start([
    { content: 'Let me look.', toolCalls: [{ name: 'read_file', args: { path: 'app.js' } }, { name: 'list_dir', args: { path: '.' } }] },
    { toolCalls: [{ name: 'edit_file', args: { path: 'app.js', old_string: '  return "hi";', new_string: '  return "hello";' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'lib/util.js', content: 'module.exports = 1;\n' } }] },
    { toolCalls: [{ name: 'run_command', args: { command: 'echo agent-ran' } }] },
    { toolCalls: [{ name: 'delete_file', args: { path: 'app.js' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: '../outside.txt' } }] },
    { content: 'All done.' },
  ]);
  const events = [];
  const approvals = [];
  try {
    const res = await agent.runChat({
      cfg: { baseURL: srv.baseURL, apiKey: 'test-key', model: 'm' },
      mode: 'agent',
      root,
      messages: [{ role: 'user', content: 'make it say hello', _display: 'make it say hello' }],
      context: { activeFile: { path: path.join(root, 'app.js'), content: 'UNSAVED BUFFER', cursorLine: 2 } },
      emit: (e) => events.push(e),
      requestApproval: async (req) => {
        approvals.push(req);
        if (req.kind === 'delete') return { approved: false, feedback: 'keep it' };
        return { approved: true };
      },
    });
    // Files changed on disk, CRLF preserved
    assert.strictEqual(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'function greet() {\r\n  return "hello";\r\n}\r\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'lib', 'util.js'), 'utf8'), 'module.exports = 1;\n');
    // approvals requested for edit, write, command and delete
    assert.deepStrictEqual(approvals.map((a) => a.kind), ['edit', 'edit', 'command', 'delete']);
    assert.strictEqual(approvals[1].isNew, true);
    // tool results flowed back to the model
    const toolMsgs = res.messages.filter((m) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 7);
    assert.match(toolMsgs[0].content, /1\|function greet/);
    assert.match(toolMsgs[1].content, /app\.js/);
    assert.match(toolMsgs[4].content, /agent-ran[\s\S]*Exit code: 0/);
    assert.match(toolMsgs[5].content, /rejected deleting app\.js\. Feedback: keep it/);
    assert.match(toolMsgs[6].content, /outside the workspace/);
    // Context block was attached to the user message, display text kept
    assert.match(res.messages[0].content, /<context>[\s\S]*UNSAVED BUFFER[\s\S]*<\/context>\s*make it say hello$/);
    assert.strictEqual(res.messages[0]._display, 'make it say hello');
    // System prompt mentions the OS and the request carried tools
    const firstReq = srv.requests[0].body;
    assert.strictEqual(firstReq.messages[0].role, 'system');
    assert.match(firstReq.messages[0].content, new RegExp(platform.platformInfo().osName));
    assert.ok(firstReq.tools.some((t) => t.function.name === 'run_command'));
    // Each follow-up request includes the assistant tool_calls + tool results
    const secondReq = srv.requests[1].body;
    const roles = secondReq.messages.map((m) => m.role);
    assert.deepStrictEqual(roles.slice(-3), ['assistant', 'tool', 'tool']);
    // change tracking for revert
    const changed = res.changes.map((c) => c.rel).sort();
    assert.deepStrictEqual(changed, ['app.js', 'lib/util.js']);
    assert.strictEqual(res.changes.find((c) => c.rel === 'lib/util.js').before, null);
    assert.ok(events.some((e) => e.type === 'file_changed'));
    assert.ok(events.some((e) => e.type === 'tool_output' && /agent-ran/.test(e.text)));
    assert.strictEqual(res.messages[res.messages.length - 1].content, 'All done.');
  } finally {
    await srv.close();
  }
});

test('ask mode exposes only read-only tools; raw mode sends messages verbatim', async () => {
  const root = tmpdir();
  const srv = await mock.start([{ content: 'answer' }, { content: 'raw answer' }]);
  try {
    const cfg = { baseURL: srv.baseURL, apiKey: 'test-key', model: 'm' };
    await agent.runChat({ cfg, mode: 'ask', root, messages: [{ role: 'user', content: 'q' }], emit: () => {} });
    const names = srv.requests[0].body.tools.map((t) => t.function.name).sort();
    assert.deepStrictEqual(names, ['ask_user', 'find_files', 'list_dir', 'read_file', 'search']);
    const r = await agent.runChat({ cfg, mode: 'raw', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], emit: () => {} });
    assert.strictEqual(srv.requests[1].body.tools, undefined);
    assert.deepStrictEqual(srv.requests[1].body.messages.map((m) => m.content), ['S', 'U']);
    assert.strictEqual(r.messages[0].content, 'raw answer');
  } finally {
    await srv.close();
  }
});

test('plan mode: read-only tools and a planning system prompt', async () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'a.js'), 'x');
  const srv = await mock.start([
    { toolCalls: [{ name: 'write_file', args: { path: 'a.js', content: 'hacked' } }] },
    { content: '## Plan\n- [ ] 1. do it' },
  ]);
  try {
    const res = await agent.runChat({
      cfg: { baseURL: srv.baseURL, apiKey: 'test-key', model: 'm' },
      mode: 'plan', root, messages: [{ role: 'user', content: 'add a feature' }], emit: () => {},
      requestApproval: async () => { throw new Error('plan mode must not ask to edit'); },
    });
    const body = srv.requests[0].body;
    assert.deepStrictEqual(body.tools.map((t) => t.function.name).sort(), ['ask_user', 'find_files', 'list_dir', 'read_file', 'search']);
    assert.match(body.messages[0].content, /PLAN mode/);
    // Even if the model tries to write, the tool is unavailable and the file is untouched.
    assert.match(res.messages.find((m) => m.role === 'tool').content, /Unknown tool|not available/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'x');
  } finally {
    await srv.close();
  }
});

test('ask_user: questions go to the UI and answers come back to the model', async () => {
  const srv = await mock.start([
    { toolCalls: [{ name: 'ask_user', args: { questions: [
      { question: 'Which database?', options: ['PostgreSQL', 'SQLite', 'MySQL'] },
      { question: 'Which features?', options: ['Auth', 'Search', 'Export'], multi_select: true },
    ] } }] },
    { content: 'Great, using SQLite.' },
    { toolCalls: [{ name: 'ask_user', args: { questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }] } }] },
    { content: 'Ok, assuming yes.' },
  ]);
  try {
    const cfg = { baseURL: srv.baseURL, apiKey: 'test-key', model: 'm' };
    let asked = null;
    // No folder open: ask_user is still offered.
    const res = await agent.runChat({
      cfg, mode: 'agent', messages: [{ role: 'user', content: 'build an app' }], emit: () => {},
      requestApproval: async (req) => {
        asked = req;
        return { approved: true, answers: [{ selected: ['SQLite'] }, { selected: ['Auth', 'Export'], other: 'Dark mode' }] };
      },
    });
    assert.deepStrictEqual(srv.requests[0].body.tools.map((t) => t.function.name), ['ask_user']);
    assert.strictEqual(asked.kind, 'question');
    assert.strictEqual(asked.questions.length, 2);
    assert.strictEqual(asked.questions[1].multiSelect, true);
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /Which database\?\s+Answer: SQLite/);
    assert.match(toolMsg.content, /Answer: Auth; Export; Dark mode/);
    assert.ok(toolMsg._answers, 'structured answers kept for the UI');
    // the follow-up request carries the answers but not the UI-only field
    const sent = srv.requests[1].body.messages.find((m) => m.role === 'tool');
    assert.match(sent.content, /SQLite/);
    assert.strictEqual(sent._answers, undefined);
    // Dismissing the questions tells the model to proceed with assumptions.
    const res2 = await agent.runChat({
      cfg, mode: 'ask', messages: [{ role: 'user', content: 'q' }], emit: () => {},
      requestApproval: async () => ({ approved: false }),
    });
    assert.match(res2.messages.find((m) => m.role === 'tool').content, /dismissed the questions/);
  } finally {
    await srv.close();
  }
});

test('normalizeQuestions tolerates sloppy model arguments', () => {
  const q = agent.normalizeQuestions({ questions: [
    { question: ' Pick? ', options: ['a', '', { label: 'b' }], multiSelect: true },
    { question: '', options: ['x'] },
    { question: 'No options?' },
  ] });
  assert.deepStrictEqual(q, [{ question: 'Pick?', options: ['a', 'b'], multiSelect: true }]);
  assert.deepStrictEqual(agent.normalizeQuestions({}), []);
});

test('cancelling a run keeps partial output and does not throw', async () => {
  const srv = await mock.start([(req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial ' } }] })}\n\n`);
    // never finish
  }]);
  try {
    const ctrl = new AbortController();
    const p = agent.runChat({
      cfg: { baseURL: srv.baseURL, apiKey: 'test-key', model: 'm' },
      mode: 'ask',
      messages: [{ role: 'user', content: 'q' }],
      signal: ctrl.signal,
      emit: (e) => { if (e.type === 'delta') ctrl.abort(); },
    });
    const res = await p;
    assert.strictEqual(res.messages[res.messages.length - 1].content, 'partial ');
  } finally {
    srv.close();
  }
});
