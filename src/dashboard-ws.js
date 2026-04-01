const path = require('path');
const WebSocket = require('ws');
const { sanitizeForDashboard, OUTPUTS_DIR, getActiveProcessCount } = require('./utils');
const { pendingQuestions } = require('./proxy');
const caps = require('./capabilities');
const workflows = require('./workflows');

// Capabilities config always lives at project root, not the outputs sandbox
const PROJECT_ROOT = path.dirname(__dirname);

function profilesWithUsage() {
  const usage = workflows.getProfileUsage(PROJECT_ROOT);
  return caps.listProfiles(PROJECT_ROOT).map(p => ({
    ...p,
    usedBy: usage[p.name] || [],
  }));
}

class DashboardBroadcaster {
  constructor(wss, store, sessionManager) {
    this.wss = wss;
    this.store = store;
    this.sessionManager = sessionManager;
    this.mcpHandler = null; // Set externally by src/mcp/index.js
    this.workflowHandler = null; // Set externally by src/workflow-handler.js
    this.apiListeners = new Set();

    this.wss.on('connection', (ws) => {
      // Send full history on connect
      const interactions = this.store.getAll().map(sanitizeForDashboard);
      ws.send(JSON.stringify({ type: 'init', interactions }));

      // Send tab list
      ws.send(JSON.stringify({ type: 'chat:tabs', tabs: this.sessionManager.list() }));

      // Send current chat status and settings (default tab)
      ws.send(JSON.stringify({
        type: 'chat:status',
        tabId: 'tab-1',
        status: this.sessionManager?.running ? 'running' : 'idle',
      }));
      if (this.sessionManager) {
        const cwd = this.sessionManager.cwd;
        // Collect available MCP tools for reference
        let mcpServers = [];
        try { mcpServers = require('./mcp/servers').listTools(); } catch {}
        ws.send(JSON.stringify({
          type: 'chat:settings',
          tabId: 'tab-1',
          cwd,
          outputsDir: OUTPUTS_DIR,
          capabilities: this.sessionManager.capabilities,
          profiles: profilesWithUsage(),
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
      }

      // Send running Claude process count
      ws.send(JSON.stringify({ type: 'claude:count', count: getActiveProcessCount() }));

      // Send session list and active session
      ws.send(JSON.stringify({
        type: 'session:list',
        sessions: this.store.listSessions(),
        activeId: this.store.sessionId,
      }));

      // MCP Server Manager init
      if (this.mcpHandler) this.mcpHandler.onConnect(ws);
      // Workflow handler init
      if (this.workflowHandler) this.workflowHandler.onConnect(ws);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          const tabId = msg.tabId || 'tab-1';
          if (msg.type === 'chat:send' && this.sessionManager) {
            this.sessionManager.send(tabId, msg.prompt || '');
          } else if (msg.type === 'chat:stop' && this.sessionManager) {
            this.sessionManager.kill(tabId);
          } else if (msg.type === 'chat:setCwd' && this.sessionManager) {
            this.sessionManager.setCwd(msg.cwd || '', tabId);
          } else if (msg.type === 'chat:newTab' && this.sessionManager) {
            const newTabId = this.sessionManager.nextTabId();
            this.sessionManager.getOrCreate(newTabId);
            const session = this.sessionManager.get(newTabId);
            if (session) session.setReady();
            this.broadcast({ type: 'chat:tabs', tabs: this.sessionManager.list() });
          } else if (msg.type === 'chat:closeTab' && this.sessionManager) {
            if (msg.tabId && msg.tabId !== 'tab-1') {
              this.sessionManager.remove(msg.tabId);
              this.broadcast({ type: 'chat:tabs', tabs: this.sessionManager.list() });
            }
          } else if (msg.type === 'session:delete' && this.sessionManager) {
            const ok = this.store.deleteSession(msg.id);
            if (ok) {
              this.broadcast({ type: 'session:list', sessions: this.store.listSessions(), activeId: this.store.sessionId });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', tabId, text: `Cannot delete session ${msg.id}` }));
            }
          } else if (msg.type === 'session:new' && this.sessionManager) {
            this.sessionManager.newSession(tabId);
            this.broadcast({ type: 'session:switched', activeId: this.store.sessionId, interactions: [], chatHistory: [] });
            this.broadcast({ type: 'session:list', sessions: this.store.listSessions(), activeId: this.store.sessionId });
          } else if (msg.type === 'session:switch' && this.sessionManager) {
            const data = this.sessionManager.switchSession(msg.id, tabId);
            if (data) {
              // Build chat history from saved interactions
              const chatHistory = this._extractChatHistory(data.interactions);
              // Build inspector interactions (reconstruct enough for the timeline)
              const inspectorInteractions = this._reconstructInteractions(data.interactions);
              this.broadcast({ type: 'session:switched', activeId: this.store.sessionId, interactions: inspectorInteractions, chatHistory });
              this.broadcast({ type: 'session:list', sessions: this.store.listSessions(), activeId: this.store.sessionId });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', tabId, text: `Session ${msg.id} not found` }));
            }
          } else if (msg.type === 'ask:answer') {
            // Resolve a pending AskUserQuestion
            const pending = pendingQuestions.get(msg.toolUseId);
            if (pending?.resolve) {
              pending.resolve(msg.answer);
            }
          // --- Capabilities / Profiles ---
          } else if (msg.type === 'chat:setCapabilities' && this.sessionManager) {
            this.sessionManager.setCapabilities(msg.capabilities);
            const cwd = this.sessionManager.cwd;
            this.broadcast({ type: 'profile:list', profiles: profilesWithUsage() });
          } else if (msg.type === 'chat:switchProfile' && this.sessionManager) {
            const ok = this.sessionManager.switchProfile(msg.name);
            if (!ok) {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Unknown profile: ${msg.name}` }));
            } else {
              const cwd = this.sessionManager.cwd;
              this.broadcast({ type: 'profile:list', profiles: profilesWithUsage() });
            }
          } else if (msg.type === 'profile:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'profile:list', profiles: profilesWithUsage() }));
          } else if (msg.type === 'profile:save') {
            // Handle rename: if oldName provided and differs, delete old file first
            if (msg.oldName && msg.oldName !== msg.profile?.name) {
              const usage = workflows.getProfileUsage(PROJECT_ROOT);
              if (usage[msg.oldName]?.length) {
                ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot rename profile "${msg.oldName}" — it is used in workflows` }));
                return;
              }
              caps.deleteProfile(PROJECT_ROOT, msg.oldName);
              if (this.sessionManager && this.sessionManager.capabilities.name === msg.oldName) {
                this.sessionManager.switchProfile(msg.profile.name);
              }
            }
            const ok = caps.saveProfile(PROJECT_ROOT, msg.profile);
            if (ok) {
              this.broadcast({ type: 'profile:list', profiles: profilesWithUsage() });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save profile: ${msg.profile?.name} (invalid or builtin name)` }));
            }
          } else if (msg.type === 'profile:delete') {
            const usage = workflows.getProfileUsage(PROJECT_ROOT);
            if (usage[msg.name]?.length) {
              const refs = usage[msg.name].map(u => `${u.workflow} (${u.steps.join(', ')})`).join('; ');
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete profile "${msg.name}" — used in: ${refs}` }));
              return;
            }
            const ok = caps.deleteProfile(PROJECT_ROOT, msg.name);
            if (ok) {
              if (this.sessionManager && this.sessionManager.capabilities.name === msg.name) {
                this.sessionManager.switchProfile('full');
              }
              this.broadcast({ type: 'profile:list', profiles: profilesWithUsage() });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete profile: ${msg.name}` }));
            }
          } else if (msg.type === 'profile:duplicate') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.duplicateProfile(PROJECT_ROOT, msg.source, msg.newName);
            if (ok) {
              this.broadcast({ type: 'profile:list', profiles: profilesWithUsage() });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot duplicate profile: invalid name or source` }));
            }
          // --- Skills ---
          } else if (msg.type === 'skill:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) }));
          } else if (msg.type === 'skill:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveSkill(PROJECT_ROOT, msg.name, msg.content, msg.extraFiles);
            if (ok) {
              this.broadcast({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid skill name: ${msg.name}` }));
            }
          } else if (msg.type === 'skill:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteSkill(PROJECT_ROOT, msg.name);
            if (ok) this.broadcast({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
          // --- Agents ---
          } else if (msg.type === 'agent:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) }));
          } else if (msg.type === 'agent:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveAgent(PROJECT_ROOT, msg.name, msg.content);
            if (ok) {
              this.broadcast({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid agent name: ${msg.name}` }));
            }
          } else if (msg.type === 'agent:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteAgent(PROJECT_ROOT, msg.name);
            if (ok) this.broadcast({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
          // --- Hooks ---
          } else if (msg.type === 'hook:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) }));
          } else if (msg.type === 'hook:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            caps.saveHook(PROJECT_ROOT, msg.hook);
            this.broadcast({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
          } else if (msg.type === 'hook:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteHook(PROJECT_ROOT, msg.event, msg.entryIndex);
            if (ok) this.broadcast({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
          // --- Models ---
          } else if (msg.type === 'model:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) }));
          } else if (msg.type === 'model:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveModel(PROJECT_ROOT, msg.model);
            if (ok) {
              this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save model: ${msg.model?.name} (invalid)` }));
            }
          } else if (msg.type === 'model:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteModel(PROJECT_ROOT, msg.name);
            if (ok) {
              this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete model: ${msg.name}` }));
            }
          } else if (msg.type === 'anthropic:pricing:save') {
            if (msg.pricing && typeof msg.pricing === 'object') {
              caps.updateAnthropicPricing(PROJECT_ROOT, msg.pricing);
            }
          // --- Providers ---
          } else if (msg.type === 'provider:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) }));
          } else if (msg.type === 'provider:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveProvider(PROJECT_ROOT, msg.key, msg.provider);
            if (ok) {
              this.broadcast({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
              // Resolved models include provider apiKey, so refresh models too
              this.broadcast({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save provider: ${msg.key}` }));
            }
          } else if (msg.type === 'provider:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
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
          } else if (msg.type.startsWith('mcp:')) {
            if (this.mcpHandler) this.mcpHandler.handleMessage(ws, msg, this);
          } else if (msg.type.startsWith('workflow:')) {
            if (this.workflowHandler) this.workflowHandler.handleMessage(ws, msg, this);
          }
        } catch (err) { console.error('WS message handling error:', err); }
      });
    });
  }

  _isNewUserTurn(inter) {
    const ep = inter.request?.endpoint || '/v1/messages';
    if (ep.startsWith('mcp://') || ep.startsWith('hook://')) return false;
    const msgs = inter.request?.messages;
    if (!msgs || msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    if (last.role !== 'user') return false;
    const content = Array.isArray(last.content) ? last.content : [];
    if (content.length === 0) return typeof last.content === 'string';
    return content[content.length - 1]?.type === 'text';
  }

  _extractAssistantText(inter) {
    // Try body.content first (non-streaming)
    const body = inter.response?.body;
    if (body?.content) {
      const texts = body.content.filter(b => b.type === 'text').map(b => b.text);
      if (texts.length > 0) return texts.join('\n');
    }
    // Fall back to SSE events (streaming)
    const events = inter.response?.sseEvents || [];
    let text = '';
    for (const e of events) {
      let data = e.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { continue; } }
      if (data?.delta?.type === 'text_delta') text += data.delta.text || '';
    }
    return text || null;
  }

  _extractUserPrompt(inter) {
    const msgs = inter.request?.messages || [];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') return null;
    const content = last.content;
    if (typeof content === 'string') {
      return content.startsWith('<system-reminder>') ? null : content;
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter(b => b.type === 'text' && !b.text.startsWith('<system-reminder>'))
        .map(b => b.text);
      return texts.length > 0 ? texts[texts.length - 1] : null;
    }
    return null;
  }

  _extractChatHistory(interactions) {
    const history = [];
    let segmentStart = -1;

    for (let i = 0; i < interactions.length; i++) {
      if (!this._isNewUserTurn(interactions[i])) continue;

      // Push assistant text from the previous segment (last interaction before this new turn)
      if (segmentStart >= 0) {
        for (let j = i - 1; j >= segmentStart; j--) {
          const text = this._extractAssistantText(interactions[j]);
          if (text) { history.push({ role: 'assistant', text }); break; }
        }
      }

      // Push user prompt for this turn
      const prompt = this._extractUserPrompt(interactions[i]);
      if (prompt) history.push({ role: 'user', text: prompt });
      segmentStart = i;
    }

    // Push assistant text from the final segment
    if (segmentStart >= 0) {
      for (let j = interactions.length - 1; j >= segmentStart; j--) {
        const text = this._extractAssistantText(interactions[j]);
        if (text) { history.push({ role: 'assistant', text }); break; }
      }
    }

    return history;
  }

  _reconstructInteractions(savedInteractions) {
    return savedInteractions.map((inter, i) => {
      const id = `restored-${i}-${Date.now()}`;
      return {
        id,
        endpoint: (inter.request?.endpoint?.startsWith('mcp://') || inter.request?.endpoint?.startsWith('hook://'))
          ? inter.request.endpoint : '/v1/messages',
        originalEndpoint: inter.request?.endpoint || '/v1/messages',
        isMcp: !!inter.request?.endpoint?.startsWith('mcp://'),
        isHook: !!inter.request?.endpoint?.startsWith('hook://'),
        profile: inter.request?.profile || null,
        stepId: inter.request?.stepId || null,
        runId: inter.request?.runId || null,
        timestamp: inter.request?.timestamp || null,
        isStreaming: inter.request?.isStreaming ?? true,
        request: {
          model: inter.request?.model,
          messages: inter.request?.messages,
          system: inter.request?.system,
          tools: inter.request?.tools,
        },
        response: {
          status: inter.response?.status,
          headers: inter.response?.headers || {},
          body: inter.response?.body || null,
          sseEvents: inter.response?.sseEvents || [],
        },
        status: inter.response?.result || 'complete',
        timing: inter.response?.timing || {},
        usage: inter.response?.usage || null,
      };
    });
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
    // Notify API listeners
    for (const listener of this.apiListeners) {
      try { listener(message); } catch {}
    }
  }

  addApiListener(fn) { this.apiListeners.add(fn); }
  removeApiListener(fn) { this.apiListeners.delete(fn); }
}

module.exports = DashboardBroadcaster;
