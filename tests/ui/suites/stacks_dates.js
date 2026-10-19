// Every date is indexed once; date jumps move the shared camera without fetching image catalogues.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {boot,ready,synthetic}=require('./stack-helpers.cjs');const {BASE,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[];
  page.on('pageerror',e=>problems.push(e.message));await boot(page);const state=await synthetic(page,{count:720,takes:1,first:180000});
  await page.goto(BASE+'/#stacks');await ready(page,720);await page.click('[data-stack-order=time]');await page.waitForSelector('[data-date-jump]');await ready(page,720);
  assert.equal(await page.locator('[data-date-jump] option').count(),144);
  const last=state.rows.at(-1),day=last.taken.slice(0,10),before=state.requests.length;
  await page.selectOption('[data-date-jump]',day);await page.waitForFunction(()=>World.sea.camera.zoom>1&&!World.sea.cameraGlide);
  const desktop=await page.evaluate(id=>{const it=World.sea.items.get(id),[x,y]=World.sea.toScreen(it.x,it.y);return {x,y,zoom:World.sea.camera.zoom};},last.rep);
  assert(desktop.y>100&&desktop.y<700);assert.equal(state.requests.length,before,'Jumping uses the indexed arrangement');
  await page.screenshot({path:OUT+'/K-dates-desktop.png'});await page.click('[data-date-step="-1"]');
  await page.waitForFunction(day=>document.querySelector('[data-date-jump]').value!==day,day);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(450);await page.click('[data-stack-overview]');
  const phone=await page.locator('.date-jump').evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert(phone.left>=0&&phone.right<=390&&!phone.overflow&&phone.width>140,JSON.stringify(phone));
  await page.screenshot({path:OUT+'/K-dates-phone.png'});assert.deepEqual(problems,[]);console.log(JSON.stringify({desktop,phone,requests:state.requests,problems}));await browser.close();
})().catch(e=>{console.error(e.stack);process.exit(1);});
