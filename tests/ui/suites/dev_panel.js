// Debug mode: the developer panel stays on every screen, its knobs tune the sea live, and Export hands the
// session back as JSON.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,BASE,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK+'&debug=1');
  await page.evaluate(()=>localStorage.setItem('matcher-sea-tuning',JSON.stringify({version:4,tuning:{margin:.08,homeRate:.004}})));
  await page.reload();await page.click('#sample');await page.waitForSelector('#an-go',{timeout:300000});
  assert(await page.locator('#dev-panel').isVisible(),'The panel shows during analysis too');
  await page.click('#an-go');await page.waitForSelector('.journey');await page.waitForFunction(()=>World.sea?.bodies?.length>0);
  assert(await page.locator('#dev-panel .dev-row[data-key=spread]').isVisible());
  const margins={marginTop:.18,marginRight:.12,marginBottom:.03,marginLeft:0};
  for(const [key,value] of Object.entries(margins)){
    const input=page.locator(`#dev-panel .dev-row[data-key=${key}] .dev-num`);
    assert.equal(Number(await input.inputValue()),.08,'An older tuning supplies all four inherited values');
    await input.fill(String(value));await input.dispatchEvent('change');
  }
  await page.waitForFunction(()=>World.sea.bounds().margins.top===.18&&World.sea.bounds().margins.left===0);
  assert.deepEqual(await page.evaluate(()=>World.sea.bounds().margins),{top:.18,right:.12,bottom:.03,left:0});
  assert.equal(await page.evaluate(()=>World.sea.tuning.homeRate),.004,'Other saved tuning stays intact');
  // A knob reaches the worker and the renderer at once, and survives a reload in this browser.
  await page.locator('#dev-panel .dev-row[data-key=sizeShare] .dev-num').fill('0.5');await page.locator('#dev-panel .dev-row[data-key=sizeShare] .dev-num').dispatchEvent('change');
  await page.waitForFunction(()=>World.sea.tuning.sizeShare===.5);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('matcher-sea-tuning')).tuning.sizeShare);assert.equal(saved,.5);
  await page.reload();await page.waitForSelector('.journey');await page.waitForFunction(()=>World.sea?.tuning?.sizeShare===.5);
  assert(await page.locator('#dev-panel').isVisible(),'Debug mode is remembered');
  assert.deepEqual(await page.evaluate(()=>Object.fromEntries(['marginTop','marginRight','marginBottom','marginLeft'].map(k=>[k,World.sea.tuning[k]]))),margins);
  // Export: the JSON names what changed and carries every value.
  const [download,payload]=await Promise.all([page.waitForEvent('download'),page.evaluate(()=>DevPanel.export())]);
  assert.equal(payload.changed.sizeShare,.5);for(const [key,value] of Object.entries(margins))assert.equal(payload.changed[key],value);
  assert(Object.keys(payload.tuning).length>20);assert(/matcher-sea-tuning-.*\.json$/.test(download.suggestedFilename()));
  await page.screenshot({path:OUT+'/DEV-panel.png'});
  await page.click('#dev-panel .dev-row[data-key=marginTop] .dev-reset');
  assert.equal(await page.evaluate(()=>World.sea.tuning.marginTop),null);
  assert.equal(Number(await page.locator('#dev-panel .dev-row[data-key=marginTop] .dev-num').inputValue()),.08);
  assert.equal(await page.evaluate(()=>World.sea.tuning.marginRight),.12,'Resetting one edge leaves the others alone');
  await page.locator('#dev-panel .dev-row[data-key=margin] .dev-num').fill('.1');
  await page.locator('#dev-panel .dev-row[data-key=margin] .dev-num').dispatchEvent('change');
  assert.equal(Number(await page.locator('#dev-panel .dev-row[data-key=marginTop] .dev-num').inputValue()),.1,'Inherited controls follow the shared value live');
  assert.equal(Number(await page.locator('#dev-panel .dev-row[data-key=marginRight] .dev-num').inputValue()),.12,'Explicit controls retain their value');
  // Reset returns the defaults; the panel survives every route and can collapse out of the way.
  await page.click('#dev-panel [data-dev=reset]');await page.waitForFunction(()=>World.sea.tuning.sizeShare===seaTuningDefaults().sizeShare);
  assert.deepEqual(await page.evaluate(()=>World.sea.bounds().margins),{top:.04,right:.04,bottom:.04,left:.04});
  await page.evaluate(()=>location.hash='#stacks');await page.waitForSelector('.stacker');assert(await page.locator('#dev-panel').isVisible());
  await page.click('#dev-panel .dev-toggle');assert(await page.locator('#dev-panel').evaluate(el=>el.classList.contains('collapsed')));
  // debug=0 forgets it.
  await page.goto(BASE+'/?debug=0');await page.waitForSelector('.journey');assert.equal(await page.locator('#dev-panel').count(),0);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({changed:payload.changed,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
