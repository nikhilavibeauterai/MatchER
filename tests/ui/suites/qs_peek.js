// Quick sort: a placement bumps the group's count at once; ← tosses (to Set aside); Z brings it back.
const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/403/.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(LINK);
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go", { timeout: 300000 });
  await page.click("#an-go");
  await page.waitForSelector(".journey");
  await page.goto(BASE + "/#home");
  await page.goto(BASE + "/#draw?sort=1");
  await page.waitForSelector("#dtop");
  const res = {};
  const unsorted = async () => Number((await page.$eval(".play-head .stat-chip b", (b) => b.textContent)).replace(/\D/g, ""));
  const sizes = () => page.$$eval("#bins .bin[data-bin]:not(.new) .bin-size", (xs) => xs.map((x) => x.textContent.trim()));
  const card = () => page.$eval("#dtop", (d) => d.dataset.photo);
  res.start = { unsorted: await unsorted(), sizes: await sizes() };
  if (!res.start.sizes.length) { await page.keyboard.press("n"); await page.waitForFunction(() => document.querySelectorAll("#bins .bin[data-bin]:not(.new)").length > 0); }
  res.beforePlace = { unsorted: await unsorted(), sizes: await sizes(), card: await card() };
  await page.keyboard.press("1");  // into group 1
  await page.waitForFunction((c) => document.querySelector("#dtop") && document.querySelector("#dtop").dataset.photo !== c, res.beforePlace.card);
  res.afterPlace = { unsorted: await unsorted(), sizes: await sizes(), card: await card() };
  await page.keyboard.press("ArrowLeft");  // toss
  await page.waitForFunction((c) => document.querySelector("#dtop") && document.querySelector("#dtop").dataset.photo !== c, res.afterPlace.card);
  res.afterToss = { unsorted: await unsorted(), card: await card(), tossed: res.afterPlace.card };
  await page.keyboard.press("z");
  await page.waitForFunction((c) => document.querySelector("#dtop") && document.querySelector("#dtop").dataset.photo === c, res.afterPlace.card, { timeout: 8000 }).catch(() => {});
  res.afterUndo = { unsorted: await unsorted(), card: await card() };
  await page.waitForTimeout(1500);
  res.look = await page.$eval("#dtop", (d) => ({ op: getComputedStyle(d).opacity, cls: d.className, imgOp: getComputedStyle(d.querySelector("img")).opacity,
    filter: getComputedStyle(d.querySelector("img")).filter, stamp: getComputedStyle(d.querySelector(".stamp.toss")).opacity }));
  await page.screenshot({ path: `${OUT}/qs-peek.png` });
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
