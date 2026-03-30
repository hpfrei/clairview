// ============================================================
// Workflow WS Message Handler
// Follows src/mcp/index.js pattern: init(), onConnect(), handleMessage()
// ============================================================

const path = require('path');
const workflows = require('./workflows');
const caps = require('./capabilities');
const mcpServers = require('./mcp/servers');
const { resolveOutputDir } = require('./utils');

const PROJECT_ROOT = path.dirname(__dirname);

let broadcaster = null;
let sessionManager = null;
let opts = {};

function init(options) {
  opts = options;
  broadcaster = options.broadcaster;
  sessionManager = options.sessionManager;
  broadcaster.workflowHandler = { onConnect, handleMessage };
}

function onConnect(ws) {
  ws.send(JSON.stringify({
    type: 'workflow:list',
    workflows: workflows.listWorkflows(PROJECT_ROOT),
  }));
}

async function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));
  const cwd = PROJECT_ROOT;

  try {
    switch (msg.type) {
      case 'workflow:list':
        send({ type: 'workflow:list', workflows: workflows.listWorkflows(cwd) });
        break;

      case 'workflow:load':
        const wf = workflows.loadWorkflow(cwd, msg.name);
        if (wf) {
          const compiledSource = workflows.loadCompiledSource(cwd, msg.name);
          send({ type: 'workflow:loaded', name: msg.name, workflow: wf, compiledSource });
        } else {
          send({ type: 'workflow:error', error: `Workflow not found: ${msg.name}` });
        }
        break;

      case 'workflow:save':
        const ok = workflows.saveWorkflow(cwd, msg.name, msg.workflow);
        if (ok) {
          broadcaster.broadcast({ type: 'workflow:list', workflows: workflows.listWorkflows(cwd) });
        } else {
          send({ type: 'workflow:error', error: `Cannot save workflow: ${msg.name} (invalid name — use lowercase alphanumeric with hyphens)` });
        }
        break;

      case 'workflow:saveCompiled':
        const okJs = workflows.saveCompiledSource(cwd, msg.name, msg.compiledSource || '');
        if (okJs) {
          broadcaster.broadcast({ type: 'workflow:list', workflows: workflows.listWorkflows(cwd) });
        } else {
          send({ type: 'workflow:error', error: `Cannot save compiled JS for: ${msg.name}` });
        }
        break;

      case 'workflow:delete':
        const deleted = workflows.deleteWorkflow(cwd, msg.name);
        if (deleted) {
          broadcaster.broadcast({ type: 'workflow:list', workflows: workflows.listWorkflows(cwd) });
        } else {
          send({ type: 'workflow:error', error: `Cannot delete workflow: ${msg.name}` });
        }
        break;

      case 'workflow:generate':
        try {
          const envContext = buildEnvContext(cwd);
          const generated = await workflows.generateWorkflow(
            msg.description,
            msg.feedback || null,
            { proxyPort: opts.proxyPort || 3456, cwd, envContext }
          );
          send({ type: 'workflow:generated', workflow: generated });
        } catch (err) {
          send({ type: 'workflow:error', error: `Generation failed: ${err.message}` });
        }
        break;

      case 'workflow:compile':
        try {
          const envContext = buildEnvContext(cwd);
          const result = await workflows.compileWorkflow(msg.name, {
            proxyPort: opts.proxyPort || 3456,
            cwd,
            broadcaster,
            envContext,
          });
          broadcaster.broadcast({ type: 'workflow:compiled', name: msg.name, success: result.success, compiledSource: result.compiledSource });
          broadcaster.broadcast({ type: 'workflow:list', workflows: workflows.listWorkflows(cwd) });
        } catch (err) {
          send({ type: 'workflow:error', error: `Compilation failed: ${err.message}` });
        }
        break;

      case 'workflow:run':
        try {
          // Resolve CWD into outputs sandbox (creates dir if needed)
          const runCwd = resolveOutputDir(msg.cwd || '');
          // Run async — don't await, let it broadcast progress
          workflows.runWorkflow(msg.name, msg.inputs || {}, {
            sessionManager,
            broadcaster,
            cwd: runCwd,
            tabId: msg.tabId || null,
            proxyPort: opts.proxyPort || 3456,
          }).catch(err => {
            broadcaster.broadcast({ type: 'workflow:error', runId: msg.runId, tabId: msg.tabId || undefined, error: err.message });
          });
        } catch (err) {
          send({ type: 'workflow:error', error: `Run failed: ${err.message}` });
        }
        break;

      case 'workflow:run:cancel':
        const cancelled = workflows.cancelRun(msg.runId);
        if (!cancelled) {
          send({ type: 'workflow:error', error: `No active run: ${msg.runId}` });
        }
        break;

      case 'workflow:run:status':
        const status = workflows.getRunStatus(msg.runId);
        if (status) {
          send({ type: 'workflow:run:status', ...status });
        } else {
          send({ type: 'workflow:error', error: `No active run: ${msg.runId}` });
        }
        break;
    }
  } catch (err) {
    console.error('[workflow] Handler error:', err);
    send({ type: 'workflow:error', error: err.message });
  }
}

function buildEnvContext(cwd) {
  const profiles = caps.listProfiles(cwd).map(p => ({
    name: p.name,
    description: p.description || '',
    model: p.model || null,
    builtin: p.builtin || false,
  }));

  const tools = mcpServers.listTools().filter(t => t.enabled).map(t => ({
    name: t.name,
    description: t.description || '',
    params: (t.params || []).map(p => ({ name: p.name, type: p.type, description: p.description })),
  }));

  const wfs = workflows.listWorkflows(cwd).map(w => ({
    name: w.name,
    description: w.description || '',
    status: w.status,
  }));

  return { profiles, tools, workflows: wfs };
}

module.exports = { init, onConnect, handleMessage };
