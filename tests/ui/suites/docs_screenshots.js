// Real documentation captures from the pinned photography showcase, in a throwaway save. No mocked photos or UI.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {BASE,LINK,LIB,OUT}=process.env;
const manifest=require('../fixtures/showcase.json');
const scenes=require('../fixtures/showcase-scenes.json');
let page;
(async()=>{
  assert.equal(manifest.photos.length,320,'Prepare the full showcase with tests/ui/setup.sh --showcase');
  assert(fs.readFileSync(path.join(LIB,'ATTRIBUTION.txt'),'utf8').startsWith('Photography by Carol M. Highsmith'),'Documentation only uses its public photography fixture');
  const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1600,height:1000}});await page.emulateMedia({reducedMotion:'reduce'});
  const problems=[],captures=[];page.on('pageerror',e=>problems.push(e.message));
  const visit=async route=>{await page.goto(BASE+'/'+route,{waitUntil:'domcontentloaded',timeout:60000});};
  await page.goto(LINK,{waitUntil:'domcontentloaded',timeout:60000});
  if(await page.locator('#path').count()){
    await page.click('[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  }else await page.evaluate(async lib=>{await api('/api/library',{path:lib,mode:'gallery'});await loadState();location.hash='analyze';route();},LIB);
  await page.waitForFunction(()=>document.querySelector('#an-go')||S.lib?.analyzed&&!S.lib.analyzing,null,{timeout:900000});
  if(await page.locator('#an-go').count())await page.click('#an-go');
  await visit('#home');
  await page.evaluate(()=>World.sync());
  const seaReady=async()=>{
    try{await page.waitForFunction(()=>World.photos?.size===320&&!World.loading&&World.sea.settled&&World.sprites?.size===320&&
      [...World.sprites.values()].every(s=>s.img instanceof HTMLCanvasElement||s.img.complete&&s.img.naturalWidth),null,{timeout:60000});}
    catch(error){const state=await page.evaluate(async()=>({lib:{analyzed:S.lib?.analyzed,analyzing:S.lib?.analyzing},mode:World.mode,total:World.total,photos:World.photos?.size,
      sprites:World.sprites?.size,loading:!!World.loading,stale:World.stale,settled:World.sea.settled,items:World.sea.items.size,paused:World.sea.paused,
      backend:(await api('/api/world?per=1')).total}));throw new Error(`${error.message}: ${JSON.stringify(state)}`);}
  };
  await seaReady();
  const catalog=await page.evaluate(()=>[...World.photos.values()].map(p=>({id:p.id,file:`${p.measurements.folder}/${p.measurements.filename}`,dims:p.dims,visual:p.visual,quality:p.measurements.quality})));
  const credits=new Map(manifest.photos.map(p=>[p.file,p]));
  assert(catalog.every(p=>credits.has(p.file)),'Every displayed photo must belong to the recorded collection');
  const featured=catalog.find(p=>p.file===scenes.featured);assert(featured,'The featured photograph belongs to the collection');
  const visibleImages=()=>[...document.images].filter(img=>{
    if(!img.src||getComputedStyle(img).visibility==='hidden')return false;
    const r=img.getBoundingClientRect();let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
    for(let el=img.parentElement;el&&el!==document.body;el=el.parentElement){
      const style=getComputedStyle(el),clip=el.getBoundingClientRect();
      if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,clip.left);right=Math.min(right,clip.right);}
      if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}
    }
    return right>left&&bottom>top;
  });
  const shot=async name=>{
    await page.evaluate(()=>document.fonts.ready);await page.mouse.move(1590,990);await page.waitForTimeout(1600);
    await page.waitForFunction(()=>![...World.sea.items.values()].some(it=>!it.density&&!it.hidden&&it.el.isConnected&&(it.imagePending||it.imageRequest)),null,{timeout:30000});
    const images=await page.evaluateHandle(visibleImages);
    await images.evaluate(list=>Promise.race([Promise.all(list.map(img=>img.decode())),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Visible photos did not decode')),30000))]));
    const broken=await images.evaluate(list=>list.filter(img=>!img.complete||!img.naturalWidth).length);await images.dispose();
    const state={...await page.evaluate(()=>({photos:World.photos?.size,prints:[...World.sea.items.values()].filter(it=>!it.take&&!it.hidden).length,
      zoom:World.sea.camera.zoom})),broken};
    assert.equal(state.photos,320);assert.equal(state.broken,0,`${name}: visible images must be decoded`);
    captures.push({name,...state});await page.screenshot({path:`${OUT}/docs-${name}.png`,animations:'disabled'});
  };
  await page.evaluate(async()=>{
    await api('/api/settings',{help:false});S.lib.settings.help=false;paintGameHelp();
    await api('/api/filter/decision',{photos:[...World.photos.keys()],action:'reset'});
  });
  // Crop, hand-made stacks and a favourite are ordinary edits to this disposable demonstration save.
  await page.evaluate(()=>{while(normCrop(S.crop)!=='height')toggleCrop();});
  await page.evaluate(id=>api('/api/edit',{photo:id,crop:'off'}),featured.id);
  await visit('#filter');await page.waitForSelector('.filter-spotlight .print');await seaReady();
  await page.evaluate(id=>World.sea.clickPrint(World.sea.items.get(id),new MouseEvent('click')),featured.id);
  await page.waitForFunction(id=>Number(document.querySelector('.filter-shot')?.dataset.photo)===id,featured.id);await shot('filter');
  await page.evaluate(async({stacks,catalog})=>{
    await api('/api/filter/decision',{photos:[...World.photos.keys()],action:'keep'});
    for(const files of stacks){
      const ids=files.map(file=>catalog.find(p=>p.file===file)?.id);if(ids.some(id=>!id))throw new Error('A showcase stack source is missing');
      const world=await api('/api/world?per=1000'),reps=new Set(ids.map(id=>world.photos.find(p=>p.id===id).rep));
      if(reps.size>1)await api('/api/groups/merge',{photos:ids});
    }
    const board=await api('/api/draw/board?per=1&uper=1');if(board.unsorted.count)await api('/api/draw/auto',{});
  },{stacks:scenes.stacks,catalog});
  await visit('#home');await seaReady();
  await page.evaluate(()=>World.sea.zoomAt(2,innerWidth*.64,innerHeight*.58));await page.waitForTimeout(1000);await shot('map');
  await page.evaluate(()=>World.sea.resetCamera());
  await page.click('#sea-layout');await page.waitForSelector('.sea-axis-dialog[open]');await shot('axes');await page.keyboard.press('Escape');
  await visit('#draw');await page.waitForSelector('.sorter.sea-view');await seaReady();await shot('groups-sea');
  await page.click('[data-mode=list]');await page.waitForSelector('.sorter:not(.sea-view) #sections');await shot('groups');
  await visit('#stacks');await page.waitForFunction(()=>World.sea.arrangement&&World.sea.settled);await seaReady();await shot('stacks');
  const stack=await page.evaluate(id=>World.photos.get(id).rep,catalog.find(p=>p.file===scenes.stacks[0][0]).id);
  assert(stack,'The real photo collection must have a stack to demonstrate');
  await page.evaluate(id=>World.openStack(id),stack);await page.waitForFunction(()=>World.sea.settled&&!World.sea.cameraGlide);await shot('stack-fan');
  const fan=await page.evaluate(()=>[...World.sea.items.values()].filter(it=>it.el.classList.contains('stack-fan-take')).map(it=>({id:it.id,take:it.take,under:[...it.el.querySelectorAll('.under')].map(el=>getComputedStyle(el).display)})));
  assert(fan.length>=2&&fan.every(it=>!it.take&&it.under.every(display=>display==='none')),'The fan opens real takes without duplicate underprints');
  await visit(`#duel?stack=${stack}`);await page.waitForSelector('#stage .side .print');
  await page.waitForFunction(()=>!World.flights?.size&&!S.busy);await shot('crown');
  const credit=credits.get(featured.file),title='A garden worth stopping for';
  await page.evaluate(async({id,title})=>{await api('/api/edit',{photo:id,title,description:'Keep the pink flowers in the foreground and the softer garden behind them. A little colour from the road.',crop:'off',enhance:true});await api('/api/pick',{photo:id,on:true});},{id:featured.id,title});
  await visit('#shortlist');await page.waitForSelector('.board-fit .print .photo-notes-tab');
  const position=await page.evaluate(async id=>{const d=await api('/api/shortlist');return [...d.items,...d.bubble].findIndex(it=>it.photo===id);},featured.id);
  assert(position>=0,'The featured favourite must be reachable on the leaderboard');
  for(let i=0;i<position;i++)await page.click('.board-arrow[data-step="1"]');
  await page.waitForFunction(id=>Number(document.querySelector('.board-fit .print')?.dataset.photo)===id,featured.id);await shot('leaderboard');
  await visit('#home');await seaReady();await page.evaluate(id=>openViewer(id,{notes:true}),featured.id);
  await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');await page.click('[data-notes-page=look]');
  await page.locator('[data-notes-panel=look]').evaluate(panel=>panel.scrollTop=0);await shot('notes');
  await page.setViewportSize({width:390,height:844});await visit('#home');await seaReady();await page.evaluate(id=>openViewer(id,{notes:true}),featured.id);
  await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');await page.click('[data-notes-page=look]');await page.locator('[data-notes-panel=look]').evaluate(panel=>panel.scrollTop=0);
  await shot('phone');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({photos:catalog.length,uniqueSources:credits.size,stack,featured:{...featured,title,source:credit.source},fan,captures,problems}));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page)await page.screenshot({path:OUT+'/docs-failure.png'}).catch(()=>{});process.exit(1);});
