const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream');
const SSEPassthrough = require('./sse-passthrough');
const { generateId, filterRequestHeaders, filterResponseHeaders, sanitizeForDashboard, getInstanceContext } = require('./utils');
const { getProvider } = require('./providers/registry');
const caps = require('./capabilities');
const { getModelPricing } = caps;
const enhancedAskTool = require('./ask-schema');

const PROJECT_ROOT = path.dirname(__dirname);

// Shared state: pending AskUserQuestion interceptions
// Map<tool_use_id, { questions, resolve, reject }>
const pendingQuestions = new Map();

function sendProxyError(res, err) {
  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message: `Proxy error: ${err.message}` },
  }));
}

// Parse an Anthropic SSE event string ("event: ...\ndata: ...\n\n") into {eventType, data}
function parseSSEString(eventStr) {
  const lines = eventStr.split('\n');
  let eventType = null;
  let dataStr = null;
  for (const line of lines) {
    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
    if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
  }
  if (!eventType || !dataStr) return null;
  try {
    return { eventType, data: JSON.parse(dataStr) };
  } catch {
    return { eventType, data: dataStr };
  }
}

// Shared SSE event tracking for inspector/dashboard (used by both paths)
function trackSSEEvent(event, interaction, activeToolBlocks, broadcaster, instanceId) {
  if (event.eventType === 'message_start') {
    interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
    if (event.data?.message?.usage) {
      interaction.usage = { ...event.data.message.usage };
    }
  }
  if (event.eventType === 'message_delta' && event.data?.usage) {
    interaction.usage = { ...interaction.usage, ...event.data.usage };
  }
  if (event.eventType === 'message_stop') {
    interaction.timing.duration = Date.now() - interaction.timing.startedAt;
    interaction.status = 'complete';
  }

  // Track tool_use blocks for AskUserQuestion
  if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
    const cb = event.data.content_block;
    activeToolBlocks.set(event.data.index, { id: cb.id, name: cb.name, inputJson: '' });
  }
  if (event.eventType === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta') {
    const tb = activeToolBlocks.get(event.data.index);
    if (tb) tb.inputJson += event.data.delta.partial_json || '';
  }
  if (event.eventType === 'content_block_stop') {
    const tb = activeToolBlocks.get(event.data?.index);
    if (tb && tb.name === 'AskUserQuestion' && instanceId) {
      try {
        const input = JSON.parse(tb.inputJson);
        // Capture workflow context now (not later) to avoid race conditions with parallel steps
        // Store full form data for enhanced AskUserQuestion (title, description, submitLabel, cancelLabel, questions)
        pendingQuestions.set(tb.id, { formData: input, questions: input.questions || [], resolve: null, reject: null, ctx: getInstanceContext(instanceId) });
      } catch {}
    }
    activeToolBlocks.delete(event.data?.index);
  }

  broadcaster.broadcast({
    type: 'sse_event',
    interactionId: interaction.id,
    event,
  });
}

function createProxyRouter(store, broadcaster, targetUrl) {
  const router = express.Router();

  router.use(express.json({ limit: '50mb' }));
  router.use(express.raw({ limit: '50mb', type: () => false }));

  // /p/:profileName/i/:instanceId prefix: per-session profile + instance scoped routing
  router.use('/p/:profileName/i/:instanceId', (req, res, next) => {
    req.profileName = decodeURIComponent(req.params.profileName);
    req.instanceId = decodeURIComponent(req.params.instanceId);
    next();
  });

  // /p/:profileName prefix: per-session profile-scoped routing (fallback without instance)
  router.use('/p/:profileName', (req, res, next) => {
    req.profileName = decodeURIComponent(req.params.profileName);
    next();
  });

  // POST /v1/messages - main endpoint
  router.post(['/v1/messages', '/p/:profileName/v1/messages', '/p/:profileName/i/:instanceId/v1/messages'], async (req, res) => {
    const body = req.body;
    const isStreaming = !!body.stream;

    // --- AskUserQuestion interception ---
    // Scan request messages for error tool_results matching a pending question
    let intercepted = false;
    if (body.messages && req.instanceId) {
      for (const msg of body.messages) {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
        for (let i = 0; i < msg.content.length; i++) {
          const block = msg.content[i];
          if (block.type === 'tool_result' && block.is_error && pendingQuestions.has(block.tool_use_id)) {
            intercepted = true;
            const toolUseId = block.tool_use_id;
            const pending = pendingQuestions.get(toolUseId);

            // Set up promise for the answer
            const answerPromise = new Promise((resolve, reject) => {
              pending.resolve = resolve;
              pending.reject = reject;
            });

            // Use context captured when the question was recorded (not global)
            const qCtx = pending.ctx || {};
            console.log(`[proxy] Broadcasting ask:question ${toolUseId}, questionContext:`, qCtx.tabId ? `tabId=${qCtx.tabId}` : 'none (chat)');
            broadcaster.broadcast({
              type: 'ask:question',
              toolUseId,
              questions: pending.questions,
              formData: pending.formData,
              ...(qCtx.tabId ? { tabId: qCtx.tabId, runId: qCtx.runId, stepId: qCtx.stepId } : {}),
            });

            try {
              // Wait for user answer (no timeout — user may take hours)
              const answer = await answerPromise;

              // Rewrite the tool_result with the real answer
              msg.content[i] = {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: JSON.stringify(answer),
              };

              broadcaster.broadcast({ type: 'ask:answered', toolUseId, ...(qCtx.tabId ? { tabId: qCtx.tabId } : {}) });
            } catch {
              // Rejected (e.g. chat stopped) - forward original error as-is
              broadcaster.broadcast({ type: 'ask:timeout', toolUseId, ...(qCtx.tabId ? { tabId: qCtx.tabId } : {}) });
            }

            pendingQuestions.delete(toolUseId);
          }
        }
      }
    }

    // Replace AskUserQuestion schema with enhanced version (internal sessions only)
    if (Array.isArray(body.tools) && req.instanceId) {
      body.tools = body.tools.map(t => t.name === 'AskUserQuestion' ? enhancedAskTool : t);
    }

    // Remove tools that should never be sent to API endpoints
    const REMOVED_TOOLS = new Set([
      'mcp__claude_ai_Gmail__authenticate',
      'mcp__claude_ai_Google_Calendar__authenticate',
      'CronCreate', 'CronDelete', 'CronList',
      'EnterWorktree', 'ExitWorktree',
      'NotebookEdit',
      'RemoteTrigger',
    ]);
    if (Array.isArray(body.tools)) {
      body.tools = body.tools.filter(t => !REMOVED_TOOLS.has(t.name));
    }

    // Resolve profile and model from per-request URL context
    const profileName = req.profileName || null;
    const profileData = profileName ? caps.loadProfile(PROJECT_ROOT, profileName) : null;

    const instCtx = getInstanceContext(req.instanceId);
    const interaction = {
      id: generateId(),
      timestamp: Date.now(),
      endpoint: '/v1/messages',
      profile: profileName || instCtx?.profile || null,
      bare: !!profileData?.bare,
      disableAutoMemory: profileData ? profileData.disableAutoMemory !== false : true,
      instanceId: req.instanceId || null,
      stepId: instCtx?.stepId || null,
      runId: instCtx?.runId || null,
      request: { ...body },
      response: {
        status: null,
        headers: {},
        body: null,
        sseEvents: [],
      },
      timing: {
        startedAt: Date.now(),
        ttfb: null,
        duration: null,
      },
      usage: null,
      isStreaming,
      status: intercepted ? 'intercepted' : 'pending',
    };

    store.add(interaction);
    broadcaster.broadcast({
      type: 'interaction:start',
      interaction: sanitizeForDashboard(interaction),
    });

    // --- Check for model translation ---
    // Profile's modelDef determines routing: if set → translate, if null → direct to Anthropic
    const modelDef = profileData?.modelDef ? caps.loadModel(PROJECT_ROOT, profileData.modelDef) : null;
    const provider = modelDef ? getProvider(modelDef.provider) : null;

    if (modelDef && !provider && modelDef.provider !== 'anthropic') {
      console.warn(`[proxy] Unknown provider "${modelDef.provider}" for model "${modelDef.name}" — falling through to Anthropic`);
    }

    // Attach pricing for cost calculation
    const pricingKey = modelDef ? (modelDef.name || modelDef.modelId) : body.model;
    interaction.pricing = getModelPricing(PROJECT_ROOT, pricingKey);

    if (provider && modelDef) {
      // --- Translation path: route through non-Anthropic provider ---
      try {
        // Filter tools based on profile's disabledTools / allowedTools
        if (profileData && Array.isArray(body.tools)) {
          const disabledSet = profileData.disabledTools?.length > 0
            ? new Set(profileData.disabledTools)
            : null;
          const allowedSet = profileData.allowedTools?.length > 0
            ? new Set(profileData.allowedTools)
            : null;
          if (disabledSet || allowedSet) {
            body.tools = body.tools.filter(t => {
              if (!t.name) return true;
              if (disabledSet && disabledSet.has(t.name)) return false;
              if (allowedSet && !allowedSet.has(t.name)) return false;
              return true;
            });
          }
        }

        // Re-snapshot request after profile-based tool filtering
        interaction.request = { ...body };

        const translated = provider.translateRequest(body, modelDef);
        console.log(`[proxy] Translating to ${modelDef.name} (${modelDef.provider}) → ${translated.url}`);

        // Update interaction to reflect what was actually sent
        interaction.request.model = modelDef.label || modelDef.name;
        interaction.request.max_tokens = translated.body.max_tokens ?? translated.body.max_completion_tokens;
        interaction.endpoint = translated.url;
        interaction.translatedFrom = body.model; // preserve original for reference
        // Store translated request for curl export (mask API key)
        interaction.translatedBody = translated.body;
        interaction.translatedHeaders = Object.fromEntries(
          Object.entries(translated.headers).map(([k, v]) =>
            k.toLowerCase() === 'authorization' ? [k, 'Bearer $API_KEY'] : [k, v]
          )
        );
        broadcaster.broadcast({
          type: 'interaction:update',
          interaction: sanitizeForDashboard(interaction),
        });

        const upstream = await fetch(translated.url, {
          method: 'POST',
          headers: translated.headers,
          body: JSON.stringify(translated.body),
        });

        interaction.response.status = upstream.status;

        // Translation always uses streaming (translateRequest forces stream:true)
        if (upstream.ok) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
          });

          const streamState = provider.createStreamState();
          const activeToolBlocks = new Map();

          // Process OpenAI SSE and translate to Anthropic SSE
          const nodeStream = Readable.fromWeb(upstream.body);
          let buffer = '';

          nodeStream.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (!data) continue;

                const anthropicEvents = provider.translateSSEChunk(data, streamState);
                for (const eventStr of anthropicEvents) {
                  res.write(eventStr);

                  // Parse the translated event for inspector/dashboard tracking
                  const parsed = parseSSEString(eventStr);
                  if (parsed) {
                    interaction.response.sseEvents.push(parsed);
                    trackSSEEvent(parsed, interaction, activeToolBlocks, broadcaster, interaction.instanceId);
                  }
                }
              }
            }
          });

          nodeStream.on('end', () => {
            // Process any remaining buffer
            if (buffer.trim()) {
              const remaining = buffer.trim();
              if (remaining.startsWith('data: ')) {
                const data = remaining.slice(6).trim();
                if (data) {
                  const anthropicEvents = provider.translateSSEChunk(data, streamState);
                  for (const eventStr of anthropicEvents) {
                    res.write(eventStr);
                    const parsed = parseSSEString(eventStr);
                    if (parsed) {
                      interaction.response.sseEvents.push(parsed);
                      trackSSEEvent(parsed, interaction, activeToolBlocks, broadcaster, interaction.instanceId);
                    }
                  }
                }
              }
            }

            // Safety-net finalization — ensures proper Anthropic SSE termination
            // even if the provider stream ends without explicit signal (e.g. Gemini has no [DONE])
            const finalEvents = provider.finalizeStream(streamState);
            for (const eventStr of finalEvents) {
              res.write(eventStr);
              const parsed = parseSSEString(eventStr);
              if (parsed) {
                interaction.response.sseEvents.push(parsed);
                trackSSEEvent(parsed, interaction, activeToolBlocks, broadcaster, interaction.instanceId);
              }
            }

            if (!interaction.timing.duration) {
              interaction.timing.duration = Date.now() - interaction.timing.startedAt;
            }
            if (interaction.status === 'pending' || interaction.status === 'intercepted') {
              interaction.status = 'complete';
            }
            store.save(interaction.id);
            broadcaster.broadcast({
              type: 'interaction:complete',
              interaction: sanitizeForDashboard(interaction),
            });
            res.end();
          });

          nodeStream.on('error', (err) => {
            console.error('Translation stream error:', err.message);
            interaction.status = 'error';
            interaction.response.error = err.message;
            interaction.timing.duration = Date.now() - interaction.timing.startedAt;
            store.save(interaction.id);
            broadcaster.broadcast({
              type: 'interaction:error',
              interactionId: interaction.id,
              error: err.message,
            });
            if (!res.writableEnded) res.end();
          });
        } else {
          // Non-streaming or error from translated provider
          const responseBody = await upstream.text();
          interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
          interaction.timing.duration = Date.now() - interaction.timing.startedAt;
          interaction.status = upstream.ok ? 'complete' : 'error';

          // For errors from translated provider, wrap in Anthropic error format
          if (!upstream.ok) {
            const errorBody = {
              type: 'error',
              error: { type: 'api_error', message: `Provider ${modelDef.name} error (${upstream.status}): ${responseBody.slice(0, 500)}` },
            };
            interaction.response.body = errorBody;
            res.writeHead(upstream.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(errorBody));
          } else {
            // Non-streaming success — translate response body
            try { interaction.response.body = JSON.parse(responseBody); }
            catch { interaction.response.body = responseBody; }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(responseBody);
          }

          store.save(interaction.id);
          broadcaster.broadcast({
            type: 'interaction:complete',
            interaction: sanitizeForDashboard(interaction),
          });
        }
      } catch (err) {
        console.error('Translation proxy error:', err.message);
        interaction.timing.duration = Date.now() - interaction.timing.startedAt;
        interaction.status = 'error';
        interaction.response.error = err.message;
        sendProxyError(res, err);
        store.save(interaction.id);
        broadcaster.broadcast({
          type: 'interaction:error',
          interactionId: interaction.id,
          error: err.message,
        });
      }
    } else {
    // --- Standard Anthropic passthrough ---
    try {
      const upstream = await fetch(`${targetUrl}/v1/messages`, {
        method: 'POST',
        headers: filterRequestHeaders(req.headers),
        body: JSON.stringify(body),
      });

      interaction.response.status = upstream.status;
      interaction.response.headers = filterResponseHeaders(upstream.headers);

      if (isStreaming && upstream.ok) {
        const responseHeaders = {
          ...filterResponseHeaders(upstream.headers),
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        };
        if (!responseHeaders['content-type']) {
          responseHeaders['content-type'] = 'text/event-stream';
        }

        res.writeHead(upstream.status, responseHeaders);

        const activeToolBlocks = new Map();

        const passthrough = new SSEPassthrough((event) => {
          interaction.response.sseEvents.push(event);
          trackSSEEvent(event, interaction, activeToolBlocks, broadcaster, interaction.instanceId);
        });

        const nodeStream = Readable.fromWeb(upstream.body);

        pipeline(nodeStream, passthrough, res, (err) => {
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error('Stream pipeline error:', err.message);
            interaction.status = 'error';
            interaction.response.error = err.message;
            broadcaster.broadcast({
              type: 'interaction:error',
              interactionId: interaction.id,
              error: err.message,
            });
          }
          if (!interaction.timing.duration) {
            interaction.timing.duration = Date.now() - interaction.timing.startedAt;
          }
          if (interaction.status === 'pending' || interaction.status === 'intercepted') {
            interaction.status = 'complete';
          }
          store.save(interaction.id);
          broadcaster.broadcast({
            type: 'interaction:complete',
            interaction: sanitizeForDashboard(interaction),
          });
        });
      } else {
        // Non-streaming response (or error response)
        const responseBody = await upstream.text();
        interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
        interaction.timing.duration = Date.now() - interaction.timing.startedAt;

        try {
          interaction.response.body = JSON.parse(responseBody);
          if (interaction.response.body.usage) {
            interaction.usage = interaction.response.body.usage;
          }
          // Track AskUserQuestion in non-streaming responses too
          if (interaction.response.body.content) {
            for (const block of interaction.response.body.content) {
              if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && interaction.instanceId) {
                pendingQuestions.set(block.id, {
                  formData: block.input || {},
                  questions: block.input?.questions || [],
                  resolve: null,
                  reject: null,
                  ctx: getInstanceContext(interaction.instanceId),
                });
                console.log(`[proxy] Recorded AskUserQuestion ${block.id} (non-streaming)`);
              }
            }
          }
        } catch {
          interaction.response.body = responseBody;
        }

        interaction.status = upstream.ok ? 'complete' : 'error';

        const responseHeaders = filterResponseHeaders(upstream.headers);
        if (!responseHeaders['content-type']) {
          responseHeaders['content-type'] = 'application/json';
        }
        res.writeHead(upstream.status, responseHeaders);
        res.end(responseBody);

        store.save(interaction.id);
        broadcaster.broadcast({
          type: 'interaction:complete',
          interaction: sanitizeForDashboard(interaction),
        });
      }
    } catch (err) {
      console.error('Upstream fetch error:', err.message);
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      interaction.status = 'error';
      interaction.response.error = err.message;

      sendProxyError(res, err);

      store.save(interaction.id);
      broadcaster.broadcast({
        type: 'interaction:error',
        interactionId: interaction.id,
        error: err.message,
      });
    }
    } // end standard Anthropic passthrough
  });

  // POST /v1/messages/count_tokens
  router.post(['/v1/messages/count_tokens', '/p/:profileName/v1/messages/count_tokens', '/p/:profileName/i/:instanceId/v1/messages/count_tokens'], async (req, res) => {
    const body = req.body;
    const interaction = {
      id: generateId(),
      timestamp: Date.now(),
      endpoint: '/v1/messages/count_tokens',
      instanceId: req.instanceId || null,
      request: { ...body },
      response: { status: null, headers: {}, body: null, sseEvents: [] },
      timing: { startedAt: Date.now(), ttfb: null, duration: null },
      usage: null,
      isStreaming: false,
      status: 'pending',
    };

    store.add(interaction);
    broadcaster.broadcast({
      type: 'interaction:start',
      interaction: sanitizeForDashboard(interaction),
    });

    try {
      const upstream = await fetch(`${targetUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: filterRequestHeaders(req.headers),
        body: JSON.stringify(body),
      });

      const responseBody = await upstream.text();
      interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      const responseHeaders = filterResponseHeaders(upstream.headers);
      interaction.response.status = upstream.status;
      interaction.response.headers = responseHeaders;

      try {
        interaction.response.body = JSON.parse(responseBody);
      } catch {
        interaction.response.body = responseBody;
      }

      interaction.status = upstream.ok ? 'complete' : 'error';

      res.writeHead(upstream.status, responseHeaders);
      res.end(responseBody);

      store.save(interaction.id);
      broadcaster.broadcast({
        type: 'interaction:complete',
        interaction: sanitizeForDashboard(interaction),
      });
    } catch (err) {
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      interaction.status = 'error';
      interaction.response.error = err.message;

      sendProxyError(res, err);

      store.save(interaction.id);
    }
  });

  // Catch-all: forward unknown paths transparently
  router.all('*', async (req, res) => {
    try {
      const headers = filterRequestHeaders(req.headers);
      const fetchOpts = {
        method: req.method,
        headers,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchOpts.body = JSON.stringify(req.body);
      }
      const upstream = await fetch(`${targetUrl}${req.path}`, fetchOpts);
      const body = await upstream.arrayBuffer();
      const responseHeaders = filterResponseHeaders(upstream.headers);
      res.writeHead(upstream.status, responseHeaders);
      res.end(Buffer.from(body));
    } catch (err) {
      sendProxyError(res, err);
    }
  });

  return router;
}

/** Reject and remove all pending questions associated with a given tabId */
function clearPendingQuestionsForTab(tabId) {
  for (const [toolUseId, pending] of pendingQuestions) {
    if (pending.ctx?.tabId === tabId) {
      if (pending.reject) pending.reject(new Error('Chat stopped'));
      pendingQuestions.delete(toolUseId);
    }
  }
}

module.exports = createProxyRouter;
module.exports.pendingQuestions = pendingQuestions;
module.exports.clearPendingQuestionsForTab = clearPendingQuestionsForTab;
