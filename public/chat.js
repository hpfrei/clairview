// ============================================================
// CHAT MODULE — Tab-aware Claude chat, ask-user-question, toolbar
// ============================================================
(function chatModule() {
  const { state, escHtml, sendWs } = window.dashboard;

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
    // Remove existing tab buttons (keep the + button)
    tabStrip.querySelectorAll('.chat-tab').forEach(b => b.remove());
    const list = tabList || Array.from(tabs.keys());
    for (const tabId of list) {
      const btn = document.createElement('button');
      btn.className = 'chat-tab' + (tabId === activeTabId ? ' active' : '');
      btn.dataset.tabId = tabId;
      const label = tabId.startsWith('wf-') ? tabId : tabId.replace('tab-', 'Tab ');
      btn.innerHTML = escHtml(label);
      if (tabId !== 'tab-1') {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'chat-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.title = 'Close tab';
        btn.appendChild(closeBtn);
      }
      tabStrip.insertBefore(btn, tabNewBtn);
    }
  }

  tabStrip?.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.chat-tab-close');
    if (closeBtn) {
      e.stopPropagation();
      const tab = closeBtn.closest('.chat-tab');
      const tabId = tab?.dataset.tabId;
      if (tabId && tabId !== 'tab-1') {
        sendWs({ type: 'chat:closeTab', tabId });
        tabs.delete(tabId);
        if (activeTabId === tabId) switchTab('tab-1');
        renderTabStrip();
      }
      return;
    }
    const tabBtn = e.target.closest('.chat-tab');
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
    tabStrip?.querySelectorAll('.chat-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tabId === tabId);
    });
    // Sync shared state
    state.chatCurrentEl = active.currentEl;
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

  function appendChatBubble(text, role, tabId) {
    const tab = tabs.get(tabId || activeTabId);
    const container = tab?.container || chatMessages;
    if (!container) return;
    const welcome = container.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble chat-${role}`;
    bubble.textContent = text;
    container.appendChild(bubble);
    if ((tabId || activeTabId) === activeTabId) chatScrollToBottom();
    return bubble;
  }

  function appendChatText(text, role, tabId) {
    const tid = tabId || activeTabId;
    const tab = tabs.get(tid);
    if (!tab) return;
    if (role === 'assistant' && tab.currentEl) {
      tab.currentEl.textContent += text;
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
        tab.currentEl.textContent += text;
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
        tab.currentEl.textContent = event.result;
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
    // Only update DOM if this is the active tab
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
  const chatCwdInput = document.getElementById('chatCwdInput');
  const chatCwdSetBtn = document.getElementById('chatCwdSetBtn');
  const chatProfileSelect = document.getElementById('chatProfileSelect');

  chatCwdBtn?.addEventListener('click', () => {
    const editing = !chatCwdInput.classList.contains('hidden');
    if (editing) {
      chatCwdInput.classList.add('hidden');
      chatCwdSetBtn.classList.add('hidden');
      chatCwdLabel.classList.remove('hidden');
    } else {
      chatCwdInput.value = chatCwdLabel.textContent || '';
      chatCwdLabel.classList.add('hidden');
      chatCwdInput.classList.remove('hidden');
      chatCwdSetBtn.classList.remove('hidden');
      chatCwdInput.focus();
    }
  });

  chatCwdSetBtn?.addEventListener('click', () => {
    const cwd = chatCwdInput?.value?.trim();
    if (!cwd) return;
    sendWs({ type: 'chat:setCwd', tabId: activeTabId, cwd });
    chatCwdInput.classList.add('hidden');
    chatCwdSetBtn.classList.add('hidden');
    chatCwdLabel.classList.remove('hidden');
  });

  chatCwdInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      chatCwdSetBtn?.click();
    } else if (e.key === 'Escape') {
      chatCwdInput.classList.add('hidden');
      chatCwdSetBtn.classList.add('hidden');
      chatCwdLabel.classList.remove('hidden');
    }
  });

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
      opt.textContent = p.builtin ? p.label : p.label || p.name;
      opt.title = p.description || '';
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
    if (msg.cwd) {
      if (chatCwdLabel) chatCwdLabel.textContent = msg.cwd;
      if (chatCwdInput) chatCwdInput.placeholder = msg.cwd;
    }
    if (msg.profiles) state.profiles = msg.profiles;
    if (msg.knownTools) state.knownTools = msg.knownTools;
    if (msg.knownSkills) state.knownSkills = msg.knownSkills;
    if (msg.hookEvents) state.hookEvents = msg.hookEvents;
    if (msg.matcherEvents) state.matcherEvents = msg.matcherEvents;
    if (msg.mcpServers) state.mcpServers = msg.mcpServers;
    if (msg.capabilities) {
      state.capabilities = msg.capabilities;
      state.activeProfileName = msg.capabilities.name;
    }
    if (msg.capabilities || msg.profiles) {
      renderChatProfileSelect();
    }
  }

  // ============================================================
  // ASK USER QUESTION
  // ============================================================

  function showAskQuestion(toolUseId, questions, tabId) {
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

    let html = '';
    for (let qi = 0; qi < (questions || []).length; qi++) {
      const q = questions[qi];
      const isMulti = !!q.multiSelect;

      if (qi > 0) html += `<div class="chat-question-divider"></div>`;
      if (q.header) {
        html += `<div class="chat-question-header">${escHtml(q.header)}</div>`;
      }
      html += `<div class="chat-question-text">${escHtml(q.question)}</div>`;
      if (isMulti) {
        html += `<div class="chat-question-hint">Select one or more, then submit</div>`;
      }

      if (q.options && q.options.length > 0) {
        html += `<div class="chat-options" data-qi="${qi}" data-multi="${isMulti}">`;
        for (const opt of q.options) {
          html += `<button class="chat-option-btn" data-qi="${qi}" data-label="${escHtml(opt.label)}">`;
          if (isMulti) {
            html += `<span class="chat-option-check"></span>`;
          }
          html += `<span class="chat-option-label">${escHtml(opt.label)}</span>`;
          if (opt.description) {
            html += `<span class="chat-option-desc">${escHtml(opt.description)}</span>`;
          }
          html += `</button>`;
        }
        html += `</div>`;
      }
    }

    const needsSubmit = questions.length > 1 || questions.some(q => q.multiSelect);
    if (needsSubmit) {
      html += `<button class="chat-submit-btn" disabled>Submit</button>`;
    }

    bubble.innerHTML = html;

    const allQuestions = questions || [];
    const submitBtn = bubble.querySelector('.chat-submit-btn');

    function checkSubmitReady() {
      if (!submitBtn) return;
      const allAnswered = allQuestions.every((_, qi) => {
        const sel = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
        return sel.length > 0;
      });
      submitBtn.disabled = !allAnswered;
    }

    bubble.querySelectorAll('.chat-option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const qi = parseInt(btn.dataset.qi);
        const q = allQuestions[qi];
        const isMulti = !!q?.multiSelect;
        const optionsContainer = bubble.querySelector(`.chat-options[data-qi="${qi}"]`);

        if (isMulti) {
          btn.classList.toggle('selected');
        } else {
          optionsContainer.querySelectorAll('.chat-option-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');

          if (!needsSubmit) {
            const answer = [{ question: q.question, answer: btn.dataset.label }];
            sendQuestionAnswer(toolUseId, answer);
            bubble.querySelectorAll('.chat-option-btn').forEach(b => b.disabled = true);
            bubble.classList.add('answered');
            return;
          }
        }

        checkSubmitReady();
      });
    });

    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        const answer = allQuestions.map((q, qi) => {
          const selected = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
          const labels = Array.from(selected).map(b => b.dataset.label);
          return {
            question: q.question,
            answer: q.multiSelect ? labels : labels[0] || '',
          };
        });

        sendQuestionAnswer(toolUseId, answer);
        bubble.querySelectorAll('.chat-option-btn').forEach(b => b.disabled = true);
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitted';
        bubble.classList.add('answered');
      });
    }

    container.appendChild(bubble);
    if (tid === activeTabId) chatScrollToBottom();
  }

  function sendQuestionAnswer(toolUseId, answer) {
    if (state.ws?.readyState === WebSocket.OPEN) {
      sendWs({ type: 'ask:answer', toolUseId, answer });
    }
  }

  function markQuestionAnswered(toolUseId) {
    // Search all tabs for the question bubble
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
        showAskQuestion(msg.toolUseId, msg.questions, tabId);
        break;
      case 'ask:answered':
        markQuestionAnswered(msg.toolUseId);
        break;
      case 'ask:timeout':
        markQuestionTimeout(msg.toolUseId);
        break;
      case 'session:switched':
        resetChatView();
        break;
    }
  }

  function handleTabList(tabList) {
    // Sync local tab map with server's tab list
    for (const t of tabList) {
      if (!tabs.has(t.tabId)) {
        const container = document.createElement('div');
        container.className = 'chat-messages';
        container.innerHTML = welcomeHTML;
        tabs.set(t.tabId, { container, currentEl: null, status: t.status });
      }
    }
    renderTabStrip(tabList.map(t => t.tabId));
  }

  function updateProfiles(profiles) {
    state.profiles = profiles;
    renderChatProfileSelect();
  }

  // --- Export ---
  window.chatModule = { handleMessage, updateProfiles, tabs, switchTab };
})();
