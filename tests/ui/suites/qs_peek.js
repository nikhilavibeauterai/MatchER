// Quick sort: Skip defers without editing, keeps its queue through hint reloads, and preserves native keys.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  const writes = [];
  page.on("request", r => { if (r.method() === "POST" && /\/api\/(draw|vote)/.test(r.url())) writes.push(r.url()); });
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
  assert(await unsorted() > 3, "The public fixture needs several unsorted takes");
  const state = () => page.evaluate(async () => {
    const deck = await (await fetch('/api/draw/stragglers')).json(), board = await (await fetch('/api/draw/board')).json();
    return {deck, xp:board.game.xp, undo:board.undo};
  });
  const changed = c => page.waitForFunction(c => document.querySelector('#dtop')?.dataset.photo !== c, c);
  const cursor = () => page.$eval('#bins .cursor', el => el.dataset.bin);
  await page.keyboard.press('ArrowDown');
  const beforeSkip = {card:await card(), count:await unsorted(), cursor:await cursor(), state:await state(), writes:writes.length};
  // A deterministic random choice puts skipped takes at the back, so return order is observable.
  await page.evaluate(() => { window.qsRandom = Math.random; Math.random = () => .999; });
  await page.keyboard.press('Space');
  await changed(beforeSkip.card);
  const second = await card();
  assert.equal(await cursor(), beforeSkip.cursor, 'Skipping keeps the selected group');
  await page.click('[data-c=skip]');
  await changed(second);
  assert.equal(await unsorted(), beforeSkip.count);
  assert.deepEqual(await state(), beforeSkip.state, 'Skipping changes no groups, tosses, XP or undo history');
  assert.equal(writes.length, beforeSkip.writes, 'Skipping sends no edit or vote');

  const beforeNative = await card();
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'qs-native-input'; document.body.append(input);
    const button = document.createElement('button'); button.id = 'qs-native-button'; button.textContent = 'Native action';
    button.onclick = () => { button.dataset.clicks = String(Number(button.dataset.clicks || 0) + 1); }; document.body.append(button);
  });
  await page.focus('#qs-native-input'); await page.keyboard.press('Space');
  assert.equal(await page.inputValue('#qs-native-input'), ' ');
  await page.focus('#qs-native-button'); await page.keyboard.press('Space');
  assert.equal(await page.getAttribute('#qs-native-button', 'data-clicks'), '1');
  assert.equal(await card(), beforeNative, 'Space in an input or native button does not skip');
  await page.evaluate(() => { document.querySelector('#qs-native-input').remove(); document.querySelector('#qs-native-button').remove(); });

  // Creating a group refreshes the dealt hints. The deferred takes must keep their later positions.
  await page.keyboard.press('n'); await changed(beforeNative);
  assert.notEqual(await card(), beforeSkip.card, 'A hint reload cannot undo the first skip');
  assert.notEqual(await card(), second, 'A hint reload cannot undo the second skip');
  let returnsAfter = 0;
  while (await card() !== beforeSkip.card && returnsAfter < 12) {
    const previous = await card(); await page.keyboard.press('Space'); await changed(previous); returnsAfter++;
  }
  assert.equal(await card(), beforeSkip.card, 'The skipped take eventually returns');
  res.skip = {count:beforeSkip.count, returned:beforeSkip.card, returnsAfter, nativeKeys:true};
  await page.evaluate(() => { Math.random = window.qsRandom; delete window.qsRandom; });
  res.beforePlace = { unsorted: await unsorted(), sizes: await sizes(), card: await card() };
  await page.keyboard.press("1");  // into group 1
  await page.waitForFunction((c) => document.querySelector("#dtop") && document.querySelector("#dtop").dataset.photo !== c, res.beforePlace.card);
  res.afterPlace = { unsorted: await unsorted(), sizes: await sizes(), card: await card() };
  assert.equal(res.afterPlace.unsorted, res.beforePlace.unsorted - 1);
  assert.equal(Number(res.afterPlace.sizes[0]), Number(res.beforePlace.sizes[0]) + 1);
  await page.keyboard.press("ArrowLeft");  // toss
  await page.waitForFunction((c) => document.querySelector("#dtop") && document.querySelector("#dtop").dataset.photo !== c, res.afterPlace.card);
  res.afterToss = { unsorted: await unsorted(), card: await card(), tossed: res.afterPlace.card };
  assert.equal(res.afterToss.unsorted, res.afterPlace.unsorted - 1);
  await page.keyboard.press("z");
  await page.waitForFunction((c) => document.querySelector("#dtop") && document.querySelector("#dtop").dataset.photo === c, res.afterPlace.card, { timeout: 8000 });
  res.afterUndo = { unsorted: await unsorted(), card: await card() };
  assert.equal(res.afterUndo.unsorted, res.afterPlace.unsorted);
  await page.waitForTimeout(1500);
  res.look = await page.$eval("#dtop", (d) => ({ op: getComputedStyle(d).opacity, cls: d.className, imgOp: getComputedStyle(d.querySelector("img")).opacity,
    filter: getComputedStyle(d.querySelector("img")).filter, stamp: getComputedStyle(d.querySelector(".stamp.toss")).opacity }));
  await page.screenshot({ path: `${OUT}/qs-peek.png` });
  const publicDeck = beforeSkip.state.deck;
  await page.goto(BASE + '/#home');
  let deals = 0;
  await page.route('**/api/draw/stragglers', route => route.fulfill({json:{...publicDeck, left:3,
    cards:publicDeck.cards.slice(0, ++deals === 1 ? 1 : 3)}}));
  await page.goto(BASE + '/#draw?sort=1'); await page.waitForSelector('#dtop');
  const lastInBatch = await card(), beforeRefill = writes.length;
  await page.keyboard.press('Space'); await changed(lastInBatch);
  assert.equal(deals, 2, 'Skipping the end of a batch first deals the remaining takes');
  assert.equal(await unsorted(), 3); assert.equal(writes.length, beforeRefill);
  await page.goto(BASE + '/#home');
  await page.unroute('**/api/draw/stragglers');
  await page.route('**/api/draw/stragglers', route => route.fulfill({json:{...publicDeck, left:1, cards:publicDeck.cards.slice(0,1)}}));
  await page.goto(BASE + '/#draw?sort=1'); await page.waitForSelector('#dtop');
  const last = await card(), beforeLast = writes.length;
  assert.equal(await page.locator('[data-c=skip]').count(), 1, 'The final take can still be left for later');
  await page.keyboard.press('Space'); await page.waitForURL('**/#draw');
  assert.equal(writes.length, beforeLast, 'Leaving the final take makes no decision');
  await page.goto(BASE + '/#draw?sort=1'); await page.waitForSelector('#dtop');
  assert.equal(await card(), last); assert.equal(await unsorted(), 1);
  res.skip.refilledBatch = true; res.skip.lastTakeDeferred = true;
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
