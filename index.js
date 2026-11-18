// Lightning Duels server: pass the charge by touching someone before the storm strikes you.
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

/* ================= tuning ================= */
const MAX_PLAYERS = 8;          // per match (humans + bots)
const QUICK_FILL = 6;           // quick play fills up to this many with bots
const QUICK_WAIT = 8;           // seconds a quick play lobby waits for more people
const PRE_ROUND = 3;            // seconds to spread out before the timer starts
const POST_ROUND = 2.5;         // seconds after a strike
const RESULTS = 7;              // seconds on the results screen
const PASS_RANGE = 1.45;        // how close you have to get to pass the charge
const PASS_CD = 0.35;           // seconds between any two passes
const NO_TAGBACK = 1.0;         // you can't pass straight back to whoever gave it to you
const SPEED = 7, HOLDER_SPEED = 7.8, DASH_SPEED = 21, DASH_TIME = 0.16, DASH_CD = 2.5, RADIUS = 0.45;
const roundTime = (alive) => Math.min(13, 8 + alive * 0.6);   // fewer players left = shorter fuse
const TICK = 0.05;

/* ================= arenas: boxes are [x, z, width, depth, height] ================= */
const MAPS = [
  { id: 'plaza', name: 'Storm Plaza', half: 16, theme: 0, boxes: [
    [0, 0, 4, 4, 0.9], [-8, -8, 1.6, 1.6, 3], [8, -8, 1.6, 1.6, 3], [-8, 8, 1.6, 1.6, 3], [8, 8, 1.6, 1.6, 3],
    [0, -11, 6, 0.8, 1.6], [0, 11, 6, 0.8, 1.6], [-11, 0, 0.8, 6, 1.6], [11, 0, 0.8, 6, 1.6] ] },
  { id: 'rooftop', name: 'Thunder Rooftop', half: 15, theme: 1, boxes: [
    [-5, -5, 3, 3, 1], [5, 5, 3, 3, 1], [5, -5, 2, 2, 3.2], [-5, 5, 2, 2, 3.2],
    [0, 0, 1.2, 7, 2.2], [-11, -9, 3, 1, 1.2], [11, 9, 3, 1, 1.2], [-11, 9, 1, 3, 2.4], [11, -9, 1, 3, 2.4] ] },
  { id: 'yard', name: 'Static Yard', half: 17, theme: 2, boxes: [
    [-6, 0, 1.4, 1.4, 1.1], [6, 0, 1.4, 1.4, 1.1], [0, -6, 1.4, 1.4, 1.1], [0, 6, 1.4, 1.4, 1.1],
    [-12, -12, 3, 3, 2.6], [12, 12, 3, 3, 2.6], [12, -12, 3, 3, 1], [-12, 12, 3, 3, 1],
    [-6, -11, 0.8, 5, 2.2], [6, 11, 0.8, 5, 2.2], [11, -5, 5, 0.8, 2.2], [-11, 5, 5, 0.8, 2.2] ] },
];

/* ================= helpers ================= */
const rooms = new Map(), players = new Map();
let nextId = 1, nextBot = 1000;
const now = () => Date.now() / 1000;
const send = (p, m) => { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); };
const broadcast = (room, m) => { const s = JSON.stringify(m); for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s); };
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null; };
const r2 = (v) => Math.round(v * 100) / 100;
const clean = (s) => String(s || '').replace(/[^\w \-.!?]/g, '').trim().slice(0, 14);
const BOT_NAMES = ['Zap', 'Volt', 'Sparky', 'Bolt', 'Static', 'Ampere', 'Jolt', 'Flicker', 'Thunder', 'Nimbus', 'Surge', 'Gizmo'];
const code5 = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 5; i++) c += a[Math.floor(Math.random() * a.length)]; return rooms.has(c) ? code5() : c; };

// circle-vs-box movement (same rules as the game page, so bots slide around walls the same way)
function blocked(map, x, z, y) {
  if (Math.abs(x) > map.half - RADIUS || Math.abs(z) > map.half - RADIUS) return true;
  for (const [bx, bz, w, d, h] of map.boxes) {
    if (y >= h - 0.05) continue;   // standing on top of it
    const cx = Math.max(bx - w / 2, Math.min(x, bx + w / 2)), cz = Math.max(bz - d / 2, Math.min(z, bz + d / 2));
    if ((x - cx) ** 2 + (z - cz) ** 2 < RADIUS * RADIUS) return true;
  }
  return false;
}
function moveBot(map, b, dx, dz) {
  if (blocked(map, b.x, b.z, 0)) { b.x += dx; b.z += dz; return; }   // somehow inside something: let it walk out
  if (!blocked(map, b.x + dx, b.z, 0)) b.x += dx;
  if (!blocked(map, b.x, b.z + dz, 0)) b.z += dz;
}
function clearSpot(map, a, R) {   // a start spot on the ring, nudged off any pillar or wall
  for (const dr of [0, -1.5, 1.5, -3, 3]) for (const da of [0, .12, -.12, .25, -.25]) {
    const x = Math.cos(a + da) * (R + dr), z = Math.sin(a + da) * (R + dr);
    if (!blocked(map, x, z, 0)) return [x, z];
  }
  return [Math.cos(a) * R * .4, Math.sin(a) * R * .4];
}

/* ================= rooms ================= */
function makeRoom(priv) {
  const room = { code: code5(), priv, players: new Map(), state: 'waiting', hostId: null, botsOn: true, t: 0,
    map: MAPS[Math.floor(Math.random() * MAPS.length)], holder: null, phase: '', timer: 0, round: 0, lastPass: 0, lastFrom: null, order: [], winner: null };
  rooms.set(room.code, room); return room;
}
const humans = (room) => [...room.players.values()].filter(p => !p.bot);
const alive = (room) => [...room.players.values()].filter(p => p.inMatch && !p.out);
function roomInfo(room) {
  return { t: 'room', code: room.code, priv: room.priv, host: room.hostId, state: room.state, t2: Math.ceil(room.t), botsOn: room.botsOn, map: room.map.name,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot, out: !!p.out, inMatch: !!p.inMatch, wins: p.wins || 0 })) };
}
const sendRoom = (room) => broadcast(room, roomInfo(room));
function joinRoom(p, room) {
  leaveRoom(p);
  if (humans(room).length >= MAX_PLAYERS) return send(p, { t: 'err', text: 'That room is full.' });
  room.players.set(p.id, p); p.room = room; p.inMatch = false; p.out = true; p.wins = p.wins || 0;
  if (!room.hostId || !room.players.has(room.hostId) || room.players.get(room.hostId).bot) room.hostId = p.id;
  if (room.state === 'playing') send(p, startMsg(room));   // watch until the next match
  sendRoom(room);
}
function leaveRoom(p) {
  const room = p.room; if (!room) return;
  room.players.delete(p.id); p.room = null;
  if (!humans(room).length) { rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = humans(room)[0].id;
  if (room.state === 'playing' && p.inMatch && !p.out) {
    room.order.push(p.id);
    if (room.holder === p.id) { room.holder = null; endRound(room, null); }
  }
  sendRoom(room);
}
function quickRoom() {
  for (const r of rooms.values()) if (!r.priv && r.state !== 'results' && humans(r).length < MAX_PLAYERS && (r.state === 'waiting' || r.state === 'countdown')) return r;
  for (const r of rooms.values()) if (!r.priv && humans(r).length < MAX_PLAYERS) return r;   // join a match in progress and watch
  return makeRoom(false);
}

/* ================= matches ================= */
function startMatch(room) {
  for (const b of [...room.players.values()].filter(p => p.bot)) room.players.delete(b.id);   // fresh bots each match
  const fill = room.botsOn ? Math.min(MAX_PLAYERS, room.priv ? Math.max(4, humans(room).length) : QUICK_FILL) : 0;
  const used = new Set();
  while (room.players.size < fill) {
    let n; do n = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; while (used.has(n) && used.size < BOT_NAMES.length); used.add(n);
    const b = { id: nextBot++, name: n, color: Math.floor(Math.random() * 8), bot: true, wins: 0, dashCD: Math.random() * 2, side: Math.random() < .5 ? 1 : -1, think: 0, dirX: 0, dirZ: 0, skill: 0.85 + Math.random() * 0.12 };
    room.players.set(b.id, b);
  }
  if (room.players.size < 2) { room.state = 'waiting'; sendRoom(room); return; }
  room.map = MAPS[Math.floor(Math.random() * MAPS.length)];
  room.state = 'playing'; room.round = 0; room.order = []; room.winner = null;
  const list = [...room.players.values()], R = room.map.half * 0.62;
  list.forEach((p, i) => {   // spread everyone out around a circle
    const a = i / list.length * Math.PI * 2, [x, z] = clearSpot(room.map, a, R);
    p.x = x; p.z = z; p.y = 0; p.yaw = Math.atan2(-p.x, -p.z); p.inMatch = true; p.out = false; p.dash = 0; p.moving = false;
  });
  sendRoom(room); broadcast(room, startMsg(room));
  startRound(room);
}
function startMsg(room) {
  return { t: 'start', map: { id: room.map.id, name: room.map.name, half: room.map.half, theme: room.map.theme, boxes: room.map.boxes },
    players: [...room.players.values()].filter(p => p.inMatch).map(p => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot })),
    holder: room.holder, phase: room.phase, tl: r2(Math.max(0, room.timer)),
    spawns: Object.fromEntries([...room.players.values()].filter(p => p.inMatch).map(p => [p.id, [r2(p.x), r2(p.z)]])) };
}
function startRound(room) {
  const left = alive(room);
  if (left.length <= 1) return endMatch(room);
  room.round++; room.phase = 'pre'; room.timer = PRE_ROUND;
  room.holder = left[Math.floor(Math.random() * left.length)].id; room.lastFrom = null; room.lastPass = now();
  room.fuse = roundTime(left.length);
  broadcast(room, { t: 'round', n: room.round, holder: room.holder, fuse: room.fuse, pre: PRE_ROUND, alive: left.length });
}
function endRound(room, struckId) {
  room.phase = 'post'; room.timer = POST_ROUND;
  if (struckId != null) {
    const p = room.players.get(struckId);
    if (p) { p.out = true; room.order.push(p.id); broadcast(room, { t: 'strike', id: p.id, x: r2(p.x), z: r2(p.z), name: p.name }); }
  }
  room.holder = null; sendRoom(room);
}
function endMatch(room) {
  const left = alive(room), win = left[0] || null;
  room.state = 'results'; room.t = RESULTS; room.phase = ''; room.holder = null;
  if (win) { win.wins = (win.wins || 0) + 1; room.winner = win.id; }
  const places = [...(win ? [win.id] : []), ...room.order.slice().reverse()].map(id => room.players.get(id)).filter(Boolean);
  broadcast(room, { t: 'end', winner: win ? { id: win.id, name: win.name, color: win.color, bot: !!win.bot } : null,
    places: places.map(p => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot })) });
  sendRoom(room);
}

/* ================= bots ================= */
function botThink(room, b, dt) {
  const map = room.map, me = room.holder === b.id;
  b.dashCD -= dt; if (b.dash > 0) b.dash -= dt;
  b.think -= dt;
  if (b.think <= 0) {
    b.think = 0.12 + Math.random() * 0.12;   // bots react a little slower than people
    const others = alive(room).filter(o => o !== b);
    let tx = 0, tz = 0, want = 0;
    if (me) {   // chase the closest player you're allowed to tag
      let best = null, bd = 1e9;
      for (const o of others) { if (o.id === room.lastFrom && now() - room.lastPass < NO_TAGBACK) continue; const d = Math.hypot(o.x - b.x, o.z - b.z); if (d < bd) { bd = d; best = o; } }
      if (best) { tx = best.x - b.x; tz = best.z - b.z; want = 1; if (bd < 4 && b.dashCD <= 0 && room.phase === 'live' && Math.random() < .55) { b.dash = DASH_TIME; b.dashCD = DASH_CD + Math.random(); } }
    } else {
      const h = room.holder != null ? room.players.get(room.holder) : null;
      const d = h ? Math.hypot(h.x - b.x, h.z - b.z) : 99;
      if (h && d < 13) {   // run away, juke sideways when it's close
        const ax = (b.x - h.x) / (d || 1), az = (b.z - h.z) / (d || 1);
        const side = d < 4 ? 0.9 : 0.35;
        tx = ax - az * side * b.side; tz = az + ax * side * b.side; want = 1;
        if (Math.random() < .03) b.side *= -1;
        if (d < 2.6 && b.dashCD <= 0 && Math.random() < .5) { b.dash = DASH_TIME; b.dashCD = DASH_CD + Math.random(); }
      } else {   // drift around, keep away from crowds
        if (!b.wx || Math.random() < .02) { b.wx = (Math.random() * 2 - 1) * map.half * .7; b.wz = (Math.random() * 2 - 1) * map.half * .7; }
        tx = b.wx - b.x; tz = b.wz - b.z; want = Math.hypot(tx, tz) > 1 ? .5 : 0;
      }
      const edge = map.half - 3;   // stay off the walls so they don't get cornered
      if (b.x > edge) tx -= (b.x - edge); if (b.x < -edge) tx -= (b.x + edge);
      if (b.z > edge) tz -= (b.z - edge); if (b.z < -edge) tz -= (b.z + edge);
    }
    const l = Math.hypot(tx, tz) || 1; b.dirX = tx / l; b.dirZ = tz / l; b.want = want;
  }
  if (!b.want && !(b.dash > 0)) { b.moving = false; return; }
  const sp = (b.dash > 0 ? DASH_SPEED : (me ? HOLDER_SPEED : SPEED) * (b.want || 1)) * b.skill * dt;
  let dx = b.dirX, dz = b.dirZ;
  if (blocked(map, b.x + dx * sp * 2, b.z + dz * sp * 2, 0)) {   // something in the way: try turning
    for (const a of [0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
      const c = Math.cos(a), s = Math.sin(a), nx = dx * c - dz * s, nz = dx * s + dz * c;
      if (!blocked(map, b.x + nx * sp * 2, b.z + nz * sp * 2, 0)) { dx = nx; dz = nz; break; }
    }
  }
  const ox = b.x, oz = b.z; moveBot(map, b, dx * sp, dz * sp);
  b.moving = Math.hypot(b.x - ox, b.z - oz) > 0.001;
  if (b.moving) b.yaw = Math.atan2(b.x - ox, b.z - oz);
}

/* ================= the game loop ================= */
function tickRoom(room, dt) {
  if (room.state === 'waiting' && !room.priv && humans(room).length) { room.state = 'countdown'; room.t = QUICK_WAIT; sendRoom(room); }
  if (room.state === 'countdown') { const before = Math.ceil(room.t); room.t -= dt; if (Math.ceil(room.t) !== before) sendRoom(room); if (room.t <= 0) startMatch(room); return; }
  if (room.state === 'results') { room.t -= dt; if (room.t <= 0) { for (const p of room.players.values()) { p.inMatch = false; p.out = true; } for (const b of [...room.players.values()].filter(p => p.bot)) room.players.delete(b.id); room.state = room.priv ? 'waiting' : 'countdown'; room.t = QUICK_WAIT; sendRoom(room); } return; }
  if (room.state !== 'playing') return;
  for (const p of room.players.values()) if (p.bot && p.inMatch && !p.out) botThink(room, p, dt);
  room.timer -= dt;
  if (room.phase === 'pre' && room.timer <= 0) { room.phase = 'live'; room.timer = room.fuse; broadcast(room, { t: 'live', fuse: room.fuse }); }
  else if (room.phase === 'live') {
    const h = room.players.get(room.holder);
    if (!h || h.out) { endRound(room, null); }
    else if (room.timer <= 0) endRound(room, h.id);   // ⚡ the storm strikes whoever is holding the charge
    else if (now() - room.lastPass > PASS_CD) {
      let best = null, bd = PASS_RANGE;
      for (const o of alive(room)) {
        if (o === h || (o.id === room.lastFrom && now() - room.lastPass < NO_TAGBACK)) continue;
        const d = Math.hypot(o.x - h.x, o.z - h.z);
        if (d < bd && Math.abs((o.y || 0) - (h.y || 0)) < 1.6) { bd = d; best = o; }
      }
      if (best) { room.lastFrom = h.id; room.holder = best.id; room.lastPass = now(); broadcast(room, { t: 'pass', from: h.id, to: best.id }); }
    }
  } else if (room.phase === 'post' && room.timer <= 0) startRound(room);
  if (room.state !== 'playing') return;
  broadcast(room, { t: 'st', h: room.holder, ph: room.phase, tl: r2(Math.max(0, room.timer)),
    p: alive(room).map(p => [p.id, r2(p.x), r2(p.y || 0), r2(p.z), r2(p.yaw || 0), (p.dash > 0 ? 1 : 0) | (p.moving ? 2 : 0)]) });
}
setInterval(() => { for (const room of [...rooms.values()]) tickRoom(room, TICK); }, TICK * 1000);
setInterval(() => { const msg = JSON.stringify({ t: 'online', n: players.size }); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(msg); }, 5000);

/* ================= connections ================= */
wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, name: 'Player', color: 0, room: null, x: 0, y: 0, z: 0, yaw: 0, wins: 0 };
  players.set(p.id, p);
  send(p, { t: 'welcome', id: p.id, online: players.size });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = p.room;
    switch (m.t) {
      case 'hello': p.name = clean(m.name) || 'Player'; p.color = Math.max(0, Math.min(7, m.color | 0)); if (room) sendRoom(room); break;
      case 'quick': joinRoom(p, quickRoom()); break;
      case 'create': { const r = makeRoom(true); joinRoom(p, r); break; }
      case 'join': { const r = rooms.get(String(m.code || '').toUpperCase().trim()); if (!r) return send(p, { t: 'err', text: 'No room with that code.' }); joinRoom(p, r); break; }
      case 'leave': leaveRoom(p); send(p, { t: 'left' }); break;
      case 'start': if (room && room.priv && room.hostId === p.id && room.state === 'waiting') startMatch(room); break;
      case 'bots': if (room && room.priv && room.hostId === p.id) { room.botsOn = !!m.on; sendRoom(room); } break;
      case 's': {   // your position (the server decides tags from these)
        if (!room || room.state !== 'playing' || !p.inMatch || p.out) return;
        const H = room.map.half, x = num(m.x, -H, H), y = num(m.y, 0, 8), z = num(m.z, -H, H);
        if (x === null || y === null || z === null) return;
        p.x = x; p.y = y; p.z = z; p.yaw = num(m.yaw, -10, 10) || 0; p.dash = m.d ? DASH_TIME : 0; p.moving = !!m.m; break;
      }
    }
  });
  ws.on('close', () => { leaveRoom(p); players.delete(p.id); });
});

server.listen(PORT, () => console.log('Lightning Duels running on port ' + PORT));
