#!/usr/bin/env node
// Runs the end-to-end smoke test (test/smoke-main.js) in a real Electron window.
// Needs a display: on headless Linux run it under `xvfb-run -a npm run test:e2e`.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const args = [path.join(__dirname, '..', 'test', 'smoke-main.js')];
if (process.platform === 'linux') args.push('--no-sandbox');
const child = spawn(electron, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..') });
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => {
  // Chromium is noisy on CI (GPU/dbus); only surface our own output.
  const lines = d.toString().split('\n').filter((l) => l && !/^\[\d+:\d+\//.test(l) && !/Xlib|Gtk-|libva/.test(l));
  if (lines.length) process.stderr.write(lines.join('\n') + '\n');
});
child.on('close', (code) => process.exit(code ?? 1));
