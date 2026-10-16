// Styling must survive the actual wheel and pointer gestures, not just their settled endpoints.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[],states=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.sea.settled);
  await page.evaluate(()=>{S.filter=true;S.crop='height';paintFilters();PhotoNotes.repaint();});
  const shots=await page.evaluate(()=>{
    const shots=[...World.sea.items.values()].filter(it=>!it.take);
    return [shots.find(it=>it.n>1).id,shots.find(it=>it.n===1&&it.dims[0]>it.dims[1]).id];
  });
  const check=async(label,detail=true)=>{
    const state=await page.evaluate(detail=>{
      const it=motionItem,img=motionImage,paper=img.closest('.paper'),host=PhotoNotes.seaDetail;
      const r=host?.getBoundingClientRect(),p=it.el.getBoundingClientRect();
      return {id:it.id,zoom:World.sea.camera.zoom,connected:img.isConnected,visible:getComputedStyle(img).visibility,
        sameImage:(host&&getComputedStyle(host.querySelector('.paper')).visibility!=='hidden'?host.querySelector('.window img'):it.el.querySelector('.pile-cover'))===img,
        filter:img.style.filter,opacity:getComputedStyle(it.el).opacity,shadow:getComputedStyle(it.el).boxShadow,geometry:[img.style.width,img.style.height,img.style.transform],
        sameAnimation:paper?.getAnimations()[0]===motionAnimation,sameDetail:!detail||host===motionDetail,
        drift:r?Math.hypot(r.left-p.left,r.top-p.top)+Math.abs(r.width-p.width):0,
        takes:[...it.el.querySelectorAll('.pile-take')].every(el=>getComputedStyle(el).visibility==='visible')};
    },detail);
    states.push({label,...state});
    assert(state.connected&&state.visible==='visible'&&state.sameImage,`${label}: the same rendered photo stays visible: ${JSON.stringify(state)}`);
    assert(state.filter.includes('url('),`${label}: enhancement stays applied`);
    assert.equal(state.opacity,await page.evaluate(()=>motionOpacity),`${label}: moving a print does not dim its paper or picture`);
    assert.notEqual(state.shadow,'none',`${label}: the print keeps its shadow`);
    assert(state.sameAnimation,`${label}: the paper's animation is not restarted`);
    assert(state.sameDetail,`${label}: the focused controls are not rebuilt while moving`);
    if(detail)assert(state.drift<3,`${label}: controls follow the print: ${JSON.stringify(state)}`);
    assert(state.takes,`${label}: the stack stays visible`);
    return state;
  };
  for(const id of shots){
    await page.evaluate(id=>{window.motionItem=World.sea.items.get(id);World.sea.zoomToPrint(motionItem);},id);
    await page.waitForSelector('.sea-photo-detail .photo-sticky');
    await page.evaluate(()=>{
      window.motionDetail=PhotoNotes.seaDetail;
      window.motionImage=getComputedStyle(motionDetail.querySelector('.paper')).visibility==='hidden'?motionItem.el.querySelector('.pile-cover'):motionDetail.querySelector('.window img');
      window.motionAnimation=motionImage.closest('.paper')?.getAnimations()[0];
      window.motionOpacity=getComputedStyle(motionItem.el).opacity;
    });
    const start=await check('focused');
    for(const delta of [-50,-50,-50,50,50,50]){
      const before=await page.evaluate(()=>World.sea.camera.zoom);
      await page.mouse.move(720,400);await page.mouse.wheel(0,delta);
      await page.waitForFunction(before=>World.sea.camera.zoom!==before,before);
      const during=await check('wheel');assert.deepEqual(during.geometry,start.geometry,'The camera transforms the card without reframing its photo');
    }
    await page.mouse.move(720,400);await page.mouse.down();
    for(let i=1;i<=6;i++){await page.mouse.move(720-i*14,400-i*5);await check('focused pan');}
    await page.screenshot({path:`${OUT}/motion-focused-${id}.png`});await page.mouse.up();await check('pan released');
    // Back in the overview, the same card keeps its look while water and prints are dragged.
    await page.evaluate(()=>World.sea.resetCamera());await check('reset',false);
    await page.evaluate(()=>{const s=World.sea,it=motionItem;s.setCamera(1.4,650-it.x*1.4,430-it.y*1.4);});
    await page.waitForTimeout(300);
    const point=await page.evaluate(()=>{const r=motionItem.el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
    await page.mouse.move(point.x,point.y);await page.mouse.down();
    assert.equal(await page.evaluate(()=>World.sea.drag?.items[0]?.id),id,'The overview gesture grabs the print');
    for(let i=1;i<=5;i++){await page.mouse.move(point.x+i*8,point.y+i*5);await check('overview print drag',false);}
    await page.screenshot({path:`${OUT}/motion-overview-${id}.png`});
    // Cancel the test move; there is no library edit or accidental stack merge.
    await page.dispatchEvent('#world','pointercancel',{pointerId:1});await page.mouse.up();
    const water=await page.evaluate(()=>{
      const s=World.sea;
      for(let y=180;y<innerHeight-140;y+=31)for(let x=200;x<innerWidth-160;x+=31){
        const el=document.elementFromPoint(x,y),[wx,wy]=s.toWorld(x,y);
        if(!s.uiTarget(el)&&!s.photoAt(wx,wy))return {x,y};
      }
    });
    assert(water,'Open water for an overview pan');await page.mouse.move(water.x,water.y);await page.mouse.down();
    for(let i=1;i<=5;i++){await page.mouse.move(water.x-i*6,water.y-i*4);await check('overview water pan',false);}
    await page.mouse.up();await page.evaluate(()=>World.sea.resetCamera());
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({states,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
