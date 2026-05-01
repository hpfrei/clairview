const fs = require('fs');
const path = require('path');

const INTERACTIONS_DIR = path.join(__dirname, '..', 'interactions');

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

    fs.mkdirSync(INTERACTIONS_DIR, { recursive: true });
    this._purgeNumericDirs();
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

  registerSession(instanceId, sessId) {
    this.sessionMap.set(instanceId, sessId);
    this.sessionSeqs.set(sessId, 0);
    const dir = path.join(INTERACTIONS_DIR, sessId);
    fs.mkdirSync(dir, { recursive: true });
  }

  unregisterSession(instanceId) {
    this.sessionMap.delete(instanceId);
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

    const fileContent = {
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
    };

    const filePath = path.join(INTERACTIONS_DIR, sessId, `${seqNum}.json`);
    this.filePaths.set(id, filePath);
    fs.writeFile(filePath, JSON.stringify(fileContent, null, 2), (err) => {
      if (err) console.error(`Failed to write interaction ${sessId}/${seqNum}:`, err.message);
    });
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
