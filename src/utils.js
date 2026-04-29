const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
};

function generateId() {
  return `req_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

// --- Shared claude spawn utilities ---

/**
 * Build CLI args from a profile/capabilities object.
 * Returns the base args array (caller adds --resume, --mcp-config, etc.).
 */
function buildClaudeArgs(profile, { skipTools } = {}) {
  const args = ['-p', '--verbose', '--output-format', 'stream-json'];
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

function spawnClaude(args, { cwd, proxyPort, profileName, disableAutoMemory, dashboardPort, authToken, instanceId, sourceContext, extraEnv }) {
  if (!instanceId) throw new Error('spawnClaude requires instanceId');
  const env = { ...process.env, ...extraEnv };
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
  if (dashboardPort) env.VISTACLAIR_DASHBOARD_PORT = String(dashboardPort);
  if (authToken) env.VISTACLAIR_AUTH_TOKEN = authToken;
  env.VISTACLAIR_INSTANCE_ID = instanceId;
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

    // Relative path from project root
    const relPath = `_uploads/${toolUseId}/${safeName}`;
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

/**
 * Collect output files from a workflow's working directory, excluding uploaded input files.
 * Returns base64 data URL objects matching the input file format for symmetry.
 * @param {string} cwd - Working directory to scan
 * @returns {Array<{ name: string, data: string, mimeType: string, size: number }>}
 */
function collectOutputFiles(cwd) {
  const MAX_FILE_SIZE = 10 * 1024 * 1024;   // 10 MB per file
  const MAX_TOTAL_SIZE = 50 * 1024 * 1024;  // 50 MB total

  if (!cwd || !fs.existsSync(cwd)) return [];

  const results = [];
  let totalSize = 0;

  let entries;
  try { entries = fs.readdirSync(cwd); } catch { return []; }

  for (const name of entries) {
    if (name.startsWith('upload-')) continue;

    const fullPath = path.join(cwd, name);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE) continue;
      if (totalSize + stat.size > MAX_TOTAL_SIZE) continue;

      const ext = path.extname(name).toLowerCase();
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      const buffer = fs.readFileSync(fullPath);
      const base64 = buffer.toString('base64');

      results.push({
        name,
        data: `data:${mimeType};base64,${base64}`,
        mimeType,
        size: stat.size,
      });
      totalSize += stat.size;
    } catch {
      continue;
    }
  }
  return results;
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
  removeInstances,
  createStreamJsonParser,
  MIME_TYPES,
  OUTPUTS_DIR,
  resolveOutputDir,
  ensureDir,
  readJSON,
  writeJSON,
  listFiles,
  processUploadedFiles,
  placeFilesInCwd,
  augmentPromptWithFiles,
  collectOutputFiles,
};
