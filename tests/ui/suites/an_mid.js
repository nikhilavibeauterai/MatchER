// The analysis screen part-way through each step (the grab and the sea sorting itself as tags land).
const { chromium } = require("playwright-core");
const { LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(LINK); await page.fill("#path", LIB); await page.click("#use-path");
  await page.waitForSelector("#an-body");
  const shot = {}, info = {};
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    const st = await page.evaluate(() => { const b = document.querySelector("#an-body"); return b ? { scene: b.dataset.scene, grab: !!document.querySelector(".an-grab.open"),
      tiles: document.querySelectorAll("#an-sea .ps-item").length, chips: document.querySelectorAll("#an-cloud .tag-chip").length,
      circles: [...document.querySelectorAll("#an-sea .vn-tag")].map((t) => t.textContent.replace(/\s+/g, " ").trim()) } : null; }).catch(() => null);
    if (!st || st.scene === "reveal") break;
    info[st.scene] = st;
    if (st.grab && !shot[st.scene]) { shot[st.scene] = true; await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/M-${st.scene}.png` }); }
    await page.waitForTimeout(150);
  }
  console.log(JSON.stringify({ shots: Object.keys(shot), info, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
