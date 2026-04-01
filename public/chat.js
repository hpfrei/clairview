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
    if (role === 'assistant') {
      bubble.classList.add('markdown-body');
      bubble._rawText = text;
      if (text) window.dashboard.renderMarkdown(text, bubble);
    } else {
      bubble.textContent = text;
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
      html += `<div class="chat-question-text markdown-body">${inlineMd(q.question)}</div>`;
      if (isMulti) {
        html += `<div class="chat-question-hint">Select one or more</div>`;
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
            html += `<span class="chat-option-desc markdown-body">${inlineMd(opt.description)}</span>`;
          }
          html += `</button>`;
        }
        html += `</div>`;
      }

      // Free-text input
      html += `<textarea class="chat-question-textarea" data-qi="${qi}" rows="2" placeholder="Or type your answer here..."></textarea>`;
    }

    // Always show submit
    html += `<button class="chat-submit-btn" disabled>Submit</button>`;

    bubble.innerHTML = html;

    const allQuestions = questions || [];
    const submitBtn = bubble.querySelector('.chat-submit-btn');

    function checkSubmitReady() {
      if (!submitBtn) return;
      const ready = allQuestions.some((_, qi) => {
        const sel = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
        const ta = bubble.querySelector(`.chat-question-textarea[data-qi="${qi}"]`);
        return sel.length > 0 || (ta && ta.value.trim());
      });
      submitBtn.disabled = !ready;
    }

    // Option click: toggle selection (never auto-submit)
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
        }

        checkSubmitReady();
      });
    });

    // Textarea input: enable submit when text entered
    bubble.querySelectorAll('.chat-question-textarea').forEach(ta => {
      ta.addEventListener('input', checkSubmitReady);
    });

    submitBtn.addEventListener('click', () => {
      const answer = allQuestions.map((q, qi) => {
        const ta = bubble.querySelector(`.chat-question-textarea[data-qi="${qi}"]`);
        const freeText = ta?.value?.trim() || '';

        // Free text takes priority if filled
        if (freeText) {
          const selected = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
          const labels = Array.from(selected).map(b => b.dataset.label);
          return {
            question: q.question,
            answer: labels.length > 0 ? `${labels.join(', ')} — ${freeText}` : freeText,
          };
        }

        const selected = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
        const labels = Array.from(selected).map(b => b.dataset.label);
        return {
          question: q.question,
          answer: q.multiSelect ? labels : labels[0] || '',
        };
      });

      sendQuestionAnswer(toolUseId, answer);
      bubble.querySelectorAll('.chat-option-btn').forEach(b => b.disabled = true);
      bubble.querySelectorAll('.chat-question-textarea').forEach(ta => ta.disabled = true);
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitted';
      bubble.classList.add('answered');

      // Show submitted answer
      const answerText = answer.map(a => {
        const val = Array.isArray(a.answer) ? a.answer.join(', ') : a.answer;
        return val;
      }).filter(Boolean).join('; ');
      if (answerText) {
        const answerEl = document.createElement('div');
        answerEl.className = 'chat-question-answer';
        answerEl.textContent = answerText;
        bubble.appendChild(answerEl);
      }
    });

    container.appendChild(bubble);
    // Typeset math in question content
    if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([bubble]).catch(() => {});
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
        if (msg.chatHistory?.length > 0) {
          for (const entry of msg.chatHistory) {
            appendChatBubble(entry.text, entry.role, activeTabId);
          }
        }
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
