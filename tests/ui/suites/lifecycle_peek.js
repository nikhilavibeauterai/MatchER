// Replies from a previous screen must never block input or repaint the current one.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { LINK, LIB, OUT } = process.env;
const problems = [], res = {};
let page;
(async () => {
  const browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.addInitScript(() => localStorage.setItem("matcher-groups-view", "list"));
  const go = async (hash, selector) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForSelector(selector);
  };
  const defer = async (path, body) => {
    let release, arrived, completed;
    const gate = new Promise((r) => { release = r; });
    const ready = new Promise((r, reject) => {
      const timer = setTimeout(() => reject(new Error(`No request arrived for ${path}`)), 15000);
      arrived = () => { clearTimeout(timer); r(); };
    });
    const done = new Promise((r) => { completed = r; });
    let first = true;
    const handler = async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = body === undefined ? await route.fetch() : null;
      arrived(); await gate;
      await route.fulfill(response ? { response } : { json: body });
      completed();
    };
    await page.route(path, handler);
    return { ready, release: async () => { release(); await done; await page.unroute(path, handler); await page.waitForTimeout(300); } };
  };
  const check = (key, value) => { res[key] = value; assert.equal(value, true, key); };
  await page.goto(LINK);
  await page.fill("#path", LIB); await page.click("#use-path");
  await page.waitForSelector("#an-go", { timeout: 300000 });
  await page.click("#an-go"); await page.waitForSelector(".journey");
  await page.waitForFunction(()=>World.sea?.items.size>0&&!World.loading);
  const loading=await defer('**/api/journey');
  await page.evaluate(()=>{location.hash='#home?loading-check=1';});await loading.ready;
  await page.waitForSelector('.empty.loading');await page.waitForTimeout(600);
  check('loadingDoesNotEvictTheSea',await page.evaluate(()=>{
    World.fence();const sea=World.sea;
    return !sea.obstacles.some(o=>(o.x1-o.x0)*(o.y1-o.y0)>sea.width*sea.height*.3);
  }));
  await loading.release();await page.waitForSelector('.journey');
  await page.evaluate(() => api("/api/stacks/auto", {}));

  await go("#duel?stage=open", "#stage .side");
  const vote = await defer("**/api/vote");
  await page.keyboard.press("ArrowLeft"); await vote.ready;
  assert.equal(await page.evaluate(() => S.busy), true);
  await go("#home", ".journey"); await go("#duel?stage=open", "#stage .side");
  check("duelsUnlockAfterLeaving", await page.evaluate(() => !S.busy && !S.queued.length && !S.undoQueued));
  await vote.release();
  const before = await page.evaluate(() => S.progress.votes);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((n) => !S.busy && S.progress.votes === n + 1, before);
  check("nextVoteSaves", true);
  await page.keyboard.press('Escape');await page.waitForSelector('#menu[open] #menu-leave');
  check('openArenaPausesBeforeLeaving',await page.locator('#stage .side').count()===2);
  await page.click('#menu-leave');await page.waitForSelector('.journey');check('openArenaCanLeaveThroughMenu',true);
  await go("#duel?stage=open", "#stage .side");

  const table = await defer("**/api/draw/table/0", { table: { id: 0, letter: "STALE", played: 0, budget: 1, adv: 1, rows: [] } });
  await page.evaluate(() => { S.current.group = { id: 0 }; loadTable(0); }); await table.ready;
  await go("#home", ".journey"); await go("#duel?stage=open", "#stage .side");
  await table.release();
  check("oldTableIgnored", await page.$eval("#group-table", (e) => e.hidden && !e.textContent.includes("STALE")));

  const group = await defer("**/api/journey", { stages: { groups: { groups: 1, through: 4 } } });
  await page.evaluate(() => { S.stage = "groups"; S.current = null; groupStageDone(); }); await group.ready;
  await go("#duel?stage=open&again=1", "#stage .side"); await group.release();
  check("oldStageFinishIgnored", await page.evaluate(() => S.stage === "open" && !!document.querySelector("#stage .side") && !document.querySelector(".stage-done")));

  await page.evaluate(() => startLightning());
  const lightning = await defer("**/api/game");
  await page.evaluate(() => { endLightning(); }); await lightning.ready;
  await go("#home", ".journey"); await lightning.release();
  check("oldLightningIgnored", !(await page.$("#modal[open] .lr-result")));

  const ids = await page.evaluate(async () => (await api("/api/world?per=8")).photos.map((p) => p.id));
  await page.evaluate((id) => { openViewer(id); document.querySelector("#modal").close(); }, ids[0]);
  await page.evaluate((id) => openFrames(id), ids[0]); await page.waitForSelector("#modal[open] h2");
  await page.click("#modal h2"); check("takePickerKeepsItsOwnClicks", !!(await page.$("#modal[open]")));
  await page.click("#close-modal");
  check("filterCacheUsesAnalysisVersion", await page.evaluate(async (id) => {
    const img = new Image(); img.src = P(id); await img.decode();
    const key = S.lib.image_key, first = autoFilterId(img, id);
    S.lib.image_key = "synthetic-filter-version";
    const second = autoFilterId(img, id);
    S.lib.image_key = key;
    return first !== second && !document.getElementById(first) && FILTERS.size === 1;
  }, ids[0]));
  const oldJourney = await page.evaluate(() => api("/api/journey"));
  const hud = await defer("**/api/journey", { ...oldJourney, staleTest: true });
  await page.evaluate(() => { refreshHud(true); }); await hud.ready;
  await page.evaluate(() => refreshHud(true)); await hud.release();
  check("oldHudIgnored", await page.evaluate(() => !S.journey.staleTest));

  // A stage ending calms the sea for its reward card; the next route brings the sea back at full strength.
  await page.evaluate(() => { World.calm(true); });
  check("rewardMomentCalmsTheSea", await page.evaluate(() => document.body.classList.contains("world-calm")));
  await go("#stacks", ".stacker");
  check("calmLeavesWithItsView", await page.evaluate(() => !document.body.classList.contains("world-calm")));

  await page.evaluate(() => {
    window.__storageSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("matcher-ranks:")) throw new DOMException("Full", "QuotaExceededError");
      return window.__storageSet.call(this, key, value);
    };
  });
  await go("#shortlist", ".board-body"); check("leaderboardWorksWithoutStorage", true);
  await page.evaluate(() => { Storage.prototype.setItem = window.__storageSet; });
  await page.route('**/api/export',r=>r.fulfill({json:{count:4,dir:'/tmp/matcher-ui/test-export'}}));
  // The page's own heading is hidden behind the shared HUD title; Enter must still export from anywhere on the page.
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Enter');await page.waitForSelector('#modal[open] .exported');
  check('leaderboardEnterClaimsResult',true);await page.click('#close-modal');await page.unroute('**/api/export');

  const sweepCards={cards:ids.slice(0,3).map(photo=>({photo,kind:'cut',reason:'test'})),labels:{test:'Review test'}};
  await page.route('**/api/sweep',r=>r.fulfill({json:r.request().method()==='GET'?sweepCards:{}}));
  await go('#sweep','#top');
  const sweep=await defer('**/api/sweep',{});let sweepCalls=0;
  const countSweep=r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/sweep')sweepCalls++;};page.on('request',countSweep);
  await page.keyboard.press('ArrowRight');await sweep.ready;
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowRight');await sweep.release();await page.waitForTimeout(700);
  check('sweepNeverVotesOnUnseenTakes',sweepCalls===1);page.off('request',countSweep);
  await go('#home','.journey');await page.unroute('**/api/sweep');

  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{achievementPop({icon:'🏆',title:'A useful result',desc:'Your choices have been saved.'});achievementPop({icon:'🌊',title:'Still flowing',desc:'The next photo stays clear.'});});
  await page.waitForSelector('#hud-reward:visible');
  check('oneRewardInsidePhoneHud',await page.locator('#hud-reward').evaluate(e=>{const r=e.getBoundingClientRect(),bar=document.querySelector('#topbar').getBoundingClientRect();return r.top>=bar.top&&r.bottom<=bar.bottom&&r.left>=0&&r.right<=innerWidth&&document.querySelectorAll('.achv,.banner').length===0;}));
  await page.screenshot({path:OUT+'/UX-reward-phone.png'});await page.click('#hud-reward');await page.waitForSelector('.trophy-head');await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:900});
  const trophies=await defer('**/api/game');await page.evaluate(()=>{openTrophies();});await trophies.ready;
  await go('#stacks','.stacker');await trophies.release();
  check('lateTrophiesStayClosed',await page.locator('#modal[open]').count()===0);
  await page.evaluate(()=>openTrophies());await page.waitForSelector('#modal[open] .trophy-head');
  await go('#home','.journey');check('trophiesLeaveWithTheirView',await page.locator('#modal[open]').count()===0);

  // Both reasons use public fixture IDs; the rescue reply is mocked.
  const cuts = { photos: ids.slice(0, 2).map((id, i) => ({ id, rel: `Public fixture ${i}`, reason: `test-${i}`, rescued: false })), labels: { "test-0": "First reason", "test-1": "Second reason" } };
  await page.route("**/api/cuts", (route) => route.fulfill({ json: cuts }));
  await go("#cuts", "#all-back");
  const rescue = await defer("**/api/rescue", {});
  await page.click("#all-back"); await rescue.ready; await page.click('[data-r="test-1"]'); await rescue.release();
  check("rescueKeepsCurrentTab", await page.$eval(".tile[data-id]", (el) => !el.classList.contains("rescued") && el.getAttribute("aria-pressed") === "false"));
  await go("#home", ".journey"); await page.unroute("**/api/cuts");

  await page.evaluate(async () => {
    await api("/api/draw/auto", {});
    const board = await api("/api/draw/board?per=400&uper=600");
    const shots = board.groups.flatMap((g) => g.shots.slice(0, 1).map((s) => s.rep));
    await api("/api/draw/move", { photos: shots.slice(0, 3), theme: null });
  });
  await go("#draw?sort=1", "#dtop");
  let cancelWrites = 0;
  const countWrite = (request) => { if (request.method() === "POST" && /\/api\/draw\/(place|toss|new)$/.test(request.url())) cancelWrites++; };
  page.on("request", countWrite);
  const card = await page.locator("#dtop").boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2); await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 - 220, card.y + card.height / 2, { steps: 4 });
  await page.dispatchEvent("#dtop", "pointercancel", { pointerId: 1 }); await page.mouse.up(); await page.waitForTimeout(300);
  check("cancelledDragDoesNotVote", cancelWrites === 0); page.off("request", countWrite);
  const place = await defer("**/api/draw/place");
  await page.evaluate(() => document.querySelector("#bins .bin:not(.new) .bin-place").click()); await place.ready;
  await go("#home", ".journey"); await place.release(); check("oldQuickSortIgnored", !!(await page.$(".journey")));

  await page.route("**/api/settings", (route) => route.fulfill({ status: 503, json: { error: "Try again after the test" } }));
  await page.evaluate(() => openSettings()); await page.click("#s-save");
  await page.waitForFunction(() => document.querySelector("#toast").textContent === "Try again after the test");
  check("settingsFailureKeepsForm", !!(await page.$("#settings[open] #s-save")));
  await page.click("#s-cancel"); await page.unroute("**/api/settings");
  await page.screenshot({ path: `${OUT}/lifecycle-map.png` });
  assert.deepEqual(problems, []);
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch(async (e) => {
  console.error("FAILED:", e.message, JSON.stringify({ ...res, problems }));
  if (page) await page.screenshot({ path: `${OUT}/lifecycle-fail.png` }).catch(() => {});
  process.exit(1);
});
