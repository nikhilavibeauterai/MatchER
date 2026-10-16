// The popup uses real pyramid levels and decoded full-size pixels, including slow, failed and stale upgrades.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),problems=[],cases=[];
  for(const dpr of [1,2]){
    const context=await browser.newContext({viewport:{width:1100,height:650},deviceScaleFactor:dpr}),page=await context.newPage();
    page.on('pageerror',e=>problems.push(e.message));
    await page.goto(LINK);
    if(await page.locator('#path').count()){
      await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
      await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');
    }
    await page.waitForSelector('.journey');await page.waitForFunction(()=>World.photos?.size&&!World.loading);
    const photos=await page.evaluate(()=>[...World.photos.values()].filter(p=>p.dims[1]>p.dims[0]).slice(0,3).map(p=>({id:p.id,dims:p.dims,thumb:T(p.id)})));
    assert.equal(photos.length,3);
    const full=new Map();
    for(const photo of photos){
      const jpeg=await(await page.request.get(new URL(photo.thumb,BASE).href)).body(),height=3200,width=Math.round(height*photo.dims[0]/photo.dims[1]);
      full.set(photo.id,`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image href="data:image/jpeg;base64,${jpeg.toString('base64')}" width="${width}" height="${height}"/><path fill="#12de56" d="M0 0h32v32H0z"/></svg>`);
    }
    const pid=photos[0].id,attempts=new Map();let release=null,fail=true;
    await page.route(/\/img\/[tp]\/\d+\.jpg\?.*m=full/,async route=>{
      const id=Number(new URL(route.request().url()).pathname.match(/\/(\d+)\.jpg$/)[1]);
      if(!full.has(id))return route.continue();
      attempts.set(id,(attempts.get(id)||0)+1);
      if(id===pid&&fail)return route.fulfill({status:503,body:'temporary original failure'});
      if(release)await release.wait;
      return route.fulfill({contentType:'image/svg+xml',body:full.get(id)}).catch(()=>{});
    });
    const level=()=>page.evaluate(()=>{const img=document.querySelector('.viewer .window img'),url=new URL(img.getAttribute('src'),location.href);return {level:url.searchParams.get('m')||(/\/t\//.test(url.pathname)?'400':'1600'),width:img.naturalWidth,height:img.naturalHeight,ready:img.complete&&!!img.naturalWidth,zoom:Number(img.closest('.print').dataset.viewerZoom)};});
    const waitLevel=async expected=>{
      await page.waitForFunction(expected=>{const img=document.querySelector('.viewer .window img'),url=new URL(img.getAttribute('src'),location.href);return img.complete&&img.naturalWidth&&(url.searchParams.get('m')||(/\/t\//.test(url.pathname)?'400':'1600'))===expected;},expected);
      return level();
    };
    const open=async id=>{
      await page.evaluate(id=>openViewer(id),id);await page.waitForSelector('.viewer .photo-sticky');await page.evaluate(()=>document.fonts.ready);
      await page.waitForFunction(()=>[...PhotoNotes.hosts].filter(([host])=>host.closest('.viewer')).every(([,state])=>!state.loading));
    };
    const zoomTo=async wanted=>{
      let current=(await level()).zoom;
      while(Math.abs(Math.log(wanted/current))>.005){
        await page.mouse.move(550,260);await page.mouse.wheel(0,-Math.max(-480,Math.min(480,Math.log(wanted/current)/.0015)));
        await page.waitForTimeout(35);current=(await level()).zoom;
      }
    };
    await open(pid);const initial=await waitLevel(dpr===1?'400':'800');
    const threshold=await page.locator('.viewer .print').evaluate(card=>innerHeight*.8/card.getBoundingClientRect().height);
    await zoomTo(threshold*.95);const middle=await waitLevel(dpr===1?'800':'1600');assert.equal(attempts.get(pid)||0,0,'The original is not requested below the full-print threshold');
    const failed=page.waitForResponse(r=>r.url().includes(`/${pid}.jpg`)&&r.url().includes('m=full')&&r.status()===503);
    await zoomTo(threshold*1.15);await failed;assert.deepEqual(await level(),{...middle,zoom:(await level()).zoom},'A failed upgrade keeps the last decoded image');
    let unlock;release={wait:new Promise(resolve=>{unlock=resolve;})};fail=false;const failedAttempts=attempts.get(pid);
    const pending=page.waitForRequest(r=>r.url().includes(`/${pid}.jpg`)&&r.url().includes('m=full'));
    await zoomTo(threshold*1.4);await pending;
    for(let i=0;i<5;i++)await page.mouse.wheel(0,-25);
    await page.waitForTimeout(200);assert.equal(attempts.get(pid),failedAttempts+1,'Rapid wheel events share one pending original');
    assert((await level()).ready&&(await level()).level!=='full','The preview remains visible while the original decodes');
    await page.screenshot({path:`${OUT}/VL-loading-${dpr}.png`});unlock();release=null;
    await waitLevel('full');
    await page.waitForFunction(()=>document.querySelector('.viewer .window img').naturalHeight===3200);
    const original=await level(),pixel=await page.locator('.viewer .window img').evaluate(img=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(0,0,1,1).data];});
    assert.deepEqual(pixel,[18,222,86,255],'The visible image contains the decoded original pixels');
    assert(original.height>middle.height,'The original has more pixels than the preview');
    await page.screenshot({path:`${OUT}/VL-original-${dpr}.png`});
    await page.click('[data-viewer-reset]');await waitLevel(initial.level);await page.click('.viewer #close-modal');
    // A late full-size response must not replace a reset preview.
    await open(photos[1].id);await waitLevel(initial.level);
    let finish;release={wait:new Promise(resolve=>{finish=resolve;})};
    const late=page.waitForRequest(r=>r.url().includes(`/${photos[1].id}.jpg`)&&r.url().includes('m=full'));
    await zoomTo(threshold*1.5);await late;await page.click('[data-viewer-reset]');await page.waitForTimeout(200);finish();release=null;
    await waitLevel(initial.level);assert.equal((await level()).zoom,1);
    await page.waitForTimeout(150);assert.notEqual((await level()).level,'full','A stale original cannot replace the current pyramid level');
    await page.click('.viewer #close-modal');
    // Size changes can cross the threshold without a wheel event.
    await open(photos[2].id);
    await page.locator('.viewer .print').evaluate(card=>{card.style.height=`${innerHeight*.85}px`;});
    await waitLevel('full');await page.waitForFunction(()=>document.querySelector('.viewer .window img').naturalHeight===3200);
    assert.equal((await level()).zoom,1,'The original loads whenever the card is big enough, including at fitted zoom');
    await page.click('.viewer #close-modal');cases.push({dpr,initial,middle,original,pixel,attempts:[...attempts]});await context.close();
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({cases,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
