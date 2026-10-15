// Debug mode: the developer panel stays on every screen, its knobs tune the sea live, and Export hands the
// session back as JSON.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,BASE,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK+'&debug=1');await page.click('#sample');await page.waitForSelector('#an-go',{timeout:300000});
  assert(await page.locator('#dev-panel').isVisible(),'The panel shows during analysis too');
  await page.click('#an-go');await page.waitForSelector('.journey');await page.waitForFunction(()=>World.sea?.bodies?.length>0);
  assert(await page.locator('#dev-panel .dev-row[data-key=spread]').isVisible());
  // A knob reaches the worker and the renderer at once, and survives a reload in this browser.
  await page.locator('#dev-panel .dev-row[data-key=sizeShare] .dev-num').fill('0.5');await page.locator('#dev-panel .dev-row[data-key=sizeShare] .dev-num').dispatchEvent('change');
  await page.waitForFunction(()=>World.sea.tuning.sizeShare===.5);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('matcher-sea-tuning')).tuning.sizeShare);assert.equal(saved,.5);
  await page.reload();await page.waitForSelector('.journey');await page.waitForFunction(()=>World.sea?.tuning?.sizeShare===.5);
  assert(await page.locator('#dev-panel').isVisible(),'Debug mode is remembered');
  // Export: the JSON names what changed and carries every value.
  const [download,payload]=await Promise.all([page.waitForEvent('download'),page.evaluate(()=>DevPanel.export())]);
  assert.equal(payload.changed.sizeShare,.5);assert(Object.keys(payload.tuning).length>20);assert(/matcher-sea-tuning-.*\.json$/.test(download.suggestedFilename()));
  await page.screenshot({path:OUT+'/DEV-panel.png'});
  // Reset returns the defaults; the panel survives every route and can collapse out of the way.
  await page.click('#dev-panel [data-dev=reset]');await page.waitForFunction(()=>World.sea.tuning.sizeShare===seaTuningDefaults().sizeShare);
  await page.evaluate(()=>location.hash='#stacks');await page.waitForSelector('.stacker');assert(await page.locator('#dev-panel').isVisible());
  await page.click('#dev-panel .dev-toggle');assert(await page.locator('#dev-panel').evaluate(el=>el.classList.contains('collapsed')));
  // debug=0 forgets it.
  await page.goto(BASE+'/?debug=0');await page.waitForSelector('.journey');assert.equal(await page.locator('#dev-panel').count(),0);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({changed:payload.changed,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
