'use strict';
// A tiny scripted OpenAI-compatible server for tests.
const http = require('http');

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Build streamed chunks for a scripted assistant turn: { content?, toolCalls?: [{name, args}] } */
function turnChunks(turn) {
  const chunks = [];
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'mock' };
  if (turn.content) {
    for (const piece of turn.content.match(/.{1,7}/gs)) chunks.push({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
  }
  (turn.toolCalls || []).forEach((tc, i) => {
    const args = JSON.stringify(tc.args);
    const half = Math.floor(args.length / 2);
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}_${Date.now()}`, type: 'function', function: { name: tc.name, arguments: args.slice(0, half) } }] } }] });
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] } }] });
  });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls ? 'tool_calls' : 'stop' }] });
  return chunks;
}

function start(script = [], { models = ['mock-b', 'mock-a'] } = {}) {
  const requests = [];
  const queue = [...script];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ url: req.url, headers: req.headers, body: json });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: models.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      if (req.url === '/v1/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ text: 'return a + b;\n}' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        if (req.headers.authorization !== 'Bearer test-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
          return;
        }
        const turn = queue.shift() || { content: 'done' };
        if (typeof turn === 'function') return turn(req, res, json);
        if (!json.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: turn.content || '' }, finish_reason: 'stop' }] }));
          return;
        }
        sse(res, turnChunks(turn));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ baseURL: `http://127.0.0.1:${port}/v1`, requests, queue, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { start, turnChunks, sse };
