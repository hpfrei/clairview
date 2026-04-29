#!/usr/bin/env node
/**
 * Chat API client example — zero dependencies, Node.js built-ins only.
 *
 * Usage:
 *   TOKEN=<auth-token> node chat.js "your prompt here"
 *   TOKEN=<auth-token> PORT=3457 node chat.js "your prompt here"
 *
 * To attach files, include them as base64 data URLs in the request body:
 *   body.files = [{ name: 'photo.png', data: 'data:image/png;base64,...' }]
 * Files are placed in Claude's working directory and the prompt is augmented
 * with instructions to read them.
 *
 * Streams the response in real-time, handles AskUserQuestion prompts,
 * and demonstrates multi-turn conversation via sessionId.
 */

const http = require('http');
const readline = require('readline');

const TOKEN = process.env.TOKEN;
const PORT = parseInt(process.env.PORT || '3457');
const HOST = process.env.HOST || 'localhost';
const CWD = process.env.CWD || '';

if (!TOKEN) { console.error('Set TOKEN env var to the auth token.'); process.exit(1); }

const prompt = process.argv[2];
if (!prompt) { console.error('Usage: TOKEN=<token> node chat.js "your prompt"'); process.exit(1); }

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

// ── Stream a single run ──────────────────────────────────────────────

function runChat(userPrompt, sessionId) {
  return new Promise((resolve, reject) => {
    const body = { type: 'chat', prompt: userPrompt };
    if (sessionId) body.sessionId = sessionId;
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
        // Process complete SSE blocks
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
        // Process any remaining data
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
          console.error('\n[error]', data.error);
          break;

        case 'done':
          console.log('\n');
          done(data);
          break;
      }
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`> ${prompt}\n`);

  // First turn
  const result = await runChat(prompt);
  console.log('--- Done ---');
  if (result.sessionId) console.log(`sessionId: ${result.sessionId}`);

  // Demonstrate multi-turn: ask user if they want to continue
  if (result.sessionId) {
    const followUp = await askUser('\nSend a follow-up? (enter prompt or press Enter to quit): ');
    if (followUp.trim()) {
      console.log(`\n> ${followUp}\n`);
      const result2 = await runChat(followUp, result.sessionId);
      console.log('--- Done ---');
      if (result2.sessionId) console.log(`sessionId: ${result2.sessionId}`);
    }
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
