// server/social.js — 大厅社交层：账号、好友、组队、商店、任务、排行榜、单挑匹配
import { fullProfile, publicProfile, sanitizeName } from './store.js';
import { EVENTS, eventActive, MISSIONS, EMOTES, WEAPON_SKINS, BODY_SKINS, rankOf } from '../shared/skins.js';

export function attachSocial({ store, runtime, enterRoom, leaveRoom, adminLog }) {
  const duelQueue = [];      // {accId, ws, at}
  const partyQueue = [];     // {partyId, at}

  function sendProfile(acc, extra = {}) {
    store.send(acc.id, { t: 'account', profile: fullProfile(acc, store), ...extra });
  }

  function presencePing(acc) {
    for (const f of store.friendList(acc)) {
      if (f.online) store.send(f.id, { t: 'social', k: 'presence', id: acc.id, online: true });
    }
  }

  function handle(ws, m) {
    if (m.t === 'auth') {
      const acc = store.auth({ id: m.id, token: m.token, name: sanitizeName(m.name) });
      if (acc.banned || store.bans.has(ws.ip)) {
        try { ws.send(JSON.stringify({ t: 'banned' })); ws.close(); } catch {}
        return true;
      }
      ws._acc = acc;
      store.addSession(acc, ws);
      ws.send(JSON.stringify({
        t: 'account',
        profile: fullProfile(acc, store),
        announcements: store.announcements.slice(0, 20),
        events: EVENTS.map((e) => ({ ...e, active: eventActive(e) })),
        missions: MISSIONS,
        shop: { weapons: WEAPON_SKINS, bodies: BODY_SKINS, emotes: EMOTES },
        leaderboard: store.leaderboard('points', 20),
        motd: store.config.motd,
        online: store.stats().online,
      }));
      presencePing(acc);
      adminLog?.(`${acc.name} 登录大厅（在线 ${store.stats().online}）`, 'social');
      return true;
    }

    const acc = ws._acc;
    if (!acc) return false;

    switch (m.t) {
      case 'social': {
        const k = m.k;
        if (k === 'friendAdd') {
          const r = store.friendRequest(acc, m.name);
          ws.send(JSON.stringify({ t: 'social', k: 'result', of: k, ...r }));
          sendProfile(acc);
        } else if (k === 'friendAccept') {
          const r = store.friendAccept(acc, m.id);
          ws.send(JSON.stringify({ t: 'social', k: 'result', of: k, ...r }));
          sendProfile(acc);
        } else if (k === 'friendRemove') {
          const r = store.friendRemove(acc, m.id);
          ws.send(JSON.stringify({ t: 'social', k: 'result', of: k, ...r }));
          sendProfile(acc);
        } else if (k === 'friendList') {
          ws.send(JSON.stringify({ t: 'social', k: 'friendList', friends: store.friendList(acc) }));
        } else if (k === 'refresh') {
          sendProfile(acc);
        } else if (k === 'partyCreate') {
          const p = store.createParty(acc);
          store.broadcastParty(p, { t: 'social', k: 'partyUpdate', party: store.partyView(p) });
          sendProfile(acc);
        } else if (k === 'partyInvite') {
          const r = store.partyInvite(acc, m.name);
          ws.send(JSON.stringify({ t: 'social', k: 'result', of: k, ...r }));
        } else if (k === 'partyJoin') {
          const r = store.partyJoin(acc, m.code);
          ws.send(JSON.stringify({ t: 'social', k: 'result', of: k, ...r }));
          sendProfile(acc);
        } else if (k === 'partyLeave') {
          store.partyLeave(acc);
          sendProfile(acc);
        } else if (k === 'partyQueue') {
          const party = store.partyOf(acc);
          if (!party) { ws.send(JSON.stringify({ t: 'social', k: 'result', of: k, error: '还没有队伍' })); break; }
          if (party.leader !== acc.id) { ws.send(JSON.stringify({ t: 'social', k: 'result', of: k, error: '只有队长能开始匹配' })); break; }
          party.mode = m.mode || party.mode;
          store.broadcastParty(party, { t: 'social', k: 'queueing', mode: party.mode });
          adminLog?.(`队伍 ${party.id} 匹配 ${party.mode}`, 'party');
          startPartyMatch(party);
        } else if (k === 'partyChat') {
          const party = store.partyOf(acc);
          if (party) store.broadcastParty(party, { t: 'social', k: 'partyChat', from: acc.name, text: String(m.text || '').slice(0, 90) });
        } else if (k === 'dm') {
          const t = store.find(m.name);
          if (!t) { ws.send(JSON.stringify({ t: 'social', k: 'result', of: k, error: '找不到该玩家' })); break; }
          const text = String(m.text || '').slice(0, 120);
          store.send(t.id, { t: 'social', k: 'dm', from: acc.name, fromId: acc.id, text });
          ws.send(JSON.stringify({ t: 'social', k: 'dmSent', to: t.name, text }));
        } else if (k === 'partyMode') {
          const party = store.partyOf(acc);
          if (party && party.leader === acc.id) { party.mode = m.mode; store.broadcastParty(party, { t: 'social', k: 'partyUpdate', party: store.partyView(party) }); }
        }
        return true;
      }

      case 'shop': {
        const r = m.k === 'buy' ? store.buy(acc, m.id) : m.k === 'equip' ? store.equip(acc, m.id) : { error: '未知操作' };
        ws.send(JSON.stringify({ t: 'social', k: 'result', of: 'shop', ...r }));
        sendProfile(acc);
        return true;
      }

      case 'mission': {
        if (m.k === 'claim') {
          const r = store.claimMission(acc, m.id);
          ws.send(JSON.stringify({ t: 'social', k: 'result', of: 'mission', ...r }));
        } else if (m.k === 'checkin') {
          const r = store.checkin(acc);
          ws.send(JSON.stringify({ t: 'social', k: 'result', of: 'checkin', ...r }));
        }
        sendProfile(acc);
        return true;
      }

      case 'lb': {
        ws.send(JSON.stringify({ t: 'social', k: 'leaderboard', kind: m.kind || 'points', list: store.leaderboard(m.kind || 'points', 50) }));
        return true;
      }

      case 'profile': {
        const t = store.find(m.name) || acc;
        ws.send(JSON.stringify({ t: 'social', k: 'profile', profile: publicProfile(t, store), history: t.history.slice(0, 10) }));
        return true;
      }

      case 'duel': {
        if (m.k === 'queue') {
          if (duelQueue.some((q) => q.accId === acc.id)) break;
          duelQueue.push({ accId: acc.id, ws, at: Date.now() });
          ws.send(JSON.stringify({ t: 'social', k: 'duelQueue', size: duelQueue.length, rank: rankOf(acc.points).name }));
          adminLog?.(`${acc.name} 进入单挑匹配`, 'duel');
          tryDuelMatch();
        } else if (m.k === 'cancel') {
          const i = duelQueue.findIndex((q) => q.accId === acc.id);
          if (i >= 0) duelQueue.splice(i, 1);
          ws.send(JSON.stringify({ t: 'social', k: 'duelCancel' }));
        }
        return true;
      }

      case 'emote': {
        if (ws._room && ws._room.onEmote) ws._room.onEmote(ws._player, m.id);
        const isEmote = EMOTES.find((e) => e.id === m.id);
        if (isEmote && acc.emotes.includes(m.id)) {
          acc.emoteUses = (acc.emoteUses || 0) + 1;
          store.addMissionProgress(acc, 'dance', 1);
        }
        return true;
      }

      case 'leaveRoom': {
        leaveRoom(ws);
        sendProfile(acc);
        return true;
      }

      case 'motd': {
        ws.send(JSON.stringify({ t: 'social', k: 'motd', motd: store.config.motd }));
        return true;
      }
    }
    return false;
  }

  // ---------- 单挑匹配 ----------
  function tryDuelMatch() {
    duelQueue.sort((a, b) => a.at - b.at);
    while (duelQueue.length >= 2) {
      const a = duelQueue.shift();
      const b = duelQueue.shift();
      const room = runtime.newRoom('duel');
      adminLog?.(`单挑房间 ${room.id}：${store.accounts.get(a.accId)?.name} vs ${store.accounts.get(b.accId)?.name}`, 'duel');
      enterRoom(a.ws, 'duel', { room, team: 1 });
      enterRoom(b.ws, 'duel', { room, team: 2 });
    }
  }

  // ---------- 组队开局 ----------
  function startPartyMatch(party) {
    const mode = party.mode || 'battlefield';
    const room = runtime.newRoom(mode);
    room.partyId = party.id;
    let i = 0;
    for (const id of party.members) {
      const s = store.sessions.get(id);
      if (!s) continue;
      const ws = [...s][0];
      enterRoom(ws, mode, { room, team: mode === 'battlefield' ? 1 : 1, index: i++ });
    }
  }

  function tick() {
    // 超时未匹配（30s）提示
    for (const q of duelQueue) {
      if (Date.now() - q.at > 30000 && !q.warned) {
        q.warned = true;
        store.send(q.accId, { t: 'social', k: 'duelWait', text: '暂无对手，继续等待或取消匹配' });
      }
    }
  }
  setInterval(tick, 5000).unref?.();

  return { handle, duelQueue, partyQueue, sendProfile };
}
