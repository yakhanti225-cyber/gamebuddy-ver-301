// GameBuddy backend: Node.js 18+, MongoDB for storage.
// Local run: npm install แล้วตั้งค่า MONGODB_URI จากนั้นรัน node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// อ่านไฟล์ .env ในโฟลเดอร์เดียวกัน (ใช้เฉพาะตอนรันบนเครื่อง ค่าที่ตั้งจากระบบ เช่น Render จะถูกใช้ก่อนเสมอ)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'gamebuddy';
const PUBLIC_DIR = path.join(__dirname, 'public');
// ตั้ง SEED_DEMO=true เฉพาะตอนทดลองบนเครื่องตัวเอง เพื่อสร้างบัญชีตัวอย่าง demo1-demo5
// บนเว็บจริงห้ามเปิด เพราะรหัสผ่านของบัญชีตัวอย่างเดาง่าย
const SEED_DEMO = /^(1|true|yes)$/i.test(process.env.SEED_DEMO || '');
const RESERVED_NAMES = ['admin', 'administrator', 'root', 'support', 'system'];

const META = {
  games: ['APEX Legends', 'Valorant', 'League of Legends', 'Overwatch 2', 'Fortnite', 'Minecraft', 'Genshin Impact', 'Among Us',
    'Counter-Strike 2', 'Dota 2', 'PUBG', 'Free Fire', 'Roblox', 'Call of Duty', 'Rainbow Six Siege', 'Rocket League',
    'Honkai: Star Rail', 'Dead by Daylight', 'Elden Ring', 'Valorant Mobile', 'FC Online', 'Clash Royale'],
  platforms: ['PC', 'PlayStation', 'Xbox', 'Nintendo Switch', 'Mobile'],
  levels: ['เริ่มต้น', 'ปานกลาง', 'เก่ง', 'สายโปร'],
  avatars: ['🐰', '🐱', '🐼', '🦊', '🐸', '🐧', '🦉', '🐯'],
};

// ---------- ข้อมูลทั้งหมดอยู่ในหน่วยความจำ และบันทึกลง MongoDB ----------
const db = {
  seq: 1, users: {}, sessions: {}, friendships: [], dms: [], reads: {},
  groups: {}, notifications: [], queue: [], matchResults: {}, matches: [],
  ratings: [], visits: [], orders: {}, rooms: {}, roomMsgs: {}, roomHistory: [], ad: null, announcement: null, reports: [], dailyRooms: {}, gameCounts: {}, discordLinks: {}, discordCodes: {}, vcSeq: 0, vcChannels: [], devices: {},
};
const KEYS = Object.keys(db);
let stateCol = null;
let imageCol = null;

let saveTimer = null;
let saving = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saving = saving.then(flush).catch((e) => console.error('บันทึกข้อมูลไม่สำเร็จ:', e.message));
  }, 300);
}
async function flush() {
  await stateCol.bulkWrite(KEYS.map((k) => ({
    replaceOne: { filter: { _id: k }, replacement: { _id: k, value: db[k] }, upsert: true },
  })));
}
async function loadDb() {
  const docs = await stateCol.find({}).toArray();
  for (const d of docs) if (KEYS.includes(d._id)) db[d._id] = d.value;
}
const nextId = (prefix = '') => prefix + (db.seq++).toString(36) + crypto.randomBytes(3).toString('hex');

// ---------- รหัสผ่าน ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(user, pw) {
  if (!user.hash) return false; // บัญชี Google ไม่มีรหัสผ่าน
  const h = crypto.scryptSync(pw, user.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(user.hash));
}

// ---------- Helpers ----------
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

function ratingOf(uid) {
  const rs = db.ratings.filter((r) => r.to === uid);
  const avg = rs.length ? rs.reduce((a, r) => a + r.score, 0) / rs.length : 0;
  return { avg: Math.round(avg * 10) / 10, count: rs.length };
}
// สถานะออนไลน์: ผู้ใช้ที่เรียก API ภายใน 2 นาทีที่ผ่านมาถือว่าออนไลน์ (เก็บในหน่วยความจำ ไม่บันทึกลงฐานข้อมูล)
const presence = {};
const isOnline = (id) => !!id && Date.now() - (presence[id] || 0) < 2 * 60 * 1000;
function pub(u) {
  if (!u) return null;
  const { id, username, displayName, bio, avatar, games, platform, level, schedule, createdAt } = u;
  return { id, username, displayName, bio, avatar, frame: u.frame || null, games, platform, level, schedule, createdAt, rating: ratingOf(id), online: isOnline(id), badges: badgesOf(u) };
}
const pubMini = (u) => (u ? { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, frame: u.frame || null, online: isOnline(u.id) } : null);

function findFriendship(a, b) {
  return db.friendships.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
}
function friendRel(me, other) {
  if (me === other) return 'self';
  const f = findFriendship(me, other);
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  return f.from === me ? 'outgoing' : 'incoming';
}
function friendIds(uid) {
  return db.friendships
    .filter((f) => f.status === 'accepted' && (f.from === uid || f.to === uid))
    .map((f) => (f.from === uid ? f.to : f.from));
}
function notify(userId, type, text, data = {}) {
  db.notifications.unshift({ id: nextId('n'), userId, type, text, data, at: Date.now(), read: false });
  if (db.notifications.length > 2000) db.notifications.length = 2000;
  pushTo(userId, type, text);
}

// ===== แจ้งเตือนบนมือถือ (FCM) =====
// ต้องตั้ง FIREBASE_SERVICE_ACCOUNT (JSON ของ service account) ใน Render ถึงจะส่งได้
// ถ้าไม่ได้ตั้ง ระบบจะข้ามการส่ง push ไปเฉย ๆ การแจ้งเตือนในเว็บยังทำงานปกติ
const PUSH_TYPES = ['room', 'invite', 'friend_request', 'friend', 'match', 'rating', 'announce', 'dm'];
let FIREBASE_SA = null;
try {
  FIREBASE_SA = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
} catch { console.error('FIREBASE_SERVICE_ACCOUNT ไม่ใช่ JSON ที่ถูกต้อง'); }
let fcmCache = { token: '', exp: 0 };
const b64url = (input) => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function fcmAccessToken() {
  if (fcmCache.token && Date.now() < fcmCache.exp - 60000) return fcmCache.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: FIREBASE_SA.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }))}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(FIREBASE_SA.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('ขอ token FCM ไม่สำเร็จ: ' + JSON.stringify(j).slice(0, 200));
  fcmCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmCache.token;
}
async function sendPush(uid, title, body, type) {
  const tokens = db.devices[uid] || [];
  if (!FIREBASE_SA || !tokens.length) return;
  const access = await fcmAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${FIREBASE_SA.project_id}/messages:send`;
  const gone = new Set();
  await Promise.all(tokens.map(async (token) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, notification: { title, body }, data: { type: String(type || '') }, android: { priority: 'high' } } }),
      });
      if (!r.ok && (await r.text()).includes('UNREGISTERED')) gone.add(token);
    } catch (e) { console.error('push:', e.message); }
  }));
  if (gone.size) { db.devices[uid] = (db.devices[uid] || []).filter((t) => !gone.has(t)); save(); }
}
function pushTo(uid, type, text) {
  const u = db.users[uid];
  if (!FIREBASE_SA || !PUSH_TYPES.includes(type) || u?.notifPrefs?.[type] === false) return;
  sendPush(uid, 'GameBuddy', String(text).slice(0, 160), type).catch((e) => console.error('push:', e.message));
}
const dmKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

// จำกัดจำนวนครั้งที่ลองเข้าสู่ระบบ/สมัครต่อ IP กันการเดารหัสผ่านและกันเซิร์ฟเวอร์ค้าง
const attempts = new Map();
function rateLimit(ip, max = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now > e.reset) { attempts.set(ip, { n: 1, reset: now + windowMs }); return; }
  if (++e.n > max) fail(429, 'ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of attempts) if (now > e.reset) attempts.delete(k);
}, 60 * 1000).unref();

// คิวจับคู่: ตัดคนที่ไม่ได้เปิดหน้าเว็บอยู่ออก (หน้าเว็บส่งสัญญาณทุก 3 วินาที)
const QUEUE_TTL = 10 * 60 * 1000;
const QUEUE_IDLE = 90 * 1000;
function pruneQueue() {
  const now = Date.now();
  db.queue = db.queue.filter((q) => now - q.at < QUEUE_TTL && now - (q.seen || q.at) < QUEUE_IDLE);
}

function createUser({ username, password, displayName }) {
  const id = nextId('u');
  const { salt, hash } = password ? hashPw(password) : { salt: '', hash: '' };
  db.users[id] = {
    id, username, salt, hash, displayName: displayName || username, bio: '',
    avatar: META.avatars[Math.floor(Math.random() * META.avatars.length)],
    games: [], platform: 'PC', level: 'ปานกลาง', schedule: '', createdAt: Date.now(),
    credits: 0, adFree: false,
  };
  return db.users[id];
}

// ---------- รูปภาพ (เก็บแยกใน collection images) ----------
const IMAGE_COST = 5;
const AD_FREE_COST = 30;
const PACKS = [
  { id: 's', label: '10 เครดิต', credits: 10, price: 10 },
  { id: 'm', label: '50 เครดิต', credits: 50, price: 45 },
  { id: 'l', label: '150 เครดิต', credits: 150, price: 120 },
];
// ค่าเริ่มต้นเป็น live (ปิดการให้เครดิตทดสอบ) เพื่อไม่ให้ใครได้เครดิตฟรีบนเว็บจริง
// ทดสอบบนเครื่องตัวเองให้ตั้งค่า PAYMENT_MODE=mock
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'live';

function parseImage(data) {
  if (!data) return null;
  const m = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(data));
  if (!m) fail(400, 'รองรับเฉพาะไฟล์รูป PNG, JPEG, GIF หรือ WebP');
  if (m[3].length > 2.2e6) fail(413, 'รูปใหญ่เกินไป (สูงสุดประมาณ 1.5 MB)');
  return { mime: m[1], buf: Buffer.from(m[3], 'base64') };
}
function parseAudio(data) {
  if (!data) return null;
  const m = /^data:audio\/(webm|ogg|mp4|mpeg|wav)(?:;[\w=.-]+)*;base64,([A-Za-z0-9+/=]+)$/.exec(String(data));
  if (!m) fail(400, 'รองรับเฉพาะข้อความเสียงที่บันทึกจากแอป');
  if (m[2].length > 1.5e6) fail(413, 'ข้อความเสียงยาวเกินไป (สูงสุด 30 วินาที)');
  return { mime: `audio/${m[1]}`, buf: Buffer.from(m[2], 'base64') };
}
function ensureCredits(user, cost) {
  user.credits = user.credits || 0;
  if (user.credits < cost) fail(402, `เครดิตไม่พอ ส่งรูป 1 รูปใช้ ${cost} เครดิต`);
}
async function saveImage(parsed) {
  const id = nextId('i');
  await imageCol.insertOne({ _id: id, mime: parsed.mime, data: parsed.buf, at: Date.now() });
  return id;
}
// หักเครดิตก่อนบันทึกรูป (กันส่งรูปหลายอันพร้อมกันจนเครดิตติดลบ) และคืนให้ถ้าบันทึกไม่สำเร็จ
async function storeImage(user, parsed) {
  ensureCredits(user, IMAGE_COST);
  user.credits -= IMAGE_COST;
  try { return await saveImage(parsed); }
  catch (e) { user.credits += IMAGE_COST; throw e; }
}
// ส่งรูปให้ผู้ที่ล็อกอินแล้วเท่านั้น โดยแนบโทเคนใน URL เพราะแท็ก img ส่ง header ไม่ได้
const imageUrl = (imageId, token) => (imageId ? `/api/images/${imageId}?t=${token}` : undefined);

// ---------- Router ----------
const routes = [];
function compile(p) {
  const keys = [];
  const src = p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp('^' + src + '$'), keys };
}
// open = true หมายถึงไม่ต้องล็อกอิน
function on(method, p, handler, open = false) {
  const { re, keys } = compile(p);
  routes.push({ method, re, keys, handler, open });
}

// ===== Auth =====
on('POST', '/api/auth/register', async ({ body, ip }) => {
  rateLimit(ip);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[a-z0-9_]{3,16}$/.test(username)) fail(400, 'ชื่อผู้ใช้ต้องมี 3-16 ตัว (a-z, 0-9, _)');
  if (password.length < 6) fail(400, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
  if (RESERVED_NAMES.includes(username) || Object.values(db.users).some((u) => u.username === username)) fail(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  const u = createUser({ username, password, displayName: String(body.displayName || '').trim().slice(0, 24) || username });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = u.id;
  save();
  return { token, user: pub(u) };
}, true);

on('POST', '/api/auth/login', async ({ body, ip }) => {
  rateLimit(ip);
  const username = String(body.username || '').trim().toLowerCase();
  const u = Object.values(db.users).find((x) => x.username === username);
  if (!u || !checkPw(u, String(body.password || ''))) fail(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (u.banned) fail(403, 'บัญชีนี้ถูกระงับการใช้งาน');
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = u.id;
  save();
  // ต้องบอกด้วยว่าเป็นแอดมินหรือไม่ ไม่งั้นเมนูผู้ดูแลระบบจะไม่ขึ้นจนกว่าจะรีเฟรชหน้า
  return { token, user: { ...pub(u), isAdmin: !!u.isAdmin, isSup: !!u.isSup, isMod: isMod(u) } };
}, true);

on('POST', '/api/auth/logout', async ({ token }) => {
  delete db.sessions[token];
  save();
  return { ok: true };
});

on('GET', '/api/meta', async () => ({ ...META, partySize: PARTY_SIZE, ranks: RANKS, demo: SEED_DEMO }), true);

// ===== Profile =====
on('GET', '/api/me', async ({ user }) => ({
  ...pub(user), isAdmin: !!user.isAdmin, isSup: !!user.isSup, isMod: isMod(user), credits: user.credits || 0, adFree: !!user.adFree,
  discordLinked: Object.values(db.discordLinks).includes(user.id),
  notifPrefs: user.notifPrefs || {},
}));

// เชื่อมบัญชีดิส: ผู้ใช้พิมพ์ /link ในดิส ได้รหัส 6 หลัก แล้วกรอกในเว็บ
on('POST', '/api/me/discord', async ({ user, body }) => {
  const code = String(body.code || '').trim();
  const c = db.discordCodes[code];
  if (!c || Date.now() - c.at > 10 * 60 * 1000) fail(400, 'รหัสไม่ถูกต้องหรือหมดอายุ ใช้คำสั่ง /link ในดิสเพื่อขอรหัสใหม่');
  delete db.discordCodes[code];
  for (const [did, uid] of Object.entries(db.discordLinks)) {
    if (uid === user.id || did === c.discordId) delete db.discordLinks[did];
  }
  db.discordLinks[c.discordId] = user.id;
  save();
  return { ok: true };
});

on('POST', '/api/me/discord/unlink', async ({ user }) => {
  for (const [did, uid] of Object.entries(db.discordLinks)) if (uid === user.id) delete db.discordLinks[did];
  save();
  return { ok: true };
});

on('PUT', '/api/me', async ({ user, body }) => {
  if (body.displayName !== undefined) {
    const v = String(body.displayName).trim().slice(0, 24);
    if (!v) fail(400, 'กรุณาใส่ชื่อที่แสดง');
    user.displayName = v;
  }
  if (body.bio !== undefined) user.bio = String(body.bio).slice(0, 200);
  // รูปโปรไฟล์: ส่งเป็น data URL (อัปโหลดจากเครื่อง) หรือเลือกจาก emoji ที่กำหนดไว้
  // ค่าอื่นที่ไม่ใช่ data URL (เช่น รหัสรูปเดิม) จะไม่เปลี่ยนแปลง
  if (body.avatar !== undefined) {
    const img = typeof body.avatar === 'string' && body.avatar.startsWith('data:') ? parseImage(body.avatar) : null;
    if (img) user.avatar = await saveImage(img);
    else if (META.avatars.includes(body.avatar)) user.avatar = body.avatar;
  }
  // กรอบรูป: ส่ง null เพื่อลบ หรือส่ง data URL เพื่อตั้งกรอบใหม่
  if (body.frame !== undefined) {
    const img = typeof body.frame === 'string' && body.frame.startsWith('data:') ? parseImage(body.frame) : null;
    if (img) user.frame = await saveImage(img);
    else if (body.frame === null) user.frame = null;
  }
  if (body.games !== undefined) {
    user.games = (Array.isArray(body.games) ? body.games : []).filter((g) => META.games.includes(g)).slice(0, 6);
  }
  if (body.platform !== undefined && META.platforms.includes(body.platform)) user.platform = body.platform;
  if (body.level !== undefined && META.levels.includes(body.level)) user.level = body.level;
  if (body.schedule !== undefined) user.schedule = String(body.schedule).slice(0, 80);
  save();
  return { ...pub(user), isAdmin: !!user.isAdmin };
});

// ===== Users =====
on('GET', '/api/users', async ({ user, query }) => {
  const q = (query.get('q') || '').trim().toLowerCase();
  const game = query.get('game') || '';
  return Object.values(db.users)
    .filter((u) => u.id !== user.id && !u.isAdmin)
    .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.includes(q))
    .filter((u) => !game || u.games.includes(game))
    .sort((a, b) => ratingOf(b.id).avg - ratingOf(a.id).avg)
    .slice(0, 50)
    .map((u) => ({ ...pub(u), rel: friendRel(user.id, u.id) }));
});

on('GET', '/api/users/:id', async ({ user, params }) => {
  const u = db.users[params.id];
  if (!u) fail(404, 'ไม่พบผู้ใช้');
  if (u.id !== user.id) {
    db.visits.push({ id: nextId('v'), viewer: user.id, target: u.id, at: Date.now() });
    if (db.visits.length > 5000) db.visits = db.visits.slice(-5000);
    save();
  }
  const ratings = db.ratings
    .filter((r) => r.to === u.id)
    .slice(-30)
    .reverse()
    .map((r) => ({ score: r.score, comment: r.comment, at: r.at, from: pubMini(db.users[r.from]) }));
  return { ...pub(u), rel: friendRel(user.id, u.id), ratings };
});

on('POST', '/api/users/:id/rate', async ({ user, params, body }) => {
  const target = db.users[params.id];
  if (!target) fail(404, 'ไม่พบผู้ใช้');
  if (target.id === user.id) fail(400, 'ให้คะแนนตัวเองไม่ได้');
  const score = Math.round(Number(body.score));
  if (!(score >= 1 && score <= 5)) fail(400, 'คะแนนต้องอยู่ระหว่าง 1-5');
  const comment = String(body.comment || '').slice(0, 200);
  const existing = db.ratings.find((r) => r.from === user.id && r.to === target.id);
  if (existing) Object.assign(existing, { score, comment, at: Date.now() });
  else db.ratings.push({ id: nextId('r'), from: user.id, to: target.id, score, comment, at: Date.now() });
  notify(target.id, 'rating', `${user.displayName} ให้คะแนน ${score} ดาวแก่คุณ`);
  save();
  return ratingOf(target.id);
});

on('GET', '/api/visitors', async ({ user }) =>
  db.visits
    .filter((v) => v.target === user.id)
    .slice(-100)
    .reverse()
    .map((v) => ({ at: v.at, viewer: pubMini(db.users[v.viewer]) }))
    .filter((x) => x.viewer));

// ===== Friends =====
on('GET', '/api/friends', async ({ user }) => {
  const list = db.friendships.filter((f) => f.from === user.id || f.to === user.id);
  const other = (f) => db.users[f.from === user.id ? f.to : f.from];
  return {
    friends: list.filter((f) => f.status === 'accepted' && other(f)).map((f) => ({ ...pub(other(f)), friendshipId: f.id })),
    incoming: list
      .filter((f) => f.status === 'pending' && f.to === user.id)
      .map((f) => ({ requestId: f.id, user: pubMini(db.users[f.from]), at: f.createdAt })),
    outgoing: list
      .filter((f) => f.status === 'pending' && f.from === user.id)
      .map((f) => ({ requestId: f.id, user: pubMini(other(f)) })),
  };
});

// ส่งคำขอเมื่ออีกฝ่ายส่งมาก่อนแล้ว จะตอบรับทันที
on('POST', '/api/friends/request', async ({ user, body }) => {
  const target = db.users[body.userId];
  if (!target || target.id === user.id) fail(400, 'ไม่สามารถส่งคำขอได้');
  const rel = friendRel(user.id, target.id);
  if (rel === 'friends') fail(409, 'เป็นเพื่อนกันอยู่แล้ว');
  if (rel === 'outgoing') fail(409, 'ส่งคำขอไปแล้ว');
  if (rel === 'incoming') {
    findFriendship(user.id, target.id).status = 'accepted';
    notify(target.id, 'friend', `${user.displayName} ตอบรับคำขอเป็นเพื่อนแล้ว`);
    save();
    return { status: 'friends' };
  }
  const f = { id: nextId('f'), from: user.id, to: target.id, status: 'pending', createdAt: Date.now() };
  db.friendships.push(f);
  notify(target.id, 'friend_request', `${user.displayName} ส่งคำขอเป็นเพื่อนถึงคุณ`, { userId: user.id, requestId: f.id });
  save();
  return { status: 'pending' };
});

on('POST', '/api/friends/:id/accept', async ({ user, params }) => {
  const f = db.friendships.find((x) => x.id === params.id && x.to === user.id && x.status === 'pending');
  if (!f) fail(404, 'ไม่พบคำขอ');
  f.status = 'accepted';
  notify(f.from, 'friend', `${user.displayName} ตอบรับคำขอเป็นเพื่อนแล้ว`);
  save();
  return { ok: true };
});

// ปฏิเสธคำขอ ยกเลิกคำขอที่ส่งไป หรือลบเพื่อน
on('DELETE', '/api/friends/:id', async ({ user, params }) => {
  const f = db.friendships.find((x) => x.id === params.id && (x.from === user.id || x.to === user.id));
  if (!f) fail(404, 'ไม่พบรายการ');
  db.friendships = db.friendships.filter((x) => x !== f);
  save();
  return { ok: true };
});

// ===== Direct messages =====
on('GET', '/api/dm', async ({ user }) =>
  friendIds(user.id)
    .map((fid) => {
      const key = dmKey(user.id, fid);
      const msgs = db.dms.filter((m) => dmKey(m.from, m.to) === key);
      const last = msgs[msgs.length - 1];
      const lastRead = (db.reads[user.id] || {})[fid] || 0;
      const unread = msgs.filter((m) => m.from === fid && m.at > lastRead).length;
      return {
        user: pubMini(db.users[fid]),
        last: last ? { text: last.text || (last.image ? '📷 รูปภาพ' : ''), at: last.at, mine: last.from === user.id } : null,
        unread,
      };
    })
    .sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0)));

on('GET', '/api/dm/:userId', async ({ user, params, token }) => {
  const other = db.users[params.userId];
  if (!other) fail(404, 'ไม่พบผู้ใช้');
  const key = dmKey(user.id, other.id);
  const messages = db.dms.filter((m) => dmKey(m.from, m.to) === key).slice(-200);
  db.reads[user.id] = db.reads[user.id] || {};
  db.reads[user.id][other.id] = Date.now();
  save();
  return {
    user: pub(other),
    rel: friendRel(user.id, other.id),
    messages: messages.map((m) => ({
      id: m.id, mine: m.from === user.id, text: m.text, image: imageUrl(m.image, token), at: m.at,
    })),
  };
});

on('POST', '/api/dm/:userId', async ({ user, params, body }) => {
  const other = db.users[params.userId];
  if (!other) fail(404, 'ไม่พบผู้ใช้');
  if (friendRel(user.id, other.id) !== 'friends') fail(403, 'ต้องเป็นเพื่อนกันก่อนจึงจะส่งข้อความได้');
  const text = String(body.text || '').trim().slice(0, 500);
  const img = parseImage(body.image);
  if (!text && !img) fail(400, 'ข้อความว่างเปล่า');
  const imageId = img ? await storeImage(user, img) : null;
  const m = { id: nextId('m'), from: user.id, to: other.id, text, image: imageId, at: Date.now() };
  pushTo(other.id, 'dm', `${user.displayName}: ${text || '📷 ส่งรูปภาพ'}`);
  db.dms.push(m);
  if (db.dms.length > 10000) db.dms = db.dms.slice(-10000);
  save();
  return { id: m.id, mine: true, text, at: m.at };
});

// ===== Groups =====
on('GET', '/api/groups', async ({ user }) =>
  Object.values(db.groups).map((g) => ({
    id: g.id, name: g.name, game: g.game, description: g.description,
    members: g.members.length, joined: g.members.includes(user.id),
  })));

on('POST', '/api/groups', async ({ user, body }) => {
  const name = String(body.name || '').trim().slice(0, 30);
  if (!name) fail(400, 'กรุณาตั้งชื่อกลุ่ม');
  const g = {
    id: nextId('g'), name,
    game: META.games.includes(body.game) ? body.game : '',
    description: String(body.description || '').slice(0, 120),
    owner: user.id, members: [user.id], messages: [], createdAt: Date.now(),
  };
  db.groups[g.id] = g;
  save();
  return { id: g.id };
});

on('GET', '/api/groups/:id', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  return {
    id: g.id, name: g.name, game: g.game, description: g.description, owner: g.owner,
    joined: g.members.includes(user.id),
    members: g.members.map((id) => pubMini(db.users[id])).filter(Boolean),
  };
});

on('POST', '/api/groups/:id/join', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) g.members.push(user.id);
  save();
  return { ok: true };
});

on('POST', '/api/groups/:id/leave', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  g.members = g.members.filter((m) => m !== user.id);
  if (!g.members.length) delete db.groups[g.id];
  save();
  return { ok: true };
});

on('GET', '/api/groups/:id/messages', async ({ user, params, token }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) fail(403, 'เข้าร่วมกลุ่มก่อนจึงจะดูข้อความได้');
  return g.messages.slice(-200).map((m) => ({
    id: m.id, mine: m.from === user.id, from: pubMini(db.users[m.from]),
    text: m.text, image: imageUrl(m.image, token), at: m.at,
  }));
});

on('POST', '/api/groups/:id/messages', async ({ user, params, body }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) fail(403, 'เข้าร่วมกลุ่มก่อนจึงจะส่งข้อความได้');
  const text = String(body.text || '').trim().slice(0, 500);
  const img = parseImage(body.image);
  if (!text && !img) fail(400, 'ข้อความว่างเปล่า');
  const imageId = img ? await storeImage(user, img) : null;
  const m = { id: nextId('m'), from: user.id, text, image: imageId, at: Date.now() };
  g.messages.push(m);
  if (g.messages.length > 2000) g.messages = g.messages.slice(-2000);
  save();
  return { id: m.id, mine: true, text, at: m.at };
});

// ===== รูปภาพ =====
on('GET', '/api/images/:id', async ({ params }) => {
  const img = await imageCol.findOne({ _id: params.id });
  if (!img) fail(404, 'ไม่พบรูป');
  const b = img.data;
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer).subarray(0, b.position);
  return { __raw: true, mime: img.mime, buf };
});

// ===== Wallet =====
on('GET', '/api/wallet', async ({ user }) => {
  user.credits = user.credits || 0;
  return { credits: user.credits, adFree: !!user.adFree, imageCost: IMAGE_COST, adFreeCost: AD_FREE_COST, packs: PACKS, mode: PAYMENT_MODE };
});
on('POST', '/api/wallet/topup', async ({ user, body }) => {
  // ยังไม่ได้ต่อระบบรับเงินจริง จึงไม่สร้างออเดอร์ค้างในฐานข้อมูลเมื่อไม่ใช่โหมดทดสอบ
  if (PAYMENT_MODE !== 'mock') fail(503, 'ระบบชำระเงินยังไม่เปิดให้บริการ ติดต่อผู้ดูแลระบบเพื่อซื้อเครดิต');
  const pack = PACKS.find((p) => p.id === body.pack);
  if (!pack) fail(400, 'ไม่พบแพ็กเกจ');
  const id = nextId('o');
  db.orders[id] = { id, userId: user.id, credits: pack.credits, price: pack.price, status: 'pending', at: Date.now() };
  save();
  return { orderId: id, amount: pack.price, mode: PAYMENT_MODE };
});
// ใช้ได้เฉพาะโหมด mock เท่านั้น ตอนขายจริงต้องรับผลจาก webhook ของผู้ให้บริการ
on('POST', '/api/wallet/confirm', async ({ user, body }) => {
  if (PAYMENT_MODE !== 'mock') fail(403, 'การชำระเงินจริงยืนยันผ่าน webhook เท่านั้น');
  const o = db.orders[body.orderId];
  if (!o || o.userId !== user.id) fail(404, 'ไม่พบออเดอร์');
  if (o.status !== 'pending') fail(409, 'ออเดอร์นี้ถูกใช้ไปแล้ว');
  o.status = 'paid';
  user.credits = (user.credits || 0) + o.credits;
  save();
  return { credits: user.credits };
});
on('POST', '/api/wallet/adfree', async ({ user }) => {
  user.credits = user.credits || 0;
  if (user.adFree) fail(409, 'ปิดโฆษณาไปแล้ว');
  if (user.credits < AD_FREE_COST) fail(402, `เครดิตไม่พอ ต้องใช้ ${AD_FREE_COST} เครดิต`);
  user.credits -= AD_FREE_COST;
  user.adFree = true;
  save();
  return { credits: user.credits, adFree: true };
});

// ===== Auto match =====
// คืนสถานะการค้นหาของฉัน พร้อมผลการจับคู่ที่เกิดขึ้นตอนที่ฉันไม่อยู่
on('GET', '/api/match', async ({ user }) => {
  pruneQueue();
  const q = db.queue.find((x) => x.userId === user.id);
  if (q) q.seen = Date.now();
  const result = db.matchResults[user.id] || null;
  if (result) { delete db.matchResults[user.id]; save(); }
  return { searching: !!q, game: q?.game || null, since: q?.at || null, result };
});

on('POST', '/api/match/start', async ({ user, body }) => {
  const game = String(body.game || '');
  if (!META.games.includes(game)) fail(400, 'กรุณาเลือกเกมก่อน');
  pruneQueue();
  db.queue = db.queue.filter((q) => q.userId !== user.id);
  const partnerQ = db.queue.find((q) => q.game === game && q.userId !== user.id && db.users[q.userId]);
  if (!partnerQ) {
    db.queue.push({ userId: user.id, game, at: Date.now(), seen: Date.now() });
    save();
    return { searching: true, game, since: Date.now(), result: null };
  }
  db.queue = db.queue.filter((q) => q !== partnerQ);
  const match = { id: nextId('x'), game, players: [user.id, partnerQ.userId], at: Date.now() };
  db.matches.push(match);
  if (db.matches.length > 500) db.matches = db.matches.slice(-500);
  const partner = db.users[partnerQ.userId];
  // ฝั่งที่ถูกจับคู่ทีหลังจะได้รับผลตอนโพลล์ GET /api/match
  db.matchResults[partner.id] = { match: { id: match.id, game, at: match.at }, partner: pubMini(user) };
  notify(partner.id, 'match', `พบคู่เล่น ${game} กับ ${user.displayName} แล้ว`);
  notify(user.id, 'match', `พบคู่เล่น ${game} กับ ${partner.displayName} แล้ว`);
  save();
  return { searching: false, game, result: { match: { id: match.id, game, at: match.at }, partner: pubMini(partner) } };
});

on('POST', '/api/match/stop', async ({ user }) => {
  db.queue = db.queue.filter((q) => q.userId !== user.id);
  save();
  return { searching: false };
});

on('GET', '/api/matches', async ({ user }) =>
  db.matches
    .filter((m) => m.players.includes(user.id))
    .slice(-50)
    .reverse()
    .map((m) => ({
      id: m.id, game: m.game, at: m.at,
      partner: pubMini(db.users[m.players.find((p) => p !== user.id)]),
    })));

// ===== เพื่อนที่เคยเล่นด้วยล่าสุด (Recent Teammates) =====
// รวมคนที่เคยอยู่ห้องเดียวกัน (ห้องที่เปิดอยู่ + ประวัติห้องที่ปิดไปแล้ว) และคนที่เคยจับคู่ด้วย
// เรียงจากล่าสุด คนละ 1 รายการ และคืนสูงสุด 10 คน
const RECENT_TEAMMATES_LIMIT = 10;
function recentTeammates(uid, limit = RECENT_TEAMMATES_LIMIT) {
  const best = new Map(); // otherId -> { at, game, source }
  const see = (other, at, game, source) => {
    if (!other || other === uid || !at) return;
    const cur = best.get(other);
    if (!cur || at > cur.at) best.set(other, { at, game, source });
  };
  for (const r of Object.values(db.rooms)) {
    if (!r.members.includes(uid)) continue;
    const mine = (r.joinedAt || {})[uid] || r.createdAt || 0;
    for (const m of r.members) {
      const theirs = (r.joinedAt || {})[m] || r.createdAt || 0;
      see(m, Math.max(mine, theirs), r.game, 'room');
    }
  }
  for (const h of db.roomHistory || []) {
    if (h.a === uid) see(h.b, h.at, h.game, 'room');
    else if (h.b === uid) see(h.a, h.at, h.game, 'room');
  }
  for (const m of db.matches) {
    if (m.players.includes(uid)) see(m.players.find((p) => p !== uid), m.at, m.game, 'match');
  }
  return [...best.entries()]
    .filter(([id]) => { const u = db.users[id]; return u && !u.isAdmin && !u.banned; })
    .sort((x, y) => y[1].at - x[1].at)
    .slice(0, limit)
    .map(([id, v]) => ({ ...pubMini(db.users[id]), rel: friendRel(uid, id), game: v.game, at: v.at, source: v.source }));
}

on('GET', '/api/recent-teammates', async ({ user }) => recentTeammates(user.id));

// ชวนเล่นอีกครั้ง: ส่งแจ้งเตือนถึงเพื่อน (ถ้าเรามีห้องที่ยังว่างอยู่ จะพาไปห้องนั้น ไม่งั้นพาไปแชท)
const inviteCooldown = new Map(); // `${from}>${to}` -> เวลาที่ส่งล่าสุด
on('POST', '/api/recent-teammates/:id/invite', async ({ user, params }) => {
  const t = recentTeammates(user.id).find((x) => x.id === params.id);
  if (!t) fail(404, 'ไม่พบผู้เล่นคนนี้ในรายชื่อเล่นด้วยกันล่าสุด');
  if (t.rel !== 'friends') fail(403, 'ต้องเป็นเพื่อนกันก่อนจึงจะชวนเล่นได้');
  const key = user.id + '>' + t.id;
  if (Date.now() - (inviteCooldown.get(key) || 0) < 60 * 1000) fail(429, 'เพิ่งชวนไปเมื่อสักครู่ รอสักพักแล้วลองใหม่');
  inviteCooldown.set(key, Date.now());
  if (inviteCooldown.size > 5000) inviteCooldown.clear();
  const room = roomOfUser(user.id);
  const joinable = room && room.members.length < room.size && !(room.banned || []).includes(t.id) && !roomOfUser(t.id);
  const game = room ? room.game : t.game;
  notify(t.id, 'invite', `${user.displayName} ชวนคุณเล่น ${game} อีกครั้ง`,
    { userId: user.id, game, ...(joinable ? { roomId: room.id } : {}) });
  save();
  return { ok: true, roomId: joinable ? room.id : null };
});

// ===== ห้องหาตี้ (LFG) =====
const ROOM_MAX = 10;
// จำนวนคนสูงสุดต่อ 1 ปาร์ตี้ของแต่ละเกม (แก้ตัวเลขได้ตามต้องการ)
const PARTY_SIZE = {
  'APEX Legends': 3, 'Valorant': 5, 'League of Legends': 5, 'Overwatch 2': 5, 'Fortnite': 4,
  'Minecraft': 10, 'Genshin Impact': 4, 'Among Us': 10, 'Counter-Strike 2': 5, 'Dota 2': 5,
  'PUBG': 4, 'Free Fire': 4, 'Roblox': 10, 'Call of Duty': 6, 'Rainbow Six Siege': 5,
  'Rocket League': 3, 'Honkai: Star Rail': 4, 'Dead by Daylight': 5, 'Elden Ring': 3,
  'Valorant Mobile': 5, 'FC Online': 11, 'Clash Royale': 2,
};
// แรงค์ของแต่ละเกม (ห้องที่ตั้งแรงค์ไว้ ผู้ที่เข้าต้องเลือกแรงค์เดียวกันเท่านั้น) ว่าง = ไม่จำกัด
// แก้รายการได้ตามต้องการ
const TIERS = ['มือใหม่', 'กลาง', 'เก่ง', 'โปรขึ้นไป'];
const RANKS = {
  'APEX Legends': ['Rookie', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Apex Predator'],
  'Valorant': ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal', 'Radiant'],
  'League of Legends': ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond', 'Master', 'Grandmaster', 'Challenger'],
  'Overwatch 2': ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Grandmaster', 'Top 500'],
  'Fortnite': ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Elite', 'Champion', 'Unreal'],
  'Minecraft': TIERS,
  'Genshin Impact': ['AR 1–20', 'AR 21–35', 'AR 36–50', 'AR 51–60'],
  'Among Us': TIERS,
  'Counter-Strike 2': ['Silver', 'Gold Nova', 'Master Guardian', 'Legendary Eagle', 'Supreme', 'Global Elite'],
  'Dota 2': ['Herald', 'Guardian', 'Crusader', 'Archon', 'Legend', 'Ancient', 'Divine', 'Immortal'],
  'PUBG': ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Crown', 'Ace', 'Conqueror'],
  'Free Fire': ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Heroic', 'Grandmaster'],
  'Roblox': TIERS,
  'Call of Duty': ['Rookie', 'Regular', 'Veteran', 'Elite', 'Pro', 'Master', 'Grandmaster'],
  'Rainbow Six Siege': ['Copper', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond', 'Champion'],
  'Rocket League': ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Champion', 'Grand Champion', 'Supersonic Legend'],
  'Honkai: Star Rail': ['TL 1–30', 'TL 31–50', 'TL 51–70', 'TL 71+'],
  'Dead by Daylight': TIERS,
  'Elden Ring': TIERS,
  'Valorant Mobile': ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal', 'Radiant'],
  'FC Online': TIERS,
  'Clash Royale': ['Arena 1–5', 'Arena 6–10', 'Arena 11–15', 'Arena 16+'],
};
// ช่วงแรงค์ของห้อง (รองรับห้องเก่าที่เก็บเป็นแรงค์เดียว)
function rankRange(r) {
  return { min: r.rankMin || r.rank || '', max: r.rankMax || r.rank || '' };
}
function rankLabel(r) {
  const { min, max } = rankRange(r);
  if (!min) return '';
  return min === max ? min : `${min} – ${max}`;
}
// ตรวจช่วงแรงค์ที่ผู้สร้างเลือก (ตั้งอันเดียวได้ อีกอันจะเติมให้เป็นต่ำสุด/สูงสุดของเกม)
function parseRankRange(game, minIn, maxIn) {
  const list = RANKS[game] || [];
  let min = String(minIn || ''), max = String(maxIn || '');
  if (!min && !max) return { rankMin: '', rankMax: '' };
  if (min && !list.includes(min)) fail(400, 'แรงค์ต่ำสุดไม่ถูกต้องสำหรับเกมนี้');
  if (max && !list.includes(max)) fail(400, 'แรงค์สูงสุดไม่ถูกต้องสำหรับเกมนี้');
  if (!min) min = list[0];
  if (!max) max = list[list.length - 1];
  if (list.indexOf(min) > list.indexOf(max)) fail(400, 'แรงค์ต่ำสุดต้องไม่สูงกว่าแรงค์สูงสุด');
  return { rankMin: min, rankMax: max };
}
const ROOM_MIN_STAY = 60 * 1000; // ต้องอยู่ในห้องอย่างน้อย 1 นาทีก่อนออก
const ROOM_SKIP_COST = 5; // เครดิตสำหรับข้ามการรีวิว
const AD_WAIT = 15 * 1000;
// หาห้องที่ผู้ใช้อยู่ตอนนี้ (ผู้ใช้อยู่ได้ทีละ 1 ห้องเท่านั้น)
function roomOfUser(uid, exceptId = null) {
  return Object.values(db.rooms).find((r) => r.id !== exceptId && r.members.includes(uid)) || null;
}
const BUSY_MSG = 'คุณอยู่ในห้องอื่นอยู่ ต้องออกจากห้องนั้นก่อนจึงจะเข้าหรือสร้างห้องใหม่ได้'; // เวลาดูโฆษณาเพื่อข้ามการรีวิว

// Google login: ตั้งค่าใน Environment ของ Render
// PUBLIC_URL ต้องเป็น URL ของเว็บ เช่น https://gamebuddy.onrender.com (ไม่มี / ท้าย)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const oauthStates = new Map(); // state -> เวลาหมดอายุ
// ผู้เล่นในห้องที่ยังไม่ได้รีวิวหลังจากที่เราเข้าห้อง
function unratedFor(r, uid) {
  const since = (r.joinedAt || {})[uid] || 0;
  return r.members.filter((m) => m !== uid && !db.ratings.some((x) => x.from === uid && x.to === m && x.at >= since));
}
// ===== ฟีเจอร์เพิ่มเติม: เล่นด้วยกันล่าสุด, ยศ/ป้ายโปรไฟล์, สถิติ, DM ดิส =====
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
function bumpStat(uid, key) {
  const u = db.users[uid];
  if (!u) return;
  u.stats = u.stats || {};
  u.stats[key] = (u.stats[key] || 0) + 1;
}
function countRoom(r) {
  const k = dayKey(Date.now());
  db.dailyRooms = db.dailyRooms || {};
  db.dailyRooms[k] = (db.dailyRooms[k] || 0) + 1;
  db.gameCounts = db.gameCounts || {};
  db.gameCounts[r.game] = (db.gameCounts[r.game] || 0) + 1;
}
function badgesOf(u) {
  const out = [];
  const st = u.stats || {};
  if ((st.joined || 0) >= 10) out.push('🎮 นักปาร์ตี้');
  if ((st.hosted || 0) >= 5) out.push('👑 เจ้าของห้องตัวยง');
  const rt = ratingOf(u.id);
  if (rt.count >= 5 && rt.avg >= 4.5) out.push('⭐ รีวิวดีเยี่ยม');
  if (Object.values(db.discordLinks || {}).includes(u.id)) out.push('🔗 เชื่อมดิสแล้ว');
  if (recentTeammates(u.id).length >= 10) out.push('🤝 เพื่อนเล่นเยอะ');
  return out;
}
// ส่ง DM ไปหาผู้ใช้ทางบอทดิส (ถ้าผู้ใช้เชื่อมบัญชีดิสไว้) ล้มเหลวเงียบ ๆ
function discordDmUser(uid, text) {
  const did = Object.keys(db.discordLinks || {}).find((d) => db.discordLinks[d] === uid);
  if (!did || !DISCORD_BOT_TOKEN) return;
  (async () => {
    try {
      const ch = await discordApi('POST', '/users/@me/channels', { recipient_id: did });
      await discordApi('POST', `/channels/${ch.id}/messages`, { content: text });
    } catch (e) { console.error('ส่ง DM ดิสไม่สำเร็จ:', e.message); }
  })();
}
function joinRoomNow(r, user) {
  r.members.push(user.id);
  r.joinedAt = r.joinedAt || {};
  r.joinedAt[user.id] = Date.now();
  db.roomHistory = db.roomHistory || [];
  for (const m of r.members) {
    if (m !== user.id) db.roomHistory.push({ a: user.id, b: m, game: r.game, title: r.title, roomId: r.id, at: Date.now() });
  }
  if (db.roomHistory.length > 2000) db.roomHistory = db.roomHistory.slice(-2000);
  bumpStat(user.id, 'joined');
  notify(r.hostId, 'room', `${user.displayName} ได้เข้าร่วมห้อง "${r.title}" ของคุณแล้ว`, { roomId: r.id, userId: user.id });
  discordNotifyJoin(r, user);
}
function roomView(r, uid) {
  const joinedAt = (r.joinedAt || {})[uid] || null;
  const inRoom = r.members.includes(uid);
  return {
    id: r.id, game: r.game, title: r.title, note: r.note, size: r.size,
    rankMin: rankRange(r).min, rankMax: rankRange(r).max, rankText: rankLabel(r), desc: r.desc || '',
    approval: !!r.approval, myRequest: (r.requests || []).some((q) => q.userId === uid),
    requests: r.hostId === uid ? (r.requests || []).map((q) => ({ user: pubMini(db.users[q.userId]), rank: q.rank || '', at: q.at })).filter((x) => x.user) : [],
    count: r.members.length, slotsLeft: r.size - r.members.length,
    host: pubMini(db.users[r.hostId]), createdAt: r.createdAt,
    isHost: r.hostId === uid, joined: inRoom,
    myJoinedAt: joinedAt, canLeaveAt: joinedAt ? joinedAt + ROOM_MIN_STAY : 0,
    unrated: inRoom ? unratedFor(r, uid).map((id) => pubMini(db.users[id])).filter(Boolean) : [],
    members: r.members.map((id) => pubMini(db.users[id])).filter(Boolean),
  };
}
function deleteRoom(r) {
  delete db.rooms[r.id];
  delete db.roomMsgs[r.id];
  save();
}
function dissolveRoom(r) {
  for (const m of r.members) if (m !== r.hostId) notify(m, 'room', `ห้อง "${r.title}" ถูกปิดแล้ว`);
  deleteRoom(r);
}

// กวาดห้องที่มีคนอยู่คนเดียวหรือไม่มีคนเลยทุก 30 นาที
const ROOM_SWEEP_MS = 30 * 60 * 1000;
function sweepRooms() {
  const solo = Object.values(db.rooms).filter((r) => r.members.length <= 1);
  if (!solo.length) return;
  for (const r of solo) deleteRoom(r);
  save();
}
setInterval(sweepRooms, ROOM_SWEEP_MS).unref();

// ห้องที่ยังเปิดอยู่ กรองตามเกมได้ ห้องที่ยังว่างขึ้นก่อน
on('GET', '/api/rooms', async ({ user, query }) => {
  const game = query.get('game') || '';
  return Object.values(db.rooms)
    .filter((r) => !game || r.game === game)
    .sort((a, b) => (b.members.length < b.size) - (a.members.length < a.size) || b.createdAt - a.createdAt)
    .map((r) => roomView(r, user.id));
});

on('POST', '/api/rooms', async ({ user, body }) => {
  const game = String(body.game || '');
  if (!META.games.includes(game)) fail(400, 'กรุณาเลือกเกม');
  const size = Math.round(Number(body.size));
  const maxSize = PARTY_SIZE[game] || ROOM_MAX;
  if (!(size >= 2 && size <= maxSize)) fail(400, `${game} ปาร์ตี้ได้สูงสุด ${maxSize} คน`);
  const { rankMin, rankMax } = parseRankRange(game, body.rankMin, body.rankMax);
  if (roomOfUser(user.id)) fail(409, BUSY_MSG);
  const r = {
    id: nextId('rm'), game, size, hostId: user.id, members: [user.id], rankMin, rankMax,
    title: String(body.title || '').trim().slice(0, 40) || `${game} ปาร์ตี้`,
    note: String(body.note || '').trim().slice(0, 80),
    desc: String(body.desc || '').trim().slice(0, 500),
    approval: !!body.approval, requests: [],
    createdAt: Date.now(), joinedAt: { [user.id]: Date.now() }, banned: [],
  };
  db.rooms[r.id] = r;
  db.roomMsgs[r.id] = [];
  save();
  countRoom(r);
  bumpStat(user.id, 'hosted');
  discordNotifyRoom(r, user);
  return roomView(r, user.id);
});

// ส่งการ์ดห้องไปยังช่อง Discord ผ่าน Webhook (ตั้งค่า DISCORD_WEBHOOK_URL บน Render)
// ใช้ได้ทั้งตอนสร้างห้องและตอนมีคนเข้าห้อง ไม่ block การทำงานหลัก และล้มเหลวเงียบ ๆ ได้ (แค่ log)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const clip = (v, n) => { const t = String(v ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function discordSend(embed) {
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(DISCORD_WEBHOOK_URL)) return;
  fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // allowed_mentions ว่าง = ชื่อห้อง/ชื่อผู้ใช้ที่มี @everyone หรือ @here จะไม่ถูกเอาไปแท็กคนในเซิร์ฟเวอร์
    body: JSON.stringify({ username: 'GameBuddy', embeds: [embed], allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(8000),
  }).then((res) => {
    if (!res.ok) console.error('Discord webhook ตอบกลับผิดปกติ:', res.status);
  }).catch((e) => console.error('Discord webhook ล้มเหลว:', e.message));
}
function discordRoomFields(r) {
  return [
    { name: 'เกม', value: clip(r.game, 1024), inline: true },
    { name: 'ที่ว่าง', value: `${Math.max(0, r.size - r.members.length)}/${r.size} คน`, inline: true },
    ...(rankLabel(r) ? [{ name: 'แรงค์', value: clip(rankLabel(r), 1024), inline: true }] : []),
  ];
}
// ห้องใหม่
function discordNotifyRoom(r, host) {
  const link = PUBLIC_URL ? `${PUBLIC_URL}/#/room/${r.id}` : '';
  discordSend({
    title: clip(`🎮 ${r.title}`, 256),
    description: clip(r.note || 'มาหาเพื่อนเล่นด้วยกัน!', 2000) + (link ? `\n🔗 ${link}` : ''),
    color: 0x7c5cff,
    fields: [
      ...discordRoomFields(r).slice(0, 2),
      { name: 'ผู้สร้าง', value: clip(host?.displayName || host?.username || 'ไม่ระบุ', 1024), inline: true },
      ...discordRoomFields(r).slice(2),
    ],
    url: link || undefined,
    timestamp: new Date(r.createdAt).toISOString(),
  });
}
// มีคนเข้าร่วมห้อง
function discordNotifyJoin(r, joiner) {
  const link = PUBLIC_URL ? `${PUBLIC_URL}/#/room/${r.id}` : '';
  const left = Math.max(0, r.size - r.members.length);
  discordSend({
    title: clip(`👋 มีคนเข้าร่วมห้อง ${r.title}`, 256),
    description: clip(`${joiner?.displayName || joiner?.username || 'ผู้เล่น'} เข้าร่วมแล้ว` + (left ? ` · ยังว่างอีก ${left} ที่` : ' · ห้องเต็มแล้ว 🎉'), 2000)
      + (link ? `\n🔗 ${link}` : ''),
    color: left ? 0x3ba55d : 0xe8b64c,
    fields: [
      ...discordRoomFields(r),
      { name: 'เจ้าของห้อง', value: clip(db.users[r.hostId]?.displayName || 'ไม่ระบุ', 1024), inline: true },
    ],
    url: link || undefined,
    timestamp: new Date().toISOString(),
  });
}

on('POST', '/api/rooms/:id/join', async ({ user, params, body }) => {
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง');
  if (r.members.includes(user.id)) return roomView(r, user.id);
  if ((r.banned || []).includes(user.id)) fail(403, 'คุณออกจากห้องนี้ไปแล้ว เข้าใหม่ไม่ได้');
  if (r.members.length >= r.size) fail(409, 'ห้องเต็มแล้ว');
  if (roomOfUser(user.id, r.id)) fail(409, BUSY_MSG);
  const { min, max } = rankRange(r);
  if (min) {
    const list = RANKS[r.game] || [];
    const mine = list.indexOf(String(body.rank || ''));
    if (mine < 0) fail(400, 'เลือกแรงค์ของคุณก่อนเข้าห้อง');
    if (mine < list.indexOf(min) || mine > list.indexOf(max)) fail(403, `ห้องนี้รับแรงค์ ${min} ถึง ${max} แรงค์ของคุณไม่อยู่ในช่วงนี้`);
  }
  if (r.approval) {
    r.requests = r.requests || [];
    if (!r.requests.some((q) => q.userId === user.id)) {
      r.requests.push({ userId: user.id, rank: String(body.rank || ''), at: Date.now() });
      notify(r.hostId, 'room', `${user.displayName} ขอเข้าห้อง "${r.title}"`);
      discordDmUser(r.hostId, `🙋 ${user.displayName} ขอเข้าห้อง "${r.title}"\nไปอนุมัติที่: ${PUBLIC_URL ? PUBLIC_URL + '/#/room/' + r.id : 'เว็บ GameBuddy'}`);
      save();
    }
    return { ...roomView(r, user.id), requested: true };
  }
  joinRoomNow(r, user);
  save();
  return roomView(r, user.id);
});

on('POST', '/api/rooms/:id/approve', async ({ user, params, body }) => {
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง');
  if (r.hostId !== user.id && !user.isAdmin) fail(403, 'เฉพาะเจ้าของห้องเท่านั้น');
  const q = (r.requests || []).find((x) => x.userId === String(body.userId || ''));
  if (!q) fail(404, 'ไม่พบคำขอนี้ (อาจถูกจัดการไปแล้ว)');
  if (!body.ok) {
    r.requests = r.requests.filter((x) => x !== q);
    notify(q.userId, 'room', `เจ้าของห้อง "${r.title}" ยังไม่รับคำขอเข้าห้องของคุณ`);
    discordDmUser(q.userId, `❌ คำขอเข้าห้อง "${r.title}" ยังไม่ได้รับการอนุมัติ`);
    save();
    return roomView(r, user.id);
  }
  if (r.members.length >= r.size) fail(409, 'ห้องเต็มแล้ว');
  if (roomOfUser(q.userId, r.id)) fail(409, 'ผู้ขอเข้ายังอยู่ในห้องอื่น ให้รอให้เขาออกก่อน');
  const target = db.users[q.userId];
  r.requests = r.requests.filter((x) => x !== q);
  if (target && !r.members.includes(q.userId)) {
    joinRoomNow(r, target);
    notify(q.userId, 'room', `เจ้าของห้อง "${r.title}" อนุมัติให้คุณเข้าห้องแล้ว`);
    discordDmUser(q.userId, `✅ ได้รับอนุมัติให้เข้าห้อง "${r.title}" แล้ว`);
  }
  save();
  return roomView(r, user.id);
});

on('POST', '/api/reports', async ({ user, body }) => {
  const type = body.type === 'user' ? 'user' : 'room';
  const targetId = String(body.targetId || '');
  const exists = type === 'user' ? !!db.users[targetId] : !!db.rooms[targetId];
  if (!exists) fail(404, 'ไม่พบสิ่งที่จะรายงาน');
  if (type === 'user' && targetId === user.id) fail(400, 'รายงานตัวเองไม่ได้');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) fail(400, 'กรุณาระบุเหตุผลสั้นๆ');
  if (db.reports.some((x) => x.by === user.id && x.targetId === targetId && x.status === 'open')) fail(409, 'คุณรายงานเรื่องนี้ไปแล้ว');
  db.reports.push({ id: nextId('rp'), by: user.id, type, targetId, reason, at: Date.now(), status: 'open' });
  save();
  return { ok: true };
});

on('GET', '/api/admin/reports', async ({ user }) => {
  requireMod(user);
  return db.reports.filter((x) => x.status === 'open').sort((a, b) => b.at - a.at).map((x) => ({
    id: x.id, type: x.type, reason: x.reason, at: x.at,
    by: pubMini(db.users[x.by]),
    target: x.type === 'user'
      ? pubMini(db.users[x.targetId])
      : { id: x.targetId, title: db.rooms[x.targetId]?.title || '(ห้องปิดแล้ว)', game: db.rooms[x.targetId]?.game || '' },
  }));
});

on('POST', '/api/admin/reports/:id/resolve', async ({ user, params }) => {
  requireMod(user);
  const rp = db.reports.find((x) => x.id === params.id);
  if (!rp) fail(404, 'ไม่พบรายงาน');
  rp.status = 'done';
  save();
  return { ok: true };
});

on('GET', '/api/rooms/:id', async ({ user, params }) => {
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง หรือห้องปิดไปแล้ว');
  return roomView(r, user.id);
});

// เริ่มนับเวลาดูโฆษณาเพื่อข้ามการรีวิว (จำลอง ยังไม่มีเครือข่ายโฆษณาจริง)
on('POST', '/api/rooms/:id/ad-start', async ({ user, params }) => {
  const r = db.rooms[params.id];
  if (!r || !r.members.includes(user.id)) fail(404, 'ไม่พบห้อง');
  r.adReady = r.adReady || {};
  const readyAt = Date.now() + AD_WAIT;
  r.adReady[user.id] = readyAt;
  return { readyAt };
});

// ออกจากห้อง ต้องอยู่ครบ 1 นาที และเลือกหนึ่งวิธี: รีวิวครบ / จ่ายเครดิต / ดูโฆษณา
// หัวห้องออก = ปิดห้อง
on('POST', '/api/rooms/:id/leave', async ({ user, params, body }) => {
  const r = db.rooms[params.id];
  if (!r || !r.members.includes(user.id)) fail(404, 'ไม่พบห้อง');
  const since = Date.now() - ((r.joinedAt || {})[user.id] || 0);
  if (since < ROOM_MIN_STAY) fail(403, `ต้องอยู่ในห้องอีก ${Math.ceil((ROOM_MIN_STAY - since) / 1000)} วินาทีก่อนออก`);
  if (body.mode === 'review') {
    if (unratedFor(r, user.id).length) fail(403, 'ต้องรีวิวผู้เล่นทุกคนในห้องก่อนออก');
  } else if (body.mode === 'pay') {
    if ((user.credits || 0) < ROOM_SKIP_COST) fail(402, `เครดิตไม่พอ ต้องใช้ ${ROOM_SKIP_COST} เครดิต`);
    user.credits -= ROOM_SKIP_COST;
  } else if (body.mode === 'ad') {
    const readyAt = (r.adReady || {})[user.id];
    if (!readyAt || Date.now() < readyAt) fail(403, 'ยังดูโฆษณาไม่ครบเวลา');
  } else {
    fail(400, 'รูปแบบการออกไม่ถูกต้อง');
  }
  if (r.adReady) delete r.adReady[user.id];
  if (r.hostId === user.id) {
    dissolveRoom(r);
    return { ok: true };
  }
  r.members = r.members.filter((m) => m !== user.id);
  r.banned = r.banned || [];
  r.banned.push(user.id);
  if (!r.members.length) deleteRoom(r);
  save();
  return { ok: true };
});

// แชทของห้อง เฉพาะสมาชิกที่อยู่ในห้องเท่านั้น
// เจ้าของห้องเตะผู้เล่นออก (เตะแล้วเข้าห้องนี้ซ้ำไม่ได้)
on('POST', '/api/rooms/:id/kick', async ({ user, params, body }) => {
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง');
  if (r.hostId !== user.id) fail(403, 'เฉพาะเจ้าของห้องเท่านั้นที่เตะผู้เล่นได้');
  const target = String(body.userId || '');
  if (target === user.id || !r.members.includes(target)) fail(400, 'ไม่พบผู้เล่นคนนี้ในห้อง');
  r.members = r.members.filter((m) => m !== target);
  r.banned = r.banned || [];
  if (!r.banned.includes(target)) r.banned.push(target);
  if (r.adReady) delete r.adReady[target];
  notify(target, 'room', `คุณถูกเจ้าของห้อง "${r.title}" เตะออกจากห้อง`);
  save();
  return roomView(r, user.id);
});

on('GET', '/api/rooms/:id/messages', async ({ user, params, token }) => {
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง');
  return (db.roomMsgs[r.id] || []).slice(-200).map((m) => ({
    id: m.id, mine: m.from === user.id, from: pubMini(db.users[m.from]), text: m.text,
    kind: m.kind || null, link: m.link || null, appLink: m.appLink || null,
    image: imageUrl(m.image, token) || null, audio: imageUrl(m.audio, token) || null, at: m.at,
  }));
});

on('POST', '/api/rooms/:id/messages', async ({ user, params, body }) => {
  const r = db.rooms[params.id];
  if (!r || !r.members.includes(user.id)) fail(403, 'ต้องอยู่ในห้องก่อนจึงจะส่งข้อความได้');
  const text = String(body.text || '').trim().slice(0, 300);
  const img = parseImage(body.image);
  const aud = parseAudio(body.audio);
  if (!text && !img && !aud) fail(400, 'ข้อความว่างเปล่า');
  const imageId = img ? await storeImage(user, img) : null;
  const audioId = aud ? await saveImage(aud) : null;
  const list = (db.roomMsgs[r.id] = db.roomMsgs[r.id] || []);
  list.push({ id: nextId('m'), from: user.id, text, image: imageId, audio: audioId, at: Date.now() });
  if (list.length > 500) list.splice(0, list.length - 500);
  save();
  return { ok: true };
});

// ===== Notifications =====
// เครื่องที่ลงแอปมือถือ: เก็บ token ไว้ให้ส่ง push ได้ (token เดียวผูกกับผู้ใช้คนเดียวล่าสุด)
on('POST', '/api/me/device', async ({ user, body }) => {
  const token = String(body.token || '').trim();
  if (!token || token.length > 400) fail(400, 'token ไม่ถูกต้อง');
  for (const uid of Object.keys(db.devices)) {
    db.devices[uid] = db.devices[uid].filter((t) => t !== token);
    if (!db.devices[uid].length) delete db.devices[uid];
  }
  db.devices[user.id] = [...(db.devices[user.id] || []), token].slice(-5);
  save();
  return { ok: true };
});

on('POST', '/api/me/notif-prefs', async ({ user, body }) => {
  const type = String(body.type || '');
  if (!PUSH_TYPES.includes(type)) fail(400, 'ประเภทการแจ้งเตือนไม่ถูกต้อง');
  user.notifPrefs = { ...(user.notifPrefs || {}), [type]: !!body.on };
  save();
  return { ok: true, notifPrefs: user.notifPrefs };
});

// เวอร์ชันล่าสุดของแอป (ตั้งใน Render: APP_LATEST_VERSION, APP_APK_URL)
on('GET', '/api/app-version', async () => ({
  latest: process.env.APP_LATEST_VERSION || '',
  apkUrl: process.env.APP_APK_URL || '',
}), true);

on('GET', '/api/notifications', async ({ user }) => {
  const mine = db.notifications.filter((n) => n.userId === user.id);
  return { items: mine.slice(0, 100), unread: mine.filter((n) => !n.read).length };
});

on('GET', '/api/notifications/count', async ({ user }) => ({
  unread: db.notifications.filter((n) => n.userId === user.id && !n.read).length,
  announcement: db.announcement || null,
}));

on('POST', '/api/notifications/read', async ({ user }) => {
  db.notifications.forEach((n) => { if (n.userId === user.id) n.read = true; });
  save();
  return { ok: true };
});

// ===== Admin =====
const requireAdmin = (user) => { if (!user?.isAdmin) fail(403, 'เฉพาะผู้ดูแลระบบหลัก'); };
// ยศ Sup Admin: ดูแลเรื่องกลั่นกรองได้ (ดูผู้ใช้ ห้องแชท ลบข้อความ ปิดห้อง แบน ประกาศ) แต่ไม่ได้ทำเรื่องเครดิต โฆษณา รหัสผ่าน และลบบัญชี
const isMod = (u) => !!(u?.isAdmin || u?.isSup);
const requireMod = (user) => { if (!isMod(user)) fail(403, 'เฉพาะผู้ดูแลระบบ'); };

on('GET', '/api/admin/stats', async ({ user }) => {
  requireAdmin(user);
  const paid = Object.values(db.orders).filter((o) => o.status === 'paid');
  return {
    users: Object.keys(db.users).length,
    friendships: db.friendships.filter((f) => f.status === 'accepted').length,
    messages: db.dms.length + Object.values(db.groups).reduce((a, g) => a + g.messages.length, 0),
    groups: Object.keys(db.groups).length,
    paidOrders: paid.length,
    revenue: paid.reduce((a, o) => a + o.price, 0),
    daily: [...Array(7)].map((_, i) => {
      const d = dayKey(Date.now() - (6 - i) * 86400000);
      return { day: d.slice(5), rooms: (db.dailyRooms || {})[d] || 0 };
    }),
    topGames: Object.entries(db.gameCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
});

on('GET', '/api/admin/users', async ({ user }) => {
  requireMod(user);
  return Object.values(db.users)
    .map((u) => ({
      id: u.id, username: u.username, displayName: u.displayName,
      credits: u.credits || 0, adFree: !!u.adFree, isAdmin: !!u.isAdmin, banned: !!u.banned, online: isOnline(u.id), isSup: !!u.isSup, createdAt: u.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
});

on('POST', '/api/admin/users/:id/credits', async ({ user, params, body }) => {
  requireAdmin(user);
  const target = db.users[params.id];
  if (!target) fail(404, 'ไม่พบผู้ใช้');
  const amount = Math.round(Number(body.amount));
  if (!Number.isFinite(amount)) fail(400, 'จำนวนไม่ถูกต้อง');
  target.credits = Math.max(0, (target.credits || 0) + amount);
  save();
  return { credits: target.credits };
});

on('DELETE', '/api/admin/users/:id', async ({ user, params }) => {
  requireAdmin(user);
  if (params.id === user.id) fail(400, 'ลบบัญชีของตัวเองไม่ได้');
  if (!db.users[params.id]) fail(404, 'ไม่พบผู้ใช้');
  delete db.users[params.id];
  db.friendships = db.friendships.filter((f) => f.from !== params.id && f.to !== params.id);
  for (const t of Object.keys(db.sessions)) if (db.sessions[t] === params.id) delete db.sessions[t];
  for (const g of Object.values(db.groups)) g.members = g.members.filter((m) => m !== params.id);
  for (const r of Object.values(db.rooms)) {
    r.members = r.members.filter((m) => m !== params.id);
    if (r.hostId === params.id || !r.members.length) deleteRoom(r);
  }
  save();
  return { ok: true };
});

on('POST', '/api/admin/users/:id/ban', async ({ user, params, body }) => {
  requireMod(user);
  const target = db.users[params.id];
  if (!target) fail(404, 'ไม่พบผู้ใช้');
  if (target.isAdmin || (target.isSup && !user.isAdmin)) fail(400, 'ระงับผู้ดูแลระบบไม่ได้ (Sup Admin ระงับกันเองไม่ได้)');
  target.banned = !!body.banned;
  if (target.banned) {
    for (const t of Object.keys(db.sessions)) if (db.sessions[t] === params.id) delete db.sessions[t];
    for (const r of Object.values(db.rooms)) {
      if (!r.members.includes(params.id)) continue;
      if (r.hostId === params.id) { dissolveRoom(r); continue; }
      r.members = r.members.filter((m) => m !== params.id);
      if (!r.members.length) deleteRoom(r);
    }
  }
  save();
  return { ok: true, banned: target.banned };
});

on('GET', '/api/admin/rooms', async ({ user }) => {
  requireMod(user);
  return Object.values(db.rooms).sort((a, b) => b.createdAt - a.createdAt).map((r) => ({
    id: r.id, game: r.game, title: r.title, size: r.size, count: r.members.length,
    host: pubMini(db.users[r.hostId]), rankText: rankLabel(r), createdAt: r.createdAt,
  }));
});

on('GET', '/api/admin/rooms/:id/messages', async ({ user, params, token }) => {
  requireMod(user);
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง หรือห้องปิดไปแล้ว');
  return (db.roomMsgs[r.id] || []).slice(-300).map((m) => ({
    id: m.id, from: pubMini(db.users[m.from]), text: m.text, kind: m.kind || null,
    image: imageUrl(m.image, token) || null, audio: imageUrl(m.audio, token) || null, at: m.at,
  }));
});

on('DELETE', '/api/admin/rooms/:id/messages/:msgId', async ({ user, params }) => {
  requireMod(user);
  const list = db.roomMsgs[params.id] || [];
  const i = list.findIndex((m) => String(m.id) === String(params.msgId));
  if (i < 0) fail(404, 'ไม่พบข้อความ');
  list.splice(i, 1);
  save();
  return { ok: true };
});

on('POST', '/api/admin/rooms/:id/close', async ({ user, params }) => {
  requireMod(user);
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง');
  dissolveRoom(r);
  return { ok: true };
});

on('POST', '/api/admin/users/:id/sup', async ({ user, params, body }) => {
  requireAdmin(user);
  const target = db.users[params.id];
  if (!target) fail(404, 'ไม่พบผู้ใช้');
  if (target.isAdmin) fail(400, 'ผู้ดูแลระบบหลักไม่ต้องมียศนี้');
  target.isSup = !!body.on;
  save();
  return { ok: true, isSup: target.isSup };
});

on('GET', '/api/admin/orders', async ({ user }) => {
  requireAdmin(user);
  return Object.values(db.orders).slice(-50).reverse().map((o) => ({
    id: o.id, username: db.users[o.userId]?.username || '-', credits: o.credits, price: o.price, status: o.status, at: o.at,
  }));
});

// โฆษณาที่แอดมินตั้งได้เอง: หัวข้อ ข้อความ ลิงก์ (https เท่านั้น) และรูป
on('GET', '/api/ad', async ({ token }) => {
  if (!db.ad) return null;
  return { title: db.ad.title, text: db.ad.text, link: db.ad.link, image: imageUrl(db.ad.image, token) || null };
});

on('PUT', '/api/admin/ad', async ({ user, body }) => {
  requireAdmin(user);
  if (body.clear) { db.ad = null; save(); return { ok: true }; }
  const title = String(body.title || '').trim().slice(0, 40);
  const text = String(body.text || '').trim().slice(0, 120);
  const link = String(body.link || '').trim();
  if (link && !/^https?:\/\/\S+$/i.test(link)) fail(400, 'ลิงก์ต้องขึ้นต้นด้วย https:// หรือ http://');
  if (!title && !text) fail(400, 'กรุณาใส่หัวข้อหรือข้อความโฆษณา');
  let image = (db.ad && db.ad.image) || null;
  if (body.image === null) image = null;
  else if (typeof body.image === 'string' && body.image.startsWith('data:')) image = await saveImage(parseImage(body.image));
  db.ad = { title, text, link, image, updatedAt: Date.now() };
  save();
  return { ok: true };
});

on('POST', '/api/admin/announce', async ({ user, body }) => {
  requireMod(user);
  const text = String(body.text || '').trim().slice(0, 200);
  if (!text) fail(400, 'กรุณาใส่ข้อความประกาศ');
  const ids = Object.keys(db.users);
  db.announcement = { id: nextId('ann'), text, at: Date.now() };
  for (const id of ids) notify(id, 'announce', `📢 ${text}`);
  save();
  return { sent: ids.length };
});

on('POST', '/api/admin/password', async ({ user, body }) => {
  requireAdmin(user);
  const pw = String(body.password || '');
  if (pw.length < 6) fail(400, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
  Object.assign(user, hashPw(pw));
  save();
  return { ok: true };
});

// ---------- HTTP server ----------
// ---------- Google login (OAuth 2.0) ----------
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
async function handleGoogle(req, res, url) {
  const home = (msg) => redirect(res, '/' + (msg ? '?err=' + encodeURIComponent(msg) : '') + '#/home');
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !PUBLIC_URL) return home('ยังไม่ได้ตั้งค่า Google login');
  const redirectUri = PUBLIC_URL + '/api/auth/google/callback';

  if (url.pathname === '/api/auth/google') {
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const p = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid profile', state, prompt: 'select_account',
    });
    return redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?' + p);
  }

  // /api/auth/google/callback
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const exp = oauthStates.get(state);
  oauthStates.delete(state);
  if (!code || !exp || Date.now() > exp) return home('การเข้าสู่ระบบหมดอายุ ลองใหม่อีกครั้ง');
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    });
    const tok = await tr.json();
    if (!tok.access_token) throw new Error('no access token');
    const ur = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tok.access_token },
    });
    const info = await ur.json();
    if (!info.sub) throw new Error('no user info');

    let u = Object.values(db.users).find((x) => x.googleId === info.sub);
    if (!u) {
      u = createUser({
        username: 'g' + crypto.randomBytes(4).toString('hex'),
        password: null,
        displayName: String(info.name || 'ผู้เล่น').trim().slice(0, 24) || 'ผู้เล่น',
      });
      u.googleId = info.sub;
      save();
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = u.id;
    save();
    return redirect(res, `/?gt=${token}#/home`);
  } catch (e) {
    console.error('Google login ผิดพลาด:', e.message);
    return home('เข้าสู่ระบบด้วย Google ไม่สำเร็จ ลองใหม่อีกครั้ง');
  }
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8'); // กันตัวอักษรไทยเพี้ยนเมื่อข้อมูลถูกแบ่งเป็นหลายก้อน
    req.on('data', (c) => {
      d += c;
      if (d.length > 2.5e6) { req.destroy(); reject(new HttpError(413, 'ข้อมูลใหญ่เกินไป')); }
    });
    req.on('end', () => {
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); } catch { reject(new HttpError(400, 'รูปแบบข้อมูลไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route) fail(404, 'ไม่พบ API นี้');
  const m = url.pathname.match(route.re);
  const params = {};
  route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  let user = null;
  // โทเคนทางลิงก์ (?t=) ใช้ได้เฉพาะรูปภาพ เพราะแท็ก img ส่ง header ไม่ได้
  const queryToken = url.pathname.startsWith('/api/images/') ? url.searchParams.get('t') : '';
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || queryToken || '';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!route.open) {
    const uid = db.sessions[token];
    if (!uid || !db.users[uid]) fail(401, 'กรุณาเข้าสู่ระบบใหม่');
    if (db.users[uid].banned) fail(403, 'บัญชีนี้ถูกระงับการใช้งาน');
    presence[uid] = Date.now();
    user = db.users[uid];
  }
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
  const result = await route.handler({ body, params, user, token, ip, query: url.searchParams });
  if (result && result.__raw) {
    res.writeHead(200, { 'Content-Type': result.mime, 'Cache-Control': 'private, max-age=86400' });
    return res.end(result.buf);
  }
  send(res, 200, result ?? { ok: true });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function serveStatic(p, res) {
  const file = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // ส่ง index.html กลับไปเสมอ เพื่อให้ hash route ทำงาน
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}


// ---------- Discord (Interactions: คำสั่ง slash ผ่าน HTTP ไม่ต้องรันบอทค้างไว้) ----------
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';
const DISCORD_APP_ID = process.env.DISCORD_APP_ID || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

// ตรวจลายเซ็น Ed25519 ตามที่ Discord กำหนด (ปฏิเสธคำขอที่ไม่ได้มาจาก Discord)
function verifyDiscord(req, raw) {
  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  if (!sig || !ts || !DISCORD_PUBLIC_KEY) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(DISCORD_PUBLIC_KEY, 'hex')]),
      format: 'der', type: 'spki',
    });
    return crypto.verify(null, Buffer.from(ts + raw), key, Buffer.from(String(sig), 'hex'));
  } catch { return false; }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 100000) { reject(new HttpError(413, 'ข้อมูลใหญ่เกินไป')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function discordReply(res, data) {
  send(res, 200, { type: 4, data: { flags: 64, ...data } }); // flags 64 = ข้อความเห็นเฉพาะผู้ใช้คำสั่ง
}

async function handleDiscord(req, res) {
  const raw = await readRaw(req);
  if (!verifyDiscord(req, raw)) return send(res, 401, { error: 'invalid request signature' });
  const body = JSON.parse(raw || '{}');
  if (body.type === 1) return send(res, 200, { type: 1 }); // PING จาก Discord ตอนตั้งค่า Endpoint
  if (body.type !== 2) return send(res, 400, { error: 'unsupported' });

  const name = body.data?.name;
  const discordId = body.member?.user?.id || body.user?.id || '';

  if (name === 'link') {
    if (!discordId) return discordReply(res, { content: 'ไม่พบบัญชีดิสของคุณ' });
    const linkedUid = db.discordLinks[discordId];
    if (linkedUid && db.users[linkedUid]) {
      return discordReply(res, { content: `✅ บัญชีดิสนี้เชื่อมกับ GameBuddy อยู่แล้ว (${db.users[linkedUid].displayName || db.users[linkedUid].username || 'บัญชีเว็บ'})\nถ้าต้องการเปลี่ยนบัญชี ไปที่ My Page → เชื่อมดิสคอร์ด แล้วกดยกเลิกการเชื่อมก่อน` });
    }
    const now = Date.now();
    for (const [c, v] of Object.entries(db.discordCodes)) if (now - v.at > 10 * 60 * 1000) delete db.discordCodes[c];
    const code = String(crypto.randomInt(100000, 1000000));
    db.discordCodes[code] = { discordId, at: now };
    save();
    return discordReply(res, { content: `🔗 รหัสเชื่อมบัญชีของคุณคือ **${code}**\nไปที่ My Page ในเว็บ → เชื่อมดิสคอร์ด แล้วกรอกรหัสนี้ภายใน 10 นาที` });
  }

  if (name === 'create') {
    const uid = db.discordLinks[discordId];
    if (!uid || !db.users[uid]) return discordReply(res, { content: 'ยังไม่ได้เชื่อมบัญชี GameBuddy ใช้คำสั่ง /link ก่อน' });
    const opts = Object.fromEntries((body.data.options || []).map((o) => [o.name, o.value]));
    const game = String(opts.game || '');
    if (!META.games.includes(game)) return discordReply(res, { content: 'ไม่รู้จักเกมนี้' });
    const size = Math.round(Number(opts.size));
    const maxSize = PARTY_SIZE[game] || ROOM_MAX;
    if (!(size >= 2 && size <= maxSize)) return discordReply(res, { content: `${game} ปาร์ตี้ได้สูงสุด ${maxSize} คน` });
    if (roomOfUser(uid)) return discordReply(res, { content: BUSY_MSG });
    const title = String(opts.title || '').trim().slice(0, 40) || `${game} ปาร์ตี้`;
    const r = {
      id: nextId('rm'), game, size, hostId: uid, members: [uid], title, note: '', rank: '', desc: '',
      createdAt: Date.now(), joinedAt: { [uid]: Date.now() }, banned: [],
    };
    db.rooms[r.id] = r;
    db.roomMsgs[r.id] = [];
    save();
    countRoom(r);
    bumpStat(uid, 'hosted');
    discordNotifyRoom(r, db.users[uid]);
    const link = PUBLIC_URL ? `${PUBLIC_URL}/#/room/${r.id}` : '';
    return discordReply(res, { embeds: [{
      title: `🎮 สร้างห้องแล้ว: ${r.title}`,
      description: `${r.game} · ${size} คน`,
      color: 0x7c5cff,
      url: link || undefined,
      fields: [{ name: 'เปิดในเว็บ', value: link || 'ยังไม่ได้ตั้งค่า PUBLIC_URL' }],
    }] });
  }

  if (name === 'web') {
    return discordReply(res, { content: PUBLIC_URL ? `🎮 เข้าเว็บ GameBuddy ได้ที่ ${PUBLIC_URL}` : 'ยังไม่ได้ตั้งค่า PUBLIC_URL' });
  }
  if (name === 'party') {
    const gameOpt = (body.data.options || []).find((o) => o.name === 'game');
    const game = gameOpt ? String(gameOpt.value) : '';
    const rooms = Object.values(db.rooms)
      .filter((r) => r.members.length < r.size && (!game || r.game === game))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
    if (!rooms.length) {
      return discordReply(res, { content: 'ตอนนี้ยังไม่มีห้องว่าง ลองสร้างห้องใหม่ที่เว็บ GameBuddy ได้เลย' });
    }
    const embeds = rooms.map((r) => ({
      title: r.title,
      description: r.note || '',
      color: 0x7c5cff,
      fields: [
        { name: 'เกม', value: r.game, inline: true },
        { name: 'ที่ว่าง', value: `${r.size - r.members.length}/${r.size} คน`, inline: true },
        { name: 'ผู้สร้าง', value: db.users[r.hostId]?.displayName || 'ไม่ระบุ', inline: true },
      ],
      url: PUBLIC_URL ? `${PUBLIC_URL}/#/room/${r.id}` : undefined,
    }));
    return discordReply(res, { embeds });
  }
  return discordReply(res, { content: 'ไม่รู้จักคำสั่งนี้' });
}

async function discordApi(method, p, body) {
  if (!DISCORD_BOT_TOKEN) throw new HttpError(503, 'ยังไม่ได้ตั้งค่า DISCORD_BOT_TOKEN');
  const r = await fetch('https://discord.com/api/v10' + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new HttpError(502, `Discord ตอบกลับผิดพลาด (${r.status}) ตรวจสิทธิ์ของบอทในเซิร์ฟเวอร์`);
  return r.status === 204 ? null : r.json();
}

// ช่องเสียงดิสคอร์ด: สร้างชื่อ Vc-001, Vc-002, ... และลบอัตโนมัติหลัง 3 ชั่วโมง
const VC_TTL = 3 * 60 * 60 * 1000;
// ย้ายผู้ใช้เข้าช่องเสียง: ทำได้เฉพาะคนที่เชื่อม /link แล้วและกำลังอยู่ในช่องเสียงดิสอยู่แล้ว
// คืนค่า null = ยังไม่ได้เชื่อมดิส, true = ย้ายสำเร็จ, false = ไม่ได้อยู่ในช่องเสียง
async function tryMoveUser(guild, userId, channelId) {
  const did = Object.keys(db.discordLinks).find((k) => db.discordLinks[k] === userId);
  if (!did) return null;
  try {
    await discordApi('PATCH', `/guilds/${guild}/members/${did}`, { channel_id: channelId });
    return true;
  } catch { return false; }
}
// เรียงช่อง Vc-NNN ในหมวดเดียวกันตามเลข (น้อยอยู่บน) โดยใช้ตำแหน่งเดิมของช่องเหล่านั้น
async function sortVcChannels(guild, parentId) {
  const all = await discordApi('GET', `/guilds/${guild}/channels`);
  const parent = parentId || null;
  const vcs = all
    .filter((c) => c.type === 2 && (c.parent_id || null) === parent && /^Vc-\d+$/.test(c.name))
    .sort((a, b) => Number(a.name.slice(3)) - Number(b.name.slice(3)));
  if (vcs.length < 2) return;
  await discordApi('PATCH', `/guilds/${guild}/channels`, vcs.map((c, i) => ({ id: c.id, position: i })));
}
function sweepVc() {
  const now = Date.now();
  const old = db.vcChannels.filter((v) => now - v.createdAt >= VC_TTL);
  if (!old.length) return;
  db.vcChannels = db.vcChannels.filter((v) => now - v.createdAt < VC_TTL);
  for (const v of old) {
    discordApi('DELETE', `/channels/${v.channelId}`).catch((e) => console.error('ลบช่องดิสไม่สำเร็จ:', e.message));
  }
  save();
}
setInterval(sweepVc, 10 * 60 * 1000).unref();

// กดปุ่มในห้อง: สร้างช่องเสียงใหม่ Vc-NNN แล้วส่งลิงก์เชิญเข้าแชทห้อง (ถ้าห้องนี้มีช่องที่ยังไม่หมดอายุอยู่แล้วจะใช้ช่องเดิม)
on('POST', '/api/rooms/:id/discord', async ({ user, params }) => {
  const r = db.rooms[params.id];
  if (!r || !r.members.includes(user.id)) fail(403, 'ต้องอยู่ในห้องก่อนจึงจะสร้างช่องดิสได้');
  const guild = process.env.DISCORD_GUILD_ID || '';
  if (!guild) fail(503, 'ยังไม่ได้ตั้งค่า DISCORD_GUILD_ID');
  // ดูรายการช่องจริงในดิส: ช่องที่ถูกลบมือในดิสจะถูกตัดออกจากระบบ (เลขจะว่างกลับมาใช้ได้)
  const liveChannels = await discordApi('GET', `/guilds/${guild}/channels`);
  const live = new Set(liveChannels.map((c) => c.id));
  db.vcChannels = db.vcChannels.filter((v) => live.has(v.channelId));
  if (r.discord?.url && Date.now() - r.discord.createdAt < VC_TTL && live.has(r.discord.channelId)) {
    const moved = await tryMoveUser(guild, user.id, r.discord.channelId);
    return { url: r.discord.url, appUrl: r.discord.appUrl, created: false, moved };
  }
  // ใช้เลขที่เล็กที่สุดที่ยังว่างอยู่ (เช่น ถ้ามี 002 กับ 003 จะได้ 001 ก่อน)
  const used = new Set(db.vcChannels.map((v) => v.n));
  let n = 1;
  while (used.has(n)) n++;
  const name = `Vc-${String(n).padStart(3, '0')}`;
  const ch = await discordApi('POST', `/guilds/${guild}/channels`, {
    name, type: 2, user_limit: 0, parent_id: process.env.DISCORD_VC_CATEGORY_ID || undefined,
  });
  sortVcChannels(guild, process.env.DISCORD_VC_CATEGORY_ID).catch((e) => console.error('เรียงช่องดิสไม่สำเร็จ:', e.message));
  const inv = await discordApi('POST', `/channels/${ch.id}/invites`, { max_age: 86400, max_uses: 0 });
  const url = `https://discord.gg/${inv.code}`;
  const appUrl = `discord://discord.com/channels/${guild}/${ch.id}`;
  r.discord = { channelId: ch.id, url, appUrl, createdAt: Date.now() };
  db.vcChannels.push({ channelId: ch.id, createdAt: Date.now(), n });
  const moved = await tryMoveUser(guild, user.id, ch.id);
  const list = (db.roomMsgs[r.id] = db.roomMsgs[r.id] || []);
  list.push({ id: nextId('m'), from: user.id, text: moved ? `บอทย้ายคุณเข้า ${name} แล้ว` : `ช่องเสียง ${name} พร้อมแล้ว`, kind: 'discord', link: url, appLink: appUrl, image: null, audio: null, at: Date.now() });
  save();
  return { url, appUrl, created: true, moved };
});

// ลงทะเบียนคำสั่ง slash ให้บอท (รันตอนเริ่มเซิร์ฟเวอร์ ถ้าตั้ง DISCORD_APP_ID และ DISCORD_BOT_TOKEN)
async function registerDiscordCommands() {
  if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN) return;
  const commands = [
    { name: 'party', description: 'ดูห้องปาร์ตี้ที่ยังว่างอยู่', options: [{
      name: 'game', description: 'กรองตามเกม', type: 3, required: false,
      choices: META.games.slice(0, 25).map((g) => ({ name: g, value: g })),
    }] },
    { name: 'web', description: 'ลิงก์เข้าเว็บ GameBuddy' },
    { name: 'link', description: 'ขอรหัสเชื่อมบัญชี GameBuddy กับดิสของคุณ' },
    { name: 'create', description: 'สร้างห้องปาร์ตี้ใน GameBuddy (ต้องเชื่อมบัญชีก่อน)', options: [
      { name: 'game', description: 'เกม', type: 3, required: true, choices: META.games.slice(0, 25).map((g) => ({ name: g, value: g })) },
      { name: 'size', description: 'จำนวนคนทั้งหมด (รวมคุณ)', type: 4, required: true, min_value: 2, max_value: 11 },
      { name: 'title', description: 'ชื่อห้อง (ไม่บังคับ)', type: 3, required: false },
    ] },
  ];
  try {
    const r = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      body: JSON.stringify(commands),
    });
    if (!r.ok) console.error('ลงทะเบียนคำสั่ง Discord ไม่สำเร็จ:', r.status, await r.text());
    else console.log('ลงทะเบียนคำสั่ง Discord แล้ว');
  } catch (e) { console.error('ลงทะเบียนคำสั่ง Discord ล้มเหลว:', e.message); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (url.pathname.startsWith('/api/auth/google')) return await handleGoogle(req, res, url);
    if (url.pathname === '/api/discord/interactions' && req.method === 'POST') return await handleDiscord(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(url.pathname, res);
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
});

// ---------- Startup ----------
function seed() {
  if (!SEED_DEMO || Object.keys(db.users).length) return;
  const demos = [
    ['demo1', 'ฟ้า', ['APEX Legends', 'Valorant'], 'เสาร์-อาทิตย์ 19:00-22:00', 'เก่ง', '🐱'],
    ['demo2', 'ปลาย', ['Minecraft', 'Among Us'], 'ทุกวัน 20:00-23:00', 'เริ่มต้น', '🦊'],
    ['demo3', 'บอส', ['League of Legends', 'Overwatch 2'], 'จันทร์-ศุกร์ 18:00-21:00', 'สายโปร', '🐯'],
    ['demo4', 'มินท์', ['Genshin Impact'], 'เสาร์ 14:00-17:00', 'ปานกลาง', '🐼'],
    ['demo5', 'เอ็ม', ['Fortnite', 'APEX Legends'], 'อาทิตย์ 10:00-13:00', 'ปานกลาง', '🐸'],
  ];
  for (const [username, displayName, games, schedule, level, avatar] of demos) {
    const u = createUser({ username, password: 'demo1234', displayName });
    Object.assign(u, { games, schedule, level, avatar, bio: 'ยินดีที่ได้รู้จักทุกคน!' });
  }
  const ids = Object.keys(db.users);
  db.ratings.push({ id: nextId('r'), from: ids[1], to: ids[0], score: 5, comment: 'เล่นสนุกมาก', at: Date.now() });
  db.ratings.push({ id: nextId('r'), from: ids[2], to: ids[0], score: 4, comment: 'สื่อสารดี', at: Date.now() });
  save();
}

// สร้างบัญชี admin ถ้ายังไม่มี
function ensureAdmin() {
  if (Object.values(db.users).some((u) => u.isAdmin)) return;
  if (Object.values(db.users).some((u) => u.username === 'admin')) return;
  // ไม่มีรหัสผ่านเริ่มต้นที่เดาได้ ถ้าไม่ได้ตั้ง ADMIN_PASSWORD จะสุ่มให้และแสดงใน log ครั้งเดียว
  let pw = process.env.ADMIN_PASSWORD || '';
  const generated = pw.length < 6;
  if (generated) pw = crypto.randomBytes(9).toString('base64url');
  const u = createUser({ username: 'admin', password: pw, displayName: 'ผู้ดูแลระบบ' });
  u.isAdmin = true;
  save();
  console.log(generated
    ? `สร้างบัญชี admin แล้ว ไม่ได้ตั้ง ADMIN_PASSWORD (หรือสั้นกว่า 6 ตัว) จึงสุ่มรหัสผ่านให้: ${pw}`
    : 'สร้างบัญชี admin แล้ว ด้วยรหัสผ่านจาก ADMIN_PASSWORD');
}

async function main() {
  if (!MONGODB_URI) {
    console.error('ยังไม่ได้ตั้งค่า MONGODB_URI');
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const mdb = client.db(DB_NAME);
  stateCol = mdb.collection('state');
  imageCol = mdb.collection('images');
  await loadDb();
  seed();
  ensureAdmin();
  await flush();
  server.listen(PORT, () => console.log(`GameBuddy running on port ${PORT}`));
  registerDiscordCommands();
  // ตอน Render อัปเดตหรือหยุดแอป ให้บันทึกข้อมูลที่ค้างอยู่ก่อนปิด
  const shutdown = async () => {
    clearTimeout(saveTimer);
    try { await saving; await flush(); } catch (e) { console.error('บันทึกก่อนปิดไม่สำเร็จ:', e.message); }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('เริ่มเซิร์ฟเวอร์ไม่สำเร็จ:', e.message);
  process.exit(1);
});