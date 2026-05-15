const path = require('path');
const fs = require('fs');
const caps = require('./capabilities');
const { buildClaudeArgs, spawnClaude, ensureDir, generateId, DATA_HOME } = require('./utils');

const PROJECT_ROOT = DATA_HOME;

let opts = {};
let broadcaster = null;

function init(options) {
  opts = options;
  broadcaster = options.broadcaster;
  broadcaster.ruleHandler = { onConnect, handleMessage };
}

function onConnect(ws) {
  ws.send(JSON.stringify({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) }));
}

async function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));

  try {
    switch (msg.type) {
      case 'rule:list':
        send({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
        break;

      case 'rule:create': {
        if (!msg.description?.trim()) {
          send({ type: 'rule:error', error: 'Description is required' });
          break;
        }
        send({ type: 'rule:generating' });
        try {
          const result = await generateProxyRule(msg.description.trim());
          caps.addProxyRule(PROJECT_ROOT, result.id, result.name, result.slug, result.source);
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
          bc.broadcast({ type: 'rule:generated', rule: { id: result.id, name: result.name, slug: result.slug, enabled: true } });
        } catch (err) {
          send({ type: 'rule:error', error: `Rule creation failed: ${err.message}` });
        }
        break;
      }

      case 'rule:edit': {
        if (!msg.id || !msg.description?.trim()) {
          send({ type: 'rule:error', error: 'Rule ID and description are required' });
          break;
        }
        send({ type: 'rule:generating', id: msg.id });
        try {
          const result = await editProxyRule(msg.id, msg.description.trim());
          caps.updateProxyRule(PROJECT_ROOT, msg.id, result.name, result.slug, result.source);
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
        } catch (err) {
          send({ type: 'rule:error', error: `Rule edit failed: ${err.message}` });
        }
        break;
      }

      case 'rule:toggle': {
        if (caps.toggleProxyRule(PROJECT_ROOT, msg.id, msg.enabled)) {
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
        }
        break;
      }

      case 'rule:delete': {
        const delRule = caps.listProxyRules(PROJECT_ROOT).find(r => r.id === msg.id);
        if (delRule?.builtin) {
          send({ type: 'rule:error', error: 'Cannot delete built-in rule.' });
          break;
        }
        if (caps.deleteProxyRule(PROJECT_ROOT, msg.id)) {
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
        }
        break;
      }

      case 'rule:restore': {
        if (!msg.id || !caps.isValidRuleId(msg.id)) {
          send({ type: 'rule:error', error: 'Invalid rule ID' });
          break;
        }
        const origPath = path.join(PROJECT_ROOT, 'capabilities', 'proxy-rules', `${msg.id}.original.js`);
        if (!fs.existsSync(origPath)) {
          send({ type: 'rule:error', error: 'No original version found for this rule.' });
          break;
        }
        const origSource = fs.readFileSync(origPath, 'utf-8');
        if (caps.updateProxyRule(PROJECT_ROOT, msg.id, null, null, origSource)) {
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
          send({ type: 'rule:restored', id: msg.id });
        } else {
          send({ type: 'rule:error', error: `Rule not found: ${msg.id}` });
        }
        break;
      }

      case 'rule:reorder':
        if (Array.isArray(msg.ids) && caps.reorderProxyRules(PROJECT_ROOT, msg.ids)) {
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
        }
        break;

      case 'rule:source': {
        const source = caps.readProxyRuleSource(PROJECT_ROOT, msg.id);
        if (source !== null) {
          const srcRule = caps.listProxyRules(PROJECT_ROOT).find(r => r.id === msg.id);
          send({ type: 'rule:source', id: msg.id, source, builtin: !!srcRule?.builtin });
        } else {
          send({ type: 'rule:error', error: `Rule source not found: ${msg.id}` });
        }
        break;
      }

      case 'rule:save': {
        if (!msg.id || typeof msg.source !== 'string') {
          send({ type: 'rule:error', error: 'Rule ID and source are required' });
          break;
        }
        try {
          new Function(msg.source);
        } catch (e) {
          send({ type: 'rule:error', error: `Syntax error: ${e.message}` });
          break;
        }
        if (caps.updateProxyRule(PROJECT_ROOT, msg.id, null, null, msg.source)) {
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
          send({ type: 'rule:saved', id: msg.id });
        } else {
          send({ type: 'rule:error', error: `Rule not found: ${msg.id}` });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Rule handler error:', err);
    send({ type: 'rule:error', error: err.message });
  }
}

const RULE_CONTRACT = `The file must export a single function(ctx):

module.exports = function(ctx) {
  // ctx.body           - the Anthropic Messages API request body (mutable — modify in place)
  // ctx.isStreaming     - boolean, true if body.stream is set
  // ctx.instanceId     - string or null (Claude session instance ID from the URL path)
  // ctx.isInternalInstance - true if the CLI was spawned by the dashboard, false for external CLIs connecting to the proxy
  // ctx.req            - Express request object
  // ctx.res            - Express response object (for short-circuit rules)
  // ctx.interaction    - interaction tracking object
  // ctx.store          - interaction store
  // ctx.broadcaster    - WebSocket broadcaster
  // ctx.helpers.generateId()        - generate a unique ID string
  // ctx.helpers.sendDummyResponse(ctx, { text, model?, usage? })
  //     Send a fake Anthropic API response without making an upstream call.
  //     Handles both streaming (SSE) and non-streaming (JSON) modes automatically.
  //     Sets interaction status to complete.
  // ctx.helpers.parseSSEString(str) - parse "event: ...\\ndata: ...\\n\\n" into {eventType, data}
  // ctx.helpers.trackSSEEvent(event, interaction, activeToolBlocks, broadcaster, instanceId)
  // ctx.helpers.enhancedAskTool     - enhanced AskUserQuestion tool schema object
  //
  // Return values:
  //   return true              → short-circuit (response already sent, skip upstream)
  //   return undefined/false   → continue to upstream (no response hooks)
  //   return { transformSSE?, transformBody? }
  //                            → continue to upstream, apply hooks to the response
  //
  // Response hooks (returned in an object):
  //   transformSSE(eventStr)   - called per SSE line in streaming responses.
  //                              Must return the (possibly modified) string.
  //   transformBody(body)      - called with the parsed JSON body for non-streaming responses.
  //                              Must return the (possibly modified) object.
  //
  // IMPORTANT:
  // - To modify the request, mutate ctx.body directly (e.g. ctx.body.system = 'new prompt')
  // - To filter tools, modify ctx.body.tools array
  // - To short-circuit, call ctx.helpers.sendDummyResponse(ctx, {...}) then return true
  // - To transform responses, return { transformSSE(str){...}, transformBody(obj){...} }
  // - NEVER use require() for external npm modules — only Node built-ins
  // - Keep the function synchronous unless you need to await something
};

## Anthropic Messages API — request body shape

ctx.body follows the Anthropic /v1/messages format:
- model: string (e.g. "claude-sonnet-4-20250514")
- max_tokens: number
- system: string OR array of { type: "text", text: "..." } blocks (handle BOTH forms)
- messages: array of { role: "user"|"assistant", content: string | array of content blocks }
  Content blocks: { type: "text", text }, { type: "image", source: { type, data, media_type } },
                  { type: "tool_use", id, name, input }, { type: "tool_result", tool_use_id, content }
- tools: array of { name, description, input_schema } — the tools available to the model
- stream: boolean

## Existing rules (read for reference)

Existing rule files live in capabilities/proxy-rules/*.js — read them to see real-world patterns.
Key examples:
- auq-mcp-rewrite.js: renames tools in requests and responses (uses transformSSE + transformBody)
- unsafe-tool-filter.js: filters tools from ctx.body.tools
- title-schema-shortcut.js: short-circuits with sendDummyResponse based on output_config`;

const RULE_EXAMPLES = `Filtering tools:
module.exports = function(ctx) {
  if (Array.isArray(ctx.body.tools)) {
    ctx.body.tools = ctx.body.tools.filter(t => t.name !== 'DangerousTool');
  }
};

Short-circuiting (skipping the API call):
module.exports = function(ctx) {
  if (someCondition(ctx.body)) {
    ctx.helpers.sendDummyResponse(ctx, { text: '{"result":"handled"}' });
    return true;
  }
};

Modifying system prompt (handle both string and array forms):
module.exports = function(ctx) {
  const extra = '\\nAlways respond in French.';
  if (typeof ctx.body.system === 'string') {
    ctx.body.system += extra;
  } else if (Array.isArray(ctx.body.system)) {
    ctx.body.system.push({ type: 'text', text: extra });
  }
};

Scoping to internal CLIs only (skip external CLIs connecting to the proxy):
module.exports = function(ctx) {
  if (!ctx.isInternalInstance) return;
  // ... rule logic that should only apply to dashboard-spawned CLIs
};

Transforming responses (request + response in one rule):
module.exports = function(ctx) {
  // request-side: filter a tool from the request
  if (Array.isArray(ctx.body.tools)) {
    ctx.body.tools = ctx.body.tools.filter(t => t.name !== 'OldTool');
  }
  // response-side: rename tool in SSE stream and non-streaming body
  return {
    transformSSE(eventStr) {
      return eventStr.replace('"OldTool"', '"NewTool"');
    },
    transformBody(body) {
      if (body?.content) {
        for (const block of body.content) {
          if (block.name === 'OldTool') block.name = 'NewTool';
        }
      }
      return body;
    },
  };
};`;

function generateProxyRule(description) {
  return new Promise((resolve, reject) => {
    const id = 'rule-' + generateId().slice(0, 8);
    const rulesDir = path.join(PROJECT_ROOT, 'capabilities', 'proxy-rules');
    ensureDir(rulesDir);
    const targetPath = path.join(rulesDir, `${id}.js`);
    const metaPath = path.join(rulesDir, `${id}.meta.json`);

    try { fs.unlinkSync(targetPath); } catch {}
    try { fs.unlinkSync(metaPath); } catch {}

    const prompt = `You are creating a proxy rule for VistaClair — a middleware function that intercepts Anthropic API requests flowing through the proxy.

## Task

Create a proxy rule based on this description:

"${description}"

## Module Contract

${RULE_CONTRACT}

## Examples

${RULE_EXAMPLES}

## Output

Write the rule module to: ${targetPath}
Write metadata JSON to: ${metaPath}

The metadata JSON must have exactly these fields:
{
  "name": "Human-Readable Name (2-5 words, title case)",
  "slug": "One sentence describing what this rule does"
}

Use the Write tool to create both files. Write ONLY valid JavaScript (no markdown fences) to the .js file, and ONLY valid JSON to the .meta.json file.`;

    const args = buildClaudeArgs({ permissionMode: 'bypassPermissions', allowedTools: [...caps.KNOWN_TOOLS] });
    const proc = spawnClaude(args, {
      cwd: PROJECT_ROOT,
      proxyPort: opts.proxyPort || 3456,
      instanceId: `rule-gen-${Date.now()}`,
    });

    const genTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 300000);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stderrBuf = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });

    proc.on('close', (code) => {
      clearTimeout(genTimeout);

      if (!fs.existsSync(targetPath)) {
        const detail = stderrBuf.trim() ? `: ${stderrBuf.trim()}` : '';
        reject(new Error(`Generation produced no rule file (exit ${code})${detail}`));
        return;
      }

      try {
        require(targetPath);
      } catch (e) {
        reject(new Error(`Generated rule has syntax errors: ${e.message}`));
        return;
      }

      let name = 'Untitled Rule';
      let slug = description.slice(0, 100);
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.name) name = meta.name;
          if (meta.slug) slug = meta.slug;
        } catch {}
        try { fs.unlinkSync(metaPath); } catch {}
      }

      const source = fs.readFileSync(targetPath, 'utf-8');
      try { fs.unlinkSync(targetPath); } catch {}

      resolve({ id, name, slug, source });
    });

    proc.on('error', (err) => {
      clearTimeout(genTimeout);
      reject(new Error(`Generation failed: ${err.message}`));
    });
  });
}

function editProxyRule(id, description) {
  return new Promise((resolve, reject) => {
    const existingSource = caps.readProxyRuleSource(PROJECT_ROOT, id);
    if (!existingSource) {
      reject(new Error(`Rule not found: ${id}`));
      return;
    }

    const rulesDir = path.join(PROJECT_ROOT, 'capabilities', 'proxy-rules');
    const targetPath = path.join(rulesDir, `${id}.js`);
    const metaPath = path.join(rulesDir, `${id}.meta.json`);
    try { fs.unlinkSync(metaPath); } catch {}

    const prompt = `You are editing an existing proxy rule for VistaClair.

## Current Rule Source

\`\`\`javascript
${existingSource}
\`\`\`

## Requested Change

"${description}"

## Module Contract

${RULE_CONTRACT}

## Examples

${RULE_EXAMPLES}

## Output

Rewrite the rule to incorporate the requested change. Keep any existing behavior that isn't explicitly being changed.

Write the updated rule to: ${targetPath}
Write updated metadata JSON to: ${metaPath}

The metadata JSON must have exactly these fields:
{
  "name": "Human-Readable Name (2-5 words, title case)",
  "slug": "One sentence describing what this updated rule does"
}

Use the Write tool to create both files. Write ONLY valid JavaScript (no markdown fences) to the .js file, and ONLY valid JSON to the .meta.json file.`;

    const args = buildClaudeArgs({ permissionMode: 'bypassPermissions', allowedTools: [...caps.KNOWN_TOOLS] });
    const proc = spawnClaude(args, {
      cwd: PROJECT_ROOT,
      proxyPort: opts.proxyPort || 3456,
      instanceId: `rule-edit-${Date.now()}`,
    });

    const genTimeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 300000);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stderrBuf = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });

    proc.on('close', (code) => {
      clearTimeout(genTimeout);

      if (!fs.existsSync(targetPath)) {
        const detail = stderrBuf.trim() ? `: ${stderrBuf.trim()}` : '';
        reject(new Error(`Edit produced no rule file (exit ${code})${detail}`));
        return;
      }

      delete require.cache[require.resolve(targetPath)];
      try {
        require(targetPath);
      } catch (e) {
        reject(new Error(`Edited rule has syntax errors: ${e.message}`));
        return;
      }

      const rules = caps.listProxyRules(PROJECT_ROOT);
      const existing = rules.find(r => r.id === id);
      let name = existing?.name || 'Untitled Rule';
      let slug = existing?.slug || description.slice(0, 100);
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.name) name = meta.name;
          if (meta.slug) slug = meta.slug;
        } catch {}
        try { fs.unlinkSync(metaPath); } catch {}
      }

      const source = fs.readFileSync(targetPath, 'utf-8');
      resolve({ id, name, slug, source });
    });

    proc.on('error', (err) => {
      clearTimeout(genTimeout);
      reject(new Error(`Edit failed: ${err.message}`));
    });
  });
}

module.exports = { init, onConnect, handleMessage };
