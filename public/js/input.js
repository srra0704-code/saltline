// public/js/input.js — 键鼠 + 触屏双摇杆，统一成一份输入状态
export class Controls {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.sens = opts.sens ?? 1;
    this.invY = opts.invY ?? false;
    this.touchMode = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    this.yaw = 0; this.pitch = 0;
    this.moveX = 0; this.moveZ = 0;
    this.fire = false; this.ads = false; this.crouch = false; this.sprint = false;
    this.pressed = { reload: false, jump: false, interact: false };
    this.locked = false;
    this.enabled = false;
    this.autoFire = false;
    this.aimAssist = false;
    this._keys = new Set();
    this._bind();
    if (this.touchMode) document.body.classList.add('touch-on');
    else document.body.classList.add('no-touch');
  }

  setSens(v) { this.sens = v; }

  lock() {
    if (this.touchMode) { this.enabled = true; return; }
    this.canvas.requestPointerLock?.();
    this.enabled = true;
  }

  unlock() {
    this.enabled = false;
    this.fire = false; this.ads = false;
    this._keys.clear();
    this.moveX = this.moveZ = 0;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  consume(name) {
    if (this.pressed[name]) { this.pressed[name] = false; return true; }
    return false;
  }

  _bind() {
    const c = this.canvas;

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.code;
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyE', 'KeyC', 'ShiftLeft'].includes(k)) e.preventDefault();
      this._keys.add(k);
      if (k === 'KeyR') this.pressed.reload = true;
      if (k === 'KeyE') this.pressed.interact = true;
      if (k === 'Space') this.pressed.jump = true;
      if (k === 'KeyC') this.crouch = !this.crouch;
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));

    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || this.touchMode || !document.pointerLockElement) return;
      this.yaw -= e.movementX * 0.0022 * this.sens;
      this.pitch -= (this.invY ? -1 : 1) * e.movementY * 0.0022 * this.sens;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.touchMode) return;
      if (e.button === 0) {
        if (!document.pointerLockElement) { this.lock(); return; }
        this.fire = true;
      }
      if (e.button === 2) this.ads = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.ads = false;
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => { this.locked = !!document.pointerLockElement; });

    // ---- 触屏 ----
    const mkStick = (el, onMove) => {
      let id = null, cx = 0, cy = 0, R = 1;
      const knob = el.querySelector('i');
      el.addEventListener('touchstart', (ev) => {
        const t = ev.changedTouches[0];
        id = t.identifier;
        const r = el.getBoundingClientRect();
        cx = r.left + r.width / 2; cy = r.top + r.height / 2; R = r.width * 0.42;
        onMove(0, 0, knob);
        ev.preventDefault();
      }, { passive: false });
      el.addEventListener('touchmove', (ev) => {
        for (const t of ev.changedTouches) {
          if (t.identifier !== id) continue;
          let dx = t.clientX - cx, dy = t.clientY - cy;
          const len = Math.hypot(dx, dy) || 1;
          const cl = Math.min(len, R);
          const nx = (dx / len) * cl, ny = (dy / len) * cl;
          knob.style.transform = `translate(${nx}px,${ny}px)`;
          onMove(nx / R, ny / R, knob);
        }
        ev.preventDefault();
      }, { passive: false });
      const end = (ev) => {
        for (const t of ev.changedTouches) if (t.identifier === id) {
          id = null; knob.style.transform = ''; onMove(0, 0, knob);
        }
      };
      el.addEventListener('touchend', end);
      el.addEventListener('touchcancel', end);
    };

    const stickL = document.getElementById('stickL');
    const stickR = document.getElementById('stickR');
    if (stickL) mkStick(stickL, (x, y) => {
      this.moveX = Math.max(-1, Math.min(1, x * 1.1));
      this.moveZ = Math.max(-1, Math.min(1, -y * 1.1));
      const l = Math.hypot(this.moveX, this.moveZ);
      this.sprint = l > 0.92;
    });
    if (stickR) mkStick(stickR, (x, y) => {
      if (!this.enabled) return;
      this.yaw -= x * 0.055 * this.sens;
      this.pitch -= (this.invY ? -1 : 1) * y * 0.045 * this.sens;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    });

    // 右侧空白拖动也可转视角
    let lookId = null, lastX = 0, lastY = 0;
    c.addEventListener('touchstart', (ev) => {
      const t = ev.changedTouches[0];
      if (t.clientX < window.innerWidth * 0.35) return;
      lookId = t.identifier; lastX = t.clientX; lastY = t.clientY;
    }, { passive: true });
    c.addEventListener('touchmove', (ev) => {
      for (const t of ev.changedTouches) {
        if (t.identifier !== lookId) continue;
        const dx = t.clientX - lastX, dy = t.clientY - lastY;
        lastX = t.clientX; lastY = t.clientY;
        this.yaw -= dx * 0.006 * this.sens;
        this.pitch -= (this.invY ? -1 : 1) * dy * 0.005 * this.sens;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
      }
    }, { passive: true });
    const lookEnd = (ev) => {
      for (const t of ev.changedTouches) if (t.identifier === lookId) lookId = null;
    };
    c.addEventListener('touchend', lookEnd);
    c.addEventListener('touchcancel', lookEnd);

    // 触屏按钮
    for (const btn of document.querySelectorAll('.tb')) {
      const act = btn.dataset.act;
      const on = (e) => {
        e.preventDefault();
        btn.classList.add('on');
        if (act === 'fire') this.fire = true;
        if (act === 'ads') this.ads = true;
        if (act === 'reload') this.pressed.reload = true;
        if (act === 'jump') this.pressed.jump = true;
        if (act === 'interact') this.pressed.interact = true;
        if (act === 'crouch') this.crouch = !this.crouch;
        if (act === 'sprint') this.sprint = true;
      };
      const off = (e) => {
        e.preventDefault();
        btn.classList.remove('on');
        if (act === 'fire') this.fire = false;
        if (act === 'ads') this.ads = false;
        if (act === 'sprint') this.sprint = false;
      };
      btn.addEventListener('touchstart', on, { passive: false });
      btn.addEventListener('touchend', off);
      btn.addEventListener('touchcancel', off);
      btn.addEventListener('mousedown', on);
      btn.addEventListener('mouseup', off);
    }
  }

  sample() {
    if (!this.touchMode) {
      let mx = 0, mz = 0;
      if (this._keys.has('KeyW')) mz += 1;
      if (this._keys.has('KeyS')) mz -= 1;
      if (this._keys.has('KeyA')) mx -= 1;
      if (this._keys.has('KeyD')) mx += 1;
      this.moveX = mx; this.moveZ = mz;
      this.sprint = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight');
    }
    return {
      yaw: this.yaw, pitch: this.pitch,
      mx: this.moveX, mz: this.moveZ,
      fire: this.fire, ads: this.ads, crouch: this.crouch, sprint: this.sprint,
    };
  }
}
