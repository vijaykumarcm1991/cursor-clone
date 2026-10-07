// File explorer tree with lazy loading, context menu, rename/create/delete and fs watching.
import { $, h, svg, basename, dirname, joinPath, samePath, isUnder, relativePath, promptInput, toast, debounce } from './util.js';

const ICONS = {
  js: ['JS', '#e8d44d'], mjs: ['JS', '#e8d44d'], cjs: ['JS', '#e8d44d'], jsx: ['JSX', '#61dafb'], ts: ['TS', '#3178c6'], tsx: ['TSX', '#3178c6'],
  py: ['PY', '#4b8bbe'], rb: ['RB', '#cc342d'], go: ['GO', '#00add8'], rs: ['RS', '#dea584'], java: ['JV', '#e76f00'], kt: ['KT', '#a97bff'],
  c: ['C', '#659ad2'], h: ['H', '#a074c4'], cpp: ['C++', '#659ad2'], hpp: ['H++', '#a074c4'], cs: ['C#', '#68217a'], php: ['PHP', '#777bb3'],
  html: ['<>', '#e34c26'], htm: ['<>', '#e34c26'], css: ['#', '#563d7c'], scss: ['S', '#c6538c'], less: ['L', '#1d365d'], vue: ['V', '#41b883'], svelte: ['S', '#ff3e00'],
  json: ['{}', '#cbcb41'], yml: ['YML', '#cb171e'], yaml: ['YML', '#cb171e'], toml: ['TML', '#9c4221'], xml: ['XML', '#e37933'], ini: ['INI', '#888'],
  md: ['M↓', '#519aba'], txt: ['TXT', '#888'], sh: ['$', '#89e051'], bash: ['$', '#89e051'], ps1: ['PS', '#012456'], bat: ['BAT', '#c1f12e'], cmd: ['CMD', '#c1f12e'],
  sql: ['SQL', '#e38c00'], swift: ['SW', '#f05138'], dart: ['DT', '#00b4ab'], lua: ['LUA', '#000080'], r: ['R', '#198ce7'],
  png: ['IMG', '#a074c4'], jpg: ['IMG', '#a074c4'], jpeg: ['IMG', '#a074c4'], gif: ['IMG', '#a074c4'], svg: ['SVG', '#ffb13b'], ico: ['IMG', '#a074c4'],
  lock: ['🔒', '#888'], env: ['ENV', '#ecd53f'], dockerfile: ['🐳', '#2496ed'], gitignore: ['GIT', '#f14e32'],
};

function fileIcon(name) {
  const lower = name.toLowerCase();
  let key = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  if (lower === 'dockerfile') key = 'dockerfile';
  if (lower.startsWith('.env')) key = 'env';
  const [text, color] = ICONS[key] || ['•', '#888'];
  return h('span', { class: 'ficon', style: { color } }, text);
}

export class Explorer {
  constructor(app) {
    this.app = app;
    this.el = $('#tree');
    this.nodes = new Map(); // path -> node
    this.rootNode = null;
    this.selected = null;
    this.scheduleWatch = debounce(() => this.updateWatch(), 300);
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('contextmenu', (e) => {
      if (e.target === this.el && this.rootNode) { e.preventDefault(); this.showMenu(e, this.rootNode); }
    });
    $('#btn-new-file').onclick = () => this.newFile();
    $('#btn-new-folder').onclick = () => this.newFolder();
    $('#btn-refresh').onclick = () => this.refreshAll();
    $('#btn-collapse').onclick = () => this.collapseAll();
    window.api.on('fs:changed', ({ dir, files }) => this.onFsChanged(dir, files));
  }

  async setRoot(root) {
    this.nodes.clear();
    this.selected = null;
    if (!root) {
      this.rootNode = null;
      this.render();
      return;
    }
    this.rootNode = { path: root, name: basename(root), isDir: true, open: true, children: null, depth: -1 };
    this.nodes.set(root, this.rootNode);
    await this.load(this.rootNode);
    this.render();
    this.updateWatch();
  }

  async load(node) {
    try {
      const entries = await window.api.fs.readDir(node.path);
      const old = new Map((node.children || []).map((c) => [c.path, c]));
      node.children = entries.map((e) => {
        const prev = old.get(e.path);
        if (prev && prev.isDir === e.isDir) return prev;
        const n = { path: e.path, name: e.name, isDir: e.isDir, open: false, children: null, depth: node.depth + 1 };
        this.nodes.set(e.path, n);
        return n;
      });
      for (const [p, n] of old) if (!node.children.includes(n)) this.forget(n);
    } catch (e) {
      node.children = [];
      if (node === this.rootNode) toast(`Cannot read folder: ${e.message}`, 'error');
    }
  }

  forget(n) {
    this.nodes.delete(n.path);
    for (const c of n.children || []) this.forget(c);
  }

  async toggle(node, open = !node.open) {
    node.open = open;
    if (open && !node.children) await this.load(node);
    this.render();
    this.scheduleWatch();
  }

  collapseAll() {
    for (const n of this.nodes.values()) if (n !== this.rootNode) n.open = false;
    this.render();
    this.scheduleWatch();
  }

  async refreshDir(dir) {
    const n = this.nodes.get(dir) || [...this.nodes.values()].find((x) => samePath(x.path, dir));
    if (!n || !n.isDir || !n.children) return;
    await this.load(n);
    for (const c of n.children) if (c.isDir && c.open) await this.refreshDir(c.path);
    this.render();
  }

  async refreshAll() {
    if (this.rootNode) await this.refreshDir(this.rootNode.path);
  }

  onFsChanged(dir, files) {
    this.refreshDir(dir);
    for (const f of files || []) {
      if (this.app.editors.find(f)) this.app.editors.fileChangedOnDisk(f);
    }
    this.app.quickOpenCache = null;
  }

  updateWatch() {
    const dirs = [...this.nodes.values()].filter((n) => n.isDir && n.open && n.children).map((n) => n.path);
    window.api.fs.watch(dirs);
  }

  visible() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        out.push(c);
        if (c.isDir && c.open) walk(c);
      }
    };
    if (this.rootNode) walk(this.rootNode);
    return out;
  }

  render() {
    $('#no-folder').style.display = this.rootNode ? 'none' : '';
    this.el.style.display = this.rootNode ? '' : 'none';
    $('#explorer-title').textContent = this.rootNode ? this.rootNode.name.toUpperCase() : 'EXPLORER';
    const frag = document.createDocumentFragment();
    for (const n of this.visible()) {
      const row = h('div', {
        class: `tree-row${n.open ? ' open' : ''}${this.selected === n ? ' selected' : ''}${!n.isDir && this.app.editors?.isDirty(n.path) ? ' dirty' : ''}`,
        style: { paddingLeft: `${8 + n.depth * 14}px` },
        title: relativePath(this.rootNode.path, n.path),
        'data-path': n.path,
      },
      h('span', { class: 'twisty' }, n.isDir ? svg('chevron') : ''),
      n.isDir ? null : fileIcon(n.name),
      h('span', { class: 'name' }, n.name));
      row.addEventListener('click', (e) => this.onClick(n, e));
      row.addEventListener('dblclick', () => { if (!n.isDir) this.app.editors.open(n.path, { preview: false }); });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.select(n); this.showMenu(e, n); });
      n.row = row;
      frag.append(row);
    }
    this.el.innerHTML = '';
    this.el.append(frag);
  }

  select(n) {
    this.selected = n;
    for (const r of this.el.querySelectorAll('.tree-row.selected')) r.classList.remove('selected');
    if (n && n.row) {
      n.row.classList.add('selected');
      n.row.scrollIntoView({ block: 'nearest' });
    }
  }

  onClick(n, e) {
    this.select(n);
    this.el.focus();
    if (n.isDir) this.toggle(n);
    else this.app.editors.open(n.path, { preview: !e.detail || e.detail < 2, focus: false });
  }

  /** Expand parents and select a file in the tree. */
  async reveal(path, focus = true) {
    if (!this.rootNode || !isUnder(this.rootNode.path, path)) return;
    const chain = [];
    let d = dirname(path);
    while (isUnder(this.rootNode.path, d) && !samePath(d, this.rootNode.path)) {
      chain.unshift(d);
      const nd = dirname(d);
      if (nd === d) break;
      d = nd;
    }
    let changed = false;
    for (const dir of chain) {
      const n = this.nodes.get(dir);
      if (!n) break;
      if (!n.open || !n.children) {
        n.open = true;
        if (!n.children) await this.load(n);
        changed = true;
      }
    }
    if (changed) { this.render(); this.scheduleWatch(); }
    const n = this.nodes.get(path);
    if (n) { this.select(n); if (focus) this.el.focus(); }
  }

  targetDir() {
    const n = this.selected;
    if (!n) return this.rootNode && this.rootNode.path;
    return n.isDir ? n.path : dirname(n.path);
  }

  async newFile(dir = this.targetDir()) {
    if (!dir) { this.app.editors.newUntitled(); return; }
    const name = await promptInput('New file name (use / for subfolders)', { placeholder: 'e.g. src/utils.ts' });
    if (!name) return;
    const p = joinPath(dir, name.trim());
    try {
      await window.api.fs.createFile(p);
    } catch (e) {
      toast(/EEXIST/.test(e.message) ? `${name} already exists` : e.message, 'error');
      return;
    }
    await this.refreshDir(dir);
    for (let d = dirname(p); isUnder(dir, d) && !samePath(d, dir); d = dirname(d)) await this.refreshDir(d);
    await this.app.editors.open(p);
    this.reveal(p, false);
  }

  async newFolder(dir = this.targetDir()) {
    if (!dir) return;
    const name = await promptInput('New folder name');
    if (!name) return;
    const p = joinPath(dir, name.trim());
    try { await window.api.fs.createDir(p); } catch (e) { toast(e.message, 'error'); return; }
    const n = this.nodes.get(dir);
    if (n) { n.open = true; await this.load(n); }
    this.render();
    this.reveal(p);
  }

  async rename(n) {
    if (!n || n === this.rootNode) return;
    const name = await promptInput(`Rename ${n.name}`, { value: n.name, selectBase: !n.isDir });
    if (!name || name === n.name) return;
    const to = joinPath(dirname(n.path), name.trim());
    try {
      await window.api.fs.rename(n.path, to);
    } catch (e) { toast(e.message, 'error'); return; }
    this.app.editors.pathRenamed(n.path, to);
    await this.refreshDir(dirname(n.path));
    this.reveal(to);
  }

  async remove(n) {
    if (!n || n === this.rootNode) return;
    const r = await window.api.dialog.confirm({
      message: `Are you sure you want to delete '${n.name}'${n.isDir ? ' and its contents' : ''}?`,
      detail: 'You can restore it from the Trash / Recycle Bin.',
      buttons: ['Move to Trash', 'Cancel'],
    });
    if (r !== 0) return;
    try { await window.api.fs.delete(n.path); } catch (e) { toast(e.message, 'error'); return; }
    this.app.editors.fileDeleted(n.path);
    await this.refreshDir(dirname(n.path));
  }

  showMenu(e, n) {
    const dir = n.isDir ? n.path : dirname(n.path);
    const rel = relativePath(this.rootNode.path, n.path);
    this.app.ui.contextMenu(e.clientX, e.clientY, [
      { label: 'New File...', action: () => this.newFile(dir) },
      { label: 'New Folder...', action: () => this.newFolder(dir) },
      '-',
      !n.isDir && { label: 'Open', action: () => this.app.editors.open(n.path) },
      { label: 'Add to AI Chat', action: () => this.app.chat.attach(n.path) },
      { label: 'Open in Terminal', action: () => this.app.terminal.create(dir) },
      { label: 'Reveal in File Manager', action: () => window.api.shell.showItemInFolder(n.path) },
      '-',
      { label: 'Copy Path', action: () => navigator.clipboard.writeText(n.path) },
      { label: 'Copy Relative Path', action: () => navigator.clipboard.writeText(rel) },
      n !== this.rootNode && '-',
      n !== this.rootNode && { label: 'Rename...', kb: 'F2', action: () => this.rename(n) },
      n !== this.rootNode && { label: 'Delete', kb: 'Del', action: () => this.remove(n) },
    ]);
  }

  onKey(e) {
    const list = this.visible();
    if (!list.length) return;
    let i = list.indexOf(this.selected);
    const n = this.selected;
    switch (e.key) {
      case 'ArrowDown': this.select(list[Math.min(list.length - 1, i + 1)]); break;
      case 'ArrowUp': this.select(list[Math.max(0, i - 1)]); break;
      case 'ArrowRight': if (n && n.isDir && !n.open) this.toggle(n, true); break;
      case 'ArrowLeft':
        if (n && n.isDir && n.open) this.toggle(n, false);
        else if (n) { const p = this.nodes.get(dirname(n.path)); if (p && p !== this.rootNode) this.select(p); }
        break;
      case 'Enter': if (n) (n.isDir ? this.toggle(n) : this.app.editors.open(n.path)); break;
      case 'F2': this.rename(n); break;
      case 'Delete': this.remove(n); break;
      default: return;
    }
    e.preventDefault();
  }
}
