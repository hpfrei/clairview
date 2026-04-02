/**
 * Directory Picker Modal
 *
 * Opens a modal that browses the outputs/ directory tree.
 * Usage: const abs = await window.dashboard.openDirPicker({ initialPath: '' });
 * Returns the absolute path on Select, or null on Cancel.
 */
(function () {
  const modal     = document.getElementById('dirPickerModal');
  const closeBtn  = document.getElementById('dirPickerClose');
  const crumbsEl  = document.getElementById('dirPickerBreadcrumbs');
  const listEl    = document.getElementById('dirPickerList');
  const newRow    = document.getElementById('dirPickerNew');
  const newInput  = document.getElementById('dirPickerNewName');
  const newOkBtn  = document.getElementById('dirPickerNewOk');
  const newCancel = document.getElementById('dirPickerNewCancel');
  const newBtn    = document.getElementById('dirPickerNewBtn');
  const cancelBtn = document.getElementById('dirPickerCancelBtn');
  const selectBtn = document.getElementById('dirPickerSelectBtn');

  let currentPath = '';
  let currentAbsolute = '';
  let resolvePromise = null;

  // ── Open / Close ───────────────────────────────────────────────────

  function openDirPicker({ initialPath } = {}) {
    // Cancel any previous pending open
    if (resolvePromise) resolvePromise(null);

    currentPath = initialPath || '';
    modal.classList.remove('hidden');
    hideNewForm();
    loadDir(currentPath);

    return new Promise(resolve => { resolvePromise = resolve; });
  }

  function close(value) {
    modal.classList.add('hidden');
    hideNewForm();
    if (resolvePromise) {
      resolvePromise(value);
      resolvePromise = null;
    }
  }

  // ── Fetch & render ─────────────────────────────────────────────────

  async function loadDir(relPath) {
    listEl.innerHTML = '<div class="dir-picker-empty">Loading...</div>';
    try {
      const resp = await fetch('/api/dirs?path=' + encodeURIComponent(relPath));
      const data = await resp.json();
      currentPath = data.current || '';
      currentAbsolute = data.absolute || '';
      renderBreadcrumbs(currentPath);
      renderList(data.dirs || []);
    } catch {
      listEl.innerHTML = '<div class="dir-picker-empty">Failed to load directories.</div>';
    }
  }

  function renderBreadcrumbs(pathStr) {
    crumbsEl.innerHTML = '';
    const segments = pathStr ? pathStr.split('/').filter(Boolean) : [];

    // Root crumb
    const root = document.createElement('span');
    root.className = 'dir-picker-crumb' + (segments.length === 0 ? ' active' : '');
    root.textContent = 'outputs';
    if (segments.length > 0) root.addEventListener('click', () => loadDir(''));
    crumbsEl.appendChild(root);

    segments.forEach((seg, i) => {
      const sep = document.createElement('span');
      sep.className = 'dir-picker-sep';
      sep.textContent = ' / ';
      crumbsEl.appendChild(sep);

      const crumb = document.createElement('span');
      const isLast = i === segments.length - 1;
      crumb.className = 'dir-picker-crumb' + (isLast ? ' active' : '');
      crumb.textContent = seg;
      if (!isLast) {
        const target = segments.slice(0, i + 1).join('/');
        crumb.addEventListener('click', () => loadDir(target));
      }
      crumbsEl.appendChild(crumb);
    });
  }

  function renderList(dirs) {
    listEl.innerHTML = '';

    // Parent (..) entry
    if (currentPath) {
      const parentItem = document.createElement('div');
      parentItem.className = 'dir-picker-item parent';
      parentItem.innerHTML = '<span class="dir-picker-item-icon">\u2190</span><span class="dir-picker-item-name">..</span>';
      parentItem.addEventListener('click', () => {
        const parts = currentPath.split('/').filter(Boolean);
        parts.pop();
        loadDir(parts.join('/'));
      });
      listEl.appendChild(parentItem);
    }

    if (dirs.length === 0 && !currentPath) {
      const empty = document.createElement('div');
      empty.className = 'dir-picker-empty';
      empty.textContent = 'No directories yet. Click "+ New Folder" to create one.';
      listEl.appendChild(empty);
      return;
    }

    if (dirs.length === 0 && currentPath) {
      const empty = document.createElement('div');
      empty.className = 'dir-picker-empty';
      empty.textContent = 'Empty directory. Click "+ New Folder" to create a subdirectory.';
      listEl.appendChild(empty);
      return;
    }

    dirs.forEach(name => {
      const item = document.createElement('div');
      item.className = 'dir-picker-item';
      item.title = name;
      item.innerHTML =
        '<span class="dir-picker-item-icon">\uD83D\uDCC1</span>' +
        '<span class="dir-picker-item-name">' + escName(name) + '</span>';
      item.addEventListener('click', () => {
        const target = currentPath ? currentPath + '/' + name : name;
        loadDir(target);
      });
      listEl.appendChild(item);
    });
  }

  function escName(s) {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── New Folder ─────────────────────────────────────────────────────

  function showNewForm() {
    newRow.classList.remove('hidden');
    newInput.value = '';
    newInput.focus();
    clearNewError();
  }

  function hideNewForm() {
    newRow.classList.add('hidden');
    newInput.value = '';
    clearNewError();
  }

  function clearNewError() {
    const existing = newRow.parentElement.querySelector('.dir-picker-new-error');
    if (existing) existing.remove();
  }

  function showNewError(msg) {
    clearNewError();
    const el = document.createElement('div');
    el.className = 'dir-picker-new-error';
    el.textContent = msg;
    newRow.after(el);
  }

  async function createFolder() {
    const name = newInput.value.trim();
    if (!name) return;
    if (name.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/.test(name)) {
      showNewError('Invalid name. Use letters, numbers, spaces, dots, hyphens, underscores.');
      return;
    }
    newOkBtn.disabled = true;
    try {
      const resp = await fetch('/api/dirs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, name }),
      });
      const data = await resp.json();
      if (data.error) {
        showNewError(data.error);
        return;
      }
      hideNewForm();
      loadDir(data.created);
    } catch {
      showNewError('Failed to create folder.');
    } finally {
      newOkBtn.disabled = false;
    }
  }

  // ── Event listeners ────────────────────────────────────────────────

  closeBtn?.addEventListener('click', () => close(null));
  cancelBtn?.addEventListener('click', () => close(null));
  selectBtn?.addEventListener('click', () => close(currentAbsolute));


  newBtn?.addEventListener('click', showNewForm);
  newOkBtn?.addEventListener('click', createFolder);
  newCancel?.addEventListener('click', hideNewForm);

  newInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createFolder(); }
    else if (e.key === 'Escape') { e.stopPropagation(); hideNewForm(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      close(null);
    }
  });

  // ── Expose ─────────────────────────────────────────────────────────

  if (window.dashboard) {
    window.dashboard.openDirPicker = openDirPicker;
  }
})();
