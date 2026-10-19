// Late photo metadata adds writing and hanging notes without shrinking the comparison that is already on screen.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {boot}=require('./stack-helpers.cjs');const {BASE,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),problems=[],cases=[];
  page.on('pageerror',e=>problems.push(e.message));await boot(page);
  await page.evaluate(async()=>{const w=await api('/api/world?per=1000');await api('/api/rescue',{ids:w.photos.map(p=>p.id),on:true});
    const b=await api('/api/groups?view=all&per=500');for(const s of b.shots)for(const id of s.members.filter(id=>id!==s.rep))await api('/api/groups/split',{photo:id});
    await api('/api/draw/new',{photos:w.photos.map(p=>p.id)});
  });
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);let release;const gate=new Promise(resolve=>release=resolve);
    await page.route('**/api/photo/*/notes',async r=>{await gate;await r.continue();});
    await page.evaluate(()=>{PhotoNotes.cache.clear();location.hash='#home';});await page.waitForSelector('.journey');
    await page.goto(BASE+'/#duel?stage=groups');await page.waitForSelector('#stage .side .print');
    await page.waitForFunction(()=>[...document.querySelectorAll('#stage .print')].length===2&&[...document.querySelectorAll('#stage .print .window img')].every(i=>i.complete&&i.naturalWidth)&&!World.flights?.size);
    const before=await page.locator('#stage .side .print').evaluateAll(nodes=>nodes.map(p=>({id:p.closest('.side').dataset.photo,width:p.getBoundingClientRect().width,height:p.getBoundingClientRect().height})));
    assert.equal(await page.locator('#stage .photo-sticky').count(),0,'Metadata is still held back');release();
    await page.waitForSelector('#stage .photo-sticky');await page.waitForFunction(()=>[...document.querySelectorAll('#stage .print')].every(p=>p.querySelector('.photo-sticky')?.textContent));await page.waitForTimeout(250);
    const after=await page.locator('#stage .side .print').evaluateAll(nodes=>nodes.map(p=>({id:p.closest('.side').dataset.photo,width:p.getBoundingClientRect().width,height:p.getBoundingClientRect().height,
      note:p.querySelector('.photo-sticky').getBoundingClientRect().toJSON(),fits:p.querySelector('.photo-sticky').scrollHeight<=p.querySelector('.photo-sticky').clientHeight+1})));
    for(let i=0;i<before.length;i++){
      assert.equal(after[i].id,before[i].id);assert(Math.abs(after[i].width-before[i].width)<1&&Math.abs(after[i].height-before[i].height)<1,JSON.stringify({before,after}));
      assert(after[i].fits,'The full sticky contents remain readable');assert(after[i].note.left>=5&&after[i].note.right<=viewport.width-5&&after[i].note.bottom<=viewport.height-5,'Notes remain on screen');
    }
    cases.push({viewport,before,after});await page.screenshot({path:OUT+'/pair-size-'+viewport.width+'.png'});
    const pose=await page.locator('#stage .photo-sticky').evaluateAll(ns=>ns.map(n=>[n.style.getPropertyValue('--note-x'),n.style.getPropertyValue('--note-y')]));
    await page.evaluate(()=>{PhotoNotes.repaint();PhotoNotes.repaint();});
    assert.deepEqual(await page.locator('#stage .photo-sticky').evaluateAll(ns=>ns.map(n=>[n.style.getPropertyValue('--note-x'),n.style.getPropertyValue('--note-y')])),pose,'Repainting or changing image level keeps notes on their chosen edge');
    await page.unroute('**/api/photo/*/notes');await page.goto(BASE+'/#home');await page.waitForSelector('.journey');
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({cases,problems}));await browser.close();
})().catch(e=>{console.error(e.stack);process.exit(1);});
