const fs = require('fs');
const path = require('path');

/**
 * TraceIndex — authoritative subagent attribution from Claude's own trace files.
 *
 * Claude writes, per session:
 *   <dir>/<sessionId>.jsonl                          main-thread transcript
 *   <dir>/<sessionId>/subagents/agent-<id>.jsonl     one per subagent
 *   <dir>/<sessionId>/subagents/agent-<id>.meta.json {agentType, description, toolUseId}
 *
 * Every assistant record carries `requestId`; every tool_use block carries an
 * `id`. The transcript a record lives in IS its owner: the main file → 'main',
 * a subagent file → that agent's id. This gives a bullet-proof map:
 *   requestId  -> agentId | 'main'   (resolves LLM turns by response request-id)
 *   toolUseId  -> agentId | 'main'   (resolves tool-call hooks by tool_use_id)
 *
 * The index watches the transcript dir and parses incrementally (append-only,
 * byte-offset tracked). When a new mapping appears it fires onResolve so the
 * store can enrich + broadcast the instant the data lands.
 */
class TraceIndex {
  /**
   * @param {string} transcriptPath absolute path to <sessionId>.jsonl
   * @param {(kind:'request'|'tool', key:string, agentId:string)=>void} onResolve
   */
  constructor(transcriptPath, onResolve) {
    this.transcriptPath = transcriptPath;
    this.onResolve = onResolve || (() => {});

    const dir = path.dirname(transcriptPath);
    const baseNoExt = path.basename(transcriptPath, '.jsonl');
    this.mainFile = transcriptPath;
    this.subagentsDir = path.join(dir, baseNoExt, 'subagents');

    this.requestIdToAgent = new Map(); // reqId -> agentId | 'main'
    this.toolUseIdToAgent = new Map();  // toolUseId -> agentId | 'main'
    this.agentMeta = new Map();         // agentId -> {agentType, description, toolUseId}

    this._offsets = new Map();          // filePath -> bytes already parsed
    this._watchers = [];
    this._rescanTimer = null;
    this._closed = false;

    this.scanAll();
    this._startWatching();
  }

  resolveRequestId(reqId) {
    return reqId ? (this.requestIdToAgent.get(reqId) ?? null) : null;
  }

  resolveToolUseId(toolUseId) {
    return toolUseId ? (this.toolUseIdToAgent.get(toolUseId) ?? null) : null;
  }

  getAgentMeta(agentId) {
    return this.agentMeta.get(agentId) || null;
  }

  /** Full (re)scan: main file + every subagent file + meta files. */
  scanAll() {
    this._scanFile(this.mainFile, 'main');
    let subFiles = [];
    try { subFiles = fs.readdirSync(this.subagentsDir); } catch { subFiles = []; }
    for (const f of subFiles) {
      if (f.endsWith('.meta.json')) {
        this._loadMeta(path.join(this.subagentsDir, f));
      } else if (/^agent-.+\.jsonl$/.test(f)) {
        const agentId = f.slice('agent-'.length, -'.jsonl'.length);
        this._scanFile(path.join(this.subagentsDir, f), agentId);
      }
    }
  }

  _loadMeta(metaPath) {
    const m = path.basename(metaPath).match(/^agent-(.+)\.meta\.json$/);
    if (!m) return;
    const agentId = m[1];
    if (this.agentMeta.has(agentId)) return;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      this.agentMeta.set(agentId, {
        agentType: meta.agentType || 'agent',
        description: meta.description || null,
        toolUseId: meta.toolUseId || null,
      });
    } catch {}
  }

  /** Parse newly-appended bytes of a transcript file, attributing to agentId. */
  _scanFile(filePath, agentId) {
    let fd;
    try { fd = fs.openSync(filePath, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      const start = this._offsets.get(filePath) || 0;
      if (size <= start) return;
      const len = size - start;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      const text = buf.toString('utf-8');
      // Only consume up to the last newline; a trailing partial line is left
      // for the next scan (offset advanced only past complete lines).
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) return;
      const complete = text.slice(0, lastNl);
      this._offsets.set(filePath, start + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf-8'));
      for (const line of complete.split('\n')) {
        if (line.trim()) this._consumeLine(line, agentId);
      }
    } catch {} finally {
      try { fs.closeSync(fd); } catch {}
    }
  }

  _consumeLine(line, agentId) {
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    if (rec.requestId && !this.requestIdToAgent.has(rec.requestId)) {
      this.requestIdToAgent.set(rec.requestId, agentId);
      this.onResolve('request', rec.requestId, agentId);
    }
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.id && !this.toolUseIdToAgent.has(block.id)) {
          this.toolUseIdToAgent.set(block.id, agentId);
          this.onResolve('tool', block.id, agentId);
        }
      }
    }
  }

  _startWatching() {
    const watchDir = (dir) => {
      try {
        const w = fs.watch(dir, () => this._scheduleRescan());
        w.on('error', () => {});
        this._watchers.push(w);
      } catch {}
    };
    // Watch the session dir (main .jsonl changes) and the subagents dir.
    watchDir(path.dirname(this.mainFile));
    try { fs.mkdirSync(this.subagentsDir, { recursive: true }); } catch {}
    watchDir(this.subagentsDir);
  }

  /** Debounced rescan — fs.watch can fire many times per flush. */
  _scheduleRescan() {
    if (this._closed || this._rescanTimer) return;
    this._rescanTimer = setTimeout(() => {
      this._rescanTimer = null;
      if (!this._closed) this.scanAll();
    }, 60);
  }

  /** Force an immediate rescan (e.g. on a SubagentStop / Stop hook). */
  rescanNow() {
    if (!this._closed) this.scanAll();
  }

  close() {
    this._closed = true;
    if (this._rescanTimer) { clearTimeout(this._rescanTimer); this._rescanTimer = null; }
    for (const w of this._watchers) { try { w.close(); } catch {} }
    this._watchers = [];
  }
}

module.exports = { TraceIndex };
