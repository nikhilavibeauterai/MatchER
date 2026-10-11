// Gallery mode end to end after the review fixes. Every check lands in `res`; anything odd in `problems`.
const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem("matcher-groups-view", "list"); } catch (_) {} });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/status of 40[09]/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !/\/api\/(vote|finals)/.test(r.url())) problems.push(`${r.status()} ${r.url()}`); });
  page.on("dialog", (d) => d.accept());
  const settle = async () => { await page.waitForFunction(() => !S.busy && !(S.queued && S.queued.length), null, { timeout: 15000 }); await page.waitForTimeout(150); };
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
  const res = {};

  // locked without the link, open with it, and the key leaves the address bar
  await page.goto(BASE + "/");
  res.lockedWithoutLink = (await page.content()).includes("MatchER is locked");
  await page.goto(LINK);
  res.cleanUrl = page.url() === BASE + "/" || page.url().startsWith(BASE + "/#");
  await page.waitForSelector(".mode-card");
  res.modePressed = await page.$eval('.mode-card[data-mode="gallery"]', (b) => b.getAttribute("aria-pressed"));
  await page.screenshot({ path: OUT + "/r-onboard.png" });
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go, .journey", { timeout: 300000 }); if (await page.$("#an-go")) { res.reveal = await page.$eval(".an-reveal", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)).catch(() => null); await page.screenshot({ path: OUT + "/" + "gallery_e2e-reveal.png" }); await page.click("#an-go"); } await page.waitForSelector(".journey");
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT + "/r-home.png", fullPage: true });
  res.cups = await page.$$eval(".cup-row b", (c) => c.map((x) => x.textContent.trim()));

  // sweep: finite, fast keys are kept, done afterwards
  await page.goto(BASE + "/#sweep");
  await page.waitForSelector(".swipe-card.top, .sweep-empty");
  if (await page.$(".swipe-card.top")) {
    res.sweepFirst = await text("#sw-count");
    res.sweepLabel = await text(".swipe-card.top .why");
    const n = Number(res.sweepFirst.split("/")[1]);
    for (let k = 0; k < n; k++) { await page.keyboard.press(k % 3 ? "ArrowRight" : "ArrowLeft"); await page.waitForTimeout(60); }
    await page.waitForSelector(".sweep-done", { timeout: 30000 }).catch(() => problems.push("sweep never finished"));
    res.sweepDone = await text(".sweep-done");
  } else res.sweepFirst = "empty";
  await page.goto(BASE + "/#home");
  await page.waitForSelector(".journey");
  res.sweepStage = await page.$eval(".side-quest", (s) => s.textContent.replace(/\s+/g, " ").trim()).catch(() => "side quest done");

  // stacks stage shows how many are left
  await page.goto(BASE + "/#duel?stage=stacks");
  await page.waitForSelector("#stage.mini-stage, .stage-done");
  res.stacksHeader = await text("#duel-q");
  for (let k = 0; k < 30 && (await page.$("#stage.mini-stage")); k++) { await page.keyboard.press("ArrowLeft"); await settle(); await page.waitForTimeout(150); }

  // duels: three fast presses are three calls; rank chip with a story when there is one
  await page.goto(BASE + "/#duel");
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
  await page.waitForSelector("#f-start, #f-arena");
  if (await page.$("#f-start")) await page.click("#f-start");
  await page.waitForSelector("#f-arena");
  await page.screenshot({ path: OUT + "/r-finals.png" });
  for (let k = 0; k < 10 && (await page.$("#f-arena")); k++) {
    const t = await text(".match-title");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((t0) => !document.querySelector(".match-title") || document.querySelector(".match-title").textContent.replace(/\s+/g, " ").trim() !== t0, t, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  res.ceremony = !!(await page.waitForSelector(".ceremony", { timeout: 5000 }).catch(() => null));
  res.ceremonyFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
  await page.keyboard.press("Escape");
  res.ceremonyClosedByEsc = !(await page.$(".ceremony"));
  const champ = await page.evaluate(async () => (await (await fetch("/api/finals")).json()).finals.champion);
  await page.goto(BASE + "/#reveal");
  await page.waitForSelector(".reveal");
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + "/r-reveal.png", fullPage: true });
  res.revealTopIsChampion = (await page.$eval(".reveal .pod.gold img", (i) => Number(/\/(\d+)\.jpg/.exec(i.getAttribute("src"))[1]))) === champ;
  res.nextCup = await page.$(".next-cup") ? await text(".next-cup") : null;
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }).catch(() => null), page.click("#x-card")]);
  res.shareCard = dl ? dl.suggestedFilename() : null;
  if (dl) await dl.saveAs(OUT + "/r-sharecard.png");
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
  p2.on("dialog", (d) => d.accept());
  await p2.goto(BASE + "/#home");
  await p2.waitForSelector(".journey");
  await p2.screenshot({ path: OUT + "/r-phone-home.png", fullPage: true });
  await p2.goto(BASE + "/#duel");
  await p2.waitForSelector("#stage .side img");
  res.phoneToss = await p2.$eval(".side .toss", (b) => getComputedStyle(b).opacity);
  await p2.screenshot({ path: OUT + "/r-phone-duel.png" });
  await p2.goto(BASE + "/#finals");
  await p2.waitForSelector(".screen.finals");
  if (await p2.$("#f-reset")) { await p2.click("#f-reset"); await p2.waitForSelector("#f-start"); await p2.click("#f-start"); }
  await p2.waitForSelector("#f-arena");
  res.phoneFinals = await p2.$$eval("#f-arena .side", (s) => s.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }));
  await p2.screenshot({ path: OUT + "/r-phone-finals.png" });
  res.phoneOverflow = await p2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
