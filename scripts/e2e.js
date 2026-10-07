#!/usr/bin/env node
// Runs the end-to-end smoke test (test/smoke-main.js) in a real Electron window.
// Needs a display: on headless Linux run it under `xvfb-run -a npm run test:e2e`.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const args = [path.join(__dirname, '..', 'test', 'smoke-main.js')];
if (process.platform === 'linux') args.push('--no-sandbox');
const child = spawn(electron, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..') });
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
child.stderr.on('data', (d) => {
  stderr += d;
  // Chromium is noisy on CI (GPU/dbus); only surface our own output.
  const lines = d.toString().split('\n').filter((l) => l && !/^\[\d+:\d+\//.test(l) && !/Xlib|Gtk-|libva/.test(l));
  if (lines.length) process.stderr.write(lines.join('\n') + '\n');
});
child.on('close', (code, signal) => {
  if ((code !== 0 || signal) && process.env.GITHUB_ACTIONS) {
    // Surface failures as annotations (visible without downloading logs).
    const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
    for (const l of stdout.split('\n').filter((x) => /^FAIL|console:(error|3)/.test(x))) console.log(`::error title=e2e::${esc(l.slice(0, 1500))}`);
    const tail = (stdout + '\n' + stderr).split('\n').filter(Boolean).slice(-40).join('\n');
    console.log(`::error title=e2e exit ${code ?? signal}::${esc(tail.slice(-6000))}`);
  }
  process.exit(code ?? 1);
});
