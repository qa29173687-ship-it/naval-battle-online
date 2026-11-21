// 海戰棋 連線對戰伺服器：靜態檔 + WebSocket，船的位置只存在伺服器
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room } = require('./game');

const PORT = process.env.PORT || 8080;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

const rooms = new Map();
const socks = new Map(); // playerId -> ws
const genCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s; do { s = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(s)); return s; };
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function broadcast(room) {
  for (const p of room.players) if (p.connected) send(socks.get(p.id), { t: 'state', s: room.viewFor(p.id) });
}

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const id = crypto.randomUUID();
  let room = null;
  socks.set(id, ws);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  send(ws, { t: 'hello', id });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      switch (m.t) {
        case 'create': {
          if (room) throw new Error('已在房間中');
          const code = genCode();
          room = new Room(code, broadcast);
          rooms.set(code, room);
          room.addPlayer(id, m.name);
          break;
        }
        case 'join': {
          if (room) throw new Error('已在房間中');
          const r = rooms.get(String(m.code || '').toUpperCase().trim());
          if (!r) throw new Error('找不到這個房號');
          r.addPlayer(id, m.name);
          room = r;
          break;
        }
        case 'start': room && room.start(id); break;
        case 'place': room && room.place(id, m.ships); break;
        case 'shoot': room && room.shoot(id, m.targetId, m.r, m.c); break;
        case 'rematch': room && room.rematch(); break;
        case 'leave': leave(); send(ws, { t: 'left' }); break;
        case 'ping': send(ws, { t: 'pong' }); break;
      }
    } catch (e) { send(ws, { t: 'error', msg: e.message }); }
  });
  function leave() {
    if (!room) return;
    const r = room; room = null;
    r.disconnect(id);
    if (r.isEmpty()) { r.destroy(); rooms.delete(r.code); }
  }
  ws.on('close', () => { leave(); socks.delete(id); });
});
// 心跳：偵測斷線
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 10000);

server.listen(PORT, () => console.log('海戰棋 server on :' + PORT));
