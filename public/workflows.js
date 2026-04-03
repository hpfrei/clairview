// ============================================================
// WORKFLOW MODULE — Create / edit workflows (renders into tab container)
// ============================================================
(function workflowModule() {
  'use strict';
  const { state, sendWs, escHtml } = window.dashboard;

  // --- Internal state per create-tab (keyed by tabId) ---
  const editors = new Map();

  const INPUT_MODE_HELP = {
    none: 'Runs autonomously. Steps can still use AskUserQuestion, fetch from the web, read files, check git, etc.',
    prompt: 'Shows a prompt input when running. The user\u2019s message is available as {{prompt}} in step instructions.',
  };

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
    const inputMode = workflowData?.inputMode || 'none';
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
            <span class="wfc-label">Input</span>
            <label class="wfc-radio"><input type="radio" name="wfcInputMode-${tabId}" value="none" ${inputMode !== 'prompt' ? 'checked' : ''}> None</label>
            <label class="wfc-radio"><input type="radio" name="wfcInputMode-${tabId}" value="prompt" ${inputMode === 'prompt' ? 'checked' : ''}> Prompt</label>
            <span class="wfc-input-hint" id="wfc-input-hint-${tabId}">${INPUT_MODE_HELP[inputMode] || INPUT_MODE_HELP.none}</span>
          </div>
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
  "inputMode": "none" or "prompt",
  "inputs": {
    "topic": "The topic to process"
  },
  "steps": {
    "step-id": { ... }
  }
}</pre>
              <p class="wf-help-note"><b>inputMode</b>: <code>none</code> (default) runs autonomously. <code>prompt</code> shows a text input when running &mdash; the value is available as <code>{{prompt}}</code> in step instructions.</p>

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
      const busy = ed.generating || ed.compiling;
      const hasName = !!nameEl?.value?.trim();
      const hasDesc = !!descEl?.value?.trim();
      generateBtn.disabled = busy || !hasName || !hasDesc;
      compileBtn.disabled = busy || !hasSourceJson();
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

    // Input mode radios
    container.querySelectorAll(`input[name="wfcInputMode-${tabId}"]`).forEach(radio => {
      radio.addEventListener('change', () => {
        const mode = radio.value;
        const hint = container.querySelector(`#wfc-input-hint-${tabId}`);
        if (hint) hint.textContent = INPUT_MODE_HELP[mode] || INPUT_MODE_HELP.none;
        try {
          const json = JSON.parse(textareaEl?.value || '{}');
          json.inputMode = mode;
          const updated = JSON.stringify(json, null, 2);
          if (textareaEl) textareaEl.value = updated;
          ed.sourceContent = updated;
        } catch {}
      });
    });

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
    ed._ui = { textareaEl, nameEl, descEl, logEl, helpEl, compileBtn, generateBtn, deleteBtn,
               setLog, appendLog, clearLog, updateButtonStates, switchEditorTab };
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
    }
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
  };
})();
