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
  assert.equal(await page.locator('button input,button select,button button').count(),0);assert.deepEqual(edits,[],'Changing arrangement casts no votes or photo edits');assert.deepEqual(problems,[]);
  console.log(JSON.stringify({before,layout,phone,dated,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
