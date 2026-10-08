'use strict';
// Background process manager. Every agent command runs through here so that a long-running
// foreground command can be "sent to the background" (detached) instead of being killed.
// Pure Node (no Electron) so it can be unit-tested.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { commandShell, killTree, isWin } = require('./platform');

const MAX_BUFFER_CHARS = 512 * 1024; // in-memory output kept per process (~5k+ lines)
const MAX_RUNNING = 10;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]+):\d{2,5}(?:\/[^\s'"`<>)\]]*)?/i;

class Proc {
  constructor(id, { command, cwd, origin, hidden }) {
    this.id = id;
    this.command = command;
    this.cwd = cwd;
    this.origin = origin; // 'agent' | 'user'
    this.hidden = hidden; // foreground agent command not (yet) sent to background
    this.status = 'starting'; // running | exited | stopped | failed
    this.exitCode = null;
    this.pid = null;
    this.url = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.buf = '';
    this.bufStart = 0; // absolute offset of buf[0]
    this.total = 0; // absolute chars written
    this.cursors = {}; // reader -> absolute offset
    this.stopRequested = false;
    this.child = null;
    this.exitPromise = null;
  }

  info() {
    return {
      id: this.id, command: this.command, cwd: this.cwd, origin: this.origin, hidden: this.hidden, status: this.status,
      exitCode: this.exitCode, pid: this.pid, url: this.url, startedAt: this.startedAt, endedAt: this.endedAt,
    };
  }

  append(text) {
    this.buf += text;
    this.total += text.length;
    if (this.buf.length > MAX_BUFFER_CHARS) {
      const drop = this.buf.length - MAX_BUFFER_CHARS;
      // Cut at a line boundary when possible.
      const nl = this.buf.indexOf('\n', drop);
      const cut = nl >= 0 && nl - drop < 4096 ? nl + 1 : drop;
      this.buf = this.buf.slice(cut);
      this.bufStart += cut;
    }
    if (!this.url) {
      const m = stripAnsi(text).match(URL_RE);
      if (m) this.url = m[0].replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '');
    }
  }

  /** Output since `from` (absolute offset). */
  slice(from) {
    const truncated = from < this.bufStart;
    return { text: this.buf.slice(Math.max(0, from - this.bufStart)), truncated };
  }
}

class ProcessManager extends EventEmitter {
  constructor({ maxRunning = MAX_RUNNING } = {}) {
    super();
    this.maxRunning = maxRunning;
    this.procs = new Map();
    this.seq = 0;
  }

  running() {
    return [...this.procs.values()].filter((p) => p.status === 'running' || p.status === 'starting');
  }

  list({ includeHidden = false } = {}) {
    return [...this.procs.values()].filter((p) => includeHidden || !p.hidden).map((p) => p.info());
  }

  get(id) {
    return this.procs.get(String(id).trim());
  }

  _spawn({ command, cwd, origin = 'agent', hidden = false, env: extraEnv }) {
    if (this.running().length >= this.maxRunning) {
      throw new Error(`Too many running processes (limit ${this.maxRunning}). Stop one first.`);
    }
    const id = `bg-${++this.seq}`;
    const p = new Proc(id, { command, cwd, origin, hidden });
    this.procs.set(id, p);
    const sh = commandShell();
    const env = { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', ...(extraEnv || {}) };
    let resolveExit;
    p.exitPromise = new Promise((r) => { resolveExit = r; });
    try {
      // stdin stays open: some dev servers exit when stdin closes.
      p.child = spawn(sh.file, sh.args(command), { cwd, env, windowsHide: true, detached: !isWin, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      p.status = 'failed';
      p.exitCode = -1;
      p.endedAt = Date.now();
      p.append(`Failed to start: ${e.message}\n`);
      resolveExit(p);
      this.emit('status', p.info());
      return p;
    }
    p.pid = p.child.pid;
    p.status = 'running';
    const onData = (b) => {
      const text = b.toString();
      const hadUrl = !!p.url;
      p.append(text);
      this.emit('output', { id, text, hidden: p.hidden });
      if (!hadUrl && p.url) this.emit('status', p.info()); // let the UI show the detected URL
    };
    p.child.stdout.on('data', onData);
    p.child.stderr.on('data', onData);
    p.child.stdin.on('error', () => {});
    p.child.on('error', (e) => {
      p.append(`\n${e.message}\n`);
      this.emit('output', { id, text: `\n${e.message}\n`, hidden: p.hidden });
    });
    p.child.on('close', (code, signal) => {
      p.exitCode = code ?? (signal ? -1 : null);
      p.status = p.stopRequested ? 'stopped' : 'exited';
      p.endedAt = Date.now();
      p.child = null;
      resolveExit(p);
      this.emit('status', p.info());
      if (!p.hidden) this.emit('exit', p.info());
    });
    this.emit('status', p.info());
    return p;
  }

  /** Start a visible background process. */
  start(command, { cwd, origin = 'user' } = {}) {
    return this._spawn({ command, cwd, origin }).info();
  }

  /**
   * Run a command in the foreground (agent run_command). Resolves when it exits, or early with
   * { detached: true } when it is sent to the background (by the user, or because it timed out).
   */
  runForeground(command, { cwd, timeoutMs = 120000, signal, onData, onStart, backgroundOnTimeout = true } = {}) {
    const p = this._spawn({
      command, cwd, origin: 'agent', hidden: true,
      env: { FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI || '1' },
    });
    if (onStart) onStart(p.id);
    return new Promise((resolve) => {
      let settled = false;
      const listener = (ev) => { if (ev.id === p.id && onData) onData(ev.text); };
      this.on('output', listener);
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('output', listener);
        if (signal) signal.removeEventListener('abort', onAbort);
        p.onDetach = null;
        resolve({ id: p.id, ...result, output: stripAnsi(p.buf), truncated: p.bufStart > 0 });
      };
      const timer = setTimeout(() => {
        if (backgroundOnTimeout) {
          this.detach(p.id);
        } else {
          this.stop(p.id);
          done({ timedOut: true, code: null });
        }
      }, timeoutMs);
      const onAbort = () => { this.stop(p.id); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      p.onDetach = (reason) => done({ detached: true, reason, code: null });
      p.exitPromise.then(() => done({ code: p.exitCode, status: p.status }));
    });
  }

  /** Send a hidden foreground command to the background. */
  detach(id, reason = 'timeout') {
    const p = this.get(id);
    if (!p || !p.hidden) return false;
    if (p.status !== 'running') return false;
    p.hidden = false;
    // Everything so far counts as read by the agent; it already received it.
    p.cursors.agent = p.total;
    if (p.onDetach) p.onDetach(reason);
    this.emit('status', p.info());
    return true;
  }

  /** New output for a reader since its last read (agent uses its own cursor). */
  read(id, { reader = 'agent', all = false, maxChars = 20000 } = {}) {
    const p = this.get(id);
    if (!p) return null;
    const from = all ? p.bufStart : (p.cursors[reader] ?? p.bufStart);
    let { text, truncated } = p.slice(from);
    p.cursors[reader] = p.total;
    let clipped = false;
    if (text.length > maxChars) {
      text = text.slice(-maxChars);
      clipped = true;
    }
    return { ...p.info(), output: text, truncated: truncated || clipped };
  }

  /** Full buffered output (raw, with ANSI) for the UI log viewer. */
  output(id) {
    const p = this.get(id);
    return p ? { text: p.buf, truncated: p.bufStart > 0 } : null;
  }

  /** Wait until output (since `from`) matches `pattern`, the process exits, or timeout. */
  waitFor(id, pattern, timeoutMs = 15000) {
    const p = this.get(id);
    if (!p) return Promise.resolve({ matched: false, exited: true });
    let re;
    try { re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i'); } catch { re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    if (re.test(stripAnsi(p.buf))) return Promise.resolve({ matched: true, exited: p.status !== 'running' });
    return new Promise((resolve) => {
      let finished = false;
      const finish = (r) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.off('output', onOut);
        resolve(r);
      };
      const onOut = (ev) => { if (ev.id === p.id && re.test(stripAnsi(p.buf.slice(-8192)))) finish({ matched: true, exited: false }); };
      const timer = setTimeout(() => finish({ matched: false, exited: false, timedOut: true }), timeoutMs);
      this.on('output', onOut);
      p.exitPromise.then(() => finish({ matched: re.test(stripAnsi(p.buf)), exited: true }));
    });
  }

  stop(id) {
    const p = this.get(id);
    if (!p || !p.child || (p.status !== 'running' && p.status !== 'starting')) return false;
    p.stopRequested = true;
    killTree(p.child);
    return true;
  }

  async restart(id) {
    const p = this.get(id);
    if (!p) throw new Error(`No process ${id}`);
    if (p.child) {
      this.stop(id);
      await p.exitPromise;
    }
    this.procs.delete(p.id);
    this.emit('removed', { id: p.id });
    return this.start(p.command, { cwd: p.cwd, origin: p.origin });
  }

  remove(id) {
    const p = this.get(id);
    if (!p || p.child) return false;
    this.procs.delete(p.id);
    this.emit('removed', { id: p.id });
    return true;
  }

  stopAll() {
    for (const p of this.procs.values()) if (p.child) this.stop(p.id);
  }

  /** Stop everything and forget all processes (e.g. switching workspace). */
  async reset() {
    const pending = [...this.procs.values()].filter((p) => p.child).map((p) => p.exitPromise);
    this.stopAll();
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 3000))]);
    for (const id of [...this.procs.keys()]) this.emit('removed', { id });
    this.procs.clear();
  }

  /** One-line summaries for the agent's system prompt. */
  summary() {
    return this.list().map((p) => {
      const state = p.status === 'running' ? 'running' : p.status === 'stopped' ? 'stopped' : `exited with code ${p.exitCode}`;
      return `- ${p.id}: \`${p.command}\` (${state}${p.url ? `, ${p.url}` : ''}; started by ${p.origin === 'agent' ? 'you' : 'the user'})`;
    });
  }
}

const defaultManager = new ProcessManager();

module.exports = { ProcessManager, defaultManager, stripAnsi, MAX_RUNNING };
