// Drawing follows the same prints through the sorted Stacks sea, an opened fan and the zoomed map.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1500,height:900},reducedMotion:'reduce'});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading);
  // Stacks: every tile is armed; the pen draws a stroke on one and it is kept with the shot.
  await page.goto(BASE+'/#stacks');await page.waitForFunction(()=>World.sea.arrangement&&World.sea.settled);
  const armed=await page.evaluate(()=>({tiles:document.querySelectorAll('.stack-field .ps-item:not(.take)').length,armed:document.querySelectorAll('.stack-field .ps-item:not(.take)[data-belt] > svg.marks').length}));
  assert(armed.tiles>0&&armed.armed===armed.tiles,`Every stack tile is armed: ${JSON.stringify(armed)}`);
  await page.click('#toolbelt [data-tool="pen"]');
  assert.equal(await page.evaluate(()=>document.body.dataset.tool),'pen');
  const tile=page.locator('.stack-field .ps-item:not(.take)').first(),pid=Number(await tile.getAttribute('data-belt')),box=await tile.boundingBox();
  await page.mouse.move(box.x+box.width*.3,box.y+box.height*.3);await page.mouse.down();
  for(let i=1;i<=6;i++)await page.mouse.move(box.x+box.width*(.3+i*.06),box.y+box.height*(.3+i*.05));
  await page.mouse.up();await page.waitForTimeout(500);
  const saved=await page.evaluate(async pid=>(await (await fetch(`/api/edit?photo=${pid}`)).json()).edits,pid);
  assert.equal(saved.marks?.length,1,`The stroke is saved with the shot: ${JSON.stringify(saved)}`);
  assert(saved.marks[0].p.length>=4&&saved.marks[0].t==='pen',`A pen stroke with its points: ${JSON.stringify(saved.marks[0])}`);
  assert.equal(await tile.locator('svg.marks polyline').count(),1,'and drawn on the tile');
  assert.equal(await page.evaluate(()=>!!World.sea.el.dataset.stackFan),false,'A pen stroke does not open the stack');
  await page.screenshot({path:`${OUT}/toolbelt-stacks.png`});
  // Opening a stack exposes separate drawing surfaces for its takes, each saving to that take rather than the cover.
  await page.click('#toolbelt [data-tool="hand"]');
  await page.locator('.stack-field .stack-clip').first().click();await page.waitForFunction(()=>World.sea.settled&&!World.sea.cameraGlide&&World.sea.el.dataset.stackFan);
  const take=page.locator('.stack-field .stack-fan-take').last(),takeId=Number(await take.getAttribute('data-photo'));
  assert.equal(Number(await take.getAttribute('data-belt')),takeId);
  await take.focus();await page.waitForTimeout(250);await page.click('#toolbelt [data-tool="pen"]');
  const old=await page.evaluate(id=>api(`/api/edit?photo=${id}`).then(r=>(r.edits.marks||[]).length),takeId);
  const points=await take.locator(':scope > svg.marks').evaluate(svg=>[new DOMPoint(40,30),new DOMPoint(60,50)].map(p=>{const q=p.matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y};}));
  await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();await page.mouse.move(points[1].x,points[1].y,{steps:5});await page.mouse.up();await page.evaluate(()=>Toolbelt.flush());
  assert.equal(await page.evaluate(id=>api(`/api/edit?photo=${id}`).then(r=>(r.edits.marks||[]).length),takeId),old+1,'The mark belongs to the take under the pen');
  assert(await page.evaluate(()=>!!World.sea.el.dataset.stackFan));assert.equal(await page.locator('#modal[open]').count(),0,'Drawing in the fan does not open a viewer');
  await page.screenshot({path:`${OUT}/toolbelt-stack-take.png`});
  await page.click('#toolbelt [data-tool="hand"]');await page.locator('[data-stack-action=close]').click();await page.waitForFunction(()=>World.sea.settled&&!World.sea.cameraGlide);
  // C frames the tiles by the crop mode; off leaves them to their own look.
  await page.click('#toolbelt [data-tool="hand"]');
  await page.keyboard.press('c');await page.waitForTimeout(300);
  const framed=await page.evaluate(()=>{const img=document.querySelector('.stack-field .ps-item:not(.take) .window img'),r=img.getBoundingClientRect(),w=img.closest('.window').getBoundingClientRect();return {mode:S.crop,filled:r.width>=w.width-1&&r.height>=w.height-1};});
  assert.notEqual(framed.mode,'off');
  assert(framed.filled,`Best crop fills the shared window: ${JSON.stringify(framed)}`);
  for(let k=0;k<4&&await page.evaluate(()=>S.crop!=='off');k++){await page.keyboard.press('c');await page.waitForTimeout(150);}
  const off=await page.evaluate(()=>{const img=document.querySelector('.stack-field .ps-item:not(.take) .window img'),r=img.getBoundingClientRect(),w=img.closest('.window').getBoundingClientRect();return {mode:S.crop,contained:r.width<=w.width+1&&r.height<=w.height+1};});
  assert.deepEqual(off,{mode:'off',contained:true},'Crop off contains the whole photo in its paper');
  // The map: a click zooms a print in (it becomes a live card); the marker draws on it and the stroke follows the shot.
  await page.goto(BASE+'/#home');await page.waitForSelector('.journey');await page.waitForTimeout(800);
  const target=await page.evaluate(()=>{const s=World.sea,r=s.el.getBoundingClientRect(),W=s.el.clientWidth,H=s.el.clientHeight;const it=[...s.items.values()].filter(it=>!it.take).sort((a,b)=>Math.hypot(a.x-W/2,a.y-H/2)-Math.hypot(b.x-W/2,b.y-H/2))[0];const [sx,sy]=s.toScreen(it.x,it.y);return {id:it.id,photo:it.photo,x:r.left+sx,y:r.top+sy};});
  await page.mouse.click(target.x,target.y);await page.waitForTimeout(800);
  const card=await page.evaluate(id=>{const it=World.sea.items.get(id),b=it.el.getBoundingClientRect();return {live:!it.density,belt:it.el.dataset.belt,svg:!!it.el.querySelector(':scope > svg.marks'),x:b.left,y:b.top,w:b.width,h:b.height};},target.id);
  assert(card.live&&card.svg&&Number(card.belt)===target.photo,`The zoomed-in print is armed for its photo: ${JSON.stringify(card)}`);
  await page.click('#toolbelt [data-tool="marker"]');
  const cam0=await page.evaluate(()=>({...World.sea.camera}));
  await page.mouse.move(card.x+card.w*.3,card.y+card.h*.3);await page.mouse.down();
  for(let i=1;i<=6;i++)await page.mouse.move(card.x+card.w*(.3+i*.07),card.y+card.h*.3);
  await page.mouse.up();await page.waitForTimeout(500);
  const onSea=await page.evaluate(async photo=>(await (await fetch(`/api/edit?photo=${photo}`)).json()).edits,target.photo);
  assert.equal((onSea.marks||[]).filter(m=>m.t==='marker').length,1,`The marker stroke is saved with the shot: ${JSON.stringify(onSea)}`);
  const cam1=await page.evaluate(()=>({...World.sea.camera}));
  assert.deepEqual(cam1,cam0,'Drawing on a print does not pan the camera');
  await page.screenshot({path:`${OUT}/toolbelt-map.png`});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({armed,saved:saved.marks.length,framed,off,card,onSea:onSea.marks.length}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
