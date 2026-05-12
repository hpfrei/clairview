<div align="center">

<img src="public/favicon.svg" width="80" alt="vistaclair logo"/>

# vistaclair

**automate · inspect · access**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Turn your home PC into an AI-automated workstation you control from any browser.
Wraps [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with remote terminal sessions, real-time API inspection,
file management, and multi-provider model routing — so Claude can build, configure, and maintain your machine while you watch and steer from a phone, tablet, or laptop anywhere on the network.

[Getting started](#getting-started) ·
[Features](#features) ·
[Free vs Pro](#free-vs-pro) ·
[Architecture](#architecture) ·
[Contributing](CONTRIBUTING.md) ·
[Pro](https://hpfreilabs.com)

https://github.com/user-attachments/assets/b2bee30c-6d4b-42e7-9c2f-473453bb3350

</div>

---

## Use cases

| | |
|---|---|
| **Automate your home PC** | Point Claude at your machine and let it install packages, write configs, start services, and fix issues — all unattended or with you steering from a browser |
| **Remote access** | Run Claude Code on a powerful home machine and control it from a phone, tablet, or any browser — no SSH, no desktop environment needed |
| **Study the wire protocol** | See exactly what Claude Code sends and receives: system prompts, tool schemas, SSE events, token counts, costs |
| **Multi-provider routing** | Route Claude Code through OpenAI, Gemini, DeepSeek, Kimi, or local models via provider translation |
| **Tool development** | Create and test custom MCP tools from a form-driven editor without leaving the browser |
| **File management** | Browse, preview, and manage files on the remote machine with a full-featured file manager |

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
npm install -g vistaclair
```

Or clone the repository:

```bash
git clone https://github.com/hpfrei/vistaclair.git
cd vistaclair
npm install
```

> [!IMPORTANT]
> If cloning, always run `npm install` after cloning or pulling new changes to install dependencies.

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

### Unlocking full system access

By default, Claude Code sessions run under your user account. If your user can `sudo`, Claude can install packages, configure services, and set up entire environments — just make sure vistaclair runs under an account with sudo privileges:

```bash
npm start
```

With sudo access available, Claude can:

- Install system packages (`apt install`, `brew install`, `snap install`)
- Configure and start services (nginx, PostgreSQL, Docker, systemd units)
- Manage users, permissions, and SSH keys
- Set up development toolchains and language runtimes
- Modify system configuration files (`/etc/`, crontabs, environment)
- Build and deploy applications end-to-end

#### Recommended: use a VM

Running an AI agent with sudo is powerful but carries risk on your primary machine. A virtual machine gives you the best of both worlds -- full system access in an isolated sandbox:

```bash
# On a fresh Ubuntu VM:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude login   # authenticate once

# Clone and run vistaclair
git clone https://github.com/hpfrei/vistaclair.git
cd vistaclair && npm install
npm start
```

Then open `http://<vm-ip>:3457` from your host browser. You now have a remote, browser-controlled Claude with sudo access in a disposable environment.

> [!TIP]
> **Snapshot before, experiment freely.** Take a VM snapshot before starting. If Claude misconfigures something, roll back in seconds. This is the fastest way to iterate on complex system setups.

> [!TIP]
> **Headless servers and cloud VMs work great.** vistaclair's dashboard is fully browser-based -- no desktop environment needed. A $5/month VPS or a local QEMU/VirtualBox VM is all it takes.

#### What you can ask Claude to do

With sudo available, try things like:

- *"Set up a complete LAMP stack with PHP 8.3, MariaDB, and a sample WordPress site"*
- *"Install Docker, pull the postgres:16 image, create a database, and set up pgAdmin"*
- *"Configure nginx as a reverse proxy for three Node.js apps with SSL via Let's Encrypt"*
- *"Install and configure Tailscale so I can access this VM from anywhere"*
- *"Set up a Python 3.12 virtualenv, install PyTorch with CUDA support, and verify GPU access"*
- *"Create a systemd service that runs this Node.js app on boot with automatic restart"*

Claude handles the full loop -- installing dependencies, writing configs, starting services, verifying everything works, and fixing issues along the way.

---

## Features

### Inspector

A transparent proxy that captures every API call between Claude Code and the upstream LLM -- across all sessions, all providers, in real time. The primary debugging tool for understanding what Claude is doing and why.

- Full request/response capture with headers, payloads, and timing (TTFB + total duration)
- **System prompt viewer** -- see the full system prompt Claude receives, with character-count gauge
- **Message history viewer** -- expand every message in the conversation with role, content, and token contribution
- **Tool definition viewer** -- inspect every tool schema Claude has access to in each turn
- Live SSE event stream -- watch `message_start`, `content_block_delta`, tool calls as they arrive; raw SSE event log available per turn
- **Tool call inspector** -- view tool inputs (interactive JSON tree) and matched tool results, including error states
- **Thinking block display** -- see extended thinking / reasoning output inline
- Token usage breakdown: input, output, cache read, cache creation, reasoning tokens
- **Cost tracking** per interaction, per user-turn group, and session totals with color-coded gauges
- Live **markdown rendering** of assistant responses in the detail panel
- **cURL export** -- generate a ready-to-run `curl` command for any captured request (API key masked)
- **Subagent tracking** -- color-coded badges and parallel swimlane view showing which turns belong to which subagent
- **Hook call inspector** -- PreToolUse / PostToolUse hook events nested under the turn that triggered them, with full input/output
- Per-instance tab isolation with running/idle status indicators
- All interactions saved to disk as structured JSON for offline analysis, with full history reload

### CLI (Multi-tab Terminal)

Multi-tab Claude Code terminal sessions managed from the browser.

- **Multiple independent tabs**, each running a separate `claude` process
- Spawn sessions in any directory with the filesystem picker
- Per-session settings: model routing, working directory
- **Session save and resume** -- close a session and pick it up later with full context
- **AskUserQuestion** interception -- Claude's questions appear inline, answers are injected back transparently
- Directory-spawned tabs shown with distinct `>dirname` label and green accent
- Stop running sessions at any time
- Inline tab rename via double-click

### LLM Provider Adapters

Route Claude Code through non-Anthropic models. The proxy translates Anthropic Messages API requests into the target provider's format and translates responses back -- Claude Code sees a normal Anthropic API.

| Provider | Highlights | Notes |
|---|---|---|
| **Anthropic** | Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5 | Direct passthrough (no translation) |
| **OpenAI** | GPT-5.4, GPT-5.4 Mini / Nano, GPT-5, o3, o4-mini, gpt-4.1 | via `api.openai.com` |
| **Google Gemini** | Gemini 3.1 Pro, 3 Flash, 2.5 Flash / Flash Lite | 1M context, reasoning support |
| **DeepSeek** | V3.2, R1 Thinking, V4 Flash, V4 Pro | 128K context |
| **Moonshot (Kimi)** | K2.6, K2.5, K2 Thinking | 256K context |
| **Ollama** | Any local model | localhost base URL |

40+ models ship pre-configured (some disabled by default). The table above shows highlights — see `capabilities/models.json` for the full catalog.

Model definitions are configured in `capabilities/models.json`. API keys stored separately in `capabilities/secrets.json` (gitignored). Each model can specify system prompt handling (`replace` / `prepend` / `append` / `passthrough`), reasoning mode, context window, max output tokens, and cost per million tokens.

### Proxy Rules

Programmable request/response manipulation at the proxy layer. Rules are JavaScript functions that run on every API request before it reaches the upstream LLM -- they can inspect and modify the request body, block requests, or short-circuit responses.

- Toggle rules on/off from the dashboard Rules tab
- Rules are hot-reloaded on file change (no restart needed)
- Configured via `capabilities/proxy-rules.json` + JS files in `capabilities/proxy-rules/`

**Built-in rules:**

| Rule | Description |
|---|---|
| **Model Override** | Rewrites the model field on requests (e.g. `claude-opus-4-7` to `claude-opus-4-6`) -- lets you pin all Claude Code sessions to a specific model version |
| **Tool Filter** | Strips dangerous or unwanted tools from the request before they reach the LLM (e.g. `CronCreate`, `PushNotification`, remote triggers) |
| **AskUserQuestion MCP Rewrite** | Rewrites AskUserQuestion tool calls between the CLI and the MCP tool handler so questions route through the dashboard UI |
| **Title Schema Shortcut** | Short-circuits Claude Code's automatic title-generation requests with a dummy response, saving tokens on every new conversation (disabled by default) |

### MCP Tool Manager

Extend Claude Code with custom tools through one integrated MCP server.

- Form-driven tool editor with typed parameters (string, number, boolean, object, array)
- Auto-generated `server.js` and per-tool handler files -- you only write the handler body
- Enable/disable tools with checkboxes, restart indicator when changes need applying
- Inline testing with parameter inputs and result display
- All MCP tool calls logged in the Inspector

**Built-in MCP tools:**

| Tool | Default | Description |
|---|---|---|
| `vista-AskUserQuestion` | enabled | Routes AskUserQuestion forms through the dashboard UI so you can answer from any browser |
| `chat` | disabled | Run a prompt through Claude Code, supports multi-turn via `session_id`, profile and cwd selection |

The `chat` tool enables **delegation** -- a Claude session can spawn sub-conversations (e.g. an orchestrator using `chat` to delegate research tasks). Enable it from the MCP tool manager.

### Directories (File Manager)

Full-featured file browser with multi-tab support.

- Browse the remote filesystem with breadcrumb navigation and sort controls
- **Preview grid** -- toggle thumbnail previews for all files in a directory (images, text snippets, binary icons)
- **File overlay** -- click any file to open a full preview overlay with Monaco editor for code, native rendering for images/audio/video/PDF
- **Keyboard navigation** -- arrow keys to browse, left/right to navigate between files in the overlay, Escape to close
- **Multi-select and bulk delete** -- checkboxes fade in on hover, click to select, delete bar appears in the toolbar
- **Integrated shell** -- spawn a terminal in any directory's context
- File search with filename/content regex and date filters
- Download any file directly from the browser

### Skills, Agents, and Hooks

- **Skills** -- create and edit skills (`.claude/skills/<name>/SKILL.md`) with supporting template files
- **Agents** -- custom sub-agents with their own system prompts, models, and tool restrictions
- **Hooks** -- lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`, etc.) with command, prompt, or agent handlers

### Themes

Two built-in themes toggled from the header: **Bright** (checker-paper grid, default) and **Dark** (Tokyo Night palette).

---

## Free vs Pro

| Feature | Free | Pro |
|---------|:----:|:---:|
| API Inspector & cost tracking | ✓ | ✓ |
| Multi-session CLI terminal | ✓ | ✓ |
| LLM provider routing | ✓ | ✓ |
| MCP tool manager | ✓ | ✓ |
| File manager | ✓ | ✓ |
| Proxy rules engine | ✓ | ✓ |
| Model config & routing | ✓ | ✓ |
| Skills, agents, hooks | ✓ | ✓ |
| **Apps Platform** | — | ✓ |

[Get vistaclair Pro →](https://hpfreilabs.com)

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
| **Dashboard** | `:3457` | `0.0.0.0` | WebSocket + web UI (auth-protected) |

### Per-session isolation

Every `claude` process gets a unique instance ID baked into its base URL at spawn time:

```
ANTHROPIC_BASE_URL = http://localhost:3456/i/{instanceId}
```

This means each session's API traffic is tracked independently. Concurrent chats and API calls are fully isolated.

### Request flow

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/request-flow-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/request-flow-light.svg">
  <img alt="Request flow diagram" src="docs/request-flow-light.svg" width="880">
</picture>

### AskUserQuestion interception

When `claude` calls the `AskUserQuestion` tool during a session:

1. The proxy intercepts the tool call in the API response stream
2. When `claude` sends back the error `tool_result`, the proxy pauses the request
3. The proxy broadcasts `ask:question` to the dashboard UI
4. The UI renders the question with options and free text input
5. User answers, UI sends `ask:answer` back via WebSocket
6. Proxy rewrites the `tool_result` with the real answer and continues the API call
7. Claude resumes as if the tool succeeded normally

---

## Project structure

```
server.js                  Entry point -- proxy + dashboard servers, auth
src/
  proxy.js                 API forwarding, SSE passthrough, provider routing, per-session isolation
  proxy-rule-handler.js    Programmable proxy request/response rules
  sse-passthrough.js       Zero-copy SSE transform stream
  jsonl-watcher.js         Watches JSONL conversation files for real-time tool-call events
  api.js                   REST API endpoints (filesystem browsing, file serving, search, delete)
  ask-schema.js            AskUserQuestion schema definitions
  cli-session.js           Spawns claude with session settings and resume
  cli-sessions.js          Multi-tab session manager
  dashboard-ws.js          WebSocket server and broadcast hub
  capabilities.js          Models, providers, hooks, skills, agents CRUD
  store.js                 In-memory interaction store with disk persistence
  utils.js                 Central spawn function, process tracking, stream parsing
  providers/
    base.js                Provider adapter interface
    openai.js              OpenAI-compatible adapter (OpenAI, DeepSeek, Moonshot, Ollama)
    gemini.js              Google Gemini adapter (native REST API)
    registry.js            Provider registry
  mcp/
    index.js               MCP init, auto-start, tool probing, inspector logging
    servers.js             Tool CRUD, server.js/tool file generation
    templates.js           MCP server file templates
    logs.js                MCP call logging
    registrar.js           Reads/writes .mcp.json and ~/.claude.json
lib/
  mcp-bridge.js            Stdio bridge Claude Code spawns via --mcp-config
  hook-reporter.js         Hook event reporting bridge
public/
  index.html               Dashboard SPA
  login.html               Auth token login page
  home.js                  Home view documentation (overview, architecture, tools)
  core.js                  WebSocket, view switching, markdown rendering, process counter
  capabilities.js          Model/tool/skill/agent/hook management UI
  inspector.js             Inspector timeline and detail panel
  cli.js                   Multi-tab CLI session UI and settings
  directories.js           File manager -- browsing, previews, overlay, selection, shell
  rules.js                 Proxy rules editor UI
  mcp.js                   MCP tool manager UI
  mcp.css                  MCP-specific styles
  favicon.svg              App icon
  style.css                Layout and structural styles
  theme-bright.css         Bright theme (default)
  theme-dark.css           Dark theme (Tokyo Night)
  tools.html               Standalone MCP tool testing page
  landing_page/            Static landing page assets
capabilities/
  models.json              Pre-configured LLM provider models
  anthropic-pricing.json   Anthropic model pricing (auto-refreshable)
  proxy-rules.json         Proxy rule definitions
  secrets.json             API keys (gitignored)
mcp-servers/integrated/    Auto-generated MCP tool server + built-in tools
interactions/              Saved API call history (per-session directories)
docs/
  architecture-*.svg       Architecture diagrams (light + dark theme)
  request-flow-*.svg       Request flow diagrams (light + dark theme)
```

---

## License

**Apache 2.0** — see [LICENSE](LICENSE). Copyright 2026 [hpfreilabs.com](https://hpfreilabs.com)

Free to use, modify, and redistribute. Attribution required — derivative works must preserve the [NOTICE](NOTICE) file and copyright notices.

> **vistaclair Pro** — the Apps Platform and additional features — is a separately licensed commercial add-on. [Learn more →](https://hpfreilabs.com)
