// The offline sample's real portrait crops teach together even when recognition supplies different tags.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,OUT}=process.env;
let page;const problems=[],result={};
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>problems.push(e.message));
  const api=(path,body)=>page.evaluate(([path,body])=>api(path,body),[path,body]);
  const ready=()=>page.waitForFunction(()=>!!document.querySelector('.filter-shot')&&!document.querySelector('.filter-thinking')&&!document.querySelector('.filter-review[aria-busy="true"]'));
  await page.goto(LINK);await page.click('#sample');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===13&&!World.loading);
  const initial=await api('/api/filter?per=200'),source=initial.photos.find(p=>p.rel==='ducreux-mocking.jpg'),copies=initial.photos.filter(p=>p.rel.startsWith('burst/'));
  assert(source);assert.equal(copies.length,4);
  result.photos=await page.evaluate(()=>[...World.photos.values()].map(p=>({id:p.id,tags:p.tags})));
  result.source=source.id;result.copies=copies.map(p=>p.id);result.moves=[];
  const seaState=()=>page.evaluate(()=>({width:World.sea.width,held:World.sea.held,lifted:[...World.lifted],items:[...World.sea.items.values()].map(it=>({id:it.id,x:it.x,y:it.y,size:it.size,stack:it.stack,take:it.take,lifted:it.lifted,pileLifted:it.pileLifted,connected:it.el.isConnected,classes:it.el.className,opacity:getComputedStyle(it.el).opacity,rect:it.el.getBoundingClientRect().toJSON()}))}));
  await page.evaluate(()=>location.hash='#filter');await ready();
  await page.click('#open-menu');await page.click('#filter-catalogue');await page.waitForSelector(`[data-review-photo="${source.id}"]`);await page.click(`[data-review-photo="${source.id}"]`);await ready();
  await page.waitForTimeout(1800);result.initialSea=await seaState();
  for(const [key,direction,sign] of [['ArrowUp','toward',1],['ArrowDown','away',-1]]){
    const previewReply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/preview'&&r.request().method()==='POST');
    await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);const preview=await(await previewReply).json();await ready();
    assert.equal(preview.scores[source.id],sign===1?1:0,'More keeps its source and Less sets it aside');
    const rows=initial.photos.map(p=>({id:p.id,rel:p.rel,before:initial.scores[p.id],after:preview.scores[p.id],delta:preview.scores[p.id]-initial.scores[p.id]}));
    result.moves.push({direction,rows});
    await page.waitForTimeout(1000);result.moves.at(-1).sea=await seaState();await page.screenshot({path:`${OUT}/FS-${direction}.png`});
    assert(copies.every(p=>sign*(preview.scores[p.id]-initial.scores[p.id])>.05),`${direction} should move every real near-copy, not only the source: ${JSON.stringify(result)}`);
    const unrelated=rows.filter(p=>p.id!==source.id&&!copies.some(copy=>copy.id===p.id));
    assert(unrelated.filter(p=>Math.abs(p.delta)>.05).length<unrelated.length/2,'A portrait example must not move every unrelated painting or face');
    await page.keyboard.press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
    assert.deepEqual((await api('/api/filter?per=200')).scores,initial.scores);
  }
  result.flights=[];
  for(const [key,action,side] of [['ArrowRight','keep',1],['ArrowLeft','aside',-1]]){
    await page.waitForFunction(()=>!World.flights?.size);await page.mouse.move(10,10);
    await page.evaluate(id=>{
      window.filterFlightFrames=[];window.filterFlightTracking=true;
      const sample=()=>{const f=World.flights?.get(id);if(f?.kind==='sink'){const target=f.measure();filterFlightFrames.push({x:f.rect.left+f.rect.width/2,target:target.left+target.width/2});}if(filterFlightTracking)requestAnimationFrame(sample);};requestAnimationFrame(sample);
    },source.id);
    const origin=await page.locator('.filter-print img').boundingBox();await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);await ready();
    await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)!==id,source.id);await page.waitForFunction(()=>!World.flights?.size);
    const flight=await page.evaluate(id=>{window.filterFlightTracking=false;const sea=World.sea,it=sea.items.get(id);return {frames:filterFlightFrames,width:sea.width,x:it.x,visible:!it.el.classList.contains('lifted')};},source.id);
    result.flights.push({action,...flight});
    assert(flight.frames.length>=3,'Capture the visible return flight rather than only its API result');
    assert(flight.frames.every(f=>(f.target-(origin.x+origin.width/2))*side>100),`${action} must fly directly toward its outcome bank`);
    assert((flight.frames.at(-1).x-flight.frames[0].x)*side>100,`${action} must visibly travel in the chosen direction`);
    assert((flight.x-flight.width/2)*side>flight.width*.2&&flight.visible,'The arriving sea copy stays on the correct side');
    await page.screenshot({path:`${OUT}/FS-${action}-released.png`});
    await page.keyboard.press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
    assert.equal(Number(await page.locator('.filter-shot').getAttribute('data-photo')),source.id);
  }
  // New explicit teaching can revisit earlier calls; the player sees that proposal before Apply.
  await api('/api/filter/decision',{photos:copies.map(p=>p.id),action:'aside'});
  await page.evaluate(()=>location.hash='#filter?previous-calls');await ready();
  await page.click('#open-menu');await page.click('#filter-catalogue');await page.waitForSelector(`[data-review-photo="${source.id}"]`);await page.click(`[data-review-photo="${source.id}"]`);await ready();
  const taughtReply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/preview'&&r.request().method()==='POST');
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('ArrowUp');const proposal=await(await taughtReply).json();await ready();
  assert(copies.every(p=>proposal.scores[p.id]>initial.scores[p.id]+.05),'New More previews a change for the older set-aside variants');
  const savedBeforeApply=await api('/api/filter?per=200');assert(copies.every(p=>savedBeforeApply.scores[p.id]===0),'Teaching alone does not commit those rescues');
  await page.waitForTimeout(1000);await page.screenshot({path:`${OUT}/FS-revisit-earlier-calls.png`});
  await api('/api/filter/apply',{token:proposal.token});
  assert.deepEqual((await api('/api/filter?per=200')).scores,proposal.scores,'Apply commits the shown result');
  await api('/api/draw/undo',{});
  const undone=await api('/api/filter?per=200');assert(copies.every(p=>undone.scores[p.id]===0),'Undo restores the individual calls');
  // A new individual decision is an intentional exception to teaching that already exists.
  const pinned=copies[0].id;await api('/api/filter/decision',{photos:[pinned],action:'aside'});
  const afterException=await api('/api/filter/preview',{policy:proposal.policy,per:200});
  assert.equal(afterException.scores[pinned],0);assert(copies.slice(1).every(p=>afterException.scores[p.id]>.8));
  const threshold=await api('/api/filter/preview',{policy:{...proposal.policy,fit_threshold:0},per:200});
  assert.equal(threshold.scores[pinned],0);assert(threshold.ids.aside.includes(pinned),'The cutoff cannot undo a newer individual exception');
  result.manualExceptions=copies.map(p=>({id:p.id,before:savedBeforeApply.scores[p.id],proposal:proposal.scores[p.id],afterNewException:afterException.scores[p.id]}));
  assert.deepEqual(problems,[]);console.log(JSON.stringify({...result,problems},null,1));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);console.error(JSON.stringify({...result,problems}));if(page)await page.screenshot({path:OUT+'/FS-failure.png'}).catch(()=>{});process.exit(1);});
