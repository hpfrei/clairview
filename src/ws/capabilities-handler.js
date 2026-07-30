// WebSocket handler for capability CRUD: skills, agents, hooks, models, providers.
// Registered on the dashboard broadcaster under those prefixes. Initial lists are
// sent by the broadcaster's connection bootstrap, so this handler is handleMessage-only.

const path = require('path');
const caps = require('../capabilities');
const { buildClaudeArgs, spawnClaude, createStreamJsonParser, describeClaudeError, DATA_HOME } = require('../utils');

const PROJECT_ROOT = DATA_HOME;

const PREFIXES = ['skill:', 'agent:', 'hook:', 'model:', 'provider:', 'prefs:'];

function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));

  switch (msg.type) {
    // --- Skills ---
    case 'skill:list':
      send({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
      break;
    case 'skill:save': {
      const ok = caps.saveSkill(PROJECT_ROOT, msg.name, msg.content, msg.extraFiles);
      if (ok) {
        bc.broadcast({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Invalid skill name: ${msg.name}` });
      }
      break;
    }
    case 'skill:delete': {
      const ok = caps.deleteSkill(PROJECT_ROOT, msg.name);
      if (ok) bc.broadcast({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
      break;
    }

    // --- Agents ---
    case 'agent:list':
      send({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
      break;
    case 'agent:save': {
      const ok = caps.saveAgent(PROJECT_ROOT, msg.name, msg.content);
      if (ok) {
        bc.broadcast({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Invalid agent name: ${msg.name}` });
      }
      break;
    }
    case 'agent:delete': {
      const ok = caps.deleteAgent(PROJECT_ROOT, msg.name);
      if (ok) bc.broadcast({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
      break;
    }

    // --- Hooks ---
    case 'hook:list':
      send({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
      break;
    case 'hook:save': {
      caps.saveHook(PROJECT_ROOT, msg.hook);
      bc.broadcast({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
      break;
    }
    case 'hook:delete': {
      const ok = caps.deleteHook(PROJECT_ROOT, msg.event, msg.entryIndex);
      if (ok) bc.broadcast({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
      break;
    }

    // --- Models ---
    case 'model:list':
      send({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
      break;
    case 'model:save': {
      const ok = caps.saveModel(PROJECT_ROOT, msg.model);
      if (ok) {
        bc.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Cannot save model: ${msg.model?.name} (invalid)` });
      }
      break;
    }
    case 'model:delete': {
      const ok = caps.deleteModel(PROJECT_ROOT, msg.name);
      if (ok) {
        bc.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Cannot delete model: ${msg.name}` });
      }
      break;
    }
    case 'model:toggle': {
      const model = caps.loadModel(PROJECT_ROOT, msg.name);
      if (model) {
        model.disabled = !!msg.disabled;
        model.isNew = false;
        caps.saveModel(PROJECT_ROOT, model);
        bc.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
      }
      break;
    }
    case 'model:refresh':
      handleModelRefresh(ws, bc);
      break;

    // --- Providers ---
    case 'provider:list':
      send({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
      break;
    case 'provider:save': {
      const ok = caps.saveProvider(PROJECT_ROOT, msg.key, msg.provider);
      if (ok) {
        bc.broadcast({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
        // Resolved models include provider apiKey, so refresh models too
        bc.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Cannot save provider: ${msg.key}` });
      }
      break;
    }
    case 'provider:delete': {
      const ok = caps.deleteProvider(PROJECT_ROOT, msg.key);
      if (ok) {
        bc.broadcast({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Cannot delete provider: ${msg.key} (in use or not found)` });
      }
      break;
    }

    // --- Preferences (Claude auth choice) ---
    case 'prefs:get':
      caps.noteSubscriptionState(PROJECT_ROOT);
      send({ type: 'prefs:claudeAuth', ...claudeAuthState() });
      send({ type: 'prefs:cliModel', ...cliModelState() });
      break;
    case 'prefs:cliModel:set': {
      const ok = caps.setCliModelPref(PROJECT_ROOT, msg.value);
      if (!ok) {
        send({ type: 'chat:error', text: `Invalid CLI model: ${msg.value}` });
        break;
      }
      bc.broadcast({ type: 'prefs:cliModel', ...cliModelState() });
      break;
    }
    case 'prefs:claudeAuth:set': {
      const ok = caps.setClaudeAuthPref(PROJECT_ROOT, msg.value);
      if (!ok) {
        send({ type: 'chat:error', text: `Invalid Claude auth preference: ${msg.value}` });
        break;
      }
      bc.broadcast({ type: 'prefs:claudeAuth', ...claudeAuthState() });
      break;
    }
  }
}

// Snapshot of the default-model-for-new-CLI-tabs choice, plus the alias list the
// picker offers alongside the resolved model catalog.
function cliModelState() {
  return {
    model: caps.getCliModelPref(PROJECT_ROOT),
    aliases: caps.CLI_MODEL_ALIASES,
  };
}

// Snapshot of the Claude auth decision for the frontend.
function claudeAuthState() {
  return {
    pref: caps.getClaudeAuthPref(PROJECT_ROOT) || null,
    hasSubscription: caps.hasClaudeSubscription(),
    needsChoice: caps.needsClaudeAuthChoice(PROJECT_ROOT),
  };
}

// Two-step model refresh: scan provider /models APIs, then have Claude update pricing.
function handleModelRefresh(ws, bc) {
  const send = (data) => ws.send(JSON.stringify(data));
  send({ type: 'model:refresh:status', text: 'Scanning providers for new models...' });
  caps.scanProviderModels(PROJECT_ROOT).then(scanResults => {
    send({ type: 'model:refresh:scanned', results: scanResults });
    bc.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });

    // Step 2: Refresh pricing via Claude
    const allModels = caps.listModels(PROJECT_ROOT);
    const modelsPath = path.join(PROJECT_ROOT, 'capabilities', 'models.json');
    const anthropicPath = path.join(PROJECT_ROOT, 'capabilities', 'anthropic-pricing.json');
    const modelList = allModels.map(m => `${m.label || m.name} (modelId: ${m.modelId}, provider: ${m.providerKey})`).join('\n');
    const prompt = `Maintain the Anthropic model catalog and AI model pricing by directly editing files on disk.\n\nSteps:\n1. Read ${modelsPath} to see the current model definitions.\n2. Read ${anthropicPath}. This is the authoritative Anthropic catalog: each key is a model prefix (e.g. claude-opus-4-8) and each value is an object that may contain "inputCostPerMTok", "outputCostPerMTok", "cacheReadCostPerMTok", "cacheCreateCostPerMTok", "label", "lifecycle" ("current" | "deprecated" | "retired"), and "retiresAt" (an ISO date string, only for deprecated models).\n3. You are a Claude model yourself — you know which models Anthropic currently offers and which are deprecated or decommissioned. Update ${anthropicPath} so it reflects reality:\n   - ADD an entry for every current Anthropic model that is missing (include label, lifecycle "current", and pricing). Add newly released models even if you only just learned of them.\n   - Set "lifecycle":"deprecated" and a "retiresAt" ISO date on models Anthropic has announced for retirement but not yet removed.\n   - Set "lifecycle":"retired" on models Anthropic has decommissioned (no longer served). Keep the entry; do not delete it.\n   - Set "lifecycle":"current" (and remove any "retiresAt") on models that are fully supported.\n   - Keep/update the four pricing fields (per million tokens, USD) on every entry.\n4. Look up and update the current official pricing for each THIRD-PARTY model in models.json (listed below). Spawn one parallel Agent task per provider (group the models by their provider, then launch all the provider tasks at once in a single message). Each task must use WebSearch/WebFetch to find that provider's current official pricing page and return the inputCostPerMTok, outputCostPerMTok, cacheReadCostPerMTok, and cacheCreateCostPerMTok (per million tokens, USD; null for cache fields if not available) for each of that provider's models. Once all tasks return, set those values directly in ${modelsPath}. Do not edit Anthropic entries in models.json — those are reconciled automatically from ${anthropicPath}.\n\nThe third-party models to look up pricing for:\n${modelList}\n\nIMPORTANT: You MUST directly edit the files using your Edit or Write tools — do not just output JSON. After updating, briefly summarize which Anthropic models you added, deprecated, or retired, and which third-party prices you changed.`;

    const args = buildClaudeArgs({ permissionMode: 'bypassPermissions', allowedTools: [...caps.KNOWN_TOOLS] });
    const proc = spawnClaude(args, {
      cwd: PROJECT_ROOT,
      proxyPort: bc._proxyPort,
      instanceId: `pricing-${Date.now()}`,
      anthropicApiKey: caps.resolveHeadlessAuth(PROJECT_ROOT),
    });

    let resultText = '';
    let stderrBuf = '';
    const parser = createStreamJsonParser((ev) => {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        resultText += ev.delta.text || '';
      }
    });
    proc.stdout.on('data', (chunk) => {
      parser.write(chunk);
      send({ type: 'model:refresh:status', text: 'Updating pricing...' });
    });
    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });
    proc.stdin.write(prompt);
    proc.stdin.end();
    proc.on('close', (code) => {
      parser.flush();
      // Re-reconcile so any models the subprocess added/deprecated/retired
      // in anthropic-pricing.json are reflected in models.json.
      let recon = null;
      try { recon = caps.reconcileAnthropicCatalog(PROJECT_ROOT, { clearNew: false }); } catch {}
      const lifecycleNote = recon
        ? ` Anthropic catalog: +${recon.added.length} new, ${recon.deprecated.length} deprecated, ${recon.retired.length} retired.`
        : '';
      const claudeErr = describeClaudeError(code, stderrBuf);
      if (claudeErr) {
        send({ type: 'model:refresh:done', text: `Scan complete.${lifecycleNote} Pricing update failed: ${claudeErr}` });
      } else {
        send({ type: 'model:refresh:done', text: (resultText || 'Refresh complete.') + lifecycleNote });
      }
      bc.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
    });
  }).catch(err => {
    send({ type: 'model:refresh:error', error: err.message });
  });
}

module.exports = { PREFIXES, handleMessage };
