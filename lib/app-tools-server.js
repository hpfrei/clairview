#!/usr/bin/env node
// App-Tools MCP Server — serves app-registered MCP tools to Claude sessions.
// Spawned per-session via --mcp-config. Uses the low-level Server class (no Zod).
// Tool calls are routed back to the dashboard, which forwards to the owning app.

import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkBase = path.join(__dirname, "..", "mcp-servers", "integrated", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");

const toolsFile = process.env.VISTACLAIR_APP_TOOLS_FILE;
const dashboardPort = process.env.VISTACLAIR_DASHBOARD_PORT || "3457";
const authToken = process.env.VISTACLAIR_AUTH_TOKEN || "";
const instanceId = process.env.VISTACLAIR_INSTANCE_ID || "";
const appName = process.env.VISTACLAIR_APP_NAME || "";

let tools = [];
try {
  const fs = await import("fs");
  tools = JSON.parse(fs.default.readFileSync(toolsFile, "utf-8"));
} catch (err) {
  process.stderr.write(`app-tools-server: failed to read tools file: ${err.message}\n`);
  process.exit(1);
}

const { Server } = await import(pathToFileURL(path.join(sdkBase, "server", "index.js")).href);
const { StdioServerTransport } = await import(pathToFileURL(path.join(sdkBase, "server", "stdio.js")).href);
const types = await import(pathToFileURL(path.join(sdkBase, "types.js")).href);

const server = new Server(
  { name: "app-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(types.ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(t => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    })),
  };
});

server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `tool ${name} not found` }) }],
      isError: true,
    };
  }

  const timeout = tool.timeout || 180000;

  try {
    const result = await callDashboard(name, args || {}, timeout);
    return result;
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `tool ${name} is producing error: ${err.message}` }) }],
      isError: true,
    };
  }
});

function callDashboard(toolName, args, timeout) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ appName, toolName, arguments: args, instanceId });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: parseInt(dashboardPort, 10),
        path: "/api/app-tool-call",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Vistaclair-Internal": authToken,
        },
        timeout,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(parsed.error));
            } else {
              resolve(parsed.result || { content: [{ type: "text", text: data }] });
            }
          } catch {
            reject(new Error(`Invalid response from dashboard: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`timeout after ${timeout}ms`));
    });
    req.write(body);
    req.end();
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
