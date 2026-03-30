const WebSocket = require('ws');
const { sanitizeForDashboard } = require('./utils');
const { pendingQuestions } = require('./proxy');
const caps = require('./capabilities');

class DashboardBroadcaster {
  constructor(wss, store, sessionManager) {
    this.wss = wss;
    this.store = store;
    this.sessionManager = sessionManager;
    this.mcpHandler = null; // Set externally by src/mcp/index.js
    this.workflowHandler = null; // Set externally by src/workflow-handler.js

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
          capabilities: this.sessionManager.capabilities,
          profiles: caps.listProfiles(cwd),
          knownTools: caps.KNOWN_TOOLS,
          knownSkills: caps.KNOWN_SKILLS,
          hookEvents: caps.HOOK_EVENTS,
          matcherEvents: caps.MATCHER_EVENTS,
          mcpServers,
        }));
        // Send skills, agents, hooks for capabilities tab
        ws.send(JSON.stringify({ type: 'skill:list', skills: caps.listSkills(cwd) }));
        ws.send(JSON.stringify({ type: 'agent:list', agents: caps.listAgents(cwd) }));
        ws.send(JSON.stringify({ type: 'hook:list', hooks: caps.listHooks(cwd) }));
        ws.send(JSON.stringify({ type: 'model:list', models: caps.listModels(cwd) }));
        ws.send(JSON.stringify({ type: 'provider:list', providers: caps.listProviders(cwd) }));
      }

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
            const ok = this.sessionManager.setCwd(msg.cwd || '', tabId);
            if (!ok) {
              ws.send(JSON.stringify({ type: 'chat:error', tabId, text: `Invalid directory: ${msg.cwd}` }));
            }
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
            this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
          } else if (msg.type === 'chat:switchProfile' && this.sessionManager) {
            const ok = this.sessionManager.switchProfile(msg.name);
            if (!ok) {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Unknown profile: ${msg.name}` }));
            } else {
              const cwd = this.sessionManager.cwd;
              this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
            }
          } else if (msg.type === 'profile:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'profile:list', profiles: caps.listProfiles(cwd) }));
          } else if (msg.type === 'profile:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveProfile(cwd, msg.profile);
            if (ok) {
              this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save profile: ${msg.profile?.name} (invalid or builtin name)` }));
            }
          } else if (msg.type === 'profile:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteProfile(cwd, msg.name);
            if (ok) {
              // If active profile was deleted, switch to full
              if (this.sessionManager && this.sessionManager.capabilities.name === msg.name) {
                this.sessionManager.switchProfile('full');
              }
              this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete profile: ${msg.name}` }));
            }
          } else if (msg.type === 'profile:duplicate') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.duplicateProfile(cwd, msg.source, msg.newName);
            if (ok) {
              this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot duplicate profile: invalid name or source` }));
            }
          // --- Skills ---
          } else if (msg.type === 'skill:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'skill:list', skills: caps.listSkills(cwd) }));
          } else if (msg.type === 'skill:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveSkill(cwd, msg.name, msg.content, msg.extraFiles);
            if (ok) {
              this.broadcast({ type: 'skill:list', skills: caps.listSkills(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid skill name: ${msg.name}` }));
            }
          } else if (msg.type === 'skill:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteSkill(cwd, msg.name);
            if (ok) this.broadcast({ type: 'skill:list', skills: caps.listSkills(cwd) });
          // --- Agents ---
          } else if (msg.type === 'agent:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'agent:list', agents: caps.listAgents(cwd) }));
          } else if (msg.type === 'agent:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveAgent(cwd, msg.name, msg.content);
            if (ok) {
              this.broadcast({ type: 'agent:list', agents: caps.listAgents(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid agent name: ${msg.name}` }));
            }
          } else if (msg.type === 'agent:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteAgent(cwd, msg.name);
            if (ok) this.broadcast({ type: 'agent:list', agents: caps.listAgents(cwd) });
          // --- Hooks ---
          } else if (msg.type === 'hook:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'hook:list', hooks: caps.listHooks(cwd) }));
          } else if (msg.type === 'hook:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            caps.saveHook(cwd, msg.hook);
            this.broadcast({ type: 'hook:list', hooks: caps.listHooks(cwd) });
          } else if (msg.type === 'hook:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteHook(cwd, msg.event, msg.entryIndex);
            if (ok) this.broadcast({ type: 'hook:list', hooks: caps.listHooks(cwd) });
          // --- Models ---
          } else if (msg.type === 'model:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'model:list', models: caps.listModels(cwd) }));
          } else if (msg.type === 'model:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveModel(cwd, msg.model);
            if (ok) {
              this.broadcast({ type: 'model:list', models: caps.listModels(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save model: ${msg.model?.name} (invalid)` }));
            }
          } else if (msg.type === 'model:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteModel(cwd, msg.name);
            if (ok) {
              this.broadcast({ type: 'model:list', models: caps.listModels(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete model: ${msg.name}` }));
            }
          // --- Providers ---
          } else if (msg.type === 'provider:list') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'provider:list', providers: caps.listProviders(cwd) }));
          } else if (msg.type === 'provider:save') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.saveProvider(cwd, msg.key, msg.provider);
            if (ok) {
              this.broadcast({ type: 'provider:list', providers: caps.listProviders(cwd) });
              // Resolved models include provider apiKey, so refresh models too
              this.broadcast({ type: 'model:list', models: caps.listModels(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save provider: ${msg.key}` }));
            }
          } else if (msg.type === 'provider:delete') {
            const cwd = this.sessionManager?.cwd || process.cwd();
            const ok = caps.deleteProvider(cwd, msg.key);
            if (ok) {
              this.broadcast({ type: 'provider:list', providers: caps.listProviders(cwd) });
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

  _extractChatHistory(interactions) {
    const history = [];
    for (const inter of interactions) {
      // Extract user prompt from the last user message
      const messages = inter.request?.messages || [];
      for (const m of messages) {
        if (m.role === 'user') {
          const content = m.content;
          if (typeof content === 'string') {
            // Skip system reminder texts
            if (!content.startsWith('<system-reminder>')) {
              history.push({ role: 'user', text: content });
            }
          } else if (Array.isArray(content)) {
            // Find the actual user text (last text block, skip system-reminders)
            const texts = content
              .filter(b => b.type === 'text' && !b.text.startsWith('<system-reminder>'))
              .map(b => b.text);
            if (texts.length > 0) {
              history.push({ role: 'user', text: texts[texts.length - 1] });
            }
          }
        }
      }
      // Extract assistant response
      const body = inter.response?.body;
      if (body?.content) {
        const textBlocks = body.content.filter(b => b.type === 'text').map(b => b.text);
        if (textBlocks.length > 0) {
          history.push({ role: 'assistant', text: textBlocks.join('\n') });
        }
      }
    }
    return history;
  }

  _reconstructInteractions(savedInteractions) {
    return savedInteractions.map((inter, i) => {
      const id = `restored-${i}-${Date.now()}`;
      return {
        id,
        endpoint: inter.request?.endpoint || '/v1/messages',
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
  }
}

module.exports = DashboardBroadcaster;
