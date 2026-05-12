(function() {
  'use strict';
  const { state, escHtml, highlightJSON, renderJSON, jsonBlock, formatDuration, truncate,
          renderMarkdown, renderMarkdownDebounced, cancelRenderDebounce, sendWs,
          timelineList, detailContent, emptyState, statsEl } = window.dashboard;

  // --- Auto-select suppression: don't jump away from user-selected turns ---
  let _userPinnedSelection = false;
  let _autoClearInactive = localStorage.getItem('inspectorAutoClear') === '1';

  // --- Subagent registry: track numbering and colors for parallel subagents ---
  const _subagentRegistry = new Map();    // agentId -> { agentType, number, colorIndex }
  const _subagentTypeCounts = new Map();  // agentType -> Map<agentId, number>
  let _subagentColorCounter = 0;
  const SUBAGENT_COLORS = [
    '#7dcfff', // cyan
    '#ff9e64', // orange
    '#bb9af7', // purple
    '#9ece6a', // green
    '#f7768e', // pink
    '#e0af68', // yellow
    '#ff7eb6', // magenta
    '#7aa2f7', // blue
  ];

  function registerSubagent(subagent) {
    if (!subagent?.agentId) return null;
    if (_subagentRegistry.has(subagent.agentId)) return _subagentRegistry.get(subagent.agentId);

    const type = subagent.agentType || 'subagent';
    if (!_subagentTypeCounts.has(type)) _subagentTypeCounts.set(type, new Map());
    const typeMap = _subagentTypeCounts.get(type);
    const number = typeMap.size + 1;
    typeMap.set(subagent.agentId, number);

    const colorIndex = _subagentColorCounter++ % SUBAGENT_COLORS.length;
    const entry = { agentType: type, number, colorIndex };
    _subagentRegistry.set(subagent.agentId, entry);

    if (number === 2) refreshSubagentLabelsForType(type);

    return entry;
  }

  function getSubagentLabel(subagent) {
    if (!subagent?.agentId) return subagent?.agentType || 'subagent';
    const entry = _subagentRegistry.get(subagent.agentId);
    if (!entry) return subagent.agentType || 'subagent';
    const typeMap = _subagentTypeCounts.get(entry.agentType);
    if (typeMap && typeMap.size > 1) return `${entry.agentType} ${entry.number}`;
    return entry.agentType;
  }

  function getSubagentColor(subagent) {
    if (!subagent?.agentId) return SUBAGENT_COLORS[0];
    const entry = _subagentRegistry.get(subagent.agentId);
    if (!entry) return SUBAGENT_COLORS[0];
    return SUBAGENT_COLORS[entry.colorIndex];
  }

  function refreshSubagentLabelsForType(type) {
    const typeMap = _subagentTypeCounts.get(type);
    if (!typeMap) return;
    for (const [agentId, num] of typeMap) {
      const label = typeMap.size > 1 ? `${type} ${num}` : type;
      document.querySelectorAll(`.turn-group[data-agent-id="${agentId}"]`).forEach(group => {
        const badge = group.querySelector('.entry-subagent');
        if (badge) badge.textContent = label;
        group.querySelectorAll('.tag-agent').forEach(tag => { tag.textContent = label; });
      });
    }
  }

  function resetSubagentRegistry() {
    _subagentRegistry.clear();
    _subagentTypeCounts.clear();
    _subagentColorCounter = 0;
  }

  // --- Streaming text block merge state ---
  let _streamBlockMap = new Map();   // index -> { bodyEl, needsSeparator }
  let _lastStreamTextBodyEl = null;
  let _pendingMarkdownBodyEl = null;

  function flushPendingMarkdown() {
    if (_pendingMarkdownBodyEl) {
      cancelRenderDebounce(_pendingMarkdownBodyEl);
      const rawText = _pendingMarkdownBodyEl._rawText || _pendingMarkdownBodyEl.textContent;
      if (rawText) {
        _pendingMarkdownBodyEl.classList.add('markdown-body');
        renderMarkdown(rawText, _pendingMarkdownBodyEl);
      }
      _pendingMarkdownBodyEl = null;
    }
  }

  // --- Instance tabs ---
  const knownInstances = new Map(); // instanceId -> { instanceId, profileName, status, spawnedAt }
  let activeInstanceTab = 'all';
  const inspectorTabStrip = document.getElementById('inspectorTabStrip');

  // --- External session tabs ---
  let extTabCounter = 0;
  let activeExtTab = null; // e.g. 'ext-1'

  function stampExtInteraction(interaction) {
    // Assign null-instanceId interactions to the active ext tab (auto-create if needed)
    if (interaction.instanceId) return;
    if (!activeExtTab) {
      extTabCounter++;
      activeExtTab = `ext-${extTabCounter}`;
      knownInstances.set(activeExtTab, {
        instanceId: activeExtTab, profileName: null,
        status: 'running', spawnedAt: interaction.timestamp || Date.now(), cwd: null,
      });
      renderInspectorTabStrip();
    }
    interaction.instanceId = activeExtTab;
  }

  function cliInstanceLabel(instanceId) {
    const info = knownInstances.get(instanceId);
    const tabId = info?.tabId;
    if (tabId && window.cliModule?.computeTabLabel) {
      const label = window.cliModule.computeTabLabel(tabId);
      if (label && label !== tabId) return label.replace(/^>/, '');
    }
    if (!info?.cwd) return instanceId;
    const parts = info.cwd.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || info.cwd;
  }

  function instanceDisplayLabel(instanceId) {
    if (!instanceId || instanceId === 'all') return 'Others';
    // ext-1 → "Ext 1"
    const extMatch = instanceId.match(/^ext-(\d+)$/);
    if (extMatch) return `Ext ${extMatch[1]}`;
    // chat-tab-1 → "Chat 1"
    const chatMatch = instanceId.match(/^chat-tab-(\d+)$/);
    if (chatMatch) return `Chat ${chatMatch[1]}`;
    // cli-tab-1 → cwd-based label
    if (instanceId.startsWith('cli-')) return cliInstanceLabel(instanceId);
    return instanceId;
  }

  function hasOrphanInteractions() {
    return state.interactions.some(i => !i.instanceId || !knownInstances.has(i.instanceId));
  }

  function renderInspectorTabStrip() {
    if (!inspectorTabStrip) return;
    inspectorTabStrip.innerHTML = '';
    // "Others" tab — only when orphan interactions exist
    const showOthers = false;
    if (showOthers) {
      const allBtn = document.createElement('button');
      allBtn.className = 'view-tab' + (activeInstanceTab === 'all' ? ' active' : '');
      allBtn.dataset.instanceId = 'all';
      allBtn.textContent = 'Others';
      inspectorTabStrip.appendChild(allBtn);
    } else if (activeInstanceTab === 'all' && knownInstances.size > 0) {
      activeInstanceTab = knownInstances.keys().next().value;
    }
    // Per-instance tabs
    for (const [id, info] of knownInstances) {
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (activeInstanceTab === id ? ' active' : '');
      if (info.status === 'exited') btn.classList.add('instance-exited');
      btn.dataset.instanceId = id;
      const label = document.createElement('span');
      label.textContent = instanceDisplayLabel(id);
      if (id.startsWith('cli-')) {
        label.className = 'cli-tab-label';
        label.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeInstanceTab !== id) {
            switchInstanceTab(id);
            return;
          }
          const entry = knownInstances.get(id);
          if (entry?.tabId) {
            switchView('claude');
            window.cliModule?.switchTab?.(entry.tabId);
          }
        });
      }
      btn.appendChild(label);
      const close = document.createElement('span');
      close.className = 'view-tab-close';
      close.textContent = '\u00d7';
      btn.appendChild(close);
      inspectorTabStrip.appendChild(btn);
    }
    // "Clear inactive" button + autoclear checkbox
    const hasExited = [...knownInstances.values()].some(i => i.status === 'exited');

    // Autoclear: if enabled, clear exited instances immediately
    if (hasExited && _autoClearInactive) {
      const exitedIds = [];
      for (const [id, info] of knownInstances) {
        if (info.status === 'exited') exitedIds.push(id);
      }
      for (const id of exitedIds) knownInstances.delete(id);
      if (exitedIds.length) sendWs({ type: 'inspector:clearInstances', instanceIds: exitedIds });
      if (!knownInstances.has(activeInstanceTab)) {
        const fallback = knownInstances.size > 0 ? knownInstances.keys().next().value : 'all';
        activeInstanceTab = fallback;
      }
      // Re-render after autoclear (defer to avoid recursion)
      queueMicrotask(() => renderInspectorTabStrip());
      return;
    }

    if (hasExited) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'view-tab-action';
      clearBtn.title = 'Close all inactive tabs';
      clearBtn.textContent = 'Clear inactive';
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const exitedIds = [];
        for (const [id, info] of knownInstances) {
          if (info.status === 'exited') exitedIds.push(id);
        }
        for (const id of exitedIds) knownInstances.delete(id);
        if (exitedIds.length) sendWs({ type: 'inspector:clearInstances', instanceIds: exitedIds });
        if (!knownInstances.has(activeInstanceTab)) {
          const fallback = knownInstances.size > 0 ? knownInstances.keys().next().value : 'all';
          switchInstanceTab(fallback);
        } else renderInspectorTabStrip();
      });
      inspectorTabStrip.appendChild(clearBtn);
    }

    // Autoclear checkbox — always visible
    const autoLabel = document.createElement('label');
    autoLabel.className = 'tl-autoclear-label';
    autoLabel.innerHTML = `<input type="checkbox" class="tl-autoclear-cb"${_autoClearInactive ? ' checked' : ''}> autoclear`;
    autoLabel.querySelector('input').addEventListener('change', (e) => {
      _autoClearInactive = e.target.checked;
      localStorage.setItem('inspectorAutoClear', _autoClearInactive ? '1' : '0');
      if (_autoClearInactive) renderInspectorTabStrip();
    });
    inspectorTabStrip.appendChild(autoLabel);

    updateStreamingState();
  }

  function switchInstanceTab(instanceId) {
    activeInstanceTab = instanceId;
    renderInspectorTabStrip();
    renderTimelineActive();
    // Select last matching interaction
    const filtered = activeInstanceTab === 'all'
      ? state.interactions.filter(i => !i.instanceId || !knownInstances.has(i.instanceId) )
      : state.interactions.filter(i => i.instanceId === activeInstanceTab);
    const last = filtered[filtered.length - 1];
    if (last) {
      _userPinnedSelection = false;
      select({ type: last.isMcp ? 'mcp' : last.isHook ? 'hook' : 'turn', id: last.id });
    } else {
      state.selection = null;
      document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
  }

  const _faviconLink = document.querySelector('link[rel="icon"]');
  const _faviconNormal = 'favicon.svg';
  const _busyFrames = [0, 5, 0, -5].map(dx => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#cc3344"/><stop offset="25%" stop-color="#c07020"/><stop offset="50%" stop-color="#1a8a3a"/><stop offset="75%" stop-color="#2255aa"/><stop offset="100%" stop-color="#7744bb"/></linearGradient></defs>
  <ellipse cx="32" cy="32" rx="29" ry="18" fill="#fff" stroke="#aaa" stroke-width="1.5"/>
  <circle cx="${32 + dx}" cy="32" r="13" fill="url(#g)"/>
  <circle cx="${32 + dx}" cy="32" r="5.5" fill="#1a1a2e"/>
  <circle cx="${28 + dx}" cy="28" r="2.5" fill="#fff"/>
  <circle cx="53" cy="12" r="11" fill="#22c55e" stroke="#fff" stroke-width="2.5"/>
</svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  });
  let _faviconIsBusy = false;
  let _busyInterval = null;
  let _busyFrame = 0;

  function setFavicon(busy) {
    if (busy === _faviconIsBusy) return;
    _faviconIsBusy = busy;
    if (!_faviconLink) return;
    if (busy) {
      _busyFrame = 0;
      _faviconLink.href = _busyFrames[0];
      _busyInterval = setInterval(() => {
        _busyFrame = (_busyFrame + 1) % 4;
        _faviconLink.href = _busyFrames[_busyFrame];
      }, 250);
    } else {
      clearInterval(_busyInterval);
      _busyInterval = null;
      _faviconLink.href = _faviconNormal;
    }
  }

  function updateStreamingState() {
    const busyInstances = new Set();
    if (inspectorTabStrip) {
      for (const [instanceId] of knownInstances) {
        const tabBtn = inspectorTabStrip.querySelector(`[data-instance-id="${CSS.escape(instanceId)}"]`);
        if (!tabBtn) continue;
        const busy = state.interactions.some(
          i => i.instanceId === instanceId && (i.status === 'pending' || i.status === 'streaming')
        );
        tabBtn.classList.toggle('instance-running', busy);
        if (busy) busyInstances.add(instanceId);
      }
    }
    const inspectorTab = document.querySelector('[data-view="dashboard"]');
    if (inspectorTab) {
      const count = busyInstances.size;
      inspectorTab.classList.toggle('instance-running', count > 0);
      inspectorTab.textContent = 'Inspector';
    }
    setFavicon(busyInstances.size > 0);
    document.title = 'vistaclair';
    window.cliModule?.updateStreamingState?.(busyInstances);
  }

  if (inspectorTabStrip) {
    inspectorTabStrip.addEventListener('click', (e) => {
      // Close button on instance tab
      if (e.target.classList.contains('view-tab-close')) {
        const tabBtn = e.target.closest('.view-tab');
        const id = tabBtn?.dataset.instanceId;
        if (id && id !== 'all') {
          const info = knownInstances.get(id);
          if (info?.status === 'running') {
            // Running instance — confirm before killing
            if (!confirm(`"${instanceDisplayLabel(id)}" is still running.\n\nClosing this tab will terminate the Claude process. Continue?`)) return;
            sendWs({ type: 'claude:killInstance', instanceId: id });
          }
          knownInstances.delete(id);
          sendWs({ type: 'inspector:clearInstances', instanceIds: [id] });
          if (activeInstanceTab === id) {
            const fallback = knownInstances.size > 0 ? knownInstances.keys().next().value
              : hasOrphanInteractions() ? 'all' : 'all';
            switchInstanceTab(fallback);
          } else renderInspectorTabStrip();
        }
        return;
      }
      const tabBtn = e.target.closest('.view-tab');
      if (tabBtn && tabBtn.dataset.instanceId != null) {
        switchInstanceTab(tabBtn.dataset.instanceId);
      }
    });
  }

  // --- cURL export ---
  function buildCurlCommand(interaction) {
    const isTranslated = !!interaction.translatedBody;
    const endpoint = interaction.originalEndpoint || interaction.endpoint || '/v1/messages';
    const url = endpoint.startsWith('http') ? endpoint : `https://api.anthropic.com${endpoint}`;
    const body = isTranslated ? interaction.translatedBody : interaction.request;
    const headers = isTranslated
      ? interaction.translatedHeaders || { 'Content-Type': 'application/json', 'Authorization': 'Bearer $API_KEY' }
      : { 'Content-Type': 'application/json', 'x-api-key': '$ANTHROPIC_API_KEY', 'anthropic-version': '2023-06-01' };

    let cmd = `curl ${url} \\\n`;
    for (const [key, val] of Object.entries(headers)) {
      cmd += `  -H '${key}: ${val}' \\\n`;
    }
    cmd += `  -d '${JSON.stringify(body, null, 2)}'`;
    return cmd;
  }

  function showCurlModal(curlText) {
    // Remove existing modal if any
    document.getElementById('curl-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'curl-modal-overlay';
    overlay.className = 'curl-modal-overlay';
    overlay.innerHTML = `
      <div class="curl-modal">
        <div class="curl-modal-header">
          <span>cURL Command</span>
          <div>
            <button class="curl-modal-copy">Copy</button>
            <button class="curl-modal-close">\u00d7</button>
          </div>
        </div>
        <pre class="curl-modal-body"></pre>
      </div>
    `;
    document.body.appendChild(overlay);

    // Set text content safely (no innerHTML for user data)
    overlay.querySelector('.curl-modal-body').textContent = curlText;

    const close = () => overlay.remove();
    overlay.querySelector('.curl-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.curl-modal-copy').addEventListener('click', (e) => {
      navigator.clipboard.writeText(curlText).then(() => {
        e.target.textContent = 'Copied!';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1400);
      });
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.curl-btn');
    if (!btn) return;
    const id = btn.dataset.interactionId;
    const interaction = state.interactions.find(i => i.id === id);
    if (!interaction) return;
    showCurlModal(buildCurlCommand(interaction));
  });

  // --- Tool call extraction ---
  function extractToolCalls(interaction) {
    const calls = [];
    const resp = interaction.response || {};

    if (interaction.isStreaming && resp.sseEvents?.length) {
      let current = null;
      for (const event of resp.sseEvents) {
        if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
          const cb = event.data.content_block;
          current = {
            blockIndex: event.data.index,
            id: cb.id || '',
            name: cb.name || '',
            inputJson: '',
            input: null,
            status: 'streaming',
          };
          calls.push(current);
        } else if (event.eventType === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta') {
          const match = calls.find(c => c.blockIndex === event.data.index);
          if (match) match.inputJson += event.data.delta.partial_json || '';
        } else if (event.eventType === 'content_block_stop') {
          const match = calls.find(c => c.blockIndex === event.data?.index);
          if (match) {
            match.status = 'complete';
            try { match.input = JSON.parse(match.inputJson); } catch {}
          }
        }
      }
      return calls;
    }

    if (resp.body?.content) {
      for (const block of resp.body.content) {
        if (block.type === 'tool_use') {
          calls.push({
            blockIndex: null,
            id: block.id || '',
            name: block.name || '',
            inputJson: JSON.stringify(block.input || {}),
            input: block.input || {},
            status: 'complete',
          });
        }
      }
    }

    return calls;
  }

  function findToolResult(toolUseId) {
    for (const interaction of state.interactions) {
      const msgs = interaction.request?.messages;
      if (!msgs) continue;
      for (const msg of msgs) {
        if (msg.role !== 'user') continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
            return block;
          }
        }
      }
    }
    return null;
  }

  function isNewUserTurn(interaction) {
    if ((interaction.endpoint || '/v1/messages') !== '/v1/messages') return false;
    const msgs = interaction.request?.messages;
    if (!msgs || msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    if (last.role !== 'user') return false;
    const content = Array.isArray(last.content) ? last.content : [];
    if (content.length === 0) return typeof last.content === 'string';
    return content[content.length - 1]?.type === 'text';
  }

  function toolSummary(name, input) {
    if (!input) return '';
    if (name === 'Skill') return input.args || '';
    if (input.file_path) return input.file_path;
    if (input.command) return input.command;
    if (input.pattern) return input.pattern;
    if (input.query) return input.query;
    if (input.url) return input.url;
    if (input.content) return typeof input.content === 'string' ? input.content : '';
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  }

  // --- SSE event handling ---
  function handleSSEEvent(interactionId, event) {
    const interaction = state.interactions.find(i => i.id === interactionId);
    if (!interaction) return;

    if (!interaction.response) interaction.response = { sseEvents: [] };
    if (!interaction.response.sseEvents) interaction.response.sseEvents = [];
    interaction.response.sseEvents.push(event);

    // Maintain running response char counter for live gauge
    const _evtChars = JSON.stringify(event.data || '').length;
    interaction._respChars = (interaction._respChars || 0) + _evtChars;

    if (event.eventType === 'message_start' && event.data?.message?.usage) {
      interaction.usage = { ...event.data.message.usage };
      updateTurnTokens(interaction);
    }
    if (event.eventType === 'message_delta' && event.data?.usage) {
      interaction.usage = { ...interaction.usage, ...event.data.usage };
      updateTurnTokens(interaction);
    }
    if (event.eventType === 'message_start') {
      interaction.status = 'streaming';
      updateTurnBadge(interactionId, 'streaming');
    }
    if (event.eventType === 'message_stop') {
      interaction.status = 'complete';
      updateTurnBadge(interactionId, 'complete');
    }

    if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
      const cb = event.data.content_block;
      const toolCalls = extractToolCalls(interaction);
      const toolIdx = toolCalls.length - 1;
      appendToolToTimeline(interactionId, toolIdx, cb.name, '');
    }
    if (event.eventType === 'content_block_stop') {
      const toolCalls = extractToolCalls(interaction);
      const match = toolCalls.find(c => c.blockIndex === event.data?.index);
      if (match) {
        const toolIdx = toolCalls.indexOf(match);
        const summaryEl = document.querySelector(`[data-tool-summary="${interactionId}-${toolIdx}"]`);
        if (summaryEl) summaryEl.textContent = toolSummary(match.name, match.input);
        if (match.name === 'Skill' && match.input?.skill) {
          const nameEl = document.querySelector(`[data-tool-name="${interactionId}-${toolIdx}"]`);
          if (nameEl) nameEl.textContent = `/${match.input.skill}`;
          const toolEl = document.querySelector(`[data-tool-id="${interactionId}-${toolIdx}"]`);
          if (toolEl && !toolEl.classList.contains('skill-call')) {
            toolEl.classList.add('skill-call');
            if (nameEl) {
              const tag = document.createElement('span');
              tag.className = 'tool-entry-tag tag-sk';
              tag.textContent = 'skill';
              nameEl.after(tag);
            }
          }
        }
      }
    }

    const sel = state.selection;
    if (sel?.type === 'turn' && sel.id === interactionId) {
      appendSSEToDetail(event, interaction);
    }
  }

  function appendSSEToDetail(event, interaction) {
    const { eventType, data } = event;

    if (eventType === 'message_start') {
      const statusVal = document.getElementById('resp-status');
      if (statusVal) { statusVal.textContent = '200'; statusVal.className = 'info-value status-ok'; }
      if (data?.message?.usage) updateUsageDisplay(data.message.usage, interaction.pricing);
      _streamBlockMap = new Map();
      _lastStreamTextBodyEl = null;
      _pendingMarkdownBodyEl = null;
    }

    if (eventType === 'content_block_start') {
      const block = data?.content_block;
      if (!block) return;
      const container = document.getElementById('response-blocks');
      if (!container) return;

      // Flush pending markdown when a non-text block arrives
      if (block.type !== 'text') {
        flushPendingMarkdown();
        _lastStreamTextBodyEl = null;
      }

      // Merge consecutive text blocks: reuse previous text block's body
      if (block.type === 'text' && _lastStreamTextBodyEl) {
        _streamBlockMap.set(data.index, { bodyEl: _lastStreamTextBodyEl, needsSeparator: true });
        return;
      }

      if (block.type === 'text') {
        // Text blocks: just the body, no container/header
        const body = document.createElement('div');
        body.className = 'content-block-body';
        body.id = `block-body-${data.index}`;
        _lastStreamTextBodyEl = body;
        _streamBlockMap.set(data.index, { bodyEl: body, needsSeparator: false });
        container.appendChild(body);
      } else if (block.type === 'tool_use') {
        // Tool use blocks: just the body, no container/header
        const body = document.createElement('div');
        body.className = 'content-block-body tool-use';
        body.id = `block-body-${data.index}`;
        body.innerHTML = `<div class="tool-name"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>${escHtml(block.name || '')}</div><div class="json-block jt-root" id="tool-input-${data.index}"></div>`;
        container.appendChild(body);
      } else {
        // Other blocks (thinking, etc.): keep container/header
        const blockEl = document.createElement('div');
        blockEl.className = 'content-block';
        blockEl.id = `block-${data.index}`;

        const header = document.createElement('div');
        header.className = 'content-block-header';
        header.textContent = block.type === 'thinking' ? 'Thinking' : block.type;

        const body = document.createElement('div');
        body.className = 'content-block-body';
        body.id = `block-body-${data.index}`;
        if (block.type === 'thinking') body.classList.add('thinking');

        blockEl.appendChild(header);
        blockEl.appendChild(body);
        container.appendChild(blockEl);
      }
    }

    if (eventType === 'content_block_delta') {
      const delta = data?.delta;
      if (!delta) return;

      if (delta.type === 'thinking_delta') {
        const bodyEl = document.getElementById(`block-body-${data.index}`);
        if (!bodyEl) return;
        bodyEl.appendChild(document.createTextNode(delta.thinking || ''));
        bodyEl.scrollTop = bodyEl.scrollHeight;
      } else if (delta.type === 'text_delta') {
        const entry = _streamBlockMap.get(data.index);
        const bodyEl = entry?.bodyEl || document.getElementById(`block-body-${data.index}`);
        if (!bodyEl) return;
        if (entry?.needsSeparator) {
          bodyEl._rawText = (bodyEl._rawText || '') + '\n';
          entry.needsSeparator = false;
        }
        bodyEl._rawText = (bodyEl._rawText || '') + (delta.text || '');
        bodyEl.classList.add('markdown-body');
        renderMarkdownDebounced(bodyEl._rawText, bodyEl);
        bodyEl.scrollTop = bodyEl.scrollHeight;
      } else if (delta.type === 'input_json_delta') {
        const inputEl = document.getElementById(`tool-input-${data.index}`);
        if (inputEl) inputEl.appendChild(document.createTextNode(delta.partial_json || ''));
      }
    }

    if (eventType === 'content_block_stop') {
      const inputEl = document.getElementById(`tool-input-${data.index}`);
      if (inputEl) {
        try {
          const parsed = JSON.parse(inputEl.textContent);
          inputEl.innerHTML = renderJSON(parsed);
        } catch {}
      }
      // Immediate markdown render for completed text blocks; still defer for possible merge
      const entry = _streamBlockMap.get(data.index);
      const bodyEl = entry?.bodyEl || document.getElementById(`block-body-${data.index}`);
      if (bodyEl && !bodyEl.classList.contains('tool-use') && !bodyEl.classList.contains('thinking')) {
        cancelRenderDebounce(bodyEl);
        const rawText = bodyEl._rawText || bodyEl.textContent;
        if (rawText) {
          bodyEl.classList.add('markdown-body');
          renderMarkdown(rawText, bodyEl);
        }
        _pendingMarkdownBodyEl = bodyEl;
      }
    }

    if (eventType === 'message_delta') {
      if (data?.usage) {
        interaction.usage = { ...interaction.usage, ...data.usage };
        updateUsageDisplay(interaction.usage, interaction.pricing);
        updateTurnTokens(interaction);
      }
      if (interaction.timing) {
        interaction.timing.duration = Date.now() - interaction.timing.startedAt;
        const durationEl = document.getElementById('resp-duration');
        if (durationEl) durationEl.textContent = formatDuration(interaction.timing.duration);
      }
    }

    if (eventType === 'message_stop') {
      flushPendingMarkdown();
      _lastStreamTextBodyEl = null;
      if (interaction.timing) {
        const durationEl = document.getElementById('resp-duration');
        if (durationEl) durationEl.textContent = formatDuration(interaction.timing.duration);
      }
      updateTurnBadge(interaction.id, 'complete');
      updateStats();
    }

    // --- Live-update response char gauge ---
    const _gaugeEl = document.getElementById('resp-char-gauge');
    if (_gaugeEl && interaction._respChars) {
      _gaugeEl.innerHTML = charGauge(interaction._respChars);
    }

    // --- Live-update Raw SSE Events section ---
    const _sseDetails = document.getElementById('raw-sse-details');
    if (_sseDetails) {
      _sseDetails.hidden = false;
      const _sseCount = document.getElementById('raw-sse-count');
      if (_sseCount) _sseCount.textContent = interaction.response.sseEvents.length;
      const _ssePre = document.getElementById('raw-sse-pre');
      if (_ssePre) {
        const _evtHtml = `<span class="json-key">event:</span> ${escHtml(event.eventType)}\n<span class="json-string">data:</span> ${escHtml(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))}\n`;
        _ssePre.insertAdjacentHTML('beforeend', '\n' + _evtHtml);
      }
    }
  }

  // --- Interaction update ---
  function updateInteraction(updated) {
    const idx = state.interactions.findIndex(i => i.id === updated.id);
    if (idx >= 0) {
      const localEvents = state.interactions[idx].response?.sseEvents || [];
      const localInstanceId = state.interactions[idx].instanceId;
      const localSubagent = state.interactions[idx].subagent;
      state.interactions[idx] = { ...updated, response: { ...updated.response, sseEvents: localEvents } };
      // Preserve locally-stamped ext instanceId (server sends null for external sessions)
      if (!updated.instanceId && localInstanceId) {
        state.interactions[idx].instanceId = localInstanceId;
      }
      if (localSubagent && !state.interactions[idx].subagent) {
        state.interactions[idx].subagent = localSubagent;
      }
    }

    updateTurnBadge(updated.id, updated.status || 'complete');
    updateTurnMeta(updated);
    updateTurnTokens(state.interactions[idx] || updated);
    rebuildToolEntries(updated.id);
    updateStats();

    const sel = state.selection;
    if (sel?.type === 'turn' && sel.id === updated.id) {
      const ttfbEl = document.getElementById('resp-ttfb');
      const durationEl = document.getElementById('resp-duration');
      if (ttfbEl && updated.timing?.ttfb) ttfbEl.textContent = formatDuration(updated.timing.ttfb);
      if (durationEl && updated.timing?.duration) durationEl.textContent = formatDuration(updated.timing.duration);
      if (updated.usage) updateUsageDisplay(updated.usage, updated.pricing);
    }
  }

  function markInteractionError(id, error) {
    const interaction = state.interactions.find(i => i.id === id);
    if (interaction) {
      interaction.status = 'error';
      interaction.response = interaction.response || {};
      interaction.response.error = error;
    }
    updateTurnBadge(id, 'error');
  }

  // ============================================================
  // TIMELINE RENDERING
  // ============================================================

  function llmTurnNumber(interaction) {
    let n = 0;
    for (const i of state.interactions) {
      if (!i.isMcp && !i.isHook) n++;
      if (i === interaction) return n;
    }
    return n;
  }

  let _lastRenderedAgentId = null;

  // --- Timeline view mode toggle (single column vs parallel columns) ---
  let _timelineMode = localStorage.getItem('timelineMode') || 'single';

  let _allHistoryLoaded = false;

  function initTimelineToggle() {
    const header = document.getElementById('timeline-header');
    if (!header || header.querySelector('.timeline-view-toggle')) return;
    const toggle = document.createElement('div');
    toggle.className = 'timeline-view-toggle';
    const singleSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="3" x2="10" y2="3"/><line x1="2" y1="6" x2="10" y2="6"/><line x1="2" y1="9" x2="10" y2="9"/></svg>`;
    const parallelSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3" y1="2" x2="3" y2="10"/><line x1="6" y1="2" x2="6" y2="10"/><line x1="9" y1="2" x2="9" y2="10"/></svg>`;
    const allSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 2h8v8H2z"/><line x1="2" y1="5" x2="10" y2="5"/><line x1="2" y1="8" x2="10" y2="8"/></svg>`;
    toggle.innerHTML = `
      <span class="tl-view-label">view</span>
      <button class="tl-toggle-btn tl-view-toggle" title="Toggle single / parallel columns">${_timelineMode === 'parallel' ? parallelSvg : singleSvg}</button>
      <button class="tl-toggle-btn tl-load-all-btn${_allHistoryLoaded ? ' active' : ''}" title="Load full history from disk">${allSvg}</button>
    `;
    const viewBtn = toggle.querySelector('.tl-view-toggle');
    viewBtn.addEventListener('click', () => {
      _timelineMode = _timelineMode === 'single' ? 'parallel' : 'single';
      localStorage.setItem('timelineMode', _timelineMode);
      viewBtn.innerHTML = _timelineMode === 'parallel' ? parallelSvg : singleSvg;
      const aside = document.getElementById('timeline');
      if (aside) aside.classList.toggle('parallel-mode', _timelineMode === 'parallel');
      renderTimelineActive();
    });
    toggle.querySelector('.tl-load-all-btn').addEventListener('click', (e) => {
      if (_allHistoryLoaded) return;
      e.currentTarget.style.opacity = '0.5';
      sendWs({ type: 'inspector:loadAll' });
    });
    header.appendChild(toggle);
    const aside = document.getElementById('timeline');
    if (aside) aside.classList.toggle('parallel-mode', _timelineMode === 'parallel');
  }

  function renderTimelineActive() {
    if (_timelineMode === 'parallel') renderTimelineParallel();
    else renderTimeline();
  }

  function renderTimeline() {
    timelineList.innerHTML = '';
    resetSubagentRegistry();
    _lastRenderedAgentId = null;
    let turnNum = 0;
    const subagentTurnCounts = new Map();
    state.interactions.forEach((interaction) => {
      // Apply instance filter
      if (activeInstanceTab === 'all') {
        // "Others" — exclude interactions that belong to a known instance tab (but include dir-spawned)
        if (interaction.instanceId && knownInstances.has(interaction.instanceId)) return;
      } else if (interaction.instanceId !== activeInstanceTab) return;
      if (!interaction.isMcp && !interaction.isHook) {
        const agentId = interaction.subagent?.agentId;
        if (agentId) {
          const n = (subagentTurnCounts.get(agentId) || 0) + 1;
          subagentTurnCounts.set(agentId, n);
          appendTurnToTimeline(interaction, n, true);
        } else {
          turnNum++;
          appendTurnToTimeline(interaction, turnNum, false);
        }
      } else {
        appendTurnToTimeline(interaction);
      }
    });
    updateUserTurnTotals();
  }

  // === PARALLEL TIMELINE (multi-column swimlane view) ===

  let _parallelState = null; // persisted between incremental appends; reset on full re-render

  function resolveHookAgentId(hookInteraction, interactions) {
    if (!hookInteraction.toolUseId) return null;
    for (let i = interactions.length - 1; i >= 0; i--) {
      const turn = interactions[i];
      if (turn.isHook || turn.isMcp) continue;
      if (turn.instanceId !== hookInteraction.instanceId) continue;
      const tools = extractToolCalls(turn);
      if (tools.some(tc => tc.id === hookInteraction.toolUseId)) {
        return turn.subagent?.agentId || null;
      }
    }
    return null;
  }

  function buildColumnAssignment(interactions) {
    const columnFor = new Map();
    const rowFor = new Map();
    const activeColumns = new Map();     // agentId -> colIndex (currently running)
    const historicalColumns = new Map();  // agentId -> colIndex (persists after free)
    const columnAgents = new Map();      // colIndex -> subagent object
    const freeColumns = [];
    let nextColumn = 1;

    // Pass 1: assign columns
    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      let agentId = null;

      if (interaction.isHook) {
        agentId = resolveHookAgentId(interaction, interactions.slice(0, idx));
      } else if (!interaction.isMcp) {
        agentId = interaction.subagent?.agentId || null;
      }

      if (agentId && !activeColumns.has(agentId) && !historicalColumns.has(agentId)) {
        const col = freeColumns.length > 0 ? freeColumns.pop() : nextColumn++;
        activeColumns.set(agentId, col);
        historicalColumns.set(agentId, col);
        if (interaction.subagent) {
          registerSubagent(interaction.subagent);
          columnAgents.set(col, interaction.subagent);
        }
      }

      const resolvedCol = agentId
        ? (activeColumns.get(agentId) || historicalColumns.get(agentId) || 0)
        : 0;
      // Backfill column header info when the first LLM turn with subagent data arrives
      if (resolvedCol > 0 && interaction.subagent && !columnAgents.has(resolvedCol)) {
        registerSubagent(interaction.subagent);
        columnAgents.set(resolvedCol, interaction.subagent);
      }
      columnFor.set(interaction.id, resolvedCol);

      if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
        let closedAgentId = null;
        for (let j = idx - 1; j >= 0; j--) {
          const prev = interactions[j];
          if (prev.isHook || prev.isMcp) continue;
          const aid = prev.subagent?.agentId;
          if (aid && activeColumns.has(aid)) { closedAgentId = aid; break; }
        }
        if (closedAgentId) {
          freeColumns.push(activeColumns.get(closedAgentId));
          activeColumns.delete(closedAgentId);
        }
      }
    }

    const totalColumns = nextColumn;

    // Pass 2: assign rows — parallel-aware
    // Main thread items act as barriers (must come after all prior activity).
    // Subagent items stack within their column, starting where the main thread left off.
    // Items in different non-main columns can share the same row.
    const colNextRow = new Map(); // col -> next available row
    let nextRow = 1;

    for (const interaction of interactions) {
      const col = columnFor.get(interaction.id) || 0;
      let row;

      if (col === 0) {
        // Main thread: barrier — must be after everything
        row = nextRow;
        for (const r of colNextRow.values()) {
          if (r > row) row = r;
        }
      } else {
        // Subagent column: start from where main thread left off, or continue stacking
        row = colNextRow.get(col) || colNextRow.get(0) || nextRow;
      }

      colNextRow.set(col, row + 1);
      if (row + 1 > nextRow) nextRow = row + 1;
      rowFor.set(interaction.id, row);
    }

    const totalRows = nextRow - 1;
    return { columnFor, rowFor, totalColumns, totalRows, columnAgents };
  }

  function buildParallelTurnEl(interaction, turnNum, isSubagentTurn) {
    const group = document.createElement('div');
    group.className = 'turn-group' + (isNewUserTurn(interaction) ? ' new-user-turn' : '');
    group.dataset.turnId = interaction.id;

    if (interaction.subagent?.agentId) {
      registerSubagent(interaction.subagent);
      group.dataset.agentId = interaction.subagent.agentId;
      const color = getSubagentColor(interaction.subagent);
      group.style.setProperty('--subagent-color', color);
    }

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry';
    el.dataset.id = interaction.id;

    const isStandardLlm = !interaction.endpoint || interaction.endpoint === '/v1/messages';
    const statusClass = badgeClass(interaction.status);
    const profile = interaction.profile || '';
    const stepId = interaction.stepId || '';
    const model = interaction.request?.model || 'unknown';
    const shortModel = model.replace('claude-', '').split('-202')[0];
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';

    let modelLabel;
    if (!isStandardLlm) {
      const ep = interaction.endpoint.replace('/v1/messages/', '');
      modelLabel = `<span class="entry-endpoint-label">${escHtml(ep)}</span>`;
    } else {
      modelLabel = profile ? `<span class="entry-profile">${escHtml(profile)}</span> ${escHtml(shortModel)}` : escHtml(shortModel);
    }
    const turnPrefix = isSubagentTurn ? 'Turn S' : 'Turn ';
    const turnLabel = stepId ? `${turnPrefix}${turnNum} <span class="entry-step">${escHtml(stepId)}</span>` : `${turnPrefix}${turnNum}`;
    const tokenSummary = compactTokens(interaction.usage);
    const cost = computeCost(interaction.usage, interaction.pricing);
    const costHtml = turnCostGauge(cost);

    el.innerHTML = `
      <div class="entry-header">
        <span class="entry-num">${turnLabel}</span>
        <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${interaction.status || 'pending'}</span>
      </div>
      <div class="entry-model" data-model="${interaction.id}">
        <span class="entry-model-label">${modelLabel}</span>
        <span class="entry-duration" data-duration="${interaction.id}">${durationHtml}</span>
      </div>
      <div class="entry-meta" data-tokens="${interaction.id}">
        <span class="entry-tokens" data-tokenlabel="${interaction.id}">${tokenSummary}</span>
        <span class="entry-cost" data-costgauge="${interaction.id}">${costHtml}</span>
      </div>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = { type: 'turn', id: interaction.id };
      if (isAlreadySelected(sel)) { selectLastAndFollow(); return; }
      _userPinnedSelection = true;
      select(sel);
    });

    group.appendChild(el);

    const toolsContainer = document.createElement('div');
    toolsContainer.className = 'tool-entries';
    toolsContainer.dataset.toolsFor = interaction.id;
    group.appendChild(toolsContainer);

    const toolCalls = extractToolCalls(interaction);
    toolCalls.forEach((tc, tIdx) => {
      const toolEl = createToolEntryEl(interaction.id, tIdx, tc.name, toolSummary(tc.name, tc.input), tc.input, interaction.subagent);
      toolsContainer.appendChild(toolEl);
    });

    if (interaction.status === 'pending' || interaction.status === 'streaming') {
      startDurationTimer(interaction);
    }

    return group;
  }

  function buildParallelHookEl(interaction) {
    const hookEvent = interaction.hookEvent || 'Hook';
    const toolName = interaction.toolName || '';
    const arrow = /post/i.test(hookEvent) ? '←' : '→';

    const group = document.createElement('div');
    group.className = 'turn-group hook-call-group';
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry hook-call-entry';
    el.dataset.id = interaction.id;

    el.innerHTML = `
      <span class="hook-arrow">${arrow}</span>
      <span class="hook-label">${escHtml(hookEvent)}</span>
      <span class="hook-tool-name">${escHtml(toolName)}</span>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = { type: 'turn', id: interaction.id };
      if (isAlreadySelected(sel)) { selectLastAndFollow(); return; }
      _userPinnedSelection = true;
      select(sel);
    });

    group.appendChild(el);
    return group;
  }

  function buildParallelMcpEl(interaction) {
    const group = document.createElement('div');
    group.className = 'turn-group mcp-call-group';
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry mcp-call-entry';
    el.dataset.id = interaction.id;

    const toolName = interaction.request?.tool || 'unknown';
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';
    const isError = interaction.status === 'error';
    const source = interaction.mcpSource === 'claude-code' ? 'claude' : 'test';

    el.innerHTML = `
      <div class="entry-header">
        <span class="entry-num mcp-label">MCP</span>
        <span class="entry-badge ${isError ? 'error' : 'complete'}">${isError ? 'error' : 'ok'}</span>
      </div>
      <div class="entry-model mcp-tool-name">${escHtml(toolName)}</div>
      <div class="entry-meta">
        <span class="mcp-source-tag mcp-src-${source}">${source}</span>
        <span>${durationHtml}</span>
      </div>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = { type: 'turn', id: interaction.id };
      if (isAlreadySelected(sel)) { selectLastAndFollow(); return; }
      _userPinnedSelection = true;
      select(sel);
    });

    group.appendChild(el);
    return group;
  }

  function renderTimelineParallel() {
    timelineList.innerHTML = '';
    resetSubagentRegistry();

    const filtered = state.interactions.filter(i => isVisibleInTimeline(i));
    const { columnFor, rowFor, totalColumns, totalRows, columnAgents } = buildColumnAssignment(filtered);

    // Sticky column headers
    const headerRow = document.createElement('div');
    headerRow.className = 'parallel-timeline-headers';
    for (let col = 0; col < totalColumns; col++) {
      const header = document.createElement('div');
      header.className = 'parallel-column-header';
      const agentInfo = columnAgents.get(col);
      if (col === 0) {
        header.textContent = 'Main Thread';
      } else if (agentInfo) {
        const label = getSubagentLabel(agentInfo);
        const color = getSubagentColor(agentInfo);
        header.textContent = label;
        if (color) {
          header.style.color = color;
          header.style.borderBottomColor = color;
        }
      } else {
        header.textContent = `Agent ${col}`;
      }
      headerRow.appendChild(header);
    }
    timelineList.appendChild(headerRow);

    // CSS Grid: rows assigned by parallel-aware algorithm
    const grid = document.createElement('div');
    grid.className = 'parallel-timeline-grid';
    grid.style.gridTemplateColumns = `repeat(${totalColumns}, 260px)`;

    let turnNum = 0;
    const subagentTurnCounts = new Map();

    for (const interaction of filtered) {
      const col = columnFor.get(interaction.id) || 0;
      const row = rowFor.get(interaction.id) || 1;
      let el;

      if (interaction.isMcp) {
        el = buildParallelMcpEl(interaction);
      } else if (interaction.isHook) {
        el = buildParallelHookEl(interaction);
      } else {
        const agentId = interaction.subagent?.agentId;
        let num, isSub;
        if (agentId) {
          const n = (subagentTurnCounts.get(agentId) || 0) + 1;
          subagentTurnCounts.set(agentId, n);
          num = n;
          isSub = true;
        } else {
          turnNum++;
          num = turnNum;
          isSub = false;
        }
        el = buildParallelTurnEl(interaction, num, isSub);
      }

      el.style.gridRow = row;
      el.style.gridColumn = col + 1;
      grid.appendChild(el);
    }

    // Column separators spanning all rows
    for (let col = 0; col < totalColumns - 1; col++) {
      const sep = document.createElement('div');
      sep.className = 'parallel-grid-separator';
      sep.style.gridColumn = col + 1;
      sep.style.gridRow = `1 / ${(totalRows || 1) + 1}`;
      grid.appendChild(sep);
    }

    timelineList.appendChild(grid);

    // Save state for incremental appends
    _parallelState = { columnFor, rowFor, columnAgents, grid, headerRow, turnNum, subagentTurnCounts,
      totalColumns, totalRows,
      activeColumns: new Map(), historicalColumns: new Map(),
      freeColumns: [], nextColumn: totalColumns,
      colNextRow: new Map(), nextRowCounter: (totalRows || 0) + 1 };
    // Rebuild active/historical columns from the assignment
    for (const interaction of filtered) {
      const agentId = interaction.subagent?.agentId;
      if (agentId) {
        const col = columnFor.get(interaction.id);
        if (col > 0) {
          _parallelState.activeColumns.set(agentId, col);
          _parallelState.historicalColumns.set(agentId, col);
        }
      }
      if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
        for (let j = filtered.indexOf(interaction) - 1; j >= 0; j--) {
          const prev = filtered[j];
          if (prev.isHook || prev.isMcp) continue;
          const aid = prev.subagent?.agentId;
          if (aid && _parallelState.activeColumns.has(aid)) {
            _parallelState.freeColumns.push(_parallelState.activeColumns.get(aid));
            _parallelState.activeColumns.delete(aid);
            break;
          }
        }
      }
    }
    // Seed colNextRow from rowFor
    for (const interaction of filtered) {
      const col = columnFor.get(interaction.id) || 0;
      const row = rowFor.get(interaction.id) || 1;
      _parallelState.colNextRow.set(col, Math.max(_parallelState.colNextRow.get(col) || 0, row + 1));
    }
  }

  function appendToParallelTimeline(interaction) {
    if (!_parallelState) {
      renderTimelineParallel();
      return;
    }
    const ps = _parallelState;

    // Determine column for this interaction
    let agentId = null;
    if (interaction.isHook) {
      agentId = resolveHookAgentId(interaction, state.interactions);
    } else if (!interaction.isMcp) {
      agentId = interaction.subagent?.agentId || null;
    }

    let col = 0;
    if (agentId) {
      if (!ps.activeColumns.has(agentId) && !ps.historicalColumns.has(agentId)) {
        col = ps.freeColumns.length > 0 ? ps.freeColumns.pop() : ps.nextColumn++;
        ps.activeColumns.set(agentId, col);
        ps.historicalColumns.set(agentId, col);
        // Expand grid and add header if this is a new column
        if (col >= ps.totalColumns) {
          ps.totalColumns = col + 1;
          ps.grid.style.gridTemplateColumns = `repeat(${ps.totalColumns}, 260px)`;
          const header = document.createElement('div');
          header.className = 'parallel-column-header';
          if (interaction.subagent) {
            registerSubagent(interaction.subagent);
            const label = getSubagentLabel(interaction.subagent);
            const color = getSubagentColor(interaction.subagent);
            header.textContent = label;
            if (color) { header.style.color = color; header.style.borderBottomColor = color; }
            ps.columnAgents.set(col, interaction.subagent);
          } else {
            header.textContent = `Agent ${col}`;
          }
          ps.headerRow.appendChild(header);
        }
      }
      col = ps.activeColumns.get(agentId) || ps.historicalColumns.get(agentId) || 0;
    }

    // Build element
    let el;
    if (interaction.isMcp) {
      el = buildParallelMcpEl(interaction);
    } else if (interaction.isHook) {
      el = buildParallelHookEl(interaction);
    } else {
      if (agentId) {
        const n = (ps.subagentTurnCounts.get(agentId) || 0) + 1;
        ps.subagentTurnCounts.set(agentId, n);
        el = buildParallelTurnEl(interaction, n, true);
      } else {
        ps.turnNum++;
        el = buildParallelTurnEl(interaction, ps.turnNum, false);
      }
    }

    // Parallel-aware row assignment
    let row;
    if (col === 0) {
      row = ps.nextRowCounter;
      for (const r of ps.colNextRow.values()) {
        if (r > row) row = r;
      }
    } else {
      row = ps.colNextRow.get(col) || ps.colNextRow.get(0) || ps.nextRowCounter;
    }
    ps.colNextRow.set(col, row + 1);
    if (row + 1 > ps.nextRowCounter) ps.nextRowCounter = row + 1;
    ps.totalRows = Math.max(ps.totalRows, row);

    el.style.gridRow = row;
    el.style.gridColumn = col + 1;
    ps.grid.appendChild(el);

    // Extend column separators
    ps.grid.querySelectorAll('.parallel-grid-separator').forEach(sep => {
      sep.style.gridRow = `1 / ${ps.totalRows + 1}`;
    });

    ps.columnFor.set(interaction.id, col);
    ps.rowFor.set(interaction.id, row);

    // Check if this hook closes a subagent column
    if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
      for (let j = state.interactions.length - 2; j >= 0; j--) {
        const prev = state.interactions[j];
        if (prev.isHook || prev.isMcp) continue;
        const aid = prev.subagent?.agentId;
        if (aid && ps.activeColumns.has(aid)) {
          ps.freeColumns.push(ps.activeColumns.get(aid));
          ps.activeColumns.delete(aid);
          break;
        }
      }
    }
  }

  // === END PARALLEL TIMELINE ===

  function appendTurnToTimeline(interaction, turnNum, isSubagentTurn) {
    if (turnNum === undefined) turnNum = llmTurnNumber(interaction);

    if (interaction.isMcp) {
      return appendMcpCallToTimeline(interaction);
    }
    if (interaction.isHook) {
      return appendHookEntryToTimeline(interaction);
    }

    const group = document.createElement('div');
    let groupClass = 'turn-group' + (isNewUserTurn(interaction) ? ' new-user-turn' : '');
    if (interaction.subagent?.isSidechain) groupClass += ' sidechain-group';
    else if (interaction.subagent?.agentType) groupClass += ' subagent-group';
    group.className = groupClass;
    group.dataset.turnId = interaction.id;

    const currentAgentId = interaction.subagent?.agentId || null;
    if (interaction.subagent?.agentId) {
      registerSubagent(interaction.subagent);
      group.dataset.agentId = interaction.subagent.agentId;
      const color = getSubagentColor(interaction.subagent);
      group.style.setProperty('--subagent-color', color);
      if (currentAgentId !== _lastRenderedAgentId) {
        group.style.borderTop = `2px solid ${color}`;
      }
    } else if (_lastRenderedAgentId !== null && currentAgentId === null) {
      group.style.borderTop = '2px solid var(--border)';
    }
    _lastRenderedAgentId = currentAgentId;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry';
    el.dataset.id = interaction.id;

    const isStandardLlm = !interaction.endpoint || interaction.endpoint === '/v1/messages';
    const statusClass = badgeClass(interaction.status);
    const profile = interaction.profile || '';
    const stepId = interaction.stepId || '';
    const model = interaction.request?.model || 'unknown';
    const shortModel = model.replace('claude-', '').split('-202')[0];
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';

    let modelLabel;
    if (!isStandardLlm) {
      const ep = interaction.endpoint.replace('/v1/messages/', '');
      modelLabel = `<span class="entry-endpoint-label">${escHtml(ep)}</span>`;
    } else {
      modelLabel = profile ? `<span class="entry-profile">${escHtml(profile)}</span> ${escHtml(shortModel)}` : escHtml(shortModel);
    }
    const turnPrefix = isSubagentTurn ? 'Turn S' : 'Turn ';
    const turnLabel = stepId ? `${turnPrefix}${turnNum} <span class="entry-step">${escHtml(stepId)}</span>` : `${turnPrefix}${turnNum}`;
    const instanceTag = (activeInstanceTab === 'all' && interaction.instanceId)
      ? `<span class="entry-instance">${escHtml(instanceDisplayLabel(interaction.instanceId))}</span>` : '';
    const subagentLabel = interaction.subagent ? getSubagentLabel(interaction.subagent) : '';
    const subagentColor = interaction.subagent?.agentId ? getSubagentColor(interaction.subagent) : '';
    const subagentTag = (interaction.subagent && (interaction.subagent.agentType || interaction.subagent.agentId || interaction.subagent.description))
      ? `<span class="entry-subagent" title="${escHtml(interaction.subagent.description || '')}"${subagentColor ? ` style="color:${subagentColor};background:color-mix(in srgb, ${subagentColor} 12%, transparent)"` : ''}>${escHtml(subagentLabel)}</span>`
      : '';
    const tokenSummary = compactTokens(interaction.usage);
    const cost = computeCost(interaction.usage, interaction.pricing);
    const costHtml = turnCostGauge(cost);

    el.innerHTML = `
      <div class="entry-header">
        <span class="entry-num">${turnLabel}</span>
        <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${interaction.status || 'pending'}</span>
        ${subagentTag}
        ${instanceTag}
      </div>
      <div class="entry-model" data-model="${interaction.id}">
        <span class="entry-model-label">${modelLabel}</span>
        <span class="entry-duration" data-duration="${interaction.id}">${durationHtml}</span>
      </div>
      <div class="entry-meta" data-tokens="${interaction.id}">
        <span class="entry-tokens" data-tokenlabel="${interaction.id}">${tokenSummary}</span>
        <span class="entry-cost" data-costgauge="${interaction.id}">${costHtml}</span>
      </div>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = { type: 'turn', id: interaction.id };
      if (isAlreadySelected(sel)) { selectLastAndFollow(); return; }
      _userPinnedSelection = true;
      select(sel);
    });

    group.appendChild(el);

    const toolsContainer = document.createElement('div');
    toolsContainer.className = 'tool-entries';
    toolsContainer.dataset.toolsFor = interaction.id;
    group.appendChild(toolsContainer);

    const toolCalls = extractToolCalls(interaction);
    toolCalls.forEach((tc, tIdx) => {
      const toolEl = createToolEntryEl(interaction.id, tIdx, tc.name, toolSummary(tc.name, tc.input), tc.input, interaction.subagent);
      toolsContainer.appendChild(toolEl);
    });

    timelineList.appendChild(group);

    if (interaction.status === 'pending' || interaction.status === 'streaming') {
      startDurationTimer(interaction);
    }
  }

  function appendMcpCallToTimeline(interaction, idx) {
    const group = document.createElement('div');
    group.className = 'turn-group mcp-call-group';
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry mcp-call-entry';
    el.dataset.id = interaction.id;

    const toolName = interaction.request?.tool || 'unknown';
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';
    const isError = interaction.status === 'error';
    const source = interaction.mcpSource === 'claude-code' ? 'claude' : 'test';

    el.innerHTML = `
      <div class="entry-header">
        <span class="entry-num mcp-label">MCP</span>
        <span class="entry-badge ${isError ? 'error' : 'complete'}">${isError ? 'error' : 'ok'}</span>
      </div>
      <div class="entry-model mcp-tool-name">${escHtml(toolName)}</div>
      <div class="entry-meta">
        <span class="mcp-source-tag mcp-src-${source}">${source}</span>
        <span>${durationHtml}</span>
      </div>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = { type: 'turn', id: interaction.id };
      if (isAlreadySelected(sel)) { selectLastAndFollow(); return; }
      _userPinnedSelection = true;
      select(sel);
    });

    group.appendChild(el);
    timelineList.appendChild(group);
  }

  function findHookSubagent(hookInteraction) {
    if (!hookInteraction.toolUseId) return null;
    for (let i = state.interactions.length - 1; i >= 0; i--) {
      const turn = state.interactions[i];
      if (turn.isHook || turn.isMcp) continue;
      if (turn.instanceId !== hookInteraction.instanceId) continue;
      const tools = extractToolCalls(turn);
      if (tools.some(tc => tc.id === hookInteraction.toolUseId)) return turn.subagent || null;
    }
    return null;
  }

  function appendHookEntryToTimeline(interaction, idx) {
    const hookEvent = interaction.hookEvent || 'Hook';
    const toolName = interaction.toolName || '';
    const arrow = /post/i.test(hookEvent) ? '←' : '→';
    const subagent = findHookSubagent(interaction);

    const agentLabel = subagent ? getSubagentLabel(subagent) : '';
    const agentColor = subagent?.agentId ? getSubagentColor(subagent) : '';
    const agentTag = subagent?.agentType
      ? `<span class="tool-entry-tag tag-agent"${agentColor ? ` style="color:${agentColor};background:color-mix(in srgb, ${agentColor} 10%, transparent);border-color:color-mix(in srgb, ${agentColor} 20%, transparent)"` : ''}>${escHtml(agentLabel)}</span>` : '';

    // Try to nest under the most recent LLM turn for the same instance
    const parentContainer = findParentToolContainer(interaction);
    if (parentContainer) {
      const el = document.createElement('div');
      el.className = 'timeline-entry tool-entry hook-tool-entry';
      el.dataset.id = interaction.id;
      el.innerHTML = `
        <span class="tool-connector hook-connector"></span>
        <span class="hook-arrow">${arrow}</span>
        <span class="tool-entry-name hook-entry-name">${escHtml(hookEvent)}</span>
        <span class="tool-entry-tag tag-hook">hook</span>
        ${agentTag}
        <span class="tool-entry-summary">${escHtml(toolName)}</span>
      `;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const sel = { type: 'turn', id: interaction.id };
        if (isAlreadySelected(sel)) { selectLastAndFollow(); return; }
        _userPinnedSelection = true;
        select(sel);
      });
      parentContainer.appendChild(el);
      return;
    }

    // Fallback: standalone entry if no parent turn found
    const group = document.createElement('div');
    group.className = 'turn-group hook-call-group';
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry hook-call-entry';
    el.dataset.id = interaction.id;

    el.innerHTML = `
      <span class="hook-arrow">${arrow}</span>
      <span class="hook-label">${escHtml(hookEvent)}</span>
      <span class="hook-tool-name">${escHtml(toolName)}</span>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = { type: 'turn', id: interaction.id };
      if (isAlreadySelected(sel)) { selectLastAndFollow(); return; }
      _userPinnedSelection = true;
      select(sel);
    });

    group.appendChild(el);
    timelineList.appendChild(group);
  }

  function findParentToolContainer(hookInteraction) {
    // If the hook has a toolUseId, find the turn that owns that tool call
    if (hookInteraction.toolUseId) {
      const groups = timelineList.querySelectorAll('.turn-group:not(.hook-call-group):not(.mcp-call-group)');
      for (let i = groups.length - 1; i >= 0; i--) {
        const turnId = groups[i].dataset.turnId;
        const turn = state.interactions.find(t => t.id === turnId);
        if (!turn) continue;
        const tools = extractToolCalls(turn);
        if (tools.some(tc => tc.id === hookInteraction.toolUseId)) {
          return groups[i].querySelector('.tool-entries');
        }
      }
    }
    // Fallback: most recent LLM turn for the same instance
    const groups = timelineList.querySelectorAll('.turn-group:not(.hook-call-group):not(.mcp-call-group)');
    for (let i = groups.length - 1; i >= 0; i--) {
      const turnId = groups[i].dataset.turnId;
      const turn = state.interactions.find(t => t.id === turnId);
      if (turn && turn.instanceId === hookInteraction.instanceId) {
        return groups[i].querySelector('.tool-entries');
      }
    }
    return null;
  }

  function appendToolToTimeline(interactionId, toolIdx, name, summary) {
    const container = document.querySelector(`[data-tools-for="${interactionId}"]`);
    if (!container) return;
    if (container.querySelector(`[data-tool-id="${interactionId}-${toolIdx}"]`)) return;
    const interaction = state.interactions.find(i => i.id === interactionId);
    const toolEl = createToolEntryEl(interactionId, toolIdx, name, summary, null, interaction?.subagent);
    container.appendChild(toolEl);
    if (!_userPinnedSelection) scrollTimelineToBottom();
  }

  function createToolEntryEl(interactionId, toolIdx, name, summary, input, subagent) {
    const toolEl = document.createElement('div');
    const isSkill = name === 'Skill' && input?.skill;
    toolEl.className = 'timeline-entry tool-entry' + (isSkill ? ' skill-call' : '');
    toolEl.dataset.toolId = `${interactionId}-${toolIdx}`;
    const displayName = isSkill ? `/${input.skill}` : name;
    const agentLabel = subagent ? getSubagentLabel(subagent) : '';
    const agentColor = subagent?.agentId ? getSubagentColor(subagent) : '';
    const agentTag = subagent?.agentType
      ? `<span class="tool-entry-tag tag-agent"${agentColor ? ` style="color:${agentColor};background:color-mix(in srgb, ${agentColor} 10%, transparent);border-color:color-mix(in srgb, ${agentColor} 20%, transparent)"` : ''}>${escHtml(agentLabel)}</span>` : '';
    toolEl.innerHTML = `
      <span class="tool-connector"></span>
      <span class="tool-entry-name" data-tool-name="${interactionId}-${toolIdx}">${escHtml(displayName)}</span>
      ${isSkill ? '<span class="tool-entry-tag tag-sk">skill</span>' : ''}
      ${agentTag}
      <span class="tool-entry-summary" data-tool-summary="${interactionId}-${toolIdx}">${escHtml(summary)}</span>
    `;
    toolEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = { type: 'tool', interactionId, toolIndex: toolIdx };
      if (isAlreadySelected(sel)) { selectLastAndFollow(); return; }
      _userPinnedSelection = true;
      select(sel);
    });
    return toolEl;
  }

  function rebuildToolEntries(interactionId) {
    const container = document.querySelector(`[data-tools-for="${interactionId}"]`);
    if (!container) return;
    const hookEls = [...container.querySelectorAll('.hook-tool-entry')];
    container.innerHTML = '';
    const interaction = state.interactions.find(i => i.id === interactionId);
    if (!interaction) return;
    const toolCalls = extractToolCalls(interaction);
    toolCalls.forEach((tc, tIdx) => {
      const toolEl = createToolEntryEl(interactionId, tIdx, tc.name, toolSummary(tc.name, tc.input), tc.input, interaction.subagent);
      container.appendChild(toolEl);
    });
    for (const h of hookEls) container.appendChild(h);
  }

  const _durationTimers = new Map();
  function startDurationTimer(interaction) {
    if (_durationTimers.has(interaction.id)) return;
    const startedAt = interaction.timing?.startedAt || Date.now();
    const iv = setInterval(() => {
      const el = document.querySelector(`[data-duration="${interaction.id}"]`);
      if (el) el.innerHTML = durationGauge(Date.now() - startedAt);
    }, 1000);
    _durationTimers.set(interaction.id, iv);
  }
  function stopDurationTimer(id) {
    const iv = _durationTimers.get(id);
    if (iv != null) { clearInterval(iv); _durationTimers.delete(id); }
  }

  function updateTurnBadge(id, status) {
    const badge = document.querySelector(`[data-badge="${id}"]`);
    if (badge) {
      badge.className = `entry-badge ${badgeClass(status)}`;
      badge.textContent = status;
    }
    if (status === 'streaming' || status === 'pending') {
      const interaction = state.interactions.find(i => i.id === id);
      if (interaction) startDurationTimer(interaction);
    } else {
      stopDurationTimer(id);
    }
  }

  function updateTurnSubagentBadge(interaction) {
    const entry = document.querySelector(`.turn-entry[data-id="${interaction.id}"]`);
    if (!entry) return;
    const header = entry.querySelector('.entry-header');
    if (!header) return;
    const existing = header.querySelector('.entry-subagent');
    if (existing) existing.remove();

    if (interaction.subagent?.agentId) registerSubagent(interaction.subagent);

    if (interaction.subagent && (interaction.subagent.agentType || interaction.subagent.agentId || interaction.subagent.description)) {
      const label = getSubagentLabel(interaction.subagent);
      const color = interaction.subagent.agentId ? getSubagentColor(interaction.subagent) : '';
      const badge = document.createElement('span');
      badge.className = 'entry-subagent';
      badge.title = interaction.subagent.description || '';
      badge.textContent = label;
      if (color) {
        badge.style.color = color;
        badge.style.background = `color-mix(in srgb, ${color} 12%, transparent)`;
      }
      const instanceEl = header.querySelector('.entry-instance');
      if (instanceEl) {
        header.insertBefore(badge, instanceEl);
      } else {
        header.appendChild(badge);
      }
    }
    const group = entry.closest('.turn-group');
    if (group) {
      group.classList.remove('sidechain-group', 'subagent-group');
      if (interaction.subagent?.isSidechain) group.classList.add('sidechain-group');
      else if (interaction.subagent?.agentType) {
        group.classList.add('subagent-group');
        if (interaction.subagent.agentId) {
          group.dataset.agentId = interaction.subagent.agentId;
          const color = getSubagentColor(interaction.subagent);
          group.style.setProperty('--subagent-color', color);
        }
      }
    }
  }

  function updateTurnMeta(interaction) {
    const durationEl = document.querySelector(`[data-duration="${interaction.id}"]`);
    if (durationEl && interaction.timing?.duration) {
      durationEl.innerHTML = durationGauge(interaction.timing.duration);
    }
    const modelEl = document.querySelector(`[data-model="${interaction.id}"]`);
    if (modelEl) {
      const model = interaction.request?.model || 'unknown';
      const shortModel = model.replace('claude-', '').split('-202')[0];
      const profile = interaction.profile || '';
      const modelSpan = modelEl.querySelector('.entry-model-label');
      if (modelSpan) modelSpan.innerHTML = profile ? `<span class="entry-profile">${escHtml(profile)}</span> ${escHtml(shortModel)}` : escHtml(shortModel);
    }
  }

  function updateTurnTokens(interaction) {
    const tokenEl = document.querySelector(`[data-tokenlabel="${interaction.id}"]`);
    if (tokenEl) tokenEl.innerHTML = compactTokens(interaction.usage);
    const costEl = document.querySelector(`[data-costgauge="${interaction.id}"]`);
    if (costEl) {
      const cost = computeCost(interaction.usage, interaction.pricing);
      costEl.innerHTML = turnCostGauge(cost);
    }
    updateUserTurnTotals();
  }

  function updateUserTurnTotals() {
    // Remove existing totals
    timelineList.querySelectorAll('.user-turn-total').forEach(el => el.remove());

    const children = [...timelineList.children];
    let sectionCost = 0;
    let lastGroupInSection = null;

    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (!el.classList.contains('turn-group')) continue;

      const isNewSection = el.classList.contains('new-user-turn') && lastGroupInSection;
      if (isNewSection) {
        // Close previous section
        insertTurnTotal(lastGroupInSection, sectionCost);
        sectionCost = 0;
      }

      const turnId = el.dataset.turnId;
      const interaction = state.interactions.find(it => it.id === turnId);
      if (interaction) {
        const cost = computeCost(interaction.usage, interaction.pricing);
        if (cost != null) sectionCost += cost;
      }
      lastGroupInSection = el;
    }
    // Close final section
    if (lastGroupInSection) insertTurnTotal(lastGroupInSection, sectionCost);
  }

  function insertTurnTotal(afterEl, cost) {
    if (!cost) return;
    const el = document.createElement('div');
    el.className = 'user-turn-total';
    el.innerHTML = `\u03A3 ${formatCost(cost)}`;
    afterEl.after(el);
  }

  function badgeClass(status) {
    switch (status) {
      case 'streaming': return 'badge-streaming';
      case 'complete': return 'badge-complete';
      case 'error': return 'badge-error';
      default: return 'badge-pending';
    }
  }

  function updateInspectorBusy() {
    updateStreamingState();
  }

  function scrollTimelineToBottom() {
    const el = document.getElementById('timeline-list');
    el.scrollTop = el.scrollHeight;
  }

  // ============================================================
  // SELECTION + DETAIL PANEL
  // ============================================================

  function selectLastAndFollow() {
    _userPinnedSelection = false;
    const filtered = activeInstanceTab === 'all'
      ? state.interactions.filter(i => !i.instanceId || !knownInstances.has(i.instanceId) )
      : state.interactions.filter(i => i.instanceId === activeInstanceTab);
    const last = filtered[filtered.length - 1];
    if (last) {
      select({ type: 'turn', id: last.id });
    } else {
      state.selection = null;
      document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
    scrollTimelineToBottom();
  }

  function isAlreadySelected(sel) {
    const cur = state.selection;
    if (!cur) return false;
    if (sel.type === 'turn' && cur.type === 'turn') return cur.id === sel.id;
    if (sel.type === 'tool' && cur.type === 'tool') return cur.interactionId === sel.interactionId && cur.toolIndex === sel.toolIndex;
    return false;
  }

  function select(sel) {
    state.selection = sel;

    document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));

    if (sel.type === 'turn') {
      const el = document.querySelector(`.turn-entry[data-id="${sel.id}"]`);
      if (el) {
        el.classList.add('selected');
        if (_userPinnedSelection) el.scrollIntoView({ block: 'nearest' });
      }

      const interaction = state.interactions.find(i => i.id === sel.id);
      if (!interaction) return;

      emptyState.classList.add('hidden');
      detailContent.classList.remove('hidden');
      renderTurnDetail(interaction);
    } else if (sel.type === 'tool') {
      const el = document.querySelector(`[data-tool-id="${sel.interactionId}-${sel.toolIndex}"]`);
      if (el) {
        el.classList.add('selected');
        if (_userPinnedSelection) el.scrollIntoView({ block: 'nearest' });
      }

      const interaction = state.interactions.find(i => i.id === sel.interactionId);
      if (!interaction) return;

      emptyState.classList.add('hidden');
      detailContent.classList.remove('hidden');
      renderToolDetail(interaction, sel.toolIndex);
    }
  }

  function renderMcpCallDetail(interaction) {
    const req = interaction.request || {};
    const resp = interaction.response || {};
    const timing = interaction.timing || {};
    const isError = interaction.status === 'error';
    const source = interaction.mcpSource === 'claude-code' ? 'Claude Code' : 'Dashboard test';

    let html = '<div class="section-title" style="color:var(--green)">MCP Tool Call</div>';
    html += `<div class="info-grid">
      <span class="info-label">Tool</span><span class="info-value" style="color:var(--green);font-weight:700">${escHtml(req.tool || 'unknown')}</span>
      <span class="info-label">Source</span><span class="info-value">${source}</span>
      <span class="info-label">Status</span><span class="info-value" style="color:var(${isError ? '--red' : '--green'})">${isError ? 'Error' : 'Success'}</span>
      <span class="info-label">Duration</span><span class="info-value">${timing.duration ? formatDuration(timing.duration) : '--'}</span>
    </div>`;

    html += '<div class="section-title">Input</div>';
    if (req.params && Object.keys(req.params).length > 0) {
      html += `${jsonBlock(req.params)}`;
    } else {
      html += '<p class="info-label">No parameters</p>';
    }

    html += '<div class="section-title">Output</div>';
    if (isError && resp.body?.error) {
      html += `<div class="content-block"><div class="content-block-header" style="color:var(--red)">Error</div>`;
      html += `<div class="content-block-body"><pre style="white-space:pre-wrap">${escHtml(resp.body.error)}</pre></div></div>`;
    } else if (resp.body) {
      const content = resp.body.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            html += `<pre class="json-block" style="white-space:pre-wrap">${escHtml(block.text || '')}`;
          } else {
            html += `${jsonBlock(block)}`;
          }
        }
      } else {
        html += `${jsonBlock(resp.body)}`;
      }
    } else {
      html += '<p class="info-label">No output</p>';
    }

    detailContent.innerHTML = html;
    processMarkdownBlocks(detailContent);
  }

  function renderHookCallDetail(interaction) {
    const req = interaction.request || {};
    const hookEvent = interaction.hookEvent || 'unknown';
    const toolName = interaction.toolName || '--';
    const time = new Date(interaction.timestamp).toLocaleTimeString();

    let html = '<div class="section-title" style="color:var(--magenta, #c084fc)">Hook Call</div>';
    html += `<div class="info-grid">
      <span class="info-label">Event</span><span class="info-value" style="color:var(--magenta, #c084fc);font-weight:700">${escHtml(hookEvent)}</span>
      <span class="info-label">Tool</span><span class="info-value">${escHtml(toolName)}</span>
      <span class="info-label">Session</span><span class="info-value">${escHtml(req.session_id || '--')}</span>
      <span class="info-label">Time</span><span class="info-value">${time}</span>
    </div>`;

    if (req.tool_input) {
      html += '<div class="section-title">Tool Input</div>';
      html += jsonBlock(req.tool_input);
    }

    if (req.tool_response) {
      html += '<div class="section-title">Tool Response</div>';
      if (typeof req.tool_response === 'string') {
        html += `<pre class="json-block" style="white-space:pre-wrap">${escHtml(req.tool_response)}</pre>`;
      } else {
        html += jsonBlock(req.tool_response);
      }
    }

    html += '<div class="section-title">Raw Hook Data</div>';
    html += jsonBlock(req);

    detailContent.innerHTML = html;
  }

  function renderTurnDetail(interaction) {
    if (interaction.isMcp) {
      return renderMcpCallDetail(interaction);
    }
    if (interaction.isHook) {
      return renderHookCallDetail(interaction);
    }

    const req = interaction.request || {};
    const resp = interaction.response || {};
    const timing = interaction.timing || {};

    const model = req.model || 'unknown';
    const maxTokens = req.max_tokens || '--';
    const temperature = req.temperature !== undefined ? req.temperature : '--';
    const stream = interaction.isStreaming ? 'yes' : 'no';

    let html = '';

    html += `<div class="detail-panel request-panel">`;
    html += `<div class="section-title">Request</div>`;
    html += `<div class="info-grid">
      <span class="info-label">Model</span><span class="info-value">${escHtml(model)}</span>
      <span class="info-label">Max tokens</span><span class="info-value">${maxTokens}</span>
      <span class="info-label">Temperature</span><span class="info-value">${temperature}</span>
      <span class="info-label">Stream</span><span class="info-value">${stream}</span>
      <span class="info-label">Endpoint</span><span class="info-value">${escHtml(interaction.originalEndpoint || interaction.endpoint || '/v1/messages')}</span>
      <span class="info-label">Bare</span><span class="info-value">${interaction.bare ? 'yes' : 'no'}</span>
      <span class="info-label">Auto-memory</span><span class="info-value">${interaction.disableAutoMemory ? 'disabled' : 'enabled'}</span>
      <span class="info-label">Time</span><span class="info-value">${new Date(interaction.timestamp).toLocaleTimeString()}</span>
    </div>`;

    if (interaction.subagent && (interaction.subagent.agentType || interaction.subagent.agentId || interaction.subagent.description)) {
      const sa = interaction.subagent;
      html += `<div class="info-grid subagent-info">
        <span class="info-label">Agent</span><span class="info-value" style="color:var(--cyan)">${escHtml(sa.agentType || 'unknown')}</span>
        <span class="info-label">Agent ID</span><span class="info-value">${escHtml(sa.agentId || '--')}</span>
        <span class="info-label">Description</span><span class="info-value">${escHtml(sa.description || '--')}</span>
        <span class="info-label">Sidechain</span><span class="info-value">${sa.isSidechain ? 'yes' : 'no'}</span>
      </div>`;
    }

    if (req.system) {
      const systemText = typeof req.system === 'string' ? req.system : JSON.stringify(req.system, null, 2);
      const charLen = typeof req.system === 'string' ? req.system.length : JSON.stringify(req.system).length;
      html += `<details>
        <summary>System Prompt ${charGauge(charLen)}</summary>
        <div class="json-block">${escHtml(systemText)}</div>
      </details>`;
    }

    if (req.thinking) {
      html += `<details>
        <summary>Thinking Config</summary>
        ${jsonBlock(req.thinking)}</pre>
      </details>`;
    }

    if (req.messages?.length > 0) {
      const msgChars = JSON.stringify(req.messages).length;
      html += `<details>
        <summary>Messages ${req.messages.length} ${charGauge(msgChars)}</summary>
        <div class="json-block">${renderMessages(req.messages)}</div>
      </details>`;
    }

    if (req.tools?.length > 0) {
      const toolChars = JSON.stringify(req.tools).length;
      const toolNames = req.tools.map(t => t.name || 'unnamed').join(', ');
      html += `<details>
        <summary>Tools ${req.tools.length} ${charGauge(toolChars, escHtml(truncate(toolNames, 100)))}</summary>
        ${jsonBlock(req.tools)}</pre>
      </details>`;
    }

    const knownKeys = new Set(['model', 'system', 'messages', 'tools', 'tool_choice', 'max_tokens', 'temperature', 'stream', 'thinking']);
    const otherParams = {};
    for (const [k, v] of Object.entries(req)) {
      if (!knownKeys.has(k)) otherParams[k] = v;
    }
    if (Object.keys(otherParams).length > 0) {
      html += `<details>
        <summary>Other Parameters</summary>
        ${jsonBlock(otherParams)}</pre>
      </details>`;
    }

    html += `<button class="curl-btn" data-interaction-id="${interaction.id}">cURL</button>`;

    html += `</div>`;

    html += `<div class="detail-panel response-panel">`;
    const respChars = interaction._respChars || (resp.body ? JSON.stringify(resp.body).length : (resp.sseEvents ? resp.sseEvents.reduce((n, e) => n + JSON.stringify(e.data || '').length, 0) : 0));
    html += `<div class="section-title">Response <span id="resp-char-gauge">${respChars ? charGauge(respChars) : ''}</span></div>`;

    const statusOk = resp.status >= 200 && resp.status < 300;
    html += `<div class="info-grid">
      <span class="info-label">Status</span><span class="info-value ${statusOk ? 'status-ok' : 'status-err'}" id="resp-status">${resp.status || '--'}</span>
      <span class="info-label">TTFB</span><span class="info-value" id="resp-ttfb">${timing.ttfb ? formatDuration(timing.ttfb) : '--'}</span>
      <span class="info-label">Duration</span><span class="info-value" id="resp-duration">${timing.duration ? formatDuration(timing.duration) : '--'}</span>
    </div>`;

    html += `<div id="response-blocks">`;

    const isStandardLlm = !interaction.endpoint || interaction.endpoint === '/v1/messages';
    if (interaction.isStreaming && resp.sseEvents?.length > 0) {
      html += renderAccumulatedBlocks(resp.sseEvents);
    } else if (resp.body) {
      if (!isStandardLlm) {
        html += `<div class="content-block">
          <div class="content-block-header">Response Body</div>
          <pre class="content-block-body json-block">${escHtml(JSON.stringify(resp.body, null, 2))}</pre>
        </div>`;
      } else if (resp.body.content) {
        const merged = mergeConsecutiveTextBlocks(resp.body.content);
        for (const block of merged) html += renderStaticBlock(block);
      }
      if (resp.body.type === 'error') {
        html += `<div class="content-block">
          <div class="content-block-header" style="color:var(--red)">Error</div>
          <div class="content-block-body">${escHtml(JSON.stringify(resp.body.error, null, 2))}</div>
        </div>`;
      }
    }

    if (resp.error) {
      html += `<div class="content-block">
        <div class="content-block-header" style="color:var(--red)">Proxy Error</div>
        <div class="content-block-body">${escHtml(resp.error)}</div>
      </div>`;
    }

    html += `</div>`;

    html += `<details id="raw-sse-details"${resp.sseEvents?.length > 0 ? '' : ' hidden'}>
      <summary>Raw SSE Events (<span id="raw-sse-count">${resp.sseEvents?.length || 0}</span>)</summary>
      <pre class="json-block" id="raw-sse-pre">${resp.sseEvents?.length > 0 ? resp.sseEvents.map(e =>
        `<span class="json-key">event:</span> ${escHtml(e.eventType)}\n<span class="json-string">data:</span> ${escHtml(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))}\n`
      ).join('\n') : ''}</pre>
    </details>`;

    html += `</div>`;

    detailContent.innerHTML = html;
    processMarkdownBlocks(detailContent);
  }

  function renderToolDetail(interaction, toolIndex) {
    const toolCalls = extractToolCalls(interaction);
    const tc = toolCalls[toolIndex];
    if (!tc) { detailContent.innerHTML = '<p>Tool call not found.</p>'; return; }

    let html = '';
    const isSkill = tc.name === 'Skill' && tc.input?.skill;

    html += `<div class="section-title">${isSkill ? 'Skill Invocation' : 'Tool Call'}</div>`;
    html += `<div class="info-grid">
      <span class="info-label">${isSkill ? 'Skill' : 'Tool'}</span><span class="info-value" style="color:var(${isSkill ? '--cyan' : '--purple'});font-weight:700">${isSkill ? '/' + escHtml(tc.input.skill) : escHtml(tc.name)}</span>`;
    if (isSkill && tc.input.args) {
      html += `<span class="info-label">Arguments</span><span class="info-value">${escHtml(tc.input.args)}</span>`;
    }
    html += `<span class="info-label">Status</span><span class="info-value">${tc.status}</span>
      <span class="info-label">Turn</span><span class="info-value"><a href="#" class="turn-link" data-turn-id="${interaction.id}">Turn ${llmTurnNumber(interaction)}</a></span>
    </div>`;

    html += `<div class="section-title">Input</div>`;
    if (tc.input) {
      html += `${jsonBlock(tc.input)}`;
    } else if (tc.inputJson) {
      html += `<pre class="json-block">${escHtml(tc.inputJson)}`;
    } else {
      html += `<p class="info-label">No input data</p>`;
    }

    const result = findToolResult(tc.id);
    if (result) {
      html += `<div class="section-title">Result</div>`;
      if (result.is_error) {
        html += `<div class="content-block"><div class="content-block-header" style="color:var(--red)">Error Result</div>`;
      } else {
        html += `<div class="content-block"><div class="content-block-header">Tool Result</div>`;
      }
      html += `<div class="content-block-body">`;

      const content = result.content;
      if (typeof content === 'string') {
        html += `<pre style="white-space:pre-wrap">${escHtml(content)}`;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            html += `<pre style="white-space:pre-wrap">${escHtml(block.text || '')}`;
          } else if (block.type === 'image') {
            html += `<p class="info-label">[image: ${escHtml(block.source?.media_type || 'unknown')}]</p>`;
          } else {
            html += `${jsonBlock(block)}`;
          }
        }
      } else if (content) {
        html += `${jsonBlock(content)}`;
      }

      html += `</div></div>`;
    } else {
      html += `<div class="section-title">Result</div>`;
      html += `<p class="info-label">No result found (tool may still be executing or result not yet sent)</p>`;
    }

    detailContent.innerHTML = html;
    processMarkdownBlocks(detailContent);

    const link = detailContent.querySelector('.turn-link');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        _userPinnedSelection = true;
        select({ type: 'turn', id: link.dataset.turnId });
      });
    }
  }

  // ============================================================
  // RENDERING HELPERS
  // ============================================================

  function mergeConsecutiveTextBlocks(blocks) {
    const merged = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const prev = merged[merged.length - 1];
        if (prev && prev.type === 'text') {
          prev.text = (prev.text || '') + '\n' + (block.text || '');
          continue;
        }
      }
      merged.push({ ...block });
    }
    return merged;
  }

  function renderAccumulatedBlocks(events) {
    const blocks = [];
    let currentBlock = null;

    for (const event of events) {
      if (event.eventType === 'content_block_start') {
        const cb = event.data?.content_block;
        currentBlock = { type: cb?.type || 'unknown', name: cb?.name || '', text: '', index: event.data?.index };
        blocks.push(currentBlock);
      } else if (event.eventType === 'content_block_delta' && currentBlock) {
        const delta = event.data?.delta;
        if (delta?.type === 'text_delta') currentBlock.text += delta.text || '';
        else if (delta?.type === 'thinking_delta') currentBlock.text += delta.thinking || '';
        else if (delta?.type === 'input_json_delta') currentBlock.text += delta.partial_json || '';
      } else if (event.eventType === 'content_block_stop') {
        currentBlock = null;
      }
    }

    const mergedBlocks = mergeConsecutiveTextBlocks(blocks);
    return mergedBlocks.map(b => {
      if (b.type === 'thinking') {
        return `<div class="content-block">
          <div class="content-block-header">Thinking</div>
          <div class="content-block-body thinking">${escHtml(b.text)}</div>
        </div>`;
      } else if (b.type === 'text') {
        return `<div class="content-block-body markdown-body" data-md-pending="${escHtml(b.text)}">${escHtml(b.text)}</div>`;
      } else if (b.type === 'tool_use') {
        let inputHtml;
        try { inputHtml = jsonBlock(JSON.parse(b.text)); } catch { inputHtml = `<pre class="json-block">${escHtml(b.text)}</pre>`; }
        return `<div class="content-block-body tool-use">
          <div class="tool-name"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>${escHtml(b.name)}</div>
          ${inputHtml}
        </div>`;
      }
      return `<div class="content-block">
        <div class="content-block-header">${escHtml(b.type)}</div>
        <div class="content-block-body">${escHtml(b.text)}</div>
      </div>`;
    }).join('');
  }

  // Post-process: render markdown in elements with data-md-pending attribute
  function processMarkdownBlocks(root) {
    const els = (root || document).querySelectorAll('[data-md-pending]');
    for (const el of els) {
      const text = el.getAttribute('data-md-pending');
      el.removeAttribute('data-md-pending');
      if (text) renderMarkdown(text, el);
    }
  }

  function renderStaticBlock(block) {
    if (block.type === 'text') {
      return `<div class="content-block-body markdown-body" data-md-pending="${escHtml(block.text || '')}">${escHtml(block.text || '')}</div>`;
    }
    if (block.type === 'thinking') {
      return `<div class="content-block">
        <div class="content-block-header">Thinking</div>
        <div class="content-block-body thinking">${escHtml(block.thinking || '')}</div>
      </div>`;
    }
    if (block.type === 'tool_use') {
      return `<div class="content-block-body tool-use">
        <div class="tool-name"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>${escHtml(block.name || '')}</div>
        ${jsonBlock(block.input || {})}</pre>
      </div>`;
    }
    return `<div class="content-block">
      <div class="content-block-header">${escHtml(block.type)}</div>
      ${jsonBlock(block)}</pre>
    </div>`;
  }

  function renderMessages(messages) {
    return messages.map((msg, idx) => {
      const role = msg.role || 'unknown';
      let preview = '';
      if (typeof msg.content === 'string') {
        preview = msg.content.slice(0, 150);
      } else if (Array.isArray(msg.content)) {
        preview = msg.content.map(b => {
          if (b.type === 'text') return (b.text || '').slice(0, 80);
          if (b.type === 'tool_use') return `[tool_use: ${b.name}]`;
          if (b.type === 'tool_result') return `[tool_result: ${b.tool_use_id}]`;
          if (b.type === 'image') return '[image]';
          return `[${b.type}]`;
        }).join(' | ');
      }
      return `<details>
        <summary><strong>${escHtml(role)}</strong> [${idx}]: ${escHtml(truncate(preview, 120))}</summary>
        ${jsonBlock(msg)}
      </details>`;
    }).join('');
  }

  function compactTokens(usage) {
    if (!usage) return '';
    const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const arrowUp = '<svg width="7" height="7" viewBox="0 0 8 8"><path d="M4 1L7 5H1Z" fill="currentColor"/></svg>';
    const arrowDn = '<svg width="7" height="7" viewBox="0 0 8 8"><path d="M4 7L1 3H7Z" fill="currentColor"/></svg>';
    const cacheIcon = '<svg width="8" height="8" viewBox="0 0 10 10"><ellipse cx="5" cy="2.5" rx="4" ry="1.8" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M1 2.5v2.2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V2.5" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M1 4.7v2.2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V4.7" fill="none" stroke="currentColor" stroke-width="0.9"/></svg>';
    let html = '';
    if (usage.input_tokens != null) html += `<span class="et-in">${arrowUp} ${fmt(usage.input_tokens)}</span>`;
    if (usage.output_tokens != null) html += `<span class="et-out">${arrowDn} ${fmt(usage.output_tokens)}</span>`;
    if (usage.cache_creation_input_tokens) html += `<span class="et-cw">${cacheIcon} ${fmt(usage.cache_creation_input_tokens)}w</span>`;
    if (usage.cache_read_input_tokens) html += `<span class="et-cr">${cacheIcon} ${fmt(usage.cache_read_input_tokens)}r</span>`;
    return html;
  }

  function durationGauge(ms) {
    if (ms == null) return '--';
    const secs = ms / 1000;
    const pct = Math.min(secs / 500, 1);
    const w = 32, h = 8, fill = pct * w;
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    return `<span class="entry-duration-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="entry-duration-label" style="color:${color}">${formatDuration(ms)}</span></span>`;
  }

  function turnCostGauge(cost) {
    if (cost == null) return '';
    const pct = Math.min(cost / 1, 1);
    const w = 32, h = 8, fill = pct * w;
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    return `<span class="entry-cost-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="entry-cost-label" style="color:${color}">${formatCost(cost)}</span></span>`;
  }

  function charGauge(chars, suffix) {
    // chars in thousands; gauge 0-200k, green->yellow->red->darkred
    const k = chars / 1000;
    const pct = Math.min(k / 200, 1);
    const w = 40, h = 10, fill = pct * w;
    // green(120) -> yellow(60) -> red(0) -> darkred
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    const trail = suffix ? `<span class="char-gauge-suffix">${suffix}</span>` : '';
    return `<span class="char-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="char-count">${chars.toLocaleString()}</span>${trail}</span>`;
  }

  function computeCost(usage, pricing) {
    if (!pricing || !usage) return null;
    let cost = 0;
    cost += (usage.input_tokens || 0) * (pricing.inputCostPerMTok || 0) / 1e6;
    cost += (usage.output_tokens || 0) * (pricing.outputCostPerMTok || 0) / 1e6;
    cost += (usage.cache_read_input_tokens || 0) * (pricing.cacheReadCostPerMTok || pricing.inputCostPerMTok || 0) / 1e6;
    cost += (usage.cache_creation_input_tokens || 0) * (pricing.cacheCreateCostPerMTok || pricing.inputCostPerMTok || 0) / 1e6;
    return cost;
  }

  function formatCost(cost) {
    if (cost == null) return '';
    if (cost < 0.001) return '$' + cost.toFixed(6);
    if (cost < 0.01) return '$' + cost.toFixed(4);
    if (cost < 1) return '$' + cost.toFixed(3);
    return '$' + cost.toFixed(2);
  }

  function renderUsage(usage, pricing) {
    let html = '';
    if (usage.input_tokens !== undefined)
      html += `<div class="usage-item"><span class="usage-dot input"></span>${usage.input_tokens.toLocaleString()} input</div>`;
    if (usage.cache_creation_input_tokens)
      html += `<div class="usage-item"><span class="usage-dot cache-create"></span>${usage.cache_creation_input_tokens.toLocaleString()} cache create</div>`;
    if (usage.cache_read_input_tokens)
      html += `<div class="usage-item"><span class="usage-dot cache-read"></span>${usage.cache_read_input_tokens.toLocaleString()} cache read</div>`;
    if (usage.output_tokens !== undefined)
      html += `<div class="usage-item"><span class="usage-dot output"></span>${usage.output_tokens.toLocaleString()} output</div>`;
    if (usage.reasoning_tokens)
      html += `<div class="usage-item"><span class="usage-dot reasoning"></span>${usage.reasoning_tokens.toLocaleString()} reasoning</div>`;
    const cost = computeCost(usage, pricing);
    if (cost != null)
      html += `<div class="usage-item usage-cost">${formatCost(cost)}</div>`;
    return html;
  }

  function updateUsageDisplay(usage, pricing) {
    const bar = document.getElementById('usage-bar');
    if (bar) bar.innerHTML = renderUsage(usage, pricing);
  }

  function costGauge(cost) {
    const pct = Math.min(cost / 100, 1);
    const w = 40, h = 10, fill = pct * w;
    const hue = Math.round((1 - pct) * 120);
    const sat = pct > 0.9 ? '80%' : '70%';
    const lit = pct > 0.9 ? '30%' : '45%';
    const color = `hsl(${hue},${sat},${lit})`;
    return `<span class="footer-cost-gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/><rect width="${fill}" height="${h}" rx="2" fill="${color}"/></svg><span class="footer-cost-label" style="color:${color}">${formatCost(cost)}</span></span>`;
  }

  function updateStats() {
    const source = state.interactions;
    const total = source.length;
    let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0, toolCallCount = 0, totalCost = 0;
    let hasCost = false;
    for (const i of source) {
      if (i.usage) {
        inputTokens += i.usage.input_tokens || 0;
        outputTokens += i.usage.output_tokens || 0;
        cacheRead += i.usage.cache_read_input_tokens || 0;
        cacheCreate += i.usage.cache_creation_input_tokens || 0;
        const cost = computeCost(i.usage, i.pricing);
        if (cost != null) { totalCost += cost; hasCost = true; }
      }
      toolCallCount += extractToolCalls(i).length;
    }

    // Footer stats section
    statsEl.textContent = `${total} turn${total !== 1 ? 's' : ''} \u00b7 ${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}`;

    // Footer tokens section — arrows for in/out
    const tokensEl = document.getElementById('footerTokens');
    if (tokensEl) {
      if (inputTokens || outputTokens) {
        tokensEl.innerHTML =
          `<span class="ft-in"><svg width="8" height="8" viewBox="0 0 8 8"><path d="M4 1L7 5H1Z" fill="currentColor"/></svg> ${inputTokens.toLocaleString()}</span>` +
          `<span class="ft-out"><svg width="8" height="8" viewBox="0 0 8 8"><path d="M4 7L1 3H7Z" fill="currentColor"/></svg> ${outputTokens.toLocaleString()}</span>`;
      } else {
        tokensEl.innerHTML = '<span class="footer-placeholder">tokens</span>';
      }
    }

    // Footer cache section — cache icon with create/read
    const cacheEl = document.getElementById('footerCache');
    if (cacheEl) {
      if (cacheRead || cacheCreate) {
        const icon = '<svg class="ft-cache-icon" width="10" height="10" viewBox="0 0 10 10"><ellipse cx="5" cy="2.5" rx="4" ry="1.8" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M1 2.5v2.2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V2.5" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M1 4.7v2.2c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V4.7" fill="none" stroke="currentColor" stroke-width="0.9"/></svg>';
        let parts = '';
        if (cacheCreate) parts += `<span class="ft-cache-w">${icon} ${cacheCreate.toLocaleString()} w</span>`;
        if (cacheRead) parts += `<span class="ft-cache-r">${icon} ${cacheRead.toLocaleString()} r</span>`;
        cacheEl.innerHTML = parts;
      } else {
        cacheEl.innerHTML = '<span class="footer-placeholder">cache</span>';
      }
    }

    // Footer cost section with gauge
    const costEl = document.getElementById('footerCost');
    if (costEl) {
      costEl.innerHTML = hasCost ? costGauge(totalCost) : '<span class="footer-placeholder">price</span>';
    }

    // Timeline footer — total busy time and cost of visible turns
    const tlTimeEl = document.getElementById('timeline-total-time');
    const tlCostEl = document.getElementById('timeline-total-cost');
    let visibleCost = 0, visibleTime = 0;
    let hasVisibleCost = false, hasVisibleTime = false;
    for (const i of source) {
      if (!isVisibleInTimeline(i)) continue;
      const c = computeCost(i.usage, i.pricing);
      if (c != null) { visibleCost += c; hasVisibleCost = true; }
      if (i.timing?.duration) { visibleTime += i.timing.duration; hasVisibleTime = true; }
    }
    if (tlTimeEl) {
      tlTimeEl.textContent = hasVisibleTime ? `\u03A3 ${formatDuration(visibleTime)}` : '';
    }
    if (tlCostEl) {
      tlCostEl.textContent = hasVisibleCost ? `\u03A3 ${formatCost(visibleCost)}` : '';
    }
  }

  function isVisibleInTimeline(interaction) {
    if (activeInstanceTab === 'all') {
      return !(interaction.instanceId && knownInstances.has(interaction.instanceId));
    }
    return interaction.instanceId === activeInstanceTab;
  }

  function renderEmptyState() {
    if (!emptyState) return;
    if (state.interactions.length > 0) return;
    emptyState.innerHTML = '<p>No interaction selected.</p>'
      + '<p class="empty-state-sub">Start capturing Claude Code API streams:</p>'
      + '<ul class="empty-state-list">'
      + '<li><b>External Claude</b> &mdash; run with the proxy env var:<br><code>ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "prompt"</code></li>'
      + '<li><b>Chat</b> &mdash; use the <span class="empty-state-link" data-view="claude">Chat</span> tab to talk to Claude directly through the proxy</li>'
      + '</ul>';
    emptyState.querySelectorAll('.empty-state-link').forEach(el => {
      el.addEventListener('click', () => {
        const view = el.dataset.view;
        if (view) document.querySelector(`.header-tab[data-view="${view}"]`)?.click();
      });
    });
  }

  // --- Message handler ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        _userPinnedSelection = false;
        extTabCounter = 0;
        activeExtTab = null;
        state.interactions = msg.interactions || [];
        // Stamp null-instanceId interactions as ext tabs, rebuild instance map
        for (const i of state.interactions) {
          stampExtInteraction(i);
          if (i.instanceId && !knownInstances.has(i.instanceId)) {
            knownInstances.set(i.instanceId, {
              instanceId: i.instanceId, profileName: i.profile, status: 'exited', spawnedAt: i.timestamp, cwd: null,
            });
          }
        }
        // Mark ext tabs as exited on init (they're historical)
        for (let n = 1; n <= extTabCounter; n++) {
          const ext = knownInstances.get(`ext-${n}`);
          if (ext) ext.status = 'exited';
        }
        renderInspectorTabStrip();
        initTimelineToggle();
        renderTimelineActive();
        updateStats();
        updateInspectorBusy();
        if (state.interactions.length > 0) {
          select({ type: 'turn', id: state.interactions[state.interactions.length - 1].id });
        } else {
          renderEmptyState();
        }
        break;

      case 'interaction:start':
        stampExtInteraction(msg.interaction);
        state.interactions.push(msg.interaction);
        // Auto-discover instance from interaction
        if (msg.interaction.instanceId && !knownInstances.has(msg.interaction.instanceId)) {
          knownInstances.set(msg.interaction.instanceId, {
            instanceId: msg.interaction.instanceId, profileName: msg.interaction.profile,
            status: 'running', spawnedAt: msg.interaction.timestamp, cwd: null,
          });
          renderInspectorTabStrip();
        }
        // Only append to visible timeline if it matches current filter
        const matchesFilter = activeInstanceTab === 'all'
          ? (!msg.interaction.instanceId || !knownInstances.has(msg.interaction.instanceId))
          : msg.interaction.instanceId === activeInstanceTab;
        if (matchesFilter) {
          if (_timelineMode === 'parallel') appendToParallelTimeline(msg.interaction);
          else appendTurnToTimeline(msg.interaction);
          if (!_userPinnedSelection) {
            select({ type: 'turn', id: msg.interaction.id });
            scrollTimelineToBottom();
          }
        }
        updateStats();
        updateInspectorBusy();
        break;

      case 'interaction:update':
        updateInteraction(msg.interaction);
        // Re-render detail if this interaction is selected
        if (state.selection?.type === 'turn' && state.selection.id === msg.interaction.id) {
          select({ type: 'turn', id: msg.interaction.id });
        }
        break;

      case 'sse_event':
        handleSSEEvent(msg.interactionId, msg.event);
        break;

      case 'interaction:complete':
        updateInteraction(msg.interaction);
        updateInspectorBusy();
        break;

      case 'interaction:error':
        markInteractionError(msg.interactionId, msg.error);
        updateInspectorBusy();
        break;

      case 'cleared':
        state.interactions = [];
        state.selection = null;
        knownInstances.clear();
        activeInstanceTab = 'all';
        extTabCounter = 0;
        activeExtTab = null;
        renderInspectorTabStrip();
        timelineList.innerHTML = '';
        detailContent.innerHTML = '';
        detailContent.classList.add('hidden');
        emptyState.classList.remove('hidden');
        updateStats();
        updateInspectorBusy();
        renderEmptyState();
        break;

      case 'claude:instances':
        if (msg.instances) {
          for (const inst of msg.instances) {
            const existing = knownInstances.get(inst.instanceId);
            knownInstances.set(inst.instanceId, {
              instanceId: inst.instanceId, profileName: inst.profileName,
              status: inst.status, spawnedAt: inst.spawnedAt,
              cwd: inst.cwd || existing?.cwd || null,
              tabId: inst.tabId || existing?.tabId || null,
            });
          }
        }
        renderInspectorTabStrip();
        break;

      case 'inspector:instancesCleared': {
        const cleared = new Set(msg.instanceIds || []);
        state.interactions = state.interactions.filter(i => !cleared.has(i.instanceId));
        for (const id of cleared) knownInstances.delete(id);
        if (cleared.has(activeInstanceTab)) activeInstanceTab = 'all';
        renderInspectorTabStrip();
        renderTimelineActive();
        updateStats();
        break;
      }

      case 'inspector:sessionLoaded': {
        const instanceId = msg.instanceId || `cli-${msg.sessId}`;
        const newInteractions = msg.interactions || [];
        const existingIds = new Set(state.interactions.map(i => i.id));
        const toAdd = newInteractions.filter(i => !existingIds.has(i.id));
        state.interactions.push(...toAdd);
        state.interactions.sort((a, b) => a.timestamp - b.timestamp);
        if (!knownInstances.has(instanceId)) {
          knownInstances.set(instanceId, {
            instanceId, profileName: null, status: 'running',
            spawnedAt: toAdd[0]?.timestamp || Date.now(), cwd: null,
          });
        }
        renderInspectorTabStrip();
        if (activeInstanceTab === instanceId) renderTimelineActive();
        updateStats();
        break;
      }

      case 'inspector:allLoaded': {
        const allInteractions = msg.interactions || [];
        const existingIds = new Set(state.interactions.map(i => i.id));
        const toAdd = allInteractions.filter(i => !existingIds.has(i.id));
        if (toAdd.length > 0) {
          for (const i of toAdd) stampExtInteraction(i);
          state.interactions.push(...toAdd);
          state.interactions.sort((a, b) => a.timestamp - b.timestamp);
          for (const i of toAdd) {
            if (i.instanceId && !knownInstances.has(i.instanceId)) {
              knownInstances.set(i.instanceId, {
                instanceId: i.instanceId, profileName: i.profile,
                status: 'exited', spawnedAt: i.timestamp, cwd: null,
              });
            }
          }
          renderInspectorTabStrip();
          renderTimelineActive();
          updateStats();
        }
        _allHistoryLoaded = true;
        const loadAllBtn = document.querySelector('.tl-load-all-btn');
        if (loadAllBtn) { loadAllBtn.classList.add('active'); loadAllBtn.style.opacity = ''; }
        break;
      }

      case 'interaction:enriched': {
        const interaction = state.interactions.find(i => i.id === msg.interactionId);
        if (interaction) {
          interaction.subagent = msg.subagent;
          if (_timelineMode === 'parallel') {
            renderTimelineParallel();
          } else {
            updateTurnSubagentBadge(interaction);
          }
          if (state.selection?.type === 'turn' && state.selection.id === msg.interactionId) {
            select({ type: 'turn', id: msg.interactionId });
          }
        }
        break;
      }
    }
  }

  // Reset button — clears all interactions and zeroes the footer
  const resetBtn = document.getElementById('footerReset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const instanceIds = [...new Set(state.interactions.map(i => i.instanceId).filter(Boolean))];
      if (instanceIds.length) sendWs({ type: 'inspector:clearInstances', instanceIds });
      state.interactions.length = 0;
      updateStats();
      renderTimelineActive();
      state.selection = null;
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    });
  }

  // Timeline clear button — removes visible non-streaming interactions
  const tlClearBtn = document.getElementById('timeline-clear-btn');
  if (tlClearBtn) {
    tlClearBtn.addEventListener('click', () => {
      const toRemove = new Set();
      for (const i of state.interactions) {
        if (isVisibleInTimeline(i) && i.status !== 'streaming' && i.status !== 'pending') {
          toRemove.add(i.id);
        }
      }
      if (toRemove.size === 0) return;
      // Collect instance IDs of removed interactions to clear from server
      const instanceIds = [...new Set(
        state.interactions.filter(i => toRemove.has(i.id) && i.instanceId).map(i => i.instanceId)
      )];
      state.interactions = state.interactions.filter(i => !toRemove.has(i.id));
      // Only clear instances that have no remaining interactions
      const remainingInstances = new Set(state.interactions.map(i => i.instanceId).filter(Boolean));
      const toClear = instanceIds.filter(id => !remainingInstances.has(id));
      if (toClear.length) sendWs({ type: 'inspector:clearInstances', instanceIds: toClear });
      if (state.selection && toRemove.has(state.selection.id)) {
        state.selection = null;
        detailContent.classList.add('hidden');
        emptyState.classList.remove('hidden');
      }
      renderTimelineActive();
      updateStats();
    });
  }

  window.inspectorModule = { handleMessage, instanceDisplayLabel, renderInspectorTabStrip, switchInstanceTab };
})();
