// Quick sort and Find more use the shared sea camera without turning a close look into a group decision.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:true}),problems=[],writes=[],results=[];
  page.on('pageerror',e=>problems.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(draw|vote|groups)\b/.test(new URL(r.url()).pathname))writes.push(r.url());});
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading);
  const group=await page.evaluate(async()=>{
    const world=await api('/api/world?per=1000');await api('/api/rescue',{ids:world.photos.map(p=>p.id),on:true});
    let b=await api('/api/draw/board?per=400&uper=400');
    for(const shot of [...b.groups.flatMap(g=>g.shots),...b.unsorted.shots])for(const photo of shot.members.filter(id=>id!==shot.rep))await api('/api/groups/split',{photo});
    b=await api('/api/draw/board?per=400&uper=400');const photos=[...b.groups.flatMap(g=>g.shots),...b.unsorted.shots].map(s=>s.rep);
    await api('/api/draw/move',{photos,theme:null});const first=await api('/api/draw/new',{photos:[photos[0]]});await api('/api/draw/new',{photos:[photos[1]]});return first.theme.id;
  });
  const camera=()=>page.evaluate(()=>({...World.sea.camera}));
  const state=()=>page.evaluate(async()=>({board:await api('/api/draw/board?per=400&uper=400'),photo:document.querySelector('#dtop')?.dataset.photo}));
  const point=()=>page.locator('#dtop .print').evaluate(el=>{const r=el.getBoundingClientRect(),s=el.closest('.screen-body').getBoundingClientRect();return{x:(Math.max(r.left,s.left)+Math.min(r.right,s.right))/2,y:(Math.max(r.top,s.top)+Math.min(r.bottom,s.bottom))/2};});
  const cdp=await page.context().newCDPSession(page);
  for(const route of ['#draw?sort=1',`#draw?play=${group}`]){
    await page.goto(BASE+'/'+route);await page.waitForSelector('.draw-play');
    if(await page.locator('[data-c=onebyone]').count())await page.click('[data-c=onebyone]');
    await page.waitForSelector('#dtop .print img');await page.waitForFunction(()=>{const host=document.querySelector('#dtop .print'),img=host?.querySelector('img');return img?.complete&&img.naturalWidth&&PhotoNotes.hosts.get(host)?.data&&!World.arrivals?.has(Number(document.querySelector('#dtop').dataset.photo));});
    assert(await page.evaluate(()=>World.sea.cameraOn),'Group drafting keeps the shared sea camera enabled');
    const before=await state(),calls=writes.length,origin=await page.locator('#dtop .print').boundingBox();
    await page.evaluate(()=>{window.groupZoomPhoto=document.querySelector('#dtop .print');window.groupZoomImage=groupZoomPhoto.querySelector('img');});
    let p=await point();await page.mouse.move(p.x,p.y);await page.mouse.wheel(0,-600);
    await page.waitForFunction(()=>World.sea.camera.zoom>1.5);
    const zoomed=await camera(),large=await page.locator('#dtop .print').boundingBox();
    assert(Math.abs(large.height/origin.height-zoomed.zoom)<.05,'The polaroid grows with the same camera as the sea');
    assert(await page.evaluate(()=>document.querySelector('#dtop .print')===groupZoomPhoto&&groupZoomPhoto.querySelector('img')===groupZoomImage),'Zoom retains the same paper and image nodes');
    await page.waitForFunction(()=>{const card=document.querySelector('#dtop .print'),img=card.querySelector('img'),r=card.getBoundingClientRect();return r.height<innerHeight*.8||img.getAttribute('src')===M(Number(document.querySelector('#dtop').dataset.photo),r.width,true);});
    p=await point();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x-100,p.y-70,{steps:6});await page.mouse.up();
    const panned=await camera();assert(Math.abs(panned.tx-zoomed.tx+100)<3&&Math.abs(panned.ty-zoomed.ty+70)<3,JSON.stringify({zoomed,panned}));
    const rail=await page.locator('#bins').boundingBox();await page.mouse.move(rail.x+rail.width/2,rail.y+Math.min(50,rail.height/2));await page.mouse.wheel(0,300);await page.waitForTimeout(120);
    assert.deepEqual(await camera(),panned,'The group list keeps its own wheel');
    assert.deepEqual(await state(),before);assert.equal(writes.length,calls,'Zooming, panning and scrolling do not file, toss or vote');
    await page.screenshot({path:`${OUT}/group-zoom-${route.includes('sort')?'quick-sort':'find-more'}.png`});
    // A close look extends beneath the controls, rather than being cut out by the old photo column.
    const shifted=await page.locator('.draw-play .screen-head').evaluate(head=>{const deck=head.closest('.draw-play').querySelector('.deck'),top=deck.getBoundingClientRect().top;head.style.paddingBottom='44px';return deck.getBoundingClientRect().top-top;});
    assert(Math.abs(shifted)>5,'A late help or font layout moves the dealt photo before the next gesture');
    p=await point();p={x:Math.round(p.x),y:Math.round(p.y)}; // Native wheel coordinates are whole screen pixels.
    const underPointer=()=>page.locator('#dtop img').evaluate((img,p)=>{const r=img.getBoundingClientRect();return[(p.x-r.left)/r.width,(p.y-r.top)/r.height];},p);
    const originalPoint=await underPointer(),delta=await page.evaluate(()=>-Math.log(56/World.sea.camera.zoom)/World.sea.tuning.wheelSpeed);
    await page.mouse.move(p.x,p.y);await page.mouse.wheel(0,delta);await page.waitForFunction(()=>World.sea.camera.zoom>55);
    const closePoint=await underPointer();
    assert(Math.hypot(...closePoint.map((v,i)=>v-originalPoint[i]))<.0001,`Deep zoom keeps the same part of the photo under the pointer after layout changes: ${JSON.stringify({originalPoint,closePoint,p})}`);
    const outside=await page.evaluate(()=>{
      const card=document.querySelector('#dtop'),print=card.querySelector('.print'),r=card.closest('.screen-body').getBoundingClientRect();
      const points=[{x:r.left-8,y:r.top+64},{x:r.right+8,y:r.top+64},{x:r.left+64,y:r.top-8},{x:r.left+64,y:r.bottom+8}];
      return points.find(p=>p.x>0&&p.x<innerWidth&&p.y>80&&p.y<innerHeight&&print.contains(document.elementFromPoint(p.x,p.y)));
    });
    assert(outside,'The visible enlarged print continues beyond the former photo column');
    const deep=await camera();await page.mouse.move(outside.x,outside.y);await page.mouse.down();await page.mouse.move(outside.x+30,outside.y+20,{steps:4});await page.mouse.up();
    const beyond=await camera();assert(Math.abs(beyond.tx-deep.tx-30)<3&&Math.abs(beyond.ty-deep.ty-20)<3,'Dragging the photo beyond its former column still pans');
    assert(await page.locator('.draw-play .screen-head').evaluate(head=>{const controls=[...head.querySelectorAll('a,button')].filter(el=>el.getBoundingClientRect().width&&getComputedStyle(el).opacity!=='0');return controls.length&&controls.every(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});}),'The enlarged photo stays beneath the header controls');
    assert(await page.evaluate(()=>{const main=document.querySelector('#main'),body=document.querySelector('.draw-play .screen-body');main.scrollTo(100,100);return !main.scrollLeft&&!main.scrollTop&&!body.scrollTop&&document.documentElement.scrollWidth<=innerWidth;}),'Deep zoom cannot scroll or expand the page');
    assert.deepEqual(await state(),before);assert.equal(writes.length,calls,'Looking outside the old column never files a photo');
    await page.screenshot({path:`${OUT}/group-zoom-${route.includes('sort')?'quick-sort':'find-more'}-deep.png`});
    p=await point();await page.mouse.dblclick(p.x,p.y);await page.waitForFunction(()=>World.sea.camera.zoom===1);
    await page.locator('.draw-play .screen-head').evaluate(head=>head.style.removeProperty('padding-bottom'));
    // Real two-finger gestures cancel a begun one-finger card drag instead of committing it on release.
    p=await point();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x-35,y:p.y},{x:p.x+35,y:p.y}]});
    for(const offset of [50,65,80])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x-offset,y:p.y},{x:p.x+offset,y:p.y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const pinched=await camera();assert(pinched.zoom>1.7,JSON.stringify(pinched));
    assert(await page.evaluate(()=>!World.sea.pan&&!World.sea.touches.size&&!document.querySelector('#dtop').classList.contains('held')),'Pinch releases both fingers and any card drag');
    assert.deepEqual(await state(),before);assert.equal(writes.length,calls);
    await page.evaluate(()=>World.sea.resetCamera());await page.setViewportSize({width:390,height:844});
    p=await point();await page.mouse.move(p.x,p.y);await page.mouse.wheel(0,-500);await page.waitForFunction(()=>World.sea.camera.zoom>1.5);
    assert(await page.locator('[data-c=skip]').isVisible(),'Phone actions remain reachable while the photo is enlarged');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Zoom does not enlarge the page');
    await page.screenshot({path:`${OUT}/group-zoom-${route.includes('sort')?'quick-sort':'find-more'}-phone.png`});
    const previous=before.photo;await page.click('[data-c=skip]');await page.waitForFunction(previous=>document.querySelector('#dtop')?.dataset.photo!==previous,previous);
    assert.equal((await camera()).zoom,1,'The next dealt photo starts in its normal place');assert.equal(writes.length,calls,'Skipping stays a deferral');
    results.push({route,zoom:zoomed.zoom,deep:deep.zoom,pinched:pinched.zoom,phone:true});await page.setViewportSize({width:1440,height:1000});
  }
  await page.goto(BASE+'/#draw?sort=1');await page.waitForSelector('#dtop .print img');
  await page.waitForFunction(()=>World.sea.settled&&!World.arrivals?.has(Number(document.querySelector('#dtop')?.dataset.photo)));
  const dragSource=Number(await page.locator('#dtop').getAttribute('data-photo')),dragCalls=writes.length;
  const covered=await page.evaluate(()=>{
    const sea=World.sea,card=document.querySelector('#dtop .print'),r=card.getBoundingClientRect(),root=sea.el.getBoundingClientRect(),
      x=r.left+r.width/2,y=r.top+r.height/2,[wx,wy]=sea.toWorld(x-root.left,y-root.top),
      under=[...sea.items.values()].find(it=>!it.take&&!it.lifted&&!it.el.classList.contains('lifted')&&it.photo!==Number(document.querySelector('#dtop').dataset.photo));
    under.x=wx;under.y=wy;under.dropped=true;sea.paintItem(under,true);sea.releasePins=[{id:under.id,x:wx,y:wy}];sea.kick();
    const down=sea.down;window.groupInputProbe={down:[],original:down};sea.down=function(e,photo){groupInputProbe.down.push(photo?.dataset.id);return down.call(this,e,photo);};
    return {x,y,id:under.id,hit:sea.photoAt(wx,wy)?.id};
  });
  assert(covered.hit,'A real sea thumbnail is directly under the dealt print');
  await page.mouse.click(covered.x,covered.y);await page.waitForTimeout(150);
  assert.equal(await page.locator('.inspect').count(),0,'Clicking the dealt print never inspects the thumbnail underneath');
  const destination=page.locator('#bins .bin:not(.new)').first(),bin=await destination.boundingBox(),target=Number(await destination.getAttribute('data-bin'));
  await page.mouse.move(covered.x,covered.y);await page.mouse.down();await page.mouse.move(bin.x+bin.width/2,bin.y+bin.height/2,{steps:12});
  assert(await destination.evaluate(el=>el.classList.contains('hot')),'The main print reaches the chosen group');
  await page.mouse.up();await page.waitForFunction(photo=>Number(document.querySelector('#dtop')?.dataset.photo)!==photo,dragSource);
  assert.equal(writes.length,dragCalls+1,'A deliberate group drag makes exactly one edit');
  const filed=await page.evaluate(async({photo,group})=>{const b=await api('/api/draw/board?per=400&uper=400');return b.groups.find(g=>g.id===group)?.shots.some(s=>s.members.includes(photo));},{photo:dragSource,group:target});
  assert(filed,'The main photo, rather than its covered thumbnail, is filed into the group');
  assert.deepEqual(await page.evaluate(()=>groupInputProbe.down),[],'The sea pointer handler never grabs an obscured thumbnail');
  await page.evaluate(()=>World.sea.down=groupInputProbe.original);
  await page.goto(BASE+'/#home');await page.waitForSelector('.journey');
  assert.equal(await page.evaluate(()=>World.sea.externalFocus==null&&World.sea.camera.zoom===1),true,'Leaving drafting releases its camera attachment');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({results,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
