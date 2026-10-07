#!/usr/bin/env node
// Dev launcher: starts Electron on Linux and Windows. On Linux, dev checkouts of Electron
// usually lack a SUID chrome-sandbox, so we pass --no-sandbox there (packaged builds are unaffected).
const { spawn } = require('child_process');
const electron = require('electron');

const args = ['.', ...process.argv.slice(2)];
if (process.platform === 'linux' && !process.env.ELECTRON_ENABLE_SANDBOX) args.push('--no-sandbox');

const child = spawn(electron, args, { stdio: 'inherit', cwd: require('path').join(__dirname, '..') });
child.on('close', (code) => process.exit(code ?? 0));
