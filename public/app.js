
(() => {
  const $ = id => document.getElementById(id);

  // ============================================================
  // ЛОГГЕР
  // ============================================================
  const LOGS = [];
  const LOG_LIMIT = 500;
  const logQueue = [];
  let logTimer = null;
  let logSending = false;

  function a22Log(cat, msg, data) {
    const entry = { ts: Date.now(), source: 'web', cat: cat, msg: msg, data: data };
    try {
      LOGS.push(entry);
      if (LOGS.length > LOG_LIMIT) LOGS.shift();
    } catch (e) {}
    try {
      if (data !== undefined) console.log('[a22/' + cat + '] ' + msg, data);
      else console.log('[a22/' + cat + '] ' + msg);
    } catch (e) {}
    try {
      if (window.a22desktop && window.a22desktop.log && window.a22desktop.log.push) {
        window.a22desktop.log.push(entry);
      }
    } catch (e) {}
    try {
      logQueue.push(entry);
      if (logQueue.length >= 50) pushLogsToServer();
      else scheduleLogFlush();
    } catch (e) {}
  }

  async function pushLogsToServer() {
    if (logSending || !logQueue.length) return;
    logSending = true;
    const entries = logQueue.splice(0, 100);
    try {
      await fetch('api/logs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries })
      });
    } catch (e) {
      logQueue.unshift(...entries);
      if (logQueue.length > 500) logQueue.splice(500);
    } finally {
      logSending = false;
    }
  }

  function scheduleLogFlush() {
    if (logTimer) return;
    logTimer = setTimeout(() => { logTimer = null; pushLogsToServer(); }, 5000);
  }

  window.a22Log = a22Log;
  window.a22Logs = LOGS;
  window.a22LogDump = () => {
    const all = LOGS.slice();
    console.log('=== WEB LOGS (' + all.length + ') ===');
    all.forEach(e => {
      const line = new Date(e.ts).toISOString() + ' [' + e.cat + '] ' + e.msg + (e.data !== undefined ? ' ' + JSON.stringify(e.data) : '');
      console.log(line);
    });
    return all;
  };
  window.a22LogSave = async () => {
    if (!window.a22desktop || !window.a22desktop.log) {
      alert('Только в десктоп-версии'); return;
    }
    const mainLogs = await window.a22desktop.log.getAll();
    const combined = [...mainLogs, ...LOGS].sort((a, b) => a.ts - b.ts);
    const text = combined.map(e =>
      new Date(e.ts).toISOString() + ' [' + (e.source || '?') + '/' + (e.cat || e.level || '?') + '] ' + e.msg +
      (e.data !== undefined ? ' ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : '')
    ).join('\n');
    const path = await window.a22desktop.log.save(text);
    console.log('Logs saved:', path);
    alert('Логи сохранены:\n' + path);
  };

  window.addEventListener('error', (e) => {
    a22Log('error', 'JS error: ' + e.message, {
      file: e.filename, line: e.lineno, col: e.colno
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    a22Log('error', 'Unhandled rejection: ' + String(e.reason));
  });

  console.log('[app] logger initialized');



  const state = {
    user: null, chatId: null, chats: [],
    socket: null, onlineIds: [], userList: [],
    members: [], membersChat: null,
    chatMembersCache: {},
    unread: new Set(),
    unreadCounts: {},
    mentionPicker: { active: false, query: '', startPos: -1, users: [], selected: 0 },
    pendingAttachment: null,
    uploading: false,
    pendingRing: null,
    remote: {
      active: false, accepted: false, pending: false,
      userId: null, pendingFrom: null,
      pc: null, stream: null, remoteStream: null,
      dataChannel: null, _capturing: false, _stopCapture: null
    },
    control: {
      active: false, peerId: null,
      remoteActive: false, remoteFrom: null,
      remoteCursor: null, pendingRequest: null,
      lastMoveTs: 0, moveThrottle: 20
    },
    call: {
      active: false, chatId: null,
      localStream: null, cameraTrack: null, micTrack: null, screenStream: null,
      peers: new Map(), remoteStreams: new Map(),
      participants: new Map(),
      muted: false, videoOn: true, screenSharing: false,
      startedAt: 0, iceConfig: null, minimized: false, timer: null,
      relayForced: new Set(), fallbackTimers: new Map()
    }
  };

  async function api(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const t0 = performance.now();
    try {
      const r = await fetch(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...opts
      });
      const data = await r.json().catch(() => ({}));
      const dur = Math.round(performance.now() - t0);
      if (!r.ok) {
        // Логируем ошибку ОДИН раз и сразу пробрасываем
        if (typeof a22Log === 'function') {
          a22Log('api-error', method + ' ' + url, { status: r.status, dur: dur, err: data.error });
        }
        const err = new Error(data.error || ('HTTP ' + r.status));
        err.status = r.status;
        throw err;
      }
      if (dur > 800 && typeof a22Log === 'function') {
        a22Log('api-slow', method + ' ' + url, { dur: dur });
      }
      return data;
    } catch (e) {
      // Если ошибка уже имеет .status — это наша ошибка, не логируем повторно
      if (!e.status && typeof a22Log === 'function') {
        a22Log('api-error', method + ' ' + url, { err: e.message });
      }
      throw e;
    }
  }

  const PALETTE = ['#6264a7','#c4314b','#0b6a0b','#8e562e','#4a154b','#e36209','#005a9e','#a4262c','#7719aa','#008272'];

  function renderAvatar(el, user) {
    if (!el) return;
    const av = (user && user.avatar) || '';
    if (av) {
      el.style.backgroundImage = 'url(' + av + ')';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.textContent = '';
    } else {
      el.style.backgroundImage = '';
      const src = ((user && (user.full_name || user.username)) || '?').trim();
      const initials = src.split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase();
      el.textContent = initials || '?';
      el.style.background = PALETTE[((user && user.id) || 0) % PALETTE.length];
    }
  }
  function displayName(u) { return u ? (u.full_name || u.username || ('user#' + u.id)) : '—'; }
  function formatSize(b) {
    if (!b) return '';
    const u = ['Б','КБ','МБ','ГБ'];
    let i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }
  function fileEmoji(name, type) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if ((type || '').startsWith('image/')) return '🖼️';
    if ((type || '').startsWith('video/')) return '🎬';
    if ((type || '').startsWith('audio/')) return '🎵';
    if (ext === 'pdf') return '📕';
    if (['doc','docx'].includes(ext)) return '📘';
    if (['xls','xlsx','csv'].includes(ext)) return '📗';
    if (['zip','rar','7z','tar','gz'].includes(ext)) return '🗜️';
    if (['txt','md','log'].includes(ext)) return '📄';
    return '📎';
  }
  async function fileToDataURL(file, maxSize = 200) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ============================================================
  // AUTH
  // ============================================================
  function renderMe() {
    try {
      const av = $('me-avatar');
      if (av) renderAvatar(av, state.user);
      const fn = $('me-full-name');
      if (fn) fn.textContent = displayName(state.user);
      const un = $('me-username');
      if (un) un.textContent = '@' + state.user.username;
      const me = $('me');
      if (me) me.textContent = '@' + state.user.username;
    } catch (e) {
      a22Log('error', 'renderMe failed', e.message);
    }
  }

  function showMain() {
    a22Log('boot', 'showMain', { chats: state.chats.length, users: state.userList.length, isAdmin: !!state.user.is_admin });
    try {
      $('auth').classList.add('hidden');
      $('main').classList.remove('hidden');
      renderMe();
      if (state.user.is_admin) {
        const adminSec = $('admin-section');
        if (adminSec) adminSec.classList.remove('hidden');
      }
      try { loadUsers(); } catch (e) { a22Log('error', 'loadUsers threw in showMain', e.message); }
      try { connectSocket(); } catch (e) { a22Log('error', 'connectSocket failed', e.message); }
      try { refreshIce(); } catch (e) {}
      try { registerServiceWorker(); } catch (e) {}
      try { updateNotifButton(); } catch (e) {}
    } catch (e) {
      a22Log('error', 'showMain failed', e.message);
      console.error('showMain error:', e);
    }
  }

  async function refreshIce() {
    try {
      const { iceServers } = await api('api/ice');
      state.call.iceConfig = { iceServers };
    } catch {}
  }
  async function boot() {
    a22Log('boot', 'start');
    try {
      const meResp = await api('api/me');
      state.user = meResp.user;
      a22Log('boot', 'user loaded', { username: state.user.username });

      const chatsResp = await api('api/chats');
      state.chats = chatsResp.chats || [];

      try {
        const unreadResp = await api('api/unread');
        state.unreadCounts = unreadResp.counts || {};
      } catch (e) { /* не критично */ }

      renderChats();
      showMain();
      a22Log('boot', 'main shown');

      if (state.chats[0]) {
        selectChat(state.chats[0].id);
      }
      setTimeout(openChatFromUrl, 500);
    } catch (e) {
      // 401 — это НЕ ошибка, а «не залогинен». Показываем форму входа тихо.
      if (e.status === 401 || e.message === 'unauthorized') {
        a22Log('boot', 'not logged in');
        const authEl = document.getElementById('auth');
        const mainEl = document.getElementById('main');
        if (authEl) authEl.classList.remove('hidden');
        if (mainEl) mainEl.classList.add('hidden');
        return;
      }
      // Настоящая ошибка — логируем
      if (typeof a22Log === 'function') a22Log('error', 'boot failed: ' + e.message);
      console.error('boot error:', e);
    }
  }

  $('btn-login').onclick = async () => {
    a22Log('ui', 'login button clicked');
    try {
      $('auth-error').textContent = '';
      const { user } = await api('api/login', {
        method: 'POST',
        body: JSON.stringify({ username: $('username').value, password: $('password').value })
      });
      state.user = user;
      const { chats } = await api('api/chats');
      state.chats = chats;
      renderChats();
      showMain();
      if (chats[0]) selectChat(chats[0].id);
    } catch (e) { $('auth-error').textContent = e.message; }
  };
  $('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-login').click(); });
  $('btn-logout').onclick = async () => {
    a22Log('ui', 'logout clicked');
    if (state.call.active) await leaveCall();
    if (state.remote.active || state.remote.accepted) stopRemoteSession();
    await api('api/logout', { method: 'POST' });
    location.reload();
  };

  // ============================================================
  // ПРОФИЛЬ
  // ============================================================
  let pendingAvatar = null;
  $('btn-edit-profile').onclick = () => openProfileModal();
  $('me-card').onclick = (e) => { if (e.target.closest('.u-btn')) return; openProfileModal(); };
  function openProfileModal() {
    pendingAvatar = null;
    $('profile-full-name').value = state.user.full_name || '';
    $('profile-username').textContent = '@' + state.user.username;
    $('profile-error').textContent = '';
    renderAvatar($('profile-avatar-preview'), state.user);
    $('profile-avatar-file').value = '';
    $('profile-modal').classList.remove('hidden');
  }
  function closeProfileModal() { $('profile-modal').classList.add('hidden'); }
  $('profile-avatar-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      pendingAvatar = await fileToDataURL(f);
      renderAvatar($('profile-avatar-preview'), { id: state.user.id, avatar: pendingAvatar, full_name: $('profile-full-name').value });
    } catch { $('profile-error').textContent = 'не удалось прочитать файл'; }
  };
  $('btn-avatar-clear').onclick = () => {
    pendingAvatar = '';
    renderAvatar($('profile-avatar-preview'), { id: state.user.id, avatar: '', full_name: $('profile-full-name').value });
  };
  $('btn-profile-cancel').onclick = closeProfileModal;
  $('profile-modal').addEventListener('click', e => { if (e.target === $('profile-modal')) closeProfileModal(); });
  $('btn-profile-save').onclick = async () => {
    try {
      $('profile-error').textContent = '';
      const body = { full_name: $('profile-full-name').value.trim() };
      if (pendingAvatar !== null) body.avatar = pendingAvatar;
      const { user } = await api('api/me', { method: 'PATCH', body: JSON.stringify(body) });
      state.user = user;
      renderMe();
      closeProfileModal();
      if (state.chatId) selectChat(state.chatId, true);
    } catch (e) { $('profile-error').textContent = e.message; }
  };

  // ============================================================
  // ЧАТЫ
  // ============================================================
  function renderChats() {
    const ul = $('chats');
    if (!ul) return;
    ul.innerHTML = '';

    state.chats.filter(c => c.type !== 'dm').forEach(c => {
      const li = document.createElement('li');
      li.className = 'chat-li';
      li.dataset.chatId = c.id;

      // Определяем, непрочитанное входящее
      const hasUnread = c.id !== state.chatId && c.unread_count > 0;
      const lastIsMine = c.last_message_user_id === state.user.id;
      const showUnread = hasUnread && !lastIsMine;

      if (showUnread) li.classList.add('unread');

      // Синяя точка слева
      if (showUnread) {
        const dot = document.createElement('span');
        dot.className = 'unread-dot';
        li.appendChild(dot);
      }

      // Аватар
      const av = document.createElement('span');
      av.className = 'avatar avatar-md';
      av.textContent = (c.name || '?').trim().slice(0, 1).toUpperCase();
      av.style.background = '#7b83eb';
      li.appendChild(av);

      // Тело
      const body = document.createElement('div');
      body.className = 'chat-li-body';

      const nameRow = document.createElement('div');
      nameRow.style.cssText = 'display:flex;align-items:center;gap:6px';
      const nm = document.createElement('span');
      nm.className = 'chat-li-name';
      nm.textContent = c.name;
      nameRow.appendChild(nm);
      body.appendChild(nameRow);

      const preview = document.createElement('div');
      preview.className = 'chat-li-preview';
      preview.textContent = c.last_message_preview || ('Участников: ' + (c.members_count || 1));
      body.appendChild(preview);

      li.appendChild(body);

      // Мета
      const meta = document.createElement('div');
      meta.className = 'chat-li-meta';

      if (c.call_active) {
        const ci = document.createElement('span');
        ci.className = 'chat-call-icon';
        ci.textContent = '📞';
        meta.appendChild(ci);
      }

      if (c.last_message_at) {
        const t = document.createElement('span');
        t.className = 'chat-li-time';
        t.textContent = formatChatTime(c.last_message_at);
        meta.appendChild(t);
      }

      li.appendChild(meta);
      if (c.id === state.chatId) li.classList.add('active');
      li.onclick = () => selectChat(c.id);
      ul.appendChild(li);
    });

    renderColleagues();
  }


  function formatChatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Вчера';
    const diff = (now - d) / 86400000;
    if (diff < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }


  async function selectChat(id, force) {
    a22Log('chat', 'select called', { id, force, current: state.chatId });
    try {
    if (state.chatId === id && !force) return;
    if (state.chatId && state.socket) state.socket.emit('leave', state.chatId);
    state.chatId = id;
    state.unread.delete(id);
    if (state.unreadCounts[id]) {
      state.unreadCounts[id] = 0;
      delete state.unreadCounts[id];
    }
    // Обнуляем unread_count у чата
    const theChat = state.chats.find(c => c.id === id);
    if (theChat) theChat.unread_count = 0;
    try { api('api/chats/' + id + '/read', { method: 'POST' }); } catch (e) {}
    renderChats();
    const ch = state.chats.find(c => c.id === id);
    $('chat-title').textContent = ch ? ch.name : 'Чат';
    const peerAv = $('chat-peer-avatar');
    if (ch && ch.type === 'dm' && ch.peer) {
      peerAv.classList.remove('hidden');
      renderAvatar(peerAv, ch.peer);
    } else {
      peerAv.classList.add('hidden');
    }
    $('btn-chat-members').classList.toggle('hidden', !!(ch && ch.type === 'dm'));
    $('btn-delete-chat').classList.toggle('hidden',
      !ch || (ch.type === 'dm' ? false : (ch.created_by !== state.user.id && !state.user.is_admin)));
    updateCallButtons();
    const { messages } = await api('api/chats/' + id + '/messages');
    const box = $('messages');
    box.innerHTML = '';
    messages.forEach(addMessage);
    box.scrollTop = box.scrollHeight;
    if (state.socket) state.socket.emit('join', id);
    delete state.chatMembersCache[id];
    if (window.__closeSidebarIfMobile) window.__closeSidebarIfMobile();
      } catch (e) {
      a22Log('error', 'selectChat failed', e.message);
      console.error('selectChat', e);
    }
  }

  async function openDMWith(userId) {
    a22Log('ui', 'open DM', { userId });
    try {
      const { chat } = await api('api/dm/' + userId, { method: 'POST' });
      const existing = state.chats.find(c => c.id === chat.id);
      if (existing) Object.assign(existing, chat);
      else state.chats.push(chat);
      renderChats();
      selectChat(chat.id);
    } catch (e) { alert(e.message); }
  }
  async function startDmCall(userId) {
    a22Log('ui', 'start DM call', { userId });
    try {
      const { chat } = await api('api/dm/' + userId, { method: 'POST' });
      const existing = state.chats.find(c => c.id === chat.id);
      if (existing) Object.assign(existing, chat);
      else state.chats.push(chat);
      renderChats();
      await selectChat(chat.id);
      await startCall();
    } catch (e) { alert(e.message); }
  }

  $('btn-new-chat').onclick = () => {
    a22Log('ui', 'new chat clicked');
    $('new-chat-name').value = '';
    $('create-chat-error').textContent = '';
    renderUserPicker($('new-chat-users'), state.userList, new Set(), () => {});
    $('create-chat-modal').classList.remove('hidden');
  };
  $('btn-create-chat-cancel').onclick = () => $('create-chat-modal').classList.add('hidden');
  $('create-chat-modal').addEventListener('click', e => { if (e.target === $('create-chat-modal')) $('create-chat-modal').classList.add('hidden'); });
  $('btn-create-chat-submit').onclick = async () => {
    try {
      $('create-chat-error').textContent = '';
      const name = $('new-chat-name').value.trim();
      const memberIds = [...$('new-chat-users').querySelectorAll('input:checked')].map(i => Number(i.value));
      const { chat } = await api('api/chats', { method: 'POST', body: JSON.stringify({ name, memberIds }) });
      if (!state.chats.find(c => c.id === chat.id)) state.chats.push(chat);
      renderChats();
      $('create-chat-modal').classList.add('hidden');
      selectChat(chat.id);
    } catch (e) { $('create-chat-error').textContent = e.message; }
  };

  $('btn-chat-members').onclick = () => { if (state.chatId) openMembersModal(); };
  $('btn-delete-chat').onclick = async () => {
    const ch = state.chats.find(c => c.id === state.chatId);
    if (!ch) return;
    if (ch.type === 'dm') {
      if (!confirm('Скрыть личный чат?')) return;
    } else {
      if (!confirm('Удалить чат «' + ch.name + '»?')) return;
    }
    try { await api('api/chats/' + ch.id, { method: 'DELETE' }); }
    catch (e) { alert(e.message); }
  };

  // ============================================================
  // УЧАСТНИКИ
  // ============================================================
  async function openMembersModal() {
    try {
      $('members-error').textContent = '';
      const { members, chat } = await api('api/chats/' + state.chatId + '/members');
      state.members = members;
      state.membersChat = chat;
      state.chatMembersCache[state.chatId] = members;
      renderMembers();
      renderAddMemberPicker();
      $('members-modal').classList.remove('hidden');
    } catch (e) { alert(e.message); }
  }
  $('btn-members-close').onclick = () => $('members-modal').classList.add('hidden');
  $('members-modal').addEventListener('click', e => { if (e.target === $('members-modal')) $('members-modal').classList.add('hidden'); });

  function renderMembers() {
    const ul = $('members-list');
    ul.innerHTML = '';
    const isCreator = state.membersChat && state.membersChat.created_by === state.user.id;
    state.members.forEach(m => {
      const li = document.createElement('li');
      const av = document.createElement('span');
      const isOnline = state.onlineIds.includes(m.id);
      av.className = 'avatar avatar-sm' + (isOnline ? ' online' : '');
      renderAvatar(av, m);
      li.appendChild(av);
      const info = document.createElement('div');
      info.className = 'member-info';
      const name = document.createElement('div');
      name.className = 'member-name';
      name.textContent = displayName(m) + (m.id === state.membersChat.created_by ? '  👑' : '');
      const uname = document.createElement('div');
      uname.className = 'member-username';
      uname.textContent = '@' + m.username;
      info.appendChild(name); info.appendChild(uname);
      li.appendChild(info);
      const actions = document.createElement('span');
      actions.className = 'u-actions';
      if (m.id !== state.user.id) {
        const dmBtn = document.createElement('button');
        dmBtn.className = 'u-btn'; dmBtn.title = 'Написать'; dmBtn.textContent = '💬';
        dmBtn.onclick = () => { $('members-modal').classList.add('hidden'); openDMWith(m.id); };
        actions.appendChild(dmBtn);
        const callBtn = document.createElement('button');
        callBtn.className = 'u-btn'; callBtn.title = 'Позвонить'; callBtn.textContent = '📞';
        callBtn.onclick = () => { $('members-modal').classList.add('hidden'); startDmCall(m.id); };
        actions.appendChild(callBtn);
      }
      const canRemove = (m.id !== state.membersChat.created_by) &&
                        (isCreator || m.id === state.user.id || state.user.is_admin);
      if (canRemove) {
        const btn = document.createElement('button');
        btn.className = 'u-btn del'; btn.title = 'Убрать'; btn.textContent = '✕';
        btn.onclick = async () => {
          if (!confirm('Убрать @' + m.username + '?')) return;
          try {
            await api('api/chats/' + state.chatId + '/members/' + m.id, { method: 'DELETE' });
            openMembersModal();
          } catch (e) { $('members-error').textContent = e.message; }
        };
        actions.appendChild(btn);
      }
      li.appendChild(actions);
      ul.appendChild(li);
    });
  }
  function renderAddMemberPicker() {
    const inChat = new Set(state.members.map(m => m.id));
    const candidates = state.userList.filter(u => !inChat.has(u.id));
    renderUserPicker($('add-member-users'), candidates, new Set(), async (userId) => {
      try {
        await api('api/chats/' + state.chatId + '/members', { method: 'POST', body: JSON.stringify({ userId }) });
        openMembersModal();
      } catch (e) { $('members-error').textContent = e.message; }
    }, true);
  }
  function renderUserPicker(root, users, selectedSet, onChange, immediate) {
    root.innerHTML = '';
    if (!users.length) { root.innerHTML = '<div class="muted">Нет доступных пользователей</div>'; return; }
    users.forEach(u => {
      const row = document.createElement('label');
      row.className = 'user-picker-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = u.id; cb.checked = selectedSet.has(u.id);
      const av = document.createElement('span');
      const isOnline = state.onlineIds.includes(u.id);
      av.className = 'avatar avatar-sm' + (isOnline ? ' online' : '');
      renderAvatar(av, u);
      const name = document.createElement('span');
      name.textContent = displayName(u) + '  @' + u.username;
      row.appendChild(cb); row.appendChild(av); row.appendChild(name);
      if (immediate) cb.onchange = () => onChange(Number(u.id));
      else cb.onchange = () => onChange();
      root.appendChild(row);
    });
  }

  // ============================================================
  // УПОМИНАНИЯ
  // ============================================================
  const MENTION_RE = /@([a-zA-Z0-9_.\-]{3,32})/g;
  function findUserByUsername(uname) {
    return (state.chatMembersCache[state.chatId] || []).find(x => x.username === uname)
      || state.userList.find(x => x.username === uname) || null;
  }
  function renderMessageBody(text) {
    const frag = document.createDocumentFragment();
    let last = 0, m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const user = findUserByUsername(m[1]);
      const span = document.createElement('span');
      span.className = 'mention';
      if (user) {
        span.textContent = '@' + displayName(user);
        span.title = '@' + m[1];
        if (user.id === state.user.id) span.classList.add('mention-me');
      } else span.textContent = '@' + m[1];
      frag.appendChild(span);
      last = MENTION_RE.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  // ============================================================
  // ВЛОЖЕНИЯ
  // ============================================================
  function renderAttachment(att) {
    if (!att || !att.url) return null;
    const wrap = document.createElement('div');
    wrap.className = 'attachment';
    const isImage = (att.type || '').startsWith('image/');
    if (isImage) {
      const img = document.createElement('img');
      img.className = 'attachment-img';
      img.src = att.url;
      img.alt = att.name || 'image';
      img.loading = 'lazy';
      img.onclick = () => openLightbox(att.url);
      wrap.appendChild(img);
    } else {
      const card = document.createElement('a');
      card.className = 'attachment-file';
      card.href = att.url;
      card.download = att.name || '';
      card.target = '_blank';
      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.textContent = fileEmoji(att.name || '', att.type || '');
      const info = document.createElement('div');
      info.className = 'file-info';
      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = att.name || 'file';
      const size = document.createElement('div');
      size.className = 'file-size';
      size.textContent = formatSize(att.size);
      info.appendChild(name); info.appendChild(size);
      card.appendChild(icon); card.appendChild(info);
      wrap.appendChild(card);
    }
    return wrap;
  }
  function openLightbox(url) {
    $('lightbox-img').src = url;
    $('lightbox').classList.remove('hidden');
  }
  $('lightbox').onclick = () => $('lightbox').classList.add('hidden');

  // ============================================================
  // СООБЩЕНИЯ
  // ============================================================
  function addMessage(m) {
    const isMine = m.user_id === state.user.id;

    const el = document.createElement('div');
    el.className = 'msg' + (isMine ? ' self' : '');
    el.dataset.messageId = m.id;
    el.dataset.userId = m.user_id;
    el.dataset.createdAt = m.created_at;

    const av = document.createElement('div');
    av.className = 'avatar avatar-sm msg-avatar';
    renderAvatar(av, { id: m.user_id, avatar: m.avatar, full_name: m.full_name, username: m.username });
    el.appendChild(av);

    const content = document.createElement('div');
    content.className = 'msg-content';

    const head = document.createElement('div');
    head.className = 'msg-head';
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = m.full_name || m.username;
    const uname = document.createElement('span');
    uname.className = 'msg-username';
    uname.textContent = '@' + m.username;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(m.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    head.appendChild(author);
    head.appendChild(uname);

    // Галочка только для своих сообщений
    if (isMine) {
      const check = document.createElement('span');
      check.className = 'msg-check' + (m.read ? ' read' : '');
      check.textContent = m.read ? '✓✓' : '✓';
      check.title = m.read ? 'Прочитано' : 'Отправлено';
      check.dataset.checkFor = m.id;
      head.appendChild(check);
    }

    head.appendChild(time);
    content.appendChild(head);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (m.attachment_url || m.attachment_name) {
      const att = renderAttachment({
        url: m.attachment_url, name: m.attachment_name,
        type: m.attachment_type, size: m.attachment_size
      });
      if (att) bubble.appendChild(att);
    }
    if (m.body) {
      const text = document.createElement('div');
      text.className = 'body';
      text.appendChild(renderMessageBody(m.body));
      bubble.appendChild(text);
    }
    content.appendChild(bubble);
    el.appendChild(content);

    const box = $('messages');
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }



  // ============================================================
  // ПОЛЬЗОВАТЕЛИ (админ + контакты)
  // ============================================================
  async function loadUsers() {
    try {
      a22Log('users', 'loading...');
      const resp = await api('api/users');
      state.userList = resp.users || [];
      a22Log('users', 'loaded', { count: state.userList.length });
      if (state.user.is_admin) {
        try { renderAdminUsers(); } catch (e) { a22Log('error', 'renderAdminUsers failed', e.message); }
      }
      try { renderColleagues(); } catch (e) { a22Log('error', 'renderColleagues failed', e.message); }
    } catch (e) {
      a22Log('error', 'loadUsers failed', e.message);
      console.warn('loadUsers error:', e);
    }
  }


  function renderAdminUsers() {
    const ul = $('users');
    ul.innerHTML = '';
    state.userList.forEach(u => {
      const li = document.createElement('li');
      const av = document.createElement('span');
      const isOnline = state.onlineIds.includes(u.id);
      av.className = 'avatar avatar-xs' + (isOnline ? ' online' : '');
      renderAvatar(av, u);
      li.appendChild(av);
      const left = document.createElement('span');
      left.className = 'uname';
      left.textContent = displayName(u);
      if (u.is_admin) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'admin';
        left.appendChild(document.createTextNode(' '));
        left.appendChild(b);
      }
      li.appendChild(left);
      const actions = document.createElement('span');
      actions.className = 'u-actions';
      const ren = document.createElement('button');
      ren.className = 'u-btn'; ren.title = 'Редактировать'; ren.textContent = '✎';
      ren.onclick = () => openEditUserModal(u);
      actions.appendChild(ren);
      const pw = document.createElement('button');
      pw.className = 'u-btn'; pw.title = 'Сменить пароль'; pw.textContent = '🔑';
      pw.onclick = () => openPasswordModal(u);
      actions.appendChild(pw);
      if (u.id !== state.user.id) {
        const del = document.createElement('button');
        del.className = 'u-btn del'; del.title = 'Удалить'; del.textContent = '✕';
        del.onclick = async () => {
          if (!confirm('Удалить @' + u.username + '?')) return;
          try { await api('api/users/' + u.id, { method: 'DELETE' }); loadUsers(); }
          catch (e) { alert(e.message); }
        };
        actions.appendChild(del);
      }
      li.appendChild(actions);
      ul.appendChild(li);
    });
  }

  function renderColleagues() {
    try {
      a22Log('users', 'renderColleagues start', { users: state.userList.length, online: state.onlineIds.length });
      const ul = $('colleagues');
      if (!ul) return;
      ul.innerHTML = '';

      state.userList
        .filter(u => u.id !== state.user.id)
        .forEach(u => {
          const li = document.createElement('li');
          li.className = 'colleague-li';

          const dm = state.chats.find(c => c.type === 'dm' && c.peer && c.peer.id === u.id);
          if (dm && state.chatId === dm.id) li.classList.add('active');

          // Определяем, непрочитанное входящее
          const hasUnread = dm && dm.id !== state.chatId && dm.unread_count > 0;
          const lastIsMine = dm && dm.last_message_user_id === state.user.id;
          const showUnread = hasUnread && !lastIsMine;

          if (showUnread) li.classList.add('unread');

          // Синяя точка слева
          if (showUnread) {
            const dot = document.createElement('span');
            dot.className = 'unread-dot';
            li.appendChild(dot);
          }

          // Аватар
          const av = document.createElement('span');
          const isOnline = state.onlineIds.includes(u.id);
          av.className = 'avatar avatar-md' + (isOnline ? ' online' : '');
          renderAvatar(av, u);
          li.appendChild(av);

          // Тело
          const body = document.createElement('div');
          body.className = 'chat-li-body';

          const name = document.createElement('div');
          name.className = 'chat-li-name';
          name.textContent = displayName(u);
          body.appendChild(name);

          const preview = document.createElement('div');
          preview.className = 'chat-li-preview';
          if (dm && dm.last_message_preview) {
            preview.textContent = dm.last_message_preview;
          } else {
            preview.textContent = '@' + u.username;
          }
          body.appendChild(preview);
          li.appendChild(body);

          // Мета
          const meta = document.createElement('div');
          meta.className = 'chat-li-meta';

          if (dm && dm.call_active) {
            const ci = document.createElement('span');
            ci.className = 'chat-call-icon';
            ci.textContent = '📞';
            meta.appendChild(ci);
          }
          if (dm && dm.last_message_at) {
            const t = document.createElement('span');
            t.className = 'chat-li-time';
            t.textContent = formatChatTime(dm.last_message_at);
            meta.appendChild(t);
          }
          li.appendChild(meta);

          // Кнопки действий
          const actions = document.createElement('span');
          actions.className = 'u-actions';
          const dmBtn = document.createElement('button');
          dmBtn.className = 'u-btn'; dmBtn.title = 'Написать'; dmBtn.textContent = '💬';
          dmBtn.onclick = (e) => { e.stopPropagation(); openDMWith(u.id); };
          actions.appendChild(dmBtn);
          const callBtn = document.createElement('button');
          callBtn.className = 'u-btn'; callBtn.title = 'Позвонить'; callBtn.textContent = '📞';
          callBtn.onclick = (e) => { e.stopPropagation(); startDmCall(u.id); };
          actions.appendChild(callBtn);
          const remoteBtn = document.createElement('button');
          remoteBtn.className = 'u-btn'; remoteBtn.title = 'Удалённый рабочий стол'; remoteBtn.textContent = '🖥️';
          remoteBtn.onclick = (e) => { e.stopPropagation(); startRemoteSession(u.id); };
          actions.appendChild(remoteBtn);
          li.appendChild(actions);

          li.onclick = (e) => { if (e.target.closest('.u-btn')) return; openDMWith(u.id); };
          ul.appendChild(li);
        });
    } catch (e) {
      a22Log('error', 'renderColleagues threw', e.message);
    }
  }




  // ============================================================
  // МОДАЛКА (админ)
  // ============================================================
  const modal = {
    submit: null,
    open({ title, placeholder1, value1 = '', type1 = 'text',
           placeholder2 = null, type2 = 'password', value2 = '',
           placeholder3 = null, value3 = '', type3 = 'text',
           showAdmin = false, adminValue = false, submitLabel = 'OK', onSubmit }) {
      $('modal-title').textContent = title;
      const i1 = $('modal-input-1'), i2 = $('modal-input-2'), i3 = $('modal-input-3');
      const admRow = $('modal-admin-row'), adm = $('modal-input-admin');
      i1.value = value1; i1.placeholder = placeholder1 || ''; i1.type = type1; i1.classList.remove('hidden');
      if (placeholder2) { i2.value = value2; i2.placeholder = placeholder2; i2.type = type2; i2.classList.remove('hidden'); }
      else { i2.classList.add('hidden'); i2.value = ''; }
      if (placeholder3) { i3.value = value3; i3.placeholder = placeholder3; i3.type = type3; i3.classList.remove('hidden'); }
      else { i3.classList.add('hidden'); i3.value = ''; }
      if (showAdmin) { admRow.classList.remove('hidden'); adm.checked = !!adminValue; }
      else { admRow.classList.add('hidden'); adm.checked = false; }
      $('modal-error').textContent = '';
      $('btn-modal-submit').textContent = submitLabel;
      $('modal').classList.remove('hidden');
      setTimeout(() => i1.focus(), 30);
      this.submit = onSubmit;
    },
    close() { $('modal').classList.add('hidden'); this.submit = null; }
  };

  function openEditUserModal(u) {
    modal.open({
      title: 'Редактировать @' + u.username,
      placeholder1: 'Логин', value1: u.username,
      placeholder3: 'ФИО', value3: u.full_name || '',
      submitLabel: 'Сохранить',
      onSubmit: async () => {
        await api('api/users/' + u.id, {
          method: 'PATCH',
          body: JSON.stringify({
            username: $('modal-input-1').value.trim(),
            full_name: $('modal-input-3').value.trim()
          })
        });
      }
    });
  }
  function openPasswordModal(u) {
    modal.open({
      title: 'Новый пароль для @' + u.username,
      placeholder1: 'Пароль (минимум 4)', type1: 'password',
      submitLabel: 'Сменить пароль',
      onSubmit: async () => {
        await api('api/users/' + u.id + '/password', {
          method: 'POST',
          body: JSON.stringify({ password: $('modal-input-1').value })
        });
      }
    });
  }
  function openCreateUserModal() {
    modal.open({
      title: 'Новый пользователь',
      placeholder1: 'Логин',
      placeholder2: 'Пароль (минимум 4)',
      placeholder3: 'ФИО (необязательно)',
      showAdmin: true,
      submitLabel: 'Создать',
      onSubmit: async () => {
        await api('api/users', {
          method: 'POST',
          body: JSON.stringify({
            username: $('modal-input-1').value.trim(),
            password: $('modal-input-2').value,
            full_name: $('modal-input-3').value.trim(),
            is_admin: $('modal-input-admin').checked
          })
        });
      }
    });
  }
  $('btn-add-user').onclick = openCreateUserModal;
  $('btn-modal-cancel').onclick = () => modal.close();
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) modal.close(); });
  $('btn-modal-submit').onclick = async () => {
    if (!modal.submit) return;
    try {
      $('modal-error').textContent = '';
      await modal.submit();
      modal.close();
      loadUsers();
    } catch (e) { $('modal-error').textContent = e.message; }
  };

  // ============================================================
  // MENTION AUTOCOMPLETE
  // ============================================================
  const input = $('input');
  const picker = $('mention-picker');

  async function getChatMembers() {
    if (!state.chatId) return [];
    if (state.chatMembersCache[state.chatId]) return state.chatMembersCache[state.chatId];
    try {
      const { members } = await api('api/chats/' + state.chatId + '/members');
      state.chatMembersCache[state.chatId] = members;
      return members;
    } catch { return []; }
  }
  function hidePicker() {
    state.mentionPicker.active = false;
    picker.classList.add('hidden');
    picker.innerHTML = '';
  }
  function renderPicker() {
    picker.innerHTML = '';
    state.mentionPicker.users.forEach((u, i) => {
      const row = document.createElement('div');
      row.className = 'mention-row' + (i === state.mentionPicker.selected ? ' active' : '');
      const av = document.createElement('span');
      av.className = 'avatar avatar-xs';
      renderAvatar(av, u);
      const name = document.createElement('span');
      name.className = 'mention-name';
      name.textContent = displayName(u);
      const un = document.createElement('span');
      un.className = 'mention-username';
      un.textContent = '@' + u.username;
      row.appendChild(av); row.appendChild(name); row.appendChild(un);
      row.addEventListener('mousedown', e => { e.preventDefault(); applyMention(u); });
      picker.appendChild(row);
    });
    picker.classList.remove('hidden');
  }
  async function updateMentionPicker() {
    const val = input.value;
    const pos = input.selectionStart;
    const before = val.slice(0, pos);
    const m = before.match(/(?:^|\s)@([a-zA-Z0-9_.\-]{0,32})$/);
    if (!m) { hidePicker(); return; }
    const query = m[1].toLowerCase();
    const atPos = pos - m[1].length - 1;
    const members = await getChatMembers();
    const q = query.trim();
    const filtered = members.filter(u => {
      if (!q) return true;
      const fn = (u.full_name || '').toLowerCase();
      const un = u.username.toLowerCase();
      return un.startsWith(q) || fn.split(/\s+/).some(w => w.startsWith(q)) || fn.includes(q);
    }).slice(0, 8);
    if (!filtered.length) { hidePicker(); return; }
    state.mentionPicker = { active: true, query, startPos: atPos, users: filtered, selected: 0 };
    renderPicker();
  }
  function applyMention(u) {
    const val = input.value;
    const pos = input.selectionStart;
    const start = state.mentionPicker.startPos;
    const before = val.slice(0, start);
    const after = val.slice(pos);
    const inserted = '@' + u.username + ' ';
    input.value = before + inserted + after;
    const newPos = start + inserted.length;
    input.setSelectionRange(newPos, newPos);
    input.focus();
    hidePicker();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    if (state.socket && state.chatId) {
      state.socket.emit('typing', { chatId: state.chatId, typing: input.value.length > 0 || !!state.pendingAttachment });
    }
    updateMentionPicker();
  });
  input.addEventListener('click', updateMentionPicker);
  input.addEventListener('blur', () => setTimeout(hidePicker, 120));
  input.addEventListener('keydown', e => {
    if (state.mentionPicker.active) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.mentionPicker.selected = (state.mentionPicker.selected + 1) % state.mentionPicker.users.length;
        renderPicker(); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.mentionPicker.selected = (state.mentionPicker.selected - 1 + state.mentionPicker.users.length) % state.mentionPicker.users.length;
        renderPicker(); return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMention(state.mentionPicker.users[state.mentionPicker.selected]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hidePicker(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  });

  // ============================================================
  // ФАЙЛЫ
  // ============================================================
  $('btn-attach').onclick = () => $('file-input').click();
  $('file-input').onchange = (e) => {
    const f = e.target.files[0];
    if (f) startUpload(f);
    e.target.value = '';
  };
  async function startUpload(file) {
    if (file.size > 25 * 1024 * 1024) { alert('Файл больше 25 МБ'); return; }
    state.uploading = true;
    renderAttachmentPreview(file, { uploading: true });
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('api/upload', { method: 'POST', credentials: 'include', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'upload failed');
      state.pendingAttachment = data;
      renderAttachmentPreview(file, data);
    } catch (e) {
      alert('Ошибка загрузки: ' + e.message);
      clearAttachment();
    } finally { state.uploading = false; }
  }
  function renderAttachmentPreview(file, uploaded) {
    const box = $('attachment-preview');
    box.innerHTML = '';
    box.classList.remove('hidden');
    const row = document.createElement('div');
    row.className = 'attachment-preview-row';
    const isImage = (file.type || '').startsWith('image/');
    if (isImage) {
      const img = document.createElement('img');
      img.className = 'attachment-preview-thumb';
      img.src = URL.createObjectURL(file);
      row.appendChild(img);
    } else {
      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.textContent = fileEmoji(file.name, file.type);
      row.appendChild(icon);
    }
    const info = document.createElement('div');
    info.className = 'attachment-preview-info';
    const name = document.createElement('div');
    name.className = 'attachment-preview-name';
    name.textContent = file.name;
    const status = document.createElement('div');
    status.className = 'attachment-preview-status';
    if (uploaded && uploaded.uploading) status.textContent = 'Загрузка…';
    else if (uploaded && uploaded.url) status.textContent = formatSize(uploaded.size) + ' • готово';
    else status.textContent = formatSize(file.size);
    info.appendChild(name); info.appendChild(status);
    row.appendChild(info);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'u-btn del';
    rm.textContent = '✕';
    rm.onclick = clearAttachment;
    row.appendChild(rm);
    box.appendChild(row);
  }
  function clearAttachment() {
    state.pendingAttachment = null;
    $('attachment-preview').classList.add('hidden');
    $('attachment-preview').innerHTML = '';
  }
  const content = $('content');
  let dragDepth = 0;
  content.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); dragDepth++;
    $('drop-overlay').classList.remove('hidden');
  });
  content.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
  });
  content.addEventListener('dragleave', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('drop-overlay').classList.add('hidden');
  });
  content.addEventListener('drop', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); dragDepth = 0;
    $('drop-overlay').classList.add('hidden');
    const f = e.dataTransfer.files[0];
    if (f) startUpload(f);
  });
  $('composer').addEventListener('submit', e => {
    e.preventDefault();
    const body = input.value.trim();
    if (state.uploading) { alert('Дождитесь окончания загрузки'); return; }
    if (!body && !state.pendingAttachment) return;
    if (!state.chatId) return;
    state.socket.emit('message', { chatId: state.chatId, body, attachment: state.pendingAttachment });
    input.value = '';
    input.style.height = 'auto';
    clearAttachment();
    hidePicker();
    state.socket.emit('typing', { chatId: state.chatId, typing: false });
  });

  // ============================================================
  // ЗВОНКИ
  // ============================================================
  function updateCallButtons() {
    const inCallHere = state.call.active && state.call.chatId === state.chatId;
    const callActiveHere = state.chats.find(c => c.id === state.chatId)?.call_active;
    $('btn-call').classList.toggle('hidden', inCallHere || !!callActiveHere);
    $('btn-join-call').classList.toggle('hidden', inCallHere || !callActiveHere);
    if (!inCallHere && callActiveHere) $('call-banner').classList.remove('hidden');
    else $('call-banner').classList.add('hidden');
  }
  $('btn-call').onclick = () => { a22Log('ui', 'call button clicked'); startCall(); };
  $('btn-join-call').onclick = () => startCall();
  $('btn-banner-join').onclick = () => startCall();
  $('btn-banner-dismiss').onclick = () => $('call-banner').classList.add('hidden');

  async function startCall() {
    if (state.call.active) return;
    if (!state.chatId) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Браузер не поддерживает WebRTC');
      return;
    }
    let audioStream;
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
    } catch (e) {
      alert('Не удалось получить доступ к микрофону: ' + (e.message || e.name));
      return;
    }
    let videoStream = null;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (e) { console.warn('video unavailable:', e.message); }

    const stream = new MediaStream();
    audioStream.getAudioTracks().forEach(t => stream.addTrack(t));
    if (videoStream) videoStream.getVideoTracks().forEach(t => stream.addTrack(t));

    state.call.localStream = stream;
    state.call.micTrack = stream.getAudioTracks()[0] || null;
    state.call.cameraTrack = stream.getVideoTracks()[0] || null;
    state.call.active = true;
    state.call.chatId = state.chatId;
    state.call.peers = new Map();
    state.call.remoteStreams = new Map();
    state.call.participants = new Map();
    state.call.muted = !state.call.micTrack;
    state.call.videoOn = !!state.call.cameraTrack;
    state.call.screenSharing = false;
    state.call.startedAt = Date.now();
    state.call.minimized = false;

    $('btn-toggle-mic').classList.toggle('off', state.call.muted);
    $('btn-toggle-cam').classList.toggle('off', !state.call.videoOn);
    renderCallUI();
    $('call-overlay').classList.remove('hidden');
    $('call-mini').classList.add('hidden');
    updateCallButtons();
    startCallTimer();
    state.socket.emit('call:join', { chatId: state.chatId });
    state.socket.emit('call:state-update', { chatId: state.chatId, muted: state.call.muted, video: state.call.videoOn });
  }

  function startCallTimer() {
    stopCallTimer();
    state.call.timer = setInterval(() => {
      if (!state.call.active) return;
      const sec = Math.floor((Date.now() - state.call.startedAt) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      $('call-duration').textContent = mm + ':' + ss;
    }, 1000);
  }
  function stopCallTimer() {
    if (state.call.timer) { clearInterval(state.call.timer); state.call.timer = null; }
  }
  async function leaveCall() {
    if (!state.call.active) return;
    const cid = state.call.chatId;
    if (state.socket) state.socket.emit('call:leave', { chatId: cid });
    for (const [, pc] of state.call.peers) { try { pc.close(); } catch {} }
    state.call.peers.clear();
    state.call.remoteStreams.clear();
    if (state.call.localStream) state.call.localStream.getTracks().forEach(t => t.stop());
    if (state.call.screenStream) state.call.screenStream.getTracks().forEach(t => t.stop());
    state.call.localStream = null;
    state.call.screenStream = null;
    state.call.micTrack = null;
    state.call.cameraTrack = null;
    state.call.active = false;
    state.call.chatId = null;
    state.call.participants.clear();
    state.call.screenSharing = false;
    state.call.videoOn = true;
    state.call.muted = false;
    for (const t of state.call.fallbackTimers.values()) clearTimeout(t);
    state.call.fallbackTimers.clear();
    state.call.relayForced.clear();
    stopCallTimer();
    $('call-overlay').classList.add('hidden');
    $('call-mini').classList.add('hidden');
    $('call-grid').innerHTML = '';
    updateCallButtons();
    stopControl(true);
    try {
      const { chats } = await api('api/chats');
      state.chats = chats;
      renderChats();
    } catch {}
  }
  $('btn-call-leave').onclick = () => { a22Log('ui', 'leave call clicked'); leaveCall(); };
  $('btn-call-leave-mini').onclick = () => leaveCall();
  $('btn-call-minimize').onclick = () => {
    state.call.minimized = true;
    $('call-overlay').classList.add('hidden');
    $('call-mini').classList.remove('hidden');
    renderMini();
  };
  $('btn-call-expand').onclick = () => {
    state.call.minimized = false;
    $('call-mini').classList.add('hidden');
    $('call-overlay').classList.remove('hidden');
    renderCallUI();
  };
  function renderMini() {
    const n = state.call.participants.size + 1;
    $('call-mini-count').textContent = n + ' ' + (n === 1 ? 'участник' : (n < 5 ? 'участника' : 'участников'));
    const ch = state.chats.find(c => c.id === state.call.chatId);
    $('call-mini-title').textContent = ch ? ch.name : 'Звонок';
  }
  function setMicEnabled(on) {
    state.call.muted = !on;
    if (state.call.micTrack) state.call.micTrack.enabled = on;
    $('btn-toggle-mic').classList.toggle('off', !on);
    if (state.call.active) state.socket.emit('call:state-update', { chatId: state.call.chatId, muted: !on });
  }
  async function setCamEnabled(on) {
    if (on && !state.call.cameraTrack) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
        const track = s.getVideoTracks()[0];
        state.call.cameraTrack = track;
        if (!state.call.localStream) state.call.localStream = s;
        else state.call.localStream.addTrack(track);
        for (const pc of state.call.peers.values()) {
          const sender = pc.getSenders().find(x => x.track && x.track.kind === 'video');
          if (sender) { try { await sender.replaceTrack(track); } catch {} }
        }
      } catch (e) { alert('Не удалось включить камеру: ' + e.message); return; }
    }
    state.call.videoOn = on;
    if (state.call.cameraTrack) state.call.cameraTrack.enabled = on;
    $('btn-toggle-cam').classList.toggle('off', !on);
    if (state.call.active) state.socket.emit('call:state-update', { chatId: state.call.chatId, video: on });
    renderCallUI();
  }
  $('btn-toggle-mic').onclick = () => { a22Log('ui', 'toggle mic', { muted: state.call.muted }); setMicEnabled(state.call.muted); };
  $('btn-toggle-cam').onclick = () => { a22Log('ui', 'toggle cam', { videoOn: state.call.videoOn }); setCamEnabled(!state.call.videoOn); };
  $('btn-toggle-screen').onclick = async () => {
    if (!state.call.active) return;
    if (state.call.screenSharing) {
      const track = state.call.screenStream && state.call.screenStream.getVideoTracks()[0];
      if (track) track.stop();
      state.call.screenStream = null;
      state.call.screenSharing = false;
      if (state.call.cameraTrack) {
        for (const pc of state.call.peers.values()) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) { try { await sender.replaceTrack(state.call.cameraTrack); } catch {} }
        }
      }
      $('btn-toggle-screen').classList.remove('on');
      state.socket.emit('call:state-update', { chatId: state.call.chatId, screen: false });
      renderCallUI();
      return;
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false
      });
      state.call.screenStream = screen;
      state.call.screenSharing = true;
      const screenTrack = screen.getVideoTracks()[0];
      for (const pc of state.call.peers.values()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) { try { await sender.replaceTrack(screenTrack); } catch {} }
        else pc.addTrack(screenTrack, screen);
      }
      screenTrack.onended = () => { if (state.call.screenSharing) $('btn-toggle-screen').click(); };
      $('btn-toggle-screen').classList.add('on');
      state.socket.emit('call:state-update', { chatId: state.call.chatId, screen: true });
      renderCallUI();
    } catch {}
  };

  function createPeerConnection(peerId, opts = {}) {
    const cfg = Object.assign({}, state.call.iceConfig || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    if (opts.forceRelay) cfg.iceTransportPolicy = 'relay';
    const pc = new RTCPeerConnection(cfg);
    pc._isRelay = !!opts.forceRelay;
    pc._pendingCandidates = [];
    if (state.call.localStream) {
      state.call.localStream.getTracks().forEach(t => {
        try { pc.addTrack(t, state.call.localStream); } catch {}
      });
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        state.socket.emit('call:signal', {
          chatId: state.call.chatId,
          toUserId: peerId,
          signal: { kind: 'candidate', candidate: e.candidate.toJSON() }
        });
      }
    };
    pc.ontrack = (e) => {
      let remote = state.call.remoteStreams.get(peerId);
      if (!remote) { remote = new MediaStream(); state.call.remoteStreams.set(peerId, remote); }
      const incoming = (e.streams && e.streams[0]) ? e.streams[0] : remote;
      if (!incoming.getTracks().find(t => t.id === e.track.id)) incoming.addTrack(e.track);
      state.call.remoteStreams.set(peerId, incoming);
      renderCallUI();
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        const t = state.call.fallbackTimers.get(peerId);
        if (t) { clearTimeout(t); state.call.fallbackTimers.delete(peerId); }
      }
      renderCallUI();
    };
    pc.onconnectionstatechange = () => { renderCallUI(); };
    state.call.peers.set(peerId, pc);
    return pc;
  }
  async function flushPendingCandidates(pc) {
    if (!pc._pendingCandidates) return;
    const arr = pc._pendingCandidates.slice();
    pc._pendingCandidates = [];
    for (const c of arr) { try { await pc.addIceCandidate(c); } catch {} }
  }
  function scheduleRelayFallback(peerId) {
    if (state.call.relayForced.has(peerId)) return;
    if (state.call.fallbackTimers.has(peerId)) return;
    const t = setTimeout(() => {
      state.call.fallbackTimers.delete(peerId);
      const pc = state.call.peers.get(peerId);
      if (!pc) return;
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') return;
      forceRelayFor(peerId);
    }, 4000);
    state.call.fallbackTimers.set(peerId, t);
  }
  async function forceRelayFor(peerId) {
    if (state.call.relayForced.has(peerId)) return;
    state.call.relayForced.add(peerId);
    const oldPc = state.call.peers.get(peerId);
    const wasOfferer = !!(oldPc && oldPc.localDescription && oldPc.localDescription.type === 'offer');
    if (oldPc) { try { oldPc.close(); } catch {} state.call.peers.delete(peerId); }
    const pc = createPeerConnection(peerId, { forceRelay: true });
    if (wasOfferer) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        state.socket.emit('call:signal', {
          chatId: state.call.chatId,
          toUserId: peerId,
          signal: { kind: 'offer', sdp: offer.sdp, relay: true }
        });
      } catch {}
    }
  }
  async function createOfferTo(peerId) {
    const pc = createPeerConnection(peerId);
    scheduleRelayFallback(peerId);
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      state.socket.emit('call:signal', {
        chatId: state.call.chatId,
        toUserId: peerId,
        signal: { kind: 'offer', sdp: offer.sdp }
      });
    } catch (e) { console.warn('offer error', e); }
  }

  function renderCallUI() {
    const grid = $('call-grid');
    const all = [];
    all.push({
      userId: state.user.id, username: state.user.username,
      full_name: state.user.full_name, avatar: state.user.avatar, isLocal: true
    });
    for (const [uid, info] of state.call.participants) {
      if (uid === state.user.id) continue;
      all.push({
        userId: uid, username: info.username,
        full_name: info.full_name, avatar: info.avatar,
        isLocal: false, muted: info.muted, video: info.video, screen: info.screen
      });
    }
    const n = all.length;
    let cols = 1;
    if (n === 2) cols = 2;
    else if (n >= 3 && n <= 4) cols = 2;
    else if (n >= 5 && n <= 9) cols = 3;
    else if (n > 9) cols = 4;
    if (!window.matchMedia('(max-width: 768px)').matches) {
      grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    }
    const presentIds = new Set(all.map(p => String(p.userId)));
    [...grid.querySelectorAll('.call-tile')].forEach(tile => {
      if (!presentIds.has(tile.dataset.userId)) tile.remove();
    });
    for (const p of all) {
      const uid = String(p.userId);
      let tile = grid.querySelector('.call-tile[data-user-id="' + uid + '"]');
      if (!tile) {
        tile = document.createElement('div');
        tile.className = 'call-tile';
        tile.dataset.userId = uid;
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        tile.appendChild(video);
        const overlay = document.createElement('div');
        overlay.className = 'call-tile-overlay';
        const av = document.createElement('div');
        av.className = 'avatar avatar-lg tile-avatar';
        overlay.appendChild(av);
        const nm = document.createElement('div');
        nm.className = 'call-tile-name';
        overlay.appendChild(nm);
        tile.appendChild(overlay);
        const badges = document.createElement('div');
        badges.className = 'call-tile-badges';
        tile.appendChild(badges);
        grid.appendChild(tile);
      }
      tile.classList.toggle('screen', !!p.screen);
      const video = tile.querySelector('video');
      const overlay = tile.querySelector('.call-tile-overlay');
      const av = overlay.querySelector('.tile-avatar');
      const nm = overlay.querySelector('.call-tile-name');
      const badges = tile.querySelector('.call-tile-badges');
      renderAvatar(av, { id: p.userId, username: p.username, full_name: p.full_name, avatar: p.avatar });
      nm.textContent = displayName(p) + (p.isLocal ? ' (вы)' : '');
      let shouldHideVideo = false;
      if (p.isLocal) {
        const stream = (state.call.screenSharing && state.call.screenStream)
          ? state.call.screenStream
          : state.call.localStream;
        if (stream && video.srcObject !== stream) video.srcObject = stream;
        video.muted = true;
        shouldHideVideo = !state.call.screenSharing && !state.call.videoOn;
      } else {
        const stream = state.call.remoteStreams.get(p.userId);
        if (stream && video.srcObject !== stream) {
          video.srcObject = stream;
          video.muted = true;
          const ap = video.play();
          if (ap && ap.catch) ap.catch(() => {});
        }
        shouldHideVideo = (p.video === false && !p.screen) && !stream;
      }
      video.style.visibility = shouldHideVideo ? 'hidden' : 'visible';
      overlay.style.opacity = shouldHideVideo ? '1' : '0';
      badges.innerHTML = '';
      if (p.isLocal) {
        if (state.call.muted) { const b = document.createElement('span'); b.className = 'call-badge muted'; b.textContent = '🔇'; badges.appendChild(b); }
        if (state.call.screenSharing) { const b = document.createElement('span'); b.className = 'call-badge'; b.textContent = '🖥️'; badges.appendChild(b); }
      } else {
        if (p.muted) { const b = document.createElement('span'); b.className = 'call-badge muted'; b.textContent = '🔇'; badges.appendChild(b); }
        if (p.screen) { const b = document.createElement('span'); b.className = 'call-badge'; b.textContent = '🖥️'; badges.appendChild(b); }
      }
    }
    $('call-chat-name').textContent = (state.chats.find(c => c.id === state.call.chatId)?.name || 'Звонок')
      + ' • ' + all.length + ' ' + (all.length === 1 ? 'участник' : (all.length < 5 ? 'участника' : 'участников'));
    if (state.call.minimized) renderMini();
  }

  // ============================================================
  // УДАЛЁННЫЙ РАБОЧИЙ СТОЛ
  // ============================================================
  async function startRemoteSession(userId) {
    a22Log('ui', 'start remote session', { userId });
    if (!window.a22desktop || !window.a22desktop.isDesktop) {
      alert('Удалённое управление доступно только в десктопном приложении a22 Chat.\nСкачайте его: https://chat.a22mail.ru — кнопка «⬇️ Windows».');
      return;
    }
    if (state.remote.active || state.remote.accepted) {
      alert('Уже есть активная сессия удалённого управления');
      return;
    }
    if (state.call.active) {
      alert('Сначала завершите текущий звонок');
      return;
    }
    const peer = state.userList.find(u => u.id === userId);
    if (!peer) return;
    if (!confirm('Запросить удалённое управление компьютером ' + displayName(peer) + '?')) return;

    state.remote.userId = userId;
    state.remote.pending = true;

    let chatId = null;
    try {
      const { chat } = await api('api/dm/' + userId, { method: 'POST' });
      chatId = chat.id;
      if (!state.chats.find(c => c.id === chat.id)) state.chats.push(chat);
      renderChats();
      selectChat(chat.id);
    } catch {}

    state.socket.emit('remote:request', { toUserId: userId, chatId });
  }

  function showRemoteRequest({ from }) {
    state.remote.pendingFrom = from;
    renderAvatar($('remote-req-avatar'), from);
    $('remote-req-name').textContent = displayName(from);
    $('remote-request-modal').classList.remove('hidden');
  }

  $('btn-remote-decline').onclick = () => {
    const from = state.remote.pendingFrom;
    if (from) state.socket.emit('remote:reject', { toUserId: from.id });
    state.remote.pendingFrom = null;
    $('remote-request-modal').classList.add('hidden');
  };

  $('btn-remote-accept').onclick = async () => {
    const from = state.remote.pendingFrom;
    if (!from) return;
    if (!window.a22desktop || !window.a22desktop.isDesktop) {
      alert('Принять управление можно только в десктопном приложении');
      return;
    }
    state.remote.pendingFrom = null;
    $('remote-request-modal').classList.add('hidden');

    try {
      // Захватываем ВЕСЬ экран (или даём выбрать)
      const sources = await window.a22desktop.getSources();
      // Фильтруем только ЭКРАНЫ
      const screens = sources.filter(s => s.id.startsWith('screen:'));
      let screenSource;

      if (screens.length === 0) {
        alert('Не найдено ни одного экрана');
        return;
      } else if (screens.length === 1) {
        // Один экран — берём его без вопросов
        screenSource = screens[0];
      } else {
        // Несколько экранов — даём выбрать
        screenSource = await window.__a22PickSource(screens);
        if (!screenSource) return;
      }

      console.log('[remote] capturing:', screenSource.id, screenSource.name);

      // Захват всей области экрана (без курсора — он будет виден сам по себе)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screenSource.id,
            minWidth: 1280,
            maxWidth: 3840,
            minHeight: 720,
            maxHeight: 2160,
            maxFrameRate: 30
          }
        }
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        console.log('[remote] capture settings:', settings.width + 'x' + settings.height);
      }

      const pc = new RTCPeerConnection(state.call.iceConfig || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      // DataChannel для событий управления
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dc.onopen = () => console.log('[remote] dataChannel OPEN');
        dc.onclose = () => console.log('[remote] dataChannel CLOSED');
        dc.onerror = (err) => console.error('[remote] dc error', err);
        dc.onmessage = (msg) => {
          try {
            const ev = JSON.parse(msg.data);
            if (typeof window.handleControlEvent === 'function') {
              window.handleControlEvent({ event: ev });
            } else {
              console.warn('[remote] handleControlEvent undefined');
            }
          } catch (err) { console.error('dc parse', err); }
        };
        state.remote.dataChannel = dc;
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          state.socket.emit('remote:ice', { toUserId: from.id, candidate: e.candidate.toJSON() });
        }
      };

      state.remote.pc = pc;
      state.remote.stream = stream;
      state.remote.accepted = true;
      state.remote.userId = from.id;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket.emit('remote:offer', { toUserId: from.id, sdp: offer.sdp });

      updateRemoteUI();

      // Показываем локальную полосу «вас смотрят»
      document.body.classList.add('remote-controlling');

    } catch (e) {
      console.error('[remote] accept error', e);
      alert('Не удалось начать сессию: ' + e.message);
    }
  };

  function updateRemoteUI() {
    if (state.remote.accepted) {
      const who = state.userList.find(u => u.id === state.remote.userId);
      $('remote-overlay-me').classList.remove('hidden');
      $('remote-overlay-name').textContent = who ? displayName(who) : 'пользователем';
      window.__a22UseNativeControl = true;
    } else if (state.remote.active) {
      $('remote-banner-active').classList.remove('hidden');
      $('remote-viewer').classList.remove('hidden');
    } else {
      $('remote-overlay-me').classList.add('hidden');
      $('remote-banner-active').classList.add('hidden');
      $('remote-viewer').classList.add('hidden');
    }
  }

  function stopRemoteSession() {
    if (state.remote._stopCapture) { try { state.remote._stopCapture(); } catch {} state.remote._stopCapture = null; }
    if (state.remote.pc) { try { state.remote.pc.close(); } catch {} state.remote.pc = null; }
    if (state.remote.stream) { state.remote.stream.getTracks().forEach(t => t.stop()); state.remote.stream = null; }
    if (state.remote.dataChannel) { try { state.remote.dataChannel.close(); } catch {} state.remote.dataChannel = null; }
    if (state.remote.userId) state.socket.emit('remote:stop', { toUserId: state.remote.userId });
    state.remote = {
      active: false, accepted: false, pending: false,
      userId: null, pendingFrom: null,
      pc: null, stream: null, remoteStream: null,
      dataChannel: null, _capturing: false, _stopCapture: null
    };
    $('remote-overlay-me').classList.add('hidden');
    $('remote-banner-active').classList.add('hidden');
    $('remote-viewer').classList.add('hidden');
    document.body.classList.remove('remote-controlling');
  }
  $('btn-remote-overlay-stop').onclick = stopRemoteSession;
  $('btn-remote-banner-stop').onclick = stopRemoteSession;
  $('btn-remote-viewer-close').onclick = stopRemoteSession;

  function startRemoteCapture() {
    if (state.remote._capturing) return;
    state.remote._capturing = true;
    const dc = state.remote.dataChannel;
    if (!dc) { console.warn('[remote] no dataChannel'); return; }

    const trySend = (ev) => {
      if (dc.readyState === 'open') {
        try { dc.send(JSON.stringify(ev)); return true; } catch (e) { console.warn('dc.send', e); }
      }
      return false;
    };

    // Очередь до открытия канала
    const queue = [];
    const flushQueue = () => {
      while (queue.length) {
        const ev = queue.shift();
        if (!trySend(ev)) { queue.unshift(ev); break; }
      }
    };
    if (dc.readyState !== 'open') {
      dc.addEventListener('open', () => { console.log('[remote] dc open'); flushQueue(); });
    }

    const send = (ev) => {
      if (!trySend(ev)) { queue.push(ev); if (queue.length > 200) queue.shift(); }
    };

    // Точные координаты с учётом letterboxing
    const video = $('remote-viewer-video');
    function norm(clientX, clientY) {
      if (!video) return { x: 0, y: 0 };
      const rect = video.getBoundingClientRect();
      const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
      const va = vw / vh;
      const ea = rect.width / rect.height;
      let dw, dh, dx, dy;
      if (va > ea) { dw = rect.width; dh = rect.width / va; dx = 0; dy = (rect.height - dh) / 2; }
      else { dh = rect.height; dw = rect.height * va; dx = (rect.width - dw) / 2; dy = 0; }
      const x = (clientX - rect.left - dx) / dw;
      const y = (clientY - rect.top - dy) / dh;
      return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }

    let lastMoveTs = 0;
    const onMove = (e) => {
      const now = performance.now();
      if (now - lastMoveTs < 16) return;
      lastMoveTs = now;
      const p = norm(e.clientX, e.clientY);
      send({ t: 'move', x: p.x, y: p.y });
    };
    const onDown = (e) => { const p = norm(e.clientX, e.clientY); send({ t: 'down', x: p.x, y: p.y, btn: e.button }); e.preventDefault(); };
    const onUp = (e)   => { const p = norm(e.clientX, e.clientY); send({ t: 'up',   x: p.x, y: p.y, btn: e.button }); e.preventDefault(); };
    const onCtx  = (e) => e.preventDefault();
    const onWheel = (e) => { const p = norm(e.clientX, e.clientY); send({ t: 'wheel', x: p.x, y: p.y, dy: e.deltaY, dx: e.deltaX }); e.preventDefault(); };
    const onKey = (e) => {
      if (e.key === 'F12' || e.key === 'F5') return;
      e.preventDefault();
      send({ t: 'key', type: e.type, key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    };

    const target = video || document;
    target.addEventListener('mousemove', onMove, true);
    target.addEventListener('mousedown', onDown, true);
    target.addEventListener('mouseup', onUp, true);
    target.addEventListener('contextmenu', onCtx, true);
    target.addEventListener('wheel', onWheel, { capture: true, passive: false });
    // Клавиатуру слушаем на документе
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);

    state.remote._stopCapture = () => {
      target.removeEventListener('mousemove', onMove, true);
      target.removeEventListener('mousedown', onDown, true);
      target.removeEventListener('mouseup', onUp, true);
      target.removeEventListener('contextmenu', onCtx, true);
      target.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKey, true);
      state.remote._capturing = false;
    };

    // Клик по видео — фокусируемся, чтобы ловить клавиатуру
    if (video) {
      video.tabIndex = 0;
      video.addEventListener('click', () => video.focus(), true);
      setTimeout(() => video.focus(), 100);
    }
    document.body.classList.add('remote-controlling');
  }



  // ============================================================
  // УПРАВЛЕНИЕ ВКЛАДКОЙ
  // ============================================================
  function updateControlUI() {
    if (state.control.active && !state.call.minimized) {
      $('control-banner').classList.remove('hidden');
      $('control-banner-text').textContent = 'Вы управляете вкладкой';
      $('btn-request-control').classList.add('on');
    } else {
      $('control-banner').classList.add('hidden');
      $('btn-request-control').classList.remove('on');
    }
    if (state.control.remoteActive) {
      const from = state.userList.find(u => u.id === state.control.remoteFrom)
        || state.call.participants.get(state.control.remoteFrom);
      $('control-by-name').textContent = from ? displayName(from) : 'пользователем';
      $('control-overlay-me').classList.remove('hidden');
      document.body.classList.add('control-active');
    } else {
      $('control-overlay-me').classList.add('hidden');
      document.body.classList.remove('control-active');
      if (state.control.remoteCursor) { state.control.remoteCursor.remove(); state.control.remoteCursor = null; }
    }
  }
  $('btn-request-control').onclick = () => {
    if (!state.call.active) return;
    const peers = [...state.call.participants.keys()].filter(id => id !== state.user.id);
    if (!peers.length) { alert('В звонке нет других участников'); return; }
    let target = peers[0];
    if (peers.length > 1) {
      const names = peers.map((id, i) => (i + 1) + '. ' + displayName(state.userList.find(u => u.id === id)));
      const inputVal = prompt('Кому запросить управление?\n' + names.join('\n'), '1');
      const idx = parseInt(inputVal, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= peers.length) return;
      target = peers[idx];
    }
    state.socket.emit('control:request', { chatId: state.call.chatId, toUserId: target });
    state.control.peerId = target;
  };
  function showControlRequest({ from }) {
    state.control.pendingRequest = { from };
    renderAvatar($('control-req-avatar'), from);
    $('control-req-name').textContent = displayName(from);
    $('control-req-error').textContent = '';
    $('control-request-modal').classList.remove('hidden');
  }
  $('btn-control-decline').onclick = () => {
    if (!state.control.pendingRequest) return;
    const from = state.control.pendingRequest.from;
    state.socket.emit('control:response', { chatId: state.call.chatId, toUserId: from.id, accepted: false });
    state.control.pendingRequest = null;
    $('control-request-modal').classList.add('hidden');
  };
  $('btn-control-accept').onclick = () => {
    if (!state.control.pendingRequest) return;
    const from = state.control.pendingRequest.from;
    state.socket.emit('control:response', { chatId: state.call.chatId, toUserId: from.id, accepted: true });
    state.control.remoteActive = true;
    state.control.remoteFrom = from.id;
    state.control.pendingRequest = null;
    $('control-request-modal').classList.add('hidden');
    updateControlUI();
    if (!state.control.remoteCursor) {
      const c = document.createElement('div');
      c.className = 'remote-cursor';
      c.dataset.user = displayName(from);
      document.body.appendChild(c);
      state.control.remoteCursor = c;
    }
  };
  function onControlResponse({ fromUserId, accepted }) {
    if (accepted) {
      state.control.active = true;
      state.control.peerId = fromUserId;
      updateControlUI();
      startCapturing();
    } else {
      state.control.active = false;
      alert('Пользователь отклонил запрос управления');
    }
  }
  let captureHandlers = null;
  function startCapturing() {
    if (captureHandlers) return;
    const send = (ev) => {
      if (!state.control.active || !state.call.active) return;
      state.socket.emit('control:event', {
        chatId: state.call.chatId,
        toUserId: state.control.peerId,
        event: ev
      });
    };
    const norm = (e) => ({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight });
    const onMove = (e) => {
      const now = performance.now();
      if (now - state.control.lastMoveTs < state.control.moveThrottle) return;
      state.control.lastMoveTs = now;
      const p = norm(e);
      send({ t: 'move', x: p.x, y: p.y });
    };
    const onDown = (e) => { const p = norm(e); send({ t: 'down', x: p.x, y: p.y, btn: e.button }); };
    const onUp = (e) => { const p = norm(e); send({ t: 'up', x: p.x, y: p.y, btn: e.button }); };
    const onWheel = (e) => { const p = norm(e); send({ t: 'wheel', x: p.x, y: p.y, dy: e.deltaY, dx: e.deltaX }); };
    const onKey = (e) => {
      if (e.key === 'Escape') return;
      if (e.ctrlKey && ['c','v','x','a','z','r','w','t','n'].includes(e.key.toLowerCase())) return;
      if (e.metaKey) return;
      e.preventDefault();
      send({ t: 'key', key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, type: e.type });
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);
    captureHandlers = { onMove, onDown, onUp, onWheel, onKey };
  }
  function stopCapturing() {
    if (!captureHandlers) return;
    document.removeEventListener('mousemove', captureHandlers.onMove, true);
    document.removeEventListener('mousedown', captureHandlers.onDown, true);
    document.removeEventListener('mouseup', captureHandlers.onUp, true);
    document.removeEventListener('wheel', captureHandlers.onWheel, true);
    document.removeEventListener('keydown', captureHandlers.onKey, true);
    document.removeEventListener('keyup', captureHandlers.onKey, true);
    captureHandlers = null;
  }
  function handleControlEvent({ event, fromUserId }) {
    if (!state.control.remoteActive) return;
    if (fromUserId && fromUserId !== state.control.remoteFrom) return;
    const w = window.innerWidth, h = window.innerHeight;
    const x = Math.round(event.x * w), y = Math.round(event.y * h);
    if (state.control.remoteCursor && ['move','down','up','wheel'].includes(event.t)) {
      state.control.remoteCursor.style.transform = `translate(${x}px, ${y}px)`;
    }
    if (event.t === 'move') {
      const el = document.elementFromPoint(x, y);
      document.querySelectorAll('.remote-hover').forEach(n => n.classList.remove('remote-hover'));
      if (el && el !== document.body && el !== document.documentElement) el.classList.add('remote-hover');
      return;
    }
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    if (event.t === 'down') { el.classList.add('remote-hover'); return; }
    if (event.t === 'up') {
      try {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: event.btn }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window, button: event.btn }));
        el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window, button: event.btn }));
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
          try { el.focus({ preventScroll: true }); } catch {}
        }
      } catch {}
      el.classList.remove('remote-hover');
      return;
    }
    if (event.t === 'wheel') { window.scrollBy({ top: event.dy || 0, left: event.dx || 0 }); return; }
    if (event.t === 'key') {
      const focused = document.activeElement;
      if (!focused) return;
      if (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA') {
        if (event.type === 'keydown') {
          if (event.key.length === 1 && !event.ctrl && !event.meta && !event.alt) {
            const start = focused.selectionStart ?? focused.value.length;
            const end = focused.selectionEnd ?? focused.value.length;
            focused.value = focused.value.slice(0, start) + event.key + focused.value.slice(end);
            focused.selectionStart = focused.selectionEnd = start + event.key.length;
            focused.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (event.key === 'Backspace') {
            const start = focused.selectionStart ?? focused.value.length;
            const end = focused.selectionEnd ?? focused.value.length;
            if (start === end && start > 0) {
              focused.value = focused.value.slice(0, start - 1) + focused.value.slice(end);
              focused.selectionStart = focused.selectionEnd = start - 1;
            } else {
              focused.value = focused.value.slice(0, start) + focused.value.slice(end);
              focused.selectionStart = focused.selectionEnd = start;
            }
            focused.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (event.key === 'Enter' && focused.tagName === 'TEXTAREA' && !event.shiftKey) {
            const form = focused.closest('form');
            if (form) form.requestSubmit();
          }
        }
        return;
      }
      try {
        focused.dispatchEvent(new KeyboardEvent(event.type, {
          key: event.key, code: event.code,
          ctrlKey: event.ctrl, altKey: event.alt,
          shiftKey: event.shift, metaKey: event.meta,
          bubbles: true, cancelable: true
        }));
      } catch {}
    }
  }
  // Экспортируем наружу для инжекта desktop-версии
  window.handleControlEvent = handleControlEvent;
  window.__a22State = state;

  function stopControl(silent) {
    if (state.control.active) state.socket.emit('control:stop', { chatId: state.call.chatId, toUserId: state.control.peerId });
    if (state.control.remoteActive) state.socket.emit('control:stop', { chatId: state.call.chatId, toUserId: state.control.remoteFrom });
    state.control.active = false;
    state.control.peerId = null;
    state.control.remoteActive = false;
    state.control.remoteFrom = null;
    stopCapturing();
    document.querySelectorAll('.remote-hover').forEach(n => n.classList.remove('remote-hover'));
    updateControlUI();
  }
  $('btn-control-stop').onclick = () => stopControl();
  $('btn-control-stop-2').onclick = () => stopControl();

  // ============================================================
  // УВЕДОМЛЕНИЯ И ЗВУК
  // ============================================================
  const notifState = {
    enabled: localStorage.getItem('notif_enabled') !== '0',
    sound: localStorage.getItem('sound_enabled') !== '0'
  };
  let audioCtx = null;
  let ringtoneNode = null;
  let unreadCount = 0;
  const baseTitle = document.title;

  function unlockAudio() {
    try {
      if (!audioCtx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (C) audioCtx = new C();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  function playNotificationSound() {
    if (!notifState.sound) return;
    if (!audioCtx) unlockAudio();
    if (!audioCtx) return;
    try {
      const t0 = audioCtx.currentTime;
      const tones = [
        { f: 880, t: 0, d: 0.10 },
        { f: 1318, t: 0.11, d: 0.18 }
      ];
      for (const tn of tones) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = tn.f;
        gain.gain.setValueAtTime(0, t0 + tn.t);
        gain.gain.linearRampToValueAtTime(0.16, t0 + tn.t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0008, t0 + tn.t + tn.d);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0 + tn.t);
        osc.stop(t0 + tn.t + tn.d + 0.03);
      }
    } catch {}
  }
  function startRingtone() {
    if (ringtoneNode) return;
    try {
      if (!audioCtx) unlockAudio();
      if (!audioCtx) return;
      const loop = () => {
        if (!ringtoneNode) return;
        const t0 = audioCtx.currentTime;
        const tones = [
          { f: 740, t: 0, d: 0.35 },
          { f: 880, t: 0.40, d: 0.35 },
          { f: 1046, t: 0.80, d: 0.40 }
        ];
        for (const tn of tones) {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = tn.f;
          gain.gain.setValueAtTime(0, t0 + tn.t);
          gain.gain.linearRampToValueAtTime(0.18, t0 + tn.t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + tn.t + tn.d);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(t0 + tn.t);
          osc.stop(t0 + tn.t + tn.d + 0.05);
        }
        ringtoneNode._timer = setTimeout(() => loop(), 2500);
      };
      ringtoneNode = { _timer: null };
      loop();
    } catch {}
  }
  function stopRingtone() {
    if (!ringtoneNode) return;
    clearTimeout(ringtoneNode._timer);
    ringtoneNode = null;
  }
  async function ensureNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try { const p = await Notification.requestPermission(); return p === 'granted'; } catch { return false; }
  }
  function notifyUser(title, body, chatId) {
    // В десктоп-версии используем нативные уведомления из main-процесса
    if (window.a22desktop && window.a22desktop.isDesktop && typeof window.a22desktop.notify === 'function') {
      try { window.a22desktop.notify({ title, body, chatId }); return; } catch (e) {}
    }
    // Веб-версия — Notification API
    if (!notifState.enabled) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const opts = {
      body: body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'chat-' + (chatId || 'msg'),
      renotify: true,
      data: { chatId: chatId || null }
    };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts)).catch(() => {
          try { new Notification(title, opts); } catch {}
        });
      } else {
        new Notification(title, opts);
      }
    } catch {}
  }

  function updateTitle() {
    document.title = unreadCount > 0 ? '(' + unreadCount + ') ' + baseTitle : baseTitle;
    a22Log('title', 'updated', { unreadCount, title: document.title });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { unreadCount = 0; updateTitle(); }
  });
  function updateNotifButton() {
    const b = $('btn-notif-toggle');
    if (!b) return;
    const perm = (('Notification' in window) && Notification.permission) || 'default';
    b.textContent = notifState.enabled && perm === 'granted' ? '🔔' : '🔕';
  }
  if ($('btn-notif-toggle')) {
    $('btn-notif-toggle').onclick = async () => {
      if (notifState.enabled) {
        notifState.enabled = false;
        notifState.sound = false;
        localStorage.setItem('notif_enabled', '0');
        localStorage.setItem('sound_enabled', '0');
        updateNotifButton();
        return;
      }
      notifState.enabled = true;
      localStorage.setItem('notif_enabled', '1');
      const ok = await ensureNotificationPermission();
      notifState.sound = true;
      localStorage.setItem('sound_enabled', '1');
      playNotificationSound();
      if (ok) notifyUser('a22 Chat', 'Уведомления включены', null);
      updateNotifButton();
    };
  }
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => updateNotifButton()).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-chat' && e.data.chatId) {
        const id = Number(e.data.chatId);
        if (state.chats.find(c => c.id === id)) selectChat(id);
      }
    });
  }
  function openChatFromUrl() {
    try {
      const u = new URL(location.href);
      const id = Number(u.searchParams.get('chat'));
      if (id && state.chats.find(c => c.id === id)) {
        selectChat(id);
        u.searchParams.delete('chat');
        history.replaceState({}, '', u.toString());
      }
    } catch {}
  }
  function showMessageToast({ chatId, title, body, from }) {
    try {
      const box = document.getElementById('mention-toasts');
      if (!box) { a22Log('warn', 'no #mention-toasts container'); return; }
      const el = document.createElement('div');
      el.className = 'mention-toast message-toast';
      const av = document.createElement('span');
      av.className = 'avatar avatar-sm';
      renderAvatar(av, from);
      const info = document.createElement('div');
      info.className = 'mention-toast-info';
      const t = document.createElement('div');
      t.className = 'mention-toast-title';
      t.textContent = title || 'Новое сообщение';
      const p = document.createElement('div');
      p.className = 'mention-toast-preview';
      p.textContent = body || '';
      info.appendChild(t); info.appendChild(p);
      el.appendChild(av); el.appendChild(info);
      el.onclick = () => { selectChat(chatId); el.remove(); };
      box.appendChild(el);
      a22Log('toast', 'message toast shown', { chatId, title });
      setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 400); }, 6000);
    } catch (e) {
      a22Log('error', 'showMessageToast failed', e.message);
    }
  }

  function showMentionToast({ chatId, chatName, from, body }) {
    const box = $('mention-toasts');
    const el = document.createElement('div');
    el.className = 'mention-toast';
    const av = document.createElement('span');
    av.className = 'avatar avatar-sm';
    renderAvatar(av, from);
    const info = document.createElement('div');
    info.className = 'mention-toast-info';
    const title = document.createElement('div');
    title.className = 'mention-toast-title';
    title.textContent = displayName(from) + ' упомянул вас в «' + (chatName || 'чате') + '»';
    const preview = document.createElement('div');
    preview.className = 'mention-toast-preview';
    preview.textContent = body || '(вложение)';
    info.appendChild(title);
    info.appendChild(preview);
    el.appendChild(av);
    el.appendChild(info);
    el.onclick = () => { selectChat(chatId); el.remove(); };
    box.appendChild(el);
    setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 400); }, 6000);
  }

  // ============================================================
  // МОБИЛЬНОЕ МЕНЮ
  // ============================================================
  function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
  function openSidebar() {
    document.querySelector('.sidebar')?.classList.add('open');
    $('sidebar-overlay')?.classList.remove('hidden');
  }
  function closeSidebar() {
    document.querySelector('.sidebar')?.classList.remove('open');
    $('sidebar-overlay')?.classList.add('hidden');
  }
  document.addEventListener('click', (e) => {
    if (e.target.id === 'btn-hamburger') { openSidebar(); return; }
    if (e.target.id === 'sidebar-overlay') { closeSidebar(); return; }
  });
  window.__closeSidebarIfMobile = () => { if (isMobile()) closeSidebar(); };

  // ============================================================
  // SOCKET
  // ============================================================
  // ============================================================
  // Обёртка socket.io — автологирование всех событий
  // ============================================================
  function wrapSocketForLogs(socket) {
    const origEmit = socket.emit.bind(socket);
    const origOn = socket.on.bind(socket);

    socket.emit = function(event, ...args) {
      try {
        if (typeof a22Log === 'function') {
          const safeArgs = args.map(a => {
            if (a === undefined || a === null) return a;
            if (typeof a !== 'object') return a;
            try {
              const c = {};
              Object.keys(a).forEach(k => {
                const v = a[k];
                if (typeof v === 'string') c[k] = v.length > 150 ? v.slice(0,150)+'…' : v;
                else if (typeof v === 'number' || typeof v === 'boolean') c[k] = v;
                else if (v && v.kind) c[k] = '<' + v.kind + '>';
                else if (Array.isArray(v)) c[k] = '<array ' + v.length + '>';
                else c[k] = typeof v;
              });
              return c;
            } catch (e) { return '<data>'; }
          });
          a22Log('sock:out', '➡ ' + event, safeArgs);
        }
      } catch (e) {}
      return origEmit(event, ...args);
    };

    socket.on = function(event, handler) {
      const wrapped = function(...args) {
        try {
          if (typeof a22Log === 'function') {
            const first = args[0];
            let summary = first;
            if (first && typeof first === 'object') {
              try {
                const c = {};
                Object.keys(first).forEach(k => {
                  const v = first[k];
                  if (typeof v === 'string') c[k] = v.length > 150 ? v.slice(0,150)+'…' : v;
                  else if (typeof v === 'number' || typeof v === 'boolean') c[k] = v;
                  else if (v && v.kind) c[k] = '<' + v.kind + '>';
                  else if (Array.isArray(v)) c[k] = '<array ' + v.length + '>';
                  else c[k] = typeof v;
                });
                summary = c;
              } catch (e) { summary = '<data>'; }
            }
            a22Log('sock:in', '⬅ ' + event, [summary]);
          }
        } catch (e) {}
        return handler.apply(this, args);
      };
      wrapped.__orig = handler;
      return origOn(event, wrapped);
    };

    return socket;
  }

  function connectSocket() {
    const socket = io({ withCredentials: true });
    state.socket = socket;
    socket.on('connect', () => { if (state.chatId) socket.emit('join', state.chatId); });

    socket.on('message', async m => {
      a22Log('ws', 'message received', { chatId: m.channel_id, from: m.user_id, self: state.user.id, current: state.chatId, body: (m.body || '').slice(0, 40) });

      const isSameChat = m.channel_id === state.chatId;
      const fromOther = m.user_id !== state.user.id;

      if (isSameChat) addMessage(m);

      // Найти чат в state (если нет — перезагрузить)
      let chat = state.chats.find(c => c.id === m.channel_id);
      if (!chat) {
        try {
          const fresh = await api('api/chats');
          state.chats = fresh.chats || [];
          chat = state.chats.find(c => c.id === m.channel_id);
        } catch (e) { a22Log('error', 'reload failed', e.message); }
      }

      // ОБНОВИТЬ ПРЕВЬЮ — локально, мгновенно
      if (chat) {
        let preview = '';
        if (m.body && m.body.trim()) preview = m.body.trim();
        else if (m.attachment_name) {
          const t = m.attachment_type || '';
          let emoji = '📎';
          if (t.startsWith('image/')) emoji = '🖼️';
          else if (t.startsWith('video/')) emoji = '🎬';
          else if (t.startsWith('audio/')) emoji = '🎵';
          preview = emoji + ' ' + m.attachment_name;
        }
        if (preview.length > 90) preview = preview.slice(0, 90) + '…';
        chat.last_message_preview = preview;
        chat.last_message_at = m.created_at;

        // Поднять чат наверх
        const idx = state.chats.indexOf(chat);
        if (idx > 0) {
          state.chats.splice(idx, 1);
          state.chats.unshift(chat);
        }
        renderChats();
        a22Log('ws', 'preview updated', { chatId: m.channel_id, preview: preview.slice(0, 40) });
      }

      if (!fromOther) return;

      const mentionsMe = new RegExp('@' + state.user.username + '\\b').test(m.body || '');
      const isAway = document.hidden || !document.hasFocus();

      // Звук: при упоминании, из другого чата, или когда окно свёрнуто
      if (mentionsMe || !isSameChat || isAway) {
        try { playNotificationSound(); } catch (e) {}
      }

      const finalChat = state.chats.find(c => c.id === m.channel_id);
      const title = finalChat
        ? (finalChat.type === 'dm' ? (m.full_name || m.username) : (finalChat.name + ' — ' + (m.full_name || m.username)))
        : (m.full_name || m.username);
      const body = (m.body && m.body.trim()) ? m.body : (m.attachment_name ? '📎 ' + m.attachment_name : 'Новое сообщение');

      // ВСЕГДА показываем уведомление, если сообщение не из открытого чата
      // или если окно не в фокусе
      if (isAway) {
        a22Log('notify', 'native toast (away)');
        try { notifyUser(title, body, m.channel_id); } catch (e) { a22Log('error', 'notifyUser failed', e.message); }
      } else if (!isSameChat) {
        a22Log('notify', 'html toast (other chat)');
        try { showMessageToast({ chatId: m.channel_id, title: title, body: body, from: { id: m.user_id, username: m.username, full_name: m.full_name, avatar: m.avatar } }); }
        catch (e) { a22Log('error', 'showMessageToast failed', e.message); }
      } else if (mentionsMe) {
        a22Log('notify', 'mention (same chat)');
        try { showMessageToast({ chatId: m.channel_id, title: 'Упоминание от ' + (m.full_name || m.username), body: body, from: { id: m.user_id, username: m.username, full_name: m.full_name, avatar: m.avatar } }); }
        catch (e) {}
      }

      if (!isSameChat) {
        state.unreadCounts[m.channel_id] = (state.unreadCounts[m.channel_id] || 0) + 1;
        // Обновляем unread_count в чате
        if (chat) {
          chat.unread_count = (chat.unread_count || 0) + 1;
          chat.last_message_user_id = m.user_id;
        }
        renderChats();
      }
      if (isAway || !isSameChat) {
        unreadCount++;
        updateTitle();
        if (window.a22desktop && typeof window.a22desktop.setBadge === 'function') {
          const total = Object.values(state.unreadCounts).reduce((a, b) => a + b, 0);
          try { window.a22desktop.setBadge(total); } catch {}
        }
      }
    });

    socket.on('chat:read', async (payload) => {
      // payload: { chatId, userId, readAt }
      a22Log('read', 'chat:read received', payload);
      if (!payload || payload.chatId !== state.chatId) return;
      if (payload.userId === state.user.id) return; // сам себя не считаем

      // Помечаем все свои сообщения до readAt как прочитанные
      document.querySelectorAll('.msg.self').forEach(el => {
        const createdAt = Number(el.dataset.createdAt || 0);
        if (createdAt <= payload.readAt) {
          const check = el.querySelector('.msg-check');
          if (check && !check.classList.contains('read')) {
            check.classList.add('read');
            check.textContent = '✓✓';
            check.title = 'Прочитано';
          }
        }
      });
      a22Log('read', 'checkmarks updated', { upTo: payload.readAt });
    });

    socket.on('presence', ids => {
      state.onlineIds = ids;
      renderChats();
      if (state.user.is_admin) renderAdminUsers();
      if (state.chatId) renderMembers();
    });

    socket.on('chat:new', async ({ chatId, memberIds }) => {
      if (memberIds && !memberIds.map(Number).includes(state.user.id)) return;
      try { const { chats } = await api('api/chats'); state.chats = chats; renderChats(); updateCallButtons(); } catch {}
    });
    socket.on('dm:new', async () => {
      try { const { chats } = await api('api/chats'); state.chats = chats; renderChats(); } catch {}
    });
    socket.on('dm:meta', ({ chat }) => {
      const ex = state.chats.find(c => c.id === chat.id);
      if (ex) Object.assign(ex, chat);
      else state.chats.push(chat);
      renderChats();
    });

    socket.on('chat:deleted', ({ chatId }) => {
      state.chats = state.chats.filter(c => c.id !== chatId);
      delete state.chatMembersCache[chatId];
      state.unread.delete(chatId);
      if (state.call.active && state.call.chatId === chatId) leaveCall();
      if (state.chatId === chatId) {
        state.chatId = null;
        $('messages').innerHTML = '';
        $('chat-title').textContent = 'Чат';
        $('chat-peer-avatar').classList.add('hidden');
        $('btn-delete-chat').classList.add('hidden');
        if (state.chats[0]) selectChat(state.chats[0].id);
      }
      renderChats();
    });
    socket.on('chat:members-changed', ({ chatId }) => {
      delete state.chatMembersCache[chatId];
      if (!$('members-modal').classList.contains('hidden') && state.chatId === chatId) openMembersModal();
    });
    socket.on('users:changed', async () => {
      await loadUsers();
      state.chatMembersCache = {};
      if (state.chatId) selectChat(state.chatId, true);
    });
    socket.on('typing', ({ username, full_name, typing }) => {
      $('typing').textContent = typing ? ((full_name || username) + ' печатает...') : '';
    });
    socket.on('mention', payload => {
      showMentionToast(payload);
      playNotificationSound();
      const chat = state.chats.find(c => c.id === payload.chatId);
      const title = (payload.from && (payload.from.full_name || payload.from.username)) || 'Упоминание';
      const prefix = chat ? (chat.type === 'dm' ? '' : '#' + chat.name + ': ') : '';
      notifyUser(title + ' упомянул(а) вас', prefix + (payload.body || ''), payload.chatId);
      if (payload.chatId !== state.chatId) { state.unread.add(payload.chatId); renderChats(); }
      unreadCount++;
      updateTitle();
    });

    // УДАЛЁННЫЙ РАБОЧИЙ СТОЛ
    socket.on('remote:request', (payload) => {
      if (state.remote.accepted || state.remote.active) {
        state.socket.emit('remote:reject', { toUserId: payload.from.id });
        return;
      }
      showRemoteRequest(payload);
    });
    socket.on('remote:reject', () => {
      state.remote.pending = false;
      state.remote.userId = null;
      alert('Запрос удалённого управления отклонён');
    });
    socket.on('remote:offer', async ({ fromUserId, sdp }) => {
      console.log('[remote] A: got offer');
      if (!state.remote.userId || state.remote.userId !== fromUserId) return;
      if (!window.a22desktop || !window.a22desktop.isDesktop) { stopRemoteSession(); return; }

      const pc = new RTCPeerConnection(state.call.iceConfig || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const dc = pc.createDataChannel('control', { ordered: true });
      dc.onopen = () => {
        console.log('[remote] A: dc OPEN — starting capture');
        startRemoteCapture();
      };
      dc.onclose = () => console.log('[remote] A: dc CLOSED');
      state.remote.dataChannel = dc;
      state.remote.pc = pc;

      const remoteStream = new MediaStream();
      pc.ontrack = (e) => {
        console.log('[remote] A: ontrack', e.track.kind);
        remoteStream.addTrack(e.track);
        state.remote.remoteStream = remoteStream;
        const v = document.getElementById('remote-viewer-video');
        if (v) { v.srcObject = remoteStream; v.play().catch(()=>{}); }
        document.getElementById('remote-viewer').classList.remove('hidden');
      };
      pc.onicecandidate = (e) => { if (e.candidate) state.socket.emit('remote:ice', { toUserId: fromUserId, candidate: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => console.log('[remote] A: pc state', pc.connectionState);

      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.socket.emit('remote:answer', { toUserId: fromUserId, sdp: answer.sdp });
      state.remote.active = true;
      state.remote.userId = fromUserId;
      updateRemoteUI();

      setTimeout(() => {
        if (!state.remote._capturing) {
          console.log('[remote] A: force-start after timeout');
          startRemoteCapture();
        }
      }, 1500);
    });
    socket.on('remote:answer', async ({ sdp }) => {
      if (!state.remote.pc) return;
      try { await state.remote.pc.setRemoteDescription({ type: 'answer', sdp }); } catch {}
    });
    socket.on('remote:ice', async ({ candidate }) => {
      if (!state.remote.pc) return;
      try { await state.remote.pc.addIceCandidate(candidate); } catch {}
    });
    socket.on('remote:stop', () => stopRemoteSession());

    // УПРАВЛЕНИЕ ВКЛАДКОЙ
    socket.on('control:request', payload => showControlRequest(payload));
    socket.on('control:response', payload => onControlResponse(payload));
    socket.on('control:event', payload => handleControlEvent(payload));
    socket.on('control:stop', () => {
      if (state.control.active) { stopControl(true); alert('Управление остановлено'); }
      if (state.control.remoteActive) stopControl(true);
    });

    // ЗВОНКИ
    socket.on('call:active', ({ chatId }) => {
      const c = state.chats.find(x => x.id === chatId);
      if (c) c.call_active = true;
      renderChats();
      updateCallButtons();
    });
    socket.on('call:inactive', ({ chatId }) => {
      const c = state.chats.find(x => x.id === chatId);
      if (c) c.call_active = false;
      renderChats();
      updateCallButtons();
    });
    socket.on('call:state', ({ chatId, participants }) => {
      if (!state.call.active || state.call.chatId !== chatId) return;
      state.call.participants = new Map();
      participants.forEach(p => {
        if (p.userId !== state.user.id) state.call.participants.set(p.userId, p);
      });
      renderCallUI();
    });
    socket.on('call:joined', async ({ chatId, existingParticipants }) => {
      if (!state.call.active || state.call.chatId !== chatId) return;
      state.call.participants = new Map();
      existingParticipants.forEach(p => state.call.participants.set(p.userId, p));
      renderCallUI();
      for (const p of existingParticipants) {
        scheduleRelayFallback(p.userId);
        await createOfferTo(p.userId);
      }
    });
    socket.on('call:participant-joined', ({ chatId, userId, username, full_name, avatar }) => {
      if (!state.call.active || state.call.chatId !== chatId) return;
      state.call.participants.set(userId, { userId, username, full_name, avatar, muted: false, video: true, screen: false });
      scheduleRelayFallback(userId);
      renderCallUI();
    });
    socket.on('call:participant-left', ({ chatId, userId }) => {
      if (!state.call.active || state.call.chatId !== chatId) return;
      const pc = state.call.peers.get(userId);
      if (pc) { try { pc.close(); } catch {} }
      state.call.peers.delete(userId);
      state.call.remoteStreams.delete(userId);
      state.call.participants.delete(userId);
      renderCallUI();
    });
    socket.on('call:ended', ({ chatId }) => {
      if (state.call.active && state.call.chatId === chatId) leaveCall();
      const c = state.chats.find(x => x.id === chatId);
      if (c) c.call_active = false;
      renderChats();
      updateCallButtons();
      if (state.pendingRing && state.pendingRing.chatId === chatId) hideIncomingCall();
    });
    socket.on('call:signal', async ({ chatId, fromUserId, signal }) => {
      if (!state.call.active || state.call.chatId !== chatId) return;
      let pc = state.call.peers.get(fromUserId);
      if (!pc) pc = createPeerConnection(fromUserId);
      try {
        if (signal.kind === 'offer') {
          if (signal.relay && !state.call.relayForced.has(fromUserId)) {
            state.call.relayForced.add(fromUserId);
            if (pc) { try { pc.close(); } catch {} state.call.peers.delete(fromUserId); }
            pc = createPeerConnection(fromUserId, { forceRelay: true });
          }
          await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          await flushPendingCandidates(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          state.socket.emit('call:signal', {
            chatId, toUserId: fromUserId,
            signal: { kind: 'answer', sdp: answer.sdp }
          });
        } else if (signal.kind === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          await flushPendingCandidates(pc);
        } else if (signal.kind === 'candidate' && signal.candidate) {
          if (!pc.remoteDescription || !pc.remoteDescription.type) {
            pc._pendingCandidates.push(signal.candidate);
          } else {
            try { await pc.addIceCandidate(signal.candidate); } catch {}
          }
        }
      } catch (e) { console.warn('signal', e); }
    });
    socket.on('call:ring', ({ chatId, from, isDm, chatName }) => {
      if (state.call.active) {
        if (isDm !== false) state.socket.emit('call:decline', { chatId });
        return;
      }
      if (state.pendingRing && state.pendingRing.chatId !== chatId) {
        state.socket.emit('call:decline', { chatId: state.pendingRing.chatId });
      }
      showIncomingCall({ chatId, from, isDm, chatName });
    });
    socket.on('call:ring-stop', () => hideIncomingCall());
    socket.on('call:ring-cancelled', () => hideIncomingCall());
    socket.on('call:ring-timeout', () => { hideIncomingCall(); alert('Абонент не ответил'); });
    socket.on('call:declined', () => { hideIncomingCall(); alert('Звонок отклонён'); });
    socket.on('call:ring-accepted', () => stopRingtone());
  }

  // ============================================================
  // ВХОДЯЩИЙ ЗВОНОК
  // ============================================================
  function showIncomingCall({ chatId, from, chatName, isDm }) {
    state.pendingRing = { chatId, from };
    renderAvatar($('incoming-avatar'), from);
    $('incoming-name').textContent = displayName(from);
    const sub = document.querySelector('.incoming-call-sub');
    if (sub) sub.textContent = isDm === false
      ? ('Звонок в «' + (chatName || '') + '»')
      : 'Входящий звонок…';
    $('incoming-call').classList.remove('hidden');
    startRingtone();
    const title = displayName(from) + (isDm === false ? ' звонит в «' + (chatName || '') + '»' : ' звонит вам');
    notifyUser(title, 'Нажмите, чтобы принять звонок', chatId);
  }
  function hideIncomingCall() {
    state.pendingRing = null;
    $('incoming-call').classList.add('hidden');
    stopRingtone();
  }
  $('btn-incoming-decline').onclick = () => {
    if (!state.pendingRing) return;
    const cid = state.pendingRing.chatId;
    state.socket.emit('call:decline', { chatId: cid });
    hideIncomingCall();
  };
  $('btn-incoming-accept').onclick = async () => {
    if (!state.pendingRing) return;
    const cid = state.pendingRing.chatId;
    hideIncomingCall();
    await selectChat(cid);
    await startCall();
  };

  // ============================================================
  // BEFOREUNLOAD
  // ============================================================
  window.addEventListener('beforeunload', (e) => {
    if (state.call.active || state.remote.active || state.remote.accepted) {
      e.preventDefault();
      e.returnValue = '';
    }
  });


  window.__a22State = state;
  window.__a22RemoteDebug = () => ({
    patched: !!window.__a22Patched,
    nativeControl: !!window.__a22UseNativeControl,
    hasHandleControlEvent: typeof window.handleControlEvent === 'function',
    remoteActive: state.remote.active,
    remoteAccepted: state.remote.accepted,
    dcState: state.remote.dataChannel ? state.remote.dataChannel.readyState : null,
    pcState: state.remote.pc ? state.remote.pc.connectionState : null,
    capturing: !!state.remote._capturing
  });
  window.handleControlEvent = handleControlEvent;
  console.log('[app] debug helpers installed');


  if (window.a22desktop && typeof window.a22desktop.onOpenChat === 'function') {
    window.a22desktop.onOpenChat((data) => {
      if (data && data.chatId) {
        const id = Number(data.chatId);
        if (state.chats.find(c => c.id === id)) selectChat(id);
      }
    });
  }


  // Страховка: делегирование клика по кнопке логов
  document.addEventListener('click', function(ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest('#btn-admin-logs') : null;
    if (!btn) return;
    ev.preventDefault();
    console.log('[a22/admin] logs button clicked (delegated)');
    if (typeof openAdminLogs === 'function') {
      openAdminLogs().catch(err => {
        console.error('[a22/admin] openAdminLogs failed', err);
        alert('Ошибка: ' + err.message);
      });
    } else {
      alert('openAdminLogs не определён');
    }
  }, true); // capture=true — ловит раньше inline-onclick




  // ============================================================
  // АДМИН: ЛОГИ СИСТЕМЫ
  // ============================================================
  let logsAutoTimer = null;

  function ensureLogsModal() {
    let modal = document.getElementById('admin-logs-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'admin-logs-modal';
    modal.className = 'modal hidden';
    modal.innerHTML = ''
      + '<div class="modal-card admin-logs-card">'
      + '  <div class="logs-header">'
      + '    <h3>Логи системы</h3>'
      + '    <div class="logs-header-actions">'
      + '      <span id="logs-total" class="logs-total"></span>'
      + '      <button id="btn-logs-close" class="u-btn" title="Закрыть">✕</button>'
      + '    </div>'
      + '  </div>'
      + '  <div class="logs-filters">'
      + '    <select id="logs-user"><option value="">Все пользователи</option></select>'
      + '    <select id="logs-source"><option value="">Все источники</option></select>'
      + '    <select id="logs-cat"><option value="">Все категории</option></select>'
      + '    <input id="logs-search" placeholder="Поиск по тексту..." />'
      + '    <button id="btn-logs-refresh" type="button">Обновить</button>'
      + '    <button id="btn-logs-export" type="button">Экспорт</button>'
      + '    <button id="btn-logs-purge" type="button" class="danger-btn-small">Очистить старые</button>'
      + '  </div>'
      + '  <div class="logs-table-wrap">'
      + '    <table id="logs-table">'
      + '      <thead><tr>'
      + '        <th style="width:150px">Время</th>'
      + '        <th style="width:130px">Пользователь</th>'
      + '        <th style="width:90px">Источник</th>'
      + '        <th style="width:100px">Категория</th>'
      + '        <th>Сообщение</th>'
      + '        <th style="width:300px">Данные</th>'
      + '      </tr></thead>'
      + '      <tbody></tbody>'
      + '    </table>'
      + '  </div>'
      + '  <div class="logs-info">'
      + '    <span id="logs-count">0 записей</span>'
      + '    <span class="muted">Автообновление:</span>'
      + '    <label class="logs-auto"><input type="checkbox" id="logs-auto" /> каждые 5 сек</label>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(modal);
    return modal;
  }

  async function openAdminLogs() {
    if (!state.user) { alert('Не залогинен'); return; }
    if (!state.user.is_admin) { alert('Только для админа'); return; }
    const modal = ensureLogsModal();
    modal.classList.remove('hidden');
    try {
      if (typeof window.a22Log === 'function') window.a22Log('admin', 'logs modal opened');
      await loadLogMeta();
      await loadAdminLogs();
    } catch (e) {
      alert('Ошибка загрузки логов: ' + (e.message || e));
    }
  }

  async function loadLogMeta() {
    const uSel = document.getElementById('logs-user');
    const sSel = document.getElementById('logs-source');
    const cSel = document.getElementById('logs-cat');
    if (!uSel || !sSel || !cSel) return;
    try {
      const data = await api('api/admin/logs/meta');
      uSel.innerHTML = '<option value="">Все пользователи</option>';
      sSel.innerHTML = '<option value="">Все источники</option>';
      cSel.innerHTML = '<option value="">Все категории</option>';
      (data.users || []).forEach(u => {
        const o = document.createElement('option');
        o.value = u.user_id;
        o.textContent = u.username || ('user#' + u.user_id);
        uSel.appendChild(o);
      });
      (data.sources || []).forEach(s => {
        const o = document.createElement('option');
        o.value = s; o.textContent = s;
        sSel.appendChild(o);
      });
      (data.cats || []).forEach(c => {
        const o = document.createElement('option');
        o.value = c; o.textContent = c;
        cSel.appendChild(o);
      });
      const totalEl = document.getElementById('logs-total');
      if (totalEl) totalEl.textContent = 'всего: ' + (data.total || 0);
    } catch (e) {
      console.warn('loadLogMeta', e);
    }
  }

  function buildLogsQuery(limit) {
    const q = new URLSearchParams();
    const u = document.getElementById('logs-user');
    const s = document.getElementById('logs-source');
    const c = document.getElementById('logs-cat');
    const search = document.getElementById('logs-search');
    if (u && u.value) q.set('userId', u.value);
    if (s && s.value) q.set('source', s.value);
    if (c && c.value) q.set('cat', c.value);
    if (search && search.value.trim()) q.set('q', search.value.trim());
    q.set('limit', String(limit || 500));
    return q.toString();
  }

  async function loadAdminLogs() {
    const tbody = document.querySelector('#logs-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#8a8886;padding:16px">Загрузка...</td></tr>';
    try {
      const { logs } = await api('api/admin/logs?' + buildLogsQuery(500));
      renderLogsTable(logs);
      const cntEl = document.getElementById('logs-count');
      if (cntEl) cntEl.textContent = (logs || []).length + ' записей';
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:#d13438;padding:16px">Ошибка: ' + (e.message || e) + '</td></tr>';
    }
  }

  function renderLogsTable(logs) {
    const tbody = document.querySelector('#logs-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!logs || !logs.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#8a8886;padding:20px">Пусто</td></tr>';
      return;
    }
    const frag = document.createDocumentFragment();
    logs.forEach(l => {
      const tr = document.createElement('tr');
      const cat = String(l.cat || 'log').toLowerCase();
      if (cat.indexOf('error') !== -1) tr.className = 'log-error';
      else if (cat.indexOf('warn') !== -1) tr.className = 'log-warn';
      else tr.className = 'log-info';

      const td1 = document.createElement('td');
      td1.textContent = new Date(l.ts).toLocaleString('ru-RU');
      const td2 = document.createElement('td');
      td2.textContent = l.username || (l.user_id ? 'user#' + l.user_id : '—');
      const td3 = document.createElement('td');
      td3.textContent = l.source || '—';
      const td4 = document.createElement('td');
      td4.textContent = l.cat || '—';
      const td5 = document.createElement('td');
      td5.textContent = l.msg || '';
      const td6 = document.createElement('td');
      td6.textContent = l.data || '';
      td6.style.fontSize = '11px';
      td6.style.color = '#666';

      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      tr.appendChild(td4); tr.appendChild(td5); tr.appendChild(td6);
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  async function exportLogs() {
    try {
      const { logs } = await api('api/admin/logs?' + buildLogsQuery(5000));
      const lines = (logs || []).map(l =>
        new Date(l.ts).toISOString() + '\t' + (l.username || '—') + '\t' + (l.source || '—')
        + '\t' + (l.cat || '—') + '\t' + (l.msg || '') + '\t' + (l.data || '')
      );
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'a22-logs-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Ошибка экспорта: ' + (e.message || e));
    }
  }

  // --- Обработчики через делегирование ---
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest && ev.target.closest('#btn-admin-logs');
    if (!t) return;
    ev.preventDefault();
    if (typeof window.a22Log === 'function') window.a22Log('admin', 'logs button clicked');
    try { await openAdminLogs(); }
    catch (e) { alert('Ошибка: ' + (e.message || e)); }
  });

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('#btn-logs-close');
    if (!t) return;
    ev.preventDefault();
    const modal = document.getElementById('admin-logs-modal');
    if (modal) modal.classList.add('hidden');
    if (logsAutoTimer) { clearInterval(logsAutoTimer); logsAutoTimer = null; }
  });

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('#btn-logs-refresh');
    if (!t) return;
    ev.preventDefault();
    loadAdminLogs();
  });

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('#btn-logs-export');
    if (!t) return;
    ev.preventDefault();
    exportLogs();
  });

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest && ev.target.closest('#btn-logs-purge');
    if (!t) return;
    ev.preventDefault();
    if (!confirm('Удалить логи старше 7 дней?')) return;
    try {
      const olderThan = Date.now() - 7 * 24 * 3600 * 1000;
      const r = await api('api/admin/logs', { method: 'DELETE', body: JSON.stringify({ olderThan }) });
      alert('Удалено: ' + (r.deleted || 0));
      await loadAdminLogs();
      await loadLogMeta();
    } catch (e) { alert('Ошибка: ' + (e.message || e)); }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target && ev.target.id === 'logs-search' && ev.key === 'Enter') loadAdminLogs();
  });

  document.addEventListener('change', (ev) => {
    const id = ev.target && ev.target.id;
    if (id === 'logs-user' || id === 'logs-source' || id === 'logs-cat') loadAdminLogs();
    if (id === 'logs-auto') {
      if (ev.target.checked) logsAutoTimer = setInterval(loadAdminLogs, 5000);
      else if (logsAutoTimer) { clearInterval(logsAutoTimer); logsAutoTimer = null; }
    }
  });

  // --- Экспорт в window для onclick (на случай, если делегирование не сработает) ---
  window.openAdminLogs = openAdminLogs;
  window.loadAdminLogs = loadAdminLogs;
  window.loadLogMeta = loadLogMeta;
  window.exportLogs = exportLogs;
  console.log('[app] admin-logs functions exported OK');


  // ============================================================
  // ТЕМЫ (светлая / тёмная)
  // ============================================================
  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    const ico = document.getElementById('theme-ico');
    if (ico) ico.textContent = t === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('a22_theme', t);
    a22Log('theme', 'applied', { theme: t });
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }
  // Применяем сохранённую тему сразу
  applyTheme(localStorage.getItem('a22_theme') || 'light');

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#rail-theme');
    if (!b) return;
    e.preventDefault();
    toggleTheme();
  });


  // ============================================================
  // МОДАЛКА ЗАГРУЗКИ ДЕСКТОП-ПРИЛОЖЕНИЯ
  // ============================================================
  function openDownloadModal() {
    const m = document.getElementById('download-modal');
    if (!m) return;
    m.classList.remove('hidden');
    a22Log('download', 'modal opened');
    fetch('desktop/a22-chat-setup-1.0.0.exe', { method: 'HEAD' })
      .then(r => {
        const size = r.headers.get('content-length');
        const el = document.getElementById('dl-size');
        if (el && size) el.textContent = (Number(size)/1024/1024).toFixed(1) + ' МБ';
      })
      .catch(() => {});
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href="desktop/"]');
    if (!a) return;
    if (e.ctrlKey || e.metaKey || e.button === 1) return;
    e.preventDefault();
    openDownloadModal();
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#dl-close')) {
      document.getElementById('download-modal').classList.add('hidden');
    }
  });

  document.addEventListener('click', (e) => {
    const m = document.getElementById('download-modal');
    if (m && e.target === m) m.classList.add('hidden');
  });

  // ============================================================
  // ЭМОДЗИ-ПИКЕР
  // ============================================================
  const EMOJI_DATA = {
    smileys: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤗','🤔','🤨','😐','😑','😶','😏','😒','🙄','😬','😮‍💨','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','🤡','👻','👽','🤖'],
    gestures: ['👍','👎','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐','🖖','👋','🤝','🙏','✊','👊','🤛','🤜','👏','🙌','👐','🤲','💪','🦾','🖕','✍️','💅','🦵','🦶','👂','🦻','👃','🧠','🦷','👀','👁','👅','👄'],
    hearts: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💌','💋','😻','💐','🌹','🌷','🌺','🌸','🌼','🌻'],
    objects: ['💼','📁','📂','📅','📆','📇','📈','📉','📊','📋','📌','📍','📎','🖇','📏','📐','✂️','🗃','🗄','🗑','🔒','🔓','🔐','🔑','🗝','🔨','⚒','🛠','⚙️','🔧','🔩','⚖️','🔗','⛓','🧰','🧲','🔫','💣','🧨','🪓','🔪','🗡','⚔️','🛡','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳','💊','💉','🩸','🩹','🩺','🚪','🛏','🛋','🪑','🚽','🚿','🛁','🪒','🧴','🧷','🧹','🧺','🧻','🧼','🧽','🧯','🛒'],
    food: ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯'],
    animals: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷','🕸','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🪶','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊','🐇','🦝','🦨','🦡','🦦','🦥','🐁','🐀','🐿','🦔']
  };

  let emojiPickerOpen = false;

  function renderEmojiGrid(cat) {
    const grid = document.getElementById('emoji-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const list = EMOJI_DATA[cat] || [];
    const frag = document.createDocumentFragment();
    list.forEach(e => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-item';
      b.textContent = e;
      b.onclick = () => insertEmoji(e);
      frag.appendChild(b);
    });
    grid.appendChild(frag);
  }

  function insertEmoji(emoji) {
    const ta = document.getElementById('input');
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + emoji.length;
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function initEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    if (!picker) return;
    renderEmojiGrid('smileys');

    // Переключение категорий
    picker.querySelectorAll('.emoji-tab').forEach(tab => {
      tab.onclick = () => {
        picker.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderEmojiGrid(tab.dataset.cat);
      };
    });

    // Клик по кнопке 😊 в composer
    document.addEventListener('click', (e) => {
      // Кнопка эмодзи в composer
      const btn = e.target.closest && e.target.closest('.composer-actions .icon-btn');
      if (btn && btn.textContent.trim() === '😊') {
        e.preventDefault();
        e.stopPropagation();
        emojiPickerOpen = !emojiPickerOpen;
        picker.classList.toggle('hidden', !emojiPickerOpen);
        a22Log('emoji', emojiPickerOpen ? 'opened' : 'closed');
        return;
      }
      // Клик вне пикера — закрываем
      if (emojiPickerOpen && !e.target.closest('#emoji-picker')) {
        emojiPickerOpen = false;
        picker.classList.add('hidden');
      }
    });
  }

  // ============================================================
  // КАЛЕНДАРЬ
  // ============================================================
  let calDate = new Date();
  let calSelected = null;

  function renderCalendar() {
    const grid = document.getElementById('cal-grid');
    const header = document.getElementById('cal-month-year');
    if (!grid || !header) return;

    const year = calDate.getFullYear();
    const month = calDate.getMonth();
    header.textContent = calDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

    // Первый день месяца — какой день недели (0 = Пн)
    const firstDay = new Date(year, month, 1);
    const startWeekday = (firstDay.getDay() + 6) % 7; // Пн = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    grid.innerHTML = '';
    const today = new Date();

    // Предыдущий месяц
    for (let i = startWeekday - 1; i >= 0; i--) {
      const b = document.createElement('button');
      b.className = 'cal-day other-month';
      b.textContent = prevMonthDays - i;
      b.onclick = () => { calDate = new Date(year, month - 1, prevMonthDays - i); renderCalendar(); };
      grid.appendChild(b);
    }

    // Текущий месяц
    for (let d = 1; d <= daysInMonth; d++) {
      const b = document.createElement('button');
      b.className = 'cal-day';
      b.textContent = d;
      const thisDate = new Date(year, month, d);
      if (d === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
        b.classList.add('today');
      }
      if (calSelected && d === calSelected.getDate() && month === calSelected.getMonth() && year === calSelected.getFullYear()) {
        b.classList.add('selected');
      }
      b.onclick = () => {
        calSelected = thisDate;
        renderCalendar();
        const info = document.getElementById('cal-selected-info');
        if (info) info.textContent = thisDate.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      };
      grid.appendChild(b);
    }

    // Следующий месяц — до 6 недель в сетке
    const totalCells = grid.children.length;
    const remaining = (7 - (totalCells % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      const b = document.createElement('button');
      b.className = 'cal-day other-month';
      b.textContent = i;
      b.onclick = () => { calDate = new Date(year, month + 1, i); renderCalendar(); };
      grid.appendChild(b);
    }
  }

  function openCalendar() {
    const m = document.getElementById('calendar-modal');
    if (!m) return;
    calSelected = null;
    calDate = new Date();
    const info = document.getElementById('cal-selected-info');
    if (info) info.textContent = 'Выберите день';
    renderCalendar();
    m.classList.remove('hidden');
    a22Log('calendar', 'opened');
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#rail-calendar')) {
      e.preventDefault(); openCalendar(); return;
    }
    if (e.target.closest && e.target.closest('#cal-close')) {
      document.getElementById('calendar-modal').classList.add('hidden'); return;
    }
    if (e.target.closest && e.target.closest('#cal-prev')) {
      calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1); renderCalendar(); return;
    }
    if (e.target.closest && e.target.closest('#cal-next')) {
      calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1); renderCalendar(); return;
    }
    if (e.target.closest && e.target.closest('#cal-today')) {
      calDate = new Date(); calSelected = new Date(); renderCalendar();
      const info = document.getElementById('cal-selected-info');
      if (info) info.textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      return;
    }
  });

  // ============================================================
  // ЗВОНКИ
  // ============================================================
  function renderCallsModal() {
    const activeBox = document.getElementById('calls-active');
    const contactsBox = document.getElementById('calls-contacts');
    if (!activeBox || !contactsBox) return;

    // Активные звонки
    activeBox.innerHTML = '';
    const active = state.chats.filter(c => c.call_active);
    if (active.length) {
      const title = document.createElement('div');
      title.className = 'calls-section-title';
      title.textContent = 'Активные звонки';
      activeBox.appendChild(title);

      active.forEach(c => {
        const row = document.createElement('div');
        row.className = 'call-row';
        const av = document.createElement('span');
        av.className = 'avatar avatar-sm';
        if (c.type === 'dm' && c.peer) renderAvatar(av, c.peer);
        else { av.textContent = (c.name || '?')[0].toUpperCase(); av.style.background = '#7b83eb'; }
        row.appendChild(av);
        const info = document.createElement('div');
        info.className = 'call-row-info';
        const nm = document.createElement('div');
        nm.className = 'call-row-name';
        nm.textContent = c.name;
        const sub = document.createElement('div');
        sub.className = 'call-row-sub';
        sub.textContent = (c.call_count || 1) + ' участник(ов)';
        info.appendChild(nm); info.appendChild(sub);
        row.appendChild(info);
        const badge = document.createElement('span');
        badge.className = 'call-active-badge';
        badge.textContent = 'Идёт';
        row.appendChild(badge);
        row.onclick = () => {
          document.getElementById('calls-modal').classList.add('hidden');
          selectChat(c.id);
          if (!state.call.active) startCall();
        };
        activeBox.appendChild(row);
      });
    }

    // Контакты — быстрый звонок
    contactsBox.innerHTML = '';
    state.userList.filter(u => u.id !== state.user.id).forEach(u => {
      const row = document.createElement('div');
      row.className = 'call-row';
      const av = document.createElement('span');
      av.className = 'avatar avatar-sm';
      const isOnline = state.onlineIds.includes(u.id);
      if (isOnline) av.classList.add('online');
      renderAvatar(av, u);
      row.appendChild(av);

      const info = document.createElement('div');
      info.className = 'call-row-info';
      const nm = document.createElement('div');
      nm.className = 'call-row-name';
      nm.textContent = displayName(u);
      const sub = document.createElement('div');
      sub.className = 'call-row-sub';
      sub.textContent = isOnline ? 'В сети' : 'Не в сети';
      info.appendChild(nm); info.appendChild(sub);
      row.appendChild(info);

      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.title = 'Позвонить';
      btn.textContent = '📞';
      btn.onclick = (e) => {
        e.stopPropagation();
        document.getElementById('calls-modal').classList.add('hidden');
        startDmCall(u.id);
      };
      row.appendChild(btn);

      row.onclick = () => {
        document.getElementById('calls-modal').classList.add('hidden');
        startDmCall(u.id);
      };
      contactsBox.appendChild(row);
    });
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#rail-calls')) {
      e.preventDefault();
      renderCallsModal();
      document.getElementById('calls-modal').classList.remove('hidden');
      return;
    }
    if (e.target.closest && e.target.closest('#calls-close')) {
      document.getElementById('calls-modal').classList.add('hidden');
      return;
    }
  });

  // Прочие кнопки rail
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#rail-teams')) {
      e.preventDefault();
      // Прокрутить к «Контакты»
      const el = document.querySelector('.list-section-title');
      if (el) {
        // Открыть мобильный сайдбар, если закрыт
        if (window.matchMedia('(max-width: 900px)').matches) {
          document.querySelector('.chat-list')?.classList.add('open');
          document.getElementById('sidebar-overlay')?.classList.remove('hidden');
        }
        const ul = document.getElementById('colleagues');
        if (ul) ul.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    if (e.target.closest && e.target.closest('#rail-files')) {
      e.preventDefault();
      if (typeof a22Log === 'function') a22Log('files', 'opening sharepoint');
      window.open('/drive/', '_blank');
      return;
    }
    if (e.target.closest && e.target.closest('#rail-chat')) {
      e.preventDefault();
      return;
    }
  });

  boot();

  // Прямая привязка кнопки (fallback)
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btn-admin-logs');
    if (btn && !btn._a22Bound) {
      btn._a22Bound = true;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof window.openAdminLogs === 'function') {
          window.openAdminLogs();
        } else {
          alert('Логи: функция не загружена. Ctrl+Shift+R.');
        }
      });
      console.log('[app] admin-logs button bound directly');
    }
  });
  // Если DOM уже загружен
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => {
      const btn = document.getElementById('btn-admin-logs');
      if (btn && !btn._a22Bound) {
        btn._a22Bound = true;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          if (typeof window.openAdminLogs === 'function') window.openAdminLogs();
        });
        console.log('[app] admin-logs button bound directly (immediate)');
      }
    }, 100);
  }
})();
