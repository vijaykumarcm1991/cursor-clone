// Shared renderer helpers: DOM, paths, toasts, modals, quick pick, context menu.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const ICON = {
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
};

export function svg(name) {
  const t = document.createElement('template');
  t.innerHTML = ICON[name];
  return t.content.firstChild;
}

// ---- paths (renderer has no Node path module) -------------------------------
export const isWin = () => window.__platform === 'win32';
export function basename(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
export function dirname(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return s;
  if (i === 0) return s[0];
  // keep "C:\" as a root
  if (/^[A-Za-z]:$/.test(s.slice(0, i))) return s.slice(0, i + 1);
  return s.slice(0, i);
}
export function sep() {
  return isWin() ? '\\' : '/';
}
export function joinPath(dir, name) {
  const s = sep();
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + s + name.replace(/[\\/]/g, s);
}
export function samePath(a, b) {
  if (!a || !b) return false;
  return isWin() ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export function isUnder(root, p) {
  if (!root || !p) return false;
  const r = isWin() ? root.toLowerCase() : root;
  const q = isWin() ? p.toLowerCase() : p;
  return q === r || q.startsWith(r.endsWith('/') || r.endsWith('\\') ? r : r + sep());
}
export function relativePath(root, p) {
  if (!root || !isUnder(root, p)) return p;
  return p.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || basename(p);
}

// ---- misc ---------------------------------------------------------------------
export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Simple fuzzy matcher: returns score (higher is better) and matched indexes, or null. */
export function fuzzy(query, text) {
  if (!query) return { score: 0, idx: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let prev = -2;
  const idx = [];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === ' ') continue;
    const found = t.indexOf(c, ti);
    if (found < 0) return null;
    idx.push(found);
    score += found === prev + 1 ? 5 : 1;
    const before = text[found - 1];
    if (found === 0 || before === '/' || before === '\\' || before === '_' || before === '-' || before === '.' || before === ' ') score += 3;
    prev = found;
    ti = found + 1;
  }
  score -= text.length * 0.01;
  return { score, idx };
}
export function highlight(text, idx) {
  const set = new Set(idx || []);
  let out = '';
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<b>${escapeHtml(text[i])}</b>` : escapeHtml(text[i]);
  return out;
}

// ---- toasts -----------------------------------------------------------------------
let toastBox = null;
export function toast(message, kind = 'info', ms = 4000) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts' });
    document.body.append(toastBox);
  }
  const el = h('div', { class: `toast ${kind}` }, message);
  toastBox.append(el);
  const remove = () => el.remove();
  el.addEventListener('click', remove);
  setTimeout(remove, kind === 'error' ? Math.max(ms, 8000) : ms);
}

export function setStatus(msg, ms = 3000) {
  const el = document.getElementById('status-msg');
  if (!el) return;
  el.textContent = msg;
  if (ms) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, ms);
}

// ---- modal -----------------------------------------------------------------------
export function modal({ title, body, buttons = [], wide = false, onClose }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const foot = h('div', { class: 'modal-foot' });
  const box = h('div', { class: `modal${wide ? ' wide' : ''}` },
    h('div', { class: 'modal-head' }, h('span', { class: 'title' }, title || ''), h('button', { class: 'icon-btn', title: 'Close', onclick: () => close(null) }, svg('close'))),
    h('div', { class: 'modal-body' }, body),
    foot);
  backdrop.append(box);
  let closed = false;
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  function close(value) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose(value);
    resolveFn(value);
  }
  for (const b of buttons) {
    if (b.element) { foot.append(b.element); continue; }
    foot.append(h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: async () => {
      if (b.onClick) {
        const r = await b.onClick();
        if (r === false) return;
        close(r === undefined ? b.value : r);
      } else close(b.value);
    } }, b.label));
  }
  if (!buttons.length) foot.remove();
  function onKey(e) {
    // An open dropdown (model picker) handles Escape itself.
    if (e.key === 'Escape' && !document.querySelector('.mp-popup')) { e.stopPropagation(); close(null); }
  }
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
  document.getElementById('overlay-root').append(backdrop);
  return { close, promise, element: box };
}

export function promptInput(title, { value = '', placeholder = '', selectBase = false } = {}) {
  const input = h('input', { class: 'text-input', type: 'text', value, placeholder, style: { width: '100%' }, spellcheck: 'false' });
  const m = modal({
    title,
    body: input,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, onClick: () => input.value }],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); m.close(input.value); }
  });
  setTimeout(() => {
    input.focus();
    if (selectBase && value.includes('.')) input.setSelectionRange(0, value.lastIndexOf('.'));
    else input.select();
  }, 0);
  return m.promise;
}

// ---- quick pick (Ctrl+P / Ctrl+Shift+P) --------------------------------------------
let activePick = null;
/**
 * @param {object} o
 * @param {Array|((q:string)=>Array)} o.items  items: {label, description?, keybinding?, value}
 */
export function quickPick({ placeholder = '', items, initial = '', matchOn = (it) => it.label }) {
  if (activePick) activePick.close(null);
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder, value: initial, spellcheck: 'false' });
    const list = h('div', { class: 'items' });
    const box = h('div', { class: 'quickpick' }, input, list);
    let shown = [];
    let active = 0;
    const close = (val) => {
      box.remove();
      document.removeEventListener('mousedown', outside, true);
      activePick = null;
      resolve(val);
    };
    activePick = { close };
    const render = () => {
      const q = input.value.trim();
      const src = typeof items === 'function' ? items(q) : items;
      if (typeof items === 'function') shown = src.map((it) => ({ it, m: { idx: it.idx || [] } }));
      else {
        shown = src.map((it) => ({ it, m: fuzzy(q, matchOn(it)) })).filter((x) => x.m);
        if (q) shown.sort((a, b) => b.m.score - a.m.score);
      }
      shown = shown.slice(0, 200);
      active = Math.min(active, Math.max(0, shown.length - 1));
      list.innerHTML = '';
      if (!shown.length) list.append(h('div', { class: 'empty' }, 'No matching results'));
      shown.forEach(({ it, m }, i) => {
        const row = h('div', { class: `item${i === active ? ' active' : ''}` },
          h('span', { class: 'label', html: highlight(it.label, matchOn(it) === it.label ? m.idx : []) }),
          h('span', { class: 'desc' }, it.description || ''),
          it.keybinding ? h('span', { class: 'kb' }, it.keybinding) : null);
        row.addEventListener('mousedown', (e) => { e.preventDefault(); close(it.value ?? it); });
        list.append(row);
      });
      const a = list.children[active];
      if (a) a.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); const s = shown[active]; close(s ? s.it.value ?? s.it : null); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    });
    const outside = (e) => { if (!box.contains(e.target)) close(null); };
    document.addEventListener('mousedown', outside, true);
    document.getElementById('overlay-root').append(box);
    render();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

// ---- context menu ---------------------------------------------------------------------
export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctxmenu').forEach((m) => m.remove());
  const menu = h('div', { class: 'ctxmenu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div', { class: 'sep' })); continue; }
    if (!it) continue;
    menu.append(h('div', { class: 'item', onclick: () => { menu.remove(); it.action(); } }, h('span', {}, it.label), it.kb ? h('span', { class: 'muted' }, it.kb) : null));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  const off = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off, true); }
  };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
}

/** Simple line diff stats (+added/-removed) using LCS on lines (bounded). */
export function diffStat(a, b) {
  const x = (a || '').split(/\r?\n/);
  const y = (b || '').split(/\r?\n/);
  if (x.length * y.length > 4e6) {
    const sx = new Set(x);
    const sy = new Set(y);
    return { add: y.filter((l) => !sx.has(l)).length, del: x.filter((l) => !sy.has(l)).length };
  }
  const n = x.length;
  const m = y.length;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[m];
  return { add: m - lcs, del: n - lcs };
}
