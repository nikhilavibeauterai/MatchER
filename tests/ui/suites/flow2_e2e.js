// The journey in order: Filter → Stacks → Groups → Crown → Group stage → Knockouts.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { BASE, LINK, LIB, OUT } = process.env;
const res = {}, problems = [];
let pg = null;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("matcher-groups-view", "list"); } catch (_) {} });
  const page = await ctx.newPage();
  pg = page;
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/status of 40[09]/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !/\/api\/vote/.test(r.url())) problems.push(`${r.status()} ${r.url()}`); });
  page.on("dialog", (d) => d.accept());
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
  const shot = (n) => page.screenshot({ path: `${OUT}/g-${n}.png` });
  await page.goto(LINK);
  await page.click('.mode-card[data-mode="gallery"]');
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go, .journey", { timeout: 300000 }); if (await page.$("#an-go")) { res.reveal = await page.$eval(".an-reveal", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)).catch(() => null); await page.screenshot({ path: OUT + "/" + "flow2_e2e-reveal.png" }); await page.click("#an-go"); } await page.waitForSelector(".journey");
  await page.waitForSelector(".tnode");
  res.track = await page.$$eval(".tnode .tlabel", (t) => t.map((x) => x.textContent));
  res.nextUp = await page.locator("#journey-next").getAttribute("aria-label");
  await shot("map");

  // Filter is the first explicit review, even when keeping the initial policy.
  await page.click("#journey-next");
  await page.waitForSelector('.filter-stage');
  await page.waitForSelector('#journey-next[aria-disabled="false"]');
  assert.equal(new URL(page.url()).hash,'#filter');
  await page.click('#journey-next');
  // Stacks
  await page.waitForSelector(".stacker");
  res.stacksTools = await text("#journey-next");
  await shot("stacks");
  if (await page.locator('a[href="#stacks?check=1"]').first().isVisible()) {
    await page.click('a[href="#stacks?check=1"]');
    await page.waitForSelector(".twin-arena, .big-emoji");
    if (await page.$(".twin-arena")) await shot("twins");
    for (let k = 0; k < 20 && (await page.$(".twin-arena")); k++) { await page.keyboard.press(k ? "ArrowLeft" : "ArrowRight"); await page.waitForTimeout(700); }
    res.twinsDone = await text("h1");
  }
  // 2. crown comes before groups: every stack's takes duel, then the next arrow leads on to Groups.
  await page.goto(BASE + "/#duel?stage=stacks");
  await page.waitForSelector("#stage.mini-stage, .stage-done");
  res.crownHere = await page.$eval(".tnode.here .tlabel", (x) => x.textContent).catch(() => null);
  for (let k = 0; k < 20 && (await page.$("#stage.mini-stage")); k++) { await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(700); }
  await page.waitForSelector(".stage-done");
  res.crownDone = await text("#journey-next");
  await page.click("#journey-next");

  // 3. groups: select two and press N, a number to move, drag onto a group, quick sort, find more
  await page.waitForSelector(".gsec.unsorted .tile[data-sel]");
  await shot("groups-empty");
  const t = await page.$$(".gsec.unsorted .tile[data-sel]");
  await t[0].click({ position: { x: 20, y: 60 } });
  const second=await t[1].$(".shot-select");
  await second.focus();await page.keyboard.press('Space');
  assert.equal(await second.getAttribute('aria-pressed'),'true');
  await page.keyboard.press('Enter');assert.equal(await second.getAttribute('aria-pressed'),'false');
  await page.keyboard.press('Enter');assert.equal(await second.getAttribute('aria-pressed'),'true');
  assert.equal(new URL(page.url()).hash,'#draw','Native selection keys do not advance the journey');
  assert.equal(await second.evaluate(e=>getComputedStyle(e,'::after').borderTopStyle),'dashed','Keyboard focus has its own inner marker');
  await page.locator('#track [aria-current=step]').focus();await t[2].hover();
  res.selectedPhotos=await page.$$eval('.gsec.unsorted .tile[data-sel]',tiles=>tiles.slice(0,3).map(el=>{
    const button=el.querySelector('.shot-select'),mark=el.querySelector('.shot-selected'),style=getComputedStyle(el);
    return {picked:el.classList.contains('picked'),pressed:button.getAttribute('aria-pressed'),check:!mark.hidden&&getComputedStyle(mark).display!=='none',
      outline:style.outlineStyle,width:parseFloat(style.outlineWidth),invalidGroupState:el.hasAttribute('aria-pressed')};
  }));
  for(const photo of res.selectedPhotos.slice(0,2)){assert(photo.picked&&photo.pressed==='true'&&photo.check);assert(photo.outline==='solid'&&photo.width>=3);assert(!photo.invalidGroupState);}
  assert(!res.selectedPhotos[2].picked&&res.selectedPhotos[2].pressed==='false'&&!res.selectedPhotos[2].check,'Hover does not imply selection');
  const pile=page.locator('.gsec.unsorted .tile.stacked').first();
  await pile.locator('.shot-select').click();
  assert.equal(await pile.locator('.shot-select').getAttribute('aria-pressed'),'true');
  assert(await pile.locator('.shot-selected').isVisible(),'A selected stack has the same visible check');
  assert(/rgb\(255, 216, 107\)/.test(await pile.locator('.pile-cover').evaluate(e=>getComputedStyle(e).boxShadow)),'A picked print wears a gold ring');
  await page.mouse.move(12,70);await page.waitForTimeout(350);await shot('groups-selected');
  await pile.locator('.shot-select').click();
  assert.equal(await page.locator('.gsec .tile.picked').count(),2,'Deselecting a stack keeps the other choices');
  await page.keyboard.press("n");
  await page.waitForSelector(".gsec:not(.unsorted)");
  res.firstGroup = await text(".gsec:not(.unsorted) .gsec-title");
  const u1 = await page.$$(".gsec.unsorted .tile[data-sel]");
  await u1[0].click({ position: { x: 20, y: 60 } });
  await page.keyboard.press("1");
  await page.waitForTimeout(1500);
  res.afterNumber = await page.$eval(".gsec:not(.unsorted) .gsec-head .muted.small", (x) => x.textContent);
  const tile = await page.$(".gsec.unsorted .tile[data-sel]"), bin = await page.$('.bins .bin[data-bin]:not(.new)');
  await page.dragAndDrop(`.gsec.unsorted .tile[data-sel="${await tile.getAttribute("data-sel")}"]`, `.bins .bin[data-bin="${await bin.getAttribute("data-bin")}"]`);
  await page.waitForTimeout(1500);
  res.afterDrag = await page.$eval(".gsec:not(.unsorted) .gsec-head .muted.small", (x) => x.textContent);
  const groupNames=await page.evaluate(()=>[...document.querySelectorAll('.gsec [data-rename]')].map(e=>e.textContent));
  const rosterNames=await page.evaluate(()=>[...document.querySelectorAll('.bins .bin-label')].map(e=>e.textContent));
  assert.deepEqual(rosterNames,groupNames,'List navigation names every group');
  assert(await page.locator('.bins .bin-size').count()===groupNames.length,'Shot counts sit beside group names');
  await shot("groups");
  // Splitting the cover changes the representative, but the remaining fan and reached-for row stay open.
  const original=await page.evaluate(async()=>{
    const board=await api('/api/draw/board?per=400&uper=400');return board.unsorted.shots.find(x=>x.members.length>2);
  });
  assert(original,'Fixture has a multi-take stack to split');
  await page.click(`[data-expand="${original.rep}"]`);await page.waitForSelector('.tile.open .photo-fan');
  const split=page.locator(`.tile.open [data-split="${original.rep}"]`);
  await split.focus();await page.waitForTimeout(250);await split.hover();await page.waitForTimeout(250);
  const offset=()=>page.locator('.tile.open').evaluate(e=>e.getBoundingClientRect().top-e.closest('#sections').getBoundingClientRect().top);
  const beforeSplit=await offset();await split.click();
  await page.waitForFunction(([ids,removed])=>{
    const tile=document.querySelector('.tile.open');if(!tile)return false;
    const takes=[...tile.querySelectorAll('[data-split]')].map(e=>Number(e.dataset.split));
    return takes.length===ids.length-1&&!takes.includes(removed)&&takes.every(id=>ids.includes(id));
  },[original.members,original.rep]);
  await page.waitForTimeout(250);const afterSplit=await offset();
  assert(Math.abs(beforeSplit-afterSplit)<4,`Split moved its row from ${beforeSplit} to ${afterSplit}`);
  assert(await page.locator('.tile.open [data-keep]').count()>0,'Remaining takes keep their controls');
  const remainder=await page.locator('.tile.open').getAttribute('data-sel');assert.notEqual(Number(remainder),original.rep);
  await shot('groups-split-open');await page.keyboard.press('z');
  await page.waitForFunction(([rep,n])=>{const tile=document.querySelector('.tile.open');return Number(tile?.dataset.sel)===rep&&tile.querySelectorAll('[data-split]').length===n;},[original.rep,original.members.length]);
  await page.waitForTimeout(250);const afterUndo=await offset();assert(Math.abs(afterUndo-afterSplit)<4,`Undo moved its row from ${afterSplit} to ${afterUndo}`);
  res.splitFan={beforeSplit,afterSplit,afterUndo,takes:original.members.length};
  await shot('groups-split-undo');await page.click(`.tile.open [data-expand="${original.rep}"]`);
  const pair=page.locator('.tile.stacked').filter({has:page.locator('[data-expand][aria-label="Open stack of 2 takes"]')}).first();
  if(!await pair.count()){
    // A two-take split must not depend on Twin check happening to offer a pair in this public sample.
    await page.evaluate(async()=>{
      const board=await api('/api/draw/board?per=400&uper=400'),ids=[...board.groups.flatMap(g=>g.shots),...board.unsorted.shots].filter(s=>s.members.length===1).slice(0,2).map(s=>s.rep);
      if(ids.length!==2)throw new Error('The public fixture needs two loose photos for the split check');
      await api('/api/groups/merge',{photos:ids});await api('/api/frame',{photo:ids[0]});
    });
    await page.reload();await page.waitForSelector('#sections');
  }
  await pair.locator('[data-expand]').click();await page.waitForSelector('.tile.open .photo-fan');
  const pairIds=await page.locator('.tile.open [data-split]').evaluateAll(es=>es.map(e=>Number(e.dataset.split))),pairRep=Number(await page.locator('.tile.open').getAttribute('data-sel'));
  const splitPair=page.locator(`.tile.open [data-split="${pairRep}"]`);
  await splitPair.focus();await page.waitForTimeout(250);await splitPair.click();await page.waitForFunction(()=>!document.querySelector('.tile.open'));
  const remaining=pairIds.find(id=>id!==pairRep);
  await page.waitForSelector(`.tile[data-sel="${remaining}"]:not(.stacked)`);
  assert(await page.locator(`.tile[data-sel="${remaining}"]`).evaluate(e=>{const r=e.getBoundingClientRect(),b=e.closest('#sections').getBoundingClientRect();return r.bottom>b.top&&r.top<b.bottom;}),'A two-take split leaves the remaining single in view');
  await page.keyboard.press('z');await page.waitForFunction(ids=>{
    const takes=[...document.querySelectorAll('.tile.open [data-split]')].map(e=>Number(e.dataset.split));return takes.length===2&&ids.every(id=>takes.includes(id));
  },pairIds);
  await page.locator('.tile.open [data-expand]').click();
  await page.click('.screen-bar a[href="#draw?sort=1"]');
  await page.waitForSelector("#dtop");
  await shot("quicksort");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(900);
  await page.keyboard.press("n");
  await page.waitForTimeout(1500);
  res.quickBins = await page.$$eval(".bin:not(.new)", (b) => b.length);
  await page.keyboard.press("Escape");await page.click("#menu-leave");  // Leaving a paused activity is explicit.
  await page.waitForSelector(".sorter");
  await page.click('.gsec-actions a[href^="#draw?play="]');
  await page.waitForSelector("#dtop, .bulk-card, .deck-note");
  await shot("findmore");
  if (await page.$("#dtop")) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(700); }
  await page.keyboard.press("Escape");await page.click("#menu-leave");  // Leaving a paused activity is explicit.
  await page.waitForSelector(".sorter");
  await page.click("#d-auto");
  await page.waitForSelector('#journey-next.ready[href="#tournament?kickoff=1"]', { timeout: 60000 });
  res.groupsDone = await text("#journey-next");
  await shot("groups-done");

  // 4. group stage, 5. knockouts
  await page.click('#journey-next');
  await page.waitForSelector(".kickoff-team");
  res.kickoff=await text("h1");
  res.kickoffHere=await page.locator('#track [aria-current="step"]').getAttribute('data-stage');
  await page.click("#journey-next.ready");
  await page.waitForSelector("#stage .side img, #stage.mini-stage");
  res.groupHeader = await text("#duel-q");
  for (let k = 0; k < 160 && !(await page.$(".stage-done")); k++) {
    if (!(await page.$("#stage .side"))) { await page.waitForTimeout(250); continue; }
    await page.keyboard.press(k % 3 ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(220);
  }
  res.groupStage = await page.$(".stage-done") ? await text(".stage-done h2") : null;
  if (res.groupStage) {
    res.groupStageNext = await page.locator("#journey-next.ready").getAttribute("href");
    const direct = await page.evaluate(async () => !!(await api("/api/journey")).stages.duels.direct);
    assert.equal(res.groupStageNext, direct ? "#finals" : "#duel?stage=knockouts", "The way on names where you land");
    await page.goto(BASE + "/#duel?stage=knockouts");
    await page.waitForFunction(() => S.stage === "knockouts" && (S.current?.type === "knockout" || document.querySelector("#stage .stage-done")));
    await page.waitForSelector("#stage .side img, .stage-done");
    res.knockouts = await text(await page.$("#stage .stage-done h2") ? "#stage .stage-done h2" : "#duel-q");
    if (direct) assert.match(res.knockouts, /Straight to the finals/);
  }
  res.trackDone = await page.$$eval(".tnode.done .tlabel", (t) => t.map((x) => x.textContent));
  assert(await page.locator('.tnode.done[aria-label*="complete"]').count()===res.trackDone.length,'Completed stages retain their accessible status');
  await shot("knockouts");
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.addCookies(await ctx.cookies());
  const p2 = await phone.newPage();
  for (const [n, url, sel] of [["map", "/#home", ".journey"], ["groups", "/#draw", ".sorter"], ["stacks", "/#stacks", ".stacker"]]) {
    await p2.goto(BASE + url);
    await p2.waitForSelector(sel);
    await p2.waitForTimeout(500);
    if(n==='groups'){
      assert(await p2.locator('#groups-tag-lab').isVisible());
      const forwardBefore=await p2.locator('#journey-next').boundingBox();
      const photo=p2.locator('.shot-select').first();await photo.click();
      const forwardAfter=await p2.locator('#journey-next').boundingBox();
      assert(Math.abs(forwardAfter.y-forwardBefore.y)<1,'Selection tools open above the anchored forward action');
      assert.equal(await photo.getAttribute('aria-pressed'),'true');
      assert(!await p2.locator('#groups-tag-lab').isVisible(),'Selection actions have the footer to themselves');
      const marker=photo.locator('.shot-selected');assert(await marker.isVisible());
      assert(await marker.evaluate(e=>{const b=e.getBoundingClientRect(),p=e.closest('.shot-select').getBoundingClientRect(),list=e.closest('#sections').getBoundingClientRect();return b.width>=24&&b.height>=24&&b.left>=p.left&&b.right<=p.right&&b.bottom<=p.bottom&&b.top>=list.top&&b.bottom<=list.bottom;}),'Phone check stays inside the visible photo list when actions appear');
      await p2.screenshot({path:`${OUT}/g-phone-groups-selected.png`});
      await p2.keyboard.press('Escape');assert.equal(await photo.getAttribute('aria-pressed'),'false');assert(!await marker.isVisible());
      assert(await p2.locator('#groups-tag-lab').isVisible(),'Tag lab returns when the selection is released');
    }
    await p2.screenshot({ path: `${OUT}/g-phone-${n}.png` });
    res[`phoneOverflow_${n}`] = await p2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  }
  res.phoneTrackFits = await p2.evaluate(() => {
    const dock=document.querySelector('#journey-dock').getBoundingClientRect(),main=document.querySelector('#main').getBoundingClientRect();
    return [...document.querySelectorAll('.tnode')].every(x=>{const r=x.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})
      && dock.bottom<=main.top+1
      && document.querySelector('#journey-title').textContent==='Stack' && document.querySelector('.tnode[aria-current="step"]')?.dataset.stage==='stacks';
  });
  assert.equal(res.groupStage, "Group stage complete!");
  assert.equal(res.kickoffHere,'groups');
  assert.deepEqual(res.track,['Map','Filter','Stack','Crown','Group','Group stage','Knockouts','Finals','Reveal','Leaderboard']);
  assert.match(res.crownDone,/Groups/);assert.match(res.groupsDone,/Group stage/);
  for(const name of ['Group','Crown','Group stage'])assert(res.trackDone.includes(name),`${name} is marked complete`);
  assert.match(res.knockouts, /Knockouts|Round of|Finalists|Straight to the finals/);
  assert.equal(res.phoneTrackFits, true);
  for (const key of Object.keys(res).filter((key) => key.startsWith("phoneOverflow_"))) assert.equal(res[key], false, key);
  assert.deepEqual(problems,[]);
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  console.error(JSON.stringify({ ...res, problems, url: pg && pg.url() }, null, 1));
  if (pg) await pg.screenshot({ path: process.env.OUT + "/g-fail.png" }).catch(() => {});
  process.exit(1);
});
