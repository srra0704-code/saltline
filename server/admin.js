// server/admin.js — 管理后台 API（登录、监控、踢人/封禁、公告、发钱、房间控制、日志流）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.SALT_DATA || path.join(__dirname, '..', 'data'));
const AUTH_FILE = path.join(DATA, 'admin.json');

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
function saveAuth(o) { fs.writeFileSync(AUTH_FILE, JSON.stringify(o, null, 1)); }
function hash(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

export function attachAdmin(ctx) {
  const { runtime, store, roomList, roomDetail, makeRoom, adminLog } = ctx;
  const sessions = new Map();       // token -> expiresAt
  const attempts = new Map();       // ip -> {n, at}
  const sseClients = new Set();

  let auth = loadAuth();
  if (process.env.ADMIN_PASSWORD) {
    const salt = crypto.randomBytes(8).toString('hex');
    auth = { salt, hash: hash(process.env.ADMIN_PASSWORD, salt), createdAt: Date.now(), generated: false };
    saveAuth(auth);
    console.log('  [admin] 已按环境变量 ADMIN_PASSWORD 设置后台密码');
  } else if (auth && auth.generated) {
    // 保留自动生成的密码文件
  }
  if (!auth) {
    const pw = process.env.ADMIN_PASSWORD || String(crypto.randomInt(100000, 999999));
    const salt = crypto.randomBytes(8).toString('hex');
    auth = { salt, hash: hash(pw, salt), createdAt: Date.now(), generated: !process.env.ADMIN_PASSWORD };
    saveAuth(auth);
    console.log('\n  ╔══════════════════════════════════════╗');
    console.log('  ║  管理后台入口  /admin                ║');
    console.log(`  ║  初始密码：${pw.padEnd(24)}║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('  （可在 data/admin.json 修改，或设置环境变量 ADMIN_PASSWORD）\n');
  }

  function json(res, code, obj, headers = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }
  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function authed(req) {
    const t = cookies(req).sl_sid;
    if (!t) return false;
    const e = sessions.get(t);
    if (!e || e < Date.now()) { sessions.delete(t); return false; }
    sessions.set(t, Date.now() + 12 * 3600 * 1000);
    return true;
  }
  function body(req) {
    return new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    });
  }
  function pushLog(line) {
    const payload = `data: ${JSON.stringify(line)}\n\n`;
    for (const res of sseClients) { try { res.write(payload); } catch {} }
  }

  // 日志流：把 adminLog 的输出镜像给后台页面
  const origLog = adminLog;
  const wrappedLog = (text, kind) => {
    origLog(text, kind);
    pushLog({ t: Date.now(), kind: kind || 'info', text });
  };

  async function handleApi(req, res, urlPath) {
    const ip = ctx.clientIp ? ctx.clientIp(req) : (req.socket.remoteAddress || '');
    if (urlPath === '/api/admin/login' && req.method === 'POST') {
      const b = await body(req);
      const a = attempts.get(ip) || { n: 0, at: Date.now() };
      if (Date.now() - a.at > 60000) { a.n = 0; a.at = Date.now(); }
      if (a.n > 8) return json(res, 429, { error: '尝试过多，请稍后再试' });
      const tryHash = hash(String(b.password || ''), auth.salt);
      if (tryHash !== auth.hash) {
        a.n++; attempts.set(ip, a);
        wrappedLog(`后台登录失败（${ip}）`, 'admin');
        return json(res, 401, { error: '密码错误' });
      }
      attempts.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, Date.now() + 12 * 3600 * 1000);
      wrappedLog(`后台登录成功（${ip}）`, 'admin');
      return json(res, 200, { ok: true }, { 'set-cookie': `sl_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200` });
    }

    if (urlPath === '/api/admin/logout' && req.method === 'POST') {
      const t = cookies(req).sl_sid;
      sessions.delete(t);
      return json(res, 200, { ok: true }, { 'set-cookie': 'sl_sid=; Path=/; Max-Age=0' });
    }

    if (urlPath === '/api/admin/session') return json(res, 200, { ok: authed(req) });

    if (!authed(req)) return json(res, 401, { error: '未登录' });

    if (urlPath === '/api/admin/data') {
      const mem = process.memoryUsage();
      return json(res, 200, {
        ok: true,
        health: {
          up: Math.round(process.uptime()),
          rooms: runtime.rooms.size,
          humans: [...runtime.rooms.values()].reduce((a, r) => a + r.humanCount(), 0),
          wsClients: runtime.wss?.clients?.size || 0,
          tickMs: +runtime.metrics.tickMs.toFixed(2),
          peakOnline: runtime.metrics.peakOnline,
          memMB: +(mem.rss / 1048576).toFixed(1),
          load: os.loadavg()[0],
          cpus: os.cpus().length,
          node: process.version,
        },
        store: store.stats(),
        rooms: roomList(),
        announcements: store.announcements,
        bans: [...store.bans],
        config: store.config,
        leaderboard: {
          points: store.leaderboard('points', 15),
          kills: store.leaderboard('kills', 10),
          currency: store.leaderboard('currency', 10),
        },
        accounts: [...store.accounts.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 60).map((a) => ({
          id: a.id, name: a.name, currency: a.currency, points: a.points, kills: a.kills, deaths: a.deaths,
          matches: a.matches, online: store.isOnline(a.id), banned: !!a.banned,
          lastSeen: a.lastSeen, friends: a.friends.length, skins: a.skins.length, party: a.partyId || '',
        })),
        logs: runtime.logs.slice(-120),
        clientErrors: (runtime.clientErrors || []).slice(-40).reverse(),
        parties: [...store.parties.values()].map((p) => ({ id: p.id, leader: store.accounts.get(p.leader)?.name, members: p.members.length, mode: p.mode })),
      });
    }

    if (urlPath === '/api/admin/room') {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      return json(res, 200, { ok: true, room: roomDetail(id) });
    }

    if (urlPath === '/api/admin/action' && req.method === 'POST') {
      const b = await body(req);
      const doIt = b.do;
      const out = { ok: true, do: doIt };
      switch (doIt) {
        case 'kick':
          out.result = ctx.kick(b.room, Number(b.id));
          break;
        case 'ban_ip': {
          store.bans.add(String(b.ip));
          store.dirty = true;
          wrappedLog(`封禁 IP ${b.ip}`, 'admin');
          break;
        }
        case 'unban_ip': store.bans.delete(String(b.ip)); store.dirty = true; break;
        case 'ban_account': out.result = store.setBan(b.id, true); break;
        case 'unban_account': out.result = store.setBan(b.id, false); break;
        case 'announce': {
          const a = store.postAnnouncement({ title: b.title || '公告', body: b.body || '', kind: b.kind || 'notice', author: 'ADMIN' });
          out.announcement = a;
          for (const [accId] of store.sessions) store.send(accId, { t: 'social', k: 'notice', title: a.title, text: a.body });
          wrappedLog(`发布公告：${a.title}`, 'admin');
          break;
        }
        case 'delete_announcement': store.removeAnnouncement(b.id); break;
        case 'broadcast':
          ctx.broadcastAll(String(b.text || '').slice(0, 120));
          break;
        case 'grant': {
          const acc = store.accounts.get(b.id);
          if (acc) { store.grant(acc, Number(b.amount) || 0, '管理员发放'); out.balance = acc.currency; }
          wrappedLog(`给 ${acc?.name} 发放 ${b.amount} 港币`, 'admin');
          break;
        }
        case 'end_round': {
          const r = runtime.rooms.get(b.room);
          if (r) { r.endRound('admin', Number(b.winner) || 0); out.result = true; }
          break;
        }
        case 'reset_room': {
          const r = runtime.rooms.get(b.room);
          if (r) { r.reset(); out.result = true; }
          break;
        }
        case 'close_room': {
          const r = runtime.rooms.get(b.room);
          if (r) {
            for (const p of r.players.values()) if (p.ws) { try { p.ws.send(JSON.stringify({ t: 'kicked', reason: '房间已关闭' })); } catch {} }
            runtime.rooms.delete(b.room);
            out.result = true;
          }
          break;
        }
        case 'create_room': out.room = makeRoom(String(b.mode || 'battlefield')).id; break;
        case 'set_config': {
          if (typeof b.motd === 'string') store.config.motd = b.motd.slice(0, 120);
          if (typeof b.botScale === 'number') store.config.botScale = Math.max(0, Math.min(2, b.botScale));
          store.dirty = true;
          out.config = store.config;
          break;
        }
        case 'reset_password': {
          const pw = String(b.password || '').trim();
          if (pw.length < 4) { out.ok = false; out.error = '密码至少 4 位'; break; }
          const salt = crypto.randomBytes(8).toString('hex');
          auth = { salt, hash: hash(pw, salt), createdAt: Date.now(), generated: false };
          saveAuth(auth);
          sessions.clear();
          wrappedLog('后台密码已重置', 'admin');
          break;
        }
        default: out.ok = false; out.error = '未知操作';
      }
      return json(res, 200, out);
    }

    if (urlPath === '/api/admin/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache',
        connection: 'keep-alive', 'x-accel-buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ t: Date.now(), kind: 'system', text: '日志流已连接' })}\n\n`);
      sseClients.add(res);
      const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(keep); sseClients.delete(res); });
      return true; // 已处理
    }

    return json(res, 404, { error: 'not found' });
  }

  // 把 runtime.logs 的增量镜像到 SSE
  let lastSeen = runtime.logs.length;
  const mirror = setInterval(() => {
    if (runtime.logs.length < lastSeen) lastSeen = 0;
    for (let i = lastSeen; i < runtime.logs.length; i++) pushLog(runtime.logs[i]);
    lastSeen = runtime.logs.length;
  }, 1000);
  mirror.unref?.();

  // 供 index.js 的 HTTP 入口调用
  return { handleApi, sessions };
}
