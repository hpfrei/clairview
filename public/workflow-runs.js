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
      phase: 'pick',       // 'pick' | 'input' | 'active'
      workflowName: null,
      workflowData: null,
      compiledSource: null,
      inputValues: {},
      runId: null,
      steps: [],
      stepOutputs: {},
      expandedStepId: null,
      pendingQuestion: null,
      answeredQuestions: [],
      finalStatus: null,
      container: document.createElement('div'),
    };
  }

  // Init default tab
  tabs.set('wfrun-1', createTabState('wfrun-1'));

  // --- DOM refs ---
  const tabStrip = document.getElementById('wfrunTabStrip');
  const tabNewBtn = document.getElementById('wfrunTabNew');
  const cwdBtn = document.getElementById('wfrunCwdBtn');
  const cwdLabel = document.getElementById('wfrunCwdLabel');
  const container = document.getElementById('wfrunContainer');

  // --- Tab strip ---
  function renderTabStrip() {
    if (!tabStrip) return;
    tabStrip.innerHTML = '';
    for (const [id, tab] of tabs) {
      const btn = document.createElement('button');
      btn.className = 'chat-tab' + (id === activeTabId ? ' active' : '');
      btn.dataset.tabId = id;
      const label = tab.workflowName || id.replace('wfrun-', 'Run ');
      btn.innerHTML = escHtml(label);
      if (tabs.size > 1) {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'chat-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
        btn.appendChild(closeBtn);
      }
      btn.addEventListener('click', () => switchTab(id));
      tabStrip.appendChild(btn);
    }
    const newBtn = document.createElement('button');
    newBtn.className = 'chat-tab-new';
    newBtn.title = 'New run tab';
    newBtn.textContent = '+';
    newBtn.addEventListener('click', () => {
      const id = 'wfrun-' + nextTabNum++;
      tabs.set(id, createTabState(id));
      switchTab(id);
      renderTabStrip();
    });
    tabStrip.appendChild(newBtn);
  }

  function switchTab(tabId) {
    if (!tabs.has(tabId)) return;
    activeTabId = tabId;
    const tab = tabs.get(tabId);
    if (cwdLabel) cwdLabel.textContent = tab.cwd || defaultCwd();
    renderTabStrip();
    renderPhase();
  }

  function closeTab(tabId) {
    if (tabId === activeTabId) {
      const keys = [...tabs.keys()];
      const idx = keys.indexOf(tabId);
      const next = keys[idx > 0 ? idx - 1 : idx + 1];
      if (next) activeTabId = next;
    }
    const tab = tabs.get(tabId);
    if (tab?.runId) {
      sendWs({ type: 'workflow:run:cancel', runId: tab.runId });
    }
    tabs.delete(tabId);
    renderTabStrip();
    renderPhase();
  }

  // --- CWD toolbar ---
  async function openWfrunDirPicker() {
    const tab = tabs.get(activeTabId);
    const currentCwd = tab?.cwd || defaultCwd();
    const outputsDir = state.outputsDir || '';
    const relative = currentCwd.startsWith(outputsDir)
      ? currentCwd.slice(outputsDir.length).replace(/^\//, '') : '';
    const picked = await window.dashboard.openDirPicker({ initialPath: relative });
    if (picked !== null) {
      if (tab) tab.cwd = picked;
      if (cwdLabel) cwdLabel.textContent = picked;
    }
  }
  cwdBtn?.addEventListener('click', openWfrunDirPicker);
  cwdLabel?.addEventListener('click', openWfrunDirPicker);

  // --- Phase rendering ---
  function renderPhase() {
    const tab = tabs.get(activeTabId);
    if (!tab || !container) return;
    switch (tab.phase) {
      case 'pick': renderPickPhase(tab); break;
      case 'input': renderInputPhase(tab); break;
      case 'active': renderActivePhase(tab); break;
    }
  }

  // --- Phase: Pick (card grid) ---
  function renderPickPhase(tab) {
    if (workflows.length === 0) {
      container.innerHTML = '<div class="wfrun-empty">No workflows available. Create one in the Workflows tab.</div>';
      return;
    }
    let html = '<div class="wfrun-card-grid">';
    for (const w of workflows) {
      html += `<div class="wfrun-card" data-name="${escHtml(w.name)}">
        <div class="wfrun-card-name">${escHtml(w.name)}</div>
        <div class="wfrun-card-desc">${escHtml(w.description || 'No description')}</div>
        <div class="wfrun-card-meta">${escHtml(w.stepCount || '?')} steps &middot; ${escHtml(w.status || 'draft')}</div>
      </div>`;
    }
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.wfrun-card').forEach(card => {
      card.addEventListener('click', () => {
        const name = card.dataset.name;
        tab.workflowName = name;
        // Request workflow data for input rendering
        module.pendingLoad = name;
        sendWs({ type: 'workflow:load', name });
      });
    });
  }

  // --- Phase: Input ---
  function renderInputPhase(tab) {
    const wf = tab.workflowData;
    if (!wf) return;

    const inputs = wf.inputs || {};
    const keys = Object.keys(inputs);

    let html = `<div class="wfrun-input-panel">
      <div class="wfrun-input-header">
        <h3>${escHtml(wf.name || tab.workflowName)}</h3>
        <p class="wfrun-input-desc">${escHtml(wf.description || '')}</p>
      </div>`;

    if (keys.length > 0) {
      html += '<div class="wfrun-input-fields">';
      for (const key of keys) {
        const desc = inputs[key] || '';
        const val = tab.inputValues[key] || '';
        html += `<div class="wfrun-field">
          <label>${escHtml(key)}</label>
          <input type="text" class="wfrun-field-input" data-key="${escHtml(key)}"
            placeholder="${escHtml(desc)}" value="${escHtml(val)}">
        </div>`;
      }
      html += '</div>';
    } else {
      html += '<p class="wfrun-no-inputs">This workflow has no inputs.</p>';
    }

    html += `<div class="wfrun-input-actions">
      <button class="wfrun-back-btn" id="wfrunBack">Back</button>
      <button class="wfrun-run-btn" id="wfrunRun">Run</button>
    </div></div>`;

    container.innerHTML = html;

    // Back button
    container.querySelector('#wfrunBack')?.addEventListener('click', () => {
      tab.phase = 'pick';
      tab.workflowName = null;
      tab.workflowData = null;
      tab.compiledSource = null;
      renderPhase();
      renderTabStrip();
    });

    // Run button
    container.querySelector('#wfrunRun')?.addEventListener('click', () => {
      const collected = {};
      container.querySelectorAll('.wfrun-field-input').forEach(inp => {
        collected[inp.dataset.key] = inp.value || inp.placeholder || '';
      });
      tab.inputValues = collected;
      tab.phase = 'active';
      tab.steps = [];
      tab.stepOutputs = {};
      tab.expandedStepId = null;
      tab.pendingQuestion = null;
      tab.answeredQuestions = [];
      tab.finalStatus = null;

      sendWs({
        type: 'workflow:run',
        name: tab.workflowName,
        inputs: collected,
        cwd: tab.cwd || defaultCwd(),
        tabId: tab.tabId,
      });

      renderPhase();
      renderTabStrip();
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
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    const onKey = (e) => { if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }

  // --- Phase: Active (running + complete) ---
  function renderActivePhase(tab) {
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

    // Step list
    html += '<div class="wfrun-step-list">';
    for (const s of tab.steps) {
      const icons = { pending: '\u25cb', running: '\u27f3', done: '\u2713', failed: '\u2717', skipped: '\u2013' };
      const icon = icons[s.status] || '\u25cb';
      const expanded = tab.expandedStepId === s.id;
      const elapsed = s.elapsed != null ? (s.elapsed < 1000 ? s.elapsed + 'ms' : (s.elapsed / 1000).toFixed(1) + 's') : '';

      const profileTag = s.profile ? `<span class="wfrun-step-profile" data-profile="${escHtml(s.profile)}">${escHtml(s.profile)}</span>` : '';

      html += `<div class="wfrun-step-row ${s.status}${expanded ? ' expanded' : ''}" data-step="${escHtml(s.id)}">
        <span class="wfrun-step-icon ${s.status}">${icon}</span>
        <span class="wfrun-step-name" data-step-click="${escHtml(s.id)}">${escHtml(s.id)}</span>
        ${profileTag}
        <span class="wfrun-step-elapsed">${elapsed}</span>
        <span class="wfrun-step-toggle">${expanded ? '\u25be' : '\u25b8'}</span>
      </div>`;

      if (expanded) {
        html += `<div class="wfrun-step-detail">`;
        // Show answered questions for this step
        if (tab.answeredQuestions) {
          for (const aq of tab.answeredQuestions.filter(a => a.stepId === s.id)) {
            html += renderAnsweredQuestion(aq);
          }
        }
        // Show pending escalation question for this step
        if (tab.pendingQuestion && tab.pendingQuestion.stepId === s.id) {
          html += renderEscalation(tab.pendingQuestion);
        }
        html += `<div class="wfrun-step-output markdown-body" data-step-output="${escHtml(s.id)}"></div>`;
        html += `</div>`;
      }
    }
    html += '</div>';

    // Result banner
    if (tab.finalStatus) {
      const cls = tab.finalStatus === 'completed' ? 'success' : tab.finalStatus === 'cancelled' ? 'warning' : 'error';
      html += `<div class="wfrun-result-banner ${cls}">
        Workflow ${escHtml(tab.finalStatus)}${tab.errorMessage ? ': ' + escHtml(tab.errorMessage) : ''}
      </div>`;
    }

    html += '</div>';
    container.innerHTML = html;

    // Event: step row click to expand
    container.querySelectorAll('.wfrun-step-row').forEach(row => {
      row.addEventListener('click', () => {
        const stepId = row.dataset.step;
        tab.expandedStepId = tab.expandedStepId === stepId ? null : stepId;
        renderActivePhase(tab);
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

    // Event: new run
    container.querySelector('#wfrunNewRun')?.addEventListener('click', () => {
      tab.phase = 'pick';
      tab.workflowName = null;
      tab.workflowData = null;
      tab.compiledSource = null;
      tab.runId = null;
      tab.steps = [];
      tab.stepOutputs = {};
      tab.finalStatus = null;
      tab.errorMessage = null;
      tab.pendingQuestion = null;
      tab.answeredQuestions = [];
      renderPhase();
      renderTabStrip();
    });

    // Event: escalation option toggle (never auto-submit)
    const escSubmitBtn = container.querySelector('.wfrun-esc-submit');
    function checkEscReady() {
      if (!escSubmitBtn || !tab.pendingQuestion) return;
      const pq = tab.pendingQuestion;
      const ready = (pq.questions || []).some((_, qi) => {
        const sel = container.querySelectorAll(`.wfrun-esc-option.selected[data-qi="${qi}"]`);
        const ta = container.querySelector(`.wfrun-esc-textarea[data-qi="${qi}"]`);
        return sel.length > 0 || (ta && ta.value.trim());
      });
      escSubmitBtn.disabled = !ready;
    }
    container.querySelectorAll('.wfrun-esc-option').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!tab.pendingQuestion) return;
        const qi = btn.dataset.qi;
        // Single-select: deselect others in same group
        container.querySelectorAll(`.wfrun-esc-option[data-qi="${qi}"]`).forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        checkEscReady();
      });
    });
    container.querySelectorAll('.wfrun-esc-textarea').forEach(ta => {
      ta.addEventListener('input', checkEscReady);
    });
    if (escSubmitBtn) {
      escSubmitBtn.addEventListener('click', () => {
        if (!tab.pendingQuestion) return;
        const pq = tab.pendingQuestion;
        const answer = (pq.questions || []).map((q, qi) => {
          const ta = container.querySelector(`.wfrun-esc-textarea[data-qi="${qi}"]`);
          const freeText = ta?.value?.trim() || '';
          if (freeText) {
            const sel = container.querySelectorAll(`.wfrun-esc-option.selected[data-qi="${qi}"]`);
            const labels = Array.from(sel).map(b => b.dataset.label);
            return { question: q?.question || '', answer: labels.length > 0 ? `${labels.join(', ')} — ${freeText}` : freeText };
          }
          const sel = container.querySelectorAll(`.wfrun-esc-option.selected[data-qi="${qi}"]`);
          const labels = Array.from(sel).map(b => b.dataset.label);
          return { question: q?.question || '', answer: labels[0] || '' };
        });
        sendWs({ type: 'ask:answer', toolUseId: pq.toolUseId, answer });
        // Store answered question for display persistence
        tab.answeredQuestions.push({
          stepId: pq.stepId,
          questions: pq.questions,
          answer,
        });
        tab.pendingQuestion = null;
        renderActivePhase(tab);
      });
    }

    // Render markdown into expanded step output
    const outputEl = container.querySelector('.wfrun-step-output');
    if (outputEl) {
      const stepId = outputEl.dataset.stepOutput;
      const text = tab.stepOutputs[stepId] || '';
      window.dashboard.renderMarkdown(text, outputEl);
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  }

  function renderEscalation(pq) {
    let html = '<div class="wfrun-escalation">';
    for (let qi = 0; qi < (pq.questions || []).length; qi++) {
      const q = pq.questions[qi];
      if (q.header) html += `<div class="wfrun-esc-header">${escHtml(q.header)}</div>`;
      if (q.question) html += `<div class="wfrun-esc-question markdown-body">${inlineMd(q.question)}</div>`;
      if (q.options && q.options.length > 0) {
        html += '<div class="wfrun-esc-options">';
        for (const opt of q.options) {
          html += `<button class="wfrun-esc-option" data-qi="${qi}" data-label="${escHtml(opt.label)}">`;
          html += `<span class="wfrun-esc-opt-label">${escHtml(opt.label)}</span>`;
          if (opt.description) html += `<span class="wfrun-esc-opt-desc markdown-body">${inlineMd(opt.description)}</span>`;
          html += `</button>`;
        }
        html += '</div>';
      }
      html += `<textarea class="wfrun-esc-textarea" data-qi="${qi}" rows="2" placeholder="Or type your answer here..."></textarea>`;
    }
    html += `<button class="wfrun-esc-submit" disabled>Submit</button>`;
    html += '</div>';
    return html;
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

      case 'workflow:loaded': {
        module.pendingLoad = null;
        const t = tabs.get(activeTabId);
        if (t && t.workflowName === msg.name) {
          t.workflowData = msg.workflow;
          t.compiledSource = msg.compiledSource || null;
          t.phase = 'input';
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
        break;
      }

      case 'workflow:step:start': {
        const t = findTab(msg.tabId);
        if (!t) break;
        updateStep(t, msg.stepId, 'running');
        // Auto-expand running step
        t.expandedStepId = msg.stepId;
        if (msg.tabId === activeTabId) renderActivePhase(t);
        break;
      }

      case 'workflow:step:progress': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t.stepOutputs[msg.stepId] = (t.stepOutputs[msg.stepId] || '') + (msg.text || '');
        // Update output in place if expanded (debounced markdown render)
        if (msg.tabId === activeTabId && t.expandedStepId === msg.stepId) {
          const outputEl = container.querySelector('.wfrun-step-output');
          if (outputEl) {
            window.dashboard.renderMarkdownDebounced(t.stepOutputs[msg.stepId], outputEl);
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
        updateStep(t, msg.stepId, msg.success ? 'done' : 'failed', msg.elapsed);
        if (msg.tabId === activeTabId) renderActivePhase(t);
        break;
      }

      case 'workflow:run:complete': {
        const t = findTab(msg.tabId);
        if (!t) break;
        t.finalStatus = msg.status || 'completed';
        t.runId = null;
        // Auto-expand last step
        if (t.steps.length > 0) t.expandedStepId = t.steps[t.steps.length - 1].id;
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
          stepId: msg.stepId,
        };
        // Auto-expand the step with the question
        if (msg.stepId) t.expandedStepId = msg.stepId;
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
    }
  }

  function findTab(tabId) {
    if (!tabId) return null;
    return tabs.get(tabId) || null;
  }

  function updateStep(tab, stepId, status, elapsed) {
    const step = tab.steps.find(s => s.id === stepId);
    if (step) {
      step.status = status;
      if (elapsed !== undefined) step.elapsed = elapsed;
    }
  }

  function handleSettings(msg) {
    const dir = defaultCwd();
    if (dir) {
      for (const [, tab] of tabs) {
        if (!tab.cwd) tab.cwd = dir;
      }
      if (cwdLabel && !cwdLabel.textContent) cwdLabel.textContent = dir;
    }
  }

  // --- Init ---
  if (cwdLabel) cwdLabel.textContent = defaultCwd();
  renderTabStrip();
  renderPhase();

  // --- Public API ---
  function startRun(name) {
    const tab = tabs.get(activeTabId);
    if (!tab) return;
    tab.workflowName = name;
    tab.phase = 'pick'; // will transition to input on load
    module.pendingLoad = name;
    sendWs({ type: 'workflow:load', name });
  }

  // --- Export ---
  const module = { handleMessage, handleSettings, pendingLoad: null, startRun };
  window.workflowRunModule = module;
})();
