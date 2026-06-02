const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureDir, safeJoin, readJSON, writeJSON } = require('./utils');
const secretStore = require('./secret-store');

const KNOWN_TOOLS = [
  'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep',
  'Bash',
  'Agent', 'Skill',
  'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'TaskStop',
  'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'AskUserQuestion',
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
];

const HOOK_EVENTS = [
  // Session
  'SessionStart', 'Setup', 'SessionEnd',
  // Prompt
  'UserPromptSubmit', 'UserPromptExpansion',
  // Tool
  'PreToolUse', 'PermissionRequest', 'PermissionDenied',
  'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  // Stop
  'Stop', 'StopFailure',
  // Subagent / Task
  'SubagentStart', 'SubagentStop', 'TeammateIdle',
  'TaskCreated', 'TaskCompleted',
  // Config / Environment
  'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'FileChanged',
  // Worktree
  'WorktreeCreate', 'WorktreeRemove',
  // Compaction
  'PreCompact', 'PostCompact',
  // MCP Elicitation
  'Elicitation', 'ElicitationResult',
  // Notification
  'Notification',
];

// Events that support a matcher (tool name filter)
const MATCHER_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionRequest', 'PermissionDenied',
];

const KNOWN_SKILLS = [
  { name: 'commit', description: 'Create a git commit with a well-crafted message' },
  { name: 'review-pr', description: 'Review a pull request from GitHub' },
  { name: 'create-pr', description: 'Create a GitHub pull request' },
  { name: 'simplify', description: 'Simplify and refactor selected code' },
  { name: 'pdf', description: 'Read and summarize PDF files' },
  { name: 'init', description: 'Initialize Claude Code configuration for a project' },
  { name: 'bug', description: 'Find and fix bugs in the codebase' },
  { name: 'memory', description: "Manage Claude's project memory (CLAUDE.md)" },
];

// Provider keys that support native web search (used by UI + adapter)
const WEB_SEARCH_PROVIDERS = new Set(['openai', 'google', 'moonshot']);

// Maps providerKey → adapter name (used for model scanning and auto-adding)
const PROVIDER_ADAPTER_MAP = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'gemini',
  deepseek: 'openai',
  moonshot: 'openai',
  ollama: 'openai',
};

// --- Generic Markdown entity CRUD factory ---

function createMarkdownCrud(subdir) {
  const getDir = (cwd) => path.join(cwd, '.claude', subdir);
  return {
    dir: getDir,
    list(cwd) {
      const dir = getDir(cwd);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const name = f.replace(/\.md$/, '');
          const content = fs.readFileSync(path.join(dir, f), 'utf-8');
          const desc = (extractFrontmatterField(content, 'description') || '').split('\n')[0].trim();
          return { name, description: desc, content };
        });
    },
    read(cwd, name) {
      const file = path.join(getDir(cwd), `${name}.md`);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf-8');
    },
    save(cwd, name, content) {
      if (!isValidName(name)) return false;
      const dir = getDir(cwd);
      ensureDir(dir);
      fs.writeFileSync(path.join(dir, `${name}.md`), content);
      return true;
    },
    delete(cwd, name) {
      const file = path.join(getDir(cwd), `${name}.md`);
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    },
  };
}

const commandsCrud = createMarkdownCrud('commands');
const agentsCrud = createMarkdownCrud('agents');

// --- Skill CRUD (.claude/skills/<name>/SKILL.md) ---

function skillsDir(cwd) {
  return path.join(cwd, '.claude', 'skills');
}

function listSkills(cwd) {
  const dir = skillsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => {
      const skillFile = path.join(dir, f, 'SKILL.md');
      return fs.existsSync(skillFile) && fs.statSync(path.join(dir, f)).isDirectory();
    })
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f, 'SKILL.md'), 'utf-8');
      const desc = extractFrontmatterField(content, 'description') || '';
      return { name: f, description: desc.split('\n')[0].trim(), content };
    });
}

function readSkill(cwd, name) {
  const file = path.join(skillsDir(cwd), name, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function saveSkill(cwd, name, content, extraFiles) {
  if (!isValidName(name)) return false;
  const dir = path.join(skillsDir(cwd), name);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  // Write extra files (templates, scripts, etc.)
  if (Array.isArray(extraFiles)) {
    for (const f of extraFiles) {
      if (!f.name || typeof f.content !== 'string') continue;
      // Prevent path traversal — resolve and verify containment
      let filePath;
      try { filePath = safeJoin(dir, f.name); } catch { continue; }
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, f.content);
    }
  }
  return true;
}

function deleteSkill(cwd, name) {
  const dir = path.join(skillsDir(cwd), name);
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  // Remove the directory if empty
  try {
    const remaining = fs.readdirSync(dir);
    if (remaining.length === 0) fs.rmdirSync(dir);
  } catch {}
  return true;
}

// --- Agent CRUD (uses shared factory) ---

// --- Hook CRUD ---

function settingsLocalPath(cwd) {
  return path.join(cwd, '.claude', 'settings.local.json');
}

function readSettingsLocal(cwd) {
  const p = settingsLocalPath(cwd);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return {};
}

function writeSettingsLocal(cwd, settings) {
  const dir = path.join(cwd, '.claude');
  ensureDir(dir);
  fs.writeFileSync(settingsLocalPath(cwd), JSON.stringify(settings, null, 2));
}

function listHooks(cwd) {
  const settings = readSettingsLocal(cwd);
  const hooks = settings.hooks || {};
  const result = [];
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const innerHooks = entry.hooks || [];
      for (let j = 0; j < innerHooks.length; j++) {
        const h = innerHooks[j];
        result.push({
          event,
          entryIndex: i,
          hookIndex: j,
          matcher: entry.matcher || '',
          type: h.type || 'command',
          command: h.command || h.prompt || '',
          timeout: h.timeout || 30,
        });
      }
    }
  }
  return result;
}

function saveHook(cwd, hook) {
  const settings = readSettingsLocal(cwd);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[hook.event]) settings.hooks[hook.event] = [];

  const newEntry = {
    hooks: [{
      type: hook.type || 'command',
      [hook.type === 'prompt' ? 'prompt' : 'command']: hook.command,
      timeout: hook.timeout || 30,
    }],
  };
  if (hook.matcher && MATCHER_EVENTS.includes(hook.event)) {
    newEntry.matcher = hook.matcher;
  }

  // If editing existing (has entryIndex + hookIndex), replace it
  if (hook.entryIndex !== undefined && hook.hookIndex !== undefined) {
    const entries = settings.hooks[hook.event];
    if (entries[hook.entryIndex]) {
      // Replace the entire entry (simplified: one hook per entry)
      entries[hook.entryIndex] = newEntry;
    } else {
      settings.hooks[hook.event].push(newEntry);
    }
  } else {
    settings.hooks[hook.event].push(newEntry);
  }

  writeSettingsLocal(cwd, settings);
  return true;
}

function deleteHook(cwd, event, entryIndex) {
  const settings = readSettingsLocal(cwd);
  if (!settings.hooks?.[event]) return false;
  const entries = settings.hooks[event];
  if (entryIndex < 0 || entryIndex >= entries.length) return false;
  entries.splice(entryIndex, 1);
  if (entries.length === 0) delete settings.hooks[event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettingsLocal(cwd, settings);
  return true;
}

// --- Hook reporter auto-injection ---

const HOOK_REPORTER_MARKER = '__vistaclair_reporter__';

function ensureHookReporters(cwd, reporterPath) {
  const settings = readSettingsLocal(cwd);
  if (!settings.hooks) settings.hooks = {};
  const events = HOOK_EVENTS;
  let changed = false;
  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const expectedCmd = `node "${reporterPath}" # ${HOOK_REPORTER_MARKER}`;
    const hasCorrectReporter = settings.hooks[event].some(e =>
      e.hooks?.some(h => h.command === expectedCmd)
    );
    if (!hasCorrectReporter) {
      const stale = settings.hooks[event].filter(e =>
        e.hooks?.some(h => h.command?.includes(HOOK_REPORTER_MARKER))
      );
      if (stale.length > 0) {
        settings.hooks[event] = settings.hooks[event].filter(e => !stale.includes(e));
      }
      settings.hooks[event].push({
        hooks: [{
          type: 'command',
          command: expectedCmd,
          timeout: 5,
        }],
      });
      changed = true;
    }
  }
  if (changed) writeSettingsLocal(cwd, settings);
}

// --- System prompt constants ---

const BASE_SYSTEM_PROMPT = `You are a coding assistant with direct access to the user's file system through tools. You help with software engineering tasks: writing code, debugging, refactoring, explaining code, and more.

## Available Tools

You have access to file system and development tools:
- **Read**: Read file contents by path. Always read before modifying a file.
- **Write**: Create new files or fully rewrite existing ones.
- **Edit**: Make targeted string replacements in existing files. Prefer this over Write for modifications.
- **Bash**: Execute shell commands. Use for builds, tests, git, and system operations.
- **Glob**: Find files by glob pattern (e.g. "**/*.js"). Use instead of find or ls commands.
- **Grep**: Search file contents with regex. Use instead of grep or rg commands.
- **WebSearch**: Search the web for current information.
- **WebFetch**: Fetch content from a specific URL.
- **Skill**: Execute a named skill (reusable prompt template). When users say "/<name>", call this tool with that skill name.
- **Agent**: Launch a sub-agent for independent sub-tasks.
- **TodoWrite**: Track task progress with a todo list.

## Guidelines

- Always read files before modifying them. Understand existing code first.
- Prefer editing existing files over creating new ones.
- Use dedicated file tools (Read, Edit, Write, Glob, Grep) instead of shell equivalents.
- Keep responses concise and direct. Lead with the answer, not the reasoning.
- Do not add features, refactoring, or improvements beyond what was asked.
- Be careful about security: avoid injection vulnerabilities, validate inputs at boundaries.
- When referencing code locations, use the format file_path:line_number.
- If a task seems risky or destructive, confirm with the user before proceeding.
- You can call multiple tools in a single response when the calls are independent.`;

const REASONING_ADDENDUM = `

## Thinking

You have extended thinking capabilities. Use them for:
- Planning multi-step code changes before executing
- Analyzing complex bugs or architectural questions
- Reasoning through trade-offs before choosing an approach
Do not narrate your thinking process in your response — just provide the result.`;

function getDefaultSystemPrompt(reasoning) {
  return BASE_SYSTEM_PROMPT + (reasoning ? REASONING_ADDENDUM : '');
}

// --- Model CRUD (capabilities/models.json) ---

function modelsFilePath(baseDir) {
  return path.join(baseDir, 'capabilities', 'models.json');
}

// Provider/model API keys live in an encrypted store (secrets.enc). A legacy
// plaintext secrets.json is migrated on first read and removed on next write.
function secretsEncPath(baseDir) {
  return path.join(baseDir, 'capabilities', 'secrets.enc');
}

function secretsLegacyPath(baseDir) {
  return path.join(baseDir, 'capabilities', 'secrets.json');
}

function readSecrets(baseDir) {
  const encPath = secretsEncPath(baseDir);
  const legacyPath = secretsLegacyPath(baseDir);
  const s = secretStore.readSecretFile(encPath, baseDir, {
    legacyPath,
    fallback: { providerKeys: {}, modelKeys: {} },
  });
  if (!s.providerKeys) s.providerKeys = {};
  if (!s.modelKeys) s.modelKeys = {};
  // Proactively migrate a legacy plaintext file to the encrypted store on first
  // read (mirrors the inline migration in readModelsFile), so keys never linger
  // in plaintext after the new code first runs.
  if (!fs.existsSync(encPath) && fs.existsSync(legacyPath)) {
    try { writeSecrets(baseDir, s); } catch {}
  }
  return s;
}

function writeSecrets(baseDir, secrets) {
  ensureDir(path.join(baseDir, 'capabilities'));
  secretStore.writeSecretFile(secretsEncPath(baseDir), secrets, baseDir, {
    legacyPath: secretsLegacyPath(baseDir),
  });
}

// Detect provider key from apiBaseUrl domain (used in migration)
function detectProviderKey(apiBaseUrl) {
  if (!apiBaseUrl) return 'custom';
  const domain = apiBaseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (domain.includes('openai.com')) return 'openai';
  if (domain.includes('googleapis.com')) return 'google';
  if (domain.includes('deepseek.com')) return 'deepseek';
  if (domain.includes('moonshot.cn')) return 'moonshot';
  if (domain.includes('localhost')) return 'ollama';
  return 'custom';
}

// Read models.json
function readModelsFile(baseDir) {
  const file = modelsFilePath(baseDir);
  const empty = { providers: {}, models: [] };
  try {
    if (!fs.existsSync(file)) return empty;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));

    if (Array.isArray(raw)) return empty;

    // Migrate any inline apiKeys to secrets file
    const result = {
      providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
      models: Array.isArray(raw.models) ? raw.models : [],
    };
    let dirty = false;
    const secrets = readSecrets(baseDir);
    // Move provider-level keys to secrets
    for (const [key, p] of Object.entries(result.providers)) {
      if (p.apiKey) {
        if (!secrets.providerKeys[key]) secrets.providerKeys[key] = p.apiKey;
        delete p.apiKey;
        dirty = true;
      }
    }
    // Move model-level keys to secrets
    for (const m of result.models) {
      if (m.apiKey) {
        if (!secrets.modelKeys[m.name]) secrets.modelKeys[m.name] = m.apiKey;
        delete m.apiKey;
        dirty = true;
      }
    }
    if (dirty) {
      writeSecrets(baseDir, secrets);
      const dir = path.join(baseDir, 'capabilities');
      ensureDir(dir);
      fs.writeFileSync(file, JSON.stringify(result, null, 2));
    }
    return result;
  } catch {
    return empty;
  }
}

function writeModelsFile(baseDir, data) {
  const dir = path.join(baseDir, 'capabilities');
  ensureDir(dir);
  fs.writeFileSync(modelsFilePath(baseDir), JSON.stringify(data, null, 2));
}

// Merge provider-level fields onto a model to produce a fully resolved object
function resolveModel(model, providers, secrets) {
  const prov = providers[model.providerKey] || {};
  const secs = secrets || { providerKeys: {}, modelKeys: {} };
  const systemPrompt = model.systemPrompt || getDefaultSystemPrompt(model.reasoning);
  // API key resolution: model-level secret > provider-level secret > legacy inline key
  const apiKey = secs.modelKeys?.[model.name]
    || secs.providerKeys?.[model.providerKey]
    || model.apiKey || prov.apiKey || '';
  return {
    name: model.name,
    label: model.label || model.name,
    description: model.description || '',
    providerKey: model.providerKey || 'custom',
    provider: model.provider || 'openai',
    modelId: model.modelId || '',
    apiBaseUrl: model.apiBaseUrl || prov.apiBaseUrl || '',
    apiKey,
    systemPromptMode: model.systemPromptMode || 'replace',
    systemPrompt,
    toolOverrides: model.toolOverrides || {},
    reasoning: !!model.reasoning,
    disabled: !!model.disabled,
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
    maxOutputTokens: typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : null,
    useMaxCompletionTokens: !!model.useMaxCompletionTokens,
    inputCostPerMTok: typeof model.inputCostPerMTok === 'number' ? model.inputCostPerMTok : null,
    outputCostPerMTok: typeof model.outputCostPerMTok === 'number' ? model.outputCostPerMTok : null,
    cacheReadCostPerMTok: typeof model.cacheReadCostPerMTok === 'number' ? model.cacheReadCostPerMTok : null,
    cacheCreateCostPerMTok: typeof model.cacheCreateCostPerMTok === 'number' ? model.cacheCreateCostPerMTok : null,
    lifecycle: ['current', 'deprecated', 'retired'].includes(model.lifecycle) ? model.lifecycle : 'current',
    retiresAt: (typeof model.retiresAt === 'string' && model.retiresAt) ? model.retiresAt : null,
    isNew: !!model.isNew,
  };
}

function hasClaudeSubscription() {
  try {
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return false;
    // Treat an expired OAuth token as no active subscription so headless runs
    // fall back to the API key (Anthropic disallows -p on a subscription anyway).
    if (oauth.expiresAt && Date.now() >= oauth.expiresAt) return false;
    return true;
  } catch { return false; }
}

// Resolve the Anthropic API key for headless (-p) spawns: the key pasted into
// the Models page (encrypted secrets store) takes precedence, then a key already
// present in the server's environment. Returns '' when none is configured.
function getAnthropicApiKey(baseDir) {
  try {
    const key = readSecrets(baseDir)?.providerKeys?.anthropic;
    if (key) return key;
  } catch {}
  return process.env.ANTHROPIC_API_KEY || '';
}

// --- App preferences (small global key-value store) ---
// Persisted at DATA_HOME/data/app-prefs.json. Holds the user's Claude auth
// choice and a record of whether a subscription has ever been detected.
function appPrefsPath(baseDir) {
  return path.join(baseDir, 'data', 'app-prefs.json');
}

function readAppPrefs(baseDir) {
  const p = readJSON(appPrefsPath(baseDir), {});
  return (p && typeof p === 'object') ? p : {};
}

function writeAppPrefs(baseDir, prefs) {
  writeJSON(appPrefsPath(baseDir), prefs);
}

// The user's preferred auth for Claude calls. '' / unset means "not chosen yet".
// Valid values: 'apikey' | 'subscription'.
function getClaudeAuthPref(baseDir) {
  const v = readAppPrefs(baseDir).claudeAuth;
  return (v === 'apikey' || v === 'subscription') ? v : '';
}

function setClaudeAuthPref(baseDir, value) {
  if (value !== 'apikey' && value !== 'subscription') return false;
  const prefs = readAppPrefs(baseDir);
  prefs.claudeAuth = value;
  writeAppPrefs(baseDir, prefs);
  return true;
}

// Record (once) that a subscription has been seen, so the UI can prompt the user
// to choose a preference the first time after they run `/login`. Returns true if
// the prefs were changed (i.e. this is a newly observed subscription).
function noteSubscriptionState(baseDir) {
  const active = hasClaudeSubscription();
  const prefs = readAppPrefs(baseDir);
  if (active && !prefs.subscriptionSeen) {
    prefs.subscriptionSeen = true;
    writeAppPrefs(baseDir, prefs);
    return true;
  }
  return false;
}

// True when a subscription is active but the user has not yet chosen how they
// want Claude calls authenticated. Drives the one-time "choose auth" prompt.
function needsClaudeAuthChoice(baseDir) {
  return hasClaudeSubscription() && !getClaudeAuthPref(baseDir);
}

// Decide which Anthropic API key (if any) a HEADLESS `claude -p` spawn should use.
// Returns the key string to inject, or '' to run on the subscription OAuth.
//
// Default is the API key: Anthropic does NOT permit `claude -p` on a Max/Pro
// subscription, and doing so may result in account bans. Subscription-headless
// is therefore an explicit, gated opt-in.
//
// authMode (per-call flag from ai.prompt; undefined => default):
//   'apikey' / default -> always use the API key
//   'subscription'     -> ONLY honored when the stored user preference is also
//                         'subscription' AND a subscription is active; otherwise
//                         falls back to the API key.
function resolveHeadlessAuth(baseDir, authMode) {
  const apiKey = getAnthropicApiKey(baseDir);
  if (authMode === 'subscription'
      && getClaudeAuthPref(baseDir) === 'subscription'
      && hasClaudeSubscription()) {
    return ''; // run on subscription OAuth (opt-in feature)
  }
  return apiKey;
}

// Decide auth for INTERACTIVE (PTY) sessions. These always PREFER the
// subscription when one is active (interactive use is allowed on a
// subscription); the API key is only used as a fallback when there is no
// active subscription. Returns the key string to inject, or '' for OAuth.
function getInteractiveAuth(baseDir) {
  if (hasClaudeSubscription()) return '';
  return getAnthropicApiKey(baseDir);
}

function listModels(baseDir) {
  const data = readModelsFile(baseDir);
  const secrets = readSecrets(baseDir);
  return data.models.map(m => resolveModel(m, data.providers, secrets));
}

function loadModel(baseDir, name) {
  const models = listModels(baseDir);
  return models.find(m => m.name === name) || null;
}

function saveModel(baseDir, model) {
  const validated = validateModel(model);
  if (!validated.name) return false;
  // Extract API key to secrets file (never store in models.json)
  const apiKey = validated.apiKey || '';
  delete validated.apiKey;
  if (apiKey) {
    const secrets = readSecrets(baseDir);
    secrets.modelKeys[validated.name] = apiKey;
    writeSecrets(baseDir, secrets);
  }
  const data = readModelsFile(baseDir);
  const idx = data.models.findIndex(m => m.name === validated.name);
  if (idx >= 0) {
    data.models[idx] = validated;
  } else {
    data.models.push(validated);
  }
  writeModelsFile(baseDir, data);
  return true;
}

function deleteModel(baseDir, name) {
  const data = readModelsFile(baseDir);
  const idx = data.models.findIndex(m => m.name === name);
  if (idx < 0) return false;
  data.models.splice(idx, 1);
  writeModelsFile(baseDir, data);
  // Clean up secrets
  const secrets = readSecrets(baseDir);
  if (secrets.modelKeys[name]) {
    delete secrets.modelKeys[name];
    writeSecrets(baseDir, secrets);
  }
  return true;
}

function validateModel(m) {
  const result = {
    name: typeof m.name === 'string' ? m.name.trim() : '',
    label: typeof m.label === 'string' ? m.label : (m.name || ''),
    description: typeof m.description === 'string' ? m.description : '',
    providerKey: typeof m.providerKey === 'string' ? m.providerKey : 'custom',
    provider: typeof m.provider === 'string' ? m.provider : 'openai',
    modelId: typeof m.modelId === 'string' ? m.modelId : '',
    systemPromptMode: ['replace', 'prepend', 'append', 'passthrough'].includes(m.systemPromptMode)
      ? m.systemPromptMode : 'replace',
    toolOverrides: (m.toolOverrides && typeof m.toolOverrides === 'object') ? m.toolOverrides : {},
    reasoning: !!m.reasoning,
    disabled: !!m.disabled,
    contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    maxOutputTokens: typeof m.maxOutputTokens === 'number' ? m.maxOutputTokens : null,
    useMaxCompletionTokens: !!m.useMaxCompletionTokens,
    inputCostPerMTok: typeof m.inputCostPerMTok === 'number' ? m.inputCostPerMTok : null,
    outputCostPerMTok: typeof m.outputCostPerMTok === 'number' ? m.outputCostPerMTok : null,
    cacheReadCostPerMTok: typeof m.cacheReadCostPerMTok === 'number' ? m.cacheReadCostPerMTok : null,
    cacheCreateCostPerMTok: typeof m.cacheCreateCostPerMTok === 'number' ? m.cacheCreateCostPerMTok : null,
    lifecycle: ['current', 'deprecated', 'retired'].includes(m.lifecycle) ? m.lifecycle : 'current',
    retiresAt: (typeof m.retiresAt === 'string' && m.retiresAt) ? m.retiresAt : null,
    isNew: !!m.isNew,
  };
  // Retired models are always hidden from selection
  if (result.lifecycle === 'retired') result.disabled = true;
  // Custom provider models can have their own apiBaseUrl/apiKey
  if (m.providerKey === 'custom') {
    result.apiBaseUrl = typeof m.apiBaseUrl === 'string' ? m.apiBaseUrl : '';
    result.apiKey = typeof m.apiKey === 'string' ? m.apiKey : '';
  }
  // Custom system prompt override (only store if provided)
  if (typeof m.systemPrompt === 'string' && m.systemPrompt.trim()) {
    result.systemPrompt = m.systemPrompt;
  }
  return result;
}

// --- Provider CRUD ---

function listProviders(baseDir) {
  const data = readModelsFile(baseDir);
  const secrets = readSecrets(baseDir);
  return Object.entries(data.providers).map(([key, p]) => ({
    key,
    label: p.label || key,
    apiBaseUrl: p.apiBaseUrl || '',
    apiKey: secrets.providerKeys?.[key] || p.apiKey || '',
  }));
}

function saveProvider(baseDir, key, provider) {
  if (!key || typeof key !== 'string') return false;
  const data = readModelsFile(baseDir);
  data.providers[key] = {
    label: typeof provider.label === 'string' ? provider.label : key,
    apiBaseUrl: typeof provider.apiBaseUrl === 'string' ? provider.apiBaseUrl : '',
  };
  writeModelsFile(baseDir, data);
  // Store API key in secrets file (never in models.json)
  if (typeof provider.apiKey === 'string' && provider.apiKey) {
    const secrets = readSecrets(baseDir);
    secrets.providerKeys[key] = provider.apiKey;
    writeSecrets(baseDir, secrets);
  }
  return true;
}

function deleteProvider(baseDir, key) {
  const data = readModelsFile(baseDir);
  if (!data.providers[key]) return false;
  const inUse = data.models.some(m => m.providerKey === key);
  if (inUse) return false;
  delete data.providers[key];
  writeModelsFile(baseDir, data);
  // Clean up secrets
  const secrets = readSecrets(baseDir);
  if (secrets.providerKeys[key]) {
    delete secrets.providerKeys[key];
    writeSecrets(baseDir, secrets);
  }
  return true;
}

// --- Proxy Rules CRUD ---

function proxyRulesDir(baseDir) {
  return path.join(baseDir, 'capabilities', 'proxy-rules');
}

function proxyRulesManifestPath(baseDir) {
  return path.join(baseDir, 'capabilities', 'proxy-rules.json');
}

function listProxyRules(baseDir) {
  try {
    const p = proxyRulesManifestPath(baseDir);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return [];
}

function saveProxyRulesManifest(baseDir, rules) {
  fs.writeFileSync(proxyRulesManifestPath(baseDir), JSON.stringify(rules, null, 2) + '\n');
}

function addProxyRule(baseDir, id, name, slug, source) {
  const dir = proxyRulesDir(baseDir);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${id}.js`), source);
  const rules = listProxyRules(baseDir);
  rules.push({ id, name, slug, enabled: true });
  saveProxyRulesManifest(baseDir, rules);
  return true;
}

function toggleProxyRule(baseDir, id, enabled) {
  const rules = listProxyRules(baseDir);
  const rule = rules.find(r => r.id === id);
  if (!rule) return false;
  rule.enabled = enabled;
  saveProxyRulesManifest(baseDir, rules);
  return true;
}

function deleteProxyRule(baseDir, id) {
  const rules = listProxyRules(baseDir);
  const idx = rules.findIndex(r => r.id === id);
  if (idx < 0) return false;
  rules.splice(idx, 1);
  saveProxyRulesManifest(baseDir, rules);
  const file = path.join(proxyRulesDir(baseDir), `${id}.js`);
  try { fs.unlinkSync(file); } catch {}
  return true;
}

function updateProxyRule(baseDir, id, name, slug, source) {
  const rules = listProxyRules(baseDir);
  const rule = rules.find(r => r.id === id);
  if (!rule) return false;
  if (name) rule.name = name;
  if (slug) rule.slug = slug;
  saveProxyRulesManifest(baseDir, rules);
  if (source) {
    const dir = proxyRulesDir(baseDir);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, `${id}.js`), source);
  }
  return true;
}

function reorderProxyRules(baseDir, orderedIds) {
  const rules = listProxyRules(baseDir);
  const byId = new Map(rules.map(r => [r.id, r]));
  const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
  for (const r of rules) {
    if (!orderedIds.includes(r.id)) reordered.push(r);
  }
  saveProxyRulesManifest(baseDir, reordered);
  return true;
}

function isValidRuleId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(id);
}

function readProxyRuleSource(baseDir, id) {
  if (!isValidRuleId(id)) return null;
  try {
    return fs.readFileSync(path.join(proxyRulesDir(baseDir), `${id}.js`), 'utf-8');
  } catch { return null; }
}

// --- Helpers ---

function isValidName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/.test(name) && name.length >= 2 && name.length <= 50;
}

function extractFrontmatterField(content, field) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = match[1];
  // Handle multi-line fields (YAML block scalar)
  const lines = fm.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^${field}:\\s*(.*)$`));
    if (m) {
      const val = m[1].trim();
      // If value starts with | or >, it's a block scalar — read indented lines
      if (val === '|' || val === '>') {
        let block = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(/^\s+/)) {
            block += lines[j].trim() + ' ';
          } else break;
        }
        return block.trim();
      }
      return val.replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

// --- Pricing lookup ---

function getModelPricing(baseDir, modelName) {
  if (!modelName) return null;
  // 1. Check models.json by name, label, or modelId
  const data = readModelsFile(baseDir);
  const model = data.models.find(m =>
    m.name === modelName || m.label === modelName || m.modelId === modelName
  );
  if (model && model.inputCostPerMTok != null) {
    return {
      inputCostPerMTok: model.inputCostPerMTok,
      outputCostPerMTok: model.outputCostPerMTok,
      cacheReadCostPerMTok: model.cacheReadCostPerMTok,
      cacheCreateCostPerMTok: model.cacheCreateCostPerMTok,
    };
  }
  // 2. Fall back to anthropic-pricing.json with prefix matching
  const pricingPath = path.join(baseDir, 'capabilities', 'anthropic-pricing.json');
  try {
    const pricing = JSON.parse(fs.readFileSync(pricingPath, 'utf-8'));
    // Sort keys by length descending for longest-prefix match
    const prefixes = Object.keys(pricing).sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
      if (modelName.startsWith(prefix)) return pricing[prefix];
    }
  } catch {}
  return null;
}

function updateAnthropicPricing(baseDir, updates) {
  const pricingPath = path.join(baseDir, 'capabilities', 'anthropic-pricing.json');
  let pricing = {};
  try { pricing = JSON.parse(fs.readFileSync(pricingPath, 'utf-8')); } catch {}
  Object.assign(pricing, updates);
  fs.writeFileSync(pricingPath, JSON.stringify(pricing, null, 2) + '\n');
}

// --- Provider model scanning ---

// Non-chat OpenAI models
const OPENAI_MODEL_EXCLUDE = /^(ft:|babbage|davinci|whisper|dall-e|text-embedding|text-moderation|canary-|tts-)|embedding|realtime|audio|transcri|sora|gpt-image|chatgpt-image|omni-mod|-tts|-search-|-codex|-deep-research|-instruct|^gpt-3\.5|^gpt-4(?!\.\d)|^gpt-4o/i;
// Dated variants (gpt-5.4-2026-03-05) and aliases (-chat-latest)
const OPENAI_DATED_RE = /-(20\d{2}-\d{2}-\d{2})$|-chat-latest$/;
// Non-text Gemini models, aliases, and pinned versions
const GEMINI_MODEL_EXCLUDE = /tts|image|nano-banana|robotics|computer-use|deep-research|lyria|^gemma|-latest$|-customtools|-\d{3}$/i;
// Dated Anthropic variants (claude-opus-4-7-20250715)
const ANTHROPIC_DATED_RE = /-(\d{8})$/;

const PRICING_FIELDS = ['inputCostPerMTok', 'outputCostPerMTok', 'cacheReadCostPerMTok', 'cacheCreateCostPerMTok'];

// Hardcoded safety net of currently-offered Anthropic models. Guarantees these
// exist in models.json even when the Claude pricing subprocess is unavailable
// (e.g. subscription-only auth with no Anthropic API key). To support a new
// release, add it here (lifecycle 'current'); the refresh subprocess also adds
// newly-released models automatically by editing anthropic-pricing.json.
const ANTHROPIC_CATALOG_FALLBACK = {
  'claude-opus-4-8': { label: 'Claude Opus 4.8', reasoning: true, contextWindow: 200000, maxOutputTokens: 32000, lifecycle: 'current', description: "Anthropic's newest and most capable model — frontier reasoning, coding, and agentic tasks" },
  'claude-opus-4-7': { label: 'Claude Opus 4.7', reasoning: true, contextWindow: 200000, maxOutputTokens: 32000, lifecycle: 'current' },
  'claude-opus-4-6': { label: 'Claude Opus 4.6', reasoning: true, contextWindow: 200000, maxOutputTokens: 32000, lifecycle: 'current' },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200000, maxOutputTokens: 16000, lifecycle: 'current' },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', reasoning: false, contextWindow: 200000, maxOutputTokens: 8192, lifecycle: 'current' },
};

// Reconcile models.json against the Anthropic catalog (hardcoded fallback merged
// with anthropic-pricing.json, which the refresh subprocess keeps current).
// Adds missing current/deprecated models (flagged isNew), updates lifecycle and
// pricing, and disables models the catalog marks retired. Retirement only happens
// for entries explicitly marked lifecycle:'retired' — never on mere absence —
// to avoid false positives from an incomplete fallback.
function reconcileAnthropicCatalog(baseDir, opts = {}) {
  const result = { status: 'ok', added: [], deprecated: [], retired: [], total: 0 };
  const pricingPath = path.join(baseDir, 'capabilities', 'anthropic-pricing.json');
  let fileCatalog = {};
  try { fileCatalog = JSON.parse(fs.readFileSync(pricingPath, 'utf-8')) || {}; } catch {}
  const catalog = {};
  for (const key of new Set([...Object.keys(ANTHROPIC_CATALOG_FALLBACK), ...Object.keys(fileCatalog)])) {
    catalog[key] = { ...(ANTHROPIC_CATALOG_FALLBACK[key] || {}), ...(fileCatalog[key] || {}) };
  }

  const data = readModelsFile(baseDir);
  const baseOf = (m) => (m.modelId || m.name || '').replace(ANTHROPIC_DATED_RE, '');
  const existingNames = new Set(data.models.map(m => m.name));
  const byBase = new Map();
  for (const m of data.models) {
    if (m.providerKey !== 'anthropic') continue;
    byBase.set(m.name, m);
    byBase.set(baseOf(m), m);
    if (opts.clearNew && m.isNew) m.isNew = false;
  }

  for (const [key, meta] of Object.entries(catalog)) {
    const lifecycle = ['current', 'deprecated', 'retired'].includes(meta.lifecycle) ? meta.lifecycle : 'current';
    const retiresAt = (typeof meta.retiresAt === 'string' && meta.retiresAt) ? meta.retiresAt : null;
    const existing = byBase.get(key);
    result.total++;

    if (lifecycle === 'retired') {
      if (existing && existing.lifecycle !== 'retired') {
        existing.lifecycle = 'retired';
        existing.disabled = true;
        existing.retiresAt = null;
        result.retired.push(existing.label || existing.name);
      }
      continue;
    }

    if (!existing) {
      if (existingNames.has(key)) continue;
      const entry = {
        name: key,
        label: meta.label || key,
        description: meta.description || '',
        providerKey: 'anthropic',
        provider: 'anthropic',
        modelId: meta.modelId || key,
        systemPromptMode: 'passthrough',
        reasoning: !!meta.reasoning,
        disabled: false,
        lifecycle,
        retiresAt,
        isNew: true,
        contextWindow: typeof meta.contextWindow === 'number' ? meta.contextWindow : null,
        maxOutputTokens: typeof meta.maxOutputTokens === 'number' ? meta.maxOutputTokens : null,
      };
      for (const f of PRICING_FIELDS) if (typeof meta[f] === 'number') entry[f] = meta[f];
      data.models.push(validateModel(entry));
      existingNames.add(key);
      byBase.set(key, entry);
      byBase.set(baseOf(entry), entry);
      result.added.push(entry.label || key);
    } else {
      existing.lifecycle = lifecycle;
      existing.retiresAt = lifecycle === 'deprecated' ? retiresAt : null;
      for (const f of PRICING_FIELDS) if (typeof meta[f] === 'number') existing[f] = meta[f];
      if (lifecycle === 'deprecated') result.deprecated.push(existing.label || existing.name);
    }
  }
  writeModelsFile(baseDir, data);
  return result;
}

function _sanitizeModelName(modelId, existingNames) {
  let name = modelId.toLowerCase()
    .replace(/^models\//, '')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .slice(0, 50);
  if (name.length < 2) name = 'model-' + name;
  if (!/^[a-z0-9]/.test(name)) name = 'm' + name;
  let candidate = name;
  let suffix = 2;
  while (existingNames.has(candidate)) {
    candidate = name.slice(0, 46) + '-' + suffix++;
  }
  return candidate;
}

async function _fetchOpenAICompatModels(apiBaseUrl, apiKey) {
  const url = apiBaseUrl.replace(/\/+$/, '') + '/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401) throw new Error('Invalid API key');
      if (status === 429) throw new Error('Rate limited — try again later');
      throw new Error(`HTTP ${status}: ${res.statusText}`);
    }
    const data = await res.json();
    const items = Array.isArray(data.data) ? data.data : [];
    const filtered = items.filter(m => m.id && !OPENAI_MODEL_EXCLUDE.test(m.id));
    // Dedup dated variants: keep base name, drop dated suffixes
    const baseIds = new Set(filtered.map(m => m.id.replace(OPENAI_DATED_RE, '')));
    return filtered
      .filter(m => !OPENAI_DATED_RE.test(m.id) || !baseIds.has(m.id.replace(OPENAI_DATED_RE, '')) || m.id === m.id.replace(OPENAI_DATED_RE, ''))
      .filter(m => !OPENAI_DATED_RE.test(m.id))
      .map(m => ({
        modelId: m.id,
        displayName: m.id,
        description: '',
        contextWindow: null,
        maxOutputTokens: null,
      }));
  } finally {
    clearTimeout(timer);
  }
}

async function _fetchGeminiModels(apiBaseUrl, apiKey) {
  const base = apiBaseUrl.replace(/\/+$/, '');
  const all = [];
  let pageToken = null;
  for (let page = 0; page < 5; page++) {
    let url = `${base}/models?key=${apiKey}&pageSize=100`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        const status = res.status;
        if (status === 400 || status === 403) throw new Error('Invalid API key');
        if (status === 429) throw new Error('Rate limited — try again later');
        throw new Error(`HTTP ${status}: ${res.statusText}`);
      }
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models : [];
      for (const m of models) {
        if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
        const modelId = (m.name || '').replace(/^models\//, '');
        if (!modelId || GEMINI_MODEL_EXCLUDE.test(modelId)) continue;
        all.push({
          modelId,
          displayName: m.displayName || modelId,
          description: m.description || '',
          contextWindow: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : null,
          maxOutputTokens: typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : null,
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    } finally {
      clearTimeout(timer);
    }
  }
  return all;
}

async function scanProviderModels(baseDir) {
  const data = readModelsFile(baseDir);
  const secrets = readSecrets(baseDir);
  const existingModelIds = new Set(data.models.map(m => m.modelId));
  const existingNames = new Set(data.models.map(m => m.name));
  const results = {};

  // Scan keyed providers via their /models API. Anthropic is handled separately
  // by reconcileAnthropicCatalog below (works without an API key).
  for (const [key, prov] of Object.entries(data.providers)) {
    if (key === 'anthropic') continue;
    const apiKey = secrets.providerKeys?.[key] || '';
    if (!apiKey) {
      results[key] = { status: 'skipped', error: 'No API key configured', added: [] };
      continue;
    }
    const adapter = PROVIDER_ADAPTER_MAP[key] || 'openai';
    const exclude = adapter === 'gemini' ? GEMINI_MODEL_EXCLUDE : OPENAI_MODEL_EXCLUDE;
    try {
      const raw = adapter === 'gemini'
        ? await _fetchGeminiModels(prov.apiBaseUrl || '', apiKey)
        : await _fetchOpenAICompatModels(prov.apiBaseUrl || '', apiKey);
      const liveIds = new Set(raw.map(m => m.modelId));
      const added = [];
      const retired = [];
      // Recompute isNew + retirement against the live list
      for (const m of data.models) {
        if (m.providerKey !== key) continue;
        if (m.isNew) m.isNew = false;
        // Decommission detection: a model we'd normally track but the API no
        // longer returns. Guarded by the exclude regex so filtered-out models
        // (embeddings, dated aliases, etc.) are never falsely retired.
        if (m.modelId && !exclude.test(m.modelId) && !liveIds.has(m.modelId) && m.lifecycle !== 'retired') {
          m.lifecycle = 'retired';
          m.disabled = true;
          retired.push(m.label || m.name);
        }
      }
      for (const m of raw) {
        if (existingModelIds.has(m.modelId)) continue;
        const name = _sanitizeModelName(m.modelId, existingNames);
        existingNames.add(name);
        existingModelIds.add(m.modelId);
        const entry = validateModel({
          name,
          label: m.displayName !== m.modelId ? m.displayName : name,
          description: m.description || '',
          providerKey: key,
          provider: adapter,
          modelId: m.modelId,
          systemPromptMode: 'replace',
          reasoning: false,
          disabled: true,
          lifecycle: 'current',
          isNew: true,
          contextWindow: m.contextWindow || null,
          maxOutputTokens: m.maxOutputTokens || null,
        });
        data.models.push(entry);
        added.push({ name, label: entry.label, modelId: m.modelId });
      }
      results[key] = { status: 'ok', total: raw.length, added, retired };
    } catch (err) {
      results[key] = { status: 'error', error: err.message || String(err), added: [] };
    }
  }

  writeModelsFile(baseDir, data);
  // Anthropic: ensure all current models exist + apply lifecycle flags
  results.anthropic = reconcileAnthropicCatalog(baseDir, { clearNew: true });
  return results;
}

module.exports = {
  KNOWN_TOOLS,
  PROVIDER_ADAPTER_MAP,
  KNOWN_SKILLS,
  HOOK_EVENTS,
  MATCHER_EVENTS,
  listSkills,
  saveSkill,
  deleteSkill,
  listAgents: agentsCrud.list,
  saveAgent: agentsCrud.save,
  deleteAgent: agentsCrud.delete,
  listHooks,
  saveHook,
  deleteHook,
  ensureHookReporters,
  listModels,
  loadModel,
  saveModel,
  deleteModel,
  listProviders,
  saveProvider,
  deleteProvider,
  getModelPricing,
  scanProviderModels,
  reconcileAnthropicCatalog,
  listProxyRules,
  addProxyRule,
  toggleProxyRule,
  deleteProxyRule,
  updateProxyRule,
  reorderProxyRules,
  readProxyRuleSource,
  isValidRuleId,
  hasClaudeSubscription,
  getAnthropicApiKey,
  resolveHeadlessAuth,
  getInteractiveAuth,
  readAppPrefs,
  getClaudeAuthPref,
  setClaudeAuthPref,
  noteSubscriptionState,
  needsClaudeAuthChoice,
};
