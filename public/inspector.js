(function() {
  'use strict';
  const { state, escHtml, highlightJSON, renderJSON, jsonBlock, formatDuration, truncate,
          renderMarkdown, renderMarkdownDebounced, cancelRenderDebounce, sendWs,
          timelineList, detailContent, emptyState, statsEl } = window.dashboard;

  // --- Auto-select suppression: don't jump away from user-selected turns ---
  let _liveMode = localStorage.getItem('timelineLive') !== 'false';
  let _autoClearInactive = localStorage.getItem('inspectorAutoClear') === '1';
  let _suppressAutoClear = false;

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

      // Model override indicator (non-clickable)
      if (id.startsWith('cli-') && info.tabId && window.cliModule?.tabs) {
        const cliTab = window.cliModule.tabs.get(info.tabId);
        const hasOverride = cliTab?.settings &&
          cliTab.settings.modelMap && Object.values(cliTab.settings.modelMap).some(v => v);
        const overrideIcon = document.createElement('span');
        overrideIcon.className = 'cli-model-override-btn' + (hasOverride ? ' active' : '') + ' inspector-only';
        overrideIcon.innerHTML = hasOverride
          ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 2l12 10M1 7h12M1 12l12-10"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 3h10m-2-2l2 2-2 2"/><path d="M1 7h10m-2-2l2 2-2 2"/><path d="M1 11h10m-2-2l2 2-2 2"/></svg>';
        overrideIcon.title = hasOverride ? 'Model override active' : 'No model override';
        btn.appendChild(overrideIcon);
      }

      const close = document.createElement('span');
      close.className = 'view-tab-close';
      close.textContent = '\u00d7';
      btn.appendChild(close);
      inspectorTabStrip.appendChild(btn);
    }
    // Combined "Clear inactive" button with autoclear toggle
    const hasExited = [...knownInstances.values()].some(i => i.status === 'exited');

    // Autoclear: if enabled, clear exited instances immediately
    if (hasExited && _autoClearInactive && !_suppressAutoClear) {
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
      queueMicrotask(() => renderInspectorTabStrip());
      return;
    }

    {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'view-tab-action' + (_autoClearInactive ? ' autoclear-on' : '');
      clearBtn.title = _autoClearInactive ? 'Autoclear active — inactive tabs are removed automatically' : 'Clear all inactive tabs';

      // Auto-toggle SVG — recycle arrows when off, check-circle when on
      const autoToggle = document.createElement('span');
      autoToggle.className = 'autoclear-toggle' + (_autoClearInactive ? ' active' : '');
      autoToggle.title = _autoClearInactive ? 'Disable autoclear' : 'Enable autoclear';
      autoToggle.innerHTML = _autoClearInactive
        ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><polyline points="5 8.2 7.2 10.5 11 5.5"/></svg>'
        : '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 0 1 9.3-4"/><path d="M13.5 8a5.5 5.5 0 0 1-9.3 4"/><polyline points="12 1.5 12 4.5 9 4.5"/><polyline points="4 11.5 4 14.5 7 14.5"/></svg>';
      autoToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        _autoClearInactive = !_autoClearInactive;
        localStorage.setItem('inspectorAutoClear', _autoClearInactive ? '1' : '0');
        renderInspectorTabStrip();
      });

      const textSpan = document.createElement('span');
      textSpan.className = 'autoclear-label-text';
      textSpan.textContent = hasExited ? 'Clear inactive' : (_autoClearInactive ? 'Autoclear' : 'Clear inactive');

      clearBtn.appendChild(autoToggle);
      clearBtn.appendChild(textSpan);

      if (hasExited && !_autoClearInactive) {
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
      }

      inspectorTabStrip.appendChild(clearBtn);
    }

    updateStreamingState();
  }

  function switchInstanceTab(instanceId) {
    activeInstanceTab = instanceId;
    renderInspectorTabStrip();
    renderTimelineActive();
    updateStats();
    // Select last matching interaction
    const filtered = activeInstanceTab === 'all'
      ? state.interactions.filter(i => !i.instanceId || !knownInstances.has(i.instanceId) )
      : state.interactions.filter(i => i.instanceId === activeInstanceTab);
    const last = filtered[filtered.length - 1];
    if (last) {
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

  function isStandardLlm(interaction) {
    if (!interaction.endpoint || interaction.endpoint === '/v1/messages') return true;
    if (interaction.translatedFrom) return true;
    return false;
  }

  function llmTurnNumber(interaction) {
    let n = 0;
    for (const i of state.interactions) {
      if (!i.isMcp && !i.isHook && isStandardLlm(i)) n++;
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

    // Single button that swaps between narrow ↔ wide
    const narrowSvg = `<svg width="12" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="3" y="1" width="8" height="10" rx="1.5"/><line x1="5" y1="4" x2="9" y2="4"/><line x1="5" y1="6.5" x2="9" y2="6.5"/><line x1="5" y1="9" x2="8" y2="9"/></svg>`;
    const wideSvg = `<svg width="12" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1" y="1" width="12" height="10" rx="1.5"/><line x1="5" y1="1" x2="5" y2="11"/><line x1="9" y1="1" x2="9" y2="11"/></svg>`;
    const allSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 2h8v8H2z"/><line x1="2" y1="5" x2="10" y2="5"/><line x1="2" y1="8" x2="10" y2="8"/></svg>`;

    const liveOnSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,6.5 5,9.5 10,3"/></svg>`;
    const liveOffSvg = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="3" y1="3" x2="9" y2="9"/><line x1="9" y1="3" x2="3" y2="9"/></svg>`;
    function liveButtonContent(on) { return (on ? liveOnSvg : liveOffSvg) + `<span class="tl-toggle-label">live</span>`; }

    const isWide = _timelineMode === 'parallel';
    toggle.innerHTML = `
      <button class="tl-toggle-btn tl-live-btn${_liveMode ? ' active' : ''}" title="${_liveMode ? 'Live mode on' : 'Live mode off'}">${liveButtonContent(_liveMode)}</button>
      <button class="tl-toggle-btn tl-view-toggle${isWide ? ' active' : ''}" title="${isWide ? 'Switch to narrow view' : 'Switch to wide view'}">${isWide ? wideSvg : narrowSvg}<span class="tl-toggle-label">${isWide ? 'wide' : 'narrow'}</span></button>
      <button class="tl-toggle-btn tl-load-all-btn${_allHistoryLoaded ? ' active' : ''}" title="Load full history from disk">${allSvg}</button>
    `;
    const liveBtn = toggle.querySelector('.tl-live-btn');
    liveBtn.addEventListener('click', () => {
      _liveMode = !_liveMode;
      localStorage.setItem('timelineLive', _liveMode);
      liveBtn.classList.toggle('active', _liveMode);
      liveBtn.innerHTML = liveButtonContent(_liveMode);
      liveBtn.title = _liveMode ? 'Live mode on' : 'Live mode off';
      if (_liveMode) selectLastAndFollow();
    });
    const viewBtn = toggle.querySelector('.tl-view-toggle');
    viewBtn.addEventListener('click', () => {
      _timelineMode = _timelineMode === 'single' ? 'parallel' : 'single';
      localStorage.setItem('timelineMode', _timelineMode);
      const nowWide = _timelineMode === 'parallel';
      viewBtn.innerHTML = (nowWide ? wideSvg : narrowSvg) + `<span class="tl-toggle-label">${nowWide ? 'wide' : 'narrow'}</span>`;
      viewBtn.classList.toggle('active', nowWide);
      viewBtn.title = nowWide ? 'Switch to narrow view' : 'Switch to wide view';
      const aside = document.getElementById('timeline');
      if (aside) aside.classList.toggle('parallel-mode', nowWide);
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
    const savedScroll = _liveMode ? null : timelineList.scrollTop;
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
        if (!isStandardLlm(interaction)) {
          appendTurnToTimeline(interaction, undefined, false);
        } else {
          const agentId = interaction.subagent?.agentId;
          if (agentId) {
            const n = (subagentTurnCounts.get(agentId) || 0) + 1;
            subagentTurnCounts.set(agentId, n);
            appendTurnToTimeline(interaction, n, true);
          } else {
            turnNum++;
            appendTurnToTimeline(interaction, turnNum, false);
          }
        }
      } else {
        appendTurnToTimeline(interaction);
      }
    });
    updateUserTurnTotals();
    if (_liveMode) scrollTimelineToBottom();
    else if (savedScroll != null) timelineList.scrollTop = savedScroll;
  }

  // === D3 PARALLEL TIMELINE (multi-column swimlane with SVG connectors) ===

  let _d3State = null; // persisted between incremental appends; reset on full re-render
  let _flowAnimations = new Map(); // agentId -> animFrameId
  let _inflightSet = new Set(); // interaction IDs currently shown as footer badges
  let _inflightTimers = new Map(); // id -> intervalId for elapsed counter

  const D3_CONST = {
    RULER_WIDTH: 52,
    COLUMN_WIDTH: 240,
    COLUMN_GAP: 16,
    MIN_ENTRY_HEIGHT: 52,
    TOOL_HEIGHT: 24,
    MIN_GAP: 6,
    TIME_SCALE: 0.04,
    HEADER_HEIGHT: 30,
    NODE_BORDER_RADIUS: 6,
    TICK_INTERVAL: 10000,
    ZIGZAG_MIN_CUT: 10000,
  };

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

  function resolveClosedAgentId(hookInteraction, interactions, hookIdx, activeColumns) {
    if (hookInteraction.toolUseId) {
      // Find the parent turn that contains the Agent tool_use matching this hook's toolUseId
      let parentIdx = -1;
      for (let j = hookIdx - 1; j >= 0; j--) {
        const prev = interactions[j];
        if (prev.isHook || prev.isMcp) continue;
        const tools = extractToolCalls(prev);
        if (tools.some(tc => tc.id === hookInteraction.toolUseId)) { parentIdx = j; break; }
      }
      if (parentIdx >= 0) {
        // Scan forward from parent to find the subagent spawned by this tool call
        for (let j = parentIdx + 1; j < hookIdx; j++) {
          const child = interactions[j];
          if (child.isHook || child.isMcp) continue;
          const aid = child.subagent?.agentId;
          if (aid && activeColumns.has(aid)) return aid;
        }
      }
    }
    // Fallback: last active agent seen before this hook
    for (let j = hookIdx - 1; j >= 0; j--) {
      const prev = interactions[j];
      if (prev.isHook || prev.isMcp) continue;
      const aid = prev.subagent?.agentId;
      if (aid && activeColumns.has(aid)) return aid;
    }
    return null;
  }

  function buildColumnAssignment(interactions) {
    const columnFor = new Map();
    const activeColumns = new Map();
    const historicalColumns = new Map();
    const columnAgents = new Map();
    const freeColumns = [];
    const parallelRegions = [];
    const postHookClosedCol = new Map();
    let nextColumn = 1;
    let currentRegion = null;

    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      let agentId = null;
      if (interaction.isHook) {
        agentId = interaction.subagent?.agentId || resolveHookAgentId(interaction, interactions.slice(0, idx));
      } else {
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
      if (resolvedCol > 0 && interaction.subagent && !columnAgents.has(resolvedCol)) {
        registerSubagent(interaction.subagent);
        columnAgents.set(resolvedCol, interaction.subagent);
      }
      // PostToolUse/Agent hooks go to column 0 (main thread) so merge connectors can target them
      const assignedCol = (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent')
        ? 0 : resolvedCol;
      columnFor.set(interaction.id, assignedCol);

      if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
        const closedAgentId = resolveClosedAgentId(interaction, interactions, idx, activeColumns);
        if (closedAgentId) {
          const closedCol = activeColumns.get(closedAgentId);
          postHookClosedCol.set(interaction.id, closedCol);
          freeColumns.push(closedCol);
          activeColumns.delete(closedAgentId);
        }
      }

      const inParallel = activeColumns.size > 0;
      if (inParallel && !currentRegion) {
        currentRegion = { startIdx: idx, endIdx: idx, startTime: interaction.timestamp, endTime: interaction.timestamp };
      } else if (inParallel && currentRegion) {
        currentRegion.endIdx = idx;
        currentRegion.endTime = interaction.timestamp;
      } else if (!inParallel && currentRegion) {
        currentRegion.endIdx = idx;
        currentRegion.endTime = interaction.timestamp;
        parallelRegions.push(currentRegion);
        currentRegion = null;
      }
    }
    if (currentRegion) parallelRegions.push(currentRegion);

    return { columnFor, totalColumns: nextColumn, columnAgents, activeColumns, historicalColumns, freeColumns, nextColumn, parallelRegions, postHookClosedCol };
  }

  // --- Layout computation ---

  function computeNodeHeight(interaction) {
    if (interaction.isHook) return 28;
    if (!isStandardLlm(interaction)) return 28;
    if (interaction.isMcp) return 42;
    const tools = extractToolCalls(interaction);
    return D3_CONST.MIN_ENTRY_HEIGHT + tools.length * D3_CONST.TOOL_HEIGHT;
  }

  const GAP_COLLAPSE_THRESHOLD = 30000;
  const GAP_COLLAPSE_HEIGHT = 28;

  function computeD3Layout(interactions, columnFor, totalColumns, parallelRegions, postHookClosedCol) {
    const C = D3_CONST;
    const layout = [];
    const breaks = [];
    const colBottoms = new Map();
    const sessionStart = interactions.length > 0 ? interactions[0].timestamp : 0;
    let globalBottom = C.HEADER_HEIGHT + 8;
    const availWidth = computeColumnWidth(totalColumns);

    // Index → parallel region lookup
    const idxRegion = new Array(interactions.length).fill(null);
    for (const r of (parallelRegions || [])) {
      for (let i = r.startIdx; i <= r.endIdx; i++) idxRegion[i] = r;
    }

    // Pre-compute per-region: gap compression and minimum viable time scale
    const regionCache = new Map();
    for (const region of (parallelRegions || [])) {
      const regionElapsed = [];
      for (let i = region.startIdx; i <= region.endIdx; i++) {
        regionElapsed.push(interactions[i].timestamp - sessionStart);
      }
      const sorted = [...new Set(regionElapsed)].sort((a, b) => a - b);

      let cumShift = 0;
      const shifts = [];
      const regionBreaks = [];
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1];
        if (gap > GAP_COLLAPSE_THRESHOLD) {
          cumShift += gap - GAP_COLLAPSE_THRESHOLD * 0.1;
          regionBreaks.push({ before: sorted[i - 1], after: sorted[i] });
        }
        shifts.push({ elapsed: sorted[i], shift: cumShift });
      }
      const compressElapsed = (elapsed) => {
        let s = 0;
        for (const { elapsed: e, shift } of shifts) {
          if (e <= elapsed) s = shift; else break;
        }
        return elapsed - s;
      };

      // Compute scale: for each column, consecutive pairs determine minimum scale
      const byCols = new Map();
      for (let i = region.startIdx; i <= region.endIdx; i++) {
        const col = columnFor.get(interactions[i].id) || 0;
        if (!byCols.has(col)) byCols.set(col, []);
        byCols.get(col).push({
          height: computeNodeHeight(interactions[i]),
          compElapsed: compressElapsed(interactions[i].timestamp - sessionStart)
        });
      }
      let maxScale = 0.005;
      for (const [, nodes] of byCols) {
        for (let i = 0; i < nodes.length - 1; i++) {
          const dt = nodes[i + 1].compElapsed - nodes[i].compElapsed;
          if (dt > 0) {
            const needed = (nodes[i].height + C.MIN_GAP) / dt;
            if (needed > maxScale) maxScale = needed;
          }
        }
      }

      regionCache.set(region, {
        scale: Math.min(maxScale, C.TIME_SCALE),
        compressElapsed,
        regionBreaks,
        startElapsed: region.startTime - sessionStart
      });
    }

    // Main layout pass
    let prevElapsed = null;
    let activeRegion = null;
    let regionStartY = 0;

    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      const col = columnFor.get(interaction.id) || 0;
      const height = computeNodeHeight(interaction);
      const elapsed = interaction.timestamp - sessionStart;
      const x = C.RULER_WIDTH + col * (availWidth + C.COLUMN_GAP);
      const region = idxRegion[idx];
      let y;

      if (region) {
        // Entering a new parallel region
        if (activeRegion !== region) {
          if (prevElapsed != null && (elapsed - prevElapsed) > C.ZIGZAG_MIN_CUT) {
            const breakY = globalBottom + C.MIN_GAP + GAP_COLLAPSE_HEIGHT / 2;
            breaks.push({ y: breakY, elapsedBefore: prevElapsed, elapsedAfter: elapsed });
            globalBottom = breakY + GAP_COLLAPSE_HEIGHT / 2;
          }
          activeRegion = region;
          regionStartY = globalBottom + C.MIN_GAP;
        }

        if (col === 0) {
          const colBottom = colBottoms.get(0) || globalBottom;
          y = colBottom + C.MIN_GAP;
          // PostToolUse/Agent hooks must sit at or below the closed subagent column bottom
          const closedCol = postHookClosedCol && postHookClosedCol.get(interaction.id);
          if (closedCol != null && colBottoms.has(closedCol)) {
            y = Math.max(y, colBottoms.get(closedCol) + C.MIN_GAP);
          }
        } else {
          // Subagent columns: time-proportional positioning
          const rs = regionCache.get(region);
          const compE = rs.compressElapsed(elapsed);
          const compStart = rs.compressElapsed(rs.startElapsed);
          const timeY = regionStartY + (compE - compStart) * rs.scale;

          y = colBottoms.has(col)
            ? Math.max(timeY, colBottoms.get(col) + C.MIN_GAP)
            : timeY;
        }
      } else {
        // Sequential: compact stacking
        if (activeRegion) activeRegion = null;

        if (prevElapsed != null && (elapsed - prevElapsed) > C.ZIGZAG_MIN_CUT) {
          const breakY = globalBottom + C.MIN_GAP + GAP_COLLAPSE_HEIGHT / 2;
          breaks.push({ y: breakY, elapsedBefore: prevElapsed, elapsedAfter: elapsed });
          globalBottom = breakY + GAP_COLLAPSE_HEIGHT / 2;
        }

        if (col === 0) {
          let maxBottom = globalBottom;
          for (const b of colBottoms.values()) {
            if (b > maxBottom) maxBottom = b;
          }
          y = maxBottom + C.MIN_GAP;
        } else {
          const colBottom = colBottoms.get(col) || globalBottom;
          y = colBottom + C.MIN_GAP;
        }
      }

      layout.push({ id: interaction.id, x, y, width: availWidth, height, col, interaction, elapsed });
      colBottoms.set(col, y + height);
      if (y + height > globalBottom) globalBottom = y + height;
      prevElapsed = elapsed;
    }

    // Stretch shorter subagent columns in parallel regions so all span equal height
    // Column 0 (main thread) is never stretched — it keeps its natural height.
    for (const region of (parallelRegions || [])) {
      const colItems = new Map();
      for (let i = region.startIdx; i <= region.endIdx; i++) {
        const item = layout[i];
        if (!colItems.has(item.col)) colItems.set(item.col, []);
        colItems.get(item.col).push(item);
      }
      let tallestBottom = 0;
      for (const [c, items] of colItems) {
        if (c === 0) continue;
        const last = items[items.length - 1];
        if (last.y + last.height > tallestBottom) tallestBottom = last.y + last.height;
      }
      for (const [col, items] of colItems) {
        if (col === 0) continue;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const stretchable = !item.interaction.isHook && !item.interaction.isMcp
            && isStandardLlm(item.interaction);
          if (!stretchable) continue;
          if (i < items.length - 1) {
            item.height = Math.max(item.height, items[i + 1].y - item.y - C.MIN_GAP);
          } else {
            item.height = Math.max(item.height, tallestBottom - item.y);
          }
        }
      }
    }

    // Build monotonic elapsed→Y interpolation from layout
    const yPoints = layout.map(item => ({ elapsed: item.elapsed, y: item.y }));
    for (let i = 1; i < yPoints.length; i++) {
      if (yPoints[i].y < yPoints[i - 1].y) yPoints[i].y = yPoints[i - 1].y;
    }
    function elapsedToY(t) {
      if (yPoints.length === 0) return C.HEADER_HEIGHT + 8;
      if (t <= yPoints[0].elapsed) return yPoints[0].y;
      if (t >= yPoints[yPoints.length - 1].elapsed) return yPoints[yPoints.length - 1].y;
      for (let i = 0; i < yPoints.length - 1; i++) {
        if (yPoints[i].elapsed <= t && t <= yPoints[i + 1].elapsed) {
          const dt = yPoints[i + 1].elapsed - yPoints[i].elapsed;
          if (dt === 0) return yPoints[i].y;
          const frac = (t - yPoints[i].elapsed) / dt;
          return yPoints[i].y + frac * (yPoints[i + 1].y - yPoints[i].y);
        }
      }
      return yPoints[yPoints.length - 1].y;
    }

    // Breaks from parallel-region internal gaps (uses elapsedToY for Y positioning)
    for (const region of (parallelRegions || [])) {
      const rs = regionCache.get(region);
      for (const br of rs.regionBreaks) {
        if (br.after - br.before <= C.ZIGZAG_MIN_CUT) continue;
        const yBefore = elapsedToY(br.before);
        const yAfter = elapsedToY(br.after);
        breaks.push({ y: (yBefore + yAfter) / 2, elapsedBefore: br.before, elapsedAfter: br.after });
      }
    }

    let finalBottom = C.HEADER_HEIGHT + 8;
    for (const item of layout) {
      if (item.y + item.height > finalBottom) finalBottom = item.y + item.height;
    }

    return { layout, totalHeight: finalBottom + 40, sessionStart, breaks, compressedY: elapsedToY };
  }

  function computeColumnWidth(totalColumns) {
    const container = document.getElementById('timeline-list');
    if (!container) return D3_CONST.COLUMN_WIDTH;
    const available = container.clientWidth - D3_CONST.RULER_WIDTH - 12;
    const perCol = Math.floor((available - (totalColumns - 1) * D3_CONST.COLUMN_GAP) / totalColumns);
    return Math.max(160, Math.min(D3_CONST.COLUMN_WIDTH, perCol));
  }

  // --- Build node HTML elements (reusing existing patterns) ---

  function buildD3TurnEl(interaction, turnNum, isSubagentTurn) {
    const stdLlm = isStandardLlm(interaction);

    if (!stdLlm) {
      const group = document.createElement('div');
      group.className = `turn-group endpoint-call-group status-${interaction.status || 'pending'}`;
      group.dataset.turnId = interaction.id;

      const el = document.createElement('div');
      el.className = 'timeline-entry turn-entry endpoint-call-entry';
      el.dataset.id = interaction.id;

      const ep = interaction.endpoint.replace('/v1/messages/', '');
      const statusClass = badgeClass(interaction.status);
      el.innerHTML = `
        <span class="endpoint-label">${escHtml(ep)}</span>
        <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${interaction.status || 'pending'}</span>
        <span class="entry-tokens" data-tokenlabel="${interaction.id}">${compactTokens(interaction.usage)}</span>
      `;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        select({ type: 'turn', id: interaction.id }, { userClick: true });
      });
      group.appendChild(el);
      return group;
    }

    const group = document.createElement('div');
    let cls = 'turn-group';
    if (isNewUserTurn(interaction)) cls += ' new-user-turn';
    if (interaction.subagent?.isSidechain) cls += ' sidechain-group';
    else if (interaction.subagent?.agentType) cls += ' subagent-group';
    cls += ` status-${interaction.status || 'pending'}`;
    group.className = cls;
    group.dataset.turnId = interaction.id;

    if (interaction.subagent?.agentId) {
      registerSubagent(interaction.subagent);
      group.dataset.agentId = interaction.subagent.agentId;
      group.style.setProperty('--subagent-color', getSubagentColor(interaction.subagent));
    }

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry';
    el.dataset.id = interaction.id;

    const statusClass = badgeClass(interaction.status);
    const profile = interaction.profile || '';
    const stepId = interaction.stepId || '';
    const model = interaction.request?.model || 'unknown';
    const shortModel = model.replace('claude-', '').split('-202')[0];
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';

    const modelLabel = profile ? `<span class="entry-profile">${escHtml(profile)}</span> ${escHtml(shortModel)}` : escHtml(shortModel);
    let turnLabel = '';
    if (turnNum != null) {
      const turnPrefix = isSubagentTurn ? 'Turn S' : 'Turn ';
      turnLabel = stepId ? `${turnPrefix}${turnNum} <span class="entry-step">${escHtml(stepId)}</span>` : `${turnPrefix}${turnNum}`;
    }
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
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.addEventListener('click', () => {
      select({ type: 'turn', id: interaction.id }, { userClick: true });
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

  function buildD3HookEl(interaction) {
    const hookEvent = interaction.hookEvent || 'Hook';
    const toolName = interaction.toolName || '';
    const arrow = /post/i.test(hookEvent) ? '←' : '→';
    const subType = interaction.subagent?.agentType;
    const label = subType ? `${toolName} (${subType})` : toolName;

    const group = document.createElement('div');
    group.className = `turn-group hook-call-group status-${interaction.status || 'complete'}`;
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry hook-call-entry';
    el.dataset.id = interaction.id;

    el.innerHTML = `
      <span class="hook-arrow">${arrow}</span>
      <span class="hook-label">${escHtml(/pre/i.test(hookEvent) ? 'pre' : 'post')}</span>
      <span class="hook-tool-name">${escHtml(label)}</span>
    `;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.appendChild(el);
    return group;
  }

  function buildD3McpEl(interaction) {
    const group = document.createElement('div');
    group.className = `turn-group mcp-call-group status-${interaction.status || 'complete'}`;
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
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    group.appendChild(el);
    return group;
  }

  // --- Time ruler ---

  function formatWallTime(epochMs) {
    const d = new Date(epochMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function renderTimeRuler(svg, layout, sessionStart, totalHeight, breaks, elapsedToY) {
    if (layout.length === 0) return;
    breaks = breaks || [];

    const rulerG = svg.select('.tl-time-ruler');
    rulerG.selectAll('*').remove();

    const svgNode = svg.node();
    const svgWidth = (svgNode?.parentElement?.clientWidth || svgNode?.clientWidth || 800);
    const lineX1 = D3_CONST.RULER_WIDTH + 2;
    const axisX = D3_CONST.RULER_WIDTH;
    const minTickGap = 36;
    const breakHalf = 7;

    // Generate tick candidates at fixed 10-second intervals using elapsedToY
    const maxElapsed = layout[layout.length - 1].elapsed;
    const interval = D3_CONST.TICK_INTERVAL;
    const candidates = [];

    // First tick aligned to 10s boundary of wall-clock time
    const startRem = sessionStart % interval;
    const firstOffset = startRem === 0 ? interval : (interval - startRem);
    for (let t = firstOffset; t <= maxElapsed; t += interval) {
      const inGap = breaks.some(br => t > br.elapsedBefore && t < br.elapsedAfter);
      if (inGap) continue;
      const y = elapsedToY ? elapsedToY(t) : (D3_CONST.HEADER_HEIGHT + 8 + t * D3_CONST.TIME_SCALE);
      candidates.push({ y, elapsed: t });
    }

    // Also add ticks at the first and last layout items for context
    if (layout.length > 0) {
      candidates.push({ y: layout[0].y, elapsed: layout[0].elapsed });
      if (layout.length > 1) {
        const last = layout[layout.length - 1];
        candidates.push({ y: last.y, elapsed: last.elapsed });
      }
    }

    // Sort by elapsed (guarantees monotonic time), then by Y
    candidates.sort((a, b) => a.elapsed - b.elapsed || a.y - b.y);

    // Deduplicate and ensure monotonic elapsed
    const deduped = [];
    let lastElapsed = -Infinity;
    for (const c of candidates) {
      if (c.elapsed <= lastElapsed) continue;
      deduped.push(c);
      lastElapsed = c.elapsed;
    }

    // Filter out ticks too close in Y-space or near break indicators
    const ticks = [];
    let lastY = -Infinity;
    for (const c of deduped) {
      if (c.y - lastY < minTickGap) continue;
      const nearBreak = breaks.some(br => Math.abs(c.y - br.y) < breakHalf + 8);
      if (nearBreak) continue;
      ticks.push(c);
      lastY = c.y;
    }

    // Draw tick labels and horizontal grid lines
    for (const { y, elapsed } of ticks) {
      const wallMs = sessionStart + elapsed;
      const isMajor = new Date(wallMs).getSeconds() === 0;
      const tickG = rulerG.append('g').attr('class', 'tick' + (isMajor ? ' tick-major' : '')).attr('transform', `translate(0,${y})`);
      tickG.append('line')
        .attr('x1', lineX1)
        .attr('x2', svgWidth);
      tickG.append('text')
        .attr('x', D3_CONST.RULER_WIDTH - 4)
        .attr('y', 0)
        .attr('dy', '0.32em')
        .attr('text-anchor', 'end')
        .text(formatWallTime(wallMs));
    }

    // Draw vertical axis line with break interruptions
    const axisTop = D3_CONST.HEADER_HEIGHT;
    const axisBottom = totalHeight - 20;
    const sortedBreaks = [...breaks].sort((a, b) => a.y - b.y);

    let segStart = axisTop;
    for (const br of sortedBreaks) {
      const brTop = br.y - breakHalf;
      const brBottom = br.y + breakHalf;
      if (brTop > segStart) {
        rulerG.append('line')
          .attr('class', 'axis-line')
          .attr('x1', axisX).attr('x2', axisX)
          .attr('y1', segStart).attr('y2', brTop);
      }
      const zw = 4;
      rulerG.append('path')
        .attr('class', 'axis-break')
        .attr('d', `M${axisX},${brTop} l${zw},${breakHalf * 0.5} l${-zw * 2},${breakHalf} l${zw},${breakHalf * 0.5}`)
        .attr('fill', 'none');
      const cutMs = br.elapsedAfter - br.elapsedBefore;
      const cutSec = Math.round(cutMs / 1000);
      const cutLabel = cutSec >= 60 ? `${Math.floor(cutSec / 60)}m${cutSec % 60 ? ` ${cutSec % 60}s` : ''}` : `${cutSec}s`;
      rulerG.append('text')
        .attr('class', 'axis-break-label')
        .attr('x', axisX - 6)
        .attr('y', br.y)
        .attr('dy', '0.32em')
        .attr('text-anchor', 'end')
        .text(`-${cutLabel}`);
      segStart = brBottom;
    }
    if (segStart < axisBottom) {
      rulerG.append('line')
        .attr('class', 'axis-line')
        .attr('x1', axisX).attr('x2', axisX)
        .attr('y1', segStart).attr('y2', axisBottom);
    }
  }

  // --- SVG connectors ---

  function computeConnectorData(layout, columnFor, columnAgents, totalColumns, elapsedToY, sessionStart, postHookClosedCol) {
    const connectors = [];
    const colEntries = new Map();

    for (const item of layout) {
      if (!colEntries.has(item.col)) colEntries.set(item.col, []);
      colEntries.get(item.col).push({ y: item.y, yBottom: item.y + item.height, id: item.id, x: item.x, width: item.width, interaction: item.interaction });
    }

    // Reverse map: subagent column → PostToolUse/Agent hook entry in main thread
    const colToPostHook = new Map();
    if (postHookClosedCol) {
      const mainEntryById = new Map();
      for (const me of (colEntries.get(0) || [])) mainEntryById.set(me.id, me);
      for (const [hookId, closedCol] of postHookClosedCol) {
        const me = mainEntryById.get(hookId);
        if (me) colToPostHook.set(closedCol, me);
      }
    }

    const mainEntries = colEntries.get(0);

    const colWidth = computeColumnWidth(totalColumns);
    for (let col = 1; col < totalColumns; col++) {
      const entries = colEntries.get(col);
      if (!entries || entries.length === 0) continue;

      const agent = columnAgents.get(col);
      const color = agent ? getSubagentColor(agent) : SUBAGENT_COLORS[0];

      const bgLeft = D3_CONST.RULER_WIDTH + col * (colWidth + D3_CONST.COLUMN_GAP) - 4;
      const bgTop = entries[0].y - 4;

      // Bg rect bottom: use end time of last entry (timestamp + duration) if available
      const lastEntry = entries[entries.length - 1];
      let bgBottom = lastEntry.yBottom + 4;
      if (elapsedToY && sessionStart != null && lastEntry.interaction) {
        const endTs = lastEntry.interaction.timestamp + (lastEntry.interaction.timing?.duration || 0);
        const timeBottom = elapsedToY(endTs - sessionStart);
        bgBottom = Math.max(timeBottom, lastEntry.yBottom) + 4;
      }

      const mainX = D3_CONST.RULER_WIDTH + colWidth / 2;

      // Fork: starts from center of preToolUse hook node
      let forkOriginY = bgTop;
      let forkOriginX = mainX;
      if (mainEntries) {
        for (let i = mainEntries.length - 1; i >= 0; i--) {
          if (mainEntries[i].y <= entries[0].y) {
            forkOriginY = (mainEntries[i].y + mainEntries[i].yBottom) / 2;
            forkOriginX = mainEntries[i].x + mainEntries[i].width / 2;
            break;
          }
        }
      }

      const cpX = (bgLeft - forkOriginX) * 0.6;
      connectors.push({
        type: 'fork',
        col,
        path: `M${forkOriginX},${forkOriginY} C${forkOriginX + cpX},${forkOriginY} ${bgLeft - cpX},${bgTop} ${bgLeft},${bgTop}`,
        color,
        opacity: 0.6,
        strokeWidth: 1.5,
        agentId: agent?.agentId,
      });

      // Merge: from bg rect bottom-center to center of corresponding PostToolUse/Agent hook
      let mergeTargetY = null;
      let mergeTargetX = mainX;
      const directHook = colToPostHook.get(col);
      if (directHook) {
        mergeTargetY = directHook.y + directHook.height / 2;
        mergeTargetX = directHook.x + directHook.width / 2;
      } else if (mainEntries) {
        for (const me of mainEntries) {
          if (me.y >= lastEntry.yBottom) {
            mergeTargetY = me.yBottom;
            mergeTargetX = me.x + me.width / 2;
            break;
          }
        }
      }
      if (mergeTargetY != null) {
        const bgCenterX = bgLeft + (colWidth + 8) / 2;
        const mCpX = (bgCenterX - mergeTargetX) * 0.6;
        connectors.push({
          type: 'merge',
          col,
          path: `M${bgCenterX},${bgBottom} C${bgCenterX - mCpX},${bgBottom} ${mergeTargetX + mCpX},${mergeTargetY} ${mergeTargetX},${mergeTargetY}`,
          color,
          opacity: 0.5,
          strokeWidth: 1.5,
          agentId: agent?.agentId,
        });
      }
    }

    return connectors;
  }

  function renderConnectors(svgBg, svgFg, connectors, layout, columnAgents, totalColumns, elapsedToY, sessionStart) {
    const gBg = svgBg.select('.tl-connectors');
    gBg.selectAll('*').remove();
    const gFg = svgFg.select('.tl-connectors-fg');
    gFg.selectAll('*').remove();

    let defsFg = svgFg.select('defs');
    if (defsFg.empty()) defsFg = svgFg.append('defs');
    defsFg.selectAll('.connector-marker').remove();

    // Fork diamond marker (in foreground SVG)
    defsFg.append('marker')
      .attr('class', 'connector-marker')
      .attr('id', 'fork-diamond')
      .attr('viewBox', '0 0 8 8')
      .attr('refX', 4).attr('refY', 4)
      .attr('markerWidth', 5).attr('markerHeight', 5)
      .append('path')
      .attr('d', 'M4,0.5 L7.5,4 L4,7.5 L0.5,4 Z')
      .attr('fill', 'var(--accent)');

    // Merge circle marker (in foreground SVG)
    defsFg.append('marker')
      .attr('class', 'connector-marker')
      .attr('id', 'merge-dot')
      .attr('viewBox', '0 0 8 8')
      .attr('refX', 4).attr('refY', 4)
      .attr('markerWidth', 5).attr('markerHeight', 5)
      .append('circle')
      .attr('cx', 4).attr('cy', 4).attr('r', 3)
      .attr('fill', 'var(--accent)').attr('opacity', 0.8);

    // Column background rects (in background SVG, behind nodes)
    const colWidth = computeColumnWidth(totalColumns);
    const colEntries = new Map();
    for (const item of layout) {
      if (!colEntries.has(item.col)) colEntries.set(item.col, []);
      colEntries.get(item.col).push(item);
    }
    for (let col = 1; col < totalColumns; col++) {
      const entries = colEntries.get(col);
      if (!entries || entries.length === 0) continue;
      const agent = columnAgents.get(col);
      const color = agent ? getSubagentColor(agent) : SUBAGENT_COLORS[0];
      const x = D3_CONST.RULER_WIDTH + col * (colWidth + D3_CONST.COLUMN_GAP) - 4;
      const yTop = entries[0].y - 4;
      const lastE = entries[entries.length - 1];
      let yBottom = lastE.y + lastE.height + 4;
      if (elapsedToY && sessionStart != null && lastE.interaction) {
        const endTs = lastE.interaction.timestamp + (lastE.interaction.timing?.duration || 0);
        const timeBottom = elapsedToY(endTs - sessionStart);
        yBottom = Math.max(timeBottom, lastE.y + lastE.height) + 4;
      }
      const isStreaming = entries.some(e => e.interaction.status === 'streaming');
      gBg.append('rect')
        .attr('class', 'col-bg-rect' + (isStreaming ? ' col-bg-streaming' : ''))
        .attr('data-agent-id', agent?.agentId || '')
        .attr('x', x)
        .attr('y', yTop)
        .attr('width', colWidth + 8)
        .attr('height', yBottom - yTop)
        .attr('rx', 6)
        .attr('ry', 6)
        .attr('fill', color)
        .attr('opacity', 0.08);
    }

    // Fork and merge curves (in foreground SVG, above nodes)
    for (const c of connectors) {
      const path = gFg.append('path')
        .attr('class', `connector-path connector-${c.type}`)
        .attr('d', c.path)
        .attr('stroke', c.color)
        .attr('stroke-width', c.strokeWidth)
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round')
        .attr('fill', 'none')
        .attr('opacity', c.opacity);

      if (c.type === 'fork') {
        path.attr('marker-start', 'url(#fork-diamond)');
        const pathNode = path.node();
        const length = pathNode.getTotalLength();
        path.attr('stroke-dasharray', `${length} ${length}`)
          .attr('stroke-dashoffset', length)
          .transition()
          .duration(400)
          .ease(d3.easeLinear)
          .attr('stroke-dashoffset', 0);
      }

      if (c.type === 'merge') {
        path.attr('marker-end', 'url(#merge-dot)');
      }

      if (c.agentId) {
        path.attr('data-agent-id', c.agentId);
      }
    }
  }

  // --- Streaming pulse for column backgrounds ---

  function startFlowAnimation(svg, agentId) {
    if (_flowAnimations.has(agentId)) return;
    const rect = svg.select(`.col-bg-rect[data-agent-id="${agentId}"]`);
    if (rect.empty()) return;
    rect.classed('col-bg-streaming', true);
    _flowAnimations.set(agentId, true);
  }

  function stopFlowAnimation(agentId) {
    if (!_flowAnimations.has(agentId)) return;
    _flowAnimations.delete(agentId);
    if (!_d3State?.svg) return;
    _d3State.svg.select(`.col-bg-rect[data-agent-id="${agentId}"]`).classed('col-bg-streaming', false);
  }

  function stopAllFlowAnimations() {
    _flowAnimations.clear();
    if (_d3State?.svg) _d3State.svg.selectAll('.col-bg-streaming').classed('col-bg-streaming', false);
  }

  // --- D3 Selection management ---

  function d3UpdateSelection(nodesLayer) {
    const sel = state.selection;
    if (!nodesLayer) return;
    const layer = typeof nodesLayer === 'string' ? document.querySelector(nodesLayer) : nodesLayer;
    if (!layer) return;

    layer.querySelectorAll('.turn-group.selected').forEach(el => el.classList.remove('selected'));
    layer.classList.toggle('has-selection', !!sel);

    if (sel) {
      const target = sel.type === 'turn'
        ? layer.querySelector(`.turn-group[data-turn-id="${sel.id}"]`)
        : layer.querySelector(`[data-tool-id="${sel.interactionId}-${sel.toolIndex}"]`);
      if (target) {
        const group = target.closest('.turn-group') || target;
        group.classList.add('selected');
      }
    }
  }

  // --- Main render ---

  function renderTimelineParallel() {
    const savedScroll = _liveMode ? null : timelineList.scrollTop;
    timelineList.innerHTML = '';
    resetSubagentRegistry();
    stopAllFlowAnimations();

    // Rebuild footer badges filtered to the active instance tab
    rebuildFooterBadgesForTab();

    const visible = state.interactions.filter(i => isVisibleInTimeline(i) && i.timestamp > 0 && !_inflightSet.has(i.id));
    if (visible.length === 0) return;

    // Detect session boundaries (gaps > 5 min) for visual separators
    const SESSION_GAP = 5 * 60 * 1000;
    const sessionBoundaries = new Set();
    for (let i = 1; i < visible.length; i++) {
      if (visible[i].timestamp - visible[i - 1].timestamp > SESSION_GAP) {
        sessionBoundaries.add(i);
      }
    }
    const filtered = visible;

    const assignment = buildColumnAssignment(filtered);
    const { columnFor, totalColumns, columnAgents, parallelRegions, postHookClosedCol } = assignment;
    const colWidth = computeColumnWidth(totalColumns);

    const { layout, totalHeight, sessionStart, breaks, compressedY } = computeD3Layout(filtered, columnFor, totalColumns, parallelRegions, postHookClosedCol);

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'tl-d3-wrapper';
    wrapper.style.height = totalHeight + 'px';

    // Lane headers
    const headers = document.createElement('div');
    headers.className = 'tl-lane-headers';

    // Ruler header
    const rulerHeader = document.createElement('div');
    rulerHeader.className = 'tl-lane-header';
    rulerHeader.style.width = D3_CONST.RULER_WIDTH + 'px';
    rulerHeader.textContent = '⏱';
    headers.appendChild(rulerHeader);

    for (let col = 0; col < totalColumns; col++) {
      const h = document.createElement('div');
      h.className = 'tl-lane-header';
      h.style.width = (colWidth + (col < totalColumns - 1 ? D3_CONST.COLUMN_GAP : 0)) + 'px';
      const agent = columnAgents.get(col);
      if (col === 0) {
        h.textContent = 'Main Thread';
      } else if (agent) {
        const label = getSubagentLabel(agent);
        const color = getSubagentColor(agent);
        h.textContent = label;
        if (color) { h.style.color = color; h.style.borderBottomColor = color; }
      } else {
        h.textContent = `Agent ${col}`;
      }
      headers.appendChild(h);
    }

    // SVG background layer (behind nodes): ruler + column backgrounds
    const svgColumnsWidth = D3_CONST.RULER_WIDTH + totalColumns * (colWidth + D3_CONST.COLUMN_GAP);
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('class', 'tl-connector-svg');
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', totalHeight);

    const svg = d3.select(svgEl);
    svg.append('defs');
    svg.append('g').attr('class', 'tl-time-ruler');
    svg.append('g').attr('class', 'tl-connectors');

    // Nodes layer
    const nodesLayer = document.createElement('div');
    nodesLayer.className = 'tl-nodes-layer';
    nodesLayer.style.height = totalHeight + 'px';

    // SVG foreground layer (above nodes): fork/merge curves
    const svgFgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgFgEl.setAttribute('class', 'tl-connector-svg tl-connector-fg');
    svgFgEl.setAttribute('width', '100%');
    svgFgEl.setAttribute('height', totalHeight);
    const svgFg = d3.select(svgFgEl);
    svgFg.append('defs');
    svgFg.append('g').attr('class', 'tl-connectors-fg');

    // Render nodes
    let turnNum = 0;
    const subagentTurnCounts = new Map();

    for (const item of layout) {
      const interaction = item.interaction;
      let el;

      if (interaction.isMcp) {
        el = buildD3McpEl(interaction);
      } else if (interaction.isHook) {
        el = buildD3HookEl(interaction);
      } else {
        let num, isSub = false;
        if (!isStandardLlm(interaction)) {
          num = undefined;
        } else {
          const agentId = interaction.subagent?.agentId;
          if (agentId) {
            const n = (subagentTurnCounts.get(agentId) || 0) + 1;
            subagentTurnCounts.set(agentId, n);
            num = n;
            isSub = true;
          } else {
            turnNum++;
            num = turnNum;
          }
        }
        el = buildD3TurnEl(interaction, num, isSub);
      }

      el.style.transform = `translate(${item.x}px, ${item.y}px)`;
      el.style.width = item.width + 'px';
      if (item.height > D3_CONST.MIN_ENTRY_HEIGHT) el.style.minHeight = item.height + 'px';
      nodesLayer.appendChild(el);
    }

    wrapper.appendChild(svgEl);
    wrapper.appendChild(nodesLayer);
    wrapper.appendChild(svgFgEl);
    timelineList.appendChild(headers);
    timelineList.appendChild(wrapper);

    // Render connectors: backgrounds in svg (behind nodes), curves in svgFg (above nodes)
    const connectors = computeConnectorData(layout, columnFor, columnAgents, totalColumns, compressedY, sessionStart, postHookClosedCol);
    renderConnectors(svg, svgFg, connectors, layout, columnAgents, totalColumns, compressedY, sessionStart);

    // Render time ruler
    renderTimeRuler(svg, layout, sessionStart, totalHeight, breaks, compressedY);

    // Render session boundary separators
    if (sessionBoundaries.size > 0) {
      const gSep = svg.select('.tl-connectors');
      const totalW = D3_CONST.RULER_WIDTH + totalColumns * (colWidth + D3_CONST.COLUMN_GAP);
      for (const idx of sessionBoundaries) {
        const itemAbove = layout[idx - 1];
        const itemBelow = layout[idx];
        if (!itemAbove || !itemBelow) continue;
        const sepY = (itemAbove.y + itemAbove.height + itemBelow.y) / 2;
        gSep.append('line')
          .attr('class', 'session-separator')
          .attr('x1', D3_CONST.RULER_WIDTH)
          .attr('x2', totalW)
          .attr('y1', sepY)
          .attr('y2', sepY);
      }
    }

    // Apply current selection
    d3UpdateSelection(nodesLayer);

    // Start bg pulse for any streaming subagents
    for (const item of layout) {
      if (item.interaction.status === 'streaming' && item.interaction.subagent?.agentId) {
        startFlowAnimation(svg, item.interaction.subagent.agentId);
      }
    }

    if (_liveMode) scrollTimelineToBottom();
    else if (savedScroll != null) timelineList.scrollTop = savedScroll;

    // Save state for incremental appends
    _d3State = {
      wrapper, svg, svgFg, nodesLayer, headers,
      columnFor, columnAgents, totalColumns,
      layout, totalHeight, sessionStart, breaks, compressedY,
      turnNum, subagentTurnCounts,
      activeColumns: assignment.activeColumns,
      historicalColumns: assignment.historicalColumns,
      freeColumns: assignment.freeColumns,
      nextColumn: assignment.nextColumn,
      parallelRegions,
      postHookClosedCol,
    };

    // Set up resize observer
    if (!_d3ResizeObserver) {
      _d3ResizeObserver = new ResizeObserver(() => {
        if (_timelineMode !== 'parallel' || !_d3State) return;
        _d3ResizeDebounce = _d3ResizeDebounce || requestAnimationFrame(() => {
          _d3ResizeDebounce = null;
          renderTimelineParallel();
        });
      });
    }
    _d3ResizeObserver.observe(document.getElementById('timeline'));
  }

  let _d3ResizeObserver = null;
  let _d3ResizeDebounce = null;

  // --- Incremental append ---

  function appendToParallelTimeline(interaction) {
    if (!_d3State) {
      renderTimelineParallel();
      return;
    }
    const ds = _d3State;

    // Determine column
    let agentId = null;
    if (interaction.isHook) {
      agentId = interaction.subagent?.agentId || resolveHookAgentId(interaction, state.interactions);
    } else {
      agentId = interaction.subagent?.agentId || null;
    }
    // PostToolUse/Agent hooks go to column 0
    if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
      agentId = null;
    }

    let col = 0;
    if (agentId) {
      if (!ds.activeColumns.has(agentId) && !ds.historicalColumns.has(agentId)) {
        col = ds.freeColumns.length > 0 ? ds.freeColumns.pop() : ds.nextColumn++;
        ds.activeColumns.set(agentId, col);
        ds.historicalColumns.set(agentId, col);
        if (interaction.subagent) {
          registerSubagent(interaction.subagent);
          ds.columnAgents.set(col, interaction.subagent);
        }
      }
      col = ds.activeColumns.get(agentId) || ds.historicalColumns.get(agentId) || 0;
    }

    // Full re-render when parallel activity is detected or columns change
    if (col >= ds.totalColumns || ds.activeColumns.size > 0 || col > 0) {
      renderTimelineParallel();
      return;
    }

    // Sequential compact stacking for single-column appends
    const colWidth = computeColumnWidth(ds.totalColumns);
    const height = computeNodeHeight(interaction);
    const elapsed = interaction.timestamp - ds.sessionStart;
    const x = D3_CONST.RULER_WIDTH + col * (colWidth + D3_CONST.COLUMN_GAP);

    let globalBottom = D3_CONST.HEADER_HEIGHT + 8;
    for (const item of ds.layout) {
      const b = item.y + item.height;
      if (b > globalBottom) globalBottom = b;
    }

    const y = globalBottom + D3_CONST.MIN_GAP;

    const item = { id: interaction.id, x, y, width: colWidth, height, col, interaction, elapsed };
    ds.layout.push(item);
    ds.columnFor.set(interaction.id, col);

    // Update total height
    const newTotalHeight = Math.max(ds.totalHeight, y + height + 40);
    if (newTotalHeight > ds.totalHeight) {
      ds.totalHeight = newTotalHeight;
      ds.wrapper.style.height = newTotalHeight + 'px';
      ds.nodesLayer.style.height = newTotalHeight + 'px';
      ds.svg.attr('height', newTotalHeight);
      ds.svgFg.attr('height', newTotalHeight);
    }

    // Build and append element
    let el;
    if (interaction.isMcp) {
      el = buildD3McpEl(interaction);
    } else if (interaction.isHook) {
      el = buildD3HookEl(interaction);
    } else {
      let num, isSub = false;
      if (!isStandardLlm(interaction)) {
        num = undefined;
      } else if (agentId) {
        const n = (ds.subagentTurnCounts.get(agentId) || 0) + 1;
        ds.subagentTurnCounts.set(agentId, n);
        num = n;
        isSub = true;
      } else {
        ds.turnNum++;
        num = ds.turnNum;
      }
      el = buildD3TurnEl(interaction, num, isSub);
    }

    el.style.width = colWidth + 'px';
    if (height > D3_CONST.MIN_ENTRY_HEIGHT) el.style.minHeight = height + 'px';
    el.style.opacity = '0';
    el.style.transform = `translate(${x}px, ${y - 8}px)`;
    ds.nodesLayer.appendChild(el);

    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.25s cubic-bezier(0.33,1,0.68,1), transform 0.25s cubic-bezier(0.33,1,0.68,1)';
      el.style.opacity = '1';
      el.style.transform = `translate(${x}px, ${y}px)`;
    });

    const connectors = computeConnectorData(ds.layout, ds.columnFor, ds.columnAgents, ds.totalColumns, ds.compressedY, ds.sessionStart, ds.postHookClosedCol);
    renderConnectors(ds.svg, ds.svgFg, connectors, ds.layout, ds.columnAgents, ds.totalColumns, ds.compressedY, ds.sessionStart);
    renderTimeRuler(ds.svg, ds.layout, ds.sessionStart, ds.totalHeight, ds.breaks || [], ds.compressedY);

    // Handle agent close
    if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
      const hookIdx = state.interactions.indexOf(interaction);
      const closedAgentId = resolveClosedAgentId(interaction, state.interactions, hookIdx >= 0 ? hookIdx : state.interactions.length - 1, ds.activeColumns);
      if (closedAgentId) {
        stopFlowAnimation(closedAgentId);
        ds.freeColumns.push(ds.activeColumns.get(closedAgentId));
        ds.activeColumns.delete(closedAgentId);
      }
    }

    if (interaction.status === 'streaming' && interaction.subagent?.agentId) {
      startFlowAnimation(ds.svg, interaction.subagent.agentId);
    }

    d3UpdateSelection(ds.nodesLayer);
  }

  // --- D3 status update hook (called from updateTurnBadge) ---

  function d3UpdateNodeStatus(id, status) {
    if (!_d3State) return;
    const node = _d3State.nodesLayer.querySelector(`.turn-group[data-turn-id="${id}"]`);
    if (!node) return;

    node.className = node.className
      .replace(/\bstatus-\w+/g, '')
      .replace(/\s+/g, ' ')
      .trim() + ` status-${status}`;

    // Manage bg pulse for subagents
    const agentId = node.dataset.agentId;
    if (agentId) {
      if (status === 'streaming') {
        startFlowAnimation(_d3State.svg, agentId);
      } else {
        stopFlowAnimation(agentId);
      }
    }
  }

  // --- Footer streaming badges ---

  function _footerBadgeStats(interaction) {
    const req = interaction.request || {};
    const msgCount = req.messages?.length || 0;
    const toolCount = req.tools?.length || 0;
    return { msgCount, toolCount };
  }

  function _updateFooterBadgeStats(badge, interaction) {
    const { msgCount, toolCount } = _footerBadgeStats(interaction);
    const statsEl = badge.querySelector('.badge-stats');
    if (statsEl) {
      const parts = [];
      if (msgCount > 0) parts.push(`${msgCount} msg`);
      if (toolCount > 0) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`);
      statsEl.textContent = parts.join(', ');
    }
    const statusEl = badge.querySelector('.badge-status');
    if (statusEl) {
      const status = interaction.status || 'pending';
      statusEl.textContent = status;
      statusEl.className = 'badge-status badge-status-' + status;
    }
  }

  function rebuildFooterBadgesForTab() {
    for (const iv of _inflightTimers.values()) clearInterval(iv);
    _inflightSet.clear();
    _inflightTimers.clear();
    const container = document.getElementById('timeline-footer-streaming');
    if (container) container.innerHTML = '';

    for (const interaction of state.interactions) {
      if (!isVisibleInTimeline(interaction)) continue;
      const iStatus = interaction.status || 'pending';
      const isLongLived = !interaction.isHook && !interaction.isMcp;
      if (isLongLived && (iStatus === 'pending' || iStatus === 'streaming')) {
        addFooterBadge(interaction);
      }
    }
  }

  function addFooterBadge(interaction) {
    if (_inflightSet.has(interaction.id)) return;
    _inflightSet.add(interaction.id);

    const container = document.getElementById('timeline-footer-streaming');
    if (!container) return;

    const badge = document.createElement('div');
    const statusCls = interaction.status === 'streaming' ? ' is-streaming' : ' is-pending';
    badge.className = 'footer-streaming-badge' + statusCls;
    badge.dataset.interactionId = interaction.id;

    const agentLabel = interaction.subagent
      ? getSubagentLabel(interaction.subagent)
      : 'main';
    const agentColor = interaction.subagent?.agentId
      ? getSubagentColor(interaction.subagent)
      : 'var(--accent)';

    const status = interaction.status || 'pending';
    badge.innerHTML =
      `<span class="badge-agent-dot" style="background:${agentColor}"></span>` +
      `<span class="badge-label">${escHtml(agentLabel)}</span>` +
      `<span class="badge-stats"></span>` +
      `<span class="badge-status badge-status-${status}">${status}</span>` +
      `<span class="badge-elapsed">0s</span>`;

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      select({ type: 'turn', id: interaction.id }, { userClick: true });
    });

    container.appendChild(badge);
    _updateFooterBadgeStats(badge, interaction);
    _updateFooterBusyIndicator();

    const startedAt = interaction.timing?.startedAt || Date.now();
    const iv = setInterval(() => {
      const elapsedEl = badge.querySelector('.badge-elapsed');
      if (elapsedEl) elapsedEl.textContent = formatDuration(Date.now() - startedAt);
    }, 1000);
    _inflightTimers.set(interaction.id, iv);
  }

  function removeFooterBadge(id) {
    if (!_inflightSet.has(id)) return;
    _inflightSet.delete(id);

    const iv = _inflightTimers.get(id);
    if (iv != null) { clearInterval(iv); _inflightTimers.delete(id); }

    const container = document.getElementById('timeline-footer-streaming');
    const badge = container?.querySelector(`[data-interaction-id="${id}"]`);
    if (badge) {
      badge.classList.add('animate-out');
      setTimeout(() => badge.remove(), 300);
    }

    _updateFooterBusyIndicator();

    if (_timelineMode === 'parallel') {
      setTimeout(() => renderTimelineParallel(), 320);
    }
  }

  function _updateFooterBusyIndicator() {
    const container = document.getElementById('timeline-footer-streaming');
    if (!container) return;
    let indicator = container.querySelector('.footer-busy-indicator');
    if (_inflightSet.size > 0) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'footer-busy-indicator';
        indicator.innerHTML =
          '<span class="busy-dot"></span>' +
          '<span class="busy-dot"></span>' +
          '<span class="busy-dot"></span>';
        container.appendChild(indicator);
      }
    } else {
      if (indicator) indicator.remove();
    }
  }

  function clearAllFooterBadges() {
    for (const iv of _inflightTimers.values()) clearInterval(iv);
    _inflightSet.clear();
    _inflightTimers.clear();
    const container = document.getElementById('timeline-footer-streaming');
    if (container) container.innerHTML = '';
  }

  // === END D3 PARALLEL TIMELINE ===

  function appendTurnToTimeline(interaction, turnNum, isSubagentTurn) {
    if (turnNum === undefined) turnNum = llmTurnNumber(interaction);

    if (interaction.isMcp) {
      return appendMcpCallToTimeline(interaction);
    }
    if (interaction.isHook) {
      return appendHookEntryToTimeline(interaction);
    }

    if (!isStandardLlm(interaction)) {
      const group = document.createElement('div');
      group.className = 'turn-group endpoint-call-group';
      group.dataset.turnId = interaction.id;

      const el = document.createElement('div');
      el.className = 'timeline-entry turn-entry endpoint-call-entry';
      el.dataset.id = interaction.id;

      const ep = interaction.endpoint.replace('/v1/messages/', '');
      const statusClass = badgeClass(interaction.status);
      el.innerHTML = `
        <span class="endpoint-label">${escHtml(ep)}</span>
        <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${interaction.status || 'pending'}</span>
        <span class="entry-tokens" data-tokenlabel="${interaction.id}">${compactTokens(interaction.usage)}</span>
      `;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        select({ type: 'turn', id: interaction.id }, { userClick: true });
      });
      group.appendChild(el);
      timelineList.appendChild(group);
      return;
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

    const statusClass = badgeClass(interaction.status);
    const profile = interaction.profile || '';
    const stepId = interaction.stepId || '';
    const model = interaction.request?.model || 'unknown';
    const shortModel = model.replace('claude-', '').split('-202')[0];
    const durationHtml = interaction.timing?.duration ? durationGauge(interaction.timing.duration) : '--';

    const modelLabel = profile ? `<span class="entry-profile">${escHtml(profile)}</span> ${escHtml(shortModel)}` : escHtml(shortModel);
    let turnLabel = '';
    if (turnNum != null) {
      const turnPrefix = isSubagentTurn ? 'Turn S' : 'Turn ';
      turnLabel = stepId ? `${turnPrefix}${turnNum} <span class="entry-step">${escHtml(stepId)}</span>` : `${turnPrefix}${turnNum}`;
    }
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
      select({ type: 'turn', id: interaction.id }, { userClick: true });
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
      select({ type: 'turn', id: interaction.id }, { userClick: true });
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
        select({ type: 'turn', id: interaction.id }, { userClick: true });
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
      select({ type: 'turn', id: interaction.id }, { userClick: true });
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
    if (_liveMode) scrollTimelineToBottom();
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
      select({ type: 'tool', interactionId, toolIndex: toolIdx }, { userClick: true });
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
      // Update footer badge streaming state and status text
      const footerBadge = document.querySelector(`.footer-streaming-badge[data-interaction-id="${id}"]`);
      if (footerBadge) {
        footerBadge.classList.toggle('is-pending', status === 'pending');
        footerBadge.classList.toggle('is-streaming', status === 'streaming');
        const statusEl = footerBadge.querySelector('.badge-status');
        if (statusEl) {
          statusEl.textContent = status;
          statusEl.className = 'badge-status badge-status-' + status;
        }
      }
    } else {
      stopDurationTimer(id);
      removeFooterBadge(id);
    }
    if (_timelineMode === 'parallel') d3UpdateNodeStatus(id, status);
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
      const modelSpan = modelEl.querySelector('.entry-model-label');
      if (modelSpan) {
        const model = interaction.request?.model || 'unknown';
        const shortModel = model.replace('claude-', '').split('-202')[0];
        const profile = interaction.profile || '';
        modelSpan.innerHTML = profile ? `<span class="entry-profile">${escHtml(profile)}</span> ${escHtml(shortModel)}` : escHtml(shortModel);
      }
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

  const _pendingSseRequests = new Set();

  function select(sel, { userClick = false } = {}) {
    state.selection = sel;

    document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));

    if (_timelineMode === 'parallel' && _d3State) {
      d3UpdateSelection(_d3State.nodesLayer);
    }

    if (sel.type === 'turn') {
      const el = document.querySelector(`.turn-entry[data-id="${sel.id}"]`);
      if (el) {
        el.classList.add('selected');
        if (userClick) el.scrollIntoView({ block: 'nearest' });
      }

      const interaction = state.interactions.find(i => i.id === sel.id);
      if (!interaction) return;

      // Lazy-load sseEvents for completed streaming interactions
      if (interaction.isStreaming && !interaction.response?.sseEvents?.length && !_pendingSseRequests.has(interaction.id)) {
        _pendingSseRequests.add(interaction.id);
        sendWs({ type: 'interaction:getSseEvents', id: interaction.id });
      }

      emptyState.classList.add('hidden');
      detailContent.classList.remove('hidden');
      renderTurnDetail(interaction);
    } else if (sel.type === 'tool') {
      const el = document.querySelector(`[data-tool-id="${sel.interactionId}-${sel.toolIndex}"]`);
      if (el) {
        el.classList.add('selected');
        if (userClick) el.scrollIntoView({ block: 'nearest' });
      }

      const interaction = state.interactions.find(i => i.id === sel.interactionId);
      if (!interaction) return;

      if (interaction.isStreaming && !interaction.response?.sseEvents?.length && !_pendingSseRequests.has(interaction.id)) {
        _pendingSseRequests.add(interaction.id);
        sendWs({ type: 'interaction:getSseEvents', id: interaction.id });
      }

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
      const charLen = typeof req.system === 'string' ? req.system.length : JSON.stringify(req.system).length;
      html += `<details>
        <summary>System Prompt ${charGauge(charLen)}</summary>
        ${jsonBlock(req.system)}</pre>
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
      html += `<details>
        <summary>Tools ${req.tools.length} ${charGauge(toolChars)}</summary>
        <div class="json-block">${renderTools(req.tools)}</div>
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

    const stdLlmResp = isStandardLlm(interaction);
    if (interaction.isStreaming && resp.sseEvents?.length > 0) {
      html += renderAccumulatedBlocks(resp.sseEvents);
    } else if (resp.body) {
      if (!stdLlmResp) {
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
    detailContent.querySelectorAll('details.jt-node').forEach(d => d.open = true);
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
        select({ type: 'turn', id: link.dataset.turnId }, { userClick: true });
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

  function renderTools(tools) {
    return tools.map(tool => {
      const name = tool.name || 'unnamed';
      const desc = tool.description ? truncate(tool.description, 90) : '';
      return `<details>
        <summary><strong>${escHtml(name)}</strong>${desc ? ` <span style="color:var(--text-dim)">— ${escHtml(desc)}</span>` : ''}</summary>
        ${jsonBlock(tool)}</pre>
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
    const pct = Math.max(0, Math.min(secs / 500, 1));
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

  function handleCliSpawned(msg) {
    if (!msg.instanceId) return;
    const existing = knownInstances.get(msg.instanceId);
    if (existing) {
      existing.tabId = msg.tabId;
      existing.cwd = msg.cwd || existing.cwd;
      existing.status = 'running';
    } else {
      knownInstances.set(msg.instanceId, {
        instanceId: msg.instanceId, profileName: null,
        status: 'running', spawnedAt: Date.now(),
        cwd: msg.cwd || null, tabId: msg.tabId || null,
      });
    }
    renderInspectorTabStrip();
  }

  // --- Message handler ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        extTabCounter = 0;
        activeExtTab = null;
        knownInstances.clear();
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
        // Suppress autoclear during init — all instances appear exited until
        // claude:instances arrives with actual running statuses
        _suppressAutoClear = true;
        renderInspectorTabStrip();
        _suppressAutoClear = false;
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
          if (_timelineMode === 'parallel') {
            const iStatus = msg.interaction.status || 'pending';
            const isLongLived = !msg.interaction.isHook && !msg.interaction.isMcp;
            if (isLongLived && (iStatus === 'pending' || iStatus === 'streaming')) {
              addFooterBadge(msg.interaction);
            } else {
              appendToParallelTimeline(msg.interaction);
            }
          } else {
            appendTurnToTimeline(msg.interaction);
          }
          if (_liveMode) {
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

      case 'interaction:sseEvents': {
        _pendingSseRequests.delete(msg.id);
        const sseIdx = state.interactions.findIndex(i => i.id === msg.id);
        if (sseIdx >= 0) {
          if (!state.interactions[sseIdx].response) state.interactions[sseIdx].response = {};
          state.interactions[sseIdx].response.sseEvents = msg.sseEvents || [];
          if (state.selection?.id === msg.id || state.selection?.interactionId === msg.id) {
            select(state.selection);
          }
        }
        break;
      }

      case 'cleared':
        state.interactions = [];
        state.selection = null;
        knownInstances.clear();
        activeInstanceTab = 'all';
        extTabCounter = 0;
        activeExtTab = null;
        stopAllFlowAnimations();
        clearAllFooterBadges();
        _d3State = null;
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
          const activeIds = new Set(msg.instances.map(i => i.instanceId));
          for (const inst of msg.instances) {
            const existing = knownInstances.get(inst.instanceId);
            knownInstances.set(inst.instanceId, {
              instanceId: inst.instanceId, profileName: inst.profileName,
              status: inst.status, spawnedAt: inst.spawnedAt,
              cwd: inst.cwd || existing?.cwd || null,
              tabId: inst.tabId || existing?.tabId || null,
            });
          }
          for (const [id, info] of knownInstances) {
            if (id.startsWith('cli-') && info.status === 'exited' && !activeIds.has(id)) {
              knownInstances.delete(id);
            }
          }
          if (!knownInstances.has(activeInstanceTab)) {
            const fallback = knownInstances.size > 0 ? knownInstances.keys().next().value : 'all';
            switchInstanceTab(fallback);
            break;
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

  window.inspectorModule = { handleMessage, handleCliSpawned, instanceDisplayLabel, renderInspectorTabStrip, switchInstanceTab };
})();
