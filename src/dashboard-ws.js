const path = require('path');
const WebSocket = require('ws');
const { sanitizeForDashboard, getActiveProcessCount, getInstances, killInstance, removeInstances, processUploadedFiles, buildClaudeArgs, spawnClaude, createStreamJsonParser, DATA_HOME } = require('./utils');
const { pendingQuestions, clearPendingQuestionsForTab } = require('./proxy');
const caps = require('./capabilities');

const PROJECT_ROOT = DATA_HOME;

const SCROLLBACK_CHUNK_SIZE = 16 * 1024;

function sendScrollbackChunked(ws, tabId, data) {
  if (data.length <= SCROLLBACK_CHUNK_SIZE) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cli:output', tabId, data }));
    }
    return;
  }
  let offset = 0;
  function sendNext() {
    if (offset >= data.length || ws.readyState !== WebSocket.OPEN) return;
    const chunk = data.slice(offset, offset + SCROLLBACK_CHUNK_SIZE);
    offset += SCROLLBACK_CHUNK_SIZE;
    ws.send(JSON.stringify({ type: 'cli:output', tabId, data: chunk }));
    setImmediate(sendNext);
  }
  sendNext();
}

class DashboardBroadcaster {
  constructor(wss, store, opts = {}) {
    this.wss = wss;
    this.store = store;
    this.authToken = opts.authToken || null;
    this._proxyPort = opts.proxyPort || 3456;
    this.cliSessionManager = opts.cliSessionManager || null;
    this.mcpHandler = null; // Set externally by src/mcp/index.js
    this._pluginHandlers = [];

    this.wss.on('connection', (ws) => {
      // Send full history on connect
      const interactions = this.store.getAll().map(sanitizeForDashboard);
      ws.send(JSON.stringify({ type: 'init', interactions }));

      // Send settings
      let mcpServers = [];
      try { mcpServers = require('./mcp/servers').listTools(); } catch {}
      ws.send(JSON.stringify({
        type: 'chat:settings',
        tabId: 'tab-1',
        cwd: process.cwd(),
        knownTools: caps.KNOWN_TOOLS,
        knownSkills: caps.KNOWN_SKILLS,
        hookEvents: caps.HOOK_EVENTS,
        matcherEvents: caps.MATCHER_EVENTS,
        mcpServers,
      }));
      // Send skills, agents, hooks for capabilities tab
      ws.send(JSON.stringify({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) }));
      ws.send(JSON.stringify({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) }));
      ws.send(JSON.stringify({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) }));
      ws.send(JSON.stringify({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) }));
      ws.send(JSON.stringify({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) }));

      // Send running Claude process count and instance list
      ws.send(JSON.stringify({ type: 'claude:count', count: getActiveProcessCount() }));
      ws.send(JSON.stringify({ type: 'claude:instances', instances: getInstances(), count: getActiveProcessCount() }));

      // MCP Server Manager init
      if (this.mcpHandler) this.mcpHandler.onConnect(ws);
      // Rule handler init
      if (this.ruleHandler) this.ruleHandler.onConnect(ws);
      // Plugin handlers init
      for (const { handler } of this._pluginHandlers) {
        if (handler.onConnect) handler.onConnect(ws);
      }

      // CLI tabs init — send tab metadata only; scrollback is loaded on demand
      if (this.cliSessionManager) {
        ws.send(JSON.stringify({ type: 'cli:tabs', tabs: this.cliSessionManager.list() }));
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          const tabId = msg.tabId || 'tab-1';
          if (msg.type === 'claude:killInstance') {
            if (msg.instanceId) killInstance(msg.instanceId);
          } else if (msg.type === 'inspector:clearInstances') {
            if (Array.isArray(msg.instanceIds) && msg.instanceIds.length > 0) {
              this.store.removeFromMemory(msg.instanceIds);
              removeInstances(msg.instanceIds);
              this.broadcast({ type: 'inspector:instancesCleared', instanceIds: msg.instanceIds });
            }
          } else if (msg.type === 'inspector:loadSession') {
            if (msg.sessId) {
              const loaded = this.store.loadSessionIntoMemory(msg.sessId);
              const interactions = loaded.map(sanitizeForDashboard);
              ws.send(JSON.stringify({
                type: 'inspector:sessionLoaded',
                sessId: msg.sessId,
                instanceId: `cli-${msg.sessId}`,
                interactions,
              }));
            }
          } else if (msg.type === 'inspector:loadAll') {
            const all = this.store.getAllFromDisk().map(sanitizeForDashboard);
            ws.send(JSON.stringify({ type: 'inspector:allLoaded', interactions: all }));
          } else if (msg.type === 'ask:answer') {
            // Resolve a pending AskUserQuestion
            const pending = pendingQuestions.get(msg.toolUseId);
            if (pending?.resolve) {
              let answer = msg.answer;
              // Process file uploads if present
              if (msg.files?.length && Array.isArray(answer)) {
                answer = processUploadedFiles(msg.toolUseId, msg.files, answer);
              }
              pending.resolve(answer);
            }
          // --- Skills ---
          } else if (msg.type === 'skill:list') {
            const cwd = process.cwd();
            ws.send(JSON.stringify({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) }));
          } else if (msg.type === 'skill:save') {
            const cwd = process.cwd();
            const ok = caps.saveSkill(PROJECT_ROOT, msg.name, msg.content, msg.extraFiles);
            if (ok) {
              this.broadcast({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid skill name: ${msg.name}` }));
            }
          } else if (msg.type === 'skill:delete') {
            const cwd = process.cwd();
            const ok = caps.deleteSkill(PROJECT_ROOT, msg.name);
            if (ok) this.broadcast({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
          // --- Agents ---
          } else if (msg.type === 'agent:list') {
            const cwd = process.cwd();
            ws.send(JSON.stringify({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) }));
          } else if (msg.type === 'agent:save') {
            const cwd = process.cwd();
            const ok = caps.saveAgent(PROJECT_ROOT, msg.name, msg.content);
            if (ok) {
              this.broadcast({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid agent name: ${msg.name}` }));
            }
          } else if (msg.type === 'agent:delete') {
            const cwd = process.cwd();
            const ok = caps.deleteAgent(PROJECT_ROOT, msg.name);
            if (ok) this.broadcast({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
          // --- Hooks ---
          } else if (msg.type === 'hook:list') {
            const cwd = process.cwd();
            ws.send(JSON.stringify({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) }));
          } else if (msg.type === 'hook:save') {
            const cwd = process.cwd();
            caps.saveHook(PROJECT_ROOT, msg.hook);
            this.broadcast({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
          } else if (msg.type === 'hook:delete') {
            const cwd = process.cwd();
            const ok = caps.deleteHook(PROJECT_ROOT, msg.event, msg.entryIndex);
            if (ok) this.broadcast({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
          // --- Models ---
          } else if (msg.type === 'model:list') {
            const cwd = process.cwd();
            ws.send(JSON.stringify({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) }));
          } else if (msg.type === 'model:save') {
            const cwd = process.cwd();
            const ok = caps.saveModel(PROJECT_ROOT, msg.model);
            if (ok) {
              this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save model: ${msg.model?.name} (invalid)` }));
            }
          } else if (msg.type === 'model:delete') {
            const cwd = process.cwd();
            const ok = caps.deleteModel(PROJECT_ROOT, msg.name);
            if (ok) {
              this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete model: ${msg.name}` }));
            }
          } else if (msg.type === 'model:toggle') {
            const model = caps.loadModel(PROJECT_ROOT, msg.name);
            if (model) {
              model.disabled = !!msg.disabled;
              caps.saveModel(PROJECT_ROOT, model);
              this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
            }
          } else if (msg.type === 'model:refresh') {
            ws.send(JSON.stringify({ type: 'model:refresh:status', text: 'Scanning providers for new models...' }));
            caps.scanProviderModels(PROJECT_ROOT).then(scanResults => {
              ws.send(JSON.stringify({ type: 'model:refresh:scanned', results: scanResults }));
              this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });

              // Step 2: Refresh pricing via Claude
              const allModels = caps.listModels(PROJECT_ROOT);
              const modelsPath = path.join(PROJECT_ROOT, 'capabilities', 'models.json');
              const anthropicPath = path.join(PROJECT_ROOT, 'capabilities', 'anthropic-pricing.json');
              const modelList = allModels.map(m => `${m.label || m.name} (modelId: ${m.modelId}, provider: ${m.providerKey})`).join('\n');
              const prompt = `Update the pricing data for AI models by directly editing the pricing files on disk.\n\nSteps:\n1. Read ${modelsPath} to see the current model definitions.\n2. Read ${anthropicPath} to see the current Anthropic pricing entries.\n3. Look up the current official API pricing (per million tokens, in USD) for:\n   - Each model found in models.json (third-party models listed below).\n   - All current Anthropic Claude models. You are a Claude model yourself — you know which models Anthropic currently offers. Update existing entries in anthropic-pricing.json with correct current prefix keys (e.g. claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5) and remove outdated entries that no longer match any current model.\n4. For each model in models.json, update the inputCostPerMTok, outputCostPerMTok, cacheReadCostPerMTok, and cacheCreateCostPerMTok fields directly in the file. Use null for cache fields if not available.\n5. For Anthropic models, update ${anthropicPath} with the same four fields per model.\n\nThe third-party models to look up pricing for:\n${modelList}\n\nIMPORTANT: You MUST directly edit the files using your Edit or Write tools — do not just output JSON. After updating, briefly summarize which models were updated and their new prices.`;

              const args = buildClaudeArgs({ permissionMode: 'bypassPermissions', allowedTools: [...caps.KNOWN_TOOLS] });
              const proc = spawnClaude(args, {
                cwd: PROJECT_ROOT,
                proxyPort: this._proxyPort,
                instanceId: `pricing-${Date.now()}`,
              });

              let resultText = '';
              const parser = createStreamJsonParser((ev) => {
                if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                  resultText += ev.delta.text || '';
                }
              });
              proc.stdout.on('data', (chunk) => {
                parser.write(chunk);
                ws.send(JSON.stringify({ type: 'model:refresh:status', text: 'Updating pricing...' }));
              });
              proc.stdin.write(prompt);
              proc.stdin.end();
              proc.on('close', () => {
                parser.flush();
                ws.send(JSON.stringify({ type: 'model:refresh:done', text: resultText }));
                this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
              });
            }).catch(err => {
              ws.send(JSON.stringify({ type: 'model:refresh:error', error: err.message }));
            });
          // --- Providers ---
          } else if (msg.type === 'provider:list') {
            const cwd = process.cwd();
            ws.send(JSON.stringify({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) }));
          } else if (msg.type === 'provider:save') {
            const cwd = process.cwd();
            const ok = caps.saveProvider(PROJECT_ROOT, msg.key, msg.provider);
            if (ok) {
              this.broadcast({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
              // Resolved models include provider apiKey, so refresh models too
              this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save provider: ${msg.key}` }));
            }
          } else if (msg.type === 'provider:delete') {
            const cwd = process.cwd();
            const ok = caps.deleteProvider(PROJECT_ROOT, msg.key);
            if (ok) {
              this.broadcast({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete provider: ${msg.key} (in use or not found)` }));
            }
          // --- MCP Tools ---
          } else if (msg.type === 'mcp:bridge:call') {
            // Bridge reporting a tool call for inspector logging
            if (this.mcpHandler?.handleBridgeReport) this.mcpHandler.handleBridgeReport(msg);
          } else if (msg.type.startsWith('rule:')) {
            if (this.ruleHandler) this.ruleHandler.handleMessage(ws, msg, this);
          } else if (this._dispatchPlugin(ws, msg)) {
            // Handled by plugin
          } else if (msg.type.startsWith('mcp:')) {
            if (this.mcpHandler) this.mcpHandler.handleMessage(ws, msg, this);
          // --- CLI Terminal ---
          } else if (msg.type === 'cli:newTab') {
            if (this.cliSessionManager) {
              const newTabId = this.cliSessionManager.nextTabId();
              this.cliSessionManager.getOrCreate(newTabId);
              ws.send(JSON.stringify({ type: 'cli:newTab', tabId: newTabId }));
            }
          } else if (msg.type === 'cli:closeTab') {
            if (this.cliSessionManager && msg.tabId) {
              clearPendingQuestionsForTab(msg.tabId);
              this.cliSessionManager.remove(msg.tabId);
              this.cliSessionManager.broadcastTabs();
            }
          } else if (msg.type === 'cli:spawn') {
            if (this.cliSessionManager && msg.tabId && msg.cwd) {
              if (msg.shell) {
                const session = this.cliSessionManager.getOrCreate(msg.tabId);
                session.spawnShell(msg.cwd, msg.cols || 80, msg.rows || 24);
              } else {
                this.cliSessionManager.spawn(msg.tabId, msg.cwd, msg.cols || 80, msg.rows || 24, { resumeSessionId: msg.resumeSessionId || undefined, isolated: msg.isolated === true });
              }
            }
          } else if (msg.type === 'cli:input') {
            if (this.cliSessionManager && msg.tabId) {
              this.cliSessionManager.write(msg.tabId, msg.data || '');
            }
          } else if (msg.type === 'cli:resize') {
            if (this.cliSessionManager && msg.tabId) {
              this.cliSessionManager.resize(msg.tabId, msg.cols || 80, msg.rows || 24);
            }
          } else if (msg.type === 'cli:kill') {
            if (this.cliSessionManager && msg.tabId) {
              clearPendingQuestionsForTab(msg.tabId);
              this.cliSessionManager.kill(msg.tabId);
            }
          } else if (msg.type === 'cli:rename') {
            if (this.cliSessionManager && msg.tabId) {
              this.cliSessionManager.rename(msg.tabId, msg.title || null);
            }
          } else if (msg.type === 'cli:settings') {
            if (this.cliSessionManager && msg.tabId && msg.settings) {
              this.cliSessionManager.updateSettings(msg.tabId, msg.settings);
              const session = this.cliSessionManager.get(msg.tabId);
              if (session) {
                ws.send(JSON.stringify({ type: 'cli:settingsData', tabId: msg.tabId, settings: session.getSettings() }));
              }
            }
          } else if (msg.type === 'cli:getSettings') {
            if (this.cliSessionManager && msg.tabId) {
              const session = this.cliSessionManager.get(msg.tabId);
              const models = caps.listModels(PROJECT_ROOT);
              ws.send(JSON.stringify({
                type: 'cli:settingsData',
                tabId: msg.tabId,
                settings: session ? session.getSettings() : {},
                models,
              }));
            }
          } else if (msg.type === 'cli:requestScrollback') {
            if (this.cliSessionManager && msg.tabId) {
              const session = this.cliSessionManager.get(msg.tabId);
              const scrollback = session?.getScrollback();
              if (scrollback) {
                sendScrollbackChunked(ws, msg.tabId, scrollback);
              }
            }
          } else if (msg.type === 'cli:getSavedSessions') {
            if (this.cliSessionManager) {
              ws.send(JSON.stringify({ type: 'cli:savedSessions', sessions: this.cliSessionManager.getSavedSessions() }));
            }
          } else if (msg.type === 'cli:deleteSavedSession') {
            if (this.cliSessionManager && msg.sessionId) {
              this.cliSessionManager.deleteSavedSession(msg.sessionId);
              ws.send(JSON.stringify({ type: 'cli:savedSessions', sessions: this.cliSessionManager.getSavedSessions() }));
            }
          }
        } catch (err) { console.error('WS message handling error:', err); }
      });
    });
  }

  registerHandler(prefix, handler) {
    this._pluginHandlers.push({ prefix, handler });
  }

  _dispatchPlugin(ws, msg) {
    let best = null;
    for (const p of this._pluginHandlers) {
      if (msg.type.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) {
        best = p;
      }
    }
    if (!best) return false;
    best.handler.handleMessage(ws, msg, this);
    return true;
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(data);
        } catch (err) { console.error('WS broadcast error:', err); }
      }
    }
  }
}

module.exports = DashboardBroadcaster;
