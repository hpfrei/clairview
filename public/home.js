// ============================================================
// HOME VIEW — Overview, Inspector & CLI, Rules, MCP, Connect
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

Transparent proxy + browser dashboard for Claude Code. Intercepts all API traffic, gives you inspection, model routing, programmable rules, and custom MCP tools. Tunnel it and you have full remote access from any device.

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

## Quick start

\`\`\`bash
npx vistaclair            # install + run
# or:
git clone https://github.com/hpfrei/vistaclair.git && cd vistaclair
npm install && npm start  # open localhost:3457
\`\`\`

Remote access — tunnel the dashboard port and use from any device:

\`\`\`bash
cloudflared tunnel --url http://localhost:3457
\`\`\`
`;

  const inspectorMd = `
# Inspector & CLI

## Inspector

Records every API call between Claude Code and the LLM. Click any row to drill into the full payload.

\`\`\`svg
<svg viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <!-- Timeline line -->
  <line x1="40" y1="15" x2="40" y2="185" stroke="var(--text-dim)" stroke-width="1.5" opacity="0.4"/>

  <!-- Event 1: API call -->
  <circle cx="40" cy="28" r="6" fill="var(--green)" opacity="0.9"/>
  <rect x="60" y="14" width="640" height="28" rx="5" fill="none" stroke="var(--green)" stroke-width="1"/>
  <text x="72" y="33" fill="var(--text)" font-size="11" font-weight="500">POST /v1/messages</text>
  <text x="280" y="33" fill="var(--text-dim)" font-size="10">claude-opus-4-7</text>
  <text x="460" y="33" fill="var(--text-dim)" font-size="10">42.8k in · 1.2k out · $0.22</text>
  <text x="660" y="33" fill="var(--text-dim)" font-size="10">3.1s</text>

  <!-- Event 2: Tool use -->
  <circle cx="40" cy="64" r="6" fill="var(--purple)" opacity="0.9"/>
  <rect x="60" y="50" width="640" height="28" rx="5" fill="none" stroke="var(--purple)" stroke-width="1"/>
  <text x="72" y="69" fill="var(--text)" font-size="11" font-weight="500">tool_use: Edit</text>
  <text x="280" y="69" fill="var(--text-dim)" font-size="10">src/auth.js — 3 lines changed</text>
  <text x="660" y="69" fill="var(--green)" font-size="10">✓</text>

  <!-- Event 3: Another API call -->
  <circle cx="40" cy="100" r="6" fill="var(--green)" opacity="0.9"/>
  <rect x="60" y="86" width="640" height="28" rx="5" fill="none" stroke="var(--green)" stroke-width="1"/>
  <text x="72" y="105" fill="var(--text)" font-size="11" font-weight="500">POST /v1/messages</text>
  <text x="280" y="105" fill="var(--text-dim)" font-size="10">claude-opus-4-7</text>
  <text x="460" y="105" fill="var(--text-dim)" font-size="10">44.1k in · 890 out · $0.19</text>
  <text x="660" y="105" fill="var(--text-dim)" font-size="10">1.8s</text>

  <!-- Event 4: Hook -->
  <circle cx="40" cy="136" r="6" fill="var(--cyan,#0dd)" opacity="0.9"/>
  <rect x="60" y="122" width="640" height="28" rx="5" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1"/>
  <text x="72" y="141" fill="var(--text)" font-size="11" font-weight="500">hook: PreToolUse</text>
  <text x="280" y="141" fill="var(--text-dim)" font-size="10">Bash — matched "npm test"</text>
  <text x="660" y="141" fill="var(--cyan,#0dd)" font-size="10">0.4s</text>

  <!-- Event 5: AskUserQuestion -->
  <circle cx="40" cy="172" r="6" fill="var(--yellow,#fa0)" opacity="0.9"/>
  <rect x="60" y="158" width="640" height="28" rx="5" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="4"/>
  <text x="72" y="177" fill="var(--text)" font-size="11" font-weight="500">AskUserQuestion</text>
  <text x="280" y="177" fill="var(--text-dim)" font-size="10">"Which database driver?"</text>
  <text x="660" y="177" fill="var(--yellow,#fa0)" font-size="10">waiting…</text>
</svg>
\`\`\`

### Detail panel

\`\`\`svg
<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="ip1" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- Detail panel columns -->
  <rect x="10" y="10" width="220" height="240" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="120" y="34" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">System prompt</text>
  <text x="120" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">full text with char-count gauge</text>
  <line x1="30" y1="68" x2="210" y2="68" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="120" y="86" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Messages</text>
  <text x="120" y="105" text-anchor="middle" fill="var(--text-dim)" font-size="9">each role + content + token count</text>
  <line x1="30" y1="118" x2="210" y2="118" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="120" y="136" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Tool definitions</text>
  <text x="120" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="9">all tools available at this turn</text>
  <line x1="30" y1="168" x2="210" y2="168" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="120" y="186" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Tool calls</text>
  <text x="120" y="205" text-anchor="middle" fill="var(--text-dim)" font-size="9">inputs, outputs, errors as JSON tree</text>
  <line x1="30" y1="218" x2="210" y2="218" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="120" y="238" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Thinking blocks</text>

  <!-- Middle column -->
  <rect x="250" y="10" width="220" height="240" rx="8" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="360" y="34" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">SSE event stream</text>
  <text x="360" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">raw events as they arrived</text>
  <line x1="270" y1="68" x2="450" y2="68" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="360" y="86" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Response preview</text>
  <text x="360" y="105" text-anchor="middle" fill="var(--text-dim)" font-size="9">live-rendered markdown</text>
  <line x1="270" y1="118" x2="450" y2="118" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="360" y="136" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">cURL export</text>
  <text x="360" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="9">copy request as curl (key masked)</text>
  <line x1="270" y1="168" x2="450" y2="168" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="360" y="186" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Hook calls</text>
  <text x="360" y="205" text-anchor="middle" fill="var(--text-dim)" font-size="9">PreToolUse / PostToolUse events</text>
  <line x1="270" y1="218" x2="450" y2="218" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="360" y="238" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Request headers</text>

  <!-- Right column -->
  <rect x="490" y="10" width="220" height="135" rx="8" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="600" y="34" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Token breakdown</text>
  <text x="600" y="58" text-anchor="middle" fill="var(--text-dim)" font-size="9">input · output · cache read</text>
  <text x="600" y="74" text-anchor="middle" fill="var(--text-dim)" font-size="9">cache create · reasoning</text>
  <line x1="510" y1="88" x2="690" y2="88" stroke="var(--text-dim)" stroke-width="0.5" opacity="0.4"/>
  <text x="600" y="108" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Cost tracking</text>
  <text x="600" y="126" text-anchor="middle" fill="var(--text-dim)" font-size="9">per-turn · per-group · session total</text>

  <rect x="490" y="160" width="220" height="90" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="600" y="184" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">Subagent tracking</text>
  <text x="600" y="204" text-anchor="middle" fill="var(--text-dim)" font-size="9">color-coded badges per subagent</text>
  <text x="600" y="220" text-anchor="middle" fill="var(--text-dim)" font-size="9">swimlane view for parallel work</text>
  <text x="600" y="236" text-anchor="middle" fill="var(--text-dim)" font-size="9">up to 8 concurrent agents</text>
</svg>
\`\`\`

### Per-instance isolation

Each Claude Code process gets its own tab. Concurrent sessions never mix.

\`\`\`svg
<svg viewBox="0 0 700 100" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <!-- Tab bar -->
  <rect x="10" y="10" width="680" height="35" rx="6" fill="none" stroke="var(--text-dim)" stroke-width="1"/>

  <rect x="15" y="14" width="120" height="27" rx="4" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <circle cx="30" cy="28" r="4" fill="var(--green)"/>
  <text x="42" y="32" fill="var(--text)" font-size="10" font-weight="500">cli-tab-1</text>
  <text x="120" y="32" fill="var(--text-dim)" font-size="8">running</text>

  <rect x="145" y="14" width="120" height="27" rx="4" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <circle cx="160" cy="28" r="4" fill="var(--text-dim)"/>
  <text x="172" y="32" fill="var(--text)" font-size="10">cli-tab-2</text>
  <text x="256" y="32" fill="var(--text-dim)" font-size="8">idle</text>

  <rect x="275" y="14" width="120" height="27" rx="4" fill="none" stroke="var(--accent)" stroke-width="1"/>
  <circle cx="290" cy="28" r="4" fill="var(--cyan,#0dd)"/>
  <text x="302" y="32" fill="var(--text)" font-size="10">chat-tab-3</text>
  <text x="396" y="32" fill="var(--text-dim)" font-size="8">running</text>

  <rect x="405" y="14" width="120" height="27" rx="4" fill="none" stroke="var(--yellow,#fa0)" stroke-width="1" stroke-dasharray="3"/>
  <circle cx="420" cy="28" r="4" fill="var(--yellow,#fa0)"/>
  <text x="432" y="32" fill="var(--text)" font-size="10">ext-1</text>
  <text x="508" y="32" fill="var(--text-dim)" font-size="8">external</text>

  <!-- Explanation -->
  <text x="15" y="65" fill="var(--text-dim)" font-size="10">Each tab tracks one Claude Code process. CLI tabs are sessions you spawned; chat tabs are browser chats.</text>
  <text x="15" y="82" fill="var(--text-dim)" font-size="10">External tabs (ext-N) appear when an outside Claude CLI connects to the proxy.</text>
</svg>
\`\`\`

Interactions are saved to \`interactions/{sessionId}/\` as JSON. You can resume any past session into a new CLI tab.

---

## CLI

Multi-tab Claude Code terminal in the browser. Each tab is an independent \`claude -p\` process with its own working directory and model routing.

\`\`\`svg
<svg viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="cl1" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- Tab 1 -->
  <rect x="10" y="10" width="220" height="175" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="120" y="35" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">Tab 1: my-project</text>
  <text x="120" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">cwd: ~/projects/my-project</text>
  <text x="120" y="75" text-anchor="middle" fill="var(--text-dim)" font-size="9">model: claude-opus-4-7</text>
  <rect x="25" y="88" width="190" height="45" rx="4" fill="none" stroke="var(--text-dim)" stroke-width="0.8"/>
  <text x="30" y="105" fill="var(--text-dim)" font-size="9" font-family="monospace">$ refactor the auth module</text>
  <text x="30" y="120" fill="var(--green)" font-size="9" font-family="monospace">Working on src/auth.js...</text>
  <text x="120" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="9">⚙ model routing · ▶ resume</text>
  <text x="120" y="172" text-anchor="middle" fill="var(--text-dim)" font-size="9">✎ rename · ✕ stop</text>

  <!-- Tab 2 -->
  <rect x="250" y="10" width="220" height="175" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="2"/>
  <text x="360" y="35" text-anchor="middle" fill="var(--cyan,#0dd)" font-size="12" font-weight="600">Tab 2: tests</text>
  <text x="360" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">cwd: ~/projects/my-project</text>
  <text x="360" y="75" text-anchor="middle" fill="var(--text-dim)" font-size="9">model: gemini-3.1-pro</text>
  <rect x="265" y="88" width="190" height="45" rx="4" fill="none" stroke="var(--text-dim)" stroke-width="0.8"/>
  <text x="270" y="105" fill="var(--text-dim)" font-size="9" font-family="monospace">$ write tests for auth.js</text>
  <text x="270" y="120" fill="var(--cyan,#0dd)" font-size="9" font-family="monospace">Creating test/auth.test.js</text>
  <text x="360" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="9">⚙ routed to Gemini</text>
  <text x="360" y="172" text-anchor="middle" fill="var(--text-dim)" font-size="9">independent session</text>

  <!-- Tab 3 — spawned from directory -->
  <rect x="490" y="10" width="220" height="175" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="600" y="35" text-anchor="middle" fill="var(--accent)" font-size="12" font-weight="600">>api-server</text>
  <text x="600" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">spawned from Directories tab</text>
  <text x="600" y="75" text-anchor="middle" fill="var(--text-dim)" font-size="9">model: deepseek-r1</text>
  <rect x="505" y="88" width="190" height="45" rx="4" fill="none" stroke="var(--text-dim)" stroke-width="0.8"/>
  <text x="510" y="105" fill="var(--text-dim)" font-size="9" font-family="monospace">$ debug the 500 error on /api</text>
  <text x="510" y="120" fill="var(--accent)" font-size="9" font-family="monospace">Reading server.js...</text>
  <text x="600" y="155" text-anchor="middle" fill="var(--text-dim)" font-size="9">green accent = directory spawn</text>
  <text x="600" y="172" text-anchor="middle" fill="var(--text-dim)" font-size="9">model routed via proxy</text>

  <!-- Bottom note -->
  <text x="360" y="198" text-anchor="middle" fill="var(--text-dim)" font-size="9">All tabs run concurrently. Each has its own model routing — changing settings in one never affects another.</text>
</svg>
\`\`\`

### Per-session model routing

Each tab has a **modelMap** that maps Claude tiers (opus/sonnet/haiku) to any provider's model:

\`\`\`svg
<svg viewBox="0 0 600 130" xmlns="http://www.w3.org/2000/svg" style="max-width:600px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="cl2" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- Claude request -->
  <rect x="10" y="30" width="120" height="50" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="70" y="52" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">claude -p</text>
  <text x="70" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="8">asks for "opus"</text>

  <line x1="130" y1="55" x2="188" y2="55" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cl2)"/>

  <!-- Model map -->
  <rect x="190" y="10" width="190" height="95" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="285" y="32" text-anchor="middle" fill="var(--green)" font-size="11" font-weight="600">modelMap</text>
  <text x="285" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="9">opus → gemini-3.1-pro</text>
  <text x="285" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="9">sonnet → gpt-5.4</text>
  <text x="285" y="84" text-anchor="middle" fill="var(--text-dim)" font-size="9">haiku → deepseek-v3.2</text>

  <line x1="380" y1="35" x2="438" y2="30" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cl2)"/>
  <line x1="380" y1="55" x2="438" y2="55" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cl2)"/>
  <line x1="380" y1="75" x2="438" y2="80" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cl2)"/>

  <!-- Providers -->
  <rect x="440" y="12" width="140" height="28" rx="5" fill="none" stroke="var(--text-dim)" stroke-width="1"/>
  <text x="510" y="30" text-anchor="middle" fill="var(--text-dim)" font-size="9">Google Gemini API</text>

  <rect x="440" y="44" width="140" height="28" rx="5" fill="none" stroke="var(--text-dim)" stroke-width="1"/>
  <text x="510" y="62" text-anchor="middle" fill="var(--text-dim)" font-size="9">OpenAI API</text>

  <rect x="440" y="76" width="140" height="28" rx="5" fill="none" stroke="var(--text-dim)" stroke-width="1"/>
  <text x="510" y="94" text-anchor="middle" fill="var(--text-dim)" font-size="9">DeepSeek API</text>

  <text x="300" y="125" text-anchor="middle" fill="var(--text-dim)" font-size="9">Leave an entry as null → forward to Anthropic as-is. Each tab maps independently.</text>
</svg>
\`\`\`
`;

  const rulesMd = `
# Proxy Rules

JavaScript middleware that intercepts every API request. Describe what you want in the **Rules** tab — vistaclair generates the JS. Hot-reloaded, toggleable, reorderable.

\`\`\`svg
<svg viewBox="0 0 720 100" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="ru1" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <!-- Pipeline -->
  <rect x="10" y="20" width="100" height="40" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="60" y="44" text-anchor="middle" fill="var(--text)" font-size="10">API request</text>

  <line x1="110" y1="40" x2="138" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#ru1)"/>

  <rect x="140" y="15" width="120" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="200" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 1</text>
  <text x="200" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">filter tools</text>

  <line x1="260" y1="40" x2="288" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#ru1)"/>

  <rect x="290" y="15" width="120" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="350" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 2</text>
  <text x="350" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">swap model</text>

  <line x1="410" y1="40" x2="438" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#ru1)"/>

  <rect x="440" y="15" width="120" height="50" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="500" y="36" text-anchor="middle" fill="var(--text)" font-size="9" font-weight="500">Rule 3</text>
  <text x="500" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">inject prompt</text>

  <line x1="560" y1="40" x2="588" y2="40" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#ru1)"/>

  <rect x="590" y="20" width="110" height="40" rx="6" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="645" y="44" text-anchor="middle" fill="var(--green)" font-size="10" font-weight="500">Provider</text>

  <text x="360" y="85" text-anchor="middle" fill="var(--text-dim)" font-size="9">Rules run in order, hot-reloaded on file change. Toggle on/off or drag to reorder in the Rules tab.</text>
</svg>
\`\`\`

## Writing a rule

\`\`\`javascript
// ctx.body — full API request body (mutable)
// ctx.isStreaming — SSE request?
// ctx.instanceId — which session sent it
module.exports = function(ctx) {
  if (ctx.body.model?.includes('opus')) {
    ctx.body.model = 'claude-sonnet-4-6-20250514';
  }
};
\`\`\`

Rules also support **response transforms** on SSE chunks streaming back from the provider.

## Creating rules from the UI

\`\`\`svg
<svg viewBox="0 0 700 100" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs>
    <marker id="ru2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker>
  </defs>

  <!-- Prompt -->
  <rect x="10" y="12" width="220" height="60" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="120" y="35" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">"Block rm, sudo, and any</text>
  <text x="120" y="50" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500"> destructive tools"</text>
  <text x="120" y="66" text-anchor="middle" fill="var(--text-dim)" font-size="9">describe in plain English</text>

  <!-- Arrow -->
  <line x1="230" y1="42" x2="298" y2="42" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ru2)"/>
  <text x="264" y="34" text-anchor="middle" fill="var(--text-dim)" font-size="8">generates</text>

  <!-- Generated rule -->
  <rect x="300" y="8" width="180" height="68" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="390" y="32" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">Proxy Rule .js</text>
  <text x="390" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="9">JavaScript middleware</text>
  <text x="390" y="64" text-anchor="middle" fill="var(--text-dim)" font-size="9">hot-reloaded · toggleable</text>

  <!-- Arrow -->
  <line x1="480" y1="42" x2="518" y2="42" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#ru2)"/>

  <!-- Editing -->
  <rect x="520" y="12" width="170" height="60" rx="8" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="605" y="35" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Edit source</text>
  <text x="605" y="52" text-anchor="middle" fill="var(--text-dim)" font-size="9">view + hand-edit the JS</text>
  <text x="605" y="66" text-anchor="middle" fill="var(--text-dim)" font-size="9">or regenerate from prompt</text>

  <text x="350" y="95" text-anchor="middle" fill="var(--text-dim)" font-size="9">Describe → Generate → Toggle on. Edit the source directly or regenerate from a new description.</text>
</svg>
\`\`\`

Type a description in the **Rules** tab. vistaclair generates JS and saves it to \`capabilities/proxy-rules/\`. Toggle on/off, drag to reorder, click to edit source.

## Built-in rules

| Rule | What it does | Default |
|------|-------------|---------|
| **Model Override** | Pin model version (\`opus-4-7\` → \`opus-4-6\`) | enabled |
| **Tool Filter** | Strip unsafe tools (CronCreate, RemoteTrigger, etc.) | enabled |
| **AUQ MCP Rewrite** | Route AskUserQuestion through dashboard | enabled |
| **Title Schema Shortcut** | Short-circuit title-generation requests | disabled |
`;

  const mcpMd = `
# MCP Tools

Define custom tools in the **MCP** tab — name, parameters, JS handler. Claude gets the capability instantly, no restart needed. All calls logged in the Inspector.

\`\`\`svg
<svg viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="mc1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- Claude process -->
  <rect x="10" y="55" width="120" height="55" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="70" y="78" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="70" y="96" text-anchor="middle" fill="var(--text-dim)" font-size="9">any session</text>

  <!-- MCP Server -->
  <rect x="210" y="15" width="200" height="140" rx="8" fill="none" stroke="var(--purple)" stroke-width="2"/>
  <text x="310" y="40" text-anchor="middle" fill="var(--purple)" font-size="13" font-weight="600">MCP Server</text>
  <text x="310" y="60" text-anchor="middle" fill="var(--text-dim)" font-size="9">auto-registered with every session</text>
  <text x="310" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="9">stdio transport · JSON-RPC</text>
  <text x="310" y="96" text-anchor="middle" fill="var(--text-dim)" font-size="9">Zod schema validation</text>
  <text x="310" y="114" text-anchor="middle" fill="var(--text-dim)" font-size="9">connectable by external clients</text>
  <text x="310" y="132" text-anchor="middle" fill="var(--text-dim)" font-size="9">all calls logged in Inspector</text>

  <!-- Custom handlers -->
  <rect x="490" y="15" width="190" height="55" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="585" y="38" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Your custom tools</text>
  <text x="585" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">JavaScript handlers you write</text>

  <!-- Built-in tools -->
  <rect x="490" y="85" width="190" height="70" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="585" y="106" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Built-in tools</text>
  <text x="585" y="124" text-anchor="middle" fill="var(--text-dim)" font-size="9">vista-AskUserQuestion</text>
  <text x="585" y="140" text-anchor="middle" fill="var(--text-dim)" font-size="9">chat (sub-session delegation)</text>

  <!-- Arrows -->
  <line x1="130" y1="82" x2="210" y2="82" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#mc1)"/>
  <text x="170" y="74" text-anchor="middle" fill="var(--text-dim)" font-size="8">tool_use</text>
  <line x1="410" y1="42" x2="490" y2="42" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#mc1)"/>
  <line x1="410" y1="110" x2="490" y2="118" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#mc1)"/>

  <!-- Dashboard logging -->
  <rect x="210" y="170" width="200" height="30" rx="6" fill="none" stroke="var(--green)" stroke-width="1" stroke-dasharray="3"/>
  <text x="310" y="190" text-anchor="middle" fill="var(--text-dim)" font-size="9">→ Tool calls appear in Inspector alongside API events</text>
</svg>
\`\`\`

## Workflow

\`\`\`svg
<svg viewBox="0 0 700 80" xmlns="http://www.w3.org/2000/svg" style="max-width:700px;font-family:system-ui,sans-serif">
  <defs><marker id="mc2" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <rect x="10" y="15" width="130" height="45" rx="6" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="75" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">Define tool</text>
  <text x="75" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">name, params, description</text>

  <line x1="140" y1="38" x2="168" y2="38" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#mc2)"/>

  <rect x="170" y="15" width="130" height="45" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="235" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">Write handler</text>
  <text x="235" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">async JS function</text>

  <line x1="300" y1="38" x2="328" y2="38" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#mc2)"/>

  <rect x="330" y="15" width="130" height="45" rx="6" fill="none" stroke="var(--green)" stroke-width="1.5"/>
  <text x="395" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">Auto-restart</text>
  <text x="395" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">server regenerated</text>

  <line x1="460" y1="38" x2="488" y2="38" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#mc2)"/>

  <rect x="490" y="15" width="130" height="45" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="555" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="500">Claude calls it</text>
  <text x="555" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">validated + logged</text>

  <text x="350" y="75" text-anchor="middle" fill="var(--text-dim)" font-size="9">Every tool call is validated by Zod schema. Results appear in the Inspector with inputs, outputs, and timing.</text>
</svg>
\`\`\`

## Handler example

\`\`\`javascript
const response = await fetch(url);
const text = await response.text();
return {
  content: [{ type: "text", text }]
};
\`\`\`

Handlers have access to Node.js built-ins (via \`import()\`), the dashboard WebSocket, and env vars.

## Built-in tools

| Tool | Purpose |
|------|---------|
| **vista-AskUserQuestion** | Routes Claude's questions through the dashboard UI. Always enabled. |
| **chat** | Spawn a sub-session via the API. Multi-turn via \`session_id\`, custom \`cwd\`. |
`;

  const connectMd = `
# Connect External Claude CLI

Point any Claude Code instance at vistaclair and its traffic appears in the Inspector.

## Method 1 — Transparent Proxy

\`\`\`bash
ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "your prompt"
\`\`\`

\`\`\`svg
<svg viewBox="0 0 720 120" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="cn1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--text-dim)"/></marker></defs>

  <!-- External CLI -->
  <rect x="10" y="25" width="150" height="60" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="2"/>
  <text x="85" y="50" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">External claude</text>
  <text x="85" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="9">ANTHROPIC_BASE_URL</text>
  <text x="85" y="80" text-anchor="middle" fill="var(--text-dim)" font-size="9">= localhost:3456</text>

  <line x1="160" y1="55" x2="228" y2="55" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#cn1)"/>
  <text x="194" y="47" text-anchor="middle" fill="var(--text-dim)" font-size="8">API calls</text>

  <!-- Proxy -->
  <rect x="230" y="15" width="200" height="80" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="330" y="40" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">vistaclair proxy</text>
  <text x="330" y="58" text-anchor="middle" fill="var(--text-dim)" font-size="9">records for Inspector</text>
  <text x="330" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="9">applies rules & routing</text>
  <text x="330" y="86" text-anchor="middle" fill="var(--text-dim)" font-size="9">auto-creates ext-N tab</text>

  <line x1="430" y1="55" x2="498" y2="55" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#cn1)"/>
  <text x="464" y="47" text-anchor="middle" fill="var(--text-dim)" font-size="8">forward</text>

  <!-- Provider -->
  <rect x="500" y="30" width="150" height="45" rx="6" fill="none" stroke="var(--purple)" stroke-width="1.5"/>
  <text x="575" y="57" text-anchor="middle" fill="var(--text)" font-size="11">Anthropic API</text>

  <!-- Note -->
  <text x="360" y="115" text-anchor="middle" fill="var(--text-dim)" font-size="9">Claude Code sees no difference. Traffic appears in a new ext-N tab in the Inspector.</text>
</svg>
\`\`\`

Works with interactive, programmatic (\`claude -p\`), and IDE sessions. For remote machines, tunnel the proxy port:

\`\`\`bash
cloudflared tunnel --url http://localhost:3456 --name proxy-tunnel
# Then: ANTHROPIC_BASE_URL=https://proxy-tunnel.your-domain.com claude -p "prompt"
\`\`\`

---

## Method 2 — MCP Bridge

Give external Claude access to vistaclair's MCP tools via stdio bridge.

\`\`\`svg
<svg viewBox="0 0 720 130" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="cn2" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <!-- External CLI -->
  <rect x="10" y="20" width="140" height="75" rx="8" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="80" y="45" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">External claude</text>
  <text x="80" y="63" text-anchor="middle" fill="var(--text-dim)" font-size="9">--mcp-config</text>
  <text x="80" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="9">points to bridge</text>

  <line x1="150" y1="58" x2="208" y2="58" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cn2)"/>
  <text x="180" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">stdio</text>

  <!-- Bridge -->
  <rect x="210" y="25" width="150" height="65" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="285" y="48" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">MCP Bridge</text>
  <text x="285" y="66" text-anchor="middle" fill="var(--text-dim)" font-size="9">lib/mcp-bridge.js</text>
  <text x="285" y="80" text-anchor="middle" fill="var(--text-dim)" font-size="9">stdio ↔ WebSocket</text>

  <line x1="360" y1="58" x2="418" y2="58" stroke="var(--text-dim)" stroke-width="1.2" marker-end="url(#cn2)"/>
  <text x="390" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="8">WebSocket</text>

  <!-- Dashboard -->
  <rect x="420" y="20" width="160" height="75" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="500" y="44" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">Dashboard</text>
  <text x="500" y="62" text-anchor="middle" fill="var(--text-dim)" font-size="9">MCP Server</text>
  <text x="500" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="9">custom + built-in tools</text>

  <!-- Inspector -->
  <rect x="600" y="30" width="100" height="50" rx="6" fill="none" stroke="var(--purple)" stroke-width="1"/>
  <text x="650" y="52" text-anchor="middle" fill="var(--text)" font-size="10">Inspector</text>
  <text x="650" y="68" text-anchor="middle" fill="var(--text-dim)" font-size="8">logs all calls</text>
  <line x1="580" y1="58" x2="600" y2="55" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#cn2)"/>

  <text x="360" y="120" text-anchor="middle" fill="var(--text-dim)" font-size="9">External Claude gains access to all MCP tools. Calls logged in Inspector.</text>
</svg>
\`\`\`

Add to \`.mcp.json\` or \`~/.claude.json\`:

\`\`\`json
{
  "mcpServers": {
    "vistaclair": {
      "command": "node",
      "args": ["/path/to/vistaclair/lib/mcp-bridge.js", "integrated"],
      "env": {
        "VISTACLAIR_AUTH_TOKEN": "<your-token>",
        "VISTACLAIR_DASHBOARD_PORT": "3457"
      }
    }
  }
}
\`\`\`

---

## Method 3 — REST API

Run chats programmatically from scripts, CI/CD, or custom integrations.

\`\`\`svg
<svg viewBox="0 0 720 110" xmlns="http://www.w3.org/2000/svg" style="max-width:720px;font-family:system-ui,sans-serif">
  <defs><marker id="cn3" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto"><polygon points="0 0,7 2.5,0 5" fill="var(--text-dim)"/></marker></defs>

  <!-- Client -->
  <rect x="10" y="15" width="140" height="70" rx="8" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <text x="80" y="40" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">Your script</text>
  <text x="80" y="58" text-anchor="middle" fill="var(--text-dim)" font-size="9">curl · Node.js · Python</text>
  <text x="80" y="72" text-anchor="middle" fill="var(--text-dim)" font-size="9">any HTTP client</text>

  <line x1="150" y1="50" x2="208" y2="50" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#cn3)"/>
  <text x="180" y="42" text-anchor="middle" fill="var(--text-dim)" font-size="8">POST /api/run</text>

  <!-- Dashboard API -->
  <rect x="210" y="10" width="200" height="80" rx="8" fill="none" stroke="var(--green)" stroke-width="2"/>
  <text x="310" y="35" text-anchor="middle" fill="var(--green)" font-size="12" font-weight="600">Dashboard :3457</text>
  <text x="310" y="55" text-anchor="middle" fill="var(--text-dim)" font-size="9">Bearer token auth</text>
  <text x="310" y="70" text-anchor="middle" fill="var(--text-dim)" font-size="9">SSE stream or JSON response</text>
  <text x="310" y="82" text-anchor="middle" fill="var(--text-dim)" font-size="9">multi-turn via sessionId</text>

  <line x1="410" y1="50" x2="468" y2="50" stroke="var(--text-dim)" stroke-width="1.5" marker-end="url(#cn3)"/>

  <!-- Claude -->
  <rect x="470" y="20" width="120" height="55" rx="6" fill="none" stroke="var(--cyan,#0dd)" stroke-width="1.5"/>
  <text x="530" y="44" text-anchor="middle" fill="var(--text)" font-size="11" font-weight="500">claude -p</text>
  <text x="530" y="60" text-anchor="middle" fill="var(--text-dim)" font-size="9">spawned by API</text>

  <line x1="590" y1="48" x2="618" y2="48" stroke="var(--text-dim)" stroke-width="1" marker-end="url(#cn3)"/>
  <rect x="620" y="25" width="80" height="40" rx="5" fill="none" stroke="var(--purple)" stroke-width="1"/>
  <text x="660" y="50" text-anchor="middle" fill="var(--text-dim)" font-size="9">LLM API</text>

  <text x="360" y="107" text-anchor="middle" fill="var(--text-dim)" font-size="9">Supports file uploads, AskUserQuestion handling, working directory selection, and session resume.</text>
</svg>
\`\`\`

\`\`\`bash
curl -N -X POST http://localhost:3457/api/run \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"chat","prompt":"List all TODO comments"}'
\`\`\`

SSE events: \`text\` (delta), \`ask\` (needs input), \`error\`, \`done\` (includes \`sessionId\` for multi-turn). Set \`"stream": false\` for JSON response.

---

## Auth & Ports

| Port | Binds to | Purpose |
|------|----------|---------|
| **:3456** | localhost | Proxy — intercepts Claude API calls |
| **:3457** | 0.0.0.0 | Dashboard — web UI, REST API, WebSocket |

Auth: \`Authorization: Bearer <token>\` header, or \`token=<token>\` cookie. Token printed on startup or set via \`AUTH_TOKEN\` env var.
`;


  // --- Render sections ---
  function renderSections() {
    const sections = {
      'home-overview': overviewMd,
      'home-inspector': inspectorMd,
      'home-rules': rulesMd,
      'home-mcp': mcpMd,
      'home-connect': connectMd,
    };
    for (const [id, md] of Object.entries(sections)) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('markdown-body');
        renderMarkdown(md.trim(), el);
      }
    }
  }

  if (document.readyState === 'complete') {
    renderSections();
  } else {
    window.addEventListener('load', renderSections);
  }
})();
