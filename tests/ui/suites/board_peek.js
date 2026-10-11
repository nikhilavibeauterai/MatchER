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
  await page.evaluate(async () => { const h = { "Content-Type": "application/json", "X-MatchER": "1" }; await fetch("/api/draw/auto", { method: "POST", headers: h, body: "{}" }); });
  await page.goto(BASE + "/#duel?stage=groups");
  for (let k = 0; k < 10; k++) { await page.waitForSelector("#stage .side img, .stage-done", { timeout: 10000 }); if (await page.$(".stage-done")) break; await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(500); }
  await page.goto(BASE + "/#home"); await page.waitForSelector(".journey");
  await page.click(".hud-btn");
  await page.waitForSelector(".tb-body");
  await page.waitForTimeout(1500);
  const res = await page.evaluate(() => ({ groups: document.querySelectorAll(".tb-group").length, rows: document.querySelectorAll(".tb-roster li").length,
    through: document.querySelectorAll(".tb-roster li.through").length, seats: document.querySelectorAll(".tb-seat:not(.bubble)").length,
    bubble: document.querySelectorAll(".tb-seat.bubble").length, bracket: !!document.querySelector(".tb-bracket"), teams: document.querySelectorAll(".tb-seat .team-chip").length }));
  await page.screenshot({ path: `${OUT}/T-board.png` });
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
