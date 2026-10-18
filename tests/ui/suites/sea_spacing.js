// Every analysis discovery survives in the sea; independent photos keep apart and takes form real piles.
const {chromium}=require("playwright-core");
const assert=require("node:assert/strict");
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const problems=[];page.on("pageerror",e=>problems.push(e.message));
  await page.goto(LINK);await page.fill("#path",LIB);await page.click("#use-path");
  const found=new Set();
  for(let k=0;k<1800;k++){
    for(const key of await page.locator('[data-found-tag]').evaluateAll(es=>es.map(e=>e.dataset.foundTag)))found.add(key);
    if(await page.locator('#an-go').isVisible())break;
    await page.waitForTimeout(150);
  }
  await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total && !World.loading);await page.waitForTimeout(4500);
  const tags=await page.evaluate(async()=> (await api('/api/tags?all=1')).tags);
  // Home keeps the shelf tucked away. Its tag inventory and the same tag popup still belong to the sea.
  const expected=tags.filter(t=>t.count||t.user).map(t=>t.key),actual=await page.evaluate(()=>[...World.sea.circles.keys()]);
  assert.deepEqual(new Set(actual),new Set(expected));assert(found.size>10);
  for(const key of found)assert(expected.includes(key),`Analysis discovery ${key} must survive in the sea`);
  await page.evaluate(key=>World.tagMenu(key,document.querySelector('#open-menu')),expected[0]);await page.waitForSelector('.sea-tag-pop');
  await page.click('[data-tag-select]');
  assert(await page.locator('#world .ps-item.selected').count()>0);
  await page.screenshot({path:`${OUT}/S-all-tags.png`});
  await page.evaluate(()=>{window.stackWaitTrace=[];window.stackWaitKey='';});
  await page.goto(BASE+'/#stacks');await page.waitForSelector('.tile.stacked');
  // Virtualized overview tiles retain their own covers; scrolling never launches duplicate flights.
  let pile;
  try {
    const ready=await page.waitForFunction(()=>{
      const tile=document.querySelector('.tile.stacked'),cover=tile?.querySelector('.pile-cover'),pid=Number(cover?.src.match(/\/(\d+)\.jpg/)?.[1]);
      const state={opacity:cover&&getComputedStyle(cover).opacity,adopted:!!World.focused?.some(p=>p.pid===pid),
        loaded:!!cover?.complete&&cover.naturalWidth>0,loading:!!World.loading,photos:World.photos?.size,total:World.total,
        flights:document.querySelectorAll('.world-fly').length};
      const key=JSON.stringify(state);if(key!==stackWaitKey){stackWaitTrace.push({t:Math.round(performance.now()),...state});stackWaitKey=key;}
      if(!state.loaded||Number(state.opacity)<=.95||state.photos!==state.total||state.loading||state.flights)return false;
      return {takes:tile.querySelectorAll('.pile-take').length,turns:[...tile.querySelectorAll('.pile-take')].map(i=>getComputedStyle(i).transform),cover:state.opacity};
    },null,{timeout:5000});
    pile=await ready.jsonValue();await ready.dispose();
    require('node:fs').writeFileSync(`${OUT}/S-stack-trace.json`,JSON.stringify(await page.evaluate(()=>stackWaitTrace),null,2));
    assert(pile.takes>0);assert(new Set(pile.turns).size===pile.takes);assert(Number(pile.cover)>.95);
  } catch(e) {
    const state=await page.evaluate(()=>{
      const cover=document.querySelector('.tile.stacked .pile-cover'),pid=Number(cover?.src.match(/\/(\d+)\.jpg/)?.[1]);
      return {cover:cover&&{opacity:getComputedStyle(cover).opacity,style:cover.getAttribute('style'),src:cover.src,
        complete:cover.complete,width:cover.naturalWidth},loading:!!World.loading,photos:World.photos?.size,total:World.total,
        flying:[...document.querySelectorAll('.world-fly')].map(i=>({src:i.src,style:i.getAttribute('style')})),
        lifted:[...World.lifted],tile:World.sea.items.get(pid)?.el.className,trace:window.stackWaitTrace};
    });
    await page.screenshot({path:`${OUT}/S-pile-fail.png`});
    throw new Error(`Stack cover failed: ${e.message} ${JSON.stringify({pile,state})}`);
  }
  await page.locator('.tile.stacked [data-expand]').first().click();await page.waitForSelector('.tile.open .photo-fan');
  await page.waitForTimeout(750);
  const fan=await page.locator('.tile.open .photo-fan').evaluate(e=>({display:getComputedStyle(e).display,
    takes:[...e.querySelectorAll('.ftile')].map(t=>{const r=t.getBoundingClientRect();return {left:r.left,right:r.right,turn:getComputedStyle(t).transform};})}));
  assert.equal(fan.display,'flex');assert(fan.takes.length>1);assert(fan.takes[0].right>fan.takes[1].left);
  assert.equal(await page.evaluate(()=>World.sea.bounds().obstacles.length),0,'Controls do not fence off the sea behind them');
  assert(await page.locator('.tile.open .photo-fan').isVisible(),'The open stack stays above the background sea');
  await page.screenshot({path:`${OUT}/S-photo-stack.png`});
  const spacing=await page.evaluate(async()=>{
    const host=document.createElement('div');host.style.cssText='position:fixed;left:20px;top:100px;width:1200px;height:750px;z-index:50;background:#142032';document.body.append(host);
    const sea=new VennSea(host), sample=[...World.photos.values()][0].id;
    sea.setVenn([],Array.from({length:120},(_,i)=>({id:10000+i,photo:sample,group:Math.floor(i/30),tags:[],n:1})),
      [0,1,2,3].map(i=>({id:`g${i}`,kind:'group',html:`Group ${i+1}`})));
    window.spacingSea=sea;await sleep(6000);
    const items=[...sea.items.values()];let overlaps=0;
    for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)if(Math.abs(items[i].x-items[j].x)<sea.s && Math.abs(items[i].y-items[j].y)<sea.s*4/3)overlaps++;
    const centers=[0,1,2,3].map(g=>{const its=items.filter(i=>i.group===g);return {x:its.reduce((n,i)=>n+i.x,0)/its.length,y:its.reduce((n,i)=>n+i.y,0)/its.length};});
    const inside=(x,y,paths)=>{let hit=false;for(const h of paths)for(let i=0,j=h.length-1;i<h.length;j=i++){const a=h[i],b=h[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;};
    // Test the displayed occupied contours. A convex hull would bridge empty water between disconnected flocks.
    const outlines=[0,1,2,3].map(g=>{const shape=sea.contours.get(`g${g}`),members=items.filter(it=>it.group===g);let empty=0,filled=0;
      for(let y=15;y<sea.height;y+=30)for(let x=15;x<sea.width;x+=30)if(inside(x,y,shape?.paths||[])){filled++;if(!members.some(it=>Math.hypot(it.x-x,it.y-y)<sea.s*2.2))empty++;}
      return {count:shape?.count,visible:!sea.lassos.get(`g${g}`).tag.hidden,paths:shape?.paths.length,filled,empty};});
    return {overlaps,outlines,centers,size:sea.s};
  });
  await page.screenshot({path:`${OUT}/S-separate-groups.png`});
  assert.equal(spacing.overlaps,0,`Separate photos: ${JSON.stringify(spacing)}`);
  assert(spacing.outlines.every(o=>o.count===30&&o.visible&&o.empty===0),`Fitted groups: ${JSON.stringify(spacing)}`);
  assert(new Set(spacing.centers.map(c=>`${Math.round(c.x)},${Math.round(c.y)}`)).size===4);
  await page.evaluate(()=>{spacingSea.destroy();spacingSea.el.remove();});
  await page.setViewportSize({width:390,height:844});await page.goto(BASE+'/#home');await page.waitForSelector('.journey');await page.waitForTimeout(1600);
  assert.deepEqual(new Set(await page.evaluate(()=>[...World.sea.circles.keys()])),new Set(expected));
  await page.evaluate(key=>World.tagMenu(key,document.querySelector('#open-menu')),expected.at(-1));await page.waitForSelector('.sea-tag-pop');await page.click('[data-tag-select]');
  await page.waitForTimeout(2800);
  const phone=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollX}));
  assert.equal(phone.scrollWidth,phone.width);assert.equal(phone.scrollX,0);
  await page.screenshot({path:`${OUT}/S-phone-tags.png`});assert.deepEqual(problems,[]);
  console.log(JSON.stringify({discovered:found.size,tags:expected.length,pile,fan,spacing,phone,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
