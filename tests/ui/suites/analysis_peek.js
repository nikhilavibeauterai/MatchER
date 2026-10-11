// The analysis screen at each step, on a library that has a "me" (details step) — screenshots as scenes change.
const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/403/.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(LINK);
  await page.click('.mode-card[data-mode="me"]');
  await page.fill("#path", LIB);
  await page.click("#use-path");
  const shot = {};
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const st = await page.evaluate(() => { const b = document.querySelector("#an-body"); return b ? b.dataset.scene : (document.querySelector(".journey") ? "home" : null); }).catch(() => null);
    if (st && !shot[st]) {
      shot[st] = true;
      await page.waitForTimeout(st === "organizing" ? 1600 : 700);
      await page.screenshot({ path: `${OUT}/A-${st}.png` });
    }
    if (st === "reveal" || st === "home") break;
    await page.waitForTimeout(150);
  }
  const res = { scenes: Object.keys(shot) };
  res.panel = await page.$eval("#an-panel", (p) => p.innerText.replace(/\s+/g, " ").slice(0, 200)).catch(() => null);
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
