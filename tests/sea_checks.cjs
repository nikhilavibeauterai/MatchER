const test=require('node:test');
const assert=require('node:assert/strict');
const {SeaField,seaSimilarity,seaForce}=require('../matcher/static/sea-worker.js');
// These checks exercise the engine's mechanics under one known tuning; the shipped defaults (sea-tuning.js) are the owner's feel.
const MECHANICS={...require('../matcher/static/sea-tuning.js').seaTuningDefaults(),speedCap:2.2,drag:.1,calmDrag:.18,repel:.8,groupCohesion:1,groupSeparation:.5,homeMax:.3,margin:.06,settleMove:.06,domLimit:160,hurry:0};
const field=(items)=>{const f=new SeaField();f.set({generation:1,tuning:MECHANICS,width:1200,height:750,items:items.map((it,i)=>({id:i+1,x:100+(i*317%1000),y:100+(i*179%550),baseSize:35,...it}))});return f;};
test('an old worker reply cannot put newly discovered photos back to sleep',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';VennSea.prototype');
  let kicked=false;
  const sea=Object.assign(Object.create(proto),{alive:true,generation:2,busy:true,settled:false,kick(){kicked=true;}});
  sea.receive({generation:1,settled:true});
  assert.equal(sea.settled,false);assert.equal(sea.busy,false);assert(kicked,'The current generation still needs a worker step');
});
test('streaming discoveries wake their photos while unrelated prints finish settling',()=>{
  const f=new SeaField(),tuning={...require('../matcher/static/sea-tuning.js').seaTuningDefaults(),spread:0};
  const items=Array.from({length:6},(_,i)=>({id:i+1,x:150+i*170,y:350,baseSize:24,tags:[`subject:${i}`]}));
  const send=generation=>f.set({generation,width:1200,height:750,calm:true,tuning,items});
  send(1);for(let frame=0;frame<400;frame++)f.step({time:frame*16.67});
  assert(f.settled,'An analysis sea can finish settling');
  const before=f.items.map(it=>[it.x,it.y]),ages=f.items.map(it=>it.age);
  for(let frame=400;frame<520;frame++){
    if(frame%6===0){items[0]={...items[0],tags:[...items[0].tags,`finding:${frame}`]};send(frame);}
    f.step({time:frame*16.67});
    for(let i=1;i<f.items.length;i++){
      assert(f.items[i].age>=ages[i],'A tag arriving elsewhere must not restart this print');
      assert.deepEqual([f.items[i].x,f.items[i].y],before[i],'Unrelated settled photos keep their position');
    }
  }
  assert(f.byId.get(1).tags.some(t=>t.startsWith('finding:')),'New findings are still applied');
  const positions=f.items.map(it=>[it.x,it.y]);send(521);
  assert.deepEqual(f.items.map(it=>[it.x,it.y]),positions,'An identical feed resend cannot move photos');
  items[1]={...items[1],visual:{colorfulness:.9,brightness:.8}};send(522);
  assert.equal(f.byId.get(2).age,0,'Changed visual evidence wakes its photo');
  assert.deepEqual(f.items.map(it=>[it.x,it.y]),positions,'A changed home is approached without teleporting');
});
test('an arriving photo can shrink the shared footprint without waking resting prints',()=>{
  const f=new SeaField(),items=[{id:1,x:180,y:200,baseSize:24,tags:[]},{id:2,x:950,y:550,baseSize:24,tags:[]}];
  const send=generation=>f.set({generation,width:1200,height:750,calm:true,items});
  send(1);for(let n=0;n<400;n++)f.step({time:n*16.67});assert(f.settled);
  const before=f.items.map(it=>[it.x,it.y,it.age]);
  for(const it of items)it.baseSize-=.01;
  items.push({id:3,x:900,y:100,baseSize:23.99,tags:[]});send(2);
  assert.deepEqual(f.items.slice(0,2).map(it=>[it.x,it.y,it.age]),before,'A smaller footprint does not restart old motion');
  assert.equal(f.byId.get(3).age,0,'The arriving photo still gets to settle');
  for(let n=400;n<500;n++)f.step({time:n*16.67});
  assert.deepEqual(f.items.slice(0,2).map(it=>[it.x,it.y]),before.map(p=>p.slice(0,2)));
});
test('atlas cells retain the photo aspect independently of their square texture slots',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';PhotoSea.prototype');
  for(const dims of [[400,200],[200,400],[300,300],[400,25]]){
    const cell=proto.atlasCell({},51,dims);assert.equal(cell.x,16);assert.equal(cell.y,16);
    assert.equal(cell.aspect,dims[0]/dims[1]);
  }
  assert.equal(proto.atlasCell({},0,null).aspect,1);
});
test('the click camera destination loads originals despite fractional card sizes and rounding',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';PhotoSea.prototype');
  for(const height of [568,650,720,844,900,1080,1152])for(const size of [4.0236220472440944,6.291338582677166,3.9448818897637796,72]){
    const sea=Object.assign(Object.create(proto),{el:{clientHeight:height},s:72,camera:{zoom:.8*height/(size*4/3)}}),it={size};
    assert(sea.fullSize(it),`The exact 80% destination shows the original (${height}px screen, ${size}px card)`);
    sea.camera.zoom*=.98;assert(!sea.fullSize(it),'Smaller prints still stop at previews');
    sea.camera.zoom*=3;assert(sea.fullSize(it),'An enlarged part of a print still shows its original');
  }
  const sea=Object.assign(Object.create(proto),{el:{clientHeight:900},s:72,camera:{zoom:5}}),it={size:96,renderScale:1};
  assert.equal(sea.imageSize(it),480);assert(!sea.fullSize(it));
  it.renderScale=1.15;assert.equal(sea.imageSize(it),552);assert(sea.fullSize(it),'Hover enlargement counts toward original detail');
});
test('a live editor can select another take while retaining wheel and pan controls',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';PhotoSea.prototype');
  const calls=[],item={id:7},event={type:'pointerup'};
  const sea=Object.assign(Object.create(proto),{cameraOn:true,zoomToPrint:it=>calls.push(['zoom',it]),onSelect:(it,e)=>calls.push(['select',it,e])});
  sea.clickPrint(item,event);assert.deepEqual(calls.pop(),['zoom',item]);
  sea.clickToZoom=false;sea.clickPrint(item,event);assert.deepEqual(calls.pop(),['select',item,event]);
  assert(sea.cameraOn,'Selecting a Filter take must not disable manual camera gestures');
  sea.clickToZoom=true;sea.cameraOn=false;sea.clickPrint(item,event);assert.deepEqual(calls.pop(),['select',item,event]);
});
test('resetting, wheeling, panning or leaving a mode cancels an unfinished click zoom',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),frames=[];
  const proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';PhotoSea.prototype',{
    reduceMotion:false,performance:{now:()=>0},requestAnimationFrame:fn=>frames.push(fn)
  });
  const sea=Object.assign(Object.create(proto),{alive:true,cameraOn:true,camera:{zoom:1,tx:0,ty:0},tuning:{zoomMax:100},
    el:{clientWidth:1200,clientHeight:900,setPointerCapture(){}},s:60,setCamera(zoom,tx,ty){this.camera={zoom,tx,ty};}});
  const item={x:300,y:250,size:60};
  sea.zoomToPrint(item);sea.resetCamera();frames.shift()(80);
  assert.deepEqual(sea.camera,{zoom:1,tx:0,ty:0},'A reset at overview must cancel even before the first frame');
  for(const cancel of [()=>sea.resetCamera(),()=>sea.zoomAt(.8,100,100),
    ()=>sea.panStart({pointerId:1,clientX:200,clientY:300,preventDefault(){}}),()=>sea.enableCamera(false)]){
    sea.cameraOn=true;sea.pan=null;sea.zoomToPrint(item);frames.shift()(80);assert(sea.camera.zoom>1);
    cancel();const camera={...sea.camera};frames.shift()(160);
    assert.deepEqual(sea.camera,camera,'A stale animation cannot override the newer gesture or mode');
  }
  sea.cameraOn=true;sea.zoomToPrint(item);const old=frames.shift();sea.zoomToPrint({...item,x:800});
  const camera={...sea.camera};old(320);assert.deepEqual(sea.camera,camera,'A second selection owns the glide');
  frames.shift()(320);assert.equal(sea.cameraGlide,null);assert(sea.camera.tx<0);
});
test('camera pans capture the pointer and release it when a two-finger pinch takes over',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),classes=new Set(),captured=new Set();
  const proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';PhotoSea.prototype',{
    performance,document:{body:{classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}}}});
  const sea=Object.assign(Object.create(proto),{cameraOn:true,camera:{zoom:1,tx:0,ty:0},touches:new Map(),
    el:{setPointerCapture:id=>captured.add(id),hasPointerCapture:id=>captured.has(id),releasePointerCapture:id=>captured.delete(id),getBoundingClientRect:()=>({left:0,top:0})},
    zoomAt(factor){this.camera.zoom*=factor;},setCamera(zoom,tx,ty){this.camera={zoom,tx,ty};}});
  let prevented=false;
  sea.panStart({pointerId:1,button:0,clientX:100,clientY:200,preventDefault(){prevented=true;}});
  assert(prevented&&captured.has(1),'The pan suppresses native dragging and keeps its pointer');
  sea.panMove({pointerId:1,clientX:110,clientY:200});assert(classes.has('sea-panning'));
  sea.pinch({type:'pointerdown',pointerType:'touch',pointerId:1,clientX:100,clientY:200});
  sea.pinch({type:'pointerdown',pointerType:'touch',pointerId:2,clientX:200,clientY:200});
  assert(sea.pinch({type:'pointermove',pointerType:'touch',pointerId:2,clientX:240,clientY:200}));
  assert.equal(sea.pan,null);assert.equal(captured.size,0);assert(!classes.has('sea-panning'));
  assert.equal(sea.camera.zoom,1.4);
});
test('Filter outcomes add a bounded current without moving, re-clustering or unpinning photos',()=>{
  const f=field([{tags:['dog'],x:800,y:180},{tags:['dog'],x:400,y:570},{tags:['cat'],x:590,y:350}]);
  f.cluster();f.step({time:0});
  const positions=f.items.map(it=>[it.x,it.y,it.vx,it.vy,it.cluster]);
  f.outcomes({aside:[1],kept:[2,3]});
  assert.deepEqual(f.items.map(it=>[it.x,it.y,it.vx,it.vy,it.cluster]),positions,'A rule change cannot teleport or reset the flock');
  const pinned={x:f.items[2].x,y:f.items[2].y};
  for(let i=1;i<=600;i++){
    const before=f.items.map(it=>[it.x,it.y]);f.step({time:i*16.67,held:3});
    assert(f.items.every((it,j)=>Math.hypot(it.x-before[j][0],it.y-before[j][1])<2.21),'Changes must ease through the ordinary speed limit');
  }
  assert(f.items[0].x<positions[0][0]-180,'Set-aside takes drift left');
  assert(f.items[1].x>positions[1][0]+180,'Kept takes drift right');
  assert.deepEqual({x:f.items[2].x,y:f.items[2].y},pinned,'A hovered take stays under the pointer');
  const before=f.items.map(it=>[it.x,it.y,it.vx,it.vy]);f.outcomes(null);
  assert.equal(f.outcomeSide.size,0);assert.deepEqual(f.items.map(it=>[it.x,it.y,it.vx,it.vy]),before);
});
test('Filter outcome changes yield to focused anchors and survive metadata refreshes',()=>{
  const f=field([{tags:['dog']},{tags:['cat']}]);f.outcomes({aside:[1],kept:[2]});
  f.focus({ids:[1]});const anchor={...f.items[0].anchor};
  for(let i=0;i<150;i++)f.step({time:i*17});
  assert(Math.hypot(f.items[0].x-anchor.x,f.items[0].y-anchor.y)<1);
  const before=f.items.map(it=>[it.x,it.y]);
  f.set({generation:2,width:1200,height:750,items:f.items.map(it=>({...it,x:0,y:0})),focus:{ids:[1]}});
  assert.deepEqual(f.items.map(it=>[it.x,it.y]),before);assert.equal(f.outcomeSide.get(2),1);
});
test('Filter fit maps to a fixed axis shared by homes and the draggable divider',()=>{
  const {seaOutcomeX}=require('../matcher/static/sea-worker.js'),fs=require('node:fs'),vm=require('node:vm');
  const proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';PhotoSea.prototype');
  const sea=Object.assign(Object.create(proto),{width:1200});
  const f=field([{tags:[],visual:{saturation:1,brightness:.8}},{tags:[],visual:{saturation:0,brightness:.2}},{tags:[]}]);
  const original=f.items.map(it=>({home:it.home&&{...it.home},state:[it.x,it.y,it.vx,it.vy]}));
  f.outcomes({scores:{1:.1,2:.9,3:.5},threshold:.5,aside:[1],kept:[2,3]});
  for(const [score,x] of [[0,96],[.25,348],[.5,600],[.75,852],[1,1104]]){
    assert(Math.abs(sea.outcomeX(score)-x)<1e-8);assert(Math.abs(seaOutcomeX(score,1200)-x)<1e-8);
    assert(Math.abs(sea.outcomeScore(x)-score)<1e-8,'Dragging uses the same normalized axis as the worker');
  }
  assert.equal(sea.outcomeScore(-200),0);assert.equal(sea.outcomeScore(2000),1);
  assert(f.items[0].home.x<250&&f.items[1].home.x>950,'Fit overrides the opposite colour ordering');
  assert.equal(f.items[0].home.y,original[0].home.y);assert.equal(f.items[1].home.y,original[1].home.y);
  assert.equal(f.items[2].visualPoint.x,.5,'Unmeasured photos still have a meaningful fit home');
  assert.deepEqual(f.items.map(it=>[it.x,it.y,it.vx,it.vy]),original.map(it=>it.state));
  f.outcomes(null);
  assert.deepEqual(f.items.map(it=>it.home),original.map(it=>it.home),'Leaving Filter restores colour homes');
  assert.deepEqual(f.items.map(it=>[it.x,it.y,it.vx,it.vy]),original.map(it=>it.state),'Leaving does not teleport the flock');
});
test('threshold changes move photos smoothly to their new side and yield to focus and hover',()=>{
  const f=field([{tags:['same'],x:870,y:180,visual:{saturation:1,brightness:.8}},
    {tags:['same'],x:330,y:570,visual:{saturation:0,brightness:.2}}]);
  const flow={scores:{1:.35,2:.65},threshold:.5,aside:[1],kept:[2]};f.outcomes(flow);
  for(let n=0;n<850;n++)f.step({time:n*16.67});
  assert(f.items[0].x<600&&f.items[1].x>600,'Opposite-colour photos settle on the side their fit predicts');
  const states=f.items.map(it=>[it.x,it.y,it.vx,it.vy]);f.outcomes({...flow,threshold:.75});
  assert.deepEqual(f.items.map(it=>[it.x,it.y,it.vx,it.vy]),states,'Moving the divider never moves a photo directly');
  assert.deepEqual(f.items.map(it=>it.outcomeBank),[-1,-1]);
  const held={x:f.items[0].x,y:f.items[0].y};f.focus({ids:[2]});const anchor={...f.items[1].anchor};
  for(let n=850;n<1000;n++)f.step({time:n*16.67,held:1});
  assert.deepEqual({x:f.items[0].x,y:f.items[0].y},held);
  assert(Math.hypot(f.items[1].x-anchor.x,f.items[1].y-anchor.y)<1,'Focus can cross the threshold');
  const release=f.items.map(it=>[it.x,it.y]);f.focus({});f.step({time:1000*16.67});
  assert(f.items.every((it,i)=>Math.hypot(it.x-release[i][0],it.y-release[i][1])<2.21));
});
test('a Filter panel projects homes onto the correct side while metadata and sizes change',()=>{
  const f=field([{tags:[],x:450,y:400,visual:{saturation:.9,brightness:.5}}]);
  f.outcomes({scores:new Map([[1,.49]]),threshold:.5});
  const positions=f.items.map(it=>[it.x,it.y,it.vx,it.vy]);
  // The nearest shore is right of the threshold, but the top shore has room on the correct side.
  f.resize({width:1200,height:750,obstacles:[{x0:0,y0:200,x1:610,y1:750}],water:[{x0:0,y0:0,x1:1200,y1:190},{x0:620,y0:190,x1:1200,y1:750}]});
  assert(f.items[0].home.x<=600&&f.items[0].home.y<190,'Open water across the divider must not steal a rejected photo');
  assert.deepEqual(f.items.map(it=>[it.x,it.y,it.vx,it.vy]),positions);
  f.set({generation:2,width:1200,height:750,items:f.items.map(it=>({...it,tags:['new'],x:0,y:0}))});
  assert.equal(f.items[0].visualPoint.x,.08+.84*.49,'Metadata refresh keeps the fit axis');
  assert.deepEqual(f.items.map(it=>[it.x,it.y,it.vx,it.vy]),positions);
});
test('explicit Filter endpoints retain their side at either threshold limit',()=>{
  const f=field([{tags:[],visual:{saturation:1,brightness:.8}},{tags:[],visual:{saturation:0,brightness:.2}}]);
  let time=0;
  for(const threshold of [0,1]){
    f.outcomes({scores:{1:0,2:1},threshold,aside:[1],kept:[2]});
    assert.deepEqual(f.items.map(it=>it.outcomeBank),[-1,1],'An explicit toss never passes, and an explicit keep never fails');
    const divider=1200*(.08+.84*threshold);
    assert(f.items[0].home.x<=divider&&f.items[1].home.x>=divider);
    for(let n=0;n<1000;n++){f.step({time:time++*16.67});assert(f.items.every(it=>it.x>=0&&it.x<=1200),'The threshold current must stay inside the sea');}
    assert(f.items[0].x<divider&&f.items[1].x>divider,'Both endpoint banks retain usable space');
  }
});
test('the shared sea ignores UI and catalogue obstacles without changing standalone fields',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';VennSea.prototype');
  const sea=Object.assign(Object.create(proto),{el:{id:'world'},width:1200,height:750,obstacles:[{x0:200,y0:0,x1:800,y1:750}],catalogRect:{x0:0,y0:650,x1:1200,y1:750}});
  sea.water=sea.openWater(1200,750,[sea.catalogRect]);
  assert.equal(sea.water.length,1);assert.equal(sea.water[0].x0,3);assert.equal(sea.water[0].x1,1197);
  assert.equal(sea.bounds().obstacles.length,0,'Neither visible chrome nor its catalogue fences the world');
  sea.el.id='standalone';sea.water=sea.openWater(1200,750,[sea.catalogRect]);
  assert(sea.water.every(r=>r.x1<=196||r.x0>=804));assert.equal(sea.bounds().obstacles.length,2);
});
test('map drops target another physical print before its group, with bounded atlas hit tests',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';VennSea.prototype',{
    document:{elementFromPoint:()=>null}});
  const card=(id,x,y,extra={})=>({id,stack:id,x,y,size:60,el:{classList:{contains:()=>false}},...extra});
  const source=card(1,200,200),target=card(2,400,300),take=card(3,450,300,{take:true,stack:2});
  const sprite=card(4,700,300,{size:12,density:true}),spriteTake=card(5,700,300,{size:12,density:true,take:true,stack:4});
  const sea=Object.assign(Object.create(proto),{cameraOn:true,s:60,camera:{zoom:1,tx:0,ty:0},moving:[source,target,take],
    items:new Map([source,target,take,sprite,spriteTake].map(it=>[it.id,it])),
    el:{id:'world',classList:{contains:()=>false},getBoundingClientRect:()=>({left:0,top:0})},uiTarget:()=>false,
    hitCols:100,hitGrid:new Map([[18*100+43,[spriteTake]]]),spriteMax:12,
    lassos:new Map([['g7',{kind:'group'}]]),contours:new Map([['g7',{paths:[[[350,250],[500,250],[500,400],[350,400]]]}]])});
  const drop=(x,y,excluded=source)=>JSON.parse(JSON.stringify(sea.target(x,y,excluded)));
  assert.deepEqual(drop(400,300),{kind:'photo',id:2},'Paper wins over the surrounding group');
  assert.deepEqual(drop(490,390),{kind:'group',id:7},'Water inside the lasso still files a shot');
  assert.deepEqual(drop(200,200),{kind:'sea'},'A stack cannot merge with itself');
  assert.deepEqual(drop(450,300),{kind:'group',id:7},'A take in a fan is not another physical stack');
  assert.deepEqual(drop(400,300,[source,target,take]),{kind:'group',id:7},'Every dragged body is excluded');
  assert.deepEqual(drop(705,307),{kind:'photo',id:4},'Tiny atlas cards use their full 3:4 paper footprint');
  assert.deepEqual(drop(707,300),{kind:'sea'},'Open water outside the paper does not stack');
  target.lifted=true;assert.deepEqual(drop(400,300),{kind:'group',id:7});target.lifted=false;
  sea.uiTarget=()=>true;assert.deepEqual(drop(400,300),{kind:'group',id:7},'Controls above the sea block stacking');sea.uiTarget=()=>false;
  sea.outcomeFlow={};assert.deepEqual(drop(400,300),{kind:'group',id:7},'Filter keeps its throwing gesture');sea.outcomeFlow=null;
  sea.cameraOn=false;assert.deepEqual(drop(400,300),{kind:'group',id:7},'A comparison does not stack its ambient prints');
});
test('layout and Filter outcome updates do not restart semantic clustering',()=>{
  const f=field(Array.from({length:16},(_,i)=>({tags:i%2?['dog','beach']:['cat','hat']})));
  f.cluster();f.clusterDirty=false;
  const positions=new Map(f.items.map(it=>[it.id,[it.x,it.y,it.cluster]]));
  f.outcomes({aside:[1,3],kept:[2,4]});
  f.set({generation:2,width:1200,height:750,items:[...f.items].reverse().map(it=>({...it,tags:[...it.tags].reverse(),label:it.id%2?'gfilter-aside':'gfilter-kept',baseSize:17}))});
  assert(!f.clusterDirty,'A layout or outcome change leaves the regular clustering cadence intact');
  assert(f.membershipDirty,'Reordered worker positions still send their matching membership array');
  assert.deepEqual(new Map(f.items.map(it=>[it.id,[it.x,it.y,it.cluster]])),positions);
  f.set({generation:3,width:1200,height:750,items:f.items.map(it=>({...it,tags:it.id===1?[...it.tags,'new-subject']:it.tags}))});
  assert(f.clusterDirty,'Actual new recognition requests an earlier semantic refresh');
  f.clusterDirty=false;
  f.set({generation:4,width:1200,height:750,items:f.items.slice(1)});
  assert(f.clusterDirty,'Removing photos changes the clustering sample too');
});
test('ten thousand worker positions respect a large drag and release without quadratic membership scans',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';VennSea.prototype',{performance,fmt:String});
  const items=Array.from({length:10000},(_,i)=>({id:i+1,x:i,y:10,size:4})),dragged=items.slice(0,5000);
  dragged.includes=()=>assert.fail('Do not scan every dragged photo for each worker body');
  const releasePins=items.slice(5000,7000).map(it=>({id:it.id,x:it.x,y:it.y}));
  releasePins.some=()=>assert.fail('Do not scan every released pin for each worker body');
  const sea=Object.assign(Object.create(proto),{alive:true,generation:1,items:new Map(items.map(it=>[it.id,it])),bodies:items,moving:[],takes:[],
    held:null,drag:{items:dragged,members:new Set(dragged)},releasePins,domLimit:160,
    el:{style:{setProperty(){}},dataset:{}},focusBar:{querySelector:()=>null},drawDensity(){},draw(){},kick(){}});
  const positions=Float32Array.from(items.flatMap(it=>[it.x+100,20,4]));
  sea.receive({generation:1,positions,ms:1,focusCount:0});
  assert(items.slice(0,7000).every((it,i)=>it.x===i&&it.y===10),'Held and released photos retain their displayed positions');
  assert(items.slice(7000).every((it,i)=>it.x===7100+i&&it.y===20),'Other photos take the worker update');
  sea.drag=null;sea.releasePins=null;
  sea.receive({generation:1,positions,ms:1,focusCount:0});
  assert(items.every((it,i)=>it.x===i+100&&it.y===20),'Released photos rejoin the next ordinary update');
});
test('a separated take stays visible while the previous stack body update is in flight',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';VennSea.prototype',{performance,fmt:String});
  const element=()=>{const classes=new Set();return {classList:{contains:x=>classes.has(x),remove:x=>classes.delete(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}};};
  const source={id:1,x:120,y:180,size:40,lifted:true},split={id:2,x:260,y:320,size:40,take:true,stack:1,pileLifted:true,el:element()},sibling={id:3,x:125,y:180,take:true,stack:1,pileLifted:false,el:element()};
  const sea=Object.assign(Object.create(proto),{alive:true,generation:1,items:new Map([[1,source],[2,split],[3,sibling]]),bodies:[],moving:[],takes:[split,sibling],
    el:{style:{setProperty(){}},dataset:{}},focusBar:{querySelector:()=>null},drawDensity(){},draw(){},kick(){}});
  proto.adopt.call(sea,split,{id:2,photo:2,rep:2,members:[2],take:false});
  assert.equal(split.pileLifted,false);
  // The lifted source remains in the stale list until sendBodies runs, as happens when Filter opens.
  split.lifted=true;
  sea.receive({generation:1,positions:new Float32Array(),ms:1,focusCount:0});
  assert.equal(split.pileLifted,false);assert.equal(split.el.classList.contains('pile-lifted'),false);
  assert.equal(split.x,260);assert.equal(split.y,320,'A separated take must not inherit stale pile offsets');
  assert.equal(sibling.pileLifted,true,'Actual stack members still follow their lifted cover');
});
test('equal-weight tag vectors blend partial overlap and bound forces',()=>{
  assert.equal(seaSimilarity([1],[2]),0);assert.equal(seaSimilarity([1,2],[1,2]),1);
  assert.equal(seaSimilarity([1],[1,2]),1/Math.sqrt(2));
  assert(seaForce(1,60,30,120)>seaForce(.7,60,30,120));assert(seaForce(.7,60,30,120)>0);
  assert(seaForce(0,60,30,120)<0);assert(seaForce(1,15,30,120)<0);
  assert(seaForce(1/3,60,30,120)<0,'One shared broad tag must not outweigh two unlike tags');
  assert.equal(seaForce(0,120,30,120),0);assert.equal(seaForce(1,121,30,120),0);
  assert(Math.abs(seaForce(0,90,30,120))<Math.abs(seaForce(0,60,30,120)));
});
test('automatic clustering finds semantic neighbourhoods without assigning a grid',()=>{
  const f=field(Array.from({length:120},(_,i)=>({tags:['tag'+i%4]}))),groups=f.cluster();
  assert.equal(groups.length,4);assert(groups.every(g=>g.count===30));
  const before=f.items.map(it=>[it.x,it.y]);for(let k=0;k<240;k++)f.step({time:k*17});
  assert(f.items.some((it,i)=>Math.hypot(it.x-before[i][0],it.y-before[i][1])>50));
  let overlaps=0;for(let i=0;i<f.items.length;i++)for(let j=0;j<i;j++)if(Math.abs(f.items[i].x-f.items[j].x)<35&&Math.abs(f.items[i].y-f.items[j].y)<35)overlaps++;
  assert.equal(overlaps,0);
  assert.deepEqual(new Set(f.cluster().map(c=>c.id)),new Set(groups.map(c=>c.id)));
});
test('settled flocks keep diagonal neighbours apart as contacts propagate',()=>{
  for(const initial of [2,31,79]){
    let seed=initial;
    const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296),homes=new Map();
    const f=new SeaField();
    f.set({generation:1,tuning:MECHANICS,width:1200,height:750,water:[{x0:3,y0:3,x1:1197,y1:656}],
      obstacles:[{x0:0,y0:660,x1:1200,y1:750}],items:Array.from({length:120},(_,i)=>{
        const tag=`tag${i%4}`,at=homes.get(tag),it={id:10000+i,tags:[tag],baseSize:31.56,
          x:at?Math.max(20,Math.min(1180,at.x+(random()-.5)*160)):20+random()*1160,
          y:at?Math.max(20,Math.min(636,at.y+(random()-.5)*160)):20+random()*616};
        homes.set(tag,it);return it;
      })});
    f.cluster();
    for(let frame=1;frame<=205;frame++){
      if(frame===126)f.cluster();
      f.step({time:frame*32});
      if(frame<130)continue;
      for(let i=0;i<f.items.length;i++)for(let j=0;j<i;j++){
        const a=f.items[i],b=f.items[j],edge=(a.size+b.size)/2;
        assert(Math.abs(a.x-b.x)>=edge||Math.abs(a.y-b.y)>=edge,`Seed ${initial}, frame ${frame}: photos ${a.id} and ${b.id} overlap`);
      }
    }
  }
});
test('focus intersects by default, supports union, and release preserves tags',()=>{
  const f=field([{tags:['dog']},{tags:['beach']},{tags:['dog','beach']},{tags:['cat']}]);f.cluster();
  f.focus({keys:['dog','beach']});assert.equal(f.focusCount,1);assert(f.items[2].anchor);assert(!f.items[0].anchor);
  const anchor={...f.items[2].anchor};for(let i=0;i<60;i++)f.step({time:i*17});
  assert(Math.hypot(f.items[2].x-anchor.x,f.items[2].y-anchor.y)<1);
  f.focus({keys:['dog','beach'],any:true});assert.equal(f.focusCount,3);
  const tags=f.items.map(it=>[...it.tags]);f.step({time:2000,pins:[{id:3,x:40,y:40}]});assert.equal(f.items[2].x,40);
  f.focus({keys:[]});assert(f.items.every(it=>!it.anchor));f.step({time:2050});assert.deepEqual(f.items.map(it=>it.tags),tags);
});
test('worker updates preserve positions and hold reached-for photos',()=>{
  const f=field([{tags:['dog']},{tags:['dog']}]);f.cluster();f.step({time:1,held:1});const first={...f.items[0]};f.step({time:34,held:1});
  assert.equal(f.items[0].x,first.x);assert.equal(f.items[0].y,first.y);
  f.set({generation:2,width:1200,height:750,items:[{id:1,x:0,y:0,baseSize:35,tags:['dog','beach']}]});
  assert.equal(f.items[0].x,first.x);assert.deepEqual(f.items[0].tags,['beach','dog']);
});
test('focused players use continuous open water and fit beside panels',()=>{
  const f=field([{tags:['dog']}]);
  f.resize({width:1200,height:750,water:[{x0:0,x1:1200,y0:0,y1:150},{x0:0,x1:900,y0:150,y1:500},{x0:0,x1:1200,y0:500,y1:750}],obstacles:[{x0:900,x1:1200,y0:150,y1:500}]});
  f.focus({keys:['dog']});
  assert.equal(f.items[0].anchor.x,450);assert.equal(f.items[0].anchor.y,375);assert.equal(f.items[0].size,220);
  f.resize({width:1200,height:750,water:[{x0:0,x1:70,y0:0,y1:750}],obstacles:[]});f.focus({keys:['dog']});
  assert(f.items[0].size*.72<35);
});
test('tiny margins reduce detail and keep prints out of the header',()=>{
  const f=field([{tags:['dog'],x:300,y:50}]);
  f.resize({width:390,height:788,water:[{x0:3,x1:8,y0:3,y1:785}],obstacles:[{x0:8,x1:390,y0:0,y1:788}]});f.focus({keys:[]});
  f.step({time:1});const it=f.items[0];
  assert(it.size<4);assert(it.x+it.size*.72<=8+1e-6);assert(it.x-it.size*.72>=3-1e-6);
});

test('flocks steer into open water instead of lining the panels',()=>{
  const width=1200,height=750,obstacles=[{x0:0,y0:0,x1:1000,y1:180},{x0:1000,y0:0,x1:1200,y1:650},{x0:0,y0:620,x1:1000,y1:750}];
  const water=[{x0:3,y0:184,x1:996,y1:616}];let seed=7;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const f=new SeaField();f.set({generation:1,tuning:MECHANICS,width,height,water,obstacles,items:Array.from({length:600},(_,i)=>({id:i,x:random()*width,y:random()*height,baseSize:i<100?20:8,tags:['year',`subject:${i%18}`,`place:${i%7}`]}))});f.cluster();
  for(let i=0;i<360;i++)f.step({time:i*16.67});
  const middle=f.items.filter(it=>it.x>70&&it.x<930&&it.y>240&&it.y<560);
  assert(middle.length>f.items.length*.3,`Only ${middle.length} photos entered the open centre`);
  for(const it of f.items)assert(obstacles.every(o=>it.x+it.size*.7<=o.x0||it.x-it.size*.7>=o.x1||it.y+it.size*.7<=o.y0||it.y-it.size*.7>=o.y1));
});
test('a broad shared tag keeps using open water as the spotlight comes and goes',()=>{
  const width=1600,height=1000,count=1879,obstacles=[{x0:610,y0:240,x1:990,y1:650}];
  const water=[{x0:3,y0:3,x1:1597,y1:236},{x0:3,y0:654,x1:1597,y1:997},
    {x0:3,y0:236,x1:606,y1:654},{x0:994,y0:236,x1:1597,y1:654}];
  let seed=31;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const f=new SeaField();
  f.set({generation:1,tuning:MECHANICS,width,height,water,obstacles,items:Array.from({length:count},(_,i)=>({id:10000+i,
    x:30+random()*(width-60),y:30+random()*(height-60),baseSize:i<160?32:5.2,
    tags:['face',`subject:${i%18}`,`appearance:${i%7}`]}))});
  f.cluster();
  for(let frame=1;frame<=300;frame++){
    if(frame===151){f.resize({width,height,obstacles:[]});f.focus({});}
    if(frame%125===0)f.cluster();
    f.step({time:frame*32});
    if(frame!==150&&frame!==300)continue;
    const quarters=[0,1,2,3].map(k=>f.items.filter(it=>it.x>=width*k/4&&it.x<width*(k+1)/4).length);
    assert(quarters.every(n=>n>count*.1),`Frame ${frame}: shared tags collapsed the sea into ${quarters}`);
  }
  const edge=f.items.filter(it=>it.x<25||it.x>width-25||it.y<25||it.y>height-25).length;
  const centre=f.items.filter(it=>it.x>400&&it.x<1200&&it.y>250&&it.y<750).length;
  assert(edge<count*.2,`${edge} photos were pushed onto the viewport boundary`);
  assert(centre>count*.18,`Only ${centre} photos returned to the open centre`);
});
test('lassos preserve empty water and wait for intermingled groups',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js');
  const items=[];for(let x=100;x<=900;x+=25)items.push({label:'g',x,y:100,size:20},{label:'g',x,y:500,size:20});
  for(let y=100;y<=500;y+=25)items.push({label:'g',x:100,y,size:20},{label:'g',x:900,y,size:20});
  const inside=(p,paths)=>{let yes=false;for(const h of paths)for(let i=0,j=h.length-1;i<h.length;j=i++){const a=h[i],b=h[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
  const [group]=seaContours(items,1000,700);
  assert(!inside([500,300],group.paths),'A lasso must not paint an empty centre');assert(inside([100,300],group.paths));
  const mixed=seaContours([...items,...items.map(it=>({...it,label:'other'}))],1000,700);
  assert.equal(mixed.length,2);assert(mixed.every(g=>g.count===items.length&&!g.paths.length));
});

test('a phone resize preserves the spread instead of pinning every photo to one edge',()=>{
  const f=field(Array.from({length:60},(_,i)=>({tags:['dog'],x:100+i*16,y:200+i%7*50,baseSize:8})));
  f.resize({width:390,height:750});f.focus({keys:[]});f.cluster();f.step({time:1});
  const xs=f.items.map(it=>it.x);assert(Math.max(...xs)<385);assert(Math.min(...xs)<60);assert(xs.filter(x=>x>100&&x<290).length>25);
});
test('holding all members keeps their group control available',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js');
  const [group]=seaContours([{label:'dogs',fixed:true,x:50,y:50,size:30}],1200,750);
  assert.equal(group.count,1);assert.deepEqual(group.paths,[]);
});

test('steering carries momentum through a sudden reversal and pins still stop immediately',()=>{
  const f=field([{tags:[],x:600,y:375,baseSize:8}]);let direction=1;
  f.avoid=()=>[direction*.12,0];
  for(let k=0;k<=45;k++)f.step({time:k*16.67});
  const before=f.items[0].vx;assert(before>.5);
  direction=-1;f.step({time:46*16.67});
  assert(f.items[0].vx>0,'A reversed steering target bends the path instead of instantly reversing it');
  assert(Math.abs(f.items[0].vx-before)<.12,'One frame cannot kick the photo into a new velocity');
  for(let k=47;k<=90;k++)f.step({time:k*16.67});
  assert(f.items[0].vx<-.5,'The smoothed response still follows the new direction');
  f.step({time:91*16.67,pins:[{id:1,x:400,y:300}]});
  assert.equal(f.items[0].x,400);assert.equal(f.items[0].y,300);assert.equal(f.items[0].vx,0);assert.equal(f.items[0].vy,0);
  f.step({time:92*16.67});assert(Math.hypot(f.items[0].x-400,f.items[0].y-300)<.1,'Release starts gently without stored steering recoil');
});
test('metadata updates and renamed clusters preserve a roaming photo’s path',()=>{
  const a=field([{tags:['dog'],x:600,y:375,baseSize:8}]),b=field([{tags:['dog'],x:600,y:375,baseSize:8}]);
  for(let k=0;k<30;k++){a.step({time:k*16.67});b.step({time:k*16.67});}
  a.set({generation:2,width:1200,height:750,items:[{id:1,x:0,y:0,baseSize:8,tags:['dog','beach']}]});
  a.items[0].cluster='new-group';b.items[0].cluster='previous-group';
  for(let k=30;k<60;k++){a.step({time:k*16.67});b.step({time:k*16.67});}
  assert(Math.hypot(a.items[0].x-b.items[0].x,a.items[0].y-b.items[0].y)<1e-8);
  assert(Math.hypot(a.items[0].vx-b.items[0].vx,a.items[0].vy-b.items[0].vy)<1e-8);
});
test('uneven worker intervals preserve the same weighted steering motion',()=>{
  const run=intervals=>{
    const f=field([{tags:[],x:600,y:375,baseSize:8}]);f.avoid=()=>[.12,0];f.step({time:0});
    let time=0,index=0;while(time<1000){time=Math.min(1000,time+intervals[index++%intervals.length]);f.step({time});}
    return f.items[0];
  };
  const regular=run([10]),uneven=run([7,29,13,41,10]);
  assert(Math.hypot(regular.x-uneven.x,regular.y-uneven.y)<.15);
  assert(Math.hypot(regular.vx-uneven.vx,regular.vy-uneven.vy)<.015);
});
test('alternating tiny-photo updates accumulate elapsed time rather than doubling the latest interval',()=>{
  const run=intervals=>{
    const f=field([{id:1,tags:[],x:600,y:375,baseSize:5},...Array.from({length:1000},(_,i)=>({id:i+2,tags:[],x:100,y:100,baseSize:5}))]);
    const lifted=f.items.slice(1).map(it=>it.id);f.avoid=()=>[.12,0];f.step({time:0,lifted});
    let time=0,index=0;while(time<1000){time+=intervals[index++%intervals.length];f.step({time,lifted});}
    return f.items[0];
  };
  const regular=run([20]),uneven=run([10,30]);
  assert(Math.hypot(regular.x-uneven.x,regular.y-uneven.y)<1e-8);
  assert(Math.hypot(regular.vx-uneven.vx,regular.vy-uneven.vy)<1e-8);
});
test('resolving a contact removes closing velocity without moving a held photo',()=>{
  for(const held of [null,2]){
    const f=field([{tags:['dog'],x:500,y:375,baseSize:35},{tags:['dog'],x:540,y:375,baseSize:35}]);
    f.items[0].vx=1;f.items[1].vx=-1;f.step({time:0,held});
    const [a,b]=f.items,dx=a.x-b.x,dy=a.y-b.y;
    assert(Math.hypot(dx,dy)>=(a.size+b.size)*.74);
    assert((a.vx-b.vx)*dx+(a.vy-b.vy)*dy>=-1e-8,'Separated photos must not immediately tap back into each other');
    if(held){assert.equal(b.x,540);assert.equal(b.y,375);assert.equal(b.vx,0);assert.equal(b.vy,0);}
  }
});

test('automatic groups do not duplicate an identical meaning across distant corners',()=>{
  const f=field(Array.from({length:90},(_,i)=>({tags:i<60?['face','face']:['dog'],
    x:i<30?10:i<60?1190:100,y:i<30?10:i<60?740:100})));
  const groups=f.cluster();
  assert.equal(groups.length,2);
  assert.equal(groups.find(g=>g.tags.includes('face')).count,60);
  assert.equal(new Set(f.items.slice(0,60).map(it=>it.cluster)).size,1);
  const allFaces=field(Array.from({length:120},(_,i)=>({tags:['face'],x:i%2?1190:10,y:i%3?740:10})));
  assert.deepEqual(allFaces.cluster(),[],'A ubiquitous tag is still a tag, not several invented neighbourhoods');
  assert(allFaces.items.every(it=>it.cluster===null));
  allFaces.focus({keys:['face']});assert.equal(allFaces.focusCount,120,'Underlying tags remain usable without an automatic suggestion');
});
test('automatic names describe a supported majority rather than ubiquitous or minority tags',()=>{
  const f=field(Array.from({length:120},(_,i)=>({x:100,y:100,tags:['face','year:2026','place:earth',`theme:${i%4}`,
    ...(i%20===4?['sparkle']:[]),...([1,2].includes(i)?['eyes_closed']:[])]})));
  const groups=f.cluster();
  assert.equal(groups.length,4);assert(groups.every(g=>g.count===30));
  assert(groups.every(g=>g.tags.length===1&&g.tags[0].startsWith('theme:')),
    'Faces is universal, sparkle is only a minority, and two blinks cannot name a group');
  const reading=field(Array.from({length:120},(_,i)=>({tags:i<60?['face','smile']:['face'],
    x:i%2?1190:10,y:i%3?740:10})));
  const suggestions=reading.cluster();assert.equal(suggestions.length,1);
  assert.deepEqual(suggestions[0].tags,['smile']);assert.equal(suggestions[0].count,60);
});
test('each outlined shore needs three actual nearby bodies and keeps saved group controls',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js');
  const print=(x,y=100)=>({label:'saved',cluster:'automatic',x,y,size:35});
  for(const items of [[{...print(100),size:160}],[print(100),print(135)],
    [print(100),print(450),print(800)],[print(100),print(135),{...print(170),fixed:true,dragged:true}]]){
    const [group]=seaContours(items,1200,750);
    assert.equal(group.id,'saved');assert.equal(group.count,items.length);assert.deepEqual(group.paths,[]);
  }
  const trio=[print(100),print(135),print(170)],separate=print(700);
  const [gathering]=seaContours([...trio,separate],1200,750);
  assert.equal(gathering.count,4);assert.equal(gathering.paths.length,1);
  assert(Math.max(...gathering.paths.flat().map(p=>p[0]))<250,'The isolated fourth body cannot make another bubble');
  const mixed=seaContours([...trio,...trio.slice(0,2).map(it=>({...it,label:'other'}))],1200,750);
  assert(mixed.find(g=>g.id==='saved').paths.length,'A pair with no shore must not hide a real gathering');
  assert.deepEqual(mixed.find(g=>g.id==='other').paths,[]);
});

test('lasso confidence stays visible while overlap crosses the former purity cutoff',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js');
  const trio=(label,shift=0)=>[100,135,170].map((x,i)=>({id:(label==='a'?0:10)+i,label,x:x+shift,y:100,size:35}));
  const history=new Map(),frames=[90,75,60,75,90].map((shift,i)=>seaContours([...trio('a'),...trio('b',shift)],1200,750,history,i*300)[0]);
  assert(frames[0].purity>.6&&frames[1].purity<.6,'The replay straddles the old on/off boundary');
  assert(frames.every(g=>g.paths.length&&g.opacity>.8));
  for(let i=1;i<frames.length;i++)assert(Math.abs(frames[i].opacity-frames[i-1].opacity)<.15);
  const mixed=seaContours([...trio('a'),...trio('b')],1200,750);
  assert(mixed.every(g=>!g.paths.length&&g.hotPaths.length),'Intermixed groups stay inspectable on hover without drawing a permanent mesh');
});
test('an established shore survives a brief separation and a held member without enclosing the gap',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js'),history=new Map();
  const trio=[100,135,170].map((x,id)=>({id,label:'saved',x,y:100,size:35}));
  const frame=(time,apart=false,held=false)=>seaContours(trio.map((it,i)=>({...it,x:it.x+(i===2&&apart?160:0),fixed:i===2&&held})),1200,750,history,time)[0];
  assert(frame(0).paths.length);
  const separated=frame(300,true);assert(separated.paths.length);
  assert(Math.max(...separated.paths.flat().map(p=>p[0]))<220,'The distant third photo cannot stretch the shore over empty water');
  assert(frame(600).paths.length);assert(frame(1000,true).paths.length);assert.deepEqual(frame(1600,true).paths,[],'A permanent pair eventually loses the automatic outline');
  assert(frame(1800).paths.length);assert(frame(3600,false,true).paths.length,'Holding a member must not erase an established group');
  seaContours([],1200,750,history,4000);assert.equal(history.size,0);
});
test('lasso controls preserve meaning across new descriptors and relayout only when the shelf opens or closes',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),frames=[];
  const node=()=>({dataset:{},hidden:false,remove(){this.parentElement?.children.delete(this);this.parentElement=null;}});
  const row={children:new Set(),append(tag){tag.parentElement?.children.delete(tag);tag.parentElement=this;this.children.add(tag);}};
  const proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';VennSea.prototype',{
    document:{createElement:node},esc:String,fmt:String,requestAnimationFrame:fn=>frames.push(fn)
  });
  let layouts=0,clicked=null;
  const sea=Object.assign(Object.create(proto),{alive:true,keys:[],catalog:true,paused:false,tray:{hidden:false},tagRow:row,
    lassos:new Map(),circles:new Map(),contours:new Map(),bodies:Array.from({length:6},(_,i)=>({id:i+1})),
    items:new Map(Array.from({length:6},(_,i)=>[i+1,{}])),draw(){},focusLasso:id=>clicked=id,
    layout(){layouts++;this.tray.hidden=!(this.keys.length||this.lassos.size);}});
  const membership=new Uint16Array(6).fill(1);
  sea.clusterLabels([{id:'old',tags:['dog'],count:6}],membership);
  const original=sea.lassos.get('old'),hue=original.hue,shape={count:6,paths:[]};sea.contours.set('old',shape);sea.focusCluster='old';
  sea.clusterLabels([{id:'new',tags:['dog','beach'],count:6}],membership);
  assert.equal(sea.lassos.get('new'),original);assert.equal(original.hue,hue);assert.equal(sea.focusCluster,'new');assert.equal(sea.contours.get('new'),shape);
  original.tag.onclick({stopPropagation(){}});assert.equal(clicked,'new');assert.equal(frames.length,0);
  sea.clusterLabels([{id:'cats',tags:['cat'],count:6}],membership);
  assert.notEqual(sea.lassos.get('cats'),original,'Unrelated meanings cannot inherit a previous flock identity');
  sea.clusterLabels([],new Uint16Array(6));assert.equal(frames.length,1);frames.shift()();assert.equal(layouts,1);assert(sea.tray.hidden);
  sea.clusterLabels([],new Uint16Array(6));assert.equal(frames.length,0,'An already hidden shelf cannot cause repeated worker rebuilds');
  sea.clusterLabels([{id:'dogs',tags:['dog'],count:6}],membership);assert.equal(frames.length,1);frames.shift()();
  assert.equal(layouts,2);assert(!sea.tray.hidden);assert.equal(row.children.size,1);
});

test('lasso geometry crossfades cached bitmaps without retracing shores',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),frames=[],paint=[];let now=0,vertices=0,canvases=0;
  const ctx={globalAlpha:1,setTransform(){},clearRect(){},save(){},restore(){},beginPath(){},rect(){},clip(){},
    moveTo(){},quadraticCurveTo(){vertices++;},closePath(){},fill(){},setLineDash(){},stroke(){},drawImage(){paint.push(this.globalAlpha);}};
  const proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';VennSea.prototype',{
    window:{devicePixelRatio:1},document:{hidden:false,createElement(){canvases++;return{getContext:()=>({...ctx})};}},
    reduceMotion:false,performance:{now:()=>now},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;}
  });
  const row={},tag={hidden:false,parentElement:row},l={tag,hue:30,kind:'group'},shape=(key,x)=>({key,count:3,opacity:1,paths:[[[x,0],[x+20,0],[x+20,20],[x,20]]]});
  const sea=Object.assign(Object.create(proto),{alive:true,paused:false,ctx,canvas:{style:{}},width:1200,height:750,tagRow:row,lassos:new Map([['g',l]]),
    contours:new Map([['g',shape('a',100)]]),generation:1,contourCountsGeneration:1,contourCounts:new Map([['g',3]]),catalogTabStop(){}});
  sea.draw(1200,750);assert.equal(frames.length,1);assert.equal(paint.length,0);assert.equal(vertices,4);
  now=110;frames.shift()();assert.equal(paint.at(-1),.5);assert.equal(vertices,4,'Fade frames must not tessellate the geometry again');
  now=220;frames.shift()();assert.equal(paint.at(-1),1);assert.equal(frames.length,0);
  now=300;sea.contours.set('g',shape('b',110));sea.draw(1200,750);assert.equal(vertices,8);
  now=410;paint.length=0;frames.shift()();assert.deepEqual(paint,[.5,.5]);assert.equal(vertices,8);
  now=520;frames.shift()();assert.equal(frames.length,0);assert.equal(sea.contourRaster.previous,null);
  now=525;sea.contours.set('g',shape('b',110));sea.draw(1200,750);assert.equal(vertices,8,'An unchanged worker shore reuses its raster even with a new message object');
  l.still=true;now=530;sea.draw(1200,750);assert.equal(paint.at(-1),1,'Hover highlighting is immediate');assert.equal(frames.length,0);
  assert.equal(canvases,2,'Subsequent geometry and hover redraws reuse two viewport-sized buffers');
});

test('contour cache keys change when equal shores move in opposite directions',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js');
  const items=[0,1].flatMap(shore=>[0,1,2].map(i=>({id:shore*3+i,label:'same',x:100+shore*400+i*35,y:100+shore*250,size:35})));
  const first=seaContours(items,1200,750)[0];
  // Each shore occupies the same number of cells. Equal and opposite translations preserve their old linear hash.
  const moved=items.map(it=>({...it,x:it.x+(it.id<3?20:-20)}));
  const second=seaContours(moved,1200,750)[0];
  assert.equal(first.paths.length,2);assert.equal(second.paths.length,2);
  assert.equal(first.key.split(':')[2],second.key.split(':')[2]);
  assert.notDeepEqual(first.paths,second.paths);
  assert.notEqual(first.key,second.key,'Different occupied water must invalidate the cached bitmap');
  assert.equal(second.key,seaContours([...moved].reverse(),1200,750)[0].key,'Iteration order cannot create spurious cache misses');
});

test('destroying a sea cancels its fade and releases both raster buffers',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),cancelled=[];
  const proto=vm.runInNewContext(fs.readFileSync('matcher/static/photo-sea.js','utf8')+';VennSea.prototype',{
    document:{removeEventListener(){}},clearTimeout(){},cancelAnimationFrame:id=>cancelled.push(id)
  });
  const current={width:2400,height:1500},spare={width:2400,height:1500};
  const sea=Object.assign(Object.create(proto),{alive:true,items:new Map(),paintRaf:18,contourFadeRaf:19,raf:20,contourRaster:{current,spare,previous:spare},
    worker:{terminate(){}},tray:{remove(){}},events:{abort(){}},ro:{disconnect(){}}});
  sea.destroy();assert.deepEqual(cancelled,[18,19,20]);assert.equal(sea.contourFadeRaf,null);assert.equal(sea.contourRaster,null);
  assert.equal(current.width+current.height+spare.width+spare.height,0);assert.equal(sea.alive,false);
});

test('assigned group neighbours gather despite unlike tags and continue roaming with a print buffer',()=>{
  const make=labels=>field([{x:550,y:350,tags:['dog'],label:labels[0]},{x:630,y:350,tags:['cat'],label:labels[1]}]);
  const same=make(['g7','g7']),other=make(['g7','g8']),plain=make([null,null]);
  const distance=f=>Math.hypot(f.items[0].x-f.items[1].x,f.items[0].y-f.items[1].y);
  let smallest=Infinity;
  for(let frame=0;frame<360;frame++){
    for(const f of [same,other,plain])f.step({time:frame*16.67});
    smallest=Math.min(smallest,distance(same));
  }
  assert(distance(same)<60,'A deliberate group must overcome conflicting automatic tags');
  assert(distance(other)>115&&distance(plain)>115,'Unrelated groups still separate locally');
  assert(smallest>=70*.74-.01,'Cohesion cannot compress the existing contact buffer');
  assert(Math.hypot((same.items[0].x+same.items[1].x)/2-590,(same.items[0].y+same.items[1].y)/2-350)>30,'A group has no fixed territory');
  assert.deepEqual(same.items.map(it=>it.tags),[['dog'],['cat']],'Group assignment does not change equal-weight semantic vectors');
});
test('automatic, set-aside and category labels do not become assigned groups, and distant groups exert no pull',()=>{
  const make=label=>field([{x:300,y:350,tags:['dog'],label},{x:600,y:350,tags:['cat'],label}]);
  const plain=make(null),variants=['g7','gcut','gcup:people','a123','saved'].map(make);
  for(let frame=0;frame<60;frame++)for(const f of [plain,...variants])f.step({time:frame*16.67});
  for(const f of variants)assert.deepEqual(f.items.map(it=>[it.x,it.y,it.vx,it.vy]),plain.items.map(it=>[it.x,it.y,it.vx,it.vy]));
  assert.equal(variants[0].items[0].assignedGroup,'g7');
  assert(variants.slice(1).every(f=>f.items.every(it=>it.assignedGroup===null)));
  const near=label=>field([{x:550,y:350,tags:['dog'],label},{x:630,y:350,tags:['cat'],label}]);
  const baseline=near(null),shelfLabels=['gcut','gcup:people','a123'].map(near);
  for(let frame=0;frame<60;frame++)for(const f of [baseline,...shelfLabels])f.step({time:frame*16.67});
  for(const f of shelfLabels)assert.deepEqual(f.items.map(it=>[it.x,it.y]),baseline.items.map(it=>[it.x,it.y]));
});
test('assigned flocks produce occupied shores from their actual positions',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js');
  const f=field([0,1].flatMap(g=>[[400,300],[480,300],[440,370]].map(([x,y],i)=>({x:x+g*250,y,tags:[`unique:${g*3+i}`],label:`g${g+1}`}))));
  for(let frame=0;frame<360;frame++)f.step({time:frame*16.67});
  const shores=seaContours(f.items,1200,750);
  assert.equal(shores.length,2);assert(shores.every(c=>c.count===3&&c.paths.length===1&&c.purity===1));
  for(const shore of shores){const xs=shore.paths.flat().map(p=>p[0]);assert(Math.max(...xs)-Math.min(...xs)<150,'The outline encloses its close gathering, not a fixed region');}
});
test('assigned cohesion releases with edits and never moves a held photo or settled focus anchor',()=>{
  const f=field([{x:550,y:350,tags:['dog'],label:'g7'},{x:630,y:350,tags:['cat'],label:'g7'}]);
  for(let frame=0;frame<120;frame++)f.step({time:frame*16.67,held:1});
  assert.equal(f.items[0].x,550);assert.equal(f.items[0].y,350);assert.equal(f.items[0].vx,0);
  f.focus({ids:[1,2]});for(let frame=120;frame<260;frame++)f.step({time:frame*16.67});
  for(const it of f.items)assert(Math.hypot(it.x-it.anchor.x,it.y-it.anchor.y)<.001);
  const anchor={...f.items[0].anchor};f.step({time:260*16.67,held:2,pins:[{id:2,x:70,y:80}]});
  assert.equal(f.items[1].x,70);assert.equal(f.items[1].y,80);assert(Math.hypot(f.items[0].x-anchor.x,f.items[0].y-anchor.y)<.001);
  f.set({generation:2,width:1200,height:750,items:f.items.map(it=>({id:it.id,x:it.x,y:it.y,baseSize:35,tags:it.tags,label:it.id===1?'g7':null}))});
  assert.equal(f.items[1].assignedGroup,null,'Removing a group cannot retain an old cohesive membership');
});
test('ten thousand assigned photos keep the existing bounded neighbour work',()=>{
  const f=new SeaField(),n=10000;
  f.set({generation:1,tuning:MECHANICS,width:1600,height:900,items:Array.from({length:n},(_,i)=>({id:i+1,x:20+i*37%1560,y:20+i*61%860,baseSize:4,tags:[`tag:${i%17}`],label:`g${i%20}`}))});
  let queries=0,visits=0;const neighbours=f.neighbours;
  f.neighbours=function(it,limit,visit){queries++;assert(limit<=4);return neighbours.call(this,it,limit,(other,j)=>{visits++;visit(other,j);});};
  f.step({time:16.67});assert(queries<=2*n&&visits<=72*n);
  assert.equal(f.byId.size,n);assert.equal(f.steering.size,n);assert(f.items.every(it=>it.assignedGroup&&Number.isFinite(it.x+it.y)));
});
test('tiny-print lassos recede without losing their group or hover geometry',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js');
  const photos=Array.from({length:12},(_,i)=>({id:i,label:'g7',x:100+i*5,y:100,size:4}));
  const [tiny]=seaContours(photos,1200,750),[large]=seaContours(photos.map(it=>({...it,size:35})),1200,750);
  assert.equal(tiny.count,12);assert(tiny.paths.length&&tiny.hotPaths.length);
  assert(tiny.opacity>0&&tiny.opacity<.1,'Distant prints should not become a mesh of full-strength outlines');
  assert.equal(large.opacity,1,'A readable gathering keeps its full outline');
});
test('lifting the bridge photo preserves its source shore and release returns the same geometry',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js'),history=new Map();
  const photos=Array.from({length:7},(_,i)=>({id:i+1,label:'g7',x:160+i*55,y:200,size:35}));
  const shore=()=>seaContours(photos,1200,750,history)[0];
  const before=shore();assert.equal(before.paths.length,1);
  photos[3].fixed=true;photos[3].lifted=true;
  const during=shore();assert.equal(during.paths.length,1);assert.equal(during.key,before.key,'The reserved source footprint is unchanged while the image is elsewhere');
  photos[3].fixed=false;photos[3].lifted=false;
  assert.equal(shore().key,before.key,'Returning the photo cannot cut or inflate its original bubble');
  photos[3].fixed=true;assert.equal(shore().key,before.key,'A stationary hover keeps its footprint too');
  photos[3].dragged=true;
  assert.equal(shore().paths.length,2,'A pointer-held bridge uses the drag rules, not the lifted source reservation');
});
test('lift reservations support nearby visible photos without inventing remote or empty bubbles',()=>{
  const {seaContours}=require('../matcher/static/sea-contours.js');
  const trio=[100,135,170].map((x,id)=>({id,label:'g7',x,y:100,size:35}));
  const local=trio.map((it,i)=>({...it,fixed:i===1,lifted:i===1}));
  assert.equal(seaContours(local,1200,750)[0].paths.length,1);
  const remote=local.map((it,i)=>({...it,x:it.x+(i===1?500:0)}));
  assert.equal(seaContours(remote,1200,750)[0].paths.length,0,'A distant lifted source cannot stretch an outline across empty water');
  const separate=[...local,...trio.map(it=>({...it,id:it.id+10,x:it.x+600}))];
  assert.equal(seaContours(separate,1200,750)[0].paths.length,2,'Truly separate flocks retain separate shores');
  assert.equal(seaContours(trio.map(it=>({...it,fixed:true,lifted:true})),1200,750)[0].paths.length,0,'Showing an entire flock elsewhere must not leave an empty bubble');
});
test('worker distinguishes a lifted source from pointer pins and clears it on return',()=>{
  const f=field([{tags:['dog'],x:200,y:200},{tags:['dog'],x:240,y:200},{tags:['dog'],x:280,y:200}]);
  f.step({time:0,lifted:[2],held:1,pins:[{id:3,x:400,y:400}],dragged:[3]});
  assert.deepEqual(f.items.map(it=>it.lifted),[false,true,false]);assert.deepEqual(f.items.map(it=>it.dragged),[false,false,true]);assert(f.items.every(it=>it.fixed));
  const origin={x:f.items[1].x,y:f.items[1].y};
  f.step({time:100,lifted:[2]});assert.deepEqual({x:f.items[1].x,y:f.items[1].y},origin);
  f.step({time:200});assert(f.items.every(it=>!it.lifted&&!it.fixed&&!it.dragged));
});

test('visual geography has fixed colour and brightness axes with no rank or tag dependence',()=>{
  const {seaVisualHome}=require('../matcher/static/sea-worker.js');
  const muted=seaVisualHome({saturation:0,brightness:.5},1200,750,1),colour=seaVisualHome({saturation:1,brightness:.5},1200,750,1);
  const dark=seaVisualHome({saturation:.5,brightness:0},1200,750,1),light=seaVisualHome({saturation:.5,brightness:1},1200,750,1);
  assert(colour.x-muted.x>900);assert(dark.y-light.y>600);assert.equal(muted.y,colour.y);assert.equal(dark.x,light.x);
  assert.equal(seaVisualHome({brightness:.5,saturation:null},1200,750,1),null,'Older unmeasured colour stays unknown');
  assert.equal(seaVisualHome({brightness:NaN,saturation:.5},1200,750,1),null);
});
test('measured photos settle by colour and light, retain hover, and yield to focus without teleporting',()=>{
  const f=field([{tags:['same'],x:700,y:600,visual:{saturation:.05,brightness:.9}},
    {tags:['same'],x:450,y:160,visual:{saturation:.95,brightness:.1}}]);
  const before=f.items.map(it=>[it.x,it.y]);
  for(let n=0;n<850;n++)f.step({time:n*16.67});
  assert(f.items[0].x<400&&f.items[0].y<220,'Muted bright photos converge upper-left');
  assert(f.items[1].x>900&&f.items[1].y>550,'Saturated dark photos converge lower-right');
  const still={x:f.items[0].x,y:f.items[0].y};
  for(let n=850;n<880;n++)f.step({time:n*16.67,held:1});
  assert.deepEqual({x:f.items[0].x,y:f.items[0].y},still);
  const positions=f.items.map(it=>[it.x,it.y]);
  f.set({generation:2,width:1200,height:750,items:f.items.map(it=>({...it,tags:['new'],x:0,y:0}))});
  assert.deepEqual(f.items.map(it=>[it.x,it.y]),positions,'Changed tags do not replace positions');
  f.focus({ids:[1]});const focus={...f.items[0].anchor};
  for(let n=880;n<980;n++)f.step({time:n*16.67});
  assert(Math.hypot(f.items[0].x-focus.x,f.items[0].y-focus.y)<1);
  const release={x:f.items[0].x,y:f.items[0].y};f.focus({});f.step({time:980*16.67});
  assert(Math.hypot(f.items[0].x-release.x,f.items[0].y-release.y)<2.21,'Release glides back into geography');
});
test('a panel displaces visual homes into nearby open water without moving the prints',()=>{
  const f=field([{tags:[],x:250,y:300,visual:{saturation:.5,brightness:.5}}]);
  const old={x:f.items[0].x,y:f.items[0].y};
  f.resize({width:1200,height:750,obstacles:[{x0:400,y0:200,x1:800,y1:550}],water:[{x0:0,y0:0,x1:1200,y1:190},{x0:0,y0:560,x1:1200,y1:750},{x0:0,y0:190,x1:390,y1:560},{x0:810,y0:190,x1:1200,y1:560}]});
  assert.deepEqual({x:f.items[0].x,y:f.items[0].y},old);
  const home=f.items[0].home;assert(!(home.x>400&&home.x<800&&home.y>200&&home.y<550));
});
