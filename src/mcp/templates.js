const fs = require('fs');
const path = require('path');
const { PACKAGE_ROOT } = require('../utils');

const templatesDir = path.join(PACKAGE_ROOT, 'templates', 'mcp-servers');

function listTemplates() {
  if (!fs.existsSync(templatesDir)) return [];
  return fs.readdirSync(templatesDir)
    .filter(name => {
      const tpl = path.join(templatesDir, name, 'template.json');
      return fs.existsSync(tpl);
    })
    .map(name => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(templatesDir, name, 'template.json'), 'utf8'));
        return { id: name, ...meta };
      } catch { return null; }
    })
    .filter(Boolean);
}

function instantiate(templateName, targetDir, slug) {
  const srcDir = path.join(templatesDir, templateName);
  if (!fs.existsSync(srcDir)) return false;

  const files = fs.readdirSync(srcDir).filter(f => f !== 'template.json');
  for (const file of files) {
    let content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    content = content.replace(/\{\{slug\}\}/g, slug);
    fs.writeFileSync(path.join(targetDir, file), content);
  }

  // Read template meta for extra deps
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(srcDir, 'template.json'), 'utf8'));
    // Write package.json with extra deps
    const pkg = {
      name: slug,
      version: '1.0.0',
      type: 'module',
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.12.1',
        'zod': '^3.24.4',
      },
    };
    if (meta.extraDeps) {
      for (const dep of meta.extraDeps) {
        const parts = dep.split('@');
        if (parts.length > 1 && parts[0]) {
          pkg.dependencies[parts[0]] = parts.slice(1).join('@');
        } else {
          pkg.dependencies[dep] = 'latest';
        }
      }
    }
    fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2));
  } catch {}

  return true;
}

module.exports = { listTemplates, instantiate };
