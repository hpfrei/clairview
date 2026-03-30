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
  if (profile.disabledTools?.length > 0) {
    args.push('--disallowedTools', ...profile.disabledTools);
  }
  if (profile.model) args.push('--model', profile.model);
  if (profile.effort) args.push('--effort', profile.effort);
  if (profile.disableSlashCommands) args.push('--disable-slash-commands');
  if (profile.maxTurns) args.push('--max-turns', String(profile.maxTurns));
  if (profile.maxBudgetUsd) args.push('--max-budget-usd', String(profile.maxBudgetUsd));
  if (profile.appendSystemPrompt) args.push('--append-system-prompt', profile.appendSystemPrompt);
  if (profile.systemPrompt) args.push('--system-prompt', profile.systemPrompt);
  return args;
}

/**
 * Spawn `claude` with the proxy URL injected into the environment.
 */
function spawnClaude(args, { cwd, proxyPort, direct, modelName }) {
  const env = { ...process.env };
  if (proxyPort) {
    if (direct) {
      env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}/direct`;
    } else if (modelName) {
      env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}/use-model/${modelName}`;
    } else {
      env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}`;
    }
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  return spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const clean = (userPath || '').replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
  // path.resolve against outputs dir; strip leading / so it's treated as relative
  const stripped = clean.replace(/^[/\\]+/, '');
  const resolved = stripped ? path.join(OUTPUTS_DIR, stripped) : OUTPUTS_DIR;
  // Final containment check
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
  createStreamJsonParser,
  OUTPUTS_DIR,
  resolveOutputDir,
  ensureDir,
  readJSON,
  writeJSON,
};
