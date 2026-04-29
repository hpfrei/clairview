# VistaClair External API

VistaClair exposes a REST API on the dashboard port (default `:3457`) that lets external applications run chats and workflows programmatically. All responses stream as **Server-Sent Events (SSE)**, giving you real-time text deltas, workflow step progress, and interactive question prompts.

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

Start a chat or workflow. By default returns a **Server-Sent Events** stream. Set `"stream": false` to block until completion and get a single JSON response instead.

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

#### Workflow mode

```json
{
  "type": "workflow",
  "workflow": "code-review",
  "stream": false,
  "inputs": { "target": "src/", "depth": "thorough" },
  "cwd": "optional/subdirectory",
  "profile": "full",
  "sourceInstanceId": "originating-instance-id",
  "files": {
    "dataset": [
      { "name": "data.csv", "data": "data:text/csv;base64,aWQsb..." }
    ]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `"workflow"` |
| `workflow` | string | yes | Name of the workflow to run (e.g. `"code-review"`) |
| `stream` | boolean | no | `false` to return a single JSON response instead of SSE. Default: `true`. |
| `inputs` | object | no | Key-value input variables. For prompt-mode workflows, pass `{ "prompt": "your message" }`. |
| `cwd` | string | no | Working directory (sandboxed into `outputs/`) |
| `profile` | string | no | Profile override for all steps |
| `files` | object | no | File attachments keyed by workflow input name: `{inputKey: [{name, data}]}`. Each file is a base64 data URL. The input variable (`{{inputKey}}`) resolves to the placed filename in step prompts. |
| `sourceInstanceId` | string | no | Instance ID for routing AskUserQuestion back to the originating tab. |

#### Workflow JSON schema

Workflow definitions (`capabilities/workflows/<name>/workflow.json`) use this structure:

```json
{
  "name": "my-workflow",
  "description": "What this workflow does",
  "inputs": {
    "topic": "The topic to process",
    "image": { "type": "file", "description": "Image to analyze", "accept": "image/*" }
  },
  "outputs": {
    "summary": { "type": "string", "description": "Result text" },
    "chart": { "type": "file", "description": "Generated chart image" }
  },
  "steps": { ... }
}
```

The `outputs` field declares what the workflow returns. Output types: `string`, `file`, `object`. File outputs are automatically collected from the working directory and returned as base64 data URLs (see [Output files](#output-files)). The `outputs` spec is also surfaced in the MCP tool description when the workflow is registered as a tool.

The `GET /api/workflows` endpoint (via WebSocket `workflow:list`) returns each workflow's `inputs` and `outputs` metadata alongside `name`, `description`, `status`, and `stepCount`.

#### SSE events (stream mode, default)

All responses stream as Server-Sent Events (`Content-Type: text/event-stream`).

| Event | Payload | When |
|-------|---------|------|
| `text` | `{ text }` | Streamed text delta from Claude (both chat and workflow steps) |
| `ask` | `{ toolUseId, questions }` | AskUserQuestion — the session needs user input to continue. Answer via `POST /api/run/answer`. |
| `step` | `{ stepId, status, text? }` | Workflow only: step started (`status: "running"`), progress (`text` included), or completed (`status: "done"` / `"failed"`) |
| `error` | `{ error }` | Error message |
| `done` | `{ result, sessionId? }` (chat) or `{ result, runId, output?, files? }` (workflow) | Final result. Chat: `result` is the full text, `sessionId` enables multi-turn. Workflow: `result` is the status, `output` is the final step text, `files` is an array of output file objects (see [Output files](#output-files)), `runId` identifies the run. |

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

**Chat response:**
```json
{ "result": "...full text...", "text": "...full text...", "sessionId": "..." }
```

**Workflow response:**
```json
{ "result": "done", "text": "...concatenated text...", "runId": "...", "output": "...", "steps": [...], "files": [{"name": "chart.png", "data": "data:image/png;base64,...", "mimeType": "image/png", "size": 8192}] }
```

If the run pauses on an `AskUserQuestion`, the response returns immediately with `status: "waiting"` and the question details so you can answer via `POST /api/run/answer` and re-submit:

```json
{ "status": "waiting", "toolUseId": "toolu_abc", "questions": [...], "text": "...so far..." }
```

#### Output files

When a workflow produces files in its working directory, they are automatically collected and returned in the `files` field of both the SSE `done` event and the JSON response. Input files (uploaded via the `files` request parameter, prefixed with `upload-`) are excluded.

Each file object has:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Filename |
| `data` | string | Base64 data URL: `data:<mimeType>;base64,<encoded>` |
| `mimeType` | string | MIME type (e.g., `image/png`, `application/pdf`) |
| `size` | number | File size in bytes (before encoding) |

**Limits**: Files over 10 MB or a total exceeding 50 MB are excluded from the response. They remain accessible via `GET /api/file?path=<absolute-path>`.

**Supported MIME types**: html, json, js, css, txt, md, csv, xml, png, jpg, jpeg, gif, svg, webp, pdf, zip, tar, gz. Unknown extensions default to `application/octet-stream`.

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

**Workflow files** (`files: {inputKey: [{name, data}]}`):
- Files are placed in the working directory
- The input variable (`{{inputKey}}` in step prompts) resolves to the placed filename(s), comma-separated if multiple

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

Three use cases covering text input, file input, streaming the response, and capturing results. Each shows both Bash and Node.js.

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

### Workflow — with text and file input

Run a workflow with text inputs and file inputs, stream step progress, and capture the final output.

**Bash:**

```bash
#!/usr/bin/env bash
TOKEN="YOUR_TOKEN"
HOST="http://localhost:3457"

# Encode file inputs (keyed by workflow input name)
CSV_DATA="data:text/csv;base64,$(base64 -w0 sales.csv)"

# Run workflow with text input + file input
CURRENT_EVENT=""
curl -N -s -X POST "$HOST/api/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"workflow\",
    \"workflow\": \"analyze-data\",
    \"inputs\": { \"focus\": \"quarterly trends\" },
    \"cwd\": \"reports\",
    \"files\": { \"dataset\": [{\"name\": \"sales.csv\", \"data\": \"$CSV_DATA\"}] }
  }" | while IFS= read -r line; do
  if [[ "$line" == event:* ]]; then
    CURRENT_EVENT="${line#event: }"
  elif [[ "$line" == data:* ]]; then
    JSON="${line#data: }"
    case "$CURRENT_EVENT" in
      text)  echo "$JSON" | jq -rj '.text // empty' ;;
      step)  echo "$JSON" | jq -r '"[\(.stepId)] \(.status // .text // "")"' ;;
      done)  echo "" ; echo "$JSON" | jq '"Status: \(.result)\nRun ID: \(.runId)\nOutput: \(.output // "none")"' -r ;;
      error) echo "$JSON" | jq -r '.error' >&2 ;;
    esac
  fi
done

# Download files the workflow generated
curl -s "$HOST/api/dirs?path=reports" -H "Authorization: Bearer $TOKEN" | jq '.dirs'
curl -s "$HOST/api/file?path=$(pwd)/outputs/reports/analysis.html" \
  -H "Authorization: Bearer $TOKEN" -o analysis.html
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
  // Encode file input (keyed by workflow input name)
  const csvB64 = fs.readFileSync('sales.csv', 'base64');
  const csvData = `data:text/csv;base64,${csvB64}`;

  // Run workflow with text + file inputs
  const res = await post('/api/run', {
    type: 'workflow',
    workflow: 'analyze-data',
    inputs: { focus: 'quarterly trends' },
    cwd: 'reports',
    files: { dataset: [{ name: 'sales.csv', data: csvData }] },
  });

  await streamSSE(res, {
    text:  d => process.stdout.write(d.text || ''),
    step:  d => console.log(`[${d.stepId}] ${d.status || d.text || ''}`),
    error: d => console.error('Error:', d.error),
    done:  d => {
      console.log(`\nStatus: ${d.result}`);
      console.log(`Run ID: ${d.runId}`);
      if (d.output) console.log(`Output: ${d.output}`);
    },
  });
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

The `api_client_example/` directory contains zero-dependency Node.js reference clients with interactive AskUserQuestion handling:

```bash
# Chat (with multi-turn support)
TOKEN=your-token node api_client_example/chat.js "your prompt here"

# Workflow
TOKEN=your-token node api_client_example/workflow.js my-workflow '{"key":"value"}'
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

**Run a workflow:**
```json
{ "type": "workflow:run", "name": "my-workflow", "inputs": {}, "tabId": "tab-1", "files": {"key": [{"name": "f.csv", "data": "data:text/csv;base64,..."}]} }
```

**Cancel a workflow:**
```json
{ "type": "workflow:run:cancel", "runId": "run-id" }
```

The WebSocket also receives all SSE-equivalent events (`chat:event`, `chat:output`, `ask:question`, `workflow:step:*`, `workflow:run:complete`, etc.) broadcast to all connected clients.
