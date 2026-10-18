// A shared slow swell crosses live paper and both sprite renderers without moving the underlying geography.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']}),runs=[],problems=[];
  for(const [gpu,reduced] of [[1,false],[0,false],[1,true]]){
    const context=await browser.newContext({viewport:{width:1100,height:760},reducedMotion:reduced?'reduce':'no-preference'}),page=await context.newPage();
    page.on('pageerror',e=>problems.push(e.message));await page.goto(LINK);await page.waitForFunction(()=>typeof VennSea==='function');
    await page.evaluate(gpu=>{
      const host=document.createElement('section');host.style.cssText='position:fixed;left:40px;top:80px;width:960px;height:600px;z-index:100000;background:#142032';document.body.append(host);
      host.insertAdjacentHTML('beforeend','<p style="position:absolute;left:20px;top:12px;color:#f4efe6;z-index:20">Slow sea swell · live paper and atlas prints</p>');
      const sea=new VennSea(host,{calm:true,catalog:false});window.waveSea=sea;sea.ro.disconnect();sea.layout=()=>{};sea.worker.terminate();cancelAnimationFrame(sea.raf);sea.raf=0;sea.kick=()=>{};sea.scheduleCull=()=>{};
      Object.assign(sea,{width:960,height:600,s:60,settled:true,ready:true,cameraOn:true});Object.assign(sea.tuning,{gpu,wobbleDeg:0});
      const atlas=document.createElement('canvas');atlas.width=atlas.height=16;const ctx=atlas.getContext('2d');ctx.fillStyle='#23b8a5';ctx.fillRect(0,0,16,16);ctx.fillStyle='#fbc240';ctx.fillRect(0,0,8,8);
      const bodies=[{id:1,x:180,y:260,density:false},{id:2,x:430,y:260,density:true},{id:3,x:700,y:260,density:true},{id:4,stack:3,x:711,y:271,density:true,take:true}];
      for(const b of bodies){const el=document.createElement('div');el.className='ps-item';el.dataset.id=b.id;const it={photo:b.id,stack:b.id,size:60,n:1,...b,el};sea.items.set(it.id,it);sea.sprites??=new Map();sea.sprites.set(it.id,{img:atlas,x:0,y:0,aspect:1});
        if(!it.density){el.classList.add('framed-photo');el.innerHTML=`<div class="paper"><div class="window"><img class="pile-cover" src="${atlas.toDataURL()}" alt="Synthetic colour proof"></div></div>`;sea.layer.append(el);sea.moving.push(it);sea.paintItem(it,true);framePhoto(el,{dims:[16,16]},{crop:'off',rotate:0,enhance:false});}}
      sea.densityDirty=sea.spritesDirty=true;sea.drawDensity(960,600);
      window.waveBodies=JSON.stringify([...sea.items.values()].map(it=>[it.id,it.x,it.y]));window.waveImage=sea.items.get(1).el.querySelector('img');
      window.waveUploads=0;if(sea.gpu){const gl=sea.gpu.gl;for(const key of ['bufferData','texImage2D']){const fn=gl[key].bind(gl);gl[key]=(...args)=>{waveUploads++;return fn(...args);};}}
    },gpu);
    const sample=()=>page.evaluate(()=>{const sea=waveSea,it=sea.items.get(1),r=it.el.getBoundingClientRect(),base=sea.el.getBoundingClientRect();return {time:sea.waveTime||0,x:r.x+r.width/2-base.x-it.x,y:r.y+r.height/2-base.y-it.y,
      position:JSON.stringify([...sea.items.values()].map(it=>[it.id,it.x,it.y])),image:waveImage===it.el.querySelector('img'),gpu:!!sea.gpu};});
    const a=await sample();await page.waitForTimeout(1400);const b=await sample();assert.equal(b.position,a.position);assert(b.image);assert.equal(b.gpu,!!gpu);
    const moved=Math.hypot(a.x-b.x,a.y-b.y);if(reduced){assert.equal(moved,0);assert.equal(b.time,0);}else{assert(moved>.15&&moved<2,JSON.stringify({a,b}));assert(b.time>a.time+900);}
    assert.equal(await page.evaluate(()=>waveUploads),0,'The swell reuses atlas textures and instance buffers');
    await page.evaluate(()=>{waveSea.hold(1);waveSea.paintItem(waveSea.items.get(1));});
    const held=await sample();await page.waitForTimeout(600);const still=await sample();assert(Math.hypot(still.x-held.x,still.y-held.y)<.03);assert.equal(still.time,held.time,'Reaching for a print pauses the water at its current phase');
    await page.evaluate(()=>waveSea.hold(null));await page.waitForTimeout(450);if(!reduced)assert((await sample()).time>still.time+200);
    const proof=await page.evaluate(()=>{
      const sea=waveSea;sea.held=1;sea.waveClock();const it=sea.items.get(2),[wx,wy]=sea.waveOffset(it);sea.densityDirty=true;sea.drawDensity(960,600);
      const canvas=sea.gpu?sea.spriteCanvas:sea.densityCanvas,gl=sea.gpu?.gl,data=gl?new Uint8Array(canvas.width*canvas.height*4):sea.densityCtx.getImageData(0,0,canvas.width,canvas.height).data;
      if(gl)gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
      let weight=0,x=0,y=0;for(let py=200;py<320;py++)for(let px=380;px<480;px++){const i=((gl?canvas.height-1-py:py)*canvas.width+px)*4,a=data[i+3];weight+=a;x+=(px+.5)*a;y+=(py+.5)*a;}
      const point=[it.x+wx,it.y+wy],center=[x/weight,y/weight],hit=sea.photoAt(...point)?.id,near=sea.smallAt(...point)?.id,stack=sea.waveOffset(sea.items.get(3)),take=sea.waveOffset(sea.items.get(4));
      Object.assign(sea.camera,{zoom:10,tx:480-1800,ty:300-2600});sea.paintWaves();const close=sea.waveOffset(sea.items.get(1)),old=sea.items.get(1).el.style.translate;
      Object.assign(sea.camera,{zoom:1,tx:0,ty:0});const live=sea.items.get(1);live.el.dataset.imageScale='40';sea.paintItem(live,true);
      const rebased=live.swellOffset,r=live.el.getBoundingClientRect(),host=sea.el.getBoundingClientRect(),shift=[r.x+r.width/2-host.x-live.x,r.y+r.height/2-host.y-live.y];
      return {center,point,hit,near,stack,take,close,old,rebased,shift};
    });
    assert(Math.hypot(proof.center[0]-proof.point[0],proof.center[1]-proof.point[1])<.3,JSON.stringify(proof));assert.equal(proof.hit,2);assert.equal(proof.near,2);assert.deepEqual(proof.stack,proof.take);assert.deepEqual(proof.close,[0,0]);assert.equal(proof.old,'');
    assert(Math.hypot(proof.shift[0]-proof.rebased[0],proof.shift[1]-proof.rebased[1])<.03,'Image coordinate rebasing keeps the same visible swell');
    await page.evaluate(()=>{waveSea.items.get(1).el.dataset.imageScale='1';waveSea.camera.zoom=1;waveSea.paintItem(waveSea.items.get(1),true);waveSea.drawDensity(960,600);});
    await page.screenshot({path:`${OUT}/sea-waves-${gpu?'gpu':'canvas'}${reduced?'-reduced':''}.png`});
    if(!reduced){await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>waveSea.waveOffset(waveSea.items.get(1))),[0,0],'An updated system preference also stills the water');}
    await page.evaluate(()=>{waveSea.tune({waveHeight:0},false);});await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>!!waveSea.wobbleTimer),false,'Disabling waves restores the sleeping renderer');
    runs.push({gpu,reduced,moved,proof});await page.evaluate(()=>waveSea.destroy());await context.close();
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({runs,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
