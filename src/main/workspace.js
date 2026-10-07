'use strict';
// Workspace file-system helpers shared by the UI (via IPC) and the agent tools.
// Pure Node so it can be tested without Electron. Works with both / and \ paths.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.venv', 'venv', 'env',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.cache', 'target', '.idea', '.vs', '.vscode-test', 'coverage',
  '.gradle', 'obj', 'bower_components', '.terraform', '.dart_tool', 'Pods',
]);
const HIDDEN_IN_TREE = new Set(['.git', '.hg', '.svn']);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve a user/model supplied path against the workspace root and refuse escapes. */
function resolveIn(root, p) {
  if (!root) throw new Error('No folder is open.');
  let s = String(p ?? '').trim();
  if (s === '' || s === '.' || s === './') return path.resolve(root);
  // Accept forward slashes on Windows and backslashes on POSIX from the model.
  s = process.platform === 'win32' ? s.replace(/\//g, '\\') : s.replace(/\\/g, '/');
  const abs = path.isAbsolute(s) ? path.resolve(s) : path.resolve(root, s);
  if (!isInside(path.resolve(root), abs)) throw new Error(`Path is outside the workspace: ${p}`);
  return abs;
}

function relPath(root, abs) {
  return toPosix(path.relative(root, abs)) || '.';
}

// --- tiny .gitignore support (root file only, common patterns) ---------------
function globToRegExp(glob, { matchBase = false } = {}) {
  let re = '';
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; inGroup = true; }
    else if (c === '}' && inGroup) { re += ')'; inGroup = false; }
    else if (c === ',' && inGroup) re += '|';
    else if ('\\^$+.()|[]'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  return new RegExp(matchBase ? `(?:^|/)${re}$` : `^${re}$`, process.platform === 'win32' ? 'i' : '');
}

function loadGitignore(root) {
  const rules = [];
  try {
    const text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/') || line.includes('/');
      line = line.replace(/^\//, '');
      if (!line) continue;
      rules.push({ re: globToRegExp(line, { matchBase: !anchored }), negate, dirOnly });
    }
  } catch { /* no .gitignore */ }
  return (rel, isDir) => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.negate;
    }
    return ignored;
  };
}

async function readDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (HIDDEN_IN_TREE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try { isDir = (await fsp.stat(full)).isDirectory(); } catch { /* broken link */ }
    }
    out.push({ name: e.name, path: full, isDir });
  }
  out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })));
  return out;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function readText(file) {
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw new Error(`${file} is a directory`);
  if (st.size > MAX_TEXT_BYTES) return { content: '', binary: false, tooLarge: true, size: st.size };
  const buf = await fsp.readFile(file);
  if (looksBinary(buf)) return { content: '', binary: true, tooLarge: false, size: st.size };
  let content = buf.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return { content, binary: false, tooLarge: false, size: st.size, eol: content.includes('\r\n') ? '\r\n' : '\n' };
}

async function writeText(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** Walk all (non-ignored) files under root. */
async function* walkFiles(root, { signal, includeIgnored = false } = {}) {
  const ignored = includeIgnored ? () => false : loadGitignore(root);
  const stack = [root];
  while (stack.length) {
    if (signal && signal.aborted) return;
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = relPath(root, full);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || ignored(rel, true)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (ignored(rel, false)) continue;
        yield full;
      }
    }
  }
}

async function listFiles(root, { limit = 20000, signal } = {}) {
  const out = [];
  for await (const f of walkFiles(root, { signal })) {
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

async function findFiles(root, pattern, { limit = 500 } = {}) {
  const re = globToRegExp(String(pattern || '**/*'), { matchBase: !String(pattern).includes('/') });
  const out = [];
  for await (const f of walkFiles(root)) {
    if (re.test(relPath(root, f))) {
      out.push(relPath(root, f));
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Grep across the workspace.
 * @returns {Promise<{results: Array<{path, rel, line, col, text}>, truncated: boolean}>}
 */
async function searchText(root, query, { regex = false, caseSensitive = false, wholeWord = false, include = '', maxResults = 2000, signal } = {}) {
  if (!query) return { results: [], truncated: false };
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b${source}\\b`;
  const re = new RegExp(source, caseSensitive ? 'g' : 'gi');
  const includeRe = include ? globToRegExp(include, { matchBase: !include.includes('/') }) : null;
  const results = [];
  for await (const file of walkFiles(root, { signal })) {
    const rel = relPath(root, file);
    if (includeRe && !includeRe.test(rel)) continue;
    let buf;
    try {
      const st = await fsp.stat(file);
      if (st.size > 2 * 1024 * 1024) continue;
      buf = await fsp.readFile(file);
    } catch { continue; }
    if (looksBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (m) {
        results.push({ path: file, rel, line: i + 1, col: m.index + 1, text: lines[i].slice(0, 400) });
        if (results.length >= maxResults) return { results, truncated: true };
      }
    }
  }
  return { results, truncated: false };
}

/** Short tree overview used in the agent system prompt. */
async function overview(root, { maxEntries = 120, maxDepth = 2 } = {}) {
  const lines = [];
  async function walk(dir, depth, indent) {
    if (lines.length >= maxEntries) return;
    let entries;
    try { entries = await readDir(dir); } catch { return; }
    for (const e of entries) {
      if (lines.length >= maxEntries) { lines.push(`${indent}...`); return; }
      lines.push(`${indent}${e.name}${e.isDir ? '/' : ''}`);
      if (e.isDir && depth < maxDepth && !IGNORED_DIRS.has(e.name)) await walk(e.path, depth + 1, indent + '  ');
    }
  }
  await walk(root, 1, '');
  return lines.join('\n');
}

module.exports = {
  IGNORED_DIRS, toPosix, isInside, resolveIn, relPath, globToRegExp, loadGitignore, readDir, readText, writeText,
  exists, walkFiles, listFiles, findFiles, searchText, overview, looksBinary,
};
