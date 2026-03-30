// ============================================================
// CAPABILITIES MODULE — Profiles, skills, agents, hooks
// ============================================================
(function capabilitiesModule() {
  const { state, escHtml, sendWs } = window.dashboard;

  // --- Templates ---

  const AGENT_TEMPLATE = `---
name: my-agent
description: |
  Use this agent when [describe trigger conditions].
  Should be invoked proactively when [situation].
model: sonnet
tools: [Read, Glob, Grep, Bash]
# disallowedTools: [Write, Edit]
# permissionMode: default
# maxTurns: 20
# effort: high
# background: false
# isolation: worktree
# skills:
#   - my-skill
# hooks:
#   PreToolUse:
#     - matcher: "Bash"
#       hooks:
#         - type: command
#           command: "./validate.sh"
---

You are an expert at [role].

## Your task

When invoked, you should:

1. [First step]
2. [Second step]
3. [Third step]

## Guidelines

- Always [important behavior]
- Never [anti-pattern]
- Return a concise summary of your findings`;

  const SKILL_TEMPLATE = `---
name: my-skill
description: >
  This skill should be used when the user asks to [describe trigger phrases],
  or when the conversation involves [topic area].
argument-hint: <filename> [options]
# user-invocable: true
# disable-model-invocation: false
# model: sonnet
# effort: high
# context: fork
# allowed-tools: Read, Grep, Glob
---

You are an expert at [domain]. When triggered, you should:

1. Analyze the request: \$ARGUMENTS
2. [Second step]
3. [Third step]

## Guidelines

- Always [important behavior]
- Never [anti-pattern]

## Dynamic context

Available templates in this skill directory:
!\`ls \${CLAUDE_SKILL_DIR}/templates/ 2>/dev/null || echo "(no templates yet)"\``;

  // --- Toolbar ---

  function renderCapabilitiesToolbar() {
    const c = state.capabilities;
    if (!c) return;

    const profileSel = document.getElementById('capProfileSelect');
    if (profileSel && state.profiles.length > 0) {
      profileSel.innerHTML = '';
      for (const p of state.profiles) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.builtin ? `${p.name} (built-in)` : p.name;
        profileSel.appendChild(opt);
      }
      profileSel.value = c.name || 'full';
    }

    const delBtn = document.getElementById('capDeleteProfile');
    const prof = state.profiles.find(p => p.name === c.name);
    if (delBtn) delBtn.disabled = !!c.builtin || (prof?.usedBy?.length > 0);

    const summary = document.getElementById('capProfileSummary');
    if (summary) {
      const parts = [];
      if (c.model) parts.push(c.model);
      if (c.effort) parts.push(c.effort);
      if (c.permissionMode && c.permissionMode !== 'default') parts.push(c.permissionMode);
      if (c.maxTurns) parts.push(`${c.maxTurns} turns`);
      if (c.maxBudgetUsd) parts.push(`$${c.maxBudgetUsd}`);
      const disabledCount = c.disabledTools?.length || 0;
      if (disabledCount > 0) parts.push(`${disabledCount} tools off`);
      if (c.disableSlashCommands) parts.push('skills off');
      const mcpCount = c.mcpServers?.length || 0;
      if (mcpCount > 0) parts.push(`${mcpCount} MCP`);
      summary.textContent = parts.length > 0 ? parts.join(' \u00b7 ') : 'defaults';
    }

    updateCapabilityStats();
  }

  function updateCapabilityStats() {
    const c = state.capabilities;
    if (!c) return;
    const enabled = state.knownTools.length - (c.disabledTools?.length || 0);
    const countEl = document.getElementById('capToolCount');
    if (countEl) countEl.textContent = `${enabled}/${state.knownTools.length}`;
    const builtinSkills = state.knownSkills?.length || 0;
    const customSkills = state.skills?.length || 0;
    const totalSkills = builtinSkills + customSkills;
    const skillCountEl = document.getElementById('capSkillCount');
    if (skillCountEl) skillCountEl.textContent = c.disableSlashCommands ? '0' : totalSkills;
    const agentCountEl = document.getElementById('capAgentCount');
    if (agentCountEl) agentCountEl.textContent = state.agents.length;
    const hookCountEl = document.getElementById('capHookCount');
    if (hookCountEl) hookCountEl.textContent = state.hooks.length;
    const mcpCountEl = document.getElementById('capMcpCount');
    if (mcpCountEl) mcpCountEl.textContent = state.mcpServers?.length || 0;
  }

  // Profile selector (Capabilities tab)
  document.getElementById('capProfileSelect')?.addEventListener('change', (e) => {
    const name = e.target.value;
    if (!name) return;
    sendWs({ type: 'chat:switchProfile', name });
  });

  // --- Profile Modal ---

  const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];

  function populateModelSelector(profile) {
    const sel = document.getElementById('pmModel');
    if (!sel) return;
    sel.innerHTML = '';

    // Anthropic group
    const claudeGroup = document.createElement('optgroup');
    claudeGroup.label = 'Anthropic (native)';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = 'Default (Claude)';
    claudeGroup.appendChild(defOpt);
    for (const m of CLAUDE_MODELS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      claudeGroup.appendChild(opt);
    }
    sel.appendChild(claudeGroup);

    // Group models by providerKey using provider labels
    const providerLabels = {};
    for (const p of state.providers) providerLabels[p.key] = p.label || p.key;

    const groups = {};
    for (const m of state.models) {
      const pk = m.providerKey || 'custom';
      const label = providerLabels[pk] || pk;
      if (!groups[label]) groups[label] = [];
      groups[label].push(m);
    }

    for (const [label, models] of Object.entries(groups)) {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = 'modeldef:' + m.name;
        opt.textContent = m.label || m.name;
        if (m.reasoning) opt.textContent += ' \u2728'; // sparkle for reasoning
        group.appendChild(opt);
      }
      sel.appendChild(group);
    }

    // Set current value
    if (profile.modelDef) {
      sel.value = 'modeldef:' + profile.modelDef;
    } else {
      sel.value = profile.model || '';
    }
  }

  function getSelectedModelDef() {
    const val = document.getElementById('pmModel')?.value || '';
    if (val.startsWith('modeldef:')) {
      const name = val.slice(9);
      return state.models.find(m => m.name === name) || null;
    }
    return null;
  }

  function updateModelInfo() {
    const val = document.getElementById('pmModel')?.value || '';
    const effortRow = document.getElementById('pmEffortRow');
    const infoEl = document.getElementById('pmModelInfo');

    if (val.startsWith('modeldef:')) {
      const md = getSelectedModelDef();
      if (md) {
        // Show effort only for reasoning models
        if (effortRow) effortRow.style.display = md.reasoning ? '' : 'none';
        // Show model info
        if (infoEl) {
          const parts = [];
          if (md.contextWindow) parts.push(`${Math.round(md.contextWindow / 1000)}K context`);
          if (md.maxOutputTokens) parts.push(`${Math.round(md.maxOutputTokens / 1000)}K max output`);
          if (md.reasoning) parts.push('reasoning');
          infoEl.textContent = parts.join(' \u00b7 ');
        }
      }
    } else {
      // Claude native — always show effort (Claude supports it on all models)
      if (effortRow) effortRow.style.display = '';
      if (infoEl) {
        if (val === 'opus') infoEl.textContent = 'Most capable \u00b7 reasoning';
        else if (val === 'sonnet') infoEl.textContent = 'Fast \u00b7 balanced';
        else if (val === 'haiku') infoEl.textContent = 'Fastest \u00b7 lightweight';
        else infoEl.textContent = '';
      }
    }
  }

  // Listen for model selector changes
  document.getElementById('pmModel')?.addEventListener('change', updateModelInfo);

  function openProfileModal(profile, mode) {
    const title = document.getElementById('profileModalTitle');
    if (mode === 'new') title.textContent = 'New Profile';
    else if (mode === 'duplicate') title.textContent = 'Duplicate Profile';
    else if (mode === 'view') title.textContent = `Profile: ${profile.name}`;
    else title.textContent = `Edit Profile: ${profile.name}`;

    const nameInput = document.getElementById('pmName');
    nameInput.value = mode === 'duplicate' ? '' : (profile.name || '');
    const usedBy = profile.usedBy || [];
    const inUse = usedBy.length > 0;
    nameInput.readOnly = mode === 'view' || (mode === 'edit' && inUse);

    // Show/hide usage info
    let usageEl = document.getElementById('pmUsageInfo');
    if (!usageEl) {
      usageEl = document.createElement('div');
      usageEl.id = 'pmUsageInfo';
      usageEl.className = 'pm-usage-info';
      nameInput.closest('.pm-form-group').appendChild(usageEl);
    }
    if (inUse && mode === 'edit') {
      const refs = usedBy.map(u => `${u.workflow} → ${u.steps.join(', ')}`).join('; ');
      usageEl.textContent = `Used in: ${refs}`;
      usageEl.style.display = '';
    } else {
      usageEl.style.display = 'none';
    }

    // Store original name for rename detection
    nameInput.dataset.oldName = mode === 'edit' ? (profile.name || '') : '';

    // Unified model selector
    populateModelSelector(profile);
    document.getElementById('pmEffort').value = profile.effort || '';
    updateModelInfo();

    document.getElementById('pmPermission').value = profile.permissionMode || 'default';
    document.getElementById('pmMaxTurns').value = profile.maxTurns || '';
    document.getElementById('pmMaxBudget').value = profile.maxBudgetUsd || '';
    document.getElementById('pmSlash').checked = !profile.disableSlashCommands;
    document.getElementById('pmAppendPrompt').value = profile.appendSystemPrompt || '';
    document.getElementById('pmSystemPrompt').value = profile.systemPrompt || '';

    // Tool checkbox grid
    const grid = document.getElementById('pmToolGrid');
    grid.innerHTML = '';
    const disabled = new Set(profile.disabledTools || []);
    for (const tool of state.knownTools) {
      const item = document.createElement('label');
      item.className = 'pm-tool-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !disabled.has(tool);
      cb.dataset.tool = tool;
      item.appendChild(cb);
      item.appendChild(document.createTextNode(' ' + tool));
      grid.appendChild(item);
    }

    // MCP server checkbox grid
    const mcpGrid = document.getElementById('pmMcpGrid');
    if (mcpGrid) {
      const available = state.mcpServers || [];
      if (available.length === 0) {
        mcpGrid.innerHTML = '<span class="cap-modal-hint">No MCP servers created yet.</span>';
      } else {
        mcpGrid.innerHTML = '';
        const selected = new Set(profile.mcpServers || []);
        for (const srv of available) {
          const item = document.createElement('label');
          item.className = 'pm-tool-item';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selected.has(srv.slug);
          cb.dataset.slug = srv.slug;
          item.appendChild(cb);
          item.appendChild(document.createTextNode(' ' + (srv.icon || '') + ' ' + (srv.name || srv.slug)));
          mcpGrid.appendChild(item);
        }
      }
    }

    // View mode: disable all controls, show read-only notice
    const modal = document.getElementById('profileModal');
    const isView = mode === 'view';
    modal.classList.toggle('pm-view-mode', isView);
    for (const el of modal.querySelectorAll('input, select, textarea')) {
      if (isView) el.setAttribute('disabled', '');
      else el.removeAttribute('disabled');
    }
    const saveBtn = document.getElementById('pmSave');
    if (isView) saveBtn.setAttribute('disabled', '');
    else saveBtn.removeAttribute('disabled');

    let banner = document.getElementById('pmViewBanner');
    if (isView) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'pmViewBanner';
        banner.className = 'pm-view-banner';
        banner.textContent = 'This is a built-in profile and cannot be edited. Use "Duplicate" to create your own copy.';
        modal.querySelector('.cap-modal-body').prepend(banner);
      }
      banner.style.display = '';
    } else if (banner) {
      banner.style.display = 'none';
    }

    modal.classList.remove('hidden');
  }

  function closeProfileModal() {
    document.getElementById('profileModal')?.classList.add('hidden');
  }

  // New profile
  document.getElementById('capNewProfile')?.addEventListener('click', () => {
    openProfileModal({
      name: '', builtin: false,
      model: null, effort: null, permissionMode: 'default',
      disabledTools: [], mcpServers: [], disableSlashCommands: false,
      maxTurns: null, maxBudgetUsd: null, appendSystemPrompt: null, systemPrompt: null,
      modelDef: null,
    }, 'new');
  });

  // Edit profile (view-only for built-ins)
  document.getElementById('capEditProfile')?.addEventListener('click', () => {
    if (!state.capabilities) return;
    const prof = (state.profiles || []).find(p => p.name === state.capabilities.name);
    const merged = { ...state.capabilities, usedBy: prof?.usedBy || [] };
    openProfileModal(merged, state.capabilities.builtin ? 'view' : 'edit');
  });

  // Duplicate profile
  document.getElementById('capDuplicateProfile')?.addEventListener('click', () => {
    if (!state.capabilities) return;
    openProfileModal(state.capabilities, 'duplicate');
  });

  // Delete profile
  document.getElementById('capDeleteProfile')?.addEventListener('click', () => {
    const name = state.capabilities?.name;
    if (!name) return;
    if (state.capabilities?.builtin) return alert('Cannot delete built-in profiles. Duplicate it to create an editable copy.');
    const prof = (state.profiles || []).find(p => p.name === name);
    const usedBy = prof?.usedBy || [];
    if (usedBy.length > 0) {
      const refs = usedBy.map(u => `${u.workflow} → ${u.steps.join(', ')}`).join('\n');
      return alert(`Cannot delete "${name}" — it is used in:\n${refs}`);
    }
    if (!confirm(`Delete profile "${name}"? This cannot be undone.`)) return;
    sendWs({ type: 'profile:delete', name });
  });

  // Save from modal
  document.getElementById('pmSave')?.addEventListener('click', () => {
    const name = document.getElementById('pmName')?.value?.trim();
    if (!name) return alert('Profile name is required.');
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name.length < 2) {
      return alert('Invalid name. Use lowercase letters, numbers, and hyphens. Min 2 chars.');
    }

    const disabledTools = [];
    document.querySelectorAll('#pmToolGrid input[type="checkbox"]').forEach(cb => {
      if (!cb.checked) disabledTools.push(cb.dataset.tool);
    });

    const mcpServers = [];
    document.querySelectorAll('#pmMcpGrid input[type="checkbox"]').forEach(cb => {
      if (cb.checked) mcpServers.push(cb.dataset.slug);
    });

    const maxT = parseInt(document.getElementById('pmMaxTurns')?.value);
    const maxB = parseFloat(document.getElementById('pmMaxBudget')?.value);

    const profile = {
      name,
      label: name,
      description: '',
      builtin: false,
      model: (() => {
        const v = document.getElementById('pmModel')?.value || '';
        return (!v || v.startsWith('modeldef:')) ? null : v;
      })(),
      effort: document.getElementById('pmEffort')?.value || null,
      permissionMode: document.getElementById('pmPermission')?.value || 'default',
      disabledTools,
      mcpServers,
      disableSlashCommands: !document.getElementById('pmSlash')?.checked,
      maxTurns: maxT > 0 ? maxT : null,
      maxBudgetUsd: maxB > 0 ? maxB : null,
      appendSystemPrompt: document.getElementById('pmAppendPrompt')?.value?.trim() || null,
      systemPrompt: document.getElementById('pmSystemPrompt')?.value?.trim() || null,
      modelDef: (() => {
        const v = document.getElementById('pmModel')?.value || '';
        return v.startsWith('modeldef:') ? v.slice(9) : null;
      })(),
    };

    const oldName = document.getElementById('pmName')?.dataset.oldName || '';
    const msg = { type: 'profile:save', profile };
    if (oldName && oldName !== name) msg.oldName = oldName;
    sendWs(msg);
    sendWs({ type: 'chat:switchProfile', name });
    closeProfileModal();
  });

  // Cancel / close modal
  document.getElementById('pmClose')?.addEventListener('click', closeProfileModal);
  document.getElementById('pmCancel')?.addEventListener('click', closeProfileModal);

  // --- Skills Panel ---

  function renderSkillsPanel() {
    const disabled = state.capabilities?.disableSlashCommands;

    const statusEl = document.getElementById('capSkillsStatus');
    if (statusEl) {
      statusEl.innerHTML = `Currently: <strong>${disabled ? 'disabled' : 'enabled'}</strong> by profile`;
    }

    const list = document.getElementById('capSkillList');
    if (list) {
      list.innerHTML = '';
      for (const skill of state.skills) {
        const item = document.createElement('div');
        item.className = 'cap-list-item';
        item.innerHTML = `<span class="cap-item-name">${escHtml(skill.name)}</span>
          <span class="cap-item-desc">${escHtml(skill.description)}</span>
          <span class="cap-list-actions">
            <button class="cap-edit-btn" data-name="${skill.name}" data-kind="skill" title="Edit">&#9998;</button>
            <button class="cap-del-btn" data-name="${skill.name}" data-kind="skill" title="Delete">&#10005;</button>
          </span>`;
        list.appendChild(item);
      }
    }

    const grid = document.getElementById('skillsGrid');
    if (grid) {
      grid.innerHTML = '';
      for (const skill of (state.knownSkills || [])) {
        const card = document.createElement('div');
        card.className = `ref-card${disabled ? ' disabled' : ''}`;
        card.innerHTML = `<div class="ref-card-header" onclick="toggleRef(this)">
            <span><span class="ref-name">/${skill.name}</span> <span class="ref-tag tag-sk">skill</span></span>
            <span class="ref-brief">${escHtml(skill.description)}</span>
            <span class="ref-chevron">&#9654;</span>
          </div>
          <div class="ref-card-body">
            <p>${escHtml(skill.description)}</p>
            <p class="ref-intro">Built-in skill. Invoked automatically by Claude when the context matches.</p>
          </div>`;
        grid.appendChild(card);
      }
    }

    updateCapabilityStats();
  }

  // --- Skills CRUD ---

  document.getElementById('capNewSkill')?.addEventListener('click', () => {
    state.editingSkill = '__new__';
    document.getElementById('skillModalTitle').textContent = 'New Skill';
    document.getElementById('capSkillTextarea').value = SKILL_TEMPLATE;
    document.getElementById('capSkillFiles').innerHTML = '';
    document.getElementById('skillModal')?.classList.remove('hidden');
  });

  document.getElementById('capSkillSave')?.addEventListener('click', () => {
    const ta = document.getElementById('capSkillTextarea');
    if (!ta) return;
    const content = ta.value;
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : null;
    if (!name) return alert('Missing "name:" in frontmatter');
    const extraFiles = [];
    document.querySelectorAll('#capSkillFiles .cap-modal-file-entry').forEach(entry => {
      const fname = entry.querySelector('.cap-modal-file-name')?.value?.trim();
      const fcontent = entry.querySelector('.cap-modal-file-content')?.value;
      if (fname && fcontent != null) extraFiles.push({ name: fname, content: fcontent });
    });
    sendWs({ type: 'skill:save', name, content, extraFiles });
    document.getElementById('skillModal')?.classList.add('hidden');
    state.editingSkill = null;
  });

  function closeSkillModal() {
    document.getElementById('skillModal')?.classList.add('hidden');
    state.editingSkill = null;
  }
  document.getElementById('capSkillCancel')?.addEventListener('click', closeSkillModal);
  document.getElementById('capSkillCancel2')?.addEventListener('click', closeSkillModal);

  document.getElementById('capSkillAddFile')?.addEventListener('click', () => {
    const container = document.getElementById('capSkillFiles');
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = 'cap-modal-file-entry';
    entry.innerHTML = `<div class="cap-modal-file-header">
        <input type="text" class="cap-modal-file-name" placeholder="filename (e.g. templates/base.md or scripts/check.sh)">
        <button class="cap-modal-file-remove" title="Remove">&times;</button>
      </div>
      <textarea class="cap-modal-file-content cap-modal-code" rows="6" spellcheck="false" placeholder="File content..."></textarea>`;
    entry.querySelector('.cap-modal-file-remove').addEventListener('click', () => entry.remove());
    container.appendChild(entry);
  });

  // --- Agents Panel ---

  function renderAgentsPanel() {
    const list = document.getElementById('capAgentList');
    if (!list) return;
    list.innerHTML = '';
    for (const agent of state.agents) {
      const item = document.createElement('div');
      item.className = 'cap-list-item';
      item.innerHTML = `<span class="cap-item-name">${escHtml(agent.name)}</span>
        <span class="cap-item-desc">${escHtml(agent.description)}</span>
        <span class="cap-list-actions">
          <button class="cap-edit-btn" data-name="${agent.name}" data-kind="agent" title="Edit">&#9998;</button>
          <button class="cap-del-btn" data-name="${agent.name}" data-kind="agent" title="Delete">&#10005;</button>
        </span>`;
      list.appendChild(item);
    }
  }

  document.getElementById('capNewAgent')?.addEventListener('click', () => {
    state.editingAgent = '__new__';
    document.getElementById('agentModalTitle').textContent = 'New Agent';
    document.getElementById('capAgentTextarea').value = AGENT_TEMPLATE;
    document.getElementById('agentModal')?.classList.remove('hidden');
  });

  document.getElementById('capAgentSave')?.addEventListener('click', () => {
    const ta = document.getElementById('capAgentTextarea');
    if (!ta) return;
    const content = ta.value;
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : null;
    if (!name) return alert('Missing "name:" in frontmatter');
    sendWs({ type: 'agent:save', name, content });
    document.getElementById('agentModal')?.classList.add('hidden');
    state.editingAgent = null;
  });

  function closeAgentModal() {
    document.getElementById('agentModal')?.classList.add('hidden');
    state.editingAgent = null;
  }
  document.getElementById('capAgentCancel')?.addEventListener('click', closeAgentModal);
  document.getElementById('capAgentCancel2')?.addEventListener('click', closeAgentModal);

  // --- Hooks Panel ---

  function renderHooksPanel() {
    const list = document.getElementById('capHookList');
    if (!list) return;
    list.innerHTML = '';

    const eventSel = document.getElementById('capHookEvent');
    if (eventSel && eventSel.options.length === 0 && state.hookEvents.length > 0) {
      for (const ev of state.hookEvents) {
        const opt = document.createElement('option');
        opt.value = ev;
        opt.textContent = ev;
        eventSel.appendChild(opt);
      }
    }

    for (const hook of state.hooks) {
      const item = document.createElement('div');
      item.className = 'cap-list-item';
      const matcherText = hook.matcher ? ` \u2192 ${hook.matcher}` : '';
      const cmdPreview = hook.command.length > 40 ? hook.command.slice(0, 40) + '\u2026' : hook.command;
      item.innerHTML = `<span class="cap-item-name">${escHtml(hook.event)}${escHtml(matcherText)}</span>
        <span class="cap-item-desc">${escHtml(cmdPreview)}</span>
        <span class="cap-list-actions">
          <button class="cap-edit-btn" data-event="${hook.event}" data-entry="${hook.entryIndex}" data-hook="${hook.hookIndex}" data-kind="hook" title="Edit">&#9998;</button>
          <button class="cap-del-btn" data-event="${hook.event}" data-entry="${hook.entryIndex}" data-kind="hook" title="Delete">&#10005;</button>
        </span>`;
      list.appendChild(item);
    }
  }

  document.getElementById('capNewHook')?.addEventListener('click', () => {
    state.editingHook = '__new__';
    document.getElementById('hookModalTitle').textContent = 'New Hook';
    document.getElementById('capHookEvent').value = state.hookEvents[0] || 'PreToolUse';
    document.getElementById('capHookMatcher').value = '';
    document.getElementById('capHookType').value = 'command';
    document.getElementById('capHookCommand').value = '';
    document.getElementById('capHookTimeout').value = '30';
    document.getElementById('hookModal')?.classList.remove('hidden');
    updateHookMatcherVisibility();
  });

  document.getElementById('capHookSave')?.addEventListener('click', () => {
    const hook = {
      event: document.getElementById('capHookEvent')?.value,
      matcher: document.getElementById('capHookMatcher')?.value || '',
      type: document.getElementById('capHookType')?.value || 'command',
      command: document.getElementById('capHookCommand')?.value || '',
      timeout: parseInt(document.getElementById('capHookTimeout')?.value) || 30,
    };
    if (!hook.command) return alert('Command/prompt is required');
    if (state.editingHook && state.editingHook !== '__new__') {
      hook.entryIndex = state.editingHook.entryIndex;
      hook.hookIndex = state.editingHook.hookIndex;
    }
    sendWs({ type: 'hook:save', hook });
    document.getElementById('hookModal')?.classList.add('hidden');
    state.editingHook = null;
  });

  function closeHookModal() {
    document.getElementById('hookModal')?.classList.add('hidden');
    state.editingHook = null;
  }
  document.getElementById('capHookCancel')?.addEventListener('click', closeHookModal);
  document.getElementById('capHookCancel2')?.addEventListener('click', closeHookModal);

  // --- Models Panel ---

  function renderModelsPanel() {
    const list = document.getElementById('capModelList');
    if (!list) return;
    list.innerHTML = '';

    for (const prov of state.providers) {
      const section = document.createElement('div');
      section.className = 'provider-group';

      const hasKey = !!prov.apiKey;
      const keyId = `provKey_${prov.key}`;
      section.innerHTML = `
        <div class="provider-header">
          <span class="provider-label">${escHtml(prov.label)}</span>
          <span class="provider-url">${escHtml(prov.apiBaseUrl || '')}</span>
          <span class="provider-key-area">
            <input type="password" id="${keyId}" class="provider-key-input" value="${escHtml(prov.apiKey || '')}" placeholder="Paste API key..." autocomplete="off">
            <button type="button" class="provider-key-toggle" data-target="${keyId}" title="Show/hide key">&#128065;</button>
            <button type="button" class="provider-key-save" data-provider="${escHtml(prov.key)}" title="Save key">${hasKey ? 'Update' : 'Set key'}</button>
            <span class="provider-key-status ${hasKey ? 'mm-key-ok' : 'mm-key-missing'}">${hasKey ? 'connected' : 'no key'}</span>
          </span>
        </div>
        <div class="provider-models"></div>`;

      const modelsContainer = section.querySelector('.provider-models');
      const provModels = state.models.filter(m => m.providerKey === prov.key);
      for (const model of provModels) {
        const ctx = model.contextWindow ? Math.round(model.contextWindow / 1000) + 'K' : '';
        const out = model.maxOutputTokens ? Math.round(model.maxOutputTokens / 1000) + 'K' : '';
        const specs = [ctx ? ctx + ' ctx' : '', out ? out + ' out' : ''].filter(Boolean).join(', ');
        const item = document.createElement('div');
        item.className = 'cap-list-item';
        item.innerHTML = `<span class="cap-item-name">${escHtml(model.label || model.name)}</span>
          <span class="cap-item-desc">
            <code>${escHtml(model.modelId || '')}</code>
            ${model.reasoning ? '<span class="cap-model-reasoning">reasoning</span>' : ''}
            ${specs ? '<span class="cap-model-specs">' + escHtml(specs) + '</span>' : ''}
          </span>
          <span class="cap-list-actions">
            <button class="cap-edit-btn" data-name="${escHtml(model.name)}" data-kind="model" title="Edit">&#9998;</button>
          </span>`;
        modelsContainer.appendChild(item);
      }

      list.appendChild(section);
    }

    const countEl = document.getElementById('capModelCount');
    if (countEl) countEl.textContent = state.models.length;
  }

  // Provider key toggle and save (delegated)
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.provider-key-toggle');
    if (toggle) {
      const input = document.getElementById(toggle.dataset.target);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    }

    const saveBtn = e.target.closest('.provider-key-save');
    if (saveBtn) {
      const provKey = saveBtn.dataset.provider;
      const prov = state.providers.find(p => p.key === provKey);
      if (!prov) return;
      const input = document.getElementById(`provKey_${provKey}`);
      const newKey = input ? input.value : '';
      sendWs({ type: 'provider:save', key: provKey, provider: { ...prov, apiKey: newKey } });
    }
  });

  function populateProviderKeyDropdown(selectedKey) {
    const sel = document.getElementById('mmProviderKey');
    if (!sel) return;
    sel.innerHTML = '';
    for (const p of state.providers) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label || p.key;
      sel.appendChild(opt);
    }
    sel.value = selectedKey || 'openai';
    updateCustomFieldsVisibility();
  }

  function updateCustomFieldsVisibility() {
    const pk = document.getElementById('mmProviderKey')?.value;
    const customFields = document.getElementById('mmCustomFields');
    if (customFields) {
      customFields.classList.toggle('hidden', pk !== 'custom');
    }
  }

  document.getElementById('mmProviderKey')?.addEventListener('change', updateCustomFieldsVisibility);

  // Default prompt checkbox toggle
  document.getElementById('mmUseDefaultPrompt')?.addEventListener('change', (e) => {
    const textarea = document.getElementById('mmSystemPrompt');
    if (textarea) textarea.classList.toggle('hidden', e.target.checked);
  });

  function populateModelForm(model, mode) {
    const nameInput = document.getElementById('mmName');
    nameInput.value = mode === 'duplicate' ? '' : (model.name || '');
    nameInput.readOnly = mode === 'edit';

    document.getElementById('mmLabel').value = (mode === 'duplicate' ? '' : model.label) || '';
    document.getElementById('mmDescription').value = (mode === 'duplicate' ? '' : model.description) || '';
    document.getElementById('mmProvider').value = model.provider || 'openai';
    document.getElementById('mmModelId').value = model.modelId || '';
    document.getElementById('mmSystemPromptMode').value = model.systemPromptMode || 'replace';

    // Reasoning + numeric fields
    const reasoningCb = document.getElementById('mmReasoning');
    if (reasoningCb) reasoningCb.checked = !!model.reasoning;
    const ctxInput = document.getElementById('mmContextWindow');
    if (ctxInput) ctxInput.value = model.contextWindow || '';
    const maxOutInput = document.getElementById('mmMaxOutputTokens');
    if (maxOutInput) maxOutInput.value = model.maxOutputTokens || '';

    // Provider key dropdown
    populateProviderKeyDropdown(model.providerKey || 'openai');

    // Custom provider fields (only for custom provider)
    const apiBaseUrl = document.getElementById('mmApiBaseUrl');
    const apiKey = document.getElementById('mmApiKey');
    if (apiBaseUrl) apiBaseUrl.value = model.apiBaseUrl || '';
    if (apiKey) { apiKey.value = model.apiKey || ''; apiKey.type = 'password'; }

    // System prompt: check if model has a custom override
    const hasCustomPrompt = model.systemPrompt && !model.systemPrompt.startsWith('You are a coding assistant with direct access');
    const useDefaultCb = document.getElementById('mmUseDefaultPrompt');
    const promptTextarea = document.getElementById('mmSystemPrompt');
    if (useDefaultCb) useDefaultCb.checked = !hasCustomPrompt;
    if (promptTextarea) {
      promptTextarea.classList.toggle('hidden', !hasCustomPrompt);
      promptTextarea.value = hasCustomPrompt ? model.systemPrompt : '';
    }

    document.getElementById('mmToolOverrides').value =
      model.toolOverrides && Object.keys(model.toolOverrides).length > 0
        ? JSON.stringify(model.toolOverrides, null, 2)
        : '';
  }

  function openModelModal(model) {
    const title = document.getElementById('modelModalTitle');
    title.textContent = `Edit Model: ${model.label || model.name}`;

    // Hide catalog (not used in edit-only mode)
    const catalog = document.getElementById('mmCatalog');
    if (catalog) catalog.classList.add('hidden');

    populateModelForm(model, 'edit');
    state.editingModel = model.name;
    document.getElementById('modelModal')?.classList.remove('hidden');
  }

  function closeModelModal() {
    document.getElementById('modelModal')?.classList.add('hidden');
    state.editingModel = null;
  }

  // API key show/hide toggle (for custom provider in model modal)
  document.getElementById('mmApiKeyToggle')?.addEventListener('click', () => {
    const input = document.getElementById('mmApiKey');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Models are pre-populated from models.json — no create button needed

  document.getElementById('capModelSave')?.addEventListener('click', () => {
    const name = document.getElementById('mmName')?.value?.trim();
    if (!name) return alert('Model name is required.');
    if (!/^[a-z][a-z0-9._-]*$/.test(name)) {
      return alert('Invalid name. Use lowercase letters, numbers, dots, hyphens, underscores.');
    }

    let toolOverrides = {};
    const toVal = document.getElementById('mmToolOverrides')?.value?.trim();
    if (toVal) {
      try { toolOverrides = JSON.parse(toVal); }
      catch { return alert('Tool overrides must be valid JSON.'); }
    }

    const providerKey = document.getElementById('mmProviderKey')?.value || 'openai';
    const useDefault = document.getElementById('mmUseDefaultPrompt')?.checked;

    const ctxVal = parseInt(document.getElementById('mmContextWindow')?.value);
    const maxOutVal = parseInt(document.getElementById('mmMaxOutputTokens')?.value);

    const model = {
      name,
      label: document.getElementById('mmLabel')?.value?.trim() || name,
      description: document.getElementById('mmDescription')?.value?.trim() || '',
      providerKey,
      provider: document.getElementById('mmProvider')?.value || 'openai',
      modelId: document.getElementById('mmModelId')?.value?.trim() || '',
      systemPromptMode: document.getElementById('mmSystemPromptMode')?.value || 'replace',
      toolOverrides,
      reasoning: !!document.getElementById('mmReasoning')?.checked,
      contextWindow: ctxVal > 0 ? ctxVal : null,
      maxOutputTokens: maxOutVal > 0 ? maxOutVal : null,
    };

    // Only send custom system prompt if user opted out of default
    if (!useDefault) {
      model.systemPrompt = document.getElementById('mmSystemPrompt')?.value || '';
    }

    // Custom provider models include their own apiBaseUrl/apiKey
    if (providerKey === 'custom') {
      model.apiBaseUrl = document.getElementById('mmApiBaseUrl')?.value?.trim() || '';
      model.apiKey = document.getElementById('mmApiKey')?.value || '';
    }

    sendWs({ type: 'model:save', model });
    closeModelModal();
  });

  document.getElementById('capModelCancel')?.addEventListener('click', closeModelModal);
  document.getElementById('capModelCancel2')?.addEventListener('click', closeModelModal);

  // Close modals on backdrop click
  document.querySelectorAll('.cap-modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.classList.add('hidden');
        state.editingSkill = null;
        state.editingAgent = null;
        state.editingHook = null;
        state.editingModel = null;
      }
    });
  });

  document.getElementById('capHookEvent')?.addEventListener('change', updateHookMatcherVisibility);

  function updateHookMatcherVisibility() {
    const event = document.getElementById('capHookEvent')?.value;
    const matcherLabel = document.querySelector('.cap-hook-matcher-label');
    if (matcherLabel) {
      matcherLabel.style.display = state.matcherEvents?.includes(event) ? '' : 'none';
    }
  }

  // --- Delegated click handlers for edit/delete ---

  document.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.cap-edit-btn');
    const delBtn = e.target.closest('.cap-del-btn');

    const dupBtn = e.target.closest('.cap-dup-btn');

    if (editBtn) {
      const kind = editBtn.dataset.kind;
      if (kind === 'skill') {
        const name = editBtn.dataset.name;
        const skill = state.skills.find(s => s.name === name);
        if (skill) {
          state.editingSkill = name;
          document.getElementById('skillModalTitle').textContent = `Edit Skill: ${name}`;
          document.getElementById('capSkillTextarea').value = skill.content;
          document.getElementById('capSkillFiles').innerHTML = '';
          document.getElementById('skillModal')?.classList.remove('hidden');
        }
      } else if (kind === 'agent') {
        const name = editBtn.dataset.name;
        const agent = state.agents.find(a => a.name === name);
        if (agent) {
          state.editingAgent = name;
          document.getElementById('agentModalTitle').textContent = `Edit Agent: ${name}`;
          document.getElementById('capAgentTextarea').value = agent.content;
          document.getElementById('agentModal')?.classList.remove('hidden');
        }
      } else if (kind === 'hook') {
        const event = editBtn.dataset.event;
        const entryIdx = parseInt(editBtn.dataset.entry);
        const hookData = state.hooks.find(h => h.event === event && h.entryIndex === entryIdx);
        if (hookData) {
          state.editingHook = { entryIndex: hookData.entryIndex, hookIndex: hookData.hookIndex };
          document.getElementById('hookModalTitle').textContent = `Edit Hook: ${hookData.event}`;
          document.getElementById('capHookEvent').value = hookData.event;
          document.getElementById('capHookMatcher').value = hookData.matcher;
          document.getElementById('capHookType').value = hookData.type;
          document.getElementById('capHookCommand').value = hookData.command;
          document.getElementById('capHookTimeout').value = hookData.timeout;
          document.getElementById('hookModal')?.classList.remove('hidden');
          updateHookMatcherVisibility();
        }
      } else if (kind === 'model') {
        const name = editBtn.dataset.name;
        const model = state.models.find(m => m.name === name);
        if (model) openModelModal(model);
      }
    }

    if (delBtn) {
      const kind = delBtn.dataset.kind;
      if (kind === 'skill') {
        if (confirm(`Delete skill ${delBtn.dataset.name}?`)) {
          sendWs({ type: 'skill:delete', name: delBtn.dataset.name });
        }
      } else if (kind === 'agent') {
        if (confirm(`Delete agent ${delBtn.dataset.name}?`)) {
          sendWs({ type: 'agent:delete', name: delBtn.dataset.name });
        }
      } else if (kind === 'hook') {
        if (confirm('Delete this hook?')) {
          sendWs({ type: 'hook:delete', event: delBtn.dataset.event, entryIndex: parseInt(delBtn.dataset.entry) });
        }
      } else if (kind === 'model') {
        if (confirm(`Delete model "${delBtn.dataset.name}"?`)) {
          sendWs({ type: 'model:delete', name: delBtn.dataset.name });
        }
      }
    }
  });

  // --- Message router ---

  function handleMessage(msg) {
    switch (msg.type) {
      case 'skill:list':
        state.skills = msg.skills || [];
        renderSkillsPanel();
        break;
      case 'agent:list':
        state.agents = msg.agents || [];
        renderAgentsPanel();
        break;
      case 'hook:list':
        state.hooks = msg.hooks || [];
        renderHooksPanel();
        break;
      case 'model:list':
        state.models = msg.models || [];
        renderModelsPanel();
        break;
      case 'provider:list':
        state.providers = msg.providers || [];
        renderModelsPanel();
        break;
      case 'profile:list':
        state.profiles = msg.profiles || [];
        renderCapabilitiesToolbar();
        break;
    }
  }

  function handleSettings(msg) {
    // State sync handled by core.js syncSettings(); just re-render here
    if (msg.capabilities || msg.profiles) {
      renderCapabilitiesToolbar();
      renderSkillsPanel();
    }
  }

  // --- Export ---
  window.capabilitiesModule = { handleMessage, handleSettings };
})();
