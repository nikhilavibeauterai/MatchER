// Directional calls decide this take and teach its cohort; wider effects remain an undoable preview.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
let page;const problems=[],result={};
(async()=>{
  const browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>problems.push(e.message));
  const api=(path,body)=>page.evaluate(([path,body])=>api(path,body),[path,body]);
  const hasDraft=()=>page.evaluate(()=>!!sessionStorage.getItem(`matcher-filter-draft:${S.lib.source}`));
  const previewReady=()=>page.waitForFunction(()=>document.querySelector('.filter-stage')?.dataset.preview==='true'&&!document.querySelector('.filter-thinking'));
  const photo=async()=>Number(await page.locator('.filter-shot').getAttribute('data-photo'));
  const ready=()=>page.waitForFunction(()=>!!document.querySelector('.filter-shot')&&!document.querySelector('.filter-thinking')&&!document.querySelector('.filter-review[aria-busy="true"]'));
  const press=async key=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);};
  const advanced=id=>page.waitForFunction(old=>!!document.querySelector('.filter-shot')&&Number(document.querySelector('.filter-shot').dataset.photo)!==old,id);
  const menuAction=async id=>{await page.click('#open-menu');await page.locator(`#menu #${id}`).click();};
  const controls=()=>page.locator('.filter-review-controls button').evaluateAll(buttons=>buttons.map(b=>{
    const r=b.getBoundingClientRect();return {key:b.dataset.tune||b.dataset.decision||'skip',x:r.x,y:r.y,w:r.width,h:r.height};
  }));
  const steady=(before,after,why)=>{
    assert.deepEqual(after.map(b=>b.key),before.map(b=>b.key));
    for(let i=0;i<before.length;i++)for(const key of ['x','y','w','h'])
      assert(Math.abs(before[i][key]-after[i][key])<=1,`${why}: ${before[i].key}.${key} moved`);
  };
  const flow=async expected=>{
    const actual=await page.evaluate(()=>World.sea.outcomeFlow);assert(actual);
    for(const key of ['aside','kept'])assert.deepEqual([...actual[key]].sort((a,b)=>a-b),[...expected[key]].sort((a,b)=>a-b));
  };
  const shotSave=async name=>{await page.waitForFunction(()=>!World.flights?.size);await page.screenshot({path:`${OUT}/${name}.png`});};
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  // New static controls must not teach through an older in-memory backend after a browser-only reload.
  const summaryURL=url=>url.pathname==='/api/filter'&&!url.searchParams.has('photo');
  const oldEngine=async route=>{const response=await route.fetch(),data=await response.json();delete data.teaching_revision;await route.fulfill({response,json:data});};
  let incompatibleCalls=0;const countIncompatible=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/filter/'))incompatibleCalls++;};
  page.on('request',countIncompatible);await page.route(summaryURL,oldEngine);
  await page.evaluate(()=>location.hash='#filter');await page.waitForSelector('#main .empty.error');
  assert.equal(await page.locator('#main .empty.error').textContent(),'Restart MatchER, then reload this page to update the filter. Your saved choices are kept.');
  assert.equal(await page.locator('[data-tune],.filter-review-controls').count(),0);
  assert.equal(await page.locator('#game-help-hint').isVisible(),false);
  const recoveryStyle=await page.locator('.filter-update > span').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
  assert.notEqual(recoveryStyle.background,'rgba(0, 0, 0, 0)');assert.notEqual(recoveryStyle.color,'rgba(0, 0, 0, 0)');
  for(const key of ['ArrowUp','w','ArrowDown','s','ArrowRight','Enter'])await press(key);
  assert.equal(incompatibleCalls,0);page.off('request',countIncompatible);await shotSave('FT-restart-required');
  await page.unroute(summaryURL,oldEngine);await page.reload();await ready();
  assert.equal(await page.locator('#main .empty.error').count(),0);assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('filter-update-required')),false);result.compatibility={blockedCalls:incompatibleCalls,reloaded:true};
  assert.equal(await page.locator('#filter-kit,[data-rule],#filter-reasons').count(),0,'Teaching has no tuning panel or reason form');
  const first=await photo(),initial=await api('/api/filter?per=200');
  assert.equal(await page.locator('.filter-round-progress,.filter-round-done').count(),0);await flow(initial.ids);
  const desktop=await controls();assert.equal(desktop.length,5);await shotSave('FT-teaching-desktop');

  // Teaching decides the focused take (it leaves for its side and the next one comes) and undoes both the call and its wider lesson.
  const teaching=[];
  for(const [key,direction] of [['ArrowUp','toward'],['w','toward'],['ArrowDown','away'],['s','away']]){
    const id=await photo(),before=(await api(`/api/filter?photo=${id}`)).photos[0];
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/tune');
    await press(key);const reply=await response,body=reply.request().postDataJSON(),data=await reply.json();
    assert.equal(reply.status(),200);assert.equal(body.photo,id);assert.equal(body.direction,direction);
    assert(data.learning.samples.reviewed>=1);await ready();assert.notEqual(await photo(),id,'Love and Hate decide the take and bring the next one');
    assert.equal((await api(`/api/filter?photo=${id}`)).photos[0].override,direction==='toward'?'keep':'toss');
    steady(desktop,await controls(),'Tuning keeps the controls fixed');
    await press('z');await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id&&document.querySelector('#filter-status')?.textContent==='Undone',id);await ready();
    assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.samples.reviewed,0);
    assert.equal((await api(`/api/filter?photo=${id}`)).photos[0].override,before.override);
    if(key==='ArrowUp'){
      const redo=page.locator('#history-hud [data-history=redo]');await redo.waitFor();
      assert((await redo.locator('img').getAttribute('src')).includes(`/${id}.jpg`),'Redo shows the actual take');
      const reply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/redo');await redo.click();assert.equal((await reply).status(),200);
      await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Redone');await ready();assert.notEqual(await photo(),id,'A redone Love decides the take again and brings the next one');
      assert.equal((await api(`/api/filter?photo=${id}`)).photos[0].override,'keep');
      assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.samples.reviewed,1);
      await press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
      assert.equal((await api(`/api/filter?photo=${id}`)).photos[0].override,before.override);
      assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.samples.reviewed,0);
    }
    teaching.push({key,direction,id});
  }

  // The key belongs to the in-flight choice even if the server has saved it before its response arrives.
  const quickId=await photo(),quickLearning=(await api('/api/filter/learn',{policy:initial.policy})).learning;
  let releaseTune,signalTune,quickUndos=0;
  const tuneGate=new Promise(resolve=>releaseTune=resolve),tuneCommitted=new Promise(resolve=>signalTune=resolve);
  await page.route('**/api/filter/tune',async route=>{const response=await route.fetch(),data=await response.json();signalTune(data);await tuneGate;await route.fulfill({response,json:data});},{times:1});
  const countUndo=request=>{if(new URL(request.url()).pathname==='/api/draw/undo')quickUndos++;};page.on('request',countUndo);
  const quickUndo=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/undo');
  await press('ArrowUp');assert((await tuneCommitted).edited);await press('z');await press('z');
  assert.equal(quickUndos,0,'Undo waits until the outstanding choice response is reconciled');releaseTune();
  assert.equal((await quickUndo).status(),200);
  await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id&&document.querySelector('#filter-status')?.textContent==='Undone',quickId);await ready();
  await page.waitForTimeout(100);page.off('request',countUndo);assert.equal(quickUndos,1,'Repeated Z while busy queues one undo');
  assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.revision,quickLearning.revision);
  await shotSave('FT-fast-undo-desktop');result.quickUndo={photo:quickId,requests:quickUndos};

  // A saved lesson must not look finished when its wider preview fails. Refresh repeats no choice.
  const peer=initial.photos.find(row=>row.id!==quickId&&row.playable&&!row.override)?.id;
  assert(peer,'The public fixture needs another readable take for a teaching cohort');
  const subjects=initial.tags.filter(tag=>['what','people'].includes(tag.family)).map(tag=>tag.key);
  assert(subjects.includes('dogs'));
  await api('/api/tags/set',{photos:[quickId,peer],on:[],off:subjects});
  await api('/api/tags/set',{photos:[quickId,peer],on:['dogs'],off:[]});
  const cohortBefore=await api('/api/filter?per=200'),previewFailures=[];
  let previewWrites=[];const recordWrite=request=>{if(request.method()==='POST')previewWrites.push(new URL(request.url()).pathname);};
  page.on('request',recordWrite);
  for(const status of [503,409]){
    previewWrites=[];let failures=0;
    await page.route('**/api/filter/preview',route=>{failures++;return route.fulfill({status,json:{error:`Fixture preview failure ${status}`}});},{times:1});
    const tune=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/filter/tune');
    await press('ArrowUp');assert.equal((await tune).status(),200);await page.waitForSelector('[data-filter-action=retry]');
    assert.equal(failures,1);assert.equal(await photo(),quickId);
    assert(await page.locator('#filter-content').evaluate(el=>el.inert));assert.equal(await page.locator('#journey-next').getAttribute('aria-disabled'),'true');
    assert.equal(await page.locator('#filter-status').textContent(),'Saved · refresh needed');assert(await hasDraft());
    const committed=await api('/api/filter?per=200');assert.equal(committed.scores[quickId],1);assert.equal(committed.scores[peer],cohortBefore.scores[peer]);
    assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.samples.reviewed,1);
    const queued=status===409?page.waitForResponse(response=>new URL(response.url()).pathname==='/api/draw/undo'):null;
    if(queued){await press('z');await press('z');assert.equal(previewWrites.filter(path=>path==='/api/draw/undo').length,0);}
    await shotSave(`FT-preview-failed-${status}`);
    const recovered=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/filter/preview'&&response.request().method()==='POST'&&response.status()===200);
    await page.click('[data-filter-action=retry]');const proposal=await(await recovered).json();
    assert(proposal.scores[peer]>cohortBefore.scores[peer]+.01,'Recovery shows the real related-take effect');
    assert.equal(previewWrites.filter(path=>path==='/api/filter/tune').length,1,'Refresh never repeats More');
    assert.equal(previewWrites.filter(path=>['/api/filter/decision','/api/filter/apply'].includes(path)).length,0);
    if(queued)assert.equal((await queued).status(),200);
    else{await ready();assert.equal(await page.locator('#filter-content').evaluate(el=>el.inert),false);assert.notEqual(await photo(),quickId,'The recovered Love decides the take and brings the next one');assert.equal(await page.evaluate(id=>World.sea.outcomeFlow.scores[id],peer),proposal.scores[peer]);await press('z');}
    await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
    assert.equal(previewWrites.filter(path=>path==='/api/draw/undo').length,1,'Recovery drains one queued undo');
    assert.equal(await photo(),quickId);assert.equal(await hasDraft(),false);
    assert.equal((await api(`/api/filter?photo=${quickId}`)).photos[0].override,cohortBefore.photos.find(row=>row.id===quickId).override);
    assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.samples.reviewed,0);
    previewFailures.push({status,source:quickId,peer,before:cohortBefore.scores[peer],preview:proposal.scores[peer],tuneCalls:previewWrites.filter(path=>path==='/api/filter/tune').length});
  }
  page.off('request',recordWrite);result.previewFailures=previewFailures;
  const laterPreview=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/filter/preview'&&response.request().method()==='POST');
  await press('w');const later=await(await laterPreview).json();await ready();assert(later.scores[peer]>cohortBefore.scores[peer]+.01);
  assert.notEqual(await photo(),quickId,'Love decides the take and brings the next one');await press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();

  // A failed read after Undo must not lose the already-undone question.
  const recoveredId=await photo(),recoveredLearning=(await api('/api/filter/learn',{policy:initial.policy})).learning;
  await press('ArrowDown');await ready();assert.notEqual(await photo(),recoveredId,'Hate decides the take and brings the next one');let failedUndoRefresh=0;
  await page.route(url=>url.pathname==='/api/filter'&&url.search==='?per=24',route=>{failedUndoRefresh++;return route.fulfill({status:503,json:{error:'Fixture Undo refresh failure'}});},{times:1});
  await press('z');await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id&&document.querySelector('#filter-status')?.textContent==='Undone',recoveredId);await ready();
  assert.equal(failedUndoRefresh,1);
  assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.revision,recoveredLearning.revision);
  assert.equal(await hasDraft(),false);result.undoRefresh={photo:recoveredId,failures:failedUndoRefresh};
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);
  const phone=await controls();assert(phone.every(b=>b.h>=44&&b.x>=0&&b.x+b.w<=390));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shotSave('FT-teaching-phone');
  let helpSaved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().postDataJSON()?.help===false);
  await page.click('#game-help');assert.equal((await helpSaved).status(),200);
  assert.equal(await page.locator('.filter-review-controls kbd:visible,.filter-review-controls [data-help-hint]:visible').count(),0);
  assert.equal(await page.locator('#game-help-hint').isVisible(),false);steady(phone,await controls(),'Help does not move the controls');
  await shotSave('FT-teaching-phone-no-help');
  helpSaved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().postDataJSON()?.help===true);
  await page.click('#game-help');assert.equal((await helpSaved).status(),200);

  // Outcome neighborhoods remain interactive, without throwing away the question in progress.
  await page.click('[data-outcome=kept]');await page.waitForSelector('.filter-content.sea');
  assert.equal(await page.evaluate(()=>World.sea.focusCluster),'gfilter-kept');
  assert.deepEqual((await page.evaluate(()=>[...World.sea.focusIds])).sort((a,b)=>a-b),[...initial.ids.kept].sort((a,b)=>a-b));
  await menuAction('filter-review');await ready();assert.equal(await photo(),first);
  await press('Space');await advanced(first);await ready();
  assert.equal((await api(`/api/filter?photo=${first}`)).photos[0].override,initial.photos.find(p=>p.id===first).override);
  const visited=[first];
  for(let i=0;i<8;i++){const id=await photo();visited.push(id);await press('Space');await advanced(id);await ready();assert.equal(await page.locator('.filter-round-done').count(),0);}
  assert(new Set(visited).size>6,`Play continues beyond an internal batch without a round screen: ${visited}`);
  const last=await photo(),beforeLast=(await api(`/api/filter?photo=${last}`)).photos[0];
  await press('d');await advanced(last);await ready();await press('z');
  await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id&&document.querySelector('#filter-status')?.textContent==='Undone',last);await ready();
  assert.equal((await api(`/api/filter?photo=${last}`)).photos[0].override,beforeLast.override);
  await shotSave('FT-continuous-phone');

  // The learner's evidence thresholds have backend coverage. Replay a proposal, then exercise real preview,
  // persistence, admission changes and undo with the public fixture's actual photos and saved choices.
  let propose=false,beforeProposal;const proposed=policy=>({ ...policy,min_pixels:10000 });
  const offer=(data,policy)=>({...data,ready:true,policy:proposed(policy),changes:[{key:'min_pixels',before:policy.min_pixels,after:10000,evidence:{keep:3,aside:3}}]});
  await page.route('**/api/filter/tune',async route=>{const response=await route.fetch(),data=await response.json();if(propose)data.learning=offer(data.learning,route.request().postDataJSON().policy);await route.fulfill({response,json:data});});
  await page.route('**/api/filter/learn',async route=>{const response=await route.fetch(),data=await response.json();if(propose)data.learning=offer(data.learning,route.request().postDataJSON().policy);await route.fulfill({response,json:data});});
  const proposeNow=async()=>{
    beforeProposal=(await api('/api/filter/learn',{policy:initial.policy})).learning;
    propose=true;const id=await photo(),reply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/preview'&&r.request().method()==='POST');
    await press('w');const preview=await(await reply).json();await ready();assert.notEqual(await photo(),id,'Love decides the take and brings the next one');await previewReady();
    assert(preview.counts.changed>0);assert.equal(preview.policy.min_pixels,10000);await flow(preview.ids);
    assert.equal((await api('/api/filter?per=1')).policy.min_pixels,initial.policy.min_pixels,'Learning only previews broad effects');
    return preview;
  };
  let preview=await proposeNow();const resumed=await photo();
  await menuAction('filter-inspect');await page.waitForSelector('.filter-take');
  assert.equal(await page.locator('[data-catalog-state=changed]').getAttribute('class'),'seg-btn on');
  const projected=await api(`/api/filter/preview?token=${encodeURIComponent(preview.token)}&state=changed&per=24`);
  assert.deepEqual(await page.locator('.filter-take').evaluateAll(es=>es.map(e=>Number(e.dataset.reviewPhoto))),projected.photos.map(p=>p.id));
  await shotSave('FT-preview-changes-phone');
  await menuAction('filter-sea');await menuAction('filter-review');await ready();assert.equal(await photo(),resumed);
  assert(await page.evaluate(()=>!!sessionStorage.getItem(`matcher-filter-draft:${S.lib.source}`)));
  await page.evaluate(()=>location.hash='#home');await page.waitForSelector('.journey');assert.equal(await page.evaluate(()=>World.sea.outcomeFlow),null);
  await page.evaluate(()=>location.hash='#filter');await previewReady();await ready();
  assert.equal((await api('/api/filter?per=1')).policy.min_pixels,initial.policy.min_pixels,'Restored preview stays unapplied');
  propose=false;await press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone'&&!!document.querySelector('#journey-next'));await ready();
  assert.equal(await hasDraft(),false,'Undo retracts the proposal from the undone teaching call');
  assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.revision,beforeProposal.revision);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem(`matcher-filter-draft:${S.lib.source}`)),null);await flow((await api('/api/filter?per=1')).ids);

  preview=await proposeNow();propose=false;let failedApplyRefresh=0,applyWrites=0;
  const countApply=request=>{if(new URL(request.url()).pathname==='/api/filter/apply')applyWrites++;};page.on('request',countApply);
  await page.route(url=>url.pathname==='/api/filter'&&url.search==='?per=24',route=>{failedApplyRefresh++;return route.fulfill({status:503,json:{error:'Fixture Apply refresh failure'}});},{times:2});
  await page.click('#journey-next');
  await page.waitForSelector('[data-filter-action=retry]');
  assert(await page.locator('#filter-content').evaluate(el=>el.inert),'Unrefreshed choices stay blocked');
  const applied=await api('/api/filter?per=200');assert.equal(applied.policy.min_pixels,10000);assert.deepEqual(applied.ids.aside,preview.ids.aside);
  assert.equal(failedApplyRefresh,2);assert.equal(await page.locator('[data-filter-action=apply],[data-filter-action=preview]').count(),0);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem(`matcher-filter-draft:${S.lib.source}`)),null);
  assert.equal(await page.evaluate(token=>fetch(`/api/filter/preview?token=${encodeURIComponent(token)}`).then(response=>response.status),preview.token),409,'Apply consumes the preview even if its summary refresh fails');
  await shotSave('FT-refresh-needed-phone');await page.click('[data-filter-action=retry]');
  await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Applied'&&!!document.querySelector('#journey-next'));await ready();
  assert.equal(await page.locator('#filter-content').evaluate(el=>el.inert),false);assert.equal(applyWrites,1,'Refresh repeats the read, never Apply');page.off('request',countApply);
  result.applyRefresh={failures:failedApplyRefresh,writes:applyWrites,policy:applied.policy.min_pixels,changed:preview.counts.changed};
  await flow(applied.ids);await shotSave('FT-applied-phone');
  await press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
  assert.equal((await api('/api/filter?per=1')).policy.min_pixels,initial.policy.min_pixels);
  // Undoing Apply restores admission rules; the teaching call still exists and may propose its fit again.
  const taught=(await api('/api/filter/learn',{policy:initial.policy})).learning;
  assert(taught.samples.reviewed>0);assert.equal(await hasDraft(),true);
  await press('z');await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone'&&!!document.querySelector('#journey-next'));await ready();
  assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.revision,beforeProposal.revision);

  // Choosing Sea during an in-flight Skip must preserve the already advanced queue when play resumes.
  const skipped=await photo(),photoRequest=url=>url.pathname==='/api/filter'&&url.searchParams.has('photo');
  await page.route(photoRequest,async route=>{const response=await route.fetch();await new Promise(resolve=>setTimeout(resolve,600));await route.fulfill({response});},{times:1});
  const loading=page.waitForRequest(r=>photoRequest(new URL(r.url())));await press('Space');
  const pending=Number(new URL((await loading).url()).searchParams.get('photo'));assert.notEqual(pending,skipped);
  await menuAction('filter-sea');await page.waitForSelector('.filter-content.sea');await page.waitForTimeout(650);
  await menuAction('filter-review');await ready();assert.equal(await photo(),pending);

  // A committed decision remains undoable even if the subsequent summary request fails.
  const committed=await photo(),before=(await api(`/api/filter?photo=${committed}`)).photos[0];
  await page.route(url=>url.pathname==='/api/filter'&&url.search==='?per=24',route=>route.fulfill({status:503,json:{error:'Fixture refresh failure'}}),{times:1});
  await press(before.override==='toss'?'d':'a');await advanced(committed);await ready();
  assert.equal((await api(`/api/filter?photo=${committed}`)).photos[0].override,before.override==='toss'?'keep':'toss');
  await press('z');await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id&&document.querySelector('#filter-status')?.textContent==='Undone',committed);await ready();
  assert.equal((await api(`/api/filter?photo=${committed}`)).photos[0].override,before.override);

  // Persisted evidence can be undone while the next entry is still loading its learned draft.
  const startupId=await photo();let startupLearning=(await api('/api/filter/learn',{policy:initial.policy})).learning;
  let startupCall=await api('/api/filter/tune',{photo:startupId,direction:'toward',policy:initial.policy});
  if(!startupCall.edited){startupLearning=(await api('/api/filter/learn',{policy:initial.policy})).learning;startupCall=await api('/api/filter/tune',{photo:startupId,direction:'away',policy:initial.policy});}
  assert(startupCall.edited);await page.evaluate(()=>location.hash='#home');await page.waitForSelector('.journey');
  let releaseLearn,signalLearn;const learnGate=new Promise(resolve=>releaseLearn=resolve),learnStarted=new Promise(resolve=>signalLearn=resolve);
  await page.route('**/api/filter/learn',async route=>{const response=await route.fetch();signalLearn();await learnGate;await route.fulfill({response});},{times:1});
  await page.evaluate(()=>location.hash='#filter');await learnStarted;
  const startupUndo=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/undo');await press('z');releaseLearn();
  assert.equal((await startupUndo).status(),200);await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
  assert.equal((await api('/api/filter/learn',{policy:initial.policy})).learning.revision,startupLearning.revision);
  assert.equal(await page.locator('.filter-empty').count(),0);assert.equal(await page.locator('.filter-round-progress').count(),0);
  await shotSave('FT-startup-undo-phone');const playable=await photo();await press('Space');await advanced(playable);await ready();
  result.startupUndo={evidencePhoto:startupId,playablePhoto:playable};
  await page.evaluate(()=>location.hash='#home');await page.waitForSelector('.journey');assert.equal(await page.evaluate(()=>World.sea.outcomeFlow),null);
  result.teaching=teaching;result.continuous={visited};result.controls={desktop,phone};result.preview=preview.counts;
  assert.deepEqual(problems,[]);console.log(JSON.stringify({...result,problems},null,1));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page){console.error(JSON.stringify({route:new URL(page.url()).hash,problems}));await page.screenshot({path:OUT+'/FT-failure.png'}).catch(()=>{});}process.exit(1);});
