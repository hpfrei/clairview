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

  // --- Capability stats ---

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

  // --- Profiles View (inline editing) ---

  let activeProfileTab = null;

  function renderProfileTabs() {
    const nav = document.getElementById('profilesNav');
    if (!nav) return;
    nav.querySelectorAll('.view-tab').forEach(b => b.remove());
    const actionBtn = nav.querySelector('.view-nav-action');
    if (!activeProfileTab && state.profiles.length) activeProfileTab = state.profiles[0].name;
    for (const p of state.profiles) {
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (activeProfileTab === p.name ? ' active' : '');
      btn.dataset.profile = p.name;
      btn.textContent = p.name + (p.builtin ? ' ●' : '');
      nav.insertBefore(btn, actionBtn);
    }
    renderProfileEditor();
  }

  function renderProfileEditor() {
    const editor = document.getElementById('profileEditor');
    if (!editor) return;
    const profile = state.profiles.find(p => p.name === activeProfileTab);
    if (!profile) { editor.innerHTML = '<div class="models-empty">Select a profile or create a new one.</div>'; return; }
    const isBuiltin = !!profile.builtin;
    const dis = isBuiltin ? ' disabled' : '';
    const usedBy = profile.usedBy || [];
    const usageHtml = usedBy.length > 0
      ? `<div class="pm-usage-info">Used in: ${escHtml(usedBy.map(u => `${u.workflow} → ${u.steps.join(', ')}`).join('; '))}</div>`
      : '';
    const builtinBanner = isBuiltin
      ? '<div class="pm-view-banner">This is a built-in profile. Fields are read-only.</div>'
      : '';

    editor.innerHTML = `${builtinBanner}
    <div class="pm-inline-columns">
      <div class="pm-inline-main">
        <div class="pm-form-group">
          <h4>Identity</h4>
          <div class="pm-field-row">
            <label>Name: <input type="text" id="pmName" value="${escHtml(profile.name)}" placeholder="my-profile" ${dis}></label>
          </div>
          ${usageHtml}
        </div>
        <div class="pm-form-group">
          <h4>Model</h4>
          <div class="pm-field-row">
            <label class="pm-wide">Model: <select id="pmModel"${dis}></select></label>
          </div>
          <div class="pm-field-row" id="pmEffortRow">
            <label>Thinking effort:
              <select id="pmEffort"${dis}>
                <option value="">default</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            </label>
            <span class="pm-model-info" id="pmModelInfo"></span>
          </div>
        </div>
        <div class="pm-form-group">
          <h4>Permissions</h4>
          <div class="pm-field-row">
            <label>Permission mode:
              <select id="pmPermission"${dis}>
                <option value="default">default</option>
                <option value="acceptEdits">acceptEdits</option>
                <option value="plan">plan</option>
                <option value="bypassPermissions">bypassPermissions</option>
                <option value="dontAsk">dontAsk</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <label class="pm-check"><input type="checkbox" id="pmSlash"${dis}> Slash commands</label>
            <label class="pm-check"><input type="checkbox" id="pmBare"${dis}> Bare mode <span class="cap-modal-hint">(no skills or MCPs)</span></label>
            <label class="pm-check"><input type="checkbox" id="pmDisableMemory"${dis}> Disable auto-memory</label>
          </div>
        </div>
        <div class="pm-form-group">
          <h4>Limits</h4>
          <div class="pm-field-row">
            <label>Max turns: <input type="number" id="pmMaxTurns" min="1" max="999" placeholder="--" style="width:60px"${dis}></label>
            <label>Budget $: <input type="number" id="pmMaxBudget" min="0.01" step="0.01" placeholder="--" style="width:70px"${dis}></label>
          </div>
        </div>
        <div class="pm-form-group">
          <h4>Tools</h4>
          <p class="cap-modal-hint">Checked tools are enabled. Unchecked tools are passed as <code>--disallowedTools</code> to the CLI.</p>
          <label class="pm-tool-item" style="margin-bottom:8px;font-weight:600">
            <input type="checkbox" id="pmAllowAllTools"${dis}> Allow all tools (pass <code>--allowedTools</code> — bypasses permission prompts)
          </label>
          <div class="pm-tool-grid" id="pmToolGrid"></div>
        </div>
        <div class="pm-form-group">
          <h4>System Prompts</h4>
          <label class="cap-modal-label">Append to system prompt <span class="cap-modal-hint" style="font-weight:normal">— added after the default prompt</span></label>
          <textarea id="pmAppendPrompt" class="pm-textarea" rows="3" placeholder="e.g. Focus on code quality and security..."${dis}></textarea>
          <label class="cap-modal-label" style="margin-top:10px">Override system prompt <span class="cap-modal-hint" style="font-weight:normal">— replaces the entire default (use with caution)</span></label>
          <textarea id="pmSystemPrompt" class="pm-textarea" rows="3" placeholder="Leave empty to use default system prompt"${dis}></textarea>
        </div>
        ${isBuiltin ? '' : `<div class="pm-inline-actions">
          <button class="cap-save-btn" id="pmSave">Save</button>
          <button class="cap-del-btn pm-delete-btn" id="pmDelete"${usedBy.length > 0 ? ' disabled title="Profile is used by workflows"' : ''}>Delete</button>
        </div>`}
      </div>
      <div class="cap-modal-docs">
        <h4>CLI flag mapping</h4>
        <pre class="cap-modal-pre">Field            CLI flag
─────────────    ──────────────────────
model            --model &lt;value&gt;
effort           --effort &lt;level&gt;
permission       --permission-mode &lt;mode&gt;
slash cmds off   --disable-slash-commands
tools            --disallowedTools T1 T2
max turns        --max-turns &lt;n&gt;
budget           --max-budget-usd &lt;n&gt;
append prompt    --append-system-prompt
system prompt    --system-prompt</pre>
        <h4>Permission modes</h4>
        <pre class="cap-modal-pre">default        Ask for each tool use
acceptEdits    Auto-accept file edits
plan           Read-only, suggest only
bypassPermissions  Skip all prompts
dontAsk        Bypass + auto-accept
auto           Automatic with guardrails</pre>
        <h4>Built-in profiles</h4>
        <pre class="cap-modal-pre">full     All tools, no prompts
safe     acceptEdits, blocks Bash/Write
readonly plan mode, Read/Glob/Grep only
minimal  plan mode, Read/Glob/Grep</pre>
      </div>
    </div>`;

    // Populate dynamic fields
    populateModelSelector(profile);
    document.getElementById('pmEffort').value = profile.effort || '';
    updateModelInfo();
    updateToolGridForModel();

    document.getElementById('pmPermission').value = profile.permissionMode || 'default';
    document.getElementById('pmMaxTurns').value = profile.maxTurns || '';
    document.getElementById('pmMaxBudget').value = profile.maxBudgetUsd || '';
    document.getElementById('pmSlash').checked = !profile.disableSlashCommands;
    document.getElementById('pmBare').checked = !!profile.bare;
    document.getElementById('pmDisableMemory').checked = profile.disableAutoMemory !== false;
    document.getElementById('pmAppendPrompt').value = profile.appendSystemPrompt || '';
    document.getElementById('pmSystemPrompt').value = profile.systemPrompt || '';

    // Allow-all-tools checkbox
    const allowAllEl = document.getElementById('pmAllowAllTools');
    if (allowAllEl) {
      const allowed = new Set(profile.allowedTools || []);
      allowAllEl.checked = allowed.size > 0 && state.knownTools.every(t => allowed.has(t));
    }

    // Tool checkbox grid
    const grid = document.getElementById('pmToolGrid');
    if (grid) {
      grid.innerHTML = '';
      const disabled = new Set(profile.disabledTools || []);
      for (const tool of state.knownTools) {
        const item = document.createElement('label');
        item.className = 'pm-tool-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !disabled.has(tool);
        cb.dataset.tool = tool;
        if (isBuiltin) cb.disabled = true;
        item.appendChild(cb);
        item.appendChild(document.createTextNode(' ' + tool));
        grid.appendChild(item);
      }
    }

    // Save button
    document.getElementById('pmSave')?.addEventListener('click', saveCurrentProfile);
    // Delete button
    document.getElementById('pmDelete')?.addEventListener('click', () => {
      if (!confirm(`Delete profile "${activeProfileTab}"? This cannot be undone.`)) return;
      sendWs({ type: 'profile:delete', name: activeProfileTab });
    });
    // Model change updates info and tool grid
    document.getElementById('pmModel')?.addEventListener('change', () => {
      updateModelInfo();
      updateToolGridForModel();
    });
  }

  function saveCurrentProfile() {
    const name = document.getElementById('pmName')?.value?.trim();
    if (!name) return alert('Profile name is required.');
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/.test(name) || name.length < 2) {
      return alert('Invalid name. Use letters, numbers, spaces, hyphens, underscores, or dots. Min 2 chars.');
    }
    const allowAllTools = document.getElementById('pmAllowAllTools')?.checked;
    const allowedTools = allowAllTools ? [...state.knownTools] : [];
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
      allowedTools,
      disabledTools,
      mcpServers,
      disableSlashCommands: !document.getElementById('pmSlash')?.checked,
      bare: !!document.getElementById('pmBare')?.checked,
      disableAutoMemory: document.getElementById('pmDisableMemory')?.checked !== false,
      maxTurns: maxT > 0 ? maxT : null,
      maxBudgetUsd: maxB > 0 ? maxB : null,
      appendSystemPrompt: document.getElementById('pmAppendPrompt')?.value?.trim() || null,
      systemPrompt: document.getElementById('pmSystemPrompt')?.value?.trim() || null,
      modelDef: (() => {
        const v = document.getElementById('pmModel')?.value || '';
        return v.startsWith('modeldef:') ? v.slice(9) : null;
      })(),
    };
    const oldName = activeProfileTab;
    const msg = { type: 'profile:save', profile };
    if (oldName && oldName !== name) msg.oldName = oldName;
    sendWs(msg);
    activeProfileTab = name;
  }

  // Profile tab switching
  document.getElementById('profilesNav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    activeProfileTab = btn.dataset.profile;
    renderProfileTabs();
  });

  // New profile button
  document.getElementById('profileNewBtn')?.addEventListener('click', () => {
    // Create a temporary new profile entry
    const name = 'new-profile';
    let counter = 1;
    let finalName = name;
    while (state.profiles.some(p => p.name === finalName)) {
      finalName = `${name}-${counter++}`;
    }
    const newProf = {
      name: finalName, builtin: false,
      model: null, effort: null, permissionMode: 'default',
      allowedTools: [], disabledTools: [], mcpServers: [],
      disableSlashCommands: false, bare: false, disableAutoMemory: true,
      maxTurns: null, maxBudgetUsd: null,
      appendSystemPrompt: null, systemPrompt: null, modelDef: null,
    };
    sendWs({ type: 'profile:save', profile: newProf });
    activeProfileTab = finalName;
  });

  // External API: navigate to profiles view and select a profile tab
  function openProfileModal(profile) {
    if (profile?.name) activeProfileTab = profile.name;
    switchView('profiles');
    renderProfileTabs();
  }

  // --- Profile model helpers ---

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

  // Provider keys that support native web search
  const WEB_SEARCH_PROVIDERS = new Set(['openai', 'google', 'moonshot']);

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

  function updateToolGridForModel() {
    const modelDef = getSelectedModelDef();
    const grid = document.getElementById('pmToolGrid');
    if (!grid) return;

    for (const label of grid.querySelectorAll('.pm-tool-item')) {
      const cb = label.querySelector('input[type="checkbox"]');
      if (!cb) continue;
      const tool = cb.dataset.tool;
      const hint = label.querySelector('.pm-server-tool-hint');
      if (hint) hint.remove();

      if (tool === 'WebSearch' && modelDef) {
        const pk = modelDef.providerKey;
        if (WEB_SEARCH_PROVIDERS.has(pk)) {
          cb.disabled = false;
          label.classList.remove('pm-tool-disabled');
          const span = document.createElement('span');
          span.className = 'pm-server-tool-hint pm-provider-hint';
          span.textContent = pk === 'google' ? ' (Google Search)'
            : pk === 'moonshot' ? ' (Kimi Search)' : ' (web search)';
          label.appendChild(span);
        } else {
          cb.checked = false;
          cb.disabled = true;
          label.classList.add('pm-tool-disabled');
          const span = document.createElement('span');
          span.className = 'pm-server-tool-hint';
          span.textContent = ' (not available for this provider)';
          label.appendChild(span);
        }
      } else if (tool === 'WebFetch' && modelDef) {
        cb.checked = false;
        cb.disabled = true;
        label.classList.add('pm-tool-disabled');
        const span = document.createElement('span');
        span.className = 'pm-server-tool-hint';
        span.textContent = ' (Anthropic only \u2014 use MCP for local fetch)';
        label.appendChild(span);
      } else if (!modelDef) {
        cb.disabled = false;
        label.classList.remove('pm-tool-disabled');
      }
    }
  }


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

  let activeProviderTab = null;

  function renderModelsPanel() {
    const nav = document.getElementById('modelsNav');
    const list = document.getElementById('capModelList');
    if (!list) return;

    // Build provider tabs (preserve non-tab children like the action button)
    if (nav) {
      nav.querySelectorAll('.view-tab').forEach(b => b.remove());
      const actionBtn = nav.querySelector('.view-nav-action');
      for (const prov of state.providers) {
        const btn = document.createElement('button');
        btn.className = 'view-tab' + (activeProviderTab === prov.key || (!activeProviderTab && prov === state.providers[0]) ? ' active' : '');
        btn.dataset.provider = prov.key;
        btn.textContent = prov.label;
        nav.insertBefore(btn, actionBtn);
      }
      if ((!activeProviderTab || !state.providers.some(p => p.key === activeProviderTab)) && state.providers.length) activeProviderTab = state.providers[0].key;
    }

    // Find active provider
    const prov = state.providers.find(p => p.key === activeProviderTab) || state.providers[0];
    if (!prov) { list.innerHTML = '<div class="models-empty">No providers configured.</div>'; return; }

    // Provider key bar
    const hasKey = !!prov.apiKey;
    const keyId = `provKey_${prov.key}`;
    let html = `<div class="provider-header">
      <span class="provider-url">${escHtml(prov.apiBaseUrl || '')}</span>
      <span class="provider-key-area">
        <input type="password" id="${keyId}" class="provider-key-input" value="${escHtml(prov.apiKey || '')}" placeholder="Paste API key..." autocomplete="off">
        <button type="button" class="provider-key-toggle" data-target="${keyId}" title="Show/hide key">&#128065;</button>
        <button type="button" class="provider-key-save" data-provider="${escHtml(prov.key)}" title="Save key">${hasKey ? 'Update' : 'Set key'}</button>
        <span class="provider-key-status ${hasKey ? 'mm-key-ok' : 'mm-key-missing'}">${hasKey ? 'connected' : 'no key'}</span>
      </span>
    </div>`;

    // Model cards
    const provModels = state.models.filter(m => m.providerKey === prov.key);
    html += '<div class="model-card-grid">';
    for (const model of provModels) {
      const ctx = model.contextWindow ? Math.round(model.contextWindow / 1000) + 'K' : '';
      const out = model.maxOutputTokens ? Math.round(model.maxOutputTokens / 1000) + 'K' : '';
      const specs = [ctx ? ctx + ' ctx' : '', out ? out + ' out' : ''].filter(Boolean).join(', ');
      const pricing = model.inputCostPerMTok != null
        ? `$${model.inputCostPerMTok} / $${model.outputCostPerMTok} per MTok`
        : '';
      html += `<div class="model-card" data-name="${escHtml(model.name)}" data-kind="model">
        <div class="model-card-name">${escHtml(model.label || model.name)}</div>
        <div class="model-card-id"><code>${escHtml(model.modelId || '')}</code></div>
        ${model.description ? '<div class="model-card-desc">' + escHtml(model.description) + '</div>' : ''}
        <div class="model-card-meta">
          ${model.reasoning ? '<span class="cap-model-reasoning">reasoning</span>' : ''}
          ${specs ? '<span class="cap-model-specs">' + escHtml(specs) + '</span>' : ''}
          ${pricing ? '<span class="cap-model-pricing">' + escHtml(pricing) + '</span>' : ''}
        </div>
      </div>`;
    }
    if (provModels.length === 0) {
      html += '<div class="models-empty">No models for this provider.</div>';
    }
    html += '</div>';
    list.innerHTML = html;

    // Card click → open edit modal
    list.querySelectorAll('.model-card').forEach(card => {
      card.addEventListener('click', () => {
        const model = state.models.find(m => m.name === card.dataset.name);
        if (model) openModelModal(model);
      });
    });
  }

  // Provider tab switching
  document.getElementById('modelsNav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    activeProviderTab = btn.dataset.provider;
    renderModelsPanel();
  });

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

    // Cost fields
    const mmInputCost = document.getElementById('mmInputCost');
    if (mmInputCost) mmInputCost.value = model.inputCostPerMTok ?? '';
    const mmOutputCost = document.getElementById('mmOutputCost');
    if (mmOutputCost) mmOutputCost.value = model.outputCostPerMTok ?? '';
    const mmCacheReadCost = document.getElementById('mmCacheReadCost');
    if (mmCacheReadCost) mmCacheReadCost.value = model.cacheReadCostPerMTok ?? '';
    const mmCacheCreateCost = document.getElementById('mmCacheCreateCost');
    if (mmCacheCreateCost) mmCacheCreateCost.value = model.cacheCreateCostPerMTok ?? '';

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

    const inCost = parseFloat(document.getElementById('mmInputCost')?.value);
    const outCost = parseFloat(document.getElementById('mmOutputCost')?.value);
    const crCost = parseFloat(document.getElementById('mmCacheReadCost')?.value);
    const ccCost = parseFloat(document.getElementById('mmCacheCreateCost')?.value);

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
      inputCostPerMTok: inCost >= 0 ? inCost : null,
      outputCostPerMTok: outCost >= 0 ? outCost : null,
      cacheReadCostPerMTok: crCost >= 0 ? crCost : null,
      cacheCreateCostPerMTok: ccCost >= 0 ? ccCost : null,
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

  // --- Refresh Pricing via claude -p ---
  document.getElementById('capRefreshPricing')?.addEventListener('click', () => {
    const btn = document.getElementById('capRefreshPricing');
    const statusEl = document.getElementById('capRefreshStatus');
    if (!btn || !statusEl) return;
    btn.disabled = true;
    btn.textContent = 'Looking up prices...';
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'Starting pricing lookup via Claude...';

    // Derive project root from outputsDir (strip trailing /outputs)
    const projectRoot = (state.outputsDir || '').replace(/\/outputs\/?$/, '');
    const modelsPath = projectRoot + '/capabilities/models.json';
    const anthropicPath = projectRoot + '/capabilities/anthropic-pricing.json';

    // Build model list for the prompt
    const modelList = state.models.map(m => `${m.label || m.name} (modelId: ${m.modelId}, provider: ${m.providerKey})`).join('\n');
    const prompt = `Update the pricing data for AI models by directly editing the pricing files on disk.

Steps:
1. Read ${modelsPath} to see the current model definitions.
2. Read ${anthropicPath} to see the current Anthropic pricing entries.
3. Look up the current official API pricing (per million tokens, in USD) for:
   - Each model found in models.json (third-party models listed below).
   - All current Anthropic Claude models. You are a Claude model yourself — you know which models Anthropic currently offers. Update existing entries in anthropic-pricing.json with correct current prefix keys (e.g. claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5) and remove outdated entries that no longer match any current model.
4. For each model in models.json, update the inputCostPerMTok, outputCostPerMTok, cacheReadCostPerMTok, and cacheCreateCostPerMTok fields directly in the file. Use null for cache fields if not available.
5. For Anthropic models, update ${anthropicPath} with the same four fields per model.

The third-party models to look up pricing for:
${modelList}

IMPORTANT: You MUST directly edit the files using your Edit or Write tools — do not just output JSON. After updating, briefly summarize which models were updated and their new prices.`;

    const body = JSON.stringify({ type: 'chat', prompt, profile: 'full' });
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then(async res => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        while (buf.includes('\n\n')) {
          const idx = buf.indexOf('\n\n');
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = null, data = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (!ev || !data) continue;
          try { data = JSON.parse(data); } catch { continue; }
          if (ev === 'text') {
            fullText += data.text || '';
            statusEl.textContent = 'Claude is updating pricing files...';
          } else if (ev === 'done') {
            applyPricingResult(fullText, statusEl, btn);
            return;
          } else if (ev === 'error') {
            statusEl.textContent = 'Error: ' + (data.error || 'unknown');
            btn.disabled = false;
            btn.textContent = 'Refresh Pricing';
            return;
          }
        }
      }
      // Stream ended without done event
      applyPricingResult(fullText, statusEl, btn);
    }).catch(err => {
      statusEl.textContent = 'Fetch error: ' + err.message;
      btn.disabled = false;
      btn.textContent = 'Refresh Pricing';
    });
  });

  function applyPricingResult(text, statusEl, btn) {
    // Claude has directly updated the files — refresh model state from server
    sendWs({ type: 'model:list' });
    statusEl.textContent = text ? 'Pricing files updated. Refreshing...' : 'Pricing update completed.';
    btn.disabled = false;
    btn.textContent = 'Refresh Pricing';
  }


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
        renderProfileTabs();
        break;
    }
  }

  function handleSettings(msg) {
    // State sync handled by core.js syncSettings(); just re-render here
    if (msg.capabilities || msg.profiles) {
      renderProfileTabs();
      updateCapabilityStats();
      renderSkillsPanel();
    }
  }

  // --- Export ---
  window.capabilitiesModule = { handleMessage, handleSettings, openProfileModal };
})();
