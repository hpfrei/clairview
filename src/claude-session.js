const fs = require('fs');
const path = require('path');
const os = require('os');
const caps = require('./capabilities');
const { buildClaudeArgs, spawnClaude, createStreamJsonParser, resolveOutputDir, OUTPUTS_DIR } = require('./utils');

const PROJECT_ROOT = path.dirname(__dirname);

class ClaudeSession {
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.proc = null;
    this.buffer = '';
    this.cwd = resolveOutputDir('');
    this.sessionId = null;
    this.ready = false;
    this.capabilities = caps.loadActiveProfile(PROJECT_ROOT);
    this._mcpConfigFile = null; // temp file for --mcp-config
    this._authToken = opts.authToken || '';
    this._dashboardPort = opts.dashboardPort || 3457;
  }

  setReady() {
    this.ready = true;
  }

  get running() {
    return this.proc !== null && this.proc.exitCode === null;
  }

  setCwd(dir) {
    this.cwd = resolveOutputDir(dir);
    this._broadcastSettings();
    return true;
  }

  setCapabilities(profile) {
    this.capabilities = caps.validateProfile(profile);
    // Save custom profiles to disk; builtins are not saved
    if (!caps.BUILTIN_PROFILES[this.capabilities.name]) {
      caps.saveProfile(PROJECT_ROOT, this.capabilities);
    }
    caps.setActiveProfile(PROJECT_ROOT, this.capabilities.name);
    if (this.running) this.kill();
    this._broadcastSettings();
    return true;
  }

  switchProfile(name) {
    const profile = caps.loadProfile(PROJECT_ROOT, name);
    if (!profile) return false;
    this.capabilities = profile;
    caps.setActiveProfile(PROJECT_ROOT, name);
    if (this.running) this.kill();
    this._broadcastSettings();
    return true;
  }

  _broadcastSettings() {
    this.broadcaster.broadcast({
      type: 'chat:settings',
      cwd: this.cwd,
      outputsDir: OUTPUTS_DIR,
      capabilities: this.capabilities,
    });
  }

  _cleanupMcpConfig() {
    if (this._mcpConfigFile) {
      try { fs.unlinkSync(this._mcpConfigFile); } catch {}
      this._mcpConfigFile = null;
    }
  }

  /**
   * Build a temp MCP config file for selected servers.
   * Returns the file path, or null if no servers selected.
   */
  _buildMcpConfig() {
    let mcpServers;
    try {
      mcpServers = require('./mcp/servers');
    } catch { return null; }

    const meta = mcpServers.readMeta();
    if (!meta) return null;

    const enabledTools = (meta.tools || []).filter(t => t.enabled);
    if (enabledTools.length === 0) return null;

    const appRoot = path.dirname(__dirname);
    const bridgePath = path.join(appRoot, 'lib', 'mcp-bridge.js');

    // Build env from server's environment variables
    const env = {};
    if (meta.env && typeof meta.env === 'object' && !Array.isArray(meta.env)) {
      for (const [k, v] of Object.entries(meta.env)) {
        if (k) env[k] = String(v);
      }
    }
    if (meta.secrets && typeof meta.secrets === 'object') {
      for (const [k, v] of Object.entries(meta.secrets)) {
        if (k) env[k] = String(v);
      }
    }
    env.VISTACLAIR_DASHBOARD_PORT = String(this._dashboardPort || process.env.DASHBOARD_PORT || '3457');
    env.VISTACLAIR_AUTH_TOKEN = String(this._authToken || process.env.AUTH_TOKEN || '');
    env.VISTACLAIR_SERVER_SLUG = mcpServers.INTEGRATED_SLUG;

    const config = {
      mcpServers: {
        [mcpServers.INTEGRATED_SLUG]: {
          command: 'node',
          args: [bridgePath, mcpServers.INTEGRATED_SLUG],
          env,
        },
      },
    };

    if (Object.keys(config.mcpServers).length === 0) return null;

    // Write to temp file
    const tmpFile = path.join(os.tmpdir(), `vistaclair-mcp-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));
    this._mcpConfigFile = tmpFile;
    return tmpFile;
  }

  send(prompt) {
    if (!this.ready) {
      this.broadcaster.broadcast({
        type: 'chat:error',
        text: 'Services are still starting up. Please wait a moment and try again.',
      });
      return;
    }

    if (this.running) {
      // Kill existing process before starting a new one
      this.kill();
    }

    this.broadcaster.broadcast({ type: 'chat:status', status: 'running' });

    const args = buildClaudeArgs(this.capabilities);
    if (this.sessionId) args.push('--resume', this.sessionId);

    // MCP server config injection
    this._cleanupMcpConfig();
    const mcpConfigFile = this._buildMcpConfig();
    if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);

    // Ensure hook reporters are injected in the spawn CWD
    const reporterPath = path.join(PROJECT_ROOT, 'lib', 'hook-reporter.js');
    caps.ensureHookReporters(this.cwd, reporterPath);

    this.proc = spawnClaude(args, {
      cwd: this.cwd, proxyPort: this.proxyPort,
      profileName: this.capabilities?.name || 'full',
      disableAutoMemory: this.capabilities?.disableAutoMemory !== false,
      dashboardPort: this._dashboardPort, authToken: this._authToken,
      instanceId: `chat-${this.tabId}`,
      sourceContext: { tabId: this.tabId },
    });

    this.proc.stdin.write(prompt);
    this.proc.stdin.end();

    const parser = createStreamJsonParser(
      (event) => {
        if (event.session_id && !this.sessionId) {
          this.sessionId = event.session_id;
          console.log(`[session] Captured session ${this.sessionId}`);
          this.store.saveSessionMeta(this.sessionId);
        }
        this.broadcaster.broadcast({ type: 'chat:event', event });
        if (event.type === 'result') {
          this.broadcaster.broadcast({ type: 'chat:status', status: 'idle', exitCode: null });
        }
      },
      (line) => this.broadcaster.broadcast({ type: 'chat:output', text: line }),
    );

    this.proc.stdout.on('data', (chunk) => parser.write(chunk));

    this.proc.stderr.on('data', (chunk) => {
      this.broadcaster.broadcast({ type: 'chat:error', text: chunk.toString('utf-8') });
    });

    this.proc.on('close', (code) => {
      parser.flush();
      this._cleanupMcpConfig();
      this.broadcaster.broadcast({ type: 'chat:status', status: 'idle', exitCode: code });
      this.proc = null;
    });

    this.proc.on('error', (err) => {
      this.broadcaster.broadcast({
        type: 'chat:error',
        text: `Failed to start claude: ${err.message}`,
      });
      this.broadcaster.broadcast({ type: 'chat:status', status: 'error' });
      this.proc = null;
    });
  }

  kill() {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this._cleanupMcpConfig();
  }

  clearSession() {
    this.kill();
    this.sessionId = null;
  }

  newSession() {
    this.kill();
    this.sessionId = null;
    this.store.newSession();
  }

  switchSession(storeSessionId) {
    this.kill();
    const data = this.store.loadSession(storeSessionId);
    if (!data) return null;
    this.store.switchTo(storeSessionId);
    this.sessionId = data.meta.claudeSessionId || null;
    return data;
  }
}

module.exports = ClaudeSession;
