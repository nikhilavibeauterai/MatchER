// Paperclips unfold the existing takes in place, with the same camera and stable edits on desktop and phone.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {boot,ready,synthetic}=require('./stack-helpers.cjs');const {BASE,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[],layouts=[];
  page.on('pageerror',e=>problems.push(e.message));await boot(page);const state=await synthetic(page,{count:160,takes:8});
  await page.goto(BASE+'/#stacks');await ready(page,160);const shot=state.rows.at(-1);
  await page.evaluate(id=>{window.fanObjects=new Map([...World.sea.items].map(([id,it])=>[id,it.el]));World.openStack(id);},shot.rep);
  await page.waitForFunction(()=>!!document.querySelector('#world').dataset.stackFan&&World.sea.settled&&!World.sea.cameraGlide);
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(450);await page.evaluate(()=>World.stackStage.refresh());
    await ready(page,160);await page.waitForTimeout(200);
    await page.evaluate(()=>{const sea=World.sea,ids=[...sea.focusIds],p=sea.items.get(ids[0]);if(p)sea.glideCamera({zoom:1,tx:0,ty:0});});
    await page.waitForTimeout(400);
    const layout=await page.evaluate(ids=>({fan:ids.map(id=>{const it=World.sea.items.get(id);return {id,take:it.take,x:it.x,y:it.y,same:it.el===fanObjects.get(id)};}),overflow:document.documentElement.scrollWidth>innerWidth,
      tools:document.querySelector('.stack-tools').getBoundingClientRect().toJSON(),clones:document.querySelectorAll('#main img').length}),shot.members);
    assert(layout.fan.every(p=>p.same&&!p.take));assert.equal(new Set(layout.fan.map(p=>`${p.x},${p.y}`)).size,8);assert(!layout.overflow);assert.equal(layout.clones,0);
    assert(layout.tools.left>=0&&layout.tools.right<=viewport.width);layouts.push(layout);await page.screenshot({path:OUT+'/K-stack-'+viewport.width+'.png'});
  }
  const chosen=shot.members.at(-1);await page.evaluate(id=>World.sea.onFocus(World.sea.items.get(id)),chosen);
  await page.click('[data-stack-action=keep]');await page.waitForFunction(id=>document.querySelector('#world').dataset.stackFan===String(id),chosen);await ready(page,160);
  assert.equal(state.rows.at(-1).rep,chosen);assert(await page.evaluate(()=>[...World.sea.items].every(([id,it])=>it.el===fanObjects.get(id))));
  await page.click('[data-stack-action=split]');await ready(page,161);await page.keyboard.press('z');await ready(page,160);
  await page.click('[data-stack-action=close]');await page.waitForFunction(()=>!document.querySelector('#world').dataset.stackFan);
  await page.goto(BASE+'/#home');await page.waitForSelector('.journey');assert(await page.evaluate(()=>!World.sea.arrangement&&!World.sea.onFocus),'Leaving Stacks releases its arrangement and handlers');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({layouts,problems}));await browser.close();
})().catch(e=>{console.error(e.stack);process.exit(1);});
