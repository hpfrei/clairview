// ============================================================
// Workflow WS Message Handler
// Follows src/mcp/index.js pattern: init(), onConnect(), handleMessage()
// ============================================================

const workflows = require('./workflows');

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
  const cwd = sessionManager?.cwd || process.cwd();
  ws.send(JSON.stringify({
    type: 'workflow:list',
    workflows: workflows.listWorkflows(cwd),
  }));
}

async function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));
  const cwd = sessionManager?.cwd || process.cwd();

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
          const generated = await workflows.generateWorkflow(
            msg.description,
            msg.feedback || null,
            { proxyPort: opts.proxyPort || 3456, cwd }
          );
          send({ type: 'workflow:generated', workflow: generated });
        } catch (err) {
          send({ type: 'workflow:error', error: `Generation failed: ${err.message}` });
        }
        break;

      case 'workflow:compile':
        try {
          const result = await workflows.compileWorkflow(msg.name, {
            proxyPort: opts.proxyPort || 3456,
            cwd,
            broadcaster,
          });
          broadcaster.broadcast({ type: 'workflow:compiled', name: msg.name, success: result.success, compiledSource: result.compiledSource });
          broadcaster.broadcast({ type: 'workflow:list', workflows: workflows.listWorkflows(cwd) });
        } catch (err) {
          send({ type: 'workflow:error', error: `Compilation failed: ${err.message}` });
        }
        break;

      case 'workflow:run':
        try {
          // Run async — don't await, let it broadcast progress
          workflows.runWorkflow(msg.name, msg.inputs || {}, {
            sessionManager,
            broadcaster,
            cwd,
            proxyPort: opts.proxyPort || 3456,
          }).catch(err => {
            broadcaster.broadcast({ type: 'workflow:error', runId: msg.runId, error: err.message });
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

module.exports = { init, onConnect, handleMessage };
