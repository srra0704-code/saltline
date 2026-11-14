// shared/skins.js — 皮肤 / 表情舞蹈 / 段位 / 任务 目录（客户端与服务器共用）

export const WEAPON_SKINS = [
  { id: 'kr7_stock', name: '制式 · 军绿', weapon: 'kr7', price: 0, color: 0x3f4a3a, accent: 0x8d9aa3, rarity: 'common' },
  { id: 'kr7_rust', name: '锈线 · 港红', weapon: 'kr7', price: 800, color: 0x8c3b2a, accent: 0xffb347, rarity: 'common' },
  { id: 'kr7_night', name: '夜潮 · 靛蓝', weapon: 'kr7', price: 1600, color: 0x22334a, accent: 0x5aa9ff, rarity: 'rare' },
  { id: 'kr7_signal', name: '信号 · 琥珀', weapon: 'kr7', price: 3200, color: 0x2a2f33, accent: 0xffb347, rarity: 'epic', glow: true },
  { id: 'sg12_stock', name: '制式 · 灰钢', weapon: 'sg12', price: 0, color: 0x4a5158, accent: 0x8d9aa3, rarity: 'common' },
  { id: 'sg12_rust', name: '断链 · 焦铁', weapon: 'sg12', price: 1200, color: 0x6b3a22, accent: 0xd2622a, rarity: 'rare' },
  { id: 'dmr_stock', name: '制式 · 沙褐', weapon: 'dmr', price: 0, color: 0x5a5246, accent: 0x8d9aa3, rarity: 'common' },
  { id: 'dmr_ghost', name: '幽灵 · 霜白', weapon: 'dmr', price: 2600, color: 0xbfc6cc, accent: 0x5aa9ff, rarity: 'epic', glow: true },
];

export const BODY_SKINS = [
  { id: 'op_stock', name: '作业员 · 灰', price: 0, body: 0x8d9aa3, gear: 0x22262a, rarity: 'common' },
  { id: 'op_amber', name: '港务 · 琥珀', price: 1000, body: 0xd2622a, gear: 0x2a1f16, rarity: 'common' },
  { id: 'op_blue', name: '夜潮 · 蓝', price: 1800, body: 0x3f7fd6, gear: 0x14202e, rarity: 'rare' },
  { id: 'op_bone', name: '骨白 · 幽灵', price: 3000, body: 0xe8e4da, gear: 0x2a2f33, rarity: 'epic', glow: true },
  { id: 'op_acid', name: '酸雨 · 荧绿', price: 4200, body: 0x7ddc8a, gear: 0x1a2a1c, rarity: 'legend', glow: true },
];

// 舞蹈 / 表情（服务器只转发 id，动画在客户端程序化播放）
export const EMOTES = [
  { id: 'wave', name: '挥手', price: 0, dur: 2.0 },
  { id: 'dance_spin', name: '转圈舞', price: 600, dur: 3.4 },
  { id: 'dance_robot', name: '机械舞', price: 1200, dur: 3.6 },
  { id: 'dance_reload', name: '战术抖枪舞', price: 1800, dur: 3.2 },
  { id: 'dance_moon', name: '月光步', price: 2600, dur: 4.0 },
  { id: 'sit', name: '坐下休息', price: 400, dur: 5.0 },
  { id: 'taunt', name: '挑衅', price: 900, dur: 2.2 },
];

export const RANKS = [
  { id: 'recruit', name: '新兵', min: 0, color: '#8d9aa3' },
  { id: 'bronze', name: '青铜', min: 600, color: '#b08050' },
  { id: 'silver', name: '白银', min: 1200, color: '#c9d1d6' },
  { id: 'gold', name: '黄金', min: 1800, color: '#ffb347' },
  { id: 'plat', name: '铂金', min: 2400, color: '#7fd8e8' },
  { id: 'diamond', name: '钻石', min: 3000, color: '#5aa9ff' },
  { id: 'master', name: '大师', min: 3800, color: '#c07fff' },
  { id: 'king', name: '港口之王', min: 4600, color: '#ff5a40' },
];

export function rankOf(points = 0) {
  let r = RANKS[0];
  for (const t of RANKS) if (points >= t.min) r = t;
  const idx = RANKS.indexOf(r);
  const next = RANKS[idx + 1] || null;
  const span = next ? next.min - r.min : 1;
  const into = next ? (points - r.min) / span : 1;
  return { ...r, index: idx, next, progress: Math.max(0, Math.min(1, into)) };
}

// 每日任务
export const MISSIONS = [
  { id: 'kills5', name: '港口清道夫', desc: '击杀 5 个敌人', target: 5, reward: 400 },
  { id: 'extract1', name: '带货离场', desc: '成功撤离 1 次', target: 1, reward: 600 },
  { id: 'win1', name: '战场赢家', desc: '赢得 1 场大战场', target: 1, reward: 700 },
  { id: 'duel1', name: '单挑不服', desc: '赢得 1 场单挑', target: 1, reward: 800 },
  { id: 'play3', name: '三局不下线', desc: '完成 3 局任意对局', target: 3, reward: 300 },
];

// 活动（活动页）
export const EVENTS = [
  {
    id: 'rainy_night', name: '雨夜行动', tag: '限时', desc: '活动期间撤离价值 +50%，港口掉落中继核心概率翻倍。',
    from: '2026-11-10T00:00:00Z', to: '2026-12-10T00:00:00Z', bonus: { extract: 1.5, lootRare: 2 },
  },
  {
    id: 'duel_cup', name: '深夜单挑杯', tag: '竞技', desc: '单挑胜利段位分双倍，前十名额外奖励 5000 港币。',
    from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z', bonus: { duelRank: 2 },
  },
  {
    id: 'dance_floor', name: '集装箱舞池', tag: '休闲', desc: '使用任意舞蹈表情参与，累计 10 次解锁「月光步」。',
    from: '2026-11-12T00:00:00Z', to: '2026-11-30T00:00:00Z', bonus: { emoteUnlock: 1 },
  },
];

export function eventActive(ev, now = Date.now()) {
  return now >= Date.parse(ev.from) && now <= Date.parse(ev.to);
}

export const CURRENCY_NAME = '港币';
