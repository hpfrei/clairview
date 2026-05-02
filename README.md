<div align="center">

<img src="public/favicon.svg" width="80" alt="vistaclair logo"/>

# $\Huge\textsf{vistaclair}$

$\large\textsf{\color{#58a6ff}inspect\color{#8b949e}{\kern{6mu}·\kern{6mu}}\color{#3fb950}chat\color{#8b949e}{\kern{6mu}·\kern{6mu}}\color{#bc8cff}route}$

A development dashboard that wraps [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with real-time API inspection,
multi-session chat, custom MCP tools, multi-provider model routing, and a REST API.

[Getting started](#getting-started) ·
[Features](#features) ·
[Architecture](#architecture) ·
[API reference](#rest-api) ·
[Project structure](#project-structure)

</div>

---

## Use cases

| | |
|---|---|
| $\color{#58a6ff}{\textsf{Study the wire protocol}}$ | See exactly what Claude Code sends and receives: system prompts, tool schemas, SSE events, token counts, costs |
| $\color{#3fb950}{\textsf{Remote access}}$ | Run Claude Code on a powerful machine and control it from a phone, tablet, or any browser |
| $\color{#bc8cff}{\textsf{Multi-provider routing}}$ | Route Claude Code through OpenAI, Gemini, DeepSeek, Kimi, or local models via provider translation |
| $\color{#79c0ff}{\textsf{Tool development}}$ | Create and test custom MCP tools from a form-driven editor without leaving the browser |
| $\color{#f778ba}{\textsf{Programmatic access}}$ | Drive chats via the REST API with Server-Sent Events streaming |

---

## Getting started

### Prerequisites

- **Node.js 18+** and **npm**
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

<details>
<summary><b>Installing Node.js and npm</b></summary>

**macOS** (via Homebrew):
```bash
brew install node
```

**Ubuntu / Debian**:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows**: download the installer from [nodejs.org](https://nodejs.org/)

Verify the installation:
```bash
node --version   # v18+ required
npm --version
```

</details>

### Install

```bash
git clone https://github.com/hpfrei/vistaclair.git
cd vistaclair
npm install
```

> [!IMPORTANT]
> Always run `npm install` after cloning or pulling new changes to install dependencies.

Run `claude` once manually to authenticate if you haven't already. With a Max subscription, just run `claude login` -- no API key needed.

### Run

```bash
npm start
```

On startup, an auth token is printed to the console:

```
Auth token (auto-generated):
c0b253eb-c650-4def-ba2c-4b2b1b545d85
```

Open **http://localhost:3457** and log in with the token.

> [!TIP]
> Custom port: `npm start -- 8080` or `DASHBOARD_PORT=8080 npm start`

> [!TIP]
> Inspect an external Claude Code session by pointing it at the proxy:
> ```bash
> ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "your prompt"
> ```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_TOKEN` | auto-generated | Dashboard auth token |
| `PROXY_PORT` | `3456` | API proxy port (localhost only) |
| `DASHBOARD_PORT` | `3457` | Web dashboard port (all interfaces) |
| `ANTHROPIC_TARGET_URL` | `https://api.anthropic.com` | Upstream API URL |
| `MAX_HISTORY` | `200` | Max interactions kept in memory |

> [!WARNING]
> The dashboard binds to `0.0.0.0` for remote access. It is protected by the auth token, but do not expose it to untrusted networks without TLS/VPN.

---

## Features

### $\color{#58a6ff}{\textsf{Inspector}}$

A transparent proxy that captures every API call between Claude Code and the upstream LLM -- across all sessions, all providers, in real time.

- Full request/response capture with headers, payloads, and timing
- Live SSE event stream -- watch `message_start`, `content_block_delta`, tool calls as they arrive
- Hierarchical timeline: turns > tool calls, with search and filtering
- Token usage breakdown: input, output, cache read, cache creation
- **Cost tracking** per interaction, per model, per provider
- Live **markdown rendering** of assistant responses in the detail panel
- Profile flags (bare mode, auto-memory) shown per request
- All interactions saved to disk as structured JSON for offline analysis

### $\color{#3fb950}{\textsf{Chat}}$

Multi-tab browser-based Claude Code sessions with full conversation context.

- Send prompts, get streamed responses, answer interactive questions -- no terminal needed
- **Multiple independent tabs**, each with its own profile, model, and working directory
- **Per-session isolation** -- switching profiles or models in one tab never affects another
- Session resume via `--resume` -- follow-up questions work naturally
- **AskUserQuestion** interception -- Claude's questions appear in the browser, answers are injected back transparently
- Live **task panel** -- `TaskCreate`/`TaskUpdate` tool calls rendered as a draggable status board
- Stop running sessions at any time
- Live process counter in the footer shows how many `claude -p` instances are active

### $\color{#d29922}{\textsf{Profiles}}$

Named capability bundles that control how `claude -p` is spawned.

| Setting | CLI flag | Description |
|---|---|---|
| Model | `--model` | sonnet, opus, haiku, or custom model ID |
| Effort | `--effort` | low, medium, high, max |
| Permission mode | `--permission-mode` | default, acceptEdits, plan, bypassPermissions, dontAsk, auto |
| Allowed/disabled tools | `--allowedTools` / `--disallowedTools` | Per-tool enable/disable via checkboxes |
| Model definition | profile `modelDef` field | Route through a third-party model |
| Bare mode | `--bare` | Strip skills and MCP servers |
| Disable auto-memory | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Prevent auto-memory writes |
| Slash commands | `--disable-slash-commands` | Enable/disable built-in skills |
| Max turns | `--max-turns` | Cap agentic loop iterations |
| Budget | `--max-budget-usd` | Dollar spend limit per run |
| System prompt | `--append-system-prompt` / `--system-prompt` | Append to or replace the default system prompt |
| MCP servers | `--mcp-config` | Integrated server with custom tools |

**Built-in profiles:**

| Profile | Permission mode | Description |
|---|---|---|
| $\color{#3fb950}{\texttt{full}}$ | `bypassPermissions` | All tools, no prompts |
| $\color{#d29922}{\texttt{safe}}$ | `acceptEdits` | No bash, write, edit, or destructive tools |
| $\color{#58a6ff}{\texttt{readonly}}$ | `plan` | Only Read, Glob, Grep, AskUserQuestion |
| $\color{#8b949e}{\texttt{minimal}}$ | `plan` | Only Read, Glob, Grep; slash commands disabled |

Duplicate any built-in profile to create an editable custom profile with full control over all settings.

### $\color{#bc8cff}{\textsf{LLM Provider Adapters}}$

Route Claude Code through non-Anthropic models. The proxy translates Anthropic Messages API requests into the target provider's format and translates responses back -- Claude Code sees a normal Anthropic API.

| Provider | Models | Notes |
|---|---|---|
| **Anthropic** | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 | Direct passthrough (no translation) |
| **OpenAI** | GPT-5.4, GPT-5.4 Pro / Mini / Nano | via `api.openai.com` |
| **Google Gemini** | Gemini 3.1 Pro, 3 Flash, 2.5 Flash | 1M context, reasoning support |
| **DeepSeek** | V3.2, R1 Thinking | 128K context |
| **Moonshot (Kimi)** | K2.5, K2 Thinking | 256K context |
| **Ollama** | Any local model | localhost base URL |

Model definitions are configured in `capabilities/models.json`. API keys stored separately in `capabilities/secrets.json` (gitignored). Each model can specify system prompt handling (`replace` / `prepend` / `append` / `passthrough`), reasoning mode, context window, max output tokens, and cost per million tokens.

### $\color{#79c0ff}{\textsf{MCP Tool Manager}}$

Extend Claude Code with custom tools through one integrated MCP server.

- Form-driven tool editor with typed parameters (string, number, boolean, object, array)
- Auto-generated `server.js` and per-tool handler files -- you only write the handler body
- Enable/disable tools with checkboxes, restart indicator when changes need applying
- Inline testing with parameter inputs and result display
- All MCP tool calls logged in the Inspector

**Built-in MCP tools** (always available):

| Tool | Description |
|---|---|
| `chat` | Run a prompt through Claude Code, supports multi-turn via `session_id`, profile and cwd selection |

The `chat` tool enables **delegation** -- a Claude session can spawn sub-conversations with different profiles (e.g. an orchestrator using `chat` to delegate research to a `readonly` session).

### $\color{#f778ba}{\textsf{Skills, Agents, and Hooks}}$

- **Skills** -- create and edit skills (`.claude/skills/<name>/SKILL.md`) with supporting template files
- **Agents** -- custom sub-agents with their own system prompts, models, and tool restrictions
- **Hooks** -- lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`, etc.) with command, prompt, or agent handlers

### $\textsf{Themes}$

Two built-in themes toggled from the header: **Bright** (checker-paper grid, default) and **Dark** (Tokyo Night palette).

---

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/architecture-light.svg">
  <img alt="vistaclair architecture" src="docs/architecture-light.svg" width="880">
</picture>

vistaclair runs two servers from a single Node.js process:

| Server | Port | Binding | Purpose |
|---|---|---|---|
| **Proxy** | `:3456` | `127.0.0.1` | Intercepts all Claude API calls for inspection and model routing |
| **Dashboard** | `:3457` | `0.0.0.0` | WebSocket + REST API + web UI (auth-protected) |

### Per-session isolation

Every `claude -p` process gets its profile baked into its base URL at spawn time:

```
ANTHROPIC_BASE_URL = http://localhost:3456/p/{profileName}
```

This means the profile is **immutable for the process lifetime**. Switching profiles in the browser never affects a running session. Concurrent chats and API calls are fully isolated.

### Request flow

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/request-flow-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/request-flow-light.svg">
  <img alt="Request flow diagram" src="docs/request-flow-light.svg" width="880">
</picture>

### AskUserQuestion interception

When `claude -p` calls the `AskUserQuestion` tool during a chat:

1. The proxy intercepts the tool call in the API response stream
2. When `claude -p` sends back the error `tool_result`, the proxy pauses the request
3. The proxy broadcasts `ask:question` to the dashboard UI
4. The UI renders the question with options and free text input
5. User answers, UI sends `ask:answer` back via WebSocket
6. Proxy rewrites the `tool_result` with the real answer and continues the API call
7. Claude resumes as if the tool succeeded normally

---

## REST API

The dashboard server (`:3457`) exposes a REST API for programmatic access. All endpoints require authentication.

> [!NOTE]
> Auth methods: cookie `token=<TOKEN>`, header `Authorization: Bearer <TOKEN>`, or `X-Vistaclair-Internal: true` from localhost.

### $\texttt{POST /api/run}$

Start a chat. Returns a **Server-Sent Events** stream.

<details>
<summary><b>Chat mode</b></summary>

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `string` | **yes** | `"chat"` |
| `prompt` | `string` | **yes** | The user message to send to Claude |
| `cwd` | `string` | no | Working directory (sandboxed into `outputs/`) |
| `profile` | `string` | no | Profile name (e.g. `"full"`, `"safe"`, or custom). Does not change the global active profile. |
| `sessionId` | `string` | no | Resume an existing session for multi-turn. Returned in the `done` event. |

</details>

<details>
<summary><b>SSE events</b></summary>

| Event | Payload | Description |
|---|---|---|
| `text` | `{ text }` | Streamed text delta from Claude |
| `ask` | `{ toolUseId, questions }` | AskUserQuestion -- answer via `POST /api/run/answer` |
| `error` | `{ error }` | Error message |
| `done` | `{ result, sessionId? }` | Completion with final result |

</details>

### $\texttt{POST /api/run/answer}$

Answer a pending `AskUserQuestion` from the `ask` SSE event. The run resumes after the answer.

| Field | Type | Required | Description |
|---|---|---|---|
| `toolUseId` | `string` | **yes** | The `toolUseId` from the `ask` event |
| `answer` | `any` | **yes** | The answer value |

Returns `{ ok: true }` or `404` if no pending question matches.

### $\texttt{GET /api/dirs}$

List subdirectories within `outputs/`.

| Param | Type | Required | Description |
|---|---|---|---|
| `path` | query string | no | Relative path within `outputs/`. Defaults to root. |

Returns `{ current, absolute, dirs }` -- `dirs` is a sorted array of subdirectory names.

### $\texttt{POST /api/dirs}$

Create a new directory within `outputs/`.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | no | Parent directory (relative to `outputs/`) |
| `name` | `string` | **yes** | Folder name (alphanumeric, spaces, dots, hyphens, underscores; max 100 chars) |

Returns `{ ok: true, created: "relative/path" }`.

### Examples

<details>
<summary><b>Chat -- single and multi-turn</b></summary>

```bash
# Single turn
curl -N -X POST http://localhost:3457/api/run \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"chat","prompt":"List all TODO comments in the codebase","profile":"readonly"}'

# Multi-turn: use sessionId from the done event
curl -N -X POST http://localhost:3457/api/run \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"chat","prompt":"Now fix the first one","profile":"full","sessionId":"SESSION_ID"}'
```

</details>

<details>
<summary><b>Answer an AskUserQuestion</b></summary>

```bash
# After receiving: event: ask  data: {"toolUseId":"toolu_abc123","questions":[...]}
curl -X POST http://localhost:3457/api/run/answer \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"toolUseId":"toolu_abc123","answer":"PostgreSQL"}'
```

</details>

<details>
<summary><b>Directory management</b></summary>

```bash
# List directories
curl "http://localhost:3457/api/dirs?path=my-project" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Create directory
curl -X POST http://localhost:3457/api/dirs \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"","name":"my-new-project"}'
```

</details>

---

## Project structure

```
server.js                  Entry point -- proxy + dashboard servers, auth
src/
  proxy.js                 API forwarding, SSE passthrough, provider routing, per-session profiles
  sse-passthrough.js       Zero-copy SSE transform stream
  api.js                   REST API endpoints (POST /api/run, POST /api/run/answer)
  claude-session.js        Spawns claude -p with profile flags and session resume
  claude-sessions.js       Multi-tab session manager
  dashboard-ws.js          WebSocket server and broadcast hub
  capabilities.js          Profiles, models, providers, hooks, skills, agents CRUD
  store.js                 In-memory interaction store with disk persistence
  utils.js                 Central spawn function, process tracking, stream parsing
  providers/
    base.js                Provider adapter interface
    openai.js              OpenAI-compatible adapter (OpenAI, Gemini, DeepSeek, Moonshot, Ollama)
    registry.js            Provider registry
  mcp/
    index.js               MCP init, auto-start, tool probing, inspector logging
    servers.js             Tool CRUD, server.js/tool file generation
    registrar.js           Reads/writes .mcp.json and ~/.claude.json
lib/
  mcp-bridge.js            Stdio bridge Claude Code spawns via --mcp-config
public/
  index.html               Dashboard SPA
  home.js                  Home view documentation (4 tabs: overview, architecture, tools, API)
  core.js                  WebSocket, view switching, markdown rendering, process counter
  capabilities.js          Profile/model/tool/skill/agent/hook management UI
  inspector.js             Inspector timeline and detail panel
  chat.js                  Chat tab UI and session controls
  style.css                Layout and structural styles
  theme-bright.css         Bright theme (default)
  theme-dark.css           Dark theme (Tokyo Night)
capabilities/
  models.json              Pre-configured LLM provider models
  anthropic-pricing.json   Anthropic model pricing (auto-refreshable)
  secrets.json             API keys (gitignored)
  profiles/                Custom profile JSON files
mcp-servers/integrated/    Auto-generated MCP tool server + built-in tools
interactions/              Saved API call history (per-session directories)
outputs/                   Sandboxed working directory for Claude sessions
docs/
  architecture-*.svg       Architecture diagrams (light + dark theme)
```

---

## License

Business Source License 1.1 -- see [LICENSE](LICENSE). Copyright (c) 2026 [hpfreilabs.com](https://hpfreilabs.com)
