// Kurote server: serves index.html and relays game state between the two players of a room.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const page = () => fs.readFileSync(path.join(__dirname, 'index.html'));
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page());
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
  Array.isArray(st.B) && st.B.length === 25 && st.B.every(v => v === null || v === 'Y' || v === 'G') &&
  Array.isArray(st.X) && st.X.length === 25 && st.R && st.C && (st.turn === 'Y' || st.turn === 'G');

wss.on('connection', ws => {
  ws.alive = true; ws.room = null; ws.role = null;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !ws.room) {
      if (typeof m.code !== 'string' || !/^[a-z0-9]{3,12}$/.test(m.code)) return send(ws, { t: 'err', msg: 'Bad room code' });
      const r = getRoom(m.code);
      clearTimeout(r.timer);
      const taken = [...r.socks].map(s => s.role);
      ws.role = ['Y', 'G'].find(x => !taken.includes(x)) || 'S';
      ws.room = r; ws.code = m.code; r.socks.add(ws);
      send(ws, { t: 'hello', role: ws.role, state: r.state, peers: peers(r) });
      bc(r, { t: 'peers', peers: peers(r) }, ws);
    } else if (m.t === 'state' && ws.room && ws.role !== 'S') {
      const r = ws.room, st = m.state;
      const ok = okState(st) && (!r.state || (st.seq > r.state.seq && (m.reset === true && ws.role === 'Y')));
      if (ok) { r.state = st; bc(r, { t: 'state', state: st }, ws); }
      else if (r.state) send(ws, { t: 'state', state: r.state, force: true });
    }
  });
  ws.on('close', () => {
    const r = ws.room; if (!r) return;
    r.socks.delete(ws);
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
