'use strict';
// Persistent settings stored in the Electron userData folder.
// The API key is encrypted with the OS keychain (DPAPI on Windows, libsecret/kwallet on Linux) when available.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  autocompleteEnabled: true,
  autocompleteModel: '',
  autocompleteMode: 'chat', // 'chat' | 'fim'
  autocompleteDelay: 350,
  temperature: 0.2,
  maxTokens: 0, // 0 = let the server decide
  extraHeaders: {},
  autoApproveEdits: false,
  autoApproveCommands: false,
  terminalShell: '',
  fontSize: 14,
  tabSize: 2,
  wordWrap: 'off',
  minimap: true,
  theme: 'dark',
  recentFolders: [],
  modelList: [],
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function load() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  const s = { ...DEFAULTS, ...raw };
  if (raw.apiKeyEnc) {
    try { s.apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64')); } catch { s.apiKey = ''; }
  }
  delete s.apiKeyEnc;
  if (!s.apiKey && process.env.OPENAI_API_KEY) s.apiKey = process.env.OPENAI_API_KEY;
  cache = s;
  return s;
}

function save(partial) {
  const s = { ...load(), ...partial };
  cache = s;
  const out = { ...s };
  if (out.apiKey && canEncrypt()) {
    out.apiKeyEnc = safeStorage.encryptString(out.apiKey).toString('base64');
    delete out.apiKey;
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, file());
  return s;
}

function addRecentFolder(folder) {
  const list = [folder, ...load().recentFolders.filter((f) => f !== folder)].slice(0, 10);
  save({ recentFolders: list });
}

module.exports = { load, save, addRecentFolder, DEFAULTS, canEncrypt };
