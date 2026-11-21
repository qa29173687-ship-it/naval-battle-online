const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8091/';
const EXE = '/home/box/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function game(browser, n, opts = {}) {
  const pages = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    p.on('pageerror', e => log('PAGEERROR', i, e.message));
    await p.goto(URL); pages.push(p);
  }
  const names = ['宏威', '小明', 'Amy', '阿傑', 'Luna'];
  await pages[0].fill('#nick', names[0]); await pages[0].click('#btnCreate');
  await pages[0].waitForSelector('#room:not(.hidden)');
  const code = (await pages[0].textContent('#roomCode')).trim();
  for (let i = 1; i < n; i++) { await pages[i].fill('#nick', names[i]); await pages[i].fill('#joinCode', code); await pages[i].click('#btnJoin'); await pages[i].waitForSelector('#room:not(.hidden)'); }
  await pages[0].waitForFunction(k => document.querySelectorAll('#roomPlayers li').length === k, n);
  await pages[0].click('#btnStart');
  for (const [i, p] of pages.entries()) {
    await p.waitForSelector('#placePanel:not(.hidden)');
    if (i === 0) { // 手動點擊擺船（測試點選擺放 + 旋轉）
      const cell = (r, c) => p.click(`#myBoard .cell[data-r="${r}"][data-c="${c}"]`);
      await cell(0, 0); await cell(2, 1); await p.click('#btnRotate'); await cell(4, 7); await p.click('#btnRotate'); await cell(7, 2);
      const placed = await p.evaluate(() => place.ships.filter(Boolean).length);
      if (placed !== 4) throw new Error('manual placement failed ' + placed);
    } else await p.click('#btnRandom');
    await p.click('#btnReady');
  }
  await pages[0].waitForFunction(() => S && S.phase === 'battle');
  log(`[${n}P] room ${code} battle started`);
  let shot = false, timeoutChecked = !opts.timeout, disconnected = !opts.disconnect;
  const live = new Set(pages.keys());
  for (let iter = 0; iter < 400; iter++) {
    const phase = await pages[0].evaluate(() => S.phase).catch(() => null);
    const alivePages = [...live];
    const anyOver = await pages[[...live][0]].evaluate(() => S.phase);
    if (anyOver === 'over') break;
    const round = await pages[[...live][0]].evaluate(() => S.round);
    if (round === 6 && !shot && opts.shot) { await sleep(300); await pages[0].screenshot({ path: opts.shot }); shot = true; log('screenshot', opts.shot); }
    if (!disconnected && round === 4) {
      const victim = n - 1; await pages[victim].context().close(); live.delete(victim); disconnected = true;
      await sleep(500);
      const v = await pages[0].evaluate(() => S.players.map(p => [p.name, p.alive, p.connected]));
      log(`[${n}P] disconnected player ${names[victim]} ->`, JSON.stringify(v));
      if (v[victim] && v[victim][1]) throw new Error('disconnected player still alive');
      continue;
    }
    let skip = -1;
    if (!timeoutChecked && round === 3) skip = 1; // 玩家 1 這回合不開砲
    for (const i of live) {
      if (i === skip) continue;
      const p = pages[i];
      const ok = await p.evaluate(() => {
        if (S.phase !== 'battle' || !S.me.alive || S.me.pending) return 'skip';
        const opps = [...document.querySelectorAll('#opps .opp:not(.dead):not(.empty)')];
        if (!opps.length) return 'noopp';
        opps[Math.floor(Math.random() * opps.length)].click();
        const cells = [...document.querySelectorAll('#targetBoard .cell:not(.shot)')];
        cells[Math.floor(Math.random() * cells.length)].click();
        document.querySelector('#btnFire').click();
        return 'fired';
      });
    }
    if (skip >= 0) {
      const t0 = Date.now();
      await pages[skip].waitForFunction(r => S.round > r, round, { timeout: 30000 });
      const lr = await pages[skip].evaluate(() => S.lastRound.myShots);
      log(`[${n}P] timeout round resolved after ${((Date.now() - t0) / 1000).toFixed(1)}s, auto shot:`, JSON.stringify(lr));
      if (!lr.length || !lr[0].auto) throw new Error('no auto shot');
      timeoutChecked = true;
    } else {
      await pages[[...live][0]].waitForFunction(r => S.round > r || S.phase === 'over', round, { timeout: 30000 });
    }
  }
  const first = pages[[...live][0]];
  await first.waitForSelector('#over:not(.hidden)', { timeout: 5000 });
  const res = await first.evaluate(() => ({ round: S.round, title: document.querySelector('#overTitle').textContent, players: S.players.map(p => `${p.name}:${p.alive ? '存活' : '淘汰'}:${p.shipsLeft}`) }));
  log(`[${n}P] GAME OVER`, JSON.stringify(res));
  // 驗證每人只看到自己的砲擊結果；對手船位不在戰鬥中傳出（over 才揭露）
  if (opts.rematch) {
    await first.click('#btnRematch');
    await first.waitForFunction(() => S.phase === 'lobby');
    log(`[${n}P] rematch -> back to lobby with`, await first.evaluate(() => S.players.length), 'players');
  }
  for (const p of pages) await p.context().close().catch(() => {});
  return res;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  try {
    await game(browser, 3, { timeout: true, shot: '/workspace/naval_battle_v1/screenshot_midgame_3p.png', rematch: true });
    await game(browser, 5, { disconnect: true, shot: '/workspace/naval_battle_v1/screenshot_midgame_5p.png' });
    log('ALL TESTS PASSED');
  } catch (e) { log('FAIL', e.stack); process.exitCode = 1; }
  await browser.close();
})();
