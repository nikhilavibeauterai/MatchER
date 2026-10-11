const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.accept());
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
    await fetch("/api/draw/move", { method: "POST", headers: h, body: JSON.stringify({ photos: b.groups.flatMap((g) => g.shots.slice(0, 1).map((x) => x.rep)), theme: null }) });
  });
  const res = {};
  await page.goto(BASE + "/#draw?sort=1");
  await page.waitForSelector("#dtop");
  const cursor = () => page.evaluate(() => { const c = document.querySelector("#bins .bin.cursor"); return c ? c.textContent.replace(/\s+/g, " ").trim() : null; });
  res.start = await cursor();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
  res.afterDown2 = await cursor();
  res.button = await page.$eval(".bar-right .btn", (b) => b.textContent.replace(/\s+/g, " ").trim());
  await page.screenshot({ path: OUT + "/Q-cursor.png" });
  const photo = await page.$eval("#dtop", (d) => Number(d.dataset.photo));
  const aimed = await page.evaluate(() => document.querySelector("#bins .bin.cursor").dataset.bin);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
  res.placedInAimed = await page.evaluate(async ([p, g]) => { const b = await (await fetch("/api/draw/board?per=400")).json(); const grp = b.groups.find((x) => String(x.id) === g); return !!grp && grp.shots.some((x) => x.rep === p || x.members.includes(p)); }, [photo, aimed]);
  // Find more's pick mode
  const g = await page.evaluate(async () => (await (await fetch("/api/draw")).json()).groups[0].id);
  await page.goto(`${BASE}/#draw?play=${g}`);
  await page.waitForSelector("#dtop, .bulk-card, .deck-note");
  if (await page.$("#dtop")) {
    await page.keyboard.press("ArrowLeft");
    res.pickStart = await cursor();
    await page.keyboard.press("ArrowUp");
    res.pickAfterUp = await cursor();
    res.pickButton = await page.$eval(".bar-right .btn", (b) => b.textContent.replace(/\s+/g, " ").trim());
  }
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
