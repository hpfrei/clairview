// Global model override rule — applies to ALL requests passing through the proxy.
// Precedence: per-tab model overrides (set in CLI tab settings) apply BEFORE this rule.
// If a tab has already rewritten the model, this rule sees the rewritten value.
module.exports = function(ctx) {
  if (ctx.body.model === 'claude-opus-4-7') {
    ctx.body.model = 'claude-opus-4-6';
    if (ctx.body.output_config?.effort === 'xhigh') {
      ctx.body.output_config.effort = 'high';
    }
  }
};
