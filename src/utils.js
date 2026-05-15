const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
let _pty;
function getPty() {
  if (!_pty) _pty = require('node-pty');
  return _pty;
}

const os = require('os');

// --- Directory roots ---
// PACKAGE_ROOT: where bundled code lives (lib/, public/, templates/)
const PACKAGE_ROOT = path.dirname(__dirname);

// DATA_HOME: where runtime/user state goes (outputs/, interactions/, data/, capabilities/, mcp-servers/)
// - VISTACLAIR_HOME env var overrides everything
// - Global npm install (inside node_modules): defaults to ~/.vistaclair
// - Local dev (cloned repo): defaults to the package root (backward compatible)
const DATA_HOME = (function resolveDataHome() {
  if (process.env.VISTACLAIR_HOME) return path.resolve(process.env.VISTACLAIR_HOME);
  const sep = path.sep;
  if (PACKAGE_ROOT.includes(sep + 'node_modules' + sep) ||
      PACKAGE_ROOT.endsWith(sep + 'node_modules')) {
    return path.join(os.homedir(), '.vistaclair');
  }
  return PACKAGE_ROOT;
})();

let counter = 0;

const MIME_TYPES = {
  '.html': 'text/html', '.htm': 'text/html',
  '.json': 'application/json', '.js': 'text/javascript',
  '.css': 'text/css', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.ts': 'text/plain', '.tsx': 'text/plain',
  '.py': 'text/plain', '.rb': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain',
  '.yaml': 'text/plain', '.yml': 'text/plain', '.toml': 'text/plain', '.ini': 'text/plain',
  '.sh': 'text/plain', '.bash': 'text/plain', '.log': 'text/plain', '.env': 'text/plain',
};

function generateId() {
  return `req_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

// --- Shared claude spawn utilities ---

/**
 * Build CLI args from a profile/capabilities object.
 * Returns the base args array (caller adds --resume, --mcp-config, etc.).
 */
function buildClaudeArgs(profile, { skipTools, outputFormat = 'stream-json' } = {}) {
  const args = ['-p'];
  if (outputFormat === 'stream-json') {
    args.push('--verbose', '--output-format', 'stream-json');
  } else if (outputFormat === 'json') {
    args.push('--output-format', 'json');
  }
  if (!profile) return args;
  if (profile.permissionMode && profile.permissionMode !== 'default') {
    args.push('--permission-mode', profile.permissionMode);
  }
  if (!skipTools) {
    if (profile.allowedTools?.length > 0) {
      args.push('--allowedTools', ...profile.allowedTools);
    }
    // Allow integrated MCP tools unless the profile explicitly disables some
    const hasMcpDisabled = profile.disabledTools?.some(t => t.startsWith('mcp__'));
    if (!hasMcpDisabled) {
      args.push('--allowedTools', 'mcp__integrated__*');
    }
    if (profile.disabledTools?.length > 0) {
      args.push('--disallowedTools', ...profile.disabledTools);
    }
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
 * Build CLI args for interactive PTY mode.
 * No -p, --output-format, or --verbose flags.
 */
function buildCliArgs(settings) {
  const args = [];
  if (!settings) return args;
  if (settings.permissionMode && settings.permissionMode !== 'default') {
    args.push('--permission-mode', settings.permissionMode);
  }
  if (settings.allowedTools?.length > 0) {
    args.push('--allowedTools', ...settings.allowedTools);
  }
  if (settings.disabledTools?.length > 0) {
    args.push('--disallowedTools', ...settings.disabledTools);
  }
  if (settings.model) args.push('--model', settings.model);
  if (settings.effort) args.push('--effort', settings.effort);
  if (settings.disableSlashCommands) args.push('--disable-slash-commands');
  if (settings.bare) args.push('--bare');
  if (settings.maxTurns) args.push('--max-turns', String(settings.maxTurns));
  if (settings.maxBudgetUsd) args.push('--max-budget-usd', String(settings.maxBudgetUsd));
  if (settings.appendSystemPrompt) args.push('--append-system-prompt', settings.appendSystemPrompt);
  if (settings.systemPrompt) args.push('--system-prompt', settings.systemPrompt);
  return args;
}

/**
 * Spawn `claude` with the proxy URL injected into the environment.
 */
// Live tracking of running Claude processes
// Map<instanceId, { proc, instanceId, spawnedAt, status, sourceContext, cwd }>
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
  return Array.from(_activeProcesses.values()).map(({ instanceId, spawnedAt, status, cwd, sourceContext }) => ({
    instanceId, spawnedAt, status, cwd: cwd || null, tabId: sourceContext?.tabId || null,
  }));
}

function getInstanceContext(instanceId) {
  const entry = _activeProcesses.get(instanceId);
  return entry?.sourceContext || null;
}

function prepareLocalConfigDir(cwd) {
  const localConfigDir = path.join(cwd, '.claude');
  fs.mkdirSync(localConfigDir, { recursive: true });
  const globalCreds = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(globalCreds)) {
    fs.copyFileSync(globalCreds, path.join(localConfigDir, '.credentials.json'));
  }
  return localConfigDir;
}

function spawnClaude(args, { cwd, proxyPort, dashboardPort, authToken, instanceId, sourceContext, extraEnv, isolated }) {
  if (!instanceId) throw new Error('spawnClaude requires instanceId');
  const env = { ...process.env, ...extraEnv };
  if (proxyPort) {
    env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}/i/${encodeURIComponent(instanceId)}`;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (isolated !== false) env.CLAUDE_CONFIG_DIR = prepareLocalConfigDir(cwd);
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  if (dashboardPort) env.VISTACLAIR_DASHBOARD_PORT = String(dashboardPort);
  if (authToken) env.VISTACLAIR_AUTH_TOKEN = authToken;
  env.VISTACLAIR_INSTANCE_ID = instanceId;
  const proc = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  _activeProcesses.set(instanceId, { proc, instanceId, spawnedAt: Date.now(), status: 'running', sourceContext: sourceContext || null, cwd: cwd || null });
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

/**
 * Spawn `claude` in interactive PTY mode with the proxy URL injected.
 */
function spawnClaudePty(args, { cwd, proxyPort, instanceId, sourceContext, cols, rows, dashboardPort, authToken, extraEnv, isolated }) {
  if (!instanceId) throw new Error('spawnClaudePty requires instanceId');
  const env = { ...process.env, ...extraEnv };
  if (proxyPort) {
    env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}/i/${encodeURIComponent(instanceId)}`;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (isolated !== false) env.CLAUDE_CONFIG_DIR = prepareLocalConfigDir(cwd);
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  if (dashboardPort) env.VISTACLAIR_DASHBOARD_PORT = String(dashboardPort);
  if (authToken) env.VISTACLAIR_AUTH_TOKEN = authToken;
  env.VISTACLAIR_INSTANCE_ID = instanceId;

  const ptyProc = getPty().spawn('claude', args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env,
  });

  _activeProcesses.set(instanceId, { proc: ptyProc, instanceId, spawnedAt: Date.now(), status: 'running', sourceContext: sourceContext || null, cwd: cwd || null });
  _broadcastInstances('spawn', instanceId);
  ptyProc.onExit(() => {
    const entry = _activeProcesses.get(instanceId);
    if (entry && entry.proc === ptyProc) {
      entry.status = 'exited';
      _broadcastInstances('exit', instanceId);
    }
  });

  return ptyProc;
}

function killInstance(instanceId) {
  const entry = _activeProcesses.get(instanceId);
  if (!entry || entry.status !== 'running') return false;
  try { entry.proc.kill('SIGTERM'); } catch {}
  return true;
}

function removeInstances(instanceIds) {
  for (const id of instanceIds) {
    const entry = _activeProcesses.get(id);
    if (entry && entry.status !== 'running') _activeProcesses.delete(id);
  }
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

const OUTPUTS_DIR = path.join(DATA_HOME, 'outputs');

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
  if (interaction.requestHeaders) {
    clone.requestHeaders = { ...interaction.requestHeaders };
    for (const key of ['x-api-key', 'authorization']) {
      if (clone.requestHeaders[key]) {
        clone.requestHeaders[key] = '[redacted]';
      }
    }
  }
  return clone;
}

function listFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => {
        try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
      })
      .map(f => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, size: stat.size, mtime: stat.mtimeMs };
      });
  } catch { return []; }
}

// --- AskUserQuestion file upload processing ---

/**
 * Process uploaded files from an ask:answer message.
 * Saves files to outputs/_uploads/<toolUseId>/, patches the answer array with relative paths.
 * @param {string} toolUseId - The tool_use_id for namespacing
 * @param {Array} files - Array of { questionId, name, data } where data is a base64 data URL
 * @param {Array} answer - The answer array to patch (file-type entries get path arrays)
 * @returns {Array} The patched answer array
 */
function processUploadedFiles(toolUseId, files, answer) {
  if (!files || !files.length) return answer;

  const uploadDir = path.join(OUTPUTS_DIR, '_uploads', toolUseId);
  ensureDir(uploadDir);

  // Group files by questionId
  const byQuestion = {};
  for (const f of files) {
    if (!byQuestion[f.questionId]) byQuestion[f.questionId] = [];

    // Sanitize filename: strip path separators, limit length, allowlist chars
    let safeName = (f.name || 'file').replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (safeName.length > 200) safeName = safeName.slice(0, 200);

    // Decode base64 data URL
    const match = (f.data || '').match(/^data:[^;]*;base64,(.+)$/);
    if (!match) continue;

    const buffer = Buffer.from(match[1], 'base64');
    const filePath = path.join(uploadDir, safeName);
    fs.writeFileSync(filePath, buffer);

    // Relative path from project root (files live under outputs/)
    const relPath = `outputs/_uploads/${toolUseId}/${safeName}`;
    byQuestion[f.questionId].push(relPath);
  }

  // Patch answer entries
  if (Array.isArray(answer)) {
    for (const entry of answer) {
      if (byQuestion[entry.id]) {
        entry.answer = byQuestion[entry.id];
      }
    }
  }

  return answer;
}

// --- File placement for prompt attachments ---

/**
 * Place uploaded files directly into a working directory for Claude to read.
 * @param {string} cwd - Target directory (must already exist)
 * @param {Array} files - Array of { name, data } where data is a base64 data URL
 * @returns {string[]} Array of placed filenames (basenames only)
 */
function placeFilesInCwd(cwd, files) {
  if (!files || !files.length) return [];
  ensureDir(cwd);

  const placed = [];
  const prefix = Date.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Sanitize filename
    let safeName = (f.name || 'file').replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (safeName.length > 200) safeName = safeName.slice(0, 200);

    const uniqueName = `upload-${prefix}-${i}-${safeName}`;

    // Decode base64 data URL
    const match = (f.data || '').match(/^data:[^;]*;base64,(.+)$/);
    if (!match) continue;

    const buffer = Buffer.from(match[1], 'base64');
    const fullPath = path.join(cwd, uniqueName);
    fs.writeFileSync(fullPath, buffer);
    placed.push(fullPath);
  }
  return placed;
}

/**
 * Augment a prompt with instructions to read attached files.
 * @param {string} prompt - Original user prompt
 * @param {string[]} filenames - Array of filenames placed in CWD
 * @returns {string} Augmented prompt (or original if no files)
 */
function augmentPromptWithFiles(prompt, filenames) {
  if (!filenames || filenames.length === 0) return prompt;
  const fileList = filenames.map(f => `- ${f}`).join('\n');
  return `[Files have been placed in your working directory. You MUST read them using the Read tool before responding:\n${fileList}\n]\n\n${prompt}`;
}

module.exports = {
  generateId,
  filterRequestHeaders,
  filterResponseHeaders,
  sanitizeForDashboard,
  buildClaudeArgs,
  spawnClaude,
  buildCliArgs,
  spawnClaudePty,
  setProcessBroadcaster,
  getActiveProcessCount,
  getInstances,
  getInstanceContext,
  killInstance,
  removeInstances,
  createStreamJsonParser,
  MIME_TYPES,
  PACKAGE_ROOT,
  DATA_HOME,
  OUTPUTS_DIR,
  resolveOutputDir,
  ensureDir,
  readJSON,
  writeJSON,
  listFiles,
  processUploadedFiles,
  placeFilesInCwd,
  augmentPromptWithFiles,
};
