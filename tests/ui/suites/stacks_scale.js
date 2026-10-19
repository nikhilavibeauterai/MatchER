// Hundreds of stacks use bounded live paper; combining two preserves every other physical photo.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {boot,ready,drag,synthetic}=require('./stack-helpers.cjs');
const {BASE,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[];
  page.on('pageerror',e=>problems.push(e.message));await boot(page);const state=await synthetic(page,{count:720,takes:6});
  await page.goto(BASE+'/#stacks');await ready(page,720);
  assert(state.requests.length<=2,'All stack metadata arrives in bounded pages');
  const before=await page.evaluate(()=>{window.stackObjects=new Map([...World.sea.items].map(([id,it])=>[id,it.el]));return {live:World.sea.moving.length,all:World.sea.items.size};});
  assert.equal(before.all,4320);assert(before.live<=160,'Small papers stay on the GPU');
  const a=state.rows.at(-2).rep,b=state.rows.at(-1).rep,start=performance.now(),requests=state.requests.length;
  await drag(page,a,b);await ready(page,719);const elapsed=performance.now()-start;
  assert.equal(state.merges.length,1);assert(state.requests.length-requests<=2,'A merge does not page through thumbnails');
  const after=await page.evaluate(()=>({same:[...World.sea.items].every(([id,it])=>stackObjects.get(id)===it.el),live:World.sea.moving.length,clones:document.querySelectorAll('#main img').length,blank:World.sea.densityStats?.blank||0}));
  assert(after.same,'Every photo keeps its actual paper object');assert.equal(after.clones,0);assert(after.live<=160);assert.equal(after.blank,0);
  assert(elapsed<5000,`Merge response took ${elapsed}ms`);await page.screenshot({path:OUT+'/stacks-scale-merged.png'});
  await page.keyboard.press('z');await ready(page,720);await page.keyboard.press('Shift+z');await ready(page,719);
  await page.click('[data-stack-overview]');await page.waitForFunction(()=>World.sea.camera.zoom===1);await page.waitForTimeout(220);
  await page.screenshot({path:OUT+'/stacks-scale-overview.png'});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({before,after,elapsed,requests:state.requests,problems}));await browser.close();
})().catch(e=>{console.error(e.stack);process.exit(1);});
