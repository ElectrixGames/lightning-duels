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
const ROUNDS_TO_WIN = 3;        // 1v1, 2v2 and 3v3 are first to 3 rounds
const BOT_WAIT = 10;            // seconds before bots join a duel queue
const MAP_IDS = ['plaza', 'rooftop', 'yard'];
const TICK = 0.05;

/* ================= arenas: boxes are [x, z, width, depth, height] ================= */
// heights step up by 0.8 so you can climb them with jumps (a jump reaches about 1.7). The 3.2 vents can't be climbed.
const symm = (list) => list.flatMap(([x, z, w, d, h]) => (x || z) ? [[x, z, w, d, h], [-x, -z, w, d, h]] : [[x, z, w, d, h]]);   // point-symmetric, so both sides are fair
const MAPS = [
  { id: 'plaza', name: 'Storm Plaza', half: 16, theme: 0, boxes: [
    [0, 0, 7, 7, 0.8], [0, 0, 4.4, 4.4, 1.6], [0, 0, 2, 2, 2.4],   // the ziggurat in the middle
    ...symm([[11, 11, 2.6, 2.6, 2.4], [8.4, 11, 2.2, 2.2, 1.6], [6.2, 11, 2.2, 2.2, 0.8],   // corner towers with steps
      [-11, 11, 2.6, 2.6, 2.4], [-11, 8.4, 2.2, 2.2, 1.6], [-11, 6.2, 2.2, 2.2, 0.8],
      [0, 12.8, 2, 2, 1.2], [12.8, 0, 2, 2, 1.2], [0, 8, 4, 0.8, 1], [8, 0, 0.8, 4, 1]]) ] },
  { id: 'rooftop', name: 'Thunder Rooftop', half: 15, theme: 1, boxes: [
    [0, 0, 3, 3, 0.8], [0, 0, 1.4, 1.4, 1.6],
    ...symm([[-7, -6, 6, 5, 1.6], [-7, -2.9, 2.4, 1.2, 0.8], [-8.6, -7.2, 1.6, 1.6, 2.4],   // raised decks with stairs and a crate on top
      [6, -7, 1.4, 1.4, 3.2], [-12.5, 3, 1.4, 6, 1.2], [-3, 8, 1.4, 1.4, 1.2], [-10, -11.5, 1.6, 1.6, 0.8], [-11.6, -11.5, 1.6, 1.6, 1.6]]) ] },
  { id: 'yard', name: 'Static Yard', half: 17, theme: 2, boxes: [
    [0, 0, 1.6, 1.6, 1.6], [0, 2, 1.6, 1.6, 0.8], [0, -2, 1.6, 1.6, 0.8],
    ...symm([[-6, -9, 8, 2.4, 2.4], [-11, -9, 1.6, 1.6, 1.6], [-12.6, -9, 1.6, 1.6, 0.8],   // a container with crate stairs
      [9, -9, 1.6, 1.6, 0.8], [10.6, -9, 1.6, 1.6, 1.6], [10.6, -10.6, 1.6, 1.6, 2.4],   // crate pyramids
      [-12, 4, 0.8, 5, 2.2], [6, -2.5, 1.4, 1.4, 1.2], [-4.5, 5, 1.4, 1.4, 1.2]]) ] },
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
function groundAt(map, x, z, y) {   // the highest box top under you (same rule as the game page)
  let g = 0;
  for (const [bx, bz, w, d, h] of map.boxes) {
    if (h > g && y >= h - 0.35) {
      const cx = Math.max(bx - w / 2, Math.min(x, bx + w / 2)), cz = Math.max(bz - d / 2, Math.min(z, bz + d / 2));
      if ((x - cx) ** 2 + (z - cz) ** 2 < (RADIUS * .7) ** 2) g = h;
    }
  }
  return g;
}
const GRAV = 26, JUMP = 9.5;
function moveBot(map, b, dx, dz) {
  const y = b.y || 0;
  if (blocked(map, b.x, b.z, y)) { b.x += dx; b.z += dz; return; }   // somehow inside something: let it walk out
  if (!blocked(map, b.x + dx, b.z, y)) b.x += dx;
  if (!blocked(map, b.x, b.z + dz, y)) b.z += dz;
}
function botPhysics(map, b, dt) {   // gravity, landing on boxes
  b.vy = (b.vy || 0) - GRAV * dt; b.y = (b.y || 0) + b.vy * dt;
  const g = groundAt(map, b.x, b.z, b.y);
  if (b.y <= g) { b.y = g; b.vy = 0; b.ground = true; } else b.ground = b.y - g < .02;
}
const botJump = (b) => { if (b.ground) { b.vy = JUMP; b.ground = false; } };
function clearSpot(map, a, R) {   // a start spot on the ring, nudged off any pillar or wall
  for (const dr of [0, -1.5, 1.5, -3, 3]) for (const da of [0, .12, -.12, .25, -.25]) {
    const x = Math.cos(a + da) * (R + dr), z = Math.sin(a + da) * (R + dr);
    if (!blocked(map, x, z, 0)) return [x, z];
  }
  return [Math.cos(a) * R * .4, Math.sin(a) * R * .4];
}

/* ================= rooms ================= */
function makeRoom(priv) {
  const room = { code: code5(), priv, players: new Map(), state: 'waiting', hostId: null, botsOn: true, t: 0, duel: 0, mapPref: 'random', score: [0, 0], next: '',
    map: MAPS[Math.floor(Math.random() * MAPS.length)], holder: null, phase: '', timer: 0, round: 0, lastPass: 0, lastFrom: null, order: [], winner: null };
  rooms.set(room.code, room); return room;
}
const humans = (room) => [...room.players.values()].filter(p => !p.bot);
const alive = (room) => [...room.players.values()].filter(p => p.inMatch && !p.out);
function roomInfo(room) {
  return { t: 'room', code: room.code, priv: room.priv, duel: room.duel, host: room.hostId, state: room.state, t2: Math.ceil(room.t), botsOn: room.botsOn, map: room.map.name, mapPref: room.mapPref,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot, out: !!p.out, inMatch: !!p.inMatch, wins: p.wins || 0, team: p.team })) };
}
const sendRoom = (room) => broadcast(room, roomInfo(room));
function joinRoom(p, room) {
  if (room.duel) return send(p, { t: 'err', text: "That's a duel. Use the duel pads instead." });
  dqRemove(p); leaveRoom(p); p.hub = null; p.team = undefined;
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
    else if (room.duel && room.phase !== 'post') checkWipe(room);
  }
  sendRoom(room);
}
function quickRoom() {
  for (const r of rooms.values()) if (!r.priv && !r.duel && r.state !== 'results' && humans(r).length < MAX_PLAYERS && (r.state === 'waiting' || r.state === 'countdown')) return r;
  for (const r of rooms.values()) if (!r.priv && !r.duel && humans(r).length < MAX_PLAYERS) return r;   // join a match in progress and watch
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
  room.map = pickMap(room.priv ? [room.mapPref] : humans(room).map(h => h.mapPref));
  beginMatch(room);
}
function pickMap(prefs) {   // a random map from what the players picked ("random" picks count for nothing)
  const real = prefs.filter(m => MAP_IDS.includes(m));
  const id = real.length ? real[Math.floor(Math.random() * real.length)] : MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)];
  return MAPS.find(m => m.id === id);
}
function placeAll(room) {
  const list = [...room.players.values()].filter(p => p.inMatch), H = room.map.half;
  if (room.duel) {   // teams start on opposite sides
    for (const t of [0, 1]) {
      const mine = list.filter(p => p.team === t);
      mine.forEach((p, i) => {
        let x = (i - (mine.length - 1) / 2) * 3, z = (t === 0 ? 1 : -1) * H * .68;
        for (let k = 0; k < 12 && blocked(room.map, x, z, 0); k++) { z -= Math.sign(z) * .8; if (k > 5) x += 1; }
        p.x = x; p.z = z; p.y = 0; p.yaw = t === 0 ? Math.PI : 0;
      });
    }
  } else {
    const R = H * 0.62;
    list.forEach((p, i) => { const [x, z] = clearSpot(room.map, i / list.length * Math.PI * 2, R); p.x = x; p.z = z; p.y = 0; p.yaw = Math.atan2(-x, -z); });   // spread around a circle
  }
  for (const p of list) { p.out = false; p.dash = 0; p.moving = false; p.vy = 0; p.ground = true; }
}
function beginMatch(room) {
  room.state = 'playing'; room.round = 0; room.order = []; room.winner = null; room.score = [0, 0]; room.next = '';
  for (const p of room.players.values()) p.inMatch = true;
  placeAll(room);
  sendRoom(room); broadcast(room, startMsg(room));
  startRound(room);
}
function startMsg(room) {
  return { t: 'start', map: { id: room.map.id, name: room.map.name, half: room.map.half, theme: room.map.theme, boxes: room.map.boxes },
    players: [...room.players.values()].filter(p => p.inMatch).map(p => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot, team: p.team })),
    duel: room.duel, score: room.score, toWin: ROUNDS_TO_WIN,
    holder: room.holder, phase: room.phase, tl: r2(Math.max(0, room.timer)),
    spawns: Object.fromEntries([...room.players.values()].filter(p => p.inMatch).map(p => [p.id, [r2(p.x), r2(p.z)]])) };
}
const teamAlive = (room, t) => alive(room).filter(p => p.team === t).length;
function checkWipe(room) {   // duels: a team with nobody left loses the round
  if (!room.duel) return false;
  const a = teamAlive(room, 0), b = teamAlive(room, 1);
  if (a && b) return false;
  const win = a ? 0 : b ? 1 : -1;
  if (win >= 0) room.score[win]++;
  const teamsLeft = [0, 1].filter(t => [...room.players.values()].some(p => p.inMatch && p.team === t));
  room.next = room.score.some(s => s >= ROUNDS_TO_WIN) || teamsLeft.length < 2 ? 'end' : 'reset';
  broadcast(room, { t: 'tround', win, score: room.score, toWin: ROUNDS_TO_WIN });
  room.phase = 'post'; room.timer = POST_ROUND + .5; room.holder = null;
  return true;
}
function startRound(room) {
  const left = alive(room);
  if (room.duel ? (!teamAlive(room, 0) || !teamAlive(room, 1)) : left.length <= 1) return endMatch(room);
  room.round++; room.phase = 'pre'; room.timer = room.duel ? 2 : PRE_ROUND;   // duels move faster
  room.holder = left[Math.floor(Math.random() * left.length)].id; room.lastFrom = null; room.lastPass = now();
  room.fuse = room.duel ? Math.min(10, 6 + left.length * 0.5) : roundTime(left.length);
  broadcast(room, { t: 'round', n: room.round, holder: room.holder, fuse: room.fuse, pre: room.timer, alive: left.length });
}
function endRound(room, struckId) {
  room.phase = 'post'; room.timer = room.duel ? 2 : POST_ROUND;
  if (struckId != null) {
    const p = room.players.get(struckId);
    if (p) { p.out = true; room.order.push(p.id); room.strikeSeq = (room.strikeSeq || 0) + 1; room.sx = r2(p.x); room.sz = r2(p.z); broadcast(room, { t: 'strike', id: p.id, x: r2(p.x), z: r2(p.z), name: p.name }); }
  }
  room.holder = null; checkWipe(room); sendRoom(room);
}
function endMatch(room) {
  room.state = 'results'; room.t = RESULTS; room.phase = ''; room.holder = null;
  if (room.duel) {
    const s = room.score, inM = [...room.players.values()].filter(p => p.inMatch);
    let winTeam = s[0] === s[1] ? -1 : s[0] > s[1] ? 0 : 1;
    const teamsLeft = [0, 1].filter(t => inM.some(p => p.team === t));
    if (teamsLeft.length === 1) winTeam = teamsLeft[0];   // the other team left
    for (const p of inM) if (p.team === winTeam) p.wins = (p.wins || 0) + 1;
    if (winTeam >= 0) recordMatch(room, p => p.team === winTeam);
    broadcast(room, { t: 'end', duel: room.duel, winTeam, score: s, players: inM.map(p => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot, team: p.team })) });
    sendRoom(room); return;
  }
  const left = alive(room), win = left[0] || null;
  if (win) { win.wins = (win.wins || 0) + 1; room.winner = win.id; }
  if (win) recordMatch(room, p => p === win);
  const places = [...(win ? [win.id] : []), ...room.order.slice().reverse()].map(id => room.players.get(id)).filter(Boolean);
  broadcast(room, { t: 'end', winner: win ? { id: win.id, name: win.name, color: win.color, bot: !!win.bot } : null,
    places: places.map(p => ({ id: p.id, name: p.name, color: p.color, bot: !!p.bot })) });
  sendRoom(room);
}
/* ================= stats and the leaderboard (saved in MongoDB when MONGODB_URI is set) ================= */
const STATS = new Map();   // uid -> { uid, name, wins, losses, streak, bestStreak, matches }
let statsDB = null;
async function initDB() {
  if (!process.env.MONGODB_URI) { console.log('No MONGODB_URI: the leaderboard is kept in memory (it resets when the server restarts)'); return; }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI); await client.connect();
    statsDB = client.db('lightningduels').collection('players');
    await statsDB.createIndex({ uid: 1 }, { unique: true });
    for (const d of await statsDB.find({}).toArray()) STATS.set(d.uid, { uid: d.uid, name: d.name || 'Player', wins: d.wins || 0, losses: d.losses || 0, streak: d.streak || 0, bestStreak: d.bestStreak || 0, matches: d.matches || 0 });
    console.log('Connected to MongoDB: leaderboard is saved (' + STATS.size + ' players)'); broadcastLB();
  } catch (e) { console.error('MongoDB connection failed:', e.message); statsDB = null; }
}
function record(p, won) {
  if (!p.uid || p.bot) return;
  const s = STATS.get(p.uid) || { uid: p.uid, name: p.name, wins: 0, losses: 0, streak: 0, bestStreak: 0, matches: 0 };
  s.name = p.name; s.matches++;
  if (won) { s.wins++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak); } else { s.losses++; s.streak = 0; }
  STATS.set(p.uid, s);
  if (statsDB) statsDB.updateOne({ uid: s.uid }, { $set: s }, { upsert: true }).catch(e => console.error('save stats', e.message));
  send(p, myStats(p));
}
const myStats = (p) => { const s = STATS.get(p.uid) || {}; return { t: 'mystats', wins: s.wins || 0, losses: s.losses || 0, streak: s.streak || 0, bestStreak: s.bestStreak || 0 }; };
const ratio = (s) => s.wins / Math.max(1, s.losses);
function lbMsg() {
  const all = [...STATS.values()], top = (arr, f) => arr.slice().sort(f).slice(0, 5);
  return { t: 'lb',
    wins: top(all.filter(s => s.wins), (a, b) => b.wins - a.wins || a.losses - b.losses).map(s => [s.name, s.wins]),
    streak: top(all.filter(s => s.bestStreak), (a, b) => b.bestStreak - a.bestStreak || b.wins - a.wins).map(s => [s.name, s.bestStreak]),
    ratio: top(all.filter(s => s.matches >= 5), (a, b) => ratio(b) - ratio(a) || b.wins - a.wins).map(s => [s.name, Math.round(ratio(s) * 100) / 100, s.wins, s.losses]) };
}
function broadcastLB() { const m = JSON.stringify(lbMsg()); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(m); }
function recordMatch(room, isWinner) {
  for (const p of room.players.values()) if (p.inMatch && !p.bot) record(p, isWinner(p));
  broadcastLB();
}
function resetRound(room) {   // duels: everyone is back for the next round
  room.next = ''; placeAll(room);
  broadcast(room, { t: 'reset', score: room.score, spawns: Object.fromEntries([...room.players.values()].filter(p => p.inMatch).map(p => [p.id, [r2(p.x), r2(p.z)]])) });
}

/* ================= bots ================= */
function botThink(room, b, dt) {
  const map = room.map, me = room.holder === b.id;
  b.dashCD -= dt; if (b.dash > 0) b.dash -= dt;
  b.think -= dt;
  if (b.think <= 0) {
    b.think = 0.12 + Math.random() * 0.12;   // bots react a little slower than people
    const others = alive(room).filter(o => o !== b && (!room.duel || o.team !== b.team));   // in duels only the other team counts
    let tx = 0, tz = 0, want = 0;
    if (me) {   // chase the closest player you're allowed to tag
      let best = null, bd = 1e9;
      for (const o of others) { if (o.id === room.lastFrom && now() - room.lastPass < NO_TAGBACK) continue; const d = Math.hypot(o.x - b.x, o.z - b.z); if (d < bd) { bd = d; best = o; } }
      if (best) { tx = best.x - b.x; tz = best.z - b.z; want = 1; if (bd < 2.4 && (best.y || 0) > (b.y || 0) + .5) botJump(b); if (bd < 4 && b.dashCD <= 0 && room.phase === 'live' && Math.random() < .55) { b.dash = DASH_TIME; b.dashCD = DASH_CD + Math.random(); } }
    } else {
      let h = room.holder != null ? room.players.get(room.holder) : null;
      if (h && room.duel && h.team === b.team) h = null;   // your own teammate has it: no need to run
      const d = h ? Math.hypot(h.x - b.x, h.z - b.z) : 99;
      if (h && d < 13) {   // run away, juke sideways when it's close
        const ax = (b.x - h.x) / (d || 1), az = (b.z - h.z) / (d || 1);
        const side = d < 4 ? 0.9 : 0.35;
        tx = ax - az * side * b.side; tz = az + ax * side * b.side; want = 1;
        if (Math.random() < .03) b.side *= -1;
        if (d < 2.6 && b.dashCD <= 0 && Math.random() < .5) { b.dash = DASH_TIME; b.dashCD = DASH_CD + Math.random(); }
        if (d < 2.2 && Math.random() < .08) botJump(b);   // hop away
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
  if (!b.want && !(b.dash > 0)) { b.moving = false; botPhysics(map, b, dt); return; }
  const sp = (b.dash > 0 ? DASH_SPEED : (me ? HOLDER_SPEED : SPEED) * (b.want || 1)) * b.skill * dt;
  let dx = b.dirX, dz = b.dirZ, y = b.y || 0;
  const look = Math.max(.6, sp * 2);
  if (blocked(map, b.x + dx * look, b.z + dz * look, y)) {
    if (b.ground && !blocked(map, b.x + dx * look, b.z + dz * look, y + 1.6)) botJump(b);   // a step up: climb it
    else if (b.ground) for (const a of [0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {   // a wall: turn
      const c = Math.cos(a), s = Math.sin(a), nx = dx * c - dz * s, nz = dx * s + dz * c;
      if (!blocked(map, b.x + nx * look, b.z + nz * look, y)) { dx = nx; dz = nz; break; }
    }
  }
  const ox = b.x, oz = b.z; moveBot(map, b, dx * sp, dz * sp); botPhysics(map, b, dt);
  b.moving = Math.hypot(b.x - ox, b.z - oz) > 0.001;
  if (b.moving) b.yaw = Math.atan2(b.x - ox, b.z - oz);
}

/* ================= the game loop ================= */
function tickRoom(room, dt) {
  if (room.state === 'waiting' && !room.priv && humans(room).length) { room.state = 'countdown'; room.t = QUICK_WAIT; sendRoom(room); }
  if (room.state === 'countdown') { const before = Math.ceil(room.t); room.t -= dt; if (Math.ceil(room.t) !== before) sendRoom(room); if (room.t <= 0) startMatch(room); return; }
  if (room.state === 'results' && room.duel) {   // duels: everyone goes back to the hub
    room.t -= dt;
    if (room.t <= 0) { for (const p of humans(room)) { send(p, { t: 'duelend' }); p.room = null; p.inMatch = false; p.team = undefined; } rooms.delete(room.code); }
    return;
  }
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
        if (room.duel && o.team === h.team) continue;   // only the other team can take it
        const d = Math.hypot(o.x - h.x, o.z - h.z);
        if (d < bd && Math.abs((o.y || 0) - (h.y || 0)) < 1.6) { bd = d; best = o; }
      }
      if (best) { room.lastFrom = h.id; room.holder = best.id; room.lastPass = now(); broadcast(room, { t: 'pass', from: h.id, to: best.id }); }
    }
  } else if (room.phase === 'post' && room.timer <= 0) {
    if (room.next === 'end') return endMatch(room);
    if (room.next === 'reset') resetRound(room);
    startRound(room);
  }
  if (room.state !== 'playing') return;
  broadcast(room, { t: 'st', h: room.holder, ph: room.phase, tl: r2(Math.max(0, room.timer)),
    p: alive(room).map(p => [p.id, r2(p.x), r2(p.y || 0), r2(p.z), r2(p.yaw || 0), (p.dash > 0 ? 1 : 0) | (p.moving ? 2 : 0)]) });
}
setInterval(() => { for (const room of [...rooms.values()]) tickRoom(room, TICK); }, TICK * 1000);

/* ================= duel queues: 1v1, 2v2, 3v3 ================= */
const DQ = { 1: [], 2: [], 3: [] };
function dqRemove(p) { for (const k in DQ) { const i = DQ[k].indexOf(p); if (i >= 0) DQ[k].splice(i, 1); } p.dq = 0; }
function formDuel(size, group) {
  const room = makeRoom(true); room.duel = size; room.botsOn = true;
  const hs = group.sort(() => Math.random() - .5);
  hs.forEach((p, i) => { p.dq = 0; p.hub = null; p.team = i % 2; p.inMatch = false; room.players.set(p.id, p); p.room = room; });
  const used = new Set(hs.map(p => p.name));
  for (const t of [0, 1]) while ([...room.players.values()].filter(p => p.team === t).length < size) {   // bots fill the empty spots
    let n; do n = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; while (used.has(n) && used.size < BOT_NAMES.length); used.add(n);
    const b = { id: nextBot++, name: n, color: Math.floor(Math.random() * 8), bot: true, team: t, wins: 0, dashCD: Math.random() * 2, side: Math.random() < .5 ? 1 : -1, think: 0, dirX: 0, dirZ: 0, skill: 0.85 + Math.random() * 0.12 };
    room.players.set(b.id, b);
  }
  room.hostId = hs[0].id;
  room.map = pickMap(hs.map(p => p.mapPref));
  beginMatch(room);
}
setInterval(() => {
  for (const size of [1, 2, 3]) {
    const q = DQ[size] = DQ[size].filter(p => p.ws.readyState === 1 && !p.room);
    if (q.length >= size * 2) { formDuel(size, q.splice(0, size * 2)); continue; }
    if (q.length && now() - q[0].dqSince >= BOT_WAIT) { formDuel(size, q.splice(0, q.length)); continue; }
    const wait = q.length ? Math.max(0, Math.ceil(BOT_WAIT - (now() - q[0].dqSince))) : 0;
    for (const p of q) send(p, { t: 'dq', size, n: q.length, need: size * 2, bots: wait });
  }
}, 500);

/* ================= the hub: everyone on the menu walks around together ================= */
const inHub = (p) => p.hub && !p.room && now() - p.hub.t < 2.5;
setInterval(() => {
  const here = [...players.values()].filter(inHub); if (!here.length) return;
  const live = [];   // one ongoing match per arena, so people in the hub can watch it
  for (const id of MAP_IDS) {
    let best = null;
    for (const r of rooms.values()) if (r.state === 'playing' && r.map.id === id && (!best || humans(r).length > humans(best).length)) best = r;
    if (best) live.push({ m: id, h: best.holder, ph: best.phase, tl: r2(Math.max(0, best.timer)), s: best.strikeSeq || 0, sx: best.sx || 0, sz: best.sz || 0,
      p: alive(best).map(p => [p.id, p.name, p.color, r2(p.x), r2(p.y || 0), r2(p.z), r2(p.yaw || 0), (p.dash > 0 ? 1 : 0) | (p.moving ? 2 : 0), p.team == null ? -1 : p.team]) });
  }
  const msg = JSON.stringify({ t: 'hub', live, list: here.map(p => [p.id, p.name, p.color, p.hub.x, p.hub.y, p.hub.z, p.hub.f, p.hub.m ? 1 : 0]) });
  for (const p of here) if (p.ws.readyState === 1) p.ws.send(msg);
}, 120);
setInterval(() => { const msg = JSON.stringify({ t: 'online', n: players.size }); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(msg); }, 5000);

/* ================= connections ================= */
wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, name: 'Player', color: 0, room: null, x: 0, y: 0, z: 0, yaw: 0, wins: 0, mapPref: 'random', dq: 0, hub: null };
  players.set(p.id, p);
  send(p, { t: 'welcome', id: p.id, online: players.size, maps: MAPS.map(m => ({ id: m.id, name: m.name, half: m.half, theme: m.theme, boxes: m.boxes })) });
  send(p, lbMsg());
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = p.room;
    switch (m.t) {
      case 'hello': {
        p.name = clean(m.name) || 'Player'; p.color = Math.max(0, Math.min(7, m.color | 0));
        if (/^[a-z0-9]{8,16}$/i.test(String(m.uid || '')) && p.uid !== m.uid) { p.uid = String(m.uid); send(p, myStats(p)); }
        if (room) sendRoom(room); break;
      }
      case 'quick': joinRoom(p, quickRoom()); break;
      case 'duel': { const size = Math.max(1, Math.min(3, m.size | 0)); if (room) leaveRoom(p); dqRemove(p); p.dq = size; p.dqSince = now(); DQ[size].push(p); break; }
      case 'duelleave': dqRemove(p); send(p, { t: 'dq', size: 0 }); break;
      case 'map': p.mapPref = MAP_IDS.includes(m.id) ? m.id : 'random'; break;
      case 'pmap': if (room && room.priv && !room.duel && room.hostId === p.id) { room.mapPref = MAP_IDS.includes(m.id) ? m.id : 'random'; sendRoom(room); } break;
      case 'hub': {   // your position in the hub
        const x = num(m.x, -30, 30), y = num(m.y, 0, 12), z = num(m.z, -30, 30); if (x === null || y === null || z === null) return;
        p.hub = { x, y, z, f: r2(Number(m.f) || 0), m: !!m.m, t: now() }; break;
      }
      case 'hubleave': p.hub = null; break;
      case 'hchat': {
        if (!inHub(p) || now() - (p.lastChat || 0) < 1) return;
        const text = String(m.text || '').replace(/[<>]/g, '').trim().slice(0, 80); if (!text) return;
        p.lastChat = now(); const msg = JSON.stringify({ t: 'hchat', id: p.id, name: p.name, color: p.color, text });
        for (const q of players.values()) if (inHub(q) && q.ws.readyState === 1) q.ws.send(msg);
        break;
      }
      case 'create': { const r = makeRoom(true); joinRoom(p, r); break; }
      case 'join': { const r = rooms.get(String(m.code || '').toUpperCase().trim()); if (!r) return send(p, { t: 'err', text: 'No room with that code.' }); joinRoom(p, r); break; }
      case 'leave': leaveRoom(p); send(p, { t: 'left' }); break;
      case 'start': if (room && room.priv && !room.duel && room.hostId === p.id && room.state === 'waiting') startMatch(room); break;
      case 'bots': if (room && room.priv && room.hostId === p.id) { room.botsOn = !!m.on; sendRoom(room); } break;
      case 's': {   // your position (the server decides tags from these)
        if (!room || room.state !== 'playing' || !p.inMatch || p.out) return;
        const H = room.map.half, x = num(m.x, -H, H), y = num(m.y, 0, 8), z = num(m.z, -H, H);
        if (x === null || y === null || z === null) return;
        p.x = x; p.y = y; p.z = z; p.yaw = num(m.yaw, -10, 10) || 0; p.dash = m.d ? DASH_TIME : 0; p.moving = !!m.m; break;
      }
    }
  });
  ws.on('close', () => { dqRemove(p); leaveRoom(p); players.delete(p.id); });
});

initDB();
server.listen(PORT, () => console.log('Lightning Duels running on port ' + PORT));
