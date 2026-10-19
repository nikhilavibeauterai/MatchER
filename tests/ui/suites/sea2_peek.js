const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { BASE, LINK, LIB, OUT } = process.env;
let pg;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  pg=page;
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => d.accept());
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url().replace(/^.*\/api\//, "") + " " + (r.postData() || "")); });
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
    let b = await (await fetch("/api/draw/board?per=400")).json();
    // The public sample can honestly form one "Wildcards" group. This exercise needs two lasting rosters.
    if(b.groups.filter(g=>g.size>=4).length<2){
      const largest=b.groups.toSorted((a,b)=>b.size-a.size)[0];
      if(largest?.shots.length>=8){await api('/api/draw/new',{photos:largest.shots.slice(-4).map(x=>x.rep),name:'Public neighbours',emoji:'🌈'});b=await api('/api/draw/board?per=400');}
    }
    const pick = b.groups.flatMap((g) => g.shots.slice(0, 2).map((x) => x.rep)).slice(0, 8);
    await fetch("/api/draw/move", { method: "POST", headers: h, body: JSON.stringify({ photos: pick, theme: null }) });
  });
  await page.goto(BASE + "/#draw");
  await page.waitForSelector(".ps-item");
  await page.waitForTimeout(3500);
  await page.screenshot({ path: OUT + "/P-sea.png" });
  const res = {};
  res.items = await page.$$eval(".ps-item", (x) => x.length);
  res.circles = await page.$$eval(".vn-tag", (x) => x.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  res.fps = await page.evaluate(() => new Promise((ok) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else ok(Math.round(n / 2)); }; requestAnimationFrame(f); }));
  res.prof = await page.evaluate(() => new Promise((ok) => {
    const P = PhotoSea.prototype, t = { tick: 0, layout: 0, nt: 0, nl: 0 }, ot = P.tick, ol = P.layout;
    P.tick = function (n) { const a = performance.now(); ot.call(this, n); t.tick += performance.now() - a; t.nt++; };
    P.layout = function () { const a = performance.now(); ol.call(this); t.layout += performance.now() - a; t.nl++; };
    setTimeout(() => { P.tick = ot; P.layout = ol; ok({ tickMs: +(t.tick / Math.max(1, t.nt)).toFixed(2), ticks: t.nt, layouts: t.nl, layoutMs: +(t.layout / Math.max(1, t.nl)).toFixed(2) }); }, 2000);
  }));
  res.fps2 = await page.evaluate(() => new Promise((ok) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else ok(Math.round(n / 2)); }; requestAnimationFrame(f); }));
  // drag an unsorted photo onto the first group in the side list
  const unsorted = () => page.evaluate(async () => (await (await fetch("/api/draw/board?per=4&uper=4")).json()).total - (await (await fetch("/api/draw/board?per=4&uper=4")).json()).drawn);
  res.unsortedBefore = await unsorted();
  const free = await page.evaluate(() => { const ps = document.querySelector("#world"); const r0 = ps.getBoundingClientRect();
    const it = [...ps.querySelectorAll(".ps-item")].find((e) => e.title.startsWith("Not in a group"));  // (the tag sea: any unsorted shot)
    const r = it.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const ring = await page.$eval("#bins .bin:not(.new)", (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });  // a group in the side list
  await page.mouse.move(free[0], free[1]);
  await page.mouse.down();
  await page.mouse.move((free[0] + ring[0]) / 2, (free[1] + ring[1]) / 2, { steps: 8 });
  await page.mouse.move(ring[0], ring[1], { steps: 8 });
  await page.screenshot({ path: OUT + "/P-dragging.png" });
  res.dragState = await page.evaluate(() => { const d = document.querySelector(".ps-item.dragging"); return !!d; });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  res.unsortedAfterDrop = await unsorted();
  res.posts = posts.slice(-3);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + "/P-after-drop.png" });
  // select two unsorted photos and press 1
  const two = await page.evaluate(() => [...document.querySelectorAll("#world .ps-item")].filter((e) => e.title.startsWith("Not in a group")).slice(0, 2)
    .map((e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }));
  for (const [x, y] of two) { await page.mouse.click(x, y); await page.waitForTimeout(150); }
  res.selected = await page.$$eval(".ps-item.selected", (x) => x.length);
  await page.keyboard.press("1");
  await page.waitForTimeout(2000);
  res.unsortedAfterKey = await unsorted();
  await page.keyboard.press("z");
  await page.waitForTimeout(1500);
  res.unsortedAfterUndo = await unsorted();
  // island menu
  await page.locator('.vn-catalog [data-tag]').first().click({button:'right'});
  await page.waitForSelector(".island-pop");
  await page.screenshot({ path: OUT + "/P-island-menu.png" });
  res.menu = await page.$eval(".island-pop", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 120));
  await page.keyboard.press("Escape");
  // list view still there
  await page.click('[data-mode="list"]');
  await page.waitForSelector(".gsec");
  res.listView = await page.$$eval(".gsec", (x) => x.length);
  await page.click('[data-mode="sea"]');
  await page.waitForSelector("#venn-rail .bin-place");
  // Once organized, the named roster is a way to look at each group as well as a move target.
  if(await page.locator('[data-sel-act="clear"]').isVisible())await page.click('[data-sel-act="clear"]');
  if(await page.locator('#d-auto').count())await page.click('#d-auto');
  await page.waitForFunction(()=>World.board?.unsorted.count===0&&!document.querySelector('#d-auto'));
  assert.equal(await page.locator('#venn-rail .sugg-card').count(),0,'No empty suggestions card after grouping');
  const groups=await page.evaluate(()=>World.board.groups.filter(g=>g.size>1).map(g=>({id:g.id,name:g.name,size:g.size,photo:g.shots[0].rep})));
  assert(groups.length>=2);const [a,b]=groups;
  const bin=id=>`#venn-rail [data-bin="${id}"]`;
  const name='Dogs on beaches with their favourite seaside companions';
  await page.click(`${bin(a.id)} [data-rename-bin]`);await page.fill('.bin-input',name);await page.press('.bin-input','Enter');
  await page.waitForFunction(({id,name})=>document.querySelector(`#venn-rail [data-bin="${id}"] .bin-label`)?.textContent===name,{id:a.id,name});
  const postCount=posts.length;
  await page.click(`${bin(a.id)} .bin-place`);
  await page.waitForFunction(id=>World.sea.focusCluster===`g${id}`&&[...World.sea.items.values()].some(it=>it.focused),a.id);
  await page.mouse.move(800,28);await page.waitForTimeout(1800);
  assert.equal(await page.locator(`${bin(a.id)} [data-focus-bin]`).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator(`${bin(a.id)} [data-focus-bin]`).innerText(),'Release');
  assert.deepEqual(posts.slice(postCount),[],'Focusing a group does not edit photos');
  res.groupFocus=await page.evaluate(()=>({count:World.sea.focusPrimary.size,cluster:World.sea.focusCluster,
    enlarged:[...World.sea.items.values()].filter(it=>it.focused).every(it=>it.size>World.sea.s),
    visible:[...World.sea.items.values()].filter(it=>it.focused&&!it.el.classList.contains('lifted')&&Number(getComputedStyle(it.el).opacity)>.9).length}));
  assert.equal(res.groupFocus.count,Math.min(12,a.size));assert(res.groupFocus.enlarged);
  assert.equal(res.groupFocus.visible,res.groupFocus.count,'Roster covers remain visible in the focused group');
  await page.screenshot({path:OUT+'/P-group-focus.png'});
  await page.click('[data-clear-focus]');
  assert.equal(await page.locator(`${bin(a.id)} [data-focus-bin]`).getAttribute('aria-pressed'),'false');
  // Focus remains available with a selection. The main roster button still places the selected shot.
  await page.click(`${bin(b.id)} .bin-place`);
  await page.waitForFunction(id=>World.sea.items.get(id)?.focused,b.photo);await page.waitForTimeout(900);
  await page.locator(`#world [data-id="${b.photo}"]`).click();
  await page.waitForSelector('#world .ps-item.selected');
  const selectedPosts=posts.length;
  await page.click(`${bin(a.id)} [data-focus-bin]`);
  assert.deepEqual(posts.slice(selectedPosts),[],'Focus button never moves the selection');
  assert.equal(await page.locator('#world .ps-item.selected').count(),1);
  await page.click(`${bin(a.id)} .bin-place`);
  await page.waitForFunction(({id,photo})=>World.board.groups.find(g=>g.id===id)?.shots.some(s=>s.rep===photo),{id:a.id,photo:b.photo});
  assert(posts.slice(selectedPosts).some(p=>p.startsWith('draw/move ')));
  await page.waitForFunction(photo=>World.sea.focusIds.has(photo),b.photo);
  await page.keyboard.press('z');
  await page.waitForFunction(({id,photo})=>World.board.groups.find(g=>g.id===id)?.shots.some(s=>s.rep===photo),{id:b.id,photo:b.photo});
  res.groupMoveUndone=true;
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(800);
  await page.click(`${bin(b.id)} [data-focus-bin]`);
  await page.waitForFunction(id=>World.sea.focusCluster===`g${id}`,b.id);
  await page.click(`${bin(a.id)} [data-focus-bin]`);
  await page.waitForFunction(id=>World.sea.focusCluster===`g${id}`,a.id);
  await page.mouse.move(190,28);await page.waitForTimeout(1800);
  res.rosterNames=await page.$$eval('#venn-rail .bin-label',els=>els.map(el=>({name:el.textContent,width:el.clientWidth,scroll:el.scrollWidth})));
  assert(res.rosterNames.some(x=>x.name===name));assert(res.rosterNames.every(x=>x.width>60&&x.scroll<=x.width+1));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert(await page.evaluate(()=>[...World.sea.items.values()].filter(it=>it.focused).every(it=>!it.el.classList.contains('lifted'))));
  await page.screenshot({path:OUT+'/P-group-focus-phone.png'});
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>World.sea.focusCluster),null);
  assert.equal(await page.locator(`${bin(a.id)} [data-focus-bin]`).getAttribute('aria-pressed'),'false');
  assert.deepEqual(problems,[]);
  console.log(JSON.stringify({ ...res, problems }));
  await browser.close();
})().catch(async(e) => { console.error("FAILED:", e.stack);if(pg)await pg.screenshot({path:OUT+'/P-fail.png'}).catch(()=>{});process.exit(1); });
