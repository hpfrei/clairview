// --- Theme toggle ---
(function initTheme() {
  const btn = document.getElementById('themeToggle');
  const link = document.getElementById('themeLink');
  let theme = localStorage.getItem('theme') || 'bright';
  btn.textContent = theme;

  btn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'bright' : 'dark';
    link.href = `theme-${theme}.css`;
    localStorage.setItem('theme', theme);
    btn.textContent = theme;
  });
})();

// --- State ---
const state = {
  interactions: [],
  selection: null,
  ws: null,
  reconnectDelay: 1000,
  activeSessionId: null,
  // Chat
  chatCurrentEl: null,
  // Capabilities
  capabilities: null,
  profiles: [],
  activeProfileName: null,
  knownTools: [],
  knownSkills: [],
  agents: [],
  hooks: [],
  hookEvents: [],
  matcherEvents: [],
  skills: [],
  editingSkill: null,
  editingAgent: null,
  editingHook: null,
  models: [],
  providers: [],
  editingModel: null,
  mcpServers: [],
  outputsDir: '',
  // Tasks
  tasks: {},
  todos: [],
  pendingTaskTools: {},
  taskPanelCollapsed: false,
};

// --- Utilities ---
function escHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Markdown rendering (with HTML/SVG pass-through and MathJax) ---
function renderMarkdown(text, targetEl) {
  if (!text) { targetEl.innerHTML = ''; return; }
  text = text.replace(/\n{2,}/g, '\n');
  if (typeof marked === 'undefined') { targetEl.textContent = text; return; }

  // Configure marked to pass through HTML/SVG blocks and render fenced code
  const renderer = new marked.Renderer();
  const origCode = renderer.code?.bind(renderer);
  renderer.code = function(args) {
    const code = typeof args === 'object' ? args.text : args;
    const lang = (typeof args === 'object' ? args.lang : arguments[1]) || '';
    // Render html and svg fenced blocks as live content
    if (lang === 'html' || lang === 'svg') {
      return `<div class="rendered-block rendered-${lang}">${code}</div>`;
    }
    // Default code block rendering
    return `<pre><code class="language-${escHtml(lang)}">${escHtml(code)}</code></pre>`;
  };

  marked.setOptions({ renderer, breaks: true, gfm: true });
  targetEl.innerHTML = marked.parse(text);

  // Typeset math if MathJax is available
  if (window.MathJax?.typesetPromise) {
    window.MathJax.typesetPromise([targetEl]).catch(() => {});
  }
}

// Debounced markdown render for streaming (renders at most every 200ms)
const _renderTimers = new WeakMap();
function renderMarkdownDebounced(text, targetEl) {
  // Store raw text on element for final render
  targetEl._rawText = text;
  if (_renderTimers.has(targetEl)) return;
  _renderTimers.set(targetEl, setTimeout(() => {
    _renderTimers.delete(targetEl);
    renderMarkdown(targetEl._rawText, targetEl);
  }, 200));
}

function cancelRenderDebounce(targetEl) {
  const timerId = _renderTimers.get(targetEl);
  if (timerId !== undefined) {
    clearTimeout(timerId);
    _renderTimers.delete(targetEl);
  }
}

function inlineMd(text) {
  return typeof marked !== 'undefined' ? marked.parseInline(text || '') : escHtml(text || '');
}

function highlightJSON(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (!json) return '';
  return escHtml(json)
    .replace(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g, '<span class="json-key">"$1"</span>:')
    .replace(/:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g, ': <span class="json-string">"$1"</span>')
    .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, ': <span class="json-number">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
}

// --- Collapsible JSON tree renderer ---

function preview(val, budget) {
  if (budget <= 0) return '…';
  if (val === null) return '<span class="json-null">null</span>';
  if (typeof val === 'boolean') return `<span class="json-bool">${val}</span>`;
  if (typeof val === 'number') return `<span class="json-number">${val}</span>`;
  if (typeof val === 'string') {
    const max = Math.min(budget, 30);
    const t = val.length > max ? val.slice(0, max) + '…' : val;
    return `<span class="json-string">"${escHtml(t)}"</span>`;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return '<span class="jt-bracket">[]</span>';
    const inner = preview(val[0], budget - 12);
    const more = val.length > 1 ? '<span class="jt-comma">, </span>…' : '';
    return `${inner}${more} <span class="jt-count">// ${val.length}</span>`;
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '<span class="jt-bracket">{}</span>';
    const parts = [];
    let len = 0;
    for (const k of keys) {
      if (len + k.length + 2 > budget && parts.length > 0) { parts.push('…'); break; }
      parts.push(escHtml(k));
      len += k.length + 2;
    }
    return parts.join('<span class="jt-comma">, </span>');
  }
  return escHtml(String(val));
}

function renderJSON(obj) {
  if (obj === undefined) return '';
  if (obj === null) return '<span class="json-null">null</span>';
  return renderValue(obj, null);
}

function renderValue(val, key) {
  const keyHtml = key !== null
    ? `<span class="json-key">"${escHtml(key)}"</span>: ` : '';
  if (val === null) return keyHtml + '<span class="json-null">null</span>';
  if (typeof val === 'string') {
    const escaped = escHtml(val).replace(/\n/g, '<br>');
    return keyHtml + `<span class="json-string">"${escaped}"</span>`;
  }
  if (typeof val === 'number') return keyHtml + `<span class="json-number">${val}</span>`;
  if (typeof val === 'boolean') return keyHtml + `<span class="json-bool">${val}</span>`;
  if (Array.isArray(val)) {
    if (val.length === 0) return keyHtml + '<span class="jt-bracket">[]</span>';
    const children = val.map((v, i) =>
      `<div class="jt-line">${renderValue(v, null)}${i < val.length - 1 ? '<span class="jt-comma">,</span>' : ''}</div>`
    ).join('');
    const pv = preview(val[0], 60);
    const more = val.length > 1 ? '<span class="jt-comma">, </span>…' : '';
    const count = ` <span class="jt-count">// ${val.length}</span>`;
    const summary = `${pv}${more} <span class="jt-bracket">]</span>${count}`;
    const openAttr = JSON.stringify(val, null, 2).split('\n').length <= 6 ? ' open' : '';
    return `${keyHtml}<details class="jt-node"${openAttr}><summary><span class="jt-bracket">[</span><span class="jt-summary">${summary}</span><span class="jt-expand-btn"></span></summary><div class="jt-children">${children}</div><span class="jt-bracket jt-close">]</span></details>`;
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return keyHtml + '<span class="jt-bracket">{}</span>';
    const children = keys.map((k, i) =>
      `<div class="jt-line">${renderValue(val[k], k)}${i < keys.length - 1 ? '<span class="jt-comma">,</span>' : ''}</div>`
    ).join('');
    const pv = preview(val, 60);
    const summary = `${pv} <span class="jt-bracket">}</span>`;
    const openAttr = JSON.stringify(val, null, 2).split('\n').length <= 6 ? ' open' : '';
    return `${keyHtml}<details class="jt-node"${openAttr}><summary><span class="jt-bracket">{</span><span class="jt-summary">${summary}</span><span class="jt-expand-btn"></span></summary><div class="jt-children">${children}</div><span class="jt-bracket jt-close">}</span></details>`;
  }
  return keyHtml + escHtml(String(val));
}

function jsonBlock(obj) {
  const raw = JSON.stringify(obj, null, 2);
  return `<div class="json-block jt-root"><button class="jt-copy" title="Copy JSON">Copy</button><script type="application/json">${escHtml(raw)}<\/script>${renderJSON(obj)}</div>`;
}

// Copy button handler (delegated)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.jt-copy');
  if (!btn) return;
  const script = btn.parentElement.querySelector('script[type="application/json"]');
  if (!script) return;
  navigator.clipboard.writeText(script.textContent).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 1200);
  });
});

// Expand/collapse all handler (delegated)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.jt-expand-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const node = btn.closest('.jt-node');
  if (!node) return;
  const descendants = node.querySelectorAll('details.jt-node');
  const allOpen = node.open && [...descendants].every(d => d.open);
  const target = !allOpen;
  node.open = target;
  descendants.forEach(d => d.open = target);
});

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '--';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

// --- DOM refs ---
const timelineList = document.getElementById('timeline-list');
const detailContent = document.getElementById('detail-content');
const emptyState = document.getElementById('empty-state');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('footerStats');
const sessionPickerBtn = document.getElementById('sessionPickerBtn');
const newSessionBtn = document.getElementById('newSessionBtn');
let cachedSessions = [];


// Centralized settings state sync — called once, modules just re-render
function syncSettings(msg) {
  if (msg.capabilities) {
    state.capabilities = msg.capabilities;
    state.activeProfileName = msg.capabilities.name;
  }
  if (msg.profiles) state.profiles = msg.profiles;
  if (msg.knownTools) state.knownTools = msg.knownTools;
  if (msg.knownSkills) state.knownSkills = msg.knownSkills;
  if (msg.hookEvents) state.hookEvents = msg.hookEvents;
  if (msg.matcherEvents) state.matcherEvents = msg.matcherEvents;
  if (msg.mcpServers) state.mcpServers = msg.mcpServers;
  if (msg.outputsDir) state.outputsDir = msg.outputsDir;
}

// Reusable CWD edit-in-place toolbar setup
function setupCwdToolbar({ editBtn, label, input, setBtn, onSave }) {
  editBtn?.addEventListener('click', () => {
    const editing = !input.classList.contains('hidden');
    if (editing) {
      input.classList.add('hidden');
      setBtn.classList.add('hidden');
      label.classList.remove('hidden');
    } else {
      input.value = label.textContent || '';
      label.classList.add('hidden');
      input.classList.remove('hidden');
      setBtn.classList.remove('hidden');
      input.focus();
    }
  });
  setBtn?.addEventListener('click', () => {
    const val = input?.value?.trim();
    if (!val) return;
    onSave(val);
    input.classList.add('hidden');
    setBtn.classList.add('hidden');
    label.classList.remove('hidden');
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); setBtn?.click(); }
    else if (e.key === 'Escape') {
      input.classList.add('hidden');
      setBtn.classList.add('hidden');
      label.classList.remove('hidden');
    }
  });
}

// --- Alert modal (replaces native alert()) ---
function showAlert(message) {
  const backdrop = document.createElement('div');
  backdrop.className = 'alert-modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'alert-modal';
  modal.innerHTML = `<div class="alert-modal-message">${escHtml(message)}</div><button class="alert-modal-ok">OK</button>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  const okBtn = modal.querySelector('.alert-modal-ok');
  okBtn.focus();
  okBtn.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') backdrop.remove(); });
}

// --- Expose API for modules ---
window.dashboard = {
  showAlert,
  state,
  sendWs(msg) { if (state.ws) state.ws.send(JSON.stringify(msg)); },
  escHtml,
  inlineMd,
  syncSettings,
  setupCwdToolbar,
  highlightJSON,
  renderJSON,
  jsonBlock,
  formatDuration,
  truncate,
  renderMarkdown,
  renderMarkdownDebounced,
  cancelRenderDebounce,
  timelineList,
  detailContent,
  emptyState,
  statsEl,
};

// --- WebSocket ---
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    statusEl.textContent = 'connected';
    statusEl.className = 'status connected';
    state.reconnectDelay = 1000;
  };

  ws.onclose = (evt) => {
    if (evt.code === 1006 && state.reconnectDelay === 1000) {
      statusEl.textContent = 'unauthorized';
      statusEl.className = 'status disconnected';
      window.location.href = '/login';
      return;
    }
    statusEl.textContent = 'disconnected';
    statusEl.className = 'status disconnected';
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    // Inspector
    case 'init':
    case 'interaction:start':
    case 'interaction:update':
    case 'sse_event':
    case 'interaction:complete':
    case 'interaction:error':
    case 'cleared':
      window.inspectorModule?.handleMessage(msg);
      if (msg.type === 'sse_event') window.taskModule?.interceptSSE(msg.event);
      break;

    // Session
    case 'session:list':
      updateSessionPicker(msg.sessions, msg.activeId);
      window.inspectorModule?.handleMessage(msg);
      break;
    case 'session:switched':
      window.inspectorModule?.handleMessage(msg);
      window.taskModule?.handleMessage(msg);
      window.chatModule?.handleMessage(msg);
      break;

    // Chat + Ask
    case 'chat:event':
    case 'chat:output':
    case 'chat:error':
    case 'chat:status':
    case 'chat:tabs':
    case 'ask:question':
    case 'ask:answered':
    case 'ask:timeout':
      if (msg.tabId && msg.tabId.startsWith('wfrun-')) {
        window.workflowRunModule?.handleMessage(msg);
      } else {
        window.chatModule?.handleMessage(msg);
      }
      break;
    case 'chat:settings':
      syncSettings(msg);
      window.chatModule?.handleMessage(msg);
      window.capabilitiesModule?.handleSettings(msg);
      window.workflowRunModule?.handleSettings?.(msg);
      break;

    // Capabilities
    case 'skill:list':
    case 'agent:list':
    case 'hook:list':
    case 'model:list':
    case 'provider:list':
      window.capabilitiesModule?.handleMessage(msg);
      break;
    case 'profile:list':
      window.capabilitiesModule?.handleMessage(msg);
      window.chatModule?.updateProfiles(msg.profiles);
      break;

    // Workflows (editor)
    case 'workflow:list':
      window.workflowModule?.handleMessage(msg);
      window.workflowRunModule?.handleMessage(msg);
      break;
    case 'workflow:loaded':
      // Route to runs module if it requested the load
      if (window.workflowRunModule?.pendingLoad === msg.name) {
        window.workflowRunModule.handleMessage(msg);
      } else {
        window.workflowModule?.handleMessage(msg);
      }
      break;
    case 'workflow:generated':
    case 'workflow:compile:progress':
    case 'workflow:compiled':
      window.workflowModule?.handleMessage(msg);
      break;
    case 'workflow:error':
      if (msg.tabId && msg.tabId.startsWith('wfrun-')) {
        window.workflowRunModule?.handleMessage(msg);
      } else if (msg.tabId) {
        window.chatModule?.handleMessage(msg);
      } else {
        window.workflowModule?.handleMessage(msg);
      }
      break;

    // Workflow run events — route to Runs tab or Chat tab based on tabId
    case 'workflow:run:started':
    case 'workflow:step:start':
    case 'workflow:step:progress':
    case 'workflow:step:complete':
    case 'workflow:run:complete':
      if (msg.tabId && msg.tabId.startsWith('wfrun-')) {
        window.workflowRunModule?.handleMessage(msg);
      } else {
        window.chatModule?.handleMessage(msg);
      }
      break;

    // Claude process count
    case 'claude:count':
      break;

    // Claude instance lifecycle
    case 'claude:instances':
      window.inspectorModule?.handleMessage(msg);
      break;

    // MCP
    default:
      if (msg.type === 'mcp:list') state.mcpServers = msg.servers || [];
      if (window.mcpModule?.handleMessage) window.mcpModule.handleMessage(msg);
      break;
  }
}

// --- Session management ---
newSessionBtn?.addEventListener('click', () => {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'session:new' }));
  }
});

function updateSessionLabel() {
  if (!sessionPickerBtn) return;
  const active = cachedSessions.find(s => s.id === state.activeSessionId);
  sessionPickerBtn.textContent = active
    ? `Session ${active.id} (${active.interactionCount})`
    : `Session ${state.activeSessionId || '?'}`;
}

function updateSessionPicker(sessions, activeId) {
  state.activeSessionId = activeId;
  cachedSessions = sessions || [];
  updateSessionLabel();
}

sessionPickerBtn?.addEventListener('click', () => {
  if (!cachedSessions.length) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'session-modal-backdrop';
  let html = '<div class="session-modal">';
  html += '<div class="session-modal-header"><h3>Sessions</h3>';
  html += '<div class="session-modal-actions">';
  html += '<button class="session-modal-delete-all">Delete All Inactive</button>';
  html += '<button class="session-modal-close">\u00d7</button>';
  html += '</div></div>';
  html += '<div class="session-modal-body">';
  for (const s of cachedSessions) {
    const isActive = s.id === state.activeSessionId;
    html += `<div class="session-modal-item${isActive ? ' active' : ''}" data-id="${s.id}">`;
    html += `<span class="session-modal-label">Session ${s.id}</span>`;
    html += `<span class="session-modal-calls">${s.interactionCount} call${s.interactionCount !== 1 ? 's' : ''}</span>`;
    if (isActive) {
      html += '<span class="session-modal-badge">current</span>';
    } else {
      html += `<button class="session-modal-del" data-id="${s.id}" title="Delete">\u2715</button>`;
    }
    html += '</div>';
  }
  html += '</div></div>';
  backdrop.innerHTML = html;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  backdrop.querySelector('.session-modal-close').addEventListener('click', close);

  // Click a session row to load it
  backdrop.querySelectorAll('.session-modal-item:not(.active)').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.session-modal-del')) return;
      const id = parseInt(row.dataset.id, 10);
      if (id && state.ws?.readyState === WebSocket.OPEN) {
        sendWs({ type: 'session:switch', id });
      }
      close();
    });
  });

  // Delete individual session
  backdrop.querySelectorAll('.session-modal-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      if (id && state.ws?.readyState === WebSocket.OPEN) {
        sendWs({ type: 'session:delete', id });
      }
      btn.closest('.session-modal-item').remove();
    });
  });

  // Delete all inactive
  backdrop.querySelector('.session-modal-delete-all')?.addEventListener('click', () => {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    for (const s of cachedSessions) {
      if (s.id !== state.activeSessionId) {
        sendWs({ type: 'session:delete', id: s.id });
      }
    }
    backdrop.querySelectorAll('.session-modal-item:not(.active)').forEach(el => el.remove());
  });

  backdrop.focus();
});

// ============================================================
// VIEW SWITCHING (Dashboard / Claude / Capabilities)
// ============================================================

function switchView(view) {
  document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
  const activeBtn = document.querySelector(`.header-tab[data-view="${view}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  const views = ['view-home', 'view-dashboard', 'view-claude', 'view-profiles', 'view-capabilities', 'view-workflow-runs', 'view-models'];
  for (const id of views) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (id === `view-${view}`) {
      el.style.display = '';
      el.classList.remove('hidden');
    } else {
      el.style.display = 'none';
      el.classList.add('hidden');
    }
  }

  // Show session picker only in Inspector and Chat views
  const showSession = (view === 'dashboard' || view === 'claude');
  if (sessionPickerBtn) sessionPickerBtn.style.display = showSession ? '' : 'none';
  if (newSessionBtn) newSessionBtn.style.display = showSession ? '' : 'none';
}

document.getElementById('headerTabs').addEventListener('click', e => {
  const tab = e.target.closest('.header-tab');
  if (!tab) return;
  switchView(tab.dataset.view);
});

// Brand click switches to home
document.getElementById('brandBtn')?.addEventListener('click', () => switchView('home'));

// ============================================================
// REFERENCE PANEL LOGIC
// ============================================================

// Global — called from inline onclick in HTML
function toggleRef(header) {
  header.closest('.ref-card').classList.toggle('open');
}

document.getElementById('refNav').addEventListener('click', e => {
  const btn = e.target.closest('.view-tab');
  if (!btn) return;
  const section = btn.dataset.section;

  document.getElementById('refNav').querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  document.querySelectorAll('.ref-panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('ref-' + section);
  if (target) target.classList.add('active');
});

document.getElementById('refFilter').addEventListener('click', e => {
  const btn = e.target.closest('.ref-filter-btn');
  if (!btn) return;
  const cat = btn.dataset.cat;

  document.querySelectorAll('.ref-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  document.querySelectorAll('#ref-tools .ref-category').forEach(section => {
    section.style.display = (cat === 'all' || section.dataset.cat === cat) ? '' : 'none';
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'e' && e.altKey) {
    const activePanel = document.querySelector('.ref-panel.active');
    if (!activePanel) return;
    const cards = activePanel.querySelectorAll('.ref-card');
    const allOpen = [...cards].every(c => c.classList.contains('open'));
    cards.forEach(c => c.classList.toggle('open', !allOpen));
  }
});

// ============================================================
// TIMELINE RESIZER
// ============================================================
(function initResizer() {
  const resizer = document.getElementById('timeline-resizer');
  const timeline = document.getElementById('timeline');
  if (!resizer || !timeline) return;

  let startX, startW;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = timeline.offsetWidth;
    resizer.classList.add('dragging');
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onUp);
  });

  function onDrag(e) {
    const w = startW + (e.clientX - startX);
    timeline.style.width = Math.max(140, w) + 'px';
  }

  function onUp() {
    resizer.classList.remove('dragging');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onUp);
  }
})();

// --- Init ---
connect();
