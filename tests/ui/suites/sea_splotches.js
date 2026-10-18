// Group HSV averages come from all the pictures, stay under both renderers, and share their travelling crests.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']}),runs=[],problems=[];
  for(const gpu of [1,0]){
    const page=await browser.newPage({viewport:{width:1100,height:760}});page.on('pageerror',e=>problems.push(e.message));
    await page.goto(LINK);await page.waitForFunction(()=>typeof VennSea==='function');
    const proof=await page.evaluate(gpu=>{
      const host=document.createElement('section');host.style.cssText='position:fixed;left:40px;top:80px;width:960px;height:600px;z-index:100000;background:#f7f2e6';document.body.append(host);
      host.insertAdjacentHTML('beforeend','<p style="position:absolute;left:20px;top:12px;color:#2a241f;z-index:20">Shared crests · group pigments below every print</p>');
      const sea=new VennSea(host,{calm:true,catalog:false});window.pigmentSea=sea;sea.ro.disconnect();sea.layout=()=>{};sea.worker.terminate();cancelAnimationFrame(sea.raf);sea.raf=0;sea.kick=()=>{};sea.scheduleCull=()=>{};
      Object.assign(sea,{width:960,height:600,s:60,settled:true,ready:true,paused:true,cameraOn:true,generation:1});Object.assign(sea.tuning,{gpu,wobbleDeg:0});sea.canvas.width=960;sea.canvas.height=600;
      const warm=[236,142,70],blue=[30,150,205],pink=[220,65,115],sheet=colour=>{const c=document.createElement('canvas');c.width=c.height=16;const x=c.getContext('2d');x.fillStyle=`rgb(${colour})`;x.fillRect(0,0,16,16);return c;},sources=[sheet(warm),sheet(blue),sheet(pink)];
      const bodies=[{id:1,x:170,y:230,density:false},{id:2,x:330,y:290},{id:3,x:395,y:210},
        {id:4,x:170,y:230,take:true,stack:1,pileLifted:true},{id:5,x:170,y:230,take:true,stack:1,pileLifted:true},
        {id:6,x:1300,y:260},{id:7,x:1400,y:340},{id:8,x:620,y:240},{id:9,x:740,y:340},{id:10,x:830,y:200}];
      sea.sprites=new Map();for(const b of bodies){const el=document.createElement('div');el.className='ps-item';el.dataset.id=b.id;const it={photo:b.id,stack:b.id,size:60,n:1,density:true,group:b.id<8?1:2,...b,el},img=sources[b.id<4?0:b.id<8?1:2];sea.items.set(it.id,it);sea.sprites.set(it.id,{img,x:0,y:0,aspect:1});
        if(!it.density){el.classList.add('framed-photo');el.innerHTML=`<div class="paper"><div class="window"><img class="pile-cover" src="${img.toDataURL()}" alt="Synthetic pigment proof"></div></div>`;sea.layer.append(el);sea.moving.push(it);sea.paintItem(it,true);framePhoto(el,{dims:[16,16]},{crop:'off',rotate:0,enhance:false});}}
      sea.bodies=bodies.filter(it=>!it.take);for(const id of [1,2]){const tag=document.createElement('button');sea.tagRow.append(tag);sea.lassos.set(`g${id}`,{tag,kind:'group'});}
      sea.contours=new Map([['g1',{key:'left',count:7,opacity:1,paths:[[[50,160],[435,160],[435,450],[50,450]],[[155,240],[355,240],[355,440],[155,440]]]}],['g2',{key:'right',count:3,opacity:1,paths:[[[530,160],[885,160],[885,465],[530,465]]]}]]);
      sea.draw(960,600);sea.contourRaster.since=performance.now()-500;sea.draw(960,600);sea.densityDirty=sea.spritesDirty=true;sea.drawDensity(960,600);
      const pixel=(x,y)=>[...sea.ctx.getImageData(x,y,1,1).data],a=pixel(100,350),hole=pixel(255,340),b=pixel(575,350),raster=sea.contourRaster.current,field=sea.waterField.basis;
      const first=sea.lassos.get('g1').colour,second=sea.lassos.get('g2').colour,hsv=sea.lassos.get('g1').hsv,z=[sea.canvas,sea.spriteCanvas||sea.densityCanvas,sea.layer].map(el=>+getComputedStyle(el).zIndex);
      let uploads=0;if(sea.gpu){const gl=sea.gpu.gl;for(const key of ['bufferData','texImage2D']){const fn=gl[key].bind(gl);gl[key]=(...args)=>{uploads++;return fn(...args);};}}
      sea.waveTime=9100;sea.densityDirty=true;sea.drawDensity(960,600);const later=pixel(100,350),reused=raster===sea.contourRaster.current&&field===sea.waterField.basis;
      // More blue photos live off-screen and behind the warm stack; replacing one makes warm the majority.
      sea.sprites.set(7,{img:sources[0],x:0,y:0,aspect:1});sea.refreshColours();const changed=sea.lassos.get('g1').colour;
      sea.sprites.set(7,{img:sources[1],x:0,y:0,aspect:1});sea.refreshColours();sea.contourRaster.since=performance.now()-500;sea.paintWater();
      const savedItems=sea.items,savedSprites=sea.sprites,hsvCase=colours=>{
        sea.items=new Map(colours.map((_,i)=>[200+i,{id:200+i,photo:200+i,group:1}]));sea.sprites=new Map(colours.map((colour,i)=>[200+i,{img:sheet(colour),x:0,y:0}]));sea.groupColoursDirty=true;sea.colourGroups();const l=sea.lassos.get('g1');return {hsv:l.hsv,colour:l.colour};
      },cases={red:hsvCase([[240,0,24],[240,24,0]]),grey:hsvCase([[240,0,24],[128,128,128]]),mono:hsvCase([[64,64,64],[128,128,128]]),opposite:hsvCase([[240,0,0],[0,240,240]]),reversed:hsvCase([[0,240,240],[240,0,0]])};
      sea.items=savedItems;sea.sprites=savedSprites;sea.refreshColours();sea.contourRaster.since=performance.now()-500;sea.paintWater();
      return {first,second,hsv,cases,warm,blue,pink,a,hole,b,later,reused,uploads,z,changed,gpu:!!sea.gpu};
    },gpu);
    assert.equal(proof.gpu,!!gpu);assert.deepEqual(proof.first,[46,197,218],'Tucked and off-screen photos contribute to the circular HSV average');assert.deepEqual(proof.second,proof.pink);assert.deepEqual(proof.changed,[178,223,52],'Updated photo pigments invalidate the cached group colour');
    assert(Math.abs(proof.hsv[0]-.5210714782457262)<1e-8&&Math.abs(proof.hsv[1]-.7892576625524124)<1e-8&&Math.abs(proof.hsv[2]-.8560224089635854)<1e-8,'Hue, saturation and value match an independent HSV calculation');
    assert.deepEqual(proof.cases.red.colour,[240,0,0],'Reds on both sides of the hue seam average to red');assert.deepEqual(proof.cases.grey.colour,[184,92,101],'Grey changes saturation and value without inventing a hue');assert.deepEqual(proof.cases.mono.colour,[96,96,96],'Black-and-white groups stay neutral');assert.deepEqual(proof.cases.opposite,proof.cases.reversed,'Opposing hues resolve consistently regardless of photo order');
    for(const [pixel,colour]of [[proof.a,proof.first],[proof.b,proof.pink]]){assert(pixel[3]>15&&pixel[3]<220);assert(pixel.slice(0,3).every((n,i)=>Math.abs(n-colour[i])<4),JSON.stringify(proof));}
    assert(proof.hole[3]<3,'Empty water remains empty inside a group: '+JSON.stringify(proof));assert(proof.z[0]<proof.z[1]&&proof.z[1]<proof.z[2],'Pigment is below sprites and live paper');
    assert.notEqual(proof.a[3],proof.later[3],'The broad swell and crest ripples move through the pigment');assert(proof.reused,'Wave paints reuse the shore raster and spatial field');assert.equal(proof.uploads,0,'Animating pigment and prints never uploads textures or instance buffers');
    await page.screenshot({path:`${OUT}/sea-splotches-${gpu?'gpu':'canvas'}.png`});runs.push(proof);await page.evaluate(()=>pigmentSea.destroy());await page.close();
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({runs,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
