const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx0 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx0.addInitScript(() => { try { localStorage.setItem("matcher-groups-view", "list"); } catch (_) {} });
  const page = await ctx0.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(LINK);
  await page.click('.mode-card[data-mode="gallery"]');
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go, .journey", { timeout: 300000 }); if (await page.$("#an-go")) { globalThis.reveal = await page.$eval(".an-reveal", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)).catch(() => null); await page.screenshot({ path: OUT + "/" + "naming_e2e-reveal.png" }); await page.click("#an-go"); } await page.waitForSelector(".journey");
  await page.goto(BASE + "/#draw");
  await page.waitForSelector(".gsec.unsorted .tile[data-sel]");
  await page.click(".gsec.unsorted .tile[data-sel]", { position: { x: 20, y: 60 } });
  await page.keyboard.press("n");
  await page.waitForSelector(".gsec:not(.unsorted) [data-rename]");
  const res = {};
  // rename: the text you type is visible
  await page.click(".gsec:not(.unsorted) [data-rename]");
  await page.keyboard.type("Laptop Time");
  res.renameColor = await page.$eval(".t-input", (i) => [getComputedStyle(i).color, getComputedStyle(i).webkitTextFillColor]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  res.renamed = await page.$eval(".gsec:not(.unsorted) [data-rename]", (b) => b.textContent);
  // emoji search
  await page.click(".gsec:not(.unsorted) [data-emoji-for]");
  await page.waitForSelector(".emoji-search");
  await page.keyboard.type("laptop");
  await page.waitForFunction(() => document.querySelectorAll("#emoji-grid [data-emoji]").length < 10, null, { timeout: 5000 }).catch(() => {});
  res.results = await page.$$eval("#emoji-grid [data-emoji]", (b) => b.map((x) => x.dataset.emoji));
  await page.screenshot({ path: OUT + "/n-emoji.png", clip: { x: 0, y: 56, width: 1280, height: 420 } });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  res.emoji = await page.$eval(".gsec:not(.unsorted) [data-emoji-for]", (b) => b.textContent.trim());
  // look for
  await page.click(".gsec:not(.unsorted) [data-hint]");
  await page.keyboard.type("laptops, screens");
  res.hintColor = await page.$eval(".hint-input", (i) => getComputedStyle(i).color);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  res.hint = await page.$eval(".gsec:not(.unsorted) [data-hint]", (b) => b.textContent.trim());
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
