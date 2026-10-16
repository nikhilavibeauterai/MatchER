// The GPU sprite layer at scale: a 6,000-print sea (the sample library's photos, repeated) on the map. Every print
// is drawn with no live cards at zoom 1, the idle frame is cheap, a fast wheel zoom into the corner print is quick
// and keeps its anchor, only the few prints filling the view ask for original files, a click's zoom followed by
// a drag pans, and zooming back out hands every print back to the GPU. Headless Chromium needs the SwiftShader flag
// for WebGL2; without it the sea would fall back to its 2D canvas and this suite would say so.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1600,height:900}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));page.on('console',m=>{if(m.type()==='error')problems.push(m.text().slice(0,160));});
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading);
  await page.waitForFunction(()=>World.sea?.sprites?.size>=World.photos.size,{timeout:60000});  // the atlas sheet has arrived: the synthetic prints borrow its cells
  const rest=await page.evaluate(async()=>{
    const sea=World.sea,photos=[...World.photos.values()];
    const items=Array.from({length:6000},(_,i)=>{const p=photos[i%photos.length];return {id:100000+i,photo:p.id,tags:p.tags||[],n:1,visual:{colorfulness:(i*7%100)/99,brightness:(i*13%100)/99}};});
    sea.setVenn([],items);
    for(const it of items){const sp=sea.sprites.get(it.photo);if(sp)sea.sprites.set(it.id,sp);}
    await new Promise(r=>setTimeout(r,7000));
    const settleBy=performance.now()+30000;
    while(!sea.settled&&performance.now()<settleBy)await new Promise(r=>setTimeout(r,100));
    sea.densityDirty=sea.spritesDirty=true;sea.drawDensity(sea.el.clientWidth,sea.el.clientHeight);
    // Read the sprite layer's own pixels right after its draw (the buffer is valid until the next composite).
    const gl=sea.gpu?.gl,canvas=sea.spriteCanvas;let painted=0,sampled=0;
    if(gl){const px=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,px);for(let i=3;i<px.length;i+=4){sampled++;if(px[i])painted++;}}
    const d=sea.densityStats||{};
    // Why a sprite would be blank, for the report: no sprite, a sheet not loaded, or a preview missing.
    const why={};for(const it of sea.items.values()){if(!it.density)continue;const sp=sea.sprites?.get(it.id);const k=!sp?'no-sprite':sp.img instanceof HTMLCanvasElement?'canvas':!sp.img.complete?'loading':!sp.img.naturalWidth?'failed':'ok';why[k]=(why[k]||0)+1;}
    const frames=[];let last=performance.now();const until=last+1500;
    await new Promise(res=>{const f=()=>{const n=performance.now();frames.push(n-last);last=n;if(n<until)requestAnimationFrame(f);else res();};requestAnimationFrame(f);});
    frames.sort((a,b)=>a-b);
    return {gpu:!!sea.gpu,items:sea.items.size,live:sea.moving.length,size:+sea.s.toFixed(1),drawn:sea.moving.length+(d.gpu||0)+(d.blank||0)+(d.dots||0)+(d.raster||0)+(d.cards||0),stats:d,
      paintedShare:+(painted/Math.max(1,sampled)).toFixed(3),why,sameMap:sea.sprites===World.sprites,settled:sea.settled,idleFrameMedian:+frames[Math.floor(frames.length/2)].toFixed(1),idleFrameP90:+frames[Math.floor(frames.length*.9)].toFixed(1)};
  });
  assert(rest.gpu,`WebGL2 sprite layer active: ${JSON.stringify(rest)}`);
  assert.equal(rest.drawn,rest.items,`Every print is drawn at zoom 1: ${JSON.stringify(rest)}`);
  assert(rest.stats.gpu>=rest.items-rest.live-20,`Nearly every print is a GPU sprite (sheets loaded): ${JSON.stringify(rest)}`);
  assert(rest.size<22&&rest.live===0,`Seven-pixel prints need no live cards at rest: ${JSON.stringify(rest)}`);
  assert(rest.paintedShare>.03,`The sprite layer painted something: ${rest.paintedShare}`);
  assert(rest.idleFrameP90<60,`Idle frames stay cheap with six thousand prints: ${JSON.stringify(rest)}`);
  await page.screenshot({path:`${OUT}/sea-gl-rest.png`});
  // Hold this measured field still while testing the camera, so a returning physics update cannot move its anchors.
  await page.evaluate(()=>{const s=World.sea;clearInterval(World.watch);s.worker.terminate();s.busy=false;s.kick=()=>{};cancelAnimationFrame(s.raf);s.raf=0;});
  // A fast wheel into the corner print, as a hand scrolls: quick, anchored, only a few originals fetched.
  await page.evaluate(()=>{
    const s=World.sea;s.__originals=[];
    s.__originalWatch=new MutationObserver(records=>{
      for(const record of records){
        const img=record.target;if(!(img instanceof HTMLImageElement)||!img.src.includes('m=full'))continue;
        const it=s.items.get(Number(img.closest('.ps-item')?.dataset.id));if(!it)continue;
        const c=s.camera,x0=-c.tx/c.zoom,y0=-c.ty/c.zoom;
        s.__originals.push({id:it.id,share:(it.size||s.s)*4/3*c.zoom/s.el.clientHeight,inView:s.inView(it,x0,y0,x0+s.el.clientWidth/c.zoom,y0+s.el.clientHeight/c.zoom,0)});
      }
    });
    s.__originalWatch.observe(s.layer,{attributes:true,attributeFilter:['src'],subtree:true});
  });
  const corner=await page.evaluate(()=>{const s=World.sea,r=s.el.getBoundingClientRect();const it=[...s.items.values()].filter(it=>!it.take).sort((a,b)=>(b.x+b.y)-(a.x+a.y))[0];const [sx,sy]=s.toScreen(it.x,it.y);s.__anchor=s.toWorld(sx,sy);performance.clearResourceTimings();performance.setResourceTimingBufferSize(20000);return {id:it.id,x:r.left+sx,y:r.top+sy};});
  await page.mouse.move(corner.x,corner.y);
  // Headless Chromium composites in software and paces wheel events by its frame rate, so the measure that holds on
  // any machine is the main thread's script time for the sixty steps, not the wall clock.
  const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
  const script=async()=>(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='ScriptDuration').value;
  const s0=await script(),t0=Date.now();for(let k=0;k<60;k++)await page.mouse.wheel(0,-300);const wheelMs=Date.now()-t0;
  await page.waitForTimeout(1200);const scriptMs=Math.round((await script()-s0)*1000);await cdp.detach();
  const deep=await page.evaluate(([x,y,id])=>{const s=World.sea,r=s.el.getBoundingClientRect(),w=s.toWorld(x-r.left,y-r.top),it=s.items.get(id);
    const names=performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/\/img\/[tp]\//.test(n)),full=names.filter(n=>/m=full/.test(n));
    s.__originalWatch.disconnect();
    return {zoom:+s.camera.zoom.toFixed(1),drift:+Math.hypot(w[0]-s.__anchor[0],w[1]-s.__anchor[1]).toFixed(2),deep:!!s.deep,live:s.moving.length,fetched:names.length,full:full.length,originals:s.__originals,
      cornerLive:!it.density,cornerSrc:it.el.querySelector('.pile-cover')?.getAttribute('src')||'',heapMB:Math.round((performance.memory?.usedJSHeapSize||0)/1048576),hidden:getComputedStyle(document.querySelector('#journey-dock')||document.body).visibility};},[corner.x,corner.y,corner.id]);
  assert(scriptMs<2500,`Sixty wheel steps on six thousand prints cost the main thread under 2.5 s of script (${scriptMs} ms, ${wheelMs} ms wall)`);
  assert(deep.deep&&deep.zoom>=100,`The corner print fills the view: ${JSON.stringify(deep)}`);
  assert(deep.drift<3,`Zooming at the corner keeps the point under the pointer (drift ${deep.drift})`);
  // A neighbouring card may briefly fill the viewport while approaching an edge print; the whole gesture stays bounded.
  assert(deep.full<=4&&/m=full/.test(deep.cornerSrc),`Only a few originals are fetched during the zoom: ${JSON.stringify(deep)}`);
  assert(deep.originals.length&&deep.originals.every(it=>it.share>=.8&&it.inView),`Originals belong to prints filling the actual view: ${JSON.stringify(deep.originals)}`);
  assert(deep.live<=120,`Deep in one print few cards are live: ${deep.live}`);
  assert(deep.heapMB<400,`Heap stays bounded after the zoom (${deep.heapMB} MB)`);
  await page.screenshot({path:`${OUT}/sea-gl-deep.png`});
  // Back out: double-click open water. Every print returns to the GPU and no card stays live.
  await page.mouse.dblclick(corner.x,corner.y);await page.waitForTimeout(900);
  const out=await page.evaluate(()=>{const s=World.sea;s.densityDirty=s.spritesDirty=true;s.drawDensity(s.el.clientWidth,s.el.clientHeight);const d=s.densityStats;return {zoom:s.camera.zoom,live:s.moving.length,drawn:s.moving.length+(d.gpu||0)+(d.blank||0),items:s.items.size,deep:!!s.deep};});
  assert.equal(out.zoom,1,'Double-click on open water shows the whole sea again');
  assert.equal(out.drawn,out.items,`Every print is drawn again: ${JSON.stringify(out)}`);
  assert(out.live<=1,`Zoomed back out, the sprites take every print back (live ${out.live})`);
  // A click on a sprite zooms to it (four fifths of the height); the drag that follows pans the camera, never the print.
  const target=await page.evaluate(()=>{const s=World.sea,r=s.el.getBoundingClientRect(),W=s.el.clientWidth,H=s.el.clientHeight;const it=[...s.items.values()].filter(it=>!it.take).sort((a,b)=>Math.hypot(a.x-W/2,a.y-H/2)-Math.hypot(b.x-W/2,b.y-H/2))[0];const [sx,sy]=s.toScreen(it.x,it.y);return {id:it.id,x:r.left+sx,y:r.top+sy,wx:it.x,wy:it.y};});
  await page.mouse.click(target.x,target.y);await page.waitForTimeout(700);
  const zoomed=await page.evaluate(id=>{const s=World.sea,it=s.items.get(id),b=it.el.getBoundingClientRect();return {zoom:+s.camera.zoom.toFixed(2),share:+(b.height/s.el.clientHeight/(it.renderScale||1)).toFixed(3),live:!it.density,over:s.overZoomed(it.el),cx:b.left+b.width/2,cy:b.top+b.height/2};},target.id);
  assert(zoomed.share>.7&&zoomed.share<.9&&zoomed.over,`A click zooms the print to four fifths of the height, past the pan threshold: ${JSON.stringify(zoomed)}`);
  await page.waitForTimeout(400);
  const original=await page.evaluate(id=>World.sea.items.get(id).el.querySelector('.pile-cover')?.getAttribute('src')||'',target.id);
  assert(/m=full/.test(original),`A print filling four fifths of the screen shows the original file: ${original}`);
  const cam0=await page.evaluate(()=>({...World.sea.camera}));
  await page.evaluate(()=>{
    const s=World.sea;s.__nativeDrags=0;
    document.addEventListener('dragstart',()=>s.__nativeDrags++,{once:true});
  });
  await page.mouse.move(zoomed.cx,zoomed.cy);await page.mouse.down();for(let i=1;i<=8;i++)await page.mouse.move(zoomed.cx-i*20,zoomed.cy-i*8);await page.mouse.up();
  const panned=await page.evaluate(([id,wx,wy])=>{const s=World.sea,it=s.items.get(id);return {tx:s.camera.tx,ty:s.camera.ty,moved:+Math.hypot(it.x-wx,it.y-wy).toFixed(2),drag:!!s.drag,nativeDrags:s.__nativeDrags};},[target.id,target.wx,target.wy]);
  assert(Math.abs(panned.tx-cam0.tx+160)<3&&Math.abs(panned.ty-cam0.ty+64)<3,`The drag pans the camera: ${JSON.stringify({cam0,panned})}`);
  assert(panned.moved<1,`The print itself stays where it was (moved ${panned.moved})`);
  assert.equal(panned.nativeDrags,0,'Native dragging cannot cancel a camera pan');
  await page.screenshot({path:`${OUT}/sea-gl-panned.png`});
  assert.deepEqual(problems,[]);
  console.log(JSON.stringify({rest,wheelMs,scriptMs,deep,out,zoomed,panned}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
