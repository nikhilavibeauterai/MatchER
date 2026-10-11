// A knockout duel: the seat-race rail beside it, team badges on the photos, the sea in the margins.
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
  await page.goto(BASE + "/#duel?stage=knockouts");
  await page.waitForSelector("#stage .side img");
  await page.waitForTimeout(2500);
  const res = await page.evaluate(() => ({ rail: !!document.querySelector("#view-duel.with-table"), seats: document.querySelectorAll(".gt-rows.seats li:not(.gt-sep)").length,
    onLine: document.querySelectorAll(".gt-rows.seats li.on-line").length, teams: document.querySelectorAll("#stage .team-chip").length,
    q: document.querySelector("#duel-q").textContent.trim().slice(0, 80) }));
  await page.screenshot({ path: `${OUT}/K-duel.png` });
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
