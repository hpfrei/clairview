const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const CliSession = require('./cli-session');
const { readJSON, writeJSON, DATA_HOME, PACKAGE_ROOT } = require('./utils');

const HISTORY_FILE = path.join(DATA_HOME, 'data', 'cli-history.json');
const RECENT_DIRS_FILE = path.join(DATA_HOME, 'data', 'cli-recent-dirs.json');
const MAX_RECENT_DIRS = 12;

function deleteFullSessionData(store, sessId, cwd, isolated) {
  store.deleteSessionData(sessId);

  const configDir = (isolated === true)
    ? path.join(cwd, '.claude')
    : path.join(os.homedir(), '.claude');

  const slug = cwd.replace(/\//g, '-');
  const projectDir = path.join(configDir, 'projects', slug);

  try { fs.unlinkSync(path.join(projectDir, `${sessId}.jsonl`)); } catch {}
  try { fs.rmSync(path.join(projectDir, sessId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(configDir, 'file-history', sessId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(configDir, 'tasks', sessId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(configDir, 'session-env', sessId), { recursive: true, force: true }); } catch {}

  const todosDir = path.join(configDir, 'todos');
  try {
    for (const f of fs.readdirSync(todosDir)) {
      if (f.startsWith(sessId + '-')) {
        try { fs.unlinkSync(path.join(todosDir, f)); } catch {}
      }
    }
  } catch {}
}

// Roll the native Claude transcript (what `--resume` reads) back by one turn:
// drop the last genuine user prompt and everything after it (its assistant
// replies, tool calls/results, and trailing metadata). A .bak is kept in case
// the rollback needs to be undone. Returns { ok, reason?, cutTimestamp? } where
// cutTimestamp is the epoch-ms time of the removed user prompt, used to flag the
// matching inspector interactions.
function rollbackTranscript(cwd, sessId, isolated) {
  if (!cwd || !sessId) return { ok: false, reason: 'no-session' };
  const configDir = (isolated === true)
    ? path.join(cwd, '.claude')
    : path.join(os.homedir(), '.claude');
  const slug = cwd.replace(/\//g, '-');
  const jsonlPath = path.join(configDir, 'projects', slug, `${sessId}.jsonl`);

  let raw;
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch { return { ok: false, reason: 'no-transcript' }; }

  const lines = raw.split('\n');
  let targetIdx = -1;
  let targetTs = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'user' || o.isMeta || o.isSidechain) continue;
    const content = o.message && o.message.content;
    const isPrompt = typeof content === 'string'
      || (Array.isArray(content) && !content.some(b => b && b.type === 'tool_result'));
    if (isPrompt) { targetIdx = i; targetTs = o.timestamp || null; }
  }
  if (targetIdx < 0) return { ok: false, reason: 'no-user-turn' };

  let out = lines.slice(0, targetIdx).join('\n');
  if (out.length && !out.endsWith('\n')) out += '\n';
  try {
    fs.writeFileSync(jsonlPath + '.bak', raw);
    fs.writeFileSync(jsonlPath, out);
  } catch (e) {
    return { ok: false, reason: 'write-failed' };
  }
  const cutTimestamp = targetTs ? Date.parse(targetTs) : null;
  return { ok: true, cutTimestamp: Number.isFinite(cutTimestamp) ? cutTimestamp : null };
}

class CliSessionManager {
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.opts = opts;
    this.sessions = new Map();
    this._exitCallbacks = new Map();
    // Per-process identity. Tab IDs embed this so they can never collide with
    // tab IDs minted by a previous server process, and clients use it to detect
    // a restart on any reconnect (even a seamless one without a page reload).
    this.bootId = crypto.randomUUID().slice(0, 8);
    this._tabSeq = 0;
  }

  _createSession(tabId) {
    const session = new CliSession(
      this.proxyPort,
      this._wrapBroadcaster(tabId),
      this.store,
      this.opts
    );
    session.tabId = tabId;
    this.sessions.set(tabId, session);
    return session;
  }

  _wrapBroadcaster(tabId) {
    const self = this;
    return {
      broadcast(msg) {
        if (msg.type && msg.type.startsWith('cli:')) {
          msg.tabId = tabId;
        }
        if (msg.type === 'cli:exit') {
          self._onSessionExit(tabId);
        }
        self.broadcaster.broadcast(msg);
      },
    };
  }

  _onSessionExit(tabId) {
    const session = this.sessions.get(tabId);
    if (session?.sessId && session.cwd) {
      this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated, autoMemory: session.autoMemory });
    }
    const cb = this._exitCallbacks.get(tabId);
    if (cb) {
      this._exitCallbacks.delete(tabId);
      try { cb(tabId); } catch (e) { console.error('Session exit callback error:', e); }
    }
    this.sessions.delete(tabId);
    this.broadcastTabs();
  }

  saveAllToHistory() {
    for (const [, session] of this.sessions) {
      if (session?.sessId && session.cwd) {
        this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated, autoMemory: session.autoMemory });
      }
    }
  }

  // --- History persistence ---

  _loadHistory() {
    return readJSON(HISTORY_FILE, []);
  }

  saveToHistory(entry) {
    const history = this._loadHistory();
    const sessId = entry.sessId || `sess-${Date.now()}`;
    const existing = history.find(h => h.id === sessId);
    const deduped = history.filter(h => h.id !== sessId);
    const now = Date.now();
    deduped.unshift({
      id: sessId,
      cwd: entry.cwd,
      title: entry.title || null,
      settings: entry.settings || {},
      isolated: entry.isolated === true,
      autoMemory: entry.autoMemory === true,
      startedAt: existing?.startedAt || now,
      savedAt: now,
    });
    writeJSON(HISTORY_FILE, deduped);
    this.recordRecentDir(entry.cwd);
  }

  getSavedSessions() {
    const history = this._loadHistory();
    const runningIds = new Set();
    for (const session of this.sessions.values()) {
      if (session.sessId && session.running) runningIds.add(session.sessId);
    }
    for (const entry of history) {
      const stat = this._getJsonlStat(entry);
      entry.jsonlSize = stat.size;
      entry.lastInteractionAt = stat.mtime || entry.savedAt;
      entry.lastEntrySize = stat.lastEntrySize;
      if (!entry.startedAt) entry.startedAt = entry.savedAt;
      entry.isRunning = runningIds.has(entry.id);
    }
    return history;
  }

  _getJsonlStat(entry) {
    const configDir = (entry.isolated === true)
      ? path.join(entry.cwd, '.claude')
      : path.join(os.homedir(), '.claude');
    const slug = entry.cwd.replace(/\//g, '-');
    const jsonlPath = path.join(configDir, 'projects', slug, `${entry.id}.jsonl`);
    try {
      const st = fs.statSync(jsonlPath);
      return { size: st.size, mtime: st.mtimeMs, lastEntrySize: this._getLastEntrySize(jsonlPath, st.size) };
    } catch {
      return { size: 0, mtime: 0, lastEntrySize: 0 };
    }
  }

  // Byte length of the final non-empty line (the last interaction) in a .jsonl session log.
  _getLastEntrySize(jsonlPath, fileSize) {
    if (!fileSize) return 0;
    const READ = Math.min(fileSize, 256 * 1024);
    let fd;
    try {
      fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(READ);
      fs.readSync(fd, buf, 0, READ, fileSize - READ);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(l => l.length > 0);
      if (!lines.length) return 0;
      return Buffer.byteLength(lines[lines.length - 1], 'utf8');
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  // --- Recent directories ---

  _loadRecentDirs() {
    const dirs = readJSON(RECENT_DIRS_FILE, []);
    return Array.isArray(dirs) ? dirs : [];
  }

  recordRecentDir(cwd) {
    if (!cwd) return;
    const now = Date.now();
    const dirs = this._loadRecentDirs().filter(d => d.path !== cwd);
    dirs.unshift({ path: cwd, lastUsedAt: now });
    writeJSON(RECENT_DIRS_FILE, dirs.slice(0, MAX_RECENT_DIRS));
  }

  getRecentDirs() {
    return this._loadRecentDirs();
  }

  deleteRecentDir(dirPath) {
    const dirs = this._loadRecentDirs().filter(d => d.path !== dirPath);
    writeJSON(RECENT_DIRS_FILE, dirs);
  }

  deleteSavedSession(id) {
    for (const session of this.sessions.values()) {
      if (session.sessId === id && session.running) return;
    }
    const history = this._loadHistory();
    const entry = history.find(s => s.id === id);
    const filtered = history.filter(s => s.id !== id);
    writeJSON(HISTORY_FILE, filtered);
    if (entry) {
      deleteFullSessionData(this.store, id, entry.cwd, entry.isolated);
    } else {
      this.store.deleteSessionData(id);
    }
  }

  // --- Active sessions ---

  getOrCreate(tabId) {
    if (!tabId) return null;
    let session = this.sessions.get(tabId);
    if (!session) {
      session = this._createSession(tabId);
    }
    return session;
  }

  get(tabId) {
    return this.sessions.get(tabId) || null;
  }

  spawn(tabId, cwd, cols, rows, { resumeSessionId, isolated, autoMemory } = {}) {
    const session = this.getOrCreate(tabId);
    if (session.sessId && session.cwd) {
      this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated, autoMemory: session.autoMemory });
    }
    session.spawn(cwd, cols, rows, { resumeSessionId, isolated, autoMemory });
    // Persist immediately so session survives ungraceful server death
    this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated, autoMemory: session.autoMemory });
    this.broadcastTabs();
  }

  write(tabId, data) {
    const session = this.sessions.get(tabId);
    if (session) session.write(data);
  }

  writeWhenReady(tabId, data, delayMs) {
    const session = this.sessions.get(tabId);
    if (session) session.writeWhenReady(data, undefined, delayMs);
  }

  resize(tabId, cols, rows) {
    const session = this.sessions.get(tabId);
    if (session) session.resize(cols, rows);
  }

  kill(tabId) {
    const session = this.sessions.get(tabId);
    if (session) session.kill();
  }

  remove(tabId) {
    const session = this.sessions.get(tabId);
    if (session) {
      if (session.sessId && session.cwd) {
        this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated });
      }
      if (session.sessId) {
        this.store.deleteSessionData(session.sessId);
        try { fs.rmSync(path.join(PACKAGE_ROOT, 'uploads', session.sessId), { recursive: true, force: true }); } catch {}
      }
      session.kill();
      this.sessions.delete(tabId);
    }
  }

  killAll() {
    for (const session of this.sessions.values()) {
      session.kill();
    }
  }

  list() {
    const tabs = [];
    for (const [tabId, session] of this.sessions) {
      if (session.hidden) continue;
      tabs.push({
        tabId,
        instanceId: session.instanceId,
        sessId: session.sessId,
        isolated: session.isolated,
        autoMemory: session.autoMemory,
        status: session.status,
        cwd: session.cwd,
        title: session.title,
        settings: session.getSettings(),
      });
    }
    return tabs;
  }

  nextTabId() {
    // Embed the per-process bootId and a monotonic counter so a tab ID is
    // unique across restarts. A stale client tab from a previous process can
    // therefore never be re-bound to a session in this process by key collision.
    let id;
    do {
      id = `tab-${this.bootId}-${++this._tabSeq}`;
    } while (this.sessions.has(id));
    return id;
  }

  rename(tabId, title) {
    const session = this.sessions.get(tabId);
    if (session) {
      session.title = title || null;
      this.broadcastTabs();
      return true;
    }
    return false;
  }

  updateSettings(tabId, settings) {
    const session = this.sessions.get(tabId);
    if (session) {
      session.updateSettings(settings);
      return true;
    }
    return false;
  }

  getSettingsByInstanceId(instanceId) {
    for (const session of this.sessions.values()) {
      if (session.instanceId === instanceId) {
        return session.getSettings();
      }
    }
    return null;
  }

  getByInstanceId(instanceId) {
    for (const session of this.sessions.values()) {
      if (session.instanceId === instanceId) return session;
    }
    return null;
  }

  launchSession(tabId, opts = {}) {
    const session = this.getOrCreate(tabId);
    if (opts.title !== undefined) session.title = opts.title;
    if (opts.settings) session.updateSettings(opts.settings);
    if (opts.hidden != null) session.hidden = opts.hidden;

    let resumeSessionId;
    if (opts.spawnOpts?.resume) {
      if (session.sessId) {
        resumeSessionId = session.sessId;
      } else if (opts.cwd) {
        const history = this._loadHistory();
        const match = history.find(h => h.cwd === opts.cwd);
        if (match) resumeSessionId = match.id;
      }
    }

    this.spawn(tabId, opts.cwd, opts.cols, opts.rows, { resumeSessionId });

    if (opts.prompt && opts.autoSubmit) {
      session.writeWhenReady(opts.prompt + '\n');
    }
  }

  // Roll a CLI session back one user/assistant turn: truncate the native
  // transcript (what `--resume` reads) so the last turn no longer counts toward
  // context, and flag the matching inspector interactions as deleted (kept for
  // viewing, struck through in the timeline). The running process is left alone.
  removeLastInteractionTurn(tabId) {
    const session = this.sessions.get(tabId);
    if (!session || !session.sessId || !session.cwd) return { ok: false, reason: 'no-session' };
    const sessId = session.sessId;

    const result = rollbackTranscript(session.cwd, sessId, session.isolated);
    if (!result.ok) return result;

    const deletedIds = this.store.markSessionTurnDeleted(sessId, result.cutTimestamp);
    if (deletedIds.length) {
      this.broadcaster.broadcast({ type: 'inspector:turnsDeleted', sessId, instanceId: `cli-${sessId}`, ids: deletedIds });
    }
    return { ok: true, deletedCount: deletedIds.length };
  }

  onExit(tabId, callback) {
    this._exitCallbacks.set(tabId, callback);
  }

  broadcastTabs() {
    this.broadcaster.broadcast({ type: 'cli:tabs', bootId: this.bootId, tabs: this.list() });
  }
}

module.exports = CliSessionManager;
