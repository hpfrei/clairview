module.exports = function(ctx) {
  if (ctx.body.model === 'claude-opus-4-7') {
    ctx.body.model = 'claude-opus-4-6';
    if (ctx.body.output_config?.effort === 'xhigh') {
      ctx.body.output_config.effort = 'high';
    }
  }
};
