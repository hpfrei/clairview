const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const InteractionStore = require('./src/store');
const DashboardBroadcaster = require('./src/dashboard-ws');
const createProxyRouter = require('./src/proxy');
const ClaudeSessionManager = require('./src/claude-sessions');
const caps = require('./src/capabilities');
const mcp = require('./src/mcp');
const workflowHandler = require('./src/workflow-handler');
const { OUTPUTS_DIR, ensureDir } = require('./src/utils');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3456');
const DASHBOARD_PORT = parseInt(process.argv[2] || process.env.DASHBOARD_PORT || '3457');
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

// getActiveModelDef: returns the model definition if the active profile uses a non-Anthropic model
function getActiveModelDef() {
  if (!sessionManager?.capabilities?.modelDef) return null;
  return caps.loadModel(__dirname, sessionManager.capabilities.modelDef) || null;
}

const proxyRouter = createProxyRouter(store, { broadcast: (...args) => broadcaster.broadcast(...args) }, TARGET_URL, getActiveModelDef);
proxyApp.use(proxyRouter);
const proxyServer = http.createServer(proxyApp);

// --- Dashboard server (port 3457) ---
const dashboardApp = express();
dashboardApp.use(express.urlencoded({ extended: false }));

// Auth: cookie parser helper
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

// Auth middleware for all other routes
dashboardApp.use((req, res, next) => {
  const token = getTokenFromCookies(req.headers.cookie);
  if (token === AUTH_TOKEN) return next();
  res.redirect('/login');
});

dashboardApp.use(express.static(path.join(__dirname, 'public')));

// Serve workflow/chat outputs at /outputs (directory auto-created)
ensureDir(OUTPUTS_DIR);
dashboardApp.use('/outputs', express.static(OUTPUTS_DIR));

const dashboardServer = http.createServer(dashboardApp);

// Session manager (spawns claude -p instances through the proxy)
sessionManager = new ClaudeSessionManager(PROXY_PORT, { broadcast: (...args) => broadcaster.broadcast(...args) }, store, { authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// WebSocket server on dashboard (with auth)
const wss = new WebSocketServer({ noServer: true });
broadcaster = new DashboardBroadcaster(wss, store, sessionManager);

dashboardServer.on('upgrade', (req, socket, head) => {
  const token = getTokenFromCookies(req.headers.cookie);
  if (token !== AUTH_TOKEN) {
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

// Initialize MCP Server Manager
mcp.init({ broadcaster, store, claudeSession: sessionManager, authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// Initialize Workflow Handler
workflowHandler.init({ broadcaster, sessionManager, proxyPort: PROXY_PORT });

// Start both servers (proxy on localhost only)
proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
  dashboardServer.listen(DASHBOARD_PORT, () => {
    sessionManager.setReady();
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
