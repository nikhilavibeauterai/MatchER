// Deep zoom on the map: zooming into a print at the sea's edge keeps the point under the pointer, one print filling
// the view stills the sea and hides the chrome, a drag on that over-zoomed print pans, the print shows the original
// file, and at zoom 1 every print is drawn.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.sea.settled,null,{timeout:60000});
  const drawn=await page.evaluate(()=>{const s=World.sea;s.densityDirty=true;s.drawDensity(s.el.clientWidth,s.el.clientHeight);const d=s.densityStats;return {items:s.items.size,live:s.moving.length,drawn:s.moving.length+d.dots+d.raster+d.cards+(d.blank||0)+(d.gpu||0)};});
  // The print nearest the right edge, at the vertical middle.
  const edge=await page.evaluate(()=>{const s=World.sea,r=s.el.getBoundingClientRect();const it=[...s.items.values()].filter(it=>!it.take).sort((a,b)=>b.x-a.x)[0];const [sx,sy]=s.toScreen(it.x,it.y);return {id:it.id,x:r.left+sx,y:r.top+sy};});
  await page.mouse.move(edge.x,edge.y);
  const anchor=await page.evaluate(([x,y])=>{const s=World.sea,r=s.el.getBoundingClientRect();return s.toWorld(x-r.left,y-r.top);},[edge.x,edge.y]);
  const drift=[];
  for(let k=0;k<40;k++){await page.mouse.wheel(0,-300);await page.waitForTimeout(40);
    const now=await page.evaluate(([x,y])=>{const s=World.sea,r=s.el.getBoundingClientRect(),w=s.toWorld(x-r.left,y-r.top);return {w,zoom:s.camera.zoom,tx:s.camera.tx,ty:s.camera.ty};},[edge.x,edge.y]);
    drift.push({zoom:+now.zoom.toFixed(1),d:+Math.hypot(now.w[0]-anchor[0],now.w[1]-anchor[1]).toFixed(2),finite:[now.tx,now.ty].every(Number.isFinite)});}
  await page.waitForTimeout(400);
  const deep=await page.evaluate(id=>{const s=World.sea,it=s.items.get(id),img=it.el.querySelector('.pile-cover');const r=it.el.getBoundingClientRect();
    return {zoom:s.camera.zoom,deep:document.body.classList.contains('sea-deep'),live:!it.density&&it.el.isConnected,src:img?.getAttribute('src'),onScreen:r.width,heightShare:r.height/innerHeight,overZoomed:s.overZoomed(it.el)};},edge.id);
  // A drag on the over-zoomed print pans.
  const cam0=await page.evaluate(()=>({...World.sea.camera}));
  await page.mouse.move(innerWidth=720,450);await page.mouse.down();for(let i=1;i<=8;i++)await page.mouse.move(720-i*25,450-i*10);await page.mouse.up();
  const cam1=await page.evaluate(()=>({...World.sea.camera}));
  const panned={dx:+(cam1.tx-cam0.tx).toFixed(1),dy:+(cam1.ty-cam0.ty).toFixed(1),zoomSame:cam0.zoom===cam1.zoom};
  await page.screenshot({path:OUT+'/Z-deep.png'});
  const maxDrift=Math.max(...drift.map(d=>d.d));
  assert.equal(drawn.drawn,drawn.items,`Every print is drawn at zoom 1: ${JSON.stringify(drawn)}`);
  assert(maxDrift<3&&drift.every(d=>d.finite),`The point under the pointer stays put while zooming at the edge (drift ${maxDrift})`);
  assert(deep.zoom>=100&&deep.deep&&deep.live,`Deep in one print: ${JSON.stringify(deep)}`);
  assert(/m=full/.test(deep.src||''),`The print shows its original file when it fills the view: ${deep.src}`);
  assert(deep.overZoomed&&Math.abs(panned.dx+200)<6&&Math.abs(panned.dy+80)<6&&panned.zoomSame,`A drag on the over-zoomed print pans: ${JSON.stringify(panned)}`);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({drawn,edge:edge.id,maxDrift,deep,panned}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
