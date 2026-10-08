'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { ProcessManager } = require('../src/main/bgproc');
const { isWin } = require('../src/main/platform');

const node = (code) => `"${process.execPath}" -e "${code.replace(/"/g, '\\"')}"`;
// Windows PowerShell needs the call operator to run a quoted executable path.
const cmd = (code) => (isWin ? `& ${node(code)}` : node(code));
const cwd = os.tmpdir();

test('foreground command completes with output and exit code', async () => {
  const m = new ProcessManager();
  const r = await m.runForeground(cmd("console.log('hello'); process.exit(3)"), { cwd });
  assert.match(r.output, /hello/);
  assert.strictEqual(r.code, 3);
  assert.ok(!r.detached);
  assert.strictEqual(m.list().length, 0, 'foreground commands are hidden from the process list');
});

test('foreground command is sent to background on timeout, keeps running, and can be read and stopped', async () => {
  const m = new ProcessManager();
  const r = await m.runForeground(cmd("let i=0; setInterval(() => console.log('tick ' + (i++)), 100)"), { cwd, timeoutMs: 600 });
  assert.ok(r.detached);
  assert.strictEqual(r.reason, 'timeout');
  assert.match(r.output, /tick 0/);
  const listed = m.list();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].status, 'running');
  await new Promise((res) => setTimeout(res, 500));
  const out = m.read(r.id);
  assert.match(out.output, /tick/);
  assert.doesNotMatch(out.output, /tick 0\b/, 'reads only return new output');
  assert.strictEqual(m.read(r.id).output.length < out.output.length + 1, true);
  assert.ok(m.stop(r.id));
  await m.get(r.id).exitPromise;
  assert.strictEqual(m.get(r.id).status, 'stopped');
});

test('manual detach (send to background)', async () => {
  const m = new ProcessManager();
  let id;
  const p = m.runForeground(cmd("setInterval(() => console.log('working'), 100)"), { cwd, timeoutMs: 60000, onStart: (i) => { id = i; } });
  await new Promise((res) => setTimeout(res, 400));
  assert.ok(m.detach(id, 'user'));
  const r = await p;
  assert.ok(r.detached);
  assert.strictEqual(r.reason, 'user');
  assert.strictEqual(m.list()[0].hidden, false);
  await m.reset();
  assert.strictEqual(m.list().length, 0);
});

test('background start: URL detection, waitFor, exit event, process tree is killed', async () => {
  const m = new ProcessManager();
  // The HTTP server runs as a grandchild (shell -> parent.js -> server.js), like `npm run dev`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgproc-'));
  fs.writeFileSync(path.join(dir, 'server.js'), "const http=require('http');const s=http.createServer((q,r)=>r.end('ok'));s.listen(0,()=>console.log('Server ready at http://localhost:'+s.address().port+'/'))");
  fs.writeFileSync(path.join(dir, 'parent.js'), "require('child_process').spawn(process.execPath,[require('path').join(__dirname,'server.js')],{stdio:'inherit'});setInterval(()=>{},1000)");
  const runParent = `"${process.execPath}" "${path.join(dir, 'parent.js')}"`;
  const info = m.start(isWin ? `& ${runParent}` : runParent, { cwd, origin: 'agent' });
  const w = await m.waitFor(info.id, 'ready', 10000);
  assert.ok(w.matched);
  const p = m.get(info.id);
  assert.match(p.url, /^http:\/\/localhost:\d+\/$/);
  const res = await fetch(p.url);
  assert.strictEqual(await res.text(), 'ok');
  const exited = new Promise((res2) => m.once('exit', res2));
  m.stop(info.id);
  const ev = await exited;
  assert.strictEqual(ev.status, 'stopped');
  // the server (a child of the shell) must be gone too
  await assert.rejects(fetch(p.url, { signal: AbortSignal.timeout(2000) }));
});

test('waitFor times out and reports exit', async () => {
  const m = new ProcessManager();
  const a = m.start(cmd("setTimeout(() => {}, 5000)"), { cwd });
  const r1 = await m.waitFor(a.id, 'never', 300);
  assert.ok(r1.timedOut);
  const b = m.start(cmd("console.log('bye')"), { cwd });
  const r2 = await m.waitFor(b.id, 'never', 10000);
  assert.ok(r2.exited && !r2.matched);
  await m.reset();
});

test('limit on running processes', async () => {
  const m = new ProcessManager({ maxRunning: 2 });
  m.start(cmd('setTimeout(()=>{},5000)'), { cwd });
  m.start(cmd('setTimeout(()=>{},5000)'), { cwd });
  assert.throws(() => m.start(cmd('1'), { cwd }), /Too many running processes/);
  await m.reset();
});

test('output buffer is bounded and readers see truncation', async () => {
  const m = new ProcessManager();
  const r = await m.runForeground(cmd("process.stdout.write('x'.repeat(700000) + '\\nEND\\n')"), { cwd });
  assert.ok(r.truncated);
  assert.match(r.output, /END/);
  assert.ok(r.output.length <= 512 * 1024);
});
