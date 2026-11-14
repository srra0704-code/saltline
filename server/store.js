// server/store.js — 账号 / 好友 / 组队 / 公告 / 排行榜 / 段位（JSON 持久化）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rankOf, MISSIONS, EMOTES, WEAPON_SKINS, BODY_SKINS, EVENTS, eventActive } from '../shared/skins.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.SALT_DATA || path.join(__dirname, '..', 'data'));
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const F = {
  accounts: path.join(DATA, 'accounts.json'),
  meta: path.join(DATA, 'meta.json'),
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 1)); } catch (e) { console.error('[store] write failed', e.message); }
}

const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class Store {
  constructor({ log = console.log } = {}) {
    this.log = log;
    const a = readJson(F.accounts, { accounts: {} });
    const m = readJson(F.meta, { announcements: [], bans: [], config: { motd: '', botScale: 1 } });
    this.accounts = new Map(Object.entries(a.accounts || {}));
    this.byName = new Map();
    for (const acc of this.accounts.values()) this.byName.set(acc.name.toLowerCase(), acc.id);
    this.announcements = m.announcements || [];
    this.bans = new Set(m.bans || []);
    this.config = Object.assign({ motd: '', botScale: 1 }, m.config || {});
    this.parties = new Map();
    this.sessions = new Map();   // accountId -> Set(ws)
    this.dirty = false;
    this.saveTimer = setInterval(() => { if (this.dirty) this.save(); }, 3000);
    this.saveTimer.unref?.();
    process.on('exit', () => this.save());
  }

  save() {
    this.dirty = false;
    writeJson(F.accounts, { accounts: Object.fromEntries(this.accounts) });
    writeJson(F.meta, { announcements: this.announcements, bans: [...this.bans], config: this.config });
  }

  count() { return this.accounts.size; }

  // ---------- 账号 ----------
  create({ id, name, token }) {
    const acc = {
      id: id || crypto.randomUUID(),
      token: token || crypto.randomBytes(12).toString('hex'),
      name: name || 'OPERATOR',
      createdAt: Date.now(), lastSeen: Date.now(),
      currency: 1200, points: 0, level: 1, exp: 0,
      wins: 0, losses: 0, kills: 0, deaths: 0, matches: 0, duelWins: 0, duelLosses: 0,
      extractions: 0, extractValue: 0, bestExtract: 0,
      skins: ['kr7_stock', 'sg12_stock', 'dmr_stock', 'op_stock'],
      equipped: { kr7: 'kr7_stock', sg12: 'sg12_stock', dmr: 'dmr_stock', body: 'op_stock' },
      emotes: ['wave'],
      emoteUses: 0,
      friends: [], incoming: [], outgoing: [],
      missions: { date: today(), progress: {}, claimed: [] },
      checkin: { last: '', streak: 0 },
      history: [],
      role: 'player', banned: false,
    };
    this.accounts.set(acc.id, acc);
    this.byName.set(acc.name.toLowerCase(), acc.id);
    this.dirty = true;
    return acc;
  }

  auth({ id, token, name }) {
    let acc = id ? this.accounts.get(id) : null;
    if (acc && token && acc.token !== token) acc = null;
    if (!acc && name) {
      const existing = this.byName.get(String(name).toLowerCase());
      if (existing) acc = this.accounts.get(existing);
    }
    if (!acc) acc = this.create({ id, name: sanitizeName(name) });
    if (name && sanitizeName(name) !== acc.name && !this.byName.has(sanitizeName(name).toLowerCase())) {
      this.byName.delete(acc.name.toLowerCase());
      acc.name = sanitizeName(name);
      this.byName.set(acc.name.toLowerCase(), acc.id);
    }
    acc.lastSeen = Date.now();
    this.dirty = true;
    return acc;
  }

  setBan(id, banned) {
    const acc = this.accounts.get(id);
    if (!acc) return false;
    acc.banned = !!banned;
    this.dirty = true;
    return true;
  }

  // ---------- 在线状态 ----------
  addSession(acc, ws) {
    if (!this.sessions.has(acc.id)) this.sessions.set(acc.id, new Set());
    this.sessions.get(acc.id).add(ws);
  }
  removeSession(acc, ws) {
    const s = this.sessions.get(acc.id);
    if (!s) return;
    s.delete(ws);
    if (!s.size) { this.sessions.delete(acc.id); this.leaveParty(acc); }
  }
  isOnline(accId) { return this.sessions.has(accId); }
  send(accId, msg) {
    const s = this.sessions.get(accId);
    if (!s) return false;
    const payload = JSON.stringify(msg);
    for (const ws of s) if (ws.readyState === 1) { try { ws.send(payload); } catch {} }
    return true;
  }

  // ---------- 好友 ----------
  find(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    if (this.accounts.has(query)) return this.accounts.get(query);
    const id = this.byName.get(q);
    return id ? this.accounts.get(id) : null;
  }

  friendRequest(acc, targetName) {
    const t = this.find(targetName);
    if (!t) return { error: '找不到该呼号' };
    if (t.id === acc.id) return { error: '不能加自己' };
    if (acc.friends.includes(t.id)) return { error: '已经是好友' };
    if (t.incoming.includes(acc.id)) return { error: '已发送过请求' };
    t.incoming.push(acc.id);
    acc.outgoing.push(t.id);
    this.dirty = true;
    this.send(t.id, { t: 'social', k: 'friendRequest', from: publicProfile(acc, this) });
    return { ok: true, target: publicProfile(t, this) };
  }

  friendAccept(acc, targetId) {
    const t = this.accounts.get(targetId);
    if (!t) return { error: '找不到该玩家' };
    if (!acc.incoming.includes(t.id)) return { error: '没有待处理请求' };
    acc.incoming = acc.incoming.filter((x) => x !== t.id);
    t.outgoing = t.outgoing.filter((x) => x !== acc.id);
    if (!acc.friends.includes(t.id)) acc.friends.push(t.id);
    if (!t.friends.includes(acc.id)) t.friends.push(acc.id);
    this.dirty = true;
    this.send(t.id, { t: 'social', k: 'friendAccepted', by: publicProfile(acc, this) });
    return { ok: true };
  }

  friendRemove(acc, targetId) {
    acc.friends = acc.friends.filter((x) => x !== targetId);
    acc.incoming = acc.incoming.filter((x) => x !== targetId);
    acc.outgoing = acc.outgoing.filter((x) => x !== targetId);
    const t = this.accounts.get(targetId);
    if (t) {
      t.friends = t.friends.filter((x) => x !== acc.id);
      t.incoming = t.incoming.filter((x) => x !== acc.id);
      t.outgoing = t.outgoing.filter((x) => x !== acc.id);
      this.send(t.id, { t: 'social', k: 'friendRemoved', by: { id: acc.id, name: acc.name } });
    }
    this.dirty = true;
    return { ok: true };
  }

  friendList(acc) {
    return acc.friends.map((id) => {
      const t = this.accounts.get(id);
      if (!t) return null;
      return { ...publicProfile(t, this), online: this.isOnline(id), inMatch: !!(t.ws && t.ws._room) };
    }).filter(Boolean);
  }

  // ---------- 组队 ----------
  createParty(acc) {
    if (acc.partyId && this.parties.has(acc.partyId)) return this.parties.get(acc.partyId);
    const id = crypto.randomBytes(3).toString('hex').toUpperCase();
    const party = { id, leader: acc.id, members: [acc.id], invited: [], createdAt: Date.now(), mode: 'battlefield' };
    this.parties.set(id, party);
    acc.partyId = id;
    this.dirty = true;
    return party;
  }

  partyOf(acc) {
    if (!acc.partyId) return null;
    const p = this.parties.get(acc.partyId);
    if (!p) { acc.partyId = null; return null; }
    return p;
  }

  partyJoin(acc, codeOrLeader) {
    const party = this.parties.get(String(codeOrLeader || '').toUpperCase())
      || [...this.parties.values()].find((p) => this.accounts.get(p.leader)?.name.toLowerCase() === String(codeOrLeader || '').toLowerCase());
    if (!party) return { error: '队伍不存在' };
    if (party.members.length >= 4) return { error: '队伍已满（4 人）' };
    if (party.members.includes(acc.id)) return { ok: true, party: this.partyView(party) };
    party.members.push(acc.id);
    party.invited = party.invited.filter((x) => x !== acc.id);
    acc.partyId = party.id;
    this.dirty = true;
    this.broadcastParty(party, { t: 'social', k: 'partyUpdate', party: this.partyView(party) });
    return { ok: true, party: this.partyView(party) };
  }

  partyInvite(acc, targetName) {
    const party = this.partyOf(acc) || this.createParty(acc);
    if (party.leader !== acc.id) return { error: '只有队长能邀请' };
    const t = this.find(targetName);
    if (!t) return { error: '找不到该玩家' };
    if (party.members.length >= 4) return { error: '队伍已满' };
    if (party.members.includes(t.id)) return { error: '已在队伍中' };
    if (!party.invited.includes(t.id)) party.invited.push(t.id);
    this.dirty = true;
    this.send(t.id, { t: 'social', k: 'partyInvite', party: this.partyView(party), from: publicProfile(acc, this) });
    return { ok: true };
  }

  partyLeave(acc) {
    return this.leaveParty(acc);
  }

  leaveParty(acc) {
    const party = this.partyOf(acc);
    if (!party) return { ok: true };
    party.members = party.members.filter((x) => x !== acc.id);
    acc.partyId = null;
    this.dirty = true;
    if (!party.members.length) {
      this.parties.delete(party.id);
    } else {
      if (party.leader === acc.id) party.leader = party.members[0];
      this.broadcastParty(party, { t: 'social', k: 'partyUpdate', party: this.partyView(party) });
    }
    return { ok: true };
  }

  partyView(party) {
    return {
      id: party.id, leader: party.leader, mode: party.mode,
      members: party.members.map((id) => {
        const a = this.accounts.get(id);
        return a ? { ...publicProfile(a, this), online: this.isOnline(id), leader: id === party.leader } : null;
      }).filter(Boolean),
      invited: party.invited.map((id) => this.accounts.get(id)?.name).filter(Boolean),
    };
  }

  broadcastParty(party, msg) {
    for (const id of party.members) this.send(id, msg);
  }

  // ---------- 公告 ----------
  postAnnouncement({ title, body, kind = 'notice', author = 'ADMIN' }) {
    const a = { id: crypto.randomBytes(4).toString('hex'), title: String(title).slice(0, 60), body: String(body).slice(0, 600), kind, author, at: Date.now() };
    this.announcements.unshift(a);
    if (this.announcements.length > 50) this.announcements.pop();
    this.dirty = true;
    return a;
  }
  removeAnnouncement(id) {
    this.announcements = this.announcements.filter((a) => a.id !== id);
    this.dirty = true;
  }

  // ---------- 经济 / 成长 ----------
  grant(acc, amount, reason = '') {
    acc.currency = Math.max(0, Math.round(acc.currency + amount));
    acc.lastGrant = { amount, reason, at: Date.now() };
    this.dirty = true;
    return acc.currency;
  }

  addMissionProgress(acc, key, amount = 1) {
    const d = today();
    if (acc.missions.date !== d) { acc.missions = { date: d, progress: {}, claimed: [] }; }
    acc.missions.progress[key] = (acc.missions.progress[key] || 0) + amount;
    this.dirty = true;
  }

  claimMission(acc, key) {
    const d = today();
    if (acc.missions.date !== d) { acc.missions = { date: d, progress: {}, claimed: [] }; }
    const def = MISSIONS.find((m) => m.id === key);
    if (!def) return { error: '任务不存在' };
    if (acc.missions.claimed.includes(key)) return { error: '已领取' };
    const prog = acc.missions.progress[key] || 0;
    if (prog < def.target) return { error: `进度不足（${prog}/${def.target}）` };
    acc.missions.claimed.push(key);
    this.grant(acc, def.reward, '任务 ' + def.name);
    return { ok: true, reward: def.reward };
  }

  checkin(acc) {
    const d = today();
    if (acc.checkin.last === d) return { error: '今天已签到' };
    const y = today(Date.now() - 86400000);
    acc.checkin.streak = acc.checkin.last === y ? acc.checkin.streak + 1 : 1;
    acc.checkin.last = d;
    const reward = 300 + Math.min(7, acc.checkin.streak) * 100;
    this.grant(acc, reward, `连续签到 ${acc.checkin.streak} 天`);
    return { ok: true, reward, streak: acc.checkin.streak };
  }

  // ---------- 商店 ----------
  buy(acc, itemId) {
    const item = [...WEAPON_SKINS, ...BODY_SKINS, ...EMOTES].find((i) => i.id === itemId);
    if (!item) return { error: '商品不存在' };
    const isEmote = EMOTES.includes(item);
    const owned = isEmote ? acc.emotes.includes(item.id) : acc.skins.includes(item.id);
    if (owned) return { error: '已拥有' };
    if (acc.currency < item.price) return { error: '港币不足' };
    this.grant(acc, -item.price, '购买 ' + item.name);
    if (isEmote) acc.emotes.push(item.id); else acc.skins.push(item.id);
    this.dirty = true;
    return { ok: true, item };
  }

  equip(acc, itemId) {
    const w = WEAPON_SKINS.find((s) => s.id === itemId);
    const b = BODY_SKINS.find((s) => s.id === itemId);
    if (w) { if (!acc.skins.includes(w.id)) return { error: '未拥有' }; acc.equipped[w.weapon] = w.id; }
    else if (b) { if (!acc.skins.includes(b.id)) return { error: '未拥有' }; acc.equipped.body = b.id; }
    else return { error: '不是可装备的皮肤' };
    this.dirty = true;
    return { ok: true, equipped: acc.equipped };
  }

  // ---------- 结算 ----------
  recordMatch(acc, { mode, kills = 0, deaths = 0, win = false, extracted = 0, score = 0, duel = false }) {
    const ev = EVENTS.map((e) => (eventActive(e) ? e : null)).filter(Boolean);
    let bonusMul = 1;
    for (const e of ev) if (mode === 'extract' && e.bonus?.extract) bonusMul *= e.bonus.extract;

    acc.matches++;
    acc.kills += kills;
    acc.deaths += deaths;
    if (win) acc.wins++; else acc.losses++;
    if (extracted) { acc.extractions++; acc.extractValue += extracted; acc.bestExtract = Math.max(acc.bestExtract || 0, extracted); }

    let points = 0;
    if (duel) {
      points = win ? 32 : -18;
      if (win) acc.duelWins++; else acc.duelLosses++;
      for (const e of ev) if (e.bonus?.duelRank) points *= e.bonus.duelRank;
    } else if (mode === 'battlefield') {
      points = win ? 22 : -12;
    } else if (mode === 'extract') {
      points = extracted > 4000 ? 26 : extracted > 0 ? 12 : -6;
    } else {
      points = win ? 18 : 4;
    }
    acc.points = Math.max(0, acc.points + Math.round(points));

    const earnedBase = Math.round(score * 0.6 + kills * 120 + extracted * bonusMul * 0.5 + (win ? 500 : 100));
    const earned = Math.max(0, earnedBase);
    this.grant(acc, earned, '对局结算 ' + mode);

    // 任务进度
    this.addMissionProgress(acc, 'kills5', kills);
    if (extracted) this.addMissionProgress(acc, 'extract1', 1);
    if (duel && win) this.addMissionProgress(acc, 'duel1', 1);
    if (mode === 'battlefield' && win) this.addMissionProgress(acc, 'win1', 1);
    this.addMissionProgress(acc, 'play3', 1);

    acc.history.unshift({ mode, win, kills, deaths, extracted, earned, points, at: Date.now() });
    if (acc.history.length > 25) acc.history.pop();
    acc.exp += Math.round(earned / 10);
    acc.level = 1 + Math.floor(acc.exp / 500);
    this.dirty = true;
    return { earned, points, rank: rankOf(acc.points), bonusMul };
  }

  // ---------- 排行榜 ----------
  leaderboard(kind = 'points', limit = 50) {
    const list = [...this.accounts.values()].filter((a) => !a.banned);
    const key = {
      points: (a) => a.points,
      kills: (a) => a.kills,
      currency: (a) => a.currency,
      extract: (a) => a.extractValue,
      duel: (a) => a.duelWins * 100 + a.points * 0.1,
    }[kind] || ((a) => a.points);
    return list.sort((a, b) => key(b) - key(a)).slice(0, limit).map((a, i) => ({
      rank: i + 1, id: a.id, name: a.name, value: Math.round(key(a)),
      tier: rankOf(a.points).name, tierColor: rankOf(a.points).color,
      kills: a.kills, matches: a.matches, online: this.isOnline(a.id),
    }));
  }

  stats() {
    const list = [...this.accounts.values()];
    return {
      accounts: list.length,
      online: this.sessions.size,
      parties: this.parties.size,
      currencyTotal: list.reduce((a, b) => a + b.currency, 0),
      matches: list.reduce((a, b) => a + b.matches, 0),
    };
  }
}

export function sanitizeName(n) {
  const s = String(n || '').replace(/[<>\r\n\t]/g, '').trim().slice(0, 14);
  return s || 'OPERATOR';
}

export function publicProfile(acc, store) {
  const r = rankOf(acc.points);
  return {
    id: acc.id, name: acc.name, level: acc.level || 1, points: acc.points,
    tier: r.name, tierColor: r.color, tierProgress: r.progress,
    currency: acc.currency, kills: acc.kills, deaths: acc.deaths, matches: acc.matches,
    wins: acc.wins, losses: acc.losses, extractions: acc.extractions, extractValue: acc.extractValue,
    bestExtract: acc.bestExtract || 0, duelWins: acc.duelWins || 0, duelLosses: acc.duelLosses || 0,
    skins: acc.skins, equipped: acc.equipped, emotes: acc.emotes,
    friends: acc.friends.length,
    checkin: acc.checkin, missions: acc.missions, history: acc.history.slice(0, 10),
    online: store ? store.isOnline(acc.id) : false,
  };
}

export function fullProfile(acc, store) {
  return {
    ...publicProfile(acc, store),
    token: acc.token,
    friendsList: store.friendList(acc),
    incoming: acc.incoming.map((id) => { const a = store.accounts.get(id); return a ? { id: a.id, name: a.name } : null; }).filter(Boolean),
    outgoing: acc.outgoing.map((id) => { const a = store.accounts.get(id); return a ? { id: a.id, name: a.name } : null; }).filter(Boolean),
    party: store.partyOf(acc) ? store.partyView(store.partyOf(acc)) : null,
  };
}
