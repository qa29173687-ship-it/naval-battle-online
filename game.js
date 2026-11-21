// 海戰棋 — 遊戲邏輯模組（與網路層分離，之後可接資料庫做持久化）
'use strict';
const CONFIG = {
  SIZE: 8,
  FLEET: [4, 3, 3, 2],
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 5,
  TURN_MS: +(process.env.TURN_SECONDS || 15) * 1000,
  PLACE_MS: +(process.env.PLACE_SECONDS || 60) * 1000,
};
const N = CONFIG.SIZE;
const AVATARS = ['🐳', '🐙', '🦈', '🐧', '🦀', '🐬', '🐢', '🦭'];
const COLORS = ['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];
const rnd = n => Math.floor(Math.random() * n);
const key = (r, c) => r * N + c;

function cellsOf(s, len) {
  const out = [];
  for (let i = 0; i < len; i++) out.push(s.dir === 'h' ? [s.r, s.c + i] : [s.r + i, s.c]);
  return out;
}
function validFleet(ships) {
  if (!Array.isArray(ships) || ships.length !== CONFIG.FLEET.length) return false;
  const occ = new Set();
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    if (!s || !['h', 'v'].includes(s.dir) || !Number.isInteger(s.r) || !Number.isInteger(s.c)) return false;
    for (const [r, c] of cellsOf(s, CONFIG.FLEET[i])) {
      if (r < 0 || r >= N || c < 0 || c >= N || occ.has(key(r, c))) return false;
      occ.add(key(r, c));
    }
  }
  return true;
}
function randomFleet() {
  for (;;) {
    const ships = CONFIG.FLEET.map(() => ({ r: rnd(N), c: rnd(N), dir: Math.random() < 0.5 ? 'h' : 'v' }));
    if (validFleet(ships)) return ships;
  }
}

class Room {
  // onChange(room) 由網路層提供，在狀態改變時推送給玩家
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange || (() => {});
    this.players = []; // {id,name,avatar,color,connected,ready,ships,hits:Set,alive,shots:{targetId:{key:result}},pending,elimRound}
    this.phase = 'lobby'; // lobby | placing | battle | over
    this.hostId = null;
    this.round = 0;
    this.deadline = 0;
    this.timer = null;
    this.lastRound = null; // {round, perPlayer:{id:{myShots:[], incoming:[]}}, eliminated:[ids]}
    this.winnerId = null;
    this.log = [];
  }
  get(id) { return this.players.find(p => p.id === id); }
  alive() { return this.players.filter(p => p.alive); }
  changed() { this.onChange(this); }

  addPlayer(id, name) {
    if (this.phase !== 'lobby') throw new Error('遊戲已開始，無法加入');
    if (this.players.length >= CONFIG.MAX_PLAYERS) throw new Error('房間已滿（最多 5 人）');
    const used = new Set(this.players.map(p => p.avatar));
    let a = 0; while (used.has(a)) a++;
    this.players.push({ id, name: String(name || '艦長').slice(0, 10), avatar: a, connected: true });
    if (!this.hostId) this.hostId = id;
    this.changed();
  }

  // 斷線：大廳中直接移除；遊戲中視為淘汰
  disconnect(id) {
    const p = this.get(id); if (!p) return;
    if (this.phase === 'lobby' || this.phase === 'over') {
      this.players = this.players.filter(x => x !== p);
    } else {
      p.connected = false;
      if (p.alive) { p.alive = false; p.elimRound = this.round; p.left = true; }
    }
    if (this.hostId === id) this.hostId = (this.players.find(x => x.connected) || {}).id || null;
    if (this.phase === 'placing') this.checkAllReady();
    else if (this.phase === 'battle') { if (!this.checkWinner()) this.checkAllSubmitted(); }
    this.changed();
  }
  isEmpty() { return !this.players.some(p => p.connected); }

  start(byId) {
    if (byId !== this.hostId) throw new Error('只有房主可以開始');
    if (this.phase !== 'lobby') throw new Error('已經開始了');
    if (this.players.length < CONFIG.MIN_PLAYERS) throw new Error('至少需要 2 位玩家');
    for (const p of this.players) Object.assign(p, { ready: false, ships: null, hits: new Set(), alive: true, shots: {}, pending: null, elimRound: null, left: false });
    this.round = 0; this.winnerId = null; this.lastRound = null;
    this.phase = 'placing';
    this.setTimer(CONFIG.PLACE_MS, () => {
      for (const p of this.players) if (!p.ready) { p.ships = randomFleet(); p.ready = true; p.autoPlaced = true; }
      this.beginBattle();
    });
    this.changed();
  }

  place(id, ships) {
    const p = this.get(id);
    if (!p || this.phase !== 'placing') throw new Error('現在不是佈陣階段');
    if (p.ready) throw new Error('已經準備好了');
    if (!validFleet(ships)) throw new Error('船的位置不合法');
    p.ships = ships.map(s => ({ r: s.r, c: s.c, dir: s.dir }));
    p.ready = true;
    this.checkAllReady();
    this.changed();
  }
  checkAllReady() {
    if (this.phase === 'placing' && this.players.every(p => p.ready || !p.connected)) {
      for (const p of this.players) if (!p.ready) { p.ships = randomFleet(); p.ready = true; }
      this.beginBattle();
    }
  }
  beginBattle() {
    this.phase = 'battle';
    if (this.checkWinner()) return;
    this.nextRound();
  }
  nextRound() {
    this.round++;
    for (const p of this.players) p.pending = null;
    this.setTimer(CONFIG.TURN_MS, () => this.resolve());
  }
  setTimer(ms, fn) {
    clearTimeout(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => { fn(); this.changed(); }, ms);
  }

  canShoot(p, t, r, c) {
    return t && t !== p && t.alive && Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < N && c >= 0 && c < N &&
      !(p.shots[t.id] && p.shots[t.id][key(r, c)]);
  }
  shoot(id, targetId, r, c) {
    const p = this.get(id), t = this.get(targetId);
    if (this.phase !== 'battle' || !p || !p.alive) throw new Error('現在不能開火');
    if (p.pending) throw new Error('這回合已經開過火了');
    if (!this.canShoot(p, t, r, c)) throw new Error('這格不能打');
    p.pending = { targetId, r, c };
    this.checkAllSubmitted();
    this.changed();
  }
  checkAllSubmitted() {
    if (this.phase === 'battle' && this.alive().every(p => p.pending)) this.resolve();
  }
  randomShot(p) {
    const opts = [];
    for (const t of this.alive()) if (t !== p)
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (this.canShoot(p, t, r, c)) opts.push({ targetId: t.id, r, c });
    return opts.length ? opts[rnd(opts.length)] : null;
  }
  shipCells(p) { return p.ships.map((s, i) => cellsOf(s, CONFIG.FLEET[i]).map(([r, c]) => key(r, c))); }
  sunkMask(p) { return this.shipCells(p).map(cs => cs.every(k => p.hits.has(k))); }
  shipsLeft(p) { return this.sunkMask(p).filter(x => !x).length; }

  resolve() {
    if (this.phase !== 'battle') return;
    clearTimeout(this.timer);
    const shooters = this.alive();
    const per = {}; for (const p of this.players) per[p.id] = { myShots: [], incoming: [] };
    const before = new Map(this.players.map(p => [p.id, p.ships ? this.sunkMask(p) : []]));
    const shots = [];
    for (const p of shooters) {
      let s = p.pending;
      let auto = false;
      if (!s) { s = this.randomShot(p); auto = true; }
      if (!s) continue;
      shots.push({ shooter: p, target: this.get(s.targetId), r: s.r, c: s.c, auto });
    }
    // 同時套用所有砲擊
    for (const s of shots) {
      const k = key(s.r, s.c);
      const cells = this.shipCells(s.target);
      const idx = cells.findIndex(cs => cs.includes(k));
      s.hit = idx >= 0; s.shipIdx = idx;
      if (s.hit) s.target.hits.add(k);
      if (!s.target.misses) s.target.misses = new Set();
      if (!s.hit) s.target.misses.add(k);
    }
    // 判定擊沉
    for (const s of shots) {
      const t = s.target, k = key(s.r, s.c);
      let result = s.hit ? 'hit' : 'miss';
      let sunkCells = null;
      if (s.hit) {
        const nowSunk = this.sunkMask(t)[s.shipIdx];
        if (nowSunk && !before.get(t.id)[s.shipIdx]) { result = 'sunk'; sunkCells = this.shipCells(t)[s.shipIdx]; }
      }
      const rec = (s.shooter.shots[t.id] = s.shooter.shots[t.id] || {});
      rec[k] = s.hit ? 'hit' : 'miss';
      if (sunkCells) for (const sk of sunkCells) rec[sk] = 'sunk';
      per[s.shooter.id].myShots.push({ targetId: t.id, r: s.r, c: s.c, result, len: sunkCells ? sunkCells.length : 0, auto: s.auto });
      per[t.id].incoming.push({ r: s.r, c: s.c, result }); // 不透露是誰開的砲
    }
    // 若有人擊中先前已沉的船，也讓所有打過該船的人看到整艘沉船
    const eliminated = [];
    for (const p of shooters) if (this.shipsLeft(p) === 0) { p.alive = false; p.elimRound = this.round; eliminated.push(p.id); }
    this.lastRound = { round: this.round, per, eliminated };
    this.log.push({ round: this.round, shots: shots.map(s => ({ from: s.shooter.id, to: s.target.id, r: s.r, c: s.c, hit: s.hit })) });
    if (!this.checkWinner()) this.nextRound();
  }
  checkWinner() {
    const al = this.alive();
    if (this.phase === 'battle' && al.length <= 1) {
      clearTimeout(this.timer);
      this.phase = 'over';
      this.winnerId = al.length ? al[0].id : null; // null = 同歸於盡平手
      return true;
    }
    return false;
  }
  rematch() {
    if (this.phase !== 'over') return;
    this.players = this.players.filter(p => p.connected);
    if (!this.get(this.hostId)) this.hostId = this.players[0] && this.players[0].id;
    this.phase = 'lobby'; this.lastRound = null; this.winnerId = null; this.round = 0;
    for (const p of this.players) { p.ready = false; p.ships = null; p.alive = true; }
    this.changed();
  }
  destroy() { clearTimeout(this.timer); }

  // 每位玩家個人化的畫面資料（只含自己該知道的資訊）
  viewFor(id) {
    const me = this.get(id);
    const v = {
      code: this.code, phase: this.phase, round: this.round, hostId: this.hostId, meId: id,
      remainMs: Math.max(0, this.deadline - Date.now()), turnMs: this.phase === 'placing' ? CONFIG.PLACE_MS : CONFIG.TURN_MS,
      size: N, fleet: CONFIG.FLEET, winnerId: this.winnerId,
      players: this.players.map(p => ({
        id: p.id, name: p.name, avatar: AVATARS[p.avatar], color: COLORS[p.avatar], connected: p.connected,
        ready: !!p.ready, alive: this.phase === 'lobby' ? true : !!p.alive, left: !!p.left,
        shipsLeft: p.ships && this.phase !== 'lobby' && this.phase !== 'placing' ? this.shipsLeft(p) : CONFIG.FLEET.length,
        submitted: !!p.pending,
      })),
    };
    if (me && this.phase !== 'lobby') {
      v.me = {
        ships: me.ships, alive: !!me.alive, pending: me.pending,
        hits: me.hits ? [...me.hits] : [], misses: me.misses ? [...me.misses] : [],
        sunk: me.ships && me.hits ? this.sunkMask(me) : [],
        shots: me.shots || {},
      };
      if (this.lastRound) v.lastRound = { round: this.lastRound.round, eliminated: this.lastRound.eliminated, ...this.lastRound.per[id] };
      if (this.phase === 'over') v.reveal = Object.fromEntries(this.players.filter(p => p.ships).map(p => [p.id, p.ships]));
    }
    return v;
  }
}

module.exports = { Room, CONFIG, validFleet, randomFleet, cellsOf };
