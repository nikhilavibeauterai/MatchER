// A Crown choice belongs to its current stack and flows back into every earlier view, including undo.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
let page;const problems=[],res={};
(async()=>{
  const browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.addInitScript(()=>localStorage.setItem('matcher-groups-view','list'));
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode="gallery"]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const setup=await page.evaluate(async()=>{
    const b=await api('/api/draw/board?per=400&uper=400'),stack=b.unsorted.shots.find(x=>x.members.length>3);
    const copies=[stack.members[0],stack.members.at(-1)];
    for(const photo of stack.members.filter(id=>!copies.includes(id)))await api('/api/groups/split',{photo});
    // The offline demo's first/last takes can be pixel twins. Keep those for the duplicate-only check;
    // use visibly different public pictures for the Crown match and the later extra challenger.
    const singles=b.unsorted.shots.filter(x=>x.members.length===1);
    const ids=[stack.members.find(id=>!copies.includes(id)),singles[0].rep];
    await api('/api/groups/merge',{photos:ids});
    await api('/api/draw/auto',{});return {retained:ids,added:singles[1].rep};
  });
  const target=await page.evaluate(async ids=>{
    const b=await api('/api/draw/board?per=400&uper=400');
    for(const group of b.groups){const stack=group.shots.find(x=>x.members.length===2&&ids.every(id=>x.members.includes(id)));if(stack)return {...stack,theme:group.id};}
  },setup.retained);
  assert(target,'Public fixture has a grouped two-take stack');
  const manual=target.members.find(id=>id!==target.rep),winner=target.rep;
  res.target={members:target.members,theme:target.theme,manual,winner};
  const go=async(hash,ready)=>{
    await page.goto(BASE+'/#'+hash);
    if(ready==='.sorter:not(.sea-view)'){
      await page.waitForSelector('.sorter');if(await page.locator('.sorter.sea-view').count())await page.click('[data-mode=list]');
    }
    await page.waitForSelector(ready);
  };
  const choose=async photo=>{
    // The entrance flight and wobble need not stop; the visible centre must belong to the intended take.
    const point=await page.waitForFunction(id=>{
      const el=document.querySelector(`#stage .side[data-photo="${id}"]`),img=el?.querySelector('img'),r=el?.getBoundingClientRect();
      if(S.busy||!img?.complete||+getComputedStyle(img).opacity<.95||!r||r.width<100||r.height<100)return false;
      const x=r.left+r.width/2,y=r.top+r.height/2;
      return document.elementFromPoint(x,y)?.closest('#stage .side')===el?{x,y}:false;
    },photo);
    const {x,y}=await point.jsonValue();await page.mouse.click(x,y);
  };
  const imageId=img=>Number(new URL(img.getAttribute('src'),location.href).pathname.match(/\/(\d+)\.jpg$/)[1]);
  const cover=async(rep,kind)=>{
    await go(kind==='stacks'?'stacks':'draw',kind==='stacks'?'.stacker':'.sorter:not(.sea-view)');
    if(kind==='stacks'){
      await page.waitForFunction(()=>World.sea.arrangement&&World.sea.settled);
      const tile=page.locator(`.stack-field .ps-item[data-id="${rep}"]`);assert.equal(await tile.locator('.pile-cover').evaluate(imageId),rep);
      await tile.locator('.stack-clip').click();await page.mouse.move(5,180);await page.waitForFunction(()=>World.sea.el.dataset.stackFan&&World.sea.settled&&!World.sea.cameraGlide);
      assert.deepEqual((await page.locator('.stack-fan-take').evaluateAll(es=>es.map(e=>Number(e.dataset.photo)))).sort((a,b)=>a-b),[...target.members].sort((a,b)=>a-b));
      await page.screenshot({path:`${OUT}/R-crown-${kind}-${rep}.png`});return;
    }
    const selector=kind==='stacks'?`[data-drag-shot="${rep}"]`:`[data-sel="${rep}"]`;
    const tile=page.locator(`.tile${selector}`);await tile.waitFor();
    assert.equal(await tile.locator('.shot-select > .pile-cover').evaluate(imageId),rep);
    if(kind==='groups')assert.equal(await tile.evaluate(e=>Number(e.closest('.gsec').dataset.dropGroup)),target.theme,'Crowning retains the themed group');
    await tile.locator('[data-expand]').click();await page.waitForSelector('.tile.open .photo-fan');
    assert.equal(await page.locator('.tile.open .ftile.kept img').evaluate(imageId),rep);
    assert.deepEqual((await page.locator('.tile.open [data-split]').evaluateAll(es=>es.map(e=>Number(e.dataset.split)))).sort((a,b)=>a-b),[...target.members].sort((a,b)=>a-b));
    await page.waitForTimeout(650);await page.screenshot({path:`${OUT}/R-crown-${kind}-${rep}.png`});
  };
  const duplicate=await page.evaluate(async()=>{
    const b=await api('/api/draw/board?per=400&uper=400');return b.groups.flatMap(g=>g.shots).find(x=>x.members.length>1&&x.crownable===false);
  });
  assert(duplicate,'The fixture also has a duplicate-only stack');
  for(const kind of ['stacks','groups']){
    await go(kind==='stacks'?'stacks':'draw',kind==='stacks'?'.stacker':'.sorter:not(.sea-view)');
    if(kind==='stacks'){
      await page.waitForFunction(()=>World.sea.arrangement&&World.sea.settled);
      await page.locator(`.stack-field [data-open-stack="${duplicate.rep}"]`).click();
      await page.mouse.move(5,180);
      await page.waitForFunction(()=>World.sea.el.dataset.stackFan&&World.sea.settled);
      assert.equal(await page.locator('.stack-tools .crown-btn').count(),0,'Identical takes do not offer an unusable Crown match');continue;
    }
    await page.locator(`[data-expand="${duplicate.rep}"]`).click();await page.waitForSelector('.tile.open .photo-fan');
    assert.equal(await page.locator('.tile.open .crown-btn').count(),0,'Identical takes do not offer an unusable Crown match');
  }
  // A manual Keep is an earlier-stage edit. Explicit Crown must still open this exact stack afterward.
  await cover(target.rep,'groups');await page.locator(`.tile.open [data-keep="${manual}"]`).click();
  await page.waitForSelector(`.tile.open[data-sel="${manual}"]`);
  await page.locator('.tile.open .crown-btn').click();await page.waitForSelector('#stage.mini-stage');
  await page.waitForFunction(ids=>S.stage==='stacks'&&S.current?.frames?.every(id=>ids.includes(id)),target.members);
  assert.equal(new URL(page.url()).hash,'#duel?stage=stacks');assert(!await page.locator('#hud-bolt').isVisible());
  await page.reload();await page.waitForSelector('#stage.mini-stage');
  assert.equal(await page.evaluate(()=>S.stage),'stacks','Reload remains in Crown');
  assert.deepEqual((await page.evaluate(()=>S.current.frames)).sort((a,b)=>a-b),[...target.members].sort((a,b)=>a-b),'Crown resumes the requested stack');
  await page.waitForFunction(id=>World.board&&[World.board.unsorted,...World.board.groups].some(g=>g.shots.some(x=>x.rep===id)),manual);
  const before=await page.evaluate(()=>({left:S.stacksLeft,actual:S.progress.crown_left}));assert.equal(before.left,before.actual);
  await choose(winner);
  await page.waitForFunction(id=>!S.busy&&S.stagePhotos.includes(id),winner);
  const after=await page.evaluate(()=>({left:S.stacksLeft,actual:S.progress.crown_left}));assert.equal(after.left,after.actual);assert.equal(after.left,before.left-1);
  await page.waitForFunction(id=>World.board&&[World.board.unsorted,...World.board.groups].some(g=>g.shots.some(x=>x.rep===id)),winner);
  await page.waitForFunction(id=>{const it=World.sea.items.get(id);return it?.stack===id&&!it.take&&it.members.length===2;},winner);
  await cover(winner,'stacks');await cover(winner,'groups');
  await page.click('[data-mode=sea]');await page.waitForSelector('.sea-view');
  await page.waitForFunction(id=>{
    const it=World.sea.items.get(id);return it?.stack===id&&!it.take&&it.photo===id&&it.members.length===2;
  },winner);
  assert.equal(await page.evaluate(id=>Number(new URL(World.sea.items.get(id).el.querySelector('.pile-cover').src).pathname.match(/\/(\d+)\.jpg$/)[1]),winner),winner);
  await page.locator(`[data-focus-bin="${target.theme}"]`).click();await page.waitForTimeout(900);
  await page.screenshot({path:OUT+'/R-crown-sea.png'});
  // Undo is the Crown vote history, distinct from the earlier manual Keep edit.
  await go('duel?stage=stacks','#stage');await page.waitForFunction(()=>S.stage==='stacks'&&(S.current||document.querySelector('.stage-done')));
  await page.keyboard.press('z');await page.waitForFunction(ids=>!S.busy&&S.current?.type==='mini'&&S.current.frames.every(id=>ids.includes(id)),target.members);
  const undone=await page.evaluate(()=>({left:S.stacksLeft,actual:S.progress.crown_left}));assert.equal(undone.left,undone.actual);assert.equal(undone.left,before.left);
  await cover(manual,'stacks');await cover(manual,'groups');
  await page.click('[data-mode=sea]');await page.waitForSelector('.sea-view');
  await page.waitForFunction(id=>{const it=World.sea.items.get(id);return it?.stack===id&&!it.take&&it.photo===id;},manual);
  assert.equal(await page.evaluate(id=>Number(new URL(World.sea.items.get(id).el.querySelector('.pile-cover').src).pathname.match(/\/(\d+)\.jpg$/)[1]),manual),manual);
  await page.locator(`[data-focus-bin="${target.theme}"]`).click();await page.waitForTimeout(900);
  await page.screenshot({path:OUT+'/R-crown-undo-sea.png'});
  // Adding a take after a completed Crown reopens the stack, with its previous winner defending.
  await go(`duel?stack=${manual}`,'#stage.mini-stage');
  await choose(manual);
  await page.waitForFunction(id=>!S.busy&&S.stagePhotos.includes(id),manual);
  await go('draw','.sorter:not(.sea-view)');
  const added=setup.added;
  await page.locator(`.tile[data-sel="${manual}"] .shot-select`).click();
  await page.locator(`.tile[data-sel="${added}"] .shot-select`).click();
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/groups/merge')&&r.request().method()==='POST');
  await page.click('[data-sel-act=stack]');assert((await saved).ok());
  const merged=await page.evaluate(async ids=>{
    const b=await api('/api/draw/board?per=400&uper=400');return b.groups.flatMap(g=>g.shots).find(x=>ids.every(id=>x.members.includes(id)));
  },[...target.members,added]);
  assert.equal(merged.members.length,3);
  await page.waitForFunction(id=>document.querySelector(`.tile[data-sel="${id}"] [data-expand]`)?.textContent.includes('3'),merged.rep);
  await page.locator(`[data-expand="${merged.rep}"]`).click();await page.locator('.tile.open .crown-btn').click();
  await page.waitForFunction(ids=>S.current?.type==='mini'&&S.current.frames.length===3&&ids.every(id=>S.current.frames.includes(id)),[...target.members,added]);
  assert.equal(await page.evaluate(()=>S.current.champ),manual,'The former Crown winner defends after a merge');
  assert.equal(await page.evaluate(()=>S.stacksLeft),1,'The changed stack returns to the unfinished Crown count');
  await page.waitForTimeout(900);await page.screenshot({path:OUT+'/R-crown-merged.png'});res.reopened={winner:manual,added};
  assert.deepEqual(problems,[]);console.log(JSON.stringify({...res,before,after,undone,problems}));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack,JSON.stringify({...res,problems}));if(page)await page.screenshot({path:OUT+'/R-crown-fail.png'}).catch(()=>{});process.exit(1);});
