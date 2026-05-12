const fs = require('fs');
const os = require('os');
const path = require('path');
const CliSession = require('./cli-session');
const { readJSON, writeJSON, DATA_HOME } = require('./utils');

const HISTORY_FILE = path.join(DATA_HOME, 'data', 'cli-history.json');

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

class CliSessionManager {
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.opts = opts;
    this.sessions = new Map();
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
      this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated });
    }
    this.sessions.delete(tabId);
    this.broadcastTabs();
  }

  saveAllToHistory() {
    for (const [, session] of this.sessions) {
      if (session?.sessId && session.cwd) {
        this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated });
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
    const deduped = history.filter(h => h.id !== sessId);
    deduped.unshift({
      id: sessId,
      cwd: entry.cwd,
      title: entry.title || null,
      settings: entry.settings || {},
      isolated: entry.isolated === true,
      savedAt: Date.now(),
    });
    writeJSON(HISTORY_FILE, deduped);
  }

  getSavedSessions() {
    const history = this._loadHistory();
    for (const entry of history) {
      entry.jsonlSize = this._getJsonlSize(entry);
    }
    return history;
  }

  _getJsonlSize(entry) {
    const configDir = (entry.isolated === true)
      ? path.join(entry.cwd, '.claude')
      : path.join(os.homedir(), '.claude');
    const slug = entry.cwd.replace(/\//g, '-');
    const jsonlPath = path.join(configDir, 'projects', slug, `${entry.id}.jsonl`);
    try {
      return fs.statSync(jsonlPath).size;
    } catch {
      return 0;
    }
  }

  getSavedSession(id) {
    return this._loadHistory().find(s => s.id === id) || null;
  }

  deleteSavedSession(id) {
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

  spawn(tabId, cwd, cols, rows, { resumeSessionId, isolated } = {}) {
    const session = this.getOrCreate(tabId);
    if (session.sessId && session.cwd) {
      this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated });
    }
    session.spawn(cwd, cols, rows, { resumeSessionId, isolated });
    this.broadcastTabs();
  }

  notifyTranscriptPath(instanceId, sessId, transcriptPath) {
    for (const session of this.sessions.values()) {
      if (session.instanceId === instanceId) {
        session.ensureJsonlWatcher(transcriptPath);
        return;
      }
    }
  }

  write(tabId, data) {
    const session = this.sessions.get(tabId);
    if (session) session.write(data);
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
      tabs.push({
        tabId,
        instanceId: session.instanceId,
        sessId: session.sessId,
        isolated: session.isolated,
        status: session.status,
        cwd: session.cwd,
        title: session.title,
        settings: session.getSettings(),
      });
    }
    return tabs;
  }

  nextTabId() {
    let i = 1;
    while (this.sessions.has(`tab-${i}`)) i++;
    return `tab-${i}`;
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

  getSettings(tabId) {
    const session = this.sessions.get(tabId);
    return session ? session.getSettings() : null;
  }

  getSettingsByInstanceId(instanceId) {
    for (const session of this.sessions.values()) {
      if (session.instanceId === instanceId) {
        return session.getSettings();
      }
    }
    return null;
  }

  broadcastTabs() {
    this.broadcaster.broadcast({ type: 'cli:tabs', tabs: this.list() });
  }
}

module.exports = CliSessionManager;
