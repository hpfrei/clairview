const VISTA_AUQ = 'vista-AskUserQuestion';

module.exports = function(ctx) {
  if (!ctx.instanceId || !ctx.isInternalInstance) return;

  // Request: rename vista-AUQ → AUQ in conversation history sent to Anthropic
  if (ctx.body.messages) {
    for (const msg of ctx.body.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name === VISTA_AUQ) {
          block.name = 'AskUserQuestion';
        }
      }
    }
  }

  // Request: remove vista-AUQ from tools, enhance AUQ schema
  if (Array.isArray(ctx.body.tools)) {
    ctx.body.tools = ctx.body.tools
      .filter(t => t.name !== VISTA_AUQ)
      .map(t => t.name === 'AskUserQuestion' ? ctx.helpers.enhancedAskTool : t);
  }

  // Response: rename AUQ → vista-AUQ so the CLI routes to the MCP tool handler
  return {
    transformSSE(eventStr) {
      if (eventStr.includes('"content_block_start"') && eventStr.includes('"AskUserQuestion"')) {
        return eventStr.replace('"AskUserQuestion"', '"' + VISTA_AUQ + '"');
      }
      return eventStr;
    },
    transformBody(body) {
      if (body?.content) {
        for (const block of body.content) {
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
            block.name = VISTA_AUQ;
          }
        }
      }
      return body;
    },
  };
};
