// Integrated terminal panel (xterm.js). Supports multiple terminals.
import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { $, h, basename, toast } from './util.js';

const THEMES = {
  dark: { background: '#181818', foreground: '#cccccc', cursor: '#cccccc', selectionBackground: '#264f78' },
  light: { background: '#ffffff', foreground: '#333333', cursor: '#333333', selectionBackground: '#add6ff' },
};

export class TerminalPanel {
  constructor(app) {
    this.app = app;
    this.terms = [];
    this.active = null;
    this.host = $('#term-host');
    window.api.on('term:data', ({ id, data }) => {
      const t = this.terms.find((x) => x.id === id);
      if (t) t.xterm.write(data);
    });
    window.api.on('term:exit', ({ id, code }) => {
      const t = this.terms.find((x) => x.id === id);
      if (t) {
        t.exited = true;
        t.xterm.write(`\r\n\x1b[90m[process exited with code ${code ?? '?'}]\x1b[0m\r\n`);
      }
    });
    $('#btn-new-term').onclick = () => this.create();
    $('#btn-kill-term').onclick = () => this.kill();
    $('#btn-close-panel').onclick = () => this.app.layout.togglePanel(false);
    new ResizeObserver(() => this.fit()).observe(this.host);
  }

  async create(cwd) {
    this.app.layout.togglePanel(true);
    const theme = THEMES[this.app.settings.theme === 'light' ? 'light' : 'dark'];
    const xterm = new Terminal({
      fontFamily: getComputedStyle(document.body).getPropertyValue('--mono'),
      fontSize: Math.max(11, this.app.settings.fontSize - 1),
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const el = h('div', { class: 'term-instance' });
    this.host.append(el);
    xterm.open(el);
    try { fit.fit(); } catch { /* not visible yet */ }
    let info;
    try {
      info = await window.api.term.create({ cwd: cwd || this.app.root || undefined, cols: xterm.cols, rows: xterm.rows });
    } catch (e) {
      xterm.write(`Failed to start terminal: ${e.message}\r\n`);
      return null;
    }
    const t = { id: info.id, mode: info.mode, xterm, fit, el, title: basename(info.shell || 'shell'), line: '' };
    this.terms.push(t);
    if (info.note) {
      xterm.write(`\x1b[33m${info.note}\x1b[0m\r\n`);
    }
    xterm.onData((data) => this.onInput(t, data));
    xterm.onResize(({ cols, rows }) => window.api.term.resize(t.id, cols, rows));
    // Ctrl+C copies when there's a selection, Ctrl+V pastes (both platforms).
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'c' && xterm.hasSelection()) {
        navigator.clipboard.writeText(xterm.getSelection());
        xterm.clearSelection();
        return false;
      }
      if (ctrl && (e.key.toLowerCase() === 'v' || (e.shiftKey && e.key.toLowerCase() === 'v'))) {
        navigator.clipboard.readText().then((txt) => this.onInput(t, txt));
        e.preventDefault();
        return false;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'c') {
        navigator.clipboard.writeText(xterm.getSelection());
        return false;
      }
      // Let app shortcuts (Ctrl+P, Ctrl+`, Ctrl+L, ...) bubble to the app.
      if (ctrl && ['p', 'b', '`', ','].includes(e.key.toLowerCase())) return false;
      return true;
    });
    this.activate(t);
    return t;
  }

  /** In pipe mode (no PTY) we do simple local line editing + echo. */
  onInput(t, data) {
    if (t.exited) return;
    if (t.mode === 'pty') {
      window.api.term.write(t.id, data);
      return;
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        t.xterm.write('\r\n');
        window.api.term.write(t.id, t.line + '\n');
        t.line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (t.line.length) {
          t.line = t.line.slice(0, -1);
          t.xterm.write('\b \b');
        }
      } else if (ch === '\x03') {
        t.xterm.write('^C\r\n');
        t.line = '';
        window.api.term.write(t.id, '\x03');
      } else if (ch >= ' ' || ch === '\t') {
        t.line += ch;
        t.xterm.write(ch);
      }
    }
  }

  activate(t) {
    this.active = t;
    for (const x of this.terms) x.el.style.display = x === t ? '' : 'none';
    this.renderTabs();
    this.fit();
    t.xterm.focus();
  }

  renderTabs() {
    const bar = $('#term-tabs');
    bar.innerHTML = '';
    this.terms.forEach((t, i) => {
      bar.append(h('span', { class: `term-tab${t === this.active ? ' active' : ''}`, onclick: () => this.activate(t), title: t.mode === 'pty' ? 'PTY terminal' : 'Basic terminal (node-pty unavailable)' }, `${i + 1}: ${t.title}`));
    });
  }

  fit() {
    const t = this.active;
    if (!t || !this.host.offsetParent) return;
    try { t.fit.fit(); } catch { /* hidden */ }
  }

  async ensure() {
    if (!this.terms.length) await this.create();
    else { this.app.layout.togglePanel(true); this.activate(this.active || this.terms[0]); }
  }

  focus() {
    if (this.active) this.active.xterm.focus();
  }

  kill(t = this.active) {
    if (!t) return;
    window.api.term.kill(t.id);
    t.xterm.dispose();
    t.el.remove();
    this.terms = this.terms.filter((x) => x !== t);
    this.active = null;
    if (this.terms.length) this.activate(this.terms[this.terms.length - 1]);
    else { this.renderTabs(); this.app.layout.togglePanel(false); }
  }

  killAll() {
    for (const t of [...this.terms]) {
      window.api.term.kill(t.id);
      t.xterm.dispose();
      t.el.remove();
    }
    this.terms = [];
    this.active = null;
    this.renderTabs();
  }

  applyTheme(theme) {
    for (const t of this.terms) t.xterm.options.theme = THEMES[theme === 'light' ? 'light' : 'dark'];
  }

  /** Last N lines of visible output in the active terminal (for "add terminal to chat"). */
  recentOutput(lines = 80) {
    const t = this.active;
    if (!t) return '';
    const buf = t.xterm.buffer.active;
    const out = [];
    const end = buf.length;
    for (let i = Math.max(0, end - lines); i < end; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n').trimEnd();
  }
}
