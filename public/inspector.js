(function() {
  'use strict';
  const { state, escHtml, highlightJSON, renderJSON, jsonBlock, formatDuration, truncate,
          renderMarkdown, renderMarkdownDebounced, cancelRenderDebounce, sendWs,
          timelineList, detailContent, emptyState, statsEl } = window.dashboard;

  let cachedSessions = [];

  // --- Auto-select suppression: don't jump away from user-selected turns ---
  let _userPinnedSelection = false;

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

  // --- Timeline filter ---
  let activeTimelineFilter = 'all';
  const timelineFilter = document.getElementById('timelineFilter');
  if (timelineFilter) {
    timelineFilter.addEventListener('change', () => {
      activeTimelineFilter = timelineFilter.value;
      renderTimeline();
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

    if (event.eventType === 'message_start' && event.data?.message?.usage) {
      interaction.usage = { ...event.data.message.usage };
    }
    if (event.eventType === 'message_delta' && event.data?.usage) {
      interaction.usage = { ...interaction.usage, ...event.data.usage };
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
  }

  // --- Interaction update ---
  function updateInteraction(updated) {
    const idx = state.interactions.findIndex(i => i.id === updated.id);
    if (idx >= 0) {
      const localEvents = state.interactions[idx].response?.sseEvents || [];
      state.interactions[idx] = { ...updated, response: { ...updated.response, sseEvents: localEvents } };
    }

    updateTurnBadge(updated.id, updated.status || 'complete');
    updateTurnMeta(updated);
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

  function renderTimeline() {
    timelineList.innerHTML = '';
    state.interactions.forEach((interaction, idx) => {
      // Apply filter
      if (activeTimelineFilter === 'mcp' && !interaction.isMcp) return;
      if (activeTimelineFilter === 'hooks' && !interaction.isHook) return;
      if (activeTimelineFilter === 'api' && (interaction.isMcp || interaction.isHook)) return;
      if (activeTimelineFilter === 'mcp' && interaction.isHook) return;
      appendTurnToTimeline(interaction, idx);
    });
  }

  function appendTurnToTimeline(interaction, idx) {
    if (idx === undefined) idx = state.interactions.length - 1;

    if (interaction.isMcp) {
      return appendMcpCallToTimeline(interaction, idx);
    }
    if (interaction.isHook) {
      return appendHookEntryToTimeline(interaction, idx);
    }

    const group = document.createElement('div');
    group.className = 'turn-group' + (isNewUserTurn(interaction) ? ' new-user-turn' : '');
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry';
    el.dataset.id = interaction.id;

    const statusClass = badgeClass(interaction.status);
    const profile = interaction.profile || '';
    const stepId = interaction.stepId || '';
    const model = interaction.request?.model || 'unknown';
    const shortModel = model.replace('claude-', '').split('-202')[0];
    const duration = interaction.timing?.duration ? formatDuration(interaction.timing.duration) : '--';
    const endpoint = interaction.originalEndpoint || interaction.endpoint || '/v1/messages';
    const shortEndpoint = endpoint.replace('/v1/', '');

    const modelLabel = profile ? `<span class="entry-profile">${escHtml(profile)}</span> ${escHtml(shortModel)}` : escHtml(shortModel);
    const turnLabel = stepId ? `Turn ${idx + 1} <span class="entry-step">${escHtml(stepId)}</span>` : `Turn ${idx + 1}`;

    el.innerHTML = `
      <div class="entry-header">
        <span class="entry-num">${turnLabel}</span>
        <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${interaction.status || 'pending'}</span>
      </div>
      <div class="entry-model" data-model="${interaction.id}">${modelLabel}</div>
      <div class="entry-meta">
        <span data-endpoint="${interaction.id}">${shortEndpoint}</span>
        <span data-duration="${interaction.id}">${duration}</span>
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
      const toolEl = createToolEntryEl(interaction.id, tIdx, tc.name, toolSummary(tc.name, tc.input), tc.input);
      toolsContainer.appendChild(toolEl);
    });

    timelineList.appendChild(group);
  }

  function appendMcpCallToTimeline(interaction, idx) {
    const group = document.createElement('div');
    group.className = 'turn-group mcp-call-group';
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry mcp-call-entry';
    el.dataset.id = interaction.id;

    const toolName = interaction.request?.tool || 'unknown';
    const duration = interaction.timing?.duration ? formatDuration(interaction.timing.duration) : '--';
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
        <span>${duration}</span>
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

  function appendHookEntryToTimeline(interaction, idx) {
    const group = document.createElement('div');
    group.className = 'turn-group hook-call-group';
    group.dataset.turnId = interaction.id;

    const el = document.createElement('div');
    el.className = 'timeline-entry turn-entry hook-call-entry';
    el.dataset.id = interaction.id;

    const hookEvent = interaction.hookEvent || 'Hook';
    const toolName = interaction.toolName || '';
    const time = new Date(interaction.timestamp).toLocaleTimeString();

    el.innerHTML = `
      <div class="entry-header">
        <span class="entry-num hook-label">${escHtml(hookEvent)}</span>
        <span class="entry-badge badge-complete">ok</span>
      </div>
      <div class="entry-model hook-tool-name">${escHtml(toolName)}</div>
      <div class="entry-meta">
        <span>${time}</span>
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

  function appendToolToTimeline(interactionId, toolIdx, name, summary) {
    const container = document.querySelector(`[data-tools-for="${interactionId}"]`);
    if (!container) return;
    if (container.querySelector(`[data-tool-id="${interactionId}-${toolIdx}"]`)) return;
    const toolEl = createToolEntryEl(interactionId, toolIdx, name, summary);
    container.appendChild(toolEl);
  }

  function createToolEntryEl(interactionId, toolIdx, name, summary, input) {
    const toolEl = document.createElement('div');
    const isSkill = name === 'Skill' && input?.skill;
    toolEl.className = 'timeline-entry tool-entry' + (isSkill ? ' skill-call' : '');
    toolEl.dataset.toolId = `${interactionId}-${toolIdx}`;
    const displayName = isSkill ? `/${input.skill}` : name;
    toolEl.innerHTML = `
      <span class="tool-connector"></span>
      <span class="tool-entry-name" data-tool-name="${interactionId}-${toolIdx}">${escHtml(displayName)}</span>
      ${isSkill ? '<span class="tool-entry-tag tag-sk">skill</span>' : ''}
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
    container.innerHTML = '';
    const interaction = state.interactions.find(i => i.id === interactionId);
    if (!interaction) return;
    const toolCalls = extractToolCalls(interaction);
    toolCalls.forEach((tc, tIdx) => {
      const toolEl = createToolEntryEl(interactionId, tIdx, tc.name, toolSummary(tc.name, tc.input), tc.input);
      container.appendChild(toolEl);
    });
  }

  function updateTurnBadge(id, status) {
    const badge = document.querySelector(`[data-badge="${id}"]`);
    if (badge) {
      badge.className = `entry-badge ${badgeClass(status)}`;
      badge.textContent = status;
    }
  }

  function updateTurnMeta(interaction) {
    const durationEl = document.querySelector(`[data-duration="${interaction.id}"]`);
    if (durationEl && interaction.timing?.duration) {
      durationEl.textContent = formatDuration(interaction.timing.duration);
    }
    const modelEl = document.querySelector(`[data-model="${interaction.id}"]`);
    if (modelEl) {
      const model = interaction.request?.model || 'unknown';
      const shortModel = model.replace('claude-', '').split('-202')[0];
      const profile = interaction.profile || '';
      modelEl.innerHTML = profile ? `<span class="entry-profile">${escHtml(profile)}</span> ${escHtml(shortModel)}` : escHtml(shortModel);
    }
    const endpointEl = document.querySelector(`[data-endpoint="${interaction.id}"]`);
    if (endpointEl) {
      const ep = interaction.originalEndpoint || interaction.endpoint || '/v1/messages';
      endpointEl.textContent = ep.replace(/^https?:\/\//, '').replace('/v1/', '…/');
    }
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
    const tab = document.querySelector('[data-view="dashboard"]');
    if (!tab) return;
    const busy = state.interactions.some(i => i.status === 'pending' || i.status === 'streaming');
    tab.classList.toggle('busy', busy);
  }

  function scrollTimelineToBottom() {
    const timeline = document.getElementById('timeline');
    timeline.scrollTop = timeline.scrollHeight;
  }

  // ============================================================
  // SELECTION + DETAIL PANEL
  // ============================================================

  function selectLastAndFollow() {
    _userPinnedSelection = false;
    const last = state.interactions[state.interactions.length - 1];
    if (last) {
      select({ type: 'turn', id: last.id });
    } else {
      state.selection = null;
      document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
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
      if (el) el.classList.add('selected');

      const interaction = state.interactions.find(i => i.id === sel.id);
      if (!interaction) return;

      emptyState.classList.add('hidden');
      detailContent.classList.remove('hidden');
      renderTurnDetail(interaction);
    } else if (sel.type === 'tool') {
      const el = document.querySelector(`[data-tool-id="${sel.interactionId}-${sel.toolIndex}"]`);
      if (el) el.classList.add('selected');

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

    html += `<div class="detail-panel tokens-panel">`;
    html += `<div class="usage-bar" id="usage-bar">${interaction.usage ? renderUsage(interaction.usage, interaction.pricing) : '<span class="info-label">--</span>'}</div>`;
    html += `</div>`;

    html += `<div class="detail-panel response-panel">`;
    const respChars = resp.body ? JSON.stringify(resp.body).length : (resp.sseEvents ? resp.sseEvents.reduce((n, e) => n + JSON.stringify(e.data || '').length, 0) : 0);
    html += `<div class="section-title">Response ${respChars ? charGauge(respChars) : ''}</div>`;

    const statusOk = resp.status >= 200 && resp.status < 300;
    html += `<div class="info-grid">
      <span class="info-label">Status</span><span class="info-value ${statusOk ? 'status-ok' : 'status-err'}" id="resp-status">${resp.status || '--'}</span>
      <span class="info-label">TTFB</span><span class="info-value" id="resp-ttfb">${timing.ttfb ? formatDuration(timing.ttfb) : '--'}</span>
      <span class="info-label">Duration</span><span class="info-value" id="resp-duration">${timing.duration ? formatDuration(timing.duration) : '--'}</span>
    </div>`;

    html += `<div id="response-blocks">`;

    if (interaction.isStreaming && resp.sseEvents?.length > 0) {
      html += renderAccumulatedBlocks(resp.sseEvents);
    } else if (resp.body) {
      if (resp.body.content) {
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

    if (resp.sseEvents?.length > 0) {
      html += `<details>
        <summary>Raw SSE Events (${resp.sseEvents.length})</summary>
        <pre class="json-block">${resp.sseEvents.map(e =>
          `<span class="json-key">event:</span> ${escHtml(e.eventType)}\n<span class="json-string">data:</span> ${escHtml(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))}\n`
        ).join('\n')}</pre>
      </details>`;
    }

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
      <span class="info-label">Turn</span><span class="info-value"><a href="#" class="turn-link" data-turn-id="${interaction.id}">Turn ${state.interactions.indexOf(interaction) + 1}</a></span>
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

  function updateStats() {
    const total = state.interactions.length;
    let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0, toolCallCount = 0, totalCost = 0;
    let hasCost = false;
    for (const i of state.interactions) {
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
    let parts = [
      `${total} turn${total !== 1 ? 's' : ''}`,
      `${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}`,
      `${inputTokens.toLocaleString()} in`,
      `${outputTokens.toLocaleString()} out`,
    ];
    if (cacheRead) parts.push(`${cacheRead.toLocaleString()} cache read`);
    if (cacheCreate) parts.push(`${cacheCreate.toLocaleString()} cache create`);
    if (hasCost) parts.push(formatCost(totalCost));
    statsEl.textContent = parts.join(' | ');
  }

  // --- Session list in empty state ---
  function renderSessionList() {
    if (!emptyState) return;
    if (state.interactions.length > 0) return; // Only show when no interactions

    let html = '<p>No interaction selected.</p>';
    if (cachedSessions.length > 0) {
      html += '<div class="session-list-empty">';
      html += '<div class="session-list-header"><p class="session-list-title">Sessions</p>';
      html += '<button class="session-list-delete-all">Delete All</button></div>';
      for (const s of cachedSessions) {
        const isActive = s.id === state.activeSessionId;
        html += `<div class="session-list-item${isActive ? ' active' : ''}" data-session-id="${s.id}">`;
        html += `<span class="session-list-label">Session ${s.id}</span>`;
        html += `<span class="session-list-calls">${s.interactionCount} call${s.interactionCount !== 1 ? 's' : ''}</span>`;
        if (isActive) {
          html += '<span class="session-list-badge">current</span>';
        } else {
          html += `<button class="session-list-load" data-id="${s.id}">Load</button>`;
          html += `<button class="session-list-del" data-id="${s.id}">Delete</button>`;
        }
        html += '</div>';
      }
      html += '</div>';
    } else {
      html += '<p class="hint">Run <code>ANTHROPIC_BASE_URL=http://localhost:3456 claude -p "prompt"</code> to capture API calls.</p>';
    }
    emptyState.innerHTML = html;

    // Bind buttons
    emptyState.querySelectorAll('.session-list-load').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        if (id && state.ws?.readyState === WebSocket.OPEN) {
          sendWs({ type: 'session:switch', id });
        }
      });
    });
    emptyState.querySelectorAll('.session-list-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        if (id && state.ws?.readyState === WebSocket.OPEN) {
          sendWs({ type: 'session:delete', id });
        }
      });
    });
    const deleteAllBtn = emptyState.querySelector('.session-list-delete-all');
    if (deleteAllBtn) {
      deleteAllBtn.addEventListener('click', () => {
        if (state.ws?.readyState !== WebSocket.OPEN) return;
        for (const s of cachedSessions) {
          if (s.id !== state.activeSessionId) {
            sendWs({ type: 'session:delete', id: s.id });
          }
        }
      });
    }
  }

  // --- Message handler ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        _userPinnedSelection = false;
        state.interactions = msg.interactions || [];
        renderTimeline();
        updateStats();
        updateInspectorBusy();
        if (state.interactions.length > 0) {
          select({ type: 'turn', id: state.interactions[state.interactions.length - 1].id });
        } else {
          renderSessionList();
        }
        break;

      case 'interaction:start':
        state.interactions.push(msg.interaction);
        appendTurnToTimeline(msg.interaction);
        updateStats();
        updateInspectorBusy();
        if (!_userPinnedSelection) {
          select({ type: 'turn', id: msg.interaction.id });
        }
        scrollTimelineToBottom();
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

      case 'session:switched':
        _userPinnedSelection = false;
        state.interactions = msg.interactions || [];
        state.selection = null;
        renderTimeline();
        updateStats();
        updateInspectorBusy();
        if (state.interactions.length > 0) {
          select({ type: 'turn', id: state.interactions[state.interactions.length - 1].id });
        } else {
          detailContent.innerHTML = '';
          detailContent.classList.add('hidden');
          emptyState.classList.remove('hidden');
          renderSessionList();
        }
        break;

      case 'session:list':
        cachedSessions = msg.sessions || [];
        if (state.interactions.length === 0) {
          renderSessionList();
        }
        break;

      case 'cleared':
        state.interactions = [];
        state.selection = null;
        timelineList.innerHTML = '';
        detailContent.innerHTML = '';
        detailContent.classList.add('hidden');
        emptyState.classList.remove('hidden');
        updateStats();
        updateInspectorBusy();
        renderSessionList();
        break;
    }
  }

  window.inspectorModule = { handleMessage };
})();
