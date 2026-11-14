// public/js/world3d.js — 把共享地图数据渲染成雨夜港口
import * as THREE from '../vendor/three.module.js';
import { WORLD, BOUNDS, SEA_Y, RELAYS, CP, EXTRACTS } from '../../shared/world.js';

const COL = {
  zenith: 0x101c26, horizon: 0x6d4526, fog: 0x4a4f55,
  ground: 0x3a4046, sea: 0x16232c, steel: 0x8d9aa3, signal: 0xffb347, alarm: 0xff5a40, blue: 0x5aa9ff,
};

const CONTAINER_TONES = [0x8c3b2a, 0x2f5a4a, 0x33465a, 0x6b5a2a, 0x4b4f55, 0x7a3b3b, 0x2b4a5a];

export class World3D {
  constructor(renderer, quality = 'medium') {
    this.quality = quality;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(COL.fog, quality === 'low' ? 0.012 : 0.009);
    this.scene.background = new THREE.Color(COL.zenith);
    this.time = 0;
    this.animated = [];
    this.pointLights = [];

    this.buildLights();
    this.buildGround();
    this.buildSea();
    this.buildContainers();
    this.buildStructures();
    this.buildRelays();
    this.buildCapturePoints();
    this.buildExtracts();
    this.buildLamps();
    this.buildRain();
    this.buildSky();
  }

  buildLights() {
    const hemi = new THREE.HemisphereLight(0x4f6d80, 0x2a231c, 1.5);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffc98c, 1.9);
    key.position.set(-40, 48, -22);
    if (this.quality === 'high') {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      const c = key.shadow.camera;
      c.left = -80; c.right = 80; c.top = 80; c.bottom = -80; c.near = 1; c.far = 220;
      key.shadow.bias = -0.0012;
    }
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x6d94ad, 0.9);
    fill.position.set(50, 20, 40);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0x4a525c, 1.15));
  }

  buildGround() {
    const w = BOUNDS.maxX - BOUNDS.minX + 80;
    const d = BOUNDS.maxZ - BOUNDS.minZ + 80;
    const geo = new THREE.PlaneGeometry(w, d, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: COL.ground, roughness: 0.36, metalness: 0.2,
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.position.set((BOUNDS.minX + BOUNDS.maxX) / 2, 0, (BOUNDS.minZ + BOUNDS.maxZ) / 2);
    ground.receiveShadow = this.quality === 'high';
    this.scene.add(ground);

    // 集装箱区的网格线（低多边形地面细节）
    const lines = new THREE.Group();
    const lineMat = new THREE.MeshStandardMaterial({ color: 0x3b4248, roughness: .8 });
    for (let x = BOUNDS.minX; x <= BOUNDS.maxX; x += 24) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, d), lineMat);
      m.position.set(x, 0.03, 0); lines.add(m);
    }
    this.scene.add(lines);

    // 水洼
    const puddleMat = new THREE.MeshStandardMaterial({
      color: 0x11181d, roughness: 0.06, metalness: 0.9, transparent: true, opacity: 0.85,
    });
    const puddles = new THREE.Group();
    for (let i = 0; i < 26; i++) {
      const r = 1.4 + Math.random() * 3.4;
      const p = new THREE.Mesh(new THREE.CircleGeometry(r, 12), puddleMat);
      p.rotation.x = -Math.PI / 2;
      p.position.set(BOUNDS.minX + Math.random() * (BOUNDS.maxX - BOUNDS.minX), 0.02,
        BOUNDS.minZ + Math.random() * (BOUNDS.maxZ - BOUNDS.minZ));
      puddles.add(p);
    }
    this.scene.add(puddles);
  }

  buildSea() {
    const geo = new THREE.PlaneGeometry(220, 220, 24, 24);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: COL.sea, roughness: 0.14, metalness: 0.75, transparent: true, opacity: 0.96,
    });
    const sea = new THREE.Mesh(geo, mat);
    sea.position.set(-160, SEA_Y, 0);
    this.scene.add(sea);
    this.sea = sea;
    const base = geo.attributes.position.array.slice();
    this.seaBase = base;
    this.animated.push((dt, t) => {
      const arr = geo.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = base[i], z = base[i + 2];
        arr[i + 1] = Math.sin((x + t * 0.7) * 0.12) * 0.28 + Math.cos((z - t * 0.5) * 0.16) * 0.22;
      }
      geo.attributes.position.needsUpdate = true;
    });
  }

  buildContainers() {
    const list = WORLD.containers;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.34 });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.castShadow = this.quality === 'high';
    mesh.receiveShadow = this.quality === 'high';
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    list.forEach((c, i) => {
      const sx = c.rot ? 2.44 : 12.2, sz = c.rot ? 12.2 : 2.44;
      m.compose(new THREE.Vector3(c.x, c.y, c.z), q, new THREE.Vector3(sx, 2.59, sz));
      mesh.setMatrixAt(i, m);
      const tone = CONTAINER_TONES[Math.floor(c.tone * CONTAINER_TONES.length) % CONTAINER_TONES.length];
      col.setHex(tone).multiplyScalar(1.15 + (i % 5) * 0.06);
      mesh.setColorAt(i, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
  }

  buildStructures() {
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a5158, roughness: .55, metalness: .5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: .8 });
    const W = WORLD.WAREHOUSE;

    const mkBox = (x, y, z, sx, sy, sz, mat) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      b.position.set(x, y, z);
      b.castShadow = this.quality !== 'low'; b.receiveShadow = this.quality !== 'low';
      this.scene.add(b); return b;
    };

    mkBox(W.x, W.h / 2, W.z - W.d / 2, W.w, W.h, 0.4, steel);
    mkBox(W.x, W.h / 2, W.z + W.d / 2, W.w, W.h, 0.4, steel);
    mkBox(W.x - W.w / 2, W.h / 2, W.z, 0.4, W.h, W.d, steel);
    mkBox(W.x + W.w / 2, W.h / 2, W.z, 0.4, W.h, W.d, steel);
    mkBox(W.x, W.h, W.z, W.w, 0.5, W.d, dark);

    // 控制塔
    mkBox(58, 9, 40, 9, 18, 9, steel);
    mkBox(58, 18.4, 40, 10, 0.8, 10, dark);

    // 码头矮墙 + 围栏
    for (let z = -50; z <= 50; z += 10) mkBox(-51, 0.6, z, 1, 1.2, 8, dark);
    mkBox(8, 1.2, -53.4, 120, 2.4, 0.6, dark);
    mkBox(8, 1.2, 53.4, 120, 2.4, 0.6, dark);

    // 零散掩体
    for (let i = 0; i < 14; i++) {
      const x = BOUNDS.minX + 6 + Math.random() * (BOUNDS.maxX - BOUNDS.minX - 12);
      const z = BOUNDS.minZ + 6 + Math.random() * (BOUNDS.maxZ - BOUNDS.minZ - 12);
      mkBox(x, 0.6, z, 1.8 + Math.random() * 2, 1.2, 1.2 + Math.random(), dark);
    }
  }

  buildRelays() {
    this.relays = [];
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x6a737a, roughness: .4, metalness: .7 });
    const bulbOn = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff8c1a, emissiveIntensity: 3 });
    const bulbOff = new THREE.MeshStandardMaterial({ color: 0x441111, emissive: 0x220000, emissiveIntensity: .3 });
    for (const r of RELAYS) {
      const g = new THREE.Group();
      g.position.set(r.x, 0, r.z);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, r.y * 2 + 2, 8), mastMat);
      mast.position.y = r.y;
      g.add(mast);
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.6), mastMat);
      base.position.y = 0.25; g.add(base);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), bulbOn);
      bulb.position.y = r.y * 2 + 2.4; g.add(bulb);
      let light = null;
      if (this.quality !== 'low') {
        light = new THREE.PointLight(0xffa040, 2.2, 18);
        light.position.y = r.y * 2 + 2.4; g.add(light);
        this.pointLights.push(light);
      }
      this.scene.add(g);
      this.relays.push({ id: r.id, group: g, bulb, light, onMat: bulbOn, offMat: bulbOff, down: false, hp: 100 });
    }
  }

  setRelays(list) {
    for (const s of list || []) {
      const r = this.relays.find((x) => x.id === s[0]);
      if (!r) continue;
      r.hp = s[1];
      const down = !!s[2];
      if (down !== r.down) {
        r.down = down;
        r.bulb.material = down ? r.offMat : r.onMat;
        if (r.light) r.light.intensity = down ? 0 : 2.2;
      }
    }
  }

  buildCapturePoints() {
    this.cps = [];
    const mk = (c) => {
      const g = new THREE.Group();
      g.position.set(c.x, 0, c.z);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(c.r - 0.5, c.r, 40),
        new THREE.MeshBasicMaterial({ color: 0xdcd6c8, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1;
      g.add(ring);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 6, 6),
        new THREE.MeshStandardMaterial({ color: 0x555c62 }));
      pole.position.y = 3; g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1),
        new THREE.MeshBasicMaterial({ color: 0xdcd6c8, side: THREE.DoubleSide }));
      flag.position.set(0.8, 5.4, 0); g.add(flag);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(c.r * 0.9, c.r * 0.55, 30, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
      );
      beam.position.y = 15; g.add(beam);
      this.scene.add(g);
      return { id: c.id, group: g, ring, flag, beam };
    };
    this.cps = CP.map(mk);
  }

  setCP(list) {
    for (const s of list || []) {
      const c = this.cps.find((x) => x.id === s[0]);
      if (!c) continue;
      const owner = s[1];
      const color = owner === 1 ? COL.blue : owner === 2 ? COL.alarm : 0xdcd6c8;
      c.ring.material.color.setHex(color);
      c.flag.material.color.setHex(color);
      c.beam.material.color.setHex(color);
      c.ring.material.opacity = owner ? 0.6 : 0.3;
    }
  }

  buildExtracts() {
    this.extracts = EXTRACTS.map((e) => {
      const g = new THREE.Group();
      g.position.set(e.x, 0, e.z);
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(e.r, e.r, 0.12, 24),
        new THREE.MeshBasicMaterial({ color: 0x7ddc8a, transparent: true, opacity: 0.16 }),
      );
      cyl.position.y = 0.06; g.add(cyl);
      const ring = new THREE.Mesh(new THREE.RingGeometry(e.r * 0.9, e.r, 32),
        new THREE.MeshBasicMaterial({ color: 0x7ddc8a, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.14; g.add(ring);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(e.r * 0.7, e.r * 0.95, 16, 14, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x7ddc8a, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }),
      );
      beam.position.y = 8; g.add(beam);
      this.scene.add(g);
      return { id: e.id, group: g, ring, beam };
    });
  }

  buildLamps() {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: .7 });
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff0cc, emissive: 0xffcc88, emissiveIntensity: 4 });
    const spots = [[-40, -30], [-10, 20], [22, -34], [46, 10], [8, 46], [-30, 2]];
    for (const [x, z] of spots) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 9, 6), poleMat);
      pole.position.set(x, 4.5, z); this.scene.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 0.12), poleMat);
      arm.position.set(x + 0.8, 9, z); this.scene.add(arm);
      const head = new THREE.Mesh(new THREE.BoxGeometry(1, 0.24, 0.6), bulbMat);
      head.position.set(x + 1.5, 8.9, z); this.scene.add(head);
      if (this.quality !== 'low' && this.pointLights.length < 5) {
        const l = new THREE.PointLight(0xffcf9a, 4.2, 30, 2);
        l.position.set(x + 1.5, 8.6, z);
        this.scene.add(l);
        this.pointLights.push(l);
      }
    }
  }

  buildRain() {
    const n = this.quality === 'low' ? 1400 : this.quality === 'high' ? 6000 : 3200;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 140;
      pos[i * 3 + 1] = Math.random() * 40;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 140;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xbfd0da, size: 0.09, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true,
    });
    this.rain = new THREE.Points(geo, mat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  buildSky() {
    const geo = new THREE.SphereGeometry(400, 16, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(COL.zenith) }, bot: { value: new THREE.Color(COL.horizon) } },
      vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float h; uniform vec3 top; uniform vec3 bot; void main(){ gl_FragColor = vec4(mix(bot, top, clamp(h*0.5+0.45,0.0,1.0)), 1.0); }',
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  setSafeMode() {
    this.quality = 'low';
    for (const l of this.pointLights) { try { l.parent && l.parent.remove(l); } catch {} }
    this.pointLights.length = 0;
    if (this.scene.fog) this.scene.fog.density = 0.01;
    this.scene.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    this.scene.add(new THREE.AmbientLight(0x8899aa, 1.2));
    return true;
  }

  update(dt, camera) {
    this.time += dt;
    for (const f of this.animated) f(dt, this.time);
    if (this.rain) {
      const arr = this.rain.geometry.attributes.position.array;
      const fall = 26 * dt;
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] -= fall;
        if (arr[i] < 0) arr[i] += 40;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.position.set(camera.position.x, 0, camera.position.z);
    }
    if (this.sky) this.sky.position.copy(camera.position);
    // 中继灯呼吸
    for (const r of this.relays) {
      if (!r.down) r.bulb.material.emissiveIntensity = 2.4 + Math.sin(this.time * 3 + r.group.position.x) * 1.2;
    }
  }
}
