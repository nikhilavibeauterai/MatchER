// Reproduce a large, heavily overlapping-tag library in the actual map, using only public fixture thumbnails.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:2048,height:1152}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading&&World.sprites?.size);
  const before=await page.evaluate(async()=>{
    const sea=World.sea,photos=[...World.photos.values()],sprites=new Map(World.sprites);
    // Start scattered, then add tags, as happens when recognition catches up with the incoming photos.
    const items=Array.from({length:1879},(_,i)=>({id:50000+i,photo:photos[i%photos.length].id,rep:50000+(i<755?i:(i-755)%755),n:1,tags:[],take:i>=755,group:i%23===0?'cut':null}));
    for(const it of items)if(!it.take){it.members=items.filter(p=>p.rep===it.id).map(p=>p.photo);it.n=it.members.length;}
    const image=new Image();image.src=T(photos[0].id);await image.decode();const atlas=document.createElement('canvas');atlas.width=atlas.height=16;atlas.getContext('2d').drawImage(image,0,0,16,16);
    sea.setVenn([],items,[{id:'gcut',kind:'group',html:'Set aside'}]);
    sea.sprites=new Map(items.map(it=>[it.id,sprites.get(it.photo)||{img:atlas,x:0,y:0}]));
    await sleep(500);
    for(const it of items)it.tags=['year:2026',`subject:${(it.rep-50000)%18}`,`place:${(it.rep-50000)%7}`];
    const tags=[...new Set(items.flatMap(it=>it.tags))].map(id=>({id,label:id,html:id}));
    sea.setVenn(tags,items,[{id:'gcut',kind:'group',html:'Set aside'}]);World.fence();
    return {photos:items.length,tags:tags.length};
  });
  await page.waitForTimeout(8000);await page.mouse.move(2020,30);
  const settled=await page.evaluate(()=>{
    const sea=World.sea,base=sea.el.getBoundingClientRect(),r=document.querySelector('.map-sea').getBoundingClientRect();
    const center={x0:r.left-base.left+50,x1:r.right-base.left-50,y0:r.top-base.top+50,y1:r.bottom-base.top-50};
    const items=[...sea.items.values()].filter(it=>!it.take);
    const interior=items.filter(it=>it.x>center.x0&&it.x<center.x1&&it.y>center.y0&&it.y<center.y1).length;
    const edge=items.filter(it=>(sea.obstacles||[]).some(o=>Math.hypot(Math.max(o.x0-it.x,0,it.x-o.x1),Math.max(o.y0-it.y,0,it.y-o.y1))<it.size*.72+7)).length;
    return {photos:sea.items.size,bodies:items.length,interior,edge,dom:sea.moving.length,
      tags:sea.tagRow.querySelectorAll('[data-tag]').length,floatingLabels:sea.el.querySelectorAll(':scope > .vn-lasso-tag').length,
      names:[...sea.lassos.values()].filter(l=>!l.tag.hidden).map(l=>l.tag.textContent),
      why:{dom:sea.moving.length,lassos:[...sea.lassos.values()].map(l=>[l.id,l.count,l.tag.hidden,!!sea.contours?.get(l.id)]),generation:sea.generation,settled:sea.settled,bodies:sea.bodies?.length,contours:sea.contours?.size,zoom:sea.camera.zoom,keys:sea.keys?.length,catalog:!!sea.catalog,paused:!!sea.paused,ready:sea.ready,busy:sea.busy,raf:!!sea.raf,alive:sea.alive},
      positions:items.map(it=>[it.id,it.x,it.y])};
  });
  assert.equal(settled.photos,1879);assert.equal(settled.bodies,755);assert(settled.dom<=160);assert.equal(settled.tags,0,'The open-water map keeps tag controls off its shelf');
  assert(settled.interior>settled.bodies*.35,JSON.stringify(settled));assert(settled.edge<settled.bodies*.3,JSON.stringify(settled));
  assert.equal(settled.floatingLabels,0);assert(settled.names.length>4,`Named flocks on the settled map: ${JSON.stringify(settled.names)} ${JSON.stringify(settled.why)}`);
  await page.screenshot({path:OUT+'/W-map-1879-photos.png'});
  await page.waitForTimeout(1600);
  const moving=await page.evaluate(previous=>previous.filter(([id,x,y])=>{const it=World.sea.items.get(id);return Math.hypot(it.x-x,it.y-y)>1;}).length,settled.positions);
  assert(moving<settled.bodies*.1,`A calm map settles and stays put (${moving} still moving)`);delete settled.positions;
  assert.deepEqual(problems,[]);console.log(JSON.stringify({settled,moving,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
