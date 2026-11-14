// public/js/main.js — 客户端主循环：菜单、联机、移动射击、HUD、触屏
import * as THREE from '../vendor/three.module.js';
import { World3D } from './world3d.js';
import { Controls } from './input.js';
import { Net } from './net.js';
import { initLobby } from './lobby.js';
import { BODY_SKINS, WEAPON_SKINS, EMOTES } from '../../shared/skins.js';

const EMOTE_NAME = Object.fromEntries(EMOTES.map((e) => [e.id, e.name]));
import { WORLD, moveActor, inZone, raycast, hasLOS } from '../../shared/world.js';
import { MODES, WEAPONS, FLAG, PLAYER, MOVE } from '../../shared/protocol.js';
import { CP as CP_DATA, EXTRACTS as EX_DATA, RELAYS as RELAY_DATA } from '../../shared/world.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------- 设置 ----------------
const SKEY = 'saltline.settings.v1';
const settings = Object.assign(
  { sens: 1, quality: 'medium', fov: 74, vol: 0.6, autoFire: true, invY: false, name: '' },
  JSON.parse(localStorage.getItem(SKEY) || '{}'),
);
function saveSettings() { localStorage.setItem(SKEY, JSON.stringify(settings)); }

// ---------------- 渲染器 ----------------
const canvas = $('gl');
const DEBUG = /(\?|&)dbg=1/.test(location.search);
const FORCED_QUALITY = new URLSearchParams(location.search).get('quality');
const SAFE_MODE = sessionStorage.getItem('saltline.safeMode') === '1';
const isTouch = (navigator.maxTouchPoints || 0) > 0 || matchMedia('(pointer: coarse)').matches;
const FORCED_Q = new URLSearchParams(location.search).get('quality');
if (FORCED_Q && ['low', 'medium', 'high'].includes(FORCED_Q)) settings.quality = FORCED_Q;
if (SAFE_MODE) { settings.quality = 'low'; }
// 手机/平板默认走省电画质（阴影 + 多光源 + 高像素比最容易把移动 GPU 干趴）
if (isTouch && settings.qualityAuto !== false && !localStorage.getItem(SKEY)) {
  settings.quality = 'low';
}

// 建 WebGL 上下文：不同 GPU/驱动对属性挑食，逐级降级重试
function createRenderer() {
  const attempts = [
    { antialias: settings.quality !== 'low', powerPreference: 'high-performance', preserveDrawingBuffer: DEBUG },
    { antialias: false, powerPreference: 'default', preserveDrawingBuffer: DEBUG },
    { antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false, preserveDrawingBuffer: DEBUG },
  ];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const r = new THREE.WebGLRenderer({ canvas, ...attempts[i] });
      if (r.getContext()) { rendererAttempt = i; return r; }
      lastErr = new Error('getContext 返回空');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('无法创建 WebGL2 上下文');
}

let rendererAttempt = 0;
let renderer;
try {
  renderer = createRenderer();
} catch (e) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:200;background:#0b0d0f;color:#e8e4da;padding:24px;' +
    'font:14px/1.7 system-ui,sans-serif';
  el.innerHTML = '<h2>画面启动失败</h2><p>你的浏览器没有给出可用的 WebGL2 上下文（多见于旧版内核、软件渲染或显卡驱动异常）。</p>' +
    '<p>可以先用电脑或其他手机打开同一个地址；下面错误信息能帮我定位：</p><pre style="white-space:pre-wrap">' +
    String(e && e.message).slice(0, 300) + '</pre>';
  document.body.appendChild(el);
  try { fetch('/api/health').catch(() => {}); } catch {}
  // 允许 UI 继续（菜单仍可用），但不再渲染
  window.__webglFailed = String(e && e.message);
}

if (renderer) {
  // 显卡能力探测：varying / uniform 太少直接降级（这是移动端黑屏的常见原因）
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    G.caps = {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      varyings: gl.getParameter(gl.MAX_VARYING_VECTORS),
      fragUniforms: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
      vertUniforms: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
    if (G.caps.varyings < 32 || G.caps.fragUniforms < 512 || G.caps.vertUniforms < 256) {
      settings.quality = 'low';
      shaderFailHandled = true;
      setTimeout(() => { try { applySafeMode(); } catch {} }, 300);
    }
  } catch (e) { /* 探测失败无所谓 */ }
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    try { reportClientError('contextlost', 'WebGL 上下文丢失（GPU 资源不足/驱动重置）', ''); } catch {}
    applySafeMode();
    setTimeout(() => {
      try {
        const gl = renderer.getContext();
        if (!gl || gl.isContextLost()) hardRecover('WebGL 上下文丢失');
      } catch { hardRecover('WebGL 上下文丢失'); }
    }, 1200);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try { reportClientError('contextrestored', 'WebGL 上下文已恢复', ''); } catch {}
  });
}
if (renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = settings.quality !== 'low';
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.08, 400);
// 场景与地图：即使显卡不可用也要保证大厅/联机可用，所以这里兜底
const NULL_WORLD = {
  scene: new THREE.Scene(), update() {}, setRelays() {}, setCP() {}, setSafeMode() {},
  relays: [], cps: [], extracts: [],
};
let world = NULL_WORLD;
let rootScene = world.scene;
try {
  world = new World3D(renderer, settings.quality);
  rootScene = world.scene;
} catch (e) {
  try { reportClientError('world', '场景构建失败: ' + (e && e.message), e && e.stack); } catch {}
}
scene.add(camera);
const safeModeStripped = [];
rootScene.add(camera);

function applyQuality(q) {
  if (SAFE_MODE) q = 'low';
  settings.quality = q;
  if (!renderer) return;
  const dpr = Math.min(devicePixelRatio || 1, q === 'low' ? 1 : q === 'high' ? 2 : 1.25);
  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = q === 'high';
}
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  applyQuality(settings.quality);
}
addEventListener('resize', onResize);
addEventListener('orientationchange', () => setTimeout(onResize, 250));
applyQuality(settings.quality);
onResize();

// ---------------- 音频 ----------------
const Audio = {
  ctx: null,
  init() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
    this.master = this.ctx.createGain();
    this.master.gain.value = settings.vol;
    this.master.connect(this.ctx.destination);
    // 雨声
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
    const g = this.ctx.createGain(); g.gain.value = 0.12;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  },
  noise(dur, freq, gainV, type = 'lowpass') {
    if (!this.ctx) return;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = this.ctx.createGain(); g.gain.value = gainV;
    s.connect(f).connect(g).connect(this.master);
    s.start();
  },
  shot() { this.noise(0.14, 900, 0.5); this.noise(0.05, 260, 0.6, 'bandpass'); },
  hit() { this.noise(0.05, 2200, 0.28, 'highpass'); },
  kill() { this.noise(0.16, 480, 0.4); },
  click() { this.noise(0.05, 1500, 0.2, 'bandpass'); },
  setVolume(v) { if (this.master) this.master.gain.value = v; },
};

// ---------------- 状态 ----------------
const G = {
  state: 'menu',       // menu | lobby | playing | dead | ended
  me: null,            // {id, name, team, spawn}
  mode: null,
  players: new Map(),  // id -> remote player object
  pos: { x: 0, y: 0, z: 0 },
  vy: 0,
  yaw: 0, pitch: 0,
  hp: 100, alive: true, team: 0,
  weapon: 'kr7',
  ammo: 30, reserve: 150,
  reloadUntil: 0, lastShot: 0,
  loot: [], lootValue: 0, extractT: 0,
  snaps: [],
  serverTimeLeft: 0,
  tickets: { 1: 0, 2: 0 },
  relays: [], cps: [], crates: [],
  kills: 0, deaths: 0, extracted: 0,
  ads: 0,
  recoil: 0,
  lastSnapAt: 0,
  ping: 0,
};

// ---------------- 线上错误抓取（玩家端真实报错回传服务器） ----------------
const reportedErrors = new Set();
function showFatalBanner(text) {
  let el = document.getElementById('fatalBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatalBanner';
    el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99;background:rgba(180,30,20,.92);' +
      'color:#fff;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 10px;white-space:pre-wrap;max-height:40vh;overflow:auto';
    document.body.appendChild(el);
  }
  el.textContent = '⚠ 游戏出错（已上报）：\n' + text;
}

function reportClientError(kind, message, stack) {
  const key = kind + '|' + String(message).slice(0, 120);
  if (reportedErrors.has(key) || reportedErrors.size > 25) return;
  reportedErrors.add(key);
  const payload = {
    t: 'clientError', kind: String(kind).slice(0, 40),
    message: String(message || '').slice(0, 400),
    stack: String(stack || '').slice(0, 1500),
    ua: navigator.userAgent.slice(0, 160),
    state: `${G.state}/${G.mode?.id || '-'} step=${frameStep} renders=${renderCount}`,
    viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    quality: settings.quality,
  };
  try { net.send(payload); } catch {}
  console.error('[saltline]', kind, message);
  if (kind.startsWith('frame') || kind === 'error' || kind === 'shader') showFatalBanner(payload.message + '\n' + payload.stack.split('\n').slice(0, 4).join('\n'));
}

window.addEventListener('error', (e) => {
  if (String(e.message || '').includes('Script error')) return;
  reportClientError('error', e.message, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  reportClientError('promise', (e.reason && e.reason.message) || e.reason, e.reason && e.reason.stack);
});
// three 的着色器编译错误只走 console.error，这里也抓回来
const _origError = console.error.bind(console);
console.error = (...args) => {
  try {
    const text = args.map((a) => (a && a.message) ? a.message : String(a)).join(' ').slice(0, 600);
    if (/Shader Error|VALIDATE_STATUS|program not valid/i.test(text)) {
      reportClientError('shader', text, '');
      onShaderFailure(text);
    } else if (/THREE|shader|WebGL|varying|uniform|Sampler/i.test(text)) {
      reportClientError('shader', text, '');
    }
  } catch {}
  _origError(...args);
};

let renderCount = 0;
let shaderFailHandled = false;

// 画面崩了（着色器错误 / 上下文丢失）→ 以兼容画质自动重载并回到对局
function hardRecover(reason) {
  const key = 'saltline.recoverCount';
  const n = Number(sessionStorage.getItem(key) || 0);
  sessionStorage.setItem('saltline.safeMode', '1');
  try {
    const m = new URLSearchParams(location.search).get('mode') || localStorage.getItem('saltline.lastMode') || 'extract';
    sessionStorage.setItem('saltline.rejoin', m);
  } catch {}
  reportClientError('recover', `${reason}（第 ${n + 1} 次自愈）`, '');
  if (n >= 2) {
    showFatalBanner('画面连续恢复失败：你的浏览器/显卡驱动可能不支持 WebGL2。\n可以换 Chrome/其他设备，或清理站点数据后重试。');
    return;
  }
  sessionStorage.setItem(key, String(n + 1));
  setTimeout(() => { try { location.reload(); } catch {} }, 600);
}

// 渲染正常跑满 6 秒后清掉恢复计数，避免一直降级
function clearRecoverFlags() {
  if (renderCount < 300) return;
  sessionStorage.removeItem('saltline.recoverCount');
  sessionStorage.setItem('saltline.renderedOk', '1');
}
function onShaderFailure(text) {
  if (shaderFailHandled) return;
  shaderFailHandled = true;
  try { applySafeMode(); } catch {}
  hardRecover('显卡着色器错误');
}

const controls = new Controls(canvas, { sens: settings.sens, invY: settings.invY });
const net = new Net();
const AKEY = 'saltline.auth.v1';
const auth = Object.assign({ id: '', token: '' }, JSON.parse(localStorage.getItem(AKEY) || '{}'));
function saveAuth() { localStorage.setItem(AKEY, JSON.stringify(auth)); }

// ---------------- 玩家模型 ----------------
function makePlayerMesh(skinIdx = 0) {
  const g = new THREE.Group();
  const skin = BODY_SKINS[skinIdx % BODY_SKINS.length] || BODY_SKINS[0];
  const bodyMat = new THREE.MeshStandardMaterial({ color: skin.body, roughness: .7, metalness: .2, emissive: skin.glow ? skin.body : 0x000000, emissiveIntensity: skin.glow ? 0.25 : 0 });
  const darkMat = new THREE.MeshStandardMaterial({ color: skin.gear, roughness: .8 });
  g.userData.skinIdx = skinIdx;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.72, 2, 8), bodyMat);
  torso.position.y = 0.95; torso.castShadow = true; g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), darkMat);
  head.position.y = 1.62; head.castShadow = true; g.add(head);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.8, 0.3), darkMat);
  legs.position.y = 0.4; g.add(legs);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.72), new THREE.MeshStandardMaterial({ color: 0x1a1d20, metalness: .8, roughness: .4 }));
  gun.position.set(0.2, 1.35, 0.42); g.add(gun);
  const label = makeLabel('');
  label.position.y = 2.05;
  g.add(label);
  return { group: g, label, torso, head };
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#e8e4da';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(1.6, 0.4, 1);
  sp.userData.canvas = c; sp.userData.ctx = ctx; sp.userData.tex = tex; sp.userData.text = text;
  return sp;
}
function setLabel(sprite, text, color = '#e8e4da') {
  if (sprite.userData.text === text) return;
  const ctx = sprite.userData.ctx;
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, 256, 64);
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 34);
  sprite.userData.text = text;
  sprite.userData.tex.needsUpdate = true;
}

function teamColor(team) {
  if (team === 1) return 0x3f7fd6;
  if (team === 2) return 0xc0452f;
  if (team === 3) return 0x6a7078;
  return 0x8d9aa3;
}

// ---------------- 曳光/弹着 ----------------
const tracers = [];
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.9 });
function addTracer(x1, y1, z1, x2, y2, z2, color = 0xffd08a) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x1, y1, z1), new THREE.Vector3(x2, y2, z2),
  ]);
  const mat = tracerMat.clone();
  mat.color.setHex(color);
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  rootScene.add(line);
  tracers.push({ line, t: 0, life: 0.09 });
}
function updateTracers(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.t += dt;
    tr.line.material.opacity = Math.max(0, 0.9 * (1 - tr.t / tr.life));
    if (tr.t >= tr.life) {
      rootScene.remove(tr.line);
      tr.line.geometry.dispose();
      tr.line.material.dispose();
      tracers.splice(i, 1);
    }
  }
}

const impacts = [];
const impactGeo = new THREE.SphereGeometry(0.07, 6, 5);
function addImpact(x, y, z, color = 0xffc977) {
  const m = new THREE.Mesh(impactGeo, new THREE.MeshBasicMaterial({ color }));
  m.position.set(x, y, z);
  rootScene.add(m);
  impacts.push({ m, t: 0 });
  if (impacts.length > 40) { const o = impacts.shift(); rootScene.remove(o.m); }
}

// ---------------- 相机与本地玩家 ----------------
function eyeHeight() { return controls.crouch ? PLAYER.crouchEye : PLAYER.eye; }

function updateCamera(dt) {
  const eye = eyeHeight();
  const bob = G.alive ? Math.sin(performance.now() * 0.009) * 0.012 * (Math.hypot(controls.moveX, controls.moveZ) > 0.1 ? 1 : 0) : 0;
  camera.position.set(G.pos.x, G.pos.y + eye + bob, G.pos.z);
  const recoilPitch = G.recoil * 0.02;
  camera.rotation.set(0, 0, 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = G.yaw + Math.PI;   // three 的 -Z 前方
  camera.rotation.x = G.pitch + recoilPitch;
  const targetFov = lerp(settings.fov, settings.fov * 0.72, G.ads);
  camera.fov = lerp(camera.fov, targetFov, 1 - Math.pow(0.001, dt));
  camera.updateProjectionMatrix();
  G.recoil = Math.max(0, G.recoil - dt * 30);
}

// ---------------- 射击 ----------------
function tryShoot() {
  const w = WEAPONS[G.weapon];
  const t = performance.now();
  if (!G.alive) return;
  if (t - G.lastShot < 60000 / w.rpm) return;
  if (t < G.reloadUntil) return;
  if (G.ammo <= 0) { startReload(); return; }
  G.lastShot = t;
  G.ammo--;

  const eye = eyeHeight();
  const ox = G.pos.x, oy = G.pos.y + eye, oz = G.pos.z;
  const cp = Math.cos(G.pitch);
  let dx = Math.sin(G.yaw) * cp, dy = Math.sin(G.pitch), dz = Math.cos(G.yaw) * cp;
  const spread = (controls.sprint ? 0.03 : w.spread) * (1 - G.ads * 0.6);
  G.recoil += w.recoil;

  const pellet = w.pellets || 1;
  for (let i = 0; i < pellet; i++) {
    const sx = dx + (Math.random() - 0.5) * spread * 2;
    const sy = dy + (Math.random() - 0.5) * spread * 2;
    const sz = dz + (Math.random() - 0.5) * spread * 2;
    const len = Math.hypot(sx, sy, sz) || 1;
    const hit = clientTrace(ox, oy, oz, sx / len, sy / len, sz / len, w.range);
    const ex = hit ? hit.x : ox + sx * w.range;
    const ey = hit ? hit.y : oy + sy * w.range;
    const ez = hit ? hit.z : oz + sz * w.range;
    addTracer(ox, oy - 0.08, oz, ex, ey, ez);
    if (hit) addImpact(ex, ey, ez, hit.player ? 0xff5a40 : 0xffc977);
    if (hit && hit.player) { hitmarker(false); Audio.hit(); }
  }
  Audio.shot();
  net.send({ t: 'fire', yaw: G.yaw, pitch: G.pitch });
  updateAmmoUI();
}

function clientTrace(ox, oy, oz, dx, dy, dz, maxD) {
  const geo = raycast(ox, oy, oz, dx, dy, dz, maxD);
  let best = geo ? geo.dist : maxD;
  let out = geo ? { x: geo.x, y: geo.y, z: geo.z } : null;
  for (const p of G.players.values()) {
    if (!p.alive) continue;
    if (p.team === G.team) continue;
    const d = raySphere(ox, oy, oz, dx, dy, dz, p.sim.x, p.sim.y + 1.0, p.sim.z, 0.5);
    if (d !== null && d < best) { best = d; out = { x: ox + dx * d, y: oy + dy * d, z: oz + dz * d, player: p }; }
  }
  return out;
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

function startReload() {
  const w = WEAPONS[G.weapon];
  if (G.ammo >= w.mag || G.reserve <= 0) return;
  if (performance.now() < G.reloadUntil) return;
  G.reloadUntil = performance.now() + w.reload * 1000;
  net.send({ t: 'input', rl: 1, yaw: G.yaw, pitch: G.pitch, mx: controls.moveX, mz: controls.moveZ });
  Audio.click();
  setTimeout(() => {
    const need = w.mag - G.ammo;
    const take = Math.min(need, G.reserve);
    G.ammo += take; G.reserve -= take;
    updateAmmoUI();
  }, w.reload * 1000);
}

function updateAmmoUI() {
  $('ammoMag').textContent = G.ammo;
  $('ammoRes').textContent = '/' + G.reserve;
  $('wname').textContent = WEAPONS[G.weapon].name;
}

// ---------------- HUD ----------------
let toastTimer = null;
function toast(text, ms = 1800) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

let hitTimer = null;
function hitmarker(kill) {
  const el = $('hitmarker');
  el.classList.toggle('kill', !!kill);
  el.classList.add('on');
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => el.classList.remove('on'), 140);
}

function dmgFlash() {
  const el = $('dmgflash');
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 180);
}

function addFeed(html, color = 'var(--alarm)') {
  const el = $('killfeed');
  const d = document.createElement('div');
  d.innerHTML = html;
  d.style.borderColor = color;
  el.appendChild(d);
  if (el.children.length > 5) el.removeChild(el.firstChild);
  setTimeout(() => d.remove(), 6000);
}

function modeObjective() {
  const m = G.mode;
  if (!m) return '';
  // 未进入对局时 HUD 不显示目标
  if (m.id === 'relay') {
    const left = G.relays.filter((r) => !r[2]).length;
    return `中继剩余 ${left}/3`;
  }
  if (m.id === 'extract') {
    const zone = EX_DATA.find((e) => inZone(G.pos.x, G.pos.z, e));
    return zone ? `撤离点 · ${zone.name}` : '搜箱 → 去撤离点';
  }
  if (m.id === 'battlefield') {
    return G.cps.map((c) => `${c[0]}${c[1] === 1 ? '蓝' : c[1] === 2 ? '红' : '·'}`).join(' ');
  }
  return '';
}

function updateHUD() {
  const hp = Math.max(0, Math.round(G.hp));
  $('hpFill').style.width = clamp(hp, 0, 100) + '%';
  $('hpFill').style.background = hp > 55 ? 'linear-gradient(90deg,#6bd07a,#b8e05a)'
    : hp > 25 ? 'linear-gradient(90deg,#e0b53c,#e08a2c)' : 'linear-gradient(90deg,#ff5a40,#a32b1c)';
  $('hpText').textContent = hp;
  const t = G.serverTimeLeft;
  $('timer').textContent = `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  $('objective').textContent = modeObjective();
  $('modeChip').textContent = (G.mode?.en || '—') + (G.mode?.id === 'battlefield' ? ` · ${G.team === 1 ? '蓝队' : '红队'}` : '');
  if (G.mode?.id === 'battlefield') {
    $('scoreline').innerHTML = `<span class="a">蓝 ${Math.round(G.tickets[1] || 0)}</span><span class="b">红 ${Math.round(G.tickets[2] || 0)}</span>`;
  } else {
    $('scoreline').innerHTML = `<span class="dim">击杀 ${G.kills}</span>`;
  }
  $('crosshair').classList.toggle('ads', G.ads > 0.5);
  // 战利品
  const lb = $('lootbox');
  if (G.mode?.id === 'extract') {
    lb.classList.remove('hidden');
    $('lootValue').textContent = G.lootValue;
    $('lootList').innerHTML = G.loot.slice(-4).map((i) => `${i.name} ¥${i.value}`).join('<br>');
  } else lb.classList.add('hidden');
  // 交互提示
  const pr = $('prompt');
  let showPrompt = false;
  if (G.alive && G.mode?.id === 'extract') {
    for (const c of G.crates) {
      if (c.open) continue;
      if (Math.hypot(c.x - G.pos.x, c.z - G.pos.z) < 2.6) { showPrompt = true; pr.textContent = 'E · 搜箱'; break; }
    }
  }
  if (G.alive && G.mode?.id === 'relay') {
    for (const r of G.relays) {
      const d = RELAY_DATA.find((x) => x.id === r[0]);
      if (!r[2] && d && Math.hypot(d.x - G.pos.x, d.z - G.pos.z) < 2.6) { showPrompt = true; pr.textContent = 'E · 拆中继（也可开枪打）'; }
    }
  }
  pr.classList.toggle('hidden', !showPrompt);
  // 撤离进度
  const eb = $('extractBar');
  if (G.extractT > 0.05) { eb.classList.remove('hidden'); eb.querySelector('i').style.width = clamp(G.extractT / 5, 0, 1) * 100 + '%'; }
  else eb.classList.add('hidden');
  drawMinimap();
}

// ---------------- 小地图 ----------------
const mapCanvas = $('mapCanvas');
const mctx = mapCanvas.getContext('2d');
function drawMinimap() {
  const W = mapCanvas.width, H = mapCanvas.height;
  const bx = WORLD.BOUNDS;
  const sx = W / (bx.maxX - bx.minX), sz = H / (bx.maxZ - bx.minZ);
  const px = (x) => (x - bx.minX) * sx;
  const pz = (z) => (z - bx.minZ) * sz;
  mctx.clearRect(0, 0, W, H);
  mctx.fillStyle = 'rgba(11,13,15,0.9)';
  mctx.fillRect(0, 0, W, H);
  mctx.fillStyle = 'rgba(140,150,158,0.55)';
  for (const b of WORLD.boxes) {
    mctx.fillRect(px(b.cx - b.hx), pz(b.cz - b.hz), Math.max(1, b.hx * 2 * sx), Math.max(1, b.hz * 2 * sz));
  }
  if (G.mode?.id === 'extract') {
    mctx.fillStyle = '#7ddc8a';
    for (const c of G.crates) if (!c.open) mctx.fillRect(px(c.x) - 1, pz(c.z) - 1, 2.5, 2.5);
    mctx.strokeStyle = '#7ddc8a'; mctx.lineWidth = 1;
    for (const e of EX_DATA) { mctx.beginPath(); mctx.arc(px(e.x), pz(e.z), e.r * sx, 0, 7); mctx.stroke(); }
  }
  if (G.mode?.id === 'battlefield') {
    for (const c of G.cps) {
      const col = c[1] === 1 ? '#5aa9ff' : c[1] === 2 ? '#ff5a40' : '#dcd6c8';
      mctx.strokeStyle = col; mctx.lineWidth = 1.5;
      mctx.beginPath(); mctx.arc(px(c[4]), pz(c[5]), 6, 0, 7); mctx.stroke();
    }
    for (const c of CP_DATA) {
      mctx.fillStyle = 'rgba(220,214,200,.12)';
      mctx.beginPath(); mctx.arc(px(c.x), pz(c.z), c.r * sx, 0, 7); mctx.fill();
    }
  }
  if (G.mode?.id === 'relay') {
    for (const r of G.relays) {
      const d = RELAY_DATA.find((x) => x.id === r[0]);
      if (!d) continue;
      mctx.fillStyle = r[2] ? '#555c62' : '#ffb347';
      mctx.beginPath(); mctx.arc(px(d.x), pz(d.z), 3, 0, 7); mctx.fill();
    }
  }
  for (const p of G.players.values()) {
    if (!p.alive) continue;
    const col = p.team === G.team && G.mode?.id === 'battlefield' ? '#5aa9ff'
      : p.team === 3 ? '#ff5a40' : p.team === 2 ? '#ff5a40' : '#5aa9ff';
    mctx.fillStyle = col;
    mctx.beginPath(); mctx.arc(px(p.sim.x), pz(p.sim.z), 2.5, 0, 7); mctx.fill();
  }
  // 自己
  mctx.save();
  mctx.translate(px(G.pos.x), pz(G.pos.z));
  mctx.rotate(-G.yaw);
  mctx.fillStyle = '#ffb347';
  mctx.beginPath(); mctx.moveTo(0, -5); mctx.lineTo(3.4, 4); mctx.lineTo(-3.4, 4); mctx.closePath(); mctx.fill();
  mctx.restore();
}

// ---------------- 远端玩家 ----------------
function playerObj(id, skinIdx = 0) {
  let p = G.players.get(id);
  if (p) return p;
  const mesh = makePlayerMesh(skinIdx);
  rootScene.add(mesh.group);
  p = { id, group: mesh.group, torso: mesh.torso, label: mesh.label, buf: [], sim: { x: 0, y: 0, z: 0 }, yaw: 0, alive: false, team: 0, hp: 100, flags: 0, skinIdx, emote: null, emoteUntil: 0, emoteT: 0 };
  G.players.set(id, p);
  return p;
}

function applySnap(m) {
  G.lastSnapAt = performance.now();
  const t = performance.now();
  G.serverTimeLeft = m.tl ?? G.serverTimeLeft;
  if (m.tk) G.tickets = m.tk;
  if (m.rl) { G.relays = m.rl; try { world.setRelays(m.rl); } catch {} }
  if (m.cp) { G.cps = m.cp.map((c) => {
    const d = CP_DATA.find((x) => x.id === c[0]);
    return [c[0], c[1], c[2], c[3], d ? d.x : 0, d ? d.z : 0];
  }); world.setCP(m.cp); }
  if (m.cr) G.crates = m.cr.map((c) => ({ id: c[0], open: !!c[1], x: c[2], z: c[3] }));

  for (const row of m.ps) {
    const [id, x, y, z, yaw, pitch, flags, hp, team, score, ammo, skinIdx] = row;
    if (id === G.me?.id) {
      // 服务器校正（预测误差平滑）
      const dx = x - G.pos.x, dz = z - G.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.6) { G.pos.x = x; G.pos.z = z; G.pos.y = y; }
      else if (d > 0.05) { G.pos.x += dx * 0.18; G.pos.z += dz * 0.18; }
      if (typeof ammo === 'number' && ammo !== G.ammo && performance.now() > G.reloadUntil) G.ammo = ammo;
      G.hp = hp; G.alive = !!(flags & FLAG.alive);
      continue;
    }
    const p = playerObj(id, skinIdx || 0);
    p.team = team;
    p.hp = hp;
    p.flags = flags;
    p.alive = !!(flags & FLAG.alive);
    p.buf.push({ t, x, y, z, yaw, pitch });
    if (p.buf.length > 12) p.buf.shift();
    if (p.buf.length === 1) p.sim = { x, y, z };
  }
  // 清理离场玩家
  const ids = new Set(m.ps.map((r) => r[0]));
  for (const [id, p] of G.players) {
    if (!ids.has(id)) { rootScene.remove(p.group); G.players.delete(id); }
  }
  if (m.bl) {
    for (const b of m.bl) {
      if (b[6] === G.me?.id) continue;
      addTracer(b[0], b[1], b[2], b[3], b[4], b[5], 0xff9a6a);
      addImpact(b[3], b[4], b[5]);
    }
  }
}

function interpPlayers(dt) {
  const now = performance.now();
  const delay = 120;
  for (const p of G.players.values()) {
    const buf = p.buf;
    if (buf.length >= 2) {
      const target = now - delay;
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= target && buf[i + 1].t >= target) { a = buf[i]; b = buf[i + 1]; break; }
      }
      const span = Math.max(1, b.t - a.t);
      const k = clamp((target - a.t) / span, 0, 1);
      p.sim.x = lerp(a.x, b.x, k);
      p.sim.y = lerp(a.y, b.y, k);
      p.sim.z = lerp(a.z, b.z, k);
      p.yaw = a.yaw + angleDelta(a.yaw, b.yaw) * k;
    } else {
      const a = buf[0];
      if (a) { p.sim.x = a.x; p.sim.y = a.y; p.sim.z = a.z; p.yaw = a.yaw; }
    }
    p.group.visible = p.alive && Math.hypot(p.sim.x - G.pos.x, p.sim.z - G.pos.z) < 140;
    p.group.position.set(p.sim.x, p.sim.y, p.sim.z);
    p.group.rotation.y = p.yaw + Math.PI;
    if (p.flags & FLAG.crouch) p.torso.scale.y = 0.72; else p.torso.scale.y = 1;
    const skin = BODY_SKINS[p.skinIdx % BODY_SKINS.length] || BODY_SKINS[0];
    p.torso.material.color.setHex(skin.body);
    // 舞蹈 / 表情动画（程序化）
    if (p.emote && performance.now() < p.emoteUntil) {
      p.emoteT += dt;
      const t = p.emoteT;
      if (p.emote === 'dance_spin' || p.emote === 'dance_moon') {
        p.group.rotation.y += dt * 6;
        p.group.position.y = p.sim.y + Math.abs(Math.sin(t * 6)) * 0.12;
      } else if (p.emote === 'dance_robot') {
        p.torso.rotation.y = Math.sin(t * 12) * 0.5;
        p.torso.rotation.z = Math.cos(t * 12) * 0.25;
        p.group.position.y = p.sim.y + Math.abs(Math.sin(t * 10)) * 0.06;
      } else if (p.emote === 'dance_reload') {
        p.torso.rotation.x = Math.sin(t * 9) * 0.35;
        p.group.rotation.y += dt * 2.4;
      } else if (p.emote === 'wave') {
        p.torso.rotation.z = Math.sin(t * 8) * 0.3;
      } else if (p.emote === 'sit') {
        p.group.position.y = p.sim.y - 0.35;
      } else if (p.emote === 'taunt') {
        p.torso.rotation.x = Math.sin(t * 14) * 0.2;
      }
    } else if (p.emote) {
      p.emote = null;
      p.group.position.y = p.sim.y;
      p.torso.rotation.set(0, 0, 0);
    }
    p.torso.material.color.setHex(skin.body);
  }
}

function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ---------------- 主循环 ----------------
let last = performance.now();
let sendAcc = 0;
let rafId = null;

let frameStep = 'init';
let frameErrors = 0;

function frame() {
  rafId = requestAnimationFrame(frame);
  try {
    tickFrame();
    frameErrors = 0;
  } catch (e) {
    frameErrors++;
    if (frameErrors <= 3) reportClientError('frame@' + frameStep, e && e.message, e && e.stack);
  }
}

function tickFrame() {
  controls.sample();   // 键盘 WASD/Shift 在这里同步进输入状态（之前漏了，桌面端走不动）
  const now = performance.now();
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  frameStep = 'state';
  if (G.state === 'playing' || G.state === 'dead') {
    stepLocal(dt);
    interpPlayers(dt);
    sendAcc += dt;
    if (sendAcc > 0.05) {
      sendAcc = 0;
      net.send({
        t: 'input', yaw: G.yaw, pitch: G.pitch,
        mx: controls.moveX, mz: controls.moveZ,
        cr: controls.crouch, sp: controls.sprint,
      });
    }
    // 开火
    if (controls.fire && G.alive && G.state === 'playing') {
      if (settings.autoFire && controls.touchMode) aimAssist();
      tryShoot();
    }
  }

  // ADS 与准星
  G.ads = lerp(G.ads, controls.ads && !controls.sprint ? 1 : 0, 1 - Math.pow(0.001, dt));
  if (controls.consume('reload')) startReload();
  if (controls.consume('jump') && G.alive && G.pos.y <= 0.02) { G.vy = MOVE.jump; net.send({ t: 'input', jp: 1, yaw: G.yaw, pitch: G.pitch }); }
  if (controls.consume('interact')) net.send({ t: 'act', a: 'interact' });

  frameStep = 'camera';
  updateCamera(dt);
  frameStep = 'world';
  world.update(dt, camera);
  updateTracers(dt);
  for (let i = impacts.length - 1; i >= 0; i--) {
    const im = impacts[i];
    im.t += dt;
    im.m.scale.setScalar(1 + im.t * 6);
    im.m.material.opacity = Math.max(0, 1 - im.t * 8);
    if (im.t > 0.14) { rootScene.remove(im.m); impacts.splice(i, 1); }
  }
  if (G.state === 'playing' || G.state === 'dead') {
  frameStep = 'hud';
    updateHUD();
    updatePartyHud();
    applyWeaponSkin();
  }

  frameStep = 'render';
  if (renderer) {
    renderer.render(rootScene, camera);
    renderCount++;
    checkRenderHealth();
    clearRecoverFlags();
    // 上下文悄悄死了也自愈（有些设备不触发 contextlost 事件）
    if (renderCount % 120 === 0) {
      try {
        const gl = renderer.getContext();
        if (!gl || gl.isContextLost()) hardRecover('上下文静默丢失');
      } catch {}
    }
  }
}

let healthChecked = 0;
function checkRenderHealth() {
  // 看完 2 秒还没画出任何三角形 → 自动降到安全画质并上报（手机 GPU 常见）
  if (healthChecked >= 3 || renderCount < 120) return;
  if (!renderer) return;
  const tris = renderer.info && renderer.info.render ? renderer.info.render.triangles : -1;
  if (tris > 0) { healthChecked = 3; return; }
  healthChecked++;
  if (healthChecked >= 2) {
    reportClientError('blank', `连续 ${renderCount} 帧 triangles=${tris}，场景没画出来`, '');
    try { applySafeMode(); } catch (e) { reportClientError('safemode', e.message, e.stack); }
    healthChecked = 3;
  }
}

function applySafeMode() {
  settings.quality = 'low';
  try { applyQuality('low'); } catch {}
  try { world.setSafeMode && world.setSafeMode(); } catch {}
  for (const l of safeModeStripped) { try { rootScene.remove(l); } catch {} }
  toast('已自动切换到省电画质');
}

function stepLocal(dt) {
  // 本地预测移动（与服务器同算法）
  if (G.alive) {
    let sp = controls.crouch ? MOVE.crouch : controls.sprint ? MOVE.sprint : MOVE.walk;
    if (G.ads > 0.5) sp = MOVE.ads;
    const mx = controls.moveX, mz = controls.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 0.05) {
      const nx = mx / Math.max(1, len), nz = mz / Math.max(1, len);
      const cos = Math.cos(G.yaw), sin = Math.sin(G.yaw);
      const dx = (nz * sin + mx * cos) * sp * dt;
      const dz = (nz * cos - mx * sin) * sp * dt;
      moveActor(G.pos, dx, dz, PLAYER.radius, PLAYER.height);
    }
  }
  G.vy -= MOVE.gravity * dt;
  G.pos.y += G.vy * dt;
  if (G.pos.y <= 0) { G.pos.y = 0; G.vy = 0; }
  G.yaw = controls.yaw;
  G.pitch = controls.pitch;

  // 撤离进度（本地预演，服务器权威）
  if (G.mode?.id === 'extract' && G.alive && G.lootValue > 0) {
    const zone = EX_DATA.find((e) => inZone(G.pos.x, G.pos.z, e));
    G.extractT = zone ? G.extractT + dt : Math.max(0, G.extractT - dt * 2);
    if (G.extractT > 5.2) G.extractT = 5.2;
  }
}

function aimAssist() {
  const eye = G.pos.y + eyeHeight();
  let best = null, bestDot = Math.cos(0.06);
  for (const p of G.players.values()) {
    if (!p.alive) continue;
    if (G.mode.id === 'battlefield' && p.team === G.team) continue;
    const dx = p.sim.x - G.pos.x, dy = (p.sim.y + 1.2) - eye, dz = p.sim.z - G.pos.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dirx = Math.sin(G.yaw) * Math.cos(G.pitch), diry = Math.sin(G.pitch), dirz = Math.cos(G.yaw) * Math.cos(G.pitch);
    const dot = (dx / len) * dirx + (dy / len) * diry + (dz / len) * dirz;
    if (dot > bestDot) { bestDot = dot; best = p; }
  }
  if (best) {
    const dx = best.sim.x - G.pos.x, dz = best.sim.z - G.pos.z;
    const dy = (best.sim.y + 1.1) - (G.pos.y + eyeHeight());
    G.yaw = Math.atan2(dx, dz);
    G.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    controls.yaw = G.yaw; controls.pitch = G.pitch;
  }
}

// ---------------- 网络事件 ----------------
net.on('status', (s) => {
  const el = $('netState');
  if (s.state === 'open') el.textContent = '已连接';
  else if (s.state === 'connecting') el.textContent = '连接中…';
  else if (s.state === 'closed') el.textContent = '断线重连中…';
  else el.textContent = '连接失败';
});

net.on('welcome', (m) => {
  G.me = { id: m.id, name: m.name };
  G.mode = m.mode;
  G.team = m.team;
  G.pos.x = m.spawn[0]; G.pos.y = m.spawn[1]; G.pos.z = m.spawn[2];
  G.yaw = controls.yaw = 0;
  G.hp = 100; G.alive = true; G.ammo = WEAPONS.kr7.mag; G.reserve = WEAPONS.kr7.reserve;
  G.state = 'playing';
  G.kills = 0; G.deaths = 0; G.loot = []; G.lootValue = 0; G.extractT = 0;
  renderRoster(m.roster);
  $('boot').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('lobby').classList.add('hidden');
  $('result').classList.add('hidden');
  controls.lock();
  Audio.init();
  toast(`${m.mode.name} · 房间 ${m.room}`);
});

net.on('snap', applySnap);

net.on('event', (m) => {
  switch (m.k) {
    case 'hit':
      if (m.by === G.me?.id) { hitmarker(!!m.head); }
      addImpact(m.x, m.y, m.z, 0xff5a40);
      break;
    case 'kill':
      addFeed(`${m.byName} → ${m.name}${m.head ? ' ⌖' : ''}`);
      if (m.id === G.me?.id) {
        G.alive = false; G.deaths++;
        G.state = 'dead';
        dmgFlash();
        toast('阵亡 · 6 秒后重新部署');
        setTimeout(() => { if (G.alive) G.state = 'playing'; }, 6000);
      }
      if (m.by === G.me?.id) { G.kills++; Audio.kill(); hitmarker(true); }
      break;
    case 'relay':
      toast(`中继 ${m.id} 已摧毁`);
      addFeed(`中继 ${m.id} DOWN`, 'var(--signal)');
      break;
    case 'loot':
      if (m.id === G.me?.id) { G.lootValue = m.value2; toast(`搜到 ${m.item} ¥${m.value}`); }
      break;
    case 'looted':
      G.loot.push(m.item);
      G.lootValue = m.total;
      break;
    case 'extracted':
      G.extracted += m.value;
      showResult({ reason: 'extracted', value: m.value, zone: m.zone });
      break;
    case 'cap':
      toast(`${m.id} 点被${m.team === 1 ? '蓝队' : '红队'}占领`);
      break;
    case 'airdrop':
      toast(`空投落在 (${Math.round(m.x)}, ${Math.round(m.z)})`, 3000);
      break;
    case 'respawned':
      G.alive = true; G.state = 'playing'; G.hp = 100;
      G.ammo = WEAPONS[G.weapon].mag; G.reserve = WEAPONS[G.weapon].reserve;
      break;
    case 'chat':
      addFeed(`<span style="color:var(--steel)">${m.from}</span>: ${m.text}`, 'var(--steel)');
      break;
    case 'joined':
      addFeed(`${m.name} 加入`, 'var(--ok)');
      break;
    case 'left':
      break;
    case 'roundEnd':
      showResult(m);
      break;
    case 'emote': {
      const pl = G.players.get(m.pid);
      if (pl) { pl.emote = m.id; pl.emoteUntil = performance.now() + 4000; pl.emoteT = 0; }
      break;
    }
    case 'admin': {
      const b = $('adminBanner');
      b.textContent = '【服务器】' + m.text;
      b.classList.remove('hidden');
      setTimeout(() => b.classList.add('hidden'), 5000);
      break;
    }
    case 'duelRoundEnd':
      toast(`回合 ${m.round} 结束 · 蓝${m.wins[1]} : 红${m.wins[2]}`);
      break;
    case 'duelRound':
      toast(`第 ${m.round} 回合开始`);
      break;
    case 'resync':
      break;
  }
});

function renderRoster(roster) {
  const el = $('roster');
  el.innerHTML = '';
  for (const r of roster || []) {
    const d = document.createElement('div');
    d.className = 'm' + (r.bot ? ' bot' : '');
    d.innerHTML = `<span>${r.name}</span><span>${r.team === 1 ? '蓝' : r.team === 2 ? '红' : r.bot ? 'AI' : '自由'}</span>`;
    el.appendChild(d);
  }
}

// ---------------- 结果面板 ----------------
function showResult(m) {
  G.state = 'ended';
  controls.unlock();
  const box = $('result');
  box.classList.remove('hidden');
  $('hud').classList.add('hidden');
  let title = '对局结束';
  if (m.reason === 'extracted') title = `撤离成功 · 带走 ¥${m.value}`;
  else if (m.reason === 'relays') title = m.winner === 0 ? '中继全部摧毁 · 胜利' : '任务完成';
  else if (m.reason === 'tickets') title = m.winner === 1 ? '蓝队胜利' : m.winner === 2 ? '红队胜利' : '战平';
  else if (m.reason === 'time') title = '时间到';
  $('resultTitle').textContent = title;
  if (m.rewards) {
    const me = m.rewards.find((r) => r.name === G.me?.name);
    $('resultReward').textContent = me ? `本局收益 +${me.earned} 港币 · 段位分 ${me.points >= 0 ? '+' : ''}${me.points}（${me.rank}）` : '';
  } else $('resultReward').textContent = '';
  lobby && lobby.renderAll();
  const board = $('resultBoard');
  board.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'r head';
  head.innerHTML = '<span>#</span><span>呼号</span><span>K</span><span>D</span><span>分</span>';
  board.appendChild(head);
  (m.board || []).forEach((r, i) => {
    const d = document.createElement('div');
    d.className = 'r';
    d.innerHTML = `<span>${i + 1}</span><span>${r.name}${r.bot ? ' <em style="color:var(--steel)">AI</em>' : ''}</span><span>${r.kills}</span><span>${r.deaths}</span><span>${r.score}</span>`;
    board.appendChild(d);
  });
  if (m.reason === 'extracted') {
    setTimeout(() => { box.classList.add('hidden'); net.send({ t: 'act', a: 'respawn' }); G.state = 'playing'; $('hud').classList.remove('hidden'); controls.lock(); }, 3800);
  }
}

// ---------------- 大厅 / 对局切换 ----------------
const lobby = initLobby({ net, settings, saveSettings, play: (mode) => enterGame(mode) });

function enterGame(mode) {
  Audio.init();
  try { localStorage.setItem('saltline.lastMode', mode); } catch {}
  const name = ($('callsign').value || '').trim() || settings.name || 'OPERATOR';
  settings.name = name; saveSettings();
  if (!net.connected) {
    net.connect({ name, mode, url: ($('serverUrl').value || '').trim(), auth });
    return;
  }
  net.send({ t: 'auth', id: auth.id, token: auth.token, name });
  net.send({ t: 'hello', mode });
  $('netState').textContent = '进入对局…';
}

function leaveGame() {
  net.send({ t: 'leaveRoom' });
  G.state = 'menu';
  controls.unlock();
  $('hud').classList.add('hidden');
  $('result').classList.add('hidden');
  $('boot').classList.remove('hidden');
  for (const [id, p] of G.players) { rootScene.remove(p.group); }
  G.players.clear();
  G.me = null; G.alive = false; G.hp = 100;
  lobby.renderAll();
  setTimeout(() => net.send({ t: 'social', k: 'refresh' }), 300);
}

// 首屏即连接大厅
net.connect({ name: settings.name || 'OPERATOR', url: '', auth });
net.on('status', (st) => {
  if (st.state === 'open') {
    if (auth.id) $('netState').textContent = '已连接';
  }
});

$('btnDeploy').onclick = () => { $('lobby').classList.add('hidden'); };
$('btnLeave').onclick = () => leaveGame();
$('btnAgain').onclick = () => { $('result').classList.add('hidden'); net.send({ t: 'act', a: 'respawn' }); $('hud').classList.remove('hidden'); G.state = 'playing'; controls.lock(); };
$('btnToMenu').onclick = () => leaveGame();
$('btnChat').onclick = () => {
  const text = prompt('发送消息');
  if (text) net.send({ t: 'chat', text });
};
$('lnkDownload')?.addEventListener('click', () => {});

// 设置面板
$('sens').value = settings.sens;
$('fov').value = settings.fov;
$('vol').value = settings.vol;
$('quality').value = settings.quality;
$('autoFire').checked = !!settings.autoFire;
$('invY').checked = !!settings.invY;
const syncLabels = () => {
  $('vSens').textContent = (+settings.sens).toFixed(2);
  $('vFov').textContent = settings.fov;
  $('vVol').textContent = Math.round(settings.vol * 100) + '%';
};
syncLabels();
$('sens').oninput = (e) => { settings.sens = +e.target.value; controls.setSens(settings.sens); syncLabels(); saveSettings(); };
$('fov').oninput = (e) => { settings.fov = +e.target.value; syncLabels(); saveSettings(); };
$('vol').oninput = (e) => { settings.vol = +e.target.value; Audio.setVolume(settings.vol); syncLabels(); saveSettings(); };
$('quality').onchange = (e) => { settings.quality = e.target.value; applyQuality(settings.quality); saveSettings(); };
$('autoFire').onchange = (e) => { settings.autoFire = e.target.checked; saveSettings(); };
$('invY').onchange = (e) => { settings.invY = e.target.checked; controls.invY = e.target.checked; saveSettings(); };
$('btnSettings').onclick = () => $('settings').classList.remove('hidden');
$('btnCloseSettings').onclick = () => $('settings').classList.add('hidden');

// 点击画面锁鼠标
canvas.addEventListener('click', () => { if (G.state === 'playing' && !controls.touchMode) controls.lock(); });

// ---------------- 舞蹈 / 表情轮盘 ----------------
const emoteWheel = $('emoteWheel');
function emoteList() { return (lobby.L.profile?.emotes || ['wave']); }
function openEmoteWheel() {
  if (G.state !== 'playing') return;
  const list = emoteList();
  emoteWheel.innerHTML = list.map((id) => `<button data-emote-id="${id}">${EMOTE_NAME[id] || id}</button>`).join('')
    + '<button data-emote-id="">取消</button>';
  emoteWheel.classList.remove('hidden');
}
emoteWheel.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const id = b.dataset.emoteId;
  if (id) net.send({ t: 'emote', id });
  emoteWheel.classList.add('hidden');
});
$('btnEmote').onclick = () => (emoteWheel.classList.contains('hidden') ? openEmoteWheel() : emoteWheel.classList.add('hidden'));
addEventListener('keydown', (e) => {
  if (e.code === 'KeyV' && G.state === 'playing') openEmoteWheel();
});

// ---------------- 队伍 HUD ----------------
function updatePartyHud() {
  const party = lobby.L.profile?.party;
  const el = $('partyHud');
  if (!party || G.state === 'menu') { el.innerHTML = ''; return; }
  el.innerHTML = party.members.map((m) => {
    const me = m.name === G.me?.name;
    const shell = me ? { hp: G.hp } : null;
    const dead = me && !G.alive;
    return `<div class="m ${dead ? 'dead' : ''}">${m.name}${m.leader ? ' ★' : ''} ${me ? '（我）' : ''}</div>`;
  }).join('');
}

// ---------------- 武器视图模型（体现皮肤） ----------------
const gunGroup = new THREE.Group();
const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.62), new THREE.MeshStandardMaterial({ color: 0x2a2f33, metalness: .7, roughness: .4 }));
const gunAccent = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.3), new THREE.MeshStandardMaterial({ color: 0xffb347, metalness: .6, roughness: .35 }));
gunAccent.position.set(0, 0.05, -0.02);
gunGroup.add(gunBody, gunAccent);
gunGroup.position.set(0.22, -0.19, -0.42);
camera.add(gunGroup);

function applyWeaponSkin() {
  const eq = lobby.L.profile?.equipped || {};
  const skin = WEAPON_SKINS.find((s) => s.id === (eq[G.weapon] || eq.kr7)) || WEAPON_SKINS[0];
  gunBody.material.color.setHex(skin.color);
  gunAccent.material.color.setHex(skin.accent);
  gunAccent.material.emissive = new THREE.Color(skin.glow ? skin.accent : 0x000000);
  gunBody.visible = G.alive;
  gunGroup.visible = G.state === 'playing' || G.state === 'dead';
}

// ---------------- 房间列表轮询 ----------------
async function refreshRooms() {
  try {
    const r = await fetch('/api/rooms');
    const j = await r.json();
    lobby.setRooms(j.rooms || [], j.motd, j.online, j.announcements);
  } catch {}
}
refreshRooms();
setInterval(refreshRooms, 6000);

updateAmmoUI();
requestAnimationFrame(frame);

// 调试入口
window.__saltline = { G, world, net, settings, controls, lobby, renderer, camera, rootScene };
window.__dbg = {
  renderer, camera, scene: rootScene, world, rendererAttempt,
  snapshot() {
    const info = renderer.info;
    return {
      state: G.state, mode: G.mode && G.mode.id, alive: G.alive, hp: G.hp,
      pos: [G.pos.x, G.pos.y, G.pos.z].map((v) => +v.toFixed(2)),
      yaw: +G.yaw.toFixed(2), ads: +G.ads.toFixed(2),
      players: G.players.size, renders: renderCount,
      triangles: info.render.triangles, calls: info.render.calls,
      programs: info.programs ? info.programs.length : -1, rendererAttempt,
      sceneChildren: rootScene.children.length,
      camPos: camera.position.toArray().map((v) => +v.toFixed(2)),
      quality: settings.quality, touch: controls.touchMode,
      errors: [...reportedErrors].slice(0, 10),
    };
  },
  // 直接从帧缓冲读像素再编码 PNG（比 toDataURL 可靠）
  frame(scale = 1) {
    if (!renderer) return null;
    renderer.render(rootScene, camera);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cw = Math.max(1, Math.floor(w * scale)), ch = Math.max(1, Math.floor(h * scale));
    const c2 = document.createElement('canvas');
    c2.width = cw; c2.height = ch;
    const ctx = c2.getContext('2d');
    const img = ctx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) {
      const srcY = h - 1 - Math.floor(y / scale);
      for (let x = 0; x < cw; x++) {
        const srcX = Math.floor(x / scale);
        const si = (srcY * w + srcX) * 4, di = (y * cw + x) * 4;
        img.data[di] = px[si]; img.data[di + 1] = px[si + 1]; img.data[di + 2] = px[si + 2]; img.data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c2.toDataURL('image/png');
  },
};

// 注册 Service Worker（PWA 安装 / 离线外壳）
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
