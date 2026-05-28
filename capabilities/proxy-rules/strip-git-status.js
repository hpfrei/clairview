module.exports = function(ctx) {
  const sys = ctx.body.system;
  if (!sys) return;

  const marker = '\n\ngitStatus:';

  if (typeof sys === 'string') {
    const idx = sys.indexOf(marker);
    if (idx !== -1) ctx.body.system = sys.slice(0, idx);
  } else if (Array.isArray(sys)) {
    for (const block of sys) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const idx = block.text.indexOf(marker);
        if (idx !== -1) block.text = block.text.slice(0, idx);
      }
    }
  }
};
