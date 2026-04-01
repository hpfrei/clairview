#!/usr/bin/env node
/**
 * Workflow API client example — zero dependencies, Node.js built-ins only.
 *
 * Usage:
 *   TOKEN=<auth-token> node workflow.js <workflow-name> ['{"key":"val"}']
 *   TOKEN=<auth-token> PORT=3457 node workflow.js my-workflow '{"target":"src/"}'
 *
 * Streams step progress and text in real-time, handles AskUserQuestion prompts.
 */

const http = require('http');
const readline = require('readline');

const TOKEN = process.env.TOKEN;
const PORT = parseInt(process.env.PORT || '3457');
const HOST = process.env.HOST || 'localhost';
const CWD = process.env.CWD || '';

if (!TOKEN) { console.error('Set TOKEN env var to the auth token.'); process.exit(1); }

const workflowName = process.argv[2];
if (!workflowName) { console.error('Usage: TOKEN=<token> node workflow.js <workflow-name> [\'{"key":"val"}\']'); process.exit(1); }

let inputs = {};
if (process.argv[3]) {
  try { inputs = JSON.parse(process.argv[3]); } catch (e) {
    console.error('Invalid JSON inputs:', e.message); process.exit(1);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: HOST, port: PORT, path, method: 'POST', headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Length': Buffer.byteLength(data),
    }}, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function askUser(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(text, answer => { rl.close(); resolve(answer); });
  });
}

function parseSSEChunks(raw) {
  const events = [];
  const blocks = raw.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = null, data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event && data) {
      try { events.push({ event, data: JSON.parse(data) }); } catch {}
    }
  }
  return events;
}

// ── Stream the workflow run ──────────────────────────────────────────

function runWorkflow(name, wfInputs) {
  return new Promise((resolve, reject) => {
    const body = { type: 'workflow', workflow: name, inputs: wfInputs };
    if (CWD) body.cwd = CWD;

    const data = JSON.stringify(body);
    const req = http.request({ hostname: HOST, port: PORT, path: '/api/run', method: 'POST', headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Length': Buffer.byteLength(data),
    }}, res => {
      let buf = '';

      res.on('data', chunk => {
        buf += chunk.toString();
        while (buf.includes('\n\n')) {
          const idx = buf.indexOf('\n\n');
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          const events = parseSSEChunks(block + '\n\n');
          for (const { event, data } of events) {
            handleEvent(event, data, resolve);
          }
        }
      });

      res.on('end', () => {
        if (buf.trim()) {
          const events = parseSSEChunks(buf);
          for (const { event, data } of events) {
            handleEvent(event, data, resolve);
          }
        }
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(data);
    req.end();

    async function handleEvent(event, data, done) {
      switch (event) {
        case 'text':
          process.stdout.write(data.text || '');
          break;

        case 'step':
          if (data.status) {
            console.log(`[step: ${data.stepId}] ${data.status}`);
          }
          if (data.text) {
            console.log(`  ${data.text}`);
          }
          break;

        case 'ask': {
          console.log('\n--- Question from Claude ---');
          for (const q of data.questions || []) {
            console.log(`  ${q.question}`);
            if (q.options) q.options.forEach((o, i) => console.log(`    ${i + 1}. ${o}`));
          }
          const answer = await askUser('Your answer: ');
          await postJSON('/api/run/answer', { toolUseId: data.toolUseId, answer });
          console.log('(answer sent, waiting for response...)\n');
          break;
        }

        case 'error':
          console.error('[error]', data.error);
          break;

        case 'done':
          console.log('');
          done(data);
          break;
      }
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`Running workflow: ${workflowName}`);
  if (Object.keys(inputs).length > 0) console.log(`Inputs: ${JSON.stringify(inputs)}`);
  console.log('');

  const result = await runWorkflow(workflowName, inputs);

  console.log('--- Done ---');
  console.log(`Status: ${result.result}`);
  if (result.runId) console.log(`Run ID: ${result.runId}`);

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
