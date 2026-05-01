const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const InteractionStore = require('./src/store');
const DashboardBroadcaster = require('./src/dashboard-ws');
const createProxyRouter = require('./src/proxy');
const ClaudeSessionManager = require('./src/claude-sessions');
const CliSessionManager = require('./src/cli-sessions');
const caps = require('./src/capabilities');
const mcp = require('./src/mcp');
const ruleHandler = require('./src/proxy-rule-handler');
const createApiRouter = require('./src/api');
const { OUTPUTS_DIR, ensureDir, setProcessBroadcaster, getActiveProcessCount } = require('./src/utils');

// Check and auto-install native dependencies
function checkDependencies() {
  const { execSync } = require('child_process');
  const missing = [];
  try { require.resolve('node-pty'); } catch { missing.push('node-pty'); }
  if (missing.length === 0) return;
  console.log(`\n  Installing missing dependencies: ${missing.join(', ')}...`);
  try {
    execSync(`npm install --no-save ${missing.join(' ')}`, { cwd: __dirname, stdio: 'inherit' });
    console.log('  Dependencies installed successfully.\n');
  } catch (err) {
    console.error(`  Failed to install dependencies: ${err.message}`);
    console.error('  CLI terminal feature will be unavailable. Run manually: npm install ' + missing.join(' '));
  }
}
checkDependencies();

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
let sessionManager = null; // forward reference, assigned below

const proxyRouter = createProxyRouter(store, { broadcast: (...args) => broadcaster.broadcast(...args) }, TARGET_URL);
proxyApp.use(proxyRouter);
const proxyServer = http.createServer(proxyApp);

// --- Dashboard server (port 3457) ---
const dashboardApp = express();
dashboardApp.use(express.json({ limit: '50mb' }));
dashboardApp.use(express.urlencoded({ extended: false }));

// Auth: cookie parser helper
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLoopback(req) { return LOOPBACK.has(req.socket?.remoteAddress); }
function isLoopbackSocket(socket) { return LOOPBACK.has(socket.remoteAddress); }

function getTokenFromCookies(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  return match ? match[1] : null;
}

// Login routes (no auth required)
dashboardApp.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

dashboardApp.post('/login', (req, res) => {
  if (req.body.token === AUTH_TOKEN) {
    res.setHeader('Set-Cookie', `token=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

// Hook reporter endpoint (auth via body token, no cookie needed)
let hookSeq = 0;
dashboardApp.post('/api/hook-report', (req, res) => {
  if (req.body?.token !== AUTH_TOKEN) return res.status(401).end();
  try {
    const hookData = typeof req.body.hookData === 'string' ? JSON.parse(req.body.hookData) : req.body.hookData;
    const id = `hook-${Date.now()}-${++hookSeq}`;
    const interaction = {
      id, timestamp: Date.now(), isHook: true,
      instanceId: req.body.instanceId || null,
      hookEvent: hookData.hook_event_name || 'unknown',
      toolName: hookData.tool_name || null,
      request: hookData,
      response: { status: 200, body: hookData.tool_response || null },
      timing: { startedAt: Date.now(), duration: 0 },
      status: 'complete', isStreaming: false,
    };
    store.add(interaction);
    broadcaster.broadcast({ type: 'interaction:start', interaction });
    broadcaster.broadcast({ type: 'interaction:complete', interaction });
  } catch {}
  res.status(200).end();
});

// Landing page (public, no auth)
dashboardApp.use('/landing_page', express.static(path.join(__dirname, 'public', 'landing_page')));

// Auth middleware for all other routes
dashboardApp.use((req, res, next) => {
  // Allow internal requests from MCP tools (localhost + internal header)
  if (req.headers['x-vistaclair-internal'] === 'true' && isLoopback(req)) return next();
  const token = getTokenFromCookies(req.headers.cookie);
  if (token === AUTH_TOKEN) return next();
  // Also accept Authorization: Bearer <token> for API clients
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ') && authHeader.slice(7) === AUTH_TOKEN) return next();
  // API routes get 401 JSON; browser routes get redirect
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
});

dashboardApp.use(express.static(path.join(__dirname, 'public')));

// Serve chat outputs at /outputs (directory auto-created)
ensureDir(OUTPUTS_DIR);
dashboardApp.use('/outputs', express.static(OUTPUTS_DIR));

const dashboardServer = http.createServer(dashboardApp);

// Session manager (spawns claude -p instances through the proxy)
sessionManager = new ClaudeSessionManager(PROXY_PORT, { broadcast: (...args) => broadcaster.broadcast(...args) }, store, { authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });
const cliSessionManager = new CliSessionManager(PROXY_PORT, { broadcast: (...args) => broadcaster.broadcast(...args) }, store, { authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// WebSocket server on dashboard (with auth)
const wss = new WebSocketServer({ noServer: true });
broadcaster = new DashboardBroadcaster(wss, store, sessionManager, { authToken: AUTH_TOKEN, cliSessionManager });
setProcessBroadcaster(broadcaster);

dashboardServer.on('upgrade', (req, socket, head) => {
  // Allow internal requests from MCP tools (localhost + internal header)
  const internal = req.headers['x-vistaclair-internal'] === 'true' && isLoopbackSocket(socket);
  const token = getTokenFromCookies(req.headers.cookie);
  if (!internal && token !== AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Fix circular ref: point all sessions' broadcasters at the real one
for (const [tabId, session] of sessionManager.sessions) {
  session.broadcaster = { broadcast(msg) { if (msg.type && (msg.type.startsWith('chat:') || msg.type.startsWith('ask:'))) msg.tabId = tabId; broadcaster.broadcast(msg); } };
}
sessionManager.broadcaster = broadcaster;
cliSessionManager.broadcaster = broadcaster;

// Wire CLI settings getter for proxy model mapping
createProxyRouter._cliSettingsGetter = (instanceId) => cliSessionManager.getSettingsByInstanceId(instanceId);

// Initialize MCP Server Manager
mcp.init({ broadcaster, store, claudeSession: sessionManager, authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });


ruleHandler.init({ broadcaster, sessionManager, store, proxyPort: PROXY_PORT, dashboardPort: DASHBOARD_PORT, authToken: AUTH_TOKEN });

// Mount REST API
dashboardApp.use('/api', createApiRouter({ broadcaster, sessionManager, store, proxyPort: PROXY_PORT, dashboardPort: DASHBOARD_PORT, authToken: AUTH_TOKEN, cliSessionManager }));

// Restart endpoint (auth handled by middleware)
dashboardApp.post('/api/restart', (req, res) => {
  res.json({ ok: true, message: 'Server restarting...' });
  setTimeout(() => {
    broadcaster.broadcast({ type: 'server:restarting' });
    // Force-close all WebSocket clients
    for (const client of wss.clients) {
      try { client.terminate(); } catch {}
    }
    // Force-close all HTTP connections so server.close() completes
    dashboardServer.closeAllConnections?.();
    proxyServer.closeAllConnections?.();
    mcp.shutdown();

    const spawnNew = () => {
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true, stdio: 'inherit', cwd: process.cwd(),
        env: { ...process.env, AUTH_TOKEN },
      });
      child.unref();
      process.exit(0);
    };

    let closed = 0;
    const onClosed = () => { if (++closed >= 2) spawnNew(); };
    dashboardServer.close(onClosed);
    proxyServer.close(onClosed);
    // Fallback: force exit and spawn even if close callbacks haven't fired
    setTimeout(spawnNew, 2000);
  }, 300);
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
    sessionManager.setReady();
    console.log('');
    console.log('  Claude Code API Proxy running.');
    console.log('');
    console.log(`  Proxy:     http://127.0.0.1:${PROXY_PORT} (localhost only)`);
    console.log(`  Dashboard: http://localhost:${DASHBOARD_PORT}`);
    console.log(`  API:       http://localhost:${DASHBOARD_PORT}/api/run`);
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
  });
});

// Clean shutdown: unregister MCP servers
function gracefulShutdown() {
  mcp.shutdown();
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
