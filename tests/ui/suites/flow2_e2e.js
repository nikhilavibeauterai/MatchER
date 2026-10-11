// The journey in order: Stacks (twin check) → Groups (page, quick sort, find more) → Crown → Group stage → Knockouts.
const { chromium } = require("playwright-core");
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
  res.nextUp = await text(".next-up .next-body b");
  await shot("map");

  // 1. stacks
  await page.click(".next-up .btn");
  await page.waitForSelector(".stacker");
  res.stacksTools = await text(".screen-bar .bar-right .btn.primary");
  await shot("stacks");
  if (await page.$('a[href="#stacks?check=1"]')) {
    await page.click('a[href="#stacks?check=1"]');
    await page.waitForSelector(".twin-arena, .big-emoji");
    if (await page.$(".twin-arena")) await shot("twins");
    for (let k = 0; k < 20 && (await page.$(".twin-arena")); k++) { await page.keyboard.press(k ? "ArrowLeft" : "ArrowRight"); await page.waitForTimeout(700); }
    res.twinsDone = await text("h1");
    await page.click('a[href="#draw"]');
  } else await page.click('.screen-bar a[href="#draw"]');

  // 2. groups: select two and press N, a number to move, drag onto a group, quick sort, find more
  await page.waitForSelector(".gsec.unsorted .tile[data-sel]");
  await shot("groups-empty");
  const t = await page.$$(".gsec.unsorted .tile[data-sel]");
  await t[0].click({ position: { x: 20, y: 60 } });
  await t[1].click({ position: { x: 20, y: 60 } });
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
  await shot("groups");
  await page.click('.screen-bar a[href="#draw?sort=1"]');
  await page.waitForSelector("#dtop");
  await shot("quicksort");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(900);
  await page.keyboard.press("n");
  await page.waitForTimeout(1500);
  res.quickBins = await page.$$eval(".bin:not(.new)", (b) => b.length);
  await page.keyboard.press("Escape");  // Esc leaves a minigame (Enter confirms, like →)
  await page.waitForSelector(".sorter");
  await page.click('.gsec-actions a[href^="#draw?play="]');
  await page.waitForSelector("#dtop, .bulk-card, .deck-note");
  await shot("findmore");
  if (await page.$("#dtop")) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(700); }
  await page.keyboard.press("Escape");  // Esc leaves a minigame (Enter confirms, like →)
  await page.waitForSelector(".sorter");
  await page.click("#d-auto");
  await page.waitForSelector('.screen-bar a[href="#duel?stage=stacks"]', { timeout: 60000 });
  res.groupsDone = await text(".screen-bar .bar-right .btn.primary");
  await shot("groups-done");

  // 3. crown, 4. group stage, 5. knockouts
  await page.click('.screen-bar a[href="#duel?stage=stacks"]');
  await page.waitForSelector("#stage.mini-stage, .stage-done");
  res.crownHere = await page.$eval(".tnode.here .tlabel", (x) => x.textContent).catch(() => null);
  for (let k = 0; k < 20 && (await page.$("#stage.mini-stage")); k++) { await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(700); }
  await page.waitForSelector(".stage-done");
  res.crownDone = await text("#fin-next");
  await page.click("#fin-next");
  await page.waitForSelector("#stage .side img, #stage.mini-stage");
  res.groupHeader = await text("#duel-q");
  for (let k = 0; k < 160 && !(await page.$(".stage-done")); k++) {
    if (!(await page.$("#stage .side"))) { await page.waitForTimeout(250); continue; }
    await page.keyboard.press(k % 3 ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(220);
  }
  res.groupStage = await page.$(".stage-done") ? await text(".stage-done h2") : null;
  if (res.groupStage) {
    await page.click('#finish-bar a[href="#duel?stage=knockouts"]');
    await page.waitForSelector("#stage .side img");
    res.knockouts = await text("#duel-q");
  }
  res.trackDone = await page.$$eval(".tnode.done .tlabel", (t) => t.map((x) => x.textContent));
  await shot("knockouts");
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.addCookies(await ctx.cookies());
  const p2 = await phone.newPage();
  for (const [n, url, sel] of [["map", "/#home", ".next-up"], ["groups", "/#draw", ".sorter"], ["stacks", "/#stacks", ".stacker"]]) {
    await p2.goto(BASE + url);
    await p2.waitForSelector(sel);
    await p2.waitForTimeout(500);
    await p2.screenshot({ path: `${OUT}/g-phone-${n}.png` });
    res[`phoneOverflow_${n}`] = await p2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  }
  res.phoneTrackFits = await p2.evaluate(() => Math.max(...[...document.querySelectorAll(".tnode")].map((x) => x.getBoundingClientRect().right)) <= document.querySelector("#open-menu").getBoundingClientRect().left + 1);
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  console.error(JSON.stringify({ ...res, problems, url: pg && pg.url() }, null, 1));
  if (pg) await pg.screenshot({ path: process.env.OUT + "/g-fail.png" }).catch(() => {});
  process.exit(1);
});
