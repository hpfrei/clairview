const fs = require('fs');
const path = require('path');

const INTERACTIONS_DIR = path.join(__dirname, '..', 'interactions');

class InteractionStore {
  constructor(maxSize = 200) {
    this.interactions = new Map();
    this.order = [];
    this.maxSize = maxSize;
    this.seqMap = new Map(); // interaction id -> sequence number
    this.seq = 0;

    // Ensure root dir exists, derive session id from existing dirs
    fs.mkdirSync(INTERACTIONS_DIR, { recursive: true });
    this.sessionId = this._nextSessionId();
    this._ensureSessionDir();
  }

  _nextSessionId() {
    try {
      const ids = fs.readdirSync(INTERACTIONS_DIR)
        .map(Number)
        .filter(n => !isNaN(n) && n > 0);
      return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    } catch {
      return 1;
    }
  }

  _ensureSessionDir() {
    this.sessionDir = path.join(INTERACTIONS_DIR, String(this.sessionId));
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  _isSessionEmpty(id) {
    const dir = path.join(INTERACTIONS_DIR, String(id));
    try {
      const files = fs.readdirSync(dir).filter(f => f !== 'meta.json');
      return files.length === 0;
    } catch {
      return true;
    }
  }

  _purgeEmpty() {
    try {
      const ids = fs.readdirSync(INTERACTIONS_DIR)
        .map(Number)
        .filter(n => !isNaN(n) && n > 0 && n !== this.sessionId);
      for (const id of ids) {
        if (this._isSessionEmpty(id)) {
          this._deleteSessionDir(id);
        }
      }
    } catch {}
  }

  _deleteSessionDir(id) {
    const dir = path.join(INTERACTIONS_DIR, String(id));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  add(interaction) {
    if (this.order.length >= this.maxSize) {
      const oldestId = this.order.shift();
      this.interactions.delete(oldestId);
      this.seqMap.delete(oldestId);
    }
    this.interactions.set(interaction.id, interaction);
    this.order.push(interaction.id);
    this.seq++;
    this.seqMap.set(interaction.id, this.seq);
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
    const seqNum = this.seqMap.get(id);
    if (!seqNum) return;

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

    const filePath = path.join(this.sessionDir, `${seqNum}.json`);
    fs.writeFile(filePath, JSON.stringify(fileContent, null, 2), (err) => {
      if (err) console.error(`Failed to write interaction ${seqNum}:`, err.message);
    });
  }

  saveSessionMeta(claudeSessionId) {
    const metaPath = path.join(this.sessionDir, 'meta.json');
    const meta = { claudeSessionId, updatedAt: new Date().toISOString() };
    fs.writeFile(metaPath, JSON.stringify(meta, null, 2), (err) => {
      if (err) console.error(`Failed to write session meta:`, err.message);
    });
  }

  listSessions() {
    try {
      const dirs = fs.readdirSync(INTERACTIONS_DIR)
        .map(Number)
        .filter(n => !isNaN(n) && n > 0)
        .sort((a, b) => b - a); // newest first

      const sessions = [];
      for (const id of dirs) {
        const dir = path.join(INTERACTIONS_DIR, String(id));
        const metaPath = path.join(dir, 'meta.json');
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}

        // Count interaction files (exclude meta.json)
        let count = 0;
        try {
          count = fs.readdirSync(dir).filter(f => f !== 'meta.json').length;
        } catch {}

        // Skip empty sessions unless it's the active one
        if (count === 0 && id !== this.sessionId) continue;

        // Get timestamp from dir stat
        let timestamp = null;
        try {
          const stat = fs.statSync(dir);
          timestamp = stat.mtime.toISOString();
        } catch {}

        sessions.push({
          id,
          claudeSessionId: meta.claudeSessionId || null,
          interactionCount: count,
          timestamp,
          active: id === this.sessionId,
        });
      }
      return sessions;
    } catch {
      return [];
    }
  }

  loadSession(id) {
    const dir = path.join(INTERACTIONS_DIR, String(id));
    if (!fs.existsSync(dir)) return null;

    // Read meta
    const metaPath = path.join(dir, 'meta.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}

    // Read interaction files in order
    const files = fs.readdirSync(dir)
      .filter(f => f !== 'meta.json' && f.endsWith('.json'))
      .map(f => ({ name: f, num: parseInt(f, 10) }))
      .filter(f => !isNaN(f.num))
      .sort((a, b) => a.num - b.num);

    const interactions = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf-8'));
        interactions.push(data);
      } catch {}
    }

    return { meta, interactions };
  }

  switchTo(id) {
    // Clear in-memory state and point to existing session
    this.interactions.clear();
    this.order = [];
    this.seqMap.clear();
    this.seq = 0;
    this.sessionId = id;
    this._ensureSessionDir();

    // Count existing files to resume seq numbering
    try {
      const files = fs.readdirSync(this.sessionDir)
        .filter(f => f !== 'meta.json' && f.endsWith('.json'));
      this.seq = files.length;
    } catch {}
  }

  newSession() {
    this._purgeEmpty();
    this.interactions.clear();
    this.order = [];
    this.seqMap.clear();
    this.seq = 0;
    this.sessionId = this._nextSessionId();
    this._ensureSessionDir();
  }

  deleteSession(id) {
    // Can't delete active session
    if (id === this.sessionId) return false;
    const dir = path.join(INTERACTIONS_DIR, String(id));
    if (!fs.existsSync(dir)) return false;
    this._deleteSessionDir(id);
    return true;
  }
}

module.exports = InteractionStore;
