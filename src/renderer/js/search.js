// Workspace-wide text search panel.
import { $, h, basename, dirname, relativePath, escapeHtml, debounce } from './util.js';

export class SearchView {
  constructor(app) {
    this.app = app;
    this.input = $('#search-input');
    this.include = $('#search-include');
    this.opts = { caseSensitive: false, wholeWord: false, regex: false };
    this.seq = 0;
    const run = debounce(() => this.run(), 300);
    this.input.addEventListener('input', run);
    this.include.addEventListener('input', run);
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });
    for (const [id, key] of [['#search-case', 'caseSensitive'], ['#search-word', 'wholeWord'], ['#search-regex', 'regex']]) {
      const b = $(id);
      b.addEventListener('click', () => {
        this.opts[key] = !this.opts[key];
        b.classList.toggle('on', this.opts[key]);
        this.run();
      });
    }
  }

  focus(text) {
    if (text) this.input.value = text;
    this.input.focus();
    this.input.select();
    if (text) this.run();
  }

  async run() {
    const q = this.input.value;
    const seq = ++this.seq;
    const out = $('#search-results');
    const summary = $('#search-summary');
    if (!q || !this.app.root) {
      out.innerHTML = '';
      summary.textContent = this.app.root ? '' : 'Open a folder to search.';
      return;
    }
    if (this.opts.regex) {
      try { new RegExp(q); } catch (e) { summary.textContent = `Invalid regex: ${e.message}`; return; }
    }
    summary.textContent = 'Searching...';
    let res;
    try {
      res = await window.api.fs.search(q, { ...this.opts, include: this.include.value.trim(), maxResults: 3000 });
    } catch (e) {
      summary.textContent = e.message;
      return;
    }
    if (seq !== this.seq) return;
    const groups = new Map();
    for (const r of res.results) {
      if (!groups.has(r.path)) groups.set(r.path, []);
      groups.get(r.path).push(r);
    }
    summary.textContent = res.results.length
      ? `${res.results.length}${res.truncated ? '+' : ''} results in ${groups.size} files`
      : 'No results found.';
    let src = this.opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (this.opts.wholeWord) src = `\\b${src}\\b`;
    const re = new RegExp(src, this.opts.caseSensitive ? 'g' : 'gi');
    const frag = document.createDocumentFragment();
    for (const [path, items] of groups) {
      const rel = relativePath(this.app.root, path);
      const lines = h('div');
      const head = h('div', { class: 'sr-file', title: rel, onclick: () => lines.classList.toggle('hidden') },
        h('span', {}, basename(path)), h('span', { class: 'dir' }, dirname(rel) === rel ? '' : dirname(rel)), h('span', { class: 'count' }, items.length));
      for (const it of items) {
        const text = it.text.replace(/^\s+/, '');
        lines.append(h('div', { class: 'sr-line', title: `${rel}:${it.line}`, html: markMatches(text, re), onclick: () => this.app.editors.open(path, { line: it.line, column: it.col, preview: true }) }));
      }
      frag.append(head, lines);
    }
    out.innerHTML = '';
    out.append(frag);
  }
}

function markMatches(text, re) {
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 200) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += escapeHtml(text.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}
