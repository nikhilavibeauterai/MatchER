// A transparent top HUD leaves the world open; help belongs to the save.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:2048,height:1152}});
  const problems=[],layouts=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.sea?.items.size>0&&!World.loading);
  for(const [name,width,height] of [['wide',2048,1152],['desktop',1200,800],['tablet',1024,768],['phone',390,844],['small',320,740]]){
    await page.setViewportSize({width,height});await page.waitForTimeout(900);
    const layout=await page.evaluate(()=>{
      const box=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom};};
      const nav=document.querySelector('#track');
      const titleStyle=getComputedStyle(document.querySelector('#journey-title'));
      return {dock:box('#journey-dock'),main:box('#main'),world:box('#world'),sea:box('.map-sea'),body:box('.map-body'),
        localChrome:document.querySelectorAll('.journey .screen-head,.journey .screen-rail,.journey .screen-bar').length,tagShelf:!World.sea.tray.hidden,strayTags:[...document.querySelectorAll('#world.home-world .vn-tag')].filter(el=>el.getClientRects().length).length,stages:nav.querySelectorAll('.tnode').length,
        journeys:document.querySelectorAll('[aria-label="Your journey"]').length,headerTrack:!!document.querySelector('#topbar #track'),
        dockOverflow:[...nav.querySelectorAll('.tnode,#journey-prev')].some(el=>{const r=el.getBoundingClientRect(),n=nav.getBoundingClientRect();return r.left<n.left-1||r.right>n.right+1;}),title:document.querySelector('#journey-title').textContent,
        forwardFits:(()=>{const f=document.querySelector('#journey-next');if(!f)return true;const r=f.getBoundingClientRect(),chip=document.querySelector('#save-chip')?.getBoundingClientRect();return r.right<=innerWidth-8&&(!chip||r.right<=chip.left+1||r.bottom<=chip.top+1||r.top>=chip.bottom-1)&&f.scrollWidth<=f.clientWidth+1;})(),
        titleStyle:{fill:titleStyle.webkitTextFillColor,color:titleStyle.color,clip:titleStyle.backgroundClip},
        seaState:{highlight:World.sea.highlightIds?[...World.sea.highlightIds]:null,classes:World.sea.el.className,
          opacity:getComputedStyle(World.sea.el).opacity,photos:[...World.sea.items.values()].filter(it=>it.el.isConnected).map(it=>({id:it.id,cut:it.cut,classes:it.el.className,opacity:getComputedStyle(it.el).opacity}))},
        menu:box('#open-menu'),help:box('#game-help'),chip:box('#save-chip'),
        obstacles:World.sea.obstacles.length,localTitles:[...document.querySelectorAll('#main .screen-head h1,#main .help-btn')].filter(el=>el.getClientRects().length).length,
        scrollWidth:document.documentElement.scrollWidth,viewWidth:innerWidth,viewHeight:innerHeight,
        links:[...nav.querySelectorAll('.tnode')].map(a=>({label:a.getAttribute('aria-label'),href:a.getAttribute('href'),...box(`[data-stage="${a.dataset.stage}"]`)}))};
    });
    assert.equal(layout.stages,10);  // the map, the eight stages, the leaderboardassert(layout.links.every(a=>a.label&&a.href&&a.width>=36&&a.height>=44));
    assert.equal(layout.journeys,1,'The journey appears once');assert.equal(layout.headerTrack,false);
    assert.equal(layout.dockOverflow,false,`${name}: journey dock overflows`);assert(layout.forwardFits,`${name}: the way forward fits beside the save chip`);
    const arrow=await page.locator('#journey-next').boundingBox();assert(arrow.width>=44&&arrow.height>=44,`${name}: the forward action keeps its full touch target`);
    assert.equal(layout.localTitles,0,`${name}: the stage has one shared title`);assert(layout.title);
    assert.equal(layout.titleStyle.clip,'padding-box',`${name}: title backing does not fill its glyphs`);
    assert.equal(layout.titleStyle.fill,layout.titleStyle.color);
    const titleRGB=layout.titleStyle.fill.match(/[\d.]+/g).map(Number);
    // Ink on the notebook strip or light on glass: either way an opaque, readable fill.
    assert((titleRGB.slice(0,3).every(channel=>channel>=180)||titleRGB.slice(0,3).every(channel=>channel<=90))&&(titleRGB.length<4||titleRGB[3]===1),`${name}: stage title has an opaque readable text fill`);
    assert(layout.menu.x<=12&&layout.menu.y<=8,`${name}: Menu stays in the top-left corner`);
    assert(layout.help.x+layout.help.width<=width-8&&layout.help.bottom>=height-16,`${name}: Help stays bottom-right`);
    assert.equal(layout.obstacles,0,`${name}: UI chrome does not repel photos`);
    assert(layout.links.every(a=>a.x>=0&&a.x+a.width<=width&&a.bottom<=height),`${name}: every stage is visible`);
    assert.equal(layout.localChrome,0,`${name}: the map is the open sea`);assert.equal(layout.tagShelf,false);assert.equal(layout.strayTags,0);
    assert.equal(layout.seaState.highlight,null,`${name}: hidden tag controls must not leave a highlighted subset: ${JSON.stringify(layout.seaState)}`);
    assert(layout.dock.bottom<=layout.main.y+1,`${name}: journey sits above the play area`);
    assert(Math.abs(layout.world.y)<=1&&Math.abs(layout.world.bottom-height)<=1,`${name}: world runs behind the entire HUD`);
    assert(layout.links.every(a=>a.bottom<=layout.main.y+1),`${name}: stage icons leave controls reachable`);
    assert(layout.sea.height>=layout.body.height*.55,`${name}: too little room for the flock`);
    assert(layout.sea.height>150,`${name}: sea is just a thin band`);
    assert(layout.scrollWidth<=width,`${name}: page overflows sideways`);
    layouts.push({name,...layout});await page.screenshot({path:`${OUT}/M-map-${name}.png`});
  }
  await page.click('#open-menu');await page.click('[data-menu-page=play]');
  for(const route of ['#tags','#sweep','#cuts','#tournament','#shortlist','#duel?stage=open','#duel?stage=open&lightning=1'])
    assert.equal(await page.locator(`#menu a[href="${route}"]`).count(),1,`${route} remains accessible in Activities`);
  assert.equal(await page.locator('#menu [data-m=trophies]').count(),1);
  await page.click('#menu-resume');
  await page.click('#open-menu');
  const cups=await page.locator('#home-cups').count();
  if(cups){await page.click('#home-cups');await page.waitForSelector('#modal[open] .cup-row');assert.equal(await page.locator('.cup-row').count(),await page.evaluate(()=>S.journey.cups.length));await page.locator('.cup-row.on').click();}
  else await page.click('#menu-resume');
  assert.equal(await page.locator('#game-help').getAttribute('aria-pressed'),'true');
  // The first toggle survives even when its write is interrupted by an immediate reload.
  let interrupted=0;await page.route('**/api/settings',route=>{interrupted++;return route.abort('failed');},{times:1});
  await page.click('#game-help');await page.reload();await page.waitForSelector('.journey');
  assert.equal(interrupted,1);assert.equal(await page.locator('#game-help').getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('#game-help-hint').isVisible(),false);
  await page.waitForFunction(async()=>!(await api('/api/state')).library.settings.help);
  let helpSaved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().postDataJSON()?.help===true);
  await page.click('#game-help');assert.equal((await helpSaved).status(),200);
  helpSaved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().postDataJSON()?.help===false);
  await page.click('#game-help');assert.equal((await helpSaved).status(),200);
  await page.reload();await page.waitForSelector('.journey');
  assert.equal(await page.locator('#game-help').getAttribute('aria-pressed'),'false','This save remembers acknowledged help-off after reload');
  // Home can reverse an editor change, and replay that exact change from its photo card.
  await page.evaluate(()=>location.hash='#draw');await page.waitForSelector('.sorter,.group-sea');
  const change=await page.evaluate(async()=>{
    const board=await api('/api/draw/board?per=24'),shots=[...board.groups.flatMap(g=>g.shots),...board.unsorted.shots];
    const created=await api('/api/draw/new',{photos:shots.slice(0,2).map(shot=>shot.rep)}),group=created.theme;
    await api('/api/draw/rename',{theme:group.id,name:'Home history fixture'});
    return {id:group.id,before:group.name,after:'Home history fixture'};
  });
  const historyRequests=[];page.on('request',request=>{if(/\/api\/(history|undo|redo|draw\/(undo|redo|history))/.test(request.url()))historyRequests.push({path:new URL(request.url()).pathname+new URL(request.url()).search,body:request.postData()});});
  await page.evaluate(()=>{document.activeElement.blur();location.hash='#home';});await page.waitForSelector('.journey');
  const history=await page.evaluate(()=>api('/api/history?stage=home'));assert.equal(history.undo.label,'rename');assert.equal(history.undo_stream,'group');
  let changed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/undo');
  await page.keyboard.press('Escape');await page.click('#menu [data-m=history-undo]');assert.equal((await changed).status(),200);
  const waitName=expected=>page.waitForFunction(async({id,name})=>!HistoryHUD.busy&&(await api('/api/draw/board?per=24')).groups.find(group=>group.id===id)?.name===name,{id:change.id,name:expected});
  await waitName(change.before);
  const redo=page.locator('#history-hud [data-history=redo]');await redo.waitFor();
  assert((await redo.locator('img').getAttribute('src')).includes(`/${history.undo.photo}.jpg`),'Home redo shows the edited group’s actual take');
  await page.screenshot({path:`${OUT}/M-history-home.png`});
  changed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/redo');await redo.click();assert.equal((await changed).status(),200);await waitName(change.after);
  changed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/undo');await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('z');
  try{assert.equal((await changed).status(),200);await waitName(change.before);}
  catch(error){await page.screenshot({path:`${OUT}/M-history-failure.png`});const state=await page.evaluate(async()=>({hash:location.hash,view:S.view,stage:S.stage,busy:HistoryHUD.busy,active:{tag:document.activeElement.tagName,id:document.activeElement.id,classes:document.activeElement.className},dialog:document.querySelector('dialog[open]')?.id,history:await api('/api/history?stage=home')}));throw new Error(`${error.message}\n${JSON.stringify({historyRequests,state})}`);}
  // A second call belongs after the in-flight edit even when its final history refresh is delayed.
  let releaseHistory,historyRead;
  const historyGate=new Promise(resolve=>releaseHistory=resolve),historyPending=new Promise(resolve=>historyRead=resolve);
  await page.route(url=>url.pathname==='/api/history'&&url.search==='?stage=home',async route=>{
    const response=await route.fetch();historyRead();await historyGate;await route.fulfill({response});
  },{times:1});
  const undoCount=historyRequests.filter(request=>request.path==='/api/draw/undo').length;
  changed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/redo');await redo.click();assert.equal((await changed).status(),200);await historyPending;
  assert(await page.evaluate(()=>HistoryHUD.busy),'The final history read remains in flight');
  const queuedUndo=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/undo');
  await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('z');await page.keyboard.press('z');
  assert.equal(historyRequests.filter(request=>request.path==='/api/draw/undo').length,undoCount,'The second call waits for the first edit to reconcile');
  releaseHistory();assert.equal((await queuedUndo).status(),200);await waitName(change.before);
  assert.equal(historyRequests.filter(request=>request.path==='/api/draw/undo').length,undoCount+1,'Repeated Z while busy queues one undo');
  await page.locator('#track [data-stage="filter"]').focus();await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('data-stage'),'stacks');
  assert(await page.locator('#track [data-stage="stacks"] .tlabel').isVisible(),'Keyboard focus reveals the stage name');
  assert(await page.evaluate(()=>{paintTrack();return document.activeElement.dataset.stage==='stacks';}),'HUD refresh retains keyboard focus');
  await page.keyboard.press('Enter');await page.waitForSelector('.stacker');
  assert.equal(await page.locator('#track [aria-current="step"]').getAttribute('data-stage'),'stacks');
  assert.match(await page.locator('#track [aria-current="step"]').getAttribute('aria-label'),/^Stacks: current/);
  assert.equal(await page.locator('#journey-title').textContent(),'Stack');
  assert.equal(await page.locator('#journey-prev').getAttribute('href'),'#filter');
  assert.equal(await page.locator('#journey-next').getAttribute('href'),'#duel?stage=stacks');  // Crown comes before Groups
  assert.equal(await page.locator('#game-help').getAttribute('aria-pressed'),'false','Changing activities keeps help off');
  await page.click('#game-help');assert.equal(await page.locator('#game-help').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>{document.activeElement.blur();location.hash='#home';});await page.waitForSelector('.journey');
  const destination=await page.locator('#journey-next').getAttribute('href');
  await page.keyboard.press('Enter');await page.waitForFunction(hash=>location.hash===hash,destination);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({layouts,problems},null,1));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
