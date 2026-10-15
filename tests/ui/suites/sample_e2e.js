// The bundled public-domain pack works offline and makes a playable small tournament.
const {chromium}=require("playwright-core");
const assert=require("node:assert/strict");
const {BASE,LINK,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[],external=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.route('**/*',route=>{if(route.request().url().startsWith(BASE+'/'))route.continue();else{external.push(route.request().url());route.abort();}});
  await page.goto(LINK);await page.click('#sample');
  await page.waitForSelector('#an-body',{timeout:300000});
  const organizing=[];let shot=false;
  const deadline=Date.now()+300000;
  while(Date.now()<deadline&&!await page.locator('#an-go').isVisible()) {
    const current=await page.evaluate(()=>{if(document.querySelector('#an-body')?.dataset.scene!=='organizing')return null;
      const grab=document.querySelector('.an-grab.open');if(!grab)return null;
      const main=grab.querySelector('.an-grab-photo img:not(.under)');
      return {photo:Number(main?.getAttribute('src').match(/\/(\d+)\.jpg/)[1]),text:grab.querySelector('.an-grab-chrome').textContent,
        takes:[...grab.querySelectorAll('.pile-take')].map(i=>Number(i.getAttribute('src').match(/\/(\d+)\.jpg/)[1]))};});
    if(current&&/\btakes\b/.test(current.text)) {
      organizing.push(current);
      if(!shot){await page.waitForTimeout(550);
        const readable=await page.evaluate(()=>{const grab=document.querySelector('.an-grab.open');if(!grab)return false;
          const caption=grab.querySelector('.an-grab-chrome').getBoundingClientRect();
          return [...grab.querySelectorAll('.pile-take')].every(i=>i.getBoundingClientRect().bottom<caption.top);});
        assert(readable,'The real stack must leave its caption readable');
        await page.screenshot({path:OUT+'/D-sample-organizing.png'});shot=true;}
    }
    await page.waitForTimeout(100);
  }
  await page.waitForSelector('#an-go');
  const stacks=await page.evaluate(()=>S.lib.progress.org.stacks.stacks.map(s=>s.length>8?s.slice(0,8):s));
  assert(stacks.length&&organizing.length,'The sample shows its real stack being formed');
  for(const shown of organizing){const stack=stacks.find(s=>s[0]===shown.photo);
    assert(stack,`Organizing spotlight must show a stack cover, got ${JSON.stringify(shown)}`);
    assert(shown.takes.length>0,'The spotlight shows the actual takes behind the cover');
    assert(shown.takes.every(id=>id!==shown.photo&&stack.includes(id)));}
  await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading);await page.waitForTimeout(800);
  const state=await page.evaluate(async()=>({sample:await api('/api/sample'),journey:await api('/api/journey')}));
  assert.equal(state.sample.state,'done');assert.equal(state.sample.total,13);assert.equal(await page.evaluate(()=>World.total),13);
  assert(state.journey.progress.shots>=4,'The sample must leave enough shots for a bracket');
  await page.goto(BASE+'/#stacks');await page.waitForSelector('.tile.stacked');await page.waitForTimeout(700);
  assert(await page.locator('.tile.stacked .pile-take').count()>0);
  await page.screenshot({path:OUT+'/D-sample-stacks.png'});
  await page.goto(BASE+'/#finals');await page.waitForSelector('#journey-next.ready');await page.click('#journey-next');
  for(let k=0;k<8;k++){
    await page.waitForTimeout(700);if(await page.locator('#journey-next.ready[href="#reveal"]').isVisible())break;
    await page.click('[data-f=a]');
  }
  await page.waitForSelector('#journey-next.ready[href="#reveal"]');
  await page.click('#journey-next');await page.waitForSelector('.podium');await page.waitForTimeout(1200);
  await page.screenshot({path:OUT+'/D-sample-champion.png'});
  assert.deepEqual(external,[]);assert.deepEqual(problems,[]);
  console.log(JSON.stringify({photos:13,shots:state.journey.progress.shots,organizing,stack:true,champion:true,external,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
