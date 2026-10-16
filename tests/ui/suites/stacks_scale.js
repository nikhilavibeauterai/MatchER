// A long Stacks overview must keep untouched cards alive when two stacks are combined.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env,FIRST=80000,COUNT=720,TAKES=6;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[],requests=[],merges=[];let imageRequests=0;
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading);
  const thumbnail=await page.evaluate(()=>T(World.photos.values().next().value.id));
  const image=await page.request.get(new URL(thumbnail,BASE).href);assert(image.ok());const pixels=await image.body();
  await page.route(/\/img\/[tp]\/\d+\.jpg(?:\?|$)/,r=>{
    const id=Number(new URL(r.request().url()).pathname.match(/\/(\d+)\.jpg$/)[1]);
    if(id>=FIRST)imageRequests++;
    return id>=FIRST?r.fulfill({contentType:'image/jpeg',body:pixels}):r.continue();
  });
  await page.route('**/api/edit?*',r=>Number(new URL(r.request().url()).searchParams.get('photo'))>=FIRST
    ?r.fulfill({json:{edits:{}}}):r.continue());
  let rows=Array.from({length:COUNT},(_,i)=>({rep:FIRST+i*TAKES,members:Array.from({length:TAKES},(_,j)=>FIRST+i*TAKES+j),family:Math.floor(i/2)}));
  const history=[];
  await page.route('**/api/groups?*',r=>{
    const q=new URL(r.request().url()).searchParams;
    if(q.get('view')==='suggest')return r.fulfill({json:{suggestions:[]}});
    if(q.get('view')!=='stacks')return r.continue();
    const page=Number(q.get('page')||0),per=Number(q.get('per')||120);requests.push({page,per});
    return r.fulfill({json:{shots:rows.slice(page*per,(page+1)*per),boxes:{},undo:history.length?'merge':null,
      total:rows.length,page,pages:Math.ceil(rows.length/per)}});
  });
  await page.route('**/api/groups/merge',r=>{
    const payload=r.request().postDataJSON();merges.push(payload);history.push(structuredClone(rows));
    const selected=rows.filter(x=>payload.photos.includes(x.rep)),first=rows.indexOf(selected[0]);
    const merged={...selected[0],rep:selected.find(x=>x.rep===payload.photos.at(-1)).rep,members:selected.flatMap(x=>x.members)};
    rows=rows.filter(x=>!selected.includes(x));rows.splice(first,0,merged);
    return r.fulfill({json:{ok:true,size:merged.members.length,undo:'merge'}});
  });
  await page.route('**/api/draw/undo',r=>{rows=history.pop()||rows;return r.fulfill({json:{undone:'merge',next:null}});});
  await page.goto(BASE+'/#stacks');await page.waitForSelector('.stacker .tile');
  await page.evaluate(()=>{
    window.stackPerf={};
    for(const [name,object,key]of [['images',World,'images'],['grab',World,'grab'],['arm',Toolbelt,'arm']]){
      const original=object[key];object[key]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{
        const row=stackPerf[name]||={calls:0,ms:0};row.calls++;row.ms+=performance.now()-start;
      }};
    }
  });
  for(let n=120;n<COUNT;n+=120){
    await page.locator('.stacker .screen-body').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await page.waitForFunction(n=>document.querySelectorAll('.stacker [data-drag-shot]').length>n,n,{timeout:30000});
  }
  await page.locator('.stacker .screen-body').evaluate(e=>{e.scrollTop=e.scrollHeight;});
  await page.waitForTimeout(800);
  const before=await page.evaluate(()=>{
    const grid=document.querySelector('.stacker .lookgrid');window.originalGrid=grid;
    window.untouchedCard=grid.querySelector('[data-drag-shot]');window.stackPerf={};
    window.gridChanges={added:0,removed:0};window.gridObserver=new MutationObserver(records=>{
      for(const r of records){gridChanges.added+=r.addedNodes.length;gridChanges.removed+=r.removedNodes.length;}
    });gridObserver.observe(grid,{childList:true,subtree:true});
    document.addEventListener('drop',()=>{window.stackDropAt=performance.now();},{capture:true});
    new MutationObserver(()=>{window.stackPaintAt=performance.now();}).observe(document.querySelector('[data-stack-total]'),{childList:true,characterData:true,subtree:true});
    return {cards:grid.querySelectorAll('[data-drag-shot]').length,images:grid.querySelectorAll('img').length,flightCandidates:World.images(document.querySelector('#main')).length};
  });
  const start=performance.now(),calls=requests.length,images=imageRequests,source=rows.at(-2).rep,target=rows.at(-1).rep;
  await page.locator(`[data-drag-shot="${source}"]`).dragTo(page.locator(`[data-drag-shot="${target}"]`));
  await page.waitForFunction(n=>Number(document.querySelector('.stacker .stat-chip b')?.textContent.replaceAll(',',''))===n,COUNT-1,{timeout:30000});
  await page.waitForTimeout(400);
  const result=await page.evaluate(()=>({sameGrid:originalGrid===document.querySelector('.stacker .lookgrid'),sameCard:untouchedCard.isConnected,
    cards:document.querySelectorAll('.stacker [data-drag-shot]').length,changes:gridChanges,work:stackPerf,dropToUpdateMs:stackPaintAt-stackDropAt}));
  result.mergeMs=performance.now()-start;result.pageRequests=requests.length-calls;result.imageRequests=imageRequests-images;
  await page.screenshot({path:OUT+'/stacks-scale-merged.png'});
  if(!result.sameGrid||!result.sameCard)console.error(JSON.stringify({before,result}));
  assert.equal(merges.length,1,'One overview drag makes one merge');
  assert(before.flightCandidates<60,`Offscreen prints must stay out of the flight animation: ${before.flightCandidates}`);
  assert(result.sameGrid&&result.sameCard,'A merge must preserve the grid and untouched photo cards');
  assert.equal(result.cards,COUNT-1);
  assert(result.changes.removed<60,`One merge rebuilt too much of the overview: ${JSON.stringify(result.changes)}`);
  assert(result.imageRequests<20,`A merge must not request unchanged photos again: ${result.imageRequests}`);
  await page.keyboard.press('z');await page.waitForFunction(n=>document.querySelectorAll('.stacker [data-drag-shot]').length===n,COUNT);
  assert(await page.evaluate(()=>untouchedCard.isConnected),'Undo also keeps untouched cards alive');
  // Merge backwards across family boxes; the chosen cover can come from either original pile.
  const backwards=[rows.at(-1).rep,rows.at(-4).rep],members=backwards.flatMap(rep=>rows.find(x=>x.rep===rep).members);
  await page.locator(`[data-drag-shot="${backwards[0]}"]`).dragTo(page.locator(`[data-drag-shot="${backwards[1]}"]`));
  await page.waitForFunction(n=>Number(document.querySelector('[data-stack-total]')?.textContent.replaceAll(',',''))===n,COUNT-1);
  await page.click(`[data-expand="${backwards[1]}"]`);await page.waitForSelector('.tile.open .ftile');
  const takes=await page.locator('.tile.open .ftile').evaluateAll(tiles=>tiles.map(tile=>Number(tile.dataset.dragFrame)));
  assert.deepEqual(takes.sort((a,b)=>a-b),members.sort((a,b)=>a-b),'Every take survives a backwards merge between families');
  assert(await page.evaluate(()=>untouchedCard.isConnected),'A cross-family merge leaves other cards alive');
  await page.keyboard.press('z');await page.waitForFunction(n=>document.querySelectorAll('.stacker [data-drag-shot]').length===n,COUNT);
  assert.equal(merges.length,2);
  // A big family can span several fetched pages. Paging must not create boxes that the first edit then merges.
  rows=rows.map(row=>({...row,family:0}));
  await page.goto(BASE+'/#home');await page.waitForSelector('.journey');await page.goto(BASE+'/#stacks');await page.waitForSelector('.stacker .tile');
  for(let n=120;n<COUNT;n+=120){
    await page.locator('.stacker .screen-body').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await page.waitForFunction(n=>document.querySelectorAll('.stacker [data-drag-shot]').length>n,n);
  }
  assert.equal(await page.locator('.stacker .lookgrid > .fam-tiles').count(),1,'Paging retains one continuous family box');
  await page.evaluate(()=>{
    originalGrid=document.querySelector('.stacker .lookgrid');untouchedCard=originalGrid.querySelector('[data-drag-shot]');
    gridObserver.disconnect();gridChanges={added:0,removed:0};gridObserver.observe(originalGrid,{childList:true,subtree:true});
  });
  await page.locator(`[data-drag-shot="${rows.at(-2).rep}"]`).dragTo(page.locator(`[data-drag-shot="${rows.at(-1).rep}"]`));
  await page.waitForFunction(n=>Number(document.querySelector('[data-stack-total]')?.textContent.replaceAll(',',''))===n,COUNT-1);
  const familyChanges=await page.evaluate(()=>({...gridChanges,sameCard:untouchedCard.isConnected}));
  assert(familyChanges.sameCard&&familyChanges.removed<60,`Merging within a 720-stack family stays local: ${JSON.stringify(familyChanges)}`);
  await page.keyboard.press('z');await page.waitForFunction(n=>document.querySelectorAll('.stacker [data-drag-shot]').length===n,COUNT);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({before,result,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
