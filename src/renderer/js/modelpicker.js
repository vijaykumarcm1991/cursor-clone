// Searchable, scrollable model picker (replaces <datalist>, whose popup can't scroll in Electron).
// Free text is allowed, so servers without a /models endpoint still work.
import { h, escapeHtml } from './util.js';

export class ModelPicker {
  /**
   * @param {object} o
   * @param {string} [o.value]
   * @param {string} [o.placeholder]
   * @param {(force:boolean)=>Promise<{models:string[], error?:string}>} o.load  model source
   * @param {(value:string)=>void} [o.onChange]
   * @param {()=>string} [o.defaultModel]  model to tag as "default" in the list
   * @param {string} [o.emptyLabel]        if set, adds a first item that selects '' (e.g. "Same as chat model")
   * @param {string} [o.className]
   */
  constructor(o) {
    this.o = o;
    this.models = [];
    this.error = '';
    this.input = h('input', { type: 'text', class: 'mp-input', value: o.value || '', placeholder: o.placeholder || 'model', spellcheck: 'false', autocomplete: 'off' });
    this.toggleBtn = h('button', { class: 'mp-toggle', type: 'button', title: 'Show models', tabindex: '-1' }, '▾');
    this.el = h('div', { class: `mp ${o.className || ''}` }, this.input, this.toggleBtn);
    this.popup = null;
    this.active = -1;
    this.filterOn = false;
    this.lastCommitted = o.value || '';

    this.input.addEventListener('focus', () => this.input.select());
    this.input.addEventListener('mousedown', () => { if (!this.popup) setTimeout(() => this.open(), 0); });
    this.input.addEventListener('input', () => { if (!this.popup) this.open(false, true); else { this.filterOn = true; this.active = 0; this.render(); } });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('change', () => { if (!this.popup) this.commit(this.input.value.trim()); });
    this.toggleBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (this.popup) this.close();
      else { this.input.focus(); this.open(); }
    });
  }

  get value() { return this.input.value.trim(); }
  set value(v) { this.input.value = v || ''; this.lastCommitted = v || ''; }

  async open(force = false, filter = false) {
    if (!this.popup) {
      this.popup = h('div', { class: 'mp-popup' });
      this.popup.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in input
      document.getElementById('overlay-root').append(this.popup);
      this.onDocDown = (e) => { if (!this.el.contains(e.target) && !this.popup?.contains(e.target)) this.close(true); };
      this.onScroll = (e) => { if (this.popup && !this.popup.contains(e.target)) this.position(); };
      this.onResize = () => this.position();
      document.addEventListener('mousedown', this.onDocDown, true);
      document.addEventListener('scroll', this.onScroll, true);
      window.addEventListener('resize', this.onResize);
      this.filterOn = filter;
      this.active = filter ? 0 : -1;
    }
    this.loading = true;
    this.render();
    this.position();
    try {
      const r = await this.o.load(force);
      this.models = r.models || [];
      this.error = r.error || '';
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;
    if (!this.popup) return;
    if (this.active < 0) this.active = Math.max(0, this.items().findIndex((it) => it.value === this.value));
    this.render();
    this.position();
  }

  close(commit = false) {
    if (!this.popup) return;
    this.popup.remove();
    this.popup = null;
    document.removeEventListener('mousedown', this.onDocDown, true);
    document.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onResize);
    if (commit) this.commit(this.value);
  }

  commit(v) {
    this.input.value = v;
    if (v !== this.lastCommitted) {
      this.lastCommitted = v;
      if (this.o.onChange) this.o.onChange(v);
    }
  }

  items() {
    const q = this.filterOn ? this.value.toLowerCase() : '';
    const list = this.models.filter((m) => !q || m.toLowerCase().includes(q)).map((m) => ({ value: m, label: m }));
    if (this.o.emptyLabel && !q) list.unshift({ value: '', label: this.o.emptyLabel, muted: true });
    const typed = this.value;
    if (this.filterOn && typed && !this.models.includes(typed)) list.push({ value: typed, label: `Use "${typed}"`, custom: true });
    return list;
  }

  render() {
    if (!this.popup) return;
    const items = this.items();
    const def = this.o.defaultModel ? this.o.defaultModel() : '';
    this.popup.innerHTML = '';
    const head = h('div', { class: 'mp-head' },
      h('span', {}, this.loading ? 'Loading models…' : `${this.models.length} model${this.models.length === 1 ? '' : 's'} available`),
      h('button', { class: 'cb-btn', type: 'button', title: 'Refresh from the server', onclick: () => this.open(true) }, '⟳ Refresh'));
    this.popup.append(head);
    if (this.error) this.popup.append(h('div', { class: 'mp-error' }, `Couldn't list models: ${this.error}. You can still type a model name.`));
    const list = h('div', { class: 'mp-list' });
    if (!items.length && !this.loading) list.append(h('div', { class: 'mp-empty' }, this.models.length ? 'No matching models' : 'Type a model name'));
    items.forEach((it, i) => {
      const row = h('div', {
        class: `mp-item${i === this.active ? ' active' : ''}${it.value === this.value && !it.custom ? ' selected' : ''}${it.muted ? ' muted' : ''}`,
        title: it.value,
        html: `<span class="mp-name">${escapeHtml(it.label)}</span>${it.value && it.value === def ? '<span class="mp-tag">default</span>' : ''}`,
      });
      row.addEventListener('click', () => { this.commit(it.value); this.close(); });
      row.addEventListener('mousemove', () => { if (this.active !== i) { this.active = i; this.highlight(); } });
      list.append(row);
    });
    this.popup.append(list);
    this.list = list;
    this.highlight(true);
  }

  highlight(scroll = false) {
    if (!this.list) return;
    [...this.list.children].forEach((c, i) => c.classList.toggle('active', i === this.active));
    const a = this.list.children[this.active];
    if (a && scroll) a.scrollIntoView({ block: 'nearest' });
  }

  position() {
    if (!this.popup) return;
    const r = this.el.getBoundingClientRect();
    const width = Math.max(r.width, 260);
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const openUp = below < 240 && above > below;
    const maxH = Math.max(120, Math.min(360, openUp ? above : below));
    Object.assign(this.popup.style, {
      left: `${Math.max(4, Math.min(r.left, window.innerWidth - width - 4))}px`,
      width: `${width}px`,
      maxHeight: `${maxH}px`,
      top: openUp ? '' : `${r.bottom + 2}px`,
      bottom: openUp ? `${window.innerHeight - r.top + 2}px` : '',
    });
  }

  onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.popup) { this.open(); return; }
      const n = this.items().length;
      if (!n) return;
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n;
      this.highlight(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = this.popup ? this.items()[this.active] : null;
      this.commit(it ? it.value : this.value);
      this.close();
    } else if (e.key === 'Escape') {
      if (this.popup) { e.preventDefault(); e.stopPropagation(); this.input.value = this.lastCommitted ?? this.input.value; this.close(); }
    } else if (e.key === 'Tab') {
      this.close(true);
    }
  }
}
