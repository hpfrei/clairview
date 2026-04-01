// === MCP Tool Manager — single integrated server, tool-centric UI ===
(function() {
  'use strict';
  const { state, sendWs, escHtml } = window.dashboard;

  // --- State ---
  const mcp = {
    tools: [],           // tool entries from meta.json
    status: 'stopped',   // integrated server status
    needsRestart: false,
    meta: null,          // server meta (name, env, secrets)
    editing: null,       // slug of tool being edited
    editTool: null,      // working copy of the tool being edited
    liveTools: [],       // tools discovered from running server (for testing)
    testResult: null,
    testHistory: [],
    output: [],
    deps: [],
    depOutput: '',
  };

  // --- WS Message Dispatch ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'mcp:tool:list':
        mcp.tools = msg.tools || [];
        renderPanel();
        break;
      case 'mcp:tool:saved':
        mcp.editTool = msg.tool;
        mcp.editing = msg.tool.slug;
        renderModalHeader();
        break;
      case 'mcp:status':
        mcp.status = msg.status || 'stopped';
        mcp.needsRestart = !!msg.needsRestart;
        renderPanel();
        if (mcp.editing) renderModalHeader();
        break;
      case 'mcp:meta':
        mcp.meta = msg.meta;
        break;
      case 'mcp:tools':
        mcp.liveTools = msg.tools || [];
        if (mcp.editing) renderTestSection();
        break;
      case 'mcp:test:result':
        mcp.testResult = msg;
        mcp.testHistory.unshift({
          timestamp: new Date().toISOString(),
          tool: msg.tool,
          status: msg.error ? 'error' : 'success',
          latencyMs: msg.latencyMs,
          result: msg.result,
          error: msg.error,
        });
        if (mcp.editing) renderTestResult();
        break;
      case 'mcp:error':
        alert(msg.error);
        break;
      case 'mcp:output':
        mcp.output.push({
          ts: new Date().toLocaleTimeString('en-US', { hour12: false }),
          data: msg.data,
          stream: msg.stream,
        });
        break;
      case 'mcp:deps:list':
        mcp.deps = msg.deps || [];
        break;
      case 'mcp:dep-progress':
        mcp.depOutput += msg.output;
        break;
    }
  }

  // ========== PANEL RENDERING ==========

  function renderPanel() {
    const panel = document.getElementById('ref-mcp');
    if (!panel) return;

    const countEl = document.getElementById('capMcpCount');
    if (countEl) {
      const enabled = mcp.tools.filter(t => t.enabled).length;
      countEl.textContent = enabled > 0 ? `${enabled} tool${enabled > 1 ? 's' : ''}` : '0';
    }

    const running = mcp.status === 'running';
    const statusClass = running ? 'running' : 'stopped';
    const statusLabel = mcp.status.charAt(0).toUpperCase() + mcp.status.slice(1);

    let html = `<div class="ref-intro">
      <strong>MCP Tools</strong> extend Claude Code with custom tools you create. One integrated server
      (<code>clairview-tools</code>) runs automatically and registers with Claude Code &mdash;
      you just add tools below and Claude can call them like built-in ones.
    </div>`;

    // Server status bar
    html += `<div class="mcp-status-bar">
      <span class="mcp-status ${statusClass}"></span>
      <span>${statusLabel}</span>
      ${mcp.needsRestart ? '<span class="mcp-restart-badge">restart needed</span>' : ''}
      <div style="margin-left:auto;display:flex;gap:4px">
        <button class="cap-new-btn" id="mcpRestart" title="Restart the integrated server">${mcp.needsRestart ? '↻ Restart Now' : '↻ Restart'}</button>
      </div>
    </div>`;

    // Tool list header
    html += `<div class="cap-section-header">
      <span>Tools</span>
      <button class="cap-new-btn" id="mcpNewTool">+ New Tool</button>
    </div>`;

    // Tool list
    if (mcp.tools.length === 0) {
      html += '<div class="mcp-empty">No tools yet. Click <strong>+ New Tool</strong> to create one.</div>';
    } else {
      html += '<div class="cap-list" id="mcpToolList">';
      for (const t of mcp.tools) {
        const bi = t.builtin;
        html += `<div class="cap-list-item mcp-tool-row">
          <label class="mcp-tool-toggle" title="${bi ? 'Built-in (always enabled)' : t.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}">
            <input type="checkbox" ${t.enabled ? 'checked' : ''} data-slug="${t.slug}" class="mcp-tool-cb" ${bi ? 'disabled' : ''}>
          </label>
          <span class="cap-item-name${t.enabled ? '' : ' mcp-disabled'}">${escHtml(t.name)}${bi ? ' <span class="ref-tag tag-ro" style="font-size:9px;margin-left:4px">built-in</span>' : ''}</span>
          <span class="cap-item-desc">${escHtml(t.description || '')}</span>
          <span class="cap-list-actions">
            <button class="cap-edit-btn mcp-tool-edit" data-slug="${t.slug}" title="${bi ? 'View tool' : 'Edit tool'}">&#9998;</button>
            ${bi ? '' : `<button class="cap-del-btn mcp-tool-del" data-slug="${t.slug}" title="Delete tool">&#10005;</button>`}
          </span>
        </div>`;
      }
      html += '</div>';
    }

    panel.innerHTML = html;
    attachPanelEvents(panel);
  }

  function attachPanelEvents(panel) {
    panel.querySelector('#mcpNewTool')?.addEventListener('click', createNewTool);
    panel.querySelector('#mcpRestart')?.addEventListener('click', () => sendWs({ type: 'mcp:restart' }));
    panel.querySelectorAll('.mcp-tool-cb').forEach(cb => cb.addEventListener('change', () => {
      sendWs({ type: 'mcp:tool:toggle', slug: cb.dataset.slug, enabled: cb.checked });
    }));
    panel.querySelectorAll('.mcp-tool-edit').forEach(btn => btn.addEventListener('click', () => {
      const tool = mcp.tools.find(t => t.slug === btn.dataset.slug);
      if (tool) { mcp.editTool = { ...tool }; openToolModal(tool.slug); }
    }));
    panel.querySelectorAll('.mcp-tool-del').forEach(btn => btn.addEventListener('click', () => {
      if (confirm(`Delete tool "${btn.dataset.slug}"? This cannot be undone.`)) {
        sendWs({ type: 'mcp:tool:delete', slug: btn.dataset.slug });
      }
    }));
  }

  // ========== TOOL MODAL ==========

  function createNewTool() {
    mcp.editTool = {
      slug: null,
      name: '',
      description: '',
      enabled: true,
      params: [{ name: 'input', type: 'string', description: '', required: true }],
      handlerBody: 'return {\n    content: [{ type: "text", text: "Result" }],\n  };',
    };
    openToolModal('__new__');
  }

  function openToolModal(slug) {
    mcp.editing = slug;
    mcp.testResult = null;
    mcp.testHistory = [];

    // Request live tools for testing if server is running
    if (mcp.status === 'running' && slug !== '__new__') sendWs({ type: 'mcp:tools' });

    renderToolModal();
  }

  function closeToolModal() {
    mcp.editing = null;
    mcp.editTool = null;
    document.getElementById('mcp-modal-root').innerHTML = '';
  }

  function renderToolModal() {
    const tool = mcp.editTool;
    if (!tool) return;

    const root = document.getElementById('mcp-modal-root');
    root.innerHTML = `<div class="mcp-modal-backdrop" id="mcpToolBackdrop">
      <div class="mcp-tool-modal">
        <div class="mcp-tool-modal-header" id="mcpToolHeader"></div>
        <div class="mcp-tool-modal-body" id="mcpToolBody"></div>
      </div>
    </div>`;

    document.getElementById('mcpToolBackdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'mcpToolBackdrop') closeToolModal();
    });
    document.addEventListener('keydown', toolModalKeyHandler);

    renderModalHeader();
    renderModalBody();
  }

  function toolModalKeyHandler(e) {
    if (!mcp.editing) { document.removeEventListener('keydown', toolModalKeyHandler); return; }
    if (e.key === 'Escape') closeToolModal();
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!mcp.editTool?.builtin) saveTool(); }
  }

  function renderModalHeader() {
    const el = document.getElementById('mcpToolHeader');
    if (!el) return;
    const tool = mcp.editTool;
    const isNew = mcp.editing === '__new__' && !tool?.name;
    const isBuiltin = tool?.builtin;
    const title = isNew ? 'New Tool' : isBuiltin ? 'View Tool: ' + escHtml(tool?.name || mcp.editing) : 'Edit Tool: ' + escHtml(tool?.name || mcp.editing);
    el.innerHTML = `
      <h3>${title}${isBuiltin ? ' <span class="ref-tag tag-ro" style="font-size:10px;vertical-align:middle">built-in</span>' : ''}</h3>
      <div class="mcp-tool-modal-actions">
        ${isBuiltin ? '' : '<button class="mcp-action-btn primary" id="mcpToolSave">Save</button>'}
        <button class="mcp-action-btn close-btn" id="mcpToolClose">&times;</button>
      </div>`;
    el.querySelector('#mcpToolSave')?.addEventListener('click', saveTool);
    el.querySelector('#mcpToolClose')?.addEventListener('click', closeToolModal);
  }

  function renderModalBody() {
    const el = document.getElementById('mcpToolBody');
    if (!el) return;
    const tool = mcp.editTool;
    if (!tool) return;
    const ro = tool.builtin;

    const paramRows = (tool.params || []).map((p, i) => `
      <tr class="mcp-param-row" data-idx="${i}">
        <td><input type="text" class="mcp-p-name" value="${escHtml(p.name)}" placeholder="param_name" ${ro ? 'readonly' : ''}></td>
        <td><select class="mcp-p-type" ${ro ? 'disabled' : ''}>
          ${['string','number','boolean','object','array'].map(t => `<option ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></td>
        <td><input type="text" class="mcp-p-desc" value="${escHtml(p.description || '')}" placeholder="Help text for Claude" ${ro ? 'readonly' : ''}></td>
        <td style="text-align:center"><input type="checkbox" class="mcp-p-req" ${p.required ? 'checked' : ''} ${ro ? 'disabled' : ''}></td>
        ${ro ? '<td></td>' : '<td><button class="mcp-p-del" title="Remove">&times;</button></td>'}
      </tr>`).join('');

    const paramNames = (tool.params || []).map(p => p.name).join(', ');

    el.innerHTML = `
      <div class="mcp-tool-form">
        <div class="mcp-form-group">
          <div class="mcp-form-row"><label>Name: <input type="text" id="mcpToolName" value="${escHtml(tool.name)}" placeholder="my-tool" ${ro ? 'readonly' : ''}></label></div>
          <div class="mcp-form-row"><label style="flex:1">Description: <input type="text" id="mcpToolDesc" value="${escHtml(tool.description || '')}" placeholder="What this tool does — shown to Claude" ${ro ? 'readonly' : ''}></label></div>
        </div>

        <div class="mcp-form-group">
          <div class="mcp-form-group-header"><h4>Parameters</h4>${ro ? '' : '<button class="cap-new-btn" id="mcpAddParam" style="font-size:11px">+ Add</button>'}</div>
          ${ro ? '' : '<div class="mcp-form-hint">Define what Claude passes to your tool. Each parameter becomes a Zod schema entry.</div>'}
          <table class="mcp-param-table" id="mcpParamTable">
            <tr><th>Name</th><th>Type</th><th>Description</th><th>Req</th><th></th></tr>
            ${paramRows}
          </table>
        </div>

        <div class="mcp-form-group">
          <h4>Implementation</h4>
          ${ro ? '<div class="mcp-form-hint">Built-in tool — read only.</div>' : '<div class="mcp-form-hint">Write the handler body. It receives the parameters as named arguments and must return MCP content.</div>'}
          <div class="mcp-handler-sig">async (input) => {  <span style="color:var(--text-dim)">// input = { ${paramNames} }</span></div>
          <textarea id="mcpToolHandler" class="cap-modal-code mcp-handler-editor" spellcheck="false" rows="10" ${ro ? 'readonly' : ''}>${escHtml(tool.handlerBody || 'return {\n    content: [{ type: "text", text: "Result" }],\n  };')}</textarea>
          <div class="mcp-handler-sig">}</div>
        </div>

        <div class="mcp-form-group" id="mcpTestSection">
          <h4>Test</h4>
        </div>

        ${ro ? '' : `<div class="mcp-form-group">
          <h4>Extra Files</h4>
          <div class="mcp-form-hint">Add helper modules when your tool logic needs shared utilities, data files, or grows too complex for one file. Import them with relative paths like <code>import { helper } from "../helpers/utils.js";</code> in your handler. Files live in the integrated server directory alongside <code>tools/</code>.</div>
        </div>`}
      </div>`;

    // Events (only for non-builtin tools)
    if (!ro) {
      el.querySelector('#mcpAddParam')?.addEventListener('click', addParamRow);
      el.querySelectorAll('.mcp-p-del').forEach(btn => btn.addEventListener('click', () => {
        btn.closest('tr').remove();
      }));
    }

    renderTestSection();
  }

  function addParamRow() {
    const table = document.getElementById('mcpParamTable');
    if (!table) return;
    const row = document.createElement('tr');
    row.className = 'mcp-param-row';
    row.innerHTML = `
      <td><input type="text" class="mcp-p-name" value="" placeholder="param_name"></td>
      <td><select class="mcp-p-type">
        <option>string</option><option>number</option><option>boolean</option><option>object</option><option>array</option>
      </select></td>
      <td><input type="text" class="mcp-p-desc" value="" placeholder="Help text for Claude"></td>
      <td style="text-align:center"><input type="checkbox" class="mcp-p-req" checked></td>
      <td><button class="mcp-p-del" title="Remove">&times;</button></td>`;
    row.querySelector('.mcp-p-del')?.addEventListener('click', () => row.remove());
    table.appendChild(row);
  }

  // --- Test section ---

  function renderTestSection() {
    const el = document.getElementById('mcpTestSection');
    if (!el) return;

    const tool = mcp.editTool;
    const running = mcp.status === 'running';
    const liveTool = mcp.liveTools.find(t => t.name === tool?.name);

    if (!running) {
      el.innerHTML = '<h4>Test</h4><div class="mcp-form-hint" style="color:var(--yellow)">Start the server and restart after saving to test this tool.</div>';
      return;
    }

    if (!liveTool) {
      el.innerHTML = '<h4>Test</h4><div class="mcp-form-hint" style="color:var(--yellow)">Tool not found in running server. Save and restart to pick up changes.</div>';
      return;
    }

    const schema = liveTool.inputSchema?.properties || {};
    const required = liveTool.inputSchema?.required || [];
    let paramInputs = '';
    for (const [name, prop] of Object.entries(schema)) {
      const type = prop.type || 'string';
      const req = required.includes(name);
      paramInputs += `<div class="mcp-test-param">
        <label>${escHtml(name)}${req ? ' *' : ''}: `;
      if (type === 'boolean') {
        paramInputs += `<input type="checkbox" data-param="${name}" data-type="boolean">`;
      } else if (type === 'number') {
        paramInputs += `<input type="number" data-param="${name}" data-type="number" placeholder="0">`;
      } else {
        paramInputs += `<input type="text" data-param="${name}" data-type="${type}" placeholder="${escHtml(prop.description || '')}">`;
      }
      paramInputs += '</label></div>';
    }

    el.innerHTML = `<h4>Test</h4>
      <div class="mcp-test-inline">
        ${paramInputs}
        <button class="mcp-action-btn primary" id="mcpTestExec">&#9654; Execute</button>
      </div>
      <div id="mcpTestResult"></div>`;

    el.querySelector('#mcpTestExec')?.addEventListener('click', executeTest);
    if (mcp.testResult) renderTestResult();
  }

  function executeTest() {
    const tool = mcp.editTool;
    if (!tool) return;
    const params = {};
    document.querySelectorAll('#mcpTestSection [data-param]').forEach(el => {
      const name = el.dataset.param;
      const type = el.dataset.type;
      if (type === 'boolean') params[name] = el.checked;
      else if (type === 'number') params[name] = parseFloat(el.value) || 0;
      else if (type === 'object' || type === 'array') { try { params[name] = JSON.parse(el.value); } catch { params[name] = el.value; } }
      else params[name] = el.value;
    });
    sendWs({ type: 'mcp:test', tool: tool.name, params });
  }

  function renderTestResult() {
    const el = document.getElementById('mcpTestResult');
    if (!el || !mcp.testResult) return;
    const r = mcp.testResult;
    const ok = !r.error;
    let body = '';
    if (ok && r.result) {
      const content = r.result.content || [];
      body = content.map(c => c.text || JSON.stringify(c)).join('\n');
    } else if (r.error) {
      body = r.error;
    }
    el.innerHTML = `<div class="mcp-test-result">
      <span class="${ok ? 'mcp-res-ok' : 'mcp-res-err'}">${ok ? '✓' : '✕'}</span>
      <span class="mcp-res-ms">${r.latencyMs || 0}ms</span>
      <pre class="mcp-test-output">${escHtml(body)}</pre>
    </div>`;
  }

  // --- Save ---

  function saveTool() {
    const tool = collectToolForm();
    if (!tool) return;
    // Pass oldSlug so backend can handle renames (delete old file)
    const oldSlug = mcp.editing !== '__new__' ? mcp.editing : undefined;
    sendWs({ type: 'mcp:tool:save', tool, oldSlug });
    // Update local state for immediate feedback
    mcp.editTool = tool;
    mcp.editing = tool.slug;
    renderModalHeader();
  }

  function collectToolForm() {
    const name = document.getElementById('mcpToolName')?.value?.trim();
    if (!name) { alert('Tool name is required.'); return null; }

    const description = document.getElementById('mcpToolDesc')?.value?.trim() || '';
    const handlerBody = document.getElementById('mcpToolHandler')?.value || '';

    const params = [];
    document.querySelectorAll('#mcpParamTable .mcp-param-row').forEach(row => {
      const pName = row.querySelector('.mcp-p-name')?.value?.trim();
      if (!pName) return;
      params.push({
        name: pName,
        type: row.querySelector('.mcp-p-type')?.value || 'string',
        description: row.querySelector('.mcp-p-desc')?.value?.trim() || '',
        required: row.querySelector('.mcp-p-req')?.checked !== false,
      });
    });

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

    return {
      slug,
      name,
      description,
      params,
      handlerBody,
      enabled: mcp.editTool?.enabled !== false,
    };
  }

  // ========== EXPOSE MODULE ==========

  window.mcpModule = { handleMessage };
})();
