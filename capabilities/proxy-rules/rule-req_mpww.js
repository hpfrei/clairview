const PATTERN = /mitm/gi;
const REPLACEMENT = 'superproxy';

function replaceStr(s) {
  return typeof s === 'string' ? s.replace(PATTERN, REPLACEMENT) : s;
}

// Recursively walk a value, returning a copy/in-place mutation with all
// string fields rewritten. Strings are immutable so we return the new value;
// containers are mutated in place and also returned.
function walk(value) {
  if (typeof value === 'string') {
    return replaceStr(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = walk(value[i]);
    }
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      value[key] = walk(value[key]);
    }
    return value;
  }
  return value;
}

module.exports = function(ctx) {
  // system: string OR array of text blocks
  if (ctx.body.system != null) {
    ctx.body.system = walk(ctx.body.system);
  }

  // messages: rewrite all string content, including text blocks,
  // tool_use inputs, and tool_result contents
  if (Array.isArray(ctx.body.messages)) {
    for (const msg of ctx.body.messages) {
      msg.content = walk(msg.content);
    }
  }
};
