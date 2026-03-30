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

const BUILTIN_PROFILES = {
  full: {
    name: 'full', label: 'Full', description: 'All tools enabled, default permissions', builtin: true,
    model: null, effort: null, permissionMode: 'default',
    disabledTools: [], disableSlashCommands: false,
    maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
  },
  safe: {
    name: 'safe', label: 'Safe', description: 'No file writes or shell execution', builtin: true,
    model: null, effort: null, permissionMode: 'acceptEdits',
    disabledTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'CronCreate', 'CronDelete', 'EnterWorktree', 'ExitWorktree'],
    disableSlashCommands: false,
    maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
  },
  readonly: {
    name: 'readonly', label: 'Read-only', description: 'Read and search only', builtin: true,
    model: null, effort: null, permissionMode: 'plan',
    disabledTools: KNOWN_TOOLS.filter(t => !['Read', 'Glob', 'Grep', 'AskUserQuestion'].includes(t)),
    disableSlashCommands: true,
    maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
  },
  minimal: {
    name: 'minimal', label: 'Minimal', description: 'Absolute minimum for code reading', builtin: true,
    model: null, effort: null, permissionMode: 'plan',
    disabledTools: KNOWN_TOOLS.filter(t => !['Read', 'Glob', 'Grep'].includes(t)),
    disableSlashCommands: true,
    maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
  },
};

// Backward compat alias
const PRESETS = BUILTIN_PROFILES;

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

// --- Profile management (multi-profile) ---

const VALID_EFFORTS = ['low', 'medium', 'high', 'max'];
const VALID_PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];

function profilesDir(baseDir) {
  return path.join(baseDir, 'capabilities', 'profiles');
}

function profileFilePath(baseDir, name) {
  return path.join(profilesDir(baseDir), `${name}.json`);
}

function activeFilePath(baseDir) {
  return path.join(baseDir, 'capabilities', 'active.json');
}

function listProfiles(baseDir) {
  const builtins = Object.values(BUILTIN_PROFILES).map(p => ({
    name: p.name, label: p.label, description: p.description, builtin: true,
  }));
  const dir = profilesDir(baseDir);
  let customs = [];
  try {
    if (fs.existsSync(dir)) {
      customs = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
            return { name: data.name, label: data.label || data.name, description: data.description || '', builtin: false };
          } catch { return null; }
        })
        .filter(Boolean)
        .filter(p => !BUILTIN_PROFILES[p.name]); // don't shadow builtins
    }
  } catch {}
  return [...builtins, ...customs];
}

function loadProfile(baseDir, name) {
  if (BUILTIN_PROFILES[name]) {
    return JSON.parse(JSON.stringify(BUILTIN_PROFILES[name]));
  }
  const file = profileFilePath(baseDir, name);
  try {
    if (fs.existsSync(file)) {
      return validateProfile(JSON.parse(fs.readFileSync(file, 'utf-8')));
    }
  } catch {}
  return null;
}

function loadActiveProfile(baseDir) {
  // Migration: old single-file profile.json
  const oldFile = path.join(baseDir, 'capabilities', 'profile.json');
  const actFile = activeFilePath(baseDir);
  if (fs.existsSync(oldFile) && !fs.existsSync(actFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(oldFile, 'utf-8'));
      const migrated = validateProfile({ ...old, name: old.name || 'custom', label: old.label || 'Custom (migrated)' });
      if (!BUILTIN_PROFILES[migrated.name]) {
        const dir = profilesDir(baseDir);
        ensureDir(dir);
        fs.writeFileSync(profileFilePath(baseDir, migrated.name), JSON.stringify(migrated, null, 2));
        setActiveProfile(baseDir, migrated.name);
      } else {
        setActiveProfile(baseDir, migrated.name);
      }
      fs.unlinkSync(oldFile);
      return loadProfile(baseDir, migrated.name) || JSON.parse(JSON.stringify(BUILTIN_PROFILES.full));
    } catch {}
  }

  // Normal load
  try {
    if (fs.existsSync(actFile)) {
      const { active } = JSON.parse(fs.readFileSync(actFile, 'utf-8'));
      if (active) {
        const profile = loadProfile(baseDir, active);
        if (profile) return profile;
      }
    }
  } catch (err) { console.error('Error loading active profile:', err); }
  return JSON.parse(JSON.stringify(BUILTIN_PROFILES.full));
}

function saveProfile(baseDir, profile) {
  const validated = validateProfile(profile);
  if (!isValidName(validated.name)) return false;
  // Cannot overwrite builtin names
  if (BUILTIN_PROFILES[validated.name]) return false;
  const dir = profilesDir(baseDir);
  ensureDir(dir);
  fs.writeFileSync(profileFilePath(baseDir, validated.name), JSON.stringify(validated, null, 2));
  return true;
}

function deleteProfile(baseDir, name) {
  if (!isValidName(name)) return false;
  if (BUILTIN_PROFILES[name]) return false;
  const file = profileFilePath(baseDir, name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  // If deleted profile was active, reset to full
  try {
    const actFile = activeFilePath(baseDir);
    if (fs.existsSync(actFile)) {
      const { active } = JSON.parse(fs.readFileSync(actFile, 'utf-8'));
      if (active === name) setActiveProfile(baseDir, 'full');
    }
  } catch (err) { console.error('Error resetting active profile after delete:', err); }
  return true;
}

function setActiveProfile(baseDir, name) {
  if (!BUILTIN_PROFILES[name] && !isValidName(name)) return false;
  const dir = path.join(baseDir, 'capabilities');
  ensureDir(dir);
  fs.writeFileSync(activeFilePath(baseDir), JSON.stringify({ active: name }, null, 2));
}

function duplicateProfile(baseDir, sourceName, newName) {
  if (!isValidName(newName)) return false;
  if (BUILTIN_PROFILES[newName]) return false;
  const source = loadProfile(baseDir, sourceName);
  if (!source) return false;
  const copy = { ...source, name: newName, label: newName, builtin: false };
  return saveProfile(baseDir, copy);
}

function validateProfile(p) {
  return {
    name: p.name || 'custom',
    label: typeof p.label === 'string' ? p.label : (p.name || 'Custom'),
    description: typeof p.description === 'string' ? p.description : '',
    builtin: !!p.builtin,
    model: p.model || null,
    effort: VALID_EFFORTS.includes(p.effort) ? p.effort : null,
    permissionMode: VALID_PERMISSIONS.includes(p.permissionMode) ? p.permissionMode : 'default',
    disabledTools: Array.isArray(p.disabledTools) ? p.disabledTools.filter(t => KNOWN_TOOLS.includes(t)) : [],
    disableSlashCommands: !!p.disableSlashCommands,
    maxTurns: typeof p.maxTurns === 'number' && p.maxTurns > 0 ? p.maxTurns : null,
    maxBudgetUsd: typeof p.maxBudgetUsd === 'number' && p.maxBudgetUsd > 0 ? p.maxBudgetUsd : null,
    appendSystemPrompt: typeof p.appendSystemPrompt === 'string' && p.appendSystemPrompt.trim() ? p.appendSystemPrompt.trim() : null,
    systemPrompt: typeof p.systemPrompt === 'string' && p.systemPrompt.trim() ? p.systemPrompt.trim() : null,
    mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers.filter(s => typeof s === 'string') : [],
    modelDef: typeof p.modelDef === 'string' && p.modelDef.trim() ? p.modelDef.trim() : null,
  };
}

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
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
    maxOutputTokens: typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : null,
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
    contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
    maxOutputTokens: typeof m.maxOutputTokens === 'number' ? m.maxOutputTokens : null,
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

// --- Helpers ---

function isValidName(name) {
  return /^[a-z][a-z0-9-]*$/.test(name) && name.length >= 2 && name.length <= 50;
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

module.exports = {
  KNOWN_TOOLS,
  BUILTIN_PROFILES,
  PRESETS, // backward compat alias
  KNOWN_SKILLS,
  HOOK_EVENTS,
  MATCHER_EVENTS,
  listProfiles,
  loadProfile,
  loadActiveProfile,
  saveProfile,
  deleteProfile,
  setActiveProfile,
  duplicateProfile,
  validateProfile,
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
  listModels,
  loadModel,
  saveModel,
  deleteModel,
  validateModel,
  listProviders,
  saveProvider,
  deleteProvider,
  getDefaultSystemPrompt,
};
