'use strict';
// Integrated terminal backends, best first:
//   1. node-pty  — real PTY (ConPTY on Windows; prebuilt binaries ship for Windows x64/arm64)
//   2. `script`  — Linux without a C++ toolchain: util-linux allocates a real PTY for us
//   3. pipes     — last resort; the renderer does line editing and echo
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { terminalShell, killTree, isWin, which } = require('./platform');

let pty = null;
let ptyError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyError = e.message;
}

const terms = new Map();
let nextId = 1;

function create({ cwd, cols = 80, rows = 24, shell }, send) {
  const id = nextId++;
  const sh = terminalShell(shell);
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'cursor-clone' };
  if (pty) {
    try {
      const p = pty.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: isWin ? true : undefined });
      p.onData((d) => send('term:data', { id, data: d }));
      p.onExit(({ exitCode }) => {
        terms.delete(id);
        send('term:exit', { id, code: exitCode });
      });
      terms.set(id, { kind: 'pty', p });
      return { id, mode: 'pty', shell: sh.file };
    } catch (e) {
      ptyError = e.message;
    }
  }
  // Linux fallback #1: util-linux `script` allocates a real PTY without native modules.
  const scriptBin = process.platform === 'linux' && which('script');
  if (scriptBin) {
    const q = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
    const cmd = `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${[sh.file, ...sh.args].map(q).join(' ')}`;
    const child = spawn(scriptBin, ['-qfec', cmd, '/dev/null'], { cwd, env, detached: true });
    child.stdout.on('data', (b) => send('term:data', { id, data: b.toString() }));
    child.stderr.on('data', (b) => send('term:data', { id, data: b.toString() }));
    child.on('error', (e) => send('term:data', { id, data: `\r\n[failed to start shell: ${e.message}]\r\n` }));
    child.on('close', (code) => {
      terms.delete(id);
      send('term:exit', { id, code });
    });
    terms.set(id, { kind: 'script', p: child, pts: null });
    return { id, mode: 'pty', shell: sh.file };
  }
  // Fallback #2: no PTY. Run the shell with pipes; the renderer does line editing/echo.
  // PowerShell only reads commands from a pipe with "-Command -"; POSIX shells need -i for a prompt.
  const args = isWin ? (/pwsh|powershell/i.test(sh.file) ? ['-NoLogo', '-Command', '-'] : sh.args) : [...sh.args, '-i'];
  const child = spawn(sh.file, args, { cwd, env: { ...env, TERM: 'dumb', PS1: '$ ' }, windowsHide: true, detached: !isWin });
  const onOut = (b) => send('term:data', { id, data: b.toString().replace(/\r?\n/g, '\r\n') });
  child.stdout.on('data', onOut);
  child.stderr.on('data', onOut);
  child.on('error', (e) => send('term:data', { id, data: `\r\n[failed to start shell: ${e.message}]\r\n` }));
  child.on('close', (code) => {
    terms.delete(id);
    send('term:exit', { id, code });
  });
  terms.set(id, { kind: 'pipe', p: child });
  return { id, mode: 'pipe', shell: sh.file, note: ptyError ? `node-pty unavailable (${ptyError.split('\n')[0]}); using basic terminal.` : undefined };
}

function write(id, data) {
  const t = terms.get(id);
  if (!t) return;
  if (t.kind === 'pty') t.p.write(data);
  else if (t.kind === 'script') { if (t.p.stdin.writable) t.p.stdin.write(data); }
  else if (t.p.stdin.writable) t.p.stdin.write(isWin ? data.replace(/\r?\n/g, '\r\n') : data);
}

// Find the pts device of the shell running under `script` (Linux /proc).
function findPts(pid) {
  try {
    const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    for (const k of kids) {
      const link = fs.readlinkSync(`/proc/${k}/fd/0`);
      if (link.startsWith('/dev/pts/')) return link;
    }
  } catch { /* not available */ }
  return null;
}

function resize(id, cols, rows) {
  const t = terms.get(id);
  if (!t || !(cols > 0 && rows > 0)) return;
  if (t.kind === 'pty') {
    try { t.p.resize(cols, rows); } catch { /* exited */ }
  } else if (t.kind === 'script') {
    clearTimeout(t.resizeTimer);
    t.resizeTimer = setTimeout(() => {
      t.pts = t.pts || findPts(t.p.pid);
      // TIOCSWINSZ via stty also delivers SIGWINCH to the foreground job.
      if (t.pts) execFile('stty', ['-F', t.pts, 'cols', String(cols), 'rows', String(rows)], () => {});
    }, 100);
  }
}

function kill(id) {
  const t = terms.get(id);
  if (!t) return;
  terms.delete(id);
  try {
    if (t.kind === 'pty') t.p.kill();
    else killTree(t.p);
  } catch { /* gone */ }
}

function killAll() {
  for (const id of [...terms.keys()]) kill(id);
}

module.exports = { create, write, resize, kill, killAll, hasPty: () => !!pty };
