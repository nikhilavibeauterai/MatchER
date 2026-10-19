// Arrangement controls change only the sea; choices survive reload and remain usable on a phone.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[],edits=[];
  page.on('pageerror',e=>problems.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(vote|edit|draw|groups)\b/.test(new URL(r.url()).pathname))edits.push(r.url());});
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading);await page.waitForSelector('#sea-layout');
  await page.waitForFunction(()=>World.sea?.pigmentField?.canvas.width>0);
  assert.match(await page.locator('#sea-layout').textContent(),/Colourfulness.*Brightness/);
  const colourToggle=await page.evaluate(()=>{const sea=World.sea,field=sea.pigmentField;Sea.toggle();const off=sea.ctx.getImageData(0,0,1,1).data[3];Sea.toggle();Sea.scan();return{off,on:sea.ctx.getImageData(0,0,1,1).data[3],reused:field===sea.pigmentField,oldAnimation:!!Sea.raf,covered:Sea.hasWorldSurface()};});
  assert.deepEqual(colourToggle,{off:0,on:255,reused:true,oldAnimation:false,covered:true},'The shared colour switch controls the actual sea surface without running a hidden background');
  const before=await page.evaluate(()=>({count:World.photos.size,ids:[...World.sea.items.keys()],votes:S.progress?.votes||0}));
  await page.click('#sea-layout');await page.waitForSelector('.sea-axis-dialog[open]');
  assert.equal(await page.locator('[data-axis]').count(),2);
  assert.equal(await page.locator('[data-axis-reverse=y]').textContent(),'↑ bright · ↓ dark ⇄');
  for(const key of ['colorfulness','brightness','hue','saturation','date','quality','ranking','sharpness','aspect','faces'])assert(await page.locator(`#sea-axis-x option[value="${key}"]`).count());
  await page.selectOption('#sea-axis-x','date');await page.selectOption('#sea-axis-y','ranking');await page.click('[data-axis-reverse=x]');
  await page.waitForFunction(()=>document.querySelector('.sea-axis-status')?.textContent==='Saved with this library');
  assert.deepEqual(await page.evaluate(()=>S.lib.settings.sea_axes),{x:'date',y:'ranking',reverseX:true,reverseY:false});
  assert.deepEqual(await page.evaluate(()=>World.sea.axes),{x:'date',y:'ranking',reverseX:true,reverseY:false});
  assert.match(await page.locator('#sea-layout').textContent(),/Capture date.*Your ranking/);
  const layout=await page.locator('.sea-axis-dialog').boundingBox();assert(layout.x>=0&&layout.y>=0&&layout.x+layout.width<=1440&&layout.y+layout.height<=900);
  await page.screenshot({path:OUT+'/sea-axes-desktop.png'});await page.locator('[data-axis-close]').last().click();
  await page.reload();await page.waitForFunction(()=>World.photos?.size&&!World.loading);await page.waitForSelector('#sea-layout');
  assert.deepEqual(await page.evaluate(()=>World.sea.axes),{x:'date',y:'ranking',reverseX:true,reverseY:false},'Reload restores the library’s chosen axes');
  assert.equal(await page.evaluate(()=>World.photos.size),before.count);assert.deepEqual(await page.evaluate(()=>[...World.sea.items.keys()].sort((a,b)=>a-b)),[...before.ids].sort((a,b)=>a-b));
  await page.click('#open-menu');await page.click('[data-menu-page=view]');await page.click('[data-m=axes]');await page.waitForSelector('.sea-axis-dialog[open]');
  assert.equal(await page.locator('#menu[open]').count(),0);
  await page.setViewportSize({width:390,height:844});await page.selectOption('#sea-axis-y','hue');await page.click('[data-axis-reverse=y]');
  await page.waitForFunction(()=>document.querySelector('.sea-axis-status')?.textContent==='Saved with this library');
  const phone=await page.locator('.sea-axis-dialog').boundingBox();assert(phone.x>=0&&phone.x+phone.width<=390&&phone.y>=0&&phone.y+phone.height<=844);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:OUT+'/sea-axes-phone.png'});
  const dated=await page.evaluate(()=>[...World.photos.values()].filter(p=>Number.isFinite(p.measurements?.date)).length);
  if(dated){assert(await page.locator('.sea-axis-date').isVisible());await page.locator('.sea-axis-date button').click();await page.waitForFunction(()=>!!World.sea.cameraGlide||World.sea.camera.zoom>1);}
  else await page.keyboard.press('Escape');
  await page.evaluate(()=>World.sea.resetCamera());await page.click('#sea-layout');await page.click('[data-axis-reset]');
  await page.waitForFunction(()=>document.querySelector('.sea-axis-status')?.textContent==='Saved with this library');
  assert.deepEqual(await page.evaluate(()=>S.lib.settings.sea_axes),{x:'colorfulness',y:'brightness',reverseX:false,reverseY:false});
  await page.keyboard.press('Escape');assert.equal(await page.locator('.sea-axis-dialog[open]').count(),0);
  if(dated){
    await page.goto(BASE+'/#duel?stage=open');await page.waitForSelector('#stage .side');await page.click('#open-menu');await page.click('[data-menu-page=view]');await page.click('[data-m=axes]');
    await page.selectOption('#sea-axis-x','date');await page.waitForFunction(()=>document.querySelector('.sea-axis-status')?.textContent==='Saved with this library');
    await page.locator('.sea-axis-date button').click();await page.waitForSelector('.journey');await page.waitForFunction(()=>World.sea.camera.zoom>1);
    assert.equal(await page.locator('.inspect').count(),0,'A date jump returns to the sea and glides to the print');
  }
  // Hundreds of public-fixture prints cross through one another using the shipped calm tuning, then sleep
  // without leaving an inverted brightness order or intersecting papers behind.
  await page.setViewportSize({width:1440,height:900});await page.goto(BASE+'/#home');await page.waitForFunction(()=>World.photos?.size&&!World.loading&&World.sea?.bodies?.length);
  await page.evaluate(()=>World.sea.resetCamera());
  await page.click('#sea-layout');await page.click('[data-axis-reset]');await page.locator('[data-axis-close]').last().click();
  await page.mouse.move(20,15);
  await page.evaluate(async()=>{
    clearInterval(World.watch);const sea=World.sea,photos=[...World.photos.values()];sea.resetCamera();sea.hold(null);
    const sources=new Map();
    for(const p of photos){
      let source=sea.sprites?.get(p.id);
      if(!source||!source.img.complete){
        const img=new Image();img.src=T(p.id);await img.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=16;canvas.getContext('2d').drawImage(img,0,0,16,16);
        source={img:canvas,x:0,y:0,aspect:p.dims[0]/p.dims[1]};
      }sources.set(p.id,source);
    }
    const items=Array.from({length:600},(_,i)=>({id:80000+i,photo:photos[i%photos.length].id,dims:photos[i%photos.length].dims,n:1,tags:['photos'],
      visual:{colorfulness:((i*7127)%997)/997,brightness:((i*8761)%991)/991},measurements:{date:i*100}}));
    // Clone the public atlas cells as well as the metadata; invented database IDs have no server thumbnails.
    sea.sprites=new Map(items.map(it=>[it.id,sources.get(it.photo)]));
    sea.setVenn([],items);
    window.axisStats=()=>{
      const rows=[...sea.items.values()].filter(it=>!it.take).sort((a,b)=>a.visual.brightness-b.visual.brightness),mean=(rows,key)=>rows.reduce((n,it)=>n+it[key],0)/rows.length;
      let overlaps=0;for(let i=0;i<rows.length;i++)for(let j=0;j<i;j++){const a=rows[i],b=rows[j],edge=(a.size+b.size)/2;
        if(Math.abs(a.x-b.x)<edge-.1&&Math.abs(a.y-b.y)<edge*4/3-.1)overlaps++;
      }
      return {count:rows.length,overlaps,blank:sea.densityStats?.blank||0,palettes:sea.bodyPigments?.size||0,dark:mean(rows.slice(0,60),'y'),bright:mean(rows.slice(-60),'y'),
        oldest:mean(rows.filter(it=>it.measurements.date<6000),'x'),newest:mean(rows.filter(it=>it.measurements.date>=54000),'x'),width:sea.width,height:sea.height};
    };
  });
  await page.waitForFunction(()=>World.sea.bodies.length===600&&World.sea.settled,{},{timeout:30000});
  await page.click('#sea-layout');await page.click('[data-axis-reverse=y]');
  assert.equal(await page.locator('[data-axis-reverse=y]').textContent(),'↑ dark · ↓ bright ⇄');
  await page.locator('[data-axis-close]').last().click();await page.mouse.move(20,15);
  await page.waitForFunction(()=>World.sea.settled,{},{timeout:30000});
  const reversed=await page.evaluate(()=>axisStats());assert.equal(reversed.count,600);assert.equal(reversed.overlaps,0,JSON.stringify(reversed));
  assert.equal(reversed.blank,0);assert.equal(reversed.palettes,600,'Every fixture print has actual public-photo pixels and colours');
  assert(reversed.dark<reversed.height*.25&&reversed.bright>reversed.height*.75,JSON.stringify(reversed));
  await page.screenshot({path:OUT+'/sea-axes-reversed-600.png'});
  await page.click('#sea-layout');await page.click('[data-axis-reverse=y]');await page.selectOption('#sea-axis-x','date');
  await page.click('[data-axis-reverse=x]');await page.click('[data-axis-reverse=x]');
  await page.locator('[data-axis-close]').last().click();await page.mouse.move(20,15);
  await page.waitForFunction(()=>World.sea.settled,{},{timeout:30000});
  const rearranged=await page.evaluate(()=>axisStats());assert.equal(rearranged.overlaps,0,JSON.stringify(rearranged));
  assert(rearranged.bright<rearranged.height*.25&&rearranged.dark>rearranged.height*.75,JSON.stringify(rearranged));
  assert(rearranged.oldest<rearranged.width*.25&&rearranged.newest>rearranged.width*.75,JSON.stringify(rearranged));
  await page.screenshot({path:OUT+'/sea-axes-rearranged-600.png'});
  assert.equal(await page.locator('button input,button select,button button').count(),0);assert.deepEqual(edits,[],'Changing arrangement casts no votes or photo edits');assert.deepEqual(problems,[]);
  console.log(JSON.stringify({before,layout,phone,dated,reversed,rearranged,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
