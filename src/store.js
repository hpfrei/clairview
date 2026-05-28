const fs = require('fs');
const path = require('path');
const { DATA_HOME } = require('./utils');
const { getModelPricing } = require('./capabilities');

const INTERACTIONS_DIR = path.join(DATA_HOME, 'interactions');

class InteractionStore {
  constructor(maxSize = 200) {
    this.interactions = new Map();
    this.order = [];
    this.maxSize = maxSize;
    this.seq = 0;

    // Per-CLI-session disk storage
    this.sessionMap = new Map();   // instanceId → sessId
    this.sessionSeqs = new Map();  // sessId → seq counter
    this.filePaths = new Map();    // interaction id → absolute file path
    this.requestIdIndex = new Map(); // request-id → filePath (survives eviction)

    fs.mkdirSync(INTERACTIONS_DIR, { recursive: true });
    this._loadFromDisk();
  }

  _loadFromDisk() {
    let dirs;
    try { dirs = fs.readdirSync(INTERACTIONS_DIR); } catch { return; }

    const sessionDirs = dirs.filter(name => {
      try { return fs.statSync(path.join(INTERACTIONS_DIR, name)).isDirectory(); } catch { return false; }
    });

    // Collect files grouped by session
    const sessions = [];
    for (const sessId of sessionDirs) {
      const dir = path.join(INTERACTIONS_DIR, sessId);
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
      if (files.length === 0) continue;

      let maxSeq = 0;
      let latestMtime = 0;
      const sessionFiles = [];
      for (const file of files) {
        const seqNum = parseInt(file);
        if (seqNum > maxSeq) maxSeq = seqNum;
        const filePath = path.join(dir, file);
        let mtime = 0;
        try { mtime = fs.statSync(filePath).mtimeMs; } catch {}
        if (mtime > latestMtime) latestMtime = mtime;
        sessionFiles.push({ sessId, seqNum, filePath, mtime });
      }
      this.sessionSeqs.set(sessId, maxSeq);
      sessions.push({ sessId, files: sessionFiles, latestMtime });
    }

    // Sort sessions by most recent activity, load complete sessions up to maxSize
    sessions.sort((a, b) => b.latestMtime - a.latestMtime);

    const toLoad = [];
    for (const sess of sessions) {
      if (toLoad.length + sess.files.length > this.maxSize && toLoad.length > 0) break;
      sess.files.sort((a, b) => a.mtime - b.mtime);
      toLoad.push(...sess.files);
    }
    // Final sort chronologically across all loaded sessions
    toLoad.sort((a, b) => a.mtime - b.mtime);

    for (const { sessId, seqNum, filePath } of toLoad) {
      const interaction = this._parseInteractionFile(sessId, seqNum, filePath);
      if (!interaction) continue;
      this.interactions.set(interaction.id, interaction);
      this.order.push(interaction.id);
      this.filePaths.set(interaction.id, filePath);
      const reqId = interaction.response?.headers?.['request-id'];
      if (reqId) this.requestIdIndex.set(reqId, filePath);
    }

    this.seq = this.order.length;
  }

  registerSession(instanceId, sessId) {
    this.sessionMap.set(instanceId, sessId);
    this.sessionSeqs.set(sessId, 0);
    const dir = path.join(INTERACTIONS_DIR, sessId);
    fs.mkdirSync(dir, { recursive: true });
  }

  unregisterSession(instanceId) {
    this.sessionMap.delete(instanceId);
  }

  hasSessionContent(sessId) {
    if (!sessId) return false;
    const dir = path.join(INTERACTIONS_DIR, sessId);
    try {
      const files = fs.readdirSync(dir);
      return files.some(f => f.endsWith('.json'));
    } catch {
      return false;
    }
  }

  deleteSessionData(sessId) {
    const dir = path.join(INTERACTIONS_DIR, sessId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    this.sessionSeqs.delete(sessId);
  }

  add(interaction) {
    if (this.order.length >= this.maxSize) {
      const oldestId = this.order.shift();
      this.interactions.delete(oldestId);
      this.filePaths.delete(oldestId);
    }
    this.interactions.set(interaction.id, interaction);
    this.order.push(interaction.id);
    this.seq++;
  }

  get(id) {
    return this.interactions.get(id) || this._getFromDisk(id);
  }

  _getFromDisk(id) {
    const sep = id.lastIndexOf('-');
    if (sep <= 0) return null;
    const sessId = id.slice(0, sep);
    const dir = path.join(INTERACTIONS_DIR, sessId);
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        const interaction = this._parseInteractionFile(sessId, parseInt(file), filePath);
        if (interaction && interaction.id === id) return interaction;
      }
    } catch {}
    return null;
  }

  getAll() {
    return this.order.map(id => this.interactions.get(id));
  }

  save(id) {
    const interaction = this.interactions.get(id);
    if (!interaction) return;

    const sessId = this.sessionMap.get(interaction.instanceId);
    if (!sessId) return;

    let seqNum = this.sessionSeqs.get(sessId) || 0;
    seqNum++;
    this.sessionSeqs.set(sessId, seqNum);

    // When saving a hook, inherit subagent from the parent turn if available
    if (interaction.isHook && interaction.toolUseId && !interaction.subagent && interaction.instanceId) {
      const parent = this._findTurnByToolUseId(interaction.toolUseId, interaction.instanceId);
      if (parent?.subagent) interaction.subagent = parent.subagent;
    }

    const fileContent = this._buildFileContent(interaction);

    const filePath = path.join(INTERACTIONS_DIR, sessId, `${seqNum}.json`);
    this.filePaths.set(id, filePath);
    const reqId = interaction.response?.headers?.['request-id'];
    if (reqId) this.requestIdIndex.set(reqId, filePath);
    fs.writeFile(filePath, JSON.stringify(fileContent, null, 2), (err) => {
      if (err) console.error(`Failed to write interaction ${sessId}/${seqNum}:`, err.message);
    });
  }

  findByRequestId(requestId) {
    if (!requestId) return null;
    for (const interaction of this.interactions.values()) {
      if (interaction.response?.headers?.['request-id'] === requestId) return interaction;
    }
    return null;
  }

  enrichInteraction(id, subagent) {
    const interaction = this.interactions.get(id);
    if (!interaction) return null;

    interaction.subagent = subagent;

    const filePath = this.filePaths.get(id);
    if (filePath) {
      const fileContent = this._buildFileContent(interaction);
      fs.writeFile(filePath, JSON.stringify(fileContent, null, 2), (err) => {
        if (err) console.error(`Failed to resave interaction:`, err.message);
      });
    }

    // Also enrich hooks whose toolUseId matches a tool call in this turn
    const enrichedHooks = this._enrichRelatedHooks(interaction, subagent);

    return { interaction, enrichedHooks };
  }

  /** Find hooks in the same instance whose toolUseId matches a tool call in the
   *  given turn's response, stamp them with the same subagent, and persist. */
  _enrichRelatedHooks(turn, subagent) {
    if (!turn.instanceId || turn.isHook || turn.isMcp) return [];

    // Extract tool_use IDs from the turn's response
    const toolIds = new Set();
    const body = turn.response?.body;
    if (body?.content) {
      for (const block of body.content) {
        if (block.type === 'tool_use' && block.id) toolIds.add(block.id);
      }
    }
    // Also check SSE events if body wasn't available
    if (toolIds.size === 0 && turn.response?.sseEvents?.length) {
      for (const evt of turn.response.sseEvents) {
        if (evt.eventType === 'content_block_start' && evt.data?.content_block?.type === 'tool_use') {
          const cbId = evt.data.content_block.id;
          if (cbId) toolIds.add(cbId);
        }
      }
    }
    if (toolIds.size === 0) return [];

    const enriched = [];
    for (const hookId of this.order) {
      const hook = this.interactions.get(hookId);
      if (!hook?.isHook || hook.subagent) continue;
      if (hook.instanceId !== turn.instanceId) continue;
      if (!hook.toolUseId || !toolIds.has(hook.toolUseId)) continue;

      hook.subagent = subagent;
      enriched.push(hook);

      const fp = this.filePaths.get(hookId);
      if (fp) {
        const content = this._buildFileContent(hook);
        fs.writeFile(fp, JSON.stringify(content, null, 2), (err) => {
          if (err) console.error(`Failed to resave hook:`, err.message);
        });
      }
    }
    return enriched;
  }

  enrichFromTranscript(agentTranscriptPath, broadcaster) {
    if (!agentTranscriptPath) return;
    const match = path.basename(agentTranscriptPath).match(/^agent-(.+)\.jsonl$/);
    if (!match) return;
    const agentId = match[1];
    const metaPath = agentTranscriptPath.replace(/\.jsonl$/, '.meta.json');

    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { meta = {}; }

    let lines;
    try { lines = fs.readFileSync(agentTranscriptPath, 'utf-8').split('\n'); } catch { return; }

    const enrichment = {
      agentId,
      agentType: meta.agentType || null,
      description: meta.description || null,
    };

    const seen = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'assistant' || !record.requestId) continue;
      if (seen.has(record.requestId)) continue;
      seen.add(record.requestId);

      const interaction = this.findByRequestId(record.requestId);
      if (interaction) {
        if (interaction.subagent) continue;
        const { enrichedHooks } = this.enrichInteraction(interaction.id, enrichment);
        if (broadcaster) {
          broadcaster.broadcast({ type: 'interaction:enriched', interactionId: interaction.id, subagent: enrichment });
          for (const hook of enrichedHooks) {
            broadcaster.broadcast({ type: 'interaction:enriched', interactionId: hook.id, subagent: enrichment });
          }
        }
      } else {
        // Interaction was evicted from memory — enrich on disk via requestId index
        const fp = this.requestIdIndex.get(record.requestId);
        if (fp) {
          try {
            const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            if (!data.subagent) {
              data.subagent = enrichment;
              fs.writeFileSync(fp, JSON.stringify(data, null, 2));
              if (broadcaster && data.id) {
                broadcaster.broadcast({ type: 'interaction:enriched', interactionId: data.id, subagent: enrichment });
              }
            }
          } catch {}
        }
      }
    }
  }

  /** Find the LLM turn that contains a tool_use block with the given ID. */
  _findTurnByToolUseId(toolUseId, instanceId) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const turn = this.interactions.get(this.order[i]);
      if (!turn || turn.isHook || turn.isMcp) continue;
      if (turn.instanceId !== instanceId) continue;
      const content = turn.response?.body?.content;
      if (content) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.id === toolUseId) return turn;
        }
      }
      if (turn.response?.sseEvents?.length) {
        for (const evt of turn.response.sseEvents) {
          if (evt.eventType === 'content_block_start' && evt.data?.content_block?.type === 'tool_use' && evt.data.content_block.id === toolUseId) return turn;
        }
      }
    }
    return null;
  }

  _parseInteractionFile(sessId, seqNum, filePath) {
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }

    const req = data.request || {};
    const resp = data.response || {};

    let subagent = data.subagent || null;
    if (subagent && !subagent.agentType && !subagent.agentId && !subagent.description) {
      subagent = null;
    }

    let body = resp.body ?? null;
    if (!body && resp.sseEvents?.length) {
      body = InteractionStore._reconstructBodyFromSSE(resp.sseEvents);
    }

    const interaction = {
      id: data.id || `${sessId}-${seqNum}`,
      timestamp: req.timestamp || 0,
      endpoint: req.endpoint || '/v1/messages',
      originalEndpoint: req.endpoint || undefined,
      instanceId: data.instanceId || `cli-${sessId}`,
      stepId: req.stepId || null,
      runId: req.runId || null,
      request: req,
      response: {
        status: resp.status ?? null,
        headers: resp.headers || {},
        body,
        sseEvents: resp.sseEvents || [],
        error: resp.error || undefined,
      },
      timing: resp.timing || { startedAt: req.timestamp || 0, ttfb: null, duration: null },
      usage: resp.usage || null,
      isStreaming: req.isStreaming || false,
      status: resp.result || 'complete',
      bare: req.bare || false,
      disableAutoMemory: req.disableAutoMemory !== false,
      subagent: subagent || undefined,
      pricing: data.pricing || (req.model ? getModelPricing(DATA_HOME, req.model) : undefined),
    };
    if (data.isHook) {
      interaction.isHook = true;
      interaction.hookEvent = data.hookEvent || 'unknown';
      interaction.toolName = data.toolName || null;
      interaction.toolUseId = data.toolUseId || null;
      interaction.hookAgentId = data.hookAgentId || null;
    }
    if (data.isMcp) {
      interaction.isMcp = true;
      interaction.mcpSource = data.mcpSource || undefined;
    }
    return interaction;
  }

  getAllFromDisk() {
    const dirs = [];
    try { dirs.push(...fs.readdirSync(INTERACTIONS_DIR)); } catch { return []; }
    const sessionDirs = dirs.filter(name => {
      try { return fs.statSync(path.join(INTERACTIONS_DIR, name)).isDirectory(); } catch { return false; }
    });
    const allFiles = [];
    for (const sessId of sessionDirs) {
      const dir = path.join(INTERACTIONS_DIR, sessId);
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
      for (const file of files) {
        const seqNum = parseInt(file);
        allFiles.push({ sessId, seqNum, filePath: path.join(dir, file) });
      }
    }
    // Build reverse lookup: filePath → in-memory ID (for files saved before id was persisted)
    const pathToMemId = new Map();
    for (const [id, fp] of this.filePaths) pathToMemId.set(fp, id);

    const results = [];
    for (const { sessId, seqNum, filePath } of allFiles) {
      const memId = pathToMemId.get(filePath);
      if (memId) {
        const memInteraction = this.interactions.get(memId);
        if (memInteraction) { results.push(memInteraction); continue; }
      }
      const interaction = this._parseInteractionFile(sessId, seqNum, filePath);
      if (interaction) results.push(interaction);
    }
    results.sort((a, b) => a.timestamp - b.timestamp);
    return results;
  }

  removeFromMemory(instanceIds) {
    const idSet = new Set(instanceIds);
    const toRemove = new Set();
    for (const id of this.order) {
      const interaction = this.interactions.get(id);
      if (interaction && idSet.has(interaction.instanceId)) {
        toRemove.add(id);
      }
    }
    for (const id of toRemove) {
      this.interactions.delete(id);
      this.filePaths.delete(id);
    }
    this.order = this.order.filter(id => !toRemove.has(id));
    return toRemove.size;
  }

  loadSessionIntoMemory(sessId) {
    const instanceId = `cli-${sessId}`;
    const existing = this.order.filter(id => {
      const i = this.interactions.get(id);
      return i && i.instanceId === instanceId;
    });
    if (existing.length > 0) return existing.map(id => this.interactions.get(id));

    const dir = path.join(INTERACTIONS_DIR, sessId);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }

    const loaded = [];
    let maxSeq = 0;
    for (const file of files) {
      const seqNum = parseInt(file);
      if (seqNum > maxSeq) maxSeq = seqNum;
      const filePath = path.join(dir, file);
      const interaction = this._parseInteractionFile(sessId, seqNum, filePath);
      if (!interaction) continue;

      if (this.order.length >= this.maxSize) {
        const oldestId = this.order.shift();
        this.interactions.delete(oldestId);
        this.filePaths.delete(oldestId);
      }
      this.interactions.set(interaction.id, interaction);
      this.order.push(interaction.id);
      this.filePaths.set(interaction.id, filePath);
      loaded.push(interaction);
    }

    if (maxSeq > 0) this.sessionSeqs.set(sessId, maxSeq);
    return loaded;
  }

  _buildFileContent(interaction) {
    const out = {
      id: interaction.id,
      instanceId: interaction.instanceId || undefined,
      request: {
        ...interaction.request,
        endpoint: interaction.endpoint,
        timestamp: interaction.timestamp,
        isStreaming: interaction.isStreaming,
        stepId: interaction.stepId || undefined,
        runId: interaction.runId || undefined,
      },
      response: {
        status: interaction.response?.status ?? null,
        headers: interaction.response?.headers ?? {},
        body: interaction.response?.body ?? null,
        sseEvents: interaction.response?.sseEvents ?? [],
        error: interaction.response?.error ?? undefined,
        timing: interaction.timing,
        usage: interaction.usage,
        result: interaction.status,
      },
      subagent: interaction.subagent || undefined,
      pricing: interaction.pricing || undefined,
    };
    if (interaction.isHook) {
      out.isHook = true;
      out.hookEvent = interaction.hookEvent;
      out.toolName = interaction.toolName || undefined;
      out.toolUseId = interaction.toolUseId || undefined;
      out.hookAgentId = interaction.hookAgentId || undefined;
    }
    if (interaction.isMcp) {
      out.isMcp = true;
      out.mcpSource = interaction.mcpSource || undefined;
    }
    return out;
  }

  static _reconstructBodyFromSSE(sseEvents) {
    const content = [];
    const jsonParts = new Map();
    for (const e of sseEvents) {
      if (e.eventType === 'content_block_start' && e.data?.content_block) {
        content[e.data.index] = { ...e.data.content_block };
        if (e.data.content_block.type === 'tool_use') jsonParts.set(e.data.index, '');
      } else if (e.eventType === 'content_block_delta') {
        const idx = e.data?.index;
        const delta = e.data?.delta;
        if (delta?.type === 'text_delta' && content[idx]) {
          content[idx].text = (content[idx].text || '') + (delta.text || '');
        } else if (delta?.type === 'thinking_delta' && content[idx]) {
          content[idx].thinking = (content[idx].thinking || '') + (delta.thinking || '');
          if (delta.estimated_tokens) content[idx].estimated_tokens = (content[idx].estimated_tokens || 0) + delta.estimated_tokens;
        } else if (delta?.type === 'input_json_delta' && jsonParts.has(idx)) {
          jsonParts.set(idx, jsonParts.get(idx) + (delta.partial_json || ''));
        }
      } else if (e.eventType === 'content_block_stop') {
        const idx = e.data?.index;
        if (jsonParts.has(idx) && content[idx]) {
          try { content[idx].input = JSON.parse(jsonParts.get(idx)); } catch {}
        }
      }
    }
    return content.length > 0 ? { content: content.filter(Boolean) } : null;
  }
}

module.exports = InteractionStore;
