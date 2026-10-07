// Ctrl+K inline edit and AI tab-autocomplete (ghost text) for the Monaco editor.
import { h, basename, relativePath, toast } from './util.js';
import { rawCompletion, stripFences } from './aiclient.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class InlineAI {
  constructor(app) {
    this.app = app;
    this.monaco = app.monaco;
    this.editor = app.editors.editor;
    this.session = null;
    this.registerAutocomplete();
    this.updateStatus();
    document.getElementById('status-ai').addEventListener('click', () => this.toggleAutocomplete());
  }

  // ------------------------------------------------------------------ autocomplete
  registerAutocomplete() {
    const monaco = this.monaco;
    const self = this;
    monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
      async provideInlineCompletions(model, position, context, token) {
        const s = self.app.settings;
        if (!s.autocompleteEnabled || self.session) return { items: [] };
        if (!s.apiKey && /api\.openai\.com/.test(s.baseURL)) return { items: [] };
        const lineText = model.getLineContent(position.lineNumber);
        const after = lineText.slice(position.column - 1);
        if (/^[A-Za-z0-9_]/.test(after)) return { items: [] }; // mid-word
        const automatic = context.triggerKind === (monaco.languages.InlineCompletionTriggerKind?.Automatic ?? 0);
        if (automatic) {
          await sleep(Number(s.autocompleteDelay) || 350);
          if (token.isCancellationRequested) return { items: [] };
        }
        const startLine = Math.max(1, position.lineNumber - 120);
        const endLine = Math.min(model.getLineCount(), position.lineNumber + 40);
        const prefix = model.getValueInRange(new monaco.Range(startLine, 1, position.lineNumber, position.column));
        const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, endLine, model.getLineMaxColumn(endLine)));
        if (prefix.trim().length < 2) return { items: [] };
        const tab = self.app.editors.tabs.find((t) => t.model === model);
        const path = tab ? (tab.path ? relativePath(self.app.root, tab.path) : tab.name) : '';
        self.setBusy(true);
        let res;
        try {
          res = await window.api.ai.complete({ prefix, suffix, path, language: model.getLanguageId() });
        } finally {
          self.setBusy(false);
        }
        if (token.isCancellationRequested || !res || !res.text) {
          if (res && res.error && !self.warned) { self.warned = true; toast(`Autocomplete error: ${res.error}`, 'error'); }
          return { items: [] };
        }
        let text = res.text;
        // Don't suggest pure whitespace.
        if (!text.trim()) return { items: [] };
        // If cursor is at start of an already indented line, the model often repeats the indent.
        const lead = lineText.slice(0, position.column - 1);
        if (/^\s+$/.test(lead) && text.startsWith(lead)) text = text.slice(lead.length);
        return { items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
      },
      freeInlineCompletions() {},
      disposeInlineCompletions() {},
    });
  }

  setBusy(on) {
    const el = document.getElementById('status-ai');
    el.textContent = `${on ? '⟳' : '✦'} AI Tab: ${this.app.settings.autocompleteEnabled ? 'on' : 'off'}`;
  }

  updateStatus() {
    const el = document.getElementById('status-ai');
    el.classList.toggle('on', !!this.app.settings.autocompleteEnabled);
    this.setBusy(false);
  }

  toggleAutocomplete() {
    this.app.saveSettings({ autocompleteEnabled: !this.app.settings.autocompleteEnabled });
    this.updateStatus();
    toast(`AI autocomplete ${this.app.settings.autocompleteEnabled ? 'enabled' : 'disabled'}`);
  }

  // ------------------------------------------------------------------ Ctrl+K inline edit
  start() {
    const ed = this.editor;
    const tab = this.app.editors.getActive();
    if (!tab) { toast('Open a file to use inline edit.'); return; }
    if (this.session) { this.session.input.focus(); return; }
    const model = tab.model;
    let sel = ed.getSelection();
    const generate = sel.isEmpty();
    let range;
    if (generate) {
      const p = ed.getPosition();
      range = new this.monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column);
    } else {
      // expand to full lines
      const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
      range = new this.monaco.Range(sel.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));
      ed.setSelection(range);
    }
    const original = model.getValueInRange(range);

    const input = h('textarea', { rows: 1, placeholder: generate ? 'Generate code… (Enter to submit, Esc to cancel)' : 'Edit selected code… (Enter to submit, Esc to cancel)', spellcheck: 'false' });
    const status = h('span', { class: 'status' });
    const acceptBtn = h('button', { class: 'btn primary small hidden' }, 'Accept (Ctrl+Enter)');
    const rejectBtn = h('button', { class: 'btn small hidden' }, 'Reject (Esc)');
    const diffBtn = h('button', { class: 'cb-btn hidden' }, 'View diff');
    const bar = h('div', { class: 'bar' }, status, h('span', { class: 'spacer' }), diffBtn, rejectBtn, acceptBtn);
    const dom = h('div', { class: 'inline-edit' }, input, bar);
    const s = {
      tab, model, range, original, generate, input, status, dom, acceptBtn, rejectBtn, diffBtn,
      decorations: ed.createDecorationsCollection(), run: null, applied: false, instructions: [],
    };
    this.session = s;

    const widget = {
      getId: () => 'cursor-clone.inline-edit',
      getDomNode: () => dom,
      getPosition: () => ({
        position: { lineNumber: s.range.startLineNumber, column: 1 },
        preference: [this.monaco.editor.ContentWidgetPositionPreference.ABOVE, this.monaco.editor.ContentWidgetPositionPreference.BELOW],
      }),
      allowEditorOverflow: true,
    };
    s.widget = widget;
    ed.addContentWidget(widget);
    // Reserve vertical space above the target lines so the widget never covers code.
    s.zoneDom = document.createElement('div');
    const layoutZone = () => {
      const height = dom.offsetHeight + 8;
      ed.changeViewZones((acc) => {
        if (s.zoneId) acc.removeZone(s.zoneId);
        s.zoneId = acc.addZone({ afterLineNumber: Math.max(0, s.range.startLineNumber - 1), heightInPx: height, domNode: s.zoneDom });
      });
      ed.layoutContentWidget(widget);
    };
    s.layoutZone = layoutZone;
    s.resizeObs = new ResizeObserver(() => layoutZone());
    s.resizeObs.observe(dom);
    ed.revealLineInCenterIfOutsideViewport(range.startLineNumber);

    // Keep keystrokes inside the widget away from Monaco.
    dom.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (s.applied) this.accept(); else this.submit(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submit(); }
    });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
    acceptBtn.onclick = () => this.accept();
    rejectBtn.onclick = () => this.cancel();
    diffBtn.onclick = () => this.showDiff();
    setTimeout(() => input.focus(), 0);
  }

  currentRange() {
    const s = this.session;
    const r = s.decorations.getRanges()[0];
    return r || s.range;
  }

  async submit() {
    const s = this.session;
    if (!s || s.run) return;
    const instruction = s.input.value.trim();
    if (!instruction) return;
    s.instructions.push(instruction);
    // Re-run from the original each time (follow-ups refine the instruction).
    if (s.applied) this.restoreOriginal();
    const model = s.model;
    const r = s.range;
    const total = model.getLineCount();
    const before = model.getValueInRange(new this.monaco.Range(Math.max(1, r.startLineNumber - 150), 1, r.startLineNumber, r.startColumn));
    const after = model.getValueInRange(new this.monaco.Range(r.endLineNumber, r.endColumn, Math.min(total, r.endLineNumber + 80), model.getLineMaxColumn(Math.min(total, r.endLineNumber + 80))));
    const file = s.tab.path ? relativePath(this.app.root, s.tab.path) : s.tab.name;
    const lang = model.getLanguageId();
    const instr = s.instructions.length > 1 ? s.instructions.map((x, i) => `${i + 1}. ${x}`).join('\n') : instruction;
    const system = s.generate
      ? 'You are an expert programmer. Write code to insert at the cursor position in the given file, following the instruction. Output ONLY the code to insert — no explanations, no markdown fences. Match the surrounding indentation and style.'
      : 'You are an expert programmer. Rewrite the SELECTED code according to the instruction. Output ONLY the full replacement for the selected code — no explanations, no markdown fences. Preserve the original indentation level and code style. Do not include code from outside the selection.';
    const user = s.generate
      ? `File: ${file} (${lang})\n\nCode before cursor:\n\`\`\`\n${before}\n\`\`\`\n\nCode after cursor:\n\`\`\`\n${after}\n\`\`\`\n\nInstruction:\n${instr}`
      : `File: ${file} (${lang})\n\nCode before the selection:\n\`\`\`\n${before}\n\`\`\`\n\nSELECTED code (lines ${r.startLineNumber}-${r.endLineNumber}):\n\`\`\`\n${s.original}\n\`\`\`\n\nCode after the selection:\n\`\`\`\n${after}\n\`\`\`\n\nInstruction:\n${instr}`;

    s.status.classList.remove('err');
    s.status.textContent = 'Generating…';
    s.input.disabled = true;
    let chars = 0;
    s.run = rawCompletion([{ role: 'system', content: system }, { role: 'user', content: user }], {
      onDelta: (text) => { chars = text.length; s.status.textContent = `Generating… ${chars} chars`; },
    });
    let out;
    try {
      out = await s.run.promise;
    } catch (e) {
      if (this.session !== s) return;
      s.run = null;
      s.input.disabled = false;
      s.status.textContent = e.message;
      s.status.classList.add('err');
      return;
    }
    if (this.session !== s) return;
    s.run = null;
    s.input.disabled = false;
    out = stripFences(out);
    if (!s.generate) {
      // keep trailing newline state of the original
      out = out.replace(/\s+$/, '');
      const origTrail = s.original.match(/\s*$/)[0];
      out += origTrail;
    }
    this.applyResult(out);
    s.input.value = '';
    s.input.placeholder = 'Follow-up instruction… (Enter) · Ctrl+Enter accept · Esc reject';
    s.input.focus();
  }

  applyResult(text) {
    const s = this.session;
    const model = s.model;
    const eol = model.getEOL();
    text = text.replace(/\r?\n/g, eol);
    model.pushStackElement();
    model.pushEditOperations([], [{ range: s.range, text }], () => null);
    model.pushStackElement();
    const lines = text.split(eol);
    const endLine = s.range.startLineNumber + lines.length - 1;
    const endCol = lines.length === 1 ? s.range.startColumn + lines[0].length : lines[lines.length - 1].length + 1;
    const newRange = new this.monaco.Range(s.range.startLineNumber, s.range.startColumn, endLine, endCol);
    s.decorations.set([{ range: newRange, options: { isWholeLine: true, className: 'ai-added-line', stickiness: 1 } }]);
    s.applied = true;
    s.result = text;
    s.status.textContent = s.generate ? 'Generated.' : 'Edited.';
    s.acceptBtn.classList.remove('hidden');
    s.rejectBtn.classList.remove('hidden');
    s.diffBtn.classList.remove('hidden');
    this.editor.layoutContentWidget(s.widget);
  }

  restoreOriginal() {
    const s = this.session;
    const r = this.currentRange();
    s.model.pushEditOperations([], [{ range: r, text: s.original }], () => null);
    const lines = s.original.split(/\r?\n/);
    const endLine = r.startLineNumber + lines.length - 1;
    const endCol = lines.length === 1 ? r.startColumn + lines[0].length : lines[lines.length - 1].length + 1;
    s.range = new this.monaco.Range(r.startLineNumber, r.startColumn, endLine, endCol);
    s.decorations.clear();
    s.applied = false;
    s.layoutZone();
  }

  async showDiff() {
    const s = this.session;
    if (!s || !s.applied) return;
    await this.app.editors.showDiff({ title: `Inline edit — ${s.tab.path ? basename(s.tab.path) : s.tab.name}`, original: s.original, modified: s.model.getValueInRange(this.currentRange()), path: s.tab.path || '', readOnly: true });
    if (this.session) this.session.input.focus();
  }

  accept() {
    const s = this.session;
    if (!s) return;
    this.end();
    this.editor.focus();
  }

  cancel() {
    const s = this.session;
    if (!s) return;
    if (s.run) s.run.cancel();
    if (s.applied) this.restoreOriginal();
    this.end();
    this.editor.focus();
  }

  end() {
    const s = this.session;
    if (!s) return;
    s.decorations.clear();
    s.resizeObs.disconnect();
    this.editor.changeViewZones((acc) => { if (s.zoneId) acc.removeZone(s.zoneId); });
    this.editor.removeContentWidget(s.widget);
    this.session = null;
  }
}
