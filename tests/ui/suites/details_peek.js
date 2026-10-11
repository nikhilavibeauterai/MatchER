// The analysis sea during each step: how many photos jump (more than 30 px between samples 150 ms apart)?
const { chromium } = require("playwright-core");
const { LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(LINK);
  await page.click('.mode-card[data-mode="me"]');
  await page.fill("#path", LIB);
  await page.click("#use-path");
  await page.waitForSelector("#an-body");
  const stats = {};
  let prev = null, shot = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const s = await page.evaluate(() => {
      const b = document.querySelector("#an-body");
      if (!b) return null;
      const pos = {};
      document.querySelectorAll("#an-sea .ps-item").forEach((el) => { const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el.style.transform); if (m) pos[el.dataset.id] = [+m[1], +m[2]]; });
      return { scene: b.dataset.scene, pos, rings: document.querySelectorAll("#an-sea .ps-ring").length };
    }).catch(() => null);
    if (!s || s.scene === "reveal") break;
    if (prev && prev.scene === s.scene) {
      const st = stats[s.scene] || (stats[s.scene] = { samples: 0, jumps: 0, worst: 0, rings: s.rings });
      let j = 0;
      for (const [id, [x, y]] of Object.entries(s.pos)) { const q = prev.pos[id]; if (q && Math.hypot(x - q[0], y - q[1]) > 30) j++; }
      st.samples++; st.jumps += j; st.worst = Math.max(st.worst, j);
    }
    if (s.scene === "details" && !shot) { shot = true; await page.waitForTimeout(1500); await page.screenshot({ path: `${OUT}/D-details.png` }); prev = null; continue; }
    prev = s;
    await page.waitForTimeout(150);
  }
  console.log(JSON.stringify({ stats, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
