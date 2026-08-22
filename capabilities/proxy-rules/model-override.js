// Global model override rule — applies to ALL requests passing through the proxy.
// Precedence: per-tab model overrides (set in CLI tab settings) apply BEFORE this rule.
// If a tab has already rewritten the model, this rule sees the rewritten value.
module.exports = function(ctx) {
  if (ctx.body.model.indexOf('claude-opus') == 0) {
    //ctx.body.model = 'claude-fable-5'; 
    ctx.body.model = 'claude-opus-4-6';
    /*if (ctx.body.output_config?.effort === 'xhigh') {
      ctx.body.output_config.effort = 'high';
    }*/
  }

  /*if (ctx.body.model.indexOf('claude-sonnet') == 0) {
    ctx.body.model = 'claude-sonnet-5'; 
    //ctx.body.model = 'claude-opus-4-8';
  }

  // CLI tabs: upgrade haiku → sonnet for interactive sessions (cost/quality tradeoff).
  // App AI prompts (e.g. email classifier) keep haiku as requested.
  const isCliTab = ctx.instanceId && ctx.instanceId.startsWith('cli-');
  if (isCliTab && ctx.body.model?.includes('haiku')) {
    ctx.body.model = 'claude-sonnet-5';
  }
  */
};
