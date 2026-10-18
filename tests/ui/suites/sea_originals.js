// Check the displayed pixels, not just the URL: a tiny world-space card must retain full detail at deep zoom.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),path=require('node:path');
const {LINK,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']}),cases=[],problems=[];
  for(const [dpr,hovered]of [[1,false],[1,true],[2,false],[2,true]]){
    const label=`${dpr}${hovered?'-hover':''}`;
    const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:dpr}),page=await context.newPage();
    page.on('pageerror',e=>problems.push(e.message));await page.goto(LINK);await page.waitForSelector('.mode-card[data-mode=gallery]');
    const fixtures=await page.evaluate(()=>{
      const full=document.createElement('canvas');full.width=2400;full.height=3200;const ctx=full.getContext('2d');
      ctx.fillStyle='#eee';ctx.fillRect(0,0,2400,3200);ctx.fillStyle='#111';
      for(let y=0;y<3200;y+=16)for(let x=0;x<2400;x+=16)if((x+y)/16%2)ctx.fillRect(x,y,16,16);
      const small=document.createElement('canvas');small.width=12;small.height=16;small.getContext('2d').drawImage(full,0,0,12,16);
      return {full:full.toDataURL().split(',')[1],small:small.toDataURL().split(',')[1]};
    });
    let originals=0,release,waiting=new Promise(resolve=>{release=resolve;});
    await page.route(/\/img\/[tp]\/900001\.jpg/,async r=>{
      const full=new URL(r.request().url()).searchParams.get('m')==='full';
      if(full){if(++originals===1)return r.fulfill({status:503,body:'temporary original failure'});await waiting;}
      return r.fulfill({contentType:'image/png',body:Buffer.from(full?fixtures.full:fixtures.small,'base64')}).catch(()=>{});
    });
    await page.route('**/api/edit?photo=900001',r=>r.fulfill({json:{edits:{}}}));
    await page.evaluate(hovered=>{
      const s=World.sea;World.mode='focus';World.stale=false;document.body.classList.remove('no-bar');document.body.dataset.world='ambient';
      World.el.style.opacity='1';World.el.style.transition='none';
      s.tune({wobbleDeg:0},false);s.setVenn([],[{id:900001,photo:900001,n:1,tags:[],dims:[2400,3200]}]);
      clearInterval(World.watch);s.worker.terminate();s.busy=false;s.kick=()=>{};cancelAnimationFrame(s.raf);s.raf=0;
      const it=s.items.get(900001),H=s.el.clientHeight;
      // Pick a genuine floating-point miss: the click computes 80%, but multiplying it back is infinitesimally less.
      it.size=Array.from({length:1000},(_,i)=>(i+500)/127).find(size=>size*4/3*(.8*H/(size*4/3))<.8*H)||6;
      it.x=s.el.clientWidth/2;it.y=H/2;s.paintItem(it,true);s.cameraOn=true;window.originalItem=it;S.crop='off';S.filter=true;
      window.originalZoom=share=>{const z=share*H/(it.size*4/3*(it.renderScale||1));s.setCamera(z,s.el.clientWidth/2-it.x*z,H/2-it.y*z);};
      if(hovered)s.hold(it.id);
      originalZoom(.79);s.cull(true);
    },hovered);
    await page.waitForFunction(()=>{const img=originalItem.el.querySelector('.pile-cover');return img?.complete&&img.naturalHeight===16&&!originalItem.imagePending;});
    assert.equal(originals,0,'Smaller prints never request originals');
    await page.evaluate(()=>window.originalImage=originalItem.el.querySelector('.pile-cover'));
    const failed=page.waitForResponse(r=>r.url().includes('900001.jpg')&&r.url().includes('m=full')&&r.status()===503);
    await page.evaluate(()=>originalZoom(.8));await failed;
    const pending=page.waitForRequest(r=>r.url().includes('900001.jpg')&&r.url().includes('m=full'));await pending;
    for(const share of [.81,.84,.82])await page.evaluate(share=>originalZoom(share),share);
    await page.waitForTimeout(180);assert.equal(originals,2,'Camera changes share one pending original, with one automatic retry after failure');
    const retained=await page.evaluate(()=>({same:originalItem.el.querySelector('.pile-cover')===originalImage,visible:getComputedStyle(originalImage).visibility,
      height:originalImage.naturalHeight,pending:!!originalItem.imagePending,src:originalImage.getAttribute('src')}));
    assert(retained.same&&retained.visible==='visible'&&!retained.pending&&retained.height===16&&!retained.src.includes('m=full'),`Failed and delayed upgrades retain the decoded photo: ${JSON.stringify(retained)}`);
    release();
    await page.waitForFunction(()=>{const img=originalItem.el.querySelector('.pile-cover');return img?.complete&&img.naturalHeight===3200&&!originalItem.imagePending;});
    await page.waitForFunction(()=>getComputedStyle(originalItem.el).opacity==='1');
    // Compare at native pixel scale, where minification phase cannot make one fine checker look sharper by aliasing.
    await page.evaluate(()=>{const img=originalItem.el.querySelector('.pile-cover');originalZoom(.82*img.naturalHeight/img.getBoundingClientRect().height);});
    await page.waitForTimeout(200);
    const state=await page.evaluate(()=>{
      const img=originalItem.el.querySelector('.pile-cover');World.sea.frameImage(originalItem);const r=img.getBoundingClientRect();
      return {src:img.getAttribute('src'),width:img.naturalWidth,height:img.naturalHeight,filter:img.style.filter,
        rect:{x:r.x,y:r.y,width:r.width,height:r.height},clip:{x:Math.floor(r.x+r.width/2-60),y:Math.floor(r.y+r.height/2-60),width:120,height:120}};
    });
    const shown=await page.screenshot({clip:state.clip,path:`${OUT}/sea-original-${label}.png`});
    await page.evaluate(async()=>{
      const img=originalItem.el.querySelector('.pile-cover'),r=img.getBoundingClientRect(),reference=new Image(),win=document.createElement('div');reference.src=img.src;await reference.decode();
      win.className='window';win.id='original-reference';win.style.cssText=`position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;z-index:100000`;
      reference.style.cssText=`position:absolute;left:0;top:0;width:100%;height:100%;padding:0;border:0;max-width:none;object-fit:fill;animation:none;filter:${img.style.filter}`;
      win.append(reference);World.el.append(win);  // the reference stays visible when deep zoom hides page chrome
    });
    assert.equal(await page.locator('#original-reference img').evaluate(el=>getComputedStyle(el).visibility),'visible','The screen-space reference must be rendered too');
    const reference=await page.screenshot({clip:state.clip,path:`${OUT}/sea-original-reference-${label}.png`});
    const pixels=JSON.parse(execFileSync(path.resolve(__dirname,'../../../.venv/bin/python'),['-c',`
import base64, io, json, sys
from PIL import Image
images = [Image.open(io.BytesIO(base64.b64decode(s))).convert('L') for s in json.load(sys.stdin)]
def detail(im):
    return sum(abs(im.getpixel((x,y))-im.getpixel((x-1,y))) for y in range(im.height) for x in range(1,im.width))/(im.height*(im.width-1))
print(json.dumps(dict(shown=detail(images[0]), reference=detail(images[1]))))
`],{input:JSON.stringify([shown.toString('base64'),reference.toString('base64')]),encoding:'utf8'}));
    cases.push({dpr,hovered,retained,state,pixels});assert(pixels.reference>8/dpr,`The original fixture has real fine detail: ${JSON.stringify(cases.at(-1))}`);
    assert(pixels.shown>pixels.reference*.75,`The displayed original stays as detailed as a screen-sized photo: ${JSON.stringify(cases.at(-1))}`);
    await page.evaluate(()=>document.getElementById('original-reference').remove());
    await page.evaluate(()=>originalZoom(2.5));await page.waitForTimeout(200);
    assert(await page.evaluate(()=>originalImage.naturalHeight===3200&&originalImage.src.includes('m=full')&&originalItem.el.getBoundingClientRect().height>innerHeight*2),'Zooming into part of the photo keeps the original');
    await page.screenshot({path:`${OUT}/sea-original-part-${label}.png`});
    await page.evaluate(()=>originalZoom(.79));await page.waitForFunction(()=>originalImage.naturalHeight===16);
    await page.evaluate(()=>{S.lib={image_key:'late-original'};}); // The earlier decoded original is intentionally still in the browser cache.
    let finish;waiting=new Promise(resolve=>{finish=resolve;});
    const late=page.waitForRequest(r=>r.url().includes('900001.jpg')&&r.url().includes('m=full'));
    await page.evaluate(()=>originalZoom(.85));await late;await page.evaluate(()=>originalZoom(.79));
    await page.waitForFunction(()=>!originalItem.imageRequest&&originalImage.naturalHeight===16);
    finish();
    await page.waitForFunction(()=>!originalItem.imageRequest);assert.equal(await page.evaluate(()=>originalImage.naturalHeight),16,'A late original cannot replace a zoomed-out preview');
    await context.close();
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({cases,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
