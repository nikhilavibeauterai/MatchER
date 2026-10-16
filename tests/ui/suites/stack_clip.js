// Stack counts are handwritten slips held by a shared paperclip, including the tile's usable Open control.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&!World.loading&&World.sea.settled);
  const shot=await page.evaluate(()=>{
    const it=[...World.sea.items.values()].find(it=>!it.take&&it.n>1);window.clipItem=it;World.sea.zoomToPrint(it);return {id:it.id,n:it.n};
  });
  await page.waitForSelector('.sea-photo-detail .photo-sticky');
  const sea=await page.evaluate(()=>{
    const card=clipItem.el,r=card.getBoundingClientRect(),clip=card.querySelector('.stack-clip'),slip=clip.querySelector('.stack-slip'),s=slip.getBoundingClientRect(),win=card.querySelector('.window').getBoundingClientRect();
    window.originalClip=clip;return {count:slip.textContent,paths:clip.querySelectorAll('svg path').length,left:s.left-r.left,top:s.top-r.top,bottom:s.bottom,photoTop:win.top,label:clip.getAttribute('aria-label')};
  });
  assert.equal(Number(sea.count),shot.n);assert(sea.paths>0);assert(sea.left<100&&sea.top<0,'The slip sits at the top-left');
  assert(sea.bottom<=sea.photoTop+3,'The count slip stays clear of the photo');assert.match(sea.label,/Stack of \d+ takes/);
  await page.screenshot({path:OUT+'/clip-sea.png'});
  for(const delta of [-40,40]){
    const before=await page.evaluate(()=>World.sea.camera.zoom);await page.mouse.move(720,420);await page.mouse.wheel(0,delta);
    await page.waitForFunction(before=>World.sea.camera.zoom!==before,before);
    assert(await page.evaluate(()=>clipItem.el.querySelector('.stack-clip')===originalClip),'Camera gestures keep the actual paperclip');
  }
  await page.evaluate(()=>location.hash='#stacks');await page.waitForSelector('.stacker .shot-pile .stack-clip');
  const tile=page.locator(`.stacker [data-drag-shot="${shot.id}"]`),clip=tile.locator('[data-expand]');
  assert.equal(await clip.locator('.stack-slip').innerText(),String(shot.n));assert.equal(await tile.locator('.stack-clip').count(),1,'Each pile has one clip');
  assert.equal(await clip.locator('input,button').count(),0,'The clip is one control without nested inputs or buttons');
  await page.screenshot({path:OUT+'/clip-stacks.png'});
  await clip.click();await page.waitForSelector('.tile.open .ftile');await page.waitForFunction(()=>!World.flights.size);assert.equal(await clip.getAttribute('aria-expanded'),'true');
  await page.waitForTimeout(700); // Let the fan's entry animation finish before reviewing its screenshot.
  await page.screenshot({path:OUT+'/clip-stack-open.png'});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await clip.scrollIntoViewIfNeeded();
  assert(await clip.isVisible());await page.screenshot({path:OUT+'/clip-stack-phone.png'});
  await clip.click();await page.waitForSelector('.tile.open',{state:'detached'});
  // Four-digit piles still fit their slip, and a single never acquires a count.
  const sizes=await page.evaluate(async()=>{
    const host=document.createElement('div');host.className='print';host.style.cssText='position:fixed;left:60px;top:200px;width:240px;height:320px;z-index:1000';
    host.innerHTML=`<div class="paper"><div class="window"></div></div>${Cards.stack(9999)}`;document.body.append(host);await document.fonts.ready;
    const slip=host.querySelector('.stack-slip'),style=getComputedStyle(slip),r=slip.getBoundingClientRect();
    return {single:Cards.stack(1),font:style.fontFamily,size:parseFloat(style.fontSize),width:r.width,fits:slip.scrollWidth<=slip.clientWidth+1};
  });
  assert.equal(sizes.single,'');assert(sizes.size>8&&sizes.fits,JSON.stringify(sizes));
  await page.screenshot({path:OUT+'/clip-large-count.png'});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({shot,sea,sizes,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
