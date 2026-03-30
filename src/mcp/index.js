const servers = require('./servers');
const registrar = require('./registrar');
const logs = require('./logs');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let broadcaster = null;
let opts = {};
let store = null;
let serverRunning = false;
let needsRestart = false;

function init(options) {
  opts = options;
  broadcaster = options.broadcaster;
  store = options.store;
  broadcaster.mcpHandler = { onConnect, handleMessage };

  // Ensure the integrated server directory exists
  servers.ensureIntegratedServer();

  // Auto-start after a short delay (let WebSocket server bind first)
  setTimeout(() => autoStart(), 500);
}

function onConnect(ws) {
  const send = (data) => ws.send(JSON.stringify(data));
  send({ type: 'mcp:tool:list', tools: servers.listTools() });
  send({ type: 'mcp:status', status: serverRunning ? 'running' : 'stopped', needsRestart });
  send({ type: 'mcp:meta', meta: servers.readMeta() });
}

function broadcastToolList() {
  broadcaster.broadcast({ type: 'mcp:tool:list', tools: servers.listTools() });
}

function broadcastStatus() {
  broadcaster.broadcast({ type: 'mcp:status', status: serverRunning ? 'running' : 'stopped', needsRestart });
}

function markNeedsRestart() {
  if (serverRunning) {
    needsRestart = true;
    broadcastStatus();
  }
}

function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));
  const broadcast = (data) => bc.broadcast(data);

  try {
    switch (msg.type) {
      // --- Tool CRUD ---
      case 'mcp:tool:list':
        send({ type: 'mcp:tool:list', tools: servers.listTools() });
        break;

      case 'mcp:tool:save': {
        const result = servers.saveTool(msg.tool, msg.oldSlug);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          broadcastToolList();
          markNeedsRestart();
          send({ type: 'mcp:tool:saved', tool: result });
        }
        break;
      }

      case 'mcp:tool:delete': {
        const result = servers.deleteTool(msg.slug);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          broadcastToolList();
          markNeedsRestart();
        }
        break;
      }

      case 'mcp:tool:toggle': {
        const result = servers.toggleTool(msg.slug, msg.enabled);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          broadcastToolList();
          markNeedsRestart();
        }
        break;
      }

      // --- Server Lifecycle ---
      case 'mcp:start':
        startServer(send, broadcast);
        break;

      case 'mcp:stop':
        stopServer();
        broadcastStatus();
        break;

      case 'mcp:restart':
        stopServer();
        startServer(send, broadcast);
        break;

      // --- Tool Discovery & Testing ---
      case 'mcp:tools': {
        const enabledCount = (servers.readMeta()?.tools || []).filter(t => t.enabled).length;
        if (enabledCount === 0) {
          send({ type: 'mcp:tools', tools: [] });
        } else {
          probeTools().then(tools => {
            send({ type: 'mcp:tools', tools });
          }).catch(err => {
            send({ type: 'mcp:error', error: `Tool discovery failed: ${err.message}` });
          });
        }
        break;
      }

      case 'mcp:test': {
        const start = Date.now();
        testTool(msg.tool, msg.params).then(result => {
          const latencyMs = Date.now() - start;
          send({ type: 'mcp:test:result', tool: msg.tool, result, latencyMs });
          logMcpCall(msg.tool, msg.params, result, latencyMs, 'test');
        }).catch(err => {
          const latencyMs = Date.now() - start;
          send({ type: 'mcp:test:result', tool: msg.tool, error: err.message, latencyMs });
          logMcpCall(msg.tool, msg.params, { error: err.message }, latencyMs, 'test');
        });
        break;
      }

      // --- File Operations (extra files) ---
      case 'mcp:file:list':
        send({ type: 'mcp:file:list', files: servers.listFiles() });
        break;

      case 'mcp:file:read': {
        const result = servers.readFile(msg.path);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          send({ type: 'mcp:file:content', ...result });
        }
        break;
      }

      case 'mcp:file:write': {
        const result = servers.writeFile(msg.path, msg.content);
        if (result.error) {
          send({ type: 'mcp:error', error: result.error });
        } else {
          send({ type: 'mcp:file:written', path: result.path });
          send({ type: 'mcp:file:list', files: servers.listFiles() });
        }
        break;
      }

      // --- Logs ---
      case 'mcp:logs': {
        const dir = servers.serverDir();
        const result = logs.readLogs(dir, msg.opts || {});
        send({ type: 'mcp:logs:result', ...result });
        break;
      }

      case 'mcp:logs:stats': {
        const dir = servers.serverDir();
        const stats = logs.getStats(dir);
        send({ type: 'mcp:logs:stats', stats });
        break;
      }

      case 'mcp:logs:clear': {
        const dir = servers.serverDir();
        logs.clearLogs(dir);
        send({ type: 'mcp:logs:result', entries: [], total: 0 });
        break;
      }

      // --- Dependencies ---
      case 'mcp:deps:list':
        send({ type: 'mcp:deps:list', deps: servers.listDeps() });
        break;

      case 'mcp:deps:install':
        send({ type: 'mcp:dep-progress', package: msg.package, status: 'installing', output: '' });
        servers.installDep(
          msg.package, msg.version,
          (data) => send({ type: 'mcp:dep-progress', package: msg.package, status: 'installing', output: data }),
          (ok) => {
            send({ type: 'mcp:dep-progress', package: msg.package, status: ok ? 'installed' : 'failed', output: '' });
            send({ type: 'mcp:deps:list', deps: servers.listDeps() });
          }
        );
        break;

      case 'mcp:deps:uninstall':
        servers.uninstallDep(
          msg.package,
          (data) => send({ type: 'mcp:dep-progress', package: msg.package, status: 'uninstalling', output: data }),
          (ok) => {
            send({ type: 'mcp:deps:list', deps: servers.listDeps() });
          }
        );
        break;

      case 'mcp:deps:install-all':
        send({ type: 'mcp:dep-progress', package: '*', status: 'installing', output: '' });
        servers.installAll(
          (data) => send({ type: 'mcp:dep-progress', package: '*', status: 'installing', output: data }),
          (ok) => {
            send({ type: 'mcp:dep-progress', package: '*', status: ok ? 'installed' : 'failed', output: '' });
            send({ type: 'mcp:deps:list', deps: servers.listDeps() });
          }
        );
        break;

      // --- Server meta update (env vars, name) ---
      case 'mcp:meta:update': {
        const meta = servers.readMeta();
        if (meta) {
          if (msg.updates.env !== undefined) meta.env = msg.updates.env;
          if (msg.updates.secrets !== undefined) meta.secrets = msg.updates.secrets;
          if (msg.updates.name !== undefined) meta.name = msg.updates.name;
          if (msg.updates.scope !== undefined) meta.scope = msg.updates.scope;
          servers.writeMeta(meta);
          markNeedsRestart();
          broadcast({ type: 'mcp:meta', meta });
        }
        break;
      }
    }
  } catch (err) {
    console.error('MCP handler error:', err);
    send({ type: 'mcp:error', error: err.message });
  }
}

// --- Server Lifecycle ---

function autoStart() {
  const meta = servers.readMeta();
  if (!meta) return;

  const dir = servers.serverDir();
  const nodeModules = path.join(dir, 'node_modules');

  if (!fs.existsSync(nodeModules)) {
    console.log('  MCP: Installing dependencies...');
    const install = spawn('npm', ['install'], { cwd: dir, shell: true });
    install.on('close', code => {
      if (code === 0) {
        console.log('  MCP: Dependencies installed.');
        finishStart(meta);
      } else {
        console.error('  MCP: npm install failed.');
      }
    });
  } else {
    finishStart(meta);
  }
}

function startServer(send, broadcast) {
  if (serverRunning) {
    send({ type: 'mcp:error', error: 'Server is already running.' });
    return;
  }

  const meta = servers.readMeta();
  if (!meta) {
    send({ type: 'mcp:error', error: 'Integrated server not initialized.' });
    return;
  }

  const dir = servers.serverDir();
  const nodeModules = path.join(dir, 'node_modules');

  if (!fs.existsSync(nodeModules)) {
    broadcast({ type: 'mcp:output', data: 'Installing dependencies...\n', stream: 'stdout' });
    const install = spawn('npm', ['install'], { cwd: dir, shell: true });
    install.stdout.on('data', d => broadcast({ type: 'mcp:output', data: d.toString(), stream: 'stdout' }));
    install.stderr.on('data', d => broadcast({ type: 'mcp:output', data: d.toString(), stream: 'stderr' }));
    install.on('close', code => {
      if (code !== 0) {
        broadcast({ type: 'mcp:output', data: `npm install failed (code ${code})\n`, stream: 'stderr' });
        return;
      }
      finishStart(meta);
    });
  } else {
    finishStart(meta);
  }
}

function finishStart(meta) {
  const appRoot = path.dirname(path.dirname(__dirname));
  const bridgePath = path.join(appRoot, 'lib', 'mcp-bridge.js');
  const projectDir = opts.claudeSession?.cwd || process.cwd();

  const regResult = registrar.register(
    servers.INTEGRATED_SLUG, meta, bridgePath,
    opts.authToken || '', opts.dashboardPort || 3457, projectDir
  );

  serverRunning = true;
  needsRestart = false;

  if (broadcaster) {
    broadcastStatus();
    const configPath = regResult.ok ? regResult.configPath : '(unknown)';
    broadcaster.broadcast({ type: 'mcp:output', data: `Registered with Claude Code (${configPath}).\n`, stream: 'stdout' });

    // Probe tools (only if there are enabled tools)
    const enabledTools = (meta.tools || []).filter(t => t.enabled);
    if (enabledTools.length > 0) {
      probeTools().then(tools => {
        broadcaster.broadcast({ type: 'mcp:tools', tools });
        const names = tools.map(t => t.name).join(', ');
        broadcaster.broadcast({ type: 'mcp:output', data: `Found ${tools.length} tool(s): ${names}\n`, stream: 'stdout' });
      }).catch(err => {
        broadcaster.broadcast({ type: 'mcp:output', data: `Tool probe failed: ${err.message}\n`, stream: 'stderr' });
      });
    } else {
      broadcaster.broadcast({ type: 'mcp:output', data: 'No enabled tools yet. Add tools via the dashboard.\n', stream: 'stdout' });
    }
  }

  console.log('  MCP: Integrated server registered and ready.');
}

function stopServer() {
  const meta = servers.readMeta();
  const projectDir = opts.claudeSession?.cwd || process.cwd();

  if (meta) {
    registrar.unregister(servers.INTEGRATED_SLUG, meta.scope || 'project', projectDir);
  }

  serverRunning = false;
  needsRestart = false;
}

function shutdown() {
  stopServer();
}

// --- MCP JSON-RPC helpers (tool discovery & testing) ---

function spawnBridge() {
  const appRoot = path.dirname(path.dirname(__dirname));
  const bridgePath = path.join(appRoot, 'lib', 'mcp-bridge.js');
  return spawn('node', [bridgePath, servers.INTEGRATED_SLUG], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_DOC_SERVER_SLUG: servers.INTEGRATED_SLUG,
      CLAUDE_DOC_AUTH_TOKEN: opts.authToken || process.env.AUTH_TOKEN || '',
      CLAUDE_DOC_DASHBOARD_PORT: String(opts.dashboardPort || process.env.DASHBOARD_PORT || 3457),
    },
  });
}

function sendJsonRpc(proc, method, params, id) {
  const msg = { jsonrpc: '2.0', method };
  if (id !== undefined) msg.id = id;
  if (params !== undefined) msg.params = params;
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

function waitForResponse(proc, id, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timeout waiting for MCP response')); }, timeout);

    function cleanup() {
      clearTimeout(timer);
      proc.stdout.removeListener('data', onData);
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
    }

    function onData(data) {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            cleanup();
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
            return;
          }
        } catch { /* skip */ }
      }
    }

    function onError(err) { cleanup(); reject(err); }
    function onClose(code) { cleanup(); reject(new Error(`Bridge exited with code ${code}`)); }

    proc.stdout.on('data', onData);
    proc.on('error', onError);
    proc.on('close', onClose);
  });
}

async function mcpInitialize(proc) {
  sendJsonRpc(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'claude-doc', version: '1.0.0' },
  }, 1);
  await waitForResponse(proc, 1);
  sendJsonRpc(proc, 'notifications/initialized');
}

async function probeTools() {
  const proc = spawnBridge();
  try {
    await mcpInitialize(proc);
    sendJsonRpc(proc, 'tools/list', {}, 2);
    const result = await waitForResponse(proc, 2);
    return result.tools || [];
  } finally {
    proc.kill();
  }
}

async function testTool(toolName, args) {
  const proc = spawnBridge();
  try {
    await mcpInitialize(proc);
    sendJsonRpc(proc, 'tools/call', { name: toolName, arguments: args }, 2);
    return await waitForResponse(proc, 2);
  } finally {
    proc.kill();
  }
}

// --- Inspector logging for MCP tool calls ---

let mcpCallSeq = 0;

function logMcpCall(toolName, input, result, durationMs, source) {
  if (!store || !broadcaster) return;

  const id = `mcp-${Date.now()}-${++mcpCallSeq}`;
  const isError = !!result?.error;

  const interaction = {
    id,
    timestamp: Date.now(),
    endpoint: `mcp://${toolName}`,
    isMcp: true,
    mcpSource: source, // 'test' or 'claude-code'
    request: { tool: toolName, params: input },
    response: {
      status: isError ? 500 : 200,
      body: result,
    },
    timing: { startedAt: Date.now() - durationMs, duration: durationMs },
    status: isError ? 'error' : 'complete',
    isStreaming: false,
  };

  store.add(interaction);
  broadcaster.broadcast({ type: 'interaction:start', interaction: interaction });
  broadcaster.broadcast({ type: 'interaction:complete', interaction: interaction });
}

// Called by the bridge when a tool is executed by Claude Code
function handleBridgeReport(report) {
  if (report.type === 'tool:call') {
    logMcpCall(report.tool, report.params, report.result, report.durationMs, 'claude-code');
  }
}

module.exports = { init, shutdown, handleBridgeReport };
