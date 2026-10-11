// The sea behind every screen: on the map, and photos lifting out of it into a duel and sinking back.
const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/403/.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(LINK); await page.fill("#path", LIB); await page.click("#use-path");
  await page.waitForSelector("#an-go", { timeout: 300000 }); await page.click("#an-go"); await page.waitForSelector(".journey");
  await page.waitForTimeout(3500);
  const res = {};
  res.map = await page.evaluate(() => ({ mode: document.body.dataset.world, tiles: document.querySelectorAll("#world .ps-item").length,
    opacity: getComputedStyle(document.querySelector("#world")).opacity }));
  await page.screenshot({ path: `${OUT}/W-map.png` });
  await page.goto(BASE + "/#duel");
  await page.waitForSelector("#stage .side img");
  await page.waitForTimeout(120);
  res.duelIn = await page.evaluate(() => ({ mode: document.body.dataset.world, flying: document.querySelectorAll(".world-fly").length,
    lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
  await page.screenshot({ path: `${OUT}/W-duel-in.png` });
  await page.waitForTimeout(600);
  res.duelLanded = await page.evaluate(() => ({ flying: document.querySelectorAll(".world-fly").length, lifted: document.querySelectorAll("#world .ps-item.lifted").length,
    shown: [...document.querySelectorAll("#stage .side img")].map((i) => i.style.opacity) }));
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(450);
  res.afterVote = await page.evaluate(() => ({ flying: [...document.querySelectorAll(".world-fly")].map((f) => f.className), lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
  await page.screenshot({ path: `${OUT}/W-duel-swap.png` });
  await page.waitForTimeout(900);
  res.settled = await page.evaluate(() => ({ flying: document.querySelectorAll(".world-fly").length, lifted: document.querySelectorAll("#world .ps-item.lifted").length,
    won: document.querySelectorAll("#world .ps-item.ps-won").length }));
  await page.goto(BASE + "/#home");
  await page.waitForTimeout(800);
  res.backHome = await page.evaluate(() => ({ mode: document.body.dataset.world, lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
