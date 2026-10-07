'use strict';
// Cross-platform helpers: shell detection, running commands, killing process trees.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';

function which(cmd) {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const candidates = isWin && path.extname(cmd) ? [path.join(d, cmd)] : [path.join(d, cmd + ext)];
      for (const p of candidates) {
        try {
          if (fs.statSync(p).isFile()) return p;
        } catch { /* keep looking */ }
      }
    }
  }
  return null;
}

/** Shell for the interactive terminal. */
function terminalShell(preferred) {
  if (preferred && preferred.trim()) {
    const parts = preferred.trim().split(/\s+/);
    return { file: parts[0], args: parts.slice(1) };
  }
  if (isWin) {
    const pwsh = which('pwsh.exe');
    if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
    const ps = which('powershell.exe');
    if (ps) return { file: ps, args: ['-NoLogo'] };
    return { file: process.env.ComSpec || 'cmd.exe', args: [] };
  }
  const sh = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file: sh, args: [] };
}

/** Shell used by the agent's run_command tool (non-interactive). */
function commandShell() {
  if (isWin) {
    const pwsh = which('pwsh.exe');
    const ps = pwsh || which('powershell.exe');
    // -EncodedCommand (base64 UTF-16LE) sidesteps Windows command-line quoting entirely.
    const encode = (c) => Buffer.from(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'\n${c}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`, 'utf16le').toString('base64');
    if (ps) return { name: pwsh ? 'pwsh' : 'powershell', file: ps, args: (c) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(c)] };
    return { name: 'cmd', file: process.env.ComSpec || 'cmd.exe', args: (c) => ['/d', '/s', '/c', c] };
  }
  const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : null;
  if (bash) return { name: 'bash', file: bash, args: (c) => ['-c', c] };
  return { name: 'sh', file: '/bin/sh', args: (c) => ['-c', c] };
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWin) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Run a shell command, capturing combined output.
 * Resolves { code, output, timedOut } — never rejects for non-zero exit codes.
 */
function runCommand(command, { cwd, timeoutMs = 120000, maxOutput = 60000, signal, onData } = {}) {
  return new Promise((resolve) => {
    const sh = commandShell();
    let output = '';
    let truncated = false;
    let timedOut = false;
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI || '1', PAGER: 'cat', GIT_PAGER: 'cat' };
    let child;
    try {
      child = spawn(sh.file, sh.args(command), { cwd, env, windowsHide: true, detached: !isWin });
    } catch (e) {
      resolve({ code: -1, output: `Failed to start command: ${e.message}`, timedOut: false });
      return;
    }
    const append = (buf) => {
      const s = buf.toString();
      if (onData) onData(s);
      if (output.length < maxOutput) {
        output += s;
        if (output.length > maxOutput) {
          output = output.slice(0, maxOutput);
          truncated = true;
        }
      } else truncated = true;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => killTree(child);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const finish = (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      let out = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      if (truncated) out += '\n...[output truncated]';
      resolve({ code, output: out, timedOut });
    };
    child.on('error', (e) => {
      output += `\n${e.message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

function platformInfo() {
  return {
    platform: process.platform,
    osName: isWin ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    release: os.release(),
    arch: process.arch,
    sep: path.sep,
    shell: commandShell().name,
    home: os.homedir(),
  };
}

module.exports = { isWin, which, terminalShell, commandShell, runCommand, killTree, platformInfo };
