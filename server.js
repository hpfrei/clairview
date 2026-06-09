require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { OUTPUTS_DIR, DATA_HOME, ensureDir, setProcessBroadcaster, spawnClaude, buildClaudeArgs } = require('./src/utils');
const InteractionStore = require('./src/store');
const DashboardBroadcaster = require('./src/dashboard-ws');
const createProxyRouter = require('./src/proxy');
const { pendingQuestions } = createProxyRouter;
const CliSessionManager = require('./src/cli-sessions');
const caps = require('./src/capabilities');
const mcp = require('./src/mcp');
const { createLicensing } = require('./src/licensing');
const addons = require('./src/addons');
let proModule = null;   // the loaded ./vistaclair-pro module (for licensing/update)
let proAddon = null;    // its registered descriptor (null until init succeeds)
let proLicenseValid = false;
const isDev = process.argv.includes('dev');
if (isDev && !process.env.DEV_LICENCING_SERVER) {
  console.error('Error: DEV_LICENCING_SERVER is not set. Create a .env file with DEV_LICENCING_SERVER=http://localhost:8888');
  process.exit(1);
}
const licensing = createLicensing({ dataHome: DATA_HOME, isDev });
const { proDir, validateLicense, fetchProductInfo, checkProUpdates, npmInstall } = licensing;
const ruleHandler = require('./src/proxy-rule-handler');
const createApiRouter = require('./src/api');

// Check and auto-install native dependencies, then restart so they load
(function checkDependencies() {
  const { execFileSync } = require('child_process');
  const missing = [];
  try { require.resolve('node-pty'); } catch { missing.push('node-pty'); }
  if (missing.length === 0) return;
  console.log(`Installing missing dependencies: ${missing.join(', ')}...`);
  try {
    execFileSync('npm', ['install', '--no-save', ...missing], { cwd: __dirname, stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to install dependencies: ${err.message}`);
    console.error('CLI terminal feature will be unavailable. Run manually: npm install ' + missing.join(' '));
    return;
  }
  console.log('Dependencies installed. Restarting...\n');
  const child = require('child_process').spawnSync(process.execPath, process.argv.slice(1), { cwd: __dirname, stdio: 'inherit' });
  process.exit(child.status ?? 1);
})();

(async () => {

const fs = require('fs');
fetchProductInfo();
setInterval(fetchProductInfo, 60 * 60 * 1000);

if (fs.existsSync(proDir)) {
  const result = await validateLicense();
  proLicenseValid = result.valid;
  if (proLicenseValid) {
    try { proModule = require('./vistaclair-pro'); } catch (e) {
      // Self-heal installs that were cloned before deps were installed (older
      // installer) or whose install was interrupted — otherwise the GUI loops
      // on needsRestart forever (installed && licensed && !loaded).
      if (e.code === 'MODULE_NOT_FOUND') {
        console.error('  Pro: missing dependencies, installing...');
        try {
          npmInstall(proDir);
          proModule = require('./vistaclair-pro');
          console.log('  Pro: dependencies installed');
        } catch (e2) {
          console.error('  Pro: dependency install failed:', e2.message);
        }
      } else {
        console.error('  Pro: failed to load:', e.message);
      }
    }
  } else {
    console.log(`  Pro: license invalid (${result.reason}) — running in free mode`);
  }
}

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3456');
const PORT_ARG = process.argv.slice(2).find(a => /^\d+$/.test(a));
const DASHBOARD_PORT = parseInt(PORT_ARG || process.env.DASHBOARD_PORT || '3457');
const TARGET_URL = process.env.ANTHROPIC_TARGET_URL || 'https://api.anthropic.com';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '200');
const AUTH_TOKEN = process.env.AUTH_TOKEN || crypto.randomUUID();
const AUTH_TOKEN_SOURCE = process.env.AUTH_TOKEN ? 'env' : 'generated';

// Shared store
const store = new InteractionStore(MAX_HISTORY);

// --- Proxy server (port 3456) ---
const proxyApp = express();
let broadcaster = { broadcast() {} };

const proxyRouter = createProxyRouter(store, { broadcast: (...args) => broadcaster.broadcast(...args) }, TARGET_URL);
proxyApp.use(proxyRouter);
const proxyServer = http.createServer(proxyApp);

// --- Dashboard server (port 3457) ---
const dashboardApp = express();
dashboardApp.set('trust proxy', 'loopback')  // proxies (nginx/ngrok/cloudflared) all run on localhost
dashboardApp.use(express.json({ limit: '50mb' }));
dashboardApp.use(express.urlencoded({ extended: false }));

// Auth: cookie parser helper
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Truly-local: loopback socket AND not forwarded by a local proxy. Since nginx,
// ngrok, and cloudflared all run on this host, the socket peer is always loopback;
// the X-Forwarded-For header is what distinguishes proxied external traffic.
function isLoopback(req) {
  return LOOPBACK.has(req.socket?.remoteAddress) && !req.headers['x-forwarded-for'];
}
function isLoopbackSocket(socket, req) {
  return LOOPBACK.has(socket.remoteAddress) && !req?.headers?.['x-forwarded-for'];
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function getTokenFromCookies(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  return match ? match[1] : null;
}

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again in a minute' },
});

// Login routes (no auth required)
dashboardApp.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

dashboardApp.post('/login', authLimiter, (req, res) => {
  if (safeEqual(req.body.token, AUTH_TOKEN)) {
    res.setHeader('Set-Cookie', `token=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/`);
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

dashboardApp.get('/login/auto', authLimiter, (req, res) => {
  if (!isLoopback(req)) return res.redirect('/login');
  if (safeEqual(req.query.token, AUTH_TOKEN)) {
    res.setHeader('Set-Cookie', `token=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/`);
    return res.redirect('/');
  }
  res.redirect('/login');
});

// Hook reporter endpoint (auth via body token, no cookie needed)
let hookSeq = 0;
dashboardApp.post('/api/hook-report', (req, res) => {
  if (!safeEqual(req.body?.token, AUTH_TOKEN)) return res.status(401).end();
  try {
    const hookData = typeof req.body.hookData === 'string' ? JSON.parse(req.body.hookData) : req.body.hookData;
    const id = `hook-${Date.now()}-${++hookSeq}`;
    const hookTs = hookData.timestamp || Date.now();
    const hookEvent = hookData.hook_event_name || 'unknown';
    const interaction = {
      id, timestamp: hookTs, isHook: true,
      instanceId: req.body.instanceId || null,
      hookEvent,
      toolName: hookData.tool_name || null,
      toolUseId: hookData.tool_use_id || null,
      hookAgentId: hookData.agent_id || null,
      request: hookData,
      response: { status: 200, body: hookData.tool_response || null },
      timing: { startedAt: hookTs, duration: hookData.duration_ms || 0 },
      status: 'complete', isStreaming: false,
    };
    const sessId = hookData.session_id
      || (interaction.instanceId?.startsWith('cli-') ? interaction.instanceId.slice(4) : null);

    // Stand up the authoritative trace index as soon as we learn the transcript
    // path (SessionStart carries it; so do most subsequent hooks).
    if (sessId && hookData.transcript_path) {
      store.attachTraceIndex(sessId, hookData.transcript_path, broadcaster);
    }

    // Every hook that carries an agent_id belongs to that subagent — stamp it
    // directly (instant, no file read). Tool-call hooks without agent_id are
    // resolved by tool_use_id via the trace index inside store.save/applyResolution.
    if (hookData.agent_id) {
      let metaDescription = hookData.description || null;
      let metaToolUseId = null;
      const ti = sessId ? store.getTraceIndex(sessId) : null;
      const meta = ti ? ti.getAgentMeta(hookData.agent_id) : null;
      if (meta) {
        metaDescription = metaDescription || meta.description;
        metaToolUseId = meta.toolUseId;
      }
      if (!metaDescription && hookData.transcript_path) {
        try {
          const sessionDir = path.join(path.dirname(hookData.transcript_path), path.basename(hookData.transcript_path, '.jsonl'));
          const metaPath = path.join(sessionDir, 'subagents', `agent-${hookData.agent_id}.meta.json`);
          const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          metaDescription = m.description || metaDescription;
          metaToolUseId = metaToolUseId || m.toolUseId || null;
        } catch {}
      }
      interaction.subagent = {
        agentId: hookData.agent_id,
        agentType: hookData.agent_type || meta?.agentType || 'agent',
        description: metaDescription,
        toolUseId: metaToolUseId,
      };
    }
    store.add(interaction);
    store.save(interaction.id);
    broadcaster.broadcast({ type: 'interaction:start', interaction });
    broadcaster.broadcast({ type: 'interaction:complete', interaction });

    // SubagentStop / Stop are authoritative "transcript just flushed" signals —
    // force an immediate rescan so pending LLM turns enrich without watcher lag.
    if ((hookEvent === 'SubagentStop' || hookEvent === 'Stop') && sessId) {
      store.rescanTrace(sessId);
    }
  } catch {}
  res.status(200).end();
});

// AskUserQuestion endpoint — called by vista-AskUserQuestion MCP tool handler.
// Broadcasts the question to the dashboard and waits for the user's answer.
const { getInstanceContext } = require('./src/utils');
let askSeq = 0;
dashboardApp.post('/api/ask', async (req, res) => {
  if (!safeEqual(req.body?.token, AUTH_TOKEN)) return res.status(401).end();
  const { instanceId, formData, questions } = req.body;
  const askId = `ask-${Date.now()}-${++askSeq}`;
  const ctx = instanceId ? getInstanceContext(instanceId) : null;
  const tabId = ctx?.tabId || null;
  const session = instanceId ? cliSessionManager.getByInstanceId(instanceId) : null;
  const title = session?.title || null;
  const cwd = session?.cwd || null;

  const promise = new Promise((resolve, reject) => {
    pendingQuestions.set(askId, { formData: formData || {}, questions: questions || [], resolve, reject, ctx });
  });

  // If the MCP tool gives up (4h timeout) it destroys the socket; reject the
  // pending question and tell clients to close the stale modal. Listen on the
  // response, not the request: req 'close' fires as soon as the body is read.
  res.on('close', () => {
    if (res.writableEnded) return;
    const pending = pendingQuestions.get(askId);
    if (pending) {
      pendingQuestions.delete(askId);
      if (pending.reject) pending.reject(new Error('Question timed out'));
      broadcaster.broadcast({ type: 'ask:timeout', askId });
    }
  });

  broadcaster.broadcast({
    type: 'ask:question',
    askId,
    toolUseIds: [askId],
    forms: [{ toolUseId: askId, formData: formData || {}, questions: questions || [] }],
    title,
    cwd,
    ...(tabId ? { tabId } : {}),
  });
  console.log(`[api/ask] Broadcasting ask:question askId=${askId} tabId=${tabId || '(none)'}`);

  try {
    const answer = await promise;
    res.json({ ok: true, answer });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  } finally {
    pendingQuestions.delete(askId);
  }
});

// Landing page (public, no auth)
dashboardApp.use('/landing_page', express.static(path.join(__dirname, 'public', 'landing_page')));

// Health check (no auth — used by client to detect restart completion)
dashboardApp.get('/api/ping', (req, res) => res.json({ ok: true }));

// Auth middleware for all other routes
dashboardApp.use((req, res, next) => {
  // Add-on-declared public paths (e.g. OAuth callbacks) — SameSite=Lax cookies
  // aren't sent on cross-site redirects, so these must bypass auth. Declarative
  // per-add-on list, no hardcoded product knowledge here.
  if (addons.isAuthExempt(req.path)) return next();
  // Allow internal requests from MCP tools (localhost + internal header)
  if (isLoopback(req) && safeEqual(req.headers['x-vistaclair-internal'], AUTH_TOKEN)) return next();
  const token = getTokenFromCookies(req.headers.cookie);
  if (safeEqual(token, AUTH_TOKEN)) return next();
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ') && safeEqual(authHeader.slice(7), AUTH_TOKEN)) return next();
  // API routes get 401 JSON; browser routes get redirect
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
});

dashboardApp.use(express.static(path.join(__dirname, 'public')));

// Serve chat outputs at /outputs (directory auto-created)
ensureDir(OUTPUTS_DIR);
dashboardApp.use('/outputs', express.static(OUTPUTS_DIR));

// Pro update check (background)
if (fs.existsSync(proDir) && proLicenseValid) {
  checkProUpdates();
  setInterval(checkProUpdates, 60 * 60 * 1000);
}

// Mount the /api/pro/* licensing routes. The lifecycle adapter bridges to the
// Pro module-load state that this file owns as the composition root.
dashboardApp.use('/api', licensing.createLicenseRouter({
  getPro: () => proModule,
  isProLoaded: () => !!proAddon,
  getProLicenseValid: () => proLicenseValid,
  getProClientModules: () => (proAddon ? addons.getClientModules() : null),
  scheduleRestart: () => scheduleRestart(),
  revalidate: async () => {
    const result = await validateLicense();
    proLicenseValid = result.valid;
  },
}));

const dashboardServer = http.createServer(dashboardApp);

const cliSessionManager = new CliSessionManager(PROXY_PORT, { broadcast: (...args) => broadcaster.broadcast(...args) }, store, { authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// WebSocket server on dashboard (with auth)
const wss = new WebSocketServer({ noServer: true });
broadcaster = new DashboardBroadcaster(wss, store, { authToken: AUTH_TOKEN, proxyPort: PROXY_PORT, cliSessionManager });
setProcessBroadcaster(broadcaster);
store.setBroadcaster(broadcaster);

dashboardServer.on('upgrade', (req, socket, head) => {
  // Allow internal requests from MCP tools (localhost + internal header)
  const internal = isLoopbackSocket(socket, req) && safeEqual(req.headers['x-vistaclair-internal'], AUTH_TOKEN);
  const token = getTokenFromCookies(req.headers.cookie);
  if (!internal && !safeEqual(token, AUTH_TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Offer the upgrade to add-ons (e.g. Pro's VNC websockify proxy) first.
  if (addons.handleUpgrade(req, socket, head)) return;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

cliSessionManager.broadcaster = broadcaster;

// Wire CLI settings getter for proxy model mapping
createProxyRouter._cliSettingsGetter = (instanceId) => cliSessionManager.getSettingsByInstanceId(instanceId);

// Initialize MCP Server Manager
mcp.init({ broadcaster, store, authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// Initialize add-ons (Pro Apps Platform, etc.) and register their descriptors.
// init() returns a versioned descriptor; core consumes it generically — routers
// are mounted after auth (below), upgrades/clientModules/auth-exempt paths are
// dispatched through the addon registry. No per-add-on branching here.
const addonCtx = {
  broadcaster, store, authToken: AUTH_TOKEN,
  dashboardPort: DASHBOARD_PORT, proxyPort: PROXY_PORT,
  cliSessionManager, spawnClaude, buildClaudeArgs,
  secretStore: require('./src/secret-store'),
  resolveHeadlessAuth: (authMode) => caps.resolveHeadlessAuth(DATA_HOME, authMode),
  resolveProviderKey: (providerKey) => caps.getProviderKey(DATA_HOME, providerKey),
  listModels: () => caps.listModels(DATA_HOME),
  claudeAuthInfo: () => ({
    hasSubscription: caps.hasClaudeSubscription(),
    pref: caps.getClaudeAuthPref(DATA_HOME),
    needsChoice: caps.needsClaudeAuthChoice(DATA_HOME),
  }),
};
if (proModule) {
  try {
    const descriptor = proModule.init(addonCtx);
    proAddon = addons.registerAddon(descriptor);
    if (proAddon) console.log('  Pro: loaded');
    else console.error('  Pro: descriptor rejected (contract mismatch)');
  } catch (e) {
    console.error('  Pro: init failed:', e.message);
  }
}
// Mount add-on routers AFTER the auth middleware (declared above) so add-on
// routes are auth-gated by construction, except their declared authExemptPaths.
addons.mountRouters(dashboardApp);

ruleHandler.init({ broadcaster, store, proxyPort: PROXY_PORT, dashboardPort: DASHBOARD_PORT, authToken: AUTH_TOKEN });

// Mount REST API
dashboardApp.use('/api', createApiRouter({ broadcaster, store, proxyPort: PROXY_PORT, dashboardPort: DASHBOARD_PORT, authToken: AUTH_TOKEN, cliSessionManager }));

function scheduleRestart() {
  setTimeout(() => {
    broadcaster.broadcast({ type: 'server:restarting' });
    for (const client of wss.clients) {
      try { client.terminate(); } catch {}
    }
    dashboardServer.closeAllConnections?.();
    proxyServer.closeAllConnections?.();
    cliSessionManager.saveAllToHistory();
    cliSessionManager.killAll();
    mcp.shutdown();

    const spawnNew = () => {
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true, stdio: 'inherit', cwd: process.cwd(),
        env: { ...process.env, AUTH_TOKEN, NO_OPEN: '1' },
      });
      child.unref();
      process.exit(0);
    };

    let closed = 0;
    const onClosed = () => { if (++closed >= 2) spawnNew(); };
    dashboardServer.close(onClosed);
    proxyServer.close(onClosed);
    setTimeout(spawnNew, 2000);
  }, 300);
}

// Restart endpoint (auth handled by middleware)
dashboardApp.post('/api/restart', (req, res) => {
  res.json({ ok: true, message: 'Server restarting...' });
  scheduleRestart();
});

// Kill stale processes on our ports before binding (handles unclean restarts)
function killStalePortProcesses() {
  try {
    const { execSync } = require('child_process');
    const myPid = process.pid;
    for (const port of [PROXY_PORT, DASHBOARD_PORT]) {
      try {
        const out = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        for (const pidStr of out.split('\n').filter(Boolean)) {
          const pid = parseInt(pidStr);
          if (pid && pid !== myPid) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      } catch {}
    }
  } catch {}
}
killStalePortProcesses();

// Start both servers (proxy on localhost only)
proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
  dashboardServer.listen(DASHBOARD_PORT, () => {
    console.log('');
    console.log('  Claude Code API Proxy running.');
    console.log('');
    console.log(`  Proxy:     http://127.0.0.1:${PROXY_PORT} (localhost only)`);
    console.log(`  Dashboard: http://localhost:${DASHBOARD_PORT}`);
    console.log(`  Upstream:  ${TARGET_URL}`);
    console.log('');
    if (AUTH_TOKEN_SOURCE === 'generated') {
      console.log(`  Auth token (auto-generated):`);
    } else {
      console.log(`  Auth token (from AUTH_TOKEN env):`);
    }
    console.log(`  ${AUTH_TOKEN}`);
    console.log('');
    console.log('  Usage:');
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT} claude -p "your prompt"`);
    console.log('');

    // Auto-open dashboard in the default browser (skip with NO_OPEN=1)
    if (!process.env.NO_OPEN) {
      const url = `http://localhost:${DASHBOARD_PORT}/login/auto?token=${AUTH_TOKEN}`;
      const { execFile } = require('child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execFile(cmd, [url]);
    }

    // Re-validate license every 4 hours
    setInterval(async () => {
      if (!proAddon) return;
      const result = await validateLicense();
      if (!result.valid && result.reason !== 'offline-grace') {
        console.log(`  Pro: license no longer valid (${result.reason}) — disabling`);
        try { proAddon.shutdown?.(); } catch {}
        addons.removeAddon(proAddon.id);
        proAddon = null;
        proModule = null;
        proLicenseValid = false;
        broadcaster.broadcast({ type: 'pro:disabled', reason: result.reason });
      }
    }, 4 * 60 * 60 * 1000);
  });
});

// Clean shutdown: unregister MCP servers and stop running apps
function gracefulShutdown() {
  cliSessionManager.saveAllToHistory();
  cliSessionManager.killAll();
  addons.shutdownAll();
  mcp.shutdown();
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('SIGHUP', gracefulShutdown);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

})();
