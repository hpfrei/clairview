// ============================================================
// HOME VIEW — Overview, proxy, MCP, API docs
// ============================================================
(function homeModule() {
  'use strict';
  const { renderMarkdown } = window.dashboard;

  // --- Sub-tab switching ---
  document.getElementById('homeNav')?.addEventListener('click', e => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    const section = btn.dataset.section;
    document.getElementById('homeNav').querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.home-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('home-' + section);
    if (target) target.classList.add('active');
  });

  // --- Content ---

  const overviewMd = `
# vistaclair

A browser dashboard that **wraps Claude Code CLI**. It proxies all API traffic, giving you real-time inspection, multi-provider routing, custom tools, and interactive prompts — all from any browser. Set up a tunnel and you can control your development machine from anywhere: phone, tablet, another PC.

\`\`\`svg
<svg viewBox="0 0 780 270" xmlns="http://www.w3.org/2000/svg" style="max-width:780px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="ov1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- You -->
  <rect x="15" y="55" width="120" height="95" rx="10" fill="none" stroke="var(--accent)" stroke-width="2"/>
  <text x="75" y="82" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="600">Any browser</text>
  <text x="75" y="100" text-anchor="middle" fill="var(--text-dim)" font-size="10">laptop · phone · tablet</text>
  <text x="75" y="134" text-anchor="middle" fill="var(--text-dim)" font-size="9">or REST API client</text>

  <!-- Tunnel arrow -->
  <line x1="135" y1="100" x2="248" y2="100" stroke="var(--text-dim)" stroke-width="1.5" stroke-dasharray="8,4" marker-end="url(#ov1)"/>
  <text x="192" y="90" text-anchor="middle" fill="var(--text-dim)" font-size="9">tunnel / VPN / LAN</text>

  <!-- vistaclair server -->
  <rect x="250" y="15" width="260" height="180" rx="10" fill="none" stroke="var(--green)" stroke-width="2.5"/>
  <text x="380" y="42" text-anchor="middle" fill="var(--green)" font-size="15" font-weight="700">vistaclair</text>
  <text x="380" y="60" text-anchor="middle" fill="var(--text-dim)" font-size="10">wraps Claude Code on your PC</text>

  <rect x="262" y="72" width="115" height="28" rx="5" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <text x="319" y="90" text-anchor="middle" fill="var(--text)" font-size="10">Inspector</text>

  <rect x="385" y="72" width="115" height="28" rx="5" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <text x="442" y="90" text-anchor="middle" fill="var(--text)" font-size="10">Chat tabs</text>

  <rect x="262" y="108" width="115" height="28" rx="5" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <text x="319" y="126" text-anchor="middle" fill="var(--text)" font-size="10">CLI · Directories</text>

  <rect x="385" y="108" width="115" height="28" rx="5" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <text x="442" y="126" text-anchor="middle" fill="var(--text)" font-size="10">MCP · Rules</text>

  <text x="380" y="182" text-anchor="middle" fill="var(--text-dim)" font-size="9">dashboard :3457  ·  proxy :3456</text>

  <!-- Claude processes -->
  <rect x="270" y="210" width="100" height="35" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="320" y="232" text-anchor="middle" fill="var(--text)" font-size="10">claude -p</text>

  <rect x="390" y="210" width="100" height="35" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="440" y="232" text-anchor="middle" fill="var(--text)" font-size="10">claude -p</text>

  <line x1="340" y1="195" x2="320" y2="210" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ov1)"/>
  <line x1="420" y1="195" x2="440" y2="210" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ov1)"/>

  <!-- Arrows to APIs -->
  <line x1="510" y1="70" x2="588" y2="58" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ov1)"/>
  <line x1="510" y1="110" x2="588" y2="115" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ov1)"/>
  <text x="550" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="8">direct</text>
  <text x="550" y="107" text-anchor="middle" fill="var(--text-dim)" font-size="8">translated</text>

  <!-- LLM APIs -->
  <rect x="590" y="38" width="170" height="35" rx="6" fill="none" stroke="var(--purple)" stroke-width="2"/>
  <text x="675" y="60" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Anthropic API</text>

  <rect x="590" y="93" width="170" height="45" rx="6" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
  <text x="675" y="113" text-anchor="middle" fill="var(--text-dim)" font-size="10">OpenAI · Gemini</text>
  <text x="675" y="128" text-anchor="middle" fill="var(--text-dim)" font-size="10">DeepSeek · Ollama · ...</text>

  <!-- AskUserQuestion -->
  <rect x="80" y="230" width="160" height="30" rx="6" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1.5" stroke-dasharray="4"/>
  <text x="160" y="250" text-anchor="middle" fill="var(--text)" font-size="10">AskUserQuestion</text>
  <line x1="270" y1="240" x2="240" y2="245" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ov1)"/>
  <line x1="80" y1="240" x2="75" y2="150" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ov1)"/>
  <text x="50" y="200" fill="var(--text-dim)" font-size="8">shown</text>
  <text x="50" y="210" fill="var(--text-dim)" font-size="8">in UI</text>
</svg>
\`\`\`

---

## Debug Claude Code in real time

The **Inspector** records every API call between Claude Code and the LLM. See request bodies, response streams, tool calls, token usage, cost, and timing — across all sessions and providers. When something goes wrong, you see exactly what happened.

\`\`\`svg
<svg viewBox="0 0 680 175" xmlns="http://www.w3.org/2000/svg" style="max-width:680px;font-family:system-ui,sans-serif">
  <!-- Timeline -->
  <line x1="40" y1="15" x2="40" y2="160" stroke="var(--text-dim)" stroke-width="1.5" opacity="0.4"/>

  <!-- Event 1: API call -->
  <circle cx="40" cy="28" r="6" fill="var(--green)" opacity="0.9"/>
  <rect x="60" y="14" width="600" height="28" rx="5" fill="none" stroke="var(--green)" stroke-width="1"/>
  <text x="72" y="33" fill="var(--text)" font-size="11" font-weight="500">POST /v1/messages</text>
  <text x="310" y="33" fill="var(--text-dim)" font-size="10">claude-sonnet-4-5-20250514</text>
  <text x="540" y="33" fill="var(--text-dim)" font-size="10">12.4k tok · $0.042 · 2.3s</text>

  <!-- Event 2: Tool use -->
  <circle cx="40" cy="64" r="6" fill="var(--purple)" opacity="0.9"/>
  <rect x="60" y="50" width="600" height="28" rx="5" fill="none" stroke="var(--purple)" stroke-width="1"/>
  <text x="72" y="69" fill="var(--text)" font-size="11" font-weight="500">tool_use: Edit</text>
  <text x="310" y="69" fill="var(--text-dim)" font-size="10">src/auth.js — 3 lines changed</text>
  <text x="540" y="69" fill="var(--green)" font-size="10">success</text>

  <!-- Event 3: Another API call -->
  <circle cx="40" cy="100" r="6" fill="var(--green)" opacity="0.9"/>
  <rect x="60" y="86" width="600" height="28" rx="5" fill="none" stroke="var(--green)" stroke-width="1"/>
  <text x="72" y="105" fill="var(--text)" font-size="11" font-weight="500">POST /v1/messages</text>
  <text x="310" y="105" fill="var(--text-dim)" font-size="10">claude-sonnet-4-5-20250514</text>
  <text x="540" y="105" fill="var(--text-dim)" font-size="10">8.1k tok · $0.028 · 1.8s</text>

  <!-- Event 4: AskUserQuestion -->
  <circle cx="40" cy="136" r="6" fill="var(--yellow,#fa0)" opacity="0.9"/>
  <rect x="60" y="122" width="600" height="28" rx="5" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="4"/>
  <text x="72" y="141" fill="var(--text)" font-size="11" font-weight="500">AskUserQuestion</text>
  <text x="310" y="141" fill="var(--text-dim)" font-size="10">"Which database should I use?"</text>
  <text x="540" y="141" fill="var(--yellow,#fa0)" font-size="10">waiting for answer…</text>

  <!-- Legend -->
  <text x="40" y="170" fill="var(--text-dim)" font-size="9">Every event is clickable — expand to see full request/response payloads, headers, and streaming chunks</text>
</svg>
\`\`\`

---

## Proxy rules and MCP tools — made from a prompt

Describe a rule in plain English in the **Rules** tab — vistaclair generates JavaScript middleware that intercepts every API call flowing through the proxy. Block tools, swap models, inject system prompts, or transform requests. Rules are hot-reloaded and toggleable.

**MCP tools** work similarly: define parameters and write a handler in the **MCP** tab. Claude gets the new capability instantly — no server restart, no config files.

\`\`\`svg
<svg viewBox="0 0 700 110" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="ov2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- Prompt -->
  <rect x="10" y="15" width="200" height="65" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="110" y="38" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">"Block rm, sudo, and</text>
  <text x="110" y="53" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500"> any destructive tools"</text>
  <text x="110" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="9">your prompt in natural language</text>

  <!-- Arrow -->
  <line x1="210" y1="48" x2="278" y2="48" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ov2)"/>
  <text x="244" y="40" text-anchor="middle" fill="var(--text-dim)" font-size="8">generates</text>

  <!-- Generated rule -->
  <rect x="280" y="10" width="190" height="75" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="375" y="34" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">Proxy Rule</text>
  <text x="375" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="9">JavaScript middleware</text>
  <text x="375" y="66" text-anchor="middle" fill="var(--text-dim)" font-size="9">hot-reloaded · toggleable</text>

  <!-- Arrow -->
  <line x1="470" y1="48" x2="518" y2="48" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ov2)"/>
  <text x="494" y="40" text-anchor="middle" fill="var(--text-dim)" font-size="8">applied to</text>

  <!-- Proxy -->
  <rect x="520" y="18" width="160" height="60" rx="8" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
  <text x="600" y="42" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="500">Proxy :3456</text>
  <text x="600" y="58" text-anchor="middle" fill="var(--text-dim)" font-size="9">intercepts every API call</text>

  <!-- Bottom note -->
  <text x="350" y="105" text-anchor="middle" fill="var(--text-dim)" font-size="9">Same flow for MCP tools: describe parameters → write handler → Claude gets the capability</text>
</svg>
\`\`\`

---

## What you can do

- **Work remotely** — set up a tunnel (cloudflared, ngrok, bore) and control your home dev machine from any browser. Your codebase stays on your machine; you just control it remotely.
- **Run multiple sessions** — open several chat tabs, each with its own working directory and model mapping. Let one refactor auth while another writes tests.
- **Switch models** — route Claude Code through OpenAI, Gemini, DeepSeek, Kimi, or local Ollama with a dropdown change. Automatic protocol translation.
- **Use the CLI terminal** — the **CLIs** tab is a full Claude Code terminal running on your server. Start sessions, run commands — no local install needed on the client.
- **Manage directories** — the **Directories** tab lets you browse, create, and switch between project folders. Each chat session gets its own sandboxed working directory.
- **AskUserQuestion** — when Claude Code needs input mid-task, the question appears in your browser. Answer it and Claude continues. Works across all sessions.
- **REST API** — \`POST /api/run\` to start chats programmatically and stream results via SSE. Build automations on top.

## Quick start

1. \`git clone https://github.com/hpfrei/vistaclair.git && cd vistaclair\`
2. \`npm install\`
3. \`npm start\` — open **localhost:3457**

### Remote access via tunnel

Expose vistaclair through a tunnel and access it from any device. The auth token protects access; the proxy (:3456) stays localhost-only.

\`\`\`bash
# Pick one:
cloudflared tunnel --url http://localhost:3457
npx bore local 3457 --to bore.pub
ssh -R 80:localhost:3457 serveo.net
\`\`\`
`;

  const proxyMd = `
# Proxy

The transparent proxy sits between Claude Code and the LLM. Every API call flows through it — recorded for the Inspector, routed to the right provider, with AskUserQuestion intercepted along the way. This is the core of vistaclair.

## Server components

vistaclair runs two servers from a single Node.js process:

| Component | Port | Purpose |
|-----------|------|---------|
| **Proxy** | \`:3456\` (localhost only) | Intercepts all Claude API calls for inspection and model routing. Intercepts AskUserQuestion tool calls. |
| **Dashboard** | \`:3457\` (all interfaces) | WebSocket server for real-time UI updates, REST API, serves the web UI. Auth-protected. |

Internal services (no separate port):

| Component | Purpose |
|-----------|---------|
| **Session Manager** | One \`claude -p\` process per chat tab, with independent cwd and model mapping. Sessions persist across browser reconnects. |
| **MCP Server** | Integrated tool server auto-registered with every \`claude -p\` process. Custom tools + built-in chat tools. |
| **Cost Tracker** | Records token usage and cost per interaction, per model, per provider. Visible in the Inspector. |

## Per-session model routing

Every \`claude -p\` process gets its instance ID baked into its base URL at spawn time:

\`\`\`
ANTHROPIC_BASE_URL = http://localhost:3456/i/{instanceId}
\`\`\`

Each session has a \`modelMap\` that maps Claude tiers (\`opus\`, \`sonnet\`, \`haiku\`) to specific models from any provider. A \`null\` entry means forward to Anthropic as-is. The instance ID is **immutable for the process lifetime** — changing model settings in one tab never affects another.

\`\`\`svg
<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" style="max-width:760px;font-family:system-ui,sans-serif">
  <defs><marker id="px1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Claude process 1 -->
  <rect x="10" y="30" width="130" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="75" y="52" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="75" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="9">instance: cli-tab-1</text>

  <!-- Proxy -->
  <rect x="210" y="15" width="190" height="80" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="305" y="38" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Proxy :3456</text>
  <text x="305" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">extracts instance ID from URL</text>
  <text x="305" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="9">looks up session modelMap</text>
  <text x="305" y="81" text-anchor="middle" fill="var(--text-dim)" font-size="9">records for inspector</text>

  <!-- Third-party -->
  <rect x="500" y="15" width="150" height="40" rx="6" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
  <text x="575" y="40" text-anchor="middle" fill="var(--text)" font-size="11">Gemini / OpenAI / ...</text>
  <line x1="400" y1="40" x2="500" y2="35" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#px1)"/>
  <text x="450" y="28" text-anchor="middle" fill="var(--text-dim)" font-size="8">translate request</text>

  <!-- Anthropic -->
  <rect x="500" y="65" width="150" height="40" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="575" y="90" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Anthropic API</text>
  <line x1="400" y1="70" x2="500" y2="80" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#px1)"/>
  <text x="450" y="82" text-anchor="middle" fill="var(--text-dim)" font-size="8">forward as-is</text>

  <!-- Arrow -->
  <line x1="140" y1="55" x2="210" y2="55" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#px1)"/>
  <text x="175" y="48" text-anchor="middle" fill="var(--green)" font-size="7">/i/cli-tab-1/v1/messages</text>

  <!-- Decision -->
  <text x="305" y="120" text-anchor="middle" fill="var(--text-dim)" font-size="10">modelMap has entry?  yes → translate to provider   |   no → forward to Anthropic</text>

  <!-- Second example -->
  <rect x="10" y="155" width="130" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="75" y="177" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="75" y="193" text-anchor="middle" fill="var(--text-dim)" font-size="9">instance: cli-tab-2</text>

  <rect x="210" y="150" width="190" height="60" rx="8" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="305" y="175" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Proxy :3456</text>
  <text x="305" y="192" text-anchor="middle" fill="var(--text-dim)" font-size="9">modelMap: all null</text>

  <rect x="500" y="155" width="150" height="40" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="575" y="180" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Anthropic API</text>

  <line x1="140" y1="180" x2="210" y2="180" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#px1)"/>
  <text x="175" y="173" text-anchor="middle" fill="var(--green)" font-size="7">/i/cli-tab-2/v1/messages</text>
  <line x1="400" y1="175" x2="500" y2="175" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#px1)"/>
  <text x="450" y="168" text-anchor="middle" fill="var(--text-dim)" font-size="8">forward as-is</text>

  <!-- Isolation note -->
  <rect x="120" y="235" width="520" height="30" rx="6" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="4"/>
  <text x="380" y="255" text-anchor="middle" fill="var(--text-dim)" font-size="10">Both sessions run concurrently. Each has its own modelMap — changing settings in one never affects the other.</text>
</svg>
\`\`\`

## How a chat message flows

1. You type a message in the **Chat tab** and click Send
2. The **Dashboard** receives it over WebSocket and spawns \`claude -p\` with \`ANTHROPIC_BASE_URL=http://localhost:3456/i/{instanceId}\`
3. \`claude -p\` sends API requests to the proxy (thinking it's talking to Anthropic)
4. The **Proxy** intercepts the request, looks up the session's \`modelMap\`, and either:
   - **Forwards** to the real Anthropic API (if no mapping for the requested model tier), or
   - **Translates** to the target provider's format (OpenAI, Gemini, etc.) and sends it there
5. The response streams back through the proxy (which records it for the Inspector)
6. \`claude -p\` streams text to stdout, which the Dashboard broadcasts over WebSocket to the browser

## How AskUserQuestion works

When \`claude -p\` calls the \`AskUserQuestion\` tool during a chat session:

\`\`\`svg
<svg viewBox="0 0 700 160" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="px2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker>
  <marker id="px3" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--yellow,#fa0)"/></marker></defs>

  <!-- Claude -->
  <rect x="10" y="30" width="100" height="45" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="60" y="50" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">claude -p</text>
  <text x="60" y="65" text-anchor="middle" fill="var(--text-dim)" font-size="8">calls AUQ</text>

  <line x1="110" y1="52" x2="178" y2="52" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#px2)"/>

  <!-- Proxy -->
  <rect x="180" y="20" width="150" height="65" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="255" y="42" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Proxy</text>
  <text x="255" y="58" text-anchor="middle" fill="var(--text-dim)" font-size="9">intercepts tool call</text>
  <text x="255" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="9">pauses request</text>

  <line x1="330" y1="52" x2="398" y2="52" stroke="var(--yellow,#fa0)" stroke-width="1.5" stroke-dasharray="4" marker-end="url(#px3)"/>

  <!-- Browser -->
  <rect x="400" y="25" width="130" height="55" rx="8" fill="none" stroke="var(--yellow,#fa0)" stroke-width="2"/>
  <text x="465" y="48" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="600">Browser UI</text>
  <text x="465" y="64" text-anchor="middle" fill="var(--text-dim)" font-size="9">shows question</text>

  <!-- Answer arrow back -->
  <path d="M465 80 Q465 120, 255 120 Q180 120, 60 90" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="4" marker-end="url(#px2)"/>
  <text x="300" y="115" text-anchor="middle" fill="var(--green)" font-size="9">user answers → proxy rewrites → claude resumes</text>

  <!-- Labels -->
  <text x="350" y="150" text-anchor="middle" fill="var(--text-dim)" font-size="9">Claude continues as if the tool succeeded normally. Works with both browser and REST API sessions.</text>
</svg>
\`\`\`

## Proxy rules

Rules are AI-generated middleware that intercept every request flowing through the proxy. Describe what you want in plain English in the **Rules** tab — vistaclair generates JavaScript that runs before model routing.

\`\`\`svg
<svg viewBox="0 0 680 90" xmlns="http://www.w3.org/2000/svg" style="max-width:680px;font-family:system-ui,sans-serif">
  <defs><marker id="px4" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <!-- Pipeline -->
  <rect x="10" y="20" width="100" height="40" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="60" y="44" text-anchor="middle" fill="var(--text)" font-size="10">API request</text>

  <line x1="110" y1="40" x2="138" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#px4)"/>

  <rect x="140" y="15" width="110" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="195" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 1</text>
  <text x="195" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">block tools</text>

  <line x1="250" y1="40" x2="278" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#px4)"/>

  <rect x="280" y="15" width="110" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="335" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 2</text>
  <text x="335" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">swap model</text>

  <line x1="390" y1="40" x2="418" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#px4)"/>

  <rect x="420" y="15" width="110" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="475" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 3</text>
  <text x="475" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">inject prompt</text>

  <line x1="530" y1="40" x2="558" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#px4)"/>

  <rect x="560" y="20" width="100" height="40" rx="6" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="610" y="44" text-anchor="middle" fill="var(--green)" font-size="10" font-weight="500">Provider</text>

  <text x="340" y="82" text-anchor="middle" fill="var(--text-dim)" font-size="9">Rules run in order, hot-reloaded. Toggle on/off or drag to reorder in the Rules tab.</text>
</svg>
\`\`\`

`;

  const mcpMd = `
# MCP Tools

Custom tools extend what Claude can do. You write a JavaScript handler in the browser, and Claude can call it like any built-in tool during chat sessions. No server restart needed — changes are picked up instantly.

\`\`\`svg
<svg viewBox="0 0 700 200" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="mc1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Claude process -->
  <rect x="10" y="50" width="120" height="55" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="70" y="74" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="70" y="92" text-anchor="middle" fill="var(--text-dim)" font-size="9">any session</text>

  <!-- MCP Server -->
  <rect x="210" y="20" width="180" height="120" rx="8" fill="none" stroke="var(--purple)" stroke-width="2"/>
  <text x="300" y="46" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">MCP Server</text>
  <text x="300" y="64" text-anchor="middle" fill="var(--text-dim)" font-size="9">auto-registered with claude -p</text>
  <text x="300" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="9">stdio transport (JSON-RPC)</text>
  <text x="300" y="92" text-anchor="middle" fill="var(--text-dim)" font-size="9">Zod schema validation</text>
  <text x="300" y="106" text-anchor="middle" fill="var(--text-dim)" font-size="9">connectable by external clients</text>

  <!-- Custom handler -->
  <rect x="470" y="15" width="170" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="555" y="36" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Custom handlers</text>
  <text x="555" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="9">your JavaScript code</text>

  <!-- Built-in tools -->
  <rect x="470" y="75" width="170" height="50" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="555" y="96" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Built-in tools</text>
  <text x="555" y="112" text-anchor="middle" fill="var(--text-dim)" font-size="9">chat (delegation)</text>

  <!-- Arrows -->
  <line x1="130" y1="78" x2="210" y2="78" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#mc1)"/>
  <text x="170" y="70" text-anchor="middle" fill="var(--text-dim)" font-size="8">tool_use</text>
  <line x1="390" y1="45" x2="470" y2="40" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#mc1)"/>
  <line x1="390" y1="90" x2="470" y2="97" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#mc1)"/>

  <!-- Notes -->
  <text x="350" y="170" text-anchor="middle" fill="var(--text-dim)" font-size="10">Tools are defined in MCP tab. External MCP clients can connect via stdio bridge.</text>
  <text x="350" y="188" text-anchor="middle" fill="var(--text-dim)" font-size="10">Tool calls appear in the Inspector alongside all other API events.</text>
</svg>
\`\`\`

## How it works

1. Tools are defined in the **MCP** tab. Each tool has a name, description, typed parameters (Zod schemas), and a handler body.
2. The integrated MCP server registers itself with every \`claude -p\` process automatically at startup.
3. When Claude decides to call your tool, the MCP server validates the input against the schema and executes the handler.
4. The handler returns a result (text, images, or errors) and Claude continues with the response.

## Built-in tools

| Tool | Purpose |
|------|---------|
| \`chat\` | Run a prompt through Claude Code via the dashboard. Supports multi-turn via \`session_id\`. Can specify \`cwd\`. |

The \`chat\` tool is useful for delegation — a Claude session can spawn sub-conversations with different working directories (e.g. an orchestrator using \`chat\` to delegate research to a sub-session).

## Writing a tool handler

The handler is an async function that receives the validated parameters and must return MCP content:

\`\`\`javascript
// Example: a tool that fetches a URL and returns the text
const response = await fetch(url);
const text = await response.text();
return {
  content: [{ type: "text", text }]
};
\`\`\`

Handlers have access to:
- All Node.js built-in modules (via dynamic \`import()\`)
- The dashboard WebSocket for integration with the live UI
- Environment variables from the server process

## Connecting external clients

The integrated MCP server uses **stdio transport**, so any MCP-compatible client can connect by spawning the bridge process.

When vistaclair starts, it writes a \`.mcp.json\` file with the correct connection details:

\`\`\`json
{
  "mcpServers": {
    "integrated": {
      "command": "node",
      "args": ["/path/to/claude-doc/lib/mcp-bridge.js", "integrated"],
      "env": {
        "VISTACLAIR_AUTH_TOKEN": "<token>",
        "VISTACLAIR_DASHBOARD_PORT": "3457"
      }
    }
  }
}
\`\`\`

Or spawn manually:

\`\`\`bash
VISTACLAIR_AUTH_TOKEN="<token>" VISTACLAIR_DASHBOARD_PORT=3457 \\
  node /path/to/claude-doc/lib/mcp-bridge.js integrated
\`\`\`

Connected clients have access to all tools — custom and built-in. Tool calls from external clients appear in the Inspector.
`;

  const apiMd = `
# REST API

vistaclair exposes a REST API on the dashboard port (\`:3457\`) for programmatic access. All endpoints require authentication via cookie (\`token=<TOKEN>\`), header (\`Authorization: Bearer <TOKEN>\`), or the internal header (\`X-Vistaclair-Internal: true\` from localhost).

\`\`\`svg
<svg viewBox="0 0 700 175" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="ap1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Client -->
  <rect x="10" y="40" width="130" height="65" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="75" y="64" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Your script</text>
  <text x="75" y="80" text-anchor="middle" fill="var(--text-dim)" font-size="9">curl / fetch / SDK</text>
  <text x="75" y="94" text-anchor="middle" fill="var(--text-dim)" font-size="9">POST /api/run</text>

  <!-- Dashboard -->
  <rect x="220" y="30" width="180" height="85" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="310" y="55" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Dashboard :3457</text>
  <text x="310" y="73" text-anchor="middle" fill="var(--text-dim)" font-size="9">validates auth + params</text>
  <text x="310" y="87" text-anchor="middle" fill="var(--text-dim)" font-size="9">spawns claude -p</text>
  <text x="310" y="101" text-anchor="middle" fill="var(--text-dim)" font-size="9">streams SSE events back</text>

  <!-- Claude -->
  <rect x="480" y="45" width="120" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="540" y="68" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="540" y="84" text-anchor="middle" fill="var(--text-dim)" font-size="9">with instance URL</text>

  <!-- Arrows -->
  <line x1="140" y1="72" x2="220" y2="72" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ap1)"/>
  <text x="180" y="65" text-anchor="middle" fill="var(--text-dim)" font-size="8">JSON body</text>
  <line x1="400" y1="68" x2="480" y2="68" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ap1)"/>
  <text x="440" y="62" text-anchor="middle" fill="var(--text-dim)" font-size="8">spawn</text>

  <!-- SSE arrow back -->
  <line x1="220" y1="95" x2="140" y2="95" stroke="var(--accent)" stroke-width="1" marker-end="url(#ap1)"/>
  <text x="180" y="108" text-anchor="middle" fill="var(--accent)" font-size="8">SSE stream</text>

  <!-- Note -->
  <text x="350" y="145" text-anchor="middle" fill="var(--text-dim)" font-size="10">Instance-scoped routing applies: API calls get the same per-session model mapping as browser chats</text>
  <text x="350" y="163" text-anchor="middle" fill="var(--text-dim)" font-size="10">All events visible in Inspector alongside browser sessions</text>
</svg>
\`\`\`

---

## POST /api/run

Start a chat. Returns a **Server-Sent Events** stream by default.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`type\` | string | yes | \`"chat"\` |
| \`prompt\` | string | yes | The user message to send to Claude |
| \`stream\` | boolean | no | \`false\` for a single JSON response instead of SSE. Default: \`true\`. |
| \`cwd\` | string | no | Working directory (sandboxed into \`outputs/\`). Defaults to \`outputs/\`. |
| \`sessionId\` | string | no | Resume an existing session for multi-turn conversation. |

### SSE events

| Event | Payload | When |
|-------|---------|------|
| \`text\` | \`{ text }\` | Streamed text delta |
| \`ask\` | \`{ toolUseId, questions }\` | Session needs user input. Answer via \`POST /api/run/answer\`. |
| \`error\` | \`{ error }\` | Error message |
| \`done\` | \`{ result, sessionId? }\` | Final result. \`sessionId\` enables multi-turn. |

---

## POST /api/run/answer

Answer a pending \`AskUserQuestion\`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`toolUseId\` | string | yes | The \`toolUseId\` from the \`ask\` event |
| \`answer\` | any | yes | The answer value |

---

## Example

\`\`\`bash
TOKEN="YOUR_TOKEN"

# Start a streaming chat
curl -N -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"chat","prompt":"List all TODO comments in this project","cwd":"my-project"}'

# Answer a pending AskUserQuestion
curl -s -X POST http://localhost:3457/api/run/answer \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"toolUseId":"toolu_abc123","answer":"PostgreSQL"}'

# Non-streaming (blocks until complete, returns JSON)
curl -s -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"chat","prompt":"Write a haiku about code","stream":false}'
\`\`\`
`;

  // --- Render sections ---
  function renderSections() {
    const sections = {
      'home-overview': overviewMd,
      'home-proxy': proxyMd,
      'home-mcp': mcpMd,
      'home-api': apiMd,
    };
    for (const [id, md] of Object.entries(sections)) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('markdown-body');
        renderMarkdown(md.trim(), el);
      }
    }
  }

  // --- Token display in API tab ---
  function updateTokenDisplay() {
    const apiEl = document.getElementById('home-api');
    if (!apiEl) return;
    const token = window.dashboard?.state?.authToken;
    if (!token) return;
    let box = document.getElementById('api-token-display');
    if (box) {
      box.querySelector('.api-token-value').textContent = token;
      return;
    }
    box = document.createElement('div');
    box.id = 'api-token-display';
    box.className = 'api-token-box';
    box.innerHTML = `
      <span class="api-token-label">Auth Token</span>
      <code class="api-token-value">${window.dashboard.escHtml(token)}</code>
      <button class="api-token-copy" title="Copy token">Copy</button>
    `;
    box.querySelector('.api-token-copy').addEventListener('click', function() {
      navigator.clipboard.writeText(window.dashboard.state.authToken).then(() => {
        this.textContent = 'Copied!';
        setTimeout(() => { this.textContent = 'Copy'; }, 1500);
      });
    });
    apiEl.insertBefore(box, apiEl.firstChild);
  }

  if (document.readyState === 'complete') {
    renderSections();
    updateTokenDisplay();
  } else {
    window.addEventListener('load', () => { renderSections(); updateTokenDisplay(); });
  }

  window.homeModule = { updateTokenDisplay };
})();
