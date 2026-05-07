require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const { OUTPUTS_DIR, DATA_HOME, ensureDir, setProcessBroadcaster, getActiveProcessCount } = require('./src/utils');
const InteractionStore = require('./src/store');
const DashboardBroadcaster = require('./src/dashboard-ws');
const createProxyRouter = require('./src/proxy');
const { pendingQuestions } = createProxyRouter;
const CliSessionManager = require('./src/cli-sessions');
const caps = require('./src/capabilities');
const mcp = require('./src/mcp');
let pro = null;
let proLicenseValid = false;
const proDir = path.join(DATA_HOME, 'vistaclair-pro');
const isDev = process.argv.includes('dev');
if (isDev && !process.env.DEV_LICENCING_SERVER) {
  console.error('Error: DEV_LICENCING_SERVER is not set. Create a .env file with DEV_LICENCING_SERVER=http://localhost:8888');
  process.exit(1);
}
const LICENSE_SERVER = isDev
  ? process.env.DEV_LICENCING_SERVER
  : (process.env.PROD_LICENCING_SERVER || 'https://licencing.hpfreilabs.com');
const PRODUCT_SLUG = process.env.HPFREILABS_PRODUCT || 'vistaclair-pro-subscription';
const ruleHandler = require('./src/proxy-rule-handler');
const createApiRouter = require('./src/api');

// Check and auto-install native dependencies, then restart so they load
(function checkDependencies() {
  const { execSync } = require('child_process');
  const missing = [];
  try { require.resolve('node-pty'); } catch { missing.push('node-pty'); }
  if (missing.length === 0) return;
  console.log(`Installing missing dependencies: ${missing.join(', ')}...`);
  try {
    execSync(`npm install --no-save ${missing.join(' ')}`, { cwd: __dirname, stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to install dependencies: ${err.message}`);
    console.error('CLI terminal feature will be unavailable. Run manually: npm install ' + missing.join(' '));
    return;
  }
  console.log('Dependencies installed. Restarting...\n');
  const child = require('child_process').spawnSync(process.execPath, process.argv.slice(1), { cwd: __dirname, stdio: 'inherit' });
  process.exit(child.status ?? 1);
})();

async function validateLicense() {
  const fs = require('fs');
  const licPath = path.join(DATA_HOME, 'data', 'license.json');
  if (!fs.existsSync(licPath)) return { valid: false, reason: 'no-key' };

  let stored;
  try { stored = JSON.parse(fs.readFileSync(licPath, 'utf-8')); } catch { return { valid: false, reason: 'corrupt' }; }
  if (!stored.key) return { valid: false, reason: 'no-key' };

  const os = require('os');
  const machineId = crypto.createHash('sha256')
    .update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 16);

  try {
    const https = require('https');
    const licUrl = new URL('/api/validate', LICENSE_SERVER);
    const body = JSON.stringify({ key: stored.key, product: PRODUCT_SLUG, machineId });

    const response = await new Promise((resolve, reject) => {
      const mod = licUrl.protocol === 'https:' ? https : require('http');
      const r = mod.request(licUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); } });
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.write(body);
      r.end();
    });

    return { valid: !!response.valid, reason: response.valid ? 'ok' : (response.error || 'invalid'), customerPortalUrl: response.customerPortalUrl || null };
  } catch {
    return { valid: true, reason: 'offline-grace' };
  }
}

let productInfo = null;
let customerPortalUrl = null;

async function fetchProductInfo() {
  try {
    const https = require('https');
    const infoUrl = new URL(`/api/product/group/${PRODUCT_SLUG}`, LICENSE_SERVER);
    const data = await new Promise((resolve, reject) => {
      const mod = infoUrl.protocol === 'https:' ? https : require('http');
      const r = mod.request(infoUrl, { timeout: 10000 }, (resp) => {
        let buf = '';
        resp.on('data', c => buf += c);
        resp.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('Invalid response')); } });
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.end();
    });
    productInfo = data;
  } catch {}
}

(async () => {

const fs = require('fs');
fetchProductInfo();
setInterval(fetchProductInfo, 60 * 60 * 1000);

if (fs.existsSync(proDir)) {
  const result = await validateLicense();
  proLicenseValid = result.valid;
  customerPortalUrl = result.customerPortalUrl || null;
  if (proLicenseValid) {
    try { pro = require('./vistaclair-pro'); } catch (e) {
      console.error('  Pro: failed to load:', e.message);
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

dashboardApp.get('/login/auto', (req, res) => {
  if (req.query.token === AUTH_TOKEN) {
    res.setHeader('Set-Cookie', `token=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    return res.redirect('/');
  }
  res.redirect('/login');
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
      toolUseId: hookData.tool_use_id || null,
      request: hookData,
      response: { status: 200, body: hookData.tool_response || null },
      timing: { startedAt: Date.now(), duration: 0 },
      status: 'complete', isStreaming: false,
    };
    store.add(interaction);
    broadcaster.broadcast({ type: 'interaction:start', interaction });
    broadcaster.broadcast({ type: 'interaction:complete', interaction });

    if (hookData.transcript_path && hookData.session_id && cliSessionManager) {
      cliSessionManager.notifyTranscriptPath(
        req.body.instanceId,
        hookData.session_id,
        hookData.transcript_path
      );
    }
  } catch {}
  res.status(200).end();
});

// AskUserQuestion endpoint — called by vista-AskUserQuestion MCP tool handler.
// Broadcasts the question to the dashboard and waits for the user's answer.
const { getInstanceContext } = require('./src/utils');
let askSeq = 0;
dashboardApp.post('/api/ask', async (req, res) => {
  if (req.body?.token !== AUTH_TOKEN) return res.status(401).end();
  const { instanceId, formData, questions } = req.body;
  const askId = `ask-${Date.now()}-${++askSeq}`;
  const ctx = instanceId ? getInstanceContext(instanceId) : null;
  const tabId = ctx?.tabId || '__default__';

  const promise = new Promise((resolve, reject) => {
    pendingQuestions.set(askId, { formData: formData || {}, questions: questions || [], resolve, reject, ctx });
  });

  broadcaster.broadcast({
    type: 'ask:question',
    toolUseIds: [askId],
    forms: [{ toolUseId: askId, formData: formData || {}, questions: questions || [] }],
    ...(tabId !== '__default__' ? { tabId } : {}),
  });
  console.log(`[api/ask] Broadcasting ask:question askId=${askId} tabId=${tabId}`);

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

function rewriteGitUrl(url, auth) {
  const parsed = new URL(url);
  const target = new URL(LICENSE_SERVER);
  parsed.protocol = target.protocol;
  parsed.hostname = target.hostname;
  parsed.port = target.port;
  if (auth) parsed.username = auth.username;
  if (auth) parsed.password = auth.password;
  return parsed.toString();
}

function installPro(response, licenseKey) {
  const { execFileSync } = require('child_process');
  const creds = response.gitCredentials
    ? { username: encodeURIComponent(response.gitCredentials.username), password: encodeURIComponent(response.gitCredentials.password) }
    : null;

  if (!fs.existsSync(proDir)) {
    const cloneUrl = rewriteGitUrl(response.gitUrl, creds);
    const safeUrl = cloneUrl.replace(/:\/\/[^@]+@/, '://***@');
    console.log(`[pro] Cloning from ${safeUrl}`);
    try {
      execFileSync('git', ['clone', cloneUrl, 'vistaclair-pro'], { cwd: DATA_HOME, stdio: 'pipe', timeout: 60000 });
      console.log('[pro] Clone successful');
    } catch (err) {
      console.error(`[pro] Clone failed: ${err.message}`);
      throw err;
    }
  }

  if (response.extras) {
    for (const extra of response.extras) {
      const dir = path.join(DATA_HOME, extra.name);
      if (!fs.existsSync(dir)) {
        const extraUrl = rewriteGitUrl(extra.gitUrl, creds);
        try {
          execFileSync('git', ['clone', extraUrl, extra.name], { cwd: DATA_HOME, stdio: 'pipe', timeout: 60000 });
        } catch (e) {
          if (!extra.optional) throw e;
        }
      }
    }
  }

  ensureDir(path.join(DATA_HOME, 'data'));
  fs.writeFileSync(path.join(DATA_HOME, 'data', 'license.json'), JSON.stringify({ key: licenseKey, activatedAt: new Date().toISOString() }));
}

dashboardApp.post('/api/pro/claim', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID required' });

  try {
    const https = require('https');
    const os = require('os');
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const machineId = crypto.createHash('sha256').update(hostname + username).digest('hex').slice(0, 16);

    const body = JSON.stringify({ orderId, product: PRODUCT_SLUG, machineId, hostname, username });
    const claimUrl = new URL('/api/claim', LICENSE_SERVER);

    const response = await new Promise((resolve, reject) => {
      const mod = claimUrl.protocol === 'https:' ? https : require('http');
      const r = mod.request(claimUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); } });
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.write(body);
      r.end();
    });

    if (!response.valid) return res.json({ ok: false, error: response.error || 'Claim failed' });

    installPro(response, response.key);

    res.json({ ok: true, message: 'Pro activated. Restarting...' });

    setTimeout(() => {
      broadcaster.broadcast({ type: 'server:restarting' });
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true, stdio: 'inherit', cwd: process.cwd(),
        env: { ...process.env, AUTH_TOKEN },
      });
      child.unref();
      process.exit(0);
    }, 500);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

dashboardApp.post('/api/pro/activate', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'License key required' });

  try {
    const https = require('https');
    const os = require('os');
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const machineId = crypto.createHash('sha256').update(hostname + username).digest('hex').slice(0, 16);

    const body = JSON.stringify({ key, product: PRODUCT_SLUG, machineId, hostname, username });
    const activateUrl = new URL('/api/activate', LICENSE_SERVER);

    const response = await new Promise((resolve, reject) => {
      const mod = activateUrl.protocol === 'https:' ? https : require('http');
      const r = mod.request(activateUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); } });
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.write(body);
      r.end();
    });

    if (!response.valid) return res.json({ ok: false, error: response.error || 'Activation failed' });

    installPro(response, response.key);

    res.json({ ok: true, message: 'Pro activated. Restarting...' });

    setTimeout(() => {
      broadcaster.broadcast({ type: 'server:restarting' });
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true, stdio: 'inherit', cwd: process.cwd(),
        env: { ...process.env, AUTH_TOKEN },
      });
      child.unref();
      process.exit(0);
    }, 500);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Pro update check/apply
let proUpdateAvailable = false;

function checkProUpdates() {
  if (!fs.existsSync(proDir)) return;
  try {
    const { execSync } = require('child_process');
    execSync('git fetch', { cwd: proDir, stdio: 'pipe', timeout: 30000 });
    const local = execSync('git rev-parse HEAD', { cwd: proDir, encoding: 'utf-8' }).trim();
    const remote = execSync('git rev-parse @{u}', { cwd: proDir, encoding: 'utf-8' }).trim();
    proUpdateAvailable = local !== remote;
    if (proUpdateAvailable) console.log('[pro] Update available');
  } catch {}
}

if (fs.existsSync(proDir) && proLicenseValid) {
  checkProUpdates();
  setInterval(checkProUpdates, 60 * 60 * 1000);
}

dashboardApp.post('/api/pro/update', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    if (!fs.existsSync(proDir)) return res.json({ ok: false, error: 'Pro not installed' });

    const before = execSync('git rev-parse HEAD', { cwd: proDir, encoding: 'utf-8' }).trim();
    try { execSync('git pull --ff-only', { cwd: proDir, stdio: 'pipe', timeout: 30000 }); } catch {}
    const after = execSync('git rev-parse HEAD', { cwd: proDir, encoding: 'utf-8' }).trim();

    const appsDir = path.join(DATA_HOME, 'vistaclair-apps');
    if (fs.existsSync(path.join(appsDir, '.git'))) {
      try { execSync('git pull --ff-only', { cwd: appsDir, stdio: 'pipe', timeout: 30000 }); } catch {}
    }

    const updated = before !== after;
    proUpdateAvailable = false;
    res.json({ ok: true, updated, version: after.slice(0, 8) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

dashboardApp.get('/api/pro/status', async (req, res) => {
  if (req.query.check === '1') {
    const result = await validateLicense();
    proLicenseValid = result.valid;
    customerPortalUrl = result.customerPortalUrl || customerPortalUrl;
  }
  const installed = fs.existsSync(proDir);
  res.json({
    installed,
    licensed: proLicenseValid,
    loaded: !!pro,
    needsRestart: installed && proLicenseValid && !pro,
    updateAvailable: proUpdateAvailable,
    customerPortalUrl: proLicenseValid ? customerPortalUrl : undefined,
    productInfo: (!pro && !proLicenseValid) ? productInfo : undefined,
  });
});

dashboardApp.post('/api/pro/restart', (req, res) => {
  if (!proLicenseValid || !fs.existsSync(proDir)) return res.status(400).json({ error: 'Not ready' });
  res.json({ ok: true });
  setTimeout(() => {
    broadcaster.broadcast({ type: 'server:restarting' });
    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true, stdio: 'inherit', cwd: process.cwd(),
      env: { ...process.env, AUTH_TOKEN },
    });
    child.unref();
    process.exit(0);
  }, 500);
});

const dashboardServer = http.createServer(dashboardApp);

const cliSessionManager = new CliSessionManager(PROXY_PORT, { broadcast: (...args) => broadcaster.broadcast(...args) }, store, { authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// WebSocket server on dashboard (with auth)
const wss = new WebSocketServer({ noServer: true });
broadcaster = new DashboardBroadcaster(wss, store, { authToken: AUTH_TOKEN, proxyPort: PROXY_PORT, cliSessionManager });
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

cliSessionManager.broadcaster = broadcaster;

// Wire CLI settings getter for proxy model mapping
createProxyRouter._cliSettingsGetter = (instanceId) => cliSessionManager.getSettingsByInstanceId(instanceId);

// Initialize MCP Server Manager
mcp.init({ broadcaster, store, authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT });

// Initialize Pro (Apps Platform) if available
if (pro) {
  pro.init({ broadcaster, store, dashboardApp, authToken: AUTH_TOKEN, dashboardPort: DASHBOARD_PORT, proxyPort: PROXY_PORT, cliSessionManager });
  console.log('  Pro: loaded');
}

ruleHandler.init({ broadcaster, store, proxyPort: PROXY_PORT, dashboardPort: DASHBOARD_PORT, authToken: AUTH_TOKEN });

// Mount REST API
dashboardApp.use('/api', createApiRouter({ broadcaster, store, proxyPort: PROXY_PORT, dashboardPort: DASHBOARD_PORT, authToken: AUTH_TOKEN, cliSessionManager }));

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
    cliSessionManager.saveAllToHistory();
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
      const { exec } = require('child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} "${url}"`);
    }

    // Re-validate license every 4 hours
    setInterval(async () => {
      if (!pro) return;
      const result = await validateLicense();
      if (!result.valid && result.reason !== 'offline-grace') {
        console.log(`  Pro: license no longer valid (${result.reason}) — disabling`);
        pro.shutdown();
        pro = null;
        proLicenseValid = false;
        broadcaster.broadcast({ type: 'pro:disabled', reason: result.reason });
      }
    }, 4 * 60 * 60 * 1000);
  });
});

// Clean shutdown: unregister MCP servers and stop running apps
function gracefulShutdown() {
  cliSessionManager.saveAllToHistory();
  if (pro) pro.shutdown();
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

})();
