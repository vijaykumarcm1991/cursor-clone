'use strict';
// Chat / agent loop on top of any OpenAI-compatible chat completions API with tool calling.
const fsp = require('fs').promises;
const path = require('path');
const ai = require('./ai');
const ws = require('./workspace');
const { platformInfo } = require('./platform');
const { defaultManager, stripAnsi } = require('./bgproc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clampSec = (v, def, max) => Math.min(max, Math.max(1, parseInt(v, 10) || def));

const MAX_TOOL_OUTPUT = 24000;
const MAX_ITERATIONS = 40;

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const TOOLS = {
  list_dir: fn('list_dir', 'List files and folders in a workspace directory.', {
    path: { type: 'string', description: 'Directory path relative to the workspace root. Use "." for the root.' },
  }, ['path']),
  read_file: fn('read_file', 'Read a text file from the workspace. Output lines are prefixed with "<line number>|" which is NOT part of the file content.', {
    path: { type: 'string', description: 'File path relative to the workspace root.' },
    start_line: { type: 'integer', description: 'Optional 1-based first line to read.' },
    end_line: { type: 'integer', description: 'Optional 1-based last line to read (inclusive).' },
  }, ['path']),
  search: fn('search', 'Search file contents in the workspace (like grep). Returns matching lines with file paths and line numbers.', {
    query: { type: 'string', description: 'Text or regular expression to search for.' },
    regex: { type: 'boolean', description: 'Treat query as a regular expression. Default false.' },
    include: { type: 'string', description: 'Optional glob to restrict files, e.g. "*.ts" or "src/**/*.py".' },
  }, ['query']),
  find_files: fn('find_files', 'Find files by glob pattern, e.g. "**/*.json" or "*config*".', {
    pattern: { type: 'string', description: 'Glob pattern.' },
  }, ['pattern']),
  write_file: fn('write_file', 'Create a new file or completely overwrite an existing file with the given content. Prefer edit_file for small changes to existing files.', {
    path: { type: 'string', description: 'File path relative to the workspace root.' },
    content: { type: 'string', description: 'The full file content.' },
  }, ['path', 'content']),
  edit_file: fn('edit_file', 'Edit an existing file by replacing an exact snippet. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.', {
    path: { type: 'string', description: 'File path relative to the workspace root.' },
    old_string: { type: 'string', description: 'Exact existing text to replace (without line-number prefixes).' },
    new_string: { type: 'string', description: 'Replacement text.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
  }, ['path', 'old_string', 'new_string']),
  delete_file: fn('delete_file', 'Delete a file from the workspace.', {
    path: { type: 'string', description: 'File path relative to the workspace root.' },
  }, ['path']),
  run_command: fn('run_command', 'Run a shell command in the workspace and return its combined output and exit code. Commands must be non-interactive. For dev servers, watchers and other long-running commands set background: true; they keep running while you continue, and you check them with read_process_output. A foreground command still running after timeout_seconds is moved to the background (not killed).', {
    command: { type: 'string', description: 'The command line to execute.' },
    cwd: { type: 'string', description: 'Optional working directory relative to the workspace root.' },
    background: { type: 'boolean', description: 'Run in the background and return immediately with a process id (for servers, watchers, long builds). Default false.' },
    wait_for: { type: 'string', description: 'Background only: wait until the output matches this text/regex (e.g. "ready|listening") before returning.' },
    wait_seconds: { type: 'integer', description: 'Background only: how long to wait for wait_for or initial output (default 3, or 30 with wait_for; max 120).' },
    timeout_seconds: { type: 'integer', description: 'Foreground only: seconds before the command is moved to the background (default 120, max 600).' },
  }, ['command']),
  read_process_output: fn('read_process_output', 'Get new output from a background process since you last read it, plus its status (running / exited with code). Optionally wait for more output, a pattern, or the process to exit.', {
    id: { type: 'string', description: 'Process id, e.g. "bg-1".' },
    wait_for: { type: 'string', description: 'Optional text/regex to wait for in the output.' },
    wait_seconds: { type: 'integer', description: 'Optional seconds to wait for wait_for or for the process to exit (max 120).' },
  }, ['id']),
  stop_process: fn('stop_process', 'Stop a background process (and all of its child processes).', {
    id: { type: 'string', description: 'Process id, e.g. "bg-1".' },
  }, ['id']),
  list_processes: fn('list_processes', 'List background processes with their status and any detected URL.', {}),
};

TOOLS.ask_user = fn('ask_user', 'Ask the user one or more multiple-choice questions and wait for their answers. Use this whenever you need the user to pick between options or clarify requirements, instead of writing the options as plain text. The user can also type a custom answer.', {
  questions: {
    type: 'array',
    description: 'Questions to ask (1-6).',
    items: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, ending with a question mark.' },
        options: { type: 'array', items: { type: 'string' }, description: '2-8 short, distinct answer options. Do not add an "Other" option; one is provided automatically.' },
        multi_select: { type: 'boolean', description: 'Allow selecting more than one option. Default false.' },
      },
      required: ['question', 'options'],
    },
  },
}, ['questions']);

const READ_ONLY_TOOLS = ['list_dir', 'read_file', 'search', 'find_files', 'ask_user', 'read_process_output', 'list_processes'];
const AGENT_TOOLS = Object.keys(TOOLS);
const NO_FOLDER_TOOLS = ['ask_user'];

/** Validate/normalize ask_user arguments coming from the model. */
function normalizeQuestions(args) {
  const qs = Array.isArray(args && args.questions) ? args.questions : [];
  return qs.slice(0, 6).map((q) => ({
    question: String((q && q.question) || '').trim(),
    options: (Array.isArray(q && q.options) ? q.options : []).map((o) => String(typeof o === 'object' && o ? o.label || o.text || JSON.stringify(o) : o).trim()).filter(Boolean).slice(0, 8),
    multiSelect: !!(q && (q.multi_select || q.multiSelect)),
  })).filter((q) => q.question && q.options.length >= 1);
}

function formatAnswers(questions, answers) {
  return questions.map((q, i) => {
    const a = answers[i] || {};
    const picked = [...(a.selected || []), ...(a.other ? [a.other] : [])];
    return `${i + 1}. ${q.question}\n   Answer: ${picked.length ? picked.join('; ') : '(no answer)'}`;
  }).join('\n');
}

function clip(s, n = MAX_TOOL_OUTPUT) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}\n...[truncated ${s.length - n} characters]` : s;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/** Apply a search/replace edit, tolerant of CRLF vs LF differences. */
function applyEdit(content, oldStr, newStr, replaceAll = false) {
  const crlf = content.includes('\r\n');
  let o = String(oldStr);
  let n = String(newStr);
  if (crlf) {
    o = o.replace(/\r?\n/g, '\r\n');
    n = n.replace(/\r?\n/g, '\r\n');
  } else {
    o = o.replace(/\r\n/g, '\n');
    n = n.replace(/\r\n/g, '\n');
  }
  let count = countOccurrences(content, o);
  if (count === 0) {
    // Retry ignoring trailing whitespace differences on each line.
    const strip = (s) => s.replace(/[ \t]+(\r?\n)/g, '$1').replace(/[ \t]+$/, '');
    const o2 = strip(o);
    const lines = content.split(/(\r?\n)/);
    const stripped = lines.map((l, i) => (i % 2 === 0 ? l.replace(/[ \t]+$/, '') : l)).join('');
    if (o2 && countOccurrences(stripped, o2) === 1) {
      return { ok: true, content: stripped.replace(o2, () => n), replaced: 1 };
    }
    return { ok: false, error: 'old_string was not found in the file. Re-read the file and copy the exact text (without line number prefixes).' };
  }
  if (count > 1 && !replaceAll) {
    return { ok: false, error: `old_string matches ${count} places. Include more surrounding context to make it unique, or set replace_all.` };
  }
  const out = replaceAll ? content.split(o).join(n) : content.replace(o, () => n);
  return { ok: true, content: out, replaced: replaceAll ? count : 1 };
}

function procHeader(p) {
  const state = p.status === 'running' ? 'running' : p.status === 'stopped' ? 'stopped' : `exited with code ${p.exitCode}`;
  return `Process ${p.id} \`${p.command}\`: ${state}${p.url ? ` — ${p.url}` : ''}`;
}

function listText(bg) {
  const lines = bg.summary();
  return lines.length ? `Background processes:\n${lines.join('\n')}` : 'There are no background processes.';
}

function numberLines(text, start = 1) {
  const lines = text.split(/\r?\n/);
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width, ' ')}|${l}`).join('\n');
}

async function buildSystemPrompt({ mode, root, bg }) {
  const p = platformInfo();
  const lines = [
    'You are an expert AI pair programmer working inside a code editor (a Cursor-like IDE).',
    `Operating system: ${p.osName} (${p.platform} ${p.arch}). Shell used by run_command: ${p.shell}.`,
    p.platform === 'win32'
      ? 'Commands run on Windows: use PowerShell syntax (e.g. Get-ChildItem, `;` to chain, $env:VAR), not bash.'
      : 'Commands run on a POSIX shell (bash/sh).',
    `Current date: ${new Date().toISOString().slice(0, 10)}.`,
  ];
  if (root) {
    lines.push(`Workspace root: ${root}`, 'Use paths relative to the workspace root in tool calls, with forward slashes.');
    try {
      const tree = await ws.overview(root);
      if (tree) lines.push('Workspace overview (partial):', '```', tree, '```');
    } catch { /* ignore */ }
  } else {
    lines.push('No folder is open, so file tools are unavailable.');
  }
  if (mode === 'agent') {
    lines.push(
      '',
      'You are in AGENT mode: you can read, search, create and edit files and run commands using the provided tools.',
      'Work autonomously until the task is complete: explore the relevant code first, then make focused changes.',
      'Prefer edit_file for targeted changes; use write_file for new files or full rewrites. Never output whole files in chat instead of editing them.',
      'After editing, verify when practical (e.g. run tests, a build, or a linter) and fix problems you introduced.',
      'Start dev servers, watchers and other long-running commands with run_command background: true (use wait_for, e.g. "ready|listening|compiled", to wait until it is up), then check them with read_process_output. Stop servers you no longer need with stop_process, but leave ones the user asked to keep running.',
      'The user may reject a proposed change or command; if so, adapt to their feedback.',
      'Finish with a brief summary of what you changed.',
    );
  } else if (mode === 'plan') {
    lines.push(
      '',
      'You are in PLAN mode. Do NOT modify files or run commands; you only have read-only tools.',
      'First research the request: explore the relevant files with the tools so the plan is grounded in the actual code.',
      'If the request is ambiguous in a way that changes the plan, call the ask_user tool with short multiple-choice questions before writing the plan, or state your assumptions.',
      'Then write the plan in Markdown with these sections:',
      '## Goal — one or two sentences.',
      '## Findings — the relevant files/functions and how they work today (cite paths).',
      '## Plan — a numbered checklist (- [ ] 1. ...) of concrete, ordered steps; each names the file(s) to change and what to change. Include new files and tests.',
      '## Risks & open questions — edge cases, migrations, anything needing a decision.',
      '## Verification — how to confirm it works (commands to run, behaviour to check).',
      'Keep code to short illustrative snippets; the full implementation happens later when the user asks you to implement the plan in Agent mode.',
    );
  } else {
    lines.push(
      '',
      'You are in ASK mode: answer questions and explain code. You may use the read-only tools to look at the workspace.',
      'When suggesting code changes, show them as fenced code blocks with the language and, on the opening fence, the file path, e.g. ```ts src/app.ts',
    );
  }
  const procs = bg ? bg.summary() : [];
  if (procs.length) lines.push('', 'Background processes in this workspace (use read_process_output to see their output):', ...procs);
  lines.push(
    'When you need the user to choose between options or answer clarifying questions, call the ask_user tool (multiple choice) instead of listing the options as plain text; you will receive the answers and can continue.',
    'Be concise. Format answers in Markdown.',
  );
  return lines.join('\n');
}

async function buildContextBlock(root, context, overlays) {
  if (!context) return '';
  const parts = [];
  const seen = new Set();
  const addFile = async (abs, label) => {
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    let content = overlays && overlays[abs];
    if (content == null) {
      try {
        const r = await ws.readText(abs);
        if (r.binary || r.tooLarge) return;
        content = r.content;
      } catch { return; }
    }
    const rel = root ? ws.relPath(root, abs) : abs;
    parts.push(`<file path="${rel}"${label ? ` note="${label}"` : ''}>\n${clip(content, 60000)}\n</file>`);
  };
  if (context.activeFile && context.activeFile.path) {
    const a = context.activeFile;
    if (a.selection && a.selection.text) {
      const rel = root && path.isAbsolute(a.path) ? ws.relPath(root, a.path) : a.path;
      parts.push(`<selection path="${rel}" lines="${a.selection.startLine}-${a.selection.endLine}">\n${clip(a.selection.text, 30000)}\n</selection>`);
    }
    if (a.include !== false) {
      if (a.content != null) {
        seen.add(a.path);
        const rel = root && path.isAbsolute(a.path) ? ws.relPath(root, a.path) : a.path;
        const cursor = a.cursorLine ? ` cursor_line="${a.cursorLine}"` : '';
        parts.push(`<file path="${rel}" note="currently open in the editor"${cursor}>\n${clip(a.content, 60000)}\n</file>`);
      } else await addFile(a.path, 'currently open in the editor');
    }
  }
  for (const s of context.snippets || []) {
    const rel = root && s.path && path.isAbsolute(s.path) ? ws.relPath(root, s.path) : s.path || 'untitled';
    parts.push(`<selection path="${rel}" lines="${s.startLine}-${s.endLine}">\n${clip(s.text, 30000)}\n</selection>`);
  }
  for (const f of context.files || []) await addFile(f, 'attached by the user');
  if (context.terminal) parts.push(`<terminal_output>\n${clip(context.terminal, 12000)}\n</terminal_output>`);
  return parts.length ? `<context>\n${parts.join('\n\n')}\n</context>\n\n` : '';
}

/**
 * Run a chat turn (possibly many agent iterations).
 * @param {object} o
 * @param {object} o.cfg               settings (baseURL, apiKey, model, ...)
 * @param {'ask'|'agent'|'raw'} o.mode
 * @param {Array} o.messages           conversation so far (OpenAI format, last one is the new user message)
 * @param {object} [o.context]         { activeFile, files, terminal }
 * @param {string} [o.root]            workspace root
 * @param {object} [o.overlays]        { absPath: unsavedContent }
 * @param {AbortSignal} [o.signal]
 * @param {(ev:object)=>void} o.emit
 * @param {(req:object)=>Promise<{approved:boolean, feedback?:string}>} o.requestApproval
 * @returns {Promise<{messages:Array, changes:Array}>} new messages to append + file changes made
 */
async function runChat(o) {
  const { cfg, mode, root, overlays = {}, signal, emit } = o;
  const bg = o.bg || defaultManager;
  const requestApproval = o.requestApproval || (async () => ({ approved: true }));
  const history = o.messages.map((m) => ({ ...m }));
  const newMessages = [];
  const changes = new Map(); // abs -> { before }

  let convo;
  let tools = [];
  if (mode === 'raw') {
    convo = history;
  } else {
    const last = history[history.length - 1];
    if (last && last.role === 'user') {
      const ctx = await buildContextBlock(root, o.context, overlays);
      if (ctx) last.content = ctx + String(last.content || '');
      newMessages.push(last);
    }
    convo = [{ role: 'system', content: await buildSystemPrompt({ mode, root, bg }) }, ...history];
    tools = (root ? (mode === 'agent' ? AGENT_TOOLS : READ_ONLY_TOOLS) : NO_FOLDER_TOOLS).map((t) => TOOLS[t]);
  }

  const recordChange = async (abs) => {
    if (changes.has(abs)) return;
    let before = null;
    try { before = (await ws.readText(abs)).content; } catch { before = null; }
    changes.set(abs, { before });
  };

  const readCurrent = async (abs) => {
    if (overlays[abs] != null) return overlays[abs];
    const r = await ws.readText(abs);
    if (r.binary) throw new Error('File appears to be binary.');
    if (r.tooLarge) throw new Error('File is too large to read.');
    return r.content;
  };

  async function execTool(call) {
    let args = {};
    try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch (e) {
      return { ok: false, output: `Invalid JSON arguments: ${e.message}` };
    }
    const name = call.function.name;
    emit({ type: 'tool_start', id: call.id, name, args });
    // Only tools offered for this mode may run (models sometimes call tools they weren't given).
    if (!tools.some((t) => t.function.name === name)) {
      return { ok: false, output: `Tool "${name}" is not available in ${mode} mode.${mode !== 'agent' ? ' Only read-only tools can be used; describe the change instead.' : ''}` };
    }
    const prefs = o.prefs ? o.prefs() : cfg; // read live so "Always allow" applies mid-run
    const autoEdits = !!prefs.autoApproveEdits;
    const autoCmds = !!prefs.autoApproveCommands;
    try {
      switch (name) {
        case 'list_dir': {
          const abs = ws.resolveIn(root, args.path);
          const entries = await ws.readDir(abs);
          const out = entries.map((e) => `${e.name}${e.isDir ? '/' : ''}`).join('\n') || '(empty)';
          return { ok: true, output: clip(out) };
        }
        case 'read_file': {
          const abs = ws.resolveIn(root, args.path);
          const text = await readCurrent(abs);
          const lines = text.split(/\r?\n/);
          const start = Math.max(1, parseInt(args.start_line, 10) || 1);
          const defaultEnd = start + 799;
          const end = Math.min(lines.length, parseInt(args.end_line, 10) || defaultEnd);
          let out = numberLines(lines.slice(start - 1, end).join('\n'), start);
          if (end < lines.length) out += `\n...[file has ${lines.length} lines; showing ${start}-${end}. Use start_line/end_line to read more]`;
          return { ok: true, output: clip(out) };
        }
        case 'search': {
          const { results, truncated } = await ws.searchText(root, args.query, { regex: !!args.regex, include: args.include || '', maxResults: 200, signal });
          if (!results.length) return { ok: true, output: 'No matches.' };
          let out = results.map((r) => `${r.rel}:${r.line}: ${r.text.trim()}`).join('\n');
          if (truncated) out += '\n...[more results omitted]';
          return { ok: true, output: clip(out) };
        }
        case 'find_files': {
          const files = await ws.findFiles(root, args.pattern, { limit: 300 });
          return { ok: true, output: files.length ? files.join('\n') : 'No files found.' };
        }
        case 'write_file':
        case 'edit_file': {
          const abs = ws.resolveIn(root, args.path);
          let before = null;
          try { before = await readCurrent(abs); } catch { before = null; }
          let after;
          if (name === 'write_file') {
            after = String(args.content ?? '');
            if (before && before.includes('\r\n')) after = after.replace(/\r?\n/g, '\r\n');
          } else {
            if (before == null) {
              if (args.old_string) return { ok: false, output: `File not found: ${args.path}. Use write_file to create it.` };
              after = String(args.new_string ?? '');
            } else {
              const r = applyEdit(before, args.old_string, args.new_string, !!args.replace_all);
              if (!r.ok) return { ok: false, output: r.error };
              after = r.content;
            }
          }
          if (before === after) return { ok: true, output: 'No changes were necessary (content identical).' };
          const rel = ws.relPath(root, abs);
          if (!autoEdits) {
            const res = await requestApproval({ kind: 'edit', toolCallId: call.id, path: abs, rel, before: before ?? '', after, isNew: before == null });
            if (!res.approved) return { ok: false, rejected: true, output: `The user rejected this change to ${rel}.${res.feedback ? ` Feedback: ${res.feedback}` : ''}` };
            if (typeof res.after === 'string') after = res.after; // user may have tweaked it
          }
          await recordChange(abs);
          await ws.writeText(abs, after);
          delete overlays[abs];
          emit({ type: 'file_changed', path: abs, content: after });
          const diffSummary = before == null ? `Created ${rel} (${after.split('\n').length} lines).` : `Updated ${rel}.`;
          return { ok: true, output: diffSummary };
        }
        case 'delete_file': {
          const abs = ws.resolveIn(root, args.path);
          const rel = ws.relPath(root, abs);
          if (!(await ws.exists(abs))) return { ok: false, output: `File not found: ${rel}` };
          if (!autoEdits) {
            const res = await requestApproval({ kind: 'delete', toolCallId: call.id, path: abs, rel });
            if (!res.approved) return { ok: false, rejected: true, output: `The user rejected deleting ${rel}.${res.feedback ? ` Feedback: ${res.feedback}` : ''}` };
          }
          await recordChange(abs);
          await fsp.rm(abs, { force: true });
          emit({ type: 'file_deleted', path: abs });
          return { ok: true, output: `Deleted ${rel}.` };
        }
        case 'ask_user': {
          const questions = normalizeQuestions(args);
          if (!questions.length) return { ok: false, output: 'ask_user needs at least one question with options.' };
          const res = await requestApproval({ kind: 'question', toolCallId: call.id, questions });
          if (!res.approved || !Array.isArray(res.answers)) {
            return { ok: false, rejected: true, output: `The user dismissed the questions without answering.${res.feedback ? ` Feedback: ${res.feedback}` : ''} Proceed with reasonable assumptions and state them.` };
          }
          return { ok: true, output: `The user answered:\n${formatAnswers(questions, res.answers)}`, answers: { questions, answers: res.answers } };
        }
        case 'run_command': {
          const cwd = ws.resolveIn(root, args.cwd || '.');
          const command = String(args.command || '');
          if (!command.trim()) return { ok: false, output: 'Empty command.' };
          const background = !!args.background;
          if (!autoCmds) {
            const res = await requestApproval({ kind: 'command', toolCallId: call.id, command, cwd: ws.relPath(root, cwd), background });
            if (!res.approved) return { ok: false, rejected: true, output: `The user declined to run this command.${res.feedback ? ` Feedback: ${res.feedback}` : ''}` };
          }
          if (background) {
            const info = bg.start(command, { cwd, origin: 'agent' });
            emit({ type: 'tool_process', id: call.id, procId: info.id, background: true });
            const p = bg.get(info.id);
            let note = '';
            if (args.wait_for) {
              const secs = clampSec(args.wait_seconds, 30, 120);
              const w = await bg.waitFor(info.id, args.wait_for, secs * 1000);
              note = w.matched ? `Output matched "${args.wait_for}".` : w.exited ? `The process exited before "${args.wait_for}" appeared.` : `"${args.wait_for}" did not appear within ${secs}s; it may still be starting.`;
            } else {
              await Promise.race([sleep(clampSec(args.wait_seconds, 3, 120) * 1000), p.exitPromise]);
            }
            const r = bg.read(info.id);
            return { ok: r.status === 'running' || r.exitCode === 0, output: `${procHeader(r)}${note ? `\n${note}` : ''}\nOutput so far:\n${clip(stripAnsi(r.output).trim() || '(no output yet)')}${r.status === 'running' ? `\nIt keeps running in the background. Use read_process_output("${r.id}") to check it and stop_process("${r.id}") to stop it.` : ''}` };
          }
          const timeoutMs = clampSec(args.timeout_seconds, 120, 600) * 1000;
          const r = await bg.runForeground(command, {
            cwd, timeoutMs, signal,
            onData: (text) => emit({ type: 'tool_output', id: call.id, text }),
            onStart: (procId) => emit({ type: 'tool_process', id: call.id, procId, background: false }),
          });
          const out = clip(r.output.trim() || '(no output)');
          if (r.detached) {
            const why = r.reason === 'user' ? 'the user sent it to the background' : `it was still running after ${timeoutMs / 1000}s`;
            return { ok: true, output: `${out}\n\nThe command is still running in the background as ${r.id} (${why}). Use read_process_output("${r.id}") to check on it and stop_process("${r.id}") to stop it.` };
          }
          const status = r.status === 'stopped' ? 'The command was stopped.' : `Exit code: ${r.code}`;
          return { ok: r.code === 0, output: `${out}\n${status}` };
        }
        case 'read_process_output': {
          const p = bg.get(args.id || '');
          if (!p) return { ok: false, output: `No background process "${args.id}". ${listText(bg)}` };
          if (p.status === 'running' && (args.wait_for || args.wait_seconds)) {
            const secs = clampSec(args.wait_seconds, 30, 120);
            if (args.wait_for) await bg.waitFor(p.id, args.wait_for, secs * 1000);
            else await Promise.race([sleep(secs * 1000), p.exitPromise]);
          }
          const r = bg.read(p.id);
          const text = stripAnsi(r.output).trim();
          return { ok: true, output: `${procHeader(r)}\n${text ? `${r.truncated ? '...[earlier output omitted]\n' : ''}${text}` : '(no new output since the last read)'}` };
        }
        case 'stop_process': {
          const p = bg.get(args.id || '');
          if (!p) return { ok: false, output: `No background process "${args.id}". ${listText(bg)}` };
          if (p.status !== 'running') return { ok: true, output: `${procHeader(p.info())} — nothing to stop.` };
          bg.stop(p.id);
          await Promise.race([p.exitPromise, sleep(5000)]);
          const tail = stripAnsi(bg.read(p.id).output).trim();
          return { ok: true, output: `Stopped ${p.id} (\`${p.command}\`).${tail ? `\nFinal output:\n${clip(tail, 4000)}` : ''}` };
        }
        case 'list_processes':
          return { ok: true, output: listText(bg) };
        default:
          return { ok: false, output: `Unknown tool: ${name}` };
      }
    } catch (e) {
      return { ok: false, output: `Error: ${e.message}` };
    }
  }

  let iterations = 0;
  let toolsSupported = true;
  let streamed = '';
  try {
    while (true) {
      if (signal && signal.aborted) break;
      if (++iterations > MAX_ITERATIONS) {
        emit({ type: 'notice', text: `Stopped after ${MAX_ITERATIONS} steps. Send a message to continue.` });
        break;
      }
      let done = null;
      streamed = '';
      emit({ type: 'turn_start' });
      try {
        for await (const ev of ai.streamChat(cfg, { messages: convo, tools: toolsSupported ? tools : [], signal })) {
          if (ev.type === 'content') { streamed += ev.text; emit({ type: 'delta', text: ev.text }); }
          else if (ev.type === 'reasoning') emit({ type: 'reasoning', text: ev.text });
          else if (ev.type === 'done') done = ev;
        }
      } catch (e) {
        // Models/servers without tool support: fall back to plain chat in ask mode.
        if (toolsSupported && tools.length && (mode !== 'agent' || !root) && e.status && e.status >= 400 && e.status < 500 && /tool|function/i.test(e.message)) {
          toolsSupported = false;
          iterations--;
          continue;
        }
        throw e;
      }
      if (!done) break;
      const assistant = { role: 'assistant', content: done.content || null };
      if (done.toolCalls && done.toolCalls.length) assistant.tool_calls = done.toolCalls;
      convo.push(assistant);
      newMessages.push(assistant);
      if (!assistant.tool_calls) break;

      for (const call of assistant.tool_calls) {
        if (signal && signal.aborted) {
          const msg = { role: 'tool', tool_call_id: call.id, content: 'Cancelled by the user.' };
          convo.push(msg);
          newMessages.push(msg);
          continue;
        }
        const result = await execTool(call);
        emit({ type: 'tool_end', id: call.id, ok: result.ok, rejected: !!result.rejected, output: result.output });
        const msg = { role: 'tool', tool_call_id: call.id, content: result.output };
        if (result.answers) msg._answers = result.answers; // UI-only; stripped before sending
        convo.push(msg);
        newMessages.push(msg);
      }
    }
  } catch (e) {
    const aborted = (signal && signal.aborted) || e.name === 'AbortError';
    if (!aborted) {
      e.partial = { messages: newMessages, changes: summarizeChanges(root, changes) };
      throw e;
    }
    if (streamed) newMessages.push({ role: 'assistant', content: streamed });
  }

  return {
    messages: newMessages,
    changes: summarizeChanges(root, changes),
  };
}

function summarizeChanges(root, changes) {
  return [...changes.entries()].map(([p, c]) => ({ path: p, rel: root ? ws.relPath(root, p) : p, before: c.before }));
}

module.exports = { runChat, applyEdit, numberLines, buildSystemPrompt, normalizeQuestions, TOOLS };
