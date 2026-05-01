# VistaClair External API

VistaClair exposes a REST API on the dashboard port (default `:3457`) that lets external applications run chats programmatically. All responses stream as **Server-Sent Events (SSE)**, giving you real-time text deltas and interactive question prompts.

## Authentication

Every request must be authenticated using one of three methods:

| Method | Header / Cookie | Use case |
|--------|----------------|----------|
| **Bearer token** | `Authorization: Bearer <TOKEN>` | API clients, scripts, CI/CD |
| **Cookie** | `token=<TOKEN>` | Browser sessions (set via `/login`) |
| **Internal header** | `X-Vistaclair-Internal: true` | Localhost-only (MCP tools, local bridges) |

### Obtaining the token

The auth token is available in two ways:

1. **Environment variable** — set `AUTH_TOKEN` before starting the server:
   ```bash
   AUTH_TOKEN=my-secret-token node server.js
   ```
2. **Auto-generated** — if `AUTH_TOKEN` is not set, a random UUID is generated on startup and printed to the console.

The token is also visible in the dashboard GUI under **Home > API**.

### Body size limit

The server accepts JSON bodies up to **50 MB** (`express.json({ limit: '50mb' })`). This accommodates base64-encoded file uploads.

---

## Endpoints

### POST /api/run

Start a chat. By default returns a **Server-Sent Events** stream. Set `"stream": false` to block until completion and get a single JSON response instead.

#### Chat mode

```json
{
  "type": "chat",
  "prompt": "Your message to Claude",
  "stream": false,
  "cwd": "optional/subdirectory",
  "profile": "full",
  "sessionId": "resume-session-id",
  "sourceInstanceId": "originating-instance-id",
  "files": [
    { "name": "photo.png", "data": "data:image/png;base64,iVBOR..." }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `"chat"` |
| `prompt` | string | yes | The user message to send to Claude |
| `stream` | boolean | no | `false` to return a single JSON response instead of SSE. Default: `true`. |
| `cwd` | string | no | Working directory (sandboxed into `outputs/`). Defaults to `outputs/`. |
| `profile` | string | no | Profile name (`"full"`, `"safe"`, `"readonly"`, or custom). Does not change the global active profile. |
| `sessionId` | string | no | Resume an existing Claude CLI session for multi-turn conversation. Returned in the `done` event. |
| `files` | array | no | File attachments as base64 data URLs: `[{name, data}]`. Files are placed in the working directory and the prompt is automatically augmented with instructions for Claude to read them. |
| `sourceInstanceId` | string | no | Instance ID for routing AskUserQuestion back to the originating chat tab. |

#### SSE events (stream mode, default)

All responses stream as Server-Sent Events (`Content-Type: text/event-stream`).

| Event | Payload | When |
|-------|---------|------|
| `text` | `{ text }` | Streamed text delta from Claude |
| `ask` | `{ toolUseId, questions }` | AskUserQuestion — the session needs user input to continue. Answer via `POST /api/run/answer`. |
| `error` | `{ error }` | Error message |
| `done` | `{ result, sessionId? }` | Final result. `result` is the full text, `sessionId` enables multi-turn. |

**SSE format:**
```
event: text
data: {"text":"Hello, "}

event: text
data: {"text":"world!"}

event: done
data: {"result":"Hello, world!","sessionId":"abc-123"}
```

#### JSON response (stream: false)

When `stream` is `false`, the request blocks until the run completes (30-minute timeout) and returns a single JSON response.

**Response:**
```json
{ "result": "...full text...", "text": "...full text...", "sessionId": "..." }
```

If the run pauses on an `AskUserQuestion`, the response returns immediately with `status: "waiting"` and the question details so you can answer via `POST /api/run/answer` and re-submit:

```json
{ "status": "waiting", "toolUseId": "toolu_abc", "questions": [...], "text": "...so far..." }
```

---

### POST /api/run/answer

Answer a pending `AskUserQuestion` that arrived via the `ask` SSE event. The run resumes after the answer.

```json
{
  "toolUseId": "toolu_abc123",
  "answer": "PostgreSQL",
  "files": [
    { "questionId": "q1", "name": "config.json", "data": "data:application/json;base64,eyJ..." }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `toolUseId` | string | yes | The `toolUseId` from the `ask` event |
| `answer` | any | yes | The answer value (string or structured response) |
| `files` | array | no | File attachments for file-type questions: `[{questionId, name, data}]`. Files are saved to `outputs/_uploads/<toolUseId>/` and relative paths are patched into the answer array. |

**Response:** `{ ok: true }` on success. `404` if no pending question matches the `toolUseId`.

---

### GET /api/dirs

List subdirectories within the `outputs/` sandbox.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string (query) | no | Relative path within `outputs/`. Defaults to root. |

**Response:**
```json
{ "current": "my-project", "absolute": "/path/to/outputs/my-project", "dirs": ["sub1", "sub2"] }
```

---

### POST /api/dirs

Create a new directory within `outputs/`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | no | Parent directory (relative to `outputs/`) |
| `name` | string | yes | Folder name. Letters, numbers, spaces, dots, hyphens, underscores. Max 100 chars. |

**Response:** `{ ok: true, created: "relative/path" }` on success.

---

### GET /api/file

Serve a file from the `outputs/` directory.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string (query) | yes | Absolute path to the file. Must be inside the `outputs/` directory. |

**Response:** The file content with the appropriate `Content-Type` header. Supported types: html, json, js, css, txt, md, csv, xml, png, jpg, gif, svg, webp, pdf (falls back to `application/octet-stream`).

Returns `403` if the path is outside `outputs/`, `404` if the file doesn't exist.

---

## File attachment format

Files are sent as **base64 data URLs** in the `data` field:

```
data:<mime-type>;base64,<base64-encoded-content>
```

Examples:
- `data:image/png;base64,iVBORw0KGgo...`
- `data:text/csv;base64,aWQsbmFtZSxhZ2UK...`
- `data:application/pdf;base64,JVBERi0xLjQK...`

### How files are processed

**Chat files** (`files: [{name, data}]`):
- Files are placed in the working directory as `upload-<timestamp>-<index>-<safename>`
- The prompt is automatically augmented with instructions for Claude to read the files using the Read tool

**Answer files** (`files: [{questionId, name, data}]`):
- Files are saved to `outputs/_uploads/<toolUseId>/`
- Relative paths are patched into the answer array at the matching `questionId` positions

### Encoding files for the API

**Bash (base64 command):**
```bash
FILE_DATA="data:image/png;base64,$(base64 -w0 photo.png)"
```

**Node.js:**
```javascript
const fs = require('fs');
const data = `data:image/png;base64,${fs.readFileSync('photo.png', 'base64')}`;
```

**Python:**
```python
import base64
with open('photo.png', 'rb') as f:
    data = f'data:image/png;base64,{base64.b64encode(f.read()).decode()}'
```

---

## Examples

Two use cases covering text input, file input, streaming the response, and capturing results. Each shows both Bash and Node.js.

### Chat — with text and file input

Send a prompt with an attached file, stream the response text, and capture the `sessionId` for multi-turn.

**Bash:**

```bash
#!/usr/bin/env bash
TOKEN="YOUR_TOKEN"
HOST="http://localhost:3457"

# Encode a file as base64 data URL
FILE_DATA="data:image/png;base64,$(base64 -w0 photo.png)"

# Start a chat with text + file input (SSE stream)
CURRENT_EVENT=""
curl -N -s -X POST "$HOST/api/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"chat\",
    \"prompt\": \"Describe this image and save a summary to summary.txt\",
    \"profile\": \"full\",
    \"cwd\": \"my-project\",
    \"files\": [{\"name\": \"photo.png\", \"data\": \"$FILE_DATA\"}]
  }" | while IFS= read -r line; do
  if [[ "$line" == event:* ]]; then
    CURRENT_EVENT="${line#event: }"
  elif [[ "$line" == data:* ]]; then
    JSON="${line#data: }"
    case "$CURRENT_EVENT" in
      text)  echo "$JSON" | jq -rj '.text // empty' ;;
      done)  echo "" ; echo "$JSON" | jq -r '"sessionId: \(.sessionId)"' ;;
      error) echo "$JSON" | jq -r '.error' >&2 ;;
    esac
  fi
done

# Multi-turn: reuse sessionId from the done event
curl -N -s -X POST "$HOST/api/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"chat","prompt":"Now translate it to French","sessionId":"SESSION_ID"}'

# Download a file Claude created
curl -s "$HOST/api/file?path=$(pwd)/outputs/my-project/summary.txt" \
  -H "Authorization: Bearer $TOKEN" -o summary.txt
```

**Node.js:**

```javascript
const http = require('http');
const fs = require('fs');

const TOKEN = process.env.TOKEN || 'YOUR_TOKEN';
const PORT = 3457;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: PORT, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
    }, resolve);
    req.on('error', reject);
    req.end(data);
  });
}

// Parse SSE stream, call handlers for each event type
function streamSSE(res, handlers) {
  let buf = '', currentEvent = '';
  res.on('data', chunk => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) currentEvent = line.slice(7);
        else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (handlers[currentEvent]) handlers[currentEvent](data);
          } catch {}
        }
      }
    }
  });
  return new Promise(resolve => res.on('end', resolve));
}

async function main() {
  // Encode file as base64 data URL
  const fileB64 = fs.readFileSync('photo.png', 'base64');
  const fileData = `data:image/png;base64,${fileB64}`;

  // Chat with text + file input
  const res = await post('/api/run', {
    type: 'chat',
    prompt: 'Describe this image and save a summary to summary.txt',
    profile: 'full',
    cwd: 'my-project',
    files: [{ name: 'photo.png', data: fileData }],
  });

  let sessionId = null;
  await streamSSE(res, {
    text:  d => process.stdout.write(d.text || ''),
    error: d => console.error('Error:', d.error),
    done:  d => { sessionId = d.sessionId; console.log('\nSession:', sessionId); },
  });

  // Multi-turn: continue the conversation
  if (sessionId) {
    const res2 = await post('/api/run', {
      type: 'chat',
      prompt: 'Now translate it to French',
      sessionId,
    });
    await streamSSE(res2, {
      text: d => process.stdout.write(d.text || ''),
      done: d => console.log('\nDone'),
    });
  }
}

main().catch(console.error);
```

### Answering an AskUserQuestion

When Claude needs input mid-run, the stream emits an `ask` event. Answer it via `POST /api/run/answer` — the run resumes automatically. Answers can include file attachments.

**Bash:**

```bash
#!/usr/bin/env bash
TOKEN="YOUR_TOKEN"
HOST="http://localhost:3457"

# When you receive an ask event in the SSE stream:
#   event: ask
#   data: {"toolUseId":"toolu_abc123","questions":[{"question":"Which database?","options":["PostgreSQL","MySQL"]}]}

# Answer with text
curl -s -X POST "$HOST/api/run/answer" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"toolUseId":"toolu_abc123","answer":"PostgreSQL"}'
# Returns: {"ok":true}

# Answer with a file attachment (for file-type questions)
FILE_DATA="data:text/csv;base64,$(base64 -w0 config.csv)"

curl -s -X POST "$HOST/api/run/answer" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"toolUseId\": \"toolu_abc123\",
    \"answer\": [\"\"],
    \"files\": [{\"questionId\": \"q1\", \"name\": \"config.csv\", \"data\": \"$FILE_DATA\"}]
  }"
```

**Node.js:**

```javascript
const http = require('http');
const fs = require('fs');

const TOKEN = process.env.TOKEN || 'YOUR_TOKEN';
const PORT = 3457;

function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: PORT, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Inside your SSE handler, when you receive an ask event:
async function handleAsk(data) {
  const { toolUseId, questions } = data;
  for (const q of questions) {
    console.log(`Question: ${q.question}`);
    if (q.options) q.options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  }

  // Answer with text
  await postJSON('/api/run/answer', {
    toolUseId,
    answer: 'PostgreSQL',
  });

  // Or answer with a file attachment
  const fileB64 = fs.readFileSync('config.csv', 'base64');
  await postJSON('/api/run/answer', {
    toolUseId,
    answer: [''],
    files: [{
      questionId: 'q1',
      name: 'config.csv',
      data: `data:text/csv;base64,${fileB64}`,
    }],
  });
  // Returns: { ok: true }
}
```

---

## Reference client examples

The `api_client_example/` directory contains a zero-dependency Node.js reference client with interactive AskUserQuestion handling:

```bash
# Chat (with multi-turn support)
TOKEN=your-token node api_client_example/chat.js "your prompt here"
```

Environment variables: `TOKEN` (required), `PORT` (default 3457), `HOST` (default localhost), `CWD` (optional working directory).

---

## WebSocket connection

The dashboard also exposes a WebSocket server on the same port for real-time bidirectional communication.

### Connecting

```javascript
const ws = new WebSocket('ws://localhost:3457');
```

WebSocket authentication uses the **cookie method** — the `token` cookie must be set on the upgrade request. Unauthorized connections receive `HTTP/1.1 401 Unauthorized` and are destroyed.

For programmatic WebSocket clients, set the cookie header:

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3457', {
  headers: { Cookie: `token=${TOKEN}` }
});
```

### Key message types

**Send a chat message:**
```json
{ "type": "chat:send", "tabId": "tab-1", "prompt": "Hello", "files": [{"name": "f.txt", "data": "data:text/plain;base64,..."}] }
```

**Answer an AskUserQuestion:**
```json
{ "type": "ask:answer", "toolUseId": "toolu_abc", "answer": "yes" }
```

The WebSocket also receives all SSE-equivalent events (`chat:event`, `chat:output`, `ask:question`, etc.) broadcast to all connected clients.
