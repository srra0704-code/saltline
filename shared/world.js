// shared/world.js — 确定性港口地图（客户端渲染 / 服务器碰撞共用同一份数据）
// 所有坐标单位：米。X 向东，Z 向南，Y 向上。

export const BOUNDS = { minX: -52, maxX: 68, minZ: -54, maxZ: 54 };
export const SEA_Y = -1.4;

// ---- 确定性随机 ----
export function rng(seed = 20261112) {
  let s = seed >>> 0;
  const f = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (a, b) => a + (b - a) * f();
  f.int = (a, b) => Math.floor(a + (b - a + 1) * f());
  f.pick = (arr) => arr[Math.floor(f() * arr.length) % arr.length];
  return f;
}

const R = rng(0x5a17);

// 一个盒子 = { cx, cy, cz, hx, hy, hz, tag }
const boxes = [];
const addBox = (cx, cy, cz, sx, sy, sz, tag = 'solid') => {
  boxes.push({ cx, cy, cz, hx: sx / 2, hy: sy / 2, hz: sz / 2, tag });
};

// 集装箱（12.2 × 2.44 × 2.59），按区块堆放
const containers = [];
function container(x, z, level, rot, tone) {
  const L = 12.2, W = 2.44, H = 2.59;
  const sx = rot ? W : L, sz = rot ? L : W;
  const y = level * H;
  containers.push({ x, y: y + H / 2, z, rot, tone, level });
  addBox(x, y + H / 2, z, sx, H, sz, 'container');
}

const lanes = [-46, -34, -22, -10, 2, 14, 26, 38, 50];
for (let li = 0; li < lanes.length; li++) {
  const lx = lanes[li];
  for (let z = -44; z <= 44; z += 13.5) {
    if (R() < 0.28) continue; // 缺口，形成通道
    const stack = R() < 0.3 ? 2 : R() < 0.15 ? 3 : 1;
    const rot = R() < 0.5 ? 1 : 0;
    for (let lv = 0; lv < stack; lv++) {
      container(lx + (R() - 0.5) * 0.5, z + (R() - 0.5) * 1.2, lv, rot, R());
    }
  }
}

// 主仓库（有屋顶，可进入）
const WAREHOUSE = { x: 34, z: -34, w: 24, d: 18, h: 7 };
addBox(WAREHOUSE.x, WAREHOUSE.h / 2, WAREHOUSE.z - WAREHOUSE.d / 2, WAREHOUSE.w, WAREHOUSE.h, 0.4, 'wall');
addBox(WAREHOUSE.x, WAREHOUSE.h / 2, WAREHOUSE.z + WAREHOUSE.d / 2, WAREHOUSE.w, WAREHOUSE.h, 0.4, 'wall');
addBox(WAREHOUSE.x - WAREHOUSE.w / 2, WAREHOUSE.h / 2, WAREHOUSE.z, 0.4, WAREHOUSE.h, WAREHOUSE.d, 'wall');
addBox(WAREHOUSE.x + WAREHOUSE.w / 2, WAREHOUSE.h / 2, WAREHOUSE.z, 0.4, WAREHOUSE.h, WAREHOUSE.d, 'wall');

// 控制塔
addBox(58, 9, 40, 9, 18, 9, 'tower');

// 码头矮墙
for (let z = -50; z <= 50; z += 10) addBox(-51, 0.6, z, 1, 1.2, 8, 'quay');
// 场地围栏
addBox(8, 1.2, -53.4, 120, 2.4, 0.6, 'fence');
addBox(8, 1.2, 53.4, 120, 2.4, 0.6, 'fence');
addBox(67.4, 1.2, 0, 0.6, 2.4, 108, 'fence');

// ---- 目标点 ----
export const RELAYS = [
  { id: 'R1', x: -34, y: 1.5, z: 30 },
  { id: 'R2', x: 16, y: 1.5, z: -16 },
  { id: 'R3', x: 52, y: 1.5, z: 6 },
].map((r) => ({ ...r, hp: 100, radius: 1.4 }));

export const CP = [
  { id: 'A', x: -30, z: -38, r: 9, name: '北闸口' },
  { id: 'B', x: 10, z: 4, r: 11, name: '箱区' },
  { id: 'C', x: 46, z: 34, r: 10, name: '塔台' },
];

export const SPAWNS = {
  free: [[-20, 0, 44], [-8, 0, 46], [4, 0, 44], [18, 0, 46], [-30, 0, 46]],
  alpha: [[-44, 0, -46], [-36, 0, -48], [-28, 0, -46], [-20, 0, -48]],
  bravo: [[60, 0, 46], [56, 0, 40], [62, 0, 34], [48, 0, 46]],
  duel: [[-46, 0, -48], [62, 0, 48]],
};

export const EXTRACTS = [
  { id: 'E1', name: '北闸口', x: -20, z: 50, r: 5 },
  { id: 'E2', name: '防波堤', x: -46, z: -14, r: 5 },
];

// 战利品容器位置（搜打撤）
export const LOOT_SPOTS = (() => {
  const out = [];
  for (let i = 0; i < 26; i++) {
    const x = R.range(-44, 62);
    const z = R.range(-46, 46);
    out.push({ id: 'L' + i, x, z, r: 1.1 });
  }
  return out;
})();

export const WORLD = { BOUNDS, boxes, containers, WAREHOUSE, RELAYS, CP, SPAWNS, EXTRACTS, LOOT_SPOTS, SEA_Y };

// ---- 碰撞 ----
export function solidAt(x, y, z, radius = 0.34, height = 1.8) {
  const y0 = y, y1 = y + height;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.cy + b.hy < y0 || b.cy - b.hy > y1) continue;
    const dx = Math.abs(x - b.cx) - b.hx;
    const dz = Math.abs(z - b.cz) - b.hz;
    if (dx < radius && dz < radius) return b;
  }
  return null;
}

export function moveActor(pos, dx, dz, radius = 0.34, height = 1.8) {
  let nx = pos.x + dx, nz = pos.z + dz;
  if (solidAt(nx, pos.y, pos.z, radius, height)) {
    if (!solidAt(pos.x + dx, pos.y, pos.z, radius, height)) { nx = pos.x + dx; nz = pos.z; }
    else if (!solidAt(pos.x, pos.y, pos.z + dz, radius, height)) { nx = pos.x; nz = pos.z + dz; }
    else { nx = pos.x; nz = pos.z; }
  }
  nx = Math.max(BOUNDS.minX + 0.5, Math.min(BOUNDS.maxX - 0.5, nx));
  nz = Math.max(BOUNDS.minZ + 0.5, Math.min(BOUNDS.maxZ - 0.5, nz));
  pos.x = nx; pos.z = nz;
  return pos;
}

// 射线 vs AABB（slab），返回最近命中
export function raycast(ox, oy, oz, dx, dy, dz, maxDist = 200) {
  let best = maxDist, hit = null;
  const inv = (v) => (Math.abs(v) < 1e-8 ? 1e8 : 1 / v);
  const ix = inv(dx), iy = inv(dy), iz = inv(dz);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const tx1 = (b.cx - b.hx - ox) * ix, tx2 = (b.cx + b.hx - ox) * ix;
    const ty1 = (b.cy - b.hy - oy) * iy, ty2 = (b.cy + b.hy - oy) * iy;
    const tz1 = (b.cz - b.hz - oz) * iz, tz2 = (b.cz + b.hz - oz) * iz;
    const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
    const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
    if (tmax < 0 || tmin > tmax || tmin > best) continue;
    const t = tmin > 0.02 ? tmin : tmax;
    if (t < best) { best = t; hit = b; }
  }
  // 地面
  if (dy < -1e-6) {
    const t = -oy / dy;
    if (t > 0.02 && t < best) return { dist: t, x: ox + dx * t, y: 0, z: oz + dz * t, box: null };
  }
  if (!hit) return null;
  return { dist: best, x: ox + dx * best, y: oy + dy * best, z: oz + dz * best, box: hit };
}

export function hasLOS(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.4) return true;
  const h = raycast(ax, ay, az, dx / len, dy / len, dz / len, len - 0.15);
  return !h;
}

export function inZone(x, z, zone) {
  return Math.hypot(x - zone.x, z - zone.z) <= zone.r;
}

export function inBounds(x, z) {
  return x > BOUNDS.minX && x < BOUNDS.maxX && z > BOUNDS.minZ && z < BOUNDS.maxZ;
}
