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
let db = { secret: crypto.randomBytes(32).toString('hex'), users: {}, avg: {} };
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('[accounts] cannot create ' + DATA_DIR + ': ' + e.message); }
if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); console.log('[accounts] loaded ' + Object.keys(db.users).length + ' account(s) from ' + DB_FILE); }
  catch (e) {
    // never start empty and overwrite a file we merely failed to read: keep a copy and stop
    const bad = DB_FILE + '.unreadable-' + Date.now();
    try { fs.copyFileSync(DB_FILE, bad); } catch {}
    console.error('[accounts] ' + DB_FILE + ' could not be read (' + e.message + '). A copy was kept at ' + bad + '. Fix or restore it, then start again.');
    process.exit(1);
  }
} else console.log('[accounts] no accounts file at ' + DB_FILE + ' yet, starting fresh. If you expected accounts here, the disk was reset or DATA_DIR points somewhere else.');
// Elo moved from a 1000 start to a 100 start: convert ratings saved on the old scale once
if (db.eloVer !== 2) {
  for (const u of Object.values(db.users)) for (const e of Object.values(u.elo || {})) { e.r = Math.max(0, Math.round(e.r / 10)); e.peak = Math.max(e.r, Math.round((e.peak || e.r * 10) / 10)); }
  db.eloVer = 2;
}
let saveT = null;
const saveDb = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => {
      if (err) return console.error('[accounts] save failed: ' + err.message);
      // keep the previous version as users.json.bak, then swap the new one in
      fs.copyFile(DB_FILE, DB_FILE + '.bak', () => fs.rename(tmp, DB_FILE, e => { if (e) console.error('[accounts] save failed: ' + e.message); }));
    });
  }, 300);
};
saveDb(); // makes sure the signing secret survives a restart
const GAMES = ['kij', 'elder', 'cotw'];
const TOKEN_MS = 30 * 24 * 3600 * 1000;
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => e ? no(e) : ok(k)));
const sign = t => crypto.createHmac('sha256', db.secret).update(t).digest('base64url');
const mkToken = name => { const t = name + '.' + (Date.now() + TOKEN_MS); return t + '.' + sign(t); };
const nameFromToken = tok => {
  const parts = String(tok || '').split('.'); if (parts.length !== 3) return null;
  const t = parts[0] + '.' + parts[1], a = Buffer.from(sign(t)), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || Number(parts[1]) < Date.now()) return null;
  return db.users[parts[0]] ? parts[0] : null;
};
const userFrom = req => {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  const n = nameFromToken(m[1]); return n ? db.users[n] : null;
};
const emptyStats = () => Object.fromEntries(GAMES.map(g => [g, { w: 0, l: 0, d: 0, streak: 0, best: 0 }]));
const ensure = u => {
  u.stats = u.stats || {}; u.elo = u.elo || {};
  for (const g of GAMES) {
    u.stats[g] = u.stats[g] || { w: 0, l: 0, d: 0, streak: 0, best: 0 };
    u.elo[g] = u.elo[g] || { r: BASE, n: 0, peak: BASE };
  }
  return u;
};
const pub = u => { ensure(u); return { name: u.display, settings: u.settings || {}, stats: u.stats, elo: u.elo }; };

// ---------------------------------------------------------------------------
// Elo, one rating per game (start 100).
//  - K shrinks as you play (16 for the first 10 games, then 12, then 8).
//  - The result is scaled by match length: moves played / the running average length of finished
//    online games of that game, so a short game moves you little and a long one moves you a lot.
//  - Bots have fixed ratings. Beating the hard bot pays a lot, but a real match against a strong
//    player can pay more: real matches allow a bigger length bonus (x2.5) than bots (x1.5).
//  - Online matches are decided by the server from the relayed game state; both players need accounts.
// ---------------------------------------------------------------------------
const BASE = 100; // everyone starts at 100 in every game
const BOT_R = { easy: 70, normal: 110, hard: 150 };
const AVG0 = { kij: 36, elder: 30, cotw: 40 };
const kFor = n => n < 10 ? 16 : n < 30 ? 12 : 8;
const expect = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 40)); // the classic Elo curve, scaled to a 100 start
const avgLen = g => (db.avg && db.avg[g]) || AVG0[g];
const lenMult = (g, moves, cap) => Math.min(cap, Math.max(0.2, moves / avgLen(g)));
function rate(u, g, oppR, score, mult) {
  const e = u.elo[g], d = Math.round(kFor(e.n) * mult * (score - expect(e.r, oppR)));
  e.r = Math.max(0, e.r + d); e.n++; e.peak = Math.max(e.peak, e.r);
  return d;
}
function tally(u, g, result) {
  const st = u.stats[g];
  if (result === 'win') { st.w++; st.streak++; st.best = Math.max(st.best, st.streak); } else if (result === 'loss') { st.l++; st.streak = 0; } else st.d++;
}
const pairSeen = new Map(); // "a|b|game" -> [count, windowStart]: repeated matches between the same two accounts pay less
const pairMult = (a, b, g) => {
  const key = [a, b].sort().join('|') + '|' + g, now = Date.now(), t = pairSeen.get(key);
  if (!t || now - t[1] > 3600000) { pairSeen.set(key, [1, now]); return 1; }
  return 1 / (1 + t[0]++);
};
setInterval(() => { const now = Date.now(); for (const [k, v] of pairSeen) if (now - v[1] > 3600000) pairSeen.delete(k); }, 600000);
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
        ensure(u);
        const g = b.game, r = b.result, lv = b.level, moves = Math.min(500, Math.max(0, Math.floor(Number(b.moves) || 0)));
        if (!GAMES.includes(g) || !['win', 'loss', 'draw'].includes(r) || !BOT_R[lv]) return json(res, 400, { err: 'Bad result.' });
        const now = Date.now(); if (now - (lastRes.get(key) || 0) < 15000) return json(res, 429, { err: 'Too fast.' });
        lastRes.set(key, now);
        const mult = lenMult(g, moves, 1.5), delta = rate(u, g, BOT_R[lv], r === 'win' ? 1 : r === 'loss' ? 0 : 0.5, mult);
        tally(u, g, r); saveDb();
        return json(res, 200, { stats: u.stats, elo: u.elo, game: g, result: r, delta, rating: u.elo[g].r, opp: { name: lv + ' bot', rating: BOT_R[lv] }, mult: +mult.toFixed(2) });
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
  const o = { Y: false, G: false, S: 0, names: {}, elo: {}, ranked: false };
  for (const s of r.socks) {
    if (s.role === 'S') { o.S++; continue; }
    o[s.role] = true;
    const u = s.user && db.users[s.user];
    if (u) { ensure(u); o.names[s.role] = u.display; if (u.elo[r.game]) o.elo[s.role] = u.elo[r.game].r; }
  }
  o.ranked = !!(o.names.Y && o.names.G && o.names.Y !== o.names.G);
  return o;
};
function finishGame(r, st) {
  const g = r.game; if (!GAMES.includes(g)) return;
  const sy = [...r.socks].find(s => s.role === 'Y' && s.user), sg = [...r.socks].find(s => s.role === 'G' && s.user);
  if (!sy || !sg || sy.user === sg.user) return; // unranked: a guest is playing, or one person in both seats
  const uy = db.users[sy.user], ug = db.users[sg.user]; if (!uy || !ug) return;
  ensure(uy); ensure(ug);
  let w = null;
  if (g === 'kij') { const n = p => st.B.filter(v => v === p).length; w = n('Y') <= 2 ? 'G' : n('G') <= 2 ? 'Y' : null; }
  else if (st.win === 'Y' || st.win === 'G') w = st.win;
  const moves = r.startSeq == null ? avgLen(g) : Math.max(0, (st.seq | 0) - r.startSeq), mult = lenMult(g, moves, 2.5) * pairMult(sy.user, sg.user, g);
  const ry = uy.elo[g].r, rg = ug.elo[g].r, score = w === 'Y' ? 1 : w === 'G' ? 0 : 0.5;
  const dy = rate(uy, g, rg, score, mult), dg = rate(ug, g, ry, 1 - score, mult);
  tally(uy, g, w === 'Y' ? 'win' : w === 'G' ? 'loss' : 'draw'); tally(ug, g, w === 'G' ? 'win' : w === 'Y' ? 'loss' : 'draw');
  db.avg = db.avg || {}; db.avg[g] = Math.round((0.9 * avgLen(g) + 0.1 * Math.max(8, moves)) * 10) / 10;
  saveDb();
  const out = (sock, u, d, res, oppU, oppR) => send(sock, { t: 'elo', game: g, result: res, delta: d, rating: u.elo[g].r, opp: { name: oppU.display, rating: oppR }, mult: +mult.toFixed(2), stats: u.stats, elo: u.elo });
  out(sy, uy, dy, w === 'Y' ? 'win' : w === 'G' ? 'loss' : 'draw', ug, rg);
  out(sg, ug, dg, w === 'G' ? 'win' : w === 'Y' ? 'loss' : 'draw', uy, ry);
  bc(r, { t: 'peers', peers: peers(r) });
}
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
      ws.room = r; ws.code = m.code; ws.user = nameFromToken(m.token); r.socks.add(ws);
      if (!r.host || !r.socks.has(r.host)) r.host = ws; // first one in (or the first back into an empty room) hosts
      send(ws, { t: 'hello', role: ws.role, state: r.state, peers: peers(r), game: r.game, host: r.host === ws });
      bc(r, { t: 'peers', peers: peers(r) }, ws);
    } else if (m.t === 'state' && ws.room && ws.role !== 'S') {
      const r = ws.room, st = m.state;
      const ok = okState(st) && ((st.game || 'kij') === r.game) && (!r.state || (st.seq > r.state.seq && (m.reset === true || ws.role === r.state.turn)));
      if (ok) { const was = r.state; if (!was || m.reset === true) r.startSeq = st.seq; r.state = st; bc(r, { t: 'state', state: st }, ws); if (st.over && !(was && was.over)) finishGame(r, st); }
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
