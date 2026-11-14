// public/admin/admin.js — 管理后台前端
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
let data = null;

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && path !== '/api/admin/login') { showLogin(); return { error: '未登录' }; }
  try { return await r.json(); } catch { return {}; }
}

function showLogin() {
  $('login').classList.remove('hidden');
  $('top').classList.add('hidden');
  $('main').classList.add('hidden');
}
function showMain() {
  $('login').classList.add('hidden');
  $('top').classList.remove('hidden');
  $('main').classList.remove('hidden');
}

$('btnLogin').onclick = async () => {
  const r = await api('/api/admin/login', { password: $('pw').value });
  if (r.ok) { showMain(); refresh(); connectStream(); }
  else $('loginHint').textContent = r.error || '登录失败';
};
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnLogin').click(); });
$('btnLogout').onclick = async () => { await api('/api/admin/logout', {}); showLogin(); };
$('btnRefresh').onclick = refresh;

// ---------------- 渲染 ----------------
function kpis(h) {
  const items = [
    ['运行时长', fmtDur(h.up)], ['在线账号', h.wsClients], ['对局内真人', h.humans],
    ['房间数', h.rooms], ['Tick 耗时', h.tickMs + ' ms'], ['峰值在线', h.peakOnline],
    ['内存', h.memMB + ' MB'], ['负载', h.load.toFixed(2) + ' / ' + h.cpus + '核'], ['Node', h.node],
  ];
  $('kpis').innerHTML = items.map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join('');
}
const fmtDur = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;

function rooms(list) {
  $('rooms').innerHTML = '<tr><th>房间</th><th>模式</th><th>真人</th><th>AI</th><th>状态</th><th>剩余</th><th>操作</th></tr>'
    + list.map((r) => `<tr>
      <td>${esc(r.id)}</td><td>${esc(r.modeName)}</td><td>${r.players}</td><td>${r.bots}</td>
      <td>${r.state === 'live' ? '进行中' : '已结束'}</td><td>${Math.floor(r.timeLeft / 60)}:${String(r.timeLeft % 60).padStart(2, '0')}</td>
      <td>
        <button class="tiny" data-view="${r.id}">查看</button>
        <button class="tiny" data-end="${r.id}">结束</button>
        <button class="tiny" data-reset="${r.id}">重开</button>
        <button class="tiny danger" data-close="${r.id}">关闭</button>
      </td></tr>`).join('') || '<tr><td class="hint">暂无房间</td></tr>';
}

function accounts(list) {
  const q = ($('accSearch').value || '').toLowerCase();
  const rows = list.filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q));
  $('accounts').innerHTML = '<tr><th>呼号</th><th>港币</th><th>段位分</th><th>K/D</th><th>对局</th><th>状态</th><th>操作</th></tr>'
    + rows.map((a) => `<tr>
      <td title="${esc(a.id)}">${esc(a.name)}</td><td>${a.currency.toLocaleString()}</td><td>${a.points}</td>
      <td>${a.kills}/${a.deaths}</td><td>${a.matches}</td>
      <td>${a.banned ? '<span style="color:var(--alarm)">封禁</span>' : a.online ? '<span style="color:var(--ok)">在线</span>' : '<span class="hint">离线</span>'}</td>
      <td>
        <button class="tiny" data-grant="${a.id}">发钱</button>
        ${a.banned ? `<button class="tiny" data-unban="${a.id}">解封</button>` : `<button class="tiny danger" data-ban="${a.id}">封禁</button>`}
      </td></tr>`).join('') || '<tr><td class="hint">没有匹配账号</td></tr>';
}

function render(d) {
  data = d;
  kpis(d.health);
  $('verTag').textContent = '账号 ' + d.store.accounts + ' · 在线 ' + d.store.online;
  $('motd').value = d.config?.motd || '';
  rooms(d.rooms);
  accounts(d.accounts);
  clientErrors(d.clientErrors);
  $('anList').innerHTML = d.announcements.map((a) => `
    <div class="card" style="margin-bottom:6px">
      <b>${esc(a.title)}</b> <span class="hint">${new Date(a.at).toLocaleString('zh-CN')}</span>
      <div class="hint">${esc(a.body)}</div>
      <button class="tiny danger" data-delann="${a.id}">删除</button>
    </div>`).join('') || '<div class="hint">暂无公告</div>';
  $('banList').innerHTML = d.bans.map((ip) => `<div class="row"><span class="tag">${esc(ip)}</span>
    <button class="tiny" data-unbanip="${esc(ip)}">解除</button></div>`).join('') || '<div class="hint">没有封禁记录</div>';
  $('lb').innerHTML = '<tr><th>#</th><th>玩家</th><th>段位</th><th>段位分</th><th>击杀</th></tr>'
    + d.leaderboard.points.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.name)}</td>
      <td style="color:${r.tierColor}">${esc(r.tier)}</td><td>${r.value}</td><td>${r.kills}</td></tr>`).join('');
}

function clientErrors(list) {
  $('clientErrors').innerHTML = (list || []).map((e) => `
    <div class="card" style="margin-bottom:6px">
      <b>${esc(e.kind)}</b> <span class="hint">${new Date(e.at).toLocaleTimeString('zh-CN')} · ${esc(e.player || '')} · ${esc(e.state || '')}</span>
      <div class="hint">${esc(e.message)}</div>
      ${e.viewport ? `<div class="hint">${esc(e.viewport)} · q=${esc(e.quality || '')} · ${esc(e.ua || '').slice(0, 60)}</div>` : ''}
      ${e.stack ? `<pre style="white-space:pre-wrap;font-size:10.5px;max-height:80px;overflow:auto;color:#f0a">${esc(e.stack)}</pre>` : ''}
    </div>`).join('') || '<div class="hint">暂无</div>';
}

function roomDetail(d) {
  if (!d) return;
  $('roomPick').textContent = d.id + ' · ' + d.modeName;
  $('roomDetail').innerHTML = `<table>
    <tr><th>#</th><th>呼号</th><th>阵营</th><th>HP</th><th>K/D</th><th>位置</th><th>状态</th><th>操作</th></tr>
    ${d.players.map((p) => `<tr>
      <td>${p.id}</td><td>${esc(p.name)}${p.bot ? ' <span class="tag">AI</span>' : ''}</td>
      <td>${p.team === 1 ? '蓝' : p.team === 2 ? '红' : 'AI'}</td><td>${p.hp}</td><td>${p.kills}/${p.deaths}</td>
      <td>${p.pos.join(',')}</td><td>${p.alive ? '存活' : '阵亡'}</td>
      <td>${p.bot ? '' : `<button class="tiny danger" data-kick="${d.id}:${p.id}">踢出</button>`}</td>
    </tr>`).join('')}</table>`;
}

// ---------------- 事件 ----------------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.view) { const r = await api('/api/admin/room?id=' + encodeURIComponent(d.view)); roomDetail(r.room); }
  else if (d.end) await act({ do: 'end_round', room: d.end });
  else if (d.reset) await act({ do: 'reset_room', room: d.reset });
  else if (d.close) { if (confirm('关闭房间 ' + d.close + '？')) await act({ do: 'close_room', room: d.close }); }
  else if (d.kick) { const [room, id] = d.kick.split(':'); await act({ do: 'kick', room, id }); refresh(); }
  else if (d.grant) {
    const amt = prompt('发放多少港币？', '1000');
    if (amt) await act({ do: 'grant', id: d.grant, amount: Number(amt) });
  } else if (d.ban) { if (confirm('封禁该账号？')) await act({ do: 'ban_account', id: d.ban }); }
  else if (d.unban) await act({ do: 'unban_account', id: d.unban });
  else if (d.unbanip) await act({ do: 'unban_ip', ip: d.unbanip });
  else if (d.delann) await act({ do: 'delete_announcement', id: d.delann });
});

async function act(payload) {
  const r = await api('/api/admin/action', payload);
  if (r.error) alert(r.error);
  refresh();
}

$('btnBroadcast').onclick = () => { if ($('bcText').value.trim()) act({ do: 'broadcast', text: $('bcText').value.trim() }); };
$('btnAnnounce').onclick = () => {
  if (!$('anTitle').value.trim()) return alert('请填写标题');
  act({ do: 'announce', title: $('anTitle').value.trim(), body: $('anBody').value.trim() });
  $('anTitle').value = ''; $('anBody').value = '';
};
$('btnBanIp').onclick = () => { if ($('banIp').value.trim()) act({ do: 'ban_ip', ip: $('banIp').value.trim() }); };
$('btnGrant').onclick = () => act({ do: 'grant', id: $('grantId').value.trim(), amount: Number($('grantAmt').value || 0) });
$('btnNewRoom').onclick = () => act({ do: 'create_room', mode: $('newRoomMode').value });
$('btnMotd').onclick = () => act({ do: 'set_config', motd: $('motd').value });
$('btnAccSearch').onclick = () => accounts(data?.accounts || []);
$('accSearch').addEventListener('input', () => accounts(data?.accounts || []));
$('btnPw').onclick = () => { if ($('newPw').value.length >= 4) { act({ do: 'reset_password', password: $('newPw').value }); $('newPw').value = ''; } else alert('至少 4 位'); };

async function refresh() {
  const d = await api('/api/admin/data');
  if (d.error) return;
  render(d);
}

// ---------------- 实时日志 ----------------
function connectStream() {
  try {
    const es = new EventSource('/api/admin/stream');
    es.onopen = () => { $('connTag').textContent = '实时日志：已连接'; };
    es.onerror = () => { $('connTag').textContent = '实时日志：重连中…'; };
    es.onmessage = (ev) => {
      const line = JSON.parse(ev.data);
      const el = document.createElement('div');
      el.className = 'k-' + (line.kind || 'info');
      el.textContent = `[${new Date(line.t).toLocaleTimeString('zh-CN')}] ${line.text}`;
      $('logs').prepend(el);
      while ($('logs').children.length > 300) $('logs').lastChild.remove();
    };
  } catch {}
}

// 启动
(async () => {
  const s = await api('/api/admin/session');
  if (s.ok) { showMain(); refresh(); connectStream(); setInterval(refresh, 5000); }
  else showLogin();
})();
