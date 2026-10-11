const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const problems = [];
  globalThis.__probs = problems;
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  // every visible input must sit inside its nearest container
  const spill = () => page.evaluate(() => [...document.querySelectorAll("input, select")].filter((i) => i.offsetParent).map((i) => {
    const box = i.closest(".bin, .screen-head, .gsec-head, .island-pop, .emoji-pop, .row, dialog, .pop-card, .action-bar") || i.parentElement;
    const a = i.getBoundingClientRect(), b = box.getBoundingClientRect();
    return a.right > b.right + 1 || a.left < b.left - 1 ? `${i.className || i.id || i.tagName} spills out of ${box.className || box.tagName} by ${Math.round(Math.max(a.right - b.right, b.left - a.left))}px` : null;
  }).filter(Boolean));
  const res = { spills: [] };
  await page.goto(LINK);
  await page.click('.mode-card[data-mode="gallery"]');
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go", { timeout: 300000 });
  await page.click("#an-go");
  await page.waitForSelector(".journey");
  await page.evaluate(async () => {
    const h = { "Content-Type": "application/json", "X-MatchER": "1" };
    await fetch("/api/draw/auto", { method: "POST", headers: h, body: "{}" });
    const b = await (await fetch("/api/draw/board?per=400")).json();
    await fetch("/api/draw/move", { method: "POST", headers: h, body: JSON.stringify({ photos: b.groups.flatMap((g) => g.shots.slice(0, 1).map((x) => x.rep)), theme: null }) });
  });
  // Quick sort: E renames the highlighted group
  await page.goto(BASE + "/#draw?sort=1");
  await page.waitForSelector("#dtop");
  await page.keyboard.press("e");
  await page.waitForSelector(".bin-input");
  res.spills.push(...(await spill()));
  const photoBefore = await page.$eval("#dtop", (d) => d.dataset.photo);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("A Rather Long Group Name For Testing Overflow");
  res.spaceKeptCard = (await page.$eval("#dtop", (d) => d.dataset.photo)) === photoBefore && !!(await page.$(".bin-input"));
  res.spills.push(...(await spill()));
  await page.screenshot({ path: OUT + "/I-quicksort-rename.png" });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  res.urlAfterRename = page.url().replace(/^.*#/, "#");
  res.cardAfterRename = (await page.$eval("#dtop", (d) => d.dataset.photo).catch(() => null)) === photoBefore;
  res.renamed = await page.evaluate(async () => (await (await fetch("/api/draw")).json()).groups.some((g) => g.name === "A Rather Long Group Name For Testing Overflow"));
  await page.evaluate(async () => {  // enough groups for the 10th and 11th keys
    const h = { "Content-Type": "application/json", "X-MatchER": "1" };
    for (let k = 0; k < 12; k++) {
      const b = await (await fetch("/api/draw/board?per=400")).json();
      const n = b.groups.length;
      if (n >= 12) break;
      const donor = b.groups.find((g) => g.shots.length > 1);
      if (!donor) break;
      await fetch("/api/draw/new", { method: "POST", headers: h, body: JSON.stringify({ photos: [donor.shots[donor.shots.length - 1].rep] }) });
    }
  });
  await page.goto(BASE + "/#home");
  await page.waitForSelector(".journey");
  await page.goto(BASE + "/#draw?sort=1");
  await page.waitForSelector("#dtop");
  res.labels = await page.$$eval("#bins .bin-n", (x) => x.map((e) => e.textContent.trim()));
  const keyTest = async (press, idx) => {
    await page.waitForSelector("#dtop");
    const photo = await page.$eval("#dtop", (d) => Number(d.dataset.photo));
    const gid = await page.$$eval("#bins [data-bin]", (x, i) => x[i] && x[i].dataset.bin, idx);
    await page.keyboard.press(press);
    await page.waitForTimeout(1200);
    return page.evaluate(async ([p, g]) => { const b = await (await fetch("/api/draw/board?per=400")).json(); const grp = b.groups.find((x) => String(x.id) === g); return !!grp && grp.shots.some((x) => x.rep === p || x.members.includes(p)); }, [photo, gid]);
  };
  const order0 = await page.$$eval("#bins [data-bin]:not(.new)", (x) => x.map((e) => e.dataset.bin));
  await page.keyboard.press("ArrowUp");  // highlight the first group (from the ★ one, wherever it is)
  for (let k = 0; k < 20; k++) { const at = await page.$$eval("#bins [data-bin]", (x) => x.findIndex((e) => e.classList.contains("cursor"))); if (at === 0) break; await page.keyboard.press("ArrowUp"); }
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(900);
  const order1 = await page.$$eval("#bins [data-bin]:not(.new)", (x) => x.map((e) => e.dataset.bin));
  res.shiftMoved = order1[1] === order0[0] && order1[0] === order0[1];
  res.cursorFollowed = await page.$$eval("#bins [data-bin]", (x) => x.findIndex((e) => e.classList.contains("cursor"))) === 1;
  res.key0 = await keyTest("0", 9);
  res.keyAlt1 = await keyTest("Alt+1", 10);
  // the ✏️ on a bin
  await page.hover("#bins .bin:not(.new)");
  await page.click("#bins .bin:not(.new) .bin-edit");
  res.pencilOpens = !!(await page.$(".bin-input"));
  await page.keyboard.press("Escape");
  await page.click("#bins .bin:not(.new) .bin-emoji");
  await page.waitForSelector(".emoji-search");
  await page.keyboard.type("dog");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  res.emojiFromList = await page.$eval("#bins .bin:not(.new) .bin-emoji", (e) => e.textContent.trim());
  // Find more: head rename + look-for
  const g = await page.evaluate(async () => (await (await fetch("/api/draw")).json()).groups[0].id);
  await page.goto(`${BASE}/#draw?play=${g}`);
  await page.waitForSelector("#t-name");
  await page.click("#t-name");
  res.spills.push(...(await spill()));
  await page.keyboard.press("Escape");
  await page.click("#t-hint");
  res.spills.push(...(await spill()));
  await page.screenshot({ path: OUT + "/I-findmore-hint.png" });
  await page.keyboard.press("Escape");
  // list view section rename + hint
  await page.evaluate(() => localStorage.setItem("matcher-groups-view", "list"));
  await page.goto(BASE + "/#home");
  await page.waitForSelector(".journey");
  await page.goto(BASE + "/#draw");
  await page.waitForSelector(".gsec [data-rename]");
  await page.click(".gsec [data-rename]");
  res.spills.push(...(await spill()));
  await page.keyboard.press("Escape");
  await page.click(".gsec [data-hint]");
  res.spills.push(...(await spill()));
  await page.keyboard.press("Escape");
  // sea view island menu + emoji search
  await page.evaluate(() => localStorage.setItem("matcher-groups-view", "sea"));
  await page.goto(BASE + "/#home");
  await page.waitForSelector(".journey");
  await page.goto(BASE + "/#draw");
  await page.waitForSelector(".ps-tag");
  await page.click(".ps-tag");
  await page.waitForSelector(".island-pop");
  res.spills.push(...(await spill()));
  await page.click(".island-pop [data-tp=emoji]");
  await page.waitForSelector(".emoji-search");
  res.spills.push(...(await spill()));
  await page.screenshot({ path: OUT + "/I-island.png" });
  // phone: the welcome path box
  const phone = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true });
  await phone.addCookies(await ctx.cookies());
  const p2 = await phone.newPage();
  await p2.goto(BASE + "/#onboard?new=1");
  await p2.waitForSelector("#path");
  res.phoneSpill = await p2.evaluate(() => { const i = document.querySelector("#path"), r = i.closest(".row").getBoundingClientRect(), a = i.getBoundingClientRect(); return Math.round(a.right - r.right); });
  res.phoneOverflow = await p2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch(async (e) => { console.error("FAILED:", e.message, JSON.stringify(globalThis.__probs || [])); process.exit(1); });
