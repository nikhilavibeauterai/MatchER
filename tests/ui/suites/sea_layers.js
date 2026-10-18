// Atlas sheets cannot decide which take covers a stack. A detailed cover leaves the underprints in place.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.waitForFunction(()=>typeof SpriteLayer==='function');
  const layers=await page.evaluate(()=>{
    const canvas=document.createElement('canvas'),gpu=new SpriteLayer(canvas);
    const batch=(colour,depth)=>{
      const image=document.createElement('canvas');image.width=image.height=16;
      const ctx=image.getContext('2d');ctx.fillStyle=colour;ctx.fillRect(0,0,16,16);
      const data=new Float32Array(SpriteLayer.STRIDE);data.set([120,120,120,0,0,16,16,1,.5,.5,.5,1,depth]);
      return {image,version:0,data,n:1,upload:true};
    };
    const cover=batch('#2457ef',-.3),take=batch('#ef241a',.3),rows=[];
    for(const batches of [[take,cover],[cover,take],[take,cover],[cover,take]]){
      gpu.draw({W:240,H:240,dpr:1,zoom:1,tx:0,ty:0,time:0,wobble:[5600,0,0,0,0]},batches);
      const pixel=new Uint8Array(4);gpu.gl.readPixels(120,140,1,1,gpu.gl.RGBA,gpu.gl.UNSIGNED_BYTE,pixel);rows.push([...pixel]);
    }
    gpu.destroy();return rows;
  });
  assert(layers.every(pixel=>pixel[2]>200&&pixel[0]<80),`The cover stays on top across sheet ordering: ${JSON.stringify(layers)}`);
  await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.sprites?.size===World.total&&World.sea.settled);
  const states=[];
  for(let pass=0;pass<3;pass++){
    await page.evaluate(()=>{
      const s=World.sea,it=[...s.items.values()].filter(it=>!it.take&&it.n>1).sort((a,b)=>b.n-a.n)[0];
      // Measure the actual live stack immediately before the presentation changes, including its current wobble.
      const add=it.el.classList.add.bind(it.el.classList);
      it.el.classList.add=(...names)=>{
        if(names.includes('photo-detail-source')){
          const under=[...it.el.querySelectorAll(':scope > .pile-take')];
          const cover=it.el.querySelector('.pile-cover'),paper=cover.closest('.paper');
          window.layerBefore={under,rects:under.map(el=>el.getBoundingClientRect()),bounds:it.el.getBoundingClientRect(),cover,paper,animation:paper.getAnimations()[0]};
        }
        return add(...names);
      };
      s.zoomToPrint(it);window.layerTarget=it;
    });
    await page.waitForSelector('.sea-photo-detail .photo-notes-tab',{state:'visible'});
    await page.waitForFunction(()=>PhotoNotes.hosts.get(PhotoNotes.seaDetail)?.data);
    const state=await page.evaluate(()=>{
      const s=World.sea,detail=PhotoNotes.seaDetail,source=PhotoNotes.seaSource;
      const r=detail.getBoundingClientRect(),p=source.getBoundingClientRect(),under=[...source.querySelectorAll(':scope > .pile-take')];
      return {details:document.querySelectorAll('.sea-photo-detail').length,detail:getComputedStyle(detail).visibility,
        source:getComputedStyle(source).visibility,tab:getComputedStyle(detail.querySelector('.photo-notes-tab')).visibility,
        cover:getComputedStyle(source.querySelector('.pile-cover')).visibility,count:source.querySelector('.ps-stack')?.textContent,
        sameCover:source.querySelector('.pile-cover')===layerBefore.cover&&source.querySelector('.paper')===layerBefore.paper,
        sameAnimation:source.querySelector('.paper').getAnimations()[0]===layerBefore.animation,duplicate:getComputedStyle(detail.querySelector('.paper')).visibility,
        takes:under.length,sameTakes:under.length===layerBefore.under.length&&under.every((el,i)=>el===layerBefore.under[i]),
        visibleTakes:under.every(el=>getComputedStyle(el).visibility==='visible'&&el.complete&&el.naturalWidth),
        takeDrift:Math.max(...under.map((el,i)=>{
          const r=el.getBoundingClientRect(),before=layerBefore.rects[i],b=layerBefore.bounds;
          return Math.max(Math.abs((r.left-p.left)/p.width-(before.left-b.left)/b.width)*p.width,
            Math.abs((r.top-p.top)/p.height-(before.top-b.top)/b.height)*p.height,
            Math.abs(r.width/p.width-before.width/b.width)*p.width,Math.abs(r.height/p.height-before.height/b.height)*p.height);
        })),
        transitions:getComputedStyle(source).transitionProperty,drift:Math.hypot(r.left-p.left,r.top-p.top),
        offscreen:s.moving.filter(it=>!it.focused&&it.id!==s.held&&!s.inView(it,-s.camera.tx/s.camera.zoom,-s.camera.ty/s.camera.zoom,(s.el.clientWidth-s.camera.tx)/s.camera.zoom,(s.el.clientHeight-s.camera.ty)/s.camera.zoom,0)).length};
    });
    states.push(state);assert.equal(state.details,1);assert.equal(state.detail,'visible');assert.equal(state.tab,'visible');assert.equal(state.source,'visible');assert.equal(state.cover,'visible');assert.equal(state.duplicate,'hidden');
    assert(state.takes>1&&state.sameTakes&&state.visibleTakes,'The same stack stays visible behind its detailed cover');
    assert(state.takeDrift<.1,`Underprints do not jump during the handoff: ${JSON.stringify(state)}`);
    assert(state.sameCover&&state.sameAnimation,'Focus retains the original cover, paper and animation');assert.match(state.count,/^\s*\d+\s*$/,'The clipped handwritten count survives');
    assert(!state.transitions.includes('width')&&!state.transitions.includes('height')&&!state.transitions.includes('opacity'),JSON.stringify(state));
    assert(state.drift<2,JSON.stringify(state));assert.equal(state.offscreen,0,'No off-screen live cards survive culling');
    if(!pass){
      await page.screenshot({path:OUT+'/sea-layers-focused.png'});await page.click('.sea-photo-detail .photo-notes-tab');await page.waitForSelector('.photo-note-sheet .notes-writing');
      await page.waitForTimeout(450);
      const sheet=await page.evaluate(()=>{
        const host=PhotoNotes.seaDetail.getBoundingClientRect(),paper=PhotoNotes.sheet.getBoundingClientRect();
        return {width:Math.abs(host.width-paper.width),height:Math.abs(host.height-paper.height),gap:paper.left-host.right,right:paper.right};
      });
      assert(sheet.width<2&&sheet.height<2&&sheet.gap>=16&&sheet.right<=1440-14,`The full sheet opens beside the real print: ${JSON.stringify(sheet)}`);
      await page.screenshot({path:OUT+'/sea-layers-notes.png'});await page.keyboard.press('Escape');
    }
    await page.evaluate(()=>World.sea.resetCamera());await page.waitForTimeout(350);
    assert.equal(await page.locator('.sea-photo-detail,.photo-detail-source').count(),0,'Zooming out restores the live cover');
  }
  await page.screenshot({path:OUT+'/sea-layers-overview.png'});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({layers,states,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
