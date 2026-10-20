// Composition is a saved viewpoint on the same photo: both perspective axes, undo, source-space crop and export.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),fs=require('node:fs');
const {boot}=require('./stack-helpers.cjs'),{adjustment}=require('./notes-helpers.cjs');
const {BASE,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),problems=[];
  let votes=0;page.on('pageerror',e=>problems.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/vote\b/.test(r.url()))votes++;});
  await boot(page);const pid=await page.evaluate(()=>[...World.sea.items.values()].find(it=>!it.take).photo);
  const png=execFileSync('../../.venv/bin/python',['-c','from PIL import Image;import numpy as np,sys;y,x=np.mgrid[:600,:800];a=np.stack((30+190*x/799,30+190*y/599,90+60*np.sin(x/100)*np.cos(y/90)),axis=2);Image.fromarray(a.astype("uint8")).save(sys.stdout.buffer,"PNG")']);
  const recipe=await page.evaluate(id=>({...AutoLook.recipes.get(id),version:4,straighten:-2,skew:{horizontal:.06,vertical:-.09},composition:{version:1,views:{
    natural:{straighten:-2,skew:{horizontal:.06,vertical:-.09},retained:.89,reasons:['Keep some of the scene’s depth']},
    upright:{straighten:-3,skew:{horizontal:.19,vertical:-.23},retained:.75,reasons:['Ease converging verticals','Balance horizontal perspective']},
    expressive:{straighten:5,skew:{horizontal:.02,vertical:.04},retained:.84,reasons:['Follow the scene’s diagonal rhythm']}}}}),pid);
  await page.route(new RegExp(`/img/[tp]/${pid}\\.jpg(?:\\?|$)`),r=>r.fulfill({contentType:'image/png',body:png}));
  await page.route(`**/api/photo/${pid}/notes`,async r=>{const response=await r.fetch(),p=await response.json();return r.fulfill({response,json:{...p,width:800,height:600,subject:null,auto_look:recipe}});});
  await page.evaluate(({pid,recipe})=>{AutoLook.know(pid,recipe);World.photos.get(pid).auto_look=recipe;World.photos.get(pid).dims=[800,600];openViewer(pid);},{pid,recipe});
  await page.waitForSelector('.viewer .photo-notes-tab');await page.click('.viewer .photo-notes-tab');await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');await page.click('[data-notes-page=look]');
  await adjustment(page,'alignment');
  const image=await page.locator('.viewer .window img').elementHandle(),paper=await page.locator('.viewer .paper').boundingBox();
  await page.click('[data-composition=upright]');
  const read=()=>page.evaluate(async id=>{await Toolbelt.flush();return (await api(`/api/edit?photo=${id}`)).edits;},pid);
  assert.equal((await read()).composition,'upright');assert.match(await page.locator('[data-composition-status]').innerText(),/converging verticals/);
  assert(await image.evaluate(img=>img===document.querySelector('.viewer .window img')&&img.style.transform.startsWith('matrix3d')));
  const horizontal=page.locator('[data-skew=horizontal]');await horizontal.focus();await horizontal.press('ArrowRight');
  await page.waitForFunction(()=>Toolbelt.current(PhotoNotes.active.pid).skew?.horizontal===.191);
  await page.click('[data-notes-undo]');await page.waitForFunction(()=>!Toolbelt.current(PhotoNotes.active.pid).skew);
  await page.click('[data-notes-redo]');await page.waitForFunction(()=>Toolbelt.current(PhotoNotes.active.pid).skew?.horizontal===.191);
  await page.click('[data-composition=expressive]');assert.equal((await read()).composition,'expressive');assert(!(await read()).skew);
  await page.click('[data-auto-skew]');assert.equal((await read()).auto_skew,false);
  assert(await image.evaluate(img=>!img.style.transform.startsWith('matrix3d')&&img.style.transform.includes('5deg')));
  await page.click('[data-auto-skew]');
  await page.screenshot({path:OUT+'/composition-notes-desktop.png'});
  const after=await page.locator('.viewer .paper').boundingBox();assert(Math.abs(paper.width-after.width)<1&&Math.abs(paper.height-after.height)<1,'The paper stays the same size through geometry choices');
  await page.locator('[data-notes-compare]').scrollIntoViewIfNeeded();const compare=await page.locator('[data-notes-compare]').boundingBox();
  await page.mouse.move(compare.x+compare.width/2,compare.y+compare.height/2);await page.mouse.down();
  assert(await image.evaluate(img=>!img.style.transform.startsWith('matrix3d')&&!img.style.transform.includes('5deg')));
  await page.mouse.up();assert(await image.evaluate(img=>img.style.transform.startsWith('matrix3d')));
  // Cropping on a projectively warped photo still saves a rectangle in the unwarped source.
  await page.evaluate(()=>PhotoNotes.edit({crop:'off',rotate:90,straighten:-3.25,skew:{horizontal:.2,vertical:-.3},enhance:false}));
  await page.click('[data-crop=custom]');await page.waitForFunction(()=>document.querySelector('.photo-crop-editor [type=submit]')?.disabled===false);
  const points=await page.locator('.crop-viewport').evaluate(el=>{
    const base=el.offsetParent.getBoundingClientRect(),w=parseFloat(el.style.width),h=parseFloat(el.style.height),m=new DOMMatrix(el.style.transform);
    return [[.15,.2],[.75,.8]].map(([x,y])=>{const p=m.transformPoint(new DOMPoint(x*w,y*h));return {x:base.left+parseFloat(el.style.left)+p.x/p.w,y:base.top+parseFloat(el.style.top)+p.y/p.w};});
  });
  await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();await page.mouse.move(points[1].x,points[1].y,{steps:12});await page.mouse.up();
  const box=await page.locator('[data-crop-param]').evaluateAll(fields=>fields.map(f=>Number(f.value)));
  assert(box.every((v,i)=>Math.abs(v-[15,20,60,60][i])<.5),`Perspective crop gestures use source coordinates: ${JSON.stringify(box)}`);
  await page.click('[data-preview-crop]');assert(await page.locator('.photo-crop-editor .window img').evaluate(img=>img.style.transform.startsWith('matrix3d')));
  await page.screenshot({path:OUT+'/composition-crop.png'});await page.locator('.photo-crop-editor [type=submit]').click();await page.waitForSelector('.photo-crop-editor',{state:'detached'});
  assert.deepEqual((await read()).skew,{horizontal:.2,vertical:-.3});assert.equal((await read()).straighten,-3.25);
  // Horizontal stays horizontal on screen after a quarter turn; only the corresponding source axis is saved.
  await horizontal.focus();await horizontal.press('ArrowRight');await read();
  assert.equal((await read()).skew.vertical,-.301);assert.equal((await read()).skew.horizontal,.2);
  const atlas=await page.evaluate(async({pid,png})=>{
    const c=document.createElement('canvas');c.width=800;c.height=16;const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();c.getContext('2d').drawImage(image,0,0,16,16);
    const sheet=new Image();sheet.src=c.toDataURL();await sheet.decode();const saved=World.sprites.get(pid),on=S.filter;S.filter=false;
    const painted=AutoLook.sheet(sheet,[{id:pid,dims:[800,600]}]),aspect=World.sprites.get(pid).aspect,
      values=[...painted.getContext('2d').getImageData(0,0,16,16).data];AutoLook.pages.delete(sheet);World.sprites.set(pid,saved);S.filter=on;return {aspect,values};
  },{pid,png:png.toString('base64')});
  assert(Math.abs(atlas.aspect-.75)<.001,'The tiny sprite keeps the same quarter turn and crop aspect');
  await page.evaluate(()=>PhotoNotes.edit({grade:{midtones:{hue:205,amount:.25}},masks:[{id:'proof-light',name:'Proof light',opacity:.6,feather:.2,adjust:{exposure:.35},strokes:[{mode:'paint',r:.13,p:[[.35,.5],[.65,.5]]}]}]}));
  const edits=await read();await page.click('.notes-close');await page.waitForSelector('.photo-note-sheet',{state:'detached'});
  await image.evaluate(async(img,id)=>{img.src=`/img/p/${id}.jpg?m=full`;await img.decode();},pid);
  await page.waitForFunction(()=>document.querySelector('.viewer .window img')?.classList.contains('photo-pixels'));
  await page.addStyleTag({content:'.viewer .paper{animation:none!important;rotate:none!important}.viewer .window img{image-rendering:auto!important}'});
  await page.locator('.viewer .window img').evaluate(img=>img.decode());
  const screenshot=await page.locator('.viewer .picture').screenshot({path:OUT+'/composition-preview-proof.png'});
  fs.writeFileSync(OUT+'/composition-source.png',png);
  const parity=JSON.parse(execFileSync('../../.venv/bin/python',['-c',
    'import sys,json,io;from PIL import Image;import numpy as np;sys.path.insert(0,"../..");from matcher import touchup;root=sys.argv[1];touchup.touch_up(root+"/composition-source.png",root+"/composition-export.jpg",json.loads(sys.argv[2]),quality=100);a=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB");b=Image.open(root+"/composition-export.jpg").resize(a.size,Image.Resampling.BICUBIC);xy=[(int(a.width*x),int(a.height*y)) for x in [.15,.3,.5,.7,.85] for y in [.15,.3,.5,.7,.85]];d=np.abs(np.array([a.getpixel(p) for p in xy],dtype=float)-np.array([b.getpixel(p) for p in xy]));print(json.dumps({"mean":float(d.mean()),"max":float(d.max()),"size":a.size}))',OUT,JSON.stringify(edits)],{input:screenshot}).toString());
  assert(parity.mean<4&&parity.max<14,`Live perspective and exported pixels agree: ${JSON.stringify(parity)}`);
  const atlasParity=JSON.parse(execFileSync('../../.venv/bin/python',['-c',
    'import sys,json;from PIL import Image;import numpy as np;sys.path.insert(0,"../..");from matcher import touchup;root=sys.argv[1];e=json.loads(sys.argv[2]);e.pop("grade",None);e.pop("masks",None);touchup.touch_up(root+"/composition-source.png",root+"/composition-atlas-export.jpg",e,quality=100);a=np.array(json.loads(sys.argv[3]),dtype=float).reshape(16,16,4)[:,:,:3];b=np.asarray(Image.open(root+"/composition-atlas-export.jpg").resize((16,16),Image.Resampling.BILINEAR));d=np.abs(a[2:-2,2:-2]-b[2:-2,2:-2]);print(json.dumps({"mean":float(d.mean()),"max":float(d.max())}))',OUT,JSON.stringify(edits),JSON.stringify(atlas.values)]).toString());
  assert(atlasParity.mean<4&&atlasParity.max<15,`The atlas uses the same viewpoint: ${JSON.stringify(atlasParity)}`);
  await page.click('.viewer .photo-notes-tab');await page.click('[data-notes-page=look]');await adjustment(page,'alignment');
  await page.setViewportSize({width:320,height:568});await horizontal.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>{const r=document.querySelector('.photo-note-sheet .notes-face').getBoundingClientRect();return r.left>=7&&r.right<=innerWidth-7;});
  await page.screenshot({path:OUT+'/composition-notes-phone.png'});
  assert(await page.locator('.notes-page:not([hidden])').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'The editing content fits beside the protruding paper leaves');
  for(const axis of ['horizontal','vertical']){const bounds=await page.locator(`[data-skew=${axis}]`).boundingBox();assert(bounds.height>=43.9,`A perspective slider has a 44px target: ${JSON.stringify({axis,bounds})}`);}
  assert.equal(votes,0);assert.deepEqual(problems,[]);console.log(JSON.stringify({pid,box,parity,atlasParity,votes,problems}));await browser.close();
})().catch(e=>{console.error(e.stack);process.exit(1);});
