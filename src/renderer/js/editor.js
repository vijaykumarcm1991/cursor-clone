// Monaco editor + tab management.
import { $, h, svg, basename, relativePath, samePath, toast, modal, setStatus, joinPath, dirname } from './util.js';

export function loadMonaco() {
  return new Promise((resolve, reject) => {
    const vs = new URL('../../node_modules/monaco-editor/min/vs', location.href).href;
    window.require.config({ paths: { vs } });
    window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
  });
}

const FILENAME_LANG = {
  dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake', '.gitignore': 'ignore', '.env': 'ini', '.bashrc': 'shell', '.zshrc': 'shell',
};

export class Editors {
  constructor(monaco, app) {
    this.monaco = monaco;
    this.app = app;
    this.tabs = [];
    this.active = null;
    this.untitledSeq = 1;
    this.tabsEl = $('#tabs');
    this.welcome = $('#welcome');
    this.listeners = new Set();
    const s = app.settings;
    this.editor = monaco.editor.create($('#editor'), {
      automaticLayout: true,
      fontSize: s.fontSize,
      fontFamily: getComputedStyle(document.body).getPropertyValue('--mono'),
      tabSize: s.tabSize,
      wordWrap: s.wordWrap,
      minimap: { enabled: s.minimap },
      theme: s.theme === 'light' ? 'vs' : 'vs-dark',
      inlineSuggest: { enabled: true, mode: 'subwordSmart' },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active' },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      stickyScroll: { enabled: true },
      model: null,
    });
    this.relaxLanguageDiagnostics();
    this.editor.onDidChangeCursorPosition(() => this.updateStatus());
    this.editor.onDidChangeModelContent(() => this.refreshDirty());
    this.editor.onDidFocusEditorText(() => this.app.lastFocus = 'editor');
    this.renderTabs();
    this.updateWelcome();
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  // TS/JS diagnostics in a standalone editor have no project context → disable noisy semantic errors.
  relaxLanguageDiagnostics() {
    const ts = this.monaco.languages.typescript || this.monaco.typescript;
    if (!ts) return;
    const opts = { noSemanticValidation: true, noSyntaxValidation: false };
    try {
      ts.typescriptDefaults.setDiagnosticsOptions(opts);
      ts.javascriptDefaults.setDiagnosticsOptions(opts);
      const co = { target: ts.ScriptTarget?.ESNext ?? 99, allowNonTsExtensions: true, allowJs: true, jsx: ts.JsxEmit?.React ?? 2, module: ts.ModuleKind?.ESNext ?? 99 };
      ts.typescriptDefaults.setCompilerOptions(co);
      ts.javascriptDefaults.setCompilerOptions(co);
    } catch { /* API shape differs */ }
  }

  applySettings(s) {
    this.editor.updateOptions({ fontSize: s.fontSize, tabSize: s.tabSize, wordWrap: s.wordWrap, minimap: { enabled: s.minimap } });
    this.monaco.editor.setTheme(s.theme === 'light' ? 'vs' : 'vs-dark');
    for (const t of this.tabs) t.model.updateOptions({ tabSize: s.tabSize });
  }

  languageFor(path) {
    const name = basename(path).toLowerCase();
    if (FILENAME_LANG[name]) return FILENAME_LANG[name];
    const langs = this.monaco.languages.getLanguages();
    for (const l of langs) if ((l.filenames || []).some((f) => f.toLowerCase() === name)) return l.id;
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
      const ext = name.slice(dot);
      for (const l of langs) if ((l.extensions || []).some((e) => e.toLowerCase() === ext)) return l.id;
    }
    return 'plaintext';
  }

  find(path) {
    return this.tabs.find((t) => samePath(t.path, path));
  }

  getActive() { return this.active; }

  async open(path, { line, column, preview = false, focus = true } = {}) {
    let tab = this.find(path);
    if (!tab) {
      let r;
      try {
        r = await window.api.fs.readFile(path);
      } catch (e) {
        toast(`Cannot open ${basename(path)}: ${e.message}`, 'error');
        return null;
      }
      if (r.binary) { toast(`${basename(path)} is a binary file and cannot be opened in the editor.`, 'error'); return null; }
      if (r.tooLarge) { toast(`${basename(path)} is too large (${(r.size / 1048576).toFixed(1)} MB).`, 'error'); return null; }
      tab = this.find(path); // opened while awaiting
      if (!tab) {
        const uri = this.monaco.Uri.file(path);
        let model = this.monaco.editor.getModel(uri);
        if (model) model.setValue(r.content);
        else model = this.monaco.editor.createModel(r.content, this.languageFor(path), uri);
        model.updateOptions({ tabSize: this.app.settings.tabSize });
        tab = { path, model, viewState: null, savedVersion: model.getAlternativeVersionId(), dirty: false, preview };
        const existingPreview = preview && this.tabs.find((t) => t.preview && !t.dirty);
        if (existingPreview) {
          const i = this.tabs.indexOf(existingPreview);
          this.tabs.splice(i, 1, tab);
          this.disposeTab(existingPreview);
        } else {
          const i = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
          this.tabs.splice(i, 0, tab);
        }
      }
    } else if (!preview && tab.preview) {
      tab.preview = false;
    }
    this.activate(tab, focus);
    if (line) {
      const pos = { lineNumber: line, column: column || 1 };
      this.editor.setPosition(pos);
      this.editor.revealPositionInCenter(pos);
    }
    return tab;
  }

  newUntitled(content = '', language = 'plaintext') {
    const name = `Untitled-${this.untitledSeq++}`;
    const model = this.monaco.editor.createModel(content, language, this.monaco.Uri.parse(`untitled:///${name}`));
    const tab = { path: null, name, model, viewState: null, savedVersion: -1, dirty: !!content, preview: false, untitled: true };
    this.tabs.push(tab);
    this.activate(tab);
    return tab;
  }

  activate(tab, focus = true) {
    if (this.active && this.active !== tab) this.active.viewState = this.editor.saveViewState();
    this.active = tab;
    this.editor.setModel(tab.model);
    if (tab.viewState) this.editor.restoreViewState(tab.viewState);
    if (focus) this.editor.focus();
    this.renderTabs();
    this.updateWelcome();
    this.updateStatus();
    this.renderBreadcrumbs();
    this.emit();
    if (tab.path) this.app.explorer?.reveal(tab.path, false);
  }

  tabTitle(t) { return t.path ? basename(t.path) : t.name; }

  renderTabs() {
    this.tabsEl.innerHTML = '';
    for (const t of this.tabs) {
      const el = h('div', {
        class: `tab${t === this.active ? ' active' : ''}${t.dirty ? ' dirty' : ''}${t.preview ? ' preview' : ''}`,
        title: t.path || t.name,
        onmousedown: (e) => {
          if (e.button === 1) { e.preventDefault(); this.close(t); } else if (e.button === 0) this.activate(t);
        },
        ondblclick: () => { t.preview = false; this.renderTabs(); },
        oncontextmenu: (e) => {
          e.preventDefault();
          this.app.ui.contextMenu(e.clientX, e.clientY, [
            { label: 'Close', action: () => this.close(t) },
            { label: 'Close Others', action: () => this.closeMany(this.tabs.filter((x) => x !== t)) },
            { label: 'Close All', action: () => this.closeMany([...this.tabs]) },
            '-',
            t.path && { label: 'Copy Path', action: () => navigator.clipboard.writeText(t.path) },
            t.path && { label: 'Copy Relative Path', action: () => navigator.clipboard.writeText(relativePath(this.app.root, t.path)) },
            t.path && { label: 'Reveal in File Manager', action: () => window.api.shell.showItemInFolder(t.path) },
            t.path && { label: 'Add to Chat', action: () => this.app.chat.attach(t.path) },
          ]);
        },
      },
      h('span', { class: 'title' }, this.tabTitle(t)),
      h('button', { class: 'close', title: 'Close', onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); this.close(t); } }, svg('close')));
      this.tabsEl.append(el);
      if (t === this.active) setTimeout(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 0);
    }
  }

  renderBreadcrumbs() {
    const el = $('#breadcrumbs');
    el.innerHTML = '';
    const t = this.active;
    if (!t) return;
    const rel = t.path ? relativePath(this.app.root, t.path) : t.name;
    rel.split(/[\\/]/).forEach((p, i, arr) => {
      el.append(h('span', {}, p));
      if (i < arr.length - 1) el.append(h('span', { class: 'sep' }, '›'));
    });
  }

  updateWelcome() {
    this.welcome.style.display = this.tabs.length ? 'none' : '';
    if (!this.tabs.length) $('#breadcrumbs').innerHTML = '';
  }

  updateStatus() {
    const t = this.active;
    const pos = this.editor.getPosition();
    const sel = this.editor.getSelection();
    let posText = '';
    if (t && pos) {
      posText = `Ln ${pos.lineNumber}, Col ${pos.column}`;
      if (sel && !sel.isEmpty()) posText += ` (${t.model.getValueInRange(sel).length} selected)`;
    }
    $('#status-pos').textContent = posText;
    $('#status-lang').textContent = t ? t.model.getLanguageId() : '';
    $('#status-eol').textContent = t ? (t.model.getEOL() === '\r\n' ? 'CRLF' : 'LF') : '';
  }

  toggleEol() {
    const t = this.active;
    if (!t) return;
    const m = this.monaco.editor.EndOfLineSequence;
    t.model.pushEOL(t.model.getEOL() === '\r\n' ? m.LF : m.CRLF);
    this.updateStatus();
    this.refreshDirty();
  }

  refreshDirty() {
    let changed = false;
    for (const t of this.tabs) {
      const dirty = t.untitled ? t.model.getValueLength() > 0 : t.model.getAlternativeVersionId() !== t.savedVersion;
      if (dirty !== t.dirty) {
        t.dirty = dirty;
        if (dirty) t.preview = false;
        changed = true;
      }
    }
    if (changed) { this.renderTabs(); this.emit(); }
  }

  isDirty(path) {
    const t = this.find(path);
    return !!(t && t.dirty);
  }

  /** Unsaved buffer contents for the agent to read instead of disk. */
  overlays() {
    const o = {};
    for (const t of this.tabs) if (t.path && t.dirty) o[t.path] = t.model.getValue();
    return o;
  }

  async save(tab = this.active) {
    if (!tab) return false;
    if (!tab.path) return this.saveAs(tab);
    try {
      await window.api.fs.writeFile(tab.path, tab.model.getValue());
      tab.savedVersion = tab.model.getAlternativeVersionId();
      this.refreshDirty();
      setStatus(`Saved ${basename(tab.path)}`);
      return true;
    } catch (e) {
      toast(`Failed to save: ${e.message}`, 'error');
      return false;
    }
  }

  async saveAs(tab = this.active) {
    if (!tab) return false;
    const def = tab.path || (this.app.root ? joinPath(this.app.root, tab.name + '.txt') : tab.name);
    const p = await window.api.dialog.saveAs(def);
    if (!p) return false;
    await window.api.fs.writeFile(p, tab.model.getValue());
    const content = tab.model.getValue();
    const old = tab;
    const idx = this.tabs.indexOf(old);
    this.tabs.splice(idx, 1);
    this.disposeTab(old);
    if (this.active === old) this.active = null;
    await this.open(p);
    const nt = this.find(p);
    if (nt && nt.model.getValue() !== content) nt.model.setValue(content);
    this.app.explorer?.refreshDir(dirname(p));
    return true;
  }

  async saveAll() {
    for (const t of this.tabs) if (t.dirty) await this.save(t);
  }

  disposeTab(t) {
    try { t.model.dispose(); } catch { /* already disposed */ }
  }

  async confirmDirty(tabs) {
    const dirty = tabs.filter((t) => t.dirty);
    if (!dirty.length) return true;
    const names = dirty.map((t) => this.tabTitle(t)).join(', ');
    const r = await window.api.dialog.confirm({
      message: dirty.length === 1 ? `Do you want to save the changes you made to ${names}?` : `Do you want to save changes to ${dirty.length} files?`,
      detail: dirty.length > 1 ? names : "Your changes will be lost if you don't save them.",
      buttons: ['Save', "Don't Save", 'Cancel'],
    });
    if (r === 2) return false;
    if (r === 0) for (const t of dirty) if (!(await this.save(t))) return false;
    return true;
  }

  async close(tab = this.active) {
    if (!tab) return;
    if (!(await this.confirmDirty([tab]))) return;
    this.removeTab(tab);
  }

  async closeMany(tabs) {
    if (!(await this.confirmDirty(tabs))) return;
    for (const t of tabs) this.removeTab(t);
  }

  removeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.activate(next);
      else this.editor.setModel(null);
    }
    this.disposeTab(tab);
    this.renderTabs();
    this.updateWelcome();
    this.updateStatus();
    this.emit();
  }

  /** A file changed on disk (agent edit or external). Reload unless the user has unsaved edits. */
  async fileChangedOnDisk(path, content) {
    const t = this.find(path);
    if (!t) return;
    if (content == null) {
      try {
        const r = await window.api.fs.readFile(path);
        if (r.binary || r.tooLarge) return;
        content = r.content;
      } catch { return; } // deleted
    }
    if (t.model.getValue() === content) {
      t.savedVersion = t.model.getAlternativeVersionId();
      this.refreshDirty();
      return;
    }
    if (t.dirty) {
      setStatus(`${basename(path)} changed on disk; keeping your unsaved edits.`, 6000);
      return;
    }
    // Use an edit so undo can restore the previous version.
    t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: content }], () => null);
    t.savedVersion = t.model.getAlternativeVersionId();
    this.refreshDirty();
  }

  fileDeleted(path) {
    const affected = this.tabs.filter((t) => t.path && (samePath(t.path, path) || t.path.startsWith(path + '/') || t.path.startsWith(path + '\\')));
    for (const t of affected) {
      if (t.dirty) { t.savedVersion = -1; continue; }
      this.removeTab(t);
    }
  }

  pathRenamed(from, to) {
    for (const t of this.tabs) {
      if (!t.path) continue;
      let np = null;
      if (samePath(t.path, from)) np = to;
      else if (t.path.startsWith(from + '/') || t.path.startsWith(from + '\\')) np = to + t.path.slice(from.length);
      if (!np) continue;
      const content = t.model.getValue();
      const wasActive = this.active === t;
      const vs = wasActive ? this.editor.saveViewState() : t.viewState;
      const old = t.model;
      t.path = np;
      t.model = this.monaco.editor.createModel(content, this.languageFor(np), this.monaco.Uri.file(np));
      t.savedVersion = t.dirty ? -1 : t.model.getAlternativeVersionId();
      if (wasActive) { this.editor.setModel(t.model); if (vs) this.editor.restoreViewState(vs); }
      old.dispose();
    }
    this.renderTabs();
    this.renderBreadcrumbs();
  }

  selectionInfo() {
    const t = this.active;
    if (!t) return null;
    const sel = this.editor.getSelection();
    if (!sel || sel.isEmpty()) return null;
    return { text: t.model.getValueInRange(sel), startLine: sel.startLineNumber, endLine: sel.endLineNumber };
  }

  /**
   * Show a side-by-side diff in a modal. Resolves to { accepted, content } — the user can edit the right side.
   */
  showDiff({ title, original, modified, path, readOnly = false, acceptLabel = 'Accept', rejectLabel = 'Reject', extraFooter }) {
    const host = h('div', { class: 'diff-host' });
    const lang = path ? this.languageFor(path) : 'plaintext';
    const o = this.monaco.editor.createModel(original ?? '', lang);
    const m = this.monaco.editor.createModel(modified ?? '', lang);
    let diff;
    const buttons = [];
    if (extraFooter) buttons.push({ element: extraFooter });
    if (!readOnly) {
      buttons.push({ label: rejectLabel, value: { accepted: false } });
      buttons.push({ label: acceptLabel, primary: true, onClick: () => ({ accepted: true, content: m.getValue() }) });
    } else buttons.push({ label: 'Close', value: { accepted: false } });
    const md = modal({
      title,
      body: host,
      wide: true,
      buttons,
      onClose: () => { diff?.dispose(); o.dispose(); m.dispose(); },
    });
    diff = this.monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      renderSideBySide: host.clientWidth > 800,
      originalEditable: false,
      readOnly,
      fontSize: this.app.settings.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    diff.setModel({ original: o, modified: m });
    md.element.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !readOnly) {
        e.preventDefault();
        md.close({ accepted: true, content: m.getValue() });
      }
    });
    return md.promise.then((v) => v || { accepted: false });
  }
}
