// public/js/lobby.js — 主界面：公告 / 好友 / 组队 / 商店 / 活动 / 排行榜 / 段位 / 单挑
const $ = (id) => document.getElementById(id);
const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = (s) => String(s || '').slice(5).replace('-', '/');

export function initLobby({ net, settings, saveSettings, play }) {
  const L = {
    profile: null,
    shop: { weapons: [], bodies: [], emotes: [] },
    events: [],
    missions: [],
    shopTab: 'weapons',
    lbTab: 'points',
    leaderboard: [],
    rooms: [],
    announcements: [],
    motd: '',
    duel: { queueing: false, size: 0 },
    dm: [],
  };

  // ---------- 通用 UI ----------
  function toast(text, ms = 2000) {
    const el = document.createElement('div');
    el.className = 'toast on';
    el.style.cssText = 'position:fixed;left:50%;bottom:18%;transform:translateX(-50%);z-index:60;opacity:1';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function rarityTag(r) {
    const map = { common: '普通', rare: '稀有', epic: '史诗', legend: '传说' };
    return `<span class="rar ${r}">${map[r] || r}</span>`;
  }

  function hex(c) { return '#' + (c >>> 0).toString(16).padStart(6, '0'); }

  // ---------- 渲染 ----------
  function renderTop() {
    const p = L.profile;
    $('topName').textContent = p ? p.name : '未登录';
    $('topTier').textContent = p ? p.tier : '—';
    $('topTier').style.color = p?.tierColor || 'var(--signal)';
    $('topCur').textContent = p ? p.currency.toLocaleString() : '0';
  }

  function renderHome() {
    $('homeOnline').textContent = L.profile?.onlineCount ?? L.rooms.reduce((a, r) => a + r.players, 0);
    $('homeRooms').textContent = L.rooms.length;
    const claimed = L.profile?.missions?.claimed?.length || 0;
    $('homeMission').textContent = `${claimed}/${L.missions.length || 5}`;
    $('motdLine').textContent = L.motd || '左舷三号泊位，雨一直在下。';
    $('callsign').value = settings.name || '';
    $('homeNotice').innerHTML = (L.announcements.slice(0, 2).map(noticeHtml).join('')) || '<div class="dim small">暂无公告</div>';
    renderMissions();
    renderRooms();
  }

  function noticeHtml(a) {
    return `<div class="notice"><b>${a.title}</b><p>${a.body}</p><div class="meta">${a.author || 'ADMIN'} · ${fmtTime(a.at)}</div></div>`;
  }

  function renderNotices() {
    $('noticeList').innerHTML = L.announcements.length
      ? L.announcements.map(noticeHtml).join('')
      : '<div class="dim small">暂无公告</div>';
  }

  function renderMissions() {
    const m = L.profile?.missions || { progress: {}, claimed: [] };
    $('missionList').innerHTML = L.missions.map((def) => {
      const prog = Math.min(def.target, m.progress?.[def.id] || 0);
      const done = prog >= def.target;
      const claimed = m.claimed?.includes(def.id);
      return `<div class="mission">
        <b>${def.name}</b>
        <em>${def.desc} · ${prog}/${def.target}</em>
        <span class="price">+${def.reward}</span>
        <button class="btn tiny ${done && !claimed ? 'primary' : 'ghost'}" data-claim="${def.id}" ${claimed ? 'disabled' : ''}>
          ${claimed ? '已领取' : done ? '领取' : '未完成'}
        </button>
      </div>`;
    }).join('') || '<div class="dim small">暂无任务</div>';
  }

  function renderRooms() {
    const html = ['<div class="r head"><span>房间</span><span>模式</span><span>真人</span><span>AI</span><span>状态</span></div>']
      .concat(L.rooms.map((r) => `<div class="r"><span>${r.id}</span><span>${r.modeName}</span><span>${r.players}</span><span>${r.bots}</span>
        <span>${r.state === 'live' ? Math.floor(r.timeLeft / 60) + ':' + String(r.timeLeft % 60).padStart(2, '0') : '结算中'}</span></div>`))
      .join('');
    $('roomList').innerHTML = html;
    $('roomList2').innerHTML = html;
  }

  function renderShop() {
    const list = L.shop[L.shopTab] || [];
    const owned = L.profile ? [...L.profile.skins, ...L.profile.emotes] : [];
    const equipped = L.profile?.equipped || {};
    $('shopGrid').innerHTML = list.map((it) => {
      const isEmote = L.shop.emotes.includes(it);
      const have = owned.includes(it.id);
      const on = isEmote ? false : (equipped[it.weapon] === it.id || equipped.body === it.id);
      const swatch = it.body !== undefined
        ? `background:linear-gradient(120deg,${hex(it.body)},${hex(it.gear)})`
        : `background:linear-gradient(120deg,${hex(it.color)},${hex(it.accent)})`;
      return `<div class="item ${have ? 'owned' : ''} ${on ? 'on' : ''}">
        <div class="swatch" style="${swatch}"></div>
        <b>${it.name}</b>
        <div class="row" style="justify-content:space-between">${rarityTag(it.rarity || 'common')}
          <span class="price">${have ? '已拥有' : it.price.toLocaleString() + ' 港币'}</span></div>
        <button class="btn tiny ${have ? '' : 'primary'}" data-buy="${it.id}" data-emote="${isEmote ? 1 : 0}">
          ${isEmote ? (have ? '使用（V）' : '购买') : have ? (on ? '已装备' : '装备') : '购买'}
        </button>
      </div>`;
    }).join('') || '<div class="dim small">加载中…</div>';
  }

  function renderEvents() {
    $('eventList').innerHTML = (L.events || []).map((e) => `
      <div class="event">
        <h3>${e.name}<span class="tag">${e.tag}</span></h3>
        <p>${e.desc}</p>
        <div class="time">${fmtDay(e.from)} — ${fmtDay(e.to)} · ${e.active ? '进行中' : '未开始/已结束'}</div>
      </div>`).join('') || '<div class="dim small">暂无活动</div>';
  }

  function renderFriends() {
    const p = L.profile;
    if (!p) return;
    $('friendReq').innerHTML = (p.incoming || []).map((f) => `
      <div class="friend-row"><span class="dot"></span><span>${f.name} 请求加好友</span>
      <button class="btn tiny primary" data-accept="${f.id}">接受</button>
      <button class="btn tiny ghost" data-reject="${f.id}">忽略</button></div>`).join('');
    $('friendList').innerHTML = (p.friendsList || []).map((f) => `
      <div class="friend-row">
        <span class="dot ${f.online ? 'on' : ''}"></span>
        <span>${f.name} · <em style="color:${f.tierColor}">${f.tier}</em></span>
        <button class="btn tiny" data-invite-friend="${f.name}">邀请组队</button>
        <button class="btn tiny ghost" data-remove-friend="${f.id}">删除</button>
      </div>`).join('') || '<div class="dim small">还没有好友，输入呼号添加</div>';
    $('dmLog').innerHTML = L.dm.slice(-12).map((d) => `<div>${d.from} → ${d.to}: ${d.text}</div>`).join('');
  }

  function renderParty() {
    const p = L.profile?.party;
    if (!p) {
      $('partyPanel').innerHTML = '<div class="dim small">还没有队伍。创建队伍后可以邀请好友一起匹配，同一队进入同一局。</div>';
      return;
    }
    $('partyPanel').innerHTML = `
      <div class="slot"><b>队码 ${p.id}</b><span>模式 ${p.mode}</span><span>${p.members.length}/4</span></div>
      ${p.members.map((m) => `<div class="slot"><span>${m.name}${m.leader ? '（队长）' : ''} ${m.online ? '' : '· 离线'}</span>
        <span style="color:${m.tierColor}">${m.tier}</span><span>${m.kills} 杀</span></div>`).join('')}
      ${p.invited?.length ? `<div class="dim small">待接受邀请：${p.invited.join('、')}</div>` : ''}`;
  }

  function renderRank() {
    $('lbList').innerHTML = ['<div class="lb-row" style="background:transparent;color:var(--dim)"><span>#</span><span>玩家</span><span>段位</span><span>数值</span></div>']
      .concat((L.leaderboard || []).map((r) => `<div class="lb-row"><span>${r.rank}</span>
        <span>${r.name}${r.online ? ' ·在线' : ''}</span>
        <span style="color:${r.tierColor}">${r.tier}</span><span>${r.value.toLocaleString()}</span></div>`))
      .join('');
  }

  function renderProfilePane() {
    const p = L.profile;
    if (!p) return;
    const per = (v, t) => Math.round(Math.min(1, v / t) * 100);
    const duelTotal = (p.duelWins || 0) + (p.duelLosses || 0);
    $('profileCard').innerHTML = `
      <div class="card-h">${p.name} · <span style="color:${p.tierColor}">${p.tier}</span></div>
      <div class="hero-r" style="justify-content:space-between">
        <div class="stat"><span>段位分</span><b>${p.points}</b></div>
        <div class="stat"><span>击杀</span><b>${p.kills}</b></div>
        <div class="stat"><span>K/D</span><b>${(p.kills / Math.max(1, p.deaths)).toFixed(2)}</b></div>
        <div class="stat"><span>对局</span><b>${p.matches}</b></div>
      </div>
      <div class="hpbar" style="width:100%"><i style="width:${Math.round((p.tierProgress || 0) * 100)}%;background:linear-gradient(90deg,#d2622a,#ffb347)"></i></div>
      <div class="dim small">距离下一段位 ${Math.round((1 - (p.tierProgress || 0)) * 100)}%${p.duelWins !== undefined ? ` · 单挑 ${p.duelWins}胜${p.duelLosses}负（${duelTotal} 场）` : ''}</div>
      <div class="hero-r" style="justify-content:space-between">
        <div class="stat"><span>撤离次数</span><b>${p.extractions}</b></div>
        <div class="stat"><span>撤离总值</span><b>${(p.extractValue || 0).toLocaleString()}</b></div>
        <div class="stat"><span>单次最高</span><b>${(p.bestExtract || 0).toLocaleString()}</b></div>
        <div class="stat"><span>港币</span><b>${p.currency.toLocaleString()}</b></div>
      </div>
      <div class="dim small">签到：连续 ${p.checkin?.streak || 0} 天 · 皮肤 ${p.skins.length} · 表情 ${p.emotes.length} · 好友 ${p.friends}</div>`;
    $('historyList').innerHTML = ['<div class="r head"><span>#</span><span>模式</span><span>K</span><span>D</span><span>收益</span></div>']
      .concat((p.history || []).map((h, i) => `<div class="r"><span>${i + 1}</span>
        <span>${h.mode}${h.win ? ' · 胜' : ''}</span><span>${h.kills}</span><span>${h.deaths}</span><span>+${h.earned}</span></div>`))
      .join('');
    const d = $('duelStat');
    if (d) d.innerHTML = `<span>胜 ${p.duelWins || 0}</span><span>负 ${p.duelLosses || 0}</span><span>段位 ${p.tier}</span>`;
  }

  function renderAll() {
    renderTop(); renderHome(); renderNotices(); renderShop(); renderEvents();
    renderFriends(); renderParty(); renderRank(); renderProfilePane();
  }

  // ---------- 事件绑定 ----------
  function bindTabs() {
    for (const t of document.querySelectorAll('#tabbar .tab')) {
      t.onclick = () => {
        for (const x of document.querySelectorAll('#tabbar .tab')) x.classList.remove('on');
        t.classList.add('on');
        for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.dataset.pane === t.dataset.tab);
        if (t.dataset.tab === 'rank') net.send({ t: 'lb', kind: L.lbTab });
      };
    }
    for (const t of document.querySelectorAll('[data-goto]')) {
      t.onclick = () => document.querySelector(`#tabbar .tab[data-tab="${t.dataset.goto}"]`)?.click();
    }
    for (const t of document.querySelectorAll('#shopTabs .tab')) {
      t.onclick = () => {
        L.shopTab = t.dataset.shop;
        for (const x of document.querySelectorAll('#shopTabs .tab')) x.classList.remove('on');
        t.classList.add('on');
        renderShop();
      };
    }
    for (const t of document.querySelectorAll('#lbTabs .tab')) {
      t.onclick = () => {
        L.lbTab = t.dataset.lb;
        for (const x of document.querySelectorAll('#lbTabs .tab')) x.classList.remove('on');
        t.classList.add('on');
        net.send({ t: 'lb', kind: L.lbTab });
      };
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.claim) net.send({ t: 'mission', k: 'claim', id: d.claim });
    else if (d.buy) {
      const isEmote = d.emote === '1' || d.emote === 'true';   // 注意：属性值是字符串
      const owned = L.profile && [...L.profile.skins, ...L.profile.emotes].includes(d.buy);
      if (!owned) net.send({ t: 'shop', k: 'buy', id: d.buy });
      else if (!isEmote) net.send({ t: 'shop', k: 'equip', id: d.buy });
      else toast('舞蹈表情：进入对局后按 V 使用');
    } else if (d.accept) net.send({ t: 'social', k: 'friendAccept', id: d.accept });
    else if (d.reject) net.send({ t: 'social', k: 'friendRemove', id: d.reject });
    else if (d.removeFriend) net.send({ t: 'social', k: 'friendRemove', id: d.removeFriend });
    else if (d.inviteFriend) net.send({ t: 'social', k: 'partyInvite', name: d.inviteFriend });
  });

  $('serverUrl').value = localStorage.getItem('saltline.server') || '';
  $('serverUrl').oninput = (e) => localStorage.setItem('saltline.server', e.target.value.trim());
  $('callsign').oninput = (e) => { settings.name = e.target.value; saveSettings(); };
  $('btnPlay').onclick = () => { const m = selectedMode(); play(m); };
  $('btnMode').onclick = () => document.querySelector('#tabbar .tab[data-tab="mode"]').click();
  $('btnProfile').onclick = () => document.querySelector('#tabbar .tab[data-tab="profile"]').click();
  $('btnTraining').onclick = () => play('relay');
  $('btnCheckin').onclick = () => net.send({ t: 'mission', k: 'checkin' });

  $('btnFriendAdd').onclick = () => {
    const v = $('friendInput').value.trim();
    if (v) net.send({ t: 'social', k: 'friendAdd', name: v });
  };
  $('btnDm').onclick = () => {
    const n = $('dmName').value.trim(), tx = $('dmText').value.trim();
    if (n && tx) { net.send({ t: 'social', k: 'dm', name: n, text: tx }); L.dm.push({ from: '我', to: n, text: tx }); $('dmText').value = ''; renderFriends(); }
  };
  $('btnPartyCreate').onclick = () => net.send({ t: 'social', k: 'partyCreate' });
  $('btnPartyLeave').onclick = () => net.send({ t: 'social', k: 'partyLeave' });
  $('btnPartyJoin').onclick = () => net.send({ t: 'social', k: 'partyJoin', code: $('partyCode').value.trim() });
  $('btnPartyInvite').onclick = () => net.send({ t: 'social', k: 'partyInvite', name: $('partyInviteName').value.trim() });
  $('partyMode').onchange = (e) => net.send({ t: 'social', k: 'partyMode', mode: e.target.value });
  $('btnPartyQueue').onclick = () => net.send({ t: 'social', k: 'partyQueue', mode: $('partyMode').value });
  $('btnDuel').onclick = () => {
    L.duel.queueing = true;
    $('duelHint').textContent = '正在寻找对手…';
    net.send({ t: 'duel', k: 'queue' });
  };
  $('btnDuelCancel').onclick = () => {
    L.duel.queueing = false;
    $('duelHint').textContent = '已取消';
    net.send({ t: 'duel', k: 'cancel' });
  };

  let selectedModeId = 'extract';
  function selectedMode() { return selectedModeId; }
  function buildModes() {
    const wrap = $('modeList');
    const list = [
      ['extract', '搜打撤', 'EXTRACTION', '搜箱、拿战利品、活着撤离。死了就丢掉身上全部东西。'],
      ['battlefield', '大战场', 'BATTLEFIELD', '两队 16 人抢三个点，票数先耗尽的一方输。可无限复活。'],
      ['duel', '单挑', 'DUEL 1V1', '一对一先赢 3 回合，段位分按胜负结算。'],
      ['relay', '中继破坏', 'RELAY RUN', '雨夜偷港，切断三座上行中继，无人机和机器狗会来找你。'],
    ];
    wrap.innerHTML = list.map(([id, name, en, desc]) => {
      const live = L.rooms.filter((r) => r.mode === id).reduce((a, r) => a + r.players, 0);
      return `<div class="mode ${id === selectedModeId ? 'on' : ''}" data-mode="${id}">
        <em>${en}</em><b>${name}</b><span>${desc}</span><i>${live} 在线</i></div>`;
    }).join('');
    for (const el of wrap.children) {
      el.onclick = () => {
        selectedModeId = el.dataset.mode;
        for (const x of wrap.children) x.classList.remove('on');
        el.classList.add('on');
        if (selectedModeId === 'duel') { document.querySelector('#tabbar .tab[data-tab="duel"]').click(); }
        else { $('btnPlay').textContent = '进入 ' + el.querySelector('b').textContent; }
      };
    }
  }

  // ---------- 网络消息 ----------
  net.on('account', (m) => {
    L.profile = m.profile;
    if (m.announcements) L.announcements = m.announcements;
    if (m.events) L.events = m.events;
    if (m.missions) L.missions = m.missions;
    if (m.shop) L.shop = m.shop;
    if (m.leaderboard) L.leaderboard = m.leaderboard;
    if (m.motd !== undefined) L.motd = m.motd;
    if (m.profile?.name) { settings.name = m.profile.name; saveSettings(); }
    renderAll();
    buildModes();
  });

  net.on('social', (m) => {
    switch (m.k) {
      case 'result':
        if (m.error) toast(m.error);
        else if (m.of === 'shop') toast('操作成功');
        else if (m.of === 'checkin') toast(`签到成功 +${m.reward} 港币（连续 ${m.streak} 天）`);
        else if (m.of === 'mission') toast(`任务奖励 +${m.reward} 港币`);
        else toast('完成');
        break;
      case 'reward': toast(m.text); break;
      case 'settled':
        toast(`对局结算：${m.win ? '胜利' : '结束'} · +${m.earned} 港币 · 段位${m.points >= 0 ? '+' : ''}${m.points}（${m.rank.name}）`, 3200);
        break;
      case 'notice': toast(`【${m.title}】${m.text}`, 4000); break;
      case 'friendRequest':
        toast(`${m.from.name} 请求加好友`);
        net.send({ t: 'social', k: 'refresh' });   // 拉一次档案，请求列表才会出现
        break;
      case 'friendAccepted':
        toast(`${m.by.name} 接受了你的好友请求`);
        net.send({ t: 'social', k: 'refresh' });
        break;
      case 'friendList': if (L.profile) { L.profile.friendsList = m.friends; renderFriends(); } break;
      case 'presence': break;
      case 'partyUpdate': if (L.profile) { L.profile.party = m.party; renderParty(); } break;
      case 'partyInvite': toast(`${m.from.name} 邀请你加入队伍 ${m.party.id}`); break;
      case 'queueing': toast('全队匹配中…'); break;
      case 'partyChat': toast(`[队] ${m.from}: ${m.text}`); break;
      case 'dm': L.dm.push({ from: m.from, to: '我', text: m.text }); renderFriends(); toast(`${m.from}: ${m.text}`); break;
      case 'dmSent': break;
      case 'leaderboard': L.leaderboard = m.list; renderRank(); break;
      case 'duelQueue': $('duelHint').textContent = `排队中（当前 ${m.size} 人 · 段位 ${m.rank}）`; break;
      case 'duelWait': $('duelHint').textContent = m.text; break;
      case 'duelCancel': $('duelHint').textContent = '已取消匹配'; break;
      case 'profile': $('profileCard').innerHTML = `<div class="card-h">${m.profile.name} 的档案</div>
        <div class="dim small">段位 ${m.profile.tier} · 击杀 ${m.profile.kills} · 对局 ${m.profile.matches} · 撤离总值 ${m.profile.extractValue}</div>`; break;
      case 'motd': L.motd = m.motd; renderHome(); break;
    }
  });

  net.on('banned', () => toast('该账号已被封禁', 6000));

  // 启动时绑定页签 / 子页签
  bindTabs();

  // ---------- 对外 ----------
  return {
    L,
    renderAll,
    buildModes,
    renderRooms,
    setRooms(rooms, motd, onlineCount, announcements) {
      L.rooms = rooms || [];
      if (motd !== undefined) L.motd = motd;
      if (onlineCount !== undefined) L.profile && (L.profile.onlineCount = onlineCount);
      if (announcements) L.announcements = announcements;
      renderHome(); renderNotices(); buildModes();
    },
    toast,
  };
}
