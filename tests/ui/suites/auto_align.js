const {adjustment}=require('./notes-helpers.cjs');
// Alignment follows each picture through the atlas, sea and notes; A never makes a directional game choice.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {boot}=require('./stack-helpers.cjs');const {BASE,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),problems=[],writes=[];
  page.on('pageerror',e=>problems.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
  await boot(page);const pid=await page.evaluate(()=>[...World.sea.items.values()].find(it=>!it.take).id);
  // Geometry is deterministic here; the estimator itself is tested against tilted structural edges in Python.
  await page.route(`**/api/photo/${pid}/notes`,async r=>{const response=await r.fetch(),p=await response.json();return r.fulfill({response,json:{...p,auto_look:{...p.auto_look,straighten:-4,skew:null,composition:null,alignment:{degrees:-4,perimeter:2,agreement:.98}}}});});
  await page.evaluate(id=>{const r={...AutoLook.recipes.get(id),straighten:-4,skew:null,composition:null};AutoLook.recipes.set(id,r);World.photos.get(id).auto_look=r;for(const p of AutoLook.pages.values())p.variants.clear();AutoLook.repaint();World.sea.zoomToPrint(World.sea.items.get(id));},pid);
  await page.waitForSelector('.sea-photo-detail .photo-notes-tab');await page.waitForFunction(id=>World.sea.items.get(id).el.querySelector('.picture img')?.style.transform.includes('-4deg'),pid);
  const paper=await page.evaluate(id=>World.sea.items.get(id).el.querySelector('.paper').getBoundingClientRect().toJSON(),pid),start=writes.length;
  await page.keyboard.press('a');await page.waitForFunction(id=>!World.sea.items.get(id).el.querySelector('.window img').style.transform.includes('-4deg'),pid);
  assert.equal(writes.length,start,'Global alignment does not cast votes or save per-photo edits');
  await page.keyboard.press('a');await page.waitForFunction(id=>World.sea.items.get(id).el.querySelector('.window img').style.transform.includes('-4deg'),pid);
  const after=await page.evaluate(id=>World.sea.items.get(id).el.querySelector('.paper').getBoundingClientRect().toJSON(),pid);assert(Math.abs(paper.width-after.width)<1&&Math.abs(paper.height-after.height)<1,'Only the picture turns');
  await page.locator('.sea-photo-detail .photo-notes-tab').click();await page.waitForSelector('.photo-note-sheet:not(.notes-opening)');await page.click('[data-notes-page=look]');
  await page.evaluate(()=>PhotoNotes.edit({straighten:0}));assert.equal(await page.locator('[name=straighten]').inputValue(),'0');
  const stopped=()=>page.evaluate(id=>!World.sea.items.get(id).el.querySelector('.window img').style.transform.includes('-4deg'),pid);
  assert(await stopped());await page.evaluate(()=>toggleAlign());await page.evaluate(()=>toggleAlign());assert(await stopped(),'Manual zero takes priority');
  await adjustment(page,'alignment');await page.locator('[data-align-reset]').click();await page.waitForFunction(id=>World.sea.items.get(id).el.querySelector('.window img').style.transform.includes('-4deg'),pid);
  await page.screenshot({path:OUT+'/auto-align-notes.png'});
  await page.keyboard.press('Escape');await page.evaluate(()=>api('/api/stacks/auto',{}));await page.goto(BASE+'/#duel?stage=open');await page.waitForFunction(()=>S.current?.type==='duel'&&!S.busy);
  const before=writes.length;await page.keyboard.press('a');for(const key of ['w','s','d'])await page.keyboard.press(key);assert.equal(writes.length,before);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({pid,paper,after,problems}));await browser.close();
})().catch(e=>{console.error(e.stack);process.exit(1);});
