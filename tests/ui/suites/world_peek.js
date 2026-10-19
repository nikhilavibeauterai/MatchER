// The sea behind every screen: on the map, and photos lifting out of it into a duel and sinking back.
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
  await page.waitForTimeout(3500);
  const res = {};
  await page.evaluate(() => {
    window.flightChecks=[];
    const fly=World.fly;
    World.fly=function(src,from,target,options={}){
      const entry={kind:options.kind||'analysis',frames:[]},finish=options.finish;
      const flight=fly.call(this,src,from,target,{...options,finish:(arrived,active)=>{
        const to=typeof target==='function'?target():target,r=active.img.getBoundingClientRect();
        entry.arrived=arrived;entry.end=performance.now();entry.error=to?Math.max(...['left','top','width','height'].map(k=>Math.abs(r[k]-to[k]))):null;
        // The flight removes its node before the independent RAF sampler can see this final handoff frame.
        entry.frames.push({time:entry.end,left:r.left,top:r.top,width:r.width,height:r.height});
        entry.natural=active.img.naturalWidth/active.img.naturalHeight;
        entry.imageRatio=parseFloat(active.img.style.width)/parseFloat(active.img.style.height);
        finish?.(arrived,active);
      }});
      flight.img.dataset.flightKind=entry.kind;window.flightChecks.push(entry);
      const frame=()=>{if(!flight.img.isConnected)return;const r=flight.img.getBoundingClientRect();
        entry.frames.push({time:performance.now(),left:r.left,top:r.top,width:r.width,height:r.height});requestAnimationFrame(frame);};
      requestAnimationFrame(frame);return flight;
    };
  });
  res.map = await page.evaluate(() => ({ mode: document.body.dataset.world, tiles: document.querySelectorAll("#world .ps-item").length,
    opacity: getComputedStyle(document.querySelector("#world")).opacity, all:World.sea.items.size,total:World.total,
    tabs:document.querySelectorAll('#world .ps-item[tabindex="0"]').length }));
  assert.equal(res.map.all,res.map.total);assert.equal(res.map.tabs,0);
  await page.screenshot({ path: `${OUT}/W-map.png` });
  await page.goto(BASE + "/#duel");
  await page.waitForSelector("#stage .side img");
  await page.waitForTimeout(120);
  res.duelIn = await page.evaluate(() => ({ mode: document.body.dataset.world, flying: document.querySelectorAll(".world-fly").length,
    lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
  await page.screenshot({ path: `${OUT}/W-duel-in.png` });
  await page.waitForFunction(()=>!document.querySelector('.world-fly'),{},{timeout:3000});
  res.duelLanded = await page.evaluate(() => ({ flying: document.querySelectorAll(".world-fly").length, lifted: document.querySelectorAll("#world .ps-item.lifted").length,
    shown: [...document.querySelectorAll("#stage .side img")].map((i) => ({opacity:getComputedStyle(i).opacity,width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height})) }));
  assert(res.duelLanded.shown.every((i)=>Number(i.opacity)>0.95&&i.width>100&&i.height>100));
  await page.evaluate(()=>{window.testImage=document.querySelector("#stage .side .window > img");window.testPid=Number(testImage.src.match(/\/(\d+)\.jpg/)[1]);location.hash="#home";});
  await page.waitForSelector(".journey");
  assert(await page.evaluate(()=>World.recycled.get(testPid)===testImage),"Keep the focused image when the map uses its photo twice");
  await page.evaluate(()=>{location.hash="#shortlist";});await page.waitForSelector(".screen.board");
  await page.waitForTimeout(120);
  const reused=await page.evaluate(()=>{const nodes=[...document.querySelectorAll(`#main img[src='/img/t/${testPid}.jpg']`)].filter(i=>!i.closest('.under'));return !nodes.length||nodes.includes(testImage);});
  assert(reused,"The same photo image should survive the route change");
  await page.evaluate(()=>{location.hash="#duel?stage=open";});await page.waitForSelector("#stage .side img");await page.waitForTimeout(600);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(450);
  res.afterVote = await page.evaluate(() => ({ flying: [...document.querySelectorAll(".world-fly")].map((f) => f.className), lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
  await page.screenshot({ path: `${OUT}/W-duel-swap.png` });
  await page.waitForTimeout(900);
  res.settled = await page.evaluate(() => ({ flying: document.querySelectorAll(".world-fly").length, lifted: document.querySelectorAll("#world .ps-item.lifted").length,
    won: document.querySelectorAll("#world .ps-item.ps-won").length }));
  await page.goto(BASE + "/#home");
  await page.waitForTimeout(800);
  res.backHome = await page.evaluate(() => ({ mode: document.body.dataset.world, lifted: document.querySelectorAll("#world .ps-item.lifted").length }));
  const shapes=await page.evaluate(async()=>{
    const found={};
    for(const p of World.photos.values()){
      const img=new Image();img.src=P(p.id);try{await img.decode();}catch(_){continue;}
      const ratio=img.naturalWidth/img.naturalHeight;if(ratio<.8&&!found.portrait)found.portrait=p.id;
      if(ratio>1.3&&!found.landscape)found.landscape=p.id;if(found.portrait&&found.landscape)break;
    }
    return found;
  });
  assert(shapes.portrait&&shapes.landscape,'Public fixtures must exercise both portrait and landscape takes');
  for(const [shape,pid]of Object.entries(shapes)){
    await page.evaluate(pid=>{World.inspect(pid);},pid);
    await page.waitForSelector('.world-fly[data-flight-kind="inspect-rise"]');
    await page.waitForTimeout(90);
    await page.setViewportSize(shape==='portrait'?{width:1400,height:850}:{width:1600,height:900});
    await page.waitForFunction(()=>!document.querySelector('.world-fly'),{},{timeout:3000});
    await page.click('[data-in=close]');
    await page.waitForSelector('.world-fly[data-flight-kind="inspect-sink"]');
    await page.waitForTimeout(80);
    await page.evaluate(()=>{World.sea.catalog=false;World.sea.layout();});
    await page.waitForTimeout(90);
    await page.evaluate(()=>{World.sea.catalog=true;World.sea.layout();});
    await page.waitForFunction(()=>!document.querySelector('.inspect, .world-fly'),{},{timeout:3000});
  }
  res.flights=await page.evaluate(()=>flightChecks.filter(c=>['rise','sink','inspect-rise','inspect-sink'].includes(c.kind)&&c.arrived).map(c=>{
    const last=c.frames.at(-1),prior=c.frames.at(-2);
    return {kind:c.kind,error:c.error,natural:c.natural,imageRatio:c.imageRatio,
      lastStep:last&&prior?Math.max(...['left','top','width','height'].map(k=>Math.abs(last[k]-prior[k]))):0,
      lastFrameMs:last&&prior?last.time-prior.time:0};
  }));
  assert(res.flights.length>=6);
  assert(res.flights.every(c=>c.error<2),`A flight must reveal at its live endpoint: ${JSON.stringify(res.flights)}`);
  assert(res.flights.filter(c=>c.kind==='inspect-rise').every(c=>Math.abs(c.imageRatio-.75)<.03),
    'Portrait and landscape takes alike fly as the same 3:4 polaroid card');
  assert(res.flights.every(c=>c.lastStep<12),`The final animation frames must settle instead of teleporting: ${JSON.stringify(res.flights)}`);
  await page.evaluate(pid=>{World.inspect(pid);},shapes.portrait);
  await page.waitForSelector('.world-fly[data-flight-kind="inspect-rise"]');
  await page.evaluate(()=>{location.hash='#stacks';});
  await page.waitForSelector('.stacker');await page.waitForTimeout(1300);
  assert.equal(await page.locator('.inspect, .world-fly').count(),0,'Navigation cancels inspector flights without leaving ghosts');
  assert(await page.evaluate(()=>[...document.querySelectorAll('#main img')].every(img=>img.style.opacity!=='0')),
    'An old flight cannot leave recycled images hidden');
  assert.deepEqual(problems,[]);
  console.log(JSON.stringify({ ...res, problems }, null, 1));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
