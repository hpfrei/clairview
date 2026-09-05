const fs = require('fs');
const path = require('path');

function getLogDir(serverDir) {
  const dir = path.join(serverDir, 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function todayFile(serverDir) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(getLogDir(serverDir), `${date}.jsonl`);
}

function readLogs(serverDir, opts = {}) {
  const { tool, status, search, limit = 100, offset = 0 } = opts;
  const logDir = getLogDir(serverDir);
  if (!fs.existsSync(logDir)) return { entries: [], total: 0 };

  // Read all log files, sorted newest first
  const files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse();

  const allEntries = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(logDir, file), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        allEntries.push(JSON.parse(line));
      } catch {}
    }
  }

  // Sort newest first
  allEntries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  // Filter
  let filtered = allEntries;
  if (tool) filtered = filtered.filter(e => e.tool === tool);
  if (status) filtered = filtered.filter(e => e.status === status);
  if (search) {
    const lc = search.toLowerCase();
    filtered = filtered.filter(e => JSON.stringify(e).toLowerCase().includes(lc));
  }

  const total = filtered.length;
  const entries = filtered.slice(offset, offset + limit);
  return { entries, total };
}

function getStats(serverDir) {
  const { entries } = readLogs(serverDir, { limit: 10000 });
  if (entries.length === 0) return { totalCalls: 0, errorRate: 0, avgLatency: 0, callsByTool: {} };

  const totalCalls = entries.length;
  const errors = entries.filter(e => e.status === 'error').length;
  const errorRate = totalCalls > 0 ? Math.round((errors / totalCalls) * 1000) / 10 : 0;
  const latencies = entries.filter(e => typeof e.latencyMs === 'number').map(e => e.latencyMs);
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const callsByTool = {};
  for (const e of entries) {
    callsByTool[e.tool] = (callsByTool[e.tool] || 0) + 1;
  }

  return { totalCalls, errorRate, avgLatency, callsByTool };
}

function clearLogs(serverDir) {
  const logDir = getLogDir(serverDir);
  if (!fs.existsSync(logDir)) return;
  for (const file of fs.readdirSync(logDir)) {
    if (file.endsWith('.jsonl')) {
      fs.unlinkSync(path.join(logDir, file));
    }
  }
}

module.exports = { readLogs, getStats, clearLogs };
