// Slow previews and repeated zooms must never remove the atlas print before its live replacement is ready.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env,FIRST=120000;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.sprites?.size===World.total);
  const thumb=await page.evaluate(()=>T(World.photos.values().next().value.id));
  const pixels=await (await page.request.get(new URL(thumb,BASE).href)).body();
  let slow=true;
  await page.route(/\/img\/[tp]\/12\d+\.jpg(?:\?|$)/,async r=>{
    if(slow)await new Promise(resolve=>setTimeout(resolve,1200));
    const id=Number(new URL(r.request().url()).pathname.match(/\/(\d+)\.jpg$/)[1]);
    return r.fulfill(id===FIRST?{status:503,body:'deliberate preview failure'}:{contentType:'image/jpeg',body:pixels}).catch(()=>{});
  });
  await page.route('**/api/edit?*',r=>Number(new URL(r.request().url()).searchParams.get('photo'))>=FIRST?r.fulfill({json:{edits:{}}}):r.continue());
  await page.evaluate(async FIRST=>{
    const s=World.sea,photo=World.photos.values().next().value,cell=World.sprites.get(photo.id);
    clearInterval(World.watch);World.stale=false;
    s.tune({domLimit:80,liveMin:80,wobbleDeg:0,waveHeight:0},false);
    const items=Array.from({length:1600},(_,i)=>({id:FIRST+i,photo:FIRST+i,tags:[],n:1,visual:{colorfulness:(i%40)/39,brightness:Math.floor(i/40)/39}}));
    s.setVenn([],items);for(const it of items)s.sprites.set(it.id,cell);
    await new Promise(resolve=>setTimeout(resolve,1200));
    // Give the controlled field a resting grid so each camera pass observes exactly the same photos.
    s.worker.terminate();s.busy=false;s.kick=()=>{};cancelAnimationFrame(s.raf);s.raf=0;
    const W=s.el.clientWidth,H=s.el.clientHeight;
    [...s.items.values()].forEach((it,i)=>{it.x=(i%40+.5)*W/40;it.y=(Math.floor(i/40)+.5)*H/40;it.size=14;});
    s.tuning.liveMin=22;s.spritesDirty=s.densityDirty=true;
    window.lodSea=s;
    window.lodCoverage=()=>{
      s.drawDensity(W,H);
      const c=s.camera,x0=-c.tx/c.zoom,y0=-c.ty/c.zoom;
      const items=[...s.items.values()].filter(it=>!it.lifted&&!it.pileLifted&&s.inView(it,x0,y0,x0+W/c.zoom,y0+H/c.zoom,0));
      const ready=items.filter(it=>!it.density&&!it.imagePending&&it.el.isConnected&&it.el.querySelector('.pile-cover')?.naturalWidth).length;
      const drawn=(s.densityStats.gpu||0)+(s.densityStats.blank||0)+ready;
      return {total:items.length,drawn,ready,pending:items.filter(it=>!it.density&&it.imagePending).length,live:s.moving.length};
    };
  },FIRST);
  const frames=[];
  for(const zoom of [1,1.55,1.62,2,1.5,3,2,1]){
    frames.push(await page.evaluate(zoom=>{
      const s=lodSea,W=s.el.clientWidth,H=s.el.clientHeight;s.setCamera(zoom,W*(1-zoom)/2,H*(1-zoom)/2);s.cull(true);
      return {zoom,...lodCoverage()};
    },zoom));
  }
  assert(frames.some(row=>row.pending>0),'Delayed previews exercise the handoff');
  assert(frames.every(row=>row.drawn===row.total),`Every print stays represented during zoom: ${JSON.stringify(frames)}`);
  await page.evaluate(()=>{const s=lodSea,W=s.el.clientWidth,H=s.el.clientHeight;s.setCamera(2,-W/2,-H/2);s.cull(true);});
  const pendingInput=await page.evaluate(()=>{
    const s=lodSea,it=[...s.items.values()].filter(it=>it.imagePending&&!it.density).sort((a,b)=>Math.hypot(a.x-s.el.clientWidth/2,a.y-s.el.clientHeight/2)-Math.hypot(b.x-s.el.clientWidth/2,b.y-s.el.clientHeight/2))[0];
    const box=it.el.getBoundingClientRect(),target=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
    return {card:getComputedStyle(it.el).visibility,image:getComputedStyle(it.el.querySelector('.pile-cover')).visibility,hit:target?.closest('.ps-item')===it.el};
  });
  assert.deepEqual(pendingInput,{card:'visible',image:'hidden',hit:true},'The fallback print remains interactive while its live image loads');
  slow=false;
  await page.waitForTimeout(1800);
  const refreshed=await page.evaluate(()=>!lodSea.spritesDirty&&lodSea.densityStats.gpu<lodSea.items.size);
  assert(refreshed,'Image decoding refreshes the cached sprite layer even when physics is resting');
  const loaded=await page.evaluate(()=>lodCoverage());assert.equal(loaded.drawn,loaded.total);assert(loaded.ready>0,'Decoded live images replace their atlas sprites');
  // A single failed preview keeps its real atlas image.
  const failure=await page.evaluate(FIRST=>{const s=lodSea,it=s.items.get(FIRST);s.promote(FIRST,false);return {pending:it.imagePending,...lodCoverage()};},FIRST);
  await page.waitForFunction(FIRST=>{const it=lodSea.items.get(FIRST),img=it.el.querySelector('.pile-cover');return it.imagePending&&img?.complete&&!img.naturalWidth;},FIRST);
  assert.equal((await page.evaluate(()=>lodCoverage())).drawn,loaded.total);
  const dirty=await page.evaluate(()=>{
    const s=lodSea,it=[...s.items.values()].find(it=>it.density);
    s.spritesDirty=s.densityDirty=false;s.promote(it.id,false);
    return {sprites:s.spritesDirty,canvas:s.densityDirty};
  });
  assert(dirty.sprites&&dirty.canvas,'A direct promotion invalidates both cached renderers');
  const reduced=await page.evaluate(()=>{
    const s=lodSea;s.drawDensity(s.el.clientWidth,s.el.clientHeight);s.domLimit=40;
    for(const it of s.moving)it.lifted=it.el.classList.contains('lifted');
    s.spritesDirty=s.densityDirty=false;
    const positions=new Float32Array(s.bodies.flatMap(body=>{const it=s.items.get(body.id);return [it.x,it.y,it.size];}));
    s.receive({generation:s.generation,positions,settled:true,ms:0,focusCount:0});
    return lodCoverage();
  });
  assert.equal(reduced.drawn,reduced.total,'Worker demotions immediately return their prints to the sprite layer');
  const shapes=await page.evaluate(()=>{
    const rows=[],s=lodSea;
    const bounds=(pixels,W,H)=>{let x0=W,y0=H,x1=-1,y1=-1;
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){const at=(y*W+x)*4;if(pixels[at]>180&&pixels[at+1]<90&&pixels[at+2]<90){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}}
      return {left:x0,top:y0,width:x1-x0+1,height:y1-y0+1};};
    for(const dims of [[400,200],[200,400],[300,300],[400,25]]){
      const atlas=document.createElement('canvas');atlas.width=atlas.height=16;
      const source=s.atlasCell(atlas,0,dims),ctx=atlas.getContext('2d');ctx.fillStyle='#ef241a';ctx.fillRect(0,0,16,16);
      const canvas=document.createElement('canvas'),gpu=new SpriteLayer(canvas);
      const data=new Float32Array(SpriteLayer.STRIDE);data.set([120,100,120,source.x,source.y,16,16,1,.5,.5,.5,source.aspect,0]);
      gpu.draw({W:240,H:240,dpr:1,zoom:1,tx:0,ty:0,time:0,wobble:[5600,0,0,0,0]},[{image:atlas,version:0,data,n:1,upload:true}]);
      const pixels=new Uint8Array(240*240*4);gpu.gl.readPixels(0,0,240,240,gpu.gl.RGBA,gpu.gl.UNSIGNED_BYTE,pixels);
      const flipped=new Uint8Array(pixels.length);for(let y=0;y<240;y++)flipped.set(pixels.subarray(y*960,(y+1)*960),(239-y)*960);
      const sprite=bounds(flipped,240,240);
      const reference=document.createElement('canvas');reference.width=reference.height=240;
      s.drawCard(reference.getContext('2d'),source,60,20,120,1);
      const fallback=bounds(reference.getContext('2d').getImageData(0,0,240,240).data,240,240);
      // CSS contains the original photo in an 89%-wide window with the same side/top inset and chin.
      const width=Math.min(120*.89,(160-120*.225)*dims[0]/dims[1]),height=width*dims[1]/dims[0];
      rows.push({dims,sprite,fallback,expected:{left:120-width/2,top:20+120*.055,width,height}});
      gpu.destroy();
    }
    return rows;
  });
  for(const row of shapes)for(const renderer of [row.sprite,row.fallback])for(const key of ['left','top','width','height'])
    assert(Math.abs(renderer[key]-row.expected[key])<2,`Photo geometry stays the same through each renderer: ${JSON.stringify(row)}`);
  await page.screenshot({path:OUT+'/sea-lod.png'});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({frames,pendingInput,loaded,failure,dirty,reduced,shapes,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
