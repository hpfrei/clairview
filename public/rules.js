(function rulesModule() {
  'use strict';
  const { state, escHtml, sendWs, showAlert } = window.dashboard;

  state.rules = [];
  let dragSrcId = null;
  let expandedId = null;

  let monacoReady = false;
  let monacoReadyPromise = null;
  let currentEditor = null;
  let currentEditorRuleId = null;
  let isEditorDirty = false;

  function getMonacoTheme() {
    const t = localStorage.getItem('theme') || 'bright';
    return t === 'dark' ? 'vs-dark' : 'vs';
  }

  function ensureMonaco() {
    if (monacoReady) return Promise.resolve();
    if (monacoReadyPromise) return monacoReadyPromise;

    monacoReadyPromise = new Promise((resolve) => {
      if (typeof window.require === 'undefined' || !window.require.config) {
        console.warn('Monaco loader not available');
        resolve();
        return;
      }
      window.require.config({
        paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' }
      });
      window.require(['vs/editor/editor.main'], function () {
        monacoReady = true;
        resolve();
      });
    });
    return monacoReadyPromise;
  }

  function updateEditorHeight() {
    if (!currentEditor) return;
    const container = currentEditor.getDomNode()?.parentElement;
    if (!container) return;
    const lineCount = currentEditor.getModel().getLineCount();
    const lineHeight = currentEditor.getOption(monaco.editor.EditorOption.lineHeight);
    const height = Math.min(500, Math.max(120, lineCount * lineHeight + 20));
    container.style.height = height + 'px';
    currentEditor.layout();
  }

  function createEditor(container, source, ruleId) {
    disposeEditor();
    currentEditorRuleId = ruleId;
    isEditorDirty = false;

    currentEditor = monaco.editor.create(container, {
      value: source,
      language: 'javascript',
      theme: getMonacoTheme(),
      readOnly: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      fontSize: 12,
      fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      automaticLayout: true,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      overviewRulerLanes: 0,
      renderLineHighlight: 'none',
      folding: true,
      wordWrap: 'on',
    });

    currentEditor.onDidChangeModelContent(() => {
      isEditorDirty = true;
      const saveBtn = document.querySelector(`.rule-save-btn[data-id="${ruleId}"]`);
      if (saveBtn) saveBtn.disabled = false;
    });

    updateEditorHeight();
    currentEditor.onDidChangeModelContent(updateEditorHeight);
  }

  function disposeEditor() {
    if (currentEditor) {
      currentEditor.dispose();
      currentEditor = null;
      currentEditorRuleId = null;
      isEditorDirty = false;
    }
  }

  function renderRuleList() {
    const list = document.getElementById('ruleList');
    if (!list) return;
    list.innerHTML = '';

    if (state.rules.length === 0) {
      list.innerHTML = '<div class="rule-empty">No proxy rules defined. Click "+ New Rule" to create one.</div>';
      return;
    }

    for (const rule of state.rules) {
      const isExpanded = expandedId === rule.id;
      const item = document.createElement('div');
      item.className = 'rule-item' + (rule.enabled ? '' : ' disabled') + (isExpanded ? ' expanded' : '');
      item.dataset.id = rule.id;
      item.draggable = true;
      item.innerHTML = `
        <div class="rule-item-header">
          <span class="rule-drag-handle" title="Drag to reorder">&#9776;</span>
          <label class="rule-toggle">
            <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-id="${escHtml(rule.id)}">
            <span class="rule-toggle-slider"></span>
          </label>
          <div class="rule-item-info">
            <div class="rule-item-name">${escHtml(rule.name)}</div>
          </div>
          <button class="rule-del-btn" data-id="${escHtml(rule.id)}" title="Delete rule">&#10005;</button>
        </div>
        <div class="rule-item-detail" style="display:${isExpanded ? 'block' : 'none'}">
          <div class="rule-item-slug">${escHtml(rule.slug)}</div>
          <div class="rule-source-section">
            <div class="rule-source-toolbar">
              <span class="rule-source-label">Source</span>
              <button class="rule-save-btn" data-id="${escHtml(rule.id)}" disabled>Save</button>
            </div>
            <div class="rule-editor-container" data-id="${escHtml(rule.id)}">
              <div class="rule-editor-loading">Loading editor&hellip;</div>
            </div>
          </div>
          <div class="rule-edit-row">
            <textarea class="rule-edit-input" data-id="${escHtml(rule.id)}" rows="3" placeholder="Describe a change to this rule&hellip;"></textarea>
            <button class="rule-edit-submit" data-id="${escHtml(rule.id)}">Apply with AI</button>
          </div>
        </div>`;
      list.appendChild(item);
    }

    if (expandedId) {
      ensureMonaco().then(() => {
        if (expandedId && monacoReady) {
          sendWs({ type: 'rule:source', id: expandedId });
        }
      });
    }
  }

  // Create rule
  document.getElementById('ruleNewBtn')?.addEventListener('click', () => {
    const desc = prompt('Describe what this rule should do:');
    if (!desc?.trim()) return;
    sendWs({ type: 'rule:create', description: desc.trim() });
  });

  // Event delegation
  document.getElementById('ruleList')?.addEventListener('click', (e) => {
    // Toggle switch
    const toggle = e.target.closest('.rule-toggle input');
    if (toggle) {
      e.stopPropagation();
      sendWs({ type: 'rule:toggle', id: toggle.dataset.id, enabled: toggle.checked });
      return;
    }
    if (e.target.closest('.rule-toggle')) return;

    // Delete
    const delBtn = e.target.closest('.rule-del-btn');
    if (delBtn) {
      e.stopPropagation();
      if (confirm('Delete this rule? The server will restart.')) {
        sendWs({ type: 'rule:delete', id: delBtn.dataset.id });
      }
      return;
    }

    // Manual save
    const saveBtn = e.target.closest('.rule-save-btn');
    if (saveBtn) {
      e.stopPropagation();
      if (!currentEditor || !isEditorDirty) return;
      sendWs({ type: 'rule:save', id: saveBtn.dataset.id, source: currentEditor.getValue() });
      saveBtn.disabled = true;
      return;
    }

    // AI edit submit
    const submitBtn = e.target.closest('.rule-edit-submit');
    if (submitBtn) {
      e.stopPropagation();
      const input = submitBtn.parentElement.querySelector('.rule-edit-input');
      const desc = input?.value?.trim();
      if (!desc) return;
      sendWs({ type: 'rule:edit', id: submitBtn.dataset.id, description: desc });
      input.value = '';
      return;
    }

    if (e.target.closest('.rule-item-detail')) return;
    if (e.target.closest('.rule-drag-handle')) return;

    // Click on header row -> expand/collapse
    const item = e.target.closest('.rule-item');
    if (item) {
      const newId = expandedId === item.dataset.id ? null : item.dataset.id;
      if (expandedId !== newId) disposeEditor();
      expandedId = newId;
      renderRuleList();
    }
  });

  // Ctrl+Enter in edit input
  document.getElementById('ruleList')?.addEventListener('keydown', (e) => {
    if (!(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
    const input = e.target.closest('.rule-edit-input');
    if (!input) return;
    const desc = input.value.trim();
    if (!desc) return;
    sendWs({ type: 'rule:edit', id: input.dataset.id, description: desc });
    input.value = '';
  });

  // Drag-and-drop reordering
  document.getElementById('ruleList')?.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.rule-item');
    if (!item) return;
    dragSrcId = item.dataset.id;
    item.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
  });

  document.getElementById('ruleList')?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.rule-item');
    if (item) item.style.borderTop = '2px solid var(--accent, #2255aa)';
  });

  document.getElementById('ruleList')?.addEventListener('dragleave', (e) => {
    const item = e.target.closest('.rule-item');
    if (item) item.style.borderTop = '';
  });

  document.getElementById('ruleList')?.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.rule-item');
    if (!target || !dragSrcId) return;
    target.style.borderTop = '';

    const targetId = target.dataset.id;
    if (dragSrcId === targetId) return;

    const ids = state.rules.map(r => r.id);
    const fromIdx = ids.indexOf(dragSrcId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;

    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragSrcId);
    sendWs({ type: 'rule:reorder', ids });
  });

  document.getElementById('ruleList')?.addEventListener('dragend', (e) => {
    dragSrcId = null;
    document.querySelectorAll('.rule-item').forEach(el => {
      el.style.opacity = '';
      el.style.borderTop = '';
    });
  });

  function handleMessage(msg) {
    switch (msg.type) {
      case 'rule:list':
        state.rules = msg.rules || [];
        disposeEditor();
        renderRuleList();
        document.getElementById('ruleGeneratingStatus')?.classList.add('hidden');
        break;
      case 'rule:generating':
        document.getElementById('ruleGeneratingStatus')?.classList.remove('hidden');
        break;
      case 'rule:generated':
        document.getElementById('ruleGeneratingStatus')?.classList.add('hidden');
        break;
      case 'rule:error':
        document.getElementById('ruleGeneratingStatus')?.classList.add('hidden');
        showAlert(msg.error);
        break;
      case 'rule:source': {
        if (msg.id !== expandedId) break;
        const container = document.querySelector(`.rule-editor-container[data-id="${msg.id}"]`);
        if (!container || !monacoReady) break;
        container.innerHTML = '';
        createEditor(container, msg.source, msg.id);
        break;
      }
      case 'rule:saved':
        isEditorDirty = false;
        showAlert('Rule saved');
        break;
    }
  }

  window.rulesModule = { handleMessage };
})();
