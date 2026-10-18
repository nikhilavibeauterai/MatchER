// Real writing survives slow replies, failed saves, local actions and closing its physical sheet.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
const problems=[],res={};let page;
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',error=>problems.push(error.message));let votes=0,writingPosts=0;
  page.on('request',request=>{
    if(request.method()==='POST'&&/\/api\/vote\b/.test(request.url()))votes++;
    if(request.method()==='POST'&&/\/api\/edit$/.test(request.url())&&'description' in request.postDataJSON())writingPosts++;
  });
  const check=(key,value)=>{res[key]=value;assert.equal(value,true,key);};
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos.size&&!World.loading);
  const ids=await page.evaluate(()=>[...World.photos.keys()].slice(0,2));
  const open=async id=>{
    await page.evaluate(id=>openViewer(id),id);await page.waitForSelector('.viewer .photo-notes-tab');
    await page.click('.viewer .photo-notes-tab');await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');
    await page.click('[data-notes-page=notes]');
  };
  await open(ids[0]);
  await page.evaluate(()=>{window.notesPaper=PhotoNotes.sheet;window.notesField=document.querySelector('.notes-writing textarea');});
  check('fourAccessiblePages',await page.locator('.notes-nav [role=tab]').count()===4&&await page.locator('.notes-page:visible').count()===1);
  await page.locator('[data-notes-page=notes]').focus();await page.keyboard.press('ArrowRight');
  check('indexKeepsItsOwnArrowKeys',await page.locator('[data-notes-page=tags]').getAttribute('aria-selected')==='true');
  await page.keyboard.press('Home');await page.fill('.notes-writing [name=title]','The light, & the “keeper”');
  let release,arrived;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{arrived=resolve;});let held=false;
  await page.route('**/api/edit',async route=>{
    if(!held&&route.request().postDataJSON()?.description==='The first sentence.'){
      held=true;arrived();await gate;
    }
    await route.continue();
  });
  await page.fill('.notes-writing textarea','The first sentence.');await ready;
  await page.fill('.notes-writing textarea','The first sentence.\nAnd the ending I added while saving.');
  await page.click('[data-notes-page=tags]');release();
  await page.waitForFunction(()=>document.querySelector('.notes-save-state')?.dataset.state==='saved');
  await page.unroute('**/api/edit');
  check('slowSaveKeepsNewestWords',await page.evaluate(async id=>(await api(`/api/edit?photo=${id}`)).edits.description==='The first sentence.\nAnd the ending I added while saving.',ids[0]));
  await page.fill('.notes-new-tag input','Little paper treasure');await page.locator('.tag-options [role=option]').filter({hasText:'Create'}).click();
  await page.waitForSelector('.notes-tag:has-text("Little paper treasure")');
  check('tagKeepsItsProvenance',await page.locator('.notes-tag:has-text("Little paper treasure")').textContent().then(text=>text.includes('Added by you')));
  await page.click('[data-notes-page=notes]');
  check('tagActionPreservesWritingAndItsElement',await page.evaluate(()=>PhotoNotes.sheet===notesPaper&&document.querySelector('.notes-writing textarea')===notesField&&notesField.value.endsWith('while saving.')));
  await page.click('[data-notes-page=tags]');
  await page.locator('.notes-tag:has-text("Little paper treasure") [data-remove-tag]').click();
  await page.waitForSelector('.notes-tag:has-text("Little paper treasure")',{state:'detached'});
  await page.locator('.notes-removed summary').click();await page.locator('.notes-removed li').filter({hasText:'Little paper treasure'}).getByRole('button',{name:'Put back'}).click();
  await page.waitForSelector('.notes-tag:has-text("Little paper treasure")');
  check('removedTagCanBeRestoredLocally',true);
  await page.click('[data-notes-page=look]');await page.click('[data-crop=height]');await page.click('[data-turn="90"]');
  await page.waitForFunction(()=>document.querySelector('.viewer .print').dataset.rotate==='90');
  const before=await page.locator('.viewer .print').evaluate(card=>({crop:card.dataset.crop,turn:card.dataset.rotate,enhance:card.dataset.enhance}));
  const original=page.locator('[data-notes-compare]');await original.scrollIntoViewIfNeeded();
  const box=await original.boundingBox(),postsBefore=writingPosts;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  check('holdShowsOriginal',await page.locator('.viewer .print').evaluate(card=>card.dataset.crop==='off'&&card.dataset.rotate==='0'&&card.dataset.enhance==='off'));
  await page.screenshot({path:`${OUT}/notes-original-comparison.png`});await page.mouse.up();
  check('releaseRestoresFinishWithoutSaving',await page.locator('.viewer .print').evaluate((card,old)=>card.dataset.crop===old.crop&&card.dataset.rotate===old.turn&&card.dataset.enhance===old.enhance,before)&&writingPosts===postsBefore);
  await page.click('[data-notes-undo]');await page.waitForFunction(()=>document.querySelector('.viewer .print').dataset.rotate==='0');
  await page.click('[data-notes-redo]');await page.waitForFunction(()=>document.querySelector('.viewer .print').dataset.rotate==='90');
  check('undoRedoKeepTheSheetAndPage',await page.evaluate(()=>PhotoNotes.sheet===notesPaper&&PhotoNotes.active.page==='look'));
  await page.click('[data-notes-page=details]');await page.locator('[data-notes-detail=saved] > summary').click();
  check('detailsReflectTheLatestFinish',await page.locator('[data-notes-detail=saved]').innerText().then(text=>text.includes('90°')));
  await page.click('[data-notes-page=notes]');
  await page.route('**/api/edit',route=>route.request().method()==='POST'&&route.request().postDataJSON()?.description==='Keep these words even if saving fails.'
    ?route.fulfill({status:503,json:{error:'Synthetic save interruption'}}):route.continue());
  await page.fill('.notes-writing textarea','Keep these words even if saving fails.');
  await page.waitForFunction(()=>document.querySelector('.notes-save-state')?.dataset.state==='error');
  await page.keyboard.press('Escape');await page.waitForSelector('.photo-notes-paper:not(.notes-returning) .photo-notes-tab');
  await page.click('.viewer .photo-notes-tab');await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-writing');
  check('failedDraftSurvivesClosing',await page.locator('.notes-writing textarea').inputValue()==='Keep these words even if saving fails.');
  await page.waitForFunction(()=>document.querySelector('.notes-save-state')?.dataset.state==='error');
  await page.unroute('**/api/edit');await page.click('[data-retry-writing]');
  await page.waitForFunction(()=>document.querySelector('.notes-save-state')?.dataset.state==='saved');
  check('retrySavesTheRetainedWords',await page.evaluate(async id=>(await api(`/api/edit?photo=${id}`)).edits.description==='Keep these words even if saving fails.',ids[0]));
  let send,received;const sending=new Promise(resolve=>{send=resolve;}),pending=new Promise(resolve=>{received=resolve;});
  await page.route('**/api/edit',async route=>{
    if(route.request().postDataJSON()?.description==='The words arriving while the paper is tucked away.'){received();await sending;}
    await route.continue();
  });
  await page.fill('.notes-writing textarea','The words arriving while the paper is tucked away.');await pending;
  await page.keyboard.press('Escape');await page.waitForSelector('.photo-notes-paper:not(.notes-returning) .photo-notes-tab');
  await page.click('.viewer .photo-notes-tab');send();
  await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-writing');
  check('reopeningWaitsForThePendingSave',await page.locator('.notes-writing textarea').inputValue()==='The words arriving while the paper is tucked away.'&&await page.locator('.notes-save-state').getAttribute('data-state')==='saved');
  await page.unroute('**/api/edit');
  await page.fill('.notes-writing textarea','Saved when I tucked the paper away.');await page.keyboard.press('Escape');await page.click('.viewer #close-modal');
  await open(ids[1]);
  check('draftsNeverBleedIntoAnotherPhoto',await page.locator('.notes-writing textarea').inputValue()==='');
  await page.waitForFunction(async id=>(await api(`/api/edit?photo=${id}`)).edits.description==='Saved when I tucked the paper away.',ids[0]);
  check('closingFlushesWriting',true);
  const layouts=[];
  for(const [width,height] of [[1440,900],[960,620],[390,844],[320,568]]){
    await page.setViewportSize({width,height});await page.waitForTimeout(500);
    for(const name of ['notes','tags','look','details']){
      await page.click(`[data-notes-page=${name}]`);
      const layout=await page.evaluate(()=>{
        const paper=PhotoNotes.sheet,r=paper.getBoundingClientRect(),footer=paper.querySelector('.notes-footer').getBoundingClientRect(),panel=paper.querySelector('.notes-page:not([hidden])');
        return {paper:r.toJSON(),footer:footer.toJSON(),overflow:document.documentElement.scrollWidth>innerWidth,panelSpills:panel.scrollWidth>panel.clientWidth+1};
      });
      assert(!layout.overflow&&!layout.panelSpills,`${name} ${width}: ${JSON.stringify(layout)}`);
      assert(layout.paper.left>=0&&layout.paper.right<=width&&layout.paper.top>=0&&layout.paper.bottom<=height,`${name} fits ${width}`);
      assert(layout.footer.bottom<=layout.paper.bottom+1,'Save state and history stay on the sheet');
      layouts.push({width,height,name});await page.screenshot({path:`${OUT}/notes-${name}-${width}.png`});
    }
  }
  check('allPagesFitDesktopAndSmallPhones',layouts.length===16);
  check('noNestedInteractiveControls',await page.locator('button button,button input,button textarea').count()===0);
  check('noVotePassthrough',votes===0);assert.deepEqual(problems,[]);
  console.log(JSON.stringify({...res,writingPosts,layouts,problems}));await browser.close();
})().catch(async error=>{
  console.error('FAILED:',error.stack,JSON.stringify({...res,problems}));
  if(page)await page.screenshot({path:`${OUT}/notes-editing-fail.png`}).catch(()=>{});process.exit(1);
});
