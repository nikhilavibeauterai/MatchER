// Every comparison uses the sea camera; an opaque sea must never cover the focused photo during zoom.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),path=require('node:path');
const {BASE,LINK,LIB,OUT}=process.env;
let page;
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  const problems=[],writes=[],cases=[];page.on('pageerror',e=>problems.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(vote|edit|draw|groups)\b/.test(new URL(r.url()).pathname))writes.push(r.url());});
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading);
  const ids=await page.evaluate(async()=>{
    const world=await api('/api/world?per=1000');await api('/api/rescue',{ids:world.photos.map(p=>p.id),on:true});
    const b=await api('/api/groups?view=all&per=400');for(const s of b.shots)for(const id of s.members.filter(id=>id!==s.rep))await api('/api/groups/split',{photo:id});
    const ids=world.photos.map(p=>p.id);await api('/api/draw/new',{photos:ids});return ids;
  });
  const exercise=async(route,selector,label)=>{
    await page.goto(BASE+'/'+route);await page.waitForSelector(selector);
    await page.waitForFunction(selector=>{const p=document.querySelector(selector),img=p?.querySelector('.window img');return p?.closest('.focus-camera')&&img?.complete&&img.naturalWidth&&!document.querySelector('.world-fly');},selector);
    await page.waitForTimeout(1000);
    const print=page.locator(selector).first(),origin=await print.boundingBox(),calls=writes.length;
    assert(origin.width>60,'A focused photo has a usable paper width');
    const point={x:Math.round(origin.x+origin.width/2),y:Math.round(origin.y+origin.height*.45)};
    await page.mouse.move(point.x,point.y);await page.waitForTimeout(400);await page.mouse.wheel(0,-600);
    await page.waitForFunction(()=>World.sea.camera.zoom>1.5);
    const waitMip=()=>page.waitForFunction(selector=>{const p=document.querySelector(selector),img=p.querySelector('.window img'),r=p.getBoundingClientRect(),picture=img.getBoundingClientRect();return img.getAttribute('src')===M(Toolbelt.pidOf(p),Math.max(picture.width,picture.height),r.height>=innerHeight*.8)&&img.complete;},selector);
    await waitMip();
    await print.locator('.window img').evaluate(async img=>{await img.decode();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    const zoom=await page.evaluate(()=>({...World.sea.camera})),large=await print.locator('.window img').getAttribute('src');
    assert((await print.boundingBox()).height>origin.height*1.5,'The focused print, as well as the sea, grows');
    const window=await print.locator('.window').boundingBox(),screen=page.viewportSize();
    const cx=(Math.max(0,window.x)+Math.min(screen.width,window.x+window.width))/2,cy=(Math.max(80,window.y)+Math.min(screen.height,window.y+window.height))/2;
    const clip={x:Math.round(cx)-15,y:Math.round(cy)-15,width:30,height:30};
    const shown=await page.screenshot({clip,animations:'disabled',path:`${OUT}/focus-${label}-pixels.png`});
    await page.evaluate(()=>World.el.style.visibility='hidden');
    const reference=await page.screenshot({clip,animations:'disabled',path:`${OUT}/focus-${label}-reference.png`});await page.evaluate(()=>World.el.style.visibility='');
    const error=Number(execFileSync(path.resolve(__dirname,'../../../.venv/bin/python'),['-c',
      'import base64,io,json,sys;import numpy as np;from PIL import Image;a,b=[np.asarray(Image.open(io.BytesIO(base64.b64decode(s))).convert("RGB"),dtype=float) for s in json.load(sys.stdin)];print(float(np.abs(a.mean((0,1))-b.mean((0,1))).mean()))'
    ],{input:JSON.stringify([shown.toString('base64'),reference.toString('base64')]),encoding:'utf8'}));
    assert(error<2,`The focused photo stays above the opaque sea (${label}: ${error})`);
    await page.mouse.down();await page.mouse.move(point.x-65,point.y-45,{steps:6});await page.mouse.up();
    const panned=await page.evaluate(()=>({...World.sea.camera}));
    assert(Math.abs(panned.tx-zoom.tx+65)<3&&Math.abs(panned.ty-zoom.ty+45)<3,'A close-up drag pans the shared camera');
    assert.equal(writes.length,calls,'Zooming and panning never vote, file or edit');
    const glow=await page.evaluate(()=>{const focus=World.draftCamera;return{n:focus.layer.querySelectorAll(':scope > .photo-glow').length,paper:focus.prints.length,front:Number(getComputedStyle(focus.layer).zIndex),back:Number(getComputedStyle(World.el).zIndex),glows:[...focus.layer.querySelectorAll(':scope > .photo-glow')].map(g=>({z:Number(getComputedStyle(g).zIndex),events:getComputedStyle(g).pointerEvents}))};});
    assert.equal(glow.n,glow.paper,'Every focused print casts a glow beneath the shared photo layer');
    assert(glow.front>glow.back&&glow.glows.every(g=>g.z===0&&g.events==='none'),'Glow cannot obscure a photo or intercept input');
    await page.screenshot({path:`${OUT}/focus-${label}.png`});
    await page.mouse.dblclick(point.x-65,point.y-45);await page.waitForFunction(()=>World.sea.camera.zoom===1);
    await waitMip();
    const small=await print.locator('.window img').getAttribute('src');
    assert.equal(writes.length,calls,'Resetting the view is not a vote');cases.push({label,zoom:zoom.zoom,error,glow,large,small});
  };
  await exercise('#duel?stage=groups','#stage .side .print','groups');
  await page.evaluate(()=>api('/api/knockouts/start',{}));await exercise('#duel?stage=knockouts','#stage .side .print','knockouts');
  await exercise('#duel?stage=open','#stage .side .print','open');
  await page.goto(BASE+'/#finals');await page.waitForSelector('#journey-next.ready');await page.click('#journey-next');await page.waitForSelector('#f-arena .side .print');
  await exercise('#finals','#f-arena .side .print','finals');
  await exercise('#shortlist','.board-fit .print','leaderboard');
  await exercise('#reveal','.podium .print','reveal');
  await page.setViewportSize({width:390,height:844});await exercise('#duel?stage=groups','#stage .side .print','groups-phone');
  const start=await page.evaluate(()=>({id:S.current.id,calls:S.progress.votes}));
  await page.keyboard.press('ArrowLeft');await page.waitForFunction(id=>!S.busy&&S.current?.id!==id,start.id);
  assert.equal((await page.evaluate(()=>World.sea.camera.zoom)),1,'The next comparison starts with the whole sea');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({cases,problems}));await browser.close();
})().catch(async error=>{console.error('FAILED:',error.stack);if(page)await page.screenshot({path:OUT+'/focus-camera-failure.png'}).catch(()=>{});process.exit(1);});
