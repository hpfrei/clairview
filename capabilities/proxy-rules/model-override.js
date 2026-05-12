module.exports = function(ctx) {
  if (ctx.body.model === 'claude-opus-4-7') {
    ctx.body.model = 'claude-opus-4-6';
    if (ctx.body.context_management?.effort === 'xhigh') {
      ctx.body.context_management.effort = 'high';
    }
  }
};
