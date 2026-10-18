// Replay a busy analysis over public fixture pixels: shared tags must not pile every photo against one side.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
const COUNT=1879,FIRST=50000;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:2048,height:1152}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading);
  const source=await page.evaluate(async()=>{
    const id=World.photos.values().next().value.id,image=new Image();image.src=T(id);await image.decode();
    const atlas=document.createElement('canvas');atlas.width=800;atlas.height=160;
    const ctx=atlas.getContext('2d');for(let i=0;i<500;i++)ctx.drawImage(image,i%50*16,Math.floor(i/50)*16,16,16);
    return {state:await api('/api/state'),thumbnail:T(id),preview:P(id),atlas:atlas.toDataURL('image/png').split(',')[1]};
  });
  const thumbnail=await page.request.get(new URL(source.thumbnail,LINK).href),preview=await page.request.get(new URL(source.preview,LINK).href);
  assert(thumbnail.ok()&&preview.ok(),'The replay only uses images from the public fixture library');
  const pixels={t:await thumbnail.body(),p:await preview.body()},atlas=Buffer.from(source.atlas,'base64');
  await page.route(/\/img\/[tp]\/\d+\.jpg(?:\?|$)/,r=>{
    const match=new URL(r.request().url()).pathname.match(/\/([tp])\/(\d+)\.jpg$/),id=Number(match?.[2]);
    return id>=FIRST&&id<FIRST+COUNT?r.fulfill({contentType:'image/jpeg',body:pixels[match[1]]}):r.continue();
  });
  await page.route('**/img/atlas.jpg?*',r=>{
    const ids=(new URL(r.request().url()).searchParams.get('ids')||'').split(',').map(Number);
    return ids.length&&ids.every(id=>id>=FIRST&&id<FIRST+COUNT)?r.fulfill({contentType:'image/png',body:atlas}):r.continue();
  });
  const read=Array.from({length:COUNT},(_,i)=>[FIRST+i,[[.25,.2,.4,.5]],0,0]);
  const cats=Array.from({length:COUNT},(_,i)=>[FIRST+i,'people',[
    ['🎭',`Subject ${i%18+1}`,.9,`subject:${i%18}`],['🎨',`Look ${i%7+1}`,.85,`look:${i%7}`]]]);
  let started=0;
  const available=()=>Math.min(COUNT,Math.floor((Date.now()-started)/600)*100);
  await page.route('**/api/state',r=>{
    const done=available(),phase=done?'understanding':'reading';
    return r.fulfill({json:{...source.state,library:{...source.state.library,analyzed:false,analyzing:true,
      progress:{phase,done:done||COUNT,total:COUNT}}}});
  });
  await page.route('**/api/analysis/feed?*',r=>{
    const q=new URL(r.request().url()).searchParams,feed={read,cats:cats.slice(0,available()),seen:[],identity:[],org:[]},body={};
    for(const [key,rows]of Object.entries(feed)){const since=Number(q.get(key)||0);body[key]=rows.slice(since,since+500);body[`${key}_n`]=rows.length;}
    return r.fulfill({json:body});
  });
  await page.evaluate(()=>{
    // Capture the instance through the public prototype; the application needs no test-only global.
    const replay=window.analysisSeaReplay={sea:null,updates:[],clusters:[],responses:0,floatingLabels:0};
    const set=VennSea.prototype.setVenn,receive=VennSea.prototype.receive;
    VennSea.prototype.setVenn=function(...args){
      if(this.el.id==='an-sea'){replay.sea=this;replay.updates.push(performance.now());}
      return set.apply(this,args);
    };
    VennSea.prototype.receive=function(m){
      if(this.el.id==='an-sea'){
        replay.responses++;
        if(m.clusterMs)replay.clusters.push({at:performance.now(),ms:m.clusterMs});
      }
      const result=receive.call(this,m);
      if(this.el.id==='an-sea')replay.floatingLabels+=this.el.querySelectorAll(':scope > .vn-lasso-tag').length;
      return result;
    };
    replay.restore=()=>{VennSea.prototype.setVenn=set;VennSea.prototype.receive=receive;};
  });
  started=Date.now();
  await page.evaluate(async()=>{await loadState();history.replaceState(null,'','#analyze');route();});
  await page.waitForFunction(count=>analysisSeaReplay.sea?.items.size===count,COUNT);
  await page.mouse.move(2020,30);
  const processing=await page.evaluate(async()=>{
    const replay=analysisSeaReplay,start=performance.now();await sleep(12000);const end=performance.now();
    return {elapsed:end-start,updates:replay.updates.filter(t=>t>=start&&t<=end).length,
      clustering:replay.clusters.filter(c=>c.at>=start&&c.at<=end),responses:replay.responses,floatingLabels:replay.floatingLabels};
  });
  // Wait for a fully open real spotlight before measuring its exclusion area and taking the screenshot.
  await page.waitForFunction(()=>{
    const sea=analysisSeaReplay.sea,box=sea.el.querySelector('.an-grab.open'),image=box?.querySelector('.an-grab-photo img');
    if(!box||!image?.complete||!image.naturalWidth||!sea.obstacles?.length)return false;
    const replay=analysisSeaReplay;
    if(replay.spotlight!==box){replay.spotlight=box;replay.spotlightAt=performance.now();return false;}
    return performance.now()-replay.spotlightAt>350;
  },null,{timeout:6500});
  const settled=await page.evaluate(()=>{
    const sea=analysisSeaReplay.sea,bounds=sea.bounds(),all=[...sea.items.values()];
    const items=all.filter(it=>!it.el.classList.contains('lifted'));
    const rows=new Map(),columns=new Map();
    for(const it of items){const x=Math.round(it.x/4),y=Math.round(it.y/4);columns.set(x,(columns.get(x)||0)+1);rows.set(y,(rows.get(y)||0)+1);}
    const aligned=axis=>{
      let peak=0;
      for(let period=16;period<=96;period+=2){
        const bins=new Map();for(const it of items){const bin=Math.floor((it[axis]%period)/4);bins.set(bin,(bins.get(bin)||0)+1);}
        peak=Math.max(peak,...bins.values());
      }
      return peak/items.length;
    };
    const penetration=items.filter(it=>bounds.obstacles.some(o=>{
      const half=(it.size||sea.s)*.5;
      return it.x+half>o.x0+1&&it.x-half<o.x1-1&&it.y+half>o.y0+1&&it.y-half<o.y1-1;
    })).map(it=>it.id);
    const canvas=sea.gpu?sea.spriteCanvas:sea.densityCanvas;
    let pixels;
    if(sea.gpu){sea.drawSprites(sea.width,sea.height);pixels=new Uint8Array(canvas.width*canvas.height*4);
      const gl=sea.gpu.gl;gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);}
    else pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let painted=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])painted++;
    return {photos:all.length,bodies:sea.bodies.length,dom:sea.moving.length,painted,
      left:items.filter(it=>it.x<bounds.width/2-30).length/items.length,
      right:items.filter(it=>it.x>bounds.width/2+30).length/items.length,
      finite:items.every(it=>Number.isFinite(it.x)&&Number.isFinite(it.y)),penetration,
      maxRow:Math.max(...rows.values())/items.length,maxColumn:Math.max(...columns.values())/items.length,
      alignedX:aligned('x'),alignedY:aligned('y'),
      tagged:all.filter(it=>it.tags.length>=3).length,tags:[...sea.circles.keys()],
      spotlight:Number(sea.el.querySelector('.an-grab.open').dataset.photo),
      phase:document.querySelector('#an-body').dataset.scene,
      positions:items.map(it=>[it.id,it.x,it.y])};
  });
  await page.screenshot({path:OUT+'/A-analysis-1879-photos.png'});
  assert.equal(settled.photos,COUNT);assert.equal(settled.bodies,COUNT);assert(settled.dom<=400,'Live prints stay within the tuned limit');assert(settled.finite);
  assert(settled.painted>10000,'Miniature public thumbnails must be drawn, not just empty photo nodes');
  assert(settled.left>=.2&&settled.right>=.2,JSON.stringify({...settled,positions:undefined}));
  assert.deepEqual(settled.penetration,[],'Ambient photos stay outside the spotlight and tag shelf');
  assert(settled.maxRow<.08&&settled.maxColumn<.08,'No narrow row or column traps a substantial part of the swarm');
  assert(settled.alignedX<.5&&settled.alignedY<.5,'The swarm must not settle onto regularly spaced rows or columns');
  assert(settled.tagged>COUNT*.85);assert(settled.tags.includes('faces'));
  for(let i=0;i<18;i++)assert(settled.tags.includes(`subject:${i}`));
  for(let i=0;i<7;i++)assert(settled.tags.includes(`look:${i}`));
  assert(settled.spotlight>=FIRST&&settled.spotlight<FIRST+COUNT);assert.equal(settled.phase,'understanding');
  assert(processing.updates>40,'Recognition must exercise the frequent live tag updates');
  assert.equal(processing.floatingLabels,0,'New group labels join the shelf immediately, without flashing over the photos');
  assert(processing.clustering.length>0&&processing.clustering.length<=15,JSON.stringify(processing));
  assert(processing.clustering.every(c=>Number.isFinite(c.ms)&&c.ms>=0),'Full worker clustering timings are reported');
  await page.waitForFunction(()=>analysisSeaReplay.sea.settled&&!document.querySelector('.an-grab'),null,{timeout:45000});
  const rest=await page.evaluate(()=>[...analysisSeaReplay.sea.items.values()].map(it=>[it.id,it.x,it.y]));
  await page.waitForTimeout(1200);
  const moving=await page.evaluate(previous=>previous.filter(([id,x,y])=>{
    const it=analysisSeaReplay.sea.items.get(id);return Math.hypot(it.x-x,it.y-y)>.01;
  }).length,rest);
  assert.equal(moving,0,'Photos settle between discoveries instead of vibrating indefinitely');
  const water=()=>page.evaluate(()=>{
    const sea=analysisSeaReplay.sea,r=sea.el.getBoundingClientRect();
    for(let y=r.top+80;y<r.bottom-60;y+=23)for(let x=r.left+80;x<r.right-80;x+=29){
      const el=document.elementFromPoint(x,y),[wx,wy]=sea.toWorld(x-r.left,y-r.top);
      if(sea.el.contains(el)&&!sea.uiTarget(el)&&!sea.photoAt(wx,wy))return {x,y,under:[wx,wy]};
    }
  });
  const point=await water();assert(point,'Analysis leaves open water for camera gestures');
  await page.mouse.move(point.x,point.y);await page.mouse.wheel(0,-600);await page.waitForTimeout(300);
  const zoomed=await page.evaluate(point=>{
    const sea=analysisSeaReplay.sea,r=sea.el.getBoundingClientRect();
    return {...sea.camera,under:sea.toWorld(point.x-r.left,point.y-r.top),worldZoom:World.sea.camera.zoom};
  },point);
  assert(zoomed.zoom>1.5,'The real wheel zooms the analysis sea');assert.equal(zoomed.worldZoom,1,'The hidden world does not take the gesture');
  assert(Math.hypot(zoomed.under[0]-point.under[0],zoomed.under[1]-point.under[1])<2,'Zoom stays anchored to the pointer');
  const pan=await water();assert(pan);
  await page.mouse.move(pan.x,pan.y);await page.mouse.down();await page.mouse.move(pan.x+100,pan.y+60,{steps:8});await page.mouse.up();
  const panned=await page.evaluate(()=>({...analysisSeaReplay.sea.camera,panning:document.body.classList.contains('sea-panning')}));
  assert(Math.abs(panned.tx-zoomed.tx-100)<3&&Math.abs(panned.ty-zoomed.ty-60)<3&&!panned.panning,JSON.stringify({zoomed,panned}));
  await page.mouse.move(100,40);await page.mouse.wheel(0,-600);await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>analysisSeaReplay.sea.camera.zoom),panned.zoom,'The analysis header keeps its own wheel');
  const reset=await water();assert(reset);await page.mouse.dblclick(reset.x,reset.y);await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>analysisSeaReplay.sea.camera.zoom),1,'Double-clicking water fits the whole analysis sea');
  const print=await page.evaluate(()=>{
    const sea=analysisSeaReplay.sea,r=sea.el.getBoundingClientRect();
    for(const it of sea.items.values()){
      const x=r.left+it.x,y=r.top+it.y,el=document.elementFromPoint(x,y);
      if(it.density&&sea.el.contains(el)&&!sea.uiTarget(el,true)&&sea.smallAt(it.x,it.y)?.id===it.id)return {id:it.id,x,y};
    }
  });
  assert(print,'An atlas photo is reachable while analysis runs');
  await page.mouse.click(print.x,print.y);await page.waitForTimeout(600);
  const focused=await page.evaluate(id=>{
    const sea=analysisSeaReplay.sea,it=sea.items.get(id),r=it.el.getBoundingClientRect();
    return {zoom:sea.camera.zoom,live:!it.density,height:r.height,viewport:sea.el.clientHeight,spotlights:sea.el.querySelectorAll('.an-grab').length};
  },print.id);
  assert(focused.live&&focused.zoom>3&&focused.height>=focused.viewport*.79,JSON.stringify(focused));
  assert.equal(focused.spotlights,0,'Automatic spotlights yield while the user inspects a photo');
  await page.screenshot({path:OUT+'/A-analysis-zoomed.png'});
  await page.mouse.wheel(0,10000);await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>analysisSeaReplay.sea.camera.zoom),1,'The real wheel zooms back out during analysis');
  delete settled.positions;
  await page.evaluate(()=>analysisSeaReplay.restore());
  const writes=[];
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/(library|rescan)$/.test(new URL(request.url()).pathname))writes.push(request.url());});
  const reloadAt=Date.now();await page.reload();
  await page.waitForFunction(count=>Number(document.querySelector('#an-sea')?.dataset.photos)===count,COUNT);
  await page.waitForFunction(()=>document.querySelectorAll('#an-sea .vn-tags [data-tag],.analyzing > .vn-catalog [data-tag]').length>=27);
  const refreshed=await page.evaluate(()=>({photos:Number(document.querySelector('#an-sea').dataset.photos),
    phase:document.querySelector('#an-body').dataset.scene,label:document.querySelector('#an-label').textContent,
    tags:document.querySelectorAll('.analyzing .vn-tags [data-tag]').length}));
  refreshed.ms=Date.now()-reloadAt;
  assert.equal(refreshed.photos,COUNT);assert.equal(refreshed.phase,'understanding');assert(refreshed.label.includes('1,879 / 1,879'));
  assert.equal(refreshed.tags,27,'All earlier tags are restored immediately, without drip-replaying recognition');
  assert.deepEqual(writes,[],'Refreshing must not start another scan');
  await page.setViewportSize({width:375,height:812});
  await page.evaluate(async()=>{await loadState();history.replaceState(null,'','#analyze');route();});
  await page.waitForSelector('.an-grab.open .an-grab-findings');await page.waitForTimeout(750);
  const phone=await page.evaluate(()=>{
    const head=document.querySelector('.analyzing .screen-head'),title=head.querySelector('h1'),r=title.getBoundingClientRect(),step=head.querySelector('.now').getBoundingClientRect();
    return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,headWidth:head.clientWidth,headScroll:head.scrollWidth,
      titleLeft:r.left,titleRight:r.right,stepRight:step.right,text:title.innerText,
      tiny:[...document.querySelectorAll('#an-sea .ps-item.is-tiny')].map(el=>({size:el.getBoundingClientRect().width,border:parseFloat(getComputedStyle(el).borderLeftWidth),image:el.querySelector('.pile-cover')?.getBoundingClientRect().width||0}))};
  });
  assert.equal(phone.scrollWidth,phone.width);assert(phone.headScroll<=phone.headWidth+1,JSON.stringify(phone));
  assert(phone.titleLeft>=0&&phone.titleRight<=phone.width&&phone.stepRight<=phone.width);assert(phone.text.includes('Meet your photos'));
  assert(phone.tiny.length>0&&phone.tiny.every(it=>it.border===0&&it.image>=it.size*.8),'Tiny photos must have room for their image, not an empty paper rim');
  phone.tinyPhotos=phone.tiny.length;delete phone.tiny;
  await page.screenshot({path:OUT+'/A-analysis-phone.png'});
  assert.deepEqual(problems,[]);console.log(JSON.stringify({processing,settled,moving,zoomed,panned,focused,refreshed,phone,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
