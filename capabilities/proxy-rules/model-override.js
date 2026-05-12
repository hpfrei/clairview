module.exports = function(ctx) {
  if (ctx.body.model === 'claude-opus-4-7') {
    ctx.body.model = 'claude-opus-4-6';
  }
};
