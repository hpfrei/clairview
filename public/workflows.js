// ============================================================
// WORKFLOW MODULE — List, edit, generate, compile
// ============================================================
(function workflowModule() {
  'use strict';
  const { state, sendWs, escHtml } = window.dashboard;

  // --- Internal state ---
  const wf = {
    workflows: [],
    generating: false,
    compiling: false,
    lastGenerated: null,
    // Modal tab state
    activeTab: 'source',   // 'source' | 'compiled'
    sourceContent: '',
    compiledContent: null,
    jsonDirty: false,
    jsDirty: false,
  };

  // --- DOM refs ---
  const wfList = document.getElementById('wfList');
  const wfErrorBar = document.getElementById('wfErrorBar');

  // Edit modal
  const wfModal = document.getElementById('wfModal');
  const wfModalTitle = document.getElementById('wfModalTitle');
  const wfName = document.getElementById('wfName');
  const wfDesc = document.getElementById('wfDesc');
  const wfTextarea = document.getElementById('wfTextarea');
  const wfRedoBar = document.getElementById('wfRedoBar');
  const wfRedoInput = document.getElementById('wfRedoInput');
  const wfRedoBtn = document.getElementById('wfRedoBtn');
  const wfSaveJson = document.getElementById('wfSaveJson');
  const wfSaveJs = document.getElementById('wfSaveJs');
  const wfGenerateBtn = document.getElementById('wfGenerateBtn');
  const wfRegenBtn = document.getElementById('wfRegenBtn');
  const wfCompileBtn = document.getElementById('wfCompileBtn');
  const wfTabSource = document.getElementById('wfTabSource');
  const wfTabCompiled = document.getElementById('wfTabCompiled');
  const wfLog = document.getElementById('wfLog');
  const wfModalCancel = document.getElementById('wfModalCancel');
  const wfModalClose = document.getElementById('wfModalClose');

  // --- Error display (page-level) ---
  function showWfError(message) {
    if (!wfErrorBar) return;
    wfErrorBar.textContent = message;
    wfErrorBar.classList.remove('hidden');
  }
  function clearWfError() {
    if (wfErrorBar) wfErrorBar.classList.add('hidden');
  }

  // --- Log area (in-modal) ---
  function appendLog(text, cls) {
    if (!wfLog) return;
    wfLog.classList.remove('hidden', 'log-error', 'log-success');
    if (cls) wfLog.classList.add(cls);
    wfLog.textContent += text;
    wfLog.scrollTop = wfLog.scrollHeight;
  }
  function setLog(text, cls) {
    if (!wfLog) return;
    wfLog.classList.remove('hidden', 'log-error', 'log-success');
    if (cls) wfLog.classList.add(cls);
    wfLog.textContent = text;
    wfLog.scrollTop = wfLog.scrollHeight;
  }
  function clearLog() {
    if (!wfLog) return;
    wfLog.textContent = '';
    wfLog.classList.add('hidden');
    wfLog.classList.remove('log-error', 'log-success');
  }

  // --- Rendering ---

  function renderList() {
    if (!wfList) return;
    if (wf.workflows.length === 0) {
      wfList.innerHTML = '<div class="cap-list-empty">No workflows yet. Click + New to create one.</div>';
      return;
    }
    wfList.innerHTML = wf.workflows.map(w => {
      const statusClass = w.status === 'compiled' ? 'tag-sk' : w.status === 'needs-compile' ? 'tag-wr' : 'tag-ro';
      const statusLabel = w.status === 'compiled' ? 'compiled' : w.status === 'needs-compile' ? 'needs compile' : 'draft';
      return `<div class="cap-list-item" data-name="${escHtml(w.name)}">
        <span class="cap-item-name">${escHtml(w.name)}</span>
        <span class="ref-tag ${statusClass}">${statusLabel}</span>
        <span class="cap-item-desc">${escHtml(w.description || '')}</span>
        <span class="cap-list-actions">
          <button class="cap-edit-btn wf-edit-btn" data-name="${escHtml(w.name)}" title="Edit">&#9998;</button>
          <button class="cap-del-btn wf-del-btn" data-name="${escHtml(w.name)}" title="Delete">&#10005;</button>
        </span>
      </div>`;
    }).join('');
  }

  // --- Edit Modal ---

  let editingName = null;

  function openEditModal(name, workflow, compiledSource, showRedo) {
    if (!wfModal) return;
    editingName = name;
    if (wfModalTitle) wfModalTitle.textContent = name ? `Edit: ${name}` : 'New Workflow';
    if (wfName) { wfName.value = workflow?.name || name || ''; wfName.disabled = !!name; }
    if (wfDesc) wfDesc.value = workflow?.description || '';

    // Tab content
    wf.sourceContent = JSON.stringify(workflow || {}, null, 2);
    wf.compiledContent = compiledSource || null;
    wf.activeTab = 'source';
    if (wfTextarea) wfTextarea.value = wf.sourceContent;
    updateTabUI();

    // Generate button: show only for new workflows
    if (wfGenerateBtn) wfGenerateBtn.classList.toggle('hidden', !!name);

    // Regenerate button: show only for existing workflows
    if (wfRegenBtn) wfRegenBtn.classList.toggle('hidden', !name);

    // Redo bar
    if (wfRedoBar) wfRedoBar.classList.toggle('hidden', !showRedo);
    if (wfRedoInput) wfRedoInput.value = '';

    // Highlight compile button when JS is stale
    const needsCompile = !!name && !compiledSource;
    updateCompileHighlight(needsCompile);

    // Reset dirty and busy states
    wf.jsonDirty = false;
    wf.jsDirty = false;
    updateSaveButtons();
    clearLog();
    wf.compiling = false;
    setCompileBusy(false);

    wfModal.classList.remove('hidden');
  }

  function closeEditModal() {
    if (wfModal) wfModal.classList.add('hidden');
    editingName = null;
    wf.generating = false;
    wf.compiling = false;
    setGenerateBusy(false);
  }

  function updateTabUI() {
    const hasCompiled = wf.compiledContent != null;
    if (wfTabSource) wfTabSource.classList.toggle('active', wf.activeTab === 'source');
    if (wfTabCompiled) {
      wfTabCompiled.classList.toggle('active', wf.activeTab === 'compiled');
      wfTabCompiled.classList.toggle('disabled', !hasCompiled);
    }
    if (wfCompileBtn) wfCompileBtn.disabled = wf.compiling;
  }

  function switchTab(tab) {
    if (tab === 'compiled' && wf.compiledContent == null) return;
    // Save current textarea content to the right variable
    if (wf.activeTab === 'source') {
      wf.sourceContent = wfTextarea?.value || '';
    } else {
      wf.compiledContent = wfTextarea?.value || '';
    }
    // Switch
    wf.activeTab = tab;
    if (wfTextarea) wfTextarea.value = tab === 'source' ? wf.sourceContent : (wf.compiledContent || '');
    updateTabUI();
  }

  // Tab clicks
  wfTabSource?.addEventListener('click', () => switchTab('source'));
  wfTabCompiled?.addEventListener('click', () => switchTab('compiled'));

  // Track manual edits in textarea for dirty state
  wfTextarea?.addEventListener('input', () => {
    if (wf.activeTab === 'source') {
      wf.jsonDirty = true;
    } else if (wf.activeTab === 'compiled') {
      wf.jsDirty = true;
    }
    updateSaveButtons();
  });

  function updateSaveButtons() {
    if (wfSaveJson) wfSaveJson.disabled = !wf.jsonDirty;
    if (wfSaveJs) wfSaveJs.disabled = !wf.jsDirty;
  }

  function saveWorkflowJson() {
    if (wf.activeTab === 'source') {
      wf.sourceContent = wfTextarea?.value || '';
    }
    let workflow;
    try {
      workflow = JSON.parse(wf.sourceContent || '{}');
    } catch (e) {
      setLog('Invalid JSON: ' + e.message, 'log-error');
      return;
    }
    const name = wfName?.value?.trim() || workflow.name || '';
    if (!name) { setLog('Name is required', 'log-error'); return; }
    workflow.name = name;
    if (wfDesc?.value) workflow.description = wfDesc.value;

    sendWs({ type: 'workflow:save', name, workflow });
    wf.jsonDirty = false;
    updateSaveButtons();
    setLog('JSON saved.', 'log-success');
  }

  function saveCompiledJs() {
    if (wf.activeTab === 'compiled') {
      wf.compiledContent = wfTextarea?.value || '';
    }
    if (!wf.compiledContent) { setLog('No compiled JS to save', 'log-error'); return; }
    const name = editingName || wfName?.value?.trim();
    if (!name) { setLog('Name is required', 'log-error'); return; }

    sendWs({ type: 'workflow:saveCompiled', name, compiledSource: wf.compiledContent });
    wf.jsDirty = false;
    updateSaveButtons();
    setLog('Compiled JS saved.', 'log-success');
  }

  // Compile
  function startCompile() {
    if (wf.compiling) return;
    // Save source first
    if (wf.activeTab === 'source') {
      wf.sourceContent = wfTextarea?.value || '';
    }
    let workflow;
    try {
      workflow = JSON.parse(wf.sourceContent || '{}');
    } catch (e) {
      setLog('Cannot compile — invalid JSON: ' + e.message, 'log-error');
      return;
    }
    const name = wfName?.value?.trim() || workflow.name || '';
    if (!name) { setLog('Cannot compile — name is required', 'log-error'); return; }
    workflow.name = name;
    if (wfDesc?.value) workflow.description = wfDesc.value;

    // Save then compile
    sendWs({ type: 'workflow:save', name, workflow });
    editingName = name;

    wf.compiling = true;
    setCompileBusy(true);
    setLog('Compiling...\n');
    setTimeout(() => sendWs({ type: 'workflow:compile', name }), 300);
  }

  wfCompileBtn?.addEventListener('click', startCompile);

  // Busy states
  function setGenerateBusy(busy) {
    if (wfGenerateBtn) {
      wfGenerateBtn.disabled = busy;
      wfGenerateBtn.textContent = busy ? 'Generating\u2026' : 'Generate';
    }
  }
  function setCompileBusy(busy) {
    if (wfCompileBtn) {
      wfCompileBtn.disabled = busy;
      wfCompileBtn.textContent = busy ? 'Compiling\u2026' : 'Compile';
    }
  }
  function updateCompileHighlight(stale) {
    if (!wfCompileBtn) return;
    if (stale) {
      wfCompileBtn.style.background = 'var(--accent)';
      wfCompileBtn.style.borderColor = 'var(--accent)';
      wfCompileBtn.style.color = '#fff';
      wfCompileBtn.textContent = 'Compile Now';
    } else {
      wfCompileBtn.style.background = '';
      wfCompileBtn.style.borderColor = '';
      wfCompileBtn.style.color = '';
      wfCompileBtn.textContent = 'Compile';
    }
  }

  // Footer buttons
  wfSaveJson?.addEventListener('click', () => saveWorkflowJson());
  wfSaveJs?.addEventListener('click', () => saveCompiledJs());
  wfModalCancel?.addEventListener('click', closeEditModal);
  wfModalClose?.addEventListener('click', closeEditModal);

  // Generate (now in footer)
  wfGenerateBtn?.addEventListener('click', () => {
    if (wf.generating) return;
    const desc = wfDesc?.value?.trim();
    if (!desc) { setLog('Enter a description first', 'log-error'); return; }
    wf.generating = true;
    setGenerateBusy(true);
    clearWfError();
    setLog('Generating workflow...\n');
    sendWs({ type: 'workflow:generate', description: desc });
  });

  // Redo
  wfRedoBtn?.addEventListener('click', () => {
    const feedback = wfRedoInput?.value?.trim();
    if (!feedback) return;
    wf.generating = true;
    setGenerateBusy(true);
    setLog('Regenerating workflow...\n');
    // Pass current source as context + feedback
    if (wf.activeTab === 'source') wf.sourceContent = wfTextarea?.value || '';
    sendWs({ type: 'workflow:generate', description: wf.sourceContent, feedback });
  });

  // Regenerate (for existing workflows — regenerates JSON from description)
  wfRegenBtn?.addEventListener('click', () => {
    if (wf.generating) return;
    const desc = wfDesc?.value?.trim();
    if (!desc) { setLog('Enter a description first', 'log-error'); return; }
    wf.generating = true;
    if (wfRegenBtn) { wfRegenBtn.disabled = true; wfRegenBtn.textContent = 'Regenerating\u2026'; }
    setLog('Regenerating source JSON from description...\n');
    sendWs({ type: 'workflow:generate', description: desc });
  });

  // New workflow
  document.getElementById('wfNewBtn')?.addEventListener('click', () => {
    openEditModal(null, {
      name: '',
      description: '',
      inputs: {},
      steps: {
        'step-1': { profile: 'full', do: 'Describe what to do', produces: 'description of output' },
        'done': { do: 'Summarize what was done' },
      },
    }, null);
  });

  // --- List actions (delegated) ---

  wfList?.addEventListener('click', (e) => {
    const name = e.target.closest('[data-name]')?.dataset.name;
    if (!name) return;
    if (e.target.closest('.wf-edit-btn')) {
      sendWs({ type: 'workflow:load', name });
    } else if (e.target.closest('.wf-del-btn')) {
      if (confirm(`Delete workflow "${name}"?`)) {
        sendWs({ type: 'workflow:delete', name });
      }
    }
  });

  // --- Helpers ---

  function isModalOpen() {
    return wfModal && !wfModal.classList.contains('hidden');
  }

  // --- Message handling ---

  function handleMessage(msg) {
    switch (msg.type) {
      case 'workflow:list':
        wf.workflows = msg.workflows || [];
        renderList();
        break;

      case 'workflow:loaded':
        openEditModal(msg.name, msg.workflow, msg.compiledSource || null);
        break;

      case 'workflow:generated':
        wf.generating = false;
        setGenerateBusy(false);
        if (wfRegenBtn) { wfRegenBtn.disabled = false; wfRegenBtn.textContent = 'Regenerate JSON'; }
        wf.lastGenerated = msg.workflow;
        wf.sourceContent = JSON.stringify(msg.workflow, null, 2);
        wf.compiledContent = null;
        wf.activeTab = 'source';
        if (wfTextarea) wfTextarea.value = wf.sourceContent;
        if (wfName) { wfName.value = msg.workflow.name || ''; wfName.disabled = false; }
        if (wfDesc) wfDesc.value = msg.workflow.description || wfDesc.value;
        updateTabUI();
        updateCompileHighlight(true);
        if (wfRedoBar) wfRedoBar.classList.remove('hidden');
        // Auto-save the generated JSON
        {
          const name = wfName?.value?.trim() || msg.workflow.name || '';
          if (name) {
            const wfToSave = { ...msg.workflow, name };
            if (wfDesc?.value) wfToSave.description = wfDesc.value;
            sendWs({ type: 'workflow:save', name, workflow: wfToSave });
            editingName = name;
            if (wfName) wfName.disabled = true;
          }
        }
        wf.jsonDirty = false;
        wf.jsDirty = false;
        updateSaveButtons();
        setLog('Generated and saved. Click "Compile Now" to create the executable JS.', 'log-success');
        // Open modal if not already open
        if (!isModalOpen()) wfModal?.classList.remove('hidden');
        break;

      case 'workflow:compile:progress':
        if (isModalOpen()) appendLog(msg.text);
        break;

      case 'workflow:compiled':
        wf.compiling = false;
        setCompileBusy(false);
        updateCompileHighlight(false);
        if (msg.compiledSource && isModalOpen()) {
          wf.compiledContent = msg.compiledSource;
          // Clear the streaming log and show success — the code is now in the textarea
          clearLog();
          setLog('Compiled and saved.', 'log-success');
          // Auto-switch to compiled tab
          switchTab('compiled');
        }
        wf.jsonDirty = false;
        wf.jsDirty = false;
        updateSaveButtons();
        // List will be refreshed by the workflow:list that follows
        break;

      case 'workflow:error':
        wf.generating = false;
        wf.compiling = false;
        setGenerateBusy(false);
        setCompileBusy(false);
        if (isModalOpen()) {
          setLog(msg.error || 'Unknown error', 'log-error');
        } else {
          showWfError(msg.error || 'Unknown error');
        }
        break;

    }
  }

  // --- Export ---
  window.workflowModule = { handleMessage };
})();
