(() => {
  // version
  fetch('/api/version')
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      const el = document.getElementById('version');
      if (!el) return;
      if (!j) {
        el.textContent = 'v?';
        return;
      }
      const version = j.version || j.exporterVersion || '?';
      const sha = j.gitSha ? String(j.gitSha).slice(0, 7) : '';
      el.textContent = sha ? `v${version} · ${sha}` : `v${version}`;
    })
    .catch(() => {
      const el = document.getElementById('version');
      if (el) el.textContent = 'v?';
    });

  const $ = (id) => document.getElementById(id);
  const views = { new: $('view-new'), list: $('view-list'), detail: $('view-detail') };
  const tabs = { new: $('tab-new'), list: $('tab-list') };
  let pollTimer = null, currentId = null;

  function show(v) {
    Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== v));
    tabs.new.classList.toggle('active', v === 'new');
    tabs.list.classList.toggle('active', v === 'list');
    if (v !== 'detail') { stopPoll(); currentId = null; }
    if (v === 'list') loadList();
  }
  tabs.new.onclick = () => show('new');
  tabs.list.onclick = () => show('list');
  $('logout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; };
  $('back').onclick = () => show('list');

  // ---- new export
  $('form-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const range = fd.get('range');
    let r;
    if (range === 'all') r = { kind: 'all' };
    else if (range === 'custom') r = { kind: 'custom', fromISO: fd.get('fromDate'), toISO: fd.get('toDate') };
    else r = { kind: 'last_days', days: parseInt(range, 10) };
    const body = {
      companyName: fd.get('companyName'),
      phoneNumber: fd.get('phoneNumber'),
      responsibleName: fd.get('responsibleName'),
      notes: fd.get('notes') || '',
      range: r,
      includeGroups: fd.get('includeGroups') === 'on',
      includeMedia: fd.get('includeMedia') === 'on',
      includeDocuments: fd.get('includeDocuments') === 'on',
      includeAudio: fd.get('includeAudio') === 'on',
      includeVideo: fd.get('includeVideo') === 'on',
    };
    const payload = new FormData();
    payload.append('options', JSON.stringify(body));
    const contacts = fd.get('contacts');
    if (contacts && contacts.size) payload.append('contacts', contacts);
    const res = await fetch('/api/export/start', { method: 'POST', body: payload });
    const j = await res.json();
    if (!res.ok) return alert(j.error || 'Erro');
    openDetail(j.id);
  });

  // ---- list
  async function loadList() {
    const r = await fetch('/api/export'); const j = await r.json();
    const wrap = $('list'); wrap.innerHTML = '';
    if (!j.exports?.length) { wrap.innerHTML = '<p class="muted">Nenhuma exportação ainda.</p>'; return; }
    for (const e of j.exports) {
      const d = document.createElement('div');
      d.className = 'item';
      const isFile = e.status === 'file_available';
      const title = isFile ? e.zipFileName : `${e.options.companyName} — ${e.options.phoneNumber}`;
      const meta = isFile
        ? `${new Date(e.createdAt).toLocaleString('pt-BR')} · ${formatBytes(e.size)}`
        : `${e.id} · ${new Date(e.createdAt).toLocaleString('pt-BR')} · ${e.progress.chatsImported} chats / ${e.progress.messagesImported} msgs`;
      const download = e.zipFileName
        ? `<a class="primary" href="/api/export/${encodeURIComponent(e.id)}/download" download="${escapeHtml(e.zipFileName)}">Baixar ZIP</a>`
        : '';
      d.innerHTML = `
        <div>
          <div class="title">${escapeHtml(title)}</div>
          <div class="meta">${meta}</div>
        </div>
        <span class="badge s-${e.status}">${isFile ? 'arquivo disponível' : escapeHtml(e.status)}</span>
        <div class="item-actions">
          <button class="ghost" data-open="${escapeHtml(e.id)}">${isFile ? 'Detalhes' : 'Abrir'}</button>
          ${download}
        </div>`;
      wrap.appendChild(d);
    }
    wrap.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openDetail(b.dataset.open));
  }

  // ---- detail
  function openDetail(id) {
    currentId = id; show('detail'); refresh(); startPoll();
  }
  function startPoll() { stopPoll(); pollTimer = setInterval(refresh, 1500); }
  function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  async function refresh() {
    if (!currentId) return;
    const r = await fetch(`/api/export/${currentId}/status`);
    if (!r.ok) return;
    const s = await r.json();
    const isFile = s.status === 'file_available';
    $('d-title').textContent = isFile ? s.zipFileName : `${s.options.companyName} — ${s.options.phoneNumber}`;
    const b = $('d-status'); b.textContent = isFile ? 'ARQUIVO DISPONÍVEL' : s.status; b.className = `badge s-${s.status}`;
    $('d-elapsed').textContent = isFile ? '' : `${(s.progress.elapsedMs / 1000).toFixed(1)}s`;

    $('d-file-info').classList.toggle('hidden', !isFile);
    $('d-progress').classList.toggle('hidden', isFile);
    if (isFile) {
      $('d-file-name').textContent = s.zipFileName;
      $('d-file-size').textContent = formatBytes(s.size);
      $('d-file-date').textContent = new Date(s.mtime || s.createdAt).toLocaleString('pt-BR');
      $('d-file-path').textContent = s.logicalPath || `/data/exports/${s.zipFileName}`;
    }

    const qrBox = $('d-qr');
    if (s.qr) { qrBox.classList.remove('hidden'); $('d-qr-img').src = s.qr; }
    else qrBox.classList.add('hidden');

    if (!isFile) {
      $('p-found').textContent = s.progress.chatsFound;
      $('p-imp').textContent = s.progress.chatsImported;
      $('p-msg').textContent = s.progress.messagesImported;
      $('p-media').textContent = s.progress.mediaDownloaded;
      $('p-mediaf').textContent = s.progress.mediaFailed;
      $('p-err').textContent = s.progress.errors;
    }

    const dl = $('d-download');
    dl.classList.toggle('hidden', !s.zipFileName);
    if (s.zipFileName) { dl.classList.remove('disabled'); dl.href = s.downloadUrl || `/api/export/${currentId}/download`; dl.setAttribute('download', s.zipFileName); }

    const activeStatuses = ['created', 'connecting', 'qr_ready', 'authenticated', 'listing_chats', 'importing_messages', 'downloading_media', 'building_index', 'building_viewer', 'zipping'];
    $('d-retry').classList.toggle('hidden', s.canRetry !== true);
    $('d-cancel').classList.toggle('hidden', !activeStatuses.includes(s.status));
    $('d-disconnect').classList.toggle('hidden', isFile || s.status === 'disconnected');
    $('d-cleanup').classList.toggle('hidden', isFile);

    const logs = s.logs || [];
    $('d-logs-section').classList.toggle('hidden', logs.length === 0);
    $('d-logs').textContent = logs.map(l => `[${l.ts.slice(11,19)}] ${l.level.toUpperCase()} ${l.message}`).join('\n');

    if (['finished', 'error', 'cancelled', 'disconnected'].includes(s.status) && s.canRetry !== true) stopPoll();
  }

  $('d-cancel').onclick = () => fetch(`/api/export/${currentId}/cancel`, { method: 'POST' });
  $('d-retry').onclick = async () => {
    const res = await fetch(`/api/export/${currentId}/retry`, { method: 'POST' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return alert(j.error || 'Erro ao tentar novamente');
    }
    refresh();
    startPoll();
  };
  $('d-disconnect').onclick = async () => { await fetch(`/api/export/${currentId}/disconnect`, { method: 'POST' }); refresh(); };
  $('d-cleanup').onclick = async () => {
    if (!confirm('Isso apagará arquivos temporários, sessão local e o ZIP desta exportação. Confirme apenas se você já baixou e validou o arquivo.')) return;
    await fetch(`/api/export/${currentId}/cleanup`, { method: 'DELETE' });
    show('list');
  };

  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let amount = bytes / 1024, unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  const media = $('form-new').elements.includeMedia;
  const mediaKinds = ['includeDocuments', 'includeAudio', 'includeVideo'].map((name) => $('form-new').elements[name]);
  function syncMediaOptions() {
    mediaKinds.forEach((input) => { input.disabled = !media.checked; if (!media.checked) input.checked = false; });
  }
  media.addEventListener('change', syncMediaOptions);
  syncMediaOptions();

  show('new');
})();
