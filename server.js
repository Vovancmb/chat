const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 25 * 1024 * 1024;

const ICE_SERVERS = [];
if (process.env.STUN_URL) {
  ICE_SERVERS.push({ urls: process.env.STUN_URL.split(',').map(s => s.trim()).filter(Boolean) });
} else {
  ICE_SERVERS.push({ urls: ['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302'] });
}
if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_PASS) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URL.split(',').map(s => s.trim()).filter(Boolean),
    username: process.env.TURN_USER,
    credential: process.env.TURN_PASS
  });
}

const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE, password TEXT, is_admin INTEGER DEFAULT 0,
  full_name TEXT, avatar TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE, created_by INTEGER, created_at INTEGER,
  type TEXT DEFAULT 'chat', dm_key TEXT
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER, user_id INTEGER, added_at INTEGER,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER, user_id INTEGER, username TEXT, body TEXT, created_at INTEGER,
  attachment_url TEXT, attachment_name TEXT, attachment_type TEXT, attachment_size INTEGER
);
`);
try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE chat_members ADD COLUMN last_read_at INTEGER DEFAULT 0'); } catch(e) {}
db.exec(`
CREATE TABLE IF NOT EXISTS client_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  source TEXT,
  cat TEXT,
  msg TEXT,
  data TEXT,
  ts INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_client_logs_ts ON client_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_client_logs_user ON client_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_client_logs_cat ON client_logs(cat);
CREATE INDEX IF NOT EXISTS idx_client_logs_source ON client_logs(source);
`);

try { db.exec('ALTER TABLE users ADD COLUMN full_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE channels ADD COLUMN type TEXT DEFAULT \'chat\''); } catch(e) {}
try { db.exec('ALTER TABLE channels ADD COLUMN dm_key TEXT'); } catch(e) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_dm_key ON channels(dm_key) WHERE dm_key IS NOT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN attachment_url TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN attachment_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN attachment_type TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN attachment_size INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER'); } catch(e) {}

['general','random','dev'].forEach(n =>
  db.prepare('INSERT OR IGNORE INTO channels (name, created_at) VALUES (?, ?)').run(n, Date.now())
);

// ============================================================
// Логирование на сервере
// ============================================================
function slog(level, msg, data) {
  try {
    db.prepare('INSERT INTO client_logs (user_id, username, source, cat, msg, data, ts, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(null, null, 'server', String(level).slice(0,50), String(msg).slice(0,1000),
           data !== undefined ? String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0,3000) : null,
           Date.now(), Date.now());
  } catch (e) {
    console.error('[slog] failed:', e.message);
  }
}
global.slog = slog;

// Очистка логов старше 7 дней
try {
  const del = db.prepare('DELETE FROM client_logs WHERE created_at < ?').run(Date.now() - 7*24*3600*1000);
  if (del.changes) console.log('[slog] purged old logs:', del.changes);
} catch {}

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (ADMIN_USERNAME && ADMIN_PASSWORD) {
  const ex = db.prepare('SELECT * FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (!ex) {
    db.prepare('INSERT INTO users (username,password,is_admin,created_at) VALUES (?,?,1,?)')
      .run(ADMIN_USERNAME, bcrypt.hashSync(ADMIN_PASSWORD, 10), Date.now());
    console.log('✅ Админ создан: ' + ADMIN_USERNAME);
  } else if (!ex.is_admin) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(ex.id);
    console.log('✅ Повышен до админа: ' + ADMIN_USERNAME);
  }
}

const orphans = db.prepare(`SELECT c.id, c.created_by FROM channels c
  WHERE NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id) AND (c.type IS NULL OR c.type='chat')`).all();
if (orphans.length) {
  const ids = db.prepare('SELECT id FROM users').all();
  for (const c of orphans) for (const u of ids)
    db.prepare('INSERT OR IGNORE INTO chat_members (chat_id,user_id,added_at) VALUES (?,?,?)').run(c.id, u.id, Date.now());
  console.log('✅ Участники добавлены в ' + orphans.length + ' чатов');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800')
}));
app.use(express.static(path.join(__dirname, 'public')));

const sign = u => jwt.sign({ id: u.id, username: u.username, is_admin: u.is_admin ? 1 : 0 },
  JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const t = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'unauthorized' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'invalid token' }); }
}
function adminOnly(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'только для админа' });
  next();
}
function chatMember(req, res, next) {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?').get(id, req.user.id);
  if (!m) return res.status(403).json({ error: 'вы не участник этого чата' });
  next();
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const publicUser = id => {
  const u = db.prepare('SELECT id,username,is_admin,full_name,avatar FROM users WHERE id=?').get(id);
  return u ? { ...u, is_admin: !!u.is_admin, full_name: u.full_name || '', avatar: u.avatar || '' } : null;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').slice(0, 12).replace(/[^.a-zA-Z0-9]/g, '');
    cb(null, crypto.randomUUID() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

function fixFilename(name) {
  if (!name) return 'file';
  // multer читает originalname как latin1, хотя байты на самом деле UTF-8
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    // если после конвертации получилась валидная строка (нет replacement char) — берём её
    if (!fixed.includes('\uFFFD') && fixed.length > 0) return fixed;
  } catch (e) {}
  return name;
}

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  // логируем ниже в самом обработчике
  if (!req.file) return res.status(400).json({ error: 'файл не получен' });
  slog('info', 'File uploaded', { by: req.user.username, name: req.file.originalname, size: req.file.size, type: req.file.mimetype });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: fixFilename(req.file.originalname),
    type: req.file.mimetype || 'application/octet-stream',
    size: req.file.size
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'файл слишком большой (макс 25 МБ)' });
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    slog('error', 'Express error', { path: req.path, method: req.method, err: err.message, stack: (err.stack||'').slice(0,1000) });
    return res.status(500).json({ error: 'server error' });
  }
  next();
});

// ============================================================
// HTTP_LOG_MW — логируем все запросы кроме обычных GET
// ============================================================
app.use((req, res, next) => {
  const t0 = Date.now();
  const isAuth = !!(req.user);
  const username = isAuth ? req.user.username : null;
  const method = req.method;
  const path = req.path;

  res.on('finish', () => {
    const dur = Date.now() - t0;
    const status = res.statusCode;

    // Пропускаем обычные GET, если всё ок и быстро
    if (method === 'GET' && status < 400 && dur < 500) return;
    // Пропускаем запросы самого логгера, иначе цикл
    if (path === '/api/logs' || path.startsWith('/api/admin/logs')) return;

    let cat = 'http';
    if (status >= 500) cat = 'http-error';
    else if (status >= 400) cat = 'http-warn';
    else if (dur > 1000) cat = 'http-slow';

    slog(cat, method + ' ' + path, {
      status: status,
      dur: dur,
      user: username,
      ip: req.ip,
      size: res.getHeader('content-length') || null
    });
  });

  next();
});

app.get('/api/ice', auth, (req, res) => res.json({ iceServers: ICE_SERVERS }));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'нужны логин и пароль' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password)) return res.status(401).json({ error: 'неверные данные' });
  const user = publicUser(u.id);
  slog('info', 'User login', { username: u.username, ip: req.ip });
  res.cookie('token', sign(user), { httpOnly: true, sameSite: 'lax', secure: true, path: '/', domain: '.a22mail.ru', maxAge: 30*24*3600*1000 });
  res.json({ user });
});
app.post('/api/logout', (req, res) => {
  if (req.cookies && req.cookies.token) {
    try { const u = jwt.verify(req.cookies.token, JWT_SECRET); slog('info', 'User logout', { username: u.username }); } catch {}
  }
  res.clearCookie('token'); res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => {
  const u = publicUser(req.user.id);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: u });
});

app.patch('/api/me', auth, (req, res) => {
  const { full_name, avatar } = req.body || {};
  const parts = [], args = [];
  if (typeof full_name === 'string') { parts.push('full_name = ?'); args.push(full_name.trim().slice(0,100)); }
  if (typeof avatar === 'string') {
    if (avatar.length > 1_500_000) return res.status(400).json({ error: 'аватар слишком большой' });
    parts.push('avatar = ?'); args.push(avatar);
  }
  if (parts.length) {
    args.push(req.user.id);
    db.prepare('UPDATE users SET ' + parts.join(', ') + ' WHERE id = ?').run(...args);
    io.emit('users:changed');
  }
  res.json({ user: publicUser(req.user.id) });
});

// ---------- ЛОГИ ----------
app.post('/api/logs', auth, (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) return res.json({ ok: true, saved: 0 });
  const stmt = db.prepare('INSERT INTO client_logs (user_id, username, source, cat, msg, data, ts, created_at) VALUES (?,?,?,?,?,?,?,?)');
  const now = Date.now();
  let saved = 0;
  try {
    const tx = db.transaction((rows) => {
      for (const e of rows.slice(0, 200)) {
        stmt.run(req.user.id, req.user.username,
          String(e.source || 'web').slice(0,20),
          String(e.cat || 'log').slice(0,50),
          String(e.msg || '').slice(0,1000),
          e.data !== undefined ? String(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)).slice(0,3000) : null,
          Number(e.ts) || now, now);
        saved++;
      }
    });
    tx(entries);
  } catch (e) {
    console.error('[logs] insert failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, saved });
});

app.get('/api/admin/logs', auth, adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  const userId = req.query.userId ? Number(req.query.userId) : null;
  const source = req.query.source ? String(req.query.source).slice(0,20) : null;
  const cat    = req.query.cat    ? String(req.query.cat).slice(0,50)   : null;
  const q      = req.query.q      ? String(req.query.q).slice(0,200)    : null;
  const since  = req.query.since  ? Number(req.query.since)             : null;

  let sql = 'SELECT * FROM client_logs WHERE 1=1';
  const args = [];
  if (userId) { sql += ' AND user_id = ?'; args.push(userId); }
  if (source) { sql += ' AND source = ?'; args.push(source); }
  if (cat)    { sql += ' AND cat = ?'; args.push(cat); }
  if (since)  { sql += ' AND ts >= ?'; args.push(since); }
  if (q) {
    sql += ' AND (msg LIKE ? OR data LIKE ? OR username LIKE ?)';
    const like = '%' + q + '%';
    args.push(like, like, like);
  }
  sql += ' ORDER BY ts DESC LIMIT ?';
  args.push(limit);

  let rows = [];
  try { rows = db.prepare(sql).all(...args); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ logs: rows });
});

app.get('/api/admin/logs/meta', auth, adminOnly, (req, res) => {
  const users = db.prepare('SELECT DISTINCT user_id, username FROM client_logs WHERE user_id IS NOT NULL ORDER BY username').all();
  const sources = db.prepare('SELECT DISTINCT source FROM client_logs ORDER BY source').all().map(r => r.source);
  const cats = db.prepare('SELECT DISTINCT cat FROM client_logs ORDER BY cat').all().map(r => r.cat);
  const total = db.prepare('SELECT COUNT(*) AS c FROM client_logs').get().c;
  res.json({ users, sources, cats, total });
});

app.delete('/api/admin/logs', auth, adminOnly, (req, res) => {
  const { olderThan } = req.body || {};
  let deleted = 0;
  try {
    const info = olderThan
      ? db.prepare('DELETE FROM client_logs WHERE created_at < ?').run(Number(olderThan))
      : db.prepare('DELETE FROM client_logs').run();
    deleted = info.changes;
    slog('info', 'Logs purged by admin', { by: req.user.username, deleted });
  } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, deleted });
});

app.get('/api/users', auth, (req, res) => {
  const users = db.prepare('SELECT id,username,is_admin,full_name,avatar,created_at FROM users ORDER BY id').all();
  res.json({ users: users.map(u => ({ ...u, is_admin: !!u.is_admin, full_name: u.full_name||'', avatar: u.avatar||'' })) });
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, is_admin, full_name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'нужны логин и пароль' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'логин: 3-32 символа (a-z, 0-9, _ . -)' });
  if (password.length < 4) return res.status(400).json({ error: 'пароль минимум 4 символа' });
  try {
    const info = db.prepare('INSERT INTO users (username,password,is_admin,full_name,created_at) VALUES (?,?,?,?,?)')
      .run(username, bcrypt.hashSync(password,10), is_admin ? 1 : 0, (full_name||'').trim().slice(0,100), Date.now());
    io.emit('users:changed');
    res.json({ user: publicUser(info.lastInsertRowid) });
  } catch { res.status(400).json({ error: 'логин уже занят' }); }
});

app.patch('/api/users/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const { username, full_name } = req.body || {};
  const u = db.prepare('SELECT id,username FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'пользователь не найден' });
  const parts = [], args = [];
  if (typeof username === 'string' && username && username !== u.username) {
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'логин: 3-32 символа' });
    if (db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(username, id))
      return res.status(400).json({ error: 'логин занят' });
    parts.push('username = ?'); args.push(username);
  }
  if (typeof full_name === 'string') { parts.push('full_name = ?'); args.push(full_name.trim().slice(0,100)); }
  if (parts.length) {
    args.push(id);
    try {
      db.prepare('UPDATE users SET ' + parts.join(', ') + ' WHERE id = ?').run(...args);
      if (typeof username === 'string' && username) db.prepare('UPDATE messages SET username=? WHERE user_id=?').run(username, id);
      io.emit('users:changed');
    } catch { return res.status(400).json({ error: 'не удалось обновить' }); }
  }
  res.json({ ok: true });
});

app.post('/api/users/:id/password', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'пароль минимум 4 символа' });
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(id)) return res.status(404).json({ error: 'не найден' });
  slog('warn', 'Password changed', { by: req.user.username, targetId: id });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(password,10), id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'нельзя удалить себя' });
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(id)) return res.status(404).json({ error: 'не найден' });
  slog('warn', 'User deleted', { by: req.user.username, userId: id });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  db.prepare('DELETE FROM chat_members WHERE user_id=?').run(id);
  io.emit('users:changed');
  res.json({ ok: true });
});

// ---------- ЧАТЫ И DM ----------
function decorateChat(row, meId) {
  const out = {
    id: row.id, name: row.name, type: row.type || 'chat',
    created_by: row.created_by, created_at: row.created_at,
    members_count: row.members_count,
    call_active: calls.has(row.id),
    call_count: calls.has(row.id) ? calls.get(row.id).participants.size : 0
  };
  if (out.type === 'dm') {
    const peer = db.prepare(`SELECT u.id, u.username, u.full_name, u.avatar
      FROM users u JOIN chat_members m ON m.user_id = u.id
      WHERE m.chat_id = ? AND u.id != ? LIMIT 1`).get(row.id, meId);
    out.peer = peer ? { ...peer, full_name: peer.full_name||'', avatar: peer.avatar||'' } : null;
    out.name = out.peer ? (out.peer.full_name || out.peer.username) : 'Личный чат';
  }
  return out;
}

app.get('/api/chats', auth, (req, res) => {
  const meId = req.user.id;
  const chats = db.prepare(`
    SELECT c.id, c.name, c.type, c.created_by, c.created_at,
           (SELECT COUNT(*) FROM chat_members WHERE chat_id=c.id) AS members_count,
           (SELECT MAX(created_at) FROM messages WHERE channel_id=c.id) AS last_message_at,
           (SELECT body FROM messages WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) AS last_message_body,
           (SELECT attachment_name FROM messages WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) AS last_message_attach,
           (SELECT attachment_type FROM messages WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) AS last_message_attach_type,
           (SELECT user_id FROM messages WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) AS last_message_user_id,
           (SELECT COUNT(*) FROM messages msg
            WHERE msg.channel_id = c.id
              AND msg.user_id != ?
              AND msg.created_at > COALESCE(m.last_read_at, 0)) AS unread_count
    FROM channels c
    JOIN chat_members m ON m.chat_id = c.id
    WHERE m.user_id = ?
    ORDER BY COALESCE((SELECT MAX(created_at) FROM messages WHERE channel_id=c.id), c.created_at) DESC
  `).all(meId, meId);

  const out = chats.map(c => {
    const deco = decorateChat(c, meId);
    deco.last_message_at = c.last_message_at || c.created_at;
    deco.last_message_user_id = c.last_message_user_id;
    deco.unread_count = c.unread_count || 0;

    let preview = '';
    if (c.last_message_body && c.last_message_body.trim()) {
      preview = c.last_message_body.trim();
    } else if (c.last_message_attach) {
      const t = c.last_message_attach_type || '';
      let emoji = '📎';
      if (t.startsWith('image/')) emoji = '🖼️';
      else if (t.startsWith('video/')) emoji = '🎬';
      else if (t.startsWith('audio/')) emoji = '🎵';
      preview = emoji + ' ' + c.last_message_attach;
    } else {
      preview = '';
    }
    if (preview.length > 90) preview = preview.slice(0, 90) + '…';
    deco.last_message_preview = preview;
    return deco;
  });
  res.json({ chats: out });
});

// Создать/получить DM с пользователем
app.post('/api/dm/:userId', auth, (req, res) => {
  const other = Number(req.params.userId);
  if (!other || other === req.user.id) return res.status(400).json({ error: 'нельзя открыть DM с собой' });
  const u2 = db.prepare('SELECT id FROM users WHERE id=?').get(other);
  if (!u2) return res.status(404).json({ error: 'пользователь не найден' });
  const a = Math.min(req.user.id, other);
  const b = Math.max(req.user.id, other);
  const key = 'dm:' + a + ':' + b;
  let row = db.prepare('SELECT id, name, type, created_by, created_at FROM channels WHERE dm_key=?').get(key);
  if (!row) {
    const name = '__dm__:' + a + ':' + b; // уникально, не пересекается с обычными чатами
    const info = db.prepare('INSERT INTO channels (name, created_by, created_at, type, dm_key) VALUES (?,?,?,?,?)')
      .run(name, req.user.id, Date.now(), 'dm', key);
    const chatId = info.lastInsertRowid;
    db.prepare('INSERT OR IGNORE INTO chat_members (chat_id,user_id,added_at) VALUES (?,?,?)').run(chatId, req.user.id, Date.now());
    db.prepare('INSERT OR IGNORE INTO chat_members (chat_id,user_id,added_at) VALUES (?,?,?)').run(chatId, other, Date.now());
    // уведомим второго, чтобы у него DM появился в списке
    io.to('user:' + other).emit('dm:new', { chatId });
    row = db.prepare('SELECT id, name, type, created_by, created_at FROM channels WHERE id=?').get(chatId);
  }
  // отдаём в формате chat
  const full = db.prepare(`SELECT c.id, c.name, c.type, c.created_by, c.created_at,
    (SELECT COUNT(*) FROM chat_members WHERE chat_id=c.id) AS members_count
    FROM channels c WHERE c.id=?`).get(row.id);
  const deco1 = decorateChat(full, req.user.id);
  const deco2 = decorateChat(full, other);
  io.to('user:' + other).emit('dm:meta', { chat: deco2 });
  io.to('user:' + req.user.id).emit('dm:meta', { chat: deco1 });
  slog('info', 'DM opened', { by: req.user.username, peer: other, chatId: row.id });
  res.json({ chat: deco1 });
});

app.post('/api/chats', auth, (req, res) => {
  const { name, memberIds } = req.body || {};
  if (!name || name.trim().length < 2 || name.trim().length > 40)
    return res.status(400).json({ error: 'название: 2-40 символов' });
  const clean = name.trim();
  if (clean.startsWith('__dm__:')) return res.status(400).json({ error: 'название зарезервировано' });
  try {
    const info = db.prepare('INSERT INTO channels (name,created_by,created_at,type) VALUES (?,?,?,?)')
      .run(clean, req.user.id, Date.now(), 'chat');
    const chatId = info.lastInsertRowid;
    const members = new Set([req.user.id]);
    if (Array.isArray(memberIds)) memberIds.forEach(x => members.add(Number(x)));
    for (const uid of members)
      db.prepare('INSERT OR IGNORE INTO chat_members (chat_id,user_id,added_at) VALUES (?,?,?)').run(chatId, uid, Date.now());
    const chat = { id: chatId, name: clean, type: 'chat', created_by: req.user.id, created_at: Date.now(), members_count: members.size, call_active: false, call_count: 0 };
    slog('info', 'Chat created', { by: req.user.username, chatId, name: clean, members: [...members] });
    io.emit('chat:new', { chatId, memberIds: [...members] });
    res.json({ chat });
  } catch { res.status(400).json({ error: 'чат с таким названием уже есть' }); }
});

app.delete('/api/chats/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT id, created_by, type FROM channels WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: 'чат не найден' });
  const isDm = c.type === 'dm';
  // DM может «удалить» любой участник — это скрытие для себя.
  if (!isDm && c.created_by !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: 'удалять может только создатель чата' });
  if (isDm) {
    // просто убираем себя из участников, сообщения и чат оставляем
    db.prepare('DELETE FROM chat_members WHERE chat_id=? AND user_id=?').run(id, req.user.id);
    io.to('user:' + req.user.id).emit('chat:deleted', { chatId: id });
  } else {
    db.prepare('DELETE FROM channels WHERE id=?').run(id);
    db.prepare('DELETE FROM chat_members WHERE chat_id=?').run(id);
    db.prepare('DELETE FROM messages WHERE channel_id=?').run(id);
    endCall(id, 'чат удалён');
    io.emit('chat:deleted', { chatId: id });
  }
  res.json({ ok: true });
});

app.get('/api/chats/:id/members', auth, chatMember, (req, res) => {
  const id = Number(req.params.id);
  const members = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.avatar FROM users u
    JOIN chat_members m ON m.user_id = u.id WHERE m.chat_id = ? ORDER BY u.id
  `).all(id).map(u => ({ ...u, full_name: u.full_name||'', avatar: u.avatar||'' }));
  const chat = db.prepare('SELECT id,name,type,created_by FROM channels WHERE id=?').get(id);
  res.json({ members, chat });
});

app.post('/api/chats/:id/members', auth, chatMember, (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT type FROM channels WHERE id=?').get(id);
  if (c && c.type === 'dm') return res.status(400).json({ error: 'нельзя добавлять в личный чат' });
  const userId = Number((req.body||{}).userId);
  if (!userId || !db.prepare('SELECT id FROM users WHERE id=?').get(userId))
    return res.status(404).json({ error: 'пользователь не найден' });
  db.prepare('INSERT OR IGNORE INTO chat_members (chat_id,user_id,added_at) VALUES (?,?,?)').run(id, userId, Date.now());
  const chat = db.prepare('SELECT id,name,created_by FROM channels WHERE id=?').get(id);
  slog('info', 'Chat member added', { by: req.user.username, chatId: id, memberId: userId });
  io.emit('chat:new', { chatId: id, memberIds: [userId] });
  io.emit('chat:members-changed', { chatId: id });
  res.json({ ok: true, chat });
});

app.delete('/api/chats/:id/members/:userId', auth, (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  const c = db.prepare('SELECT created_by, type FROM channels WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: 'чат не найден' });
  if (c.type === 'dm') return res.status(400).json({ error: 'нельзя изменять состав личного чата' });
  if (c.created_by !== req.user.id && userId !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: 'нет прав' });
  if (userId === c.created_by) return res.status(400).json({ error: 'нельзя удалить создателя' });
  slog('info', 'Chat member removed', { by: req.user.username, chatId: id, memberId: userId });
  db.prepare('DELETE FROM chat_members WHERE chat_id=? AND user_id=?').run(id, userId);
  io.emit('chat:members-changed', { chatId: id });
  res.json({ ok: true });
});

// ---------- НЕПРОЧИТАННЫЕ ----------
app.get('/api/unread', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.chat_id, COUNT(msg.id) AS cnt
    FROM chat_members m
    LEFT JOIN messages msg ON msg.channel_id = m.chat_id
       AND msg.created_at > COALESCE(m.last_read_at, 0)
       AND msg.user_id != m.user_id
    WHERE m.user_id = ?
    GROUP BY m.chat_id
    HAVING cnt > 0
  `).all(req.user.id);
  const counts = {};
  rows.forEach(r => { counts[r.chat_id] = r.cnt; });
  res.json({ counts });
});

app.post('/api/chats/:id/read', auth, chatMember, (req, res) => {
  const id = Number(req.params.id);
  const now = Date.now();

  db.prepare('UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?')
    .run(now, id, req.user.id);

  // Уведомляем остальных участников — у них обновятся галочки
  try {
    const others = db.prepare('SELECT user_id FROM chat_members WHERE chat_id=? AND user_id!=?').all(id, req.user.id);
    const me = publicUser(req.user.id);
    others.forEach(o => {
      io.to('user:' + o.user_id).emit('chat:read', {
        chatId: id,
        userId: req.user.id,
        username: me.username,
        full_name: me.full_name,
        readAt: now
      });
    });
    slog('info', 'Chat read', { by: req.user.username, chatId: id, notified: others.length });
  } catch (e) {
    console.error('[chat:read] emit failed:', e.message);
  }

  res.json({ ok: true, readAt: now });
});

app.get('/api/chats/:id/messages', auth, chatMember, (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare(`
    SELECT m.id, m.username, m.user_id, m.body, m.created_at,
           m.attachment_url, m.attachment_name, m.attachment_type, m.attachment_size,
           m.reply_to_id,
           u.full_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ?
    ORDER BY m.id DESC
    LIMIT 100
  `).all(id);

  const msgs = rows.map(r => {
    let reply = null;
    if (r.reply_to_id) {
      const parent = db.prepare(`
        SELECT m.id, m.username, m.body, m.attachment_name, u.full_name
        FROM messages m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.id = ?
      `).get(r.reply_to_id);
      if (parent) {
        reply = {
          id: parent.id,
          username: parent.username || '',
          full_name: parent.full_name || '',
          body: parent.body || '',
          attachment_name: parent.attachment_name || ''
        };
      }
    }
    return {
      ...r,
      full_name: r.full_name || '',
      avatar: r.avatar || '',
      reply
    };
  });

  res.json({ messages: msgs.reverse() });
});

// ---------- Socket.IO ----------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

// ============================================================
// Обёртка для socket.io: автоматически логирует все события
// ============================================================
const LOGGED_EVENTS = [
  'join','leave','message','typing',
  'call:join','call:leave','call:signal','call:ring','call:decline',
  'control:request','control:response','control:event','control:stop',
  'remote:request','remote:offer','remote:answer','remote:reject','remote:ice','remote:stop','remote:event'
];

function logSocketEvents(socket, username) {
  LOGGED_EVENTS.forEach(evt => {
    socket.on(evt, (data) => {
      let summary = null;
      try {
        if (data && typeof data === 'object') {
          const copy = {};
          Object.keys(data).forEach(k => {
            const v = data[k];
            if (typeof v === 'string') copy[k] = v.length > 120 ? v.slice(0, 120) + '…' : v;
            else if (typeof v === 'number' || typeof v === 'boolean' || v === null) copy[k] = v;
            else if (v && v.kind) copy[k] = '<' + v.kind + '>'; // signal
            else copy[k] = typeof v;
          });
          summary = copy;
        } else summary = data;
      } catch (e) { summary = '<unserializable>'; }

      try {
        slog('socket', '⬇ ' + evt, { user: username, data: summary });
      } catch (e) {}
    });
  });
}

io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie || '';
  const m = cookie.match(/(?:^|; )token=([^;]+)/);
  if (!m) return next(new Error('unauthorized'));
  try { socket.user = jwt.verify(decodeURIComponent(m[1]), JWT_SECRET); next(); }
  catch { next(new Error('unauthorized')); }
});

const online = new Map();
const calls = new Map();
// звонки, ожидающие ответа: chatId -> { fromUserId, toUserId, timer, isDm }
const ringings = new Map();

function isMember(chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?').get(chatId, userId);
}
function endCall(chatId, reason) {
  const c = calls.get(chatId);
  if (!c) return;
  calls.delete(chatId);
  io.to('call:' + chatId).emit('call:ended', { chatId, reason: reason || '' });
  io.to('chat:' + chatId).emit('call:inactive', { chatId });
}
function broadcastCallState(chatId) {
  const c = calls.get(chatId);
  if (!c) return;
  const list = [...c.participants.entries()].map(([uid, info]) => ({
    userId: uid,
    username: info.username,
    full_name: info.full_name,
    avatar: info.avatar,
    muted: !!info.muted,
    video: !!info.video,
    screen: !!info.screen
  }));
  io.to('chat:' + chatId).emit('call:state', { chatId, participants: list });
}
function cancelRinging(chatId, reason) {
  const r = ringings.get(chatId);
  if (!r) return;
  clearTimeout(r.timer);
  ringings.delete(chatId);
  io.to('user:' + r.fromUserId).emit('call:ring-cancelled', { chatId, reason: reason || '' });
  io.to('user:' + r.toUserId).emit('call:ring-cancelled', { chatId, reason: reason || '' });
}

io.on('connection', socket => {
  const u = socket.user;
  slog('info', 'Socket connected', { username: u.username });
  socket.join('user:' + u.id);
  online.set(u.id, (online.get(u.id) || 0) + 1);
  io.emit('presence', Array.from(online.keys()));

  socket.on('join', chatId => {
    const id = Number(chatId);
    if (!id || !isMember(id, u.id)) return;
    socket.join('chat:' + id);
    if (calls.has(id)) socket.emit('call:state', {
      chatId: id,
      participants: [...calls.get(id).participants.entries()].map(([uid, x]) => ({
        userId: uid, username: x.username, full_name: x.full_name, avatar: x.avatar,
        muted: !!x.muted, video: !!x.video, screen: !!x.screen
      }))
    });
  });
  socket.on('leave', chatId => { if (chatId) socket.leave('chat:' + chatId); });

  socket.on('message', ({ chatId, body, attachment, replyToId }) => {
    const id = Number(chatId);
    if (!id || !isMember(id, u.id)) return;
    const text = (body || '').toString().trim().slice(0, 4000);
    let att = null;
    if (attachment && typeof attachment === 'object' && attachment.url) {
      att = {
        url: String(attachment.url).slice(0, 500),
        name: String(attachment.name || 'file').slice(0, 255),
        type: String(attachment.type || 'application/octet-stream').slice(0, 100),
        size: Number(attachment.size) || 0
      };
      if (!att.url.startsWith('/uploads/')) att = null;
    }
    if (!text && !att) return;
    const now = Date.now();
    let replyId = null;
    let replyPayload = null;
    if (replyToId) {
      const parent = db.prepare(`
        SELECT m.id, m.user_id, m.username, m.body, m.attachment_name,
               u.full_name AS parent_full_name
        FROM messages m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.id = ? AND m.channel_id = ?
      `).get(Number(replyToId), id);
      if (parent) {
        replyId = parent.id;
        replyPayload = {
          id: parent.id,
          username: parent.username || '',
          full_name: parent.parent_full_name || '',
          body: parent.body || '',
          attachment_name: parent.attachment_name || ''
        };
      }
    }
    const info = db.prepare(`INSERT INTO messages
      (channel_id,user_id,username,body,created_at,attachment_url,attachment_name,attachment_type,attachment_size,reply_to_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, u.id, u.username, text, now,
        att ? att.url : null, att ? att.name : null, att ? att.type : null, att ? att.size : null,
        replyId);

    const me = publicUser(u.id);
    const payload = {
      id: info.lastInsertRowid, channel_id: id, user_id: u.id,
      username: u.username, full_name: me.full_name, avatar: me.avatar,
      body: text, created_at: now,
      attachment_url: att ? att.url : null,
      attachment_name: att ? att.name : null,
      attachment_type: att ? att.type : null,
      attachment_size: att ? att.size : null,
      reply_to_id: replyId,
      reply: replyPayload
    };
    // Рассылаем каждому участнику через персональную комнату — 
    // тогда событие дойдёт даже если получатель в другом чате
    try {
      const memberRows = db.prepare('SELECT user_id FROM chat_members WHERE chat_id=?').all(id);
      memberRows.forEach(r => {
        io.to('user:' + r.user_id).emit('message', payload);
      });
    } catch (e) {
      console.error('[broadcast] failed:', e.message);
      io.to('chat:' + id).emit('message', payload);
    }

    const mentioned = new Set();
    const re = /@([a-zA-Z0-9_.\-]{3,32})/g;
    let mm;
    while ((mm = re.exec(text))) mentioned.add(mm[1]);
    if (mentioned.size) {
      const chat = db.prepare('SELECT id, name, type FROM channels WHERE id=?').get(id);
      const memberIds = new Set(
        db.prepare('SELECT user_id FROM chat_members WHERE chat_id=?').all(id).map(r => r.user_id)
      );
      for (const uname of mentioned) {
        const target = db.prepare('SELECT id, username FROM users WHERE username=?').get(uname);
        if (!target || target.id === u.id || !memberIds.has(target.id)) continue;
        io.to('user:' + target.id).emit('mention', {
          chatId: id, chatName: chat && chat.type === 'dm' ? 'личном чате' : (chat ? chat.name : ''),
          messageId: payload.id, body: text, created_at: now,
          from: { id: u.id, username: u.username, full_name: me.full_name, avatar: me.avatar }
        });
      }
    }
  });

  socket.on('typing', ({ chatId, typing }) => {
    const id = Number(chatId);
    if (!id) return;
    const me = publicUser(u.id);
    socket.to('chat:' + id).emit('typing', { username: u.username, full_name: me.full_name, typing: !!typing });
  });

  // =============== ЗВОНКИ ===============

  socket.on('call:join', ({ chatId }) => {
    const cid = Number(chatId);
    if (!cid || !isMember(cid, u.id)) return;

    let call = calls.get(cid);
    if (!call) {
      call = { chatId: cid, participants: new Map() };
      calls.set(cid, call);
    }
    const me = publicUser(u.id);
    const existingList = [...call.participants.entries()].map(([uid, x]) => ({
      userId: uid, username: x.username, full_name: x.full_name, avatar: x.avatar,
      muted: !!x.muted, video: !!x.video, screen: !!x.screen
    }));

    const wasEmpty = call.participants.size === 0;
    call.participants.set(u.id, {
      socketId: socket.id,
      username: u.username,
      full_name: me.full_name,
      avatar: me.avatar,
      muted: false, video: true, screen: false,
      joinedAt: Date.now()
    });

    socket.join('call:' + cid);
    socket.emit('call:joined', { chatId: cid, existingParticipants: existingList });
    socket.to('call:' + cid).emit('call:participant-joined', {
      chatId: cid,
      userId: u.id, username: u.username,
      full_name: me.full_name, avatar: me.avatar
    });
    broadcastCallState(cid);
    io.to('chat:' + cid).emit('call:active', { chatId: cid });

    // === РИНГ ===
    const r = ringings.get(cid);
    if (r && r.toUserId === u.id) {
      // это принятие абонентом — снимаем ринг у звонящего
      clearTimeout(r.timer);
      ringings.delete(cid);
      io.to('user:' + r.fromUserId).emit('call:ring-accepted', { chatId: cid });
    } else if (!r && wasEmpty) {
      // самое первое присоединение — звоним остальным
      const ch = db.prepare('SELECT id, type FROM channels WHERE id=?').get(cid);
      if (ch) {
        const peerIds = db.prepare('SELECT user_id FROM chat_members WHERE chat_id=? AND user_id!=?')
          .all(cid, u.id).map(x => x.user_id);
        const onlineIds = peerIds.filter(uid => online.has(uid));

        if (ch.type === 'dm' && onlineIds.length) {
          // DM: стандартный телефонный ринг на 1-го собеседника
          const target = onlineIds[0];
          const timer = setTimeout(() => {
            ringings.delete(cid);
            io.to('user:' + u.id).emit('call:ring-timeout', { chatId: cid });
            io.to('user:' + target).emit('call:ring-cancelled', { chatId: cid, reason: 'нет ответа' });
          }, 35000);
          ringings.set(cid, { fromUserId: u.id, toUserId: target, timer });
          io.to('user:' + target).emit('call:ring', {
            chatId: cid, isDm: true,
            from: { id: u.id, username: u.username, full_name: me.full_name, avatar: me.avatar }
          });
        } else if (ch.type !== 'dm') {
          // групповой чат: уведомим всех, но не блокирующим рингом
          for (const uid of onlineIds) {
            io.to('user:' + uid).emit('call:ring', {
              chatId: cid, isDm: false,
              chatName: ch.name,
              from: { id: u.id, username: u.username, full_name: me.full_name, avatar: me.avatar }
            });
          }
        }
      }
    }
  });

  socket.on('call:leave', ({ chatId }) => {
    const cid = Number(chatId);
    const call = calls.get(cid);
    if (!call) return;
    if (!call.participants.has(u.id)) return;
    call.participants.delete(u.id);
    socket.leave('call:' + cid);
    socket.to('call:' + cid).emit('call:participant-left', { chatId: cid, userId: u.id });
    if (call.participants.size === 0) {
      calls.delete(cid);
      io.to('chat:' + cid).emit('call:inactive', { chatId: cid });
      io.to('call:' + cid).emit('call:ended', { chatId: cid, reason: 'все вышли' });
    } else {
      broadcastCallState(cid);
    }
  });

  socket.on('call:end-all', ({ chatId }) => {
    const cid = Number(chatId);
    if (!isMember(cid, u.id)) return;
    endCall(cid, 'звонок завершён');
  });

  socket.on('call:state-update', ({ chatId, muted, video, screen }) => {
    const cid = Number(chatId);
    const call = calls.get(cid);
    if (!call || !call.participants.has(u.id)) return;
    const p = call.participants.get(u.id);
    if (typeof muted === 'boolean') p.muted = muted;
    if (typeof video === 'boolean') p.video = video;
    if (typeof screen === 'boolean') p.screen = screen;
    broadcastCallState(cid);
  });

  // ================= УДАЛЁННЫЙ РАБОЧИЙ СТОЛ (relay) =================
  const remoteRelay = (event, payload, toField = 'toUserId') => {
    socket.on(event, (data) => {
      const tid = Number(data && data[toField]);
      if (!tid) return;
      const me = publicUser(u.id);
      io.to('user:' + tid).emit(event, Object.assign({}, data, {
        fromUserId: u.id,
        from: { id: u.id, username: u.username, full_name: me.full_name, avatar: me.avatar }
      }));
    });
  };

  remoteRelay('remote:request');
  remoteRelay('remote:reject');
  remoteRelay('remote:offer');
  remoteRelay('remote:answer');
  remoteRelay('remote:ice');
  remoteRelay('remote:stop');
  // ==================================================================

  socket.on('call:signal', ({ chatId, toUserId, signal }) => {
    const cid = Number(chatId);
    const call = calls.get(cid);
    if (!call) return;
    if (!call.participants.has(u.id) || !call.participants.has(Number(toUserId))) return;
    io.to('user:' + Number(toUserId)).emit('call:signal', {
      chatId: cid, fromUserId: u.id, signal
    });
  });

  // ---- Ринг для DM-звонков ----
  socket.on('call:ring', ({ chatId }) => {
    const cid = Number(chatId);
    if (!cid || !isMember(cid, u.id)) return;
    const ch = db.prepare('SELECT id, type FROM channels WHERE id=?').get(cid);
    if (!ch || ch.type !== 'dm') return; // ринг только в DM
    const peer = db.prepare(`SELECT u.id FROM users u JOIN chat_members m ON m.user_id=u.id
      WHERE m.chat_id=? AND u.id != ? LIMIT 1`).get(cid, u.id);
    if (!peer) return;
    // если уже звоним кому-то в этом чате — отменим прошлый
    if (ringings.has(cid)) cancelRinging(cid, 'новый звонок');
    const me = publicUser(u.id);
    const timer = setTimeout(() => {
      ringings.delete(cid);
      io.to('user:' + u.id).emit('call:ring-timeout', { chatId: cid });
      io.to('user:' + peer.id).emit('call:ring-cancelled', { chatId: cid, reason: 'нет ответа' });
    }, 35000); // 35 секунд на ответ
    ringings.set(cid, { fromUserId: u.id, toUserId: peer.id, timer });
    io.to('user:' + peer.id).emit('call:ring', {
      chatId: cid,
      from: { id: u.id, username: u.username, full_name: me.full_name, avatar: me.avatar }
    });
  });

  socket.on('call:ring-cancel', ({ chatId }) => {
    const cid = Number(chatId);
    if (!ringings.has(cid)) return;
    const r = ringings.get(cid);
    if (r.fromUserId !== u.id) return;
    cancelRinging(cid, 'отменён');
  });

  socket.on('call:decline', ({ chatId }) => {
    const cid = Number(chatId);
    const r = ringings.get(cid);
    if (!r) return;
    // в DM отклонить может только целевой адресат
    if (r.toUserId !== u.id) return;
    clearTimeout(r.timer);
    ringings.delete(cid);
    io.to('user:' + r.fromUserId).emit('call:declined', { chatId: cid });
  });

  // Для групповых рингов — индивидуальное «скрыть модалку», без снятия всего ринга
  socket.on('call:ring-dismiss', ({ chatId }) => {
    // просто игнорируем на сервере — клиент уже скрыл у себя
  });

  socket.on('disconnect', () => {
    const c = (online.get(u.id) || 1) - 1;
    if (c <= 0) online.delete(u.id); else online.set(u.id, c);
    io.emit('presence', Array.from(online.keys()));

    for (const [cid, call] of calls.entries()) {
      if (call.participants.has(u.id) && call.participants.get(u.id).socketId === socket.id) {
        call.participants.delete(u.id);
        socket.to('call:' + cid).emit('call:participant-left', { chatId: cid, userId: u.id });
        if (call.participants.size === 0) {
          calls.delete(cid);
          io.to('chat:' + cid).emit('call:inactive', { chatId: cid });
          io.to('call:' + cid).emit('call:ended', { chatId: cid, reason: 'все вышли' });
        } else {
          broadcastCallState(cid);
        }
      }
    }
    // отменяем наши звонки, если мы были инициатором
    for (const [cid, r] of ringings.entries()) {
      if (r.fromUserId === u.id) {
        clearTimeout(r.timer);
        ringings.delete(cid);
        io.to('user:' + r.toUserId).emit('call:ring-cancelled', { chatId: cid, reason: 'абонент отключился' });
      }
    }
  });
});

// ============================================================
// Глобальные ловушки
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  try { slog('error', 'uncaughtException: ' + err.message, { stack: (err.stack||'').slice(0,2000) }); } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try { slog('error', 'unhandledRejection: ' + (reason && reason.message || reason), { stack: reason && reason.stack ? String(reason.stack).slice(0,2000) : null }); } catch {}
});

server.listen(PORT, '0.0.0.0', () => {

  console.log('🚀 Chat server on ' + PORT);
  slog('info', 'Server started', { port: PORT });
});
