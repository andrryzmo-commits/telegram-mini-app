// Всё-в-одном: раздаёт Mini App (public/index.html), API и сам бот — один процесс.
// Так проще всего задеплоить на бесплатном хостинге (Replit, Render, Railway и т.п.).
//
// Нужно указать только 2 переменные окружения:
//   BOT_TOKEN   — токен от @BotFather
//   PUBLIC_URL  — публичный HTTPS-адрес этого сервиса (его даёт хостинг),
//                 например https://your-app.onrender.com
//
// Запуск:
//   npm install
//   BOT_TOKEN=xxxx PUBLIC_URL=https://your-app.onrender.com node app.js

const path = require('path');
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
if (!BOT_TOKEN || !PUBLIC_URL) {
  console.error('Укажи переменные окружения BOT_TOKEN и PUBLIC_URL.');
  process.exit(1);
}
const WEBAPP_URL = PUBLIC_URL.replace(/\/$/, '') + '/';

/* ---------------- DB ---------------- */
const db = new Database('data.sqlite');
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    start_weight REAL NOT NULL,
    goal_weight REAL NOT NULL,
    height REAL,
    created_at TEXT NOT NULL,
    tg_first_name TEXT, tg_last_name TEXT, tg_username TEXT
  );
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    weight REAL NOT NULL,
    created_at TEXT NOT NULL
  );
`);
const round2 = n => Math.round(n * 100) / 100;
const validWeight = w => typeof w === 'number' && isFinite(w) && w > 0 && w <= 400;
const fmt = n => { const r = Math.round(n * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };

/* ---------------- Telegram initData verification ---------------- */
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const arr = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`);
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(arr.join('\n')).digest('hex');
  if (computed !== hash) return null;
  const userJson = params.get('user');
  return userJson ? JSON.parse(userJson) : null;
}
function auth(req, res, next) {
  const initData = req.header('X-Telegram-Init-Data');
  const user = initData ? verifyInitData(initData) : null;
  if (!user) return res.status(401).json({ error: 'invalid_init_data' });
  req.userId = String(user.id);
  req.tgUser = user;
  next();
}

/* ---------------- API ---------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/profile', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(req.userId);
  if (!row) return res.json(null);
  res.json({ startWeight: row.start_weight, goalWeight: row.goal_weight, height: row.height, createdAt: row.created_at });
});

app.post('/api/profile', auth, (req, res) => {
  const { startWeight, goalWeight, height } = req.body || {};
  if (!validWeight(startWeight) || !validWeight(goalWeight)) return res.status(400).json({ error: 'invalid_weight' });
  const now = new Date().toISOString();
  const u = req.tgUser || {};
  const existing = db.prepare('SELECT user_id FROM profiles WHERE user_id=?').get(req.userId);
  if (existing) {
    db.prepare('UPDATE profiles SET start_weight=?, goal_weight=?, height=?, tg_first_name=?, tg_last_name=?, tg_username=? WHERE user_id=?')
      .run(round2(startWeight), round2(goalWeight), height || null, u.first_name || null, u.last_name || null, u.username || null, req.userId);
  } else {
    db.prepare('INSERT INTO profiles (user_id, start_weight, goal_weight, height, created_at, tg_first_name, tg_last_name, tg_username) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.userId, round2(startWeight), round2(goalWeight), height || null, now, u.first_name || null, u.last_name || null, u.username || null);
    db.prepare('INSERT INTO entries (user_id, weight, created_at) VALUES (?,?,?)').run(req.userId, round2(startWeight), now);
  }
  res.json({ ok: true });
});

app.put('/api/profile/goal', auth, (req, res) => {
  const { goalWeight } = req.body || {};
  if (!validWeight(goalWeight)) return res.status(400).json({ error: 'invalid_weight' });
  const r = db.prepare('UPDATE profiles SET goal_weight=? WHERE user_id=?').run(round2(goalWeight), req.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'no_profile' });
  res.json({ ok: true });
});

app.get('/api/entries', auth, (req, res) => {
  const rows = db.prepare('SELECT id, weight, created_at FROM entries WHERE user_id=? ORDER BY created_at ASC').all(req.userId);
  res.json(rows.map(r => ({ id: r.id, weight: r.weight, date: r.created_at })));
});

app.post('/api/entries', auth, (req, res) => {
  const { weight } = req.body || {};
  if (!validWeight(weight)) return res.status(400).json({ error: 'invalid_weight' });
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO entries (user_id, weight, created_at) VALUES (?,?,?)').run(req.userId, round2(weight), now);
  res.json({ id: info.lastInsertRowid, weight: round2(weight), date: now });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Web + API запущены на порту ' + PORT));

/* ---------------- Bot ---------------- */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const displayName = u => [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || (u.username ? '@' + u.username : 'друг');

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `Привет, ${displayName(msg.from)}! Это трекер веса и цели. Открой приложение 👇`, {
    reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть приложение', web_app: { url: WEBAPP_URL } }]] },
  });
});

bot.onText(/\/progress/, (msg) => {
  const p = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(String(msg.from.id));
  if (!p) return bot.sendMessage(msg.chat.id, 'Сначала настрой цель в приложении — нажми /start.');
  const entries = db.prepare('SELECT * FROM entries WHERE user_id=? ORDER BY created_at ASC').all(String(msg.from.id));
  const current = entries.length ? entries[entries.length - 1].weight : p.start_weight;
  const span = p.goal_weight - p.start_weight;
  const pct = span === 0 ? 100 : Math.max(0, Math.min(100, ((current - p.start_weight) / span) * 100));
  bot.sendMessage(msg.chat.id, `Старт: ${fmt(p.start_weight)} кг\nСейчас: ${fmt(current)} кг\nЦель: ${fmt(p.goal_weight)} кг\nПрогресс: ${fmt(pct)}%\nОсталось: ${fmt(Math.abs(p.goal_weight - current))} кг`);
});

bot.onText(/\/goal/, (msg) => {
  const p = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(String(msg.from.id));
  if (!p) return bot.sendMessage(msg.chat.id, 'Цель ещё не установлена — открой приложение через /start.');
  bot.sendMessage(msg.chat.id, `Твоя цель: ${fmt(p.start_weight)} → ${fmt(p.goal_weight)} кг`);
});

bot.onText(/\/weight(?:\s+([\d.,]+))?/, (msg, match) => {
  const p = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(String(msg.from.id));
  if (!p) return bot.sendMessage(msg.chat.id, 'Сначала настрой цель в приложении — нажми /start.');
  if (!match[1]) {
    return bot.sendMessage(msg.chat.id, 'Открой приложение, чтобы добавить вес 👇', {
      reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть приложение', web_app: { url: WEBAPP_URL } }]] },
    });
  }
  const v = parseFloat(match[1].replace(',', '.'));
  if (isNaN(v) || v <= 0 || v > 400) return bot.sendMessage(msg.chat.id, 'Не похоже на вес. Пример: /weight 53.4');
  db.prepare('INSERT INTO entries (user_id, weight, created_at) VALUES (?,?,?)').run(String(msg.from.id), round2(v), new Date().toISOString());
  bot.sendMessage(msg.chat.id, `Записал: ${fmt(v)} кг ✅`);
});

console.log('Бот запущен (polling)...');
