(() => {
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
    const res = await fetch('/api/export/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
      d.innerHTML = `
        <div>
          <div class="title">${escapeHtml(e.options.companyName)} — ${escapeHtml(e.options.phoneNumber)}</div>
          <div class="meta">${e.id} · ${new Date(e.createdAt).toLocaleString('pt-BR')} · ${e.progress.chatsImported} chats / ${e.progress.messagesImported} msgs</div>
        </div>
        <span class="badge s-${e.status}">${e.status}</span>
        <button class="ghost" data-open="${e.id}">Abrir</button>`;
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
    $('d-title').textContent = `${s.options.companyName} — ${s.options.phoneNumber}`;
    const b = $('d-status'); b.textContent = s.status; b.className = `badge s-${s.status}`;
    $('d-elapsed').textContent = `${(s.progress.elapsedMs / 1000).toFixed(1)}s`;

    const qrBox = $('d-qr');
    if (s.qr) { qrBox.classList.remove('hidden'); $('d-qr-img').src = s.qr; }
    else qrBox.classList.add('hidden');

    $('p-found').textContent = s.progress.chatsFound;
    $('p-imp').textContent = s.progress.chatsImported;
    $('p-msg').textContent = s.progress.messagesImported;
    $('p-media').textContent = s.progress.mediaDownloaded;
    $('p-mediaf').textContent = s.progress.mediaFailed;
    $('p-err').textContent = s.progress.errors;

    const dl = $('d-download');
    if (s.zipFileName) { dl.classList.remove('disabled'); dl.href = `/api/export/${currentId}/download`; dl.setAttribute('download', s.zipFileName); }
    else dl.classList.add('disabled');

    $('d-logs').textContent = (s.logs || []).map(l => `[${l.ts.slice(11,19)}] ${l.level.toUpperCase()} ${l.message}`).join('\n');

    if (['finished', 'error', 'cancelled', 'disconnected'].includes(s.status)) stopPoll();
  }

  $('d-cancel').onclick = () => fetch(`/api/export/${currentId}/cancel`, { method: 'POST' });
  $('d-disconnect').onclick = async () => { await fetch(`/api/export/${currentId}/disconnect`, { method: 'POST' }); refresh(); };
  $('d-cleanup').onclick = async () => {
    if (!confirm('Apagar dados temporários e ZIP desta exportação?')) return;
    await fetch(`/api/export/${currentId}/cleanup`, { method: 'DELETE' });
    show('list');
  };

  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  show('new');
})();
