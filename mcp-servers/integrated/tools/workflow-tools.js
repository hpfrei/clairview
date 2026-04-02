// Dynamic workflow tool registration — scans compiled workflows and registers each as an MCP tool.
// Loaded at MCP bridge startup; fresh per session so recompilation takes effect automatically.
import { z } from "zod";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, "capabilities", "workflows");

/** Strip -workflow suffix, replace hyphens with underscores */
function toToolName(workflowName) {
  return workflowName.replace(/-workflow$/, "").replace(/-/g, "_");
}

/** Build Zod input schema from compiled.inputs */
function buildInputSchema(inputs) {
  const schema = {};
  for (const [key, def] of Object.entries(inputs || {})) {
    const type = typeof def === "string" ? "string" : (def.type || "string");
    const desc = typeof def === "string" ? def : (def.description || "");
    const required = typeof def === "object" ? def.required !== false : true;

    let field;
    switch (type) {
      case "number":  field = z.number(); break;
      case "boolean": field = z.boolean(); break;
      default:        field = z.string();
    }
    if (desc) field = field.describe(desc);
    if (!required) field = field.optional();
    schema[key] = field;
  }
  return schema;
}

/** Create a workflow handler that POSTs to /api/run and streams SSE */
function createWorkflowHandler(workflowName) {
  return async (input) => {
    const http = await import("http");
    const dashPort = process.env.CLAIRVIEW_DASHBOARD_PORT || "3457";
    const authToken = process.env.CLAIRVIEW_AUTH_TOKEN || "";

    const body = JSON.stringify({
      type: "workflow",
      workflow: workflowName,
      inputs: input || {},
      sourceInstanceId: process.env.CLAIRVIEW_INSTANCE_ID || null,
    });

    return new Promise((resolve) => {
      let errors = [];

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: dashPort,
          path: "/api/run",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + authToken,
            "X-Clairview-Internal": "true",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let buf = "";
          res.on("data", (chunk) => {
            buf += chunk.toString();
            while (buf.includes("\n\n")) {
              const idx = buf.indexOf("\n\n");
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let ev = null, data = null;
              for (const line of block.split("\n")) {
                if (line.startsWith("event: ")) ev = line.slice(7);
                else if (line.startsWith("data: ")) data = line.slice(6);
              }
              if (!ev || !data) continue;
              try { data = JSON.parse(data); } catch { continue; }
              if (ev === "error") errors.push(data.error || "unknown");
              else if (ev === "done") {
                // Return the last step's output — clean result for Claude to continue with
                if (data.output) {
                  resolve({ content: [{ type: "text", text: data.output }] });
                } else if (data.result === "completed") {
                  resolve({ content: [{ type: "text", text: "Workflow completed successfully." }] });
                } else {
                  const errText = errors.length > 0 ? errors.join("\n") : "Unknown error";
                  resolve({ content: [{ type: "text", text: `Workflow ${data.result || "failed"}: ${errText}` }] });
                }
              }
            }
          });
          res.on("end", () => {
            const errText = errors.length > 0 ? errors.join("\n") : "Workflow stream ended unexpectedly";
            resolve({ content: [{ type: "text", text: errText }] });
          });
        }
      );
      req.on("error", (e) => {
        resolve({ content: [{ type: "text", text: "Error: " + e.message }] });
      });
      req.write(body);
      req.end();
    });
  };
}

export default function registerWorkflowTools(server) {
  if (!fs.existsSync(WORKFLOWS_DIR)) return;

  const require = createRequire(import.meta.url);
  const registered = [];

  for (const entry of fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const compiledPath = path.join(WORKFLOWS_DIR, entry.name, "compiled.js");
    if (!fs.existsSync(compiledPath)) continue;

    try {
      // CommonJS require for compiled modules — bust cache for freshness
      delete require.cache[require.resolve(compiledPath)];
      const compiled = require(compiledPath);
      if (!compiled || !Array.isArray(compiled.steps)) continue;

      const toolName = toToolName(compiled.name || entry.name);

      // Get description: prefer compiled.description, fall back to workflow.json
      let description = compiled.description || "";
      if (!description) {
        const wfPath = path.join(WORKFLOWS_DIR, entry.name, "workflow.json");
        try {
          const wf = JSON.parse(fs.readFileSync(wfPath, "utf8"));
          description = wf.description || "";
        } catch {}
      }

      const inputSchema = buildInputSchema(compiled.inputs);

      // Use annotations from compiled module, fall back to conservative defaults
      const annotations = compiled.annotations || {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      };

      server.tool(toolName, description, inputSchema, annotations,
        createWorkflowHandler(compiled.name || entry.name));
      registered.push(toolName);
    } catch (err) {
      if (err.message?.includes("already registered")) {
        process.stderr.write(`[workflow-tools] Skipping "${entry.name}": tool name "${toToolName(entry.name)}" conflicts with existing tool\n`);
      } else {
        process.stderr.write(`[workflow-tools] Failed to register "${entry.name}": ${err.message}\n`);
      }
    }
  }

  if (registered.length > 0) {
    process.stderr.write(`[workflow-tools] Registered ${registered.length} workflow tool(s): ${registered.join(", ")}\n`);
  }
}
