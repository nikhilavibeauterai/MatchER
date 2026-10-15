// Repeat the public sample after a real mixed history, not just an empty teaching model.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,OUT}=process.env;
let page;const problems=[],result={};
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>problems.push(e.message));
  const api=(path,body)=>page.evaluate(([path,body])=>api(path,body),[path,body]);
  const ready=()=>page.waitForFunction(()=>!!document.querySelector('.filter-shot')&&!document.querySelector('.filter-thinking')&&!document.querySelector('.filter-review[aria-busy="true"]')&&!World.flights?.size);
  const press=async key=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);};
  const open=async id=>{await page.click('#open-menu');await page.click('#filter-catalogue');await page.waitForSelector(`[data-review-photo="${id}"]`);await page.click(`[data-review-photo="${id}"]`);await ready();assert.equal(Number(await page.locator('.filter-shot').getAttribute('data-photo')),id);};
  const state=()=>page.evaluate(()=>({focused:Number(document.querySelector('.filter-shot')?.dataset.photo),line:World.sea.outcomeX(World.sea.outcomeFlow.threshold),scores:World.sea.outcomeFlow.scores,
    draft:JSON.parse(sessionStorage.getItem(`matcher-filter-draft:${S.lib.source}`)||'null'),lifted:[...World.lifted],
    photos:[...World.sea.items.values()].map(it=>({id:it.id,src:it.el.querySelector('img')?.getAttribute('src'),x:it.x,y:it.y,take:it.take,pileLifted:it.pileLifted,opacity:getComputedStyle(it.el).opacity}))}));
  await page.goto(LINK);await page.click('#sample');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===13&&!World.loading);
  const initial=await api('/api/filter?per=200'),source=initial.photos.find(p=>p.rel==='ducreux-mocking.jpg'),copies=initial.photos.filter(p=>p.rel.startsWith('burst/')).sort((a,b)=>a.id-b.id);
  assert(source&&copies.length===4);result.source=source.id;result.copies=copies.map(p=>p.id);result.calls=[];
  await page.evaluate(()=>location.hash='#filter');await ready();
  // Alternating calls leave two portrait copies on each side and seven of the thirteen takes out.
  for(const row of [...initial.photos].sort((a,b)=>a.id-b.id)){
    await open(row.id);const key=row.id%2?'ArrowLeft':'ArrowRight',response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/decision');
    await press(key);assert.equal((await response).status(),200);await ready();
  }
  result.manual=await state();
  const family=[source.id,...copies.map(p=>p.id)],unrelated=initial.photos.filter(p=>!family.includes(p.id));
  for(const [id,key,name] of [[copies[0].id,'ArrowDown','older-less'],[copies[1].id,'ArrowUp','older-more'],
    [source.id,'click-away','new-less'],[source.id,'click-toward','new-more'],[source.id,'ArrowUp','repeat-more'],
    [copies[3].id,'click-away','burst-less'],[copies[0].id,'ArrowUp','burst-more'],
    [copies[3].id,'ArrowDown','before-reload-less'],[source.id,'click-toward','reloaded-more']]){
    if(name==='reloaded-more'){await page.reload();await ready();}
    if(Number(await page.locator('.filter-shot').getAttribute('data-photo'))!==id)await open(id);
    const before=await state(),tune=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/tune'),preview=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/preview'&&r.request().method()==='POST');
    if(key.startsWith('click-'))await page.click(`[data-tune="${key.slice(6)}"]`);else await press(key);
    const call=await(await tune).json(),proposal=await(await preview).json();await ready();await page.mouse.move(10,10);
    const side=key==='ArrowUp'||key==='click-toward'?1:-1,started=Date.now(),travel=[];
    if(!name.startsWith('older-')){
      assert(family.every(pid=>side===1?proposal.scores[pid]>.8:proposal.scores[pid]<.3),`The latest ${name} lesson should move the full actual copy family: ${JSON.stringify(proposal.scores)}`);
      assert(unrelated.every(p=>proposal.scores[p.id]===result.manual.scores[p.id]),'Copy correction must not move unrelated art or portraits');
      while(Date.now()-started<12000){
        const s=await state(),members=s.photos.filter(p=>family.includes(p.id)&&p.id!==id);
        travel.push({ms:Date.now()-started,photos:members.map(p=>({id:p.id,x:p.x,opacity:p.opacity,crossed:(p.x-s.line)*side>20&&!p.pileLifted&&p.opacity==='1'}))});
        if(travel.at(-1).photos.every(p=>p.crossed))break;await page.waitForTimeout(250);
      }
      assert(travel.at(-1).photos.every(p=>p.crossed),`Actual photos must follow ${name}: ${JSON.stringify(travel)}`);
    }
    const after=await state();result.calls.push({name,id,edited:call.edited,protected:after.draft?.protected,examples:proposal.policy.fit_examples,
      travel:travel.filter((_,i)=>[0,2,4,travel.length-1].includes(i)),settleMs:Date.now()-started,
      sourceHidden:after.photos.find(p=>p.id===id)?.opacity==='0',scoreDeltas:family.map(pid=>({id:pid,before:before.scores[pid],after:proposal.scores[pid]}))});
    assert.deepEqual(after.scores,proposal.scores,'The sea shows the actual returned preview');
    await page.screenshot({path:`${OUT}/FM-${name}.png`});
  }
  const saved=await api('/api/filter?per=200');result.saved={scores:saved.scores,counts:saved.counts};result.manual={scores:result.manual.scores};result.problems=problems;
  assert.deepEqual(problems,[]);console.log(JSON.stringify(result,null,1));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);console.error(JSON.stringify({...result,problems}));if(page)await page.screenshot({path:OUT+'/FM-failure.png'}).catch(()=>{});process.exit(1);});
