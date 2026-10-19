// The analysis (photos bubbling to their kinds, Looking closer, the tags step) and the tag sea on the Groups page.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { BASE, LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [], posts = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/403/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/(tags|draw|groups)\//.test(r.url())) posts.push(r.url().split("/api/")[1]); });
  await page.goto(LINK);
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-body");
  const res = { scenes: {} };
  const t0 = Date.now();
  let shotDetails = false, shotOrg = false;
  while (Date.now() - t0 < 300000) {
    const st = await page.evaluate(() => {
      const b = document.querySelector("#an-body");
      if (!b) return null;
      const items = [...document.querySelectorAll("#an-sea .ps-item")];
      return { scene: b.dataset.scene, items: items.length, closer: b.dataset.scene === "details" && !!document.querySelector(".an-grab-findings"), seen: document.querySelectorAll(".an-grab-findings .tag-chip").length,
        cloud: document.querySelectorAll(".an-tagcloud .tag-chip").length, go: !!document.querySelector("#an-go") };
    }).catch(() => null);
    if (!st) break;
    const sc = res.scenes[st.scene] || (res.scenes[st.scene] = { minItems: 1e9, maxItems: 0, samples: 0 });
    sc.samples++; sc.minItems = Math.min(sc.minItems, st.items); sc.maxItems = Math.max(sc.maxItems, st.items);
    if (st.scene === "understanding" && !sc.first) sc.first = st.items;
    if (st.closer && !shotDetails && st.seen) { shotDetails = true; res.seenRows = st.seen; await page.screenshot({ path: `${OUT}/V-details.png` }); }
    if (st.cloud && !shotOrg) { shotOrg = true; await page.waitForTimeout(1500); await page.screenshot({ path: `${OUT}/V-organizing.png` }); }
    if (st.go) break;
    await page.waitForTimeout(200);
  }
  await page.waitForSelector("#an-go", { timeout: 60000 });
  res.revealTags = await page.$eval(".an-reveal", (e) => /tags, the groups/.test(e.innerText));
  await page.screenshot({ path: `${OUT}/V-reveal.png` });
  await page.click("#an-go");
  await page.waitForSelector(".journey");
  await page.goto(BASE + "/#home");
  await page.goto(BASE + "/#draw");
  await page.waitForSelector(".vn-tag", { timeout: 20000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/V-sea.png` });
  res.fps = await page.evaluate(() => new Promise((ok) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else ok(Math.round(n / 2)); }; requestAnimationFrame(f); }));
  // circles from the photos themselves: each shown tag's photos (by their titles), their middle and their spread
  const info = () => page.evaluate(() => {
    const items = [...document.querySelectorAll(".ps-item")].map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.id, title: el.title, x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const labels = [...document.querySelectorAll(".vn-tag")].map((t) => t.textContent.replace(/\s+/g, " ").trim());
    const circles = labels.map((l) => {
      const name = l.replace(/\s+\d+\+?$/, "").replace(/^\S+\s/, "").trim();
      const ms = items.filter((it) => it.title.split(" · ").slice(1).join(" · ").split(", ").includes(name));
      if (!ms.length) return { name, n: 0 };
      const cx = ms.reduce((a, m) => a + m.x, 0) / ms.length, cy = ms.reduce((a, m) => a + m.y, 0) / ms.length;
      return { name, n: ms.length, cx, cy, r: Math.max(...ms.map((m) => Math.hypot(m.x - cx, m.y - cy))) + 30 };
    });
    let overlap = 0;
    for (const it of items) for (const o of items) if (it !== o && Math.hypot(it.x - o.x, it.y - o.y) < 20) overlap++;
    return { labels, circles, items: items.length, stacked: document.querySelectorAll(".ps-item.stacked").length, piledOnTop: overlap / 2,
      lassos: [...document.querySelectorAll(".vn-lasso-tag:not([hidden])")].map((t) => t.textContent.replace(/\s+/g, " ").trim()),
      sugg: [...document.querySelectorAll(".sugg b")].map((b) => b.textContent), bins: document.querySelectorAll("#bins .bin:not(.new)").length };
  });
  await page.waitForTimeout(3000);
  const before = await info();
  Object.assign(res, { before });
  const cs = before.circles.filter((c) => c.n);
  res.overlaps = cs.some((a, i) => cs.some((b, j) => j > i && Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r));
  // A physical release near a different flock must leave the photo's tags and groups alone.
  const target = await page.evaluate((circles) => {
    for (const c of circles.filter((c) => c.n >= 2)) {
      for (const el of document.querySelectorAll(".ps-item")) {
        if (el.title.split(" · ").slice(1).join(" · ").split(", ").includes(c.name)) continue;
        const a = el.getBoundingClientRect();
        for (let t = 0; t < 300; t++) {
          const ang = t * 2.4, d = Math.min(c.r * 0.5, 6 + t * 0.6), x = c.cx + Math.cos(ang) * d, y = c.cy + Math.sin(ang) * d;
          const hit = document.elementFromPoint(x, y);
          if (hit && !hit.closest(".ps-item") && !hit.closest(".vn-tag") && !hit.closest(".vn-lasso-tag")) return { id: el.dataset.id, label: c.name, from: [a.x + a.width / 2, a.y + a.height / 2], to: [x, y] };
        }
      }
    }
    return null;
  }, before.circles);
  res.dragTarget = target && target.label;
  if (target) {
    const title=await page.$eval(`.ps-item[data-id="${target.id}"]`,e=>e.title),postCount=posts.length;
    await page.mouse.move(...target.from);
    await page.mouse.down();
    for (let k = 1; k <= 14; k++) await page.mouse.move(target.from[0] + ((target.to[0] - target.from[0]) * k) / 14, target.from[1] + ((target.to[1] - target.from[1]) * k) / 14);
    res.hint = await page.$eval(".vn-hint", (h) => (h.hidden ? null : h.textContent.trim())).catch(() => null);
    await page.screenshot({ path: `${OUT}/V-drag.png` });
    await page.mouse.up();
    await page.waitForTimeout(1800);
    res.afterTitle = await page.$eval(`.ps-item[data-id="${target.id}"]`, (e) => e.title).catch(() => null);
    assert.equal(res.afterTitle,title);assert.deepEqual(posts.slice(postCount),[]);res.physicalRelease=true;
  }
  // make the first suggested group
  if ((await info()).sugg.length) {
    await page.hover("#venn-rail .sugg");
    res.glow = await page.evaluate(() => document.querySelectorAll(".ps-item.ps-glow").length);
    const binsBefore = (await info()).bins;
    await page.click("#venn-rail .sugg [data-make]");
    await page.waitForTimeout(2500);
    res.madeGroup = (await info()).bins === binsBefore + 1;
    await page.screenshot({ path: `${OUT}/V-group.png` });
    res.badges = await page.evaluate(() => document.querySelectorAll(".ps-badge").length);
  }
  // the tag tray
  await page.click('.group-sea-tools summary');await page.click("#tag-tray");
  res.tray = await page.evaluate(() => ({ chips: document.querySelectorAll(".tag-chip").length, on: document.querySelectorAll(".tag-chip.on").length,
    fams: [...document.querySelectorAll(".tray-fam > b")].map((b) => b.textContent) }));
  await page.screenshot({ path: `${OUT}/V-tray.png` });
  await page.keyboard.press("Escape");
  res.after = await info();
  res.posts = posts;
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
