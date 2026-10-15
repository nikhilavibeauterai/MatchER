// Short windows still leave a useful photo and a reachable, spatially consistent D-pad.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
let page;
(async()=>{
  const browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[],layouts=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.evaluate(()=>location.hash='#filter');await page.waitForSelector('.filter-shot');
  await page.addStyleTag({content:'.filter-review-controls button{font-family:monospace!important}'});
  for(const [name,width,height] of [['desktop',1440,900],['phone',390,844],['short-phone',390,667],['small-phone',320,568],['landscape',844,390]]){
    await page.setViewportSize({width,height});await page.waitForTimeout(400);
    await page.waitForFunction(()=>!World.flights?.size);
    const measure=()=>page.evaluate(()=>{
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
      const photo=document.querySelector('.filter-print'),controls=[...document.querySelectorAll('.filter-review-controls button,.filter-outcome,#filter-actions button,.filter-stage .screen-head button')].filter(e=>e.getClientRects().length);
      // During avoidance a thumbnail may still cross the photo's rectangle. Its whole layer must stay below play.
      const probe=document.createElement('div');probe.style.cssText='position:absolute;inset:0;z-index:999;pointer-events:auto';document.querySelector('#world').append(probe);
      const r=rect(photo),photoClear=[.2,.5,.8].every(x=>[.2,.5,.8].every(y=>{const hit=document.elementFromPoint(r.x+r.w*x,r.y+r.h*y);return photo.contains(hit)||!!hit?.closest('.filter-spotlight>.copy-path');}));
      const dpad=Object.fromEntries([...document.querySelectorAll('.filter-review-controls button')].map(e=>[e.dataset.tune||e.dataset.decision||'skip',rect(e)]));
      const result={photo:rect(photo),photoClear,dpad,content:rect(document.querySelector('#filter-content')),dock:rect(document.querySelector('#journey-dock')),
        pageOverflow:document.documentElement.scrollWidth>innerWidth,mainOverflow:document.querySelector('#main').scrollHeight>document.querySelector('#main').clientHeight+1,
        controls:controls.map(e=>{const r=rect(e);return {text:e.textContent.trim(),...r,textFits:e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.clientHeight,reachable:e.contains(document.elementFromPoint(r.x+r.w/2,r.y+r.h/2))};})};
      probe.remove();return result;
    });
    const review=await measure();await page.screenshot({path:`${OUT}/FL-${name}.png`});
    const reasons=review;
    layouts.push({name,width,height,review,reasons});
  }
  console.log(JSON.stringify({layouts,problems},null,1));
  assert.deepEqual(problems,[]);
  for(const {name,width,review,reasons} of layouts){
    assert(!review.pageOverflow&&!review.mainOverflow,`${name}: page overflows`);
    assert(review.photo.h>=100&&review.photo.w>=70,`${name}: photo is too small to judge: ${JSON.stringify(review.photo)}`);
    assert(review.photoClear,`${name}: sea covers the focused photo`);
    const {toward,away,aside,keep,skip}=review.dpad;
    assert(Object.values(review.dpad).every(r=>r.y>=review.content.y-1&&r.bottom<=review.content.bottom+1),`${name}: D-pad clipped by its playfield`);
    assert(toward&&away&&aside&&keep&&skip,`${name}: a D-pad choice is missing`);
    const cx=r=>r.x+r.w/2,cy=r=>r.y+r.h/2;
    assert(Math.abs(cx(toward)-cx(skip))<=1&&Math.abs(cx(away)-cx(skip))<=1,`${name}: tuning choices must align above and below Skip`);
    assert(toward.bottom<=skip.y+1&&away.y>=skip.bottom-1,`${name}: tuning choices must sit above and below Skip`);
    assert(Math.abs(cy(aside)-cy(skip))<=1&&Math.abs(cy(keep)-cy(skip))<=1,`${name}: Toss, Skip and Keep must share the middle row`);
    assert(aside.right<=skip.x+1&&keep.x>=skip.right-1,`${name}: Toss and Keep must sit left and right of Skip`);
    const choices=Object.entries(review.dpad);
    for(let i=0;i<choices.length;i++)for(let j=i+1;j<choices.length;j++){
      const [aName,a]=choices[i],[bName,b]=choices[j];
      assert(a.right<=b.x+1||b.right<=a.x+1||a.bottom<=b.y+1||b.bottom<=a.y+1,`${name}: ${aName} overlaps ${bName}`);
    }
    for(const layout of [review,reasons])assert(layout.controls.every(b=>b.h>=43&&b.x>=-1&&b.right<=width+1&&b.y>=layout.dock.bottom-1&&b.reachable&&b.textFits),`${name}: a control is clipped or covered: ${JSON.stringify(layout.controls)}`);
  }
  await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page)await page.screenshot({path:OUT+'/FL-failure.png'}).catch(()=>{});process.exit(1);});
