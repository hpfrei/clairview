const fs = require('fs');
const path = require('path');

class JsonlWatcher {
  constructor(transcriptPath, onEnrichment) {
    this.mainJsonl = transcriptPath;
    this.onEnrichment = onEnrichment;

    this.sessionDir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'));
    this.subagentDir = path.join(this.sessionDir, 'subagents');

    this._fileOffsets = new Map();
    this._agentMeta = new Map();
    this._seenRequestIds = new Set();
    this._pendingByAgent = new Map(); // agentId → [{requestId, isSidechain}]
    this._watchers = [];
    this._pollTimer = null;
    this._watchingSubagentDir = false;
    this._stopped = false;
  }

  start() {
    this._scanMainJsonl();
    this._scanSubagentDir();
    this._watchSessionDir();

    this._pollTimer = setInterval(() => {
      if (this._stopped) return;
      this._scanMainJsonl();
      this._scanSubagentDir();
    }, 2000);
  }

  stop() {
    this._stopped = true;
    for (const w of this._watchers) {
      try { w.close(); } catch {}
    }
    this._watchers = [];
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _scanMainJsonl() {
    if (fs.existsSync(this.mainJsonl)) {
      this._readNewLines(this.mainJsonl);
    }
  }

  _scanSubagentDir() {
    if (!fs.existsSync(this.subagentDir)) return;

    if (!this._watchingSubagentDir) {
      this._watchingSubagentDir = true;
      this._watchDir(this.subagentDir, () => this._scanSubagentDir());
    }

    let entries;
    try { entries = fs.readdirSync(this.subagentDir); } catch { return; }

    for (const name of entries) {
      if (name.endsWith('.meta.json')) {
        this._loadMetaFile(path.join(this.subagentDir, name));
      }
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) {
        this._readNewLines(path.join(this.subagentDir, name));
      }
    }
  }

  _watchSessionDir() {
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    } catch {}

    this._watchDir(this.sessionDir, (filename) => {
      if (filename === 'subagents') {
        this._scanSubagentDir();
      }
    });
  }

  _watchDir(dir, onChange) {
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (this._stopped) return;
        onChange(filename);
      });
      watcher.on('error', () => {});
      this._watchers.push(watcher);
    } catch {}
  }

  _readNewLines(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }

    const offset = this._fileOffsets.get(filePath) || 0;
    if (stat.size <= offset) return;

    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      fd = null;

      this._fileOffsets.set(filePath, stat.size);

      const text = buf.toString('utf-8');
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          this._processRecord(record);
        } catch {}
      }
    } catch {
      if (fd != null) try { fs.closeSync(fd); } catch {}
    }
  }

  _processRecord(record) {
    if (record.type !== 'assistant') return;
    if (!record.requestId) return;
    if (this._seenRequestIds.has(record.requestId)) return;

    const agentId = record.agentId || null;
    const meta = agentId ? this._agentMeta.get(agentId) : null;

    // If this record has an agentId but meta hasn't loaded yet, defer it
    if (agentId && !meta) {
      let pending = this._pendingByAgent.get(agentId);
      if (!pending) {
        pending = [];
        this._pendingByAgent.set(agentId, pending);
      }
      if (!pending.some(p => p.requestId === record.requestId)) {
        pending.push({ requestId: record.requestId, isSidechain: record.isSidechain || false });
      }
      return;
    }

    this._seenRequestIds.add(record.requestId);

    const enrichment = {
      agentId,
      agentType: meta?.agentType || record.attributionAgent || null,
      description: meta?.description || null,
      isSidechain: record.isSidechain || false,
    };

    this.onEnrichment(record.requestId, enrichment);
  }

  _loadMetaFile(filePath) {
    try {
      const match = path.basename(filePath).match(/^agent-(.+)\.meta\.json$/);
      if (!match) return;
      const agentId = match[1];
      if (this._agentMeta.has(agentId)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this._agentMeta.set(agentId, data);

      // Flush any pending records waiting for this agent's meta
      const pending = this._pendingByAgent.get(agentId);
      if (pending) {
        this._pendingByAgent.delete(agentId);
        for (const { requestId, isSidechain } of pending) {
          if (this._seenRequestIds.has(requestId)) continue;
          this._seenRequestIds.add(requestId);
          this.onEnrichment(requestId, {
            agentId,
            agentType: data.agentType || null,
            description: data.description || null,
            isSidechain,
          });
        }
      }
    } catch {}
  }
}

module.exports = JsonlWatcher;
