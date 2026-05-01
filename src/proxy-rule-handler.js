const path = require('path');
const fs = require('fs');
const caps = require('./capabilities');
const { buildClaudeArgs, spawnClaude, ensureDir, generateId } = require('./utils');

const PROJECT_ROOT = path.dirname(__dirname);

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

      case 'rule:toggle':
        if (caps.toggleProxyRule(PROJECT_ROOT, msg.id, msg.enabled)) {
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
        }
        break;

      case 'rule:delete':
        if (caps.deleteProxyRule(PROJECT_ROOT, msg.id)) {
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
        }
        break;

      case 'rule:reorder':
        if (Array.isArray(msg.ids) && caps.reorderProxyRules(PROJECT_ROOT, msg.ids)) {
          bc.broadcast({ type: 'rule:list', rules: caps.listProxyRules(PROJECT_ROOT) });
        }
        break;

      case 'rule:source': {
        const source = caps.readProxyRuleSource(PROJECT_ROOT, msg.id);
        if (source !== null) {
          send({ type: 'rule:source', id: msg.id, source });
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
  // ctx.body           - the request body (mutable object — modify in place)
  // ctx.isStreaming     - boolean, true if body.stream is set
  // ctx.profileName    - string or null (name of the active profile)
  // ctx.profileData    - resolved profile object or null
  // ctx.instanceId     - string or null (Claude session instance ID)
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
  //
  // Return true if the response was already sent (short-circuit — no upstream API call).
  // Return false or undefined to let the request continue to the next rule or upstream.
  //
  // IMPORTANT:
  // - To modify the request, mutate ctx.body directly (e.g. ctx.body.system = 'new prompt')
  // - To filter tools, modify ctx.body.tools array
  // - To short-circuit, call ctx.helpers.sendDummyResponse(ctx, {...}) then return true
  // - NEVER use require() for external npm modules — only Node built-ins
  // - Keep the function synchronous unless you need to await something
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

Filtering tools:
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

Modifying system prompt:
module.exports = function(ctx) {
  if (ctx.body.system && typeof ctx.body.system === 'string') {
    ctx.body.system += '\\n\\nAlways respond in French.';
  }
};

## Output

Write the rule module to: ${targetPath}
Write metadata JSON to: ${metaPath}

The metadata JSON must have exactly these fields:
{
  "name": "Human-Readable Name (2-5 words, title case)",
  "slug": "One sentence describing what this rule does"
}

Use the Write tool to create both files. Write ONLY valid JavaScript (no markdown fences) to the .js file, and ONLY valid JSON to the .meta.json file.`;

    const args = buildClaudeArgs(caps.loadProfile(PROJECT_ROOT, 'full'));
    const proc = spawnClaude(args, {
      cwd: PROJECT_ROOT,
      proxyPort: opts.proxyPort || 3456,
      profileName: 'full',
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

    const args = buildClaudeArgs(caps.loadProfile(PROJECT_ROOT, 'full'));
    const proc = spawnClaude(args, {
      cwd: PROJECT_ROOT,
      proxyPort: opts.proxyPort || 3456,
      profileName: 'full',
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
