// Walk the campaign using its visible forward actions, then claim the useful result.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
let page;const problems=[],steps=[],calls={filter:0,twins:0,crown:0,groups:0,knockouts:0,finals:0};
(async()=>{
  const browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
  page.on('pageerror',e=>problems.push(e.message));
  page.on('dialog',d=>d.accept());
  const capture=async(name,phone=false)=>{
    await page.waitForTimeout(850);
    if(name!=='02-analysis')await page.waitForFunction(()=>!document.querySelector('.world-fly'),null,{timeout:10000});
    await page.screenshot({path:`${OUT}/UX-${name}.png`});
    steps.push({name,route:new URL(page.url()).hash,text:await page.locator('#main').innerText(),
      forward:await page.locator('#journey-next').allTextContents(),
      overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
    if(phone){await page.setViewportSize({width:390,height:844});await page.waitForTimeout(650);
      await page.waitForFunction(()=>!document.querySelector('.world-fly'),null,{timeout:10000});
      await page.screenshot({path:`${OUT}/UX-${name}-phone.png`});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' phone overflow');
      await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(350);}
  };
  // The one way forward is the HUD's next slot: coral with the next stage's name once the stage is ready.
  const forward=async()=>{const link=page.locator('#journey-next.ready');assert.equal(await link.count(),1,'One ready way forward');assert.equal(await page.locator('.screen-bar .bar-right .btn.primary[href^="#"]:not([href*="check"]):not([href*="sort"])').count(),0,'No second next button at the bottom');await link.click();};
  await page.goto(LINK);await page.waitForSelector('#path');await capture('01-welcome',true);
  await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('.an-sea,#an-go',{timeout:300000});await capture('02-analysis');
  await page.waitForSelector('#an-go',{timeout:300000});await capture('03-ready');await page.click('#an-go');
  await page.waitForSelector('.journey');await capture('04-home',true);await forward();
  await page.waitForSelector('[data-decision=keep]');await capture('05-filter',true);
  assert.equal(await page.locator('#filter-kit').count(),0,'Filter has no tuning panel');assert.equal(await page.locator('[data-tune],[data-decision]').count(),4);await capture('06-filter-play',true);
  for(let i=0;i<4;i++){await page.click('[data-decision=keep]');calls.filter++;await page.waitForTimeout(650);}
  await forward();
  await page.waitForSelector('.stacker');await capture('07-stacks',true);
  const twins=page.locator('a[href="#stacks?check=1"]');
  if(await twins.first().isVisible()){
    await twins.first().click();await page.waitForSelector('.twin-arena,.big-emoji');await capture('08-twins',true);
    while(await page.locator('.twin-arena').count()&&calls.twins<50){await page.keyboard.press('ArrowLeft');calls.twins++;await page.waitForTimeout(650);}
    assert.equal(await page.locator('.twin-arena').count(),0,'Twin check ends');await capture('09-stacks-done');
  }
  await forward();await page.waitForSelector('#stage.mini-stage,.stage-done');await capture('10-crown',true);
  while(await page.locator('#stage.mini-stage').count()&&calls.crown<60){await page.keyboard.press('ArrowLeft');calls.crown++;await page.waitForTimeout(550);}
  await page.waitForSelector('.stage-done');await capture('11-crown-done');await forward();
  await page.waitForSelector('.sorter');await capture('12-groups',true);
  if(await page.locator('#d-auto').count()){await page.click('#d-auto');await page.waitForSelector('#journey-next.ready[href="#tournament?kickoff=1"]',{timeout:60000});}
  await capture('13-groups-ready');await forward();
  await page.waitForSelector('.kickoff-team');await capture('14-kickoff',true);await forward();
  await page.waitForSelector('#stage .side,.stage-done');await capture('15-group-match',true);
  const beforeQualify=await page.evaluate(()=>S.progress.votes);
  await page.click('#group-qualify');await page.waitForSelector('#modal[open] #qualify-confirm');await capture('15a-leaders-preview');
  await page.goBack();await page.waitForSelector('.kickoff-team');
  assert.equal(await page.locator('#modal[open]').count(),0,'Qualification closes when leaving its stage');
  await forward();await page.waitForSelector('#group-qualify');await page.click('#group-qualify');await page.waitForSelector('#qualify-confirm');
  await page.click('#qualify-confirm');await page.waitForSelector('.stage-done');
  assert.match(await page.locator('.stage-done').innerText(),/Current leaders chosen/);
  assert.equal(await page.evaluate(()=>S.progress.votes),beforeQualify,'Qualification never invents played matches');
  await page.keyboard.press('z');await page.waitForSelector('#stage .side');
  assert.equal(await page.locator('.stage-done').count(),0,'Undo reopens the group comparisons');
  assert.equal(await page.evaluate(async()=>!!(await api('/api/journey')).stages.groups.chosen),false,'Undo retracts chosen qualification');
  await page.waitForSelector('#track [data-stage=groups]:not(.done)');
  // Undo pressed during qualification must run when the saved reply arrives.
  await page.click('#group-qualify');await page.waitForSelector('#qualify-confirm');
  let releaseQualification,qualificationArrived;
  const qualificationGate=new Promise(r=>{releaseQualification=r;}),qualificationReady=new Promise(r=>{qualificationArrived=r;});
  const holdQualification=async route=>{const response=await route.fetch();qualificationArrived();await qualificationGate;await route.fulfill({response});};
  await page.route('**/api/draw/qualify',holdQualification);
  await page.click('#qualify-confirm');await qualificationReady;await page.keyboard.press('z');
  assert.equal(await page.evaluate(()=>S.undoQueued),1,'Undo waits for the pending qualification');
  releaseQualification();await page.waitForFunction(()=>!S.busy&&!S.undoQueued&&!!document.querySelector('#stage .side'));
  await page.unroute('**/api/draw/qualify',holdQualification);
  assert.equal(await page.evaluate(async()=>!!(await api('/api/journey')).stages.groups.chosen),false,'Queued undo retracts chosen qualification');
  assert.equal(await page.evaluate(()=>S.progress.votes),beforeQualify,'Queued undo does not invent matches');
  while(!await page.locator('.stage-done').count()&&calls.groups<240){
    await page.waitForFunction(()=>!S.busy);await page.keyboard.press(calls.groups%3?'ArrowLeft':'ArrowRight');calls.groups++;await page.waitForTimeout(260);
  }
  assert(await page.locator('.stage-done').count(),'Group stage ends');await capture('16-groups-done');
  // Four advancers (or exactly eight) go straight into the bracket: the way on says so, and the rail marks the skip.
  const direct=await page.evaluate(async()=>!!(await api('/api/journey')).stages.duels.direct);
  assert.equal(await page.locator('#journey-next.ready').getAttribute('href'),direct?'#finals':'#duel?stage=knockouts','The way on names where you land');
  await forward();
  if(direct){
    await page.waitForSelector('.screen.finals');
    assert.equal(await page.evaluate(async()=>(await api('/api/finals')).seed_source),'knockouts','The group advancers seed the bracket');
    await page.waitForSelector('#track [data-stage=duels].skipped');
  }else{
    await page.waitForSelector('#stage .side,.stage-done');await capture('17-knockouts',true);
    while(!await page.locator('.stage-done').count()&&calls.knockouts<120){
      await page.waitForFunction(()=>!S.busy);await page.keyboard.press(calls.knockouts%2?'ArrowLeft':'ArrowRight');calls.knockouts++;await page.waitForTimeout(450);
    }
    assert(await page.locator('.stage-done').count(),'Knockouts end');await capture('18-knockouts-done');await forward();
  }
  await page.waitForSelector('.screen.finals');await capture('19-finals-ready',true);
  if(await page.locator('#journey-next.ready').count())await page.click('#journey-next');
  await page.waitForSelector('#f-arena');await capture('20-finals-play',true);
  const finalPair=await page.locator('#f-arena .side').evaluateAll(es=>es.map(e=>e.dataset.photo));
  await page.keyboard.press('Escape');await page.waitForSelector('#menu[open] #menu-leave');
  assert.equal(await page.locator('#menu-leave').innerText(),'Back to Tournament');
  await page.click('#menu-resume');assert.deepEqual(await page.locator('#f-arena .side').evaluateAll(es=>es.map(e=>e.dataset.photo)),finalPair,'Finals resumes the same pair');
  const finalists=await page.evaluate(async()=>(await api('/api/finals')).finals.seeds);
  while(await page.locator('#f-arena').count()&&calls.finals<10){
    const preferred=await page.locator('#f-arena .side').evaluateAll(es=>es.sort((a,b)=>Number(a.dataset.photo)-Number(b.dataset.photo))[0].dataset.side);
    await page.locator(`.screen-bar [data-f=${preferred}]`).click();calls.finals++;await page.waitForTimeout(650);
  }
  if(await page.locator('.ceremony').count()){await capture('21-champion');await page.keyboard.press('Escape');}
  await page.waitForSelector('#journey-next.ready[href="#reveal"]');await page.locator('#journey-next').click();
  await page.waitForSelector('.screen.reveal');await capture('22-reveal',true);
  assert(await page.locator('.title-road .defeated').count()>0);
  const outcome=await page.evaluate(async()=>({reveal:await api('/api/reveal'),journey:await api('/api/journey')}));
  assert(outcome.reveal.from_finals&&outcome.reveal.top.length>=4,'The run produces a crowned shortlist');
  assert.equal(outcome.reveal.podium[0],Math.min(...finalists),'A consistent preference wins the real bracket and reveal');
  assert.equal(outcome.reveal.top[0].photo,outcome.reveal.podium[0],'The useful shortlist starts with the chosen champion');
  await page.click('#x-best');await page.waitForSelector('#modal[open] .exported');await capture('23-saved');
  const exported=await page.locator('.exported').innerText();assert.match(exported,/Saved your top/);
  assert(steps.every(s=>!s.overflow));assert.deepEqual(problems,[]);
  console.log(JSON.stringify({calls,steps,champion:outcome.reveal.podium[0],shortlist:outcome.reveal.top.length,exported,problems},null,2));
  await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);console.error(JSON.stringify({calls,steps,problems}));if(page)await page.screenshot({path:OUT+'/UX-failure.png'}).catch(()=>{});process.exit(1);});
