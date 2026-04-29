// ============================================================
// WORKFLOW RUNS MODULE — Run workflows with dedicated UI
// ============================================================
(function workflowRunModule() {
  'use strict';
  const { state, sendWs, escHtml, inlineMd, setupCwdToolbar } = window.dashboard;

  // --- Tab state ---
  const tabs = new Map();
  let activeTabId = 'wfrun-1';
  let nextTabNum = 2;
  let workflows = [];

  function defaultCwd() {
    return state.outputsDir || state.capabilities?.cwd || '';
  }

  function createTabState(tabId) {
    return {
      tabId,
      cwd: defaultCwd(),
      phase: 'pick',       // 'pick' | 'input' | 'active' | 'create'
      tabKind: 'run',      // 'home' | 'edit' | 'run'
      workflowName: null,
      workflowData: null,
      compiledSource: null,
      inputValues: {},
      showEditor: false,
      runId: null,
      steps: [],
      stepOutputs: {},
      pendingQuestion: null,
      answeredQuestions: [],
      finalStatus: null,
      finalOutput: null,
      container: document.createElement('div'),
    };
  }

  // Init default tab (permanent "Workflows" home tab)
  const homeTab = createTabState('wfrun-1');
  homeTab.tabKind = 'home';
  tabs.set('wfrun-1', homeTab);

  // --- DOM refs ---
  const tabStrip = document.getElementById('wfrunTabStrip');
  const container = document.getElementById('wfrunContainer');

  // --- Tab strip ---
  const wfNewBtn = document.getElementById('wfNewBtn');

  function renderTabStrip() {
    if (!tabStrip) return;
    // Remove only tab buttons, preserve static action buttons
    tabStrip.querySelectorAll('.view-tab, .view-tab-new').forEach(el => el.remove());

    const ref = wfNewBtn || null; // insert before the action button
    for (const [id, tab] of tabs) {
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (id === activeTabId ? ' active' : '');
      btn.dataset.tabId = id;
      let label;
      if (tab.tabKind === 'home') {
        label = 'Workflows';
      } else if (tab.tabKind === 'edit') {
        label = tab.workflowName ? tab.workflowName + ' edit' : 'New';
      } else {
        label = tab.workflowName ? tab.workflowName + ' run' : id.replace('wfrun-', 'Run ');
      }
      btn.innerHTML = escHtml(label);
      // Busy-dot on running tabs (active run or editor generating/compiling)
      const ed = window.workflowModule?.getEditor?.(id);
      if ((tab.runId && !tab.finalStatus) || ed?.generating || ed?.compiling) {
        const dot = document.createElement('span');
        dot.className = 'busy-dot';
        btn.appendChild(dot);
      }
      if (tab.tabKind !== 'home') {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'view-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
        btn.appendChild(closeBtn);
      }
      btn.addEventListener('click', () => switchTab(id));
      tabStrip.insertBefore(btn, ref);
    }
  }

  function switchTab(tabId) {
    if (!tabs.has(tabId)) return;
    activeTabId = tabId;
    const tab = tabs.get(tabId);
    renderTabStrip();
    renderPhase();
  }

  function closeTab(tabId) {
    const tabToClose = tabs.get(tabId);
    if (tabToClose?.tabKind === 'home') return; // never close home tab
    if (tabId === activeTabId) {
      activeTabId = 'wfrun-1'; // fall back to home tab
    }
    const tab = tabs.get(tabId);
    if (tab?.runId) {
      sendWs({ type: 'workflow:run:cancel', runId: tab.runId });
    }
    // Clean up editor state if this was a create tab
    window.workflowModule?.removeEditor(tabId);
    tabs.delete(tabId);
    renderTabStrip();
    renderPhase();
  }

  // --- Phase rendering ---
  function renderPhase() {
    const tab = tabs.get(activeTabId);
    if (!tab || !container) return;
    // Edit tabs always render the editor form directly
    if (tab.tabKind === 'edit') { renderCreatePhase(tab); return; }
    switch (tab.phase) {
      case 'pick': renderPickPhase(tab); break;
      case 'input': renderInputPhase(tab); break;
      case 'active': renderActivePhase(tab); break;
      case 'create': renderCreatePhase(tab); break;
    }
  }

  // --- Phase: Create (new/edit workflow) ---
  function renderCreatePhase(tab) {
    window.workflowModule?.renderCreateForm(
      container, tab.tabId,
      tab.workflowData || {
        name: tab.workflowName || '', description: '', inputs: {},
        steps: {
          'step-1': { profile: 'full', do: 'Describe what to do', produces: 'description of output' },
          'done': { do: 'Summarize what was done' },
        },
      },
      tab.compiledSource || null,
      !!tab.workflowName
    );
  }

  // --- Phase: Pick (card grid) ---
  function renderPickPhase(tab) {
    if (workflows.length === 0) {
      container.innerHTML = '<div class="wfrun-empty">No workflows yet. Click <b>+ New</b> to create one.</div>';
      return;
    }
    let html = '<div class="wfrun-card-grid">';
    for (const w of workflows) {
      const statusClass = w.status === 'compiled' ? 'tag-sk' : w.status === 'needs-compile' ? 'tag-wr' : 'tag-ro';
      const statusLabel = w.status === 'compiled' ? 'compiled' : w.status === 'needs-compile' ? 'needs compile' : 'draft';
      html += `<div class="wfrun-card wfrun-card-clickable" data-name="${escHtml(w.name)}">
        <div class="wfrun-card-name">${escHtml(w.name)}</div>
        <div class="wfrun-card-desc">${escHtml(w.description || 'No description')}</div>
        <div class="wfrun-card-meta">${escHtml(w.stepCount || '?')} steps &middot; <span class="ref-tag ${statusClass}">${statusLabel}</span></div>
        <button class="wfrun-card-run" data-name="${escHtml(w.name)}" title="Run workflow">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>
          Run
        </button>
      </div>`;
    }
    html += '</div>';
    container.innerHTML = html;

    // Run button — open a new "run" tab
    container.querySelectorAll('.wfrun-card-run').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        const id = 'wfrun-' + nextTabNum++;
        const t = createTabState(id);
        t.tabKind = 'run';
        t.workflowName = name;
        tabs.set(id, t);
        module.pendingLoad = name;
        sendWs({ type: 'workflow:load', name });
        switchTab(id);
      });
    });
    // Clicking the card itself opens the editor in an edit tab
    container.querySelectorAll('.wfrun-card-clickable').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.wfrun-card-run')) return;
        const name = card.dataset.name;
        const id = 'wfrun-' + nextTabNum++;
        const t = createTabState(id);
        t.tabKind = 'edit';
        t.workflowName = name;
        tabs.set(id, t);
        module.pendingEdit = { tabId: id, name };
        sendWs({ type: 'workflow:load', name });
        switchTab(id);
        renderTabStrip();
      });
    });
  }

  // --- Phase: Input ---
  function renderInputPhase(tab) {
    const wf = tab.workflowData;
    if (!wf) {
      container.innerHTML = '<div class="wfrun-input-panel" style="padding:24px;color:var(--text-dim)">Loading workflow\u2026</div>';
      return;
    }

    const inputs = wf.inputs || {};
    const keys = Object.keys(inputs);

    const cwdDisplay = escHtml(tab.cwd || defaultCwd());
    const cwdRow = `<div class="wfrun-input-cwd" id="wfrunInputCwd" title="Click to change working directory">
      <span class="wfrun-input-cwd-icon">&#128193;</span>
      <span class="wfrun-input-cwd-path">${cwdDisplay}</span>
    </div>`;

    let html = `<div class="wfrun-input-panel">
      <div class="wfrun-input-header">
        <h3>${escHtml(wf.name || tab.workflowName)}</h3>
        <p class="wfrun-input-desc">${escHtml(wf.description || '')}</p>
      </div>`;

    // Typed input fields (text, file)
    if (keys.length > 0) {
      html += '<div class="wfrun-input-fields">';
      for (const key of keys) {
        const rawDesc = inputs[key] || '';
        const isFileInput = typeof rawDesc === 'object' && rawDesc.type === 'file';
        const desc = typeof rawDesc === 'object' ? (rawDesc.description || '') : rawDesc;
        const val = tab.inputValues[key] || '';
        if (isFileInput) {
          const accept = rawDesc.accept || '';
          const multiple = rawDesc.multiple ? 'multiple' : '';
          html += `<div class="wfrun-field">
            <label>${escHtml(key)}</label>
            <div class="wfrun-file-zone" data-key="${escHtml(key)}" title="${escHtml(desc)}">
              <span>${escHtml(desc) || 'Drop file here or click to browse'}</span>
              <input type="file" class="wfrun-file-input" data-key="${escHtml(key)}"
                ${accept ? `accept="${escHtml(accept)}"` : ''} ${multiple} style="display:none">
            </div>
            <div class="wfrun-file-preview" data-key="${escHtml(key)}"></div>
          </div>`;
        } else {
          html += `<div class="wfrun-field">
            <label>${escHtml(key)}</label>
            <input type="text" class="wfrun-field-input" data-key="${escHtml(key)}"
              placeholder="${escHtml(desc)}" value="${escHtml(val)}">
          </div>`;
        }
      }
      html += '</div>';
    }

    // Prompt textarea (always shown, optional)
    const promptVal = tab.inputValues.prompt || '';
    html += `<div class="wfrun-prompt-row">
      <textarea class="wfrun-prompt-input" id="wfrunPromptInput" rows="2"
        placeholder="Prompt (optional)">${escHtml(promptVal)}</textarea>
      <button class="wfrun-run-btn" id="wfrunRun">Run</button>
    </div>`;
    html += `<div class="wfrun-input-actions">
      <button class="wfrun-back-btn" id="wfrunBack">Back</button>
      ${cwdRow}
    </div>`;

    html += '</div>';
    container.innerHTML = html;

    // Back button — switch to Workflows home tab
    container.querySelector('#wfrunBack')?.addEventListener('click', () => {
      switchTab('wfrun-1');
    });

    // Inline directory picker
    container.querySelector('#wfrunInputCwd')?.addEventListener('click', async () => {
      const currentCwd = tab.cwd || defaultCwd();
      const outputsDir = state.outputsDir || '';
      const relative = currentCwd.startsWith(outputsDir)
        ? currentCwd.slice(outputsDir.length).replace(/^\//, '') : '';
      const picked = await window.dashboard.openDirPicker({ initialPath: relative });
      if (picked !== null) {
        tab.cwd = picked;
        const pathEl = container.querySelector('.wfrun-input-cwd-path');
        if (pathEl) pathEl.textContent = picked;
      }
    });

    // File input zones
    if (!tab.inputFiles) tab.inputFiles = {};
    container.querySelectorAll('.wfrun-file-zone').forEach(zone => {
      const key = zone.dataset.key;
      const fileInput = zone.querySelector('.wfrun-file-input');
      const preview = container.querySelector(`.wfrun-file-preview[data-key="${key}"]`);

      zone.addEventListener('click', () => fileInput?.click());
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        readFilesInto(key, e.dataTransfer?.files, preview);
      });
      fileInput?.addEventListener('change', () => {
        readFilesInto(key, fileInput.files, preview);
        fileInput.value = '';
      });
    });

    function readFilesInto(key, fileList, previewEl) {
      if (!fileList || fileList.length === 0) return;
      if (!tab.inputFiles[key]) tab.inputFiles[key] = [];
      let remaining = fileList.length;
      for (const file of fileList) {
        const reader = new FileReader();
        reader.onload = () => {
          tab.inputFiles[key].push({ name: file.name, data: reader.result });
          remaining--;
          if (remaining === 0 && previewEl) {
            previewEl.innerHTML = tab.inputFiles[key]
              .map((f, i) => `<span class="wfrun-file-chip">${escHtml(f.name)} <button data-key="${escHtml(key)}" data-idx="${i}" class="wfrun-file-remove">&times;</button></span>`)
              .join('');
            previewEl.querySelectorAll('.wfrun-file-remove').forEach(btn => {
              btn.addEventListener('click', (e) => {
                e.stopPropagation();
                tab.inputFiles[btn.dataset.key].splice(parseInt(btn.dataset.idx), 1);
                readFilesInto(btn.dataset.key, [], previewEl); // re-render
                previewEl.innerHTML = (tab.inputFiles[btn.dataset.key] || [])
                  .map((f, i) => `<span class="wfrun-file-chip">${escHtml(f.name)} <button data-key="${escHtml(btn.dataset.key)}" data-idx="${i}" class="wfrun-file-remove">&times;</button></span>`)
                  .join('');
              });
            });
          }
        };
        reader.readAsDataURL(file);
      }
    }

    // Run button
    container.querySelector('#wfrunRun')?.addEventListener('click', () => {
      const collected = {};
      container.querySelectorAll('.wfrun-field-input').forEach(inp => {
        collected[inp.dataset.key] = inp.value || inp.placeholder || '';
      });
      const promptVal = container.querySelector('#wfrunPromptInput')?.value?.trim() || '';
      if (promptVal) collected.prompt = promptVal;
      tab.inputValues = collected;
      tab.phase = 'active';
      tab.steps = [];
      tab.stepOutputs = {};
      tab.pendingQuestion = null;
      tab.answeredQuestions = [];
      tab.finalStatus = null;

      const runMsg = {
        type: 'workflow:run',
        name: tab.workflowName,
        inputs: collected,
        cwd: tab.cwd || defaultCwd(),
        tabId: tab.tabId,
      };
      // Include file inputs if any
      if (tab.inputFiles && Object.keys(tab.inputFiles).length > 0) {
        runMsg.files = tab.inputFiles;
      }
      sendWs(runMsg);

      renderPhase();
      renderTabStrip();
    });

    // Enter to run from prompt input
    const promptInput = container.querySelector('#wfrunPromptInput');
    promptInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        container.querySelector('#wfrunRun')?.click();
      }
    });
  }

  // --- Step detail modal ---
  function showStepModal(tab, stepId) {
    // Remove existing modal
    document.querySelector('.wfrun-step-modal-backdrop')?.remove();

    const stepDef = tab.workflowData?.steps?.[stepId];
    const stepJson = stepDef ? JSON.stringify(stepDef, null, 2) : '(step definition not available)';

    // Extract compiled step from source
    let compiledSnippet = '(compiled source not available)';
    if (tab.compiledSource) {
      // Try to find the step block in the compiled JS
      const src = tab.compiledSource;
      // Look for the step object by id in the steps array
      const idPattern = new RegExp(`id:\\s*['"\`]${stepId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
      const match = idPattern.exec(src);
      if (match) {
        // Walk backwards to find the opening { and forwards to find the closing }
        let start = match.index;
        while (start > 0 && src[start] !== '{') start--;
        let depth = 0;
        let end = start;
        for (let i = start; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        compiledSnippet = src.slice(start, end);
        // Try to format it a bit
        try { compiledSnippet = compiledSnippet.trim(); } catch {}
      }
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'wfrun-step-modal-backdrop cap-modal-backdrop';
    backdrop.innerHTML = `
      <div class="wfrun-step-modal cap-modal">
        <div class="cap-modal-header">
          <span>Step: ${escHtml(stepId)}</span>
          <button class="cap-modal-close">\u00d7</button>
        </div>
        <div class="wfrun-step-modal-body">
          <div class="wfrun-step-modal-section">
            <div class="wfrun-step-modal-label">workflow.json</div>
            <pre class="wfrun-step-modal-code">${escHtml(stepJson)}</pre>
          </div>
          <div class="wfrun-step-modal-section">
            <div class="wfrun-step-modal-label">compiled.js</div>
            <pre class="wfrun-step-modal-code">${escHtml(compiledSnippet)}</pre>
          </div>
        </div>
      </div>`;

    document.body.appendChild(backdrop);

    // Close handlers
    backdrop.querySelector('.cap-modal-close').addEventListener('click', () => backdrop.remove());
    const onKey = (e) => { if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }

  // --- Phase: Active (running + complete) ---
  function renderActivePhase(tab) {
    const icons = { pending: '\u25cb', running: '<span class="busy-dot"></span>', done: '\u2713', failed: '\u2717', skipped: '\u2013' };
    let html = '<div class="wfrun-active-panel">';

    // Header
    html += `<div class="wfrun-active-header">
      <span class="wfrun-active-name">${escHtml(tab.workflowName || '')}</span>
      <span class="wfrun-active-status ${tab.finalStatus || 'running'}">${tab.finalStatus || 'running'}</span>`;
    if (!tab.finalStatus) {
      html += `<button class="wfrun-cancel-btn" id="wfrunCancel">Cancel</button>`;
    } else {
      html += `<button class="wfrun-newrun-btn" id="wfrunNewRun">New Run</button>`;
    }
    html += '</div>';

    // Compact step progress tracker
    html += '<div class="wfrun-step-list">';
    for (const s of tab.steps) {
      const icon = icons[s.status] || '\u25cb';
      const elapsed = s.elapsed != null ? (s.elapsed < 1000 ? s.elapsed + 'ms' : (s.elapsed / 1000).toFixed(1) + 's') : '';
      const costStr = s.cost ? `<span class="wfrun-step-cost">${formatCost(s.cost)}</span>` : '';
      const profileTag = s.profile ? `<span class="wfrun-step-profile" data-profile="${escHtml(s.profile)}">${escHtml(s.profile)}</span>` : '';

      html += `<div class="wfrun-step-row ${s.status}" data-step="${escHtml(s.id)}">
        <span class="wfrun-step-icon ${s.status}">${icon}</span>
        <span class="wfrun-step-name" data-step-click="${escHtml(s.id)}">${escHtml(s.id)}</span>
        ${profileTag}
        <span class="wfrun-step-elapsed">${elapsed}</span>
        ${costStr}
      </div>`;
    }
    html += '</div>';

    // Chat flow area — shows all non-pending step outputs
    if (!tab.collapsedSteps) tab.collapsedSteps = new Set();
    html += '<div class="wfrun-chat" id="wfrunChat">';
    for (const s of tab.steps) {
      if (s.status === 'pending') continue;
      const icon = icons[s.status] || '\u25cb';
      const isCollapsed = tab.collapsedSteps.has(s.id);
      const timeStr = formatStepTime(s.startedAt);
      html += `<div class="wfrun-chat-step" data-chat-step="${escHtml(s.id)}">`;
      html += `<div class="wfrun-chat-step-header ${s.status}${isCollapsed ? ' collapsed' : ''}" data-step-toggle="${escHtml(s.id)}">
        <span class="wfrun-chat-step-chevron">\u25be</span>
        <span class="wfrun-chat-step-icon ${s.status}">${icon}</span>
        <span>${escHtml(s.id)}</span>
        <span class="wfrun-chat-step-time">${timeStr}</span>
      </div>`;

      html += `<div class="wfrun-chat-step-body${isCollapsed ? ' collapsed' : ''}">`;
      // Answered questions for this step
      if (tab.answeredQuestions) {
        for (const aq of tab.answeredQuestions.filter(a => a.stepId === s.id)) {
          html += renderAnsweredQuestion(aq);
        }
      }
      // Pending escalation question for this step
      if (tab.pendingQuestion && tab.pendingQuestion.stepId === s.id) {
        html += renderEscalation(tab.pendingQuestion);
      }

      html += `<div class="wfrun-chat-output markdown-body" data-step-output="${escHtml(s.id)}"></div>`;
      html += '</div>'; // close step-body
      html += '</div>'; // close chat-step
    }
    html += '</div>';

    // Result banner
    if (tab.finalStatus) {
      const cls = tab.finalStatus === 'completed' ? 'success' : tab.finalStatus === 'cancelled' ? 'warning' : 'error';
      let totalCost = 0;
      let totalElapsed = 0;
      if (tab.performanceCosts) {
        for (const v of Object.values(tab.performanceCosts)) {
          if (v.cost) totalCost += v.cost;
          if (v.elapsed_seconds) totalElapsed += v.elapsed_seconds;
        }
      }
      const costSuffix = totalCost > 0 ? ` \u00b7 ${formatCost(totalCost)} \u00b7 ${totalElapsed.toFixed(1)}s` : '';
      html += `<div class="wfrun-result-banner ${cls}">
        Workflow ${escHtml(tab.finalStatus)}${tab.errorMessage ? ': ' + escHtml(tab.errorMessage) : ''}${costSuffix}
      </div>`;
    }

    // Final output display
    if (tab.finalOutput) {
      let formatted;
      try {
        const parsed = typeof tab.finalOutput === 'string' ? JSON.parse(tab.finalOutput) : tab.finalOutput;
        formatted = JSON.stringify(parsed, null, 2);
      } catch { formatted = tab.finalOutput; }
      html += `<div class="wfrun-final-output">
        <div class="wfrun-final-output-header">Output<button class="wfrun-final-output-copy" id="wfrunCopyOutput" title="Copy to clipboard">Copy</button></div>
        <pre class="wfrun-final-output-content">${escHtml(formatted)}</pre>
      </div>`;
    }

    html += '</div>';
    container.innerHTML = html;

    // Event: copy output
    container.querySelector('#wfrunCopyOutput')?.addEventListener('click', (e) => {
      const pre = container.querySelector('.wfrun-final-output-content');
      if (pre) {
        navigator.clipboard.writeText(pre.textContent).then(() => {
          e.target.textContent = 'Copied';
          setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
        });
      }
    });

    // Event: step header click — toggle collapse
    container.querySelectorAll('[data-step-toggle]').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const stepId = hdr.dataset.stepToggle;
        if (tab.collapsedSteps.has(stepId)) tab.collapsedSteps.delete(stepId);
        else tab.collapsedSteps.add(stepId);
        hdr.classList.toggle('collapsed');
        const body = hdr.nextElementSibling;
        if (body) body.classList.toggle('collapsed');
      });
    });

    // Event: profile badge click — open profile edit modal
    container.querySelectorAll('.wfrun-step-profile').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = el.dataset.profile;
        if (!name) return;
        const prof = (state.profiles || []).find(p => p.name === name);
        if (prof && window.capabilitiesModule?.openProfileModal) {
          window.capabilitiesModule.openProfileModal(prof, prof.builtin ? 'view' : 'edit');
        }
      });
    });

    // Event: step name click — open step detail modal
    container.querySelectorAll('.wfrun-step-name[data-step-click]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const stepId = el.dataset.stepClick;
        showStepModal(tab, stepId);
      });
    });

    // Event: cancel
    container.querySelector('#wfrunCancel')?.addEventListener('click', () => {
      if (tab.runId) sendWs({ type: 'workflow:run:cancel', runId: tab.runId });
    });

    // Event: new run — switch to Workflows home tab
    container.querySelector('#wfrunNewRun')?.addEventListener('click', () => {
      switchTab('wfrun-1');
    });

    // Event: escalation form interactivity via shared askFormBind
    const escEl = container.querySelector('.wfrun-escalation');
    if (escEl && tab.pendingQuestion) {
      const pq = tab.pendingQuestion;
      const fd = pq.formData || { questions: pq.questions || [] };
      dashboard.askFormBind(escEl, fd, {
        onSubmit(answer, files) {
          const msg = { type: 'ask:answer', toolUseId: pq.toolUseId, answer };
          if (files) msg.files = files;
          sendWs(msg);
          tab.answeredQuestions.push({ stepId: pq.stepId, questions: pq.questions, answer });
          tab.pendingQuestion = null;
          renderActivePhase(tab);
        },
        onCancel() {
          sendWs({ type: 'ask:answer', toolUseId: pq.toolUseId, answer: { cancelled: true } });
          tab.pendingQuestion = null;
          renderActivePhase(tab);
        },
      });
    }

    // Render markdown into all visible step outputs
    container.querySelectorAll('.wfrun-chat-output').forEach(outputEl => {
      const stepId = outputEl.dataset.stepOutput;
      const text = tab.stepOutputs[stepId] || '';
      if (text) {
        window.dashboard.renderMarkdown(text, outputEl);
      }
    });

    // Auto-scroll chat to bottom
    const chatEl = container.querySelector('#wfrunChat');
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderEscalation(pq) {
    const fd = pq.formData || { questions: pq.questions || [] };
    return '<div class="wfrun-escalation">' + dashboard.askFormBuildHTML(fd) + '</div>';
  }

  function renderAnsweredQuestion(aq) {
    let html = '<div class="wfrun-escalation wfrun-answered">';
    for (let qi = 0; qi < (aq.questions || []).length; qi++) {
      const q = aq.questions[qi];
      if (q.header) html += `<div class="wfrun-esc-header">${escHtml(q.header)}</div>`;
      if (q.question) html += `<div class="wfrun-esc-question markdown-body">${inlineMd(q.question)}</div>`;
      const a = aq.answer?.[qi];
      const val = a ? (Array.isArray(a.answer) ? a.answer.join(', ') : a.answer) : '';
      if (val) html += `<div class="wfrun-esc-answer">${escHtml(val)}</div>`;
    }
    html += '</div>';
    return html;
  }

  // --- Message handling ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'workflow:list':
        workflows = msg.workflows || [];
        // Re-render if on pick phase
        const tab = tabs.get(activeTabId);
        if (tab?.phase === 'pick') renderPhase();
        break;

      case 'workflow:renamed': {
        // Update any tab that references the old name
        for (const [id, t] of tabs) {
          if (t.workflowName === msg.oldName) {
            t.workflowName = msg.newName;
            // Update editor state
            const ed = window.workflowModule?.getEditor(id);
            if (ed) ed.editingName = msg.newName;
          }
        }
        renderTabStrip();
        break;
      }

      case 'workflow:loaded': {
        // Check if this is an edit load
        if (module.pendingEdit && module.pendingEdit.name === msg.name) {
          const editTabId = module.pendingEdit.tabId;
          const shouldModify = module.pendingModify;
          module.pendingEdit = null;
          module.pendingModify = false;
          const t = tabs.get(editTabId);
          if (t) {
            t.workflowData = msg.workflow;
            t.compiledSource = msg.compiledSource || null;
            t.showEditor = true;
            if (t.phase !== 'active') t.phase = 'input';
            // Reset editor so it picks up the real workflow data
            window.workflowModule?.removeEditor(editTabId);
            if (editTabId === activeTabId) renderPhase();
            // If triggered from "Modify Workflow" button, open the modify modal
            if (shouldModify) {
              setTimeout(() => {
                const ed = window.workflowModule?.getEditor(editTabId);
                if (ed && ed._ui?.getSelectedProfiles) {
                  window.workflowModule.openModifyModal(ed, editTabId, ed._ui.getSelectedProfiles);
                }
              }, 100);
            }
          }
          break;
        }
        module.pendingLoad = null;
        const t = tabs.get(activeTabId);
        if (t && t.workflowName === msg.name) {
          t.workflowData = msg.workflow;
          t.compiledSource = msg.compiledSource || null;
          if (t.tabKind !== 'home') t.phase = 'input';
          renderPhase();
        }
        break;
      }

      case 'workflow:run:started': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t.runId = msg.runId;
        t.finalStatus = null;
        if (msg.steps) {
          t.steps = msg.steps.map(s => ({ id: s.id, status: s.status || 'pending', elapsed: null, profile: s.profile || null }));
        }
        t.phase = 'active';
        if (msg.tabId === activeTabId) renderActivePhase(t);
        renderTabStrip();
        break;
      }

      case 'workflow:step:start': {
        const t = findTab(msg.tabId);
        if (!t) break;
        updateStep(t, msg.stepId, 'running');
        if (msg.tabId === activeTabId) renderActivePhase(t);
        break;
      }

      case 'workflow:step:progress': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t.stepOutputs[msg.stepId] = (t.stepOutputs[msg.stepId] || '') + (msg.text || '');
        // Update output in the chat flow area (debounced markdown render)
        if (msg.tabId === activeTabId) {
          const outputEl = container.querySelector(`.wfrun-chat-output[data-step-output="${msg.stepId}"]`);
          if (outputEl) {
            window.dashboard.renderMarkdownDebounced(t.stepOutputs[msg.stepId], outputEl);
            const chatEl = container.querySelector('#wfrunChat');
            if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
          }
        }
        break;
      }

      case 'workflow:step:complete': {
        const t = findTab(msg.tabId);
        if (!t) break;
        // If we have no streamed progress text but the complete message has output, use it
        if (msg.output && !t.stepOutputs[msg.stepId]) {
          t.stepOutputs[msg.stepId] = msg.output;
        }
        updateStep(t, msg.stepId, msg.success ? 'done' : 'failed', msg.elapsed, msg.cost);
        if (msg.tabId === activeTabId) renderActivePhase(t);
        break;
      }

      case 'workflow:run:complete': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t.finalStatus = msg.status || 'completed';
        t.finalOutput = msg.output || null;
        t.performanceCosts = msg.performance_costs || null;
        t.runId = null;
        if (msg.tabId === activeTabId) renderActivePhase(t);
        renderTabStrip();
        break;
      }

      case 'workflow:error': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t.finalStatus = 'failed';
        t.runId = null;
        t.errorMessage = msg.error || 'Unknown error';
        if (msg.tabId === activeTabId) renderActivePhase(t);
        renderTabStrip();
        break;
      }

      case 'ask:question': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t.pendingQuestion = {
          toolUseId: msg.toolUseId,
          questions: msg.questions || [],
          formData: msg.formData || { questions: msg.questions || [] },
          stepId: msg.stepId,
        };
        if (msg.tabId === activeTabId) renderActivePhase(t);
        // Switch to runs view and this tab
        const runsTab = document.querySelector('[data-view="workflow-runs"]');
        if (runsTab && !runsTab.classList.contains('active')) runsTab.click();
        if (msg.tabId !== activeTabId) switchTab(msg.tabId);
        break;
      }

      case 'ask:answered': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t.pendingQuestion = null;
        if (msg.tabId === activeTabId) renderActivePhase(t);
        break;
      }

      case 'files:list': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t._files = msg.files || [];
        t._filesCwd = msg.cwd || '';
        if (msg.tabId === activeTabId) renderWfrunFilesBar(t);
        break;
      }
    }
  }

  function findTab(tabId) {
    if (!tabId) return null;
    return tabs.get(tabId) || null;
  }

  function renderWfrunFilesBar(tab) {
    const existing = container.querySelector('.wfrun-files-bar');
    if (!tab._files || !tab._files.length) {
      if (existing) existing.remove();
      return;
    }
    const chips = tab._files.map(f => {
      const sizeStr = f.size < 1024 ? f.size + ' B'
        : f.size < 1048576 ? (f.size / 1024).toFixed(1) + ' KB'
        : (f.size / 1048576).toFixed(1) + ' MB';
      const href = '/api/file?path=' + encodeURIComponent(f.path);
      return `<a class="files-bar-chip" href="${escHtml(href)}" target="_blank" title="${escHtml(f.path)}">${escHtml(f.name)} <span class="files-bar-size">${sizeStr}</span></a>`;
    }).join('');
    const html = `<div class="wfrun-files-bar">
      <div class="files-bar-header">
        <span class="files-bar-title">Files</span>
        <span class="files-bar-count">${tab._files.length}</span>
      </div>
      <div class="files-bar-list">${chips}</div>
    </div>`;
    if (existing) {
      existing.outerHTML = html;
    } else {
      // Insert after header in active panel
      const panel = container.querySelector('.wfrun-active-panel');
      if (panel) {
        const header = panel.querySelector('.wfrun-active-header');
        if (header) header.insertAdjacentHTML('afterend', html);
      }
    }
  }

  function updateStep(tab, stepId, status, elapsed, cost) {
    const step = tab.steps.find(s => s.id === stepId);
    if (step) {
      step.status = status;
      if (elapsed !== undefined) step.elapsed = elapsed;
      if (cost !== undefined) step.cost = cost;
      if (status === 'running' && !step.startedAt) step.startedAt = Date.now();
    }
  }

  function formatStepTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatCost(cost) {
    if (cost == null) return '';
    if (cost < 0.001) return '$' + cost.toFixed(6);
    if (cost < 0.01) return '$' + cost.toFixed(4);
    if (cost < 1) return '$' + cost.toFixed(3);
    return '$' + cost.toFixed(2);
  }

  function handleSettings(msg) {
    const dir = defaultCwd();
    if (dir) {
      for (const [, tab] of tabs) {
        if (!tab.cwd) tab.cwd = dir;
      }
    }
  }

  // --- + New button ---
  wfNewBtn?.addEventListener('click', () => {
    const id = 'wfrun-' + nextTabNum++;
    const t = createTabState(id);
    t.phase = 'create';
    t.tabKind = 'edit';
    tabs.set(id, t);
    switchTab(id);
    renderTabStrip();
  });

  // --- Init ---
  renderTabStrip();
  renderPhase();

  // --- Public API ---
  function startRun(name) {
    const id = 'wfrun-' + nextTabNum++;
    const t = createTabState(id);
    t.tabKind = 'run';
    t.workflowName = name;
    tabs.set(id, t);
    module.pendingLoad = name;
    sendWs({ type: 'workflow:load', name });
    switchTab(id);
  }

  function updateTabLabel(tabId, label) {
    const t = tabs.get(tabId);
    if (t) {
      t.workflowName = label;
      renderTabStrip();
    }
  }

  function getCreateTabId() {
    // Find the active tab with an editor (create phase or inline editor)
    const active = tabs.get(activeTabId);
    if (active?.phase === 'create' || active?.showEditor) return activeTabId;
    for (const [id, t] of tabs) {
      if (t.phase === 'create' || t.showEditor) return id;
    }
    return null;
  }

  // --- Export ---
  const module = { handleMessage, handleSettings, pendingLoad: null, pendingEdit: null, pendingModify: false, startRun, updateTabLabel, getCreateTabId, renderTabStrip };
  window.workflowRunModule = module;
})();
