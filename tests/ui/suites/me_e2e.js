// "Photos of me" mode end to end after the review fixes.
const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx0 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx0.addInitScript(() => { try { localStorage.setItem("matcher-groups-view", "list"); } catch (_) {} });
  const page = await ctx0.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/status of 40[09]/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !/\/api\/vote/.test(r.url())) problems.push(`${r.status()} ${r.url()}`); });
  page.on("dialog", (d) => d.accept());
  const settle = async () => { await page.waitForFunction(() => !S.busy && !(S.queued && S.queued.length), null, { timeout: 15000 }); await page.waitForTimeout(150); };
  const shown = () => page.evaluate(() => S.current && { type: S.current.type, ids: [S.current.a, S.current.b] });
  const res = {};
  await page.goto(LINK);
  await page.click('.mode-card[data-mode="me"]');
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go, .journey", { timeout: 300000 }); if (await page.$("#an-go")) { res.reveal = await page.$eval(".an-reveal", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)).catch(() => null); await page.screenshot({ path: OUT + "/" + "me_e2e-reveal.png" }); await page.click("#an-go"); } await page.waitForSelector(".journey");
  await page.click("#open-menu");
  res.peopleInMenu = !!(await page.$('#menu[open] a[href="#people"]'));
  await page.keyboard.press("Escape");
  res.cup = await page.$eval(".screen-head h1", (h) => h.textContent.trim());

  // crown the stacks so the undo checks below are plain duels
  await page.goto(BASE + "/#duel?stage=stacks");
  await page.waitForSelector("#stage.mini-stage, .stage-done");
  if (await page.$("#stage.mini-stage")) {
    const r1 = await page.evaluate(() => JSON.parse(JSON.stringify(S.current)));
    await page.keyboard.press("ArrowLeft"); await settle();
    await page.keyboard.press("z"); await settle();
    const back = await page.evaluate(() => JSON.parse(JSON.stringify(S.current)));
    res.miniUndo = back.type === "mini" && back.round === r1.round;
  }
  for (let k = 0; k < 30 && (await page.$("#stage.mini-stage")); k++) { await page.keyboard.press("ArrowLeft"); await settle(); await page.waitForTimeout(150); }
  await page.goto(BASE + "/#duel");
  await page.waitForSelector("#stage .side img");
  await settle();
  const seq = [];
  for (const k of ["ArrowLeft", "ArrowUp", "ArrowRight"]) { seq.push((await shown()).ids); await page.keyboard.press(k); await settle(); }
  const back = [];
  for (let i = 0; i < 3; i++) { await page.keyboard.press("z"); await settle(); back.push((await shown()).ids); }
  res.undoChain = JSON.stringify(back) === JSON.stringify(seq.slice().reverse());
  res.question = await page.$eval("#duel-q", (q) => q.textContent.trim());
  await page.keyboard.press("f"); await page.waitForTimeout(400);
  res.filterOn = await page.$$eval("#stage .side img", (i) => i.map((x) => x.style.filter));
  await page.keyboard.press("f"); await page.keyboard.press("c"); await page.waitForTimeout(300);
  res.cropToggled = await page.$eval("#crop-btn span", (s) => s.textContent);
  await page.keyboard.press("c");
  await page.screenshot({ path: OUT + "/m-duel.png" });

  // People: "not me" asks first, then can be undone
  await page.goto(BASE + "/#people");
  await page.waitForSelector("#not-me");
  res.undoBefore = !!(await page.$("#people-undo"));
  await page.click("#not-me");
  await page.waitForTimeout(2500);
  await page.waitForSelector("#people-undo", { timeout: 15000 }).catch(() => {});
  res.undoOffered = !!(await page.$("#people-undo"));
  await page.screenshot({ path: OUT + "/m-people.png" });
  if (res.undoOffered) { await page.click("#people-undo"); await page.waitForTimeout(2500); }
  await page.goto(BASE + "/#people");
  await page.waitForSelector("#not-me");
  res.undoGone = !(await page.$("#people-undo"));

  // Set aside: a tile can be rescued with the keyboard
  await page.goto(BASE + "/#cuts");
  await page.waitForSelector(".tile[data-id]");
  await page.focus(".tile[data-id]");
  const was = await page.$eval(".tile[data-id]", (t) => t.classList.contains("rescued"));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  res.keyboardRescue = (await page.$eval(".tile[data-id]", (t) => t.classList.contains("rescued"))) !== was;

  // A board: stack two shots, then one Z puts them back
  await page.goto(BASE + "/#draw?g=-1");
  await page.waitForSelector(".tile[data-sel]");
  const count = () => page.$eval(".gsec.unsorted .gsec-head .muted.small", (x) => parseInt(x.textContent, 10));
  const nBefore = await count();
  const tiles = await page.$$(".gsec.unsorted .tile[data-sel]:not(:has(.badge))");
  await tiles[0].click({ position: { x: 20, y: 60 } });
  await tiles[1].click({ position: { x: 20, y: 60 } });
  await page.click("[data-sel-act=stack]");
  await page.waitForFunction((n) => parseInt(document.querySelector(".gsec.unsorted .gsec-head .muted.small").textContent, 10) === n - 1, nBefore, { timeout: 10000 }).catch(() => {});
  res.mergedTiles = (await count()) - nBefore;
  res.undoButton = await page.$eval("#g-undo", (b) => [b.disabled, b.textContent.replace(/\s+/g, " ").trim()]);
  await page.keyboard.press("z");
  await page.waitForFunction((n) => parseInt(document.querySelector(".gsec.unsorted .gsec-head .muted.small").textContent, 10) === n, nBefore, { timeout: 10000 }).catch(() => {});
  res.afterUndoTiles = (await count()) - nBefore;
  await page.screenshot({ path: OUT + "/m-groups.png" });
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
