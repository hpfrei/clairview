const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./utils');

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
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop',
  'SessionStart', 'Notification', 'PreCompact', 'PostCompact',
];

// Events that support a matcher (tool name filter)
const MATCHER_EVENTS = ['PreToolUse', 'PostToolUse'];

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
      const clean = path.normalize(f.name);
      const filePath = path.resolve(dir, clean);
      if (!filePath.startsWith(dir + path.sep) && filePath !== dir) continue;
      const fileDir = path.dirname(filePath);
      ensureDir(fileDir);
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
const HOOK_REPORTER_MARKERS = ['__vistaclair_reporter__', '__claude_doc_reporter__', '__clairview_reporter__'];

function isReporterHook(h) {
  return HOOK_REPORTER_MARKERS.some(m => h.command?.includes(m));
}

function ensureHookReporters(cwd, reporterPath) {
  const settings = readSettingsLocal(cwd);
  if (!settings.hooks) settings.hooks = {};
  const events = ['PreToolUse', 'PostToolUse'];
  let changed = false;
  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const entries = settings.hooks[event];
    // Remove legacy reporter entries (old marker names)
    const legacy = entries.filter(e => e.hooks?.some(h => isReporterHook(h) && !h.command?.includes(HOOK_REPORTER_MARKER)));
    if (legacy.length > 0) {
      settings.hooks[event] = entries.filter(e => !legacy.includes(e));
      changed = true;
    }
    // Check if current reporter already exists
    const hasReporter = settings.hooks[event].some(e =>
      e.hooks?.some(h => h.command?.includes(HOOK_REPORTER_MARKER))
    );
    if (!hasReporter) {
      settings.hooks[event].push({
        hooks: [{
          type: 'command',
          command: `node "${reporterPath}" # ${HOOK_REPORTER_MARKER}`,
          timeout: 5,
        }],
      });
      changed = true;
    }
  }
  if (changed) writeSettingsLocal(cwd, settings);
}

function removeHookReporters(cwd) {
  const settings = readSettingsLocal(cwd);
  if (!settings.hooks) return;
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    const filtered = entries.filter(e =>
      !e.hooks?.some(h => isReporterHook(h))
    );
    if (filtered.length !== entries.length) {
      settings.hooks[event] = filtered;
      changed = true;
    }
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
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

function secretsFilePath(baseDir) {
  return path.join(baseDir, 'capabilities', 'secrets.json');
}

function readSecrets(baseDir) {
  const file = secretsFilePath(baseDir);
  try {
    if (!fs.existsSync(file)) return { providerKeys: {}, modelKeys: {} };
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { providerKeys: {}, modelKeys: {} };
  }
}

function writeSecrets(baseDir, secrets) {
  ensureDir(path.join(baseDir, 'capabilities'));
  fs.writeFileSync(secretsFilePath(baseDir), JSON.stringify(secrets, null, 2));
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

// Migrate old flat array format to { providers, models }
function migrateFromFlatArray(arr) {
  const providerMap = {};
  const models = [];

  for (const m of arr) {
    const pk = detectProviderKey(m.apiBaseUrl);
    // Build provider entry from first model we see for this key
    if (!providerMap[pk]) {
      let label = pk;
      if (pk === 'openai') label = 'OpenAI';
      else if (pk === 'google') label = 'Google';
      else if (pk === 'deepseek') label = 'DeepSeek';
      else if (pk === 'moonshot') label = 'Moonshot / Kimi';
      else if (pk === 'ollama') label = 'Ollama (Local)';
      else if (pk === 'custom') label = 'Custom';
      providerMap[pk] = {
        label,
        apiBaseUrl: m.apiBaseUrl || '',
        apiKey: m.apiKey || '',
      };
    }
    // Strip provider-level fields from model
    const stripped = {
      name: m.name,
      label: m.label || m.name,
      description: m.description || '',
      providerKey: pk,
      provider: m.provider || 'openai',
      modelId: m.modelId || '',
      systemPromptMode: m.systemPromptMode || 'replace',
      toolOverrides: m.toolOverrides || {},
      reasoning: !!m.reasoning,
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
      maxOutputTokens: typeof m.maxOutputTokens === 'number' ? m.maxOutputTokens : null,
    };
    // Custom models keep their own apiBaseUrl/apiKey if different from provider
    if (pk === 'custom' && m.apiBaseUrl) {
      stripped.apiBaseUrl = m.apiBaseUrl;
      stripped.apiKey = m.apiKey || '';
    }
    models.push(stripped);
  }

  return { providers: providerMap, models };
}

// Read models.json, auto-migrating from old flat format if needed
function readModelsFile(baseDir) {
  const file = modelsFilePath(baseDir);
  const empty = { providers: {}, models: [] };
  try {
    if (!fs.existsSync(file)) return empty;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));

    if (Array.isArray(raw)) {
      // Old flat format — migrate
      const migrated = migrateFromFlatArray(raw);
      const dir = path.join(baseDir, 'capabilities');
      ensureDir(dir);
      fs.writeFileSync(file, JSON.stringify(migrated, null, 2));
      return migrated;
    }

    // New format — migrate any inline apiKeys to secrets file
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
  };
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
  };
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

async function _fetchAnthropicModels(apiKey) {
  const all = [];
  let afterId = null;
  for (let page = 0; page < 5; page++) {
    let url = 'https://api.anthropic.com/v1/models?limit=100';
    if (afterId) url += `&after_id=${afterId}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
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
      for (const m of items) {
        if (!m.id) continue;
        all.push({
          modelId: m.id,
          displayName: m.display_name || m.id,
          description: '',
          contextWindow: null,
          maxOutputTokens: null,
        });
      }
      if (!data.has_more) break;
      afterId = items.length ? items[items.length - 1].id : null;
      if (!afterId) break;
    } finally {
      clearTimeout(timer);
    }
  }
  // Dedup dated variants: keep base name, drop dated suffixes
  const baseIds = new Set(all.map(m => m.modelId.replace(ANTHROPIC_DATED_RE, '')));
  return all
    .filter(m => !ANTHROPIC_DATED_RE.test(m.modelId) || !baseIds.has(m.modelId.replace(ANTHROPIC_DATED_RE, '')) || m.modelId === m.modelId.replace(ANTHROPIC_DATED_RE, ''))
    .filter(m => !ANTHROPIC_DATED_RE.test(m.modelId));
}

async function scanProviderModels(baseDir) {
  const data = readModelsFile(baseDir);
  const secrets = readSecrets(baseDir);
  const existingModelIds = new Set(data.models.map(m => m.modelId));
  const existingNames = new Set(data.models.map(m => m.name));
  const results = {};

  // Scan providers sequentially to avoid race conditions on saveModel
  for (const [key, prov] of Object.entries(data.providers)) {
    const apiKey = secrets.providerKeys?.[key]
      || (key === 'anthropic' ? process.env.ANTHROPIC_API_KEY : '')
      || '';
    if (!apiKey) {
      results[key] = { status: 'skipped', error: 'No API key configured', added: [] };
      continue;
    }
    try {
      let raw;
      const adapter = PROVIDER_ADAPTER_MAP[key] || 'openai';
      if (key === 'anthropic') {
        raw = await _fetchAnthropicModels(apiKey);
      } else if (adapter === 'gemini') {
        raw = await _fetchGeminiModels(prov.apiBaseUrl || '', apiKey);
      } else {
        raw = await _fetchOpenAICompatModels(prov.apiBaseUrl || '', apiKey);
      }
      const added = [];
      for (const m of raw) {
        if (existingModelIds.has(m.modelId)) continue;
        const name = _sanitizeModelName(m.modelId, existingNames);
        existingNames.add(name);
        existingModelIds.add(m.modelId);
        const entry = {
          name,
          label: m.displayName !== m.modelId ? m.displayName : name,
          description: m.description || '',
          providerKey: key,
          provider: adapter,
          modelId: m.modelId,
          systemPromptMode: key === 'anthropic' ? 'passthrough' : 'replace',
          reasoning: false,
          disabled: true,
          contextWindow: m.contextWindow || null,
          maxOutputTokens: m.maxOutputTokens || null,
        };
        saveModel(baseDir, entry);
        added.push({ name, label: entry.label, modelId: m.modelId });
      }
      results[key] = { status: 'ok', total: raw.length, added };
    } catch (err) {
      results[key] = { status: 'error', error: err.message || String(err), added: [] };
    }
  }

  return results;
}

module.exports = {
  KNOWN_TOOLS,
  WEB_SEARCH_PROVIDERS,
  PROVIDER_ADAPTER_MAP,
  KNOWN_SKILLS,
  HOOK_EVENTS,
  MATCHER_EVENTS,
  listCommands: commandsCrud.list,
  readCommand: commandsCrud.read,
  saveCommand: commandsCrud.save,
  deleteCommand: commandsCrud.delete,
  listSkills,
  readSkill,
  saveSkill,
  deleteSkill,
  listAgents: agentsCrud.list,
  readAgent: agentsCrud.read,
  saveAgent: agentsCrud.save,
  deleteAgent: agentsCrud.delete,
  listHooks,
  saveHook,
  deleteHook,
  ensureHookReporters,
  removeHookReporters,
  listModels,
  loadModel,
  saveModel,
  deleteModel,
  validateModel,
  listProviders,
  saveProvider,
  deleteProvider,
  getDefaultSystemPrompt,
  getModelPricing,
  updateAnthropicPricing,
  scanProviderModels,
  listProxyRules,
  addProxyRule,
  toggleProxyRule,
  deleteProxyRule,
  updateProxyRule,
  reorderProxyRules,
  readProxyRuleSource,
  isValidRuleId,
};
