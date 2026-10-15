// Grab any photo from the sea: on the map and mid-duel; Esc puts it back.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
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
  assert(tile,'A visible photo in the map sea must be reachable');
  if (tile) {
    await page.mouse.dblclick(...tile);  // on the map a click zooms to the print; a double-click grabs it
    await page.waitForSelector(".inspect.open", { timeout: 4000 });
    await page.waitForFunction(()=>!document.querySelector('.world-fly'),{},{timeout:3000});
    res.inspect = await page.evaluate(() => ({ open: !!document.querySelector(".inspect.open"), tags: document.querySelectorAll(".inspect-tags .tag-chip").length,
      lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
    await page.screenshot({ path: `${OUT}/G-grab.png` });
    await page.keyboard.press("Escape");
    await page.waitForFunction(()=>!document.querySelector('.inspect, .world-fly'),{},{timeout:3000});
    res.closed = await page.evaluate(() => ({ open: !!document.querySelector(".inspect"), lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
    assert(res.inspect.open);assert.equal(res.closed.open,false);assert.equal(res.closed.lifted,0);
  }
  assert.deepEqual(problems,[]);
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
