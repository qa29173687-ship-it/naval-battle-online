// 海戰棋 前端
'use strict';
const $ = s => document.querySelector(s);
const N = 8, FLEET = [4, 3, 3, 2], COLS = 'ABCDEFGH';
let ws, myId, S = null;            // S = 伺服器傳來的個人化狀態
let deadlineAt = 0;
let place = { ships: [null, null, null, null], sel: 0, dir: 'h', sent: false };
let targetId = null, aim = null, lastRoundSeen = 0, lastPhase = null, showReveal = false;

// ---------- 連線 ----------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'hello') myId = m.id;
    else if (m.t === 'state') onState(m.s);
    else if (m.t === 'error') toast('⚠️ ' + m.msg);
    else if (m.t === 'left') { S = null; show('lobby'); }
  };
  ws.onclose = () => $('#conn').classList.remove('hidden');
  setInterval(() => ws.readyState === 1 && ws.send('{"t":"ping"}'), 20000);
}
const send = o => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

// ---------- 共用 ----------
function show(id) { for (const s of ['lobby', 'room', 'game']) $('#' + s).classList.toggle('hidden', s !== id); }
let toastT;
function toast(html, ms = 2600) { const t = $('#toast'); t.innerHTML = html; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms); }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const P = id => S && S.players.find(p => p.id === id);
function cellsOf(s, len) { const o = []; for (let i = 0; i < len; i++) o.push(s.dir === 'h' ? [s.r, s.c + i] : [s.r + i, s.c]); return o; }
function at(el, r, c, w = 1, h = 1) { el.style.gridRow = `${r + 1} / span ${h}`; el.style.gridColumn = `${c + 1} / span ${w}`; return el; }
function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }
function labels() {
  for (const id of ['#colLabels', '#tcols']) $(id).innerHTML = [...COLS].map(c => `<span>${c}</span>`).join('');
  for (const id of ['#rowLabels', '#trows']) $(id).innerHTML = Array.from({ length: N }, (_, i) => `<span>${i + 1}</span>`).join('');
}

// ---------- 大廳 ----------
$('#nick').value = localStorage.getItem('nb_nick') || '';
const qRoom = new URLSearchParams(location.search).get('room');
if (qRoom) $('#joinCode').value = qRoom.toUpperCase();
function nick() { const n = $('#nick').value.trim(); if (!n) { toast('請先輸入暱稱'); $('#nick').focus(); return null; } localStorage.setItem('nb_nick', n); return n; }
$('#btnCreate').onclick = () => { const n = nick(); if (n) send({ t: 'create', name: n }); };
$('#btnJoin').onclick = () => { const n = nick(); const c = $('#joinCode').value.trim(); if (!n) return; if (!c) return toast('請輸入房號'); send({ t: 'join', code: c, name: n }); };
$('#btnStart').onclick = () => send({ t: 'start' });
$('#btnLeave').onclick = $('#btnExit').onclick = () => { send({ t: 'leave' }); $('#over').classList.add('hidden'); };
$('#btnShare').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('已複製邀請連結'); } catch { prompt('複製這個連結給朋友', url); }
};
$('#btnRematch').onclick = () => send({ t: 'rematch' });
$('#btnViewBoard').onclick = () => { showReveal = true; $('#over').classList.add('hidden'); renderGame(); };

// ---------- 狀態更新 ----------
function onState(s) {
  const prev = S; S = s;
  deadlineAt = Date.now() + s.remainMs;
  if (s.phase !== lastPhase) {
    if (s.phase === 'placing') { place = { ships: [null, null, null, null], sel: 0, dir: 'h', sent: false }; targetId = null; aim = null; lastRoundSeen = 0; showReveal = false; }
    if (s.phase === 'over') renderOver();
    if (s.phase === 'over') setTimeout(() => S && S.phase === 'over' && !showReveal && $('#over').classList.remove('hidden'), 1200);
    if (s.phase === 'lobby') $('#over').classList.add('hidden');
    lastPhase = s.phase;
  }
  if (s.phase === 'lobby') { renderRoom(); show('room'); return; }
  show('game');
  if (s.phase === 'battle' || s.phase === 'over') {
    const opps = s.players.filter(p => p.id !== myId && p.alive);
    if (!P(targetId) || !P(targetId).alive && s.phase === 'battle') targetId = opps.length ? opps[0].id : null;
    if (s.me && s.me.pending) aim = { r: s.me.pending.r, c: s.me.pending.c };
    if (s.lastRound && s.lastRound.round !== lastRoundSeen) { lastRoundSeen = s.lastRound.round; announce(s.lastRound); if (!s.me.pending) aim = null; }
  }
  renderGame();
}

function announce(lr) {
  const parts = [];
  for (const sh of lr.myShots) {
    const t = P(sh.targetId); const nm = t ? esc(t.name) : '?';
    const cell = COLS[sh.c] + (sh.r + 1);
    if (sh.result === 'sunk') parts.push(`💥 你擊沉了 ${nm} 的 ${sh.len} 格船！`);
    else if (sh.result === 'hit') parts.push(`🔥 命中 ${nm} ${cell}！`);
    else parts.push(`💦 ${nm} ${cell} 沒打中`);
    if (sh.auto) parts[parts.length - 1] += '（逾時自動開砲）';
  }
  const inHit = lr.incoming.filter(x => x.result !== 'miss').length, inMiss = lr.incoming.length - inHit;
  if (lr.incoming.length) parts.push(inHit ? `⚠️ 你被擊中 ${inHit} 次${lr.incoming.some(x => x.result === 'sunk') ? '，有船沉了！' : ''}` : `🌊 有 ${inMiss} 發砲彈落在你附近`);
  for (const id of lr.eliminated) { const p = P(id); if (p) parts.push(id === myId ? '☠️ 你的艦隊全滅了' : `☠️ ${esc(p.name)} 被淘汰`); }
  if (parts.length) toast(`<small>第 ${lr.round} 回合</small><br>` + parts.join('<br>'), 3200);
}

function renderOver() {
  const w = P(S.winnerId), me = S.winnerId === myId;
  $('#overEmoji').textContent = me ? '🏆' : w ? '⚓' : '🤝';
  $('#overTitle').textContent = me ? '你贏了！海上霸主！' : w ? `${w.name} 獲勝` : '同歸於盡，平手！';
  $('#overSub').textContent = `共 ${S.round} 回合` + (me ? '' : (S.me && S.me.alive === false ? '・下次再接再厲' : ''));
}

// ---------- 等待室 ----------
function renderRoom() {
  $('#roomCode').textContent = S.code;
  $('#roomPlayers').innerHTML = S.players.map(p => `<li><span class="av" style="background:${p.color}">${p.avatar}</span>${esc(p.name)}${p.id === myId ? '（你）' : ''}${p.id === S.hostId ? '<span class="tag">房主</span>' : ''}</li>`).join('');
  const host = S.hostId === myId, n = S.players.length;
  $('#btnStart').classList.toggle('hidden', !host);
  $('#btnStart').disabled = n < 2;
  $('#roomHint').textContent = host ? (n < 2 ? '等待其他玩家加入（2–5 人）' : `${n} 人，可以開始了`) : '等待房主開始…';
}

// ---------- 遊戲畫面 ----------
function renderGame() {
  renderOpps(); renderMyBoard();
  const ph = S.phase, me = S.me || {};
  $('#game').dataset.phase = ph;
  $('#placePanel').classList.toggle('hidden', ph !== 'placing');
  const battle = ph === 'battle' || ph === 'over';
  const canAct = ph === 'battle' && me.alive;
  $('#tray').classList.toggle('hidden', !(battle && targetId));
  $('#pickHint').classList.toggle('hidden', !(canAct && !targetId));
  $('#btnFire').classList.toggle('hidden', !canAct);
  if (battle && targetId) renderTarget();
  if (ph === 'placing') renderPlacePanel();
  const alive = S.players.filter(p => p.alive), done = alive.filter(p => p.submitted).length;
  let txt = '';
  if (ph === 'placing') txt = place.sent ? `已準備，等待其他人（${S.players.filter(p => p.ready).length}/${S.players.length}）` : '佈陣階段：把 4 艘船藏進你的海域';
  else if (ph === 'battle') txt = !me.alive ? '你已被淘汰，觀戰中…' : me.pending ? `已開火！等待其他人（${done}/${alive.length}）` : `第 ${S.round} 回合：選對手、選一格開火`;
  else if (ph === 'over') txt = '遊戲結束';
  $('#phaseText').textContent = txt;
  const fire = $('#btnFire');
  fire.disabled = !!me.pending || !aim || !targetId;
  fire.textContent = me.pending ? '✅ 已開火' : '🔥 開火';
}

function renderOpps() {
  const opps = S.players.filter(p => p.id !== myId);
  const slots = [opps[0], opps[1], 'timer', opps[2], opps[3]];
  const box = $('#opps'); box.innerHTML = '';
  for (const p of slots) {
    if (p === 'timer') { const t = div('timer'); t.id = 'timer'; t.innerHTML = '<b>--</b><small>倒數</small>'; box.appendChild(t); continue; }
    const o = div('opp' + (!p ? ' empty' : '') + (p && !p.alive ? ' dead' : '') + (p && p.id === targetId && S.phase !== 'placing' ? ' sel' : ''));
    if (p) {
      const ships = Array.from({ length: FLEET.length }, (_, i) => `<i class="${i >= p.shipsLeft ? 'sunk' : ''}"></i>`).join('');
      const badge = (S.phase === 'battle' && p.alive && p.submitted) || (S.phase === 'placing' && p.ready) ? '<span class="badge">✓</span>' : '';
      o.innerHTML = `<div class="av" style="background:${p.color}">${p.avatar}</div>${badge}<div class="nm">${esc(p.name)}${p.connected ? '' : '(離線)'}</div><div class="ships">${ships}</div>`;
      o.dataset.id = p.id;
      o.onclick = () => { if (S.phase === 'placing') return; if (!p.alive && S.phase === 'battle') return toast('他已經被淘汰了'); if (targetId !== p.id && !(S.me && S.me.pending)) aim = null; targetId = p.id; renderGame(); };
    }
    box.appendChild(o);
  }
  tick();
}
function tick() {
  const t = $('#timer'); if (!t || !S) return;
  const sec = Math.ceil(Math.max(0, deadlineAt - Date.now()) / 1000);
  const active = S.phase === 'placing' || S.phase === 'battle';
  t.querySelector('b').textContent = active ? sec : '--';
  t.classList.toggle('urgent', active && sec <= 5);
}
setInterval(tick, 250);

function myShipList() { return S.phase === 'placing' && !place.sent ? place.ships : (S.me && S.me.ships) || place.ships; }
function renderMyBoard() {
  const b = $('#myBoard'); b.innerHTML = '';
  const placing = S.phase === 'placing' && !place.sent;
  b.classList.toggle('placing', placing);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const cell = at(div('cell'), r, c); cell.dataset.r = r; cell.dataset.c = c;
    if (placing) cell.onclick = () => onPlaceTap(r, c);
    b.appendChild(cell);
  }
  const ships = myShipList(), sunk = (S.me && S.me.sunk) || [];
  ships.forEach((s, i) => {
    if (!s) return;
    const L = FLEET[i];
    const el = at(div(`ship c${i} ${s.dir}` + (placing && place.sel === i ? ' sel' : '') + (sunk[i] ? ' sunkShip' : '')), s.r, s.c, s.dir === 'h' ? L : 1, s.dir === 'h' ? 1 : L);
    if (placing) { el.onpointerdown = e => startDrag(e, i); }
    b.appendChild(el);
  });
  if (S.me && S.phase !== 'placing') {
    const fresh = new Set((S.lastRound && S.lastRound.round === lastRoundSeen && !renderMyBoard.seen?.[lastRoundSeen] ? S.lastRound.incoming : []).map(x => x.r * N + x.c));
    renderMyBoard.seen = { [lastRoundSeen]: true };
    for (const k of S.me.hits) b.appendChild(at(div('mark hit' + (fresh.has(k) ? ' new' : '')), Math.floor(k / N), k % N));
    for (const k of S.me.misses) b.appendChild(at(div('mark miss' + (fresh.has(k) ? ' new' : '')), Math.floor(k / N), k % N));
  }
}

// ---------- 佈陣 ----------
function fits(ships, i, s) {
  const occ = new Set();
  ships.forEach((o, j) => { if (o && j !== i) cellsOf(o, FLEET[j]).forEach(([r, c]) => occ.add(r * N + c)); });
  return cellsOf(s, FLEET[i]).every(([r, c]) => r >= 0 && r < N && c >= 0 && c < N && !occ.has(r * N + c));
}
function clampShip(s, L) { return { r: Math.min(s.r, s.dir === 'v' ? N - L : N - 1), c: Math.min(s.c, s.dir === 'h' ? N - L : N - 1), dir: s.dir }; }
function shipAt(r, c) { return place.ships.findIndex((s, i) => s && cellsOf(s, FLEET[i]).some(([a, b]) => a === r && b === c)); }
function onPlaceTap(r, c) {
  const hitI = shipAt(r, c);
  if (hitI >= 0 && hitI !== place.sel) { place.sel = hitI; place.dir = place.ships[hitI].dir; return renderGame(); }
  const i = place.sel; if (i == null) return;
  const s = clampShip({ r, c, dir: place.dir }, FLEET[i]);
  if (!fits(place.ships, i, s)) return toast('這裡放不下，換個位置或旋轉');
  place.ships[i] = s;
  const next = place.ships.findIndex(x => !x); place.sel = next >= 0 ? next : i;
  if (next >= 0) place.dir = place.dir; // 保留方向
  renderGame();
}
function startDrag(e, i) {
  e.preventDefault();
  const b = $('#myBoard'), rect = b.getBoundingClientRect(), cw = rect.width / N;
  const s0 = place.ships[i];
  const gr = Math.floor((e.clientY - rect.top) / cw) - s0.r, gc = Math.floor((e.clientX - rect.left) / cw) - s0.c;
  let moved = false, cand = null; const x0 = e.clientX, y0 = e.clientY;
  place.sel = i; place.dir = s0.dir;
  const move = ev => {
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) moved = true;
    if (!moved) return;
    const r = Math.floor((ev.clientY - rect.top) / cw) - gr, c = Math.floor((ev.clientX - rect.left) / cw) - gc;
    cand = clampShip({ r: Math.max(0, r), c: Math.max(0, c), dir: s0.dir }, FLEET[i]);
    const ok = fits(place.ships, i, cand);
    b.querySelectorAll('.cell').forEach(el => el.classList.remove('ok', 'bad'));
    cellsOf(cand, FLEET[i]).forEach(([rr, cc]) => { const el = b.querySelector(`.cell[data-r="${rr}"][data-c="${cc}"]`); el && el.classList.add(ok ? 'ok' : 'bad'); });
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (moved && cand && fits(place.ships, i, cand)) place.ships[i] = cand;
    renderGame();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  renderGame();
}
$('#btnRotate').onclick = () => {
  const i = place.sel; place.dir = place.dir === 'h' ? 'v' : 'h';
  const s = place.ships[i];
  if (s) { const ns = clampShip({ ...s, dir: place.dir }, FLEET[i]); if (fits(place.ships, i, ns)) place.ships[i] = ns; else { toast('旋轉後會撞到別的船'); place.dir = s.dir; } }
  renderGame();
};
$('#btnRandom').onclick = () => {
  for (;;) {
    const ships = [null, null, null, null]; let ok = true;
    for (let i = 0; i < FLEET.length && ok; i++) {
      let tries = 0, s;
      do { s = { r: Math.floor(Math.random() * N), c: Math.floor(Math.random() * N), dir: Math.random() < .5 ? 'h' : 'v' }; } while (!fits(ships, i, s) && ++tries < 200);
      if (tries >= 200) ok = false; else ships[i] = s;
    }
    if (ok) { place.ships = ships; break; }
  }
  renderGame();
};
$('#btnReady').onclick = () => {
  if (place.ships.some(s => !s)) return toast('還有船沒擺好');
  place.sent = true; send({ t: 'place', ships: place.ships }); renderGame();
};
function renderPlacePanel() {
  const names = ['戰艦', '巡洋艦', '巡洋艦', '驅逐艦'], cols = ['#3b6fd6', '#9b59d0', '#3fae4f', '#f2b31f'];
  $('#shipChips').innerHTML = FLEET.map((L, i) => `<div class="chip ${place.sel === i && !place.sent ? 'sel' : ''} ${place.ships[i] ? 'placed' : ''}" data-i="${i}"><span class="hull" style="width:${L * 10}px;background:${cols[i]}"></span>${names[i]}${L}</div>`).join('');
  $('#shipChips').querySelectorAll('.chip').forEach(ch => ch.onclick = () => { if (place.sent) return; place.sel = +ch.dataset.i; if (place.ships[place.sel]) place.dir = place.ships[place.sel].dir; renderGame(); });
  for (const id of ['#btnRotate', '#btnRandom', '#btnReady']) $(id).disabled = place.sent;
  $('#btnReady').textContent = place.sent ? '✅ 已準備' : '準備好了';
}

// ---------- 攻擊 ----------
function renderTarget() {
  const t = P(targetId); if (!t) return;
  $('#trayName').textContent = t.name;
  $('#trayAvatar').textContent = t.avatar; $('#trayAvatar').style.background = t.color;
  const b = $('#targetBoard'); b.innerHTML = '';
  const shots = (S.me && S.me.shots[targetId]) || {};
  const pending = S.me && S.me.pending;
  const canAct = S.phase === 'battle' && S.me.alive && !pending && t.alive;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const k = r * N + c, res = shots[k];
    const cell = at(div('cell' + (res ? ' shot' : '')), r, c); cell.dataset.r = r; cell.dataset.c = c;
    if (!res && canAct) cell.onclick = () => { aim = { r, c }; renderGame(); };
    b.appendChild(cell);
    if (res) b.appendChild(at(div('mark ' + res), r, c));
  }
  if (S.phase === 'over' && S.reveal && S.reveal[targetId]) S.reveal[targetId].forEach((s, i) => { const L = FLEET[i]; b.appendChild(at(div('revealShip'), s.r, s.c, s.dir === 'h' ? L : 1, s.dir === 'h' ? 1 : L)); });
  if (pending && pending.targetId === targetId) b.appendChild(at(div('aim locked'), pending.r, pending.c));
  else if (aim && canAct) b.appendChild(at(div('aim'), aim.r, aim.c));
}
$('#btnFire').onclick = () => { if (aim && targetId) send({ t: 'shoot', targetId, r: aim.r, c: aim.c }); };

window.addEventListener('beforeunload', e => { if (S && (S.phase === 'placing' || S.phase === 'battle')) { e.preventDefault(); e.returnValue = ''; } });
labels();
connect();
