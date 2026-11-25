// Kurote server: serves index.html and relays game state between the two players of a room.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// Only these files are served; every other path returns the game page.
const FILES = {
  '/cat.png': ['cat.png', 'image/png'],
  '/secret.ogg': ['secret.ogg', 'audio/ogg'],
  '/move.ogg': ['move.ogg', 'audio/ogg'],
  '/take.ogg': ['take.ogg', 'audio/ogg'],
  '/win.ogg': ['win.ogg', 'audio/ogg']
};

// ---------------------------------------------------------------------------
// Accounts: name + password, saved look and win/loss records per game.
// Stored in DATA_DIR/users.json (set DATA_DIR to a persistent disk on your host).
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');
let db = { secret: crypto.randomBytes(32).toString('hex'), users: {} };
try { fs.mkdirSync(DATA_DIR, { recursive: true }); db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
let saveT = null;
const saveDb = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }, 300);
};
saveDb(); // makes sure the signing secret survives a restart
const GAMES = ['kij', 'elder', 'cotw'];
const TOKEN_MS = 30 * 24 * 3600 * 1000;
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => e ? no(e) : ok(k)));
const sign = t => crypto.createHmac('sha256', db.secret).update(t).digest('base64url');
const mkToken = name => { const t = name + '.' + (Date.now() + TOKEN_MS); return t + '.' + sign(t); };
const userFrom = req => {
  const h = req.headers.authorization || '', m = /^Bearer (\S+)$/.exec(h); if (!m) return null;
  const parts = m[1].split('.'); if (parts.length !== 3) return null;
  const t = parts[0] + '.' + parts[1], a = Buffer.from(sign(t)), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || Number(parts[1]) < Date.now()) return null;
  return db.users[parts[0]] || null;
};
const emptyStats = () => Object.fromEntries(GAMES.map(g => [g, { w: 0, l: 0, d: 0, streak: 0, best: 0 }]));
const pub = u => ({ name: u.display, settings: u.settings || {}, stats: u.stats });
const cleanSettings = s => {
  const o = {}; if (!s || typeof s !== 'object') return o;
  for (const k of ['pal', 'pc', 'sh', 'epal', 'epc', 'esh', 'cpal', 'cpc', 'csh']) if (typeof s[k] === 'string' && /^[a-z]{1,12}$/.test(s[k])) o[k] = s[k];
  if (['auto', 'light', 'dark'].includes(s.mode)) o.mode = s.mode;
  if (typeof s.dos === 'boolean') o.dos = s.dos;
  return o;
};
const tries = new Map(); // ip -> [count, windowStart]
const tooMany = ip => {
  const now = Date.now(), t = tries.get(ip);
  if (!t || now - t[1] > 60000) { tries.set(ip, [1, now]); return false; }
  return ++t[0] > 10;
};
setInterval(() => { const now = Date.now(); for (const [k, v] of tries) if (now - v[1] > 60000) tries.delete(k); }, 60000);
const lastRes = new Map(); // name -> timestamp of last recorded result
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
const readBody = (req, cb) => {
  let n = 0; const ch = [];
  req.on('data', c => { n += c.length; if (n > 4096) req.destroy(); else ch.push(c); });
  req.on('end', () => { try { cb(JSON.parse(Buffer.concat(ch).toString() || '{}')); } catch { cb(null); } });
};
const DUMMY = crypto.randomBytes(16);
async function api(req, res) {
  const url = req.url.split('?')[0], ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'GET' && url === '/api/me') {
    const u = userFrom(req); return u ? json(res, 200, { user: pub(u) }) : json(res, 401, { err: 'Signed out.' });
  }
  if (req.method !== 'POST') return json(res, 405, { err: 'Method not allowed.' });
  readBody(req, async b => {
    if (!b || typeof b !== 'object') return json(res, 400, { err: 'Bad request.' });
    try {
      if (url === '/api/register' || url === '/api/login') {
        if (tooMany(ip)) return json(res, 429, { err: 'Too many attempts. Wait a minute and try again.' });
        const raw = String(b.name || '').trim(), name = raw.toLowerCase(), pw = String(b.pass || '');
        if (url === '/api/register') {
          if (!/^[a-z0-9_]{3,16}$/.test(name)) return json(res, 400, { err: 'Name: 3 to 16 letters, digits or underscores.' });
          if (pw.length < 6 || pw.length > 64) return json(res, 400, { err: 'Password: 6 to 64 characters.' });
          if (db.users[name]) return json(res, 409, { err: 'That name is taken.' });
          if (Object.keys(db.users).length >= 5000) return json(res, 503, { err: 'No new accounts right now.' });
          const salt = crypto.randomBytes(16), hash = await scrypt(pw, salt);
          if (db.users[name]) return json(res, 409, { err: 'That name is taken.' });
          db.users[name] = { display: raw, salt: salt.toString('hex'), hash: hash.toString('hex'), created: Date.now(), settings: cleanSettings(b.settings), stats: emptyStats() };
          saveDb(); return json(res, 200, { token: mkToken(name), user: pub(db.users[name]) });
        }
        const u = db.users[name], salt = u ? Buffer.from(u.salt, 'hex') : DUMMY, hash = await scrypt(pw, salt);
        if (!u || !crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) return json(res, 401, { err: 'Wrong name or password.' });
        return json(res, 200, { token: mkToken(name), user: pub(u) });
      }
      const u = userFrom(req); if (!u) return json(res, 401, { err: 'Signed out.' });
      const key = u.display.toLowerCase();
      if (url === '/api/save') { u.settings = cleanSettings(b.settings); saveDb(); return json(res, 200, { ok: true }); }
      if (url === '/api/result') {
        const g = b.game, r = b.result;
        if (!GAMES.includes(g) || !['win', 'loss', 'draw'].includes(r)) return json(res, 400, { err: 'Bad result.' });
        const now = Date.now(); if (now - (lastRes.get(key) || 0) < 3000) return json(res, 429, { err: 'Too fast.' });
        lastRes.set(key, now);
        const st = u.stats[g] || (u.stats[g] = { w: 0, l: 0, d: 0, streak: 0, best: 0 });
        if (r === 'win') { st.w++; st.streak++; st.best = Math.max(st.best, st.streak); } else if (r === 'loss') { st.l++; st.streak = 0; } else st.d++;
        saveDb(); return json(res, 200, { stats: u.stats });
      }
      if (url === '/api/delete') {
        const hash = await scrypt(String(b.pass || ''), Buffer.from(u.salt, 'hex'));
        if (!crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) return json(res, 401, { err: 'Wrong password.' });
        delete db.users[key]; saveDb(); return json(res, 200, { ok: true });
      }
      json(res, 404, { err: 'Not found.' });
    } catch { json(res, 500, { err: 'Server error.' }); }
  });
}
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  const f = FILES[req.url.split('?')[0]] || ['index.html', 'text/html; charset=utf-8'];
  fs.readFile(path.join(__dirname, f[0]), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': f[1] });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server: srv, maxPayload: 8192 });
const rooms = new Map();

const getRoom = c => {
  let r = rooms.get(c);
  if (!r) { r = { state: null, socks: new Set(), timer: null }; rooms.set(c, r); }
  return r;
};
const peers = r => {
  const o = { Y: false, G: false, S: 0 };
  for (const s of r.socks) s.role === 'S' ? o.S++ : (o[s.role] = true);
  return o;
};
const send = (s, m) => { if (s.readyState === 1) s.send(JSON.stringify(m)); };
const bc = (r, m, except) => { for (const s of r.socks) if (s !== except) send(s, m); };
const okState = st => st && Number.isInteger(st.seq) && st.seq >= 0 &&
  (st.game !== 'diag' || st.n === 6 || st.n === 8) &&
  Array.isArray(st.B) && st.B.length === (st.game === 'diag' ? st.n * st.n : st.game === 'cotw' ? 49 : 25) && st.B.every(v => v === null || v === 'Y' || v === 'G') &&
  (st.turn === 'Y' || st.turn === 'G') &&
  (st.game === 'elder'
    ? Array.isArray(st.E) && st.E.length === 25
    : st.game === 'cotw'
      ? Array.isArray(st.K) && st.K.length === 49 && Array.isArray(st.S) && st.S.length === 49
      : st.game === 'diag'
        ? Array.isArray(st.D) && st.D.length === st.B.length
      : Array.isArray(st.X) && st.X.length === 25 && st.R && st.C);

wss.on('connection', ws => {
  ws.alive = true; ws.room = null; ws.role = null;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if ((m.t === 'join' || m.t === 'create') && !ws.room) {
      if (typeof m.code !== 'string' || !/^[a-z0-9]{3,12}$/.test(m.code)) return send(ws, { t: 'err', msg: 'Bad room code. Use 3 to 12 letters or digits.' });
      const game = ['elder', 'cotw', 'diag'].includes(m.game) ? m.game : 'kij';
      const exists = rooms.has(m.code);
      if (m.t === 'create' && exists) return send(ws, { t: 'err', msg: 'That room code is already taken.' });
      if (m.t === 'join' && !exists) return send(ws, { t: 'err', msg: 'Room not found. Check the code, or create a room.' });
      if (!exists && rooms.size >= 99) return send(ws, { t: 'err', msg: 'The server is full, try again later.' });
      if (m.t === 'join' && rooms.get(m.code).game !== game) return send(ws, { t: 'err', msg: 'That room is for a different game.' });
      const r = getRoom(m.code);
      if (!exists) r.game = game;
      clearTimeout(r.timer);
      const taken = [...r.socks].map(s => s.role);
      ws.role = ['Y', 'G'].find(x => !taken.includes(x)) || 'S';
      ws.room = r; ws.code = m.code; r.socks.add(ws);
      if (!r.host || !r.socks.has(r.host)) r.host = ws; // first one in (or the first back into an empty room) hosts
      send(ws, { t: 'hello', role: ws.role, state: r.state, peers: peers(r), game: r.game, host: r.host === ws });
      bc(r, { t: 'peers', peers: peers(r) }, ws);
    } else if (m.t === 'state' && ws.room && ws.role !== 'S') {
      const r = ws.room, st = m.state;
      const ok = okState(st) && ((st.game || 'kij') === r.game) && (!r.state || (st.seq > r.state.seq && (m.reset === true || ws.role === r.state.turn)));
      if (ok) { r.state = st; bc(r, { t: 'state', state: st }, ws); }
      else if (r.state) send(ws, { t: 'state', state: r.state, force: true });
    } else if (m.t === 'style' && ws.room && ws.room.host === ws) {
      // host-only: change palette / pawn colors / pawn shape at any time without touching the game position
      const r = ws.room, s = m.style && typeof m.style === 'object' ? m.style : {}, clean = {};
      for (const k of ['pal', 'pc', 'sh']) if (typeof s[k] === 'string' && /^[a-z]{1,12}$/.test(s[k])) clean[k] = s[k];
      if (!Object.keys(clean).length) return;
      if (r.state) Object.assign(r.state, clean);
      bc(r, { t: 'style', style: clean }, ws);
    }
  });
  ws.on('close', () => {
    const r = ws.room; if (!r) return;
    r.socks.delete(ws);
    if (r.host === ws) {
      // host left: hand the room to the other player, else a spectator, and tell everyone
      const rest = [...r.socks];
      r.host = rest.find(s => s.role === 'Y') || rest.find(s => s.role === 'G') || rest[0] || null;
      for (const s of rest) send(s, { t: 'host', you: s === r.host, left: true });
    }
    bc(r, { t: 'peers', peers: peers(r) });
    if (!r.socks.size) r.timer = setTimeout(() => rooms.delete(ws.code), 30 * 60 * 1000);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000);

srv.listen(PORT, () => console.log('Kurote running on http://localhost:' + PORT));
