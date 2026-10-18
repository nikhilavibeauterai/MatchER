// Clicking an ambient take selects it for Filter; it never magnifies the sea behind the review card.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
const problems=[],res={};let page;
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:2048,height:1152}});
  page.on('pageerror',error=>problems.push(error.message));let choices=0;
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/(vote|filter\/(decision|tune))\b/.test(request.url()))choices++;});
  const check=(key,value)=>{res[key]=value;assert.equal(value,true,key);};
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos.size&&!World.loading);
  const ready=async()=>{
    await page.waitForSelector('.filter-shot');
    await page.waitForFunction(()=>!World.flights?.size&&!document.querySelector('.filter-thinking'));
  };
  const camera=()=>page.evaluate(()=>({...World.sea.camera}));
  const take=()=>page.locator('.filter-shot').getAttribute('data-photo');
  const target=()=>page.evaluate(()=>{
    const sea=World.sea,current=Number(document.querySelector('.filter-shot')?.dataset.photo);
    for(const it of sea.items.values()){
      if(it.photo===current||it.take||it.lifted||!it.el.isConnected)continue;
      const r=it.el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height*.35,hit=document.elementFromPoint(x,y);
      if(x>50&&x<innerWidth-50&&y>150&&y<innerHeight-130&&it.el.contains(hit)&&!hit.closest('button'))return {id:it.id,photo:it.photo,x,y};
    }
    return null;
  });
  const water=()=>page.evaluate(()=>{
    const sea=World.sea;
    for(let y=180;y<innerHeight-150;y+=41)for(let x=80;x<innerWidth-80;x+=43){
      const hit=document.elementFromPoint(x,y);if(hit&&!hit.closest('.ps-item')&&!sea.uiTarget(hit))return {x,y};
    }
    return null;
  });
  await page.evaluate(()=>location.hash='#filter');await ready();
  check('filterRetainsManualCamera',await page.evaluate(()=>World.sea.cameraOn&&World.sea.clickToZoom===false));
  const before=await camera(),other=await target();assert(other,'A different take is visible beside the spotlight');
  await page.mouse.click(other.x,other.y);
  await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id,other.photo);await ready();
  await page.waitForTimeout(450);
  assert.deepEqual(await camera(),before);check('clickChangesReviewWithoutZoomingBackground',true);
  check('seaRetainsPhotoDimensions',await page.evaluate(()=>[...World.sea.items.values()].every(it=>it.dims?.length===2)));
  await page.screenshot({path:`${OUT}/filter-focus-selected.png`});
  const marks=[],hover=await target();assert(hover,'Another sea print is available to hover');
  for(const zoom of [1,2,4]){
    await page.evaluate(({zoom,id})=>{
      const sea=World.sea,it=sea.items.get(id);sea.setCamera(zoom,innerWidth*.23-it.x*zoom,innerHeight*.45-it.y*zoom);
    },{zoom,id:hover.id});
    const point=await page.evaluate(id=>{const r=World.sea.items.get(id).el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*.25};},hover.id);
    await page.mouse.move(point.x,point.y);await page.waitForTimeout(180);
    for(const outcome of ['pass','fail']){
      const mark=await page.evaluate(({id,outcome})=>{
        const sea=World.sea,it=sea.items.get(id);it.el.dataset.filterResult=outcome;
        const style=getComputedStyle(it.el,'::after'),scale=sea.camera.zoom*(it.renderScale||1)*new DOMMatrix(style.transform).a;
        return {zoom:sea.camera.zoom,outcome,content:style.content,width:parseFloat(style.width)*scale,height:parseFloat(style.height)*scale,font:parseFloat(style.fontSize)*scale,border:parseFloat(style.borderTopWidth)*scale};
      },{id:hover.id,outcome});
      assert(mark.width>=20&&mark.width<=32&&mark.height>=20&&mark.height<=32&&mark.font<=24&&mark.border<=3,`Filter marks keep their screen size: ${JSON.stringify(mark)}`);
      assert(mark.content.includes(outcome==='pass'?'✓':'✕'));marks.push(mark);
    }
    await page.screenshot({path:`${OUT}/filter-hover-marks-${zoom}.png`});
  }
  await page.evaluate(()=>World.sea.resetCamera());
  check('hoverMarksKeepTheirScreenSize',marks.length===6);
  const open=await water();assert(open,'Filter leaves open water for wheel zoom');
  await page.mouse.move(open.x,open.y);await page.mouse.wheel(0,-700);await page.waitForTimeout(350);
  check('wheelStillZooms', (await camera()).zoom>1.5);
  await page.mouse.wheel(0,1800);await page.waitForTimeout(600);
  assert.deepEqual(await camera(),{zoom:1,tx:0,ty:0});
  check('zoomingOutKeepsSelectionAndClearsDetailLayer',await take()===String(other.photo)&&await page.locator('.sea-photo-detail-layer').count()===0);
  await page.screenshot({path:`${OUT}/filter-focus-zoomed-out.png`});
  // Home still glides into a print. Leaving during that glide must not resume it behind Filter.
  await page.evaluate(()=>location.hash='#home');await page.waitForFunction(()=>World.mode==='ambient'&&World.sea.clickToZoom);
  await page.waitForSelector('.home-world');await page.waitForFunction(()=>!World.loading&&!World.flights?.size&&World.sea.settled);
  const home=await target();assert(home,'A Home print is reachable');
  await page.mouse.click(home.x,home.y);
  await page.waitForFunction(()=>World.sea.camera.zoom>1);
  await page.evaluate(()=>location.hash='#filter');await ready();await page.waitForTimeout(600);
  assert.deepEqual(await camera(),{zoom:1,tx:0,ty:0});
  check('leavingHomeCancelsItsClickGlide',true);
  const again=await target();assert(again,'Another Filter take stays reachable after returning');
  await page.mouse.click(again.x,again.y);await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id,again.photo);
  check('returningToFilterRestoresTakeSelection',(await camera()).zoom===1);
  check('selectionAndZoomNeverCastVotes',choices===0);
  await page.setViewportSize({width:390,height:844});await ready();await page.waitForTimeout(300);
  check('phoneKeepsOneSpotlightAndNoOverflow',await page.locator('.filter-shot').count()===1&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${OUT}/filter-focus-phone.png`});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({...res,problems}));await browser.close();
})().catch(async error=>{
  console.error('FAILED:',error.stack,JSON.stringify({...res,problems}));
  if(page)await page.screenshot({path:`${OUT}/filter-focus-fail.png`}).catch(()=>{});process.exit(1);
});
