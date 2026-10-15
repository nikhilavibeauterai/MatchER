// Measure the real worker and real thumbnail drawing; focused anchors, filters and drag stay physical.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:90000}).catch(async e=>{await page.screenshot({path:OUT+'/B-analysis-debug.png'});throw new Error(JSON.stringify({problems,state:await page.evaluate(()=>S.lib?.progress),text:await page.locator('#main').innerText(),error:e.message}));});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size>0);
  const small=await page.evaluate(async()=>{
    World.sea.paused=true;clearInterval(World.watch);
    const host=document.createElement('div');host.style.cssText='position:fixed;left:20px;top:100px;width:1200px;height:750px;z-index:50;background:#142032';document.body.append(host);
    const sea=new VennSea(host),photo=[...World.photos.values()][0].id;window.boidsSea=sea;
    // The mechanics under test, not the owner's taste: the same pinned tuning as tests/sea_checks.cjs (not persisted).
    sea.tune({speedCap:2.2,drag:.1,calmDrag:.18,repel:.8,groupCohesion:1,groupSeparation:.5,homeMax:.3,margin:.06,settleMove:.06,domLimit:160,hurry:0},false);
    sea.setVenn([],Array.from({length:120},(_,i)=>({id:10000+i,photo,tags:[`tag${i%4}`],n:1})));
    await sleep(6500);
    const items=[...sea.items.values()],rows=new Map(),columns=new Map();let overlaps=0;
    for(const it of items){const x=Math.round(it.x/4),y=Math.round(it.y/4);columns.set(x,(columns.get(x)||0)+1);rows.set(y,(rows.get(y)||0)+1);}
    for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)if(Math.abs(items[i].x-items[j].x)<sea.s&&Math.abs(items[i].y-items[j].y)<sea.s)overlaps++;
    return {overlaps,maxRow:Math.max(...rows.values()),maxColumn:Math.max(...columns.values()),clusters:[...sea.lassos.values()].filter(l=>l.auto).length};
  });
  await page.screenshot({path:OUT+'/B-free-flocks.png'});
  assert.equal(small.overlaps,0,JSON.stringify(small));assert.equal(small.clusters,4);
  assert(small.maxRow<12&&small.maxColumn<12,JSON.stringify(small));
  const glide=await page.evaluate(async()=>{
    const sea=boidsSea;sea.paused=true;sea.mouse.x=sea.mouse.y=-1e5;sea.hold(null);await sleep(180);
    const it=[...sea.items.values()].find(it=>it.x>180&&it.x<900&&it.y>100&&it.y<600);window.motionId=it.id;
    sea.el.style.setProperty('--sea-glide','240ms');
    const center=()=>{const r=it.el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};};
    const start=center();it.x+=80;sea.paintItem(it);const samples=[];
    const until=performance.now()+400;while(performance.now()<until){await new Promise(requestAnimationFrame);samples.push(center());}
    const end=center(),middle=samples.find(p=>p.x>start.x+1&&p.x<end.x-1)||samples[0];
    const size=it.size,centerBefore=center();it.size=size*1.8;sea.paintItem(it);
    const growing=[];const grownAt=performance.now()+260;
    while(performance.now()<grownAt){await new Promise(requestAnimationFrame);growing.push({center:center(),width:it.el.getBoundingClientRect().width});}
    const centerDrift=Math.max(...growing.map(p=>Math.hypot(p.center.x-centerBefore.x,p.center.y-centerBefore.y)));
    const growsBetween=growing.some(p=>p.width>size+1&&p.width<size*1.8-1);
    it.size=size;sea.paintItem(it);await sleep(240);
    sea.releasePins=[{id:it.id,x:it.x,y:it.y}];sea.paused=false;sea.kick();return {start,middle,end,centerDrift,growsBetween};
  });
  assert(glide.middle.x>glide.start.x+1&&glide.middle.x<glide.end.x-1,JSON.stringify(glide));
  assert(Math.abs(glide.end.x-glide.start.x-80)<1,JSON.stringify(glide));
  assert(glide.growsBetween&&glide.centerDrift<.2,JSON.stringify(glide));
  // The interpolation probe placed this print80px into another flock. Let physical contacts settle before
  // measuring a real pointer target, rather than aiming at its pre-collision rectangle.
  await page.waitForTimeout(650);
  await page.waitForFunction(()=>{const it=boidsSea.items.get(motionId),r=it.el.getBoundingClientRect();return Number(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.ps-item')?.dataset.id)===motionId;});
  await page.evaluate(()=>{window.hoverHit=null;boidsSea.el.addEventListener('pointermove',e=>{hoverHit=Number(e.target.closest('.ps-item')?.dataset.id);},{once:true});});
  const target=await page.locator('[data-id="'+await page.evaluate(()=>motionId)+'"]').boundingBox();
  await page.mouse.move(target.x+target.width/2,target.y+target.height/2);
  const held=await page.evaluate(async()=>{
    const sea=boidsSea,it=sea.items.get(motionId),r=it.el.getBoundingClientRect(),start=[r.x+r.width/2,r.y+r.height/2];
    await sleep(450);const end=it.el.getBoundingClientRect();return {id:sea.held,wanted:motionId,hit:hoverHit,drift:Math.hypot(end.x+end.width/2-start[0],end.y+end.height/2-start[1])};
  });
  assert.equal(held.id,held.wanted,JSON.stringify(held));assert(held.drift<.2,JSON.stringify(held));
  await page.mouse.down();await page.mouse.move(target.x+target.width/2+90,target.y+target.height/2+70);
  const drag=await page.evaluate(()=>{
    const sea=boidsSea,it=sea.items.get(motionId),r=it.el.getBoundingClientRect(),base=sea.el.getBoundingClientRect();
    return {moving:sea.drag?.moving,lag:Math.hypot(r.x+r.width/2-base.x-sea.mouse.x,r.y+r.height/2-base.y-sea.mouse.y)};
  });
  assert(drag.moving&&drag.lag<.2,JSON.stringify(drag));await page.mouse.up();await page.mouse.move(1550,950);
  const focus=await page.evaluate(async()=>{
    const sea=boidsSea,photo=[...sea.items.values()][0].photo;
    const tags=['dog','beach','dog','cat'];
    const items=Array.from({length:24},(_,i)=>({id:10000+i,photo,tags:i%4===0?['dog','beach']:[tags[i%4]],n:1}));
    const take=[...World.photos.values()].find(p=>p.id!==photo).id;
    items.push({id:10024,photo:take,tags:['hat'],n:1,take:true,rep:10000});items[0].members=[photo,take];items[0].n=2;
    sea.setVenn(['dog','beach','cat','hat'].map(id=>({id,label:id,html:id})),items);
    await sleep(700);sea.toggleTag('dog');sea.toggleTag('beach');await sleep(1700);
    const allCount=sea.focusBar.querySelector('[data-focus-count]').textContent;
    const first=sea.items.get(10000),before={x:first.x,y:first.y},combined=sea.bodies.find(b=>b.id===10000).tags;
    await sleep(600);const anchorDrift=Math.hypot(first.x-before.x,first.y-before.y);
    const wobble=getComputedStyle(first.el.querySelector('.pile-cover')).animationName;
    sea.focusAny=true;sea.applyFocus();await sleep(500);const anyCount=sea.focusBar.querySelector('[data-focus-count]').textContent;
    return {allCount,anyCount,anchorDrift,wobble,combined,target:sea.target(10,10,first).kind};
  });
  assert.equal(focus.allCount,'6 shots');assert.equal(focus.anyCount,'18 shots');assert(focus.anchorDrift<1,JSON.stringify(focus));assert.equal(focus.wobble,'cardwobble','A focused print wobbles like every other card');assert.equal(focus.target,'sea');assert(focus.combined.includes('hat'));
  await page.screenshot({path:OUT+'/B-anchored-focus.png'});
  await page.evaluate(()=>boidsSea.select([10000,10024]));
  const cover=await page.locator('[data-id="10000"]').boundingBox();
  await page.mouse.move(cover.x+cover.width/2,cover.y+cover.height/2);await page.mouse.down();
  assert.equal(await page.evaluate(()=>boidsSea.drag?.items.length),1,'Several selected takes drag as one stack');
  await page.dispatchEvent('[data-id="10000"]','pointercancel',{pointerId:1});await page.mouse.up();
  assert.equal(await page.evaluate(()=>boidsSea.drag),null);
  const lod=await page.evaluate(async()=>{
    const sea=boidsSea,photo=[...sea.items.values()][0].photo;sea.focusKeys.clear();sea.focusAny=false;sea.focusCluster=null;sea.applyFocus();
    sea.mouse.x=sea.mouse.y=-1e5;
    const catalog=[{id:'faces',label:'Faces',html:'Faces'}];
    const items=Array.from({length:522},(_,i)=>({id:30000+i,photo,tags:['faces'],n:1}));sea.setVenn(catalog,items);await sleep(500);
    const promoted=[...sea.items.values()].find(it=>it.density),target=items.find(it=>it.id!==promoted.id&&sea.items.get(it.id).density);
    const before=sea.bodies.find(b=>b.id===promoted.id).baseSize;sea.promote(promoted.id);sea.select([promoted.id]);await sleep(250);
    const afterPromotion=sea.bodies.find(b=>b.id===promoted.id).baseSize,preview=promoted.el.querySelector('img');let createdImages=0;
    const observer=new MutationObserver(records=>{for(const r of records)for(const node of r.addedNodes)if(node.nodeType===1)createdImages+=(node.matches('img')?1:0)+node.querySelectorAll('img').length;});
    observer.observe(sea.el,{childList:true,subtree:true});
    sea.setVenn(catalog,[{...target,tags:['faces','smiling']}],[],true);await sleep(250);observer.disconnect();
    const sizes=sea.bodies.map(b=>b.baseSize);
    return {before,afterPromotion,afterMetadata:sea.bodies.find(b=>b.id===promoted.id).baseSize,ratio:Math.max(...sizes)/Math.min(...sizes),
      createdImages,keptPreview:promoted.el.querySelector('img')===preview,dom:sea.moving.length,photos:sea.items.size};
  });
  assert.equal(lod.photos,522);assert(lod.dom<=160);assert.equal(lod.ratio,1,JSON.stringify(lod));
  assert.equal(lod.before,lod.afterPromotion,JSON.stringify(lod));assert.equal(lod.afterPromotion,lod.afterMetadata,JSON.stringify(lod));
  assert.equal(lod.createdImages,0,JSON.stringify(lod));assert(lod.keptPreview,JSON.stringify(lod));
  const assigned=await page.evaluate(async()=>{
    const sea=boidsSea,photo=[...sea.items.values()][0].photo;sea.paused=true;sea.hold(null);sea.select([]);await sleep(180);
    const homes=[[400,300],[480,300],[440,370]],items=Array.from({length:120},(_,i)=>({id:60000+i,photo,
      tags:[`unlike:${i}`],n:1,...(i<6?{group:41+Math.floor(i/3)}:{})}));
    sea.setVenn([],items,[41,42].map(bin=>({id:`g${bin}`,kind:'group',bin,html:`Group ${bin}`})));
    sea.paused=false;sea.layout();clearTimeout(sea.bodyTimer);sea.bodyTimer=null;
    for(let i=0;i<items.length;i++){
      const it=sea.items.get(items[i].id),at=i<6?homes[i%3]:null,j=i-6;
      it.x=at?at[0]+Math.floor(i/3)*250:(j<60?50:950)+(j%4)*45;
      it.y=at?at[1]:40+Math.floor((j<60?j:j-60)/4)*40;sea.paintItem(it,true);
    }
    const tracked=()=>[...sea.items.values()].filter(it=>it.group!=null);
    const spread=()=>[41,42].map(group=>{
      const rows=tracked().filter(it=>it.group===group);let distance=0;
      for(let i=0;i<rows.length;i++)for(let j=0;j<i;j++)distance+=Math.hypot(rows[i].x-rows[j].x,rows[i].y-rows[j].y);
      return distance/3;
    });
    const before=spread();sea.sendBodies();await sleep(6200);
    let overlaps=0,minBuffer=Infinity;const rows=tracked();
    for(let i=0;i<rows.length;i++)for(let j=0;j<i;j++){
      const a=rows[i],b=rows[j],size=(a.size+b.size)/2;
      if(Math.abs(a.x-b.x)<size&&Math.abs(a.y-b.y)<size)overlaps++;
      minBuffer=Math.min(minBuffer,Math.hypot(a.x-b.x,a.y-b.y)/size);
    }
    return {before,after:spread(),overlaps,minBuffer,photos:sea.items.size,
      labels:sea.bodies.filter(it=>it.label).map(it=>it.label),
      shores:[41,42].map(id=>({id,count:sea.contours.get(`g${id}`)?.count,paths:sea.contours.get(`g${id}`)?.hotPaths.length||0}))};
  });
  assert.equal(assigned.photos,120);assert.deepEqual(assigned.labels,['g41','g41','g41','g42','g42','g42']);
  assert(assigned.after.every((n,i)=>n<assigned.before[i]*.85),JSON.stringify(assigned));
  assert.equal(assigned.overlaps,0,JSON.stringify(assigned));assert(assigned.minBuffer>=1.4,JSON.stringify(assigned));
  assert(assigned.shores.every(s=>s.count===3&&s.paths>0),JSON.stringify(assigned));
  await page.screenshot({path:OUT+'/B-assigned-group-flocks.png'});
  const source=await page.evaluate(async()=>{
    const sea=boidsSea,photos=[...World.photos.keys()].slice(0,7);sea.paused=true;sea.hold(null);sea.select([]);await sleep(180);
    const items=Array.from({length:120},(_,i)=>({id:i<7?photos[i]:70000+i,photo:photos[i%7],tags:[`source:${i}`],n:1,...(i<7?{group:43}:{})}));
    sea.obstacles=[{x0:790,y0:100,x1:1190,y1:640}];
    sea.setVenn([],items,[{id:'g43',kind:'group',bin:43,html:'Source flock'}]);sea.layout();clearTimeout(sea.bodyTimer);sea.bodyTimer=null;
    for(let i=0;i<items.length;i++){
      const it=sea.items.get(items[i].id),j=i-7;it.x=i<7?150+i*sea.s*1.6:40+(j%20)*55;it.y=i<7?330:j<60?40+Math.floor(j/20)*45:600+Math.floor((j-60)/20)*45;sea.paintItem(it,true);
    }
    sea.paused=false;sea.sendBodies();await sleep(1100);
    const bridge=sea.items.get(photos[3]),r=bridge.el.getBoundingClientRect();
    window.boidsSource={id:bridge.id,before:sea.contours.get('g43')?.hotPaths.length||0,world:{sea:World.sea,el:World.el,mode:World.mode}};
    return {before:boidsSource.before,id:bridge.id,x:r.x+r.width/2,y:r.y+r.height/2};
  });
  assert.equal(source.before,1,'Seven neighbouring public photos form one real worker shore before focus');
  await page.mouse.move(source.x,source.y);
  const sourceHover=await page.evaluate(async()=>{await sleep(700);return {held:boidsSea.held,paths:boidsSea.contours.get('g43')?.hotPaths.length||0};});
  assert.equal(sourceHover.held,source.id);assert.equal(sourceHover.paths,1,'Stationary hover must not bisect the source shore');
  await page.mouse.move(1550,950);
  const liftedSource=await page.evaluate(async()=>{
    const sea=boidsSea,source=boidsSource,bridge=sea.items.get(source.id);
    const spotlight=document.createElement('section');spotlight.style.cssText='position:fixed;left:850px;top:230px;width:300px;height:440px;z-index:55;padding:12px;background:#0b101de8;border-radius:16px;text-align:center';
    spotlight.innerHTML=`<b>In review</b><img src="${P(source.id)}" alt="Public sample take in focus" style="display:block;width:100%;height:390px;object-fit:contain;margin-top:10px">`;
    document.body.append(spotlight);source.spotlight=spotlight;
    World.sea=sea;World.el=sea.el;World.mode='live';World.swap(spotlight,[]);
    const end=performance.now()+6000;while(performance.now()<end&&(!bridge.el.classList.contains('lifted')||World.flights?.has(source.id)))await sleep(40);
    const origin={x:bridge.x,y:bridge.y};await sleep(900);
    return {lifted:bridge.el.classList.contains('lifted'),flying:World.flights?.has(source.id)||false,
      paths:sea.contours.get('g43')?.hotPaths.length||0,count:sea.contours.get('g43')?.count,
      drift:Math.hypot(bridge.x-origin.x,bridge.y-origin.y)};
  });
  await page.screenshot({path:OUT+'/B-lifted-source.png'});
  assert(liftedSource.lifted&&!liftedSource.flying,JSON.stringify(liftedSource));assert.equal(liftedSource.count,7);
  assert.equal(liftedSource.paths,1,'Lifting the middle take must retain one connected source shore');assert(liftedSource.drift<.1,JSON.stringify(liftedSource));
  const returnedSource=await page.evaluate(async()=>{
    const source=boidsSource,sea=boidsSea;World.sink(source.id,World.rect(source.spotlight.querySelector('img')),'back');source.spotlight.remove();
    const end=performance.now()+6000;while(performance.now()<end&&World.flights?.has(source.id))await sleep(40);
    await sleep(700);const result={lifted:sea.items.get(source.id).el.classList.contains('lifted'),paths:sea.contours.get('g43')?.hotPaths.length||0};
    Object.assign(World,source.world);sea.obstacles=[];sea.layout();return result;
  });
  assert(!returnedSource.lifted);assert.equal(returnedSource.paths,1,'The returned take rejoins the same connected shore');
  const large=await page.evaluate(async()=>{
    const sea=boidsSea,photo=[...sea.items.values()][0].photo;sea.focusKeys.clear();sea.focusAny=false;sea.focusCluster=null;sea.applyFocus();
    sea.tune(seaTuningDefaults(),false);  // the scale check measures the sea as shipped (prints settle and sleep), not the pinned mechanics
    const image=new Image();image.src=T(photo);await image.decode();
    const atlas=document.createElement('canvas');atlas.width=atlas.height=16;atlas.getContext('2d').drawImage(image,0,0,16,16);
    const items=Array.from({length:10000},(_,i)=>({id:10000+i,photo,group:100+i%20,
      visual:{colorfulness:(i%100)/99,brightness:Math.floor(i/100)/99},
      tags:['year:2026',`subject:${i%4}`,`genre:${i%8}`,`place:${i%12}`,`terrain:${i%24}`,`light:${i%8}`,`colour:${i%24}`,`person:${i%128}`,`camera:${i%8}`,`occasion:${i%32}`,`detail:${i%256}`,`month:${i%12}`],n:1}));
    sea.setVenn([],items,Array.from({length:20},(_,i)=>({id:`g${100+i}`,kind:'group',bin:100+i,html:`Group ${i+1}`})));
    sea.sprites=new Map(items.map(it=>[it.id,{img:atlas,x:0,y:0}]));
    await sleep(1600);
    const positions=[...sea.items.values()].map(it=>[it.x,it.y]),times=[],worker=[],gaps=[],arrivals=[],clustering=[];
    const costs={},methods={};for(const name of ['draw','drawDensity','clusterLabels']){methods[name]=sea[name];costs[name]={calls:0,ms:0};sea[name]=function(...args){const t=performance.now(),result=methods[name].apply(this,args);costs[name].calls++;costs[name].ms+=performance.now()-t;return result;};}
    let arrival=performance.now();
    const receive=sea.receive;sea.receive=function(m){const start=performance.now();arrivals.push(start-arrival);arrival=start;receive.call(this,m);times.push(performance.now()-start);worker.push(m.ms);if(m.clusterMs)clustering.push(m.clusterMs);};
    let last=performance.now(),running=true;const sample=now=>{gaps.push(now-last);last=now;if(running)requestAnimationFrame(sample);};requestAnimationFrame(sample);
    const split={aside:items.filter((_,i)=>!(i%2)).map(it=>it.id),kept:items.filter((_,i)=>i%2).map(it=>it.id)},flowEdits=[];
    const setFlow=flow=>{
      const before=new Map([...sea.items.values()].map(it=>[it.id,[it.x,it.y,it.size,it.cluster]])),generation=sea.generation,bodies=sea.bodies;
      sea.setOutcomeFlow(flow);
      flowEdits.push({unchanged:[...sea.items.values()].every(it=>JSON.stringify(before.get(it.id))===JSON.stringify([it.x,it.y,it.size,it.cluster])),sameBodies:sea.bodies===bodies,sameGeneration:sea.generation===generation,aside:sea.outcomeFlow?.aside.length||0,kept:sea.outcomeFlow?.kept.length||0});
      return before;
    };
    const drift=(before,flow)=>{
      const aside=new Set(flow.aside);let count=0,total=0;
      for(const it of sea.items.values()){
        const x=before.get(it.id)[0],side=aside.has(it.id)?-1:1;
        if((sea.width*(side<0?.32:.68)-x)*side>40){count++;total+=(it.x-x)*side;}
      }
      return {count,mean:total/Math.max(1,count)};
    };
    const first=setFlow(split);await sleep(4000);const firstFlow=drift(first,split);
    const reversed={aside:split.kept,kept:split.aside},second=setFlow(reversed);await sleep(3500);const secondFlow=drift(second,reversed);
    setFlow(null);await sleep(1000);running=false;sea.receive=receive;
    for(const name of Object.keys(methods))sea[name]=methods[name];
    const data=sea.densityCanvas.getContext('2d').getImageData(0,0,sea.densityCanvas.width,sea.densityCanvas.height).data;
    let painted=0;for(let i=3;i<data.length;i+=4)if(data[i])painted++;
    const stats=list=>{list.sort((a,b)=>a-b);return {mean:list.reduce((a,b)=>a+b)/list.length,p95:list[Math.floor(list.length*.95)],max:list[list.length-1]};};
    return {photos:sea.items.size,visuals:sea.bodies.filter(it=>Number.isFinite(it.visual?.colorfulness)&&Number.isFinite(it.visual?.brightness)).length,assigned:sea.bodies.filter(it=>/^g\d+$/.test(it.label)).length,groups:new Set(sea.bodies.map(it=>it.label)).size,tagsPerPhoto:items[0].tags.length,vocabulary:new Set(items.flatMap(it=>it.tags)).size,dom:sea.moving.length,moved:[...sea.items.values()].filter((it,i)=>Math.hypot(it.x-positions[i][0],it.y-positions[i][1])>2).length,painted,costs,flowEdits,firstFlow,secondFlow,contourPoints:[...sea.contours.values()].reduce((n,c)=>n+c.hotPaths.reduce((s,p)=>s+p.length,0),0),main:stats(times),worker:stats(worker),frames:stats(gaps),arrivals:stats(arrivals.slice(1)),clustering,samples:times.length};
  });
  await page.screenshot({path:OUT+'/B-10000-real-thumbnails.png'});
  assert.equal(large.photos,10000);assert(large.dom<=160);assert(large.moved>9000,JSON.stringify(large));assert(large.painted>10000);assert(large.samples>120,JSON.stringify(large));assert(large.clustering.length>=2&&large.clustering.length<=3,JSON.stringify(large));assert(large.main.mean<25,JSON.stringify(large));assert(large.worker.mean<45,JSON.stringify(large));assert(large.arrivals.mean<70&&large.arrivals.p95<120,JSON.stringify(large));assert(large.frames.p95<85,JSON.stringify(large));
  assert.equal(large.assigned,10000);assert.equal(large.visuals,10000);assert.equal(large.groups,20);
  assert(large.flowEdits.every(edit=>edit.unchanged&&edit.sameBodies&&edit.sameGeneration),JSON.stringify(large.flowEdits));
  assert.deepEqual(large.flowEdits.map(({aside,kept})=>[aside,kept]),[[5000,5000],[5000,5000],[0,0]]);
  assert(large.firstFlow.count>1000&&large.firstFlow.mean>2,JSON.stringify(large.firstFlow));
  assert(large.secondFlow.count>1000&&large.secondFlow.mean>2,JSON.stringify(large.secondFlow));
  await page.evaluate(()=>{boidsSea.destroy();boidsSea.el.remove();});assert.deepEqual(problems,[]);
  console.log(JSON.stringify({small,glide,held,drag,focus,lod,assigned,source,sourceHover,liftedSource,returnedSource,large,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
