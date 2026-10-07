// AI chat panel: Agent / Ask modes, streaming, tool cards, approvals, apply & revert.
import { marked } from '../../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../../node_modules/dompurify/dist/purify.es.mjs';
import { $, h, basename, relativePath, uid, toast, fuzzy, highlight, diffStat, escapeHtml, samePath, dirname } from './util.js';
import { startRun, rawCompletion, stripFences } from './aiclient.js';

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const info = (lang || '').trim();
      return `<pre data-info="${escapeHtml(info)}"><code>${escapeHtml(text)}</code></pre>`;
    },
  },
});

const TOOL_LABEL = {
  list_dir: 'List', read_file: 'Read', search: 'Search', find_files: 'Find', write_file: 'Write', edit_file: 'Edit', delete_file: 'Delete', run_command: 'Run',
};

function toolArgSummary(name, args) {
  if (!args) return '';
  switch (name) {
    case 'run_command': return args.command || '';
    case 'search': return `${args.query || ''}${args.include ? `  in ${args.include}` : ''}`;
    case 'find_files': return args.pattern || '';
    case 'read_file': return `${args.path || ''}${args.start_line ? `:${args.start_line}-${args.end_line || ''}` : ''}`;
    default: return args.path || '';
  }
}

function parseArgs(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

export class Chat {
  constructor(app) {
    this.app = app;
    this.list = $('#chat-messages');
    this.input = $('#chat-input');
    this.modeSel = $('#chat-mode');
    this.modelInput = $('#chat-model');
    this.ctxEl = $('#chat-context');
    this.historySel = $('#chat-history');
    this.chats = [];
    this.current = null;
    this.attached = []; // absolute paths
    this.snippets = []; // {path, startLine, endLine, text}
    this.includeActive = true;
    this.run = null;
    this.mention = null;

    try { this.modeSel.value = localStorage.getItem('chat.mode') || 'agent'; } catch { /* ignore */ }
    this.modeSel.addEventListener('change', () => { try { localStorage.setItem('chat.mode', this.modeSel.value); } catch { /* ignore */ } });
    this.modelInput.addEventListener('change', () => this.app.saveSettings({ model: this.modelInput.value.trim() }));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('input', () => { this.autosize(); this.updateMention(); });
    $('#btn-send').onclick = () => this.send();
    $('#btn-stop').onclick = () => this.stop();
    $('#btn-new-chat').onclick = () => this.newChat();
    $('#btn-delete-chat').onclick = () => this.deleteChat();
    $('#btn-close-chat').onclick = () => this.app.layout.toggleChat(false);
    $('#btn-attach').onclick = () => this.pickAttachment();
    this.historySel.addEventListener('change', () => this.load(this.historySel.value));
    this.app.editors.onChange(() => this.renderContext());
    this.app.editors.editor.onDidChangeCursorSelection(() => this.renderContext());
  }

  // ---------------------------------------------------------------- persistence
  storageKey() { return `chats:${this.app.root || '__none__'}`; }

  loadAll() {
    try { this.chats = JSON.parse(localStorage.getItem(this.storageKey()) || '[]'); } catch { this.chats = []; }
    if (!this.chats.length) this.chats = [this.blankChat()];
    this.chats.sort((a, b) => b.updated - a.updated);
    this.load(this.chats[0].id);
  }

  persist() {
    const data = this.chats.filter((c) => c.messages.length).slice(0, 50);
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(data));
    } catch {
      // Quota: drop revert snapshots and older chats, then retry.
      for (const c of data) for (const m of c.messages) if (m.role === 'ui' && m.changes) for (const ch of m.changes) ch.before = undefined;
      try { localStorage.setItem(this.storageKey(), JSON.stringify(data.slice(0, 15))); } catch { /* give up */ }
    }
  }

  blankChat() { return { id: uid(), title: 'New Chat', messages: [], updated: Date.now() }; }

  load(id) {
    this.current = this.chats.find((c) => c.id === id) || this.chats[0];
    this.renderHistory();
    this.renderMessages();
  }

  newChat() {
    if (this.run) return;
    const empty = this.chats.find((c) => !c.messages.length);
    const c = empty || this.blankChat();
    if (!empty) this.chats.unshift(c);
    this.load(c.id);
    this.input.focus();
  }

  deleteChat() {
    if (this.run || !this.current) return;
    this.chats = this.chats.filter((c) => c !== this.current);
    if (!this.chats.length) this.chats = [this.blankChat()];
    this.persist();
    this.load(this.chats[0].id);
  }

  renderHistory() {
    this.historySel.innerHTML = '';
    for (const c of this.chats) {
      const o = h('option', { value: c.id }, c.title || 'New Chat');
      this.historySel.append(o);
    }
    if (this.current) this.historySel.value = this.current.id;
  }

  // ---------------------------------------------------------------- context
  attach(path) {
    if (!path) return;
    if (!this.attached.some((p) => samePath(p, path))) this.attached.push(path);
    this.app.layout.toggleChat(true);
    this.renderContext();
    this.input.focus();
  }

  addSelection() {
    const t = this.app.editors.getActive();
    const sel = this.app.editors.selectionInfo();
    if (!t || !sel) return false;
    this.snippets.push({ path: t.path || t.name, ...sel });
    this.renderContext();
    return true;
  }

  async pickAttachment() {
    const files = await this.app.allFiles();
    const items = files.map((p) => ({ label: basename(p), description: relativePath(this.app.root, p), value: p }));
    const pick = await this.app.ui.quickPick({ placeholder: 'Attach a file to the chat', items, matchOn: (it) => it.description });
    if (pick) this.attach(pick);
  }

  renderContext() {
    this.ctxEl.innerHTML = '';
    const t = this.app.editors.getActive();
    if (t) {
      const sel = this.app.editors.selectionInfo();
      const label = `${t.path ? basename(t.path) : t.name}${sel ? ` (L${sel.startLine}-${sel.endLine})` : ''}`;
      this.ctxEl.append(h('span', {
        class: `chip clickable${this.includeActive ? '' : ' off'}`,
        title: this.includeActive ? 'Current file is included. Click to exclude.' : 'Current file excluded. Click to include.',
        onclick: () => { this.includeActive = !this.includeActive; this.renderContext(); },
      }, h('span', { class: 'label' }, `📄 ${label}`), h('span', { class: 'muted' }, 'current')));
    }
    this.snippets.forEach((s, i) => {
      this.ctxEl.append(h('span', { class: 'chip', title: s.text.slice(0, 500) },
        h('span', { class: 'label' }, `✂ ${basename(s.path)} L${s.startLine}-${s.endLine}`),
        h('button', { title: 'Remove', onclick: () => { this.snippets.splice(i, 1); this.renderContext(); } }, '×')));
    });
    this.attached.forEach((p, i) => {
      this.ctxEl.append(h('span', { class: 'chip', title: p },
        h('span', { class: 'label' }, `@ ${basename(p)}`),
        h('button', { title: 'Remove', onclick: () => { this.attached.splice(i, 1); this.renderContext(); } }, '×')));
    });
  }

  buildContext() {
    const t = this.app.editors.getActive();
    const ctx = { files: [...this.attached], snippets: [...this.snippets] };
    if (t && this.includeActive) {
      const sel = this.app.editors.selectionInfo();
      const pos = this.app.editors.editor.getPosition();
      ctx.activeFile = {
        path: t.path || t.name,
        content: t.model.getValue(),
        cursorLine: pos ? pos.lineNumber : undefined,
        selection: sel || undefined,
      };
    }
    return ctx;
  }

  // ---------------------------------------------------------------- composer
  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(220, Math.max(60, this.input.scrollHeight + 2))}px`;
  }

  onKey(e) {
    if (this.mention && this.mention.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.mention.items.length;
        this.mention.active = (this.mention.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.renderMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.acceptMention(this.mention.items[this.mention.active]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); this.closeMention(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    } else if (e.key === 'Escape' && this.run) {
      this.stop();
    }
  }

  async updateMention() {
    const pos = this.input.selectionStart;
    const before = this.input.value.slice(0, pos);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m || !this.app.root) { this.closeMention(); return; }
    const q = m[2];
    const files = await this.app.allFiles();
    const scored = [];
    for (const p of files) {
      const rel = relativePath(this.app.root, p);
      const f = fuzzy(q, rel);
      if (f) scored.push({ p, rel, f });
    }
    scored.sort((a, b) => b.f.score - a.f.score);
    this.mention = { start: pos - q.length - 1, end: pos, items: scored.slice(0, 30), active: 0 };
    this.renderMention();
  }

  renderMention() {
    let menu = $('.mention-menu');
    if (!this.mention || !this.mention.items.length) { if (menu) menu.remove(); return; }
    if (!menu) {
      menu = h('div', { class: 'mention-menu' });
      $('#chat-composer').append(menu);
    }
    menu.innerHTML = '';
    this.mention.items.forEach((it, i) => {
      const row = h('div', { class: `item${i === this.mention.active ? ' active' : ''}`, html: highlight(it.rel, it.f.idx) });
      row.addEventListener('mousedown', (e) => { e.preventDefault(); this.acceptMention(it); });
      menu.append(row);
    });
    const a = menu.children[this.mention.active];
    if (a) a.scrollIntoView({ block: 'nearest' });
  }

  acceptMention(it) {
    const v = this.input.value;
    this.input.value = v.slice(0, this.mention.start) + `@${basename(it.p)} ` + v.slice(this.mention.end);
    this.attach(it.p);
    this.closeMention();
  }

  closeMention() {
    this.mention = null;
    const menu = $('.mention-menu');
    if (menu) menu.remove();
  }

  focus() {
    this.input.focus();
  }

  setRunning(on) {
    $('#btn-send').classList.toggle('hidden', on);
    $('#btn-stop').classList.toggle('hidden', !on);
    this.historySel.disabled = on;
  }

  stop() {
    if (this.run) this.run.cancel();
  }

  // ---------------------------------------------------------------- send / run
  async send(textOverride) {
    const text = (textOverride ?? this.input.value).trim();
    if (!text || this.run) return;
    const s = this.app.settings;
    if (!s.apiKey && /api\.openai\.com/.test(s.baseURL)) {
      toast('Set your API key (or point Base URL at a local server such as Ollama) in Settings.', 'error');
      this.app.openSettings();
      return;
    }
    const mode = this.modeSel.value;
    const context = this.buildContext();
    const chat = this.current;
    const userMsg = {
      role: 'user',
      content: text,
      _display: text,
      _files: [
        ...(context.activeFile ? [`📄 ${basename(context.activeFile.path)}`] : []),
        ...context.snippets.map((sn) => `✂ ${basename(sn.path)} L${sn.startLine}-${sn.endLine}`),
        ...context.files.map((f) => `@ ${basename(f)}`),
      ],
    };
    chat.messages.push(userMsg);
    if (chat.title === 'New Chat') chat.title = text.slice(0, 60).replace(/\s+/g, ' ');
    chat.updated = Date.now();
    this.chats.sort((a, b) => b.updated - a.updated);
    this.renderHistory();
    this.input.value = '';
    this.autosize();
    this.snippets = [];
    this.attached = [];
    this.renderContext();
    this.renderMessages();

    const live = new LiveRun(this);
    this.setRunning(true);
    const apiMessages = chat.messages.filter((m) => m.role !== 'ui');
    this.run = startRun({
      mode,
      messages: apiMessages,
      context,
      overlays: this.app.editors.overlays(),
      cfg: this.modelInput.value.trim() ? { model: this.modelInput.value.trim() } : undefined,
    }, (ev) => live.onEvent(ev));
    let res;
    try {
      res = await this.run.promise;
    } catch (e) {
      res = { error: e.message, messages: [], changes: [] };
    }
    this.run = null;
    this.setRunning(false);

    const newMsgs = res.messages || [];
    if (newMsgs.length && newMsgs[0].role === 'user') {
      const aug = newMsgs.shift();
      userMsg.content = aug.content;
    }
    chat.messages.push(...newMsgs);
    if (res.changes && res.changes.length) chat.messages.push({ role: 'ui', kind: 'changes', changes: res.changes });
    if (res.error) chat.messages.push({ role: 'ui', kind: 'error', text: res.error });
    // A trailing assistant message with unanswered tool calls would break the next request.
    this.repairHistory(chat);
    chat.updated = Date.now();
    this.persist();
    this.renderMessages();
  }

  repairHistory(chat) {
    const msgs = chat.messages;
    const answered = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'assistant' && m.tool_calls) {
        const missing = m.tool_calls.filter((c) => !answered.has(c.id));
        let at = i + 1;
        while (at < msgs.length && msgs[at].role === 'tool') at++;
        for (const c of missing) msgs.splice(at++, 0, { role: 'tool', tool_call_id: c.id, content: 'Not executed (run was interrupted).' });
      }
    }
  }

  // ---------------------------------------------------------------- rendering
  renderMessages() {
    const msgs = this.current ? this.current.messages : [];
    this.list.innerHTML = '';
    if (!msgs.length) {
      const s = this.app.settings;
      this.list.append(h('div', { class: 'chat-empty' },
        h('h3', {}, 'AI Chat'),
        h('p', {}, 'Agent mode can read, edit and create files and run commands (with your approval). Ask mode answers questions about your code.'),
        h('p', { class: 'muted' }, `Model: ${this.modelInput.value || s.model} · ${s.baseURL}`),
        h('p', { class: 'muted' }, 'Tip: select code and press Ctrl+L to add it here, or Ctrl+K to edit it inline.')));
      return;
    }
    const toolResults = new Map(msgs.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
    for (const m of msgs) {
      if (m.role === 'user') this.list.append(this.userEl(m));
      else if (m.role === 'assistant') {
        const el = h('div', { class: 'msg assistant' });
        if (m.content) {
          const md = h('div', { class: 'md' });
          this.renderMarkdown(md, m.content, true);
          el.append(md);
        }
        for (const c of m.tool_calls || []) {
          const card = this.toolCard(c.id, c.function.name, parseArgs(c.function.arguments));
          const r = toolResults.get(c.id);
          if (r) this.finishToolCard(card, { ok: !/^(Error|The user rejected|The user declined|Not executed|Cancelled)/.test(r.content || ''), output: r.content });
          el.append(card);
        }
        this.list.append(el);
      } else if (m.role === 'ui' && m.kind === 'changes') this.list.append(this.changesEl(m));
      else if (m.role === 'ui' && m.kind === 'error') this.list.append(h('div', { class: 'error-box' }, m.text));
    }
    this.scrollToBottom(true);
  }

  userEl(m) {
    return h('div', { class: 'msg user' },
      m._files && m._files.length ? h('div', { class: 'ctx-files' }, m._files.map((f) => h('span', { class: 'chip' }, h('span', { class: 'label' }, f)))) : null,
      h('div', { class: 'bubble' }, m._display ?? m.content));
  }

  scrollToBottom(force = false) {
    const l = this.list;
    if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 120) l.scrollTop = l.scrollHeight;
  }

  renderMarkdown(el, text, final) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['data-info'] });
    for (const a of el.querySelectorAll('a[href]')) {
      a.addEventListener('click', (e) => { e.preventDefault(); window.api.shell.openExternal(a.getAttribute('href')); });
    }
    for (const pre of el.querySelectorAll('pre')) this.decorateCode(pre, final);
  }

  decorateCode(pre, final) {
    const info = pre.getAttribute('data-info') || '';
    const [langRaw, ...rest] = info.split(/\s+/);
    let lang = langRaw || '';
    let filePath = rest.join(' ').trim();
    // Also accept ```path/to/file.ts (path only) and ```ts:path/to/file.ts
    if (!filePath && lang.includes(':')) [lang, filePath] = [lang.split(':')[0], lang.split(':').slice(1).join(':')];
    if (!filePath && /[./\\]/.test(lang) && !/^\./.test(lang)) { filePath = lang; lang = ''; }
    const code = pre.querySelector('code');
    const text = code ? code.textContent : pre.textContent;
    const wrap = h('div', { class: 'codeblock' });
    const head = h('div', { class: 'cb-head' }, h('span', { class: 'lang', title: filePath || lang }, filePath || lang || 'code'));
    const btn = (label, title, fn) => h('button', { class: 'cb-btn', title, onclick: fn }, label);
    head.append(btn('Copy', 'Copy to clipboard', async (e) => {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
    }));
    if (final) {
      head.append(btn('Insert', 'Insert at cursor in the active editor', () => this.insertAtCursor(text)));
      head.append(btn('Apply', filePath ? `Apply to ${filePath}` : 'Apply to the active file', () => this.apply(text, filePath)));
    }
    pre.replaceWith(wrap);
    wrap.append(head, pre);
    if (final && code) {
      const monaco = this.app.monaco;
      const id = lang ? (monaco.languages.getLanguages().find((l) => l.id === lang || (l.aliases || []).some((a) => a.toLowerCase() === lang.toLowerCase()) || (l.extensions || []).includes('.' + lang))?.id) : null;
      const langId = id || (filePath ? this.app.editors.languageFor(filePath) : null);
      if (langId && langId !== 'plaintext' && text.length < 100000) {
        monaco.editor.colorize(text, langId, { tabSize: 4 }).then((html) => { code.innerHTML = html; }).catch(() => {});
      }
    }
  }

  insertAtCursor(text) {
    const ed = this.app.editors.editor;
    const t = this.app.editors.getActive();
    if (!t) { this.app.editors.newUntitled(text); return; }
    const sel = ed.getSelection();
    ed.executeEdits('ai-insert', [{ range: sel, text, forceMoveMarkers: true }]);
    ed.focus();
  }

  /** Apply a code block to a file. Uses the model to merge partial snippets (like Cursor's apply). */
  async apply(snippet, filePath) {
    const editors = this.app.editors;
    let target = null;
    if (filePath && this.app.root) {
      const rel = filePath.replace(/^\.?[\\/]/, '');
      const abs = await window.api.path.join(this.app.root, rel);
      target = abs;
    } else if (editors.getActive() && editors.getActive().path) {
      target = editors.getActive().path;
    }
    if (!target) { toast('Open a file (or include a file path in the code block) to apply.', 'error'); return; }
    const exists = await window.api.fs.exists(target);
    let original = '';
    const openTab = editors.find(target);
    if (openTab) original = openTab.model.getValue();
    else if (exists) {
      const r = await window.api.fs.readFile(target);
      original = r.content;
    }
    let merged = snippet;
    const origLines = original.split('\n').length;
    const snipLines = snippet.split('\n').length;
    const looksComplete = !original.trim() || snipLines >= origLines * 0.7;
    if (!looksComplete) {
      toast(`Applying changes to ${basename(target)}...`, 'info', 2500);
      try {
        const { promise } = rawCompletion([
          { role: 'system', content: 'You merge code edits into files. Given the ORIGINAL file and an EDIT snippet (which may use comments like "// ... existing code ..." to elide unchanged parts), output the COMPLETE updated file with the edit applied. Output only the file content, no explanations and no markdown fences.' },
          { role: 'user', content: `ORIGINAL FILE (${relativePath(this.app.root, target)}):\n\`\`\`\n${original}\n\`\`\`\n\nEDIT:\n\`\`\`\n${snippet}\n\`\`\`` },
        ], { temperature: 0 });
        merged = stripFences(await promise);
        if (original.endsWith('\n') && !merged.endsWith('\n')) merged += '\n';
      } catch (e) {
        toast(`Apply failed: ${e.message}`, 'error');
        return;
      }
    }
    const res = await editors.showDiff({ title: `Apply to ${relativePath(this.app.root, target)}`, original, modified: merged, path: target, acceptLabel: 'Accept (Ctrl+Enter)' });
    if (!res.accepted) return;
    if (openTab) {
      openTab.model.pushEditOperations([], [{ range: openTab.model.getFullModelRange(), text: res.content }], () => null);
      await editors.save(openTab);
    } else {
      await window.api.fs.writeFile(target, res.content);
      this.app.explorer.refreshDir(dirname(target));
      await editors.open(target);
    }
    toast(`Applied to ${basename(target)}`, 'ok');
  }

  toolCard(id, name, args) {
    const card = h('div', { class: 'tool run', 'data-id': id });
    const head = h('div', { class: 'tool-head', onclick: () => card.classList.toggle('expanded') },
      h('span', { class: 'tname' }, TOOL_LABEL[name] || name),
      h('span', { class: 'targ', title: toolArgSummary(name, args) }, toolArgSummary(name, args)),
      h('span', { class: 'tstatus' }));
    const body = h('div', { class: 'tool-body' });
    card.append(head, body);
    card._body = body;
    card._name = name;
    card._args = args;
    if (name === 'edit_file' || name === 'write_file') {
      const p = args.path;
      if (p && this.app.root) {
        head.querySelector('.targ').style.cursor = 'pointer';
        head.querySelector('.targ').addEventListener('click', async (e) => {
          e.stopPropagation();
          this.app.editors.open(await window.api.path.join(this.app.root, p));
        });
      }
    }
    return card;
  }

  finishToolCard(card, { ok, output, rejected }) {
    card.classList.remove('run');
    card.classList.add(ok ? 'ok' : 'err');
    card.querySelector('.tstatus').textContent = ok ? '✓' : rejected ? 'rejected' : '✗';
    if (output != null) card._body.textContent = output;
  }

  changesEl(m) {
    const box = h('div', { class: 'changes' }, h('div', { class: 'muted' }, `${m.changes.length} file${m.changes.length > 1 ? 's' : ''} changed`));
    for (const c of m.changes) {
      box.append(h('div', { class: 'row' },
        h('span', { class: 'file', title: c.path, onclick: () => this.app.editors.open(c.path) }, c.rel || basename(c.path)),
        c.before == null ? h('span', { class: 'muted' }, 'new') : null,
        c.before !== undefined ? h('button', { class: 'cb-btn', onclick: () => this.reviewChange(c) }, 'Diff') : null));
    }
    const canRevert = m.changes.every((c) => c.before !== undefined);
    if (canRevert && !m.reverted) {
      box.append(h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => this.revert(m) }, 'Revert all')));
    } else if (m.reverted) box.append(h('div', { class: 'muted' }, 'Reverted.'));
    return box;
  }

  async reviewChange(c) {
    let current = '';
    try { current = (await window.api.fs.readFile(c.path)).content; } catch { current = '(deleted)'; }
    this.app.editors.showDiff({ title: `${c.rel} — before ↔ now`, original: c.before ?? '', modified: current, path: c.path, readOnly: true });
  }

  async revert(m) {
    const r = await window.api.dialog.confirm({ message: `Revert changes to ${m.changes.length} file(s)?`, detail: 'Files will be restored to their state before this AI run.', buttons: ['Revert', 'Cancel'] });
    if (r !== 0) return;
    await window.api.ai.revert(m.changes);
    for (const c of m.changes) {
      if (c.before == null) this.app.editors.fileDeleted(c.path);
      else this.app.editors.fileChangedOnDisk(c.path, c.before);
      this.app.explorer.refreshDir(dirname(c.path));
    }
    m.reverted = true;
    this.persist();
    this.renderMessages();
    toast('Changes reverted.', 'ok');
  }
}

/** Live rendering of an in-flight run. */
class LiveRun {
  constructor(chat) {
    this.chat = chat;
    this.el = h('div', { class: 'msg assistant' });
    chat.list.append(this.el);
    this.md = null;
    this.text = '';
    this.cards = new Map();
    this.pending = false;
    this.reasoningEl = null;
    this.thinking = h('div', { class: 'notice typing' }, 'Thinking');
    this.el.append(this.thinking);
    chat.scrollToBottom(true);
  }

  flush() {
    this.pending = false;
    if (this.md) {
      this.chat.renderMarkdown(this.md, this.text, false);
      this.md.classList.add('typing');
    }
    this.chat.scrollToBottom();
  }

  schedule() {
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  onEvent(ev) {
    const app = this.chat.app;
    switch (ev.type) {
      case 'turn_start':
        if (this.md) this.md.classList.remove('typing');
        this.md = null;
        this.text = '';
        this.reasoningEl = null;
        break;
      case 'reasoning': {
        if (!this.reasoningEl) {
          this.reasoningEl = h('div', { class: 'reasoning' });
          this.el.append(this.reasoningEl);
        }
        this.reasoningEl.textContent += ev.text;
        this.reasoningEl.scrollTop = this.reasoningEl.scrollHeight;
        break;
      }
      case 'delta':
        this.thinking.remove();
        if (!this.md) {
          this.md = h('div', { class: 'md' });
          this.el.append(this.md);
        }
        this.text += ev.text;
        this.schedule();
        break;
      case 'tool_start': {
        this.thinking.remove();
        if (this.md) this.md.classList.remove('typing');
        const card = this.chat.toolCard(ev.id, ev.name, ev.args);
        this.cards.set(ev.id, card);
        this.el.append(card);
        this.chat.scrollToBottom();
        break;
      }
      case 'tool_output': {
        const card = this.cards.get(ev.id);
        if (card) {
          card.classList.add('expanded');
          card._body.textContent += ev.text;
          card._body.scrollTop = card._body.scrollHeight;
        }
        break;
      }
      case 'tool_end': {
        const card = this.cards.get(ev.id);
        if (card) {
          card.querySelector('.approval')?.remove();
          this.chat.finishToolCard(card, ev);
        }
        this.el.append(this.thinking);
        this.chat.scrollToBottom();
        break;
      }
      case 'approval':
        this.showApproval(ev);
        break;
      case 'file_changed':
        app.editors.fileChangedOnDisk(ev.path, ev.content);
        app.explorer.refreshDir(dirname(ev.path));
        app.quickOpenCache = null;
        break;
      case 'file_deleted':
        app.editors.fileDeleted(ev.path);
        app.explorer.refreshDir(dirname(ev.path));
        app.quickOpenCache = null;
        break;
      case 'notice':
        this.el.append(h('div', { class: 'notice' }, ev.text));
        break;
      default:
        break;
    }
  }

  showApproval(ev) {
    const app = this.chat.app;
    const card = this.cards.get(ev.toolCallId);
    const box = h('div', { class: 'approval' });
    const feedback = h('input', { class: 'text-input', type: 'text', placeholder: 'Optional feedback for the AI if you reject...' });
    const decide = (approved, extra = {}) => {
      box.remove();
      window.api.ai.approve(ev.approvalId, { approved, feedback: feedback.value.trim() || undefined, ...extra });
    };
    if (ev.kind === 'command') {
      box.append(
        h('div', {}, `Run command in `, h('code', {}, ev.cwd || '.'), '?'),
        h('div', { class: 'cmd' }, ev.command),
        h('div', { class: 'row' }, feedback),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', onclick: () => decide(true) }, 'Run'),
          h('button', { class: 'btn small', onclick: () => decide(false) }, 'Skip'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'cb-btn', title: 'Never ask again for commands (can be changed in Settings)', onclick: () => { app.saveSettings({ autoApproveCommands: true }); decide(true); } }, 'Always allow')));
    } else if (ev.kind === 'delete') {
      box.append(h('div', {}, `Delete `, h('code', {}, ev.rel), '?'),
        h('div', { class: 'row' }, feedback),
        h('div', { class: 'row' },
          h('button', { class: 'btn danger small', onclick: () => decide(true) }, 'Delete'),
          h('button', { class: 'btn small', onclick: () => decide(false) }, 'Keep')));
    } else {
      const st = diffStat(ev.before, ev.after);
      const review = async () => {
        const r = await app.editors.showDiff({ title: `${ev.isNew ? 'Create' : 'Edit'} ${ev.rel}`, original: ev.before, modified: ev.after, path: ev.path, acceptLabel: 'Accept (Ctrl+Enter)' });
        if (!box.isConnected) return;
        if (r.accepted) decide(true, r.content !== ev.after ? { after: r.content } : {});
      };
      box.append(
        h('div', { class: 'row' }, h('span', {}, `${ev.isNew ? 'Create' : 'Edit'} `, h('code', {}, ev.rel)),
          h('span', { class: 'diffstat' }, h('span', { class: 'add' }, `+${st.add}`), ' ', h('span', { class: 'del' }, `-${st.del}`))),
        h('div', { class: 'row' }, feedback),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', onclick: () => decide(true) }, 'Accept'),
          h('button', { class: 'btn small', onclick: () => decide(false) }, 'Reject'),
          h('button', { class: 'btn small', onclick: review }, 'Review diff'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'cb-btn', title: 'Apply AI edits without asking (can be changed in Settings)', onclick: () => { app.saveSettings({ autoApproveEdits: true }); decide(true); } }, 'Always allow')));
    }
    if (card) {
      card.classList.remove('expanded');
      card.append(box);
    } else this.el.append(box);
    this.thinking.remove();
    this.chat.scrollToBottom(true);
  }
}
