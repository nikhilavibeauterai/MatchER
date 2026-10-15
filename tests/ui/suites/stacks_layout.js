// Last-column families open in place; edits keep the loaded window and reached-for stack stable.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env,FIRST=70000;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:2048,height:1152},hasTouch:true});
  const problems=[],layouts=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading);
  const thumbnail=await page.evaluate(()=>T(World.photos.values().next().value.id));
  const image=await page.request.get(new URL(thumbnail,BASE).href);assert(image.ok());const pixels=await image.body();
  await page.route(/\/img\/[tp]\/\d+\.jpg(?:\?|$)/,r=>{
    const id=Number(new URL(r.request().url()).pathname.match(/\/(\d+)\.jpg$/)[1]);
    return id>=FIRST&&id<FIRST+1280?r.fulfill({contentType:'image/jpeg',body:pixels}):r.continue();
  });
  let rows=[],history=[],pairs=[];
  const reset=()=>{rows=Array.from({length:160},(_,i)=>({rep:FIRST+i*8,members:Array.from({length:8},(_,j)=>FIRST+i*8+j),family:Math.floor(i/2)}));history=[];};reset();
  await page.route('**/api/groups?*',r=>{
    const q=new URL(r.request().url()).searchParams;
    if(q.get('view')==='suggest')return r.fulfill({json:{suggestions:pairs}});
    if(q.get('view')!=='stacks')return r.continue();
    const page=Number(q.get('page')||0),per=Number(q.get('per')||120);
    return r.fulfill({json:{shots:rows.slice(page*per,(page+1)*per),boxes:{},undo:history.length?'keep':null,
      total:rows.length,page,pages:Math.ceil(rows.length/per)}});
  });
  // Layout actions change only the synthetic response, never the fixture library's votes or stacks.
  await page.route('**/api/frame',r=>{
    const {photo}=r.request().postDataJSON();history.push(structuredClone(rows));
    rows.find(x=>x.members.includes(photo)).rep=photo;return r.fulfill({json:{ok:true}});
  });
  await page.route('**/api/draw/undo',r=>{rows=history.pop()||rows;return r.fulfill({json:{undone:'keep',next:null}});});
  for(const [name,width,height]of [['wide',2048,1152],['phone',390,844]]){
    reset();await page.setViewportSize({width,height});await page.goto(BASE+'/#home');await page.waitForSelector('.journey');
    await page.goto(BASE+'/#stacks');await page.waitForSelector('.stacker .fam-tiles');
    assert.equal(await page.locator('.stacker .screen-rail').count(),0,'An empty twins rail has no place on screen');
    const lastColumn=await page.evaluate(()=>{
      const grid=document.querySelector('.stacker .lookgrid'),children=[...grid.children],top=Math.min(...children.map(e=>e.getBoundingClientRect().top));
      const last=children.filter(e=>Math.abs(e.getBoundingClientRect().top-top)<2).sort((a,b)=>b.getBoundingClientRect().right-a.getBoundingClientRect().right)[0];
      return Number(last.querySelector('.tile:last-child').dataset.dragShot);
    });
    await page.click(`[data-expand="${lastColumn}"]`);await page.waitForSelector('.tile.open .photo-fan');await page.waitForTimeout(350);
    const fan=page.locator('.tile.open .photo-fan');
    await fan.locator('.ftile').last().focus();await page.waitForTimeout(250);
    const layout=await page.evaluate(()=>{
      const body=document.querySelector('.stacker .screen-body'),grid=body.querySelector('.lookgrid'),tile=body.querySelector('.tile.open'),fan=tile.querySelector('.photo-fan');
      const b=body.getBoundingClientRect(),g=grid.getBoundingClientRect(),t=tile.getBoundingClientRect(),f=fan.getBoundingClientRect();
      return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,bodyWidth:body.clientWidth,bodyScroll:body.scrollWidth,
        gridWidth:g.width,tileWidth:t.width,fanWidth:f.width,tileLeft:t.left,gridLeft:g.left,
        buttons:[...fan.lastElementChild.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};}),
        fanLeft:f.left,fanRight:f.right,inside:t.left>=b.left&&t.right<=b.right};
    });
    assert(layout.pageWidth<=width&&layout.bodyScroll<=layout.bodyWidth+1,`${name}: sideways overflow ${JSON.stringify(layout)}`);
    await page.screenshot({path:`${OUT}/K-stacks-${name}.png`});
    assert(layout.tileWidth>=layout.gridWidth-52&&layout.inside,`${name}: expanded family stayed in a narrow column ${JSON.stringify(layout)}`);
    assert(layout.fanWidth>180,`${name}: fan is too narrow to use`);
    assert(layout.buttons.every(b=>b.width>30&&b.left>=layout.fanLeft&&b.right<=layout.fanRight),`${name}: keep/split controls are clipped`);
    const chosen=Number(await fan.locator('[data-keep]').last().getAttribute('data-keep'));
    await fan.locator('[data-keep]').last().click();
    await page.waitForSelector(`.tile.open[data-drag-shot="${chosen}"]`);
    assert.equal(await page.locator('.stacker [data-drag-shot]').count(),120);
    await page.keyboard.press('z');await page.waitForSelector(`.tile.open[data-drag-shot="${lastColumn}"]`);
    await page.screenshot({path:`${OUT}/K-stacks-${name}-undo.png`});layouts.push({name,...layout});
  }
  // Keep the whole loaded window after a lower-page edit, not just the first 120 stacks.
  await page.setViewportSize({width:1200,height:900});
  await page.locator('.stacker .screen-body').evaluate(e=>e.scrollTop=e.scrollHeight);
  await page.waitForFunction(()=>document.querySelectorAll('.stacker [data-drag-shot]').length===160);
  const last=rows.at(-1).rep;await page.click(`[data-expand="${last}"]`);await page.waitForSelector(`.tile.open[data-drag-shot="${last}"]`);
  await page.locator('.tile.open .ftile').last().focus();await page.waitForTimeout(250);
  await page.evaluate(()=>{
    window.stackTrace=[];window.stackGeometry=label=>{const body=document.querySelector('.stacker .screen-body'),tile=body.querySelector('.tile.open'),b=body.getBoundingClientRect(),t=tile.getBoundingClientRect();return {label,scroll:body.scrollTop,max:body.scrollHeight-body.clientHeight,body:{top:b.top,height:b.height},tile:{top:t.top,height:t.height},focus:document.activeElement?.outerHTML.slice(0,150)};};
    stackTrace.push(stackGeometry('before'));document.addEventListener('pointerdown',e=>stackTrace.push({...stackGeometry('pointerdown'),keep:Number(e.target.closest('[data-keep]')?.dataset.keep)}),{once:true,capture:true});
  });
  const chosen=Number(await page.locator('.tile.open [data-keep]').last().getAttribute('data-keep'));
  await page.locator('.tile.open [data-keep]').last().click();await page.waitForSelector(`.tile.open[data-drag-shot="${chosen}"]`);
  assert.equal(await page.locator('.stacker [data-drag-shot]').count(),160);
  // Playwright may scroll an animated button into view before dispatching the pointer event.
  // The mutation must preserve the position actually clicked, not that earlier test preparation.
  const clicked=await page.evaluate(()=>stackTrace.find(x=>x.label==='pointerdown'));
  assert.equal(clicked?.keep,chosen,'The scroll baseline belongs to the intended Keep action');
  const before=clicked.tile.top-clicked.body.top;
  const after=await page.locator('.tile.open').evaluate(e=>e.getBoundingClientRect().top-e.closest('.screen-body').getBoundingClientRect().top);
  if(Math.abs(after-before)>=3){console.error(JSON.stringify(await page.evaluate(()=>[...stackTrace,stackGeometry('after')])));await page.screenshot({path:`${OUT}/K-stack-scroll-fail.png`});}
  assert(Math.abs(after-before)<3,`Edited stack jumped from ${before}px to ${after}px`);
  pairs=[{a:FIRST,b:FIRST+8,similarity:.94}];await page.goto(BASE+'/#home');await page.waitForSelector('.journey');await page.goto(BASE+'/#stacks');
  await page.waitForSelector('.stacker .twin-row');assert.equal(await page.locator('.stacker.no-rail').count(),0);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({layouts,scroll:{before,after},problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
