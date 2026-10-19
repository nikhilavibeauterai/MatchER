// Photo palettes fill the sea, blend locally and undulate without revealing a separate background.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']}),runs=[],problems=[];
  for(const gpu of [1,0]){
    const page=await browser.newPage({viewport:{width:1100,height:760}});page.on('pageerror',e=>problems.push(e.message));
    await page.goto(LINK);await page.waitForFunction(()=>typeof VennSea==='function');
    const proof=await page.evaluate(gpu=>{
      const host=document.createElement('section');host.style.cssText='position:fixed;left:40px;top:80px;width:960px;height:600px;z-index:100000';document.body.append(host);
      host.insertAdjacentHTML('beforeend','<p style="position:absolute;left:20px;top:12px;color:#fff5e8;z-index:20">Photo colours fill the sea · drifting pockets, no separate background</p>');
      const sea=new VennSea(host,{calm:true,catalog:false});window.pigmentSea=sea;sea.ro.disconnect();sea.layout=()=>{};sea.worker.terminate();cancelAnimationFrame(sea.raf);sea.raf=0;sea.kick=()=>{};sea.scheduleCull=()=>{};
      Object.assign(sea,{width:960,height:600,s:60,settled:true,ready:true,paused:true,cameraOn:true,generation:1});Object.assign(sea.tuning,{gpu,wobbleDeg:0});sea.canvas.width=960;sea.canvas.height=600;
      const warm=[236,142,70],blue=[30,150,205],purple=[68,18,112],green=[26,150,62],sheet=(colour,dark=false)=>{
        const c=document.createElement('canvas');c.width=c.height=16;const x=c.getContext('2d');x.fillStyle=`rgb(${colour})`;x.fillRect(0,0,16,16);
        if(dark){x.fillStyle='#09080c';x.fillRect(0,0,6,16);x.fillStyle='#f0f0f0';x.fillRect(14,0,2,2);}return c;
      },sources=[sheet(warm),sheet(blue),sheet(purple,true),sheet(green)];
      // One group, with very different colours in different parts of the sea. Blue has the global majority.
      const bodies=[{id:1,x:170,y:230,density:false},{id:2,x:330,y:290},{id:3,x:395,y:210},
        {id:4,x:170,y:230,take:true,stack:1,pileLifted:true},{id:5,x:170,y:230,take:true,stack:1,pileLifted:true},
        {id:6,x:1300,y:260},{id:7,x:1400,y:340},{id:8,x:620,y:240,density:false},{id:9,x:740,y:340},{id:10,x:830,y:200}];
      sea.sprites=new Map();for(const b of bodies){const el=document.createElement('div');el.className='ps-item';el.dataset.id=b.id;const it={photo:b.id,stack:b.id,size:60,n:1,density:true,group:1,...b,el},img=sources[b.id<4?0:b.id<8?1:2];sea.items.set(it.id,it);sea.sprites.set(it.id,{img,x:0,y:0,aspect:1});
        if(!it.density){el.classList.add('framed-photo');el.innerHTML=`<div class="paper"><div class="window"><img class="pile-cover" src="${img.toDataURL()}" alt="Synthetic pigment proof"></div></div>`;sea.layer.append(el);sea.moving.push(it);sea.paintItem(it,true);framePhoto(el,{dims:[16,16]},{crop:'off',rotate:0,enhance:false});}}
      sea.bodies=bodies.filter(it=>!it.take);const tag=document.createElement('button');tag.textContent='One group, local colours';sea.tagRow.append(tag);sea.lassos.set('g1',{tag,kind:'group'});
      sea.contours=new Map([['g1',{key:'occupied',count:10,opacity:1,paths:[[[50,160],[885,160],[885,465],[50,465]],[[155,280],[355,280],[355,440],[155,440]]]}]]);
      sea.draw(960,600);sea.densityDirty=sea.spritesDirty=true;sea.drawDensity(960,600);
      const pixel=(x,y)=>[...sea.ctx.getImageData(x,y,1,1).data],colour=(x,y)=>{const f=sea.pigmentField,i=(Math.floor(y/600*f.h)*f.w+Math.floor(x/960*f.w))*4;return [...f.pixels.data.slice(i,i+4)];},
        a=pixel(100,350),b=pixel(575,350),raw=[colour(100,350),colour(575,350)],empty=pixel(255,400),corners=[[0,0],[959,0],[0,599],[959,599]].map(p=>pixel(...p)),
        raster=sea.contourRaster.current,field=sea.waterField.basis,votes=sea.pigmentField.votes,first=sea.lassos.get('g1').colour,
        palette=sea.cellPigments(sea.sprites.get(8)).palette,cover=sea.bodyPigments.get(1),z=[sea.canvas,sea.spriteCanvas||sea.densityCanvas,sea.layer].map(el=>+getComputedStyle(el).zIndex);
      let uploads=0,rebuilds=0;const build=SeaPigments.field;SeaPigments.field=function(...args){rebuilds++;return build.apply(this,args);};
      if(sea.gpu){const gl=sea.gpu.gl;for(const key of ['bufferData','texImage2D']){const fn=gl[key].bind(gl);gl[key]=(...args)=>{uploads++;return fn(...args);};}}
      const phases=[];for(const time of [9100,17800,29000,58000]){sea.waveTime=time;sea.densityDirty=true;sea.drawDensity(960,600);phases.push(pixel(575,350));}
      const reused=raster===sea.contourRaster.current&&field===sea.waterField.basis&&votes===sea.pigmentField.votes,waveRebuilds=rebuilds;
      Object.assign(sea.camera,{zoom:.5,tx:250,ty:150});sea.followCamera();const panCorners=[[0,0],[959,0],[0,599],[959,599]].map(p=>pixel(...p));
      clearTimeout(sea.contourTimer);sea.contourTimer=0;Object.assign(sea.camera,{zoom:1,tx:0,ty:0});const cameraRebuilds=rebuilds;
      // Recolour a visible photo without changing the group's leading colour. It must still update locally.
      sea.sprites.set(8,{img:sources[3],x:0,y:0,aspect:1});sea.refreshColours();sea.contourRaster.since=performance.now()-500;sea.paintWater();const changed=colour(575,350),leading=sea.lassos.get('g1').colour;
      sea.sprites.set(8,{img:sources[2],x:0,y:0,aspect:1});sea.refreshColours();
      sea.sprites.set(7,{img:sources[0],x:0,y:0,aspect:1});sea.refreshColours();const distant=colour(575,350);
      // A colour surface does not depend on groups having been assigned yet.
      sea.lassos.clear();for(const it of sea.items.values())it.group=null;sea.refreshColours();sea.contourRaster.since=performance.now()-500;sea.paintWater();const ungrouped=colour(575,350),fillsWithoutGroups=pixel(0,599);
      SeaPigments.field=build;
      return {first,leading,warm,blue,purple,green,palette,cover,a,b,raw,empty,corners,panCorners,phases,reused,waveRebuilds,cameraRebuilds,uploads,z,changed,distant,ungrouped,fillsWithoutGroups,gpu:!!sea.gpu};
    },gpu);
    assert.equal(proof.gpu,!!gpu);assert.deepEqual(proof.first,proof.blue);assert.deepEqual(proof.leading,proof.blue,'Updating a minority photo does not need to change group identity');
    assert.deepEqual(proof.palette[0].rgb,proof.purple,'Dark purple light survives surrounding shadows and tiny white highlights');
    assert.deepEqual(proof.cover[0].rgb,proof.warm);assert(proof.cover[0].weight>.79,'The visible cover outweighs tucked takes');
    for(const [pixel,expected]of [[proof.raw[0],proof.warm],[proof.raw[1],proof.purple],[proof.changed,proof.green],[proof.distant,proof.purple],[proof.ungrouped,proof.purple]]){
      assert(pixel.slice(0,3).every((n,i)=>Math.abs(n-expected[i])<3),JSON.stringify({pixel,expected,proof}));assert.equal(pixel[3],255);
    }
    assert([...proof.corners,...proof.panCorners,proof.empty,proof.fillsWithoutGroups].every(p=>p[3]===255),'Photo colours cover empty water and all viewport edges, even during camera movement');
    assert(proof.z[0]<proof.z[1]&&proof.z[1]<proof.z[2],'Colour stays below sprites and live paper');
    assert(proof.phases.some(p=>p.slice(0,3).some((n,i)=>n!==proof.b[i])),'Drifting foam undulates the actual colour surface');assert(proof.phases.every(p=>p[3]===255),'Foam never exposes a separate background');
    assert(proof.reused);assert.equal(proof.waveRebuilds,0);assert.equal(proof.cameraRebuilds,0,'Camera movement reprojects cached colour');assert.equal(proof.uploads,0,'Animating pigment and prints never uploads textures or instance buffers');
    await page.screenshot({path:`${OUT}/sea-splotches-${gpu?'gpu':'canvas'}.png`});runs.push(proof);await page.evaluate(()=>pigmentSea.destroy());await page.close();
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({runs,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
