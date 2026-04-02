const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let counter = 0;

function generateId() {
  return `req_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

// --- Shared claude spawn utilities ---

/**
 * Build CLI args from a profile/capabilities object.
 * Returns the base args array (caller adds --resume, --mcp-config, etc.).
 */
function buildClaudeArgs(profile) {
  const args = ['-p', '--verbose', '--output-format', 'stream-json'];
  if (!profile) return args;
  if (profile.permissionMode && profile.permissionMode !== 'default') {
    args.push('--permission-mode', profile.permissionMode);
  }
  if (profile.allowedTools?.length > 0) {
    args.push('--allowedTools', ...profile.allowedTools);
  }
  // Always allow integrated MCP tools so workflow tools don't require manual approval
  args.push('--allowedTools', 'mcp__integrated__*');
  if (profile.disabledTools?.length > 0) {
    args.push('--disallowedTools', ...profile.disabledTools);
  }
  if (profile.model) args.push('--model', profile.model);
  if (profile.effort) args.push('--effort', profile.effort);
  if (profile.disableSlashCommands) args.push('--disable-slash-commands');
  if (profile.bare) args.push('--bare');
  if (profile.maxTurns) args.push('--max-turns', String(profile.maxTurns));
  if (profile.maxBudgetUsd) args.push('--max-budget-usd', String(profile.maxBudgetUsd));
  if (profile.appendSystemPrompt) args.push('--append-system-prompt', profile.appendSystemPrompt);
  if (profile.systemPrompt) args.push('--system-prompt', profile.systemPrompt);
  return args;
}

/**
 * Spawn `claude` with the proxy URL injected into the environment.
 */
// Live tracking of running Claude processes
// Map<instanceId, { proc, instanceId, profileName, spawnedAt, status }>
const _activeProcesses = new Map();
let _processBroadcaster = null;
function setProcessBroadcaster(broadcaster) { _processBroadcaster = broadcaster; }
function getActiveProcessCount() {
  let count = 0;
  for (const entry of _activeProcesses.values()) {
    if (entry.status === 'running') count++;
  }
  return count;
}

function getInstances() {
  return Array.from(_activeProcesses.values()).map(({ instanceId, profileName, spawnedAt, status }) => ({
    instanceId, profileName, spawnedAt, status,
  }));
}

function getInstanceContext(instanceId) {
  const entry = _activeProcesses.get(instanceId);
  return entry?.sourceContext || null;
}

function spawnClaude(args, { cwd, proxyPort, profileName, disableAutoMemory, dashboardPort, authToken, instanceId, sourceContext }) {
  if (!instanceId) throw new Error('spawnClaude requires instanceId');
  const env = { ...process.env };
  if (proxyPort) {
    const profile = profileName ? `/p/${encodeURIComponent(profileName)}` : '';
    const instance = `/i/${encodeURIComponent(instanceId)}`;
    env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}${profile}${instance}`;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (disableAutoMemory) {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }
  if (dashboardPort) env.CLAIRVIEW_DASHBOARD_PORT = String(dashboardPort);
  if (authToken) env.CLAIRVIEW_AUTH_TOKEN = authToken;
  env.CLAIRVIEW_INSTANCE_ID = instanceId;
  const proc = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  _activeProcesses.set(instanceId, { proc, instanceId, profileName, spawnedAt: Date.now(), status: 'running', sourceContext: sourceContext || null });
  _broadcastInstances('spawn', instanceId);
  proc.on('exit', () => {
    const entry = _activeProcesses.get(instanceId);
    // Only mark exited if this proc is still the current one (avoids race on respawn)
    if (entry && entry.proc === proc) {
      entry.status = 'exited';
      _broadcastInstances('exit', instanceId);
    }
  });

  return proc;
}

function killInstance(instanceId) {
  const entry = _activeProcesses.get(instanceId);
  if (!entry || entry.status !== 'running') return false;
  try { entry.proc.kill('SIGTERM'); } catch {}
  return true;
}

function _broadcastInstances(event, instanceId) {
  if (_processBroadcaster) {
    const instances = getInstances();
    const count = instances.filter(i => i.status === 'running').length;
    _processBroadcaster.broadcast({ type: 'claude:instances', event, instanceId, instances, count });
    // Backward compat
    _processBroadcaster.broadcast({ type: 'claude:count', count });
  }
}

/**
 * Create a stream-json line parser.
 * Buffers chunks, splits on newlines, JSON.parses each complete line.
 * Calls onEvent(event) for valid JSON, onRaw(line) for non-JSON lines.
 * Returns { write(chunk), flush() → lastEvent? }.
 */
function createStreamJsonParser(onEvent, onRaw) {
  let buffer = '';
  return {
    write(chunk) {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
          if (onRaw) onRaw(line);
        }
      }
    },
    flush() {
      if (!buffer.trim()) return null;
      const remaining = buffer;
      buffer = '';
      try {
        const event = JSON.parse(remaining);
        onEvent(event);
        return event;
      } catch {
        if (onRaw) onRaw(remaining);
        return null;
      }
    },
  };
}

// --- Output directory sandboxing ---

const OUTPUTS_DIR = path.join(path.dirname(__dirname), 'outputs');

/**
 * Resolve a user-provided path into the outputs sandbox.
 * Any path (absolute or relative) is treated as relative to OUTPUTS_DIR.
 * Path traversal (../) is stripped. The resolved directory is created if needed.
 * Returns the absolute path inside outputs/.
 */
function resolveOutputDir(userPath) {
  if (!userPath) { ensureDir(OUTPUTS_DIR); return OUTPUTS_DIR; }
  // If already an absolute path inside outputs/, use it directly
  const normalized = path.resolve(userPath);
  if (normalized.startsWith(OUTPUTS_DIR)) {
    ensureDir(normalized);
    return normalized;
  }
  // Otherwise treat as relative to OUTPUTS_DIR (strip traversal and leading slashes)
  const clean = userPath.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
  const stripped = clean.replace(/^[/\\]+/, '');
  const resolved = stripped ? path.join(OUTPUTS_DIR, stripped) : OUTPUTS_DIR;
  if (!resolved.startsWith(OUTPUTS_DIR)) return OUTPUTS_DIR;
  ensureDir(resolved);
  return resolved;
}

// --- File I/O utilities ---

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filePath, defaultValue = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const FORWARD_REQUEST_HEADERS = [
  'x-api-key',
  'authorization',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
];

const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'request-id',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
];

function filterRequestHeaders(headers) {
  const out = {};
  for (const key of FORWARD_REQUEST_HEADERS) {
    if (headers[key]) out[key] = headers[key];
  }
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const key of FORWARD_RESPONSE_HEADERS) {
    const val = headers.get ? headers.get(key) : headers[key];
    if (val) out[key] = val;
  }
  return out;
}

function sanitizeForDashboard(interaction) {
  // Only deep-clone messages (which may contain base64 image data to truncate).
  // Other fields are passed by shallow copy to avoid expensive serialization of large sseEvents arrays.
  const clone = { ...interaction };
  clone.response = { ...interaction.response };
  clone.timing = { ...interaction.timing };
  if (interaction.usage) clone.usage = { ...interaction.usage };
  if (interaction.request) {
    clone.request = { ...interaction.request };
    if (interaction.request.messages) {
      clone.request.messages = interaction.request.messages.map(msg => {
        if (!Array.isArray(msg.content)) return msg;
        const hasImage = msg.content.some(b => b.type === 'image' && b.source?.data);
        if (!hasImage) return msg;
        return {
          ...msg,
          content: msg.content.map(block => {
            if (block.type === 'image' && block.source?.data) {
              return { ...block, source: { ...block.source, data: block.source.data.slice(0, 100) + '...[truncated]' } };
            }
            return block;
          }),
        };
      });
    }
  }
  return clone;
}

module.exports = {
  generateId,
  filterRequestHeaders,
  filterResponseHeaders,
  sanitizeForDashboard,
  buildClaudeArgs,
  spawnClaude,
  setProcessBroadcaster,
  getActiveProcessCount,
  getInstances,
  getInstanceContext,
  killInstance,
  createStreamJsonParser,
  OUTPUTS_DIR,
  resolveOutputDir,
  ensureDir,
  readJSON,
  writeJSON,
};
