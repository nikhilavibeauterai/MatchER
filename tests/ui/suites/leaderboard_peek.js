// The leaderboard shows one still card at a time with a square sticky note (everything the sorter knows) that grows
// to fit and can be dragged, the file, group and date handwritten on the chin, and a finishing sheet beside it:
// enhance with knobs, four crop modes, quarter turns; F, C, R and Z; cards slide in and out without flights.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  // A few open duels, so the board has ranks and duel counts to write down.
  await page.goto(BASE+'/#duel?stage=open');
  for(let k=0;k<6;k++){await page.waitForSelector('#stage .side img',{timeout:15000});await page.keyboard.press('ArrowLeft');await page.waitForTimeout(400);}
  await page.goto(BASE+'/#shortlist');await page.waitForSelector('.board-card[data-photo]');await page.waitForTimeout(700);
  const look=()=>page.evaluate(()=>{
    const cards=[...document.querySelectorAll('.board-card[data-photo]')],card=cards.at(-1),note=card.querySelector('.meta.sticky'),chin=card.querySelector('.chin');
    const c=card.getBoundingClientRect(),n=note.getBoundingClientRect(),body=document.querySelector('.board-body').getBoundingClientRect(),img=card.querySelector('.window > img');
    return {cards:cards.length,photo:Number(card.dataset.photo),card:{w:c.width,h:c.height},body:{height:body.height},note:{w:n.width,h:n.height,left:n.left-c.left,top:n.top-c.top},
      text:note.textContent.replace(/\s+/g,' ').trim(),chin:chin.textContent.replace(/\s+/g,' ').trim(),pos:document.querySelector('.board-pos').textContent.replace(/\s+/g,' ').trim(),
      wobble:getComputedStyle(card).animationName,
      imgWobble:[card.querySelector('.paper'),img,note,...card.querySelectorAll('.pile-take')].filter(Boolean).map(el=>getComputedStyle(el).animationName).find(name=>name!=='none')||'none',
      stuck:Math.min(n.right,c.right)-Math.max(n.left,c.left)>=c.width*.08&&n.bottom>c.top&&n.top<c.bottom,
      shown:n.left>=body.left-2&&n.right<=body.right+2&&n.top>=body.top-2&&n.bottom<=body.bottom+2,clipped:note.scrollHeight>note.clientHeight+1,
      clear:n.top>=card.querySelector('.window').getBoundingClientRect().bottom,
      enhance:card.dataset.enhance,crop:card.dataset.crop,rotate:card.dataset.rotate,filter:img.style.filter,transform:img.style.transform,imgW:img.getBoundingClientRect().width,winW:card.querySelector('.window').getBoundingClientRect().width,
      sheet:{crops:[...document.querySelectorAll('.edit-sheet [data-crop]')].filter(b=>!b.hidden).map(b=>[b.dataset.crop,b.getAttribute('aria-pressed')]),knobs:document.querySelectorAll('.edit-sheet [data-knob]').length,deg:document.querySelector('.edit-sheet .sheet-deg')?.textContent},
      lifted:[...World.lifted],flying:!!document.querySelector('.world-fly')};
  });
  const first=await look();
  assert.equal(first.cards,1,'One photo at a time');
  assert(first.card.h>first.body.height*.6&&first.card.h+first.note.h>first.body.height*.9,`The card and hanging sticky fill the stage ${JSON.stringify(first.card)} in ${JSON.stringify(first.body)}`);
  assert(Math.abs(first.note.w-first.note.h)<1.5&&first.note.w>first.card.w*.3,`A square sticky note ${JSON.stringify(first.note)}`);
  assert(/#1\b/.test(first.text)&&/sure/.test(first.text)&&/duel/.test(first.text)&&/appeal/.test(first.text),`The sorter's knowledge is on the note: ${first.text}`);
  assert(/\.(jpe?g|png|webp|gif|tiff?|heic|nef|dng)/i.test(first.chin),`The file is written on the chin: ${first.chin}`);
  assert(/#1 of \d+/.test(first.pos),first.pos);
  assert.equal(first.wobble,'none','The big card holds still');assert.equal(first.imgWobble,'none','Nothing on it wobbles either');
  assert(first.stuck&&first.shown,`The note is stuck to the card and fully on screen ${JSON.stringify(first.note)}`);
  assert(first.clear,'The default sticky hangs clear of the photo window');
  assert(!first.clipped,`The note holds all its writing: ${first.text}`);
  assert.equal(first.sheet.knobs,0,'The notes sheet stays tucked away until requested');
  assert(!first.lifted.includes(first.photo)&&!first.flying,'The card does not rise out of the sea');
  const boardNote=await page.locator('.board-card .photo-sticky').innerText();
  await page.evaluate(id=>openViewer(id),first.photo);await page.waitForSelector('.viewer .photo-facts');
  assert.equal((await page.locator('.viewer .photo-sticky').innerText()).replace(/\s+/g,' '),boardNote.replace(/\s+/g,' '),'Opening the same photo keeps its full sticky content');
  await page.screenshot({path:OUT+'/LB-viewer-sticky.png'});await page.click('.viewer #close-modal');
  const openNotes=async()=>{await page.locator('.board-card .photo-notes-tab').click();await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');await page.click('[data-notes-page=look]');await page.waitForSelector('.photo-note-sheet [data-knob]');};
  const closeNotes=async()=>{await page.keyboard.press('Escape');await page.waitForSelector('.photo-note-sheet',{state:'detached'});await page.locator('.board-card .photo-notes-tab').blur();};
  await openNotes();const withSheet=await look();assert.equal(withSheet.sheet.knobs,5,'Five knobs on the sheet');assert(withSheet.sheet.crops.length>=3,'Crop modes on the sheet');
  const longTag='A long tag following this exact take';
  await page.click('[data-notes-page=tags]');await page.fill('.notes-new-tag input',longTag);await page.click('.notes-new-tag > button');
  await page.waitForFunction(label=>document.querySelector('.board-card .photo-sticky').textContent.includes(label),longTag);
  assert(await page.locator('.board-card .photo-sticky').evaluate(note=>note.scrollWidth<=note.clientWidth+1&&note.scrollHeight<=note.clientHeight+1),'Long tag names fit the shared sticky');
  await page.locator('.notes-tag').filter({hasText:longTag}).locator('[data-remove-tag]').click();
  await page.waitForFunction(label=>!document.querySelector('.board-card .photo-sticky').textContent.includes(label),longTag);
  await page.waitForFunction(()=>!PhotoNotes.busy);
  await page.click('[data-notes-page=look]');
  const overlaps=[];
  for(const selector of ['.edit-sheet input','.photo-note-sheet .notes-close']){
    await page.locator(selector).first().scrollIntoViewIfNeeded();
    overlaps.push(await page.evaluate(selector=>{
      const sea=World.sea,it=[...sea.items.values()].find(it=>!it.take&&it.el.isConnected&&!it.el.classList.contains('lifted'));
      const old={x:it.x,y:it.y,size:it.size},base=sea.el.getBoundingClientRect();
      const target=document.querySelector(selector),r=target.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      [it.x,it.y]=sea.toWorld(x-base.left,y-base.top);it.size=120/sea.camera.zoom;sea.paintItem(it,true);
      const hit=document.elementFromPoint(x,y),result={selector,clear:target===hit||target.contains(hit)};
      Object.assign(it,old);sea.paintItem(it,true);return result;
    },selector));
  }
  assert(overlaps.length===2&&overlaps.every(x=>x.clear),`Sea prints cannot intercept finishing or rank controls: ${JSON.stringify(overlaps)}`);
  await page.screenshot({path:OUT+'/LB-first.png'});
  await closeNotes();
  // Walking the ranks: a slide, then one card; the note is stuck in different places.
  const spots=[JSON.stringify([Math.round(first.note.left),Math.round(first.note.top)])],photos=[first.photo];
  for(let k=0;k<4;k++){
    await page.keyboard.press('ArrowRight');await page.waitForTimeout(80);
    const mid=await page.evaluate(()=>({cards:document.querySelectorAll('.board-card[data-photo]').length,flying:!!document.querySelector('.world-fly')}));
    assert(!mid.flying,'No flight on the way in');
    await page.waitForTimeout(650);
    const s=await look();photos.push(s.photo);spots.push(JSON.stringify([Math.round(s.note.left),Math.round(s.note.top)]));
    assert.equal(s.cards,1,`The old card slid away ${JSON.stringify(mid)}`);assert(s.stuck&&s.shown&&!s.clipped,JSON.stringify(s));
  }
  assert.equal(new Set(photos).size,photos.length,'→ walks to the next shot each time');
  assert(new Set(spots).size>=2,`The note is stuck in different places: ${spots.join(' ')}`);
  await page.keyboard.press('ArrowLeft');await page.waitForTimeout(700);assert.equal((await look()).photo,photos[3],'← walks back');
  await page.keyboard.press('Home');await page.waitForTimeout(700);assert.equal((await look()).photo,photos[0]);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.board-arrow[data-step="-1"]')).visibility),'hidden','No way back from the first');
  await page.click('.board-arrow[data-step="1"]');await page.waitForTimeout(700);assert.equal((await look()).photo,photos[1],'The arrow button steps too');
  await page.keyboard.press('Home');await page.waitForTimeout(700);
  // Finishing: this shot's own enhance, crop mode and turn, shown in the window, saved, undoable.
  const before=await look();assert.equal(before.enhance,'on');assert(/url\(/.test(before.filter),'Enhance is on by default, shown in the window');
  await page.keyboard.press('f');await page.waitForFunction(()=>document.querySelector('.board-card')?.dataset.enhance==='off');await page.waitForTimeout(200);
  assert.equal((await look()).filter,'','F switches this shot\'s enhancement off');
  await page.keyboard.press('f');await page.waitForFunction(()=>document.querySelector('.board-card')?.dataset.enhance==='on');await page.waitForTimeout(200);
  await page.keyboard.press('r');await page.waitForFunction(()=>document.querySelector('.board-card')?.dataset.rotate==='90');await page.waitForTimeout(200);
  await openNotes();const turned=await look();assert(/rotate\(90deg\)/.test(turned.transform),`R turns the picture a quarter: ${turned.transform}`);assert.equal(turned.sheet.deg,'90°');await closeNotes();
  const modes=[];
  for(let k=0;k<5;k++){await page.keyboard.press('c');await page.waitForTimeout(450);modes.push((await look()).crop||'off');}
  assert(modes.includes('height')&&modes.includes('width')&&modes.at(-1)==='off',`C walks the crop modes: ${modes.join(' → ')}`);
  await openNotes();await page.click('.edit-sheet [data-crop="height"]');await page.waitForFunction(()=>document.querySelector('.board-card')?.dataset.crop==='height');await page.waitForTimeout(300);
  const filled=await look();assert(filled.sheet.crops.find(([m])=>m==='height')[1]==='true','The sheet marks the mode');
  // A knob: moving it changes the live filter and saves a look.
  const knob=page.locator('.edit-sheet [data-knob="colour"]');await knob.focus();
  await page.evaluate(()=>{const r=document.querySelector('.edit-sheet [data-knob="colour"]');r.value='0';r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(async()=>(await api('/api/shortlist')).items[0].edits?.look?.colour===0);
  const saved=await page.evaluate(async()=>(await api('/api/shortlist')).items[0].edits);
  assert.equal(saved.rotate,90);assert.equal(saved.crop,'height');assert.equal(saved.look.colour,0);
  assert.equal(await page.evaluate(()=>document.querySelector('#af-defs filter[id^="af-k"]')?.querySelector('feColorMatrix[type=saturate]')?.getAttribute('values')),'0.0000','The live filter follows the knob');
  await closeNotes();
  // The note can be dragged; where it lands is kept for this shot.
  const head=await page.locator('.board-card .note-head').boundingBox();
  await page.mouse.move(head.x+head.width/2,head.y+head.height/2);await page.mouse.down();
  for(let i=1;i<=8;i++)await page.mouse.move(head.x+head.width/2+i*20,head.y+head.height/2+i*10);
  await page.mouse.up();await page.waitForFunction(async()=>Array.isArray((await api('/api/shortlist')).items[0].edits?.note));
  const moved=await look();assert(Math.abs(moved.note.left-before.note.left)>100,'The note moved with the drag');
  await page.reload();await page.waitForSelector('.board-card[data-photo]');await page.waitForTimeout(700);
  const kept=await look();assert(Math.abs(kept.note.left-moved.note.left)<4&&Math.abs(kept.note.top-moved.note.top)<4,`The note stays where it was put ${JSON.stringify([kept.note,moved.note])}`);
  await page.keyboard.press('z');await page.waitForFunction(()=>document.querySelector('#history-hud:not([hidden])'));await page.waitForTimeout(700);
  const undone=await page.evaluate(async()=>(await api('/api/shortlist')).items[0].edits);
  assert(!undone.look,`Z takes the last finishing choice back: ${JSON.stringify(undone)}`);
  await page.screenshot({path:OUT+'/LB-edited.png'});
  // The toolbelt: a pen stroke, a marker stroke, a note of your own, an eraser; all kept with the shot.
  const card=await page.locator('.board-card').boundingBox();
  await page.click('.toolbelt [data-tool="pen"]');await page.click('.toolbelt [data-ink="coral"]');
  await page.mouse.move(card.x+card.width*.2,card.y+card.height*.2);await page.mouse.down();
  for(let i=1;i<=10;i++)await page.mouse.move(card.x+card.width*(.2+i*.04),card.y+card.height*(.2+i*.02));
  await page.mouse.up();await page.waitForFunction(async()=>(await api('/api/shortlist')).items[0].edits?.marks?.length===1);
  await page.click('.toolbelt [data-tool="marker"]');
  await page.mouse.move(card.x+card.width*.3,card.y+card.height*.6);await page.mouse.down();await page.mouse.move(card.x+card.width*.7,card.y+card.height*.62,{steps:6});await page.mouse.up();
  await page.waitForFunction(async()=>(await api('/api/shortlist')).items[0].edits?.marks?.length===2);
  const marks=await page.evaluate(async()=>(await api('/api/shortlist')).items[0].edits.marks);
  assert.equal(marks[0].t,'pen');assert.equal(marks[0].c,'coral');assert(marks[0].p.length>=5);assert.equal(marks[1].t,'marker');
  assert.equal(await page.locator('.board-card svg.marks polyline').count(),2,'Both strokes are drawn on the card');
  await page.click('.toolbelt [data-tool="note"]');await page.mouse.click(card.x+card.width*.5,card.y+card.height*.4);
  await page.waitForSelector('.board-card .user-note textarea');await page.keyboard.type('nice light');
  await page.click('.toolbelt [data-tool="hand"]');  // leaving the note saves its words
  await page.waitForFunction(async()=>(await api('/api/shortlist')).items[0].edits?.notes?.[0]?.text==='nice light');
  await page.click('.toolbelt [data-tool="eraser"]');
  const strokeBox=await page.locator('.board-card svg.marks polyline').first().boundingBox();
  await page.mouse.click(strokeBox.x+strokeBox.width/2,strokeBox.y+strokeBox.height/2);
  await page.waitForFunction(async()=>(await api('/api/shortlist')).items[0].edits?.marks?.length===1);
  await page.click('.toolbelt [data-tool="hand"]');
  await page.screenshot({path:OUT+'/LB-annotated.png'});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(800);
  const phone=await page.evaluate(()=>({card:document.querySelector('.board-card').getBoundingClientRect().toJSON(),sheet:!!document.querySelector('.photo-note-sheet'),
    arrows:[...document.querySelectorAll('.board-arrow')].map(e=>e.getBoundingClientRect().toJSON()),overflow:document.documentElement.scrollWidth>innerWidth}));
  assert(!phone.overflow,'The phone finishing view fits the page');
  assert(phone.card.height>250,`The phone gives the shot usable space: ${JSON.stringify(phone)}`);
  assert(Math.abs((phone.arrows[0].top+phone.arrows[0].height/2)-(phone.arrows[1].top+phone.arrows[1].height/2))<2,'Both rank arrows sit beside the card');
  await page.screenshot({path:OUT+'/LB-phone.png'});
  await page.locator('.board-card .photo-notes-tab').focus();await page.keyboard.press('Enter');await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');
  await page.click('[data-notes-page=look]');await page.waitForSelector('.photo-note-sheet [data-edit=enhance]');
  assert.equal(await page.locator('#modal[open] .exported').count(),0,'Enter on the notes corner opens it without exporting');
  await page.screenshot({path:OUT+'/LB-phone-finishing.png'});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({first:{...first,text:first.text.slice(0,120)},photos,spots,modes,saved,phone,overlaps}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
