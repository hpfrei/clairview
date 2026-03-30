// ============================================================
// OpenAI-compatible provider adapter
// Handles: OpenAI, Gemini, DeepSeek, Kimi/Moonshot, Ollama
// ============================================================

const BaseProvider = require('./base');

class OpenAIProvider extends BaseProvider {

  // --- Request translation (Anthropic → OpenAI) ---

  translateRequest(body, modelDef) {
    const messages = [];

    // System prompt
    const systemPrompt = this._buildSystemPrompt(body.system, modelDef);
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Convert Anthropic messages to OpenAI format
    for (const msg of (body.messages || [])) {
      const converted = this._convertMessage(msg);
      if (converted) messages.push(...(Array.isArray(converted) ? converted : [converted]));
    }

    // Convert tools
    const tools = (body.tools || []).map(t => this._convertTool(t, modelDef));

    const openaiBody = {
      model: modelDef.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools.length > 0) {
      openaiBody.tools = tools;
    }

    // Temperature passthrough
    if (body.temperature != null) openaiBody.temperature = body.temperature;

    // Token limit: some models require max_completion_tokens instead of max_tokens
    const tokenParam = modelDef.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
    if (modelDef.maxOutputTokens) {
      openaiBody[tokenParam] = body.max_tokens != null
        ? Math.min(body.max_tokens, modelDef.maxOutputTokens)
        : modelDef.maxOutputTokens;
    } else if (body.max_tokens != null) {
      openaiBody[tokenParam] = body.max_tokens;
    }

    const url = `${modelDef.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${modelDef.apiKey}`,
    };

    return { url, headers, body: openaiBody };
  }

  _buildSystemPrompt(anthropicSystem, modelDef) {
    // anthropicSystem is an array of {type: 'text', text: '...'} blocks
    const original = Array.isArray(anthropicSystem)
      ? anthropicSystem.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      : (typeof anthropicSystem === 'string' ? anthropicSystem : '');

    switch (modelDef.systemPromptMode) {
      case 'replace':
        return modelDef.systemPrompt || '';
      case 'prepend':
        return (modelDef.systemPrompt || '') + '\n\n' + original;
      case 'append':
        return original + '\n\n' + (modelDef.systemPrompt || '');
      case 'passthrough':
      default:
        return original;
    }
  }

  _convertMessage(msg) {
    if (msg.role === 'user') {
      return this._convertUserMessage(msg);
    } else if (msg.role === 'assistant') {
      return this._convertAssistantMessage(msg);
    }
    return null;
  }

  _convertUserMessage(msg) {
    // Anthropic user messages have content as string or array of content blocks
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content };
    }

    if (!Array.isArray(msg.content)) return null;

    const results = [];
    const contentParts = [];
    const toolResults = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        contentParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        // Anthropic image → OpenAI image_url
        const src = block.source;
        if (src.type === 'base64') {
          contentParts.push({
            type: 'image_url',
            image_url: { url: `data:${src.media_type};base64,${src.data}` },
          });
        } else if (src.type === 'url') {
          contentParts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      } else if (block.type === 'tool_result') {
        // Tool results go as separate messages
        toolResults.push(block);
      }
    }

    // Emit tool_result messages first (they respond to assistant's tool_calls)
    for (const tr of toolResults) {
      let content = '';
      if (typeof tr.content === 'string') {
        content = tr.content;
      } else if (Array.isArray(tr.content)) {
        content = tr.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      }
      if (tr.is_error) {
        content = `[Error] ${content}`;
      }
      results.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content,
      });
    }

    // Then emit user message if there's text/image content
    if (contentParts.length > 0) {
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        results.push({ role: 'user', content: contentParts[0].text });
      } else {
        results.push({ role: 'user', content: contentParts });
      }
    }

    return results.length > 0 ? results : null;
  }

  _convertAssistantMessage(msg) {
    if (typeof msg.content === 'string') {
      return { role: 'assistant', content: msg.content };
    }

    if (!Array.isArray(msg.content)) return null;

    const result = { role: 'assistant', content: '', tool_calls: [] };
    let toolCallIndex = 0;

    for (const block of msg.content) {
      if (block.type === 'text') {
        result.content += (result.content ? '\n' : '') + block.text;
      } else if (block.type === 'tool_use') {
        result.tool_calls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
          },
          index: toolCallIndex++,
        });
      }
      // Skip 'thinking' blocks — not relevant for other providers
    }

    if (result.tool_calls.length === 0) delete result.tool_calls;
    if (!result.content) result.content = '';

    return result;
  }

  _convertTool(tool, modelDef) {
    const description = modelDef.toolOverrides?.[tool.name] || tool.description || '';
    return {
      type: 'function',
      function: {
        name: tool.name,
        description,
        parameters: tool.input_schema || {},
      },
    };
  }

  // --- Response translation (OpenAI SSE → Anthropic SSE) ---

  createStreamState() {
    return {
      messageId: `msg_${Date.now()}`,
      contentIndex: 0,
      hasStarted: false,
      textBlockOpen: false,
      toolCalls: {},       // indexed by tool call index
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  translateSSEChunk(data, ss) {
    if (data === '[DONE]') {
      return this._finalize(ss);
    }

    let parsed;
    try { parsed = JSON.parse(data); }
    catch { return []; }

    const events = [];

    // Message start
    if (!ss.hasStarted) {
      ss.hasStarted = true;
      events.push(this._sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: ss.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: parsed.model || 'unknown',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }

    // Handle usage in the chunk (some providers send it)
    if (parsed.usage) {
      ss.inputTokens = parsed.usage.prompt_tokens || ss.inputTokens;
      ss.outputTokens = parsed.usage.completion_tokens || ss.outputTokens;
    }

    const choice = parsed.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta || {};

    // Text content
    if (delta.content != null && delta.content !== '') {
      if (!ss.textBlockOpen) {
        ss.textBlockOpen = true;
        events.push(this._sseEvent('content_block_start', {
          type: 'content_block_start',
          index: ss.contentIndex,
          content_block: { type: 'text', text: '' },
        }));
      }
      events.push(this._sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: ss.contentIndex,
        delta: { type: 'text_delta', text: delta.content },
      }));
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;

        if (tc.id || tc.function?.name) {
          // New tool call starting — close text block if open
          if (ss.textBlockOpen) {
            events.push(this._sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: ss.contentIndex,
            }));
            ss.contentIndex++;
            ss.textBlockOpen = false;
          }

          // Close previous tool call at same index if exists
          if (ss.toolCalls[idx] && ss.toolCalls[idx].started) {
            events.push(this._sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: ss.toolCalls[idx].contentIndex,
            }));
            ss.contentIndex++;
          }

          const toolId = tc.id || `toolu_${Date.now()}_${idx}`;
          const toolName = tc.function?.name || '';

          ss.toolCalls[idx] = {
            id: toolId,
            name: toolName,
            contentIndex: ss.contentIndex,
            started: true,
          };

          events.push(this._sseEvent('content_block_start', {
            type: 'content_block_start',
            index: ss.contentIndex,
            content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
          }));
        }

        // Argument deltas
        if (tc.function?.arguments) {
          const toolState = ss.toolCalls[idx];
          if (toolState) {
            events.push(this._sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: toolState.contentIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }));
          }
        }
      }
    }

    // Finish reason
    if (choice.finish_reason) {
      ss.finishReason = this._translateStopReason(choice.finish_reason);
    }

    return events;
  }

  _finalize(ss) {
    const events = [];

    // Close any open text block
    if (ss.textBlockOpen) {
      events.push(this._sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: ss.contentIndex,
      }));
      ss.contentIndex++;
    }

    // Close any open tool calls
    for (const tc of Object.values(ss.toolCalls)) {
      if (tc.started) {
        events.push(this._sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: tc.contentIndex,
        }));
      }
    }

    // Message delta with stop reason
    events.push(this._sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: ss.finishReason || 'end_turn', stop_sequence: null },
      usage: { output_tokens: ss.outputTokens },
    }));

    // Message stop
    events.push(this._sseEvent('message_stop', { type: 'message_stop' }));

    return events;
  }

  _translateStopReason(openaiReason) {
    switch (openaiReason) {
      case 'stop': return 'end_turn';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_tokens';
      case 'content_filter': return 'end_turn';
      default: return 'end_turn';
    }
  }

  _sseEvent(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

module.exports = OpenAIProvider;
