// The same physical controls work through actual activity handlers without touching native editing.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[],writes=[];page.on('pageerror',e=>problems.push(e.message));
  page.on('request',r=>{if(r.method()==='POST')writes.push({url:new URL(r.url()).pathname,body:r.postDataJSON()});});
  const bodyFocus=()=>page.evaluate(()=>{document.activeElement?.blur();});
  const api=(path,body)=>page.evaluate(async({path,body})=>api(path,body),{path,body});
  await page.goto(LINK);await page.click('[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await api('/api/stacks/auto',{});
  await page.goto(BASE+'/#duel?stage=open');await page.waitForFunction(()=>S.current?.type==='duel'&&!S.busy);
  // Arrows make choices. Former WASD keys are inert, and A only changes alignment.
  let start=writes.length;for(const key of ['w','s','d'])await page.keyboard.press(key);assert.equal(writes.length,start);
  const align=await page.evaluate(()=>S.align);await page.keyboard.press('a');assert.equal(await page.evaluate(()=>S.align),!align);assert.equal(writes.length,start);
  await page.keyboard.press('ArrowUp');await page.waitForFunction(()=>S.current?.type==='duel'&&!S.busy);
  assert.equal(writes.slice(start).filter(r=>r.url==='/api/vote')[0].body.outcome,'great');
  start=writes.length;await page.evaluate(()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',repeat:true,bubbles:true,cancelable:true})));
  await page.waitForTimeout(120);assert.equal(writes.length,start);
  start=writes.length;await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>S.current?.type==='duel'&&!S.busy);
  assert.equal(writes.slice(start).filter(r=>r.url==='/api/vote')[0].body.outcome,'meh');
  const filter=await page.evaluate(()=>S.filter);await page.keyboard.press('f');assert.equal(await page.evaluate(()=>S.filter),!filter);
  const crop=await page.evaluate(()=>S.crop);await page.keyboard.press('c');const cropNext=await page.evaluate(()=>S.crop);assert.notEqual(cropNext,crop);  // C cycles the crop modes
  await page.evaluate(()=>{const input=document.createElement('div');input.id='test-editor';input.contentEditable='true';document.body.append(input);input.focus();});
  start=writes.length;await page.keyboard.type('wasdzxcf');await page.keyboard.press('ArrowLeft');await page.keyboard.press('Space');
  assert.equal(writes.length,start);assert.equal(await page.evaluate(()=>S.filter),!filter);assert.equal(await page.evaluate(()=>S.crop),cropNext);
  await page.evaluate(()=>document.querySelector('#test-editor').remove());await bodyFocus();
  // An explicit photo focus makes X unambiguous, and the normal duel undo restores it.
  const target=await page.locator('#stage .side').first().getAttribute('data-photo');
  await page.locator('#stage .side').first().focus();start=writes.length;await page.keyboard.press('x');await page.waitForFunction(()=>S.current?.type==='duel'&&!S.busy);
  const toss=writes.slice(start).find(r=>r.url==='/api/vote');assert(toss&&/^toss_/.test(toss.body.outcome));
  await bodyFocus();await page.keyboard.press('z');await page.waitForFunction(()=>S.current?.type==='duel'&&!S.busy);
  assert(await page.locator(`#stage .side[data-photo="${target}"]`).count(),'Undo restores the tossed shot');
  await page.keyboard.press('Escape');await page.waitForSelector('#menu[open]');await bodyFocus();start=writes.length;
  await page.keyboard.press('a');await page.keyboard.press('x');await page.keyboard.press('Space');assert.equal(writes.length,start,'Pause owns its keys');
  await page.keyboard.press('Escape');await page.waitForSelector('#menu[open]',{state:'hidden'});
  // Twin skip rotates real fixture photos without saying same/different or editing the library.
  const ids=await api('/api/draw/board?per=100&uper=100');
  const photos=[...new Set([...ids.groups.flatMap(g=>g.shots.map(s=>s.rep)),...ids.unsorted.shots.map(s=>s.rep)])].slice(0,4);
  assert.equal(photos.length,4);
  const pairs=[{a:photos[0],b:photos[1],similarity:.9},{a:photos[2],b:photos[3],similarity:.9}];
  await page.route('**/api/groups?view=suggest',r=>r.fulfill({json:{suggestions:pairs,counts:{suggest:2}}}));
  await page.goto(BASE+'/#stacks?check=1');await page.waitForSelector('.twin-arena');start=writes.length;
  await page.keyboard.press('Space');assert.equal(await page.locator('.twin-arena .side').first().getAttribute('data-photo'),String(photos[2]));assert.equal(writes.length,start);
  await page.keyboard.press('Space');assert.equal(await page.locator('.twin-arena .side').first().getAttribute('data-photo'),String(photos[0]));
  await page.waitForTimeout(700);await page.screenshot({path:OUT+'/GK-twins-desktop.png'});
  // Tag calls retain native typing, support arrows, and skip without creating a tag edit.
  const tags=await api('/api/tags?all=1');const tag=tags.tags.find(t=>t.count>2);assert(tag);
  await page.goto(BASE+'/#tags?play='+encodeURIComponent(tag.key));await page.waitForSelector('#tag-call img');
  const photo=()=>page.locator('#tag-call img').getAttribute('src');const first=await photo();start=writes.length;
  await page.keyboard.press('Space');assert.notEqual(await photo(),first);assert.equal(writes.length,start);
  start=writes.length;await page.keyboard.press('ArrowLeft');await page.waitForTimeout(400);
  assert(writes.slice(start).some(r=>r.url==='/api/tags/set'&&r.body.off.includes(tag.key)));
  await page.keyboard.press('z');await page.waitForTimeout(250);
  // Bracket deferral advances only to another available match and never creates a result.
  await page.goto(BASE+'/#finals');await page.waitForSelector('#journey-next.ready');await page.click('#journey-next');await page.waitForSelector('#f-arena');
  const before=await api('/api/finals');const wins=before.finals.matches.filter(m=>m.winner).length;start=writes.length;
  await page.keyboard.press('Space');await page.waitForTimeout(400);
  const after=await api('/api/finals');assert.equal(after.finals.matches.filter(m=>m.winner).length,wins);assert.notEqual(after.card.match,before.card.match);
  assert(writes.slice(start).some(r=>r.url==='/api/vote'&&r.body.outcome==='skip'));
  await page.screenshot({path:OUT+'/GK-finals-desktop.png'});
  await page.locator('#f-arena .side').first().focus();await page.keyboard.press('x');await page.waitForTimeout(800);await page.waitForSelector('#journey-next.ready,#f-arena');
  await bodyFocus();await page.keyboard.press('z');await page.waitForSelector('#f-arena');
  const restored=await api('/api/finals');assert.deepEqual(restored.finals.seeds,after.finals.seeds,'X then Z restores the same bracket field');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);await page.screenshot({path:OUT+'/GK-finals-phone.png'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(problems,[]);console.log(JSON.stringify({controls:'Arrows, Space, Z, X, A, C, F',problems}));await browser.close();
})().catch(e=>{console.error(e.stack);process.exit(1);});
