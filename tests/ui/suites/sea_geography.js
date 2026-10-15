// Public photos retain their measured homes between stages; the real worker adds local, smooth motion.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {SeaField}=require('../../../matcher/static/sea-worker.js');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const field=new SeaField(),probe={id:1,x:700,y:400,baseSize:20,tags:[],visual:{colorfulness:.2,brightness:.4}};
  const bounds={width:1400,height:800,water:[{x0:0,y0:0,x1:1400,y1:800}],obstacles:[]};
  // On the absolute curves (spread 0) a known colour always lands in the same place, whatever else arrives.
  field.set({generation:1,items:[probe],tuning:{spread:0},...bounds});const stableHome={...field.byId.get(1).home};
  const others=Array.from({length:10000},(_,i)=>({id:i+2,x:700,y:400,baseSize:20,tags:[],visual:{colorfulness:i%2,brightness:(i%3)/2}}));
  field.set({generation:2,items:[probe,...others],tuning:{spread:0},...bounds});
  assert.deepEqual(field.byId.get(1).home,stableHome,'Adding other photos must never renormalize an existing colour coordinate on the absolute curves');
  // Spread by rank (the default), the same library uses the whole width while keeping colour order and brightness order.
  field.tune({spread:1});
  const home=id=>field.byId.get(id).home,muted=home(2),probe1=home(1),colourful=home(3),dark=home(2),bright=home(4);
  assert(muted.x<probe1.x&&probe1.x<colourful.x&&dark.y>bright.y,'Rank spread keeps colour running left to right and brightness bottom to top');
  const span=1-2*require('../../../matcher/static/sea-tuning.js').seaTuningDefaults().margin;  // the rank spread fills the water inside the edge margin
  assert(colourful.x-muted.x>bounds.width*span*.4&&dark.y-bright.y>bounds.height*span*.4,JSON.stringify({muted,colourful,dark,bright,span}));
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),problems=[],discovered=new Map();
  page.on('pageerror',e=>problems.push(e.message));
  page.on('response',async response=>{if(response.url().includes('/api/analysis/feed?'))try{
    for(const row of (await response.json()).read||[])if(row[4])discovered.set(row[0],row[4]);
  }catch(_){} });
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===World.total&&World.total>0&&!World.loading&&World.sea.bodies?.length);
  const imported=await page.evaluate(()=>{
    window.geographyWorld={sea:World.sea,items:new Map(World.sea.items),photos:new Map(World.photos)};
    return [...World.photos.values()].map(p=>({id:p.id,visual:p.visual}));
  });
  assert(imported.length>20);assert(discovered.size>20,'Analysis must deliver measured coordinates as it works');
  for(const photo of imported){assert(Number.isFinite(photo.visual?.colorfulness)&&Number.isFinite(photo.visual?.brightness),JSON.stringify(photo));
    if(discovered.has(photo.id))assert.deepEqual(photo.visual,discovered.get(photo.id));}
  const stages=[];
  for(const hash of ['#filter?view=sea','#stacks','#draw','#home']){
    await page.evaluate(hash=>location.hash=hash,hash);
    await page.waitForFunction(hash=>location.hash===hash&&!document.querySelector('#main .loading')&&World.sea.items.size===World.total&&World.sea.bodies?.length,hash);
    await page.waitForTimeout(1100);
    const stage=await page.evaluate(()=>({route:location.hash,sameSea:World.sea===geographyWorld.sea,
      ids:[...World.sea.items.keys()].sort((a,b)=>a-b),sameItems:[...World.sea.items].every(([id,it])=>it===geographyWorld.items.get(id)),
      measured:World.sea.bodies.every(body=>JSON.stringify(body.visual)===JSON.stringify(World.photos.get(body.id)?.visual)),
      finite:[...World.sea.items.values()].every(it=>Number.isFinite(it.x)&&Number.isFinite(it.y)),
      photos:[...World.photos.values()].map(p=>({id:p.id,visual:p.visual}))}));
    assert(stage.sameSea&&stage.sameItems&&stage.measured&&stage.finite,JSON.stringify(stage));
    assert.deepEqual(stage.ids,imported.map(p=>p.id).sort((a,b)=>a-b));assert.deepEqual(stage.photos,imported);delete stage.photos;delete stage.ids;stages.push(stage);
  }
  await page.screenshot({path:OUT+'/G-public-world.png'});
  const settled=await page.evaluate(async()=>{
    World.sea.paused=true;clearInterval(World.watch);
    const host=document.createElement('div');host.id='geography-test';host.style.cssText='position:fixed;left:100px;top:95px;width:1400px;height:790px;z-index:100;background:linear-gradient(#243344,#101927);border:1px solid #5c718a;border-radius:18px;overflow:hidden';document.body.append(host);
    const sea=new VennSea(host,{catalog:false}),photos=[...World.photos.values()];window.geographySea=sea;
    const corners=[{colorfulness:.025,brightness:.18},{colorfulness:.9,brightness:.18},{colorfulness:.025,brightness:.82},{colorfulness:.9,brightness:.82}];
    const closest=target=>photos.reduce((best,p)=>Math.hypot(p.visual.colorfulness-target.colorfulness,p.visual.brightness-target.brightness)<Math.hypot(best.visual.colorfulness-target.colorfulness,best.visual.brightness-target.brightness)?p:best).id;
    window.geographyItems=Array.from({length:32},(_,i)=>{const q=i%4;return {id:80000+i,photo:closest(corners[q]),n:1,tags:[`corner:${q}`],visual:{...corners[q]}};});
    sea.setVenn([],geographyItems);clearTimeout(sea.bodyTimer);sea.bodyTimer=null;
    for(const [i,it] of [...sea.items.values()].entries()){it.x=700+Math.cos(i*2.4)*210;it.y=390+Math.sin(i*2.4)*180;sea.paintItem(it,true);}
    sea.sendBodies();
    for(const [text,style] of [['Muted','left:18px;top:50%'],['Colourful','right:18px;top:50%'],['Bright','top:12px;left:48%'],['Dark','bottom:12px;left:48%']]){
      const label=document.createElement('span');label.textContent=text;label.style.cssText=`position:absolute;${style};font:600 14px system-ui;color:#e4edf9;pointer-events:none;z-index:10;text-shadow:0 2px 4px #000`;host.append(label);
    }
    const centers=()=>corners.map((_,q)=>{const rows=[...sea.items.values()].filter(it=>(it.id-80000)%4===q);return {x:rows.reduce((n,it)=>n+it.x,0)/rows.length,y:rows.reduce((n,it)=>n+it.y,0)/rows.length};});
    const started=performance.now(),correct=rows=>rows.every((c,i)=>(i%2?c.x>sea.width*.6:c.x<sea.width*.4)&&(i<2?c.y>sea.height*.58:c.y<sea.height*.42));
    while(performance.now()-started<20000&&!correct(centers()))await sleep(150);
    window.geographyCenters=centers;window.geographyOrigin=centers()[0];
    return {centers:centers(),settledMs:Math.round(performance.now()-started),width:sea.width,height:sea.height,photos:sea.items.size,measured:sea.bodies.every(it=>it.visual?.colorfulness!=null)};
  });
  await page.screenshot({path:OUT+'/G-colour-brightness-geography.png'});
  assert.equal(settled.photos,32);assert(settled.measured);
  for(const [i,c] of settled.centers.entries()){
    assert(i%2?c.x>settled.width*.6:c.x<settled.width*.4,JSON.stringify(settled));
    assert(i<2?c.y>settled.height*.58:c.y<settled.height*.42,JSON.stringify(settled));
  }
  const target=await page.evaluate(()=>{
    const it=[...geographySea.items.values()].find(it=>{const r=it.el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.ps-item')===it.el;});
    const r=it.el.getBoundingClientRect();window.geographyTarget=it.id;return {x:r.x+r.width/2,y:r.y+r.height/2};
  });
  await page.mouse.move(target.x,target.y);
  const held=await page.evaluate(async()=>{const sea=geographySea,it=sea.items.get(geographyTarget),before=[it.x,it.y];await sleep(650);
    return {id:sea.held,wanted:it.id,drift:Math.hypot(it.x-before[0],it.y-before[1])};});
  assert.equal(held.id,held.wanted);assert(held.drift<.2,JSON.stringify(held));await page.mouse.move(1550,930);
  const focus=await page.evaluate(async()=>{
    const sea=geographySea;sea.hold(null);sea.focusIds=new Set(geographyItems.filter(it=>(it.id-80000)%4===0).map(it=>it.id));sea.applyFocus();await sleep(2200);
    const rows=[...sea.items.values()].filter(it=>sea.focusIds.has(it.id)),before=rows.map(it=>[it.x,it.y]);await sleep(600);
    const anchored=Math.max(...rows.map((it,i)=>Math.hypot(it.x-before[i][0],it.y-before[i][1]))),nodes=new Map(sea.items),positions=new Map([...sea.items].map(([id,it])=>[id,[it.x,it.y]]));
    const distance=()=>rows.reduce((n,it)=>n+Math.hypot(it.x-geographyOrigin.x,it.y-geographyOrigin.y),0)/rows.length;
    const away=distance();sea.focusIds=null;sea.applyFocus();
    const immediate=[...sea.items].every(([id,it])=>it===nodes.get(id)&&it.x===positions.get(id)[0]&&it.y===positions.get(id)[1]);
    await sleep(4500);return {count:rows.length,anchored,immediate,away,returned:distance()};
  });
  assert.equal(focus.count,8);assert(focus.anchored<1,JSON.stringify(focus));assert(focus.immediate,JSON.stringify(focus));assert(focus.returned<focus.away,JSON.stringify(focus));
  const revised=await page.evaluate(async()=>{
    const sea=geographySea,original=geographyItems[0],it=sea.items.get(original.id),before=[it.x,it.y],node=it.el;
    const update={...original,visual:{colorfulness:.9,brightness:.82}};let maxJump=0,samples=0,last=[it.x,it.y];
    const receive=sea.receive;sea.receive=function(message){receive.call(this,message);maxJump=Math.max(maxJump,Math.hypot(it.x-last[0],it.y-last[1]));last=[it.x,it.y];samples++;};
    sea.setVenn([],[update],[],true);const immediate=Math.hypot(it.x-before[0],it.y-before[1]);await sleep(2000);sea.receive=receive;
    return {immediate,maxJump,samples,sameNode:it.el===node,visual:sea.bodies.find(body=>body.id===it.id).visual};
  });
  assert.equal(revised.immediate,0);assert(revised.sameNode&&revised.samples>15&&revised.maxJump<25,JSON.stringify(revised));assert.deepEqual(revised.visual,{colorfulness:.9,brightness:.82});
  await page.screenshot({path:OUT+'/G-released-geography.png'});
  await page.evaluate(()=>{geographySea.destroy();geographySea.el.remove();});assert.deepEqual(problems,[]);
  console.log(JSON.stringify({stableHome,imported:imported.length,discovered:discovered.size,stages,settled,held,focus,revised,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
