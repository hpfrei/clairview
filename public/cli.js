(function () {
  const { sendWs, state, escHtml, askFormBuildHTML, askFormBind } = window.dashboard;
  const tabStrip = document.getElementById('cliTabStrip');
  const tabNewBtn = document.getElementById('cliTabNew');
  const container = document.getElementById('cliContainer');
  const placeholder = document.getElementById('cliPlaceholder');
  const settingsModal = document.getElementById('cliSettingsModal');

  const tabs = new Map();
  let activeTabId = null;
  const pendingAskOverlays = new Map();

  function getTheme() {
    return { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#a0a0ff', selectionBackground: 'rgba(160,160,255,0.3)' };
  }

  function createTab(tabId) {
    const wrap = document.createElement('div');
    wrap.className = 'cli-terminal-wrap';
    wrap.style.display = 'none';

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      theme: getTheme(),
      convertEol: true,
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    try { terminal.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

    terminal.open(wrap);

    terminal.onData(data => {
      sendWs({ type: 'cli:input', tabId, data });
    });

    terminal.onResize(({ cols, rows }) => {
      sendWs({ type: 'cli:resize', tabId, cols, rows });
    });

    const tab = { terminal, fitAddon, wrap, cwd: null, title: null, settings: {}, status: 'idle' };
    tabs.set(tabId, tab);

    container.appendChild(wrap);

    const ro = new ResizeObserver(() => {
      if (activeTabId === tabId && wrap.offsetWidth > 0) {
        try { fitAddon.fit(); } catch {}
      }
    });
    ro.observe(wrap);
    tab._resizeObserver = ro;

    return tab;
  }

  function switchTab(tabId) {
    for (const [id, tab] of tabs) {
      tab.wrap.style.display = id === tabId ? '' : 'none';
    }
    activeTabId = tabId;
    if (placeholder) placeholder.style.display = tabs.size > 0 ? 'none' : '';
    renderTabStrip();
    const tab = tabs.get(tabId);
    if (tab) {
      setTimeout(() => {
        try { tab.fitAddon.fit(); } catch {}
        tab.terminal.focus();
      }, 50);
    }
  }

  function computeTabLabel(tabId) {
    const tab = tabs.get(tabId);
    if (tab?.title) return tab.title;
    if (!tab?.cwd) return tabId;
    const parts = tab.cwd.replace(/\/+$/, '').split('/');
    const basename = parts[parts.length - 1] || tab.cwd;
    const sameDir = [];
    for (const [id, t] of tabs) {
      if (t.title) continue;
      if (!t.cwd) continue;
      const p = t.cwd.replace(/\/+$/, '').split('/');
      if ((p[p.length - 1] || t.cwd) === basename) sameDir.push(id);
    }
    if (sameDir.length <= 1) return basename;
    sameDir.sort();
    const idx = sameDir.indexOf(tabId);
    return idx === 0 ? basename : `${basename}-${idx + 1}`;
  }

  function renderTabStrip() {
    if (!tabStrip) return;
    tabStrip.querySelectorAll('.view-tab').forEach(el => el.remove());

    for (const [tabId, tab] of tabs) {
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (tabId === activeTabId ? ' active' : '') + (pendingAskOverlays.has(tabId) ? ' has-pending-ask' : '');
      btn.dataset.tabId = tabId;

      const label = document.createElement('span');
      label.className = 'cli-tab-label';
      const isAppCli = tabId.startsWith('app-');
      label.textContent = (isAppCli ? '\u{1F528} ' : '') + computeTabLabel(tabId);
      let clickTimer = null;
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        if (activeTabId !== tabId) {
          switchTab(tabId);
          return;
        }
        if (clickTimer) return;
        clickTimer = setTimeout(() => {
          clickTimer = null;
          switchView('dashboard');
          window.inspectorModule?.switchInstanceTab?.(`cli-${tabId}`);
        }, 250);
      });
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        startInlineRename(tabId, label);
      });
      btn.appendChild(label);

      const gear = document.createElement('span');
      gear.className = 'cli-settings-btn';
      gear.textContent = '⚙';
      gear.title = 'Settings';
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        openSettings(tabId);
      });
      btn.appendChild(gear);

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        sendWs({ type: 'cli:closeTab', tabId });
        removeTab(tabId);
      });
      btn.appendChild(close);

      btn.addEventListener('click', () => switchTab(tabId));
      tabStrip.insertBefore(btn, tabNewBtn);
    }
  }

  function startInlineRename(tabId, labelEl) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const input = document.createElement('input');
    input.className = 'cli-tab-rename-input';
    input.value = tab.title || computeTabLabel(tabId);
    input.size = Math.max(input.value.length, 4);
    const parent = labelEl.parentElement;
    labelEl.style.display = 'none';
    parent.insertBefore(input, labelEl);
    input.focus();
    input.select();

    let done = false;
    function commit() {
      if (done) return;
      done = true;
      const val = input.value.trim();
      input.remove();
      labelEl.style.display = '';
      tab.title = val || null;
      sendWs({ type: 'cli:rename', tabId, title: tab.title });
      renderTabStrip();
      window.inspectorModule?.renderInspectorTabStrip?.();
    }
    function cancel() {
      if (done) return;
      done = true;
      input.remove();
      labelEl.style.display = '';
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

  function removeTab(tabId) {
    dismissAskOverlay(tabId);
    const tab = tabs.get(tabId);
    if (tab) {
      tab.terminal.dispose();
      tab._resizeObserver?.disconnect();
      tab.wrap.remove();
      tabs.delete(tabId);
    }
    if (activeTabId === tabId) {
      const remaining = Array.from(tabs.keys());
      if (remaining.length > 0) {
        switchTab(remaining[remaining.length - 1]);
      } else {
        activeTabId = null;
        if (placeholder) placeholder.style.display = '';
        renderTabStrip();
      }
    }
  }

  // --- "+" button: menu with New + saved sessions ---
  tabNewBtn?.addEventListener('click', () => {
    sendWs({ type: 'cli:getSavedSessions' });
    state._showNewMenu = true;
  });

  function showNewMenu(savedSessions) {
    closeNewMenu();
    const menu = document.createElement('div');
    menu.className = 'cli-new-menu';
    menu.id = 'cliNewMenu';

    const newItem = document.createElement('div');
    newItem.className = 'cli-new-menu-item cli-new-menu-new';
    newItem.textContent = 'New CLI in directory…';
    newItem.addEventListener('click', async () => {
      closeNewMenu();
      const picked = await openFsDirPicker();
      if (!picked) return;
      state._pendingCliCwd = picked;
      sendWs({ type: 'cli:newTab' });
    });
    menu.appendChild(newItem);

    if (savedSessions.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'cli-new-menu-divider';
      menu.appendChild(divider);

      const header = document.createElement('div');
      header.className = 'cli-new-menu-header';
      header.textContent = 'Resume session';
      menu.appendChild(header);

      for (const sess of savedSessions) {
        const parts = sess.cwd.replace(/\/+$/, '').split('/');
        const dirName = parts[parts.length - 1] || sess.cwd;
        const mappings = formatModelMap(sess.settings?.modelMap);
        const age = formatAge(sess.savedAt);
        const displayTitle = sess.title || dirName;

        const item = document.createElement('div');
        item.className = 'cli-new-menu-item cli-new-menu-session';
        item.title = sess.cwd;

        const info = document.createElement('div');
        info.className = 'cli-new-menu-session-info';
        info.innerHTML = `<span class="cli-new-menu-dir">${escHtml(displayTitle)}</span><span class="cli-new-menu-age">${escHtml(age)}</span>`;
        item.appendChild(info);

        const dirLine = document.createElement('div');
        dirLine.className = 'cli-new-menu-meta';
        dirLine.textContent = sess.cwd;
        item.appendChild(dirLine);

        if (mappings) {
          const meta = document.createElement('div');
          meta.className = 'cli-new-menu-meta';
          meta.textContent = mappings;
          item.appendChild(meta);
        }

        const del = document.createElement('span');
        del.className = 'cli-new-menu-del';
        del.textContent = '×';
        del.title = 'Remove';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          sendWs({ type: 'cli:deleteSavedSession', sessionId: sess.id });
          item.remove();
        });
        item.appendChild(del);

        item.addEventListener('click', () => {
          closeNewMenu();
          state._pendingCliCwd = sess.cwd;
          state._pendingCliResume = true;
          state._pendingCliSettings = sess.settings;
          state._pendingCliTitle = sess.title || null;
          sendWs({ type: 'cli:newTab' });
        });
        menu.appendChild(item);
      }
    }

    document.body.appendChild(menu);
    const rect = tabNewBtn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 4 + 'px';
    const menuWidth = menu.offsetWidth || 260;
    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
    menu.style.left = left + 'px';
    const onClickOutside = (e) => {
      if (!menu.contains(e.target) && e.target !== tabNewBtn) {
        closeNewMenu();
        document.removeEventListener('click', onClickOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside, true), 0);
  }

  function closeNewMenu() {
    document.getElementById('cliNewMenu')?.remove();
  }

  function formatModelMap(modelMap) {
    if (!modelMap) return '';
    const parts = [];
    for (const [family, mapped] of Object.entries(modelMap)) {
      if (mapped) parts.push(`${family}→${mapped}`);
    }
    return parts.join(', ');
  }

  function formatAge(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  // --- Filesystem directory picker ---
  async function openFsDirPicker() {
    const modal = document.getElementById('dirPickerModal');
    const closeBtn = document.getElementById('dirPickerClose');
    const crumbsEl = document.getElementById('dirPickerBreadcrumbs');
    const listEl = document.getElementById('dirPickerList');
    const cancelBtn = document.getElementById('dirPickerCancelBtn');
    const selectBtn = document.getElementById('dirPickerSelectBtn');
    const newBtn = document.getElementById('dirPickerNewBtn');
    const newRow = document.getElementById('dirPickerNew');
    const newNameInput = document.getElementById('dirPickerNewName');
    const newOkBtn = document.getElementById('dirPickerNewOk');
    const newCancelBtn = document.getElementById('dirPickerNewCancel');

    let currentDir = '';
    let resolve;
    const promise = new Promise(r => { resolve = r; });

    async function loadDir(dirPath) {
      listEl.innerHTML = '<div class="dir-picker-empty">Loading...</div>';
      try {
        const resp = await fetch('/api/browse-dirs?path=' + encodeURIComponent(dirPath));
        const data = await resp.json();
        if (data.error) {
          listEl.innerHTML = '<div class="dir-picker-empty">' + data.error + '</div>';
          return;
        }
        currentDir = data.current;
        renderCrumbs(data.current, data.parent);
        renderDirs(data.dirs, data.current, data.parent);
      } catch {
        listEl.innerHTML = '<div class="dir-picker-empty">Failed to load directories.</div>';
      }
    }

    function renderCrumbs(absPath, parent) {
      crumbsEl.innerHTML = '';
      const parts = absPath.split('/').filter(Boolean);
      parts.forEach((seg, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'dir-picker-sep';
          sep.textContent = ' / ';
          crumbsEl.appendChild(sep);
        }
        const crumb = document.createElement('span');
        crumb.className = 'dir-picker-crumb' + (i === parts.length - 1 ? ' active' : '');
        crumb.textContent = seg;
        if (i < parts.length - 1) {
          const target = '/' + parts.slice(0, i + 1).join('/');
          crumb.addEventListener('click', () => loadDir(target));
        }
        crumbsEl.appendChild(crumb);
      });
    }

    function renderDirs(dirs, current, parent) {
      listEl.innerHTML = '';
      if (parent && parent !== current) {
        const up = document.createElement('div');
        up.className = 'dir-picker-item parent';
        up.innerHTML = '<span class="dir-picker-item-icon">←</span><span class="dir-picker-item-name">..</span>';
        up.addEventListener('click', () => loadDir(parent));
        listEl.appendChild(up);
      }
      if (dirs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dir-picker-empty';
        empty.textContent = 'No subdirectories.';
        listEl.appendChild(empty);
      }
      dirs.forEach(name => {
        const item = document.createElement('div');
        item.className = 'dir-picker-item';
        item.title = name;
        const d = document.createElement('span'); d.textContent = name;
        item.innerHTML = '<span class="dir-picker-item-icon">📁</span><span class="dir-picker-item-name">' + d.innerHTML + '</span>';
        item.addEventListener('click', () => loadDir(current + '/' + name));
        listEl.appendChild(item);
      });
    }

    // New folder handlers
    function onNewBtn() {
      newRow.classList.remove('hidden');
      newNameInput.value = '';
      newNameInput.focus();
    }
    async function onNewOk() {
      const name = newNameInput.value.trim();
      if (!name) return;
      try {
        const resp = await fetch('/api/browse-dirs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent: currentDir, name }),
        });
        const data = await resp.json();
        if (data.error) { alert(data.error); return; }
        newRow.classList.add('hidden');
        loadDir(data.created);
      } catch { alert('Failed to create folder.'); }
    }
    function onNewCancel() { newRow.classList.add('hidden'); }
    function onNewKey(e) { if (e.key === 'Enter') onNewOk(); }

    function cleanup() {
      modal.classList.add('hidden');
      newRow.classList.add('hidden');
      closeBtn.removeEventListener('click', onClose);
      cancelBtn.removeEventListener('click', onClose);
      selectBtn.removeEventListener('click', onSelect);
      newBtn.removeEventListener('click', onNewBtn);
      newOkBtn.removeEventListener('click', onNewOk);
      newCancelBtn.removeEventListener('click', onNewCancel);
      newNameInput.removeEventListener('keydown', onNewKey);
    }
    function onClose() { cleanup(); resolve(null); }
    function onSelect() { cleanup(); resolve(currentDir); }

    closeBtn.addEventListener('click', onClose);
    cancelBtn.addEventListener('click', onClose);
    selectBtn.addEventListener('click', onSelect);
    newBtn.addEventListener('click', onNewBtn);
    newOkBtn.addEventListener('click', onNewOk);
    newCancelBtn.addEventListener('click', onNewCancel);
    newNameInput.addEventListener('keydown', onNewKey);

    modal.classList.remove('hidden');
    loadDir('');

    return promise;
  }

  // --- Settings modal ---
  function openSettings(tabId) {
    if (!settingsModal) return;
    const tab = tabs.get(tabId);
    sendWs({ type: 'cli:getSettings', tabId });
    settingsModal._tabId = tabId;
    settingsModal.classList.remove('hidden');
  }

  function populateSettings(tabId, settings, models) {
    if (!settingsModal || settingsModal._tabId !== tabId) return;
    const tab = tabs.get(tabId);
    const titleInput = document.getElementById('cliSettingsTitle');
    if (titleInput) titleInput.value = tab?.title || '';
    const modelMap = settings.modelMap || { opus: null, sonnet: null, haiku: null };
    const modelOptions = (models || []).map(m => m.name);

    ['opus', 'sonnet', 'haiku'].forEach(family => {
      const sel = settingsModal.querySelector(`[data-map="${family}"]`);
      if (!sel) return;
      sel.innerHTML = '<option value="">Default (passthrough)</option>';
      modelOptions.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (modelMap[family] === name) opt.selected = true;
        sel.appendChild(opt);
      });
    });
  }

  function saveSettings() {
    if (!settingsModal) return;
    const tabId = settingsModal._tabId;
    const titleInput = document.getElementById('cliSettingsTitle');
    const newTitle = titleInput?.value.trim() || null;
    const tab = tabs.get(tabId);
    if (tab) tab.title = newTitle;
    sendWs({ type: 'cli:rename', tabId, title: newTitle });
    const modelMap = {};
    ['opus', 'sonnet', 'haiku'].forEach(family => {
      const sel = settingsModal.querySelector(`[data-map="${family}"]`);
      modelMap[family] = sel?.value || null;
    });
    sendWs({ type: 'cli:settings', tabId, settings: { modelMap } });
    settingsModal.classList.add('hidden');
    renderTabStrip();
    window.inspectorModule?.renderInspectorTabStrip?.();
  }

  settingsModal?.querySelectorAll('.cli-settings-cancel').forEach(el => {
    el.addEventListener('click', () => settingsModal.classList.add('hidden'));
  });
  settingsModal?.querySelector('.cli-settings-save')?.addEventListener('click', saveSettings);

  // --- Message handler ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'cli:output': {
        const tab = tabs.get(msg.tabId);
        if (tab) tab.terminal.write(msg.data);
        break;
      }
      case 'cli:exit': {
        const tab = tabs.get(msg.tabId);
        if (tab) {
          tab.status = 'exited';
          tab.terminal.write('\r\n\x1b[90m[Process exited' + (msg.exitCode != null ? ' with code ' + msg.exitCode : '') + ']\x1b[0m\r\n');
          renderTabStrip();
          setTimeout(() => removeTab(msg.tabId), 1500);
        }
        break;
      }
      case 'cli:spawned': {
        let tab = tabs.get(msg.tabId);
        if (!tab && msg.tabId.startsWith('app-')) {
          tab = createTab(msg.tabId);
          switchTab(msg.tabId);
          if (typeof switchView === 'function') switchView('claude');
        }
        if (tab) {
          tab.status = 'running';
          tab.cwd = msg.cwd;
          if (msg.title) tab.title = msg.title;
          tab.settings = msg.settings || {};
          renderTabStrip();
        }
        break;
      }
      case 'cli:tabs': {
        handleTabList(msg.tabs || []);
        break;
      }
      case 'cli:newTab': {
        const tabId = msg.tabId;
        if (!tabs.has(tabId)) createTab(tabId);
        switchTab(tabId);
        const pendingCwd = state._pendingCliCwd;
        const pendingResume = state._pendingCliResume || false;
        const pendingSettings = state._pendingCliSettings;
        const pendingTitle = state._pendingCliTitle || null;
        state._pendingCliCwd = null;
        state._pendingCliResume = false;
        state._pendingCliSettings = null;
        state._pendingCliTitle = null;
        if (pendingTitle) {
          const tab = tabs.get(tabId);
          if (tab) tab.title = pendingTitle;
          sendWs({ type: 'cli:rename', tabId, title: pendingTitle });
        }
        if (pendingSettings) {
          sendWs({ type: 'cli:settings', tabId, settings: pendingSettings });
        }
        if (pendingCwd) {
          const tab = tabs.get(tabId);
          const { cols, rows } = tab ? { cols: tab.terminal.cols, rows: tab.terminal.rows } : { cols: 80, rows: 24 };
          sendWs({ type: 'cli:spawn', tabId, cwd: pendingCwd, cols, rows, resume: pendingResume });
        }
        break;
      }
      case 'cli:settingsData': {
        populateSettings(msg.tabId, msg.settings || {}, msg.models || []);
        break;
      }
      case 'cli:savedSessions': {
        if (state._showNewMenu) {
          state._showNewMenu = false;
          showNewMenu(msg.sessions || []);
        }
        break;
      }
    }
  }

  function handleTabList(serverTabs) {
    const serverIds = new Set(serverTabs.map(t => t.tabId));
    for (const [tabId] of tabs) {
      if (!serverIds.has(tabId)) removeTab(tabId);
    }
    for (const st of serverTabs) {
      if (!tabs.has(st.tabId)) createTab(st.tabId);
      const tab = tabs.get(st.tabId);
      tab.status = st.status;
      tab.cwd = st.cwd;
      tab.title = st.title || null;
      tab.settings = st.settings || {};
    }
    if (!activeTabId && tabs.size > 0) {
      switchTab(serverTabs[0].tabId);
    }
    renderTabStrip();
    window.inspectorModule?.renderInspectorTabStrip?.();
  }

  function updateStreamingState(streamingInstances) {
    if (!tabStrip) return;
    let anyStreaming = false;
    for (const [tabId] of tabs) {
      const instanceId = `cli-${tabId}`;
      const streaming = streamingInstances.has(instanceId);
      if (streaming) anyStreaming = true;
      const tabBtn = tabStrip.querySelector(`[data-tab-id="${tabId}"]`);
      if (tabBtn) tabBtn.classList.toggle('instance-running', streaming);
    }
    const cliHeaderTab = document.querySelector('[data-view="claude"]');
    if (cliHeaderTab) cliHeaderTab.classList.toggle('instance-running', anyStreaming);
  }

  // --- AskUserQuestion overlay ---

  function showAskOverlay(tabId, forms) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    dismissAskOverlay(tabId);

    const overlay = document.createElement('div');
    overlay.className = 'cli-ask-overlay';
    const modal = document.createElement('div');
    modal.className = 'cli-ask-modal';

    const isSingle = forms.length === 1;
    const binders = [];

    if (!isSingle) {
      const tabBar = document.createElement('div');
      tabBar.className = 'cli-ask-tabs';
      forms.forEach((f, idx) => {
        const t = document.createElement('button');
        t.className = 'cli-ask-tab' + (idx === 0 ? ' active' : '');
        t.textContent = f.formData.title || `Question ${idx + 1}`;
        t.addEventListener('click', () => {
          tabBar.querySelectorAll('.cli-ask-tab').forEach(b => b.classList.remove('active'));
          t.classList.add('active');
          body.querySelectorAll('.cli-ask-form-panel').forEach(p => p.classList.remove('active'));
          body.children[idx].classList.add('active');
        });
        tabBar.appendChild(t);
      });
      modal.appendChild(tabBar);
    }

    const body = document.createElement('div');
    body.className = 'cli-ask-body';

    forms.forEach((f, idx) => {
      const panel = document.createElement('div');
      if (isSingle) {
        panel.style.display = 'block';
      } else {
        panel.className = 'cli-ask-form-panel' + (idx === 0 ? ' active' : '');
        panel.classList.add('ask-external-submit');
      }
      panel.innerHTML = askFormBuildHTML(f.formData);

      const binder = askFormBind(panel, f.formData, isSingle ? {
        onSubmit: (answer, files) => {
          sendWs({ type: 'ask:answer', toolUseId: f.toolUseId, answer, files });
          dismissAskOverlay(tabId);
        },
        onCancel: () => {
          sendWs({ type: 'ask:answer', toolUseId: f.toolUseId, answer: [{ id: '_cancelled', question: '', answer: 'cancelled' }] });
          dismissAskOverlay(tabId);
        },
      } : {
        onSubmit: () => {},
        onCancel: () => {},
      });
      binders.push({ binder, form: f });
      body.appendChild(panel);
    });

    modal.appendChild(body);

    if (!isSingle) {
      const footer = document.createElement('div');
      footer.className = 'cli-ask-footer';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ask-cancel-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        for (const { binder, form } of binders) {
          binder.disableForm();
          sendWs({ type: 'ask:answer', toolUseId: form.toolUseId, answer: [{ id: '_cancelled', question: '', answer: 'cancelled' }] });
        }
        dismissAskOverlay(tabId);
      });
      footer.appendChild(cancelBtn);

      const submitBtn = document.createElement('button');
      submitBtn.className = 'ask-submit-btn';
      submitBtn.textContent = 'Submit All';
      submitBtn.disabled = true;

      const updateReady = () => {
        submitBtn.disabled = !binders.every(b => b.binder.checkReady());
      };

      const observer = new MutationObserver(updateReady);
      observer.observe(body, { subtree: true, attributes: true, childList: true, characterData: true });
      body.addEventListener('input', updateReady);
      body.addEventListener('change', updateReady);
      setTimeout(updateReady, 0);

      submitBtn.addEventListener('click', () => {
        for (const { binder, form } of binders) {
          const answer = binder.collectAnswers();
          const files = binder.getFileData();
          sendWs({ type: 'ask:answer', toolUseId: form.toolUseId, answer, files });
          binder.disableForm();
        }
        dismissAskOverlay(tabId);
      });
      footer.appendChild(submitBtn);
      modal.appendChild(footer);
    }

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.querySelector('.cli-ask-modal')?.scrollTo(0, 0);
    });
    tab.wrap.appendChild(overlay);
    pendingAskOverlays.set(tabId, { overlayEl: overlay });
    renderTabStrip();
  }

  function dismissAskOverlay(tabId) {
    const pending = pendingAskOverlays.get(tabId);
    if (pending) {
      pending.overlayEl.remove();
      pendingAskOverlays.delete(tabId);
      renderTabStrip();
    }
  }

  function handleAskMessage(msg) {
    switch (msg.type) {
      case 'ask:question': {
        const tabId = msg.tabId;
        if (!tabId || !tabs.has(tabId)) return;
        showAskOverlay(tabId, msg.forms || []);
        if (activeTabId !== tabId) switchTab(tabId);
        // Also switch to the CLI view if we're on another view
        if (typeof switchView === 'function') switchView('claude');
        else document.querySelector('[data-view="claude"]')?.click();
        break;
      }
      case 'ask:answered':
      case 'ask:timeout': {
        if (msg.tabId) dismissAskOverlay(msg.tabId);
        break;
      }
    }
  }

  // Expose module
  window.cliModule = { handleMessage, handleAskMessage, tabs, updateStreamingState, switchTab };
})();
