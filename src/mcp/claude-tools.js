// Live catalog of Claude Code's built-in tools, probed from `claude mcp serve`
// (the CLI exposes its native tools as a standard MCP server). Probed once per
// server lifetime; concurrent callers share the in-flight promise.

const { spawn } = require('child_process');

let probePromise = null;

function probeClaudeTools() {
  if (!probePromise) {
    probePromise = doProbe().catch((err) => {
      console.warn('  Claude tools probe failed:', err.message);
      return [];
    });
  }
  return probePromise;
}

function doProbe() {
  return new Promise((resolve, reject) => {
    // Plain env: no proxy/handshake vars, so the probe never shows up as an
    // inspector interaction or a tracked Claude instance.
    const proc = spawn('claude', ['mcp', 'serve'], { stdio: ['pipe', 'pipe', 'ignore'] });

    let buffer = '';
    let settled = false;
    const pending = new Map(); // id -> handler(result, error)

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      fn(arg);
    };

    const timer = setTimeout(() => finish(reject, new Error('Timeout probing claude mcp serve')), 15000);

    const send = (method, params, id) => {
      const msg = { jsonrpc: '2.0', method };
      if (id !== undefined) msg.id = id;
      if (params !== undefined) msg.params = params;
      proc.stdin.write(JSON.stringify(msg) + '\n');
    };

    proc.on('error', (err) => finish(reject, err));
    proc.on('close', () => finish(reject, new Error('claude mcp serve exited before responding')));

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const handler = pending.get(msg.id);
        if (!handler) continue;
        pending.delete(msg.id);
        if (msg.error) finish(reject, new Error(msg.error.message || JSON.stringify(msg.error)));
        else handler(msg.result);
      }
    });

    pending.set(1, () => {
      send('notifications/initialized');
      send('tools/list', {}, 2);
    });
    pending.set(2, (result) => {
      const tools = (result?.tools || []).map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || null,
      }));
      finish(resolve, tools);
    });

    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vistaclair', version: '1.0.0' },
    }, 1);
  });
}

module.exports = { probeClaudeTools };
