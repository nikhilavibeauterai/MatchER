// Real activities stay reachable from the campaign, including on a small phone.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
let page;const res={},problems=[];
(async()=>{
  const browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>problems.push(e.message));
  page.on('console',m=>{if(m.type()==='error')problems.push(m.text());});
  page.on('response',r=>{if(r.status()>=400)problems.push(`${r.status()} ${new URL(r.url()).pathname}`);});
  await page.goto(LINK);assert.equal(await page.locator('.onboard-path li').count(),3,'The title screen introduces three beats');
  await page.click('.onboard .help-btn');assert.match(await page.locator('.help-pop').innerText(),/Knockouts/);await page.keyboard.press('Escape');
  await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const home=async()=>{await page.goto(BASE+'/#home');await page.waitForSelector('.journey');};
  const activities=async()=>{await page.click('#open-menu');await page.click('[data-menu-page=play]');};
  assert.equal(await page.locator('#journey-next').getAttribute('href'),'#filter');
  assert.equal(await page.locator('#track .tnode').count(),10);  // the map, the eight stages, the leaderboard
  assert.equal(await page.locator('#track .tnode').first().getAttribute('data-stage'),'map');
  assert.equal(await page.locator('#track .tnode').last().getAttribute('data-stage'),'board');
  await page.screenshot({path:OUT+'/GF-map-desktop.png'});
  await activities();res.activities=await page.locator('#menu a').allTextContents();
  assert(res.activities.some(x=>x.includes('Tag lab'))&&res.activities.some(x=>x.includes('Open arena')));
  assert(await page.locator('#menu a[href="#tournament"]').isVisible());
  assert(await page.locator('#menu a[href="#shortlist"]').isVisible());
  await page.locator('#menu a[href="#tags"]').click();await page.waitForSelector('.tags-page');
  assert.equal(await page.locator('#track [aria-current=step]').getAttribute('data-stage'),'draw');
  await home();await activities();await page.locator('#menu a[href^="#tags?play="]').click();
  await page.waitForSelector('.tag-game');assert(await page.locator('#tag-call').innerText());
  await page.keyboard.press('Escape');await page.click('#menu-leave');await page.waitForSelector('.tags-page');
  await home();await activities();await page.locator('#menu a[href*="lightning=1"]').click();
  await page.waitForFunction(()=>S.lr&&!!S.current&&!S.busy);
  assert.equal(await page.locator('#track [aria-current=step]').count(),0,'Open arena is not the knockout stage');
  res.lightning=await page.locator('.lr-bar').innerText();
  // Pausing preserves the actual activity, its clock and the control that had focus.
  const running=await page.evaluate(()=>({card:S.current.id,ends:S.lr.ends}));
  await page.locator('#hud-bolt').focus();await page.keyboard.press('Escape');await page.waitForSelector('#menu[open] #menu-resume');
  assert.equal(await page.locator('#menu .menu-head h2').innerText(),'Lightning round');
  assert(await page.evaluate(()=>S.pause&&World.sea.paused&&S.lr.pausedAt!=null));
  const seconds=await page.locator('#lr-secs').innerText();await page.keyboard.press('ArrowRight');await page.waitForTimeout(800);
  assert.equal(await page.locator('#lr-secs').innerText(),seconds,'The Lightning clock freezes while paused');
  assert.equal(await page.evaluate(()=>S.current.id),running.card,'A key behind the pause panel cannot vote');
  await page.screenshot({path:OUT+'/GF-pause-desktop.png'});
  await page.click('[data-menu-page=library]');await page.click('[data-m=settings]');await page.waitForSelector('#settings[open]');await page.keyboard.press('Escape');
  assert(await page.locator('#menu').isVisible());assert(await page.evaluate(()=>S.lr.pausedAt!=null),'Utility dialogs keep the activity paused');
  await page.click('#menu-resume');
  assert(await page.evaluate(ends=>!S.pause&&!World.sea.paused&&S.lr.pausedAt==null&&S.lr.ends-ends>=800,running.ends));
  assert.equal(await page.locator('#hud-bolt').evaluate(e=>document.activeElement===e),true,'Resume restores keyboard focus');
  await page.locator('#hud-bolt').focus();await page.keyboard.press('Enter');await page.waitForSelector('.lr-result');assert.match(await page.locator('.lr-result').innerText(),/stopped early/);assert(!/calls in 60 seconds/.test(await page.locator('.lr-result').innerText()),'Stopping early must report elapsed time honestly');await page.click('#lr-done');
  await page.click('#open-menu');await page.click('[data-menu-page=view]');assert.match(await page.locator('[data-m=filter]').innerText(),/Enhance/);
  const before=await page.evaluate(()=>S.filter);await page.click('[data-m=filter]');
  assert.equal(await page.evaluate(()=>S.filter),!before,'Enhance keeps the existing F preference');
  assert.match(await page.locator('.filter-btn').innerText(),/Enhance/);await page.click('#menu-resume');
  await page.click('#open-menu');await page.click('[data-menu-page=library]');await page.click('[data-m=settings]');await page.waitForSelector('#settings[open]');
  assert.equal(await page.locator('#s-age').count(),0,'Settings cannot bypass Filter preview');
  const settingsRequest=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/settings'&&r.method()==='POST');
  await page.click('#s-save');assert(!Object.hasOwn((await settingsRequest).postDataJSON(),'max_age_years'));
  await page.waitForSelector('#settings[open]',{state:'hidden'});await page.waitForSelector('#menu[open]',{state:'hidden'});
  await page.click('#open-menu');await page.click('[data-menu-page=library]');await page.click('[data-m=settings]');await page.click('#s-filter');
  await page.waitForSelector('.filter-stage');assert.equal(await page.locator('#settings[open]').count(),0);
  await home();await activities();
  if(await page.locator('#menu a[href="#cuts"]').count()){
    await page.locator('#menu a[href="#cuts"]').click();await page.waitForSelector('.cuts');
    assert.equal(await page.locator('#track [aria-current=step]').getAttribute('data-stage'),'filter');
    assert(await page.locator('.cuts .tile').count()>0);
    const remaining=Number((await page.locator('#cut-remaining').textContent()).replaceAll(',',''));
    const first=page.locator('.cuts .tile:not(.rescued)').first();const id=await first.getAttribute('data-id');await first.click();
    await page.waitForFunction(n=>Number(document.querySelector('#cut-remaining').textContent.replaceAll(',',''))===n,remaining-1);
    await page.locator(`.cuts .tile[data-id="${id}"]`).click();await page.waitForFunction(n=>Number(document.querySelector('#cut-remaining').textContent.replaceAll(',',''))===n,remaining);
  }
  await page.goto(BASE+'/#sweep');await page.waitForSelector('.swipe-card.top,.quest-clear');
  if(await page.locator('.quest-clear').count()){
    const clear=await page.locator('.quest-clear').boundingBox();assert(clear.height<300,'An empty side quest is a compact reward card');
    await page.waitForTimeout(800);await page.screenshot({path:OUT+'/GF-sweep-clear.png'});
  }
  await home();await activities();await page.click('#menu [data-m=trophies]');await page.waitForSelector('.trophy-head');await page.keyboard.press('Escape');await page.click('#menu-resume');
  await page.setViewportSize({width:320,height:740});await page.waitForTimeout(400);
  await page.keyboard.press('Escape');await page.waitForSelector('#menu[open]');
  const pauseBox=await page.locator('#menu').boundingBox();
  assert(pauseBox.x>=0&&pauseBox.y>=0&&pauseBox.x+pauseBox.width<=320&&pauseBox.y+pauseBox.height<=740);
  const resume=await page.locator('#menu-resume').boundingBox();assert(resume.height>=44);
  await page.click('[data-menu-page=library]');await page.locator('[data-m=settings]').scrollIntoViewIfNeeded();assert(await page.locator('[data-m=settings]').isVisible());
  const resumeAfter=await page.locator('#menu-resume').boundingBox();assert(Math.abs(resume.y-resumeAfter.y)<1,'Tools scroll without moving Resume');
  await page.screenshot({path:OUT+'/GF-pause-phone.png'});
  await page.keyboard.press('Escape');assert(await page.locator('[data-menu-page=library]').isVisible(),'Escape returns from submenu before resuming');assert(await page.evaluate(()=>!!S.pause));await page.keyboard.press('Escape');await page.waitForSelector('#menu[open]',{state:'hidden'});
  const dock=await page.locator('#track').evaluate(e=>({overflow:e.scrollWidth>e.clientWidth,links:[...e.querySelectorAll('.tnode')].map(a=>{
    const r=a.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,height:r.height};})}));
  assert(!dock.overflow&&dock.links.length===10);assert(dock.links.every(r=>r.x>=0&&r.right<=320&&r.width>=36&&r.height>=44));
  const barBefore=await page.locator('#journey-next').boundingBox();
  await activities();await page.waitForTimeout(400);
  const links=page.locator('#menu .menu-list a');
  for(let i=0;i<await links.count();i++){
    await links.nth(i).scrollIntoViewIfNeeded();
    assert(await links.nth(i).evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return r.height>=44&&(hit===e||e.contains(hit));}),'Each activity has a visible phone touch target');
  }
  const barAfter=await page.locator('#journey-next').boundingBox();assert(Math.abs(barBefore.y-barAfter.y)<1,'Browsing side quests keeps the forward action fixed');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:OUT+'/GF-map-phone-activities.png'});
  // The entry gate remains explicit; completion advances to Stacks.
  await page.click('#menu-resume');await page.locator('#journey-next').click();await page.waitForSelector('.filter-stage');
  assert.equal(new URL(page.url()).hash,'#filter');
  await page.waitForSelector('.filter-shot[data-photo]');
  const filterCard=await page.locator('.filter-shot').getAttribute('data-photo');assert.equal(await page.locator('.filter-round-progress,.filter-round-done').count(),0);
  await page.keyboard.press('Escape');await page.waitForSelector('#menu[open] #filter-sea');await page.click('#menu-resume');
  assert.equal(await page.locator('.filter-shot').getAttribute('data-photo'),filterCard);assert.equal(await page.locator('.filter-round-progress,.filter-round-done').count(),0);
  const filterView=await page.evaluate(()=>S.view);await page.keyboard.press('Escape');await page.click('#filter-sea');await page.waitForSelector('.filter-content.sea');
  assert.equal(await page.evaluate(()=>S.view),filterView,'Leaving Filter review returns to its mounted editor');
  await page.click('#journey-next');await page.waitForSelector('.stacker');
  assert.equal(await page.locator('#track [aria-current=step]').getAttribute('data-stage'),'stacks');
  await page.waitForSelector('#track [data-stage=filter].done');
  assert(await page.locator('.screen-bar a[href="#filter"]').isVisible());
  const editor=async(name)=>{
    await page.waitForTimeout(450);await page.waitForFunction(()=>!document.querySelector('.world-fly'));
    const geometry=await page.evaluate(()=>{
      const screen=document.querySelector('.screen.sorter'),head=screen.querySelector('.screen-head').getBoundingClientRect(),bar=screen.querySelector('.screen-bar').getBoundingClientRect();
      return {head:head.height,bar:bar.height,body:screen.querySelector('.screen-body').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,
        controls:[...screen.querySelectorAll('.screen-head button,.screen-head a,.screen-bar button,.screen-bar a')].filter(e=>e.getBoundingClientRect().height).map(e=>{const r=e.getBoundingClientRect();return {text:e.innerText,height:r.height,fits:r.left>=0&&r.right<=innerWidth&&r.top>=document.querySelector('#journey-dock').getBoundingClientRect().bottom&&r.bottom<=innerHeight};})};
    });
    assert(!geometry.overflow&&geometry.controls.every(c=>c.fits&&c.height>=44),`${name}: visible44px controls ${JSON.stringify(geometry)}`);
    assert(geometry.bar<=65&&geometry.body>=160,`${name}: compact footer leaves photos room ${JSON.stringify(geometry)}`);
    await page.screenshot({path:`${OUT}/GF-${name}-phone.png`});return geometry;
  };
  res.stacks=await editor('stacks');await page.goto(BASE+'/#draw');await page.waitForSelector('.screen.sorter');res.groups=await editor('groups');
  await page.click('[data-mode="sea"]');await page.waitForSelector('#sea-head');await page.waitForSelector('#more-circles');res.sea=await editor('groups-sea');
  // The short phone rail has one scrollport; useful rows cannot collapse behind their headings.
  const rail=page.locator('#venn-rail'),railBar=await page.locator('.screen-bar').boundingBox();
  const reachable=async(target)=>{
    const geometry=await target.evaluate(e=>{
      const r=e.getBoundingClientRect(),rail=e.closest('#venn-rail').getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {text:e.innerText,height:r.height,fits:r.top>=rail.top-1&&r.bottom<=rail.bottom+1&&r.left>=rail.left&&r.right<=rail.right,hit:hit===e||e.contains(hit)};
    });
    assert(geometry.height>=44&&geometry.fits&&geometry.hit,`Phone rail target is clipped: ${JSON.stringify(geometry)}`);return geometry;
  };
  const suggestions=page.locator('#venn-rail [data-make]');
  assert(await suggestions.count()>0,'The public sample has suggested groups to review');
  await reachable(suggestions.first()); // No scroll first: the initial row must already be visible.
  for(let i=0;i<await suggestions.count();i++){await suggestions.nth(i).scrollIntoViewIfNeeded();await reachable(suggestions.nth(i));}
  await suggestions.first().click();await page.waitForSelector('#venn-rail [data-focus-bin]');
  const groupControls=page.locator('#venn-rail .bin-place,#venn-rail [data-focus-bin],#venn-rail .bin-emoji,#venn-rail .bin-edit,#venn-rail .bin.new');
  res.rail=[];
  for(let i=0;i<await groupControls.count();i++){await groupControls.nth(i).scrollIntoViewIfNeeded();res.rail.push(await reachable(groupControls.nth(i)));}
  const railBarAfter=await page.locator('.screen-bar').boundingBox();assert(Math.abs(railBar.y-railBarAfter.y)<1,'Reviewing the roster keeps the forward action anchored');
  assert(await rail.evaluate(e=>e.scrollHeight>e.clientHeight&&e.scrollWidth<=e.clientWidth),'All rail rows share one bounded vertical scrollport');
  await page.screenshot({path:OUT+'/GF-groups-roster-phone.png'});
  // Find more keeps its own per-card timer; its recorded call must also exclude a pause.
  const practice=await page.evaluate(async()=>{
    const b=await api('/api/draw/board?per=3&uper=3'),shots=[...(b.unsorted.shots||[]),...b.groups.flatMap(g=>g.shots||[])];
    const ids=[...new Set(shots.map(x=>x.rep))].slice(0,2);
    if(ids.length<2)throw new Error('Pause practice needs two actual shots');
    await api('/api/draw/move',{photos:ids,theme:null});return (await api('/api/draw/new',{photos:[ids[0]],name:'Pause practice'})).theme.id;
  });
  const practiceStart=await page.evaluate(tid=>{location.hash=`#draw?play=${tid}`;return performance.now();},practice);
  await page.waitForSelector('#dtop,.deck-note');
  if(await page.locator('[data-c=dig]').isVisible())await page.click('[data-c=dig]');
  await page.waitForSelector('#dtop');await page.keyboard.press('Escape');await page.waitForSelector('#menu[open]');
  const pausedClock=await page.evaluate(()=>playTime());await page.waitForTimeout(1200);
  assert(Math.abs(await page.evaluate(()=>playTime())-pausedClock)<1,'All activity timers freeze together');
  await page.click('#menu-resume');
  const practiceRequest=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/draw/call'&&r.method()==='POST'),practiceReply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/call');
  await page.click('[data-c=in]');const timedCall=(await practiceRequest).postDataJSON(),practiceElapsed=await page.evaluate(start=>performance.now()-start,practiceStart);
  assert(timedCall.ms>=0&&timedCall.ms<practiceElapsed-1100,`Find more included paused time: ${timedCall.ms} of ${practiceElapsed}`);
  await practiceReply;
  await page.keyboard.press('Escape');await page.waitForSelector('#menu[open]');
  await page.evaluate(()=>location.hash='#home');await page.waitForSelector('.journey');
  assert(await page.evaluate(()=>!S.pause&&!document.querySelector('#menu').open&&!World.sea.paused),'Navigation discards the old pause safely');
  await home();assert.notEqual(await page.locator('#journey-next').getAttribute('href'),'#filter');
  res.dock=dock;assert.deepEqual(problems,[]);console.log(JSON.stringify({...res,problems},null,1));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page){console.error(JSON.stringify({route:new URL(page.url()).hash,text:await page.locator('#main').innerText().catch(()=>''),problems}));await page.screenshot({path:OUT+'/failure-game-flow.png'}).catch(()=>{});}process.exit(1);});
