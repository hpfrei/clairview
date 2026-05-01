const path = require('path');
const CliSession = require('./cli-session');
const { readJSON, writeJSON } = require('./utils');

const HISTORY_FILE = path.join(path.dirname(__dirname), 'data', 'cli-history.json');
const MAX_HISTORY = 50;

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
    if (session?.cwd) {
      this.saveToHistory({ cwd: session.cwd, title: session.title, settings: session.getSettings() });
    }
    this.sessions.delete(tabId);
    this.broadcastTabs();
  }

  // --- History persistence ---

  _loadHistory() {
    return readJSON(HISTORY_FILE, []);
  }

  saveToHistory(entry) {
    const history = this._loadHistory();
    history.unshift({
      id: `sess-${Date.now()}`,
      cwd: entry.cwd,
      title: entry.title || null,
      settings: entry.settings || {},
      savedAt: Date.now(),
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    writeJSON(HISTORY_FILE, history);
  }

  getSavedSessions() {
    return this._loadHistory();
  }

  getSavedSession(id) {
    return this._loadHistory().find(s => s.id === id) || null;
  }

  deleteSavedSession(id) {
    const history = this._loadHistory().filter(s => s.id !== id);
    writeJSON(HISTORY_FILE, history);
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

  spawn(tabId, cwd, cols, rows, { resume = false } = {}) {
    const session = this.getOrCreate(tabId);
    session.spawn(cwd, cols, rows, { resume });
    this.broadcastTabs();
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
      if (session.cwd) {
        this.saveToHistory({ cwd: session.cwd, title: session.title, settings: session.getSettings() });
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
