// Every take stays reachable; Next confirms a saved draft before entering Stack.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
let page;
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1000}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  const api=(url,body)=>page.evaluate(([url,body])=>api(url,body),[url,body]);
  const ready=()=>page.waitForFunction(()=>!!document.querySelector('.filter-shot')&&!document.querySelector('.filter-thinking')&&!document.querySelector('.filter-review[aria-busy="true"]'));
  const photo=async()=>Number(await page.locator('.filter-shot').getAttribute('data-photo'));
  const quiet=()=>page.waitForFunction(()=>!World.flights?.size&&!document.querySelector('.world-fly'));
  const menuAction=async id=>{await page.click('#open-menu');await page.locator(`#menu #${id}`).click();};
  const idle=()=>page.waitForFunction(()=>!!document.querySelector('.filter-stage')&&!document.querySelector('.filter-thinking'));
  const previewReady=async()=>{await page.waitForFunction(()=>document.querySelector('.filter-stage')?.dataset.preview==='true');await idle();};
  const makePreview=async()=>{
    const [response]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/preview'&&r.request().method()==='POST'),menuAction('filter-preview')]);
    const data=await response.json();
    await previewReady();return data;
  };
  const legacyDraft=async policy=>page.evaluate(policy=>sessionStorage.setItem(`matcher-filter-draft:${S.lib.source}`,JSON.stringify(policy)),policy);
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.evaluate(()=>location.hash='#filter');await ready();
  assert.equal(await page.locator('#filter-kit,[data-rule],#filter-reasons').count(),0);
  assert.equal(await page.locator('[data-tune],[data-decision]').count(),4,'The whole teaching vocabulary fits on four directions');
  assert.equal(await page.locator('.filter-round-progress,.filter-round-done').count(),0,'Review has no imposed rounds');
  const initial=await api('/api/filter?per=200');assert(initial.photos.length>24);assert.equal(initial.scope,'library');
  await page.waitForFunction(n=>World.sea.items.size===n,initial.counts.total);
  assert.equal(await page.locator('#world').count(),1);
  assert(await page.evaluate(()=>[...World.sea.items.values()].every(it=>!it.take&&it.stack===it.id)));

  // A pre-existing draft remains usable after replacing the former sliders with directional teaching.
  const tags=initial.tags.filter(t=>t.count>0&&t.count<initial.counts.total).sort((a,b)=>b.count-a.count).slice(0,2).sort((a,b)=>b.key.localeCompare(a.key));
  assert.equal(tags.length,2);
  const draft={...initial.policy,min_pixels:450,require_tags:tags.map(t=>t.key),require_mode:'any'};
  await legacyDraft(draft);const automatic=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/preview'&&r.request().method()==='POST');
  await page.evaluate(()=>location.hash='#filter?view=sea');let preview=await(await automatic).json();await previewReady();
  assert.deepEqual((await api('/api/filter?per=1')).policy,initial.policy);
  assert(preview.counts.changed>0);
  assert.deepEqual(preview.policy.require_tags,[...tags.map(t=>t.key)].sort());
  assert.deepEqual((await api('/api/filter?per=1')).counts,initial.counts);
  await page.waitForFunction(n=>World.sea.outcomeFlow?.changed.length===n,preview.ids.changed.length);
  const badges=await page.evaluate(()=>[...World.sea.items.values()].map(it=>({id:it.id,result:it.el.dataset.filterResult})));
  assert(badges.length>0);assert(badges.every(b=>b.result===(preview.ids.failing.includes(b.id)?'fail':'pass')));
  await quiet();await page.screenshot({path:`${OUT}/filter-preview-desktop.png`});
  await menuAction('filter-review');await ready();const reviewed=await photo();
  assert.equal(await page.locator('.filter-result').getAttribute('aria-label'),`${preview.ids.failing.includes(reviewed)?'Fails':'Passes'} preview rules`);
  const manualBefore=(await api('/api/filter?per=1')).counts.manual_keep;
  await page.locator('[data-review-next]').focus();await page.keyboard.press('Space');
  await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)!==id,reviewed);await ready();
  assert.equal((await api('/api/filter?per=1')).counts.manual_keep,manualBefore,'Native Space on Skip makes no Keep call');
  await menuAction('filter-sea');await page.waitForSelector('.filter-content.sea');

  // Browse pages are disjoint and invisible world copies cannot steal a catalogue click.
  await menuAction('filter-catalogue');await page.waitForSelector('.filter-take');await quiet();
  assert(await page.evaluate(()=>[...document.querySelectorAll('#world .ps-item.lifted')].every(el=>getComputedStyle(el).pointerEvents==='none')));
  const first=await page.locator('.filter-take').evaluateAll(nodes=>nodes.map(n=>n.dataset.reviewPhoto));assert.equal(first.length,24);
  await page.click('[data-catalog-page=next]');await page.waitForFunction(id=>document.querySelector('.filter-take')?.dataset.reviewPhoto!==id,first[0]);
  const second=await page.locator('.filter-take').evaluateAll(nodes=>nodes.map(n=>n.dataset.reviewPhoto));assert(second.length&&second.every(id=>!first.includes(id)));

  // A concurrent choice invalidates the token. The UI returns to actual outcomes while retaining the draft.
  const external=initial.photos.find(p=>p.override!=='toss'&&p.id!==reviewed).id;
  await api('/api/filter/decision',{photos:[external],action:'aside'});
  await page.click('#journey-next');await page.waitForFunction(()=>document.querySelectorAll('#filter-outcomes [aria-label*="in preview"]').length===0);await idle();
  assert.equal(await page.locator('#filter-outcomes [aria-label*="in preview"]').count(),0);
  preview=await makePreview();await menuAction('filter-sea');await page.waitForSelector('.filter-content.sea');
  let releaseApply;const applyGate=new Promise(resolve=>releaseApply=resolve);
  await page.route('**/api/filter/apply',async route=>{const response=await route.fetch();await applyGate;await route.fulfill({response});},{times:1});
  const committing=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/filter/apply');
  await page.click('#journey-next');await committing;await menuAction('filter-catalogue');
  assert.equal(await page.locator('.filter-content.catalogue').count(),0,'Browse cannot change mode during Apply');
  releaseApply();
  await page.waitForSelector('.stacker');
  await page.evaluate(()=>location.hash='#filter?view=sea');await idle();
  const applied=await api('/api/filter?per=200');assert(applied.stage.done);assert.deepEqual(applied.ids.aside,preview.ids.aside);
  assert.equal(applied.policy.min_pixels,450);assert.deepEqual(applied.policy.require_tags,preview.policy.require_tags);

  // Every set-aside take can be rescued individually without clearing the learned admission rules.
  await menuAction('filter-catalogue');await page.waitForSelector('.filter-take');await page.click('[data-catalog-state=aside]');await page.waitForSelector('.filter-take.aside');
  const rescue=applied.photos.find(p=>p.disposition==='aside'&&!p.override&&p.playable).id;
  await page.locator(`.filter-take[data-review-photo="${rescue}"]`).click();await ready();await page.click('[data-decision=keep]');
  await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)!==id&&!!document.querySelector('#journey-next'),rescue);await ready();
  const rescued=await api('/api/filter?per=200');assert.equal(rescued.counts.aside,applied.counts.aside-1);
  assert.equal(rescued.photos.find(p=>p.id===rescue).override,'keep');assert.deepEqual(rescued.policy,applied.policy);
  assert(rescued.photos.filter(p=>p.id!==rescue).every(p=>p.disposition===applied.photos.find(q=>q.id===p.id).disposition));
  await menuAction('filter-catalogue');await page.waitForSelector('.filter-take');await page.click('[data-catalog-state=kept]');
  await page.locator(`[data-review-photo="${rescue}"]`).click();await ready();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/Follow rules for this take/}).waitFor();
  await page.screenshot({path:`${OUT}/filter-pause-reset.png`});
  await page.getByRole('button',{name:/Follow rules for this take/}).click();
  await page.waitForFunction(id=>!document.querySelector('#menu[open]')&&Number(document.querySelector('.filter-shot')?.dataset.photo)!==id,rescue);await ready();
  assert.equal((await api(`/api/filter?photo=${rescue}`)).photos[0].override,null);
  assert.equal((await api('/api/filter?per=1')).counts.aside,applied.counts.aside);
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('z');await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id&&document.querySelector('#filter-status')?.textContent==='Undone',rescue);await ready();
  assert.equal((await api(`/api/filter?photo=${rescue}`)).photos[0].override,'keep','Undo restores the personal exception');
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('z');await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id&&document.querySelector('#filter-status')?.textContent==='Undone',rescue);await ready();
  assert.equal((await api('/api/filter?per=1')).counts.aside,applied.counts.aside);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);await quiet();
  const badgeFit=await page.evaluate(()=>{const b=document.querySelector('.filter-result').getBoundingClientRect(),p=document.querySelector('.filter-print .paper').getBoundingClientRect();/* the badge sits on the card's paper */return {inside:b.left>=p.left-1&&b.top>=p.top-1&&b.right<=p.right+1&&b.bottom<=p.bottom+1,width:p.width,height:p.height};});
  assert(badgeFit.inside&&badgeFit.height>=100,JSON.stringify(badgeFit));await page.screenshot({path:`${OUT}/filter-review-phone.png`});

  // Reload preserves an old-format unapplied draft, and Discard clears both projected rows and sea badges.
  await legacyDraft({...applied.policy,min_pixels:500});const restoredReply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/preview'&&r.request().method()==='POST');
  await page.reload();const restored=await(await restoredReply).json();await previewReady();await page.waitForSelector('.filter-content.sea');
  assert.equal(restored.policy.min_pixels,500);assert.equal((await api('/api/filter?per=1')).policy.min_pixels,450);
  await menuAction('filter-catalogue');await page.waitForSelector('.filter-catalogue');await menuAction('filter-reset');
  await page.waitForFunction(()=>document.querySelector('.filter-catalogue > header')?.textContent.includes('Current'));
  assert.equal(await page.locator('.filter-take.changed').count(),0);assert.equal(await page.evaluate(()=>sessionStorage.getItem(`matcher-filter-draft:${S.lib.source}`)),null);
  await page.click('#journey-next');await page.waitForSelector('.stacker');

  // A read error stays accessible without fetching a nonexistent preview or exposing unusable actions.
  const broken=999999,brokenRequests=[];page.on('request',r=>{if(r.url().includes('/img/')&&r.url().includes(String(broken)))brokenRequests.push(r.url());});
  await page.route(/\/api\/filter\?/,async route=>{
    const response=await route.fetch(),d=await response.json(),q=new URL(route.request().url()).searchParams;
    const row={id:broken,photo:broken,rel:'unreadable-public-fixture.jpg',status:'error',reason:'error',reason_text:'Could not read this file.',reasons:['error'],override:null,disposition:'aside',cut:'error',playable:false,changed:false,before:'aside',metrics:{}};
    if(d.counts)d.counts={...d.counts,total:d.counts.total+1,aside:d.counts.aside+1,unreadable:d.counts.unreadable+1};
    if(d.ids)d.ids={...d.ids,aside:[broken,...d.ids.aside],unreadable:[broken,...(d.ids.unreadable||[])]};
    if(q.get('photo')===String(broken)){d.photos=[row];d.total=1;d.more=false;}
    else if(!q.has('photo')&&Number(q.get('page')||0)===0){d.photos=[row,...d.photos.slice(0,23)];d.total++;}
    await route.fulfill({response,json:d});
  });
  await page.evaluate(async id=>{await World.loading;World.photos.set(id,{id,rep:id,members:[id],tags:[],theme:-1,cut:true});World.total=World.photos.size;World.photosSource=S.lib.source;location.hash='#filter';},broken);
  await page.waitForSelector('.filter-stage');await menuAction('filter-catalogue');await page.locator(`[data-review-photo="${broken}"]`).click();
  await page.waitForSelector('.filter-spotlight .filter-unreadable');assert.equal(await page.locator('[data-decision=keep],[data-tune]').count(),0);
  assert(!(await page.evaluate(id=>World.sea.items.has(id),broken)));assert.deepEqual(brokenRequests,[]);
  await quiet();await page.screenshot({path:`${OUT}/filter-unreadable-phone.png`});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({initial:initial.counts,preview:preview.counts,applied:applied.counts,badgeFit,problems}));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page)await page.screenshot({path:`${OUT}/filter-fail.png`}).catch(()=>{});process.exit(1);});
