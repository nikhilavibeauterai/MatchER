// Complete public-domain takes stay visible in steady comparison panels, with room for the surrounding sea.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:2048,height:1152}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading);
  const photos=await page.evaluate(async()=>{
    const ids=[...new Set([...World.photos.values()].map(p=>p.rep||p.id))].slice(0,24);
    return Promise.all(ids.map(async id=>{const img=new Image();img.src=P(id);await img.decode();return {id,ratio:img.naturalWidth/img.naturalHeight};}));
  });
  assert(photos.length>=4,'The public fixture needs four separate shots for two comparisons');
  photos.sort((a,b)=>a.ratio-b.ratio);
  const pairs=[[photos[0].id,photos.at(-1).id],[photos[1].id,photos.at(-2).id]].map(([a,b])=>({a,b,similarity:.95,seconds_apart:2,
    box_a:[.2,.72,.6,.2],box_b:[.1,.65,.75,.3]}));
  let index=0;
  await page.route('**/api/groups?view=suggest',r=>r.fulfill({json:{suggestions:pairs.slice(index),counts:{suggest:2-index}}}));
  await page.route('**/api/groups/merge',async r=>{const response=await r.fetch();if(response.ok())index=1;await r.fulfill({response});});
  await page.route('**/api/draw/undo',async r=>{const response=await r.fetch();if(response.ok())index=0;await r.fulfill({response});});
  await page.evaluate(()=>{
    window.twinMessages=[];const original=toast;toast=(message,...args)=>{twinMessages.push(message);return original(message,...args);};
    S.crop='best';location.hash='stacks?check=1';
  });
  await page.waitForSelector('.twin-arena');
  const measure=async()=>{
    await page.waitForFunction(()=>[...document.querySelectorAll('.twin-arena img')].length===2&&[...document.querySelectorAll('.twin-arena img')].every(img=>img.complete&&img.naturalWidth));
    await page.waitForTimeout(750);
    return page.evaluate(()=>{
      S.crop='best';paintCrops();World.fence();
      const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const arena=rect(document.querySelector('.twin-arena')),body=rect(document.querySelector('.twin-stage'));
      return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,arena,body,
        panels:[...document.querySelectorAll('.twin-arena .side')].map(side=>{
          const img=side.querySelector('img');return {photo:Number(side.dataset.photo),panel:rect(side),image:rect(img),fit:getComputedStyle(img).objectFit,
            natural:[img.naturalWidth,img.naturalHeight],scroll:side.scrollWidth>side.clientWidth+1||side.scrollHeight>side.clientHeight+1};
        }),head:[...document.querySelectorAll('.twins .screen-head > h1, .twins .screen-head > a, .twins .screen-head > button, .twins .screen-head > .stat-chip')].filter(el=>el.getClientRects().length).map(rect),controls:[...document.querySelectorAll('.twins .screen-bar button')].map(rect),photos:World.sea.items.size};
    });
  };
  const check=result=>{
    assert.equal(result.scrollWidth,result.width);
    assert(result.arena.width<=1241&&result.arena.height<=641,JSON.stringify(result));
    const left=result.arena.x,right=result.width-result.arena.right;
    assert(Math.min(left,right)>=result.width*.1&&Math.abs(left-right)<5,JSON.stringify(result));
    assert(result.arena.y>=result.body.y+16&&result.arena.bottom<=result.body.bottom-16,JSON.stringify(result));
    for(const {panel,image,fit,natural,scroll}of result.panels){
      assert.equal(fit,'contain','Auto-crop must never hide a difference between possible twins');assert(natural.every(n=>n>0));assert(!scroll);
      assert(image.x>=panel.x&&image.right<=panel.right&&image.y>=panel.y&&image.bottom<=panel.bottom,JSON.stringify({panel,image}));
    }
    assert(Math.abs(result.panels[0].panel.width-result.panels[1].panel.width)<1);
    assert(Math.abs(result.panels[0].panel.height-result.panels[1].panel.height)<1);
    assert(result.head.every(r=>r.x>=0&&r.right<=result.width),'The Twin check title and exits fit without horizontal scrolling');
    assert(result.controls.every(r=>r.x>=0&&r.right<=result.width&&r.y>=0&&r.bottom<=result.height));
    assert(result.photos>=photos.length);
  };
  const first=await measure();check(first);await page.screenshot({path:OUT+'/T-twin-check-2048.png'});
  const merge=page.waitForResponse(r=>r.url().endsWith('/api/groups/merge')&&r.request().method()==='POST');
  await page.keyboard.press('ArrowRight');assert((await merge).ok());
  await page.waitForFunction(id=>Number(document.querySelector('.twin-arena .side')?.dataset.photo)===id,pairs[1].a);
  const second=await measure();check(second);
  for(let i=0;i<2;i++)for(const key of ['x','y','width','height'])assert(Math.abs(first.panels[i].panel[key]-second.panels[i].panel[key])<1,'New takes keep the same comparison anchors');
  assert(!(await page.evaluate(()=>twinMessages)).some(message=>/now play as one stack|These shots will stay separate/.test(message)));
  const undo=page.waitForResponse(r=>r.url().endsWith('/api/draw/undo')&&r.request().method()==='POST');
  await page.keyboard.press('z');assert((await undo).ok());
  await page.waitForFunction(id=>Number(document.querySelector('.twin-arena .side')?.dataset.photo)===id,pairs[0].a);
  await page.setViewportSize({width:375,height:812});const phone=await measure();check(phone);
  await page.screenshot({path:OUT+'/T-twin-check-phone.png'});
  // Dragging one sea photo onto another must not revive the same removed helper popup.
  await page.evaluate(async([a,b])=>{twinMessages.length=0;await World.drop([a],{kind:'photo',id:b});},[pairs[0].a,pairs[0].b]);
  assert(!(await page.evaluate(()=>twinMessages)).some(message=>/now play as one stack/.test(message)));
  await page.evaluate(()=>api('/api/draw/undo',{}));
  assert.deepEqual(problems,[]);console.log(JSON.stringify({first,second,phone,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
