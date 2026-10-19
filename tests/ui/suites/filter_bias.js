// The Filter line displays real fitness, and teaching moves a cohort before anything is applied.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
let page;const problems=[],result={};
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>problems.push(e.message));
  const api=(path,body)=>page.evaluate(([path,body])=>api(path,body),[path,body]);
  const press=async key=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);};
  const idle=()=>page.waitForFunction(()=>!!document.querySelector('#filter-threshold')&&!document.querySelector('.filter-thinking')&&!document.querySelector('.filter-review[aria-busy="true"]'));
  const ready=async()=>{await idle();await page.waitForSelector('.filter-shot');};
  const hasDraft=()=>page.evaluate(()=>!!sessionStorage.getItem(`matcher-filter-draft:${S.lib.source}`));
  const photo=async()=>Number(await page.locator('.filter-shot').getAttribute('data-photo'));
  const menuAction=async id=>{await page.click('#open-menu');await page.locator(`#menu #${id}`).click();};
  const nextPreview=()=>page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/preview'&&r.request().method()==='POST');
  const save=async name=>{await page.waitForFunction(()=>!World.flights?.size);await page.screenshot({path:`${OUT}/${name}.png`});};
  const shownScores=()=>page.evaluate(()=>World.sea.outcomeFlow?.scores);
  const verifyScores=async data=>{
    assert.equal(Object.keys(data.scores).length,data.counts.total);
    assert(Object.values(data.scores).every(v=>Number.isFinite(v)&&v>=0&&v<=1));
    for(const row of data.photos)assert.equal(row.fit,data.scores[row.id]);
    assert.deepEqual(await shownScores(),data.scores,'The sea receives the same scores as the Filter catalogue');
  };
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const imported=await api('/api/filter?per=200'),candidates=imported.photos.filter(p=>p.playable&&!p.override&&p.disposition==='keep');
  assert(candidates.length>=6,'The public fixture needs six readable, admitted takes');
  const [source,similarA,similarB,dogOnly,kept,tossed]=candidates.slice(0,6).map(p=>p.id),cohort=[source,similarA,similarB];
  // Give public fixture takes a known conjunction through the same editable tag API used by players.
  const subjects=imported.tags.filter(t=>['what','people'].includes(t.family)).map(t=>t.key);
  const place=subjects.includes('beach')?'beach':'water';assert(subjects.includes('dogs')&&subjects.includes(place));
  await api('/api/tags/set',{photos:[...cohort,dogOnly],on:[],off:subjects});
  await api('/api/tags/set',{photos:cohort,on:['dogs',place],off:[]});
  await api('/api/tags/set',{photos:[dogOnly],on:['dogs'],off:[]});
  await api('/api/filter/decision',{photos:[kept],action:'keep'});
  await api('/api/filter/decision',{photos:[tossed],action:'aside'});
  const baseline=await api('/api/filter?per=200');assert.equal(baseline.policy.fit_threshold,.5);assert.deepEqual(baseline.policy.fit_examples,[]);
  assert.equal(baseline.scores[kept],1);assert.equal(baseline.scores[tossed],0);
  await page.evaluate(()=>location.hash='#filter');await ready();
  await menuAction('filter-catalogue');await page.waitForSelector(`[data-review-photo="${source}"]`);await page.click(`[data-review-photo="${source}"]`);await ready();
  assert.equal(await photo(),source);await verifyScores(baseline);assert.equal(await page.locator('.filter-round-progress,.filter-round-done').count(),0);
  const learned=[];
  for(const [key,direction,sign] of [['ArrowUp','toward',1],['ArrowDown','away',-1]]){
    const response=nextPreview(),tune=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/tune');
    await press(key);const call=await(await tune).json(),preview=await(await response).json();await ready();
    assert.notEqual(await photo(),source,'Love and Hate decide the take: the next one comes to the table');
    assert(call.learning.ready);assert(call.learning.changes.some(c=>c.key==='fit_examples'));
    assert(preview.policy.fit_examples.some(e=>e.photo===source&&e.direction===direction));
    assert.equal(preview.scores[source],direction==='toward'?1:0);
    assert.equal((await api(`/api/filter?photo=${source}`)).photos[0].override,direction==='toward'?'keep':'toss');
    for(const id of [similarA,similarB])assert(sign*(preview.scores[id]-baseline.scores[id])>.01,`${direction} must move comparable take ${id}`);
    assert.equal(preview.scores[dogOnly],baseline.scores[dogOnly],'A dog without the place tag is outside this conjunction');
    assert.equal(preview.scores[kept],1);assert.equal(preview.scores[tossed],0);await verifyScores(preview);
    assert.deepEqual((await api('/api/filter?per=200')).policy,baseline.policy,'Teaching is still a preview');
    learned.push({direction,cohort:cohort.map(id=>({id,before:baseline.scores[id],after:preview.scores[id]})),changed:preview.counts.changed});
    await save(`FB-${direction}-desktop`);await press('z');
    await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
    assert.equal(await photo(),source);assert.deepEqual(await shownScores(),baseline.scores);
    assert.equal((await api(`/api/filter?photo=${source}`)).photos[0].override,baseline.photos.find(p=>p.id===source).override);
    assert.equal(await hasDraft(),false);
  }

  // Keep/Toss commits only this take and advances play; teaching a cohort belongs to Up/Down.
  const decisions=[];
  for(const [key,action] of [['ArrowRight','keep'],['ArrowLeft','aside']]){
    const decision=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/decision');
    await press(key);assert.equal((await decision).status(),200);await ready();
    assert.notEqual(await photo(),source);
    const saved=await api('/api/filter?per=200');assert.equal(saved.photos.find(p=>p.id===source).override,action==='keep'?'keep':'toss');
    assert.equal(saved.scores[source],action==='keep'?1:0);assert.deepEqual(saved.policy,baseline.policy);
    for(const id of [similarA,similarB,dogOnly]){assert.equal(saved.photos.find(p=>p.id===id).cut,baseline.photos.find(p=>p.id===id).cut);assert.equal(saved.scores[id],baseline.scores[id],`${action} does not teach from an individual exception`);}
    assert.equal(await hasDraft(),false);await verifyScores(saved);
    decisions.push({action,source:saved.scores[source],cohort:[similarA,similarB].map(id=>({id,score:saved.scores[id]}))});
    await press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
    assert.equal(await photo(),source);assert.deepEqual(await shownScores(),baseline.scores);
    assert.equal((await api(`/api/filter?photo=${source}`)).photos[0].override,baseline.photos.find(p=>p.id===source).override);
  }

  let calls=0,undos=0;const count=request=>{const path=new URL(request.url()).pathname;if(['/api/filter/decision','/api/filter/tune'].includes(path))calls++;if(path==='/api/draw/undo')undos++;};page.on('request',count);
  const slider=page.locator('#filter-threshold');assert.equal(await slider.getAttribute('type'),'range');
  assert.equal(Number(await slider.getAttribute('min')),0);assert.equal(Number(await slider.getAttribute('max')),1);assert.equal(Number(await slider.getAttribute('step')),.01);
  let response=nextPreview();await slider.focus();await slider.press('ArrowRight');let preview=await(await response).json();await idle();
  assert(Math.abs(preview.policy.fit_threshold-.51)<.001);assert.equal(await photo(),source);
  assert.equal(calls,0,'Native range arrows must never cast a take decision');
  response=nextPreview();await press('z');await response;await idle();assert.equal(Number(await slider.inputValue()),.5);assert.equal(undos,0,'Undoing a draft line movement does not undo saved calls');
  await page.waitForSelector('#history-hud [data-history=undo] img');
  assert.equal(await page.locator('#history-hud [data-history=redo]').count(),1,'Local line undo retains both the older saved decision and the line redo');
  assert.equal(await hasDraft(),false);
  response=nextPreview();await slider.focus();await slider.press('End');preview=await(await response).json();await idle();
  assert.equal(preview.policy.fit_threshold,1);assert(preview.counts.changed>0);assert(preview.ids.kept.includes(kept));assert(preview.ids.aside.includes(tossed));
  assert.deepEqual(preview.scores,baseline.scores,'The line changes admission, not the measured scores');
  assert.deepEqual((await api('/api/filter?per=200')).policy,baseline.policy);assert.equal(calls,0);
  response=nextPreview();await press('z');await response;await idle();assert.equal(Number(await slider.inputValue()),.5);

  // Drag the actual divider using a visible hit point in the sea, not synthetic input events.
  await menuAction('filter-sea');await page.waitForSelector('.filter-content.sea');
  const drag=await page.evaluate(()=>{
    const line=document.querySelector('#filter-line'),r=line.getBoundingClientRect(),sea=World.sea,w=sea.el.getBoundingClientRect(),x=r.x+r.width/2;
    const y=[.2,.35,.5,.65,.8].map(t=>r.top+r.height*t).find(y=>line.contains(document.elementFromPoint(x,y)));
    return {x,y,target:w.left+sea.outcomeX(.9),lineX:x,expected:w.left+sea.outcomeX(.5),width:w.width};
  });
  assert(Number.isFinite(drag.y),'The Filter line has a reachable drag target');assert(Math.abs(drag.lineX-drag.expected)<=2,'The line and the worker share the score axis');
  response=nextPreview();await page.mouse.move(drag.x,drag.y);await page.mouse.down();await page.mouse.move(drag.target,drag.y,{steps:8});await page.mouse.up();
  preview=await(await response).json();await idle();assert(Math.abs(preview.policy.fit_threshold-.9)<=.01);assert(preview.counts.changed>0);
  await verifyScores(preview);assert.deepEqual((await api('/api/filter?per=200')).policy,baseline.policy);
  assert.equal(calls,0);page.off('request',count);await save('FB-threshold-sea-desktop');
  const line=await page.evaluate(()=>{const r=document.querySelector('#filter-line').getBoundingClientRect(),w=World.sea.el.getBoundingClientRect();return {x:r.left+r.width/2,expected:w.left+World.sea.outcomeX(Number(document.querySelector('#filter-threshold').value))};});
  assert(Math.abs(line.x-line.expected)<=2);

  await page.click('#journey-next');await page.waitForSelector('.stacker');
  await page.evaluate(()=>location.hash='#filter?view=sea');await idle();
  const applied=await api('/api/filter?per=200');assert.equal(applied.policy.fit_threshold,preview.policy.fit_threshold);assert.deepEqual(applied.ids.aside,preview.ids.aside);
  assert.equal(await hasDraft(),false);assert.equal((await api(`/api/filter?photo=${kept}`)).photos[0].override,'keep');
  await press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await idle();
  assert.deepEqual((await api('/api/filter?per=200')).policy,baseline.policy);assert.deepEqual(await shownScores(),baseline.scores);
  await menuAction('filter-catalogue');await page.waitForSelector(`[data-review-photo="${source}"]`);await page.click(`[data-review-photo="${source}"]`);await ready();assert.equal(await photo(),source);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await save('FB-threshold-phone');
  assert(await slider.isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));

  // A pointer adjustment releases arrow keys back to the photo; Tab focus still supports range keys above.
  const pointer=await page.evaluate(()=>{const r=document.querySelector('#filter-threshold').getBoundingClientRect(),w=World.sea.el.getBoundingClientRect();return {x:w.left+World.sea.outcomeX(.5),y:r.top+r.height/2,to:w.left+World.sea.outcomeX(.6)};});
  response=nextPreview();await page.mouse.move(pointer.x,pointer.y);await page.mouse.down();await page.mouse.move(pointer.to,pointer.y,{steps:8});await page.mouse.up();
  const pointerPreview=await(await response).json();await ready();assert(Math.abs(pointerPreview.policy.fit_threshold-.6)<=.01,`Phone thumb expected .60, got ${pointerPreview.policy.fit_threshold}`);
  assert(await page.evaluate(()=>!['filter-threshold','filter-line'].includes(document.activeElement?.id)),'Pointer release gives the game its arrows back');
  const picked=await photo(),keepReply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/decision');
  await page.keyboard.press('ArrowRight');assert.equal((await keepReply).status(),200);await ready();assert.notEqual(await photo(),picked);
  assert.equal((await api(`/api/filter?photo=${picked}`)).photos[0].override,'keep');
  await press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();assert.equal(await photo(),picked);
  let enterCalls=0;const countEnter=request=>{if(['/api/filter/decision','/api/filter/tune'].includes(new URL(request.url()).pathname))enterCalls++;};page.on('request',countEnter);
  await page.locator('[data-decision=keep]').focus();await page.keyboard.press('Enter');await page.waitForSelector('.stacker');
  assert.equal(enterCalls,0,'Enter leaves Filter even when a D-pad choice has focus');page.off('request',countEnter);
  assert.equal((await api('/api/filter?per=200')).policy.fit_threshold,pointerPreview.policy.fit_threshold,'Enter applies the confirmed preview before moving on');
  await page.waitForFunction(()=>World.sea.outcomeFlow===null);
  assert.equal(await page.locator('#filter-threshold,#filter-line').count(),0);
  result.cohort={source,similarA,similarB,dogOnly,tags:['dogs',place]};result.learned=learned;result.decisions=decisions;result.threshold={preview:preview.policy.fit_threshold,changed:preview.counts.changed,drag,line};
  assert.deepEqual(problems,[]);console.log(JSON.stringify({...result,problems},null,1));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page){console.error(JSON.stringify({route:new URL(page.url()).hash,problems}));await page.screenshot({path:OUT+'/FB-failure.png'}).catch(()=>{});}process.exit(1);});
