// Background processes panel: list, live output, stop/restart, status bar indicator, exit toasts.
import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { $, $$, h, toast, promptInput } from './util.js';

const STATUS_TEXT = { starting: 'starting', running: 'running', stopped: 'stopped', failed: 'failed to start' };

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export class ProcessesView {
  constructor(app) {
    this.app = app;
    this.procs = new Map();
    this.selected = null;
    this.view = 'terminal';
    this.xterm = null;
    this.panel = $('#panel');

    $$('.pview').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.pview)));
    $('#btn-run-bg').onclick = () => this.runInBackground();
    $('#btn-clear-procs').onclick = () => this.clearFinished();
    $('#status-bg').onclick = () => this.show('processes');

    window.api.on('bg:status', (info) => this.upsert(info));
    window.api.on('bg:removed', ({ id }) => {
      this.procs.delete(id);
      if (this.selected === id) this.select(null);
      this.render();
    });
    window.api.on('bg:output', ({ id, text }) => {
      if (id === this.selected && this.xterm) this.xterm.write(text);
    });
    window.api.on('bg:exit', (info) => {
      if (info.status !== 'exited') return; // stopped by the user/AI: no toast
      const short = info.command.length > 60 ? `${info.command.slice(0, 57)}…` : info.command;
      toast(`Background process ${info.id} (${short}) exited with code ${info.exitCode}.`, info.exitCode === 0 ? 'ok' : 'error');
    });
    window.api.bg.list().then((list) => { for (const p of list) this.upsert(p); });
    // Keep uptimes fresh while something is running.
    setInterval(() => { if (this.runningCount() && this.view === 'processes' && this.app.layout.state.panel) this.render(); }, 1000);
  }

  visible() {
    return [...this.procs.values()].filter((p) => !p.hidden).sort((a, b) => b.startedAt - a.startedAt);
  }

  runningCount() {
    return this.visible().filter((p) => p.status === 'running' || p.status === 'starting').length;
  }

  upsert(info) {
    const prev = this.procs.get(info.id);
    this.procs.set(info.id, info);
    // A command the AI just sent to the background: select it if nothing else is.
    if (prev && prev.hidden && !info.hidden && !this.selected) this.selected = info.id;
    this.render();
  }

  show(view) {
    this.view = view;
    this.app.layout.togglePanel(true);
    this.panel.classList.toggle('view-processes', view === 'processes');
    $$('.pview').forEach((b) => b.classList.toggle('active', b.dataset.pview === view));
    if (view === 'processes') {
      this.ensureLog();
      if (!this.selected && this.visible().length) this.select(this.visible()[0].id);
      else if (this.selected) this.select(this.selected);
      this.render();
    } else {
      requestAnimationFrame(() => this.app.terminal.fit());
    }
  }

  open(id) {
    if (id && this.procs.has(id)) this.selected = id;
    this.show('processes');
  }

  ensureLog() {
    if (this.xterm) return;
    this.xterm = new Terminal({
      fontFamily: getComputedStyle(document.body).getPropertyValue('--mono'),
      fontSize: Math.max(11, this.app.settings.fontSize - 2),
      convertEol: true,
      disableStdin: true,
      scrollback: 10000,
      theme: this.app.settings.theme === 'light'
        ? { background: '#ffffff', foreground: '#333333', cursor: '#ffffff' }
        : { background: '#181818', foreground: '#cccccc', cursor: '#181818' },
    });
    this.fitter = new FitAddon();
    this.xterm.loadAddon(this.fitter);
    this.xterm.open($('#proc-log'));
    new ResizeObserver(() => { if (this.view === 'processes') try { this.fitter.fit(); } catch { /* hidden */ } }).observe($('#proc-log'));
  }

  async select(id) {
    this.selected = id;
    this.render();
    if (!this.xterm) return;
    this.xterm.reset();
    const head = $('#proc-log-head');
    const p = id && this.procs.get(id);
    if (!p) { head.textContent = 'Select a process to see its output'; return; }
    head.innerHTML = '';
    head.append(h('code', {}, p.command), h('span', {}, `· ${p.cwd}`));
    const out = await window.api.bg.output(id);
    if (this.selected !== id || !out) return;
    if (out.truncated) this.xterm.write('\x1b[90m…earlier output omitted…\x1b[0m\n');
    this.xterm.write(out.text);
    try { this.fitter.fit(); } catch { /* hidden */ }
  }

  render() {
    const list = this.visible();
    const running = this.runningCount();
    const count = $('#proc-count');
    count.textContent = String(running);
    count.classList.toggle('hidden', !running);
    const sb = $('#status-bg');
    sb.textContent = `⚙ ${running} running`;
    sb.classList.toggle('hidden', !running);
    if (this.view !== 'processes') return;
    const box = $('#proc-list');
    box.innerHTML = '';
    if (!list.length) {
      box.append(h('div', { class: 'empty' }, 'No background processes. The AI starts them for dev servers and watchers, or use ▶ to run one yourself.'));
      return;
    }
    const now = Date.now();
    for (const p of list) {
      const isRunning = p.status === 'running' || p.status === 'starting';
      const dotClass = isRunning ? 'running' : p.status === 'stopped' ? 'stopped' : p.exitCode === 0 ? 'exited' : 'failed';
      const state = p.status === 'exited' ? `exited (${p.exitCode})` : STATUS_TEXT[p.status] || p.status;
      const time = isRunning ? `up ${duration(now - p.startedAt)}` : `ran ${duration((p.endedAt || now) - p.startedAt)}`;
      const meta = h('div', { class: 'proc-meta' }, `${p.id} · ${p.origin === 'agent' ? 'AI' : 'You'} · ${state} · ${time}`);
      if (p.url) {
        meta.append(' · ', h('a', { href: '#', title: 'Open in browser', onclick: (e) => { e.preventDefault(); e.stopPropagation(); window.api.shell.openExternal(p.url); } }, p.url));
      }
      const btn = (label, title, fn) => h('button', { class: 'cb-btn', title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
      const actions = h('div', { class: 'proc-actions' },
        isRunning ? btn('Stop', 'Stop this process and its children', () => window.api.bg.stop(p.id)) : null,
        btn('Restart', 'Run the command again', () => this.restart(p.id)),
        !isRunning ? btn('✕', 'Remove from list', () => window.api.bg.remove(p.id)) : null);
      box.append(h('div', { class: `proc-row${p.id === this.selected ? ' selected' : ''}`, 'data-id': p.id, onclick: () => this.select(p.id) },
        h('span', { class: `proc-dot ${dotClass}`, title: state }),
        h('div', { class: 'proc-main' }, h('div', { class: 'proc-cmd', title: p.command }, p.command), meta),
        actions));
    }
  }

  async restart(id) {
    try {
      const info = await window.api.bg.restart(id);
      this.upsert(info);
      this.select(info.id);
    } catch (e) {
      toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    }
  }

  async runInBackground() {
    const command = await promptInput('Run command in background', { placeholder: this.app.info.platform === 'win32' ? 'e.g. npm run dev' : 'e.g. npm run dev' });
    if (!command || !command.trim()) return;
    try {
      const info = await window.api.bg.start(command.trim());
      this.upsert(info);
      this.show('processes');
      this.select(info.id);
    } catch (e) {
      toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    }
  }

  clearFinished() {
    for (const p of this.visible()) if (p.status !== 'running' && p.status !== 'starting') window.api.bg.remove(p.id);
  }

  /** Ask before an action that stops running processes (closing the app or folder). */
  async confirmStopAll(action) {
    const n = this.runningCount();
    if (!n) return true;
    const r = await window.api.dialog.confirm({
      message: `${n} background process${n > 1 ? 'es are' : ' is'} still running.`,
      detail: `${action} will stop ${n > 1 ? 'them' : 'it'}:\n${this.visible().filter((p) => p.status === 'running').map((p) => `• ${p.command}`).join('\n')}`,
      buttons: [`Stop and ${action.toLowerCase()}`, 'Cancel'],
    });
    return r === 0;
  }
}
