// ============================================================
// ClaudeSessionManager — Map-based multi-tab session manager
// Wraps ClaudeSession instances, keyed by tabId.
// ============================================================

const ClaudeSession = require('./claude-session');

class ClaudeSessionManager {
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.opts = opts;
    this.sessions = new Map(); // tabId → ClaudeSession

    // Create default tab-1 on startup
    this._createSession('tab-1');
  }

  /** Get the default (tab-1) session — backwards compat */
  get defaultSession() {
    return this.sessions.get('tab-1');
  }

  _createSession(tabId) {
    const session = new ClaudeSession(
      this.proxyPort,
      this._wrapBroadcaster(tabId),
      this.store,
      this.opts
    );
    session.tabId = tabId;
    if (this._ready) session.setReady();
    this.sessions.set(tabId, session);
    return session;
  }

  /** Wrap broadcaster to inject tabId into all chat:* messages */
  _wrapBroadcaster(tabId) {
    const self = this;
    return {
      broadcast(msg) {
        // Add tabId to chat:* and ask:* messages
        if (msg.type && (msg.type.startsWith('chat:') || msg.type.startsWith('ask:'))) {
          msg.tabId = tabId;
        }
        self.broadcaster.broadcast(msg);
      },
    };
  }

  /** Get or create a session for a tabId */
  getOrCreate(tabId) {
    if (!tabId) tabId = 'tab-1';
    let session = this.sessions.get(tabId);
    if (!session) {
      session = this._createSession(tabId);
    }
    return session;
  }

  /** Get existing session or null */
  get(tabId) {
    return this.sessions.get(tabId || 'tab-1') || null;
  }

  /** Send a prompt to a specific tab */
  send(tabId, prompt, files) {
    const session = this.getOrCreate(tabId || 'tab-1');
    session.send(prompt, files);
  }

  /** Kill a specific tab's process */
  kill(tabId) {
    const session = this.sessions.get(tabId || 'tab-1');
    if (session) session.kill();
  }

  /** Kill all sessions */
  killAll() {
    for (const session of this.sessions.values()) {
      session.kill();
    }
  }

  /** Kill and remove a session */
  remove(tabId) {
    const session = this.sessions.get(tabId);
    if (session) {
      session.kill();
      this.sessions.delete(tabId);
    }
  }

  /** List all tabs with status */
  list() {
    const tabs = [];
    for (const [tabId, session] of this.sessions) {
      tabs.push({
        tabId,
        status: session.running ? 'running' : 'idle',
        cwd: session.cwd,
        profile: session.capabilities?.name || 'full',
      });
    }
    return tabs;
  }

  /** Set ready on all sessions */
  setReady() {
    this._ready = true;
    for (const session of this.sessions.values()) {
      session.setReady();
    }
  }

  /** Delegate to default session — backwards compat helpers */
  get cwd() {
    return this.defaultSession?.cwd || process.cwd();
  }

  get capabilities() {
    return this.defaultSession?.capabilities || null;
  }

  get running() {
    return this.defaultSession?.running || false;
  }

  setCwd(dir, tabId) {
    const session = this.get(tabId || 'tab-1');
    return session ? session.setCwd(dir) : false;
  }

  setCapabilities(profile, tabId) {
    const session = this.get(tabId || 'tab-1');
    return session ? session.setCapabilities(profile) : false;
  }

  switchProfile(name, tabId) {
    const session = this.get(tabId || 'tab-1');
    return session ? session.switchProfile(name) : false;
  }

  newSession(tabId) {
    const session = this.get(tabId || 'tab-1');
    if (session) session.newSession();
  }

  switchSession(storeSessionId, tabId) {
    const session = this.get(tabId || 'tab-1');
    return session ? session.switchSession(storeSessionId) : null;
  }

  clearSession(tabId) {
    const session = this.get(tabId || 'tab-1');
    if (session) session.clearSession();
  }

  /** Generate a unique tabId */
  nextTabId() {
    let i = 1;
    while (this.sessions.has(`tab-${i}`)) i++;
    return `tab-${i}`;
  }
}

module.exports = ClaudeSessionManager;
