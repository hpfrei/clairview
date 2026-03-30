#!/usr/bin/env node
// MCP Bridge — stdio runner for MCP servers managed by the dashboard.
// Claude Code spawns this: node lib/mcp-bridge.js <slug>
// It imports the server module and connects it via StdioServerTransport.
//
// The SDK is resolved from the server's own node_modules (not the dashboard's).
// If MCP_DASHBOARD_URL is set, tool calls are reported back for inspector logging.

import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import { Transform } from "stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const slug = process.argv[2] || process.env.CLAUDE_DOC_SERVER_SLUG || "integrated";
const serverDir = path.join(__dirname, "..", "mcp-servers", slug);

// --- Dashboard reporting (optional, for inspector logging) ---

let dashboardWs = null;
const pendingCalls = new Map(); // id → { tool, params, startedAt }

function connectDashboard() {
  const url = process.env.MCP_DASHBOARD_URL;
  const token = process.env.MCP_AUTH_TOKEN;
  if (!url) return;

  try {
    // Dynamic import ws from the server's node_modules or global
    import("ws").then(({ default: WebSocket }) => {
      const ws = new WebSocket(url, { headers: token ? { cookie: `token=${token}` } : {} });
      ws.on("open", () => { dashboardWs = ws; });
      ws.on("error", () => {}); // Silently fail — reporting is optional
      ws.on("close", () => { dashboardWs = null; });
    }).catch(() => {}); // ws module not available — skip reporting
  } catch {}
}

function reportCall(tool, params, result, durationMs) {
  if (!dashboardWs || dashboardWs.readyState !== 1) return;
  try {
    dashboardWs.send(JSON.stringify({
      type: "mcp:bridge:call",
      tool,
      params,
      result,
      durationMs,
    }));
  } catch {}
}

// --- Stdin/stdout interception to observe tool calls ---

function createStdinInterceptor(original) {
  const interceptor = new Transform({
    transform(chunk, encoding, callback) {
      // Observe incoming JSON-RPC messages for tools/call
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.method === "tools/call" && msg.id !== undefined) {
            pendingCalls.set(msg.id, {
              tool: msg.params?.name,
              params: msg.params?.arguments,
              startedAt: Date.now(),
            });
          }
        } catch {}
      }
      callback(null, chunk);
    },
  });
  original.pipe(interceptor);
  return interceptor;
}

function createStdoutInterceptor(original) {
  const realWrite = original.write.bind(original);
  original.write = (chunk, encoding, callback) => {
    // Observe outgoing JSON-RPC responses for tools/call results
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    const lines = str.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pendingCalls.has(msg.id)) {
          const call = pendingCalls.get(msg.id);
          pendingCalls.delete(msg.id);
          const durationMs = Date.now() - call.startedAt;
          const result = msg.error ? { error: msg.error.message || JSON.stringify(msg.error) } : msg.result;
          reportCall(call.tool, call.params, result, durationMs);
        }
      } catch {}
    }
    return realWrite(chunk, encoding, callback);
  };
}

// --- Main ---

async function main() {
  // Start dashboard connection (non-blocking, optional)
  connectDashboard();

  // Resolve the SDK from the server's own node_modules
  const sdkBase = path.join(serverDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "stdio.js");
  const { StdioServerTransport } = await import(pathToFileURL(sdkBase).href);

  // Dynamic import of the user's server module (ESM)
  const mod = await import(pathToFileURL(path.join(serverDir, "server.js")).href);
  const server = mod.default;

  if (!server || typeof server.connect !== "function") {
    process.stderr.write(`Error: server.js must export default an McpServer instance\n`);
    process.exit(1);
  }

  // Intercept stdout to observe tool call responses
  createStdoutInterceptor(process.stdout);

  // Connect — StdioServerTransport reads from stdin and writes to stdout
  const transport = new StdioServerTransport();

  // Intercept stdin to observe tool call requests
  // Note: we pipe original stdin through our interceptor, then the transport reads from it
  // However, StdioServerTransport reads process.stdin directly, so we intercept by
  // observing stdin data events before the transport processes them
  process.stdin.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === "tools/call" && msg.id !== undefined) {
          pendingCalls.set(msg.id, {
            tool: msg.params?.name,
            params: msg.params?.arguments,
            startedAt: Date.now(),
          });
        }
      } catch {}
    }
  });

  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP bridge error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
