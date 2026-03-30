// ============================================================
// HOME VIEW — Overview, architecture, workflows, tools docs
// ============================================================
(function homeModule() {
  'use strict';
  const { renderMarkdown } = window.dashboard;

  // --- Sub-tab switching ---
  document.getElementById('homeNav')?.addEventListener('click', e => {
    const btn = e.target.closest('.home-nav-btn');
    if (!btn) return;
    const section = btn.dataset.section;
    document.querySelectorAll('.home-nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.home-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('home-' + section);
    if (target) target.classList.add('active');
  });

  // --- Content ---

  const overviewMd = `
# claude-doc

A development dashboard that wraps **Claude Code** with inspection, multi-tab chat, workflow automation, and custom MCP tools.

## What it does

- **Chat** with Claude through multiple parallel tabs, each with its own working directory and profile
- **Inspect** every API call in real time -- request, response, streaming events, token usage
- **Run workflows** -- multi-step automations where each step is a full \`claude -p\` session
- **Custom MCP tools** that Claude can call during any session -- you write the handler, Claude gets the capability
- **AskUserQuestion** -- workflow steps can pause and ask the user for input, then resume with the answer

\`\`\`svg
<svg viewBox="0 0 800 320" xmlns="http://www.w3.org/2000/svg" style="max-width:800px;font-family:system-ui,sans-serif">
  <!-- Browser -->
  <rect x="20" y="20" width="160" height="60" rx="8" fill="none" stroke="var(--accent)" stroke-width="2"/>
  <text x="100" y="55" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="600">Browser UI</text>
  <!-- Server -->
  <rect x="300" y="10" width="200" height="80" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="400" y="38" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="600">claude-doc server</text>
  <text x="400" y="58" text-anchor="middle" fill="var(--text-dim)" font-size="11">proxy + dashboard + WS</text>
  <text x="400" y="73" text-anchor="middle" fill="var(--text-dim)" font-size="11">workflow engine</text>
  <!-- API -->
  <rect x="620" y="20" width="160" height="60" rx="8" fill="none" stroke="var(--purple)" stroke-width="2"/>
  <text x="700" y="55" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="600">Anthropic API</text>
  <!-- Arrows top -->
  <line x1="180" y1="50" x2="300" y2="50" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ha)"/>
  <text x="240" y="43" text-anchor="middle" fill="var(--text-dim)" font-size="9">WebSocket</text>
  <line x1="500" y1="50" x2="620" y2="50" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ha)"/>
  <text x="560" y="43" text-anchor="middle" fill="var(--text-dim)" font-size="9">HTTP/SSE</text>
  <!-- Claude -p boxes -->
  <rect x="240" y="130" width="140" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="310" y="160" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="500">claude -p (chat)</text>
  <rect x="420" y="130" width="140" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="490" y="160" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="500">claude -p (step)</text>
  <!-- Arrows to claude -p -->
  <line x1="370" y1="90" x2="310" y2="130" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ha)"/>
  <line x1="430" y1="90" x2="490" y2="130" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ha)"/>
  <!-- AskUserQuestion -->
  <rect x="80" y="220" width="200" height="45" rx="6" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1.5" stroke-dasharray="4"/>
  <text x="180" y="247" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">AskUserQuestion (intercepted)</text>
  <line x1="310" y1="180" x2="280" y2="220" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ha)"/>
  <line x1="490" y1="180" x2="280" y2="235" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ha)"/>
  <line x1="180" y1="220" x2="100" y2="80" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3" marker-end="url(#ha)"/>
  <text x="90" y="160" fill="var(--text-dim)" font-size="9">shown in UI</text>
  <!-- MCP -->
  <rect x="520" y="220" width="180" height="45" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="610" y="247" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">MCP Tools (custom)</text>
  <line x1="530" y1="180" x2="570" y2="220" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#ha)"/>
  <!-- Workflow -->
  <rect x="300" y="270" width="200" height="40" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="400" y="295" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Workflow Engine (steps)</text>
  <line x1="400" y1="90" x2="400" y2="270" stroke="var(--green)" stroke-width="1" stroke-dasharray="3"/>
  <!-- Arrowhead -->
  <defs><marker id="ha" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>
</svg>
\`\`\`

## Quick start

1. **Chat tab** -- type a prompt, pick a profile (model + permissions), set a working directory
2. **Runs tab** -- pick a workflow, fill inputs, watch steps execute live
3. **Inspector tab** -- see every API call with full request/response detail
4. **Profiles tab** -- configure model, effort, permissions, MCP tools per profile
5. **Workflows tab** -- design, generate, and compile multi-step automations
`;

  const architectureMd = `
# Architecture

## Server components

| Component | Purpose |
|-----------|---------|
| **Proxy** (\`localhost:3456\`) | Intercepts all Claude API calls for inspection, also intercepts AskUserQuestion |
| **Dashboard** (\`localhost:3457\`) | WebSocket server for real-time UI updates, serves the web UI |
| **Session Manager** | One \`claude -p\` process per chat tab, with independent cwd and profile |
| **Workflow Engine** | Walks workflow steps, spawns \`claude -p\` per step, handles parallel/branching |
| **MCP Server** | Integrated tool server auto-registered with Claude Code |

## How a chat message flows

\`\`\`svg
<svg viewBox="0 0 700 200" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="a2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>
  <rect x="10" y="60" width="100" height="40" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="60" y="84" text-anchor="middle" fill="var(--text)" font-size="11">Browser</text>
  <rect x="150" y="60" width="100" height="40" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="200" y="84" text-anchor="middle" fill="var(--text)" font-size="11">Dashboard WS</text>
  <rect x="290" y="60" width="100" height="40" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="340" y="84" text-anchor="middle" fill="var(--text)" font-size="11">claude -p</text>
  <rect x="430" y="60" width="100" height="40" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="480" y="84" text-anchor="middle" fill="var(--text)" font-size="11">Proxy</text>
  <rect x="570" y="60" width="110" height="40" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="625" y="84" text-anchor="middle" fill="var(--text)" font-size="11">Anthropic API</text>
  <line x1="110" y1="80" x2="150" y2="80" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a2)"/>
  <line x1="250" y1="80" x2="290" y2="80" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a2)"/>
  <line x1="390" y1="80" x2="430" y2="80" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a2)"/>
  <line x1="530" y1="80" x2="570" y2="80" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#a2)"/>
  <text x="130" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="8">WS</text>
  <text x="270" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="8">stdin</text>
  <text x="410" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="8">HTTP</text>
  <text x="550" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="8">SSE</text>
  <text x="350" y="140" text-anchor="middle" fill="var(--text-dim)" font-size="10">Response streams back the same path. Proxy records everything for the Inspector.</text>
</svg>
\`\`\`

## How AskUserQuestion works

When \`claude -p\` calls the \`AskUserQuestion\` tool during a chat or workflow step:

1. The **proxy** intercepts the tool call in the API response stream
2. When \`claude -p\` sends back the error tool_result, the proxy **pauses** the request
3. The proxy **broadcasts** \`ask:question\` to the dashboard UI (with workflow tab ID if applicable)
4. The UI renders the question with options + free text input
5. User answers, UI sends \`ask:answer\` back via WebSocket
6. Proxy **rewrites** the tool_result with the real answer and continues the API call
7. Claude resumes as if the tool succeeded normally
`;

  const workflowsMd = `
# Workflows

Workflows automate multi-step tasks. Each step is a full \`claude -p\` session that can use tools, read/write files, and call MCP tools.

## Workflow lifecycle

1. **Design** -- write a high-level description in the Workflows tab
2. **Generate** -- AI creates the source JSON from your description
3. **Compile** -- AI transforms the JSON into executable JavaScript
4. **Run** -- execute from the Runs tab with a working directory and inputs

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

## Running workflows

- **Runs tab**: pick a workflow card, fill inputs, set working directory, click Run
- **MCP tool**: Claude can call \`workflow_run\` during a chat to trigger a workflow
- Steps show live progress with streaming output
- Steps can **escalate** via AskUserQuestion -- the UI shows the question and waits for your answer
- Same workflow can run in multiple tabs simultaneously with different directories
`;

  const toolsMd = `
# MCP Tools

Custom tools extend what Claude can do. You write a JavaScript handler, and Claude can call it like any built-in tool.

## How it works

1. Tools are defined in the **Profiles > MCP Tools** panel
2. Each tool has a name, description, parameters (typed), and a handler body
3. The integrated MCP server registers with Claude Code automatically
4. When Claude calls your tool, the handler runs and returns a result

## Built-in workflow tools

These are always available and cannot be modified:

| Tool | Purpose |
|------|---------|
| \`workflow_list\` | List available workflows |
| \`workflow_run\` | Execute a workflow with inputs and optional cwd |
| \`workflow_status\` | Check progress of a running workflow |
| \`workflow_cancel\` | Cancel a running workflow |

## Writing a tool handler

The handler is an async function that receives the parameters and must return MCP content:

\`\`\`javascript
// Example: a tool that fetches a URL
const response = await fetch(url);
const text = await response.text();
return {
  content: [{ type: "text", text }]
};
\`\`\`

Tools can also connect to the dashboard WebSocket for integration with the system.
`;

  // --- Render sections ---
  function renderSections() {
    const sections = {
      'home-overview': overviewMd,
      'home-architecture': architectureMd,
      'home-workflows': workflowsMd,
      'home-tools': toolsMd,
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
