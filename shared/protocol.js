// shared/protocol.js — 协议常量与通用规则（客户端与服务器共用）

export const TICK_HZ = 20;
export const SNAP_HZ = 15;
export const PROTOCOL_VERSION = 3;

export const MODES = {
  relay: {
    id: 'relay', name: '中继破坏', en: 'RELAY RUN',
    desc: '雨夜偷港。切断三座上行中继，无人机与机器狗会来找你。',
    players: 8, respawn: 6, bots: 7,
  },
  extract: {
    id: 'extract', name: '搜打撤', en: 'EXTRACTION',
    desc: '搜箱、拿战利品、活着撤离。死了就丢掉身上全部东西。',
    players: 10, respawn: 8, bots: 5,
  },
  duel: {
    id: 'duel', name: '单挑', en: 'DUEL 1V1',
    desc: '一对一，先赢 3 回合。段位分按胜负结算，胜者拿走全场。',
    players: 2, respawn: 0, bots: 0, roundWins: 3, tickets: 0,
  },
  battlefield: {
    id: 'battlefield', name: '大战场', en: 'BATTLEFIELD',
    desc: '两队 8v8 抢三个点，票数先耗尽的一方输。可无限复活。',
    players: 16, respawn: 5, bots: 12, tickets: 200,
  },
};

export const WEAPONS = {
  kr7: { id: 'kr7', name: 'KR-7', auto: true, rpm: 620, dmg: 26, head: 2.4, mag: 30, reserve: 150, range: 120, spread: 0.012, adsSpread: 0.004, recoil: 0.9, reload: 2.1, pellets: 1 },
  sg12: { id: 'sg12', name: 'SG-12', auto: false, rpm: 90, dmg: 13, head: 1.8, mag: 6, reserve: 36, range: 34, spread: 0.055, adsSpread: 0.042, recoil: 2.6, reload: 2.8, pellets: 8 },
  dmr: { id: 'dmr', name: 'MK-9', auto: false, rpm: 180, dmg: 48, head: 2.2, mag: 12, reserve: 60, range: 200, spread: 0.006, adsSpread: 0.0015, recoil: 1.8, reload: 2.4, pellets: 1 },
};

export const LOOT_TABLE = [
  { id: 'cash', name: '现金卷', value: 900, weight: 26, kind: 'value' },
  { id: 'chip', name: '主板芯片', value: 2400, weight: 14, kind: 'value' },
  { id: 'core', name: '中继核心', value: 5200, weight: 6, kind: 'value' },
  { id: 'ammo', name: '弹匣', value: 300, weight: 22, kind: 'ammo' },
  { id: 'plate', name: '护甲板', value: 1400, weight: 18, kind: 'armor' },
  { id: 'medkit', name: '急救包', value: 1100, weight: 14, kind: 'heal' },
];

export function rollLoot(rand) {
  const total = LOOT_TABLE.reduce((a, b) => a + b.weight, 0);
  let r = rand() * total;
  for (const item of LOOT_TABLE) { r -= item.weight; if (r <= 0) return { ...item }; }
  return { ...LOOT_TABLE[0] };
}

export const TEAM = { none: 0, alpha: 1, bravo: 2, hostile: 3 };

export const MOVE = { walk: 4.4, sprint: 6.9, crouch: 2.2, ads: 2.4, jump: 4.6, gravity: 18 };
export const PLAYER = { radius: 0.34, height: 1.8, eye: 1.62, crouchEye: 1.06, maxHp: 100 };

// 旗帜位
export const FLAG = { alive: 1, crouch: 2, sprint: 4, ads: 8, reload: 16, dead: 32, firing: 64, bot: 128 };

export const EQUIP_SLOT = ['kr7', 'sg12', 'dmr', 'body'];

export const MSG = {
  hello: 'hello', welcome: 'welcome', join: 'join', state: 'state',
  input: 'input', snap: 'snap', event: 'event', chat: 'chat',
  ping: 'ping', pong: 'pong', resync: 'resync', leave: 'leave',
};
