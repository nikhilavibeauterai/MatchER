// Real public photos cross the Filter divider beneath the mounted, ethereal spotlight and D-pad.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
let page;const problems=[],result={};
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>problems.push(e.message));
  // Expose the test worker for read-only diagnostics; its motion code and messages are unchanged.
  await page.route('**/static/sea-worker.js',async route=>{
    const response=await route.fetch(),body=(await response.text()).replace('const field=new SeaField();','const field=self.filterCrossingField=new SeaField();');
    await route.fulfill({response,body});
  });
  const api=(path,body)=>page.evaluate(([path,body])=>api(path,body),[path,body]);
  const ready=()=>page.waitForFunction(()=>!!document.querySelector('.filter-shot')&&!document.querySelector('.filter-thinking')&&!document.querySelector('.filter-review[aria-busy="true"]')&&!World.flights?.size);
  const press=async key=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);};
  const photo=()=>page.locator('.filter-shot').getAttribute('data-photo').then(Number);
  const snapshot=()=>page.evaluate(()=>({width:World.sea.width,threshold:World.sea.outcomeFlow.threshold,line:World.sea.outcomeX(World.sea.outcomeFlow.threshold),
    obstacles:World.sea.bounds().obstacles,water:World.sea.water,photos:[...World.sea.items.values()].map(it=>({id:it.id,x:it.x,y:it.y,size:it.size||World.sea.s,lifted:it.lifted||it.pileLifted,fit:World.sea.outcomeFlow.scores[it.id]}))}));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const library=await api('/api/filter?per=200'),playable=library.photos.filter(p=>p.playable).map(p=>p.id);
  assert(playable.length>=20);const seeds=playable.slice(4),left=seeds.filter((_,i)=>i%2===0),right=seeds.filter((_,i)=>i%2);
  await api('/api/filter/decision',{photos:left,action:'aside'});await api('/api/filter/decision',{photos:right,action:'keep'});
  await page.evaluate(()=>location.hash='#filter?crossing=initial');await ready();await page.mouse.move(10,10);
  const geometry=await snapshot();assert.deepEqual(geometry.obstacles,[]);assert.equal(geometry.water.length,1,'The HUD and D-pad do not partition the sea');
  result.teaching=[];
  for(const [key,direction] of [['ArrowUp','toward'],['ArrowDown','away']]){
    const id=await photo(),reply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/filter/tune');
    await press(key);assert.equal((await reply).status(),200);await ready();assert.notEqual(await photo(),id,'Love and Hate decide the take and bring the next one');
    assert.equal((await api(`/api/filter?photo=${id}`)).photos[0].override,direction==='toward'?'keep':'toss');
    result.teaching.push({id,direction});await press('Space');await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)!==id,id);await ready();
  }
  // Start with real photos that have reached opposite banks; no position or velocity is assigned by the test.
  await page.waitForFunction(()=>{
    const sea=World.sea,line=sea.outcomeX(.5),photos=[...sea.items.values()].filter(it=>!it.lifted&&!it.pileLifted),scores=sea.outcomeFlow.scores;
    return photos.filter(it=>scores[it.id]===0&&it.x<line-100).length>=5&&photos.filter(it=>scores[it.id]===1&&it.x>line+100).length>=5;
  },null,{timeout:30000});
  const initial=await snapshot(),center=await page.locator('.filter-print').boundingBox();
  const origin=await page.evaluate(()=>World.sea.el.getBoundingClientRect().top);
  const byHeight=(a,b)=>Math.abs(a.y-(center.y-origin+center.height/2))-Math.abs(b.y-(center.y-origin+center.height/2));
  const east=initial.photos.filter(p=>!p.lifted&&p.fit===0&&p.x<initial.line-100).sort(byHeight).slice(0,4);
  const west=initial.photos.filter(p=>!p.lifted&&p.fit===1&&p.x>initial.line+100).sort(byHeight).slice(0,4);
  assert.equal(east.length,4);assert.equal(west.length,4);
  await page.screenshot({path:OUT+'/FC-before-crossing.png'});
  await api('/api/filter/decision',{photos:east.map(p=>p.id),action:'keep'});
  await api('/api/filter/decision',{photos:west.map(p=>p.id),action:'aside'});
  await page.evaluate(()=>{window.crossingSea=World.sea;location.hash='#filter?crossing=reversed';});await ready();await page.mouse.move(10,10);
  const active=await photo(),targets=[...east.map(p=>({...p,side:1})),...west.map(p=>({...p,side:-1}))].filter(p=>p.id!==active);
  assert(targets.filter(p=>p.side===1).length>=3&&targets.filter(p=>p.side===-1).length>=3);
  const starting=await snapshot();assert(await page.evaluate(()=>World.sea===crossingSea),'Reopening the Filter keeps the same world');
  for(const target of targets)assert.equal(starting.photos.find(p=>p.id===target.id).fit,target.side===1?1:0);
  const samples=[],started=Date.now();
  while(Date.now()-started<20000){
    const s=await snapshot(),rows=targets.map(p=>{const it=s.photos.find(it=>it.id===p.id);return {...it,side:p.side,crossed:(it.x-s.line)*p.side>30};});
    samples.push({ms:Date.now()-started,rows});if(rows.every(p=>p.crossed))break;await page.waitForTimeout(500);
  }
  const final=samples.at(-1),eastDone=final.rows.filter(p=>p.side===1&&p.crossed),westDone=final.rows.filter(p=>p.side===-1&&p.crossed);
  result.crossing={initial:targets,starting:starting.photos.filter(p=>targets.some(t=>t.id===p.id)),final,obstacles:starting.obstacles,elapsed:Date.now()-started};
  await page.screenshot({path:OUT+'/FC-after-crossing.png'});
  assert(eastDone.length>=Math.ceil(targets.filter(p=>p.side===1).length*.75),`Kept photos remain trapped on the left: ${JSON.stringify(result.crossing)}`);
  assert(westDone.length>=Math.ceil(targets.filter(p=>p.side===-1).length*.75),`Tossed photos remain trapped on the right: ${JSON.stringify(result.crossing)}`);
  assert(await page.locator('.filter-shot').isVisible());assert.equal(await page.locator('.filter-review-controls button').count(),5);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({...result,problems},null,1));await browser.close();
})().catch(async e=>{
  console.error('FAILED:',e.stack);
  if(page){
    console.error(JSON.stringify({snapshot:await page.evaluate(()=>({bounds:World.sea.bounds(),flow:World.sea.outcomeFlow,photos:World.sea.bodies}))}));
    for(const worker of page.workers())console.error(JSON.stringify({worker:await worker.evaluate(()=>self.filterCrossingField?{obstacles:self.filterCrossingField.obstacles,items:self.filterCrossingField.items.map(it=>({id:it.id,x:it.x,y:it.y,vx:it.vx,vy:it.vy,home:it.home,bank:it.outcomeBank,fixed:it.fixed,anchor:it.anchor}))}:null)}));
    await page.screenshot({path:OUT+'/FC-failure.png'}).catch(()=>{});
  }
  process.exit(1);
});
