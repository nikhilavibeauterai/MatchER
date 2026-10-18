// An open sheet keeps readable type and reachable controls as its photo changes size in the sea.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[],states=[];
  let votes=0,reads=0;
  page.on('pageerror',e=>problems.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&/\/api\/vote\b/.test(r.url()))votes++;
    if(/\/api\/photo\/\d+\/notes$/.test(r.url()))reads++;});
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.sea.settled);
  for(const viewport of [{width:1440,height:900},{width:960,height:620},{width:390,height:844},{width:320,height:568}]){
    await page.evaluate(()=>World.sea.resetCamera());await page.setViewportSize(viewport);
    await page.waitForTimeout(200);await page.waitForFunction(()=>World.sea.settled&&!World.loading);
    await page.evaluate(()=>{
      const sea=World.sea,it=[...sea.items.values()].filter(it=>!it.take).sort((a,b)=>b.n-a.n)[0];
      window.notesZoomItem=it;sea.zoomToPrint(it);
    });
    await page.waitForSelector('.sea-photo-detail .photo-notes-tab').catch(async error=>{
      await page.screenshot({path:`${OUT}/notes-zoom-unfocused-${viewport.width}.png`});
      throw new Error(`${viewport.width}: ${error.message}; ${JSON.stringify(await page.evaluate(()=>({camera:World.sea.camera,photo:notesZoomItem.el.getBoundingClientRect().toJSON(),full:World.sea.fullSize(notesZoomItem),mode:World.mode,pending:notesZoomItem.imagePending})))}`);
    });
    await page.evaluate(()=>PhotoNotes.open(PhotoNotes.seaDetail));
    await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');
    await page.click('[data-notes-page=notes]');
    await page.fill('.notes-writing textarea','Readable words stay on this same sheet.');
    await page.waitForFunction(()=>document.querySelector('.notes-save-state')?.dataset.state==='saved');
    await page.waitForTimeout(200);
    await page.evaluate(()=>{window.zoomSheet=PhotoNotes.sheet;window.zoomField=zoomSheet.querySelector('textarea');window.notesZoomStart=World.sea.camera.zoom;});
    const readsBefore=reads;
    for(const factor of [1,.65,.3,1.7,3,1]){
      await page.evaluate(factor=>{
        const sea=World.sea,it=notesZoomItem,z=Math.max(1.1,notesZoomStart*factor);
        sea.setCamera(z,innerWidth*.3-it.x*z,innerHeight*.45-it.y*z);
      },factor);
      await page.waitForTimeout(100);
      const state=await page.evaluate(()=>{
        const paper=PhotoNotes.sheet,r=paper.getBoundingClientRect(),field=paper.querySelector('textarea'),nav=paper.querySelector('.notes-nav button'),
          scale=r.width/parseFloat(getComputedStyle(paper).width);
        return {zoom:World.sea.camera.zoom,width:innerWidth,height:innerHeight,paper:r.toJSON(),
          text:parseFloat(getComputedStyle(field).fontSize)*scale,nav:nav.getBoundingClientRect().height,
          same:paper===zoomSheet&&field===zoomField,words:field.value,overflow:paper.querySelector('.notes-page:not([hidden])').scrollWidth>paper.querySelector('.notes-page:not([hidden])').clientWidth+1};
      });
      states.push(state);
      if(factor===.3||factor===3)await page.screenshot({path:`${OUT}/notes-zoom-${viewport.width}-${factor}.png`});
      assert(state.text>=17&&state.text<=20,`Writing stays readable through zoom: ${JSON.stringify(state)}`);
      assert(state.nav>=39&&state.nav<=46,`The index keeps usable targets: ${JSON.stringify(state)}`);
      assert(state.paper.left>=7&&state.paper.right<=viewport.width-7&&state.paper.top>=7&&state.paper.bottom<=viewport.height-7,
        `All of the paper stays reachable: ${JSON.stringify(state)}`);
      assert(state.same&&!state.overflow&&state.words==='Readable words stay on this same sheet.','Zoom preserves the paper, writing and layout');
    }
    assert.equal(reads,readsBefore,'Moving the camera never reloads the notes');
    // Each page can still be used, and wheel scrolling its contents does not move the sea.
    for(const name of ['tags','look','details']){
      await page.click(`[data-notes-page=${name}]`);
      assert.equal(await page.locator('.notes-page:visible').count(),1);
    }
    const before=await page.evaluate(()=>({...World.sea.camera}));
    const panel=page.locator('.notes-page:visible');await panel.hover();await page.mouse.wheel(0,350);await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(()=>({...World.sea.camera})),before,'The sheet scrolls independently of its photo');
    await page.keyboard.press('Escape');await page.waitForSelector('.photo-notes-paper:not(.notes-returning) .photo-notes-tab');
    assert(await page.evaluate(()=>PhotoNotes.hosts.get(PhotoNotes.seaDetail).paper===zoomSheet),'The same paper tucks back beneath the frame');
  }
  assert.equal(votes,0);assert.deepEqual(problems,[]);
  console.log(JSON.stringify({states,votes,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
