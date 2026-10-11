// Grab any photo from the sea: on the map and mid-duel; Esc puts it back.
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
  await page.waitForTimeout(3000);
  const res = {};
  const tile = await page.evaluate(() => { const t = [...document.querySelectorAll("#world .ps-item")].find((e) => { const r = e.getBoundingClientRect(); return r.width > 8 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === e; });
    if (!t) return null; const r = t.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  res.foundTile = !!tile;
  if (tile) {
    await page.mouse.click(...tile);
    await page.waitForSelector(".inspect.open", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(700);
    res.inspect = await page.evaluate(() => ({ open: !!document.querySelector(".inspect.open"), tags: document.querySelectorAll(".inspect-tags .tag-chip").length,
      lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
    await page.screenshot({ path: `${OUT}/G-grab.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    res.closed = await page.evaluate(() => ({ open: !!document.querySelector(".inspect"), lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
  }
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
