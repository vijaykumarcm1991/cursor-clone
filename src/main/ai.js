'use strict';
// Minimal client for any OpenAI-compatible API (OpenAI, Azure-style proxies,
// Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek, Together, LiteLLM...).
// Pure Node (global fetch) so it can be unit-tested without Electron.

function joinUrl(baseURL, suffix) {
  const base = String(baseURL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return base + suffix;
}

function buildHeaders(cfg) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.extraHeaders && typeof cfg.extraHeaders === 'object') {
    for (const [k, v] of Object.entries(cfg.extraHeaders)) {
      if (k && v != null) headers[k] = String(v);
    }
  }
  return headers;
}

// Drop UI-only fields (prefixed with "_") and anything strict servers reject.
function sanitizeMessages(messages) {
  return messages.map((m) => {
    const out = { role: m.role };
    out.content = m.content == null ? (m.role === 'assistant' ? null : '') : m.content;
    if (m.tool_calls && m.tool_calls.length) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name && m.role === 'tool') out.name = m.name;
    if (m.role === 'assistant' && out.content == null && !out.tool_calls) out.content = '';
    return out;
  });
}

async function httpError(res) {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  let detail = body;
  try {
    const j = JSON.parse(body);
    detail = (j.error && (j.error.message || j.error)) || j.message || body;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch { /* not json */ }
  const err = new Error(`API error ${res.status} ${res.statusText || ''}: ${String(detail).slice(0, 2000)}`.trim());
  err.status = res.status;
  return err;
}

// Parse a text/event-stream body into JSON payloads.
async function* sseEvents(body, signal) {
  const decoder = new TextDecoder();
  let buf = '';
  let dataLines = [];
  for await (const chunk of body) {
    if (signal && signal.aborted) return;
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n/)) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === '\r' ? 2 : 1));
      if (line === '') {
        if (dataLines.length) {
          const data = dataLines.join('\n');
          dataLines = [];
          if (data.trim() === '[DONE]') return;
          try { yield JSON.parse(data); } catch { /* skip malformed */ }
        }
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  const rest = (dataLines.join('\n') + (buf.startsWith('data:') ? buf.slice(5).trim() : '')).trim();
  if (rest && rest !== '[DONE]') {
    try { yield JSON.parse(rest); } catch { /* ignore */ }
  }
}

/**
 * Stream a chat completion. Yields:
 *   { type: 'content', text }
 *   { type: 'reasoning', text }   (servers that expose reasoning_content)
 *   { type: 'done', content, toolCalls, finishReason, usage }
 */
async function* streamChat(cfg, { messages, tools, signal, temperature, maxTokens, model }) {
  const body = {
    model: model || cfg.model,
    messages: sanitizeMessages(messages),
    stream: true,
  };
  const temp = temperature ?? cfg.temperature;
  if (temp != null && temp !== '') body.temperature = Number(temp);
  const mt = maxTokens ?? cfg.maxTokens;
  if (mt) body.max_tokens = Number(mt);
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(joinUrl(cfg.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: buildHeaders(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res);

  let content = '';
  let finishReason = null;
  let usage = null;
  const toolCalls = [];

  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('event-stream')) {
    // Some servers ignore stream:true and return a normal JSON response.
    const j = await res.json();
    const choice = (j.choices && j.choices[0]) || {};
    const msg = choice.message || {};
    if (msg.content) {
      content = msg.content;
      yield { type: 'content', text: msg.content };
    }
    for (const tc of msg.tool_calls || []) {
      toolCalls.push({
        id: tc.id || `call_${toolCalls.length}`,
        type: 'function',
        function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' },
      });
    }
    yield { type: 'done', content, toolCalls, finishReason: choice.finish_reason, usage: j.usage || null };
    return;
  }

  for await (const evt of sseEvents(res.body, signal)) {
    if (evt.error) {
      const m = typeof evt.error === 'string' ? evt.error : evt.error.message || JSON.stringify(evt.error);
      throw new Error(`API stream error: ${m}`);
    }
    if (evt.usage) usage = evt.usage;
    const choice = evt.choices && evt.choices[0];
    if (!choice) continue;
    const delta = choice.delta || choice.message || {};
    if (delta.reasoning_content || delta.reasoning) {
      yield { type: 'reasoning', text: delta.reasoning_content || delta.reasoning };
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      yield { type: 'content', text: delta.content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const d of delta.tool_calls) {
        const i = typeof d.index === 'number' ? d.index : toolCalls.length;
        if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        const t = toolCalls[i];
        if (d.id) t.id = d.id;
        if (d.function?.name) t.function.name += d.function.name;
        if (d.function?.arguments) t.function.arguments += d.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const calls = toolCalls.filter(Boolean).map((t, i) => ({ ...t, id: t.id || `call_${Date.now()}_${i}` }));
  yield { type: 'done', content, toolCalls: calls, finishReason, usage };
}

async function chatOnce(cfg, opts) {
  let result = null;
  for await (const ev of streamChat(cfg, opts)) if (ev.type === 'done') result = ev;
  return result;
}

async function listModels(cfg, signal) {
  const res = await fetch(joinUrl(cfg.baseURL, '/models'), { headers: buildHeaders(cfg), signal });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

function stripFences(text) {
  let t = String(text || '');
  const m = t.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (m) t = m[1];
  return t;
}

// Remove the part of a completion that duplicates the text right after the cursor.
function trimSuffixOverlap(completion, suffix) {
  const s = (suffix || '').replace(/^\s+/, '').replace(/\r\n/g, '\n');
  if (!s || !completion) return completion;
  const c = completion.replace(/\s+$/, '');
  // Longest tail of the completion that equals the start of the suffix. Short overlaps
  // (like a lone "}") only count when they cover whole lines of the suffix.
  for (let k = Math.min(c.length, s.length); k >= 1; k--) {
    const head = s.slice(0, k);
    if (!c.endsWith(head)) continue;
    const wholeLine = k === s.length || s[k] === '\n';
    if (k >= 8 || wholeLine) {
      const rest = c.slice(0, c.length - k).replace(/\s+$/, '');
      if (rest) return rest;
    }
  }
  return completion;
}

/**
 * Inline (ghost text) code completion. Supports two strategies:
 *  - 'chat': instruct a chat model to output only the insertion
 *  - 'fim':  legacy /completions endpoint with prompt+suffix (Ollama, vLLM, DeepSeek, Codestral...)
 */
async function completeCode(cfg, { prefix, suffix, path, language, signal }) {
  const model = cfg.autocompleteModel || cfg.model;
  if (cfg.autocompleteMode === 'fim') {
    const res = await fetch(joinUrl(cfg.baseURL, '/completions'), {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({ model, prompt: prefix, suffix, max_tokens: 128, temperature: 0, stream: false }),
      signal,
    });
    if (!res.ok) throw await httpError(res);
    const j = await res.json();
    const text = j.choices?.[0]?.text ?? '';
    return trimSuffixOverlap(text, suffix);
  }
  const system =
    'You are a code completion engine embedded in an editor. ' +
    'Given a file with a <|CURSOR|> marker, reply with ONLY the exact text that should be inserted at the cursor. ' +
    'Do not repeat text that is already before or after the cursor. No explanations, no markdown code fences. ' +
    'Keep it short: finish the current statement or block (at most ~10 lines). If nothing sensible fits, reply with an empty string.';
  const user = `File: ${path || 'untitled'}${language ? ` (${language})` : ''}\n\n${prefix}<|CURSOR|>${suffix}`;
  const r = await chatOnce(cfg, {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    maxTokens: 160,
    signal,
  });
  let text = stripFences(r?.content || '');
  text = text.replace(/<\|CURSOR\|>/g, '');
  return trimSuffixOverlap(text, suffix);
}

module.exports = { streamChat, chatOnce, listModels, completeCode, sanitizeMessages, stripFences, joinUrl, sseEvents, trimSuffixOverlap };
