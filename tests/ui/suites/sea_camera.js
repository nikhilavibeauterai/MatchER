// The sea is calm and explorable: prints settle on the colour/brightness map and rest; open water pans, the wheel
// zooms about the pointer, a double-click shows everything again, and a comparison uses the whole sea at rest.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.sea.bodies?.length>0);
  // 1. Settling: the worker reports a settled field and positions stop changing.
  await page.waitForFunction(()=>World.sea.settled,null,{timeout:45000});
  const snap=()=>page.evaluate(()=>[...World.sea.items.values()].map(it=>[it.id,it.x,it.y]));
  const a=await snap();await page.waitForTimeout(2500);const b=await snap();
  const drift=b.filter(([id,x,y])=>{const p=a.find(q=>q[0]===id);return p&&Math.hypot(x-p[1],y-p[2])>.5;}).length;
  assert.equal(drift,0,`A settled sea stays put (${drift} prints moved)`);
  // The macro order: colourful photos sit right of muted ones, bright ones above dark ones.
  const geo=await page.evaluate(()=>{
    const rows=World.sea.bodies.filter(it=>Number.isFinite(it.visual?.colorfulness)&&Number.isFinite(it.visual?.brightness)).map(it=>({v:it.visual,it:World.sea.items.get(it.id)})).filter(x=>x.it);
    const corr=(f,g)=>{const n=rows.length,mf=rows.reduce((s,x)=>s+f(x),0)/n,mg=rows.reduce((s,x)=>s+g(x),0)/n;let num=0,df=0,dg=0;for(const x of rows){const u=f(x)-mf,w=g(x)-mg;num+=u*w;df+=u*u;dg+=w*w;}return num/Math.sqrt(df*dg||1);};
    return {n:rows.length,colour:corr(x=>x.v.colorfulness,x=>x.it.x),bright:corr(x=>x.v.brightness,x=>-x.it.y)};
  });
  assert(geo.n>10&&geo.colour>.4&&geo.bright>.4,`Colour runs left to right and brightness bottom to top: ${JSON.stringify(geo)}`);
  // 2. Zoom about the pointer, pan by dragging water, the layer carries both, a double-click resets.
  const water=await page.evaluate(()=>{const r=World.sea.el.getBoundingClientRect(),taken=[...World.sea.items.values()];
    for(let y=r.top+160;y<r.bottom-120;y+=37)for(let x=r.left+220;x<r.right-220;x+=41){const [wx,wy]=World.sea.toWorld(x-r.left,y-r.top);
      if(!taken.some(it=>Math.abs(it.x-wx)<(it.size||World.sea.s)+14&&Math.abs(it.y-wy)<(it.size||World.sea.s)+14))return {x,y};}return null;});
  assert(water,'Some open water to grab');
  const under=await page.evaluate(([x,y])=>{const r=World.sea.el.getBoundingClientRect();return World.sea.toWorld(x-r.left,y-r.top);},[water.x,water.y]);
  await page.mouse.move(water.x,water.y);await page.mouse.wheel(0,-600);await page.waitForTimeout(300);
  const zoomed=await page.evaluate(([x,y])=>{const r=World.sea.el.getBoundingClientRect();return {...World.sea.camera,transform:World.sea.layer.style.transform,under:World.sea.toWorld(x-r.left,y-r.top),dom:World.sea.moving.length,zoomAttr:World.sea.el.dataset.zoom};},[water.x,water.y]);
  assert(zoomed.zoom>1.5&&zoomed.transform.includes('scale'),JSON.stringify(zoomed));
  assert(Math.hypot(zoomed.under[0]-under[0],zoomed.under[1]-under[1])<2,'The point under the wheel stays under the wheel');
  await page.mouse.down();await page.mouse.move(water.x-200,water.y-120,{steps:8});await page.mouse.up();await page.waitForTimeout(250);
  const panned=await page.evaluate(()=>({...World.sea.camera,panning:document.body.classList.contains('sea-panning')}));
  assert(Math.abs(panned.tx-(zoomed.tx-200))<3&&Math.abs(panned.ty-(zoomed.ty-120))<3&&!panned.panning,JSON.stringify({zoomed,panned}));
  await page.screenshot({path:OUT+'/Z-zoomed-pan.png'});
  // Double-click real open water (not the HUD, not a print) to see everything again.
  const clear=await page.evaluate(()=>{for(let y=200;y<innerHeight-140;y+=37)for(let x=80;x<innerWidth-80;x+=41){const el=document.elementFromPoint(x,y);if(el&&!el.closest('.ps-item')&&!World.sea.uiTarget(el))return {x,y};}return null;});
  assert(clear,'Some open water to double-click');
  await page.mouse.dblclick(clear.x,clear.y);await page.waitForTimeout(250);
  const reset=await page.evaluate(()=>({...World.sea.camera}));assert.equal(reset.zoom,1);assert.equal(reset.tx,0);
  // 3. Dragging a print moves that print; prints far from it do not move in response.
  await page.waitForFunction(()=>World.sea.settled,null,{timeout:45000});
  const before=await page.evaluate(()=>{const it=World.sea.moving.find(it=>!it.take&&it.x>300&&it.x<1100&&it.y>200&&it.y<700);const r=it.el.getBoundingClientRect();
    return {id:it.id,x:r.x+r.width/2,y:r.y+r.height/2,others:[...World.sea.items.values()].filter(o=>o!==it&&Math.hypot(o.x-it.x,o.y-it.y)>260&&Math.hypot(o.x-(it.x+160),o.y-(it.y+40))>260).map(o=>[o.id,o.x,o.y])};});  // far from the lift and from the landing
  await page.mouse.move(before.x,before.y);await page.mouse.down();await page.mouse.move(before.x+160,before.y+40,{steps:10});await page.mouse.up();
  await page.waitForTimeout(1500);
  const after=await page.evaluate(()=>[...World.sea.items.values()].map(o=>[o.id,o.x,o.y]));
  const disturbed=before.others.filter(([id,x,y])=>{const o=after.find(q=>q[0]===id);return o&&Math.hypot(o[1]-x,o[2]-y)>2;}).length;
  assert(disturbed<=Math.ceil(before.others.length*.05),`Far prints stay put when one is dragged (${disturbed} of ${before.others.length} moved)`);
  // 4. The Groups sea keeps the camera; a comparison shows the whole sea at rest.
  await page.evaluate(()=>location.hash='#draw');await page.waitForSelector('.sorter');await page.waitForFunction(()=>World.mode==='live'&&World.sea.cameraOn);
  // The editor's list scrolls under the wheel; open water (the Sea view, away from panels) takes the camera.
  if(await page.locator('.seg-btn[data-mode="sea"]').count())await page.click('.seg-btn[data-mode="sea"]');await page.waitForTimeout(400);
  const open=await page.evaluate(()=>{for(let y=140;y<innerHeight-120;y+=40)for(let x=60;x<innerWidth-60;x+=40){const el=document.elementFromPoint(x,y);if(el&&!World.sea.uiTarget(el))return {x,y};}return null;});
  assert(open,'The Groups page leaves some open water for the camera');
  await page.mouse.move(open.x,open.y);await page.mouse.wheel(0,-400);await page.waitForTimeout(250);
  assert((await page.evaluate(()=>World.sea.camera.zoom))>1,'The Groups sea zooms');
  await page.evaluate(()=>location.hash='#duel?stage=open');await page.waitForSelector('#stage .side img');
  assert.equal(await page.evaluate(()=>World.sea.camera.zoom),1,'Comparisons use the whole sea');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({drift,geo,zoomed:{zoom:zoomed.zoom,dom:zoomed.dom},panned,disturbed,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
