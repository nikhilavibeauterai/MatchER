// The stack inspector's scroll container must not clip a pulled-out notes sheet.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[],states=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading&&World.sea.settled);
  const pid=await page.evaluate(()=>[...World.sea.items.values()].find(it=>!it.take&&it.n>1).photo);
  for(const viewport of [{width:1440,height:900},{width:960,height:620},{width:390,height:844},{width:320,height:568}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(250);
    await page.evaluate(pid=>World.openStack(pid),pid);await page.waitForSelector('.inspect.open .photo-notes-tab');
    await page.waitForFunction(()=>!World.flights.size);await page.locator('.inspect .photo-notes-tab').first().focus();await page.keyboard.press('Enter');
    await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');
    for(const name of ['notes','tags','look','details']){
      await page.click(`[data-notes-page=${name}]`);
      await page.waitForTimeout(300);
      const state=await page.evaluate(()=>{
        const s=PhotoNotes.sheet,r=s.getBoundingClientRect(),points=[[r.left+5,r.top+5],[r.right-5,r.top+5],[r.left+5,r.bottom-5],[r.right-5,r.bottom-5]];
        return {width:innerWidth,height:innerHeight,paper:r.toJSON(),clipped:points.some(([x,y])=>!document.elementsFromPoint(x,y).some(el=>s.contains(el))),
          overflow:s.querySelector('.notes-page:not([hidden])').scrollWidth>s.querySelector('.notes-page:not([hidden])').clientWidth+1,
          nav:[...s.querySelectorAll('.notes-nav button')].every(b=>{const r=b.getBoundingClientRect();return r.height>=39&&r.right<innerWidth-6&&r.bottom<innerHeight-6&&document.elementFromPoint(r.right-15,r.bottom-12)?.closest('button')===b;})};
      });
      states.push({name,...state});
      assert(!state.clipped&&!state.overflow&&state.nav,`Every part of the pulled-out sheet remains usable: ${JSON.stringify(state)}`);
      assert(state.paper.left>=7&&state.paper.right<=viewport.width-7&&state.paper.top>=7&&state.paper.bottom<=viewport.height-7,JSON.stringify(state));
    }
    await page.screenshot({path:`${OUT}/stack-notes-${viewport.width}.png`});await page.keyboard.press('Escape');
    await page.locator('.inspect [data-in=close]').click();await page.waitForSelector('.inspect',{state:'detached'});await page.waitForFunction(()=>!World.flights.size);
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({states,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
