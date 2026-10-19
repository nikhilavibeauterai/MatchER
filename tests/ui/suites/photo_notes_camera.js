// Paper surfaces pan the photo's own camera; editing controls stay native and zoom never scales the writing.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {boot}=require('./stack-helpers.cjs');
const {BASE,OUT}=process.env;
let page;
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.emulateMedia({reducedMotion:'reduce'});
  const problems=[],states=[];let votes=0;
  page.on('pageerror',e=>problems.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/vote\b/.test(r.url()))votes++;});
  await boot(page);
  const pid=await page.evaluate(async()=>{const ids=[...World.photos.keys()];await api('/api/rescue',{ids,on:true});return ids[0];});
  const drag=async(locator,dx,dy)=>{
    const r=await locator.boundingBox(),x=r.x+Math.min(r.width/2,70),y=r.y+r.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:8});await page.mouse.up();
  };
  const geometry=()=>page.evaluate(()=>{
    const p=PhotoNotes.active.host,s=PhotoNotes.sheet,r=p.getBoundingClientRect(),paper=s.getBoundingClientRect(),field=s.querySelector('textarea');
    return {card:r.toJSON(),paper:paper.toJSON(),text:parseFloat(getComputedStyle(field).fontSize)*paper.width/parseFloat(getComputedStyle(s).width),
      camera:{...World.sea.camera},zoom:Number(p.dataset.viewerZoom)||World.sea.camera.zoom,selection:getSelection().toString()};
  });
  const checkPaper=async(label)=>{
    const g=await geometry(),v=page.viewportSize();states.push({label,...g});
    assert(g.paper.left>=7&&g.paper.top>=7&&g.paper.right<=v.width-7&&g.paper.bottom<=v.height-7,`${label}: paper stays on screen: ${JSON.stringify(g)}`);
    assert(g.text>=17&&g.text<=20,`${label}: writing keeps its screen size: ${JSON.stringify(g)}`);
    return g;
  };
  for(const kind of ['sea','comparison','viewer']){
    await page.goto(BASE+(kind==='comparison'?'/#duel?stage=open':'/#home'));
    await page.waitForFunction(()=>World.photos?.size&&!World.loading);
    if(kind==='sea'){
      await page.evaluate(pid=>{const sea=World.sea,it=[...sea.items.values()].find(it=>it.photo===pid&&!it.take)||[...sea.items.values()].find(it=>!it.take);sea.zoomToPrint(it);},pid);
      await page.waitForSelector('.sea-photo-detail .photo-notes-tab');
    }else if(kind==='viewer'){
      await page.evaluate(pid=>openViewer(pid),pid);await page.waitForSelector('.viewer-stage .photo-notes-tab');
    }else await page.waitForSelector('.focus-camera .print .photo-notes-tab');
    const host=kind==='sea'?'.sea-photo-detail':kind==='viewer'?'.viewer-stage .print':'.focus-camera .print';
    if(kind!=='sea'){
      const r=await page.locator(host).first().boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height*.4);await page.mouse.wheel(0,-470);
      await page.waitForFunction(host=>Number(document.querySelector(host).dataset.viewerZoom)>1.7,host);
      await drag(page.locator(host+' .window').first(),-65,-30);
    }else await page.evaluate(()=>{const sea=World.sea;sea.setCamera(sea.camera.zoom,sea.camera.tx-90,sea.camera.ty+40);});
    const before=await page.locator(host).first().boundingBox();
    await page.evaluate(host=>PhotoNotes.open(document.querySelector(host)),host);
    await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');await page.click('[data-notes-page=notes]');
    let g=await checkPaper(kind+' open after pan');
    if(kind!=='sea')assert(Math.abs(g.card.left-before.x)<2&&Math.abs(g.card.top-before.y)<2,`${kind}: opening a sheet preserves the zoomed photo position: ${JSON.stringify({before,g})}`);
    await drag(page.locator('.notes-heading h2'),-45,25);
    let moved=await checkPaper(kind+' paper drag');
    assert(Math.abs(moved.card.left-g.card.left+45)<3&&Math.abs(moved.card.top-g.card.top-25)<3,`${kind}: dragging printed text pans the photo: ${JSON.stringify({g,moved})}`);
    assert.equal(moved.selection,'',`${kind}: dragging the paper never highlights its text`);
    if(kind!=='viewer'){
      await page.click('#toolbelt [data-tool=pen]');await drag(page.locator('.notes-heading h2'),20,15);
      const ink=await geometry();assert.deepEqual(ink.camera,moved.camera);assert(Math.abs(ink.card.left-moved.card.left)<1);
      assert(await page.evaluate(()=>!Toolbelt.gesture&&!document.querySelector('.held')),`${kind}: the paper never starts a card or drawing gesture`);
      await page.click('#toolbelt [data-tool=hand]');
    }
    // Actual writing retains text selection, and labels, sliders and colour wheels cannot start a pan.
    await page.fill('.notes-writing textarea','Select these words without moving the camera.');
    const writing=page.locator('.notes-writing textarea'),wr=await writing.boundingBox();
    await page.mouse.move(wr.x+5,wr.y+16);await page.mouse.down();await page.mouse.move(wr.x+140,wr.y+16,{steps:8});await page.mouse.up();
    assert(await writing.evaluate(el=>el.selectionEnd>el.selectionStart),`${kind}: writing is still selectable`);
    let edited=await geometry();assert.deepEqual(edited.camera,moved.camera);assert(Math.abs(edited.card.left-moved.card.left)<1);
    await page.click('[data-notes-page=look]');
    const wheel=page.locator('.grade-wheel').first();await wheel.scrollIntoViewIfNeeded();await drag(wheel,15,8);
    edited=await geometry();assert.deepEqual(edited.camera,moved.camera,`${kind}: colour wheels retain their own drag`);
    const slider=page.locator('.photo-note-sheet [name=straighten]');await slider.scrollIntoViewIfNeeded();await drag(slider,20,0);
    edited=await geometry();assert.deepEqual(edited.camera,moved.camera,`${kind}: alignment sliders retain their own drag`);
    await page.click('[data-notes-page=notes]');await page.locator('.notes-story-label').click();
    assert(await writing.evaluate(el=>el===document.activeElement),`${kind}: labels still focus their controls`);
    await page.screenshot({path:`${OUT}/notes-camera-${kind}.png`});
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!PhotoNotes.active);
    // Reopening the same paper at another camera position recomputes its anchor without stale offsets.
    if(kind==='viewer')await page.mouse.move(600,340);else await page.mouse.move(500,320);
    await page.mouse.wheel(0,-190);await page.waitForTimeout(180);
    await page.evaluate(host=>PhotoNotes.open(document.querySelector(host)),host);await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');
    await page.click('[data-notes-page=notes]');await checkPaper(kind+' reopen deeper');
    if(kind==='viewer'){
      await page.setViewportSize({width:390,height:844});await page.waitForTimeout(180);
      const water=await page.locator('.viewer-stage').evaluate(stage=>{
        const r=stage.getBoundingClientRect();for(let y=r.top+12;y<r.bottom;y+=24)for(let x=r.left+12;x<r.right;x+=24){
          const el=document.elementFromPoint(x,y);if(stage.contains(el)&&!el.closest('.photo-notes-paper,.photo-sticky,.user-note,button,input,textarea,select'))return{x,y};
        }
      });
      assert(water,'The phone leaves space to zoom around the sheet');await page.mouse.move(water.x,water.y);await page.mouse.wheel(0,-450);
      await page.waitForFunction(()=>Number(document.querySelector('.viewer .print').dataset.viewerZoom)>1.5);
      await checkPaper('phone viewer zoom');await page.screenshot({path:OUT+'/notes-camera-phone.png'});
    }
    await page.keyboard.press('Escape');if(kind==='viewer')await page.click('.viewer #close-modal');
  }
  assert.equal(votes,0);assert.deepEqual(problems,[]);console.log(JSON.stringify({states,votes,problems}));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page)await page.screenshot({path:OUT+'/notes-camera-failure.png'}).catch(()=>{});process.exit(1);});
