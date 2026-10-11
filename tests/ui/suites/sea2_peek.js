const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => d.accept());
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url().replace(/^.*\/api\//, "") + " " + (r.postData() || "")); });
  await page.goto(LINK);
  await page.click('.mode-card[data-mode="gallery"]');
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go", { timeout: 300000 });
  await page.click("#an-go");
  await page.waitForSelector(".journey");
  await page.evaluate(async () => {
    const h = { "Content-Type": "application/json", "X-MatchER": "1" };
    await fetch("/api/draw/auto", { method: "POST", headers: h, body: "{}" });
    const b = await (await fetch("/api/draw/board?per=400")).json();
    const pick = b.groups.flatMap((g) => g.shots.slice(0, 2).map((x) => x.rep)).slice(0, 8);
    await fetch("/api/draw/move", { method: "POST", headers: h, body: JSON.stringify({ photos: pick, theme: null }) });
  });
  await page.goto(BASE + "/#draw");
  await page.waitForSelector(".ps-item");
  await page.waitForTimeout(3500);
  await page.screenshot({ path: OUT + "/P-sea.png" });
  const res = {};
  res.items = await page.$$eval(".ps-item", (x) => x.length);
  res.circles = await page.$$eval(".vn-tag", (x) => x.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  res.fps = await page.evaluate(() => new Promise((ok) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else ok(Math.round(n / 2)); }; requestAnimationFrame(f); }));
  res.prof = await page.evaluate(() => new Promise((ok) => {
    const P = PhotoSea.prototype, t = { tick: 0, layout: 0, nt: 0, nl: 0 }, ot = P.tick, ol = P.layout;
    P.tick = function (n) { const a = performance.now(); ot.call(this, n); t.tick += performance.now() - a; t.nt++; };
    P.layout = function () { const a = performance.now(); ol.call(this); t.layout += performance.now() - a; t.nl++; };
    setTimeout(() => { P.tick = ot; P.layout = ol; ok({ tickMs: +(t.tick / Math.max(1, t.nt)).toFixed(2), ticks: t.nt, layouts: t.nl, layoutMs: +(t.layout / Math.max(1, t.nl)).toFixed(2) }); }, 2000);
  }));
  res.fps2 = await page.evaluate(() => new Promise((ok) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else ok(Math.round(n / 2)); }; requestAnimationFrame(f); }));
  // drag an unsorted photo onto the first group in the side list
  const unsorted = () => page.evaluate(async () => (await (await fetch("/api/draw")).json()).total - (await (await fetch("/api/draw")).json()).drawn);
  res.unsortedBefore = await unsorted();
  const free = await page.evaluate(() => { const ps = document.querySelector("#world"); const r0 = ps.getBoundingClientRect();
    const it = [...ps.querySelectorAll(".ps-item")].find((e) => e.title.startsWith("Not in a group"));  // (the tag sea: any unsorted shot)
    const r = it.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const ring = await page.$eval("#bins .bin:not(.new)", (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });  // a group in the side list
  await page.mouse.move(free[0], free[1]);
  await page.mouse.down();
  await page.mouse.move((free[0] + ring[0]) / 2, (free[1] + ring[1]) / 2, { steps: 8 });
  await page.mouse.move(ring[0], ring[1], { steps: 8 });
  await page.screenshot({ path: OUT + "/P-dragging.png" });
  res.dragState = await page.evaluate(() => { const d = document.querySelector(".ps-item.dragging"); return !!d; });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  res.unsortedAfterDrop = await unsorted();
  res.posts = posts.slice(-3);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + "/P-after-drop.png" });
  // select two unsorted photos and press 1
  const two = await page.evaluate(() => [...document.querySelectorAll("#world .ps-item")].filter((e) => e.title.startsWith("Not in a group")).slice(0, 2)
    .map((e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }));
  for (const [x, y] of two) { await page.mouse.click(x, y); await page.waitForTimeout(150); }
  res.selected = await page.$$eval(".ps-item.selected", (x) => x.length);
  await page.keyboard.press("1");
  await page.waitForTimeout(2000);
  res.unsortedAfterKey = await unsorted();
  await page.keyboard.press("z");
  await page.waitForTimeout(1500);
  res.unsortedAfterUndo = await unsorted();
  // island menu
  await page.click(".ps-tag");
  await page.waitForSelector(".island-pop");
  await page.screenshot({ path: OUT + "/P-island-menu.png" });
  res.menu = await page.$eval(".island-pop", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 120));
  await page.keyboard.press("Escape");
  // list view still there
  await page.click('[data-mode="list"]');
  await page.waitForSelector(".gsec");
  res.listView = await page.$$eval(".gsec", (x) => x.length);
  await page.click('[data-mode="sea"]');
  await page.waitForSelector(".ps-item");
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
