// server/room.js — 房间与对局逻辑（服务器权威）
import {
  WORLD, moveActor, raycast, hasLOS, inZone, SPAWNS, RELAYS, CP, EXTRACTS, LOOT_SPOTS, rng,
} from '../shared/world.js';
import {
  MODES, WEAPONS, TEAM, FLAG, PLAYER, MOVE, rollLoot, TICK_HZ, SNAP_HZ,
} from '../shared/protocol.js';

const rand = rng((Date.now() ^ 0x9e3779b9) >>> 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const now = () => Date.now();

let nextPid = 1;
const BOT_NAMES = ['GULL-1', 'GULL-2', 'GULL-3', 'HOUND-1', 'HOUND-2', 'HOUND-3', 'CROW', 'TERN', 'KITE', 'RAVEN', 'MAGPIE', 'EGRET'];

export class Room {
  constructor(id, modeId, hooks = {}) {
    this.id = id;
    this.hooks = hooks;
    this.mode = MODES[modeId] || MODES.extract;
    this.duel = { round: 1, wins: { 1: 0, 2: 0 }, roundEndsAt: 0, lastWinner: 0 };
    this.players = new Map();
    this.bullets = [];
    this.createdAt = now();
    this.tickN = 0;
    this.roundTime = this.mode.id === 'battlefield' ? 900 : 600;
    this.timeLeft = this.roundTime;
    this.state = 'live';
    const tk = this.mode.id === 'battlefield' ? (this.mode.tickets || 200) : 0;
    this.tickets = { [TEAM.alpha]: tk, [TEAM.bravo]: tk };
    this.relays = RELAYS.map((r) => ({ ...r, hp: 100, down: false }));
    this.cp = CP.map((c) => ({ ...c, owner: 0, progress: 0, contest: false }));
    this.crates = LOOT_SPOTS.map((s) => ({ id: s.id, x: s.x, z: s.z, open: false, loot: null }));
    this.events = [];
    this.airdrops = [];
    this.nextAirdrop = 180;
    this.log = [];
  }

  // ---------- 玩家 ----------
  addPlayer({ name, team, bot = false, ws = null, acc = null, skin = 0, weaponSkin = null }) {
    const id = nextPid++;
    const spawn = this.pickSpawn(team);
    const p = {
      id, name: String(name || 'OPERATOR').slice(0, 16), bot, ws, team: bot ? TEAM.hostile : team,
      accId: acc ? acc.id : null, skin: Number(skin) || 0, weaponSkin: weaponSkin || null, emote: null, emoteEnd: 0,
      x: spawn[0], y: spawn[1], z: spawn[2], vy: 0, yaw: rand() * Math.PI * 2, pitch: 0,
      hp: PLAYER.maxHp, alive: true, respawnAt: 0, crouch: false, sprint: false,
      weapon: bot && rand() < 0.3 ? 'sg12' : 'kr7', ammo: WEAPONS.kr7.mag, reserve: WEAPONS.kr7.reserve,
      reloadUntil: 0, lastFire: 0, kills: 0, deaths: 0, score: 0, ping: 0,
      loot: [], lootValue: 0, carrier: 0, extractT: 0, lastInput: 0, lastSeen: now(),
      aiTarget: null, aiNextThink: 0, aiBurst: 0, aiAim: 0, aiGoal: null, spawnAt: now(),
    };
    if (this.mode.id === 'battlefield') p.team = team;
    if (bot) {
      // 机器人散开出生，避免和玩家叠在一起
      p.x = rand.range(-40, 60); p.z = rand.range(-42, 42);
      p.aiNextThink = now() + 900 + rand() * 1500;
      p.aiAim = now() + 600 + rand() * 900;
    }
    p.invulnUntil = now() + 2500;
    this.players.set(id, p);
    return p;
  }

  pickSpawn(team) {
    if (this.mode.id === 'duel') return SPAWNS.duel[team === TEAM.bravo ? 1 : 0];
    if (this.mode.id === 'battlefield') {
      const list = team === TEAM.bravo ? SPAWNS.bravo : SPAWNS.alpha;
      return list[Math.floor(rand() * list.length)];
    }
    const list = SPAWNS.free;
    return list[Math.floor(rand() * list.length)];
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  humanCount() {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.bot) continue;
      if (p.ws && p.ws.readyState !== 1) continue;   // 已经断开的连接不算人
      n++;
    }
    return n;
  }
  totalCount() { return this.players.size; }

  fillBots() {
    if (this.mode.id === 'duel') return;
    const humans = this.humanCount();
    const desired = Math.min(this.mode.bots, this.mode.players - humans);
    let bots = 0;
    for (const p of this.players.values()) if (p.bot) bots++;
    for (let i = bots; i < desired; i++) {
      const team = this.mode.id === 'battlefield'
        ? (this.countTeam(TEAM.alpha) <= this.countTeam(TEAM.bravo) ? TEAM.alpha : TEAM.bravo)
        : TEAM.hostile;
      const nm = BOT_NAMES[(i + Math.floor(rand() * 12)) % BOT_NAMES.length];
      this.addPlayer({ name: nm, team, bot: true });
    }
  }

  countTeam(t) { let n = 0; for (const p of this.players.values()) if (p.team === t) n++; return n; }
  aliveTeam(t) { let n = 0; for (const p of this.players.values()) if (p.team === t && p.alive) n++; return n; }

  // ---------- 输入 ----------
  onInput(p, m) {
    if (!p || p.bot) return;
    p.lastInput = now();
    if (!p.alive) return;
    p.yaw = Number.isFinite(m.yaw) ? m.yaw : p.yaw;
    p.pitch = clamp(Number.isFinite(m.pitch) ? m.pitch : p.pitch, -1.5, 1.5);
    p.moveX = clamp(+m.mx || 0, -1, 1);
    p.moveZ = clamp(+m.mz || 0, -1, 1);
    p.crouch = !!m.cr;
    p.sprint = !!m.sp;
    if (m.rl) this.startReload(p);
    if (m.jp) this.jump(p);
  }

  onFire(p, m) {
    if (!p || !p.alive) return;
    const t = now();
    const w = WEAPONS[p.weapon];
    if (t - p.lastFire < 60000 / w.rpm) return;
    if (t < p.reloadUntil) return;
    if (p.ammo <= 0) { this.startReload(p); return; }
    p.lastFire = t;
    p.ammo--;
    p.lastFireServer = t;

    if (Number.isFinite(m.yaw)) p.yaw = m.yaw;
    if (Number.isFinite(m.pitch)) p.pitch = clamp(m.pitch, -1.5, 1.5);
    const ox = p.x, oy = p.y + (p.crouch ? PLAYER.crouchEye : PLAYER.eye), oz = p.z;
    const cp = Math.cos(p.pitch);
    let dx = Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = Math.cos(p.yaw) * cp;
    const spread = (p.sprint ? 0.03 : w.spread) + (p.moving ? 0.012 : 0);
    for (let pel = 0; pel < (w.pellets || 1); pel++) {
      const sx = dx + (rand() - 0.5) * spread * 2;
      const sy = dy + (rand() - 0.5) * spread * 2;
      const sz = dz + (rand() - 0.5) * spread * 2;
      const len = Math.hypot(sx, sy, sz) || 1;
      const hit = this.traceShot(p, ox, oy, oz, sx / len, sy / len, sz / len, w);
      if (hit) {
        this.pushEvent({ k: 'hit', x: hit.x, y: hit.y, z: hit.z, by: p.id, dmg: hit.dmg, head: hit.head });
        if (hit.target) this.damage(p, hit.target, hit.dmg, w, hit.head);
        else if (hit.relay) this.damageRelay(p, hit.relay, hit.dmg);
      }
      this.bullets.push({ x: ox, y: oy, z: oz, tx: hit ? hit.x : ox + sx * 60, ty: hit ? hit.y : oy + sy * 60, tz: hit ? hit.z : oz + sz * 60, by: p.id, t });
    }
    if (this.bullets.length > 400) this.bullets.splice(0, this.bullets.length - 400);
    if (p.ammo === 0) this.startReload(p);
  }

  traceShot(shooter, ox, oy, oz, dx, dy, dz, w) {
    const geo = raycast(ox, oy, oz, dx, dy, dz, w.range);
    const maxD = geo ? geo.dist : w.range;
    let best = null, bestT = maxD;
    for (const t of this.players.values()) {
      if (t === shooter || !t.alive) continue;
      if (t.team === shooter.team) continue;
      // 身体圆柱
      const bodyY = t.y + (t.crouch ? 0.55 : 1.0);
      const headY = t.y + (t.crouch ? 0.95 : 1.62);
      const d1 = raySphere(ox, oy, oz, dx, dy, dz, t.x, bodyY, t.z, 0.45);
      const d2 = raySphere(ox, oy, oz, dx, dy, dz, t.x, headY, t.z, 0.2);
      let d = Infinity, head = false;
      if (d1 !== null) d = d1;
      if (d2 !== null && d2 < d) { d = d2; head = true; }
      if (d !== null && d < bestT) {
        bestT = d;
        best = { target: t, head, dmg: Math.round(w.dmg * (head ? w.head : 1)), dist: d };
      }
    }
    if (this.mode.id === 'relay') {
      for (const r of this.relays) {
        if (r.down) continue;
        const d = raySphere(ox, oy, oz, dx, dy, dz, r.x, r.y, r.z, r.radius);
        if (d !== null && d < bestT) { bestT = d; best = { relay: r, dmg: Math.round(w.dmg * 1.5) }; }
      }
    }
    if (!best) {
      if (!geo) return null;
      return { x: geo.x, y: geo.y, z: geo.z };
    }
    const d = best.dist !== undefined ? best.dist : bestT;
    return { x: ox + dx * d, y: oy + dy * d, z: oz + dz * d, dmg: best.dmg, head: !!best.head, target: best.target, relay: best.relay };
  }

  startReload(p) {
    const w = WEAPONS[p.weapon];
    if (p.ammo >= w.mag || p.reserve <= 0) return;
    if (now() < p.reloadUntil) return;
    p.reloadUntil = now() + w.reload * 1000;
    p.reloadFrom = p.ammo;
  }

  finishReload(p) {
    const w = WEAPONS[p.weapon];
    const need = w.mag - p.ammo;
    const take = Math.min(need, p.reserve);
    p.ammo += take;
    p.reserve -= take;
    p.reloadUntil = 0;
  }

  jump(p) {
    if (p.y > 0.05) return;
    p.vy = MOVE.jump;
  }

  damage(attacker, target, dmg, w, head) {
    if (!target.alive) return;
    if (target.invulnUntil && now() < target.invulnUntil) return;
    target.hp -= dmg;
    target.lastHitBy = attacker.id;
    target.lastHitAt = now();
    if (target.hp <= 0) this.kill(attacker, target, head);
  }

  damageRelay(p, relay, dmg) {
    relay.hp -= dmg;
    if (relay.hp <= 0) {
      relay.down = true;
      relay.hp = 0;
      p.score += 500;
      this.pushEvent({ k: 'relay', id: relay.id, by: p.id });
      this.broadcast({ t: 'event', k: 'relay', id: relay.id, by: p.id });
      const left = this.relays.filter((r) => !r.down).length;
      if (left === 0) this.endRound('relays', TEAM.alpha);
    }
  }

  kill(attacker, target, head) {
    target.alive = false;
    target.hp = 0;
    target.deaths++;
    target.deadAt = now();
    target.respawnAt = now() + this.mode.respawn * 1000;
    attacker.kills++;
    attacker.score += 100 + (head ? 50 : 0);
    if (this.mode.id === 'battlefield') {
      const other = target.team === TEAM.alpha ? TEAM.bravo : TEAM.alpha;
      if (this.tickets[other] !== undefined) this.tickets[other] = Math.max(0, this.tickets[other] - 1);
    }
    this.pushEvent({ k: 'kill', by: attacker.id, byName: attacker.name, id: target.id, name: target.name, head });
    try { this.hooks.onKill && this.hooks.onKill(attacker, target, this); } catch (e) { /* 结算失败不影响对局 */ }
    if (this.mode.id === 'extract') {
      target.loot = [];
      target.lootValue = 0;
      target.carrier = 0;
    }
    if (this.mode.id === 'battlefield') {
      for (const t of [TEAM.alpha, TEAM.bravo]) {
        if (this.tickets[t] <= 0) this.endRound('tickets', t === TEAM.alpha ? TEAM.bravo : TEAM.alpha);
      }
    }
  }

  // ---------- 交互 ----------
  onInteract(p) {
    if (!p || !p.alive) return;
    if (this.mode.id === 'extract') {
      let best = null, bd = 2.6;
      for (const c of this.crates) {
        if (c.open) continue;
        const d = Math.hypot(c.x - p.x, c.z - p.z);
        if (d < bd) { bd = d; best = c; }
      }
      if (best) {
        best.open = true;
        best.loot = rollLoot(rand);
        p.loot.push(best.loot);
        p.lootValue += best.loot.value;
        this.pushEvent({ k: 'loot', id: p.id, item: best.loot.name, value: best.loot.value, value2: p.lootValue });
        this.sendTo(p, { t: 'event', k: 'looted', item: best.loot, total: p.lootValue });
      }
    }
  }

  onDrop(p) {
    if (!p || !p.alive || !p.loot.length) return;
    const v = p.lootValue;
    p.loot = [];
    p.lootValue = 0;
    this.pushEvent({ k: 'drop', id: p.id, value: v });
  }

  useItem(p, kind) {
    if (!p.alive) return;
    if (kind === 'heal' && p.hp < PLAYER.maxHp) { p.hp = Math.min(PLAYER.maxHp, p.hp + 45); }
  }

  onEmote(p, id) {
    if (!p) return;
    const ok = ['wave', 'dance_spin', 'dance_robot', 'dance_reload', 'dance_moon', 'sit', 'taunt'];
    if (!ok.includes(id)) return;
    p.emote = id;
    p.emoteEnd = now() + 4000;
    this.broadcast({ t: 'event', k: 'emote', pid: p.id, id });
  }

  pushEvent(e) {
    e.ts = now();
    this.events.push(e);
    if (this.events.length > 120) this.events.shift();
    for (const p of this.players.values()) if (!p.bot && p.ws) this.rawSend(p.ws, { t: 'event', ...e });
  }

  sendTo(p, msg) { if (p && !p.bot && p.ws) this.rawSend(p.ws, msg); }
  broadcast(msg, exceptId = 0) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.bot || !p.ws || p.id === exceptId) continue;
      if (p.ws.readyState === 1) p.ws.send(s);
    }
  }
  rawSend(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  // ---------- 主循环 ----------
  step(dt) {
    this.tickN++;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.state === 'live' && this.timeLeft <= 0) this.endRound('time', 0);

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.mode.respawn > 0 && now() >= p.respawnAt) this.respawn(p);
        continue;
      }
      if (p.bot) this.botThink(p, dt);
      else this.applyMove(p, dt);

      if (p.reloadUntil && now() >= p.reloadUntil) this.finishReload(p);
      // 撤离
      if (this.mode.id === 'extract') {
        const zone = EXTRACTS.find((e) => inZone(p.x, p.z, e));
        if (zone && p.loot.length) {
          p.extractT += dt;
          if (p.extractT >= 5) this.extract(p, zone);
        } else p.extractT = Math.max(0, p.extractT - dt * 2);
      }
      if (this.mode.id === 'relay' && p.team !== TEAM.hostile) {
        for (const r of this.relays) {
          if (!r.down && inZone(p.x, p.z, { x: r.x, z: r.z, r: 2.2 })) {
            r.hp -= 34 * dt;
            if (r.hp <= 0) this.damageRelay(p, r, 1);
          }
        }
      }
    }

    if (this.mode.id === 'duel') this.stepDuel(dt);
    if (this.mode.id === 'battlefield') this.stepBattlefield(dt);
    if (this.mode.id === 'battlefield') this.stepAirdrops(dt);

    // 掉线超时：连接已断的立刻标记，长时间没消息的踢掉
    for (const p of this.players.values()) {
      if (p.bot) continue;
      if (p.ws && p.ws.readyState !== 1) { p.lastSeen = Math.min(p.lastSeen, now() - 30000); continue; }
      if (now() - (p.lastSeen || 0) > 30000) { this.pushEvent({ k: 'timeout', name: p.name }); try { p.ws && p.ws.close(); } catch {} }
    }

    if (this.tickN % Math.round(TICK_HZ / SNAP_HZ) === 0) this.snapshot();
  }

  applyMove(p, dt) {
    const w = WEAPONS[p.weapon];
    let sp = p.sprint && !p.crouch ? MOVE.sprint : p.crouch ? MOVE.crouch : MOVE.walk;
    if (p.ammo !== undefined && p.adsHeld) sp = MOVE.ads;
    const mx = p.moveX || 0, mz = p.moveZ || 0;
    const len = Math.hypot(mx, mz);
    p.moving = len > 0.05;
    if (p.moving) {
      const nx = mx / Math.max(1, len), nz = mz / Math.max(1, len);
      const cos = Math.cos(p.yaw), sin = Math.sin(p.yaw);
      // 输入：mz 前后（+ 为前），mx 左右
      const dx = (nz * sin + mx * cos) * sp * dt;
      const dz = (nz * cos - mx * sin) * sp * dt;
      moveActor(p, dx, dz, PLAYER.radius, PLAYER.height);
    }
    p.vy -= MOVE.gravity * dt;
    p.y += p.vy * dt;
    if (p.y <= 0) { p.y = 0; p.vy = 0; }
    if (p.bot && p.y > 0) p.y = 0;
  }

  respawn(p) {
    const spawn = this.pickSpawn(p.team);
    p.x = spawn[0]; p.y = 0; p.z = spawn[2];
    p.hp = PLAYER.maxHp; p.alive = true; p.vy = 0;
    p.ammo = WEAPONS[p.weapon].mag;
    p.reserve = WEAPONS[p.weapon].reserve;
    p.reloadUntil = 0;
    p.extractT = 0;
    p.spawnAt = now();
    p.invulnUntil = now() + 2000;
    this.sendTo(p, { t: 'event', k: 'respawned' });
  }

  extract(p, zone) {
    const v = p.lootValue;
    p.score += v;
    p.extracted = (p.extracted || 0) + v;
    p.loot = [];
    p.lootValue = 0;
    p.extractT = 0;
    p.alive = false;
    p.deadAt = now();
    p.respawnAt = now() + 6e9;
    this.pushEvent({ k: 'extract', id: p.id, name: p.name, value: v, zone: zone.name });
    try { this.hooks.onExtract && this.hooks.onExtract(p, v, this); } catch (e) {}
    this.sendTo(p, { t: 'event', k: 'extracted', value: v, zone: zone.name });
  }

  stepDuel(dt) {
    const aliveA = this.aliveTeam(TEAM.alpha);
    const aliveB = this.aliveTeam(TEAM.bravo);
    if (this.duel.roundEndsAt) {
      if (now() >= this.duel.roundEndsAt) {
        this.duel.roundEndsAt = 0;
        this.duel.round++;
        for (const p of this.players.values()) { p.hp = PLAYER.maxHp; this.respawn(p); }
        this.pushEvent({ k: 'duelRound', round: this.duel.round, wins: this.duel.wins });
      }
      return;
    }
    if (this.humanCount() < 2) return;
    if (aliveA === 0 && aliveB > 0) this.duelRoundEnd(TEAM.bravo);
    else if (aliveB === 0 && aliveA > 0) this.duelRoundEnd(TEAM.alpha);
  }

  duelRoundEnd(winner) {
    const key = winner === TEAM.bravo ? TEAM.bravo : TEAM.alpha;
    this.duel.wins[key]++;
    this.duel.lastWinner = winner;
    this.duel.roundEndsAt = now() + 4000;
    this.pushEvent({ k: 'duelRoundEnd', winner, wins: this.duel.wins, round: this.duel.round });
    if (this.duel.wins[key] >= (this.mode.roundWins || 3)) {
      this.endRound('duel', winner);
    }
  }

  stepBattlefield(dt) {
    let alphaHeld = 0, bravoHeld = 0;
    for (const c of this.cp) {
      const a = [], b = [];
      for (const p of this.players.values()) {
        if (!p.alive || !inZone(p.x, p.z, c)) continue;
        if (p.team === TEAM.alpha) a.push(p);
        else if (p.team === TEAM.bravo) b.push(p);
      }
      c.contest = a.length > 0 && b.length > 0;
      if (a.length && !b.length) c.progress = clamp(c.progress + dt * (a.length > 2 ? 12 : 8), -100, 100);
      else if (b.length && !a.length) c.progress = clamp(c.progress - dt * (b.length > 2 ? 12 : 8), -100, 100);
      if (c.progress >= 100 && c.owner !== TEAM.alpha) {
        c.owner = TEAM.alpha;
        this.pushEvent({ k: 'cap', id: c.id, team: TEAM.alpha });
      } else if (c.progress <= -100 && c.owner !== TEAM.bravo) {
        c.owner = TEAM.bravo;
        this.pushEvent({ k: 'cap', id: c.id, team: TEAM.bravo });
      }
      if (c.owner === TEAM.alpha) alphaHeld++;
      if (c.owner === TEAM.bravo) bravoHeld++;
    }
    if (alphaHeld > bravoHeld) this.tickets[TEAM.bravo] = Math.max(0, this.tickets[TEAM.bravo] - dt * (1 + alphaHeld * 0.6));
    if (bravoHeld > alphaHeld) this.tickets[TEAM.alpha] = Math.max(0, this.tickets[TEAM.alpha] - dt * (1 + bravoHeld * 0.6));
    for (const t of [TEAM.alpha, TEAM.bravo]) {
      if (this.tickets[t] <= 0) this.endRound('tickets', t === TEAM.alpha ? TEAM.bravo : TEAM.alpha);
    }
  }

  stepAirdrops(dt) {
    this.nextAirdrop -= dt;
    if (this.nextAirdrop <= 0) {
      this.nextAirdrop = 200;
      const a = { id: 'A' + this.airdrops.length, x: rand() * 100 - 40, z: rand() * 80 - 40, t: now() };
      this.airdrops.push(a);
      this.pushEvent({ k: 'airdrop', x: a.x, z: a.z });
    }
  }

  endRound(reason, winner) {
    if (this.state !== 'live') return;
    this.state = 'ended';
    this.winner = winner;
    this.endReason = reason;
    this.endedAt = now();
    const board = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, score: Math.round(p.score), team: p.team, bot: p.bot }))
      .sort((a, b) => b.score - a.score).slice(0, 12);
    this.broadcast({ t: 'event', k: 'roundEnd', reason, winner, board });
    try { this.hooks.onRoundEnd && this.hooks.onRoundEnd(this, reason, winner); } catch (e) { console.error('[settle]', e.message); }
  }

  reset() {
    this.state = 'live';
    this.duel = { round: 1, wins: { 1: 0, 2: 0 }, roundEndsAt: 0, lastWinner: 0 };
    this.timeLeft = this.roundTime;
    this.tickN = 0;
    const tk = this.mode.id === 'battlefield' ? (this.mode.tickets || 200) : 0;
    this.tickets = { [TEAM.alpha]: tk, [TEAM.bravo]: tk };
    this.relays = RELAYS.map((r) => ({ ...r, hp: 100, down: false }));
    this.cp = CP.map((c) => ({ ...c, owner: 0, progress: 0, contest: false }));
    this.crates = LOOT_SPOTS.map((s) => ({ id: s.id, x: s.x, z: s.z, open: false, loot: null }));
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.score = 0; p.loot = []; p.lootValue = 0; p.extracted = 0;
      this.respawn(p);
    }
  }

  // ---------- AI ----------
  botThink(p, dt) {
    const t = now();
    p.aiAim = (p.aiAim || 0) - dt;
    // 选目标
    if (t > (p.aiNextThink || 0)) {
      p.aiNextThink = t + 400 + rand() * 500;
      let best = null, bd = 1e9;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        const friendly = this.mode.id === 'battlefield' ? o.team === p.team : o.team === TEAM.hostile;
        if (friendly) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (d > 70 || d >= bd) continue;
        if (!hasLOS(p.x, p.y + 1.5, p.z, o.x, o.y + 1.2, o.z)) continue;
        bd = d; best = o;
      }
      p.aiTarget = best;
      if (!best) {
        // 巡逻目标
        if (!p.aiGoal || Math.hypot(p.aiGoal.x - p.x, p.aiGoal.z - p.z) < 3) {
          const list = this.mode.id === 'battlefield'
            ? CP.slice() : EXTRACTS.concat(LOOT_SPOTS);
          const g = list[Math.floor(rand() * list.length)];
          p.aiGoal = { x: g.x + (rand() - 0.5) * 6, z: g.z + (rand() - 0.5) * 6 };
        }
      }
    }
    const tgt = p.aiTarget && p.aiTarget.alive ? p.aiTarget : null;
    let goalX, goalZ;
    if (tgt) { goalX = tgt.x; goalZ = tgt.z; } else {
      goalX = p.aiGoal ? p.aiGoal.x : 0;
      goalZ = p.aiGoal ? p.aiGoal.z : 0;
    }
    const dx = goalX - p.x, dz = goalZ - p.z;
    const dist = Math.hypot(dx, dz) || 1;
    const desiredYaw = Math.atan2(dx, dz);
    let dy = desiredYaw - p.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    p.yaw += clamp(dy, -5 * dt, 5 * dt);

    const stopDist = tgt ? 12 : 1.5;
    if (dist > stopDist) {
      p.moveX = 0; p.moveZ = 1; p.sprint = !tgt && dist > 10;
    } else { p.moveZ = 0; p.moveX = dist < stopDist - 2 ? -0.6 : 0; }
    this.applyMove(p, dt);

    if (tgt) {
      // 瞄准（含误差）
      const eye = p.y + PLAYER.eye;
      const ax = tgt.x - p.x, ay = (tgt.y + 1.1) - eye, az = tgt.z - p.z;
      p.pitch = Math.atan2(ay, Math.hypot(ax, az));
      // AI 有反应时间与瞄偏，不是激光枪
      p.yaw = Math.atan2(ax, az) + (rand() - 0.5) * 0.05;
      if (t > p.aiAim) {
        p.aiAim = t + 0.45 + rand() * 0.55;
        if (dist < WEAPONS[p.weapon].range * 0.75 && hasLOS(p.x, eye, p.z, tgt.x, tgt.y + 1.2, tgt.z)) {
          p.pitch = Math.atan2(ay, Math.hypot(ax, az)) + (rand() - 0.5) * 0.03;
          this.onFire(p, {});
          if (p.ammo <= 0) this.startReload(p);
        }
      }
    }
  }

  // ---------- 快照 ----------
  snapshot() {
    const ps = [];
    for (const p of this.players.values()) {
      let f = 0;
      if (p.alive) f |= FLAG.alive;
      if (p.crouch) f |= FLAG.crouch;
      if (p.sprint && p.moving) f |= FLAG.sprint;
      if (p.bot) f |= FLAG.bot;
      ps.push([
        p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +p.yaw.toFixed(3), +p.pitch.toFixed(3), f,
        Math.max(0, Math.round(p.hp)), p.team, Math.round(p.score), p.ammo, p.skin || 0,
      ]);
    }
    const msg = {
      t: 'snap', k: this.tickN, ps,
      rl: this.relays.map((r) => [r.id, Math.max(0, Math.round(r.hp)), r.down ? 1 : 0]),
      cp: this.cp.map((c) => [c.id, c.owner, Math.round(c.progress), c.contest ? 1 : 0]),
      tk: this.tickets,
      tl: Math.round(this.timeLeft),
      st: this.state,
      bl: this.bullets.length ? this.bullets.map((b) => [b.x, b.y, b.z, b.tx, b.ty, b.tz, b.by]) : undefined,
      cr: this.mode.id === 'extract' ? this.crates.map((c) => [c.id, c.open ? 1 : 0, +c.x.toFixed(1), +c.z.toFixed(1)]) : undefined,
    };
    this.bullets.length = 0;
    this.broadcast(msg);
  }
}

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return null;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return null;
  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  return t0 > 0.1 ? t0 : tca + thc;
}
