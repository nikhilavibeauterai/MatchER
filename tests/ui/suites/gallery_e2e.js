// Gallery mode end to end after the review fixes. Every check lands in `res`; anything odd in `problems`.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { BASE, LINK, LIB, OUT } = process.env;
let activePage;const res={},problems=[];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("matcher-groups-view", "list"); } catch (_) {} });
  const page = await ctx.newPage();
  activePage=page;let checkingLock=true;
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/status of 40[09]/.test(m.text()) && !(checkingLock && /status of 403/.test(m.text()))) problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !/\/api\/(vote|finals)/.test(r.url()) && !(checkingLock && r.status()===403)) problems.push(`${r.status()} ${r.url()}`); });
  page.on("dialog", (d) => d.accept());
  const settle = async () => { await page.waitForFunction(() => !S.busy && !(S.queued && S.queued.length), null, { timeout: 15000 }); await page.waitForTimeout(150); };
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());

  // locked without the link, open with it, and the key leaves the address bar
  await page.goto(BASE + "/");
  res.lockedWithoutLink = (await page.content()).includes("MatchER is locked");
  checkingLock=false;
  await page.goto(LINK);
  res.cleanUrl = page.url() === BASE + "/" || page.url().startsWith(BASE + "/#");
  await page.waitForSelector(".mode-card");
  res.modePressed = await page.$eval('.mode-card[data-mode="gallery"]', (b) => b.getAttribute("aria-pressed"));
  await page.screenshot({ path: OUT + "/r-onboard.png" });
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go, .journey", { timeout: 300000 }); if (await page.$("#an-go")) { res.reveal = await page.$eval(".an-reveal", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)).catch(() => null); await page.screenshot({ path: OUT + "/" + "gallery_e2e-reveal.png" }); await page.click("#an-go"); } await page.waitForSelector(".journey").catch(async(e)=>{console.error(JSON.stringify({url:page.url(),text:await page.locator('#main').innerText(),problems}));await page.screenshot({path:OUT+"/failure-gallery_e2e.png"});throw e;});
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT + "/r-home.png", fullPage: true });
  res.cups = await page.$$eval(".cup-row b", (c) => c.map((x) => x.textContent.trim()));

  // sweep: finite, fast keys are kept, done afterwards
  await page.goto(BASE + "/#sweep");
  await page.waitForSelector(".swipe-card.top, .screen.sweep.no-rail .empty");
  if (await page.$(".swipe-card.top")) {
    res.sweepFirst = await text("#sw-count");
    res.sweepLabel = await text(".swipe-card.top .why");
    const n = Number(res.sweepFirst.split("/")[1]);
    for (let k = 0; k < n; k++) { await page.keyboard.press(k % 3 ? "ArrowRight" : "ArrowLeft"); await page.waitForTimeout(60); }
    await page.waitForSelector(".sweep-done", { timeout: 30000 }).catch(() => problems.push("sweep never finished"));
    res.sweepDone = await text(".sweep-done");
  } else {
    res.sweepFirst="empty";
    assert.equal(await text('.screen.sweep h2'),'Nothing to sweep');
    assert(await page.locator('.screen.sweep a[href="#cuts"]').isVisible());
    assert(await page.locator('.screen.sweep .bar-right a[href="#home"]').isVisible());
    await page.screenshot({path:OUT+'/r-sweep-empty.png'});
    await page.keyboard.press('Enter');await page.waitForSelector('.journey');
  }
  await page.goto(BASE + "/#home");
  await page.waitForSelector(".journey").catch(async(e)=>{console.error(JSON.stringify({url:page.url(),text:await page.locator('#main').innerText(),problems}));await page.screenshot({path:OUT+"/failure-gallery_e2e.png"});throw e;});
  res.sweepStage = await page.$eval(".side-quest", (s) => s.textContent.replace(/\s+/g, " ").trim()).catch(() => "side quest done");

  // stacks stage shows how many are left
  await page.goto(BASE + "/#duel?stage=stacks");
  await page.waitForSelector("#stage.mini-stage, .stage-done");
  res.stacksHeader = await text("#duel-q");
  for (let k = 0; k < 30 && (await page.$("#stage.mini-stage")); k++) { await page.keyboard.press("ArrowLeft"); await settle(); await page.waitForTimeout(150); }

  // duels: three fast presses are three calls; rank chip with a story when there is one
  await page.goto(BASE + "/#duel?stage=open");
  await page.waitForSelector("#stage .side img");
  await settle();
  const before = await page.evaluate(() => S.progress.votes);
  await page.evaluate(() => { window.__chips = []; new MutationObserver(() => { const c = document.querySelector(".rank-pop"); if (c) window.__chips.push(c.textContent.replace(/\s+/g, " ").trim()); }).observe(document.body, { childList: true, subtree: true }); });
  for (const k of ["ArrowLeft", "ArrowRight", "ArrowLeft"]) { await page.keyboard.press(k); await page.waitForTimeout(250); }
  await page.waitForFunction((b) => S.progress && S.progress.votes >= b + 3, before, { timeout: 15000 }).catch(() => {});
  res.fastKeys = (await page.evaluate(() => S.progress.votes)) - before;
  res.rankChips = await page.evaluate(() => [...new Set(window.__chips)].slice(0, 4));
  await page.screenshot({ path: OUT + "/r-duel.png" });
  // a lightning round, then its scorecard
  await page.click("#hud-bolt", { force: true });
  await page.waitForTimeout(1200);
  for (let k = 0; k < 6; k++) { await page.keyboard.press(k % 2 ? "ArrowLeft" : "ArrowRight"); await settle(); }
  await page.click("#hud-bolt", { force: true });
  await page.waitForSelector(".lr-result", { timeout: 6000 });
  res.lightning = (await text(".lr-result")).slice(0, 80);
  await page.click("#lr-done");

  // finals → ceremony (Esc closes it) → reveal: the champion is #1 everywhere
  await page.goto(BASE + "/#finals");
  await page.waitForSelector("#journey-next.ready, #f-arena");
  if (await page.$("#journey-next.ready")) await page.click("#journey-next");
  await page.waitForSelector("#f-arena");
  await page.screenshot({ path: OUT + "/r-finals.png" });
  for (let k = 0; k < 10 && (await page.$("#f-arena")); k++) {
    const t = await text(".match-title");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((t0) => !document.querySelector(".match-title") || document.querySelector(".match-title").textContent.replace(/\s+/g, " ").trim() !== t0, t, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  // The champion is crowned on the page itself: the podium, the stage-clear card and one way forward, no modal.
  res.ceremony = !!(await page.waitForSelector(".finals-done .stage-done", { timeout: 5000 }).catch(() => null));
  res.ceremonyFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
  res.onePodium = await page.evaluate(() => document.querySelectorAll(".podium").length === 1 && document.querySelectorAll('#journey-next.ready[href="#reveal"]').length === 1 && !document.querySelector('.screen-bar a[href="#reveal"]') && !document.querySelector(".ceremony"));
  assert(res.ceremony && res.ceremonyFocus === "journey-next" && res.onePodium, "One podium, one forward action in the HUD, focused");
  const champ = await page.evaluate(async () => (await (await fetch("/api/finals")).json()).finals.champion);
  await page.goto(BASE + "/#reveal");
  await page.waitForSelector(".reveal");
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + "/r-reveal.png", fullPage: true });
  res.revealTopIsChampion = (await page.$eval(".reveal .pod.gold img", (i) => Number(/\/(\d+)\.jpg/.exec(i.getAttribute("src"))[1]))) === champ;
  res.defeatedOpponents=await page.$$eval('.title-road span b',marks=>marks.map(e=>({mark:e.textContent,color:getComputedStyle(e).color,label:e.getAttribute('aria-label')})));
  assert(res.defeatedOpponents.length>0&&res.defeatedOpponents.every(e=>e.mark==='✕'&&['rgb(255, 107, 91)','rgb(233, 78, 61)'].includes(e.color)&&e.label==='Defeated opponent'  /* the accent: coral, or the paper theme's red marker */));
  assert(await page.locator('.reveal .pod.gold').isVisible(),'The champion keeps the gold podium');
  res.nextCup = await page.$(".next-cup") ? await text(".next-cup") : null;
  await page.evaluate(()=>{
    window.shareText=[];const draw=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,max){
      if(this.canvas.width===1080&&this.canvas.height===1350)shareText.push({text,x,y,width:Math.min(this.measureText(text).width,max??Infinity),align:this.textAlign});
      return max==null?draw.call(this,text,x,y):draw.call(this,text,x,y,max);
    };
  });
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }).catch(() => null), page.click("#x-card")]);
  res.shareCard = dl ? dl.suggestedFilename() : null;
  if (dl) await dl.saveAs(OUT + "/r-sharecard.png");
  res.shareText=await page.evaluate(()=>shareText);
  const taste=res.shareText.filter(t=>t.align==='left'&&t.y>1000);
  assert(taste.length>0&&taste.every(t=>t.width<=420&&t.y<=1191&&t.x+t.width<=990),'Shared taste text stays in its own column and above the title path');
  await page.goto(BASE + "/#shortlist");
  await page.waitForSelector(".tile[data-photo]");
  res.leaderboardTopIsChampion = (await page.$eval(".tile[data-photo]", (t) => Number(t.dataset.photo))) === champ;

  // the unsorted board: everything arrives eventually; a stack opens down its own column; drag one shot onto another
  await page.goto(BASE + "/#draw?g=-1");
  await page.waitForSelector(".tile[data-drag-shot]");
  await page.waitForFunction(() => !document.querySelector("#group-more .muted"), null, { timeout: 30000 }).catch(() => {});
  res.groupsTiles = await page.$$eval(".tile[data-drag-shot]", (t) => t.length);
  res.groupsTotal = await page.evaluate(async () => (await (await fetch("/api/groups?view=all&per=1&theme=-1")).json()).total);
  const exp = await page.$(".tile [data-expand]");
  if (exp) {
    await exp.click();
    await page.waitForSelector(".tile.open .tile-frames");
    res.expanded = await page.$eval(".tile.open", (t) => ({ frames: t.querySelectorAll(".tile-frames .ftile").length,
      crownOnTop: !!t.querySelector(".kept-crown"), rowSpan: t.style.gridRow }));
    await page.screenshot({ path: OUT + "/r-groups-open.png" });
    await exp.click();
    res.collapsed = !(await page.$(".tile.open"));
  }
  const ids = await page.$$eval(".tile[data-drag-shot]", (t) => t.slice(0, 2).map((x) => x.dataset.dragShot));
  const posted = page.waitForResponse((r) => r.url().includes("/api/groups/merge"));
  await page.dragAndDrop(`.tile[data-drag-shot="${ids[0]}"]`, `.tile[data-drag-shot="${ids[1]}"]`);
  res.dragMerge = (await posted.catch(() => null)) ? "merged" : "no merge";

  // moving around the journey track never opens the photo viewer
  const opened = [];
  for (const href of await page.$$eval(".tnode", (n) => n.map((a) => a.getAttribute("href")))) {
    await page.click(`.tnode[href="${href}"]`);
    await page.waitForTimeout(600);
    if (await page.$("dialog#modal[open]")) { opened.push(href); await page.keyboard.press("Escape"); }
  }
  res.navOpenedViewer = opened;

  // phone: finals layout, sweep buttons on screen, toss reachable without hover
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.addCookies(await ctx.cookies());
  const p2 = await phone.newPage();
  activePage=p2;
  p2.on("dialog", (d) => d.accept()); p2.on("pageerror",e=>problems.push("phone: "+e.message));
  await p2.goto(BASE + "/#home");
  await p2.waitForSelector(".journey").catch(async(e)=>{console.error(JSON.stringify({url:p2.url(),text:await p2.locator("#main").innerText(),problems}));await p2.screenshot({path:OUT+"/failure-gallery-phone.png"});throw e;});
  await p2.screenshot({ path: OUT + "/r-phone-home.png", fullPage: true });
  await p2.goto(BASE + "/#duel?stage=open");
  await p2.waitForSelector("#stage .side img");
  // The preceding merge can reopen a stack's Crown before its next open duel.
  res.phoneReopenedCrown=await p2.evaluate(()=>S.current?.type==='mini');
  for(let k=0;k<30;k++){
    await p2.waitForFunction(()=>!S.busy&&!!S.current&&!(S.queued&&S.queued.length));
    if(await p2.evaluate(()=>S.current.type!=='mini'))break;
    const card=await p2.evaluate(()=>S.current.id);
    await p2.keyboard.press('ArrowLeft');
    await p2.waitForFunction(id=>!S.busy&&S.current?.id!==id,card);
  }
  assert.equal(await p2.evaluate(()=>S.current?.type),'duel');
  res.phoneToss = await p2.$eval(".side .toss", (b) => getComputedStyle(b).opacity);
  await p2.screenshot({ path: OUT + "/r-phone-duel.png" });
  await p2.goto(BASE + "/#finals");
  await p2.waitForSelector(".screen.finals");
  res.editedFieldReopensFinals=await p2.locator('#journey-next.ready').count()===1&&/Start Finals|Seed the bracket/.test(await p2.locator('#journey-next').getAttribute('title'))  // phones show the pill as an icon; its title keeps the label;
  assert(res.editedFieldReopensFinals,'Stack edits retire the old championship before the next Finals');
  await p2.click('#journey-next');
  await p2.waitForSelector("#f-arena");
  await p2.waitForTimeout(1200);
  res.phoneFinals = await p2.$$eval("#f-arena .side", (s) => s.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }));
  assert(await p2.evaluate(()=>World.sea.water.length>0),'Phone Finals leaves open space for the sea');
  assert(await p2.evaluate(()=>{const body=document.querySelector('.screen-body').getBoundingClientRect();return [...document.querySelectorAll('#f-arena .side')].every(e=>e.getBoundingClientRect().bottom<=body.bottom+10);}),"Finals players fit the play area");
  assert(await p2.evaluate(()=>document.querySelector('#f-arena').getBoundingClientRect().top<document.querySelector('.screen-rail').getBoundingClientRect().top));
  // The sea runs behind the whole viewport without UI obstacles; what matters is that the header, the prints and
  // the controls stay above it, so a roaming thumbnail never covers what you read or press.
  res.phoneHeaderPhotos=await p2.evaluate(()=>{
    const covered=[];const probe=(el,label)=>{const r=el.getBoundingClientRect();if(!r.width)return;const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(!el.contains(hit))covered.push({label,hit:hit?.className?.toString().slice(0,40)});};
    document.querySelectorAll('.screen-head .stat-chip').forEach(el=>probe(el,'chip'));document.querySelectorAll('#f-arena .side img').forEach(el=>probe(el,'print'));
    document.querySelectorAll('.screen-bar .btn').forEach(el=>probe(el,'control'));return covered;});
  if(res.phoneHeaderPhotos.length){await p2.screenshot({path:OUT+'/failure-phone-header.png'});throw new Error(JSON.stringify({covered:res.phoneHeaderPhotos.slice(0,3),sea:await p2.evaluate(()=>({size:World.sea.s,focus:World.sea.focusState(),water:World.sea.water,obstacles:World.sea.obstacles}))}));}
  // Prints may roam beneath the arena; the playable photos above were hit-tested in the layering probe above.
  res.phoneArenaPhotos=[];
  await p2.screenshot({ path: OUT + "/r-phone-finals.png" });
  res.phoneOverflow = await p2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert(res.lockedWithoutLink && res.cleanUrl && res.revealTopIsChampion && res.leaderboardTopIsChampion);
  assert.equal(res.phoneToss,"1");assert.equal(res.phoneOverflow,false);
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch(async(e) => {
  console.error("FAILED:",e.message);
  if(activePage){
    console.error(JSON.stringify({...res,route:new URL(activePage.url()).hash,text:await activePage.locator('#main').innerText().catch(()=>''),problems}));
    await activePage.screenshot({path:OUT+'/failure-gallery_e2e.png'}).catch(()=>{});
  }
  process.exit(1);
});
