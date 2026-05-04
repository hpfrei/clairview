(function directoriesModule() {
  'use strict';
  const { escHtml, sendWs } = window.dashboard;

  const tabStrip = document.getElementById('dirTabStrip');
  const tabNewBtn = document.getElementById('dirTabNew');
  const container = document.getElementById('dirContainer');
  const placeholder = document.getElementById('dirPlaceholder');

  const tabs = new Map();
  let activeTabId = null;
  let tabCounter = 0;

  // ── Monaco lazy loader (shared pattern with rules.js) ──────────────

  let monacoReady = false;
  let monacoReadyPromise = null;

  function ensureMonaco() {
    if (monacoReady) return Promise.resolve();
    if (monacoReadyPromise) return monacoReadyPromise;
    monacoReadyPromise = new Promise(resolve => {
      if (typeof window.require === 'undefined' || !window.require.config) {
        resolve();
        return;
      }
      window.require.config({
        paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' }
      });
      window.require(['vs/editor/editor.main'], function () {
        monacoReady = true;
        resolve();
      });
    });
    return monacoReadyPromise;
  }

  function getMonacoTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
  }

  // ── Tab management ─────────────────────────────────────────────────

  function createTab(startPath) {
    const tabId = 'dir-' + (++tabCounter);
    const wrap = document.createElement('div');
    wrap.className = 'dir-browser-wrap';
    wrap.style.display = 'none';

    const leftPanel = buildLeftPanel(tabId);
    const resizer = buildResizer(leftPanel);
    const rightPanel = buildRightPanel();

    wrap.appendChild(leftPanel);
    wrap.appendChild(resizer);
    wrap.appendChild(rightPanel);
    container.appendChild(wrap);

    const tab = {
      id: tabId,
      cwd: startPath || null,
      sortBy: 'name',
      sortDir: 'asc',
      selectedFile: null,
      selectedPaths: new Set(),
      _lastSelectedIndex: -1,
      entries: [],
      wrap,
      leftPanel,
      rightPanel,
      editor: null,
      loadSeq: 0,
      searchMode: false,
      showPreviews: false,
    };
    tabs.set(tabId, tab);
    return tab;
  }

  function buildLeftPanel(tabId) {
    const panel = document.createElement('div');
    panel.className = 'dir-file-panel';

    const header = document.createElement('div');
    header.className = 'dir-file-header';

    const crumbs = document.createElement('div');
    crumbs.className = 'dir-breadcrumbs';

    const sortBar = document.createElement('div');
    sortBar.className = 'dir-sort-bar';

    for (const s of ['name', 'date', 'size']) {
      const btn = document.createElement('button');
      btn.className = 'dir-sort-btn' + (s === 'name' ? ' active' : '');
      btn.textContent = s.charAt(0).toUpperCase() + s.slice(1);
      btn.dataset.sort = s;
      btn.addEventListener('click', () => {
        const tab = tabs.get(tabId);
        if (!tab) return;
        if (tab.sortBy === s) {
          tab.sortDir = tab.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          tab.sortBy = s;
          tab.sortDir = 'asc';
        }
        sortBar.querySelectorAll('.dir-sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        btn.textContent = (s.charAt(0).toUpperCase() + s.slice(1)) + (tab.sortDir === 'desc' ? ' ↓' : ' ↑');
        loadDir(tabId, tab.cwd);
      });
      sortBar.appendChild(btn);
    }

    const previewToggle = document.createElement('label');
    previewToggle.className = 'dir-preview-toggle';
    previewToggle.innerHTML = '<input type="checkbox" class="dir-preview-checkbox"> Previews';
    previewToggle.querySelector('input').addEventListener('change', (e) => {
      const tab = tabs.get(tabId);
      if (!tab) return;
      tab.showPreviews = e.target.checked;
      if (tab.showPreviews && !tab.selectedFile) {
        renderPreviews(tab);
      } else if (!tab.showPreviews && !tab.selectedFile) {
        const content = tab.rightPanel.querySelector('.dir-viewer-content');
        const empty = tab.rightPanel.querySelector('.dir-viewer-empty');
        content.style.display = 'none';
        content.innerHTML = '';
        empty.style.display = '';
      }
    });
    sortBar.appendChild(previewToggle);

    const searchBtn = document.createElement('button');
    searchBtn.className = 'dir-sort-btn dir-search-btn';
    searchBtn.textContent = '🔍';
    searchBtn.title = 'Search files';
    searchBtn.addEventListener('click', () => {
      const tab = tabs.get(tabId);
      if (tab) openSearchModal(tab);
    });
    sortBar.appendChild(searchBtn);

    const cmdBtn = document.createElement('button');
    cmdBtn.className = 'dir-sort-btn dir-cmd-btn';
    cmdBtn.textContent = '>_';
    cmdBtn.title = 'Toggle terminal';
    cmdBtn.addEventListener('click', () => {
      const tab = tabs.get(tabId);
      if (tab) openTerminal(tab);
    });
    sortBar.appendChild(cmdBtn);

    header.appendChild(crumbs);
    header.appendChild(sortBar);

    const list = document.createElement('div');
    list.className = 'dir-file-list';

    panel.appendChild(header);
    panel.appendChild(list);
    return panel;
  }

  function buildRightPanel() {
    const panel = document.createElement('div');
    panel.className = 'dir-viewer-panel';

    const hdr = document.createElement('div');
    hdr.className = 'dir-viewer-header';
    hdr.style.display = 'none';

    const content = document.createElement('div');
    content.className = 'dir-viewer-content';
    content.style.display = 'none';

    const empty = document.createElement('div');
    empty.className = 'dir-viewer-empty';
    empty.textContent = 'Select a file to preview';

    panel.appendChild(hdr);
    panel.appendChild(content);
    panel.appendChild(empty);
    return panel;
  }

  function buildResizer(leftPanel) {
    const resizer = document.createElement('div');
    resizer.className = 'dir-resizer';

    let startX, startW;
    function onMove(e) {
      const dx = e.clientX - startX;
      const newW = Math.max(180, Math.min(startW + dx, window.innerWidth * 0.6));
      leftPanel.style.width = newW + 'px';
    }
    function onUp() {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    resizer.addEventListener('mousedown', e => {
      e.preventDefault();
      startX = e.clientX;
      startW = leftPanel.offsetWidth;
      resizer.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    return resizer;
  }

  function switchTab(tabId) {
    for (const [id, tab] of tabs) {
      tab.wrap.style.display = id === tabId ? '' : 'none';
    }
    activeTabId = tabId;
    placeholder.style.display = tabs.size > 0 ? 'none' : '';
    renderTabStrip();
  }

  function renderTabStrip() {
    tabStrip.querySelectorAll('.view-tab').forEach(el => el.remove());
    for (const [tabId, tab] of tabs) {
      const btn = document.createElement('button');
      btn.className = 'view-tab' + (tabId === activeTabId ? ' active' : '');
      btn.dataset.tabId = tabId;

      const label = document.createElement('span');
      label.textContent = computeTabLabel(tab);
      btn.appendChild(label);

      const close = document.createElement('span');
      close.className = 'view-tab-close';
      close.textContent = '×';
      close.addEventListener('click', e => {
        e.stopPropagation();
        removeTab(tabId);
      });
      btn.appendChild(close);

      btn.addEventListener('click', () => switchTab(tabId));
      tabStrip.insertBefore(btn, tabNewBtn);
    }
  }

  function computeTabLabel(tab) {
    if (!tab.cwd) return 'Browser';
    const parts = tab.cwd.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || '/';
  }

  function removeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    closeTerminal(tab);
    if (tab.editor) { tab.editor.dispose(); tab.editor = null; }
    tab.wrap.remove();
    tabs.delete(tabId);
    if (activeTabId === tabId) {
      const remaining = Array.from(tabs.keys());
      if (remaining.length > 0) {
        switchTab(remaining[remaining.length - 1]);
      } else {
        activeTabId = null;
        placeholder.style.display = '';
        renderTabStrip();
      }
    } else {
      renderTabStrip();
    }
  }

  // ── Directory loading ──────────────────────────────────────────────

  async function loadDir(tabId, dirPath) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.searchMode = false;

    const seq = ++tab.loadSeq;
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    listEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">Loading…</div>';

    try {
      const params = new URLSearchParams({ path: dirPath || '', sort: tab.sortBy, order: tab.sortDir });
      const resp = await fetch('/api/browse-files?' + params);
      const data = await resp.json();
      if (seq !== tab.loadSeq) return;

      if (data.error) {
        listEl.innerHTML = `<div style="padding:12px;color:#e55;font-size:12px">${escHtml(data.error)}</div>`;
        return;
      }

      tab.cwd = data.current;
      tab.entries = data.entries;
      renderBreadcrumbs(tab, data.current, data.parent);
      renderFileList(tab);
      renderTabStrip();
      resetPreviewPanel(tab);
    } catch {
      if (seq !== tab.loadSeq) return;
      listEl.innerHTML = '<div style="padding:12px;color:#e55;font-size:12px">Failed to load directory</div>';
    }
  }

  function renderBreadcrumbs(tab, absPath, parent) {
    const crumbsEl = tab.leftPanel.querySelector('.dir-breadcrumbs');
    crumbsEl.innerHTML = '';

    if (parent && parent !== absPath) {
      const upBtn = document.createElement('span');
      upBtn.className = 'dir-breadcrumb';
      upBtn.textContent = '↑ up';
      upBtn.title = parent;
      upBtn.addEventListener('click', () => loadDir(tab.id, parent));
      crumbsEl.appendChild(upBtn);

      const sep = document.createElement('span');
      sep.className = 'dir-breadcrumb-sep';
      sep.textContent = '|';
      crumbsEl.appendChild(sep);
    }

    crumbsEl._absPath = absPath;
    if (!crumbsEl._copyHandler) {
      crumbsEl._copyHandler = e => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && crumbsEl.contains(sel.anchorNode)) {
          e.preventDefault();
          e.clipboardData.setData('text/plain', crumbsEl._absPath);
        }
      };
      crumbsEl.addEventListener('copy', crumbsEl._copyHandler);
    }

    const parts = absPath.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'dir-breadcrumb-sep';
        sep.textContent = '/';
        crumbsEl.appendChild(sep);
      }
      const crumb = document.createElement('span');
      const isLast = i === parts.length - 1;
      crumb.className = 'dir-breadcrumb' + (isLast ? ' current' : '');
      crumb.textContent = parts[i];
      if (!isLast) {
        const target = '/' + parts.slice(0, i + 1).join('/');
        crumb.title = target;
        crumb.addEventListener('click', () => loadDir(tab.id, target));
      }
      crumbsEl.appendChild(crumb);
    }
  }

  function renderFileList(tab) {
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    listEl.innerHTML = '';

    if (tab.entries.length === 0) {
      listEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">Empty directory</div>';
      return;
    }

    for (const entry of tab.entries) {
      const fullPath = tab.cwd + '/' + entry.name;
      const row = document.createElement('div');
      row.className = 'dir-entry' + (entry.isDirectory ? ' dir-folder' : '');
      if (!entry.isDirectory && tab.selectedFile === fullPath) row.classList.add('selected');
      row.dataset.path = fullPath;
      row.dataset.isDir = entry.isDirectory ? '1' : '';

      const icon = document.createElement('span');
      icon.className = 'dir-entry-icon';
      icon.textContent = entry.isDirectory ? '📁' : getFileIcon(entry.name);

      const name = document.createElement('span');
      name.className = 'dir-entry-name';
      name.textContent = entry.name;

      const size = document.createElement('span');
      size.className = 'dir-entry-size';
      size.textContent = entry.isDirectory ? '' : formatSize(entry.size);

      const date = document.createElement('span');
      date.className = 'dir-entry-date';
      date.textContent = formatDate(entry.mtime);

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(date);

      if (entry.isDirectory) {
        row.addEventListener('click', () => loadDir(tab.id, fullPath));
      } else {
        row.addEventListener('click', () => {
          tab.leftPanel.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));
          row.classList.add('selected');
          openFile(tab, fullPath, entry);
        });
      }

      listEl.appendChild(row);
    }
  }

  // ── File preview overlay ────────────────────────────────────────────

  const ARROW_LEFT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const ARROW_RIGHT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

  let activeOverlay = null;

  function getFileList(tab) {
    return tab.entries.filter(e => !e.isDirectory);
  }

  function getFileIndex(tab, filePath) {
    const files = getFileList(tab);
    return files.findIndex(e => tab.cwd + '/' + e.name === filePath);
  }

  function openFile(tab, filePath, entry) {
    tab.selectedFile = filePath;
    showOverlay(tab, filePath, entry);
  }

  function closeOverlay() {
    if (!activeOverlay) return;
    if (activeOverlay.editor) { activeOverlay.editor.dispose(); activeOverlay.editor = null; }
    const tab = activeOverlay.tab;
    activeOverlay.el.remove();
    document.removeEventListener('keydown', activeOverlay.keyHandler);
    activeOverlay = null;
    if (tab) tab.selectedFile = null;
  }

  function showOverlay(tab, filePath, entry) {
    closeOverlay();

    const files = getFileList(tab);
    const currentIdx = files.findIndex(e => tab.cwd + '/' + e.name === filePath);
    const hasPrev = currentIdx > 0;
    const hasNext = currentIdx < files.length - 1;

    const overlay = document.createElement('div');
    overlay.className = 'dir-overlay';

    const downloadUrl = '/api/raw-file?path=' + encodeURIComponent(filePath);

    overlay.innerHTML = `
      <div class="dir-overlay-backdrop"></div>
      <button class="dir-overlay-nav prev${hasPrev ? '' : ' disabled'}" title="Previous file">${ARROW_LEFT_SVG}</button>
      <button class="dir-overlay-nav next${hasNext ? '' : ' disabled'}" title="Next file">${ARROW_RIGHT_SVG}</button>
      <div class="dir-overlay-panel">
        <div class="dir-overlay-header">
          <span class="dir-filename">${escHtml(entry.name)}</span>
          <span class="dir-viewer-size">${formatSize(entry.size)}</span>
          <a class="dir-download-btn" href="${downloadUrl}" download="${escHtml(entry.name)}" title="Download">⬇</a>
          <button class="dir-overlay-close" title="Close">✕</button>
        </div>
        <div class="dir-overlay-content"></div>
      </div>`;

    document.body.appendChild(overlay);

    const content = overlay.querySelector('.dir-overlay-content');

    overlay.querySelector('.dir-overlay-backdrop').addEventListener('click', closeOverlay);
    overlay.querySelector('.dir-overlay-close').addEventListener('click', closeOverlay);

    function navigate(dir) {
      const newIdx = currentIdx + dir;
      if (newIdx < 0 || newIdx >= files.length) return;
      const e = files[newIdx];
      const p = tab.cwd + '/' + e.name;
      tab.selectedFile = p;
      showOverlay(tab, p, e);
    }

    if (hasPrev) overlay.querySelector('.dir-overlay-nav.prev').addEventListener('click', () => navigate(-1));
    if (hasNext) overlay.querySelector('.dir-overlay-nav.next').addEventListener('click', () => navigate(1));

    function keyHandler(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
    }
    document.addEventListener('keydown', keyHandler);

    activeOverlay = { el: overlay, editor: null, keyHandler, tab };

    renderOverlayContent(tab, filePath, entry, content);
  }

  async function renderOverlayContent(tab, filePath, entry, content) {
    const ext = (filePath.match(/\.([^./]+)$/) || [])[1]?.toLowerCase() || '';
    const category = getFileCategory(ext);
    const url = '/api/raw-file?path=' + encodeURIComponent(filePath);

    switch (category) {
      case 'text': {
        content.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">Loading…</div>';
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error();
          const text = await resp.text();
          if (!activeOverlay || tab.selectedFile !== filePath) return;
          content.innerHTML = '';
          const editorDiv = document.createElement('div');
          editorDiv.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;right:0;bottom:0;';
          content.appendChild(editorDiv);

          await ensureMonaco();
          if (!activeOverlay || tab.selectedFile !== filePath) return;
          activeOverlay.editor = monaco.editor.create(editorDiv, {
            value: text,
            language: getMonacoLanguage(ext),
            theme: getMonacoTheme(),
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontSize: 12,
            fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
            wordWrap: 'on',
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          });
        } catch {
          if (!activeOverlay || tab.selectedFile !== filePath) return;
          content.innerHTML = '<div style="padding:12px;color:#e55;font-size:12px">Failed to load file</div>';
        }
        break;
      }
      case 'image': {
        const img = document.createElement('img');
        img.src = url;
        img.alt = entry.name;
        content.appendChild(img);
        break;
      }
      case 'audio': {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = url;
        content.appendChild(audio);
        break;
      }
      case 'video': {
        const video = document.createElement('video');
        video.controls = true;
        video.src = url;
        content.appendChild(video);
        break;
      }
      case 'pdf': {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        content.appendChild(iframe);
        break;
      }
      default: {
        content.innerHTML = `<div class="dir-viewer-empty" style="height:100%">Cannot preview .${escHtml(ext)} files</div>`;
      }
    }
  }

  // ── Preview grid ───────────────────────────────────────────────────

  const BINARY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="4" width="32" height="40" rx="3"/><text x="24" y="28" text-anchor="middle" font-size="8" stroke="none" fill="currentColor" font-family="monospace">01 10</text><text x="24" y="36" text-anchor="middle" font-size="8" stroke="none" fill="currentColor" font-family="monospace">11 00</text></svg>`;

  function resetPreviewPanel(tab) {
    closeOverlay();

    const hdr = tab.rightPanel.querySelector('.dir-viewer-header');
    const content = tab.rightPanel.querySelector('.dir-viewer-content');
    const empty = tab.rightPanel.querySelector('.dir-viewer-empty');

    hdr.style.display = 'none';
    content.style.display = 'none';
    content.innerHTML = '';
    empty.style.display = '';
    tab.selectedFile = null;
    tab.selectedPaths.clear();
    tab._lastSelectedIndex = -1;

    tab.leftPanel.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));

    const checkbox = tab.leftPanel.querySelector('.dir-preview-checkbox');
    if (checkbox) checkbox.checked = tab.showPreviews;

    if (tab.showPreviews) renderPreviews(tab);
  }

  function renderPreviews(tab) {
    const content = tab.rightPanel.querySelector('.dir-viewer-content');
    const empty = tab.rightPanel.querySelector('.dir-viewer-empty');
    content.style.display = '';
    content.innerHTML = '';
    empty.style.display = 'none';

    const files = tab.entries.filter(e => !e.isDirectory);
    if (files.length === 0) {
      content.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:12px">No files to preview</div>';
      return;
    }

    const sortBar = document.createElement('div');
    sortBar.className = 'dir-preview-sort-bar';
    const previewSortKey = tab.previewSortBy || tab.sortBy;
    const previewSortDir = tab.previewSortDir || tab.sortDir;
    for (const s of ['name', 'date', 'size']) {
      const btn = document.createElement('button');
      btn.className = 'dir-sort-btn' + (previewSortKey === s ? ' active' : '');
      btn.textContent = s.charAt(0).toUpperCase() + s.slice(1) + (previewSortKey === s ? (previewSortDir === 'desc' ? ' ↓' : ' ↑') : '');
      btn.addEventListener('click', () => {
        if (tab.previewSortBy === s) {
          tab.previewSortDir = tab.previewSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          tab.previewSortBy = s;
          tab.previewSortDir = 'asc';
        }
        renderPreviews(tab);
      });
      sortBar.appendChild(btn);
    }
    content.appendChild(sortBar);

    const sortedFiles = [...files].sort((a, b) => {
      const dir = previewSortDir === 'desc' ? -1 : 1;
      if (previewSortKey === 'name') return dir * a.name.localeCompare(b.name);
      if (previewSortKey === 'date') return dir * (new Date(a.mtime) - new Date(b.mtime));
      return dir * ((a.size || 0) - (b.size || 0));
    });

    const gridWrap = document.createElement('div');
    gridWrap.className = 'dir-preview-grid-wrap';

    const grid = document.createElement('div');
    grid.className = 'dir-preview-grid';

    for (let i = 0; i < sortedFiles.length; i++) {
      const entry = sortedFiles[i];
      const fullPath = tab.cwd + '/' + entry.name;
      const ext = (entry.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
      const category = getFileCategory(ext);

      const card = document.createElement('div');
      card.className = 'dir-preview-card' + (tab.selectedPaths.has(fullPath) ? ' selected' : '');
      card.dataset.index = i;
      card.dataset.path = fullPath;

      const thumb = document.createElement('div');
      thumb.className = 'dir-preview-thumb';

      if (category === 'image') {
        const img = document.createElement('img');
        img.src = '/api/raw-file?path=' + encodeURIComponent(fullPath);
        img.alt = entry.name;
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else if (category === 'text') {
        const pre = document.createElement('pre');
        pre.textContent = 'Loading...';
        thumb.appendChild(pre);
        fetch('/api/raw-file?path=' + encodeURIComponent(fullPath))
          .then(r => r.ok ? r.text() : Promise.reject())
          .then(text => { pre.textContent = text.slice(0, 600); })
          .catch(() => { pre.textContent = '(failed to load)'; });
      } else {
        thumb.innerHTML = BINARY_SVG;
      }

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dir-preview-cb';
      cb.checked = tab.selectedPaths.has(fullPath);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const idx = parseInt(card.dataset.index, 10);
        if (cb.checked) tab.selectedPaths.add(fullPath);
        else tab.selectedPaths.delete(fullPath);
        tab._lastSelectedIndex = idx;
        syncCardSelection(grid, tab);
        updateDeleteBar(tab, content, sortBar);
      });

      const label = document.createElement('div');
      label.className = 'dir-preview-label';
      label.textContent = entry.name;

      card.appendChild(cb);
      card.appendChild(thumb);
      card.appendChild(label);

      card.addEventListener('click', (e) => {
        if (tab.selectedPaths.size > 0) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
          return;
        }
        tab.leftPanel.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));
        const row = tab.leftPanel.querySelector(`.dir-entry[data-path="${CSS.escape(fullPath)}"]`);
        if (row) row.classList.add('selected');
        openFile(tab, fullPath, entry);
      });

      grid.appendChild(card);
    }

    gridWrap.appendChild(grid);
    content.appendChild(gridWrap);
    if (tab.selectedPaths.size > 0) {
      grid.classList.add('selecting');
    }
    updateDeleteBar(tab, content, sortBar);
  }

  function syncCardSelection(grid, tab) {
    const selecting = tab.selectedPaths.size > 0;
    grid.classList.toggle('selecting', selecting);
    grid.querySelectorAll('.dir-preview-card').forEach(c => {
      const sel = tab.selectedPaths.has(c.dataset.path);
      c.classList.toggle('selected', sel);
      const cb = c.querySelector('.dir-preview-cb');
      if (cb) cb.checked = sel;
    });
  }

  function updateDeleteBar(tab, content, sortBar) {
    let bar = sortBar ? sortBar.querySelector('.dir-preview-delete-bar') : content.querySelector('.dir-preview-delete-bar');
    if (tab.selectedPaths.size === 0) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'dir-preview-delete-bar';
      const clearBtn = document.createElement('button');
      clearBtn.className = 'dir-preview-clear-btn';
      clearBtn.textContent = 'Cancel';
      clearBtn.addEventListener('click', () => {
        tab.selectedPaths.clear();
        tab._lastSelectedIndex = -1;
        const grid = content.querySelector('.dir-preview-grid');
        if (grid) syncCardSelection(grid, tab);
        updateDeleteBar(tab, content, sortBar);
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'dir-preview-delete-btn';
      delBtn.addEventListener('click', () => deleteSelectedFiles(tab));
      bar.appendChild(clearBtn);
      bar.appendChild(delBtn);
      if (sortBar) sortBar.appendChild(bar);
      else content.appendChild(bar);
    }
    const btn = bar.querySelector('.dir-preview-delete-btn');
    const n = tab.selectedPaths.size;
    btn.textContent = `Delete ${n} file${n > 1 ? 's' : ''}`;
  }

  async function deleteSelectedFiles(tab) {
    const paths = [...tab.selectedPaths];
    if (paths.length === 0) return;
    const msg = paths.length === 1
      ? `Delete "${paths[0].split('/').pop()}"?`
      : `Delete ${paths.length} files?`;
    if (!confirm(msg)) return;
    try {
      const resp = await fetch('/api/delete-files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      const result = await resp.json();
      if (result.errors?.length) {
        console.warn('Some files could not be deleted:', result.errors);
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
    tab.selectedPaths.clear();
    tab._lastSelectedIndex = -1;
    loadDir(tab.id, tab.cwd);
  }

  // ── Terminal panel ─────────────────────────────────────────────────

  const shellTabs = new Map();
  const dirShellIds = new Set();
  let dirShellSeq = 0;

  function getCliTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'bright';
    return isDark
      ? { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#a0a0ff', selectionBackground: 'rgba(160,160,255,0.3)' }
      : { background: '#f8f8f8', foreground: '#1a1a1a', cursor: '#3355aa', selectionBackground: 'rgba(50,80,170,0.2)' };
  }

  function openTerminal(tab) {
    if (tab._shellOpen) return;
    tab._shellOpen = true;

    const wrap = tab.wrap;
    wrap.style.flexDirection = 'column';

    const browserContent = document.createElement('div');
    browserContent.className = 'dir-browser-content';
    while (wrap.firstChild) browserContent.appendChild(wrap.firstChild);
    wrap.appendChild(browserContent);
    tab._browserContent = browserContent;

    const hResizer = document.createElement('div');
    hResizer.className = 'dir-h-resizer';
    wrap.appendChild(hResizer);
    tab._hResizer = hResizer;

    const termPanel = document.createElement('div');
    termPanel.className = 'dir-terminal-panel';
    termPanel.style.height = '200px';
    wrap.appendChild(termPanel);
    tab._termPanel = termPanel;

    const termHeader = document.createElement('div');
    termHeader.className = 'dir-terminal-header';
    const termTitle = document.createElement('span');
    termTitle.className = 'dir-terminal-title';
    termTitle.textContent = 'Terminal';
    const termClose = document.createElement('button');
    termClose.className = 'dir-terminal-close';
    termClose.title = 'Close terminal';
    termClose.textContent = '×';
    termClose.addEventListener('click', () => closeTerminal(tab));
    termHeader.appendChild(termTitle);
    termHeader.appendChild(termClose);
    termPanel.appendChild(termHeader);

    let startY, startH;
    function onMove(e) {
      const dy = startY - e.clientY;
      const newH = Math.max(60, Math.min(startH + dy, wrap.offsetHeight - 120));
      termPanel.style.height = newH + 'px';
      if (tab._termFitAddon) try { tab._termFitAddon.fit(); } catch {}
    }
    function onUp() {
      hResizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    hResizer.addEventListener('mousedown', e => {
      e.preventDefault();
      startY = e.clientY;
      startH = termPanel.offsetHeight;
      hResizer.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      theme: getCliTheme(),
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    try { terminal.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
    const termBody = document.createElement('div');
    termBody.className = 'dir-terminal-body';
    termPanel.appendChild(termBody);

    terminal.open(termBody);
    tab._terminal = terminal;
    tab._termFitAddon = fitAddon;

    const ro = new ResizeObserver(() => {
      if (termBody.offsetWidth > 0) {
        try { fitAddon.fit(); } catch {}
      }
    });
    ro.observe(termBody);
    tab._termResizeObserver = ro;

    const shellId = 'dir-shell-' + (++dirShellSeq);
    tab._shellTabId = shellId;
    shellTabs.set(shellId, tab);
    dirShellIds.add(shellId);

    tab._terminal.onData(data => {
      sendWs({ type: 'cli:input', tabId: shellId, data });
    });
    tab._terminal.onResize(({ cols, rows }) => {
      sendWs({ type: 'cli:resize', tabId: shellId, cols, rows });
    });

    const { cols, rows } = { cols: tab._terminal.cols, rows: tab._terminal.rows };
    sendWs({ type: 'cli:spawn', tabId: shellId, cwd: tab.cwd || '/', cols, rows, shell: true });

    setTimeout(() => {
      try { tab._termFitAddon.fit(); } catch {}
      tab._terminal.focus();
    }, 100);
  }

  function closeTerminal(tab) {
    if (!tab._shellOpen) return;
    tab._shellOpen = false;

    if (tab._shellTabId) {
      sendWs({ type: 'cli:closeTab', tabId: tab._shellTabId });
      shellTabs.delete(tab._shellTabId);
      dirShellIds.delete(tab._shellTabId);
      tab._shellTabId = null;
    }

    if (tab._termResizeObserver) {
      tab._termResizeObserver.disconnect();
      tab._termResizeObserver = null;
    }
    if (tab._terminal) {
      tab._terminal.dispose();
      tab._terminal = null;
      tab._termFitAddon = null;
    }

    const wrap = tab.wrap;
    if (tab._termPanel) { tab._termPanel.remove(); tab._termPanel = null; }
    if (tab._hResizer) { tab._hResizer.remove(); tab._hResizer = null; }

    if (tab._browserContent) {
      while (tab._browserContent.firstChild) wrap.appendChild(tab._browserContent.firstChild);
      tab._browserContent.remove();
      tab._browserContent = null;
    }
    wrap.style.flexDirection = '';
  }

  function handleShellMessage(msg) {
    if (msg.type === 'cli:tabs' && dirShellIds.size > 0) {
      msg.tabs = (msg.tabs || []).filter(t => !dirShellIds.has(t.tabId));
      return false;
    }

    const tab = msg.tabId ? shellTabs.get(msg.tabId) : null;
    if (!tab) return false;

    switch (msg.type) {
      case 'cli:output':
        if (tab._terminal) tab._terminal.write(msg.data);
        return true;
      case 'cli:exit':
        closeTerminal(tab);
        return true;
    }
    return true;
  }

  // ── Search ─────────────────────────────────────────────────────────

  function openSearchModal(tab) {
    const backdrop = document.createElement('div');
    backdrop.className = 'cap-modal-backdrop';
    backdrop.innerHTML = `
      <div class="cap-modal dir-search-modal">
        <div class="cap-modal-header">
          <h3>Search Files</h3>
          <button class="cap-modal-close" title="Close">&times;</button>
        </div>
        <div class="cap-modal-body">
          <div class="dir-search-field">
            <label>Filename pattern <span style="opacity:.5">(regex)</span></label>
            <input type="text" id="dirSearchName" placeholder="e.g. \\.test\\.js$" spellcheck="false" autocomplete="off">
          </div>
          <div class="dir-search-field">
            <label>Content pattern <span style="opacity:.5">(regex, text files only)</span></label>
            <input type="text" id="dirSearchContent" placeholder="e.g. TODO|FIXME" spellcheck="false" autocomplete="off">
          </div>
          <div class="dir-search-field">
            <label>Last modified</label>
            <select id="dirSearchModified">
              <option value="">Any</option>
              <option value="5m">Last 5 minutes</option>
              <option value="15m">Last 15 minutes</option>
              <option value="1h">Last hour</option>
              <option value="today">Today</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </div>
        </div>
        <div class="cap-modal-footer">
          <button class="cap-cancel-btn dir-search-cancel">Cancel</button>
          <button class="cap-save-btn dir-search-submit">Search</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.querySelector('.cap-modal-close').addEventListener('click', close);
    backdrop.querySelector('.dir-search-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    const nameInput = backdrop.querySelector('#dirSearchName');
    const contentInput = backdrop.querySelector('#dirSearchContent');
    const modifiedSelect = backdrop.querySelector('#dirSearchModified');

    backdrop.querySelector('.dir-search-submit').addEventListener('click', () => {
      const fn = nameInput.value.trim();
      const ct = contentInput.value.trim();
      const mod = modifiedSelect.value;
      if (!fn && !ct && !mod) return;
      close();
      executeSearch(tab, fn, ct, mod);
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') backdrop.querySelector('.dir-search-submit').click();
    });
    contentInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') backdrop.querySelector('.dir-search-submit').click();
    });

    setTimeout(() => nameInput.focus(), 50);
  }

  async function executeSearch(tab, filenamePattern, contentPattern, modifiedWithin) {
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    listEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">Searching…</div>';
    tab.searchMode = true;

    try {
      const params = new URLSearchParams({ path: tab.cwd });
      if (filenamePattern) params.set('filenamePattern', filenamePattern);
      if (contentPattern) params.set('contentPattern', contentPattern);
      if (modifiedWithin) params.set('modifiedWithin', modifiedWithin);

      const resp = await fetch('/api/search-files?' + params);
      const data = await resp.json();

      if (data.error) {
        listEl.innerHTML = `<div style="padding:12px;color:#e55;font-size:12px">${escHtml(data.error)}</div>`;
        return;
      }
      renderSearchResults(tab, data.results);
    } catch {
      listEl.innerHTML = '<div style="padding:12px;color:#e55;font-size:12px">Search failed</div>';
    }
  }

  function renderSearchResults(tab, results) {
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    listEl.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'dir-search-results-header';
    const countSpan = document.createElement('span');
    countSpan.textContent = results.length + ' result' + (results.length !== 1 ? 's' : '');
    hdr.appendChild(countSpan);
    const clearBtn = document.createElement('button');
    clearBtn.className = 'dir-search-clear';
    clearBtn.textContent = '✕ Clear';
    clearBtn.addEventListener('click', () => loadDir(tab.id, tab.cwd));
    hdr.appendChild(clearBtn);
    listEl.appendChild(hdr);

    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px;color:var(--text-dim);font-size:12px';
      empty.textContent = 'No files found';
      listEl.appendChild(empty);
      return;
    }

    for (const file of results) {
      const row = document.createElement('div');
      row.className = 'dir-entry dir-search-result';
      if (tab.selectedFile === file.path) row.classList.add('selected');

      const icon = document.createElement('span');
      icon.className = 'dir-entry-icon';
      icon.textContent = getFileIcon(file.name);

      const name = document.createElement('span');
      name.className = 'dir-entry-name';
      const relPath = file.path.startsWith(tab.cwd + '/')
        ? file.path.slice(tab.cwd.length + 1)
        : file.name;
      name.textContent = relPath;
      name.title = file.path;

      const size = document.createElement('span');
      size.className = 'dir-entry-size';
      size.textContent = formatSize(file.size);

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(size);

      row.addEventListener('click', () => {
        listEl.querySelectorAll('.dir-entry.selected').forEach(el => el.classList.remove('selected'));
        row.classList.add('selected');
        const entry = { name: file.name, size: file.size, mtime: file.mtime, isDirectory: false };
        openFile(tab, file.path, entry);
      });

      listEl.appendChild(row);
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────

  const TEXT_EXTS = new Set([
    'txt','md','mdx','json','js','mjs','cjs','jsx','ts','tsx','css','scss','less',
    'html','htm','xml','csv','yaml','yml','toml','ini','sh','bash','zsh',
    'py','rb','go','rs','java','c','cpp','h','hpp','cs','php','swift','kt','scala',
    'sql','r','lua','pl','pm','ex','exs','erl','hs','ml','clj','dart','v','zig',
    'dockerfile','makefile','cmake','gitignore','gitattributes','editorconfig',
    'env','log','cfg','conf','properties','lock','vue','svelte','astro',
    'graphql','gql','proto','tf','hcl','nix','bat','ps1','fish',
  ]);
  const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','bmp','ico','avif']);
  const AUDIO_EXTS = new Set(['mp3','wav','ogg','flac','aac','m4a','wma']);
  const VIDEO_EXTS = new Set(['mp4','webm','ogv','mov','avi','mkv']);

  function getFileCategory(ext) {
    if (TEXT_EXTS.has(ext)) return 'text';
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
    return 'unknown';
  }

  function getMonacoLanguage(ext) {
    const map = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
      xml: 'xml', md: 'markdown', mdx: 'markdown',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
      java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
      php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
      sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
      yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
      dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql',
      r: 'r', lua: 'lua', pl: 'perl', dart: 'dart',
      bat: 'bat', ps1: 'powershell',
    };
    return map[ext] || 'plaintext';
  }

  function getFileIcon(name) {
    const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
    if (IMAGE_EXTS.has(ext)) return '🖼️';
    if (AUDIO_EXTS.has(ext)) return '🎵';
    if (VIDEO_EXTS.has(ext)) return '🎬';
    if (ext === 'pdf') return '📄';
    if (['zip','tar','gz','rar','7z','bz2','xz'].includes(ext)) return '📦';
    return '📋';
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' K';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' M';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' G';
  }

  function formatDate(mtimeMs) {
    if (!mtimeMs) return '';
    const d = new Date(mtimeMs);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' });
  }

  // ── Keyboard navigation ───────────────────────────────────────────

  function highlightRow(tab, idx) {
    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    const rows = listEl.querySelectorAll('.dir-entry');
    rows.forEach(r => r.classList.remove('selected'));
    if (idx >= 0 && idx < rows.length) {
      rows[idx].classList.add('selected');
      rows[idx].scrollIntoView({ block: 'nearest' });
      const path = rows[idx].dataset.path;
      const isDir = rows[idx].dataset.isDir === '1';
      if (!isDir) {
        const entry = tab.entries.find(e => tab.cwd + '/' + e.name === path);
        if (entry) openFile(tab, path, entry);
      }
    }
  }

  document.addEventListener('keydown', e => {
    if (activeOverlay) return;
    if (activeTabId === null) return;
    const dirView = document.getElementById('view-directories');
    if (!dirView || dirView.style.display === 'none') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const tab = tabs.get(activeTabId);
    if (!tab) return;

    const listEl = tab.leftPanel.querySelector('.dir-file-list');
    const rows = listEl.querySelectorAll('.dir-entry');
    if (rows.length === 0) return;

    const selectedIdx = Array.from(rows).findIndex(r => r.classList.contains('selected'));

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightRow(tab, selectedIdx < 0 ? 0 : Math.min(selectedIdx + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightRow(tab, selectedIdx <= 0 ? 0 : selectedIdx - 1);
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      rows[selectedIdx].click();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      const upBtn = tab.leftPanel.querySelector('.dir-breadcrumb');
      if (upBtn && upBtn.textContent.includes('↑')) upBtn.click();
    } else if (e.key === 'ArrowRight' && selectedIdx >= 0 && rows[selectedIdx].dataset.isDir === '1') {
      e.preventDefault();
      rows[selectedIdx].click();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const upBtn = tab.leftPanel.querySelector('.dir-breadcrumb');
      if (upBtn && upBtn.textContent.includes('↑')) upBtn.click();
    }
  });

  // ── "+" button ─────────────────────────────────────────────────────

  tabNewBtn?.addEventListener('click', () => {
    const tab = createTab(null);
    switchTab(tab.id);
    loadDir(tab.id, '');
  });

  // ── Theme sync ─────────────────────────────────────────────────────

  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      setTimeout(() => {
        if (!monacoReady) return;
        monaco.editor.setTheme(getMonacoTheme());
      }, 100);
    });
  }

  window.directoriesModule = { tabs, handleShellMessage };
})();
