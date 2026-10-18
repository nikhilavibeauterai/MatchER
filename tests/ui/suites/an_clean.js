// Analysis is the world, real work and a status line. Its tag row stays put as focus controls appear.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);
  await page.evaluate(()=>{
    const set=VennSea.prototype.setVenn;
    VennSea.prototype.setVenn=function(...args){if(this.el.id==='an-sea')window.cleanAnalysisSea=this;return set.apply(this,args);};
    window.restoreCleanSea=()=>{VennSea.prototype.setVenn=set;};
  });
  await page.click('#use-path');
  await page.waitForSelector('#an-body');let seen=false;
  for(let k=0;k<900&&!await page.locator('#an-go').isVisible();k++){
    const state=await page.evaluate(()=>{
      const body=document.querySelector('#an-body'),field=document.querySelector('#an-sea');
      return {scene:body.dataset.scene,field:field.clientWidth,body:body.clientWidth,text:document.querySelector('#main').innerText,
        panel:!document.querySelector('#an-panel').hidden,tags:document.querySelectorAll('.vn-tags [data-tag]').length};
    });
    if(state.scene!=='reveal'){assert(!state.panel);assert(state.field>=state.body*.98);assert(!state.text.includes('How it plays'));assert(!state.text.includes('Every photo against a few hundred descriptions'));}
    if(state.tags&&!seen){await page.screenshot({path:OUT+'/C-clean-analysis.png'});seen=true;}
    await page.waitForTimeout(150);
  }
  assert(seen);await page.waitForSelector('#an-go');
  await page.waitForFunction(()=>cleanAnalysisSea?.bodies?.length>0);
  const keys=await page.evaluate(()=>cleanAnalysisSea.bodies.map(b=>b.tags.filter(t=>cleanAnalysisSea.circles.has(t))).find(tags=>tags.length>=2).slice(0,2));
  const first=page.locator(`.vn-tags [data-tag="${keys[0]}"]`),second=page.locator(`.vn-tags [data-tag="${keys[1]}"]`);
  await first.scrollIntoViewIfNeeded();const before=await first.boundingBox();await first.click();await page.waitForTimeout(450);const after=await first.boundingBox();
  assert(Math.abs(before.x-after.x)<2&&Math.abs(before.y-after.y)<2,JSON.stringify({before,after}));
  await second.click();await page.waitForTimeout(1000);
  const focus=await page.evaluate(()=>({keys:[...cleanAnalysisSea.focusKeys],any:cleanAnalysisSea.focusAny,selected:[...cleanAnalysisSea.items.values()].filter(it=>it.selected).length,
    fieldOpacity:getComputedStyle(document.querySelector('.screen-body')).opacity,primary:cleanAnalysisSea.moving.filter(it=>it.focused).length}));
  assert.equal(focus.any,false);assert.equal(focus.keys.length,2);assert.equal(focus.selected,0);assert.equal(focus.fieldOpacity,'1');assert(focus.primary>0&&focus.primary<=12);
  await page.screenshot({path:OUT+'/C-focus-analysis.png'});
  await page.click('.vn-focus [data-clear-focus]');await page.waitForTimeout(350);
  assert.equal(await page.locator('.screen-body').evaluate(e=>getComputedStyle(e).opacity),'1');
  // Native Enter on a tag focuses it instead of advancing to another stage.
  await first.focus();await page.keyboard.press('Enter');await page.waitForTimeout(250);
  assert.equal(new URL(page.url()).hash,'#analyze');assert(await first.getAttribute('aria-pressed')==='true');
  await page.click('.vn-focus [data-clear-focus]');
  await first.evaluate(e=>{const hidden=document.createElement('button');hidden.hidden=true;hidden.id='hidden-group-check';e.after(hidden);});
  await first.focus();await page.keyboard.press('ArrowRight');
  assert(await first.evaluate(e=>document.activeElement!==e&&!document.activeElement.closest('[hidden]')),'Arrow keys skip groups with no members');
  await page.evaluate(()=>document.querySelector('#hidden-group-check').remove());
  await page.evaluate(()=>restoreCleanSea());
  await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.sea.bodies?.length>0);
  // Replay recognitions over an actual public preview. A long raw classifier vector must never become a scrolling readout.
  const state=await page.evaluate(()=>api('/api/state'));
  const id=await page.evaluate(()=>World.photos.values().next().value.id);
  const themes=[['🐶','Dogs',.95,'dogs'],['🏖️','Beaches',.92,'beach'],['🎞️','Black & white',.9,'bw'],
    ['🌃','City at night',.89,'night_city'],['👪','Family',.87,'family'],['🌳','Outdoors',.85,'outdoors'],['🙂','Portrait',.83,'portrait']];
  const attrs=['blurry','filter','smoking','mirror_selfie','car','bathroom_bed','nightlife','outdoors','screenshot','no_person','great','dog','group','document','accidental','aesthetic'].map((key,i)=>[key,i%3*.01]);
  let phase='understanding',uncertain=false;
  await page.route('**/api/state',r=>r.fulfill({json:{...state,library:{...state.library,analyzed:false,analyzing:true,progress:{phase,done:1,total:2}}}}));
  await page.route('**/api/analysis/feed?*',r=>{
    const q=new URL(r.request().url()).searchParams,feed={read:[[id,[[.1,.2,.2,.2]],1,1]],cats:[[id,uncertain?'':'animals',uncertain?[]:themes,attrs]],seen:uncertain?[]:[[id,[0,0,1,1],themes]],identity:[],org:[]};
    const body={};for(const [key,rows] of Object.entries(feed)){body[key]=rows.slice(Number(q.get(key)||0));body[`${key}_n`]=rows.length;}
    return r.fulfill({json:body});
  });
  const spotlights=[];
  for(const [width,height,step,abstained=false] of [[1440,900,'understanding'],[375,812,'understanding'],[375,812,'details'],[375,812,'reading'],[375,812,'understanding',true]]){
    phase=step;uncertain=abstained;await page.setViewportSize({width,height});
    await page.evaluate(async()=>{await loadState();history.replaceState(null,'','#analyze');route();});
    await page.waitForSelector('.an-grab.open .an-grab-findings');
    await page.waitForTimeout(850);
    const result=await page.evaluate(()=>{
      const chrome=document.querySelector('.an-grab.open .an-grab-chrome'),b=chrome.getBoundingClientRect(),field=document.querySelector('#an-sea').getBoundingClientRect();
      return {text:chrome.textContent,labels:[...chrome.querySelectorAll('.tag-chip')].map(e=>e.textContent.trim()),width:b.width,height:b.height,
        inside:b.left>=field.left&&b.right<=field.right&&b.top>=field.top&&b.bottom<=field.bottom,
        scrolls:[chrome,...chrome.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+1||e.scrollWidth>e.clientWidth+1).map(e=>e.className),
        tags:[...document.querySelectorAll('.analyzing .vn-tags [data-tag]')].map(e=>e.dataset.tag)};
    });
    await page.screenshot({path:`${OUT}/C-findings-${step}-${width}${abstained?'-uncertain':''}.png`});
    assert.equal(result.labels.length,abstained?0:step==='reading'?3:5);assert.equal(new Set(result.labels).size,result.labels.length);
    assert(!result.text.includes('%'));assert(!result.text.includes('blurry'));assert(result.width>=Math.min(300,width*.7),JSON.stringify(result));assert(result.height<180,JSON.stringify(result));assert(result.inside,JSON.stringify(result));assert.deepEqual(result.scrolls,[]);
    if(abstained){assert(result.text.includes('Scene scan complete'));assert(!result.text.includes('recognized'));assert(!result.tags.some(key=>key.startsWith('kind:')));}
    else assert.equal(result.labels[0],step==='understanding'?'🐾 Animals':step==='reading'?'🙂 1 face':'🐶 Dogs');
    if(step==='reading')assert(result.labels.includes('😑 1 blink')&&!result.text.includes('blinking'));
    if(!abstained)for(const [,,,key] of themes)assert(result.tags.includes(key),`Discovery ${key} remains in the shelf`);
    spotlights.push({width,phase:step,abstained,...result});
  }
  assert.deepEqual(problems,[]);
  console.log(JSON.stringify({keys,focus,spotlights,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
