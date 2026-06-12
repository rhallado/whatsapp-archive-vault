(() => {
  const M = window.MANIFEST || {};
  const CHATS = window.CHATS || [];
  const SEARCH = window.SEARCH_INDEX || [];
  const loaded = {}; // chatId -> messages

  // ---- header
  document.getElementById('hdr-company').textContent = M.company || '';
  document.getElementById('hdr-phone').textContent = M.phoneNumber ? `📱 ${M.phoneNumber}` : '';
  document.getElementById('hdr-date').textContent = M.exportedAt ? `🗓 ${new Date(M.exportedAt).toLocaleString('pt-BR')}` : '';
  if (M.totals) document.getElementById('hdr-totals').textContent = `${M.totals.chats} conversas · ${M.totals.messages} mensagens`;

  // ---- chat list
  const listEl = document.getElementById('chat-list');
  const resultsEl = document.getElementById('search-results');
  let currentFilter = 'all';
  let currentChat = null;

  function renderList() {
    listEl.innerHTML = '';
    const term = document.getElementById('search').value.trim().toLowerCase();
    const filtered = CHATS.filter((c) => {
      if (currentFilter === 'individual' && c.isGroup) return false;
      if (currentFilter === 'group' && !c.isGroup) return false;
      if (currentFilter === 'media' && !c.hasMedia) return false;
      if (term) {
        const hay = `${c.displayName || c.name} ${c.phone || c.waId || c.rawId}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    for (const c of filtered) {
      const li = document.createElement('li');
      if (currentChat === c.id) li.classList.add('active');
      li.innerHTML = `
        <div class="cname">
          <span>${escapeHtml(c.displayName || c.name)}</span>
          ${c.isGroup ? '<span class="tag">grupo</span>' : ''}
        </div>
        <div class="csub">${escapeHtml(c.phone || c.waId || c.rawId)} · ${c.totalMessages} msgs ${c.lastMessageAt ? '· ' + new Date(c.lastMessageAt).toLocaleDateString('pt-BR') : ''}</div>`;
      li.onclick = () => openChat(c.id);
      listEl.appendChild(li);
    }
  }

  // ---- search global
  document.getElementById('search').addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    if (term.length >= 2) doGlobalSearch(term); else { resultsEl.classList.add('hidden'); listEl.classList.remove('hidden'); renderList(); }
  });
  document.querySelectorAll('input[name="f"]').forEach((r) => r.addEventListener('change', (e) => { currentFilter = e.target.value; renderList(); }));

  function doGlobalSearch(term) {
    resultsEl.classList.remove('hidden'); listEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    const hits = SEARCH.filter((s) => s.text.toLowerCase().includes(term)).slice(0, 200);
    if (!hits.length) { resultsEl.innerHTML = '<p class="muted" style="padding:10px">Nenhum resultado.</p>'; return; }
    for (const h of hits) {
      const chat = CHATS.find((c) => c.id === h.chatId);
      const div = document.createElement('div');
      div.className = 'res';
      div.innerHTML = `
        <div><strong>${escapeHtml(chat?.displayName || chat?.name || h.chatId)}</strong> <span class="muted">· ${h.date} ${h.time}</span></div>
        <div class="muted" style="font-size:12px">${escapeHtml(h.senderName)}</div>
        <div>${highlight(h.text, term)}</div>`;
      div.onclick = () => openChat(h.chatId, h.messageId);
      resultsEl.appendChild(div);
    }
  }

  function highlight(text, term) {
    const i = text.toLowerCase().indexOf(term);
    if (i < 0) return escapeHtml(text);
    return escapeHtml(text.slice(0, i)) + '<span class="hi">' + escapeHtml(text.slice(i, i + term.length)) + '</span>' + escapeHtml(text.slice(i + term.length));
  }

  // ---- open chat (loads its messages_*.js via <script> injection — no fetch, file:// safe)
  function openChat(chatId, jumpMsgId) {
    currentChat = chatId;
    renderList();
    const chat = CHATS.find((c) => c.id === chatId);
    if (!chat) return;
    document.getElementById('conv-name').textContent = chat.displayName || chat.name;
    document.getElementById('conv-sub').textContent = `${chat.phone || chat.waId || chat.rawId || ''} · ${chat.totalMessages} mensagens ${chat.isGroup ? '· grupo' : ''}`;

    const body = document.getElementById('conv-body');
    body.innerHTML = '<p class="muted" style="padding:14px">Carregando…</p>';

    if (loaded[chatId]) return renderMessages(chat, loaded[chatId], jumpMsgId);

    const s = document.createElement('script');
    s.src = chat.messagesFile;
    s.onload = () => {
      const key = 'MESSAGES_' + chatId;
      const msgs = window[key] || [];
      loaded[chatId] = msgs;
      renderMessages(chat, msgs, jumpMsgId);
    };
    s.onerror = () => { body.innerHTML = '<p class="muted" style="padding:14px">Falha ao carregar mensagens.</p>'; };
    document.body.appendChild(s);
  }

  function renderMessages(chat, msgs, jumpMsgId) {
    const body = document.getElementById('conv-body');
    body.innerHTML = '';
    // paginação simples: últimas 500; botão "carregar mais"
    const PAGE = 500;
    let from = Math.max(0, msgs.length - PAGE);

    const renderRange = (start) => {
      const frag = document.createDocumentFragment();
      if (start > 0) {
        const btn = document.createElement('button');
        btn.textContent = `Carregar mais antigas (${start} restantes)`;
        btn.style.cssText = 'display:block;margin:10px auto;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:#13213a;color:var(--text);cursor:pointer';
        btn.onclick = () => { from = Math.max(0, start - PAGE); body.innerHTML=''; renderRange(from); };
        frag.appendChild(btn);
      }
      let lastDate = null;
      for (let i = start; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.date !== lastDate) {
          lastDate = m.date;
          const sep = document.createElement('div'); sep.className = 'date-sep'; sep.innerHTML = `<span>${m.date}</span>`;
          frag.appendChild(sep);
        }
        frag.appendChild(renderMsg(m, chat));
      }
      body.appendChild(frag);
      if (jumpMsgId) {
        const el = body.querySelector(`[data-id="${cssEscape(jumpMsgId)}"]`);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('highlight'); setTimeout(() => el.classList.remove('highlight'), 2500); }
        else body.scrollTop = body.scrollHeight;
      } else body.scrollTop = body.scrollHeight;
    };
    renderRange(from);
  }

  function renderMsg(m, chat) {
    const el = document.createElement('div');
    el.dataset.id = m.id;
    if (m.type === 'revoked' || m.type === 'e2e_notification' || m.type === 'notification_template') {
      el.className = 'msg system';
      el.textContent = m.type === 'revoked' ? '🗑 Mensagem apagada' : (m.body || '— evento do sistema —');
      return el;
    }
    el.className = 'msg' + (m.fromMe ? ' me' : '');
    if (chat.isGroup && !m.fromMe && m.senderName) {
      const s = document.createElement('div'); s.className = 'sender'; s.textContent = m.senderName; el.appendChild(s);
    }
    if (m.mediaPath) {
      const mime = (m.mimeType || '').split('/')[0];
      if (mime === 'image') { const i = document.createElement('img'); i.className='media'; i.src = m.mediaPath; i.loading='lazy'; el.appendChild(i); }
      else if (mime === 'video') { const v=document.createElement('video'); v.className='media'; v.controls=true; v.src=m.mediaPath; el.appendChild(v); }
      else if (mime === 'audio') { const a=document.createElement('audio'); a.className='media'; a.controls=true; a.src=m.mediaPath; el.appendChild(a); }
      else { const link=document.createElement('a'); link.className='doc'; link.href=m.mediaPath; link.target='_blank'; link.textContent = m.fileName || m.mediaPath.split('/').pop(); el.appendChild(link); }
    }
    if (m.body) {
      const b = document.createElement('div'); b.className = 'body'; b.textContent = m.body; el.appendChild(b);
    } else if (!m.mediaPath) {
      const b = document.createElement('div'); b.className = 'body muted'; b.textContent = '(sem conteúdo)'; el.appendChild(b);
    }
    const t = document.createElement('div'); t.className = 'time'; t.textContent = m.time; el.appendChild(t);
    return el;
  }

  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }

  renderList();
})();
