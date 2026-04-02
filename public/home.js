// ============================================================
// HOME VIEW — Overview, architecture, workflows, tools, API docs
// ============================================================
(function homeModule() {
  'use strict';
  const { renderMarkdown } = window.dashboard;

  // --- Sub-tab switching ---
  document.getElementById('homeNav')?.addEventListener('click', e => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    const section = btn.dataset.section;
    document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.home-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('home-' + section);
    if (target) target.classList.add('active');
  });

  // --- Content ---

  const overviewMd = `
# clairview

A development dashboard that wraps **Claude Code** with real-time inspection, multi-session chat, workflow automation, custom MCP tools, multi-provider model routing, and a REST API.

## What it does

- **Chat** with Claude through multiple parallel browser tabs, each with its own working directory, profile, and model -- fully isolated sessions that never interfere with each other
- **Inspect** every API call in real time -- request bodies, response streams, token usage, cost tracking, and timing -- across all sessions and providers
- **Run workflows** -- multi-step automations where each step is a full \`claude -p\` session; multiple workflows can run in parallel
- **Route to any model** -- use Anthropic Claude directly, or route through OpenAI, Google Gemini, DeepSeek, Kimi/Moonshot, or any OpenAI-compatible endpoint via provider translation
- **Custom MCP tools** that Claude can call during any session -- you write the handler, Claude gets the capability
- **AskUserQuestion** -- chat sessions and workflow steps can pause and ask you for input, then resume with the answer
- **REST API** -- programmatically start chats, run workflows, and answer questions via Server-Sent Events

\`\`\`svg
<svg viewBox="0 0 800 380" xmlns="http://www.w3.org/2000/svg" style="max-width:800px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="ha" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker>
    <marker id="hg" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--green)"/></marker>
  </defs>

  <!-- Browser tabs -->
  <rect x="20" y="20" width="160" height="70" rx="8" fill="none" stroke="var(--accent)" stroke-width="2"/>
  <text x="100" y="46" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="600">Browser UI</text>
  <text x="100" y="63" text-anchor="middle" fill="var(--text-dim)" font-size="10">chat tabs / runs / inspector</text>
  <text x="100" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="10">profiles / models / workflows</text>

  <!-- API client -->
  <rect x="20" y="110" width="160" height="40" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="100" y="135" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="500">REST API client</text>

  <!-- Server -->
  <rect x="280" y="10" width="240" height="90" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="400" y="34" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="600">clairview server</text>
  <text x="400" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="10">dashboard :3457  |  proxy :3456</text>
  <text x="400" y="67" text-anchor="middle" fill="var(--text-dim)" font-size="10">session manager  |  workflow engine</text>
  <text x="400" y="82" text-anchor="middle" fill="var(--text-dim)" font-size="10">MCP server  |  cost tracker</text>

  <!-- Anthropic API -->
  <rect x="620" y="15" width="160" height="40" rx="8" fill="none" stroke="var(--purple)" stroke-width="2"/>
  <text x="700" y="40" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="600">Anthropic API</text>

  <!-- Third-party APIs -->
  <rect x="620" y="65" width="160" height="40" rx="8" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
  <text x="700" y="85" text-anchor="middle" fill="var(--text-dim)" font-size="11">OpenAI / Gemini / ...</text>

  <!-- Arrows: browser/api to server -->
  <line x1="180" y1="55" x2="280" y2="55" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ha)"/>
  <text x="230" y="48" text-anchor="middle" fill="var(--text-dim)" font-size="9">WebSocket</text>
  <line x1="180" y1="130" x2="280" y2="65" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ha)"/>
  <text x="218" y="106" text-anchor="middle" fill="var(--text-dim)" font-size="9">SSE</text>

  <!-- Arrows: server to APIs -->
  <line x1="520" y1="35" x2="620" y2="35" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ha)"/>
  <line x1="520" y1="75" x2="620" y2="82" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ha)"/>
  <text x="570" y="28" text-anchor="middle" fill="var(--text-dim)" font-size="9">direct</text>
  <text x="570" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="9">translated</text>

  <!-- Claude -p processes -->
  <rect x="220" y="140" width="130" height="45" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="285" y="160" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="285" y="175" text-anchor="middle" fill="var(--text-dim)" font-size="9">chat session 1</text>

  <rect x="370" y="140" width="130" height="45" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="435" y="160" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="435" y="175" text-anchor="middle" fill="var(--text-dim)" font-size="9">chat session 2</text>

  <rect x="220" y="200" width="130" height="45" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="285" y="220" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="285" y="235" text-anchor="middle" fill="var(--text-dim)" font-size="9">workflow step</text>

  <rect x="370" y="200" width="130" height="45" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="435" y="220" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="435" y="235" text-anchor="middle" fill="var(--text-dim)" font-size="9">workflow step</text>

  <!-- Arrows: server to claude processes -->
  <line x1="340" y1="100" x2="285" y2="140" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ha)"/>
  <line x1="400" y1="100" x2="435" y2="140" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ha)"/>
  <line x1="340" y1="100" x2="285" y2="200" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ha)"/>
  <line x1="400" y1="100" x2="435" y2="200" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ha)"/>

  <!-- Profile-scoped URLs label -->
  <rect x="530" y="145" width="240" height="55" rx="6" fill="none" stroke="var(--green)" stroke-width="1" stroke-dasharray="4"/>
  <text x="650" y="163" text-anchor="middle" fill="var(--text-dim)" font-size="9">each process has its own profile URL:</text>
  <text x="650" y="178" text-anchor="middle" fill="var(--green)" font-size="9" font-weight="600">localhost:3456/p/{profile}/v1/messages</text>
  <text x="650" y="191" text-anchor="middle" fill="var(--text-dim)" font-size="9">concurrent sessions never interfere</text>

  <!-- AskUserQuestion -->
  <rect x="80" y="290" width="200" height="45" rx="6" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1.5" stroke-dasharray="4"/>
  <text x="180" y="317" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">AskUserQuestion (intercepted)</text>
  <line x1="285" y1="245" x2="250" y2="290" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ha)"/>
  <line x1="435" y1="245" x2="260" y2="300" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ha)"/>
  <line x1="180" y1="290" x2="100" y2="90" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ha)"/>
  <text x="90" y="200" fill="var(--text-dim)" font-size="9">shown in UI</text>

  <!-- MCP -->
  <rect x="520" y="225" width="180" height="45" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="610" y="245" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">MCP Tools (custom)</text>
  <text x="610" y="259" text-anchor="middle" fill="var(--text-dim)" font-size="9">+ chat, workflow_run, ...</text>
  <line x1="500" y1="220" x2="520" y2="235" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ha)"/>

  <!-- Workflow engine -->
  <rect x="300" y="290" width="200" height="45" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="400" y="310" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Workflow Engine</text>
  <text x="400" y="324" text-anchor="middle" fill="var(--text-dim)" font-size="9">parallel steps / context passing</text>
  <line x1="350" y1="245" x2="370" y2="290" stroke="var(--green)" stroke-width="1" stroke-dasharray="3"/>
</svg>
\`\`\`

## Quick start

1. **Chat tab** -- type a prompt, pick a profile (model + permissions), set a working directory. Open multiple tabs for parallel conversations -- each is fully isolated.
2. **Workflows tab** -- pick a workflow, fill inputs, watch steps execute live. Run multiple workflows at once. Create, edit, and delete workflows from the card grid. The \`+ New\` button opens the editor to design, generate, and compile multi-step automations.
3. **Inspector tab** -- see every API call from all sessions with full request/response detail, token counts, and cost.
4. **Profiles tab** -- one tab per profile with inline editing of model, effort, permission mode, tools, and system prompts. Builtin profiles (\`full\`, \`safe\`, \`readonly\`, \`minimal\`) are read-only.
5. **Tools tab** -- browse all tools, skills, agents, hooks, and MCP tools available to the active profile.
6. **Models tab** -- browse models by provider, set API keys per provider, add custom model definitions.
7. **REST API** -- \`POST /api/run\` to start chats or workflows programmatically and stream results via SSE.
`;

  const architectureMd = `
# Architecture

## Server components

clairview runs two servers from a single Node.js process:

| Component | Port | Purpose |
|-----------|------|---------|
| **Proxy** | \`:3456\` (localhost only) | Intercepts all Claude API calls for inspection and model routing. Also intercepts AskUserQuestion tool calls. |
| **Dashboard** | \`:3457\` (all interfaces) | WebSocket server for real-time UI updates, REST API, serves the web UI. Auth-protected. |

Internal services (no separate port):

| Component | Purpose |
|-----------|---------|
| **Session Manager** | One \`claude -p\` process per chat tab, with independent cwd and profile. Sessions persist across browser reconnects. |
| **Workflow Engine** | Walks workflow steps, spawns \`claude -p\` per step, handles step dependencies and context passing. Multiple workflows run in parallel. |
| **MCP Server** | Integrated tool server auto-registered with every \`claude -p\` process. Custom tools + built-in workflow/chat tools. |
| **Cost Tracker** | Records token usage and cost per interaction, per model, per provider. Visible in the Inspector. |

## Per-session model routing

Every \`claude -p\` process gets its profile baked into its base URL at spawn time:

\`\`\`
ANTHROPIC_BASE_URL = http://localhost:3456/p/{profileName}
\`\`\`

This means profile selection is **immutable for the process lifetime** -- switching profiles in the browser UI or starting a new workflow will never affect a running session. Concurrent chats, workflows, and API calls are fully isolated.

\`\`\`svg
<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" style="max-width:760px;font-family:system-ui,sans-serif">
  <defs><marker id="a2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Claude process -->
  <rect x="10" y="30" width="130" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="75" y="52" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="75" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="9">profile: gemini-fast</text>

  <!-- Proxy -->
  <rect x="210" y="15" width="190" height="80" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="305" y="38" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Proxy :3456</text>
  <text x="305" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">extracts profile from URL</text>
  <text x="305" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="9">loads modelDef + provider</text>
  <text x="305" y="81" text-anchor="middle" fill="var(--text-dim)" font-size="9">records for inspector</text>

  <!-- Path 1: third-party -->
  <rect x="500" y="15" width="150" height="40" rx="6" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
  <text x="575" y="40" text-anchor="middle" fill="var(--text)" font-size="11">Gemini / OpenAI / ...</text>
  <line x1="400" y1="40" x2="500" y2="35" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="450" y="28" text-anchor="middle" fill="var(--text-dim)" font-size="8">translate request</text>

  <!-- Path 2: Anthropic -->
  <rect x="500" y="65" width="150" height="40" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="575" y="90" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Anthropic API</text>
  <line x1="400" y1="70" x2="500" y2="80" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="450" y="82" text-anchor="middle" fill="var(--text-dim)" font-size="8">forward as-is</text>

  <!-- Arrow: claude to proxy -->
  <line x1="140" y1="55" x2="210" y2="55" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="175" y="48" text-anchor="middle" fill="var(--green)" font-size="7">/p/gemini-fast/v1/messages</text>

  <!-- Decision box -->
  <text x="305" y="120" text-anchor="middle" fill="var(--text-dim)" font-size="10">Profile has modelDef?  yes → translate to provider   |   no → forward to Anthropic</text>

  <!-- Second example: direct Anthropic -->
  <rect x="10" y="155" width="130" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="75" y="177" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="75" y="193" text-anchor="middle" fill="var(--text-dim)" font-size="9">profile: full</text>

  <rect x="210" y="150" width="190" height="60" rx="8" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="305" y="175" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Proxy :3456</text>
  <text x="305" y="192" text-anchor="middle" fill="var(--text-dim)" font-size="9">profile: full → no modelDef</text>

  <rect x="500" y="155" width="150" height="40" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="575" y="180" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Anthropic API</text>

  <line x1="140" y1="180" x2="210" y2="180" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="175" y="173" text-anchor="middle" fill="var(--green)" font-size="7">/p/full/v1/messages</text>
  <line x1="400" y1="175" x2="500" y2="175" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="450" y="168" text-anchor="middle" fill="var(--text-dim)" font-size="8">forward as-is</text>

  <!-- Isolation note -->
  <rect x="120" y="235" width="520" height="30" rx="6" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="4"/>
  <text x="380" y="255" text-anchor="middle" fill="var(--text-dim)" font-size="10">Both sessions run concurrently. Switching profiles in the UI never affects running processes.</text>
</svg>
\`\`\`

## How a chat message flows

1. You type a message in the **Chat tab** and click Send
2. The **Dashboard** receives it over WebSocket and spawns \`claude -p\` with \`ANTHROPIC_BASE_URL=http://localhost:3456/p/{profile}\`
3. \`claude -p\` sends API requests to the proxy (thinking it's talking to Anthropic)
4. The **Proxy** intercepts the request, loads the profile, and either:
   - **Forwards** to the real Anthropic API (if no \`modelDef\` in the profile), or
   - **Translates** to the target provider's format (OpenAI, Gemini, etc.) and sends it there
5. The response streams back through the proxy (which records it for the Inspector)
6. \`claude -p\` streams text to stdout, which the Dashboard broadcasts over WebSocket to the browser

## How AskUserQuestion works

When \`claude -p\` calls the \`AskUserQuestion\` tool during a chat or workflow step:

1. The **proxy** intercepts the tool call in the API response stream
2. When \`claude -p\` sends back the error tool_result, the proxy **pauses** the request
3. The proxy **broadcasts** \`ask:question\` to the dashboard UI (with session/workflow context)
4. The UI renders the question with options + free text input
5. User answers, UI sends \`ask:answer\` back via WebSocket
6. Proxy **rewrites** the tool_result with the real answer and continues the API call
7. Claude resumes as if the tool succeeded normally

This works identically for chat sessions and workflow steps.
`;

  const workflowsMd = `
# Workflows

Workflows automate multi-step tasks. Each step is a full \`claude -p\` session that can use tools, read/write files, and call MCP tools. Multiple workflows can run simultaneously -- each is a separate set of processes with independent profiles.

\`\`\`svg
<svg viewBox="0 0 700 200" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="a3" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Design -->
  <rect x="10" y="60" width="110" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="65" y="82" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Design</text>
  <text x="65" y="98" text-anchor="middle" fill="var(--text-dim)" font-size="9">natural language</text>

  <!-- Generate -->
  <rect x="160" y="60" width="110" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="215" y="82" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Generate</text>
  <text x="215" y="98" text-anchor="middle" fill="var(--text-dim)" font-size="9">AI → JSON source</text>

  <!-- Compile -->
  <rect x="310" y="60" width="110" height="50" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="365" y="82" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Compile</text>
  <text x="365" y="98" text-anchor="middle" fill="var(--text-dim)" font-size="9">AI → JavaScript</text>

  <!-- Run -->
  <rect x="460" y="60" width="110" height="50" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="515" y="82" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Run</text>
  <text x="515" y="98" text-anchor="middle" fill="var(--text-dim)" font-size="9">execute steps</text>

  <!-- Result -->
  <rect x="610" y="60" width="80" height="50" rx="6" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1.5"/>
  <text x="650" y="89" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Result</text>

  <!-- Arrows -->
  <line x1="120" y1="85" x2="160" y2="85" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a3)"/>
  <line x1="270" y1="85" x2="310" y2="85" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a3)"/>
  <line x1="420" y1="85" x2="460" y2="85" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a3)"/>
  <line x1="570" y1="85" x2="610" y2="85" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a3)"/>

  <!-- Labels -->
  <text x="350" y="30" text-anchor="middle" fill="var(--text-dim)" font-size="10">Workflow lifecycle: describe what you want → AI builds it → run it repeatedly with different inputs</text>
  <text x="350" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="10">Each step runs as an independent claude -p with its own profile, cwd, and MCP tools</text>
  <text x="350" y="175" text-anchor="middle" fill="var(--text-dim)" font-size="10">Steps can pass context to downstream steps  |  Steps can escalate via AskUserQuestion</text>
</svg>
\`\`\`

## Workflow lifecycle

1. **Design** -- in the Workflows tab, click \`+ New\` to open the editor. Write a high-level description of what the workflow should do (e.g. "review code on a branch and produce a summary"). Name it and define its inputs.
2. **Generate** -- click Generate and AI creates the source JSON from your description, defining steps, their order, profiles, and what each step produces.
3. **Compile** -- click Compile and AI transforms the JSON into executable JavaScript that the workflow engine can run.
4. **Run** -- pick a workflow card, fill in inputs (e.g. branch name), set a working directory, and click Run.

## Workflow JSON structure

\`\`\`json
{
  "name": "code-review",
  "description": "Review code changes and suggest improvements",
  "inputs": {
    "branch": "Branch to review"
  },
  "steps": {
    "analyze": {
      "profile": "full",
      "do": "Analyze the diff on branch {{branch}}",
      "produces": "list of findings"
    },
    "suggest": {
      "profile": "full",
      "do": "For each finding, suggest a concrete fix",
      "context": ["analyze"],
      "produces": "actionable suggestions"
    },
    "summarize": {
      "do": "Create a summary of the review",
      "context": ["analyze", "suggest"]
    }
  }
}
\`\`\`

Key fields:
- **\`inputs\`** -- variables the user fills in at run time, referenced as \`{{variable}}\` in step prompts
- **\`profile\`** -- which capability profile each step uses (controls model, permissions, tools)
- **\`context\`** -- list of upstream steps whose output is passed as context to this step
- **\`produces\`** -- description of what the step outputs (used as context label for downstream steps)

## Running workflows

- **Runs tab**: pick a workflow card, fill inputs, set working directory, click Run. Live streaming output appears for each step.
- **MCP tool**: Claude can call \`workflow_run\` during a chat session to trigger a workflow programmatically.
- **REST API**: \`POST /api/run\` with \`type: "workflow"\` to start a workflow and stream events via SSE.
- Steps can **escalate** via AskUserQuestion -- the UI shows the question and waits for your answer before the step continues.
- **Parallel execution**: multiple workflows (or multiple runs of the same workflow) can execute simultaneously. Each run gets its own set of \`claude -p\` processes with independent profiles. The footer shows a live count of active Claude processes.
`;

  const toolsMd = `
# MCP Tools

Custom tools extend what Claude can do. You write a JavaScript handler, and Claude can call it like any built-in tool during chat or workflow sessions.

\`\`\`svg
<svg viewBox="0 0 700 210" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="a4" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Claude process -->
  <rect x="10" y="50" width="120" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="70" y="72" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="70" y="88" text-anchor="middle" fill="var(--text-dim)" font-size="9">any session</text>

  <!-- MCP Server -->
  <rect x="210" y="30" width="180" height="90" rx="8" fill="none" stroke="var(--purple)" stroke-width="2"/>
  <text x="300" y="55" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">MCP Server</text>
  <text x="300" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="9">auto-registered with claude -p</text>
  <text x="300" y="86" text-anchor="middle" fill="var(--text-dim)" font-size="9">custom tools + built-in tools</text>
  <text x="300" y="100" text-anchor="middle" fill="var(--text-dim)" font-size="9">Zod schema validation</text>

  <!-- Custom handler -->
  <rect x="470" y="25" width="170" height="45" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="555" y="45" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Custom handlers</text>
  <text x="555" y="60" text-anchor="middle" fill="var(--text-dim)" font-size="9">your JavaScript code</text>

  <!-- Built-in tools -->
  <rect x="470" y="80" width="170" height="45" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="555" y="100" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Built-in tools</text>
  <text x="555" y="115" text-anchor="middle" fill="var(--text-dim)" font-size="9">chat, workflow_run, ...</text>

  <!-- Arrows -->
  <line x1="130" y1="75" x2="210" y2="75" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#a4)"/>
  <text x="170" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="8">tool_use</text>
  <line x1="390" y1="55" x2="470" y2="48" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a4)"/>
  <line x1="390" y1="95" x2="470" y2="100" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a4)"/>

  <!-- Profile note -->
  <text x="350" y="160" text-anchor="middle" fill="var(--text-dim)" font-size="10">Profiles control which MCP tools are available in each session (mcpServers field)</text>
  <text x="350" y="178" text-anchor="middle" fill="var(--text-dim)" font-size="10">Tools are defined in Profiles > MCP Tools with name, description, typed parameters, and handler code</text>
</svg>
\`\`\`

## How it works

1. Tools are defined in the **Profiles > MCP Tools** panel. Each tool has a name, description, typed parameters (via Zod schemas), and a handler body.
2. The integrated MCP server registers itself with every \`claude -p\` process automatically at startup.
3. When Claude decides to call your tool, the MCP server validates the input against the schema and executes the handler.
4. The handler returns a result (text, images, or errors) and Claude continues with the response.

## Built-in tools

These are always available in every session and cannot be modified:

| Tool | Purpose |
|------|---------|
| \`chat\` | Run a prompt through Claude Code via the dashboard. Supports multi-turn via \`session_id\`. Can specify \`profile\` and \`cwd\`. |
| \`workflow_list\` | List available compiled workflows |
| \`workflow_run\` | Execute a workflow with inputs and optional cwd. Returns the run ID. |
| \`workflow_status\` | Check progress of a running workflow by run ID |
| \`workflow_cancel\` | Cancel a running workflow by run ID |

The \`chat\` tool is particularly useful for delegation -- a Claude session can spawn sub-conversations with different profiles (e.g. an orchestrator session using the \`chat\` tool to delegate research to a \`readonly\` session).

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
`;

  const apiMd = `
# REST API

clairview exposes a REST API on the dashboard port (\`:3457\`) for programmatic access. All endpoints require authentication via cookie (\`token=<TOKEN>\`), header (\`Authorization: Bearer <TOKEN>\`), or the internal header (\`X-Clairview-Internal: true\` from localhost).

The auth token is printed to the console when the server starts, or can be set via the \`AUTH_TOKEN\` environment variable.

\`\`\`svg
<svg viewBox="0 0 700 200" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="a5" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Client -->
  <rect x="10" y="50" width="130" height="60" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="75" y="72" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Your script</text>
  <text x="75" y="88" text-anchor="middle" fill="var(--text-dim)" font-size="9">curl / fetch / SDK</text>
  <text x="75" y="100" text-anchor="middle" fill="var(--text-dim)" font-size="9">POST /api/run</text>

  <!-- Dashboard -->
  <rect x="220" y="40" width="180" height="80" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="310" y="65" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Dashboard :3457</text>
  <text x="310" y="82" text-anchor="middle" fill="var(--text-dim)" font-size="9">validates auth + params</text>
  <text x="310" y="96" text-anchor="middle" fill="var(--text-dim)" font-size="9">spawns claude -p</text>
  <text x="310" y="108" text-anchor="middle" fill="var(--text-dim)" font-size="9">streams SSE events back</text>

  <!-- Claude -->
  <rect x="480" y="50" width="120" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="540" y="72" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="540" y="88" text-anchor="middle" fill="var(--text-dim)" font-size="9">with profile URL</text>

  <!-- Arrows -->
  <line x1="140" y1="80" x2="220" y2="80" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#a5)"/>
  <text x="180" y="73" text-anchor="middle" fill="var(--text-dim)" font-size="8">JSON body</text>
  <line x1="400" y1="75" x2="480" y2="75" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a5)"/>
  <text x="440" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="8">spawn</text>

  <!-- SSE arrow back -->
  <line x1="220" y1="100" x2="140" y2="100" stroke="var(--accent)" stroke-width="1" marker-end="url(#a5)"/>
  <text x="180" y="115" text-anchor="middle" fill="var(--accent)" font-size="8">SSE stream</text>

  <!-- Note -->
  <text x="350" y="165" text-anchor="middle" fill="var(--text-dim)" font-size="10">Profile-scoped routing applies: API calls get the same per-session isolation as browser chats</text>
  <text x="350" y="182" text-anchor="middle" fill="var(--text-dim)" font-size="10">All events visible in Inspector alongside browser sessions</text>
</svg>
\`\`\`

---

## POST /api/run

Start a chat or workflow. Returns a **Server-Sent Events** stream.

### Chat mode

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`type\` | string | yes | \`"chat"\` |
| \`prompt\` | string | yes | The user message to send to Claude |
| \`cwd\` | string | no | Working directory (sandboxed into \`outputs/\`). Defaults to \`outputs/\`. |
| \`profile\` | string | no | Profile name (\`"full"\`, \`"safe"\`, \`"readonly"\`, or custom). Does not change the global active profile. |
| \`sessionId\` | string | no | Resume an existing session for multi-turn conversation. Returned in the \`done\` event. |

### Workflow mode

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`type\` | string | yes | \`"workflow"\` |
| \`workflow\` | string | yes | Name of the workflow to run (e.g. \`"code-review"\`) |
| \`inputs\` | object | no | Key-value input variables. For prompt-mode workflows, pass \`{ "prompt": "your message" }\`. |
| \`cwd\` | string | no | Working directory (sandboxed into \`outputs/\`) |
| \`profile\` | string | no | Profile override for all steps |

### SSE events

All responses stream as Server-Sent Events (\`Content-Type: text/event-stream\`).

| Event | Payload | When |
|-------|---------|------|
| \`text\` | \`{ text }\` | Streamed text delta from Claude (both chat and workflow steps) |
| \`ask\` | \`{ toolUseId, questions }\` | AskUserQuestion -- the session needs user input to continue. Answer via \`POST /api/run/answer\`. |
| \`step\` | \`{ stepId, status, text? }\` | Workflow only: step started (\`status: "running"\`), progress (\`text\` included), or completed (\`status: "done"\` / \`"failed"\`) |
| \`error\` | \`{ error }\` | Error message |
| \`done\` | \`{ result, sessionId? }\` (chat) or \`{ result, runId }\` (workflow) | Final result. Chat includes \`sessionId\` for multi-turn. Workflow includes \`runId\`. |

---

## POST /api/run/answer

Answer a pending \`AskUserQuestion\` that arrived via the \`ask\` SSE event. The run resumes after the answer.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`toolUseId\` | string | yes | The \`toolUseId\` from the \`ask\` event |
| \`answer\` | any | yes | The answer value (string or structured response) |

**Response:** \`{ ok: true }\` on success. \`404\` if no pending question matches the \`toolUseId\`.

---

## GET /api/dirs

List subdirectories within the \`outputs/\` sandbox.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| \`path\` | string (query) | no | Relative path within \`outputs/\`. Defaults to root. |

**Response:** \`{ current, absolute, dirs }\` -- \`dirs\` is a sorted array of subdirectory names (hidden dirs excluded).

---

## POST /api/dirs

Create a new directory within \`outputs/\`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`path\` | string | no | Parent directory (relative to \`outputs/\`) |
| \`name\` | string | yes | Folder name. Alphanumeric, spaces, dots, hyphens, underscores. Max 100 chars. |

**Response:** \`{ ok: true, created: "relative/path" }\` on success.

---

## Examples

### Chat -- single turn

\`\`\`bash
curl -N -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"chat","prompt":"List all TODO comments in the codebase","profile":"readonly"}'
\`\`\`

### Chat -- multi-turn (resume session)

\`\`\`bash
# First message -- capture the sessionId from the done event
curl -N -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"chat","prompt":"Explain the auth middleware"}'

# Continue the conversation
curl -N -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"chat","prompt":"Now add rate limiting to it","sessionId":"SESSION_ID"}'
\`\`\`

### Workflow -- with inputs

\`\`\`bash
curl -N -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"workflow","workflow":"explain-topic","inputs":{"topic":"WebSockets"}}'
\`\`\`

### Workflow -- prompt mode

For workflows with \`inputMode: "prompt"\`, pass the user message as \`inputs.prompt\`:

\`\`\`bash
curl -N -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"workflow","workflow":"research-assistant","inputs":{"prompt":"Compare React and Vue for our use case"}}'
\`\`\`

### Answering an AskUserQuestion

When you receive an \`ask\` SSE event, answer it in a separate request:

\`\`\`bash
# Received: event: ask
# data: {"toolUseId":"toolu_abc123","questions":[{"question":"Which database?"}]}

curl -X POST http://localhost:3457/api/run/answer \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"toolUseId":"toolu_abc123","answer":"PostgreSQL"}'
\`\`\`

### Directory listing

\`\`\`bash
# List root of outputs/
curl http://localhost:3457/api/dirs -H "Authorization: Bearer YOUR_TOKEN"

# List a subdirectory
curl "http://localhost:3457/api/dirs?path=my-project" -H "Authorization: Bearer YOUR_TOKEN"
\`\`\`

### Create a directory

\`\`\`bash
curl -X POST http://localhost:3457/api/dirs \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"path":"","name":"my-new-project"}'
\`\`\`
`;

  // --- Render sections ---
  function renderSections() {
    const sections = {
      'home-overview': overviewMd,
      'home-architecture': architectureMd,
      'home-workflows': workflowsMd,
      'home-tools': toolsMd,
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

  // Render after a short delay to ensure marked + MathJax are loaded
  if (document.readyState === 'complete') {
    renderSections();
  } else {
    window.addEventListener('load', renderSections);
  }
})();
