// server/index.js — 静态站点 + 联机对战 + 大厅社交 + 管理后台
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { Store, sanitizeName } from './store.js';
import { attachSocial } from './social.js';
import { attachAdmin } from './admin.js';
import { MODES, TICK_HZ, PROTOCOL_VERSION, WEAPONS } from '../shared/protocol.js';
import { BODY_SKINS, WEAPON_SKINS, rankOf } from '../shared/skins.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', 'public');
const DATA = path.resolve(process.env.SALT_DATA || path.join(__dirname, '..', 'data'));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.apk': 'application/vnd.android.package-archive',
};

// ---------------- 运行时 ----------------
export const runtime = {
  rooms: new Map(),
  roomSeq: 0,
  startedAt: Date.now(),
  wss: null,
  metrics: { tickMs: 0, ticks: 0, peakHumans: 0, peakOnline: 0 },
  clientErrors: [],
  logs: [],
};

export const store = new Store({ log: console.log });

export function adminLog(text, kind = 'info') {
  runtime.logs.push({ t: Date.now(), kind, text });
  if (runtime.logs.length > 500) runtime.logs.shift();
  console.log(`[${kind}] ${text}`);
}

export function makeRoom(modeId) {
  const pre = { battlefield: 'BF', extract: 'EX', relay: 'RL', duel: 'DU' }[modeId] || 'RM';
  const id = pre + '-' + (++runtime.roomSeq);
  const room = new Room(id, modeId, hooks);
  room.fillBots();
  runtime.rooms.set(id, room);
  adminLog(`房间 ${id} 创建（${room.mode.name}）`, 'room');
  return room;
}
runtime.newRoom = makeRoom;

function findRoom(modeId) {
  if (modeId === 'duel') return makeRoom('duel');
  for (const r of runtime.rooms.values()) {
    if (r.mode.id !== modeId) continue;
    if (r.state !== 'live') continue;
    if (r.partyId) continue;
    if (r.humanCount() >= r.mode.players) continue;
    return r;
  }
  return makeRoom(modeId);
}

export function roomList() {
  return [...runtime.rooms.values()].map((r) => ({
    id: r.id, mode: r.mode.id, modeName: r.mode.name,
    players: r.humanCount(), bots: r.totalCount() - r.humanCount(),
    state: r.state, timeLeft: Math.round(r.timeLeft),
    party: r.partyId || '', winner: r.winner ?? null, endReason: r.endReason ?? null,
  }));
}

export function roomDetail(id) {
  const r = runtime.rooms.get(id);
  if (!r) return null;
  return {
    id: r.id, mode: r.mode.id, modeName: r.mode.name, state: r.state, tick: r.tickN,
    timeLeft: Math.round(r.timeLeft), tickets: r.tickets, party: r.partyId || '',
    duel: r.duel, relays: r.relays.map((x) => [x.id, Math.round(x.hp), x.down ? 1 : 0]),
    cp: r.cp.map((c) => [c.id, c.owner, Math.round(c.progress)]),
    cratesOpen: r.crates.filter((c) => c.open).length, cratesTotal: r.crates.length,
    players: [...r.players.values()].map((p) => ({
      id: p.id, name: p.name, bot: p.bot, team: p.team, hp: Math.round(p.hp), alive: p.alive,
      kills: p.kills, deaths: p.deaths, score: Math.round(p.score),
      pos: [Math.round(p.x), Math.round(p.y), Math.round(p.z)],
      weapon: p.weapon, loot: p.lootValue, accId: p.accId || '',
      tier: p.accId ? rankOf(store.accounts.get(p.accId)?.points || 0).name : '', ip: p.ip || '',
    })),
  };
}

// ---------------- 结算钩子 ----------------
const hooks = {
  onKill(attacker) {
    if (attacker.accId) store.addMissionProgress(store.accounts.get(attacker.accId), 'kills5', 1);
  },
  onExtract(p, value) {
    if (!p.accId) return;
    const acc = store.accounts.get(p.accId);
    if (!acc) return;
    store.addMissionProgress(acc, 'extract1', 1);
    store.send(acc.id, { t: 'social', k: 'reward', text: `撤离成功，价值 ¥${value} 已计入结算`, amount: 0 });
  },
  onRoundEnd(room, reason, winner) {
    const rewards = [];
    for (const p of room.players.values()) {
      if (!p.accId) continue;
      const acc = store.accounts.get(p.accId);
      if (!acc) continue;
      const win = room.mode.id === 'battlefield' || room.mode.id === 'duel'
        ? p.team === winner
        : room.mode.id === 'relay' ? winner === 0 || winner === 1 : p.extracted > 0 || p.lootValue > 0;
      const r = store.recordMatch(acc, {
        mode: room.mode.id, kills: p.kills, deaths: p.deaths, win,
        extracted: Math.round(p.extracted || 0), score: p.score,
        duel: room.mode.id === 'duel',
      });
      rewards.push({ id: p.id, name: p.name, earned: r.earned, points: r.points, rank: r.rank.name, rankColor: r.rank.color, win });
      store.send(acc.id, {
        t: 'social', k: 'settled', mode: room.mode.id, reason,
        earned: r.earned, points: r.points, rank: r.rank, win, kills: p.kills, deaths: p.deaths,
      });
    }
    room.rewards = rewards;
    adminLog(`对局结算 ${room.id}（${reason}）${rewards.map((r) => `${r.name}+${r.earned}`).join(' ')}`, 'settle');
  },
};

// ---------------- 定时 ----------------
setInterval(() => {
  const t = Date.now();
  for (const r of runtime.rooms.values()) {
    if (r.state === 'ended' && t - (r.endedAt || 0) > 15000) r.reset();
    if (r.humanCount() === 0 && t - r.createdAt > 30000) {
      const humans = [...r.players.values()].filter((p) => !p.bot);
      if (!humans.length) { runtime.rooms.delete(r.id); adminLog(`房间 ${r.id} 回收`, 'room'); }
    }
  }
}, 2000).unref?.();

let lastTick = Date.now();
setInterval(() => {
  const t0 = performance.now();
  const t = Date.now();
  const dt = Math.min(0.25, (t - lastTick) / 1000);
  lastTick = t;
  for (const r of runtime.rooms.values()) {
    try {
      if (r.state === 'live') r.step(dt);
      else if (r.tickN % 40 === 0) r.snapshot();
    } catch (e) {
      adminLog(`房间 ${r.id} tick 异常: ${e.message}`, 'error');
    }
  }
  runtime.metrics.tickMs = runtime.metrics.tickMs * 0.9 + (performance.now() - t0) * 0.1;
  runtime.metrics.ticks++;
  runtime.metrics.peakOnline = Math.max(runtime.metrics.peakOnline, store.stats().online);
}, 1000 / TICK_HZ).unref?.();

setInterval(() => {
  for (const ws of runtime.wss?.clients || []) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 20000).unref?.();

// ---------------- HTTP ----------------
export function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.startsWith('/api/admin/')) return false;
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/apk' || urlPath === '/download') urlPath = '/download.html';

  if (urlPath === '/api/rooms') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({
      ok: true, rooms: roomList(), modes: Object.values(MODES),
      motd: store.config.motd, online: store.stats().online,
      announcements: store.announcements.slice(0, 5),
    }));
    return true;
  }
  if (urlPath === '/api/apk') {
    const apk = path.join(ROOT, 'saltline.apk');
    const exists = fs.existsSync(apk);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, exists, size: exists ? fs.statSync(apk).size : 0 }));
    return true;
  }
  if (urlPath === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, up: Math.round(process.uptime()), rooms: runtime.rooms.size,
      online: store.stats().online, accounts: store.count(),
      tickMs: +runtime.metrics.tickMs.toFixed(2), v: PROTOCOL_VERSION,
    }));
    return true;
  }

  const isShared = urlPath.startsWith('/shared/');
  const base = isShared ? path.join(ROOT, '..', 'shared') : ROOT;
  const rel = isShared ? urlPath.slice('/shared/'.length) : urlPath;
  const tryFile = (f) => path.join(base, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
  let file = tryFile(rel);
  if (!file.startsWith(base)) { res.writeHead(403); res.end('forbidden'); return true; }
  try {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {}
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size };
    headers['cache-control'] = ['.html', '.js', '.css', '.webmanifest', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return true;
}



const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.startsWith('/api/admin/')) {
    const done = await adminApi.handleApi(req, res, urlPath);
    if (done !== false) return;
  }
  if (serveStatic(req, res)) return;
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404');
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
runtime.wss = wss;

export function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  const raw = (f ? String(f).split(',')[0] : req.socket.remoteAddress) || '';
  return raw.replace('::ffff:', '').split(':')[0] || raw;
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const ip = clientIp(req);
  if (store.bans.has(ip)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.ip = ip;
    try { ws.ping(); } catch {}
    wss.emit('connection', ws, req);
  });
});

// ---- 进入 / 离开对局 ----
export function enterRoom(ws, modeId, opts = {}) {
  const acc = ws._acc || null;
  if (ws._room) leaveRoom(ws);
  const room = opts.room || findRoom(modeId);
  const team = opts.team || (modeId === 'battlefield'
    ? (room.countTeam(1) <= room.countTeam(2) ? 1 : 2) : 1);
  const bodyIdx = acc ? Math.max(0, BODY_SKINS.findIndex((s) => s.id === acc.equipped?.body)) : 0;
  const p = room.addPlayer({
    name: acc ? acc.name : sanitizeName(opts.name || 'OPERATOR'),
    team, ws, acc: acc || null, skin: bodyIdx,
    weaponSkin: acc ? acc.equipped?.kr7 : null,
  });
  p.ip = ws.ip;
  ws._room = room;
  ws._player = p;
  room.fillBots();
  room.rawSend(ws, {
    t: 'welcome', id: p.id, room: room.id, mode: room.mode, v: PROTOCOL_VERSION,
    team: p.team, spawn: [p.x, p.y, p.z], motd: store.config.motd,
    sky: 0,
    profile: acc ? { name: acc.name, tier: rankOf(acc.points).name, tierColor: rankOf(acc.points).color, equipped: acc.equipped, emotes: acc.emotes } : null,
    roster: [...room.players.values()].map((o) => ({ id: o.id, name: o.name, team: o.team, bot: o.bot })),
    world: { relays: room.relays.map((r) => r.id), cp: room.cp.map((c) => c.id) },
  });
  room.broadcast({ t: 'event', k: 'joined', id: p.id, name: p.name }, p.id);
  adminLog(`${p.name}#${p.id} 进入 ${room.id}（${room.humanCount()} 真人）`, 'player');
  runtime.metrics.peakHumans = Math.max(runtime.metrics.peakHumans, room.humanCount());
  return room;
}

export function leaveRoom(ws) {
  const p = ws._player, r = ws._room;
  if (!p || !r) return;
  r.removePlayer(p.id);
  r.broadcast({ t: 'event', k: 'left', id: p.id, name: p.name });
  ws._room = null; ws._player = null;
  if (r.humanCount() === 0) r.createdAt = Date.now();
  adminLog(`${p.name} 离开 ${r.id}`, 'player');
}

export const social = attachSocial({ store, runtime, enterRoom, leaveRoom, adminLog });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws._room = null;
  ws._player = null;
  ws._acc = null;

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    try {
      if (social.handle(ws, m)) return;
      handleGame(ws, m);
    } catch (e) { console.error('[ws] handler error', e); }
  });

  ws.on('close', () => {
    if (ws._acc) {
      store.removeSession(ws._acc, ws);
      const f = store.friendList(ws._acc);
      for (const fr of f) if (!fr.online) store.send(fr.id, { t: 'social', k: 'presence', id: ws._acc.id, online: false });
    }
    leaveRoom(ws);
  });
  ws.on('error', () => {});
});

function handleGame(ws, m) {
  switch (m.t) {
    case 'hello': {
      const modeId = MODES[m.mode] ? m.mode : 'extract';
      enterRoom(ws, modeId, { name: m.name });
      break;
    }
    case 'input': { const p = ws._player; if (p) ws._room.onInput(p, m); break; }
    case 'fire': { const p = ws._player; if (p) ws._room.onFire(p, m); break; }
    case 'act': {
      const p = ws._player, r = ws._room; if (!p) break;
      if (m.a === 'interact') r.onInteract(p);
      else if (m.a === 'drop') r.onDrop(p);
      else if (m.a === 'use') r.useItem(p, m.kind);
      else if (m.a === 'weapon') { if (WEAPONS[m.w] && p.alive) { p.weapon = m.w; p.ammo = 0; r.startReload(p); } }
      else if (m.a === 'respawn') r.respawn(p);
      break;
    }
    case 'chat': {
      const p = ws._player, r = ws._room; if (!p || !r) break;
      const text = String(m.text || '').slice(0, 90);
      if (text) r.broadcast({ t: 'event', k: 'chat', from: p.name, text, team: p.team });
      break;
    }
    case 'resync': { const p = ws._player, r = ws._room; if (p) r.rawSend(ws, { t: 'event', k: 'resync', tl: Math.round(r.timeLeft) }); break; }
    case 'clientError': {
      const rec = {
        at: Date.now(), kind: String(m.kind || '?').slice(0, 40),
        message: String(m.message || '').slice(0, 300),
        stack: String(m.stack || '').slice(0, 900),
        state: String(m.state || ''), ua: String(m.ua || ''), viewport: String(m.viewport || ''),
        quality: String(m.quality || ''), player: ws._player ? ws._player.name : '-',
      };
      runtime.clientErrors.push(rec);
      if (runtime.clientErrors.length > 100) runtime.clientErrors.shift();
      adminLog(`客户端报错[${rec.kind}] ${rec.message}（${rec.state} ${rec.viewport} q=${rec.quality}）`, 'client');
      break;
    }
    case 'leave': { leaveRoom(ws); break; }
  }
}

// ---------------- 管理后台 ----------------
const adminApi = attachAdmin({
    runtime, store, roomList, roomDetail, makeRoom, adminLog,
    kick: (roomId, pid) => {
      const r = runtime.rooms.get(roomId);
      if (!r) return false;
      const p = r.players.get(pid);
      if (!p) return false;
      if (p.ws) { try { p.ws.send(JSON.stringify({ t: 'kicked', reason: '管理员操作' })); } catch {} }
      r.removePlayer(pid);
      r.broadcast({ t: 'event', k: 'left', id: pid, name: p.name });
      adminLog(`踢出 ${p.name}（${r.id}）`, 'admin');
      return true;
    },
  broadcastAll: (text) => {
    for (const r of runtime.rooms.values()) r.broadcast({ t: 'event', k: 'admin', text });
    for (const [accId] of store.sessions) store.send(accId, { t: 'social', k: 'notice', text, title: '服务器公告' });
    adminLog(`广播：${text}`, 'admin');
  },
});


server.listen(PORT, HOST, () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
  }
  console.log(`\n  Saltline MP   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  局域网        http://${ip}:${PORT}`);
  console.log(`  管理后台      http://localhost:${PORT}/admin`);
  console.log(`  下载页        http://localhost:${PORT}/download\n`);
  adminLog(`服务器启动，端口 ${PORT}`, 'system');
});
