/**
 * REST API for chat and workflow execution.
 *
 * POST /api/run          — start a chat or workflow, returns SSE stream
 * POST /api/run/answer   — answer an AskUserQuestion mid-stream
 *
 * Chat:     { type: "chat", prompt, cwd?, profile?, sessionId? }
 * Workflow: { type: "workflow", workflow, inputs?, cwd?, profile? }
 *
 * SSE events emitted:
 *   text     — { text }                  streamed assistant text
 *   ask      — { toolUseId, questions }  awaiting answer
 *   step     — { stepId, status, text? } workflow step progress
 *   error    — { error }                 error message
 *   done     — { result, sessionId? }    final output
 */

const path = require('path');
const express = require('express');
const { pendingQuestions } = require('./proxy');
const { resolveOutputDir } = require('./utils');
const caps = require('./capabilities');
const workflows = require('./workflows');

const PROJECT_ROOT = path.dirname(__dirname);

function createApiRouter({ broadcaster, sessionManager, proxyPort, dashboardPort, authToken }) {
  const router = express.Router();
  router.use(express.json());

  // ── POST /api/run ────────────────────────────────────────────────
  router.post('/run', (req, res) => {
    const { type, prompt, workflow, inputs, cwd, profile, sessionId } = req.body || {};

    if (!type || (type === 'chat' && !prompt) || (type === 'workflow' && !workflow)) {
      return res.status(400).json({ error: 'Missing required fields. Chat needs: type, prompt. Workflow needs: type, workflow.' });
    }

    // SSE setup
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (type === 'chat') {
      runChat({ send, res, broadcaster, sessionManager, prompt, cwd, profile, sessionId });
    } else if (type === 'workflow') {
      runWorkflow({ send, res, broadcaster, sessionManager, proxyPort, dashboardPort, authToken, workflow, inputs, cwd, profile });
    } else {
      send('error', { error: `Unknown type: ${type}` });
      res.end();
    }
  });

  // ── POST /api/run/answer ─────────────────────────────────────────
  router.post('/run/answer', (req, res) => {
    const { toolUseId, answer } = req.body || {};
    if (!toolUseId) return res.status(400).json({ error: 'Missing toolUseId' });

    const pending = pendingQuestions.get(toolUseId);
    if (!pending?.resolve) return res.status(404).json({ error: 'No pending question for that toolUseId' });

    pending.resolve(answer);
    res.json({ ok: true });
  });

  return router;
}

// ── Chat execution ───────────────────────────────────────────────────
function runChat({ send, res, broadcaster, sessionManager, prompt, cwd, profile, sessionId }) {
  // Use a dedicated API tab so we don't interfere with browser sessions
  const tabId = `api-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const session = sessionManager.getOrCreate(tabId);

  // Configure CWD and profile (load profile without changing the global active profile)
  if (cwd) session.setCwd(cwd);
  if (profile) {
    const loaded = caps.loadProfile(PROJECT_ROOT, profile);
    if (loaded) session.capabilities = loaded;
  }
  if (sessionId) {
    // Resume an existing Claude CLI session (not store session)
    session.sessionId = sessionId;
  }

  let capturedSessionId = session.sessionId || null;
  let resultText = null;

  const listener = (msg) => {
    if (msg.tabId !== tabId) return;

    if (msg.type === 'chat:event' && msg.event) {
      const ev = msg.event;
      if (ev.type === 'assistant' && ev.message?.content) {
        // Content block deltas come separately; full message sent on result
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        send('text', { text: ev.delta.text });
      } else if (ev.type === 'result') {
        resultText = ev.result || null;
        capturedSessionId = ev.session_id || capturedSessionId;
      }
      if (ev.session_id && !capturedSessionId) {
        capturedSessionId = ev.session_id;
      }
    } else if (msg.type === 'chat:output') {
      send('text', { text: msg.text });
    } else if (msg.type === 'chat:error') {
      send('error', { error: msg.text });
    } else if (msg.type === 'ask:question') {
      send('ask', { toolUseId: msg.toolUseId, questions: msg.questions });
    } else if (msg.type === 'chat:status' && msg.status === 'idle' && typeof msg.exitCode === 'number') {
      // Process exited — send done and close
      send('done', { result: resultText, sessionId: capturedSessionId });
      cleanup();
    }
  };

  function cleanup() {
    broadcaster.removeApiListener(listener);
    sessionManager.remove(tabId);
    res.end();
  }

  res.on('close', () => {
    broadcaster.removeApiListener(listener);
    sessionManager.kill(tabId);
    sessionManager.remove(tabId);
  });

  broadcaster.addApiListener(listener);
  session.send(prompt);
}

// ── Workflow execution ───────────────────────────────────────────────
function runWorkflow({ send, res, broadcaster, sessionManager, proxyPort, dashboardPort, authToken, workflow: name, inputs, cwd, profile }) {
  const runCwd = resolveOutputDir(cwd || '');
  const tabId = `api-wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  let runId = null;

  const listener = (msg) => {
    // Match by runId once known, or by tabId for ask events
    if (runId && msg.runId !== runId && msg.tabId !== tabId) return;
    if (!runId && msg.tabId !== tabId) return;

    if (msg.type === 'workflow:run:started') {
      runId = msg.runId;
    } else if (msg.type === 'workflow:step:start' || msg.type === 'workflow:step:complete') {
      send('step', { stepId: msg.stepId, status: msg.status });
    } else if (msg.type === 'workflow:step:progress') {
      send('step', { stepId: msg.stepId, text: msg.text || msg.output || undefined });
    } else if (msg.type === 'workflow:error') {
      send('error', { error: msg.error });
    } else if (msg.type === 'workflow:run:complete') {
      send('done', { result: msg.status, runId });
      cleanup();
    } else if (msg.type === 'ask:question' && msg.tabId === tabId) {
      send('ask', { toolUseId: msg.toolUseId, questions: msg.questions });
    } else if (msg.type === 'chat:event' && msg.tabId === tabId && msg.event) {
      // Workflow steps stream through chat:event
      const ev = msg.event;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        send('text', { text: ev.delta.text });
      }
    }
  };

  function cleanup() {
    broadcaster.removeApiListener(listener);
    res.end();
  }

  res.on('close', () => {
    broadcaster.removeApiListener(listener);
    if (runId) workflows.cancelRun(runId);
  });

  broadcaster.addApiListener(listener);

  workflows.runWorkflow(name, inputs || {}, {
    sessionManager,
    broadcaster,
    cwd: runCwd,
    tabId,
    profile: profile || undefined,
    proxyPort,
    dashboardPort,
    authToken,
  }).catch(err => {
    send('error', { error: err.message });
    cleanup();
  });
}

module.exports = createApiRouter;
