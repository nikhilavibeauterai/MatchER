// Reproducible documentation captures: only the public-domain test library, in a throwaway save.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
let page;
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.emulateMedia({reducedMotion:'reduce'});const problems=[];page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading&&World.sprites?.size);await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(async()=>{
    const photos=[...World.photos.values()];await api('/api/rescue',{ids:photos.map(p=>p.id),on:true});await api('/api/draw/auto',{});
    const wave=photos.find(p=>p.measurements?.filename==='great-wave.jpg');
    if(wave)await api('/api/edit',{photo:wave.id,title:'The Great Wave',description:'Hokusai’s wave: a favourite from the public-domain sample. Keep the cool blues and all that movement.',notes:[{x:72,y:104,text:'Keep the whole wave.',turn:2}]});
  });
  const shot=async name=>{await page.mouse.move(1420,990);await page.waitForTimeout(700);await page.screenshot({path:`${OUT}/docs-${name}.png`,animations:'disabled'});};
  await page.goto(BASE+'/#home');await page.waitForFunction(()=>World.photos?.size&&!World.loading&&World.sea.settled);await shot('map');
  await page.click('#sea-layout');await page.waitForSelector('.sea-axis-dialog[open]');await shot('axes');await page.keyboard.press('Escape');
  await page.goto(BASE+'/#stacks');await page.waitForSelector('.shot-select');await shot('stacks');
  await page.goto(BASE+'/#duel?stage=stacks');await page.waitForSelector('#stage .side .print');await shot('crown');
  await page.goto(BASE+'/#shortlist');await page.waitForSelector('.board-fit .print .photo-notes-tab');await shot('leaderboard');
  await page.click('.board-fit .photo-notes-tab');await page.waitForSelector('.photo-note-sheet:not(.notes-opening) .notes-nav');await page.click('[data-notes-page=look]');
  await page.locator('.notes-auto').scrollIntoViewIfNeeded();await shot('notes');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(700);await page.locator('.notes-auto').scrollIntoViewIfNeeded();await shot('phone');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({photos:await page.evaluate(()=>World.photos.size),problems}));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page)await page.screenshot({path:OUT+'/docs-failure.png'}).catch(()=>{});process.exit(1);});
