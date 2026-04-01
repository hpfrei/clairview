const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJSON, writeJSON, ensureDir } = require('../utils');

// --- Integrated MCP server directory ---

const INTEGRATED_SLUG = 'integrated';
let serversDir = null;

function getServersDir() {
  if (!serversDir) {
    serversDir = path.join(path.dirname(path.dirname(__dirname)), 'mcp-servers');
    ensureDir(serversDir);
  }
  return serversDir;
}

function serverDir() {
  return path.join(getServersDir(), INTEGRATED_SLUG);
}

function metaPath() {
  return path.join(serverDir(), 'meta.json');
}

function readMeta() {
  return readJSON(metaPath());
}

function writeMeta(meta) {
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

// --- Integrated server setup ---

function ensureIntegratedServer() {
  const dir = serverDir();
  if (fs.existsSync(path.join(dir, 'meta.json'))) return readMeta();

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

  const pkg = {
    name: 'clairview-tools',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.12.1',
      'zod': '^3.24.4',
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  const meta = {
    name: 'clairview-tools',
    version: '1.0.0',
    scope: 'project',
    env: {},
    secrets: {},
    tools: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeMeta(meta);
  generateServerJs();
  return meta;
}

// --- Tool CRUD ---

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

function validateSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && slug.length >= 2 && slug.length <= 50;
}

function listTools() {
  const meta = readMeta();
  if (!meta) return [];
  return meta.tools || [];
}

function loadTool(slug) {
  const meta = readMeta();
  if (!meta) return null;
  return (meta.tools || []).find(t => t.slug === slug) || null;
}

function saveTool(tool, oldSlug) {
  const meta = readMeta();
  if (!meta) return { error: 'Integrated server not initialized.' };

  // Prevent saving over builtin tools
  const existing = (meta.tools || []).find(t => t.slug === (tool.slug || slugify(tool.name)));
  if (existing?.builtin) return { error: 'Cannot modify built-in tool.' };

  const slug = tool.slug || slugify(tool.name);
  if (!validateSlug(slug)) return { error: 'Invalid tool name. Use lowercase letters, numbers, hyphens. Min 2 chars.' };

  const entry = {
    slug,
    name: tool.name,
    description: tool.description || '',
    enabled: tool.enabled !== false,
    file: `${slug}.js`,
    params: (tool.params || []).map(p => ({
      name: p.name,
      type: p.type || 'string',
      description: p.description || '',
      required: p.required !== false,
    })),
    handlerBody: tool.handlerBody || `return {\n    content: [{ type: "text", text: "Result from ${tool.name}" }],\n  };`,
  };

  // Handle rename: if oldSlug differs, remove old entry and file
  if (oldSlug && oldSlug !== slug) {
    const oldIdx = meta.tools.findIndex(t => t.slug === oldSlug);
    if (oldIdx >= 0) {
      const oldTool = meta.tools[oldIdx];
      meta.tools.splice(oldIdx, 1);
      const oldFile = path.join(serverDir(), 'tools', oldTool.file);
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    }
  }

  const idx = meta.tools.findIndex(t => t.slug === slug);
  if (idx >= 0) {
    meta.tools[idx] = entry;
  } else {
    meta.tools.push(entry);
  }

  writeMeta(meta);
  writeToolFile(entry);
  generateServerJs();
  return entry;
}

function deleteTool(slug) {
  const meta = readMeta();
  if (!meta) return { error: 'Integrated server not initialized.' };

  const idx = meta.tools.findIndex(t => t.slug === slug);
  if (idx < 0) return { error: 'Tool not found.' };

  if (meta.tools[idx].builtin) return { error: 'Cannot delete built-in tool.' };

  const tool = meta.tools[idx];
  meta.tools.splice(idx, 1);
  writeMeta(meta);

  const filePath = path.join(serverDir(), 'tools', tool.file);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  generateServerJs();
  return { ok: true };
}

function toggleTool(slug, enabled) {
  const meta = readMeta();
  if (!meta) return { error: 'Integrated server not initialized.' };

  const tool = meta.tools.find(t => t.slug === slug);
  if (!tool) return { error: 'Tool not found.' };

  tool.enabled = enabled;
  writeMeta(meta);
  generateServerJs();
  return { ok: true };
}

// --- Code generation ---

function writeToolFile(tool) {
  const dir = serverDir();
  const toolsDir = path.join(dir, 'tools');
  ensureDir(toolsDir);

  const params = (tool.params || []).map(p => {
    let zod;
    switch (p.type) {
      case 'number': zod = 'z.number()'; break;
      case 'boolean': zod = 'z.boolean()'; break;
      case 'object': zod = 'z.record(z.any())'; break;
      case 'array': zod = 'z.array(z.string())'; break;
      default: zod = 'z.string()';
    }
    if (p.description) zod += `.describe(${JSON.stringify(p.description)})`;
    if (!p.required) zod += '.optional()';
    return `    ${p.name}: ${zod},`;
  }).join('\n');

  const paramNames = (tool.params || []).map(p => p.name).join(', ');
  const body = tool.handlerBody || `return {\n    content: [{ type: "text", text: "Result" }],\n  };`;

  const code = `// Auto-generated by clairview — handler body is preserved on regeneration.
import { z } from "zod";

export default function register(server) {
  server.tool(
    ${JSON.stringify(tool.name)},
    ${JSON.stringify(tool.description || '')},
    {
${params}
    },
    async (input) => {
  // input is an object with: { ${paramNames} }
  ${body}
    }
  );
}
`;
  fs.writeFileSync(path.join(toolsDir, tool.file), code);
}

function generateServerJs() {
  const meta = readMeta();
  if (!meta) return;

  const enabled = (meta.tools || []).filter(t => t.enabled);

  const imports = enabled.map(t => {
    const varName = toCamel(t.slug);
    return `import ${varName} from "./tools/${t.file}";`;
  });

  const registrations = enabled.map(t => `${toCamel(t.slug)}(server);`);

  const code = `// Auto-generated by clairview dashboard — do not edit.
// Manage tools via the dashboard's MCP Tools panel.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
${imports.join('\n')}

const server = new McpServer({
  name: ${JSON.stringify(meta.name || 'clairview-tools')},
  version: "1.0.0",
});

${registrations.join('\n')}

export default server;
`;
  fs.writeFileSync(path.join(serverDir(), 'server.js'), code);
}

function toCamel(slug) {
  return 'register' + slug.replace(/(^|-)([a-z])/g, (_, _2, c) => c.toUpperCase());
}

// --- File Operations (generic, for extra files) ---

function sanitizePath(filePath) {
  const normalized = path.normalize(filePath).replace(/\\/g, '/');
  if (normalized.includes('..') || path.isAbsolute(normalized)) return null;
  return normalized;
}

function listFiles() {
  const dir = serverDir();
  if (!fs.existsSync(dir)) return [];
  const results = [];
  function walk(currentDir, prefix) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'logs' || entry.name.startsWith('.')) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), relPath);
      } else {
        results.push(relPath);
      }
    }
  }
  walk(dir, '');
  return results;
}

function readFile(filePath) {
  const safe = sanitizePath(filePath);
  if (!safe) return { error: 'Invalid path.' };
  const full = path.join(serverDir(), safe);
  if (!fs.existsSync(full)) return { error: 'File not found.' };
  return { content: fs.readFileSync(full, 'utf8'), path: safe };
}

function writeFile(filePath, content) {
  const safe = sanitizePath(filePath);
  if (!safe) return { error: 'Invalid path.' };
  const full = path.join(serverDir(), safe);
  const dir = path.dirname(full);
  ensureDir(dir);
  fs.writeFileSync(full, content);
  return { ok: true, path: safe };
}

function deleteFile(filePath) {
  const safe = sanitizePath(filePath);
  if (!safe) return { error: 'Invalid path.' };
  const full = path.join(serverDir(), safe);
  if (!fs.existsSync(full)) return { error: 'File not found.' };
  fs.unlinkSync(full);
  return { ok: true };
}

// --- Dependencies ---

function listDeps() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(serverDir(), 'package.json'), 'utf8'));
    return Object.entries(pkg.dependencies || {}).map(([name, version]) => ({ name, version }));
  } catch { return []; }
}

function installDep(pkgName, version, onData, onDone) {
  const dir = serverDir();
  const arg = version ? `${pkgName}@${version}` : pkgName;
  const proc = spawn('npm', ['install', arg], { cwd: dir, shell: true });
  proc.stdout.on('data', d => onData?.(d.toString()));
  proc.stderr.on('data', d => onData?.(d.toString()));
  proc.on('close', code => onDone?.(code === 0));
}

function uninstallDep(pkgName, onData, onDone) {
  const dir = serverDir();
  const proc = spawn('npm', ['uninstall', pkgName], { cwd: dir, shell: true });
  proc.stdout.on('data', d => onData?.(d.toString()));
  proc.stderr.on('data', d => onData?.(d.toString()));
  proc.on('close', code => onDone?.(code === 0));
}

function installAll(onData, onDone) {
  const dir = serverDir();
  const proc = spawn('npm', ['install'], { cwd: dir, shell: true });
  proc.stdout.on('data', d => onData?.(d.toString()));
  proc.stderr.on('data', d => onData?.(d.toString()));
  proc.on('close', code => onDone?.(code === 0));
}

module.exports = {
  INTEGRATED_SLUG, getServersDir, serverDir, slugify, validateSlug,
  ensureIntegratedServer, readMeta, writeMeta,
  listTools, loadTool, saveTool, deleteTool, toggleTool,
  generateServerJs, writeToolFile,
  listFiles, readFile, writeFile, deleteFile,
  listDeps, installDep, uninstallDep, installAll,
};
