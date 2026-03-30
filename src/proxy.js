const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream');
const SSEPassthrough = require('./sse-passthrough');
const { generateId, filterRequestHeaders, filterResponseHeaders, sanitizeForDashboard } = require('./utils');
const { getProvider } = require('./providers/registry');

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
function trackSSEEvent(event, interaction, activeToolBlocks, broadcaster) {
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
    if (tb && tb.name === 'AskUserQuestion') {
      try {
        const input = JSON.parse(tb.inputJson);
        pendingQuestions.set(tb.id, { questions: input.questions || [], resolve: null, reject: null });
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

function createProxyRouter(store, broadcaster, targetUrl, getActiveModelDef) {
  const router = express.Router();

  router.use(express.json({ limit: '50mb' }));
  router.use(express.raw({ limit: '50mb', type: () => false }));

  // POST /v1/messages - main endpoint
  router.post('/v1/messages', async (req, res) => {
    const body = req.body;
    const isStreaming = !!body.stream;

    // --- AskUserQuestion interception ---
    // Scan request messages for error tool_results matching a pending question
    let intercepted = false;
    if (body.messages) {
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

            // Broadcast question to dashboard (include workflow context if set)
            const qCtx = _questionContext || {};
            console.log(`[proxy] Broadcasting ask:question ${toolUseId}, questionContext:`, qCtx.tabId ? `tabId=${qCtx.tabId}` : 'none (chat)');
            broadcaster.broadcast({
              type: 'ask:question',
              toolUseId,
              questions: pending.questions,
              ...(qCtx.tabId ? { tabId: qCtx.tabId, runId: qCtx.runId, stepId: qCtx.stepId } : {}),
            });

            try {
              // Wait for user answer (5 min timeout)
              const answer = await Promise.race([
                answerPromise,
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Question timeout')), 300000)
                ),
              ]);

              // Rewrite the tool_result with the real answer
              msg.content[i] = {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: JSON.stringify(answer),
              };

              const aCtx = _questionContext || {};
              broadcaster.broadcast({ type: 'ask:answered', toolUseId, ...(aCtx.tabId ? { tabId: aCtx.tabId } : {}) });
            } catch {
              // Timeout or error - forward original error as-is
              const tCtx = _questionContext || {};
              broadcaster.broadcast({ type: 'ask:timeout', toolUseId, ...(tCtx.tabId ? { tabId: tCtx.tabId } : {}) });
            }

            pendingQuestions.delete(toolUseId);
          }
        }
      }
    }

    const interaction = {
      id: generateId(),
      timestamp: Date.now(),
      endpoint: '/v1/messages',
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
    const modelDef = typeof getActiveModelDef === 'function' ? getActiveModelDef() : null;
    const provider = modelDef ? getProvider(modelDef.provider) : null;

    if (modelDef && !provider) {
      console.warn(`[proxy] Unknown provider "${modelDef.provider}" for model "${modelDef.name}" — falling through to Anthropic`);
    }

    if (provider && modelDef) {
      // --- Translation path: route through non-Anthropic provider ---
      try {
        const translated = provider.translateRequest(body, modelDef);
        console.log(`[proxy] Translating to ${modelDef.name} (${modelDef.provider}) → ${translated.url}`);

        // Update interaction to reflect what was actually sent
        interaction.request.model = modelDef.label || modelDef.name;
        interaction.request.max_tokens = translated.body.max_tokens;
        interaction.endpoint = translated.url;
        interaction.translatedFrom = body.model; // preserve original for reference
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
                    trackSSEEvent(parsed, interaction, activeToolBlocks, broadcaster);
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
                      trackSSEEvent(parsed, interaction, activeToolBlocks, broadcaster);
                    }
                  }
                }
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

        // Track AskUserQuestion tool_use blocks per-request
        const activeToolBlocks = new Map();

        const passthrough = new SSEPassthrough((event) => {
          interaction.response.sseEvents.push(event);

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

          // --- Track AskUserQuestion tool_use blocks ---
          if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
            const cb = event.data.content_block;
            activeToolBlocks.set(event.data.index, {
              id: cb.id,
              name: cb.name,
              inputJson: '',
            });
          }
          if (event.eventType === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta') {
            const tb = activeToolBlocks.get(event.data.index);
            if (tb) tb.inputJson += event.data.delta.partial_json || '';
          }
          if (event.eventType === 'content_block_stop') {
            const tb = activeToolBlocks.get(event.data?.index);
            if (tb && tb.name === 'AskUserQuestion') {
              try {
                const input = JSON.parse(tb.inputJson);
                pendingQuestions.set(tb.id, { questions: input.questions || [], resolve: null, reject: null });
                console.log(`[proxy] Recorded AskUserQuestion ${tb.id} with ${input.questions?.length || 0} questions`);
              } catch {}
            }
            activeToolBlocks.delete(event.data?.index);
          }

          broadcaster.broadcast({
            type: 'sse_event',
            interactionId: interaction.id,
            event,
          });

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
              if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                pendingQuestions.set(block.id, {
                  questions: block.input?.questions || [],
                  resolve: null,
                  reject: null,
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
  router.post('/v1/messages/count_tokens', async (req, res) => {
    const body = req.body;
    const interaction = {
      id: generateId(),
      timestamp: Date.now(),
      endpoint: '/v1/messages/count_tokens',
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

// Question context — set by workflow executeStep to tag questions with tabId/runId/stepId
let _questionContext = null;
function setQuestionContext(ctx) { _questionContext = ctx; }
function clearQuestionContext() { _questionContext = null; }
function getQuestionContext() { return _questionContext; }

module.exports = createProxyRouter;
module.exports.pendingQuestions = pendingQuestions;
module.exports.setQuestionContext = setQuestionContext;
module.exports.clearQuestionContext = clearQuestionContext;
module.exports.getQuestionContext = getQuestionContext;
