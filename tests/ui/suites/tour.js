// A tour of every screen, set up mid-game, at desktop and phone sizes.
const { chromium } = require("playwright-core");
const { BASE, LINK, LIB, OUT } = process.env;
const DIR = OUT + "/../tour";
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const shot = async (name, p = page) => { await p.waitForTimeout(900); await p.screenshot({ path: `${DIR}/${name}.png` }); };
  await page.goto(LINK);
  await shot("01-new-save");
  await page.click('.mode-card[data-mode="gallery"]');
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-go", { timeout: 300000 });
  await shot("02-reveal-analysis");
  await page.click("#an-go");
  await page.waitForSelector(".journey");
  await shot("03-map");
  // set the game up part way: grouped, a few duels
  await page.evaluate(async () => {
    const h = { "Content-Type": "application/json", "X-MatchER": "1" };
    await fetch("/api/draw/auto", { method: "POST", headers: h, body: "{}" });
    const b = await (await fetch("/api/draw/board?per=400")).json();
    await fetch("/api/draw/move", { method: "POST", headers: h, body: JSON.stringify({ photos: b.groups.flatMap((g) => g.shots.slice(0, 1).map((x) => x.rep)), theme: null }) });
    let cards = (await (await fetch("/api/deal?n=1&stage=open", {method:"POST",headers:h,body:"{}"})).json()).cards;
    for (let k = 0; k < 30 && cards.length; k++) {
      const r = await (await fetch("/api/vote", { method: "POST", headers: h, body: JSON.stringify({ card: cards[0].id, outcome: k % 2 ? "a" : "b", ms: 900, stage: "open" }) })).json();
      cards = r.cards;
    }
  });
  const go = async (name, hash, sel) => { await page.goto(BASE + "/#home"); await page.waitForSelector(".journey"); await page.goto(BASE + hash); await page.waitForSelector(sel, { timeout: 15000 }).catch(() => problems.push(`no ${sel} on ${hash}`)); await shot(name); };
  await go("04-map-midgame", "/#home", ".journey");
  await go("05-stacks", "/#stacks", ".stacker");
  await go("06-twin-check", "/#stacks?check=1", ".screen");
  await go("07-groups-sea", "/#draw", ".ps-item");
  await page.evaluate(() => localStorage.setItem("matcher-groups-view", "list"));
  await go("08-groups-list", "/#draw", ".gsec");
  await page.evaluate(() => localStorage.setItem("matcher-groups-view", "sea"));
  await go("09-quick-sort", "/#draw?sort=1", "#dtop, .big-emoji");
  const g = await page.evaluate(async () => (await (await fetch("/api/draw/board?per=4&uper=4")).json()).groups[0].id);
  await go("10-find-more", `/#draw?play=${g}`, "#ddeck .swipe-card, #ddeck .deck-note, .bulk-card");
  await go("11-crown", "/#duel?stage=stacks", "#stage.mini-stage, .stage-done");
  await go("12-group-stage", "/#duel?stage=groups", "#stage .side img, #stage.mini-stage, .stage-done");
  await go("13-knockouts", "/#duel?stage=knockouts", "#stage .side img, #stage.mini-stage");
  await go("14-finals", "/#finals", ".screen.finals");
  await go("15-reveal", "/#reveal", ".reveal");
  await go("16-leaderboard", "/#shortlist", ".tile[data-photo], .screen.board");
  await go("17-set-aside", "/#cuts", ".screen.cuts");
  await go("18-sweep", "/#sweep", ".screen.sweep, .sweep-empty");
  await go("19-saves", "/#saves", ".save-card");
  await page.goto(BASE + "/#home");
  await page.waitForSelector(".journey");
  await page.click("#open-menu");
  await shot("20-menu");
  await page.keyboard.press("Escape");
  await page.click("#open-menu");await page.click('[data-menu-page="play"]');await page.click('[data-m="trophies"]');
  await shot("21-trophies");
  await page.keyboard.press("Escape");
  if(await page.locator("#menu[open]").count())await page.click("#menu-resume");
  await page.click("#open-menu");
  await page.click('[data-menu-page="library"]');await page.click('[data-m="settings"]');
  await shot("22-settings");
  await page.keyboard.press("Escape");
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.addCookies(await ctx.cookies());
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => problems.push(`phone pageerror: ${e.message}`));
  for (const [name, hash, sel] of [["p-map", "/#home", ".journey"], ["p-stacks", "/#stacks", ".stacker"], ["p-groups", "/#draw", ".screen"],
    ["p-quick-sort", "/#draw?sort=1", "#dtop, .big-emoji"], ["p-duel", "/#duel?stage=knockouts", "#stage .side img, #stage.mini-stage"],
    ["p-finals", "/#finals", ".screen.finals"], ["p-leaderboard", "/#shortlist", ".screen.board"], ["p-saves", "/#saves", ".save-card"]]) {
    await p2.goto(BASE + "/#home"); await p2.waitForSelector(".journey").catch(() => {});
    await p2.goto(BASE + hash);
    await p2.waitForSelector(sel, { timeout: 15000 }).catch(() => problems.push(`phone: no ${sel} on ${hash}`));
    await shot(name, p2);
    const over = await p2.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (over) problems.push(`phone overflow on ${hash}`);
  }
  console.log(JSON.stringify({ problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
