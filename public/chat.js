// ============================================================
// CHAT MODULE — Tab-aware Claude chat, ask-user-question, toolbar
// ============================================================
(function chatModule() {
  const { state, escHtml, inlineMd, sendWs, setupCwdToolbar } = window.dashboard;

  // --- Tab state ---
  const tabs = new Map(); // tabId → { container, currentEl, status }
  let activeTabId = 'tab-1';

  // --- DOM refs (shared) ---
  const chatContainer = document.querySelector('#view-claude .chat-container');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const chatStopBtn = document.getElementById('chatStopBtn');
  const welcomeHTML = chatMessages?.querySelector('.chat-welcome')?.outerHTML || '';
  const chatStatusEl = document.getElementById('chatStatus');
  const tabStrip = document.getElementById('chatTabStrip');
  const tabNewBtn = document.getElementById('chatTabNew');

  // --- Files panel ---
  const filesPanel = document.getElementById('chatFilesBar');
  const filesBody = document.getElementById('chatFilesBody');
  const filesList = document.getElementById('chatFilesList');
  const filesCount = document.getElementById('chatFilesCount');
  const filesRefreshBtn = document.getElementById('chatFilesRefresh');
  const filesHandle = document.getElementById('chatFilesHandle');

  const filesHandleBadge = document.getElementById('chatFilesHandleBadge');
  const filesHandleCount = document.getElementById('chatFilesHandleCount');

  const tabFiles = new Map(); // tabId → { cwd, files[] }
  let filesCollapsed = true;

  function renderFilesBar(tabId) {
    const data = tabFiles.get(tabId);
    const count = data?.files?.length || 0;
    if (!count) {
      filesPanel?.classList.add('no-files');
      return;
    }
    filesPanel?.classList.remove('no-files');
    if (filesCount) filesCount.textContent = count;
    if (filesHandleCount) filesHandleCount.textContent = count;
    if (!filesList) return;
    filesList.innerHTML = data.files.map(f => {
      const sizeStr = f.size < 1024 ? f.size + ' B'
        : f.size < 1048576 ? (f.size / 1024).toFixed(1) + ' KB'
        : (f.size / 1048576).toFixed(1) + ' MB';
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const icon = { js: '\u{1F4C4}', json: '\u{1F4CB}', html: '\u{1F310}', css: '\u{1F3A8}', md: '\u{1F4DD}', txt: '\u{1F4C3}', png: '\u{1F5BC}', jpg: '\u{1F5BC}', svg: '\u{1F5BC}' }[ext] || '\u{1F4C4}';
      const href = '/api/file?path=' + encodeURIComponent(f.path);
      return `<a class="chat-files-chip" href="${escHtml(href)}" target="_blank" title="${escHtml(f.path)}">${icon} ${escHtml(f.name)} <span class="chat-files-size">${sizeStr}</span></a>`;
    }).join('');
  }

  filesHandle?.addEventListener('click', () => {
    filesCollapsed = !filesCollapsed;
    filesPanel?.classList.toggle('collapsed', filesCollapsed);
  });

  filesRefreshBtn?.addEventListener('click', () => {
    const data = tabFiles.get(activeTabId);
    const cwd = data?.cwd || '';
    window.dashboard.sendWs({ type: 'files:refresh', tabId: activeTabId, cwd });
  });

  // Register default tab
  if (chatMessages) {
    tabs.set('tab-1', { container: chatMessages, currentEl: null, status: 'idle' });
  }

  let chatAutoScroll = true;

  function getActiveMessages() {
    const tab = tabs.get(activeTabId);
    return tab?.container || chatMessages;
  }

  chatMessages?.addEventListener('scroll', () => {
    const el = chatMessages;
    chatAutoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  });

  function chatScrollToBottom() {
    const el = getActiveMessages();
    if (chatAutoScroll && el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  // --- Tab strip ---

  function renderTabStrip(tabList) {
    if (!tabStrip) return;
    tabStrip.querySelectorAll('.view-tab').forEach(b => b.remove());
    const list = tabList || Array.from(tabs.keys());
    for (const tabId of list) {
      const tab = tabs.get(tabId);
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (tabId === activeTabId ? ' active' : '');
      btn.dataset.tabId = tabId;
      const label = tabId.startsWith('wf-') ? tabId : tabId.replace('tab-', 'Tab ');
      btn.innerHTML = escHtml(label);
      if (tab?.status === 'running') {
        const dot = document.createElement('span');
        dot.className = 'busy-dot';
        dot.style.marginLeft = '6px';
        btn.appendChild(dot);
      }
      if (tabId !== 'tab-1') {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'view-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.title = 'Close tab';
        btn.appendChild(closeBtn);
      }
      tabStrip.insertBefore(btn, tabNewBtn);
    }
  }

  tabStrip?.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.view-tab-close');
    if (closeBtn) {
      e.stopPropagation();
      const tab = closeBtn.closest('.view-tab');
      const tabId = tab?.dataset.tabId;
      if (tabId && tabId !== 'tab-1') {
        sendWs({ type: 'chat:closeTab', tabId });
        tabs.delete(tabId);
        if (activeTabId === tabId) switchTab('tab-1');
        renderTabStrip();
      }
      return;
    }
    const tabBtn = e.target.closest('.view-tab');
    if (tabBtn?.dataset.tabId) {
      switchTab(tabBtn.dataset.tabId);
    }
  });

  tabNewBtn?.addEventListener('click', () => {
    sendWs({ type: 'chat:newTab' });
  });

  function switchTab(tabId) {
    activeTabId = tabId;
    // Ensure tab exists locally
    if (!tabs.has(tabId)) {
      const container = document.createElement('div');
      container.className = 'chat-messages';
      container.innerHTML = welcomeHTML;
      tabs.set(tabId, { container, currentEl: null, status: 'idle' });
    }
    // Swap visible container
    const active = tabs.get(tabId);
    if (chatContainer && active) {
      const existing = chatContainer.querySelector('.chat-messages');
      if (existing && existing !== active.container) {
        chatContainer.replaceChild(active.container, existing);
      }
    }
    // Update status display
    updateChatStatus(active.status);
    // Update tab strip active state
    tabStrip?.querySelectorAll('.view-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tabId === tabId);
    });
    // Sync shared state
    state.chatCurrentEl = active.currentEl;
    // Update files bar for this tab
    renderFilesBar(tabId);
  }

  // --- Send / input ---

  function sendChat() {
    const prompt = chatInput?.value?.trim();
    if (!prompt) return;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    appendChatBubble(prompt, 'user', activeTabId);
    const tab = tabs.get(activeTabId);
    if (tab) tab.currentEl = null;
    state.chatCurrentEl = null;
    sendWs({ type: 'chat:send', tabId: activeTabId, prompt });
    chatInput.value = '';
    chatInput.style.height = 'auto';
  }

  chatSendBtn?.addEventListener('click', sendChat);
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  chatInput?.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
  });

  chatStopBtn?.addEventListener('click', () => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      sendWs({ type: 'chat:stop', tabId: activeTabId });
    }
  });

  // --- Bubbles ---

  function formatTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function appendChatBubble(text, role, tabId) {
    const tab = tabs.get(tabId || activeTabId);
    const container = tab?.container || chatMessages;
    if (!container) return;
    const welcome = container.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble chat-${role}`;
    if (role === 'assistant') {
      bubble.classList.add('markdown-body');
      bubble._rawText = text;
      if (text) window.dashboard.renderMarkdown(text, bubble);
    } else {
      bubble.textContent = text;
    }
    // Add timestamp (skip for step headers — they get their own inline time)
    if (role !== 'workflow-step-header') {
      const timeEl = document.createElement('span');
      timeEl.className = 'chat-time';
      timeEl.textContent = formatTime();
      bubble.appendChild(timeEl);
    }
    container.appendChild(bubble);
    if ((tabId || activeTabId) === activeTabId) chatScrollToBottom();
    return bubble;
  }

  function appendChatText(text, role, tabId) {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (!tab) return;
    if (role === 'assistant' && tab.currentEl) {
      tab.currentEl._rawText = (tab.currentEl._rawText || '') + text;
      window.dashboard.renderMarkdownDebounced(tab.currentEl._rawText, tab.currentEl);
    } else {
      tab.currentEl = appendChatBubble(text, role, tid);
    }
    if (tid === activeTabId) {
      state.chatCurrentEl = tab.currentEl;
      chatScrollToBottom();
    }
  }

  // --- Stream event handling ---

  function handleChatEvent(event, tabId) {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (!tab) return;
    const container = tab.container;
    if (!container) return;

    if (event.type === 'content_block_delta') {
      const text = event.delta?.text || '';
      if (text) {
        if (!tab.currentEl) {
          tab.currentEl = appendChatBubble('', 'assistant', tid);
        }
        tab.currentEl._rawText = (tab.currentEl._rawText || '') + text;
        window.dashboard.renderMarkdownDebounced(tab.currentEl._rawText, tab.currentEl);
        if (tid === activeTabId) {
          state.chatCurrentEl = tab.currentEl;
          chatScrollToBottom();
        }
      }
    } else if (event.type === 'result') {
      if (event.result) {
        if (!tab.currentEl) {
          tab.currentEl = appendChatBubble('', 'assistant', tid);
        }
        tab.currentEl._rawText = event.result;
        window.dashboard.renderMarkdown(event.result, tab.currentEl);
        if (tid === activeTabId) chatScrollToBottom();
      }
      tab.currentEl = null;
      if (tid === activeTabId) state.chatCurrentEl = null;
    } else if (event.type === 'message_stop') {
      tab.currentEl = null;
      if (tid === activeTabId) state.chatCurrentEl = null;
    }
  }

  function updateChatStatus(status, tabId) {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (tab) tab.status = status;
    // Update tab strip busy-dot for this tab
    const tabBtn = tabStrip?.querySelector(`.view-tab[data-tab-id="${tid}"]`);
    if (tabBtn) {
      const existingDot = tabBtn.querySelector('.busy-dot');
      if (status === 'running' && !existingDot) {
        const dot = document.createElement('span');
        dot.className = 'busy-dot';
        dot.style.marginLeft = '6px';
        const closeBtn = tabBtn.querySelector('.view-tab-close');
        tabBtn.insertBefore(dot, closeBtn);
      } else if (status !== 'running' && existingDot) {
        existingDot.remove();
      }
    }
    // Only update input area DOM if this is the active tab
    if (tid === activeTabId) {
      if (chatStatusEl) {
        chatStatusEl.textContent = status;
        chatStatusEl.className = `chat-status ${status}`;
      }
      if (chatStopBtn) {
        chatStopBtn.classList.toggle('hidden', status !== 'running');
      }
      if (chatSendBtn) {
        chatSendBtn.disabled = status === 'running';
      }
    }
  }

  // ============================================================
  // TOOLBAR: PROJECT DIR + PROFILE SELECT
  // ============================================================

  const chatCwdBtn = document.getElementById('chatCwdBtn');
  const chatCwdLabel = document.getElementById('chatCwdLabel');
  const chatProfileSelect = document.getElementById('chatProfileSelect');

  async function openChatDirPicker() {
    const currentLabel = chatCwdLabel?.textContent || '';
    const outputsDir = state.outputsDir || '';
    const relative = currentLabel.startsWith(outputsDir)
      ? currentLabel.slice(outputsDir.length).replace(/^\//, '') : '';
    const picked = await window.dashboard.openDirPicker({ initialPath: relative });
    if (picked !== null) {
      sendWs({ type: 'chat:setCwd', tabId: activeTabId, cwd: picked });
    }
  }
  chatCwdBtn?.addEventListener('click', openChatDirPicker);
  chatCwdLabel?.addEventListener('click', openChatDirPicker);

  chatProfileSelect?.addEventListener('change', (e) => {
    const name = e.target.value;
    if (!name) return;
    sendWs({ type: 'chat:switchProfile', tabId: activeTabId, name });
  });

  function renderChatProfileSelect() {
    if (!chatProfileSelect) return;
    chatProfileSelect.innerHTML = '';
    for (const p of (state.profiles || [])) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      chatProfileSelect.appendChild(opt);
    }
    chatProfileSelect.value = state.activeProfileName || 'full';
    const info = document.getElementById('chatProfileInfo');
    if (info && state.capabilities) {
      const c = state.capabilities;
      const parts = [];
      if (c.model) parts.push(c.model);
      if (c.effort) parts.push(c.effort);
      if (c.permissionMode && c.permissionMode !== 'default') parts.push(c.permissionMode);
      if (c.maxTurns) parts.push(c.maxTurns + ' turns');
      info.textContent = parts.length ? `(${parts.join(', ')})` : '';
    }
  }

  function updateChatSettings(msg) {
    // State sync handled by core.js syncSettings(); just update UI here
    if (msg.cwd) {
      if (chatCwdLabel) chatCwdLabel.textContent = msg.cwd;
    }
    if (msg.capabilities || msg.profiles) {
      renderChatProfileSelect();
    }
  }

  // ============================================================
  // ASK USER QUESTION
  // ============================================================

  function showAskQuestion(toolUseId, questions, tabId, formData) {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    const container = tab?.container || chatMessages;
    if (!container) return;

    const welcome = container.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Auto-switch to Claude tab and correct chat tab
    const claudeTab = document.querySelector('[data-view="claude"]');
    if (claudeTab && !claudeTab.classList.contains('active')) {
      claudeTab.click();
    }
    if (tid !== activeTabId) switchTab(tid);

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-question';
    bubble.dataset.toolUseId = toolUseId;

    // Use enhanced form rendering from core.js
    const fd = formData || { questions: questions || [] };
    bubble.innerHTML = dashboard.askFormBuildHTML(fd) + `<span class="chat-time">${formatTime()}</span>`;

    dashboard.askFormBind(bubble, fd, {
      onSubmit(answer, files) {
        sendQuestionAnswer(toolUseId, answer, files);
        // Show submitted answer summary
        const answerText = answer.map(a => {
          const val = Array.isArray(a.answer) ? a.answer.join(', ') : a.answer;
          return typeof val === 'boolean' ? (val ? 'Yes' : 'No') : val;
        }).filter(v => v !== undefined && v !== null && v !== '').join('; ');
        if (answerText) {
          const answerEl = document.createElement('div');
          answerEl.className = 'chat-question-answer';
          answerEl.textContent = answerText;
          bubble.appendChild(answerEl);
        }
      },
      onCancel() {
        sendQuestionAnswer(toolUseId, { cancelled: true });
        const answerEl = document.createElement('div');
        answerEl.className = 'chat-question-answer chat-question-cancelled';
        answerEl.textContent = 'Cancelled';
        bubble.appendChild(answerEl);
      },
    });

    container.appendChild(bubble);
    if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([bubble]).catch(() => {});
    if (tid === activeTabId) chatScrollToBottom();
  }

  function sendQuestionAnswer(toolUseId, answer, files) {
    if (state.ws?.readyState === WebSocket.OPEN) {
      const msg = { type: 'ask:answer', toolUseId, answer };
      if (files) msg.files = files;
      sendWs(msg);
    }
  }

  function markQuestionAnswered(toolUseId) {
    for (const tab of tabs.values()) {
      const bubble = tab.container?.querySelector(`.chat-question[data-tool-use-id="${toolUseId}"]`);
      if (bubble) { bubble.classList.add('answered'); return; }
    }
  }

  function markQuestionTimeout(toolUseId) {
    for (const tab of tabs.values()) {
      const bubble = tab.container?.querySelector(`.chat-question[data-tool-use-id="${toolUseId}"]`);
      if (bubble) {
        bubble.classList.add('timed-out');
        const notice = document.createElement('div');
        notice.className = 'chat-question-timeout';
        notice.textContent = 'Timed out - error forwarded as-is';
        bubble.appendChild(notice);
        return;
      }
    }
  }

  // --- Session reset ---

  function resetChatView() {
    const tab = tabs.get(activeTabId);
    if (tab?.container) {
      tab.container.innerHTML = welcomeHTML;
      tab.currentEl = null;
    }
    state.chatCurrentEl = null;
    updateChatStatus('idle');
  }

  // --- Message router ---

  function handleMessage(msg) {
    const tabId = msg.tabId || activeTabId;
    // Auto-create tab if unknown (e.g., workflow-spawned)
    if (tabId && !tabs.has(tabId) && msg.type !== 'chat:tabs') {
      const container = document.createElement('div');
      container.className = 'chat-messages';
      tabs.set(tabId, { container, currentEl: null, status: 'idle' });
      renderTabStrip();
    }

    switch (msg.type) {
      case 'chat:event':
        handleChatEvent(msg.event, tabId);
        break;
      case 'chat:output':
        appendChatText(msg.text, msg.role || 'assistant', tabId);
        break;
      case 'chat:error':
        appendChatBubble(msg.text || 'Unknown error', 'error', tabId);
        break;
      case 'chat:status':
        updateChatStatus(msg.status, tabId);
        break;
      case 'chat:settings':
        updateChatSettings(msg);
        break;
      case 'chat:tabs':
        handleTabList(msg.tabs || []);
        break;
      case 'ask:question':
        showAskQuestion(msg.toolUseId, msg.questions, tabId, msg.formData);
        break;
      case 'ask:answered':
        markQuestionAnswered(msg.toolUseId);
        break;
      case 'ask:timeout':
        markQuestionTimeout(msg.toolUseId);
        break;
      case 'files:list': {
        const fTabId = msg.tabId || activeTabId;
        tabFiles.set(fTabId, { cwd: msg.cwd || '', files: msg.files || [] });
        if (fTabId === activeTabId) renderFilesBar(fTabId);
        break;
      }
      case 'session:switched':
        resetChatView();
        if (msg.chatHistory?.length > 0) {
          for (const entry of msg.chatHistory) {
            appendChatBubble(entry.text, entry.role, activeTabId);
          }
        }
        break;

      // Workflow run events (when triggered via MCP from a chat tab)
      case 'workflow:run:started': {
        const stepCount = msg.steps?.length || '?';
        appendChatBubble(`Running workflow: ${msg.name} (${stepCount} steps)`, 'workflow-info', tabId);
        const tab = tabs.get(tabId);
        if (tab) tab.currentEl = null;
        break;
      }
      case 'workflow:step:start': {
        const tab = tabs.get(tabId);
        if (tab) tab.currentEl = null;
        // Create collapsible step header
        const headerEl = appendChatBubble('', 'workflow-step-header', tabId);
        if (headerEl) {
          headerEl.innerHTML = `<span class="chat-step-chevron">\u25be</span> ${escHtml(msg.stepId)} <span class="chat-time">${formatTime()}</span>`;
          headerEl.dataset.stepId = msg.stepId;
          headerEl.addEventListener('click', () => {
            headerEl.classList.toggle('collapsed');
            // Toggle all following step-output siblings until next header
            let next = headerEl.nextElementSibling;
            while (next && !next.classList.contains('chat-workflow-step-header') && !next.classList.contains('chat-workflow-info')) {
              next.classList.toggle('collapsed');
              next = next.nextElementSibling;
            }
          });
        }
        break;
      }
      case 'workflow:step:progress': {
        appendChatText(msg.text || '', 'assistant', tabId);
        // Tag the output bubble so it can be collapsed with the header
        const tab = tabs.get(tabId);
        if (tab?.currentEl && !tab.currentEl.classList.contains('chat-step-output')) {
          tab.currentEl.classList.add('chat-step-output');
        }
        break;
      }
      case 'workflow:step:complete': {
        const tab = tabs.get(tabId);
        if (tab && msg.output) {
          if (tab.currentEl) {
            tab.currentEl._rawText = msg.output;
            window.dashboard.renderMarkdown(msg.output, tab.currentEl);
          } else {
            const el = appendChatBubble('', 'assistant', tabId);
            if (el) {
              el.classList.add('markdown-body', 'chat-step-output');
              el._rawText = msg.output;
              window.dashboard.renderMarkdown(msg.output, el);
            }
          }
        }
        if (tab) tab.currentEl = null;
        break;
      }
      case 'workflow:run:complete': {
        const tab = tabs.get(tabId);
        if (tab) tab.currentEl = null;
        const cls = msg.status === 'completed' ? 'workflow-info' : 'error';
        appendChatBubble(`Workflow ${msg.status}`, cls, tabId);
        break;
      }
      case 'workflow:error':
        appendChatBubble(msg.error || 'Workflow error', 'error', tabId);
        break;
    }
  }

  function handleTabList(tabList) {
    // Detect newly added tabs
    let newTabId = null;
    for (const t of tabList) {
      if (!tabs.has(t.tabId)) {
        const container = document.createElement('div');
        container.className = 'chat-messages';
        container.innerHTML = welcomeHTML;
        tabs.set(t.tabId, { container, currentEl: null, status: t.status });
        newTabId = t.tabId;
      }
    }
    const ids = tabList.map(t => t.tabId);
    if (newTabId) switchTab(newTabId);
    else if (ids.length && !ids.includes(activeTabId)) switchTab(ids[0]);
    renderTabStrip(ids);
  }

  function updateProfiles(profiles) {
    state.profiles = profiles;
    renderChatProfileSelect();
  }

  // --- Export ---
  window.chatModule = { handleMessage, updateProfiles, tabs, switchTab };
})();
