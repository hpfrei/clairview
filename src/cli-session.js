const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const caps = require('./capabilities');
const { buildCliArgs, spawnClaudePty, sanitizeForDashboard, PACKAGE_ROOT } = require('./utils');
const JsonlWatcher = require('./jsonl-watcher');

const PROJECT_ROOT = PACKAGE_ROOT;

const DEFAULT_SETTINGS = {
  modelMap: { opus: null, sonnet: null, haiku: null },
  generalModel: null,
};

const SCROLLBACK_LIMIT = 128 * 1024;

class CliSession {
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.pty = null;
    this.cwd = null;
    this.tabId = null;
    this.sessId = null;
    this._instanceId = null;
    this.title = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.status = 'idle';
    this._mcpConfigFile = null;
    this._jsonlWatcher = null;
    this._scrollback = '';
    this._authToken = opts.authToken || '';
    this._dashboardPort = opts.dashboardPort || 3457;
    this._spawnGen = 0;
  }

  get instanceId() {
    return this._instanceId;
  }

  get running() {
    return this.status === 'running' && this.pty !== null;
  }

  spawn(cwd, cols, rows, { resumeSessionId, isolated } = {}) {
    this._spawnGen++;
    if (this.running) this.kill();

    this.cwd = cwd;
    this.isolated = isolated === true;
    this.status = 'running';

    if (resumeSessionId) {
      this.sessId = resumeSessionId;
    } else {
      this.sessId = crypto.randomUUID();
    }
    this._instanceId = `cli-${this.sessId}`;
    this.store.registerSession(this.instanceId, this.sessId);

    if (resumeSessionId) {
      const store = this.store;
      const sessId = this.sessId;
      const instanceId = this.instanceId;
      const broadcaster = this.broadcaster;
      setImmediate(() => {
        const historical = store.loadSessionIntoMemory(sessId);
        if (historical.length > 0) {
          broadcaster.broadcast({
            type: 'inspector:sessionLoaded',
            sessId,
            instanceId,
            interactions: historical.map(sanitizeForDashboard),
          });
        }
      });
    }

    const args = ['--dangerously-skip-permissions', ...buildCliArgs(this.settings)];
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--session-id', this.sessId);
    }

    // MCP config injection
    this._cleanupMcpConfig();
    const mcpConfigFile = this._buildMcpConfig();
    if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);

    // Hook reporters
    const reporterPath = path.join(PROJECT_ROOT, 'lib', 'hook-reporter.js');
    caps.ensureHookReporters(cwd, reporterPath);

    this.pty = spawnClaudePty(args, {
      cwd,
      proxyPort: this.proxyPort,
      instanceId: this.instanceId,
      sourceContext: { tabId: this.tabId },
      cols: cols || 80,
      rows: rows || 24,
      dashboardPort: this._dashboardPort,
      authToken: this._authToken,
      isolated: this.isolated,
    });

    this._scrollback = '';

    this.pty.onData((data) => {
      this._scrollback += data;
      if (this._scrollback.length > SCROLLBACK_LIMIT) {
        this._scrollback = this._scrollback.slice(-SCROLLBACK_LIMIT);
      }
      this.broadcaster.broadcast({ type: 'cli:output', tabId: this.tabId, data });
    });

    const gen = this._spawnGen;
    this.pty.onExit(({ exitCode }) => {
      if (gen !== this._spawnGen) return;
      this._cleanupMcpConfig();
      this.store.unregisterSession(this.instanceId);
      this.status = 'exited';
      this.pty = null;
      this.broadcaster.broadcast({ type: 'cli:exit', tabId: this.tabId, exitCode });
      setTimeout(() => this._stopJsonlWatcher(), 5000);
    });

    this.broadcaster.broadcast({
      type: 'cli:spawned',
      tabId: this.tabId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      title: this.title,
      settings: this.settings,
      isolated: this.isolated,
    });
  }

  spawnShell(cwd, cols, rows) {
    if (this.running) this.kill();

    this.cwd = cwd;
    this.status = 'running';
    this._scrollback = '';

    const shell = process.env.SHELL || '/bin/bash';
    const pty = require('node-pty');
    this.pty = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: { ...process.env },
    });

    this.pty.onData((data) => {
      this._scrollback += data;
      if (this._scrollback.length > SCROLLBACK_LIMIT) {
        this._scrollback = this._scrollback.slice(-SCROLLBACK_LIMIT);
      }
      this.broadcaster.broadcast({ type: 'cli:output', tabId: this.tabId, data });
    });

    this.pty.onExit(({ exitCode }) => {
      this.status = 'exited';
      this.pty = null;
      this.broadcaster.broadcast({ type: 'cli:exit', tabId: this.tabId, exitCode });
    });

    this.broadcaster.broadcast({
      type: 'cli:spawned',
      tabId: this.tabId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      title: this.title,
      settings: this.settings,
    });
  }

  write(data) {
    if (this.pty) this.pty.write(data);
  }

  resize(cols, rows) {
    if (this.pty) this.pty.resize(cols, rows);
  }

  kill() {
    if (this.pty) {
      try { this.pty.kill('SIGTERM'); } catch {}
      const pid = this.pty.pid;
      this.pty = null;
      if (pid) {
        setTimeout(() => {
          try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
        }, 3000);
      }
    }
    this.status = 'idle';
    this._cleanupMcpConfig();
    this._stopJsonlWatcher();
  }

  getScrollback() {
    return this._scrollback;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }

  getSettings() {
    return { ...this.settings };
  }

  ensureJsonlWatcher(transcriptPath) {
    if (this._jsonlWatcher) return;

    this._jsonlWatcher = new JsonlWatcher(transcriptPath, (requestId, enrichment) => {
      const interaction = this.store.findByRequestId(requestId);
      if (interaction) {
        const { enrichedHooks } = this.store.enrichInteraction(interaction.id, enrichment);
        this.broadcaster.broadcast({
          type: 'interaction:enriched',
          interactionId: interaction.id,
          subagent: enrichment,
        });
        for (const hook of enrichedHooks) {
          this.broadcaster.broadcast({
            type: 'interaction:enriched',
            interactionId: hook.id,
            subagent: enrichment,
          });
        }
      } else {
        this.store.pendingEnrichments.set(requestId, { data: enrichment, ts: Date.now() });
      }
    });
    this._jsonlWatcher.start();
  }

  _stopJsonlWatcher() {
    if (this._jsonlWatcher) {
      this._jsonlWatcher.stop();
      this._jsonlWatcher = null;
    }
  }

  _cleanupMcpConfig() {
    if (this._mcpConfigFile) {
      try { fs.unlinkSync(this._mcpConfigFile); } catch {}
      this._mcpConfigFile = null;
    }
  }

  _buildMcpConfig() {
    let mcpServers;
    try {
      mcpServers = require('./mcp/servers');
    } catch { return null; }

    const meta = mcpServers.readMeta();
    if (!meta) return null;

    const enabledTools = (meta.tools || []).filter(t => t.enabled);
    if (enabledTools.length === 0) return null;

    const bridgePath = path.join(PACKAGE_ROOT, 'lib', 'mcp-bridge.js');

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
    env.VISTACLAIR_INSTANCE_ID = this.instanceId;

    const config = {
      mcpServers: {
        [mcpServers.INTEGRATED_SLUG]: {
          command: 'node',
          args: [bridgePath, mcpServers.INTEGRATED_SLUG],
          env,
        },
      },
    };

    const tmpFile = path.join(os.tmpdir(), `vistaclair-cli-mcp-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));
    this._mcpConfigFile = tmpFile;
    return tmpFile;
  }
}

module.exports = CliSession;
