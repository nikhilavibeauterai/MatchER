// PhotoSea stability: when one photo leaves an island, or loose photos come and go, how many island photos get a new
// spot? (The analysis "looking closer" step used to spin whole islands.)
const { chromium } = require("playwright-core");
const { LINK } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(LINK);
  await page.waitForSelector("#path");
  const res = await page.evaluate(() => {
    const div = document.createElement("div");
    div.style.cssText = "position:fixed;left:0;top:0;width:1200px;height:700px;z-index:999";
    document.body.append(div);
    const sea = new PhotoSea(div);
    const islands = ["a", "b", "c"].map((id) => ({ id, html: id }));
    const items = [];
    for (let i = 1; i <= 60; i++) items.push({ id: i, photo: i, island: ["a", "b", "c"][i % 3], n: 1, title: "" });
    for (let i = 61; i <= 70; i++) items.push({ id: i, photo: i, island: null, n: 1, title: "" });
    sea.set(islands, items);
    const snap = () => new Map([...sea.items.values()].filter((it) => !it.free).map((it) => [it.id, [it.tx, it.ty]]));
    const moved = (a, b) => {  // [photos that moved more than 2 px, the farthest any moved, rounded]
      const d = [...a.keys()].filter((id) => b.has(id)).map((id) => Math.hypot(a.get(id)[0] - b.get(id)[0], a.get(id)[1] - b.get(id)[1]));
      return [d.filter((x) => x > 2).length, Math.round(Math.max(0, ...d))];
    };
    const out = { size0: sea.s };
    // one photo leaves island a (what "looking closer" did to every photo it examined)
    let before = snap();
    items.find((x) => x.id === 3).island = null;
    sea.set(islands, items);
    out.leaveOne = moved(before, snap());
    // five more leave, one at a time
    out.leaveFive = [];
    for (const id of [6, 9, 12, 15, 18]) { before = snap(); items.find((x) => x.id === id).island = null; sea.set(islands, items); out.leaveFive.push(moved(before, snap())); }
    out.repeatSame = []; for (let r = 0; r < 3; r++) { before = snap(); sea.set(islands, items); out.repeatSame.push(moved(before, snap())); }
    // ten loose photos arrive (the water grows)
    before = snap();
    for (let i = 71; i <= 80; i++) items.push({ id: i, photo: i, island: null, n: 1, title: "" });
    sea.set(islands, items);
    out.tenLooseArrive = moved(before, snap());
    out.size1 = sea.s;
    // a photo joins an island: only it should get a spot
    before = snap();
    items.find((x) => x.id === 75).island = "b";
    sea.set(islands, items);
    out.joinOne = moved(before, snap());
    out.members = [...sea.items.values()].filter((it) => !it.free).length;
    sea.destroy(); div.remove();
    return out;
  });
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
