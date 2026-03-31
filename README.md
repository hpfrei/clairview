# claude-doc

A browser-based dashboard for Claude Code. Inspect API traffic, run chat sessions remotely, build workflows, manage profiles, and route through multiple LLM providers.

## Use cases

- **Study the wire protocol** -- see exactly what Claude Code sends and receives: system prompts, tool schemas, SSE events, token counts
- **Remote access** -- run Claude Code on a powerful machine and control it from a phone, tablet, or any browser
- **Multi-provider experimentation** -- route Claude Code through OpenAI, Gemini, DeepSeek, or local models via provider adapters
- **Automated pipelines** -- chain multi-step workflows with branching, parallelism, and per-step profiles
- **Tool development** -- create and test custom MCP tools from a form-driven editor without leaving the browser

## Features

### Inspector

A transparent proxy that captures every API call between Claude Code and the upstream LLM.

- Full request/response capture with headers, payloads, and timing
- Live SSE event stream -- watch `message_start`, `content_block_delta`, tool calls as they arrive
- Hierarchical timeline: turns > tool calls, with search and filtering
- Token usage breakdown: input, output, cache read, cache creation
- Profile flags (bare mode, auto-memory) shown per request
- All interactions saved to disk as structured JSON for offline analysis

### Chat

Multi-tab browser-based Claude Code sessions with full conversation context.

- Send prompts, get streamed responses, answer interactive questions -- no terminal needed
- Multiple independent tabs, each with its own profile and working directory
- Session resume via `--resume` -- follow-up questions work naturally
- AskUserQuestion interception -- Claude's questions appear in the browser, answers are injected back transparently
- Live task panel -- `TaskCreate`/`TaskUpdate` tool calls rendered as a draggable status board
- Stop running sessions at any time

### Workflows

Define multi-step AI pipelines that execute as sequences of `claude -p` spawns.

- **Generate** -- describe a workflow in natural language, get a structured `workflow.json`
- **Edit** -- modify steps, inputs, profiles, conditions, and flow in the browser
- **Compile** -- transforms the definition into an optimized `compiled.js` module with prompt builders and output parsers
- **Run** -- each step spawns a fresh `claude -p` process, streamed to the Runs tab
- **Flow control** -- conditional branching (`then`/`else`), parallel fan-out, joins, retries, timeouts, error handlers
- **Per-step profiles** -- different model/effort/permissions per step
- **Context chaining** -- pipe previous step outputs into downstream prompts via `context` references
- Run history saved to `capabilities/workflows/<name>/runs/`

### Profiles

Named capability bundles that control how `claude -p` is spawned.

| Setting | CLI flag | Description |
|---|---|---|
| Model | `--model` | sonnet, opus, haiku, or custom model ID |
| Effort | `--effort` | low, medium, high, max |
| Permission mode | `--permission-mode` | default, acceptEdits, plan, bypassPermissions, dontAsk, auto |
| Allowed/disabled tools | `--allowedTools` / `--disallowedTools` | Per-tool enable/disable via checkboxes |
| Bare mode | `--bare` | Strip skills and MCP servers |
| Disable auto-memory | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | Prevent auto-memory writes |
| Slash commands | `--disable-slash-commands` | Enable/disable built-in skills |
| Max turns | `--max-turns` | Cap agentic loop iterations |
| Budget | `--max-budget-usd` | Dollar spend limit per run |
| System prompt | `--append-system-prompt` / `--system-prompt` | Append to or replace the default system prompt |
| MCP servers | `--mcp-config` | Integrated server with custom tools |

Four built-in profiles: **Full** (all tools, bypass permissions), **Safe** (no writes or shell), **Read-only**, **Minimal**. Duplicate to create editable custom profiles.

### LLM Provider Adapters

Route Claude Code through non-Anthropic models. The proxy translates Anthropic Messages API requests into the target provider's format and translates responses back -- Claude Code sees a normal Anthropic API.

**Supported providers** (all via OpenAI-compatible adapter):

| Provider | Models | Notes |
|---|---|---|
| **OpenAI** | GPT-5.4, GPT-5.4 Pro/Mini/Nano | via `api.openai.com` |
| **Google Gemini** | Gemini 3.1 Pro, 3 Flash, 2.5 Flash | OpenAI-compatible endpoint, reasoning support |
| **DeepSeek** | V3.2, R1 Thinking | 128K context |
| **Moonshot (Kimi)** | K2.5, K2 Thinking | 256K context |
| **Ollama** | Any local model | localhost base URL |

Model definitions are configured in `capabilities/models.json`. API keys stored separately in `capabilities/secrets.json`. Each model can specify system prompt handling (replace/prepend/append/passthrough), reasoning mode, context window, and max output tokens.

### MCP Tool Manager

Extend Claude Code with custom tools through one integrated MCP server.

- Form-driven tool editor with typed parameters (string, number, boolean, object, array)
- Auto-generated `server.js` and per-tool files -- you only write the handler body
- Enable/disable tools with checkboxes, restart indicator when changes need applying
- Inline testing with parameter inputs and result display
- All MCP tool calls logged in the Inspector

### Skills, Agents, and Hooks

- **Skills** -- create and edit skills (`.claude/skills/<name>/SKILL.md`) with supporting template files
- **Agents** -- custom sub-agents with their own system prompts, models, and tool restrictions
- **Hooks** -- lifecycle hooks (PreToolUse, PostToolUse, Stop, etc.) with command, prompt, or agent handlers

### Themes

Two built-in themes toggled from the header: **Bright** (checker-paper grid, default) and **Dark** (Tokyo Night).

## Setup

### Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

### Install

```bash
git clone https://github.com/hpfrei/claude-doc.git
cd claude-doc
npm install
```

Run `claude` once manually to authenticate if you haven't already:

```bash
claude
```

### Run

```bash
npm start
```

On startup, an auth token is printed to the console:

```
Auth token (auto-generated):
c0b253eb-c650-4def-ba2c-4b2b1b545d85
```

Open `http://localhost:3457` and log in with the token.

To use a custom port:

```bash
npm start -- 8080          # or: DASHBOARD_PORT=8080 npm start
```

To inspect an external Claude Code session, point it at the proxy:

```bash
ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "your prompt"
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_TOKEN` | auto-generated | Dashboard auth token |
| `PROXY_PORT` | `3456` | API proxy port (localhost only) |
| `DASHBOARD_PORT` | `3457` | Web dashboard port (all interfaces) |
| `ANTHROPIC_TARGET_URL` | `https://api.anthropic.com` | Upstream API URL |
| `MAX_HISTORY` | `200` | Max interactions kept in memory |

> The dashboard binds to `0.0.0.0` for remote access. It is protected by the auth token, but do not expose it to untrusted networks without TLS/VPN.

## How it works

```
                          +---------------------------+
                          |    claude-doc server       |
Browser -- WebSocket -->  |                           |
(:3457)                   |  proxy :3456  (SSE pass)  |--- HTTP/SSE -->  Anthropic API
                          |  dashboard :3457  (WS)    |                  (or provider adapter)
                          +---------+---------+-------+
                                    |         |
                         +----------+         +----------+
                         |                               |
                   Built-in claude -p              External claude -p
                  (spawned, --resume)             (your terminal)
```

The proxy is fully transparent with zero latency overhead. Raw SSE bytes flow to Claude Code unmodified while parsed events are tapped off to the dashboard over WebSocket.

When using a provider adapter, requests are translated to the target provider's format on the fly, and responses are translated back to Anthropic's SSE format before reaching Claude Code.

## Project structure

```
server.js                Entry point -- proxy + dashboard servers, auth
src/
  proxy.js               API forwarding, SSE passthrough, provider routing
  sse-passthrough.js     Zero-copy SSE transform stream
  claude-session.js      Spawns claude -p with profile flags and session resume
  claude-sessions.js     Multi-tab session manager
  dashboard-ws.js        WebSocket server and broadcast hub
  capabilities.js        Profiles, models, providers, hooks, skills, agents CRUD
  workflows.js           Workflow CRUD + runtime engine (generate, compile, execute)
  workflow-handler.js    WebSocket handler for workflow operations
  store.js               In-memory interaction store with disk persistence
  utils.js               Shared spawn utilities, stream parsing, output sandboxing
  providers/
    base.js              Provider adapter interface
    openai.js            OpenAI-compatible adapter (OpenAI, Gemini, DeepSeek, Moonshot, Ollama)
    registry.js          Provider registry
  mcp/
    index.js             MCP init, auto-start, tool probing, inspector logging
    servers.js           Tool CRUD, server.js/tool file generation
    registrar.js         Reads/writes .mcp.json and ~/.claude.json
lib/
  mcp-bridge.js          Stdio bridge Claude Code spawns via --mcp-config
public/
  index.html             Dashboard SPA (Inspector, Chat, Capabilities, Workflows, Runs)
  capabilities.js        Profile/model/tool management UI
  inspector.js           Inspector timeline and detail panel
  chat.js                Chat tab UI and session controls
  workflows.js           Workflow editor and generator UI
  style.css              Layout and structural styles
  theme-bright.css       Bright theme (default)
  theme-dark.css         Dark theme (Tokyo Night)
capabilities/
  models.json            Pre-configured LLM provider models
  secrets.json           API keys (gitignored)
  profiles/              Custom profile JSON files
  workflows/             Workflow definitions, compiled modules, run history
mcp-servers/integrated/  Auto-generated MCP tool server
interactions/            Saved API call history (per-session directories)
outputs/                 Sandboxed working directory for Claude sessions
```

## License

MIT -- see [LICENSE](LICENSE). Copyright (c) 2026 hpfreilabs.com
