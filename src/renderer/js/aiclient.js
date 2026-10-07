// Renderer-side helpers for streaming AI runs through the main process.
import { uid } from './util.js';

const handlers = new Map();
window.api.on('ai:event', (ev) => {
  const fn = handlers.get(ev.runId);
  if (fn) fn(ev);
});

/** Start a chat/agent run. Events are delivered to onEvent until the run resolves. */
export function startRun(payload, onEvent) {
  const runId = uid();
  handlers.set(runId, onEvent || (() => {}));
  const promise = window.api.ai.chat(runId, payload).finally(() => handlers.delete(runId));
  return { runId, promise, cancel: () => window.api.ai.cancel(runId) };
}

/** Plain completion over explicit messages (no tools). Resolves to the text. */
export function rawCompletion(messages, { onDelta, model, temperature } = {}) {
  let text = '';
  const run = startRun({ mode: 'raw', messages, cfg: { ...(model ? { model } : {}), ...(temperature != null ? { temperature } : {}) } }, (ev) => {
    if (ev.type === 'delta') {
      text += ev.text;
      if (onDelta) onDelta(text, ev.text);
    }
  });
  const promise = run.promise.then((res) => {
    if (res && res.error) throw new Error(res.error);
    const last = res && res.messages && res.messages[res.messages.length - 1];
    return (last && last.content) || text;
  });
  return { promise, cancel: run.cancel };
}

export function stripFences(t) {
  const m = String(t || '').match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : String(t || '');
}
