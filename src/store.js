const fs = require('fs');
const path = require('path');
const { DATA_HOME } = require('./utils');

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
    this.pendingEnrichments = new Map(); // requestId → { data, ts }

    fs.mkdirSync(INTERACTIONS_DIR, { recursive: true });
    this._purgeNumericDirs();
    this._loadFromDisk();
  }

  _purgeNumericDirs() {
    try {
      const entries = fs.readdirSync(INTERACTIONS_DIR);
      for (const name of entries) {
        if (/^\d+$/.test(name)) {
          fs.rmSync(path.join(INTERACTIONS_DIR, name), { recursive: true, force: true });
        }
      }
    } catch {}
  }

  _loadFromDisk() {
    let dirs;
    try { dirs = fs.readdirSync(INTERACTIONS_DIR); } catch { return; }

    const sessionDirs = dirs.filter(name => {
      try { return fs.statSync(path.join(INTERACTIONS_DIR, name)).isDirectory(); } catch { return false; }
    });

    // Collect all interaction files with their timestamps for global chronological ordering
    const allFiles = [];
    for (const sessId of sessionDirs) {
      const dir = path.join(INTERACTIONS_DIR, sessId);
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }

      let maxSeq = 0;
      for (const file of files) {
        const seqNum = parseInt(file);
        if (seqNum > maxSeq) maxSeq = seqNum;
        allFiles.push({ sessId, file, seqNum, filePath: path.join(dir, file) });
      }
      this.sessionSeqs.set(sessId, maxSeq);
    }

    // Sort by timestamp (read from file), keep only the most recent maxSize
    // For efficiency, sort by file mtime as a proxy for timestamp
    for (const entry of allFiles) {
      try { entry.mtime = fs.statSync(entry.filePath).mtimeMs; } catch { entry.mtime = 0; }
    }
    allFiles.sort((a, b) => a.mtime - b.mtime);

    // Only load the most recent maxSize interactions
    const toLoad = allFiles.slice(-this.maxSize);

    for (const { sessId, seqNum, filePath } of toLoad) {
      const interaction = this._parseInteractionFile(sessId, seqNum, filePath);
      if (!interaction) continue;
      this.interactions.set(interaction.id, interaction);
      this.order.push(interaction.id);
      this.filePaths.set(interaction.id, filePath);
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
    return this.interactions.get(id);
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

    const reqId = interaction.response?.headers?.['request-id'];
    if (reqId && this.pendingEnrichments.has(reqId)) {
      interaction.subagent = this.pendingEnrichments.get(reqId).data;
      this.pendingEnrichments.delete(reqId);
    }

    this._prunePendingEnrichments();

    const fileContent = this._buildFileContent(interaction);

    const filePath = path.join(INTERACTIONS_DIR, sessId, `${seqNum}.json`);
    this.filePaths.set(id, filePath);
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
    return interaction;
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

    return {
      id: `${sessId}-${seqNum}`,
      timestamp: req.timestamp || 0,
      endpoint: req.endpoint || '/v1/messages',
      originalEndpoint: req.endpoint || undefined,
      instanceId: `cli-${sessId}`,
      stepId: req.stepId || null,
      runId: req.runId || null,
      profile: req.profile || null,
      request: req,
      response: {
        status: resp.status ?? null,
        headers: resp.headers || {},
        body: resp.body ?? null,
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
    };
  }

  getActiveInteractions() {
    const activeInstanceIds = new Set(this.sessionMap.keys());
    return this.order
      .map(id => this.interactions.get(id))
      .filter(i => i && activeInstanceIds.has(i.instanceId));
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
    return {
      request: {
        ...interaction.request,
        endpoint: interaction.endpoint,
        timestamp: interaction.timestamp,
        isStreaming: interaction.isStreaming,
        profile: interaction.profile || undefined,
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
    };
  }

  _prunePendingEnrichments() {
    const now = Date.now();
    for (const [key, entry] of this.pendingEnrichments) {
      if (now - entry.ts > 60000) this.pendingEnrichments.delete(key);
    }
  }

  removeByInstanceIds(instanceIds) {
    const idSet = new Set(instanceIds);
    const toRemove = [];
    for (const id of this.order) {
      const interaction = this.interactions.get(id);
      if (interaction && idSet.has(interaction.instanceId)) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      const filePath = this.filePaths.get(id);
      if (filePath) {
        try { fs.unlinkSync(filePath); } catch {}
        this.filePaths.delete(id);
      }
      this.interactions.delete(id);
    }
    this.order = this.order.filter(id => !toRemove.includes(id));
    return toRemove.length;
  }
}

module.exports = InteractionStore;
