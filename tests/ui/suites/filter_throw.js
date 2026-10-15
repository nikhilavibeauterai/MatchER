// Throwing a print across Filter's line decides it: right of the divider keeps, left of it tosses, each with its
// own undo step; a drop on the side a print already has changes nothing.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const problems=[],decisions=[];page.on('pageerror',e=>problems.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/filter/decision')decisions.push(r.postDataJSON());});
  const api=(path,body)=>page.evaluate(([path,body])=>api(path,body),[path,body]);
  const ready=()=>page.waitForFunction(()=>!!document.querySelector('.filter-shot')&&!document.querySelector('.filter-thinking')&&!document.querySelector('.filter-review[aria-busy="true"]')&&!World.flights?.size&&!S.busy);
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.evaluate(()=>location.hash='#filter');await ready();await page.waitForFunction(()=>World.sea.settled,null,{timeout:30000});
  // A kept print in the sea's DOM, away from the spotlight, and the divider on screen.
  const pick=side=>page.evaluate(side=>{
    const sea=World.sea,flow=sea.outcomeFlow,threshold=flow.threshold,line=sea.outcomeX(threshold),base=sea.el.getBoundingClientRect();
    const it=[...sea.items.values()].find(it=>!it.take&&!it.lifted&&!it.density&&it.el.isConnected&&Number.isFinite(flow.scores[it.id])&&(flow.scores[it.id]>=threshold)===(side==='keep')&&(it.x-line)*(side==='keep'?1:-1)>150&&it.y>200&&it.y<800);
    if(!it)return null;const [sx,sy]=sea.toScreen(it.x,it.y),[lx]=sea.toScreen(line,0);
    return {id:it.id,x:base.left+sx,y:base.top+sy,line:base.left+lx,score:flow.scores[it.id],threshold};
  },side);
  const drag=async(from,toX,toY)=>{await page.mouse.move(from.x,from.y);await page.mouse.down();for(let i=1;i<=12;i++)await page.mouse.move(from.x+(toX-from.x)*i/12,from.y+(toY-from.y)*i/12);await page.mouse.up();};
  const kept=await pick('keep');assert(kept,'A kept print sits right of the line');
  // 1. Thrown to the left: tossed, one decision, the print stays where it was dropped.
  await drag(kept,kept.line-220,kept.y);await ready();await page.waitForTimeout(400);
  assert.deepEqual(decisions.map(d=>[d.action,d.photos]),[['aside',[kept.id]]],JSON.stringify(decisions));
  assert.equal((await api(`/api/filter?photo=${kept.id}`)).photos[0].override,'toss');
  const landed=await page.evaluate(id=>{const it=World.sea.items.get(id);return {x:it.x,line:World.sea.outcomeX(World.sea.outcomeFlow.threshold)};},kept.id);
  assert(landed.x<landed.line,'The thrown print lands on the toss side');
  await page.screenshot({path:OUT+'/FT-thrown-left.png'});
  // 2. Thrown back to the right: kept again.
  const now=await page.evaluate(id=>{const sea=World.sea,it=sea.items.get(id),base=sea.el.getBoundingClientRect(),[sx,sy]=sea.toScreen(it.x,it.y);return {x:base.left+sx,y:base.top+sy};},kept.id);
  await drag(now,kept.line+240,now.y);await ready();await page.waitForTimeout(400);
  assert.equal(decisions.length,2);assert.deepEqual(decisions[1],{...decisions[1],action:'keep',photos:[kept.id]});
  assert.equal((await api(`/api/filter?photo=${kept.id}`)).photos[0].override,'keep');
  // 3. A drop on the same side decides nothing; Z undoes the last throw.
  const again=await page.evaluate(id=>{const sea=World.sea,it=sea.items.get(id),base=sea.el.getBoundingClientRect(),[sx,sy]=sea.toScreen(it.x,it.y);return {x:base.left+sx,y:base.top+sy};},kept.id);
  await drag(again,again.x+60,again.y+40);await page.waitForTimeout(500);assert.equal(decisions.length,2,'A drop on the same side is not a decision');
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('z');
  await page.waitForFunction(()=>document.querySelector('#filter-status')?.textContent==='Undone');await ready();
  assert.equal((await api(`/api/filter?photo=${kept.id}`)).photos[0].override,'toss','Undo reverses the last throw');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({kept,decisions,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
