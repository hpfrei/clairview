// ============================================================
// WORKFLOW MODULE — List, edit, generate, compile, test/run
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
    // Run state
    activeRunId: null,
    activeRunName: null,
    runStatus: 'ready',
    runSteps: [],
    expandedSteps: new Set(),
    stepOutputs: {},
  };

  // --- DOM refs ---
  const wfList = document.getElementById('wfList');
  const wfErrorBar = document.getElementById('wfErrorBar');

  // Edit modal
  const wfModal = document.getElementById('wfModal');
  const wfModalTitle = document.getElementById('wfModalTitle');
  const wfName = document.getElementById('wfName');
  const wfCwd = document.getElementById('wfCwd');
  const wfDesc = document.getElementById('wfDesc');
  const wfTextarea = document.getElementById('wfTextarea');
  const wfRedoBar = document.getElementById('wfRedoBar');
  const wfRedoInput = document.getElementById('wfRedoInput');
  const wfRedoBtn = document.getElementById('wfRedoBtn');
  const wfSaveOnly = document.getElementById('wfSaveOnly');
  const wfSave = document.getElementById('wfSave');
  const wfGenerateBtn = document.getElementById('wfGenerateBtn');
  const wfCompileBtn = document.getElementById('wfCompileBtn');
  const wfTabSource = document.getElementById('wfTabSource');
  const wfTabCompiled = document.getElementById('wfTabCompiled');
  const wfLog = document.getElementById('wfLog');
  const wfModalCancel = document.getElementById('wfModalCancel');
  const wfModalClose = document.getElementById('wfModalClose');

  // Run modal
  const wfRunModal = document.getElementById('wfRunModal');
  const wfRunTitle = document.getElementById('wfRunTitle');
  const wfRunStatus = document.getElementById('wfRunStatus');
  const wfRunInputs = document.getElementById('wfRunInputs');
  const wfRunSteps = document.getElementById('wfRunSteps');
  const wfRunStepList = document.getElementById('wfRunStepList');
  const wfRunStart = document.getElementById('wfRunStart');
  const wfRunStop = document.getElementById('wfRunStop');
  const wfRunCancel = document.getElementById('wfRunCancel');
  const wfRunClose = document.getElementById('wfRunClose');

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
          <button class="cap-edit-btn wf-test-btn" data-name="${escHtml(w.name)}" title="Test / Run">&#9654;</button>
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
    if (wfCwd) wfCwd.value = workflow?.workingDirectory || '';
    if (wfDesc) wfDesc.value = workflow?.description || '';

    // Tab content
    wf.sourceContent = JSON.stringify(workflow || {}, null, 2);
    wf.compiledContent = compiledSource || null;
    wf.activeTab = 'source';
    if (wfTextarea) wfTextarea.value = wf.sourceContent;
    updateTabUI();

    // Generate button: show only for new workflows
    if (wfGenerateBtn) wfGenerateBtn.classList.toggle('hidden', !!name);

    // Redo bar
    if (wfRedoBar) wfRedoBar.classList.toggle('hidden', !showRedo);
    if (wfRedoInput) wfRedoInput.value = '';

    // Reset log and busy states
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

  function saveWorkflow(close) {
    // Always save from sourceContent (switch to source first if needed)
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
    if (wfCwd?.value) workflow.workingDirectory = wfCwd.value;

    sendWs({ type: 'workflow:save', name, workflow });
    if (close) closeEditModal();
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
    if (wfCwd?.value) workflow.workingDirectory = wfCwd.value;

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

  // Footer buttons
  wfSaveOnly?.addEventListener('click', () => saveWorkflow(true));
  wfSave?.addEventListener('click', () => saveWorkflow(true));
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

  // New workflow
  document.getElementById('wfNewBtn')?.addEventListener('click', () => {
    openEditModal(null, {
      name: '',
      description: '',
      workingDirectory: '',
      inputs: {},
      steps: {
        'step-1': { profile: 'full', do: 'Describe what to do', produces: 'description of output' },
        'done': { do: 'Summarize what was done' },
      },
    }, null);
  });

  // --- Run Modal ---

  let runWorkflowData = null;

  function openRunModal(name) {
    if (!wfRunModal) return;
    sendWs({ type: 'workflow:load', name });
    wf.activeRunName = name;
    if (wfRunTitle) wfRunTitle.textContent = `Test: ${name}`;
    if (wfRunStatus) { wfRunStatus.textContent = 'ready'; wfRunStatus.className = 'ref-tag tag-ro'; }
    if (wfRunSteps) wfRunSteps.classList.add('hidden');
    if (wfRunStepList) wfRunStepList.innerHTML = '';
    if (wfRunStart) wfRunStart.classList.remove('hidden');
    if (wfRunStop) wfRunStop.classList.add('hidden');
    wf.runStatus = 'ready';
    wf.runSteps = [];
    wf.expandedSteps.clear();
    wf.stepOutputs = {};
    wfRunModal.classList.remove('hidden');
  }

  function populateRunInputs(workflow) {
    runWorkflowData = workflow;
    if (!wfRunInputs) return;
    const inputs = workflow.inputs || {};
    const keys = Object.keys(inputs);
    if (keys.length === 0) {
      wfRunInputs.innerHTML = '<p class="cap-modal-hint">This workflow has no inputs.</p>';
      return;
    }
    wfRunInputs.innerHTML = '<h4>Inputs</h4>' + keys.map(key =>
      `<div class="pm-field-row"><label class="pm-wide">${escHtml(key)}: <input type="text" class="wf-run-input" data-key="${escHtml(key)}" placeholder="${escHtml(inputs[key])}"></label></div>`
    ).join('');
  }

  function startRun() {
    const name = wf.activeRunName;
    if (!name) return;
    const inputs = {};
    wfRunInputs?.querySelectorAll('.wf-run-input').forEach(inp => {
      inputs[inp.dataset.key] = inp.value || inp.placeholder || '';
    });
    if (runWorkflowData?.steps) {
      const stepEntries = Object.entries(runWorkflowData.steps);
      wf.runSteps = stepEntries.map(([id, step]) => ({
        id,
        profile: step.profile || null,
        instruction: step.do || step.condition || '',
        status: 'pending',
        elapsed: null,
      }));
      renderRunSteps();
    }
    wf.runStatus = 'running';
    updateRunUI();
    sendWs({ type: 'workflow:run', name, inputs });
  }

  function renderRunSteps() {
    if (!wfRunStepList) return;
    if (wfRunSteps) wfRunSteps.classList.remove('hidden');
    wfRunStepList.innerHTML = wf.runSteps.map(s => {
      const icon = s.status === 'done' ? '\u25cf' : s.status === 'running' ? '\u25cc' : s.status === 'failed' ? '\u2715' : s.status === 'skipped' ? '\u2013' : '\u25cb';
      const expanded = wf.expandedSteps.has(s.id);
      return `<div class="cap-list-item wf-step-row" data-step="${escHtml(s.id)}">
        <span class="wf-step-icon ${s.status}">${icon}</span>
        <span class="cap-item-name">${escHtml(s.id)}</span>
        ${s.profile ? `<span class="ref-tag tag-sk">${escHtml(s.profile)}</span>` : ''}
        <span class="cap-item-desc">${escHtml(s.instruction)}</span>
        <span class="wf-step-time">${s.elapsed != null ? formatElapsed(s.elapsed) : ''}</span>
        <span class="cap-list-actions">
          <button class="cap-edit-btn wf-step-expand" data-step="${escHtml(s.id)}" title="Toggle output">${expanded ? '\u25be' : '\u25b8'}</button>
        </span>
      </div>${expanded ? `<div class="wf-run-output" data-step-output="${escHtml(s.id)}">${escHtml(wf.stepOutputs[s.id] || '')}</div>` : ''}`;
    }).join('');
  }

  function formatElapsed(ms) {
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function updateRunUI() {
    if (wfRunStatus) {
      const labels = { ready: 'ready', running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
      const classes = { ready: 'tag-ro', running: 'tag-ex', completed: 'tag-sk', failed: 'tag-wr', cancelled: 'tag-wr' };
      wfRunStatus.textContent = labels[wf.runStatus] || wf.runStatus;
      wfRunStatus.className = `ref-tag ${classes[wf.runStatus] || 'tag-ro'}`;
    }
    if (wfRunStart) wfRunStart.classList.toggle('hidden', wf.runStatus === 'running');
    if (wfRunStop) wfRunStop.classList.toggle('hidden', wf.runStatus !== 'running');
  }

  // Run modal event handlers
  wfRunStart?.addEventListener('click', startRun);
  wfRunStop?.addEventListener('click', () => {
    if (wf.activeRunId) sendWs({ type: 'workflow:run:cancel', runId: wf.activeRunId });
  });
  wfRunCancel?.addEventListener('click', () => wfRunModal?.classList.add('hidden'));
  wfRunClose?.addEventListener('click', () => wfRunModal?.classList.add('hidden'));

  // --- List actions (delegated) ---

  wfList?.addEventListener('click', (e) => {
    const name = e.target.closest('[data-name]')?.dataset.name;
    if (!name) return;
    if (e.target.closest('.wf-test-btn')) {
      openRunModal(name);
    } else if (e.target.closest('.wf-edit-btn')) {
      sendWs({ type: 'workflow:load', name });
    } else if (e.target.closest('.wf-del-btn')) {
      if (confirm(`Delete workflow "${name}"?`)) {
        sendWs({ type: 'workflow:delete', name });
      }
    }
  });

  // Step expand toggle (delegated)
  wfRunStepList?.addEventListener('click', (e) => {
    const btn = e.target.closest('.wf-step-expand');
    if (!btn) return;
    const stepId = btn.dataset.step;
    if (wf.expandedSteps.has(stepId)) {
      wf.expandedSteps.delete(stepId);
    } else {
      wf.expandedSteps.add(stepId);
    }
    renderRunSteps();
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
        // If run modal is open, populate inputs; otherwise open edit modal
        if (wfRunModal && !wfRunModal.classList.contains('hidden') && msg.name === wf.activeRunName) {
          populateRunInputs(msg.workflow);
        } else {
          openEditModal(msg.name, msg.workflow, msg.compiledSource || null);
        }
        break;

      case 'workflow:generated':
        wf.generating = false;
        setGenerateBusy(false);
        wf.lastGenerated = msg.workflow;
        wf.sourceContent = JSON.stringify(msg.workflow, null, 2);
        wf.compiledContent = null;
        wf.activeTab = 'source';
        if (wfTextarea) wfTextarea.value = wf.sourceContent;
        if (wfName) { wfName.value = msg.workflow.name || ''; wfName.disabled = false; }
        if (wfDesc) wfDesc.value = msg.workflow.description || wfDesc.value;
        if (wfCwd) wfCwd.value = msg.workflow.workingDirectory || wfCwd.value;
        updateTabUI();
        if (wfRedoBar) wfRedoBar.classList.remove('hidden');
        setLog('Generated successfully.', 'log-success');
        // Open modal if not already open
        if (!isModalOpen()) wfModal?.classList.remove('hidden');
        break;

      case 'workflow:compile:progress':
        if (isModalOpen()) appendLog(msg.text);
        break;

      case 'workflow:compiled':
        wf.compiling = false;
        setCompileBusy(false);
        if (msg.compiledSource && isModalOpen()) {
          wf.compiledContent = msg.compiledSource;
          appendLog('\n\nCompiled successfully.', 'log-success');
          // Auto-switch to compiled tab
          switchTab('compiled');
        }
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

      case 'workflow:run:started':
        wf.activeRunId = msg.runId;
        wf.runStatus = 'running';
        if (msg.steps) {
          wf.runSteps = msg.steps.map(s => ({ ...s, instruction: '', elapsed: null }));
          renderRunSteps();
        }
        updateRunUI();
        break;

      case 'workflow:step:start':
        updateStepInList(msg.stepId, 'running');
        break;

      case 'workflow:step:progress':
        wf.stepOutputs[msg.stepId] = (wf.stepOutputs[msg.stepId] || '') + (msg.text || '');
        const outputEl = wfRunStepList?.querySelector(`[data-step-output="${msg.stepId}"]`);
        if (outputEl) {
          outputEl.textContent = wf.stepOutputs[msg.stepId];
          outputEl.scrollTop = outputEl.scrollHeight;
        }
        break;

      case 'workflow:step:complete':
        updateStepInList(msg.stepId, msg.success ? 'done' : 'failed', msg.elapsed);
        break;

      case 'workflow:run:complete':
        wf.runStatus = msg.status || 'completed';
        wf.activeRunId = null;
        updateRunUI();
        sendWs({ type: 'workflow:list' });
        break;
    }
  }

  function updateStepInList(stepId, status, elapsed) {
    const step = wf.runSteps.find(s => s.id === stepId);
    if (step) {
      step.status = status;
      if (elapsed !== undefined) step.elapsed = elapsed;
    }
    renderRunSteps();
  }

  // --- Export ---
  window.workflowModule = { handleMessage };
})();
