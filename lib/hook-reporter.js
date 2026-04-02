#!/usr/bin/env node
// Hook reporter: reads Claude Code hook JSON from stdin, POSTs to dashboard.
// Invoked as a hook command by Claude Code. Exits immediately — never blocks tools.
const http = require('http');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => data += c);
process.stdin.on('end', () => {
  const port = process.env.VISTACLAIR_DASHBOARD_PORT;
  const token = process.env.VISTACLAIR_AUTH_TOKEN;
  if (!port || !token) process.exit(0);
  const body = JSON.stringify({
    hookData: data,
    token,
    instanceId: process.env.VISTACLAIR_INSTANCE_ID || null,
  });
  const req = http.request({
    hostname: '127.0.0.1', port: parseInt(port, 10),
    path: '/api/hook-report', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => process.exit(0));
  req.on('error', () => process.exit(0));
  req.end(body);
});
setTimeout(() => process.exit(0), 3000);
