/**
 * REST API for filesystem browsing and file serving.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { MIME_TYPES } = require('./utils');

function createApiRouter({ broadcaster, store, proxyPort, dashboardPort, authToken, cliSessionManager }) {
  const router = express.Router();
  router.use(express.json());

  // ── GET /api/browse-dirs — real filesystem directory browser ────
  const os = require('os');
  router.get('/browse-dirs', (req, res) => {
    const requestedPath = req.query.path || os.homedir();
    const resolved = path.resolve(requestedPath);
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort();
      res.json({ current: resolved, parent: path.dirname(resolved), dirs });
    } catch (err) {
      res.status(403).json({ error: 'Cannot access directory', path: resolved });
    }
  });

  // ── POST /api/browse-dirs — create a directory on the real filesystem ──
  router.post('/browse-dirs', (req, res) => {
    const { parent, name } = req.body || {};
    if (!parent || !name) return res.status(400).json({ error: 'parent and name are required' });
    if (typeof name !== 'string' || name.length > 100 || /[/\\]/.test(name) || name.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }
    const target = path.join(path.resolve(parent), name);
    try {
      fs.mkdirSync(target, { recursive: true });
      res.json({ ok: true, created: target });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create directory: ' + err.message });
    }
  });

  // ── GET /api/browse-files — filesystem browser with file metadata ──
  router.get('/browse-files', (req, res) => {
    const requestedPath = req.query.path || os.homedir();
    const resolved = path.resolve(requestedPath);
    const sortBy = req.query.sort || 'name';
    const order = req.query.order || 'asc';
    try {
      const dirents = fs.readdirSync(resolved, { withFileTypes: true });
      const entries = [];
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue;
        try {
          const fullPath = path.join(resolved, d.name);
          const stat = fs.statSync(fullPath);
          entries.push({ name: d.name, isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs });
        } catch { /* skip inaccessible entries */ }
      }
      const dirs = entries.filter(e => e.isDirectory);
      const files = entries.filter(e => !e.isDirectory);
      const cmp = (a, b) => {
        let v;
        if (sortBy === 'size') v = a.size - b.size;
        else if (sortBy === 'date') v = a.mtime - b.mtime;
        else v = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return order === 'desc' ? -v : v;
      };
      dirs.sort(cmp);
      files.sort(cmp);
      res.json({ current: resolved, parent: path.dirname(resolved), entries: [...dirs, ...files] });
    } catch (err) {
      res.status(403).json({ error: 'Cannot access directory', path: resolved });
    }
  });

  // ── GET /api/raw-file — serve any file with correct MIME type ──────
  router.get('/raw-file', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const resolved = path.resolve(filePath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(resolved).pipe(res);
    } catch (err) {
      res.status(404).json({ error: 'File not found', path: resolved });
    }
  });

  // ── GET /api/search-files — recursive file search ─────────────────
  router.get('/search-files', (req, res) => {
    const searchPath = req.query.path;
    if (!searchPath) return res.status(400).json({ error: 'path is required' });
    const resolved = path.resolve(searchPath);

    const filenamePattern = req.query.filenamePattern || '';
    const contentPattern = req.query.contentPattern || '';
    const modifiedWithin = req.query.modifiedWithin || '';

    let filenameRe, contentRe;
    try { if (filenamePattern) filenameRe = new RegExp(filenamePattern, 'i'); }
    catch (e) { return res.status(400).json({ error: 'Invalid filename pattern: ' + e.message }); }
    try { if (contentPattern) contentRe = new RegExp(contentPattern, 'i'); }
    catch (e) { return res.status(400).json({ error: 'Invalid content pattern: ' + e.message }); }

    let cutoffMs = 0;
    if (modifiedWithin) {
      const now = Date.now();
      const map = { '5m': 5*60e3, '15m': 15*60e3, '1h': 60*60e3, '24h': 24*60*60e3, '7d': 7*24*60*60e3, '30d': 30*24*60*60e3 };
      if (modifiedWithin === 'today') {
        const d = new Date(); d.setHours(0,0,0,0);
        cutoffMs = d.getTime();
      } else if (map[modifiedWithin]) {
        cutoffMs = now - map[modifiedWithin];
      }
    }

    const TEXT_EXTS = new Set([
      '.txt','.md','.mdx','.json','.js','.mjs','.cjs','.jsx','.ts','.tsx','.css','.scss','.less',
      '.html','.htm','.xml','.csv','.yaml','.yml','.toml','.ini','.sh','.bash','.zsh',
      '.py','.rb','.go','.rs','.java','.c','.cpp','.h','.hpp','.cs','.php','.swift','.kt','.scala',
      '.sql','.r','.lua','.pl','.pm','.ex','.exs','.erl','.hs','.ml','.clj','.dart','.v','.zig',
      '.makefile','.cmake','.gitignore','.gitattributes','.editorconfig',
      '.env','.log','.cfg','.conf','.properties','.lock','.vue','.svelte','.astro',
      '.graphql','.gql','.proto','.tf','.hcl','.nix','.bat','.ps1','.fish',
    ]);

    const results = [];
    const MAX_RESULTS = 200;
    const MAX_CONTENT_SIZE = 1024 * 1024;
    const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', '.cache']);

    function walk(dir) {
      if (results.length >= MAX_RESULTS) return;
      let dirents;
      try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const d of dirents) {
        if (results.length >= MAX_RESULTS) return;
        if (d.name.startsWith('.')) continue;

        const full = path.join(dir, d.name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }

        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(d.name)) continue;
          walk(full);
          continue;
        }
        if (!stat.isFile()) continue;

        if (filenameRe && !filenameRe.test(d.name)) continue;
        if (cutoffMs && stat.mtimeMs < cutoffMs) continue;

        if (contentRe) {
          const ext = path.extname(d.name).toLowerCase();
          if (!TEXT_EXTS.has(ext)) continue;
          if (stat.size > MAX_CONTENT_SIZE) continue;
          try {
            const content = fs.readFileSync(full, 'utf-8');
            if (content.includes('\0')) continue;
            if (!contentRe.test(content)) continue;
          } catch { continue; }
        }

        results.push({ path: full, name: d.name, size: stat.size, mtime: stat.mtimeMs });
      }
    }

    try {
      walk(resolved);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: 'Search failed: ' + err.message });
    }
  });

  return router;
}

module.exports = createApiRouter;
