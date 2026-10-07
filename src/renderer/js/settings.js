// Settings dialog: provider / model configuration and editor preferences.
import { h, modal, toast } from './util.js';

const PRESETS = [
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Together', baseURL: 'https://api.together.xyz/v1', model: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
  { name: 'Mistral', baseURL: 'https://api.mistral.ai/v1', model: 'codestral-latest' },
  { name: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
  { name: 'LM Studio (local)', baseURL: 'http://localhost:1234/v1', model: '' },
  { name: 'vLLM / llama.cpp (local)', baseURL: 'http://localhost:8000/v1', model: '' },
];

export function openSettings(app) {
  const s = { ...app.settings };
  const f = {};
  const text = (key, attrs = {}) => (f[key] = h('input', { type: 'text', value: s[key] ?? '', spellcheck: 'false', ...attrs }));
  const num = (key, attrs = {}) => (f[key] = h('input', { type: 'number', value: s[key] ?? '', ...attrs }));
  const check = (key) => (f[key] = h('input', { type: 'checkbox', ...(s[key] ? { checked: true } : {}) }));
  const select = (key, options) => {
    const el = h('select', {}, options.map(([v, l]) => h('option', { value: v }, l)));
    el.value = String(s[key]);
    return (f[key] = el);
  };

  const preset = h('select', {}, h('option', { value: '' }, 'Choose a preset…'), PRESETS.map((p, i) => h('option', { value: String(i) }, p.name)));
  preset.addEventListener('change', () => {
    const p = PRESETS[Number(preset.value)];
    if (!p) return;
    f.baseURL.value = p.baseURL;
    if (p.model) f.model.value = p.model;
  });

  const apiKey = h('input', { type: 'password', value: s.apiKey || '', spellcheck: 'false', placeholder: 'sk-… (leave empty for local servers)' });
  f.apiKey = apiKey;
  const showKey = h('button', { class: 'btn small', onclick: () => { apiKey.type = apiKey.type === 'password' ? 'text' : 'password'; } }, 'Show');

  const modelList = h('datalist', { id: 'settings-models' }, (s.modelList || []).map((m) => h('option', { value: m })));
  text('model', { list: 'settings-models', placeholder: 'e.g. gpt-4o-mini' });
  text('autocompleteModel', { list: 'settings-models', placeholder: 'defaults to chat model' });
  const headers = h('textarea', { spellcheck: 'false', placeholder: '{"HTTP-Referer": "https://example.com"}' }, Object.keys(s.extraHeaders || {}).length ? JSON.stringify(s.extraHeaders, null, 2) : '');
  const testOut = h('span', { class: 'test-result' });

  const current = () => {
    let extraHeaders = {};
    const raw = headers.value.trim();
    if (raw) {
      try { extraHeaders = JSON.parse(raw); } catch { throw new Error('Extra headers must be valid JSON.'); }
    }
    return {
      baseURL: f.baseURL.value.trim(),
      apiKey: apiKey.value.trim(),
      model: f.model.value.trim(),
      autocompleteModel: f.autocompleteModel.value.trim(),
      autocompleteEnabled: f.autocompleteEnabled.checked,
      autocompleteMode: f.autocompleteMode.value,
      autocompleteDelay: Number(f.autocompleteDelay.value) || 350,
      temperature: f.temperature.value === '' ? null : Number(f.temperature.value),
      maxTokens: Number(f.maxTokens.value) || 0,
      extraHeaders,
      autoApproveEdits: f.autoApproveEdits.checked,
      autoApproveCommands: f.autoApproveCommands.checked,
      terminalShell: f.terminalShell.value.trim(),
      fontSize: Number(f.fontSize.value) || 14,
      tabSize: Number(f.tabSize.value) || 2,
      wordWrap: f.wordWrap.value,
      minimap: f.minimap.checked,
      theme: f.theme.value,
    };
  };

  const fetchModels = async () => {
    testOut.className = 'test-result';
    testOut.textContent = 'Fetching models…';
    try {
      const c = current();
      const list = await window.api.ai.models({ baseURL: c.baseURL, apiKey: c.apiKey, extraHeaders: c.extraHeaders });
      modelList.innerHTML = '';
      for (const m of list) modelList.append(h('option', { value: m }));
      s.modelList = list;
      testOut.className = 'test-result ok';
      testOut.textContent = `${list.length} models available — click the Model field to pick one.`;
    } catch (e) {
      testOut.className = 'test-result err';
      testOut.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  const test = async () => {
    testOut.className = 'test-result';
    testOut.textContent = 'Testing…';
    try {
      const c = current();
      const r = await window.api.ai.test({ baseURL: c.baseURL, apiKey: c.apiKey, model: c.model, extraHeaders: c.extraHeaders, maxTokens: 0 });
      testOut.className = 'test-result ok';
      testOut.textContent = `✓ Connected (${r.ms} ms): "${(r.reply || '').trim().slice(0, 60)}"`;
    } catch (e) {
      testOut.className = 'test-result err';
      testOut.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };

  const row = (label, input, hint) => [h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null];
  const info = app.info;
  const body = h('div', { class: 'form' },
    h('h3', {}, 'AI provider (OpenAI-compatible)'),
    row('Preset', preset),
    row('Base URL', text('baseURL', { placeholder: 'https://api.openai.com/v1' }), 'Any server implementing /v1/chat/completions (OpenAI, Ollama, LM Studio, vLLM, OpenRouter, LiteLLM, …).'),
    row('API key', h('div', { class: 'inline' }, apiKey, showKey), info.canEncrypt ? 'Stored encrypted with your OS keychain.' : 'OS keychain unavailable: key is stored in plain text in the app settings file.'),
    row('Model', h('div', { class: 'inline' }, f.model, modelList, h('button', { class: 'btn small', onclick: fetchModels }, 'Fetch'))),
    row('', h('div', { class: 'inline' }, h('button', { class: 'btn small', onclick: test }, 'Test connection'), testOut)),
    row('Temperature', num('temperature', { step: '0.1', min: '0', max: '2' })),
    row('Max output tokens', num('maxTokens', { min: '0', step: '256' }), '0 = server default.'),
    row('Extra HTTP headers (JSON)', headers),
    h('h3', {}, 'Agent'),
    row('Auto-apply file edits', check('autoApproveEdits'), 'When off, you review each edit the agent wants to make.'),
    row('Auto-run commands', check('autoApproveCommands'), 'When off, you approve each shell command.'),
    h('h3', {}, 'Tab autocomplete'),
    row('Enabled', check('autocompleteEnabled')),
    row('Autocomplete model', f.autocompleteModel, 'Use a small, fast model for best latency.'),
    row('Strategy', select('autocompleteMode', [['chat', 'Chat model (works everywhere)'], ['fim', 'Fill-in-the-middle via /completions (Ollama, DeepSeek, Codestral, vLLM)']])),
    row('Delay (ms)', num('autocompleteDelay', { min: '100', step: '50' })),
    h('h3', {}, 'Editor'),
    row('Theme', select('theme', [['dark', 'Dark'], ['light', 'Light']])),
    row('Font size', num('fontSize', { min: '8', max: '40' })),
    row('Tab size', num('tabSize', { min: '1', max: '8' })),
    row('Word wrap', select('wordWrap', [['off', 'Off'], ['on', 'On']])),
    row('Minimap', check('minimap')),
    h('h3', {}, 'Terminal'),
    row('Shell', text('terminalShell', { placeholder: info.platform === 'win32' ? 'auto (pwsh / powershell / cmd)' : 'auto ($SHELL)' }),
      `${info.hasPty ? 'Full PTY terminal available.' : 'node-pty not available: using a basic terminal.'} Running on ${info.osName} ${info.arch}.`),
  );

  modal({
    title: 'Settings',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          let c;
          try { c = current(); } catch (e) { toast(e.message, 'error'); return false; }
          c.modelList = s.modelList || [];
          await app.saveSettings(c);
          toast('Settings saved', 'ok');
          return true;
        },
      },
    ],
  });
}
