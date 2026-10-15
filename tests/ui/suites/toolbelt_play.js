// Drawing owns its whole gesture in a real duel. Erasing is local, Z/Shift+Z follow edits rather than old votes,
// pending saves finish before undo, touch taps leave dots, and returning to the hand restores normal play.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
let page;
(async()=>{
  const browser=await chromium.launch({headless:true}),problems=[];
  page=await browser.newPage({viewport:{width:1500,height:900},hasTouch:true});
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.goto(BASE+'/#duel?stage=open');await page.waitForSelector('#stage .side .print[data-belt]');
  await page.waitForFunction(()=>!S.busy&&!World.flights.size);
  let card=page.locator('#stage .side .print').first(),pid=Number(await card.getAttribute('data-belt'));
  await page.evaluate(async pid=>{await api('/api/edit',{photo:pid,marks:[],notes:[]});Toolbelt.know(pid,{});},pid);
  const votes=()=>page.evaluate(async()=>(await api('/api/state')).library.votes);
  const before=await votes(),pair=await page.evaluate(()=>S.current.id);
  const tool=async name=>{await page.click(`#toolbelt [data-tool="${name}"]`);};
  const at=async(x,y)=>card.locator(':scope > svg.marks').evaluate((svg,[x,y])=>{
    const p=new DOMPoint(x,y).matrixTransform(svg.getScreenCTM());return {x:p.x,y:p.y};
  },[x,y]);
  const stroke=async(points)=>{
    const p=await at(...points[0]);await page.mouse.move(p.x,p.y);await page.mouse.down();
    for(const point of points.slice(1)){const p=await at(...point);await page.mouse.move(p.x,p.y,{steps:3});}
    await page.mouse.up();await page.evaluate(()=>Toolbelt.flush());
  };
  const edits=()=>page.evaluate(pid=>api(`/api/edit?photo=${pid}`).then(r=>r.edits),pid);
  const history=async key=>{
    await page.keyboard.press(key);await page.waitForFunction(()=>!HistoryHUD.checking&&!HistoryHUD.busy&&!S.busy);
    await page.waitForTimeout(150);
  };
  await tool('pen');await stroke([[15,45],[30,45],[50,45],[70,45],[85,45]]);
  assert.equal((await edits()).marks.length,1);assert.equal(await votes(),before,'Drawing never votes');
  await tool('marker');await stroke([[20,80]]);
  assert.equal((await edits()).marks.length,2,'A tap leaves a dot');
  await tool('eraser');await stroke([[50,30],[50,60]]);
  const erased=await edits();assert.equal(erased.marks.length,3,'Rubbing the middle leaves two ends and the distant dot');
  assert(erased.marks.filter(m=>m.t==='pen').every(m=>m.p.every(p=>p[0]<48)||m.p.every(p=>p[0]>52)));
  assert.equal(await votes(),before);assert.equal(await page.evaluate(()=>S.current.id),pair,'The same duel stays on screen');
  await history('z');assert.equal((await edits()).marks.length,2,'Z restores the erased middle');
  assert.equal(await votes(),before,'Undoing an erase never undoes a vote');
  await history('Shift+Z');assert.equal((await edits()).marks.length,3,'Shift+Z repeats exactly the local erase');
  await page.locator('#history-hud [data-history=undo] img').click();await page.waitForFunction(()=>!HistoryHUD.checking&&!HistoryHUD.busy);
  assert.equal((await edits()).marks.length,2,'The Undo thumbnail works while the eraser is selected');
  await page.locator('#history-hud [data-history=redo] img').click();await page.waitForFunction(()=>!HistoryHUD.checking&&!HistoryHUD.busy);
  assert.equal((await edits()).marks.length,3,'The Redo thumbnail works too');
  await page.screenshot({path:OUT+'/toolbelt-duel-erased.png'});
  // A note is created when its words are committed: one action and one undo, with native typing on the card.
  await tool('note');const notePoint=await at(20,100);await page.mouse.click(notePoint.x,notePoint.y);
  await page.waitForSelector('#stage .user-note textarea');await page.keyboard.type('lovely light');
  await tool('hand');await page.evaluate(()=>Toolbelt.flush());
  assert.equal((await edits()).notes[0].text,'lovely light');assert.equal(await votes(),before,'Typing on a photo never votes');
  await history('z');assert(!((await edits()).notes||[]).length,'One Z removes the new note');
  await history('Shift+Z');assert.equal((await edits()).notes[0].text,'lovely light');
  // An interrupted gesture is discarded; its later release cannot click the contender underneath.
  await tool('pen');const start=await at(60,90),end=await at(80,90);
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y);
  await card.locator(':scope > svg.marks').evaluate(svg=>svg.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
  await page.mouse.up();await page.waitForTimeout(200);
  assert.equal((await edits()).marks.length,3);assert.equal(await votes(),before,'Cancellation leaves both marks and votes alone');
  // Hold the save reply and ask to undo before it arrives.
  let release,arrived;const gate=new Promise(r=>{release=r;}),pending=new Promise(r=>{arrived=r;});
  await page.route('**/api/edit',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    const response=await route.fetch();arrived();await gate;await route.fulfill({response});
  },{times:1});
  const a=await at(60,90),b=await at(80,90);
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:5});await page.mouse.up();await pending;
  await page.keyboard.press('z');release();
  await page.waitForFunction(()=>!Toolbelt.saving.size&&!HistoryHUD.checking&&!HistoryHUD.busy);
  assert.equal((await edits()).marks.length,3,'Undo waits for the stroke to save, then removes that stroke');
  await tool('marker');const tap=await at(75,110);
  await page.evaluate(()=>{window.touchTrace=[];for(const type of ['pointerdown','pointerup','pointercancel','click'])window.addEventListener(type,e=>touchTrace.push({type,id:e.pointerId,button:e.button,pointer:e.pointerType,target:e.target.outerHTML.slice(0,250),x:e.clientX,y:e.clientY,tool:Toolbelt.tool,gesture:!!Toolbelt.gesture}),true);});
  await page.touchscreen.tap(tap.x,tap.y);await page.evaluate(()=>Toolbelt.flush());
  if((await edits()).marks.length!==4)console.error(JSON.stringify({tap,debug:await page.evaluate(()=>({touchTrace,toast:document.querySelector('#toast').textContent,rect:document.querySelector('#stage .side .print').getBoundingClientRect().toJSON(),gesture:!!Toolbelt.gesture,saving:Toolbelt.saving.size,local:Toolbelt.current(Number(document.querySelector('#stage .side .print').dataset.belt))}))}));
  assert.equal((await edits()).marks.length,4,'A touch tap draws without starting a native pan');
  assert.equal(await votes(),before);assert.equal(await page.evaluate(()=>S.current.id),pair);
  await page.screenshot({path:OUT+'/toolbelt-duel-notes.png'});
  await tool('hand');const pick=await at(80,30);await page.mouse.click(pick.x,pick.y);
  await page.waitForFunction(async before=>(await api('/api/state')).library.votes===before+1,before);
  // Crown and Finals have their own click handlers; drawing and undo leave each pending match untouched too.
  for(const [name,hash,selector]of [['crown','#duel?stage=stacks','#stage.mini-stage'],['finals','#finals','#f-arena']]){
    await page.goto(BASE+'/'+hash);
    if(name==='finals'){await page.waitForSelector('#journey-next.ready');await page.click('#journey-next');}
    await page.waitForSelector(selector+' .print[data-belt]');await page.waitForFunction(()=>!S.busy&&!World.flights.size);
    card=page.locator(selector+' .side .print').first();pid=Number(await card.getAttribute('data-belt'));
    const previous=(await edits()).marks||[],n=await votes(),photos=await page.locator(selector+' .side').evaluateAll(es=>es.map(e=>e.dataset.photo));
    await tool('pen');await stroke([[20,25],[40,25],[70,25]]);
    assert.equal((await edits()).marks.length,previous.length+1,`${name}: the stroke is saved`);
    await history('z');assert.deepEqual((await edits()).marks||[],previous,`${name}: undo removes the drawing`);
    assert.equal(await votes(),n,`${name}: neither drawing nor undo casts or retracts a vote`);
    assert.deepEqual(await page.locator(selector+' .side').evaluateAll(es=>es.map(e=>e.dataset.photo)),photos,`${name}: the same match stays put`);
    await page.screenshot({path:OUT+`/toolbelt-${name}.png`});
  }
  assert.equal(await page.locator('#history-hud [data-belt]').count(),0,'History thumbnails are controls, not drawing surfaces');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({photo:pid,votesBefore:before,votesAfter:await votes(),erased:erased.marks.length,problems}));
  await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page)await page.screenshot({path:OUT+'/toolbelt-play-failure.png'}).catch(()=>{});process.exit(1);});
