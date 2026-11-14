// public/js/net.js — WebSocket 客户端（自动重连、延迟统计）
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.ping = 0;
    this.connected = false;
    this.url = '';
    this.wantClose = false;
  }

  on(kind, fn) {
    if (!this.handlers.has(kind)) this.handlers.set(kind, []);
    this.handlers.get(kind).push(fn);
    return this;
  }

  emit(kind, data) {
    for (const fn of this.handlers.get(kind) || []) {
      try { fn(data); } catch (e) { console.error('[net]', kind, e); }
    }
  }

  static defaultUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect(opts) {
    this.wantClose = false;
    const url = (opts.url && opts.url.trim()) || Net.defaultUrl();
    this.url = url.replace(/^http/, 'ws');
    this.emit('status', { state: 'connecting', url: this.url });
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.emit('status', { state: 'error', error: String(e) });
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.pingStart = performance.now();
      if (opts.auth) {
        const a = opts.auth;
        this.ws.send(JSON.stringify({ t: 'auth', id: a.id || '', token: a.token || '', name: opts.name }));
      }
      if (opts.mode) this.ws.send(JSON.stringify({ t: 'hello', name: opts.name, mode: opts.mode }));
      this.emit('status', { state: 'open', url: this.url });
    };
    this.ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'snap') { this.emit('snap', m); return; }
      if (m.t === 'event') { this.emit('event', m); return; }
      this.emit(m.t || 'msg', m);
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.emit('status', { state: 'closed' });
      if (!this.wantClose) {
        setTimeout(() => { if (!this.wantClose) this.connect(opts); }, 1500);
      }
    };
    this.ws.onerror = () => this.emit('status', { state: 'error' });
  }

  auth(id, token, name) {
    this.send({ t: 'auth', id, token, name });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (this.ws.bufferedAmount > 200000) return;
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.wantClose = true;
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
    this.connected = false;
  }
}
