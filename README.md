# Cursor Clone

An AI code editor in the style of Cursor that works with **any OpenAI-compatible API**: OpenAI, OpenRouter, Groq, DeepSeek, Together, Mistral, Ollama, LM Studio, vLLM, llama.cpp, LiteLLM, and others. It runs on **Linux and Windows** (macOS should work too, but it hasn't been tested).

It's built with Electron, the Monaco editor (the editor core used by VS Code) and xterm.js.

## Features

| | |
|---|---|
| **Agent mode** (`Ctrl+L`) | The AI reads, searches, creates, edits and deletes files and runs shell commands until the task is done. You approve each edit (with a diff review) and each command, or you can turn on auto-approve. Every run can be **reverted** in one click. |
| **Ask mode** | Q&A about your code with read-only tools. Code blocks have **Copy / Insert / Apply**. Apply merges a partial snippet into the file with the model and shows a diff before writing. |
| **Inline edit** (`Ctrl+K`) | Select code and describe a change, or generate code at the cursor. The result is applied in place and highlighted. `Ctrl+Enter` accepts, `Esc` rejects, and you can type follow-up instructions to refine it. |
| **Tab autocomplete** | AI ghost-text completions. It uses either a chat model or a fill-in-the-middle `/completions` endpoint (Ollama, DeepSeek, Codestral, vLLM). |
| **Context** | The current file and selection are attached automatically. Use `@file` mentions or 📎 to attach more files, add a selection with `Ctrl+L`, or send terminal output to the chat. |
| **Editor** | Tabs, preview tabs, a file explorer (create, rename, delete to trash), find-in-files, quick open (`Ctrl+P`), a command palette (`Ctrl+Shift+P`), diff views, LF/CRLF handling, light and dark themes. |
| **Terminal** (`` Ctrl+` ``) | Multiple integrated terminals: PowerShell or cmd on Windows, your `$SHELL` on Linux. |
| **Chats** | Saved per workspace, with history. |

## Quick start

Requirements: **Node.js 20+** (22 LTS recommended) and git.

```bash
npm install
npm start                 # or: npm start -- /path/to/project
```

Then open **Settings** (`Ctrl+,`, or click the model name in the status bar):

1. Pick a preset or enter a **Base URL**, for example `https://api.openai.com/v1` or `http://localhost:11434/v1` for Ollama.
2. Enter your **API key**. Leave it empty for local servers.
3. Click **Fetch** to list models, choose one, then click **Test connection**.

You can also set `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL` as environment variables; they're used as defaults.

The API key is encrypted with the OS keychain (DPAPI on Windows, libsecret/kwallet on Linux) when one is available.

### Example: fully local with Ollama

```bash
ollama pull qwen2.5-coder:7b
# Settings → preset "Ollama (local)", model qwen2.5-coder:7b
# For autocomplete: Strategy = "Fill-in-the-middle", model qwen2.5-coder:1.5b-base
```

Agent mode needs a model that supports **tool/function calling**, such as `gpt-4o`, `gpt-4.1`, Claude through OpenRouter, Qwen2.5-Coder, Llama 3.1+ or DeepSeek-V3. Ask mode falls back to plain chat when the server rejects tools.

## Building installers

```bash
npm run dist:linux        # dist/*.AppImage, *.deb, *.tar.gz
npm run dist:win          # dist/*Setup*.exe (NSIS installer) and *-portable.exe
```

Build each platform **on that platform**. Windows installers need Windows, or Wine on Linux. The included GitHub Actions workflow (`.github/workflows/build.yml`) runs the tests and builds both platforms on every push, then uploads the installers as artifacts.


### Publishing a release

To publish, bump the version and push a tag that matches it:

```bash
npm version 1.1.0          # updates package.json, commits, and creates tag v1.1.0
git push --follow-tags
```

CI then tests and builds on Ubuntu and Windows. It creates a GitHub Release with these files:

- `cursor-clone-<ver>-x86_64.AppImage`
- `cursor-clone-<ver>-amd64.deb`
- `cursor-clone-<ver>-x64.tar.gz`
- `cursor-clone-<ver>-setup.exe`
- `cursor-clone-<ver>-portable.exe`
- `SHA256SUMS.txt`

A tag containing `-` (for example `v1.1.0-beta.1`) is published as a pre-release. The build fails if the tag doesn't match `package.json`.

### Linux notes

- **Terminal backends.** A full PTY comes from `node-pty` when it compiles, which needs `build-essential`/`gcc-c++`, `make` and `python3` at `npm install` time. Without a compiler the app falls back to util-linux `script`, which still gives a real PTY with colors, job control and resize. A basic pipe terminal is the last resort.
- **Sandbox errors in dev.** `npm start` passes `--no-sandbox` on Linux, because dev Electron binaries don't have a SUID sandbox helper. The `.deb` package configures the sandbox properly.
- **AppImage won't start.** On distros that restrict unprivileged user namespaces (for example Ubuntu 24.04+), run it as `./Cursor\ Clone-*.AppImage --no-sandbox` or install the `.deb`.

- **Blank window in a VM or remote desktop** without GPU acceleration: start the app with `--disable-gpu`.

### Windows notes

- `node-pty` ships prebuilt ConPTY binaries for x64 and arm64, so no Visual Studio is needed.
- **Terminal shell.** The terminal and the agent's `run_command` use PowerShell 7 (`pwsh`) when it's installed, otherwise Windows PowerShell, otherwise `cmd.exe`. You can override the terminal shell in Settings. The agent is told which OS and shell it's on, so it writes PowerShell commands on Windows.
- Files with CRLF line endings keep them when the agent edits them.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| AI chat / add selection to chat | `Ctrl+L` |
| New chat | `Ctrl+Shift+L` |
| Inline edit / generate | `Ctrl+K` |
| Accept autocomplete | `Tab` |
| Quick open file | `Ctrl+P` |
| Command palette | `Ctrl+Shift+P` / `F1` |
| Find in files | `Ctrl+Shift+F` |
| Toggle terminal / new terminal | ``Ctrl+` `` / ``Ctrl+Shift+` `` |
| Toggle sidebar | `Ctrl+B` |
| Save / save all | `Ctrl+S` / `Ctrl+Alt+S` |
| Open folder | `Ctrl+Shift+O` |
| Settings | `Ctrl+,` |
| DevTools | `F12` |

## Architecture

```
src/
  main/                 Electron main process (Node)
    main.js             window, menu, app:// protocol, IPC
    ai.js               OpenAI-compatible client: SSE streaming, tool calls, models, FIM
    agent.js            agent loop, tool definitions and execution, approvals, context
    workspace.js        file tree, search, .gitignore, path safety
    platform.js         shell detection, run/kill process trees (Windows + POSIX)
    terminal.js         node-pty → `script` → pipe fallbacks
    settings.js         settings with keychain-encrypted API key
  preload.js            minimal, typed bridge (contextIsolation + sandbox)
  renderer/             UI (plain ES modules, no bundler)
    js/app.js           bootstrap, layout, commands, keybindings
    js/editor.js        Monaco tabs/models, diff modal
    js/chat.js          chat panel, markdown, tool cards, approvals, apply/revert
    js/inline.js        Ctrl+K inline edit + ghost-text autocomplete
    js/explorer.js      file tree
    js/terminal.js      xterm.js terminals
test/
  core.test.js          unit/integration tests against a mock OpenAI server
  smoke-main.js         end-to-end test that drives the real app UI
```

Security notes:

- All API calls happen in the main process, so the renderer never sees network credentials.
- The renderer is sandboxed, with context isolation and a strict CSP.
- Agent file tools can't reach outside the open workspace folder.
- Destructive tools (write, edit, delete, run) need your approval unless you opt out.

## Tests

```bash
npm test                          # unit + agent-loop tests (mock OpenAI server)
npm run test:e2e                  # drives the real Electron UI (needs a display)
xvfb-run -a npm run test:e2e      # headless Linux
```
