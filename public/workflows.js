// ============================================================
// WORKFLOW MODULE — Create / edit workflows (renders into tab container)
// ============================================================
(function workflowModule() {
  'use strict';
  const { state, sendWs, escHtml } = window.dashboard;

  // --- Internal state per create-tab (keyed by tabId) ---
  const editors = new Map();

  function createEditorState(tabId) {
    return {
      tabId,
      editingName: null,
      generating: false,
      compiling: false,
      activeTab: 'source',
      sourceContent: '',
      compiledContent: null,
      jsonDirty: false,
      jsDirty: false,
      modifying: false,
      modifyPhase: null,      // 'analyzing' | 'reviewing' | 'applying'
      modifyRequest: null,
      modifyProposal: null,
    };
  }

  function getEditor(tabId) {
    if (!editors.has(tabId)) editors.set(tabId, createEditorState(tabId));
    return editors.get(tabId);
  }

  function removeEditor(tabId) {
    editors.delete(tabId);
  }

  // --- Render the create/edit form into a container ---
  function renderCreateForm(container, tabId, workflowData, compiledSource, isEdit) {
    const ed = getEditor(tabId);
    const isFirstRender = !ed._initialized;

    // Only initialize state on first render — preserve state on re-renders (tab switches)
    if (isFirstRender) {
      ed._initialized = true;
      ed.editingName = isEdit ? (workflowData?.name || null) : null;
      ed.sourceContent = JSON.stringify(workflowData || {}, null, 2);
      ed.compiledContent = compiledSource || null;
      ed.activeTab = 'source';
      ed.jsonDirty = false;
      ed.jsDirty = false;
      ed.generating = false;
      ed.compiling = false;
    } else {
      // Save current textarea content before DOM is destroyed
      if (ed._ui?.textareaEl) {
        if (ed.activeTab === 'source') ed.sourceContent = ed._ui.textareaEl.value || '';
        else if (ed.activeTab === 'compiled') ed.compiledContent = ed._ui.textareaEl.value || '';
      }
      if (ed._ui?.nameEl) ed._savedName = ed._ui.nameEl.value;
      if (ed._ui?.descEl) ed._savedDesc = ed._ui.descEl.value;
    }

    const name = ed._savedName || workflowData?.name || '';
    const desc = ed._savedDesc || workflowData?.description || '';
    const profiles = state.profiles || [];
    const hasName = !!ed.editingName;
    const needsCompile = hasName && !ed.compiledContent;

    container.innerHTML = `
      <div class="wfc-form">
        <div class="wfc-top-row">
          <div class="wfc-field">
            <label class="wfc-label">Name</label>
            <input type="text" class="wfc-input" id="wfc-name-${tabId}" placeholder="my-workflow" value="${escHtml(name)}">
            <button class="wfc-name-save hidden" id="wfc-name-save-${tabId}">Rename</button>
          </div>
          <div class="wfc-field wfc-field-grow">
            <label class="wfc-label">Description</label>
            <textarea class="wfc-input wfc-desc" id="wfc-desc-${tabId}" rows="8" placeholder="Describe what this workflow does — used as the AI prompt for generation.">${escHtml(desc)}</textarea>
          </div>
        </div>

        <div class="wfc-options-row">
          <div class="wfc-option-group">
            <span class="wfc-label">Profiles</span>
            <div class="wfc-profile-list" id="wfc-profiles-${tabId}">
              ${profiles.map(p => `<label class="wfc-checkbox"><input type="checkbox" value="${escHtml(p.name)}" checked> ${escHtml(p.label || p.name)}</label>`).join('')}
            </div>
          </div>
        </div>

        <div class="wfc-toolbar">
          <button class="wfc-tab active" data-tab="source" id="wfc-tab-source-${tabId}">Source JSON</button>
          <button class="wfc-tab ${ed.compiledContent ? '' : 'disabled'}" data-tab="compiled" id="wfc-tab-compiled-${tabId}">Compiled JS</button>
          <button class="wfc-tab" data-tab="help" id="wfc-tab-help-${tabId}">Help</button>
          <div class="wfc-toolbar-spacer"></div>
          <button class="wfc-btn wfc-btn-secondary ${hasName ? '' : 'hidden'}" id="wfc-modify-${tabId}">Modify</button>
          <button class="wfc-btn wfc-btn-primary" id="wfc-generate-${tabId}">Generate JSON</button>
          <button class="wfc-btn wfc-btn-accent" id="wfc-compile-${tabId}">Compile</button>
        </div>

        <textarea class="wfc-code" id="wfc-textarea-${tabId}" spellcheck="false" rows="20">${escHtml(ed.sourceContent)}</textarea>

        <div class="wfc-help hidden" id="wfc-help-${tabId}">
          <div class="wf-help-columns">
            <div class="wf-help-col">
              <h4>Source JSON</h4>
              <pre class="wf-help-pre">{
  "name": "my-workflow",
  "description": "What this workflow does",
  "inputs": {
    "topic": "The topic to process",
    "image": { "type": "file", "description": "...", "accept": "image/*" }
  },
  "outputs": {
    "summary": { "type": "string", "description": "Result text" },
    "chart": { "type": "file", "description": "Generated chart image" }
  },
  "steps": {
    "step-id": { ... }
  }
}</pre>
              <p class="wf-help-note"><b>Prompt</b>: An optional prompt is always available as <code>{{prompt}}</code> in step instructions.</p>
              <p class="wf-help-note"><b>File inputs</b>: Use <code>{ "type": "file", "description": "...", "accept": "image/*" }</code>. At runtime, <code>{{key}}</code> resolves to the placed filename. Steps should instruct the agent to read the file using the Read tool.</p>
              <p class="wf-help-note"><b>Outputs</b>: Declare expected return values. Files written to the working directory are automatically collected and returned as base64 data URLs.</p>

              <h4>Step fields</h4>
              <pre class="wf-help-pre"><b>do</b>           The prompt sent to claude -p.
             Use {{key}} for input substitution.
<b>profile</b>      Profile name for this step.
<b>produces</b>     Describes expected output format.
<b>context</b>      Array of step IDs whose output is
             prepended to this step's prompt.</pre>

              <h4>Navigation</h4>
              <pre class="wf-help-pre"><b>next</b>         Unconditional jump to step ID.
<b>condition</b>    Natural-language branch condition.
<b>then / else</b>  Branch targets from evaluate().</pre>

              <h4>Advanced</h4>
              <pre class="wf-help-pre"><b>parallel</b>     Array of step IDs to run concurrently.
<b>join</b>         Step ID to resume after parallel done.
<b>maxRetries</b>   Retry count on failure (default: 0).
<b>timeout</b>      Step timeout in ms.
<b>onError</b>      Step ID to jump to on failure.</pre>
            </div>
            <div class="wf-help-col">
              <h4>Compiled JS</h4>
              <pre class="wf-help-pre">module.exports = {
  name: "my-workflow",
  sourceHash: "f68b47ebd7a6",
  inputs: { topic: { type: "string", ... } },
  steps: [ { id, profile, buildPrompt,
             parseOutput, evaluate, ... } ]
};</pre>

              <h4>Step object</h4>
              <pre class="wf-help-pre"><b>buildPrompt(ctx)</b>
  Returns the full prompt string.
  ctx.inputs.key / ctx.steps.id.output

<b>parseOutput(raw)</b>
  Transforms the raw agent output.

<b>evaluate(ctx)</b>
  Deterministic JS predicate for branching.</pre>

              <h4>Runtime context</h4>
              <pre class="wf-help-pre">ctx = {
  inputs: { topic: "user value" },
  steps: {
    "research": { output: "..." },
    "failed-step": { output: null, error: "..." }
  }
}</pre>
            </div>
          </div>
        </div>

        <div class="wfc-log hidden" id="wfc-log-${tabId}"></div>

        <div class="wfc-footer">
          <button class="wfc-btn wfc-btn-danger ${hasName ? '' : 'hidden'}" id="wfc-delete-${tabId}">Delete Workflow</button>
        </div>
      </div>`;

    // --- Wire up events ---
    const nameEl = container.querySelector(`#wfc-name-${tabId}`);
    const nameSaveBtn = container.querySelector(`#wfc-name-save-${tabId}`);
    const descEl = container.querySelector(`#wfc-desc-${tabId}`);
    const textareaEl = container.querySelector(`#wfc-textarea-${tabId}`);
    const helpEl = container.querySelector(`#wfc-help-${tabId}`);
    const logEl = container.querySelector(`#wfc-log-${tabId}`);
    const generateBtn = container.querySelector(`#wfc-generate-${tabId}`);
    const compileBtn = container.querySelector(`#wfc-compile-${tabId}`);
    const modifyBtn = container.querySelector(`#wfc-modify-${tabId}`);
    const deleteBtn = container.querySelector(`#wfc-delete-${tabId}`);

    // --- Helpers ---

    function hasSourceJson() {
      const src = (ed.activeTab === 'source' ? textareaEl?.value : ed.sourceContent) || '';
      try { const j = JSON.parse(src); return j && Object.keys(j.steps || {}).length > 0; } catch { return false; }
    }

    function updateNameSaveBtn() {
      if (!nameSaveBtn || !ed.editingName) return;
      const current = nameEl?.value?.trim() || '';
      nameSaveBtn.classList.toggle('hidden', current === ed.editingName || !current);
    }

    function updateButtonStates() {
      const busy = ed.generating || ed.compiling || ed.modifying;
      const hasName = !!nameEl?.value?.trim();
      const hasDesc = !!descEl?.value?.trim();
      generateBtn.disabled = busy || !hasName || !hasDesc;
      compileBtn.disabled = busy || !hasSourceJson();
      if (modifyBtn) {
        modifyBtn.disabled = busy || !ed.editingName || !hasSourceJson();
        modifyBtn.classList.toggle('hidden', !ed.editingName);
      }
      generateBtn.innerHTML = ed.generating ? '<span class="busy-dot"></span> Generating\u2026' : 'Generate JSON';
      compileBtn.innerHTML = ed.compiling ? '<span class="busy-dot"></span> Compiling\u2026' : 'Compile';
      updateNameSaveBtn();
      window.workflowRunModule?.renderTabStrip?.();
    }

    nameEl?.addEventListener('input', () => { updateButtonStates(); updateNameSaveBtn(); });

    nameSaveBtn?.addEventListener('click', () => {
      const newName = nameEl?.value?.trim();
      if (!newName || !ed.editingName || newName === ed.editingName) return;
      sendWs({ type: 'workflow:rename', oldName: ed.editingName, newName });
      ed.editingName = newName;
      nameSaveBtn.classList.add('hidden');
      if (window.workflowRunModule?.updateTabLabel) {
        window.workflowRunModule.updateTabLabel(tabId, newName);
      }
      setLog(`Renamed to "${newName}".`, 'log-success');
    });
    descEl?.addEventListener('input', updateButtonStates);
    textareaEl?.addEventListener('input', updateButtonStates);
    updateButtonStates();

    // Tab switching
    function switchEditorTab(tab) {
      if (tab === 'compiled' && !ed.compiledContent) return;
      if (ed.activeTab === 'source') ed.sourceContent = textareaEl?.value || '';
      else if (ed.activeTab === 'compiled') ed.compiledContent = textareaEl?.value || '';

      ed.activeTab = tab;
      container.querySelectorAll('.wfc-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      const isHelp = tab === 'help';
      textareaEl?.classList.toggle('hidden', isHelp);
      helpEl?.classList.toggle('hidden', !isHelp);
      if (!isHelp && textareaEl) {
        textareaEl.value = tab === 'source' ? ed.sourceContent : (ed.compiledContent || '');
      }
      const compiledTab = container.querySelector(`#wfc-tab-compiled-${tabId}`);
      compiledTab?.classList.toggle('disabled', !ed.compiledContent);
    }

    container.querySelectorAll('.wfc-tab').forEach(t => {
      t.addEventListener('click', () => switchEditorTab(t.dataset.tab));
    });

    // Log helpers
    function setLog(text, cls) {
      if (!logEl) return;
      logEl.classList.remove('hidden', 'log-error', 'log-success', 'log-busy');
      if (cls) logEl.classList.add(cls);
      logEl.textContent = text;
      logEl.scrollTop = logEl.scrollHeight;
    }
    function appendLog(text) {
      if (!logEl) return;
      logEl.classList.remove('hidden');
      logEl.textContent += text;
      logEl.scrollTop = logEl.scrollHeight;
    }
    function clearLog() {
      if (!logEl) return;
      logEl.textContent = '';
      logEl.classList.add('hidden');
      logEl.classList.remove('log-error', 'log-success', 'log-busy');
    }

    function getSelectedProfiles() {
      const profileList = container.querySelector(`#wfc-profiles-${tabId}`);
      if (!profileList) return [];
      return [...profileList.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
    }

    // --- Confirmation modal helper ---
    function confirmOverwrite(title, detail) {
      return new Promise(resolve => {
        const backdrop = document.createElement('div');
        backdrop.className = 'alert-modal-backdrop';
        backdrop.innerHTML = `<div class="alert-modal">
          <div class="alert-modal-message">${escHtml(title)}<br><span style="font-size:11px;color:var(--text-dim)">${escHtml(detail)}</span></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="wfc-btn wfc-btn-secondary" id="wfc-confirm-cancel">Cancel</button>
            <button class="wfc-btn wfc-btn-primary" id="wfc-confirm-ok">Continue</button>
          </div>
        </div>`;
        document.body.appendChild(backdrop);
        const dismiss = (val) => { backdrop.remove(); resolve(val); };
        backdrop.querySelector('#wfc-confirm-cancel').addEventListener('click', () => dismiss(false));
        backdrop.querySelector('#wfc-confirm-ok').addEventListener('click', () => dismiss(true));
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(false); });
        backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(false); });
        backdrop.querySelector('#wfc-confirm-ok').focus();
      });
    }

    // --- Generate JSON ---
    generateBtn?.addEventListener('click', async () => {
      if (ed.generating || ed.compiling) return;
      const desc = descEl?.value?.trim();
      const name = nameEl?.value?.trim();
      if (!desc || !name) return;

      // Confirm overwrite if JSON already exists
      if (hasSourceJson()) {
        const ok = await confirmOverwrite(
          'Overwrite existing JSON?',
          'This will replace the current workflow source with a newly generated version.'
        );
        if (!ok) return;
      }

      ed.generating = true;
      updateButtonStates();
      clearLog();
      setLog('Generating workflow\u2026', 'log-busy');
      sendWs({ type: 'workflow:generate', description: desc, existingName: ed.editingName || undefined, selectedProfiles: getSelectedProfiles() });
    });

    // --- Compile ---
    compileBtn?.addEventListener('click', async () => {
      if (ed.generating || ed.compiling) return;
      if (ed.activeTab === 'source') ed.sourceContent = textareaEl?.value || '';
      let workflow;
      try { workflow = JSON.parse(ed.sourceContent || '{}'); }
      catch (e) { setLog('Cannot compile \u2014 invalid JSON: ' + e.message, 'log-error'); return; }
      const wfName = nameEl?.value?.trim() || workflow.name || '';
      if (!wfName) { setLog('Cannot compile \u2014 name is required', 'log-error'); return; }
      workflow.name = wfName;
      if (descEl?.value) workflow.description = descEl.value;

      // Confirm overwrite if compiled JS already exists
      if (ed.compiledContent) {
        const ok = await confirmOverwrite(
          'Overwrite existing compiled JS?',
          'This will replace the current compiled JavaScript with a freshly compiled version.'
        );
        if (!ok) return;
      }

      sendWs({ type: 'workflow:save', name: wfName, workflow });
      ed.editingName = wfName;
      ed.compiling = true;
      updateButtonStates();
      setLog('Compiling\u2026', 'log-busy');
      setTimeout(() => sendWs({ type: 'workflow:compile', name: wfName }), 300);
    });

    // --- Modify workflow ---
    modifyBtn?.addEventListener('click', () => {
      if (ed.generating || ed.compiling || ed.modifying) return;
      if (!ed.editingName) return;
      openModifyModal(ed, tabId, getSelectedProfiles);
    });

    // --- Delete workflow ---
    deleteBtn?.addEventListener('click', async () => {
      const wfName = ed.editingName || nameEl?.value?.trim();
      if (!wfName) return;
      const backdrop = document.createElement('div');
      backdrop.className = 'alert-modal-backdrop';
      backdrop.innerHTML = `<div class="alert-modal">
        <div class="alert-modal-message" style="color:var(--red)">Delete workflow "${escHtml(wfName)}"?<br><span style="font-size:11px;color:var(--text-dim)">This will remove the workflow definition and compiled JS. This cannot be undone.</span></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="wfc-btn wfc-btn-secondary" id="wfc-del-cancel">Cancel</button>
          <button class="wfc-btn wfc-btn-danger" id="wfc-del-confirm">Delete</button>
        </div>
      </div>`;
      document.body.appendChild(backdrop);
      backdrop.querySelector('#wfc-del-cancel').addEventListener('click', () => backdrop.remove());
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
      backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') backdrop.remove(); });
      backdrop.querySelector('#wfc-del-confirm').addEventListener('click', () => {
        backdrop.remove();
        sendWs({ type: 'workflow:delete', name: wfName });
        if (window.workflowRunModule) {
          removeEditor(tabId);
          const closeBtn = document.querySelector(`.view-tab[data-tab-id="${tabId}"] .view-tab-close`);
          if (closeBtn) closeBtn.click();
        }
      });
      backdrop.querySelector('#wfc-del-confirm').focus();
    });

    // Store update handlers on the editor so handleMessage can call them
    ed._ui = { textareaEl, nameEl, descEl, logEl, helpEl, compileBtn, generateBtn, modifyBtn, deleteBtn,
               setLog, appendLog, clearLog, updateButtonStates, switchEditorTab, getSelectedProfiles };
  }

  // --- Message handling ---
  function handleMessage(msg, targetTabId) {
    // Find the editor for the active create tab
    const tabId = targetTabId || findActiveCreateTabId();
    if (!tabId) return;
    const ed = editors.get(tabId);
    if (!ed) return;
    const ui = ed._ui;
    if (!ui) return;

    switch (msg.type) {
      case 'workflow:list':
        // Nothing to do in editor for list updates
        break;

      case 'workflow:loaded':
        // Re-render handled by workflow-runs module
        break;

      case 'workflow:generated':
        ed.generating = false;
        ed.sourceContent = JSON.stringify(msg.workflow, null, 2);
        ed.compiledContent = null;
        ed.activeTab = 'source';
        if (ui.textareaEl) ui.textareaEl.value = ed.sourceContent;
        if (ui.nameEl) ui.nameEl.value = msg.workflow.name || '';
        if (ui.descEl) ui.descEl.value = msg.workflow.description || ui.descEl.value;

        // Update compiled tab state
        const compiledTab = ui.textareaEl?.closest('.wfc-form')?.querySelector(`#wfc-tab-compiled-${tabId}`);
        compiledTab?.classList.toggle('disabled', true);

        // Auto-save
        {
          const name = ui.nameEl?.value?.trim() || msg.workflow.name || '';
          if (name) {
            const wfToSave = { ...msg.workflow, name };
            if (ui.descEl?.value) wfToSave.description = ui.descEl.value;
            sendWs({ type: 'workflow:save', name, workflow: wfToSave });
            ed.editingName = name;
            if (ui.deleteBtn) ui.deleteBtn.classList.remove('hidden');
          }
        }
        ui.updateButtonStates();
        ui.setLog('Generated and saved.', 'log-success');

        if (window.workflowRunModule?.updateTabLabel) {
          window.workflowRunModule.updateTabLabel(tabId, msg.workflow.name || 'New');
        }
        break;

      case 'workflow:compile:progress':
        if (ui.appendLog) ui.appendLog(msg.text);
        break;

      case 'workflow:compiled':
        ed.compiling = false;
        if (msg.compiledSource) {
          ed.compiledContent = msg.compiledSource;
          ui.clearLog();
          ui.setLog('Compiled and saved.', 'log-success');
          ui.switchEditorTab('compiled');
        }
        ui.updateButtonStates();
        break;

      case 'workflow:error':
        ed.generating = false;
        ed.compiling = false;
        ui.updateButtonStates();
        ui.setLog(msg.error || 'Unknown error', 'log-error');
        break;

      // --- Modify workflow messages ---
      case 'workflow:modify:proposal':
        ed.modifying = false;
        ed.modifyPhase = 'reviewing';
        ed.modifyProposal = msg.proposal;
        ed.modifyRequest = msg.request;
        updateModifyModal(ed);
        ui.updateButtonStates();
        break;

      case 'workflow:modify:applying':
        ed.modifyPhase = 'applying';
        updateModifyModal(ed);
        break;

      case 'workflow:modify:complete':
        ed.modifying = false;
        ed.modifyPhase = null;
        ed.modifyProposal = null;
        ed.modifyRequest = null;
        ed.sourceContent = JSON.stringify(msg.workflow, null, 2);
        ed.compiledContent = msg.compiledSource || null;
        if (ui.textareaEl) ui.textareaEl.value = ed.sourceContent;
        if (ui.nameEl) ui.nameEl.value = msg.workflow.name || ui.nameEl.value;
        if (ui.descEl) ui.descEl.value = msg.workflow.description || ui.descEl.value;
        ui.updateButtonStates();
        ui.setLog('Workflow modified and recompiled.', 'log-success');
        closeModifyModal();
        // Switch to compiled tab to show the new result
        if (ed.compiledContent) ui.switchEditorTab('compiled');
        break;

      case 'workflow:modify:error':
        ed.modifying = false;
        if (ed.modifyPhase === 'analyzing') {
          ed.modifyPhase = null;
          closeModifyModal();
          ui.setLog(msg.error || 'Modification failed', 'log-error');
        } else {
          // Keep modal open to show error during apply phase
          ed.modifyPhase = 'error';
          ed._modifyError = msg.error;
          updateModifyModal(ed);
        }
        ui.updateButtonStates();
        break;
    }
  }

  // --- Modify Modal ---

  let activeModifyBackdrop = null;

  function closeModifyModal() {
    if (activeModifyBackdrop) {
      activeModifyBackdrop.remove();
      activeModifyBackdrop = null;
    }
  }

  function openModifyModal(ed, tabId, getSelectedProfiles) {
    closeModifyModal(); // ensure no duplicates
    ed.modifyPhase = 'request';
    ed.modifyProposal = null;
    ed.modifyRequest = null;
    ed._modifyError = null;

    const backdrop = document.createElement('div');
    backdrop.className = 'alert-modal-backdrop';
    backdrop.innerHTML = renderModifyModalContent(ed, 'request');

    document.body.appendChild(backdrop);
    activeModifyBackdrop = backdrop;

    // Close on backdrop click or Escape
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && !ed.modifying) { closeModifyModal(); ed.modifyPhase = null; }
    });
    const onKey = (e) => {
      if (e.key === 'Escape' && !ed.modifying) { closeModifyModal(); ed.modifyPhase = null; document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    wireModifyModalEvents(ed, tabId, getSelectedProfiles);
  }

  function renderModifyModalContent(ed, phase) {
    const name = ed.editingName || '';

    if (phase === 'request') {
      return `<div class="cap-modal wfc-modify-modal">
        <div class="cap-modal-header">
          <span class="cap-modal-title">Modify: ${escHtml(name)}</span>
          <button class="cap-modal-close" id="wfc-modify-close">&times;</button>
        </div>
        <div class="wfc-modify-body">
          <label class="wfc-label">Describe what you'd like to change</label>
          <textarea class="wfc-modify-request" id="wfc-modify-textarea" rows="5" placeholder="e.g., Add a validation step after research that checks for errors before the final summary...">${escHtml(ed.modifyRequest || '')}</textarea>
        </div>
        <div class="wfc-modify-footer">
          <button class="wfc-btn wfc-btn-secondary" id="wfc-modify-cancel">Cancel</button>
          <button class="wfc-btn wfc-btn-primary" id="wfc-modify-analyze">Analyze Changes</button>
        </div>
      </div>`;
    }

    if (phase === 'analyzing') {
      return `<div class="cap-modal wfc-modify-modal">
        <div class="cap-modal-header">
          <span class="cap-modal-title">Modify: ${escHtml(name)}</span>
        </div>
        <div class="wfc-modify-body wfc-modify-busy">
          <span class="busy-dot"></span> Analyzing workflow and proposed changes\u2026
        </div>
      </div>`;
    }

    if (phase === 'reviewing' && ed.modifyProposal) {
      const p = ed.modifyProposal;
      const changeTypeLabels = {
        'modify-step': 'Modify Step', 'add-step': 'Add Step', 'remove-step': 'Remove Step',
        'modify-input': 'Modify Input', 'add-input': 'Add Input', 'remove-input': 'Remove Input',
        'modify-meta': 'Modify Meta',
      };
      const changesHtml = (p.changes || []).map(c => {
        const label = changeTypeLabels[c.type] || c.type;
        return `<div class="wfc-modify-change-row">
          <span class="wfc-modify-change-badge" data-type="${escHtml(c.type)}">${escHtml(label)}</span>
          <span class="wfc-modify-change-target">${escHtml(c.target || '')}</span>
          <span class="wfc-modify-change-desc">${escHtml(c.description || '')}</span>
        </div>`;
      }).join('');

      const risksHtml = p.risks?.length ? `<div class="wfc-modify-risks">
        <div class="wfc-modify-risks-title">Risks</div>
        ${p.risks.map(r => `<div class="wfc-modify-risk-item">${escHtml(r)}</div>`).join('')}
      </div>` : '';

      const feasClass = p.feasibility === 'high' ? 'feas-high' : p.feasibility === 'low' ? 'feas-low' : 'feas-medium';

      return `<div class="cap-modal wfc-modify-modal wfc-modify-modal-wide">
        <div class="cap-modal-header">
          <span class="cap-modal-title">Modify: ${escHtml(name)}</span>
          <span class="wfc-modify-feasibility ${feasClass}">Feasibility: ${escHtml(p.feasibility || 'unknown')}</span>
          <button class="cap-modal-close" id="wfc-modify-close">&times;</button>
        </div>
        <div class="wfc-modify-body">
          <div class="wfc-modify-summary">${escHtml(p.summary || '')}</div>
          <div class="wfc-modify-changes-title">Proposed Changes</div>
          <div class="wfc-modify-changes">${changesHtml}</div>
          ${risksHtml}
        </div>
        <div class="wfc-modify-footer">
          <button class="wfc-btn wfc-btn-secondary" id="wfc-modify-back">Edit Request</button>
          <button class="wfc-btn wfc-btn-secondary" id="wfc-modify-cancel">Cancel</button>
          <button class="wfc-btn wfc-btn-primary" id="wfc-modify-apply">Apply Changes</button>
        </div>
      </div>`;
    }

    if (phase === 'applying') {
      return `<div class="cap-modal wfc-modify-modal">
        <div class="cap-modal-header">
          <span class="cap-modal-title">Modify: ${escHtml(name)}</span>
        </div>
        <div class="wfc-modify-body wfc-modify-busy">
          <span class="busy-dot"></span> Regenerating workflow and compiling\u2026
          <div class="wfc-modify-progress" id="wfc-modify-progress"></div>
        </div>
      </div>`;
    }

    if (phase === 'error') {
      return `<div class="cap-modal wfc-modify-modal">
        <div class="cap-modal-header">
          <span class="cap-modal-title">Modify: ${escHtml(name)}</span>
          <button class="cap-modal-close" id="wfc-modify-close">&times;</button>
        </div>
        <div class="wfc-modify-body">
          <div class="wfc-modify-error">${escHtml(ed._modifyError || 'Unknown error')}</div>
        </div>
        <div class="wfc-modify-footer">
          <button class="wfc-btn wfc-btn-secondary" id="wfc-modify-back">Try Again</button>
          <button class="wfc-btn wfc-btn-secondary" id="wfc-modify-cancel">Close</button>
        </div>
      </div>`;
    }

    return '';
  }

  function updateModifyModal(ed) {
    if (!activeModifyBackdrop) return;
    const phase = ed.modifyPhase || 'request';
    activeModifyBackdrop.innerHTML = renderModifyModalContent(ed, phase);
    wireModifyModalEvents(ed, ed.tabId, ed._ui?.getSelectedProfiles);
  }

  function wireModifyModalEvents(ed, tabId, getSelectedProfiles) {
    if (!activeModifyBackdrop) return;
    const bd = activeModifyBackdrop;

    bd.querySelector('#wfc-modify-close')?.addEventListener('click', () => {
      if (!ed.modifying) { closeModifyModal(); ed.modifyPhase = null; }
    });

    bd.querySelector('#wfc-modify-cancel')?.addEventListener('click', () => {
      if (!ed.modifying) { closeModifyModal(); ed.modifyPhase = null; }
    });

    bd.querySelector('#wfc-modify-analyze')?.addEventListener('click', () => {
      const textarea = bd.querySelector('#wfc-modify-textarea');
      const request = textarea?.value?.trim();
      if (!request) return;
      ed.modifyRequest = request;
      ed.modifying = true;
      ed.modifyPhase = 'analyzing';
      updateModifyModal(ed);
      ed._ui?.updateButtonStates?.();
      sendWs({
        type: 'workflow:modify:analyze',
        name: ed.editingName,
        request,
        selectedProfiles: getSelectedProfiles ? getSelectedProfiles() : [],
      });
    });

    bd.querySelector('#wfc-modify-apply')?.addEventListener('click', () => {
      if (!ed.modifyProposal || !ed.modifyRequest) return;
      ed.modifying = true;
      ed.modifyPhase = 'applying';
      updateModifyModal(ed);
      ed._ui?.updateButtonStates?.();
      sendWs({
        type: 'workflow:modify:apply',
        name: ed.editingName,
        request: ed.modifyRequest,
        proposal: ed.modifyProposal,
        selectedProfiles: ed._ui?.getSelectedProfiles ? ed._ui.getSelectedProfiles() : [],
      });
    });

    bd.querySelector('#wfc-modify-back')?.addEventListener('click', () => {
      ed.modifyPhase = 'request';
      ed.modifying = false;
      updateModifyModal(ed);
      ed._ui?.updateButtonStates?.();
    });
  }

  function findActiveCreateTabId() {
    // Find the first editor that exists
    for (const [tabId] of editors) return tabId;
    return null;
  }

  // --- Export ---
  window.workflowModule = {
    handleMessage,
    renderCreateForm,
    getEditor,
    removeEditor,
    hasEditor(tabId) { return editors.has(tabId); },
    openModifyModal,
  };
})();
