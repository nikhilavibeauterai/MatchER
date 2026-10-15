// Real map drags merge whole stacks, keep the destination's group, and share the editor's Undo/Redo.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[],merges=[],moves=[];
  page.on('pageerror',e=>problems.push(e.message));
  page.on('request',r=>{if(r.method()!=='POST')return;
    if(new URL(r.url()).pathname==='/api/groups/merge')merges.push(r.postDataJSON());
    if(new URL(r.url()).pathname==='/api/draw/move')moves.push(r.postDataJSON());
  });
  // The bundled public-domain demo has a real five-take stack and distinct single shots.
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.click('#sample');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const ready=async()=>{await page.waitForTimeout(200);await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.photosSource===S.lib?.source&&!World.sea.bodyTimer&&World.sea.settled&&!HistoryHUD.busy&&!HistoryHUD.checking,null,{timeout:60000});};
  await ready();
  const shots=()=>page.evaluate(()=>api('/api/groups?view=all&per=500').then(r=>r.shots));
  const original=await shots(),identity=rows=>rows.map(s=>[...s.members].sort((a,b)=>a-b).join(',')).sort();
  const singles=original.filter(s=>s.members.length===1),stack=original.find(s=>s.members.length>1);
  assert(singles.length>=4&&stack,'The demo contains singles and a stack');
  const center=id=>page.evaluate(id=>{const s=World.sea,it=s.items.get(id),r=s.el.getBoundingClientRect(),[x,y]=s.toScreen(it.x,it.y);return {x:r.left+x,y:r.top+y};},id);
  const press=async id=>{const p=await center(id);await page.mouse.move(p.x,p.y);await page.mouse.down();
    assert.equal(await page.evaluate(()=>World.sea.drag?.items[0].id),id,'The Hand grabs the actual map print');return p;};
  const over=async id=>{const p=await center(id);await page.mouse.move(p.x,p.y,{steps:12});
    try{await page.waitForFunction(id=>World.sea.dropTarget?.id===id&&World.sea.dropTarget.el.classList.contains('ps-hot'),id,{timeout:5000});}
    catch(error){await page.screenshot({path:OUT+'/map-stack-drop-failure.png'});throw new Error(error.message+' '+JSON.stringify(await page.evaluate(id=>({wanted:id,point:{x:World.sea.mouse.x,y:World.sea.mouse.y},drag:World.sea.drag?.items.map(it=>it.id),moving:World.sea.drag?.moving,target:World.sea.dropTarget?.id,items:[...World.sea.items.values()].filter(it=>!it.take).map(it=>({id:it.id,x:it.x,y:it.y,size:it.size}))}),id)));}
    return page.evaluate(()=>({id:World.sea.dropTarget.id,x:World.sea.dropTarget.x,y:World.sea.dropTarget.y,held:World.sea.held,hint:World.sea.hint.textContent,hidden:World.sea.hint.hidden}));};
  const history=async kind=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/draw/${kind}`&&r.request().method()==='POST');
    await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press(kind==='undo'?'z':'Shift+z');assert.equal((await response).status(),200);await ready();};
  const merge=async(source,destination,screenshot)=>{
    const before=merges.length;await press(source);const hot=await over(destination);
    assert.equal(hot.held,destination);assert.equal(hot.hint,'Drop to stack');assert(!hot.hidden);
    await page.waitForTimeout(500);
    const still=await center(destination);const screen=await page.evaluate(({x,y})=>World.sea.toScreen(x,y),hot);
    assert(Math.hypot(still.x-screen[0],still.y-screen[1])<1,'The target stays still while the dragged print overlaps it');
    if(screenshot)await page.screenshot({path:OUT+`/${screenshot}.png`});
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/groups/merge'&&r.request().method()==='POST');
    await page.mouse.up();assert.equal((await response).status(),200);await ready();
    assert.equal(merges.length,before+1,'One drop is one merge');
    assert.deepEqual(merges.at(-1).photos,[source,destination]);
    assert.equal(await page.locator('#world .ps-hot').count(),0);assert(await page.locator('#world .vn-hint').isHidden());
  };
  // Two singles become one stack, and a normal Z / Shift+Z reverses and repeats that one change.
  const a=singles[0].rep,b=singles[1].rep;
  await merge(a,b,'map-stack-target');
  let changed=await shots(),joined=changed.find(s=>s.members.includes(a));
  assert.deepEqual([...joined.members].sort((x,y)=>x-y),[a,b].sort((x,y)=>x-y));assert.equal(changed.length,original.length-1);
  await page.screenshot({path:OUT+'/map-stacked.png'});
  await history('undo');assert.deepEqual(identity(await shots()),identity(original));
  await history('redo');assert.equal((await shots()).length,original.length-1);
  await history('undo');assert.deepEqual(identity(await shots()),identity(original));
  // Whole piles merge, including every take; the resulting pile inherits the destination's group.
  await page.evaluate(async({a,stack})=>{await api('/api/draw/new',{photos:[a]});
    await api('/api/draw/new',{photos:[stack]});
  },{a:singles[2].rep,stack:stack.rep});
  await ready();
  const destination=singles[2].rep,source=singles[3].rep;
  await merge(source,destination);
  const pair=(await shots()).find(s=>s.members.includes(destination));
  await merge(pair.rep,stack.rep,'map-stack-piles');
  changed=await shots();joined=changed.find(s=>s.members.includes(stack.rep));
  assert.deepEqual([...joined.members].sort((x,y)=>x-y),[...stack.members,destination,source].sort((x,y)=>x-y));
  const grouped=await page.evaluate(ids=>ids.map(id=>World.photos.get(id).theme),joined.members);
  assert(grouped.every(id=>id===grouped[0]&&id>=0),'Every merged take belongs to the destination group');
  await history('undo');assert((await shots()).some(s=>s.members.length===stack.members.length&&s.members.includes(stack.rep)));
  // Cancelling a highlighted drop restores the original stack and makes no edit.
  const beforeCancel=identity(await shots()),mergeCount=merges.length;
  const currentPair=(await shots()).find(s=>s.members.includes(destination));
  await press(currentPair.rep);await over(stack.rep);await page.dispatchEvent('#world','pointercancel',{pointerId:1});await page.mouse.up();
  await ready();assert.equal(merges.length,mergeCount);assert.deepEqual(identity(await shots()),beforeCancel);
  assert.equal(await page.locator('#world .ps-hot').count(),0);assert(await page.locator('#world .vn-hint').isHidden());
  // Open water still just moves the print; a lasso still files a shot rather than merging nearby paper.
  const water=await page.evaluate(()=>{const s=World.sea;for(let y=180;y<innerHeight-100;y+=35)for(let x=180;x<innerWidth-100;x+=35){
    const el=document.elementFromPoint(x,y);if(s.uiTarget(el))continue;const [wx,wy]=s.toWorld(x,y);
    if(s.target(wx,wy).kind==='sea'&&![...s.items.values()].some(it=>Math.hypot(it.x-wx,it.y-wy)<s.s*2))return {x,y};}return null;});
  assert(water,'Open water away from photos and saved groups');
  await press(currentPair.rep);await page.mouse.move(water.x,water.y,{steps:12});await page.mouse.up();await ready();
  assert.equal(merges.length,mergeCount);assert.deepEqual(identity(await shots()),beforeCancel);
  const filing=await page.evaluate(ids=>api('/api/draw/new',{photos:ids}).then(r=>r.theme.id),[a,b,singles[4].rep]);
  await ready();
  // A scattered group deliberately has no outline. Place its three actual prints close enough to form a shore.
  const neighbourhood=await page.evaluate(()=>{const s=World.sea,prints=[...s.items.values()].filter(it=>!it.take);
    for(let y=220;y<innerHeight-240;y+=40)for(let x=180;x<innerWidth-340;x+=40){const points=[[x,y],[x+150,y],[x+75,y+125]];
      if(points.every(([x,y])=>!s.uiTarget(document.elementFromPoint(x,y))&&prints.every(it=>Math.hypot(x-it.x,y-it.y)>s.s*1.1)))return points;}return null;});
  assert(neighbourhood,'An empty neighbourhood for the three prints');
  for(const [i,id] of [a,b,singles[4].rep].entries()){
    const [x,y]=neighbourhood[i];await press(id);await page.mouse.move(x,y,{steps:12});
    assert.equal(await page.evaluate(()=>World.sea.dropTarget?.id??null),null,'The landing is water');
    await page.mouse.up();await ready();
    assert.equal(merges.length,mergeCount,'Making a neighbourhood in open water does not stack its photos');
  }
  try{await page.waitForFunction(id=>World.sea.contours?.get(`g${id}`)?.paths.length,filing,{timeout:10000});}
  catch(error){await page.screenshot({path:OUT+'/map-stack-shore-failure.png'});throw new Error(error.message+' '+JSON.stringify(await page.evaluate(id=>({id,focus:World.sea.focusState(),shapes:[...(World.sea.contours||[])].map(([id,s])=>({id,paths:s.paths,count:s.count})),bodies:World.sea.bodies.map(b=>({id:b.id,label:b.label,group:World.sea.items.get(b.id).group,x:World.sea.items.get(b.id).x,y:World.sea.items.get(b.id).y,size:World.sea.items.get(b.id).size}))}),filing)));}
  const shore=await page.evaluate(id=>{const s=World.sea;for(let y=170;y<innerHeight-80;y+=8)for(let x=120;x<innerWidth-80;x+=8){
    if(s.uiTarget(document.elementFromPoint(x,y)))continue;const t=s.target(x,y);if(t.kind==='group'&&t.id===id)return {x,y,id:t.id};}return null;},filing);
  if(!shore){await page.screenshot({path:OUT+'/map-stack-shore-failure.png'});throw new Error('No saved group water: '+JSON.stringify(await page.evaluate(id=>({id,focus:World.sea.focusState(),shapes:[...(World.sea.contours||[])],bodies:World.sea.bodies.map(b=>({id:b.id,label:b.label,x:World.sea.items.get(b.id).x,y:World.sea.items.get(b.id).y}))}),filing)));}
  const spare=await page.evaluate(excluded=>[...World.sea.items.values()].find(it=>!it.take&&!it.cut&&!excluded.includes(it.id))?.id,[a,b,singles[4].rep,currentPair.rep,stack.rep]);
  assert(spare,'An eligible single remains outside the group');
  const filed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/move'&&r.request().method()==='POST');
  await press(spare);await page.mouse.move(shore.x,shore.y,{steps:12});await page.mouse.up();assert.equal((await filed).status(),200);await ready();
  assert.equal(merges.length,mergeCount);assert.equal(moves.at(-1).theme,shore.id);assert.equal(await page.evaluate(id=>World.photos.get(id).theme,spare),shore.id);
  await history('undo');
  // At density LOD the destination is an atlas sprite until the actual drag reaches it.
  await page.evaluate(()=>World.sea.releaseFocus());await ready();
  const density=await page.evaluate(()=>{const s=World.sea;for(const it of s.moving){if(it.take)continue;it.density=true;s.smallPreview(it);it.el.replaceChildren();it.el.remove();}
    s.moving=s.moving.filter(it=>!it.density);s.densityDirty=s.spritesDirty=true;s.drawDensity(innerWidth,innerHeight);return [...s.items.values()].filter(it=>!it.take&&it.x>120&&it.x<innerWidth-120&&it.y>170&&it.y<innerHeight-100).map(it=>it.id);});
  assert(density.length>2);
  await press(density[0]);await over(density[1]);
  assert(await page.evaluate(id=>!World.sea.items.get(id).density&&World.sea.items.get(id).el.isConnected,density[1]),'An atlas target becomes a highlighted card');
  await page.dispatchEvent('#world','pointercancel',{pointerId:1});await page.mouse.up();await ready();
  assert.equal(merges.length,mergeCount);
  // At a closer map zoom, the pointer and the target still meet in the same world coordinates.
  await page.evaluate(([a,b])=>{const s=World.sea,first=s.items.get(a),second=s.items.get(b),[x,y]=s.toScreen((first.x+second.x)/2,(first.y+second.y)/2);s.zoomAt(1.6,x,y);},[a,b]);await ready();
  await merge(a,b,'map-stack-zoomed');
  assert.equal(await page.evaluate(()=>World.sea.camera.zoom),1.6,'Stacking keeps the current camera');
  await history('undo');assert.deepEqual(identity(await shots()),beforeCancel);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({shots:original.length,merges:merges.length,moves:moves.length,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
