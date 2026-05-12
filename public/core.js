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
  // Capabilities
  capabilities: null,
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
  serverRestarting: false,
  wasConnected: false,
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
      const clean = typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(code, { ADD_TAGS: ['svg', 'circle', 'rect', 'line', 'polyline', 'polygon', 'path', 'text', 'g', 'defs', 'use', 'symbol', 'clipPath', 'mask', 'pattern', 'image', 'foreignObject', 'ellipse', 'tspan', 'textPath', 'linearGradient', 'radialGradient', 'stop', 'filter', 'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'feBlend', 'feColorMatrix', 'feComposite', 'animate', 'animateTransform', 'marker'], ADD_ATTR: ['viewBox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'd', 'points', 'transform', 'opacity', 'font-size', 'text-anchor', 'dominant-baseline', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'clip-path', 'mask', 'filter', 'gradientUnits', 'offset', 'stop-color', 'stop-opacity', 'preserveAspectRatio', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'stdDeviation', 'dx', 'dy', 'result', 'in', 'in2', 'mode', 'values', 'type', 'begin', 'dur', 'repeatCount', 'attributeName', 'from', 'to'] })
        : escHtml(code);
      return `<div class="rendered-block rendered-${lang}">${clean}</div>`;
    }
    // Default code block rendering with copy button
    return `<div class="code-block-wrap"><button class="code-copy-btn" title="Copy">Copy</button><pre><code class="language-${escHtml(lang)}">${escHtml(code)}</code></pre></div>`;
  };

  marked.setOptions({ renderer, breaks: true, gfm: true });
  targetEl.innerHTML = marked.parse(text);

  // Wire up copy buttons on code blocks
  targetEl.querySelectorAll('.code-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.closest('.code-block-wrap').querySelector('code').textContent;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
  });

  // Wire up code tab groups
  targetEl.querySelectorAll('.code-tabs').forEach(group => {
    const tabs = group.querySelectorAll('.code-tab-btn');
    const panels = group.querySelectorAll('.code-tab-panel');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        group.querySelector(`.code-tab-panel[data-tab="${tab.dataset.tab}"]`)?.classList.add('active');
      });
    });
  });

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


// Centralized settings state sync — called once, modules just re-render
function syncSettings(msg) {
  if (msg.capabilities) {
    state.capabilities = msg.capabilities;
  }
  if (msg.knownTools) state.knownTools = msg.knownTools;
  if (msg.knownSkills) state.knownSkills = msg.knownSkills;
  if (msg.hookEvents) state.hookEvents = msg.hookEvents;
  if (msg.matcherEvents) state.matcherEvents = msg.matcherEvents;
  if (msg.mcpServers) state.mcpServers = msg.mcpServers;
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

// --- Restart server ---
function showRestartingOverlay() {
  if (state.serverRestarting) return;
  state.serverRestarting = true;
  state.restartStartedAt = Date.now();
  document.querySelector('.restart-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'restart-overlay';
  overlay.innerHTML = `<div class="restart-overlay-content"><div class="restart-spinner"></div><div class="restart-overlay-text">Server restarting\u2026</div></div>`;
  document.body.appendChild(overlay);
  setTimeout(pollForRestart, 2000);
}

function pollForRestart() {
  if (!state.serverRestarting) return;
  if (Date.now() - (state.restartStartedAt || 0) > 30000) {
    state.serverRestarting = false;
    const overlay = document.querySelector('.restart-overlay');
    if (overlay) {
      overlay.querySelector('.restart-spinner')?.remove();
      const text = overlay.querySelector('.restart-overlay-text');
      if (text) text.textContent = 'Restart timed out.';
      const btn = document.createElement('button');
      btn.textContent = 'Reload Page';
      btn.className = 'restart-reload-btn';
      btn.onclick = () => location.reload();
      overlay.querySelector('.restart-overlay-content')?.appendChild(btn);
    }
    return;
  }
  fetch('/api/ping').then(function(r) {
    if (!r.ok) return setTimeout(pollForRestart, 1500);
    location.reload();
  }).catch(function() {
    setTimeout(pollForRestart, 1500);
  });
}

async function doRestart() {
  try {
    const resp = await fetch('/api/restart', { method: 'POST' });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      showAlert(data.error || 'Restart failed');
      return;
    }
    showRestartingOverlay();
  } catch (err) {
    showAlert('Failed to contact server: ' + err.message);
  }
}

document.getElementById('restartServerBtn')?.addEventListener('click', doRestart);

// Wire up clickable view links in empty state
document.querySelectorAll('#empty-state .empty-state-link').forEach(el => {
  el.addEventListener('click', () => {
    const view = el.dataset.view;
    if (view) document.querySelector(`.header-tab[data-view="${view}"]`)?.click();
  });
});

// --- Expose API for modules ---
// --- AskUserQuestion: shared form rendering ---

function askFormBuildHTML(formData) {
  const questions = formData.questions || [];
  let html = '';

  // Form chrome
  if (formData.title) {
    html += `<div class="ask-form-title">${escHtml(formData.title)}</div>`;
  }
  if (formData.description) {
    html += `<div class="ask-form-desc markdown-body">${inlineMd(formData.description)}</div>`;
  }

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const qId = q.id || `q${qi}`;
    const qType = q.type || (q.options?.length ? (q.multiSelect ? 'multiselect' : 'select') : 'textarea');
    const isRequired = q.required !== false;

    if (qi > 0) html += '<div class="ask-divider"></div>';

    // Question container (showIf makes it hideable)
    const showIfAttr = q.showIf ? ` data-showif='${escHtml(JSON.stringify(q.showIf))}'` : '';
    const hiddenClass = q.showIf ? ' ask-q-hidden' : '';
    html += `<div class="ask-question${hiddenClass}" data-qid="${escHtml(qId)}" data-qtype="${escHtml(qType)}" data-qi="${qi}" data-required="${isRequired}"${showIfAttr}>`;

    // Header chip
    if (q.header) {
      html += `<div class="ask-header">${escHtml(q.header)}${!isRequired ? '<span class="ask-optional">optional</span>' : ''}</div>`;
    } else if (!isRequired) {
      html += `<div class="ask-header"><span class="ask-optional">optional</span></div>`;
    }

    // Question text
    html += `<div class="ask-text markdown-body">${inlineMd(q.question)}</div>`;

    // Render by type
    html += askFieldHTML(q, qi, qType, qId);

    html += '</div>'; // .ask-question
  }

  // Buttons
  html += '<div class="ask-buttons">';
  if (formData.cancelLabel) {
    html += `<button class="ask-cancel-btn">${escHtml(formData.cancelLabel)}</button>`;
  }
  html += `<button class="ask-submit-btn" disabled>${escHtml(formData.submitLabel || 'Submit')}</button>`;
  html += '</div>';

  return html;
}

function askFieldHTML(q, qi, qType, qId) {
  let html = '';

  switch (qType) {
    case 'select': {
      html += `<div class="ask-options" data-qid="${escHtml(qId)}" data-multi="false">`;
      for (const opt of (q.options || [])) {
        const isDef = q.defaultValue === opt.label;
        html += `<button class="ask-option-btn${isDef ? ' selected' : ''}" data-qid="${escHtml(qId)}" data-label="${escHtml(opt.label)}">`;
        html += `<span class="ask-option-label">${escHtml(opt.label)}</span>`;
        if (opt.description) html += `<span class="ask-option-desc">${inlineMd(opt.description)}</span>`;
        html += '</button>';
      }
      html += '</div>';
      // Preview panel
      html += `<div class="ask-preview" data-qid="${escHtml(qId)}"></div>`;
      // Free-text fallback
      html += `<textarea class="ask-freetext" data-qid="${escHtml(qId)}" rows="1" placeholder="${escHtml(q.placeholder || 'Or type your answer...')}"></textarea>`;
      break;
    }

    case 'multiselect': {
      html += '<div class="ask-hint">Select one or more</div>';
      html += `<div class="ask-options" data-qid="${escHtml(qId)}" data-multi="true">`;
      const defaults = Array.isArray(q.defaultValue) ? q.defaultValue : [];
      for (const opt of (q.options || [])) {
        const isDef = defaults.includes(opt.label);
        html += `<button class="ask-option-btn${isDef ? ' selected' : ''}" data-qid="${escHtml(qId)}" data-label="${escHtml(opt.label)}">`;
        html += '<span class="ask-option-check"></span>';
        html += `<span class="ask-option-label">${escHtml(opt.label)}</span>`;
        if (opt.description) html += `<span class="ask-option-desc">${inlineMd(opt.description)}</span>`;
        html += '</button>';
      }
      html += '</div>';
      html += `<div class="ask-preview" data-qid="${escHtml(qId)}"></div>`;
      html += `<textarea class="ask-freetext" data-qid="${escHtml(qId)}" rows="1" placeholder="${escHtml(q.placeholder || 'Or type your answer...')}"></textarea>`;
      break;
    }

    case 'dropdown': {
      html += `<select class="ask-dropdown" data-qid="${escHtml(qId)}">`;
      html += '<option value="">Select...</option>';
      for (const opt of (q.options || [])) {
        const isDef = q.defaultValue === opt.label;
        html += `<option value="${escHtml(opt.label)}"${isDef ? ' selected' : ''}>${escHtml(opt.label)}${opt.description ? ' — ' + escHtml(opt.description) : ''}</option>`;
      }
      html += '</select>';
      html += `<div class="ask-preview" data-qid="${escHtml(qId)}"></div>`;
      html += `<textarea class="ask-freetext" data-qid="${escHtml(qId)}" rows="1" placeholder="${escHtml(q.placeholder || 'Or type your answer...')}"></textarea>`;
      break;
    }

    case 'text': {
      const val = q.defaultValue != null ? escHtml(String(q.defaultValue)) : '';
      html += `<input type="text" class="ask-text-input" data-qid="${escHtml(qId)}" value="${val}" placeholder="${escHtml(q.placeholder || '')}">`;
      break;
    }

    case 'textarea': {
      const val = q.defaultValue != null ? escHtml(String(q.defaultValue)) : '';
      html += `<textarea class="ask-textarea-input" data-qid="${escHtml(qId)}" rows="3" placeholder="${escHtml(q.placeholder || '')}">${val}</textarea>`;
      break;
    }

    case 'number': {
      const attrs = [];
      if (q.min != null) attrs.push(`min="${q.min}"`);
      if (q.max != null) attrs.push(`max="${q.max}"`);
      if (q.step != null) attrs.push(`step="${q.step}"`);
      const val = q.defaultValue != null ? ` value="${q.defaultValue}"` : '';
      html += `<input type="number" class="ask-number-input" data-qid="${escHtml(qId)}"${val} ${attrs.join(' ')} placeholder="${escHtml(q.placeholder || '')}">`;
      break;
    }

    case 'toggle': {
      const checked = q.defaultValue === true ? ' checked' : '';
      html += `<label class="ask-toggle" data-qid="${escHtml(qId)}">`;
      html += `<input type="checkbox" class="ask-toggle-input" data-qid="${escHtml(qId)}"${checked}>`;
      html += '<span class="ask-toggle-track"><span class="ask-toggle-thumb"></span></span>';
      html += `<span class="ask-toggle-label">${q.defaultValue === true ? 'Yes' : 'No'}</span>`;
      html += '</label>';
      break;
    }

    case 'confirm': {
      const defYes = q.defaultValue === true;
      const defNo = q.defaultValue === false;
      html += `<div class="ask-confirm" data-qid="${escHtml(qId)}">`;
      html += `<button class="ask-confirm-btn ask-confirm-yes${defYes ? ' selected' : ''}" data-qid="${escHtml(qId)}" data-val="true">Yes</button>`;
      html += `<button class="ask-confirm-btn ask-confirm-no${defNo ? ' selected' : ''}" data-qid="${escHtml(qId)}" data-val="false">No</button>`;
      html += '</div>';
      break;
    }

    case 'file': {
      const multi = q.multiple ? ' data-multiple="true"' : '';
      const accept = q.accept ? ` data-accept="${escHtml(q.accept)}"` : '';
      html += `<div class="ask-file-zone" data-qid="${escHtml(qId)}"${multi}${accept}>`;
      html += '<div class="ask-file-icon">&#128206;</div>';
      html += `<div class="ask-file-label">Drop file${q.multiple ? 's' : ''} here or <span class="ask-file-browse">browse</span></div>`;
      if (q.accept) html += `<div class="ask-file-accept">${escHtml(q.accept)}</div>`;
      html += `<input type="file" class="ask-file-input" data-qid="${escHtml(qId)}"${q.accept ? ` accept="${escHtml(q.accept)}"` : ''}${q.multiple ? ' multiple' : ''} style="display:none">`;
      html += '</div>';
      html += `<div class="ask-file-list" data-qid="${escHtml(qId)}"></div>`;
      break;
    }
  }

  return html;
}

function askFormBind(container, formData, callbacks) {
  const questions = formData.questions || [];
  const submitBtn = container.querySelector('.ask-submit-btn');
  const cancelBtn = container.querySelector('.ask-cancel-btn');

  // State: track current answers and file data
  const currentAnswers = {};
  const fileStore = {}; // qId -> [{name, data, size}]
  const visibleSet = new Set();

  // Initialize defaults + visibility
  for (const q of questions) {
    const qId = q.id || `q${questions.indexOf(q)}`;
    const qType = q.type || (q.options?.length ? (q.multiSelect ? 'multiselect' : 'select') : 'textarea');
    if (q.defaultValue != null) {
      currentAnswers[qId] = q.defaultValue;
    }
    if (!q.showIf) visibleSet.add(qId);
  }
  evaluateVisibility();

  // --- Option buttons (select / multiselect) ---
  container.querySelectorAll('.ask-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const qId = btn.dataset.qid;
      const q = questions.find(qq => (qq.id || `q${questions.indexOf(qq)}`) === qId);
      const qType = q?.type || (q?.multiSelect ? 'multiselect' : 'select');
      const optionsContainer = container.querySelector(`.ask-options[data-qid="${qId}"]`);

      if (qType === 'multiselect') {
        btn.classList.toggle('selected');
        const labels = Array.from(optionsContainer.querySelectorAll('.ask-option-btn.selected')).map(b => b.dataset.label);
        currentAnswers[qId] = labels;
      } else {
        optionsContainer.querySelectorAll('.ask-option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        currentAnswers[qId] = btn.dataset.label;
      }

      // Show preview if available
      showPreview(qId, q, btn.dataset.label);
      onChange();
    });
  });

  // --- Dropdowns ---
  container.querySelectorAll('.ask-dropdown').forEach(sel => {
    sel.addEventListener('change', () => {
      const qId = sel.dataset.qid;
      const q = questions.find(qq => (qq.id || `q${questions.indexOf(qq)}`) === qId);
      currentAnswers[qId] = sel.value || undefined;
      showPreview(qId, q, sel.value);
      onChange();
    });
  });

  // --- Free-text (for select/multiselect/dropdown fallback) ---
  container.querySelectorAll('.ask-freetext').forEach(ta => {
    ta.addEventListener('input', () => {
      // Free text doesn't update currentAnswers directly — collected at submit time
      onChange();
    });
  });

  // --- Text inputs ---
  container.querySelectorAll('.ask-text-input').forEach(inp => {
    inp.addEventListener('input', () => {
      currentAnswers[inp.dataset.qid] = inp.value;
      onChange();
    });
  });

  // --- Textarea inputs ---
  container.querySelectorAll('.ask-textarea-input').forEach(ta => {
    ta.addEventListener('input', () => {
      currentAnswers[ta.dataset.qid] = ta.value;
      onChange();
    });
  });

  // --- Number inputs ---
  container.querySelectorAll('.ask-number-input').forEach(inp => {
    inp.addEventListener('input', () => {
      currentAnswers[inp.dataset.qid] = inp.value ? Number(inp.value) : undefined;
      onChange();
    });
  });

  // --- Toggle ---
  container.querySelectorAll('.ask-toggle-input').forEach(inp => {
    inp.addEventListener('change', () => {
      currentAnswers[inp.dataset.qid] = inp.checked;
      const label = inp.closest('.ask-toggle')?.querySelector('.ask-toggle-label');
      if (label) label.textContent = inp.checked ? 'Yes' : 'No';
      onChange();
    });
  });

  // --- Confirm buttons ---
  container.querySelectorAll('.ask-confirm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const qId = btn.dataset.qid;
      const confirmContainer = container.querySelector(`.ask-confirm[data-qid="${qId}"]`);
      confirmContainer.querySelectorAll('.ask-confirm-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      currentAnswers[qId] = btn.dataset.val === 'true';
      onChange();
    });
  });

  // --- File zones ---
  container.querySelectorAll('.ask-file-zone').forEach(zone => {
    const qId = zone.dataset.qid;
    const fileInput = zone.querySelector('.ask-file-input');
    const fileList = container.querySelector(`.ask-file-list[data-qid="${qId}"]`);
    const isMulti = zone.dataset.multiple === 'true';

    zone.querySelector('.ask-file-browse')?.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    zone.addEventListener('click', () => fileInput.click());

    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      handleFiles(qId, e.dataTransfer.files, isMulti, fileList);
    });

    fileInput.addEventListener('change', () => {
      handleFiles(qId, fileInput.files, isMulti, fileList);
      fileInput.value = '';
    });
  });

  function handleFiles(qId, fileListInput, isMulti, fileListEl) {
    if (!fileStore[qId]) fileStore[qId] = [];
    const files = Array.from(fileListInput);

    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        showAlert(`File "${file.name}" exceeds 10MB limit.`);
        continue;
      }

      const reader = new FileReader();
      reader.onload = () => {
        if (!isMulti) fileStore[qId] = [];
        fileStore[qId].push({ name: file.name, data: reader.result, size: file.size });
        currentAnswers[qId] = fileStore[qId].map(f => f.name);
        renderFileList(qId, fileListEl);
        onChange();
      };
      reader.readAsDataURL(file);
    }
  }

  function renderFileList(qId, fileListEl) {
    const items = fileStore[qId] || [];
    fileListEl.innerHTML = items.map((f, i) => {
      const sizeStr = f.size < 1024 ? f.size + ' B' : (f.size / 1024).toFixed(1) + ' KB';
      const isImage = f.data.startsWith('data:image/');
      return `<div class="ask-file-item" data-qid="${escHtml(qId)}" data-fi="${i}">
        ${isImage ? `<img class="ask-file-thumb" src="${f.data}" alt="">` : '<span class="ask-file-item-icon">&#128196;</span>'}
        <span class="ask-file-name">${escHtml(f.name)}</span>
        <span class="ask-file-size">${sizeStr}</span>
        <button class="ask-file-remove" data-qid="${escHtml(qId)}" data-fi="${i}">&times;</button>
      </div>`;
    }).join('');

    fileListEl.querySelectorAll('.ask-file-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.fi);
        fileStore[qId].splice(idx, 1);
        currentAnswers[qId] = fileStore[qId].map(f => f.name);
        renderFileList(qId, fileListEl);
        onChange();
      });
    });
  }

  function showPreview(qId, q, selectedLabel) {
    const previewEl = container.querySelector(`.ask-preview[data-qid="${qId}"]`);
    if (!previewEl) return;
    const opt = (q?.options || []).find(o => o.label === selectedLabel);
    if (opt?.preview) {
      previewEl.innerHTML = `<div class="ask-preview-content markdown-body">${typeof marked !== 'undefined' ? marked.parse(opt.preview) : escHtml(opt.preview)}</div>`;
      previewEl.classList.add('visible');
    } else {
      previewEl.innerHTML = '';
      previewEl.classList.remove('visible');
    }
  }

  function evaluateVisibility() {
    for (const q of questions) {
      const qId = q.id || `q${questions.indexOf(q)}`;
      const qEl = container.querySelector(`.ask-question[data-qid="${qId}"]`);
      if (!qEl) continue;

      if (!q.showIf) {
        visibleSet.add(qId);
        continue;
      }

      const depVal = currentAnswers[q.showIf.questionId];
      let show = false;
      if ('equals' in q.showIf) show = depVal === q.showIf.equals;
      else if ('notEquals' in q.showIf) show = depVal !== q.showIf.notEquals;
      else if ('includes' in q.showIf) show = Array.isArray(depVal) && depVal.includes(q.showIf.includes);
      else show = !!depVal; // truthy check

      if (show) {
        visibleSet.add(qId);
        qEl.classList.remove('ask-q-hidden');
      } else {
        visibleSet.delete(qId);
        qEl.classList.add('ask-q-hidden');
        // Reset hidden field to default
        if (q.defaultValue != null) currentAnswers[qId] = q.defaultValue;
        else delete currentAnswers[qId];
      }
    }
  }

  function checkReady() {
    for (const q of questions) {
      const qId = q.id || `q${questions.indexOf(q)}`;
      if (!visibleSet.has(qId)) continue;
      if (q.required === false) continue;

      const qType = q.type || (q.options?.length ? (q.multiSelect ? 'multiselect' : 'select') : 'textarea');

      // Check free-text override for option types
      if (qType === 'select' || qType === 'multiselect' || qType === 'dropdown') {
        const ft = container.querySelector(`.ask-freetext[data-qid="${qId}"]`);
        if (ft?.value?.trim()) continue;
      }

      const val = currentAnswers[qId];
      if (val === undefined || val === null || val === '') return false;
      if (Array.isArray(val) && val.length === 0) return false;
      if (qType === 'confirm' && typeof val !== 'boolean') return false;
    }
    return true;
  }

  function onChange() {
    evaluateVisibility();
    if (submitBtn) submitBtn.disabled = !checkReady();
  }

  // Submit
  submitBtn?.addEventListener('click', () => {
    const answer = collectAnswers();
    callbacks?.onSubmit?.(answer, getFileData());
    disableForm();
  });

  // Cancel
  cancelBtn?.addEventListener('click', () => {
    callbacks?.onCancel?.();
    disableForm();
  });

  function collectAnswers() {
    const result = [];
    for (const q of questions) {
      const qId = q.id || `q${questions.indexOf(q)}`;
      if (!visibleSet.has(qId)) continue;

      const qType = q.type || (q.options?.length ? (q.multiSelect ? 'multiselect' : 'select') : 'textarea');

      // Free-text override for option types
      if (qType === 'select' || qType === 'multiselect' || qType === 'dropdown') {
        const ft = container.querySelector(`.ask-freetext[data-qid="${qId}"]`);
        if (ft?.value?.trim()) {
          const sel = (qType === 'multiselect')
            ? Array.from(container.querySelectorAll(`.ask-option-btn.selected[data-qid="${qId}"]`)).map(b => b.dataset.label)
            : [];
          result.push({
            id: qId,
            question: q.question,
            answer: sel.length ? `${sel.join(', ')} — ${ft.value.trim()}` : ft.value.trim(),
          });
          continue;
        }
      }

      let val = currentAnswers[qId];
      // For file type, the answer is already an array of names (paths come from server)
      result.push({ id: qId, question: q.question, answer: val });
    }
    return result;
  }

  function getFileData() {
    const files = [];
    for (const qId of Object.keys(fileStore)) {
      for (const f of fileStore[qId]) {
        files.push({ questionId: qId, name: f.name, data: f.data });
      }
    }
    return files.length > 0 ? files : null;
  }

  function disableForm() {
    container.querySelectorAll('.ask-option-btn, .ask-confirm-btn, .ask-submit-btn, .ask-cancel-btn').forEach(b => b.disabled = true);
    container.querySelectorAll('input, textarea, select').forEach(el => el.disabled = true);
    container.querySelectorAll('.ask-file-zone').forEach(z => z.classList.add('disabled'));
    if (submitBtn) submitBtn.textContent = 'Submitted';
    container.classList.add('answered');
  }

  // Initial readiness check
  onChange();

  return { collectAnswers, getFileData, disableForm, checkReady };
}

window.dashboard = {
  showAlert,
  state,
  sendWs(msg) { if (state.ws) state.ws.send(JSON.stringify(msg)); },
  escHtml,
  inlineMd,
  askFormBuildHTML,
  askFormBind,
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
  _pluginHandlers: [],
  registerModule: null,
  _viewCallbacks: {},
  registerView: null,
};
dashboard.registerModule = (prefix, handler) => { dashboard._pluginHandlers.push({ prefix, handler }); };
dashboard.registerView = (viewId, renderFn) => { dashboard._viewCallbacks[viewId] = renderFn; };

// --- WebSocket ---
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    statusEl.textContent = 'connected';
    statusEl.className = 'status connected';
    state.reconnectDelay = 1000;
    state.wasConnected = true;
    if (state.serverRestarting) {
      state.serverRestarting = false;
      document.querySelector('.restart-overlay')?.remove();
    }
  };

  ws.onclose = (evt) => {
    statusEl.textContent = 'disconnected';
    statusEl.className = 'status disconnected';
    if (state.serverRestarting) {
      statusEl.textContent = 'restarting';
      return;
    }
    if (evt.code === 1006 && !state.wasConnected) {
      statusEl.textContent = 'unauthorized';
      window.location.href = '/login';
      return;
    }
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  let bestMatch = null;
  for (const entry of dashboard._pluginHandlers) {
    if (msg.type.startsWith(entry.prefix) && (!bestMatch || entry.prefix.length > bestMatch.prefix.length)) {
      bestMatch = entry;
    }
  }
  if (bestMatch) { bestMatch.handler(msg); return; }
  switch (msg.type) {
    // Inspector
    case 'init':
      document.querySelector('.header-tab[data-view="dashboard"]')?.classList.remove('tab-loading');
    case 'interaction:start':
    case 'interaction:update':
    case 'sse_event':
    case 'interaction:complete':
    case 'interaction:error':
    case 'interaction:enriched':
    case 'cleared':
    case 'inspector:instancesCleared':
    case 'inspector:sessionLoaded':
      window.inspectorModule?.handleMessage(msg);
      break;

    // Ask (routed to CLI tab overlay)
    case 'ask:question':
    case 'ask:answered':
    case 'ask:timeout':
      window.cliModule?.handleAskMessage(msg);
      break;
    case 'chat:settings':
      syncSettings(msg);
      window.capabilitiesModule?.handleSettings(msg);
      break;

    // CLI Terminal
    case 'cli:output':
    case 'cli:exit':
    case 'cli:spawned':
    case 'cli:tabs':
      document.querySelector('.header-tab[data-view="claude"]')?.classList.remove('tab-loading');
      document.querySelector('.header-tab[data-view="directories"]')?.classList.remove('tab-loading');
    case 'cli:newTab':
    case 'cli:settingsData':
    case 'cli:savedSessions':
      if (window.directoriesModule?.handleShellMessage?.(msg)) break;
      window.cliModule?.handleMessage(msg);
      break;

    // Server restart
    case 'server:restarting':
      showRestartingOverlay();
      break;

    // Capabilities
    case 'skill:list':
    case 'agent:list':
    case 'hook:list':
    case 'model:list':
    case 'provider:list':
      window.capabilitiesModule?.handleMessage(msg);
      break;

    // Proxy rules
    case 'rule:list':
    case 'rule:generating':
    case 'rule:generated':
    case 'rule:error':
    case 'rule:source':
    case 'rule:saved':
      window.rulesModule?.handleMessage(msg);
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

// ============================================================
// VIEW SWITCHING (Dashboard / Claude / Capabilities)
// ============================================================

function switchView(view) {
  document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
  const activeBtn = document.querySelector(`.header-tab[data-view="${view}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  document.querySelectorAll('[id^="view-"]').forEach(el => {
    if (el.id === `view-${view}`) {
      el.style.display = '';
      el.classList.remove('hidden');
    } else {
      el.style.display = 'none';
      el.classList.add('hidden');
    }
  });

  if (dashboard._viewCallbacks[view]) {
    dashboard._viewCallbacks[view]();
  }
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
// Show loading indicators on main tabs until data arrives
document.querySelectorAll('.header-tab[data-view]').forEach(tab => {
  const view = tab.dataset.view;
  if (view === 'dashboard' || view === 'claude' || view === 'directories') {
    tab.classList.add('tab-loading');
  }
});
connect();
