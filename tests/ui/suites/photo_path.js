// Copy the focused original, including non-cover takes; stale requests cannot act on another screen.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {resolve}=require('node:path');
const {LINK,OUT}=process.env;
let page;const problems=[],result={};
(async()=>{
  const browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.addInitScript(()=>{
    window.pathCopies=[];window.rejectPathCopy=false;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
      if(window.rejectPathCopy)throw new DOMException('Clipboard denied by this test','NotAllowedError');
      window.pathCopies.push(text);
    }}});
  });
  page.on('pageerror',e=>problems.push(e.message));
  const api=(path,body)=>page.evaluate(([path,body])=>api(path,body),[path,body]);
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');
  await page.fill('#path',process.env.LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const stacks=await api('/api/groups?view=stacks&per=120&page=0');
  const stack=stacks.shots.find(x=>x.members.length>1);assert(stack,'The public sample contains a multi-take stack');
  const take=stack.members.find(id=>id!==stack.rep);result.stack={rep:stack.rep,take};
  const original=await api(`/api/photo/${take}`);assert.equal(original.photo,take);
  assert.equal(original.original_path,resolve(process.env.LIB,original.rel),'Focused metadata points to the original public fixture, never a derived preview');
  const synthetic=id=>`/public fixture only/Trips & portraits/été 日本語/Take ${id} — original (1).jpg`;
  const requests=[];
  await page.route(/\/api\/photo\/\d+$/,async route=>{
    const id=Number(new URL(route.request().url()).pathname.split('/').at(-1));requests.push(id);
    const response=await route.fetch(),data=await response.json();
    await route.fulfill({response,json:{...data,original_path:synthetic(id)}});
  });
  const copyButton=root=>root.getByRole('button',{name:/copy.*path/i});
  // Prints deliberately wobble. Use a real pointer hit instead of waiting for animation to stop forever.
  const clickPrint=async(locator,button='left')=>{await locator.evaluate(el=>el.scrollIntoView({block:'nearest'}));const r=await locator.boundingBox();await page.mouse.click(r.x+r.width/2,r.y+r.height/3,{button});};
  // The button rides on a wobbling print: hover pauses the wobble, then a real pointer hit lands on it.
  const copied=async(button,id)=>{
    const before=await page.evaluate(()=>pathCopies.length);
    const r=await button.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.waitForTimeout(120);
    const hit=await button.boundingBox();await page.mouse.click(hit.x+hit.width/2,hit.y+hit.height/2);await page.waitForFunction(n=>pathCopies.length===n+1,before);
    const path=await page.evaluate(()=>pathCopies.at(-1));assert.equal(path,synthetic(id),'Clipboard receives the exact original path, including spaces and Unicode');
    assert(!path.includes('/img/'),'A thumbnail or preview URL is never copied');return path;
  };
  await page.evaluate(()=>location.hash='#stacks');await page.waitForSelector('.stacker');
  await page.locator(`[data-expand="${stack.rep}"]`).click();await page.waitForSelector('.tile.open .photo-fan');
  const takeCard=page.locator(`.tile.open [data-drag-frame="${take}"]`);
  await copied(copyButton(takeCard),take);
  assert.equal(await page.locator('.tile.open').getAttribute('data-drag-shot'),String(stack.rep),'Copying a non-cover path never changes the kept take');
  await page.screenshot({path:OUT+'/P-path-stack-desktop.png'});

  await clickPrint(takeCard.locator(`img[data-view="${take}"]`));await page.waitForSelector('#modal[open] .viewer');
  await copied(copyButton(page.locator('#modal')),take);
  assert(await page.locator('#modal').evaluate(el=>el.open),'Copy remains inside the open viewer');
  await page.screenshot({path:OUT+'/P-path-viewer-desktop.png'});
  await page.keyboard.press('Escape');await page.waitForSelector('#modal[open]',{state:'hidden'});

  await clickPrint(takeCard.locator(`img[data-view="${take}"]`),'right');await page.waitForSelector('#modal[open] .viewer');
  assert.equal(await page.locator('#modal [data-copy-path]').getAttribute('data-copy-path'),String(take),'Right-click keeps the original take identity');
  const beforeClose=await page.evaluate(()=>{rejectPathCopy=true;return pathCopies.length;});
  let releaseClosed;const closedLookup=new Promise(done=>{releaseClosed=done;});
  await page.route(/\/api\/photo\/\d+$/,async route=>{
    const response=await route.fetch(),data=await response.json();await closedLookup;
    await route.fulfill({response,json:{...data,original_path:synthetic(data.photo)}});
  },{times:1});
  const closingLookup=page.waitForRequest(r=>/\/api\/photo\/\d+$/.test(new URL(r.url()).pathname));
  await copyButton(page.locator('#modal')).click();await closingLookup;await page.click('#close-modal');
  const closedReply=page.waitForResponse(r=>/\/api\/photo\/\d+$/.test(new URL(r.url()).pathname));releaseClosed();await closedReply;await page.waitForTimeout(120);
  assert.equal(await page.evaluate(()=>pathCopies.length),beforeClose);
  assert.equal(await page.locator('#photo-path-dialog').count(),0,'Closing a still-connected viewer cancels the pending fallback');
  await page.evaluate(()=>rejectPathCopy=false);

  await page.evaluate(()=>location.hash='#home');await page.waitForSelector('.journey');
  await page.waitForFunction(id=>!!World.sea.items.get(id),stack.rep);
  await page.evaluate(id=>World.inspect(id),stack.rep);await page.waitForSelector('.inspect.open');
  await copied(copyButton(page.locator('.inspect')),stack.rep);
  await page.keyboard.press('Escape');await page.waitForSelector('.inspect',{state:'hidden'});

  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>location.hash='#filter');await page.waitForSelector('.filter-shot');
  const focused=Number(await page.locator('.filter-shot').getAttribute('data-photo'));
  await copied(copyButton(page.locator('.filter-stage')),focused);
  const phoneButton=await copyButton(page.locator('.filter-stage')).boundingBox();
  assert(phoneButton&&phoneButton.x>=0&&phoneButton.x+phoneButton.width<=390&&phoneButton.height>=44,'Phone path action stays visible and touch-sized');
  await page.screenshot({path:OUT+'/P-path-filter-phone.png'});
  const beforeReject=await page.evaluate(()=>{rejectPathCopy=true;return pathCopies.length;});
  const rejected=await copyButton(page.locator('.filter-stage')).boundingBox();await page.mouse.move(rejected.x+rejected.width/2,rejected.y+rejected.height/2);await page.waitForTimeout(120);
  const rejectHit=await copyButton(page.locator('.filter-stage')).boundingBox();await page.mouse.click(rejectHit.x+rejectHit.width/2,rejectHit.y+rejectHit.height/2);await page.waitForSelector('#photo-path-dialog[open]');
  const fallback=await page.locator('#photo-path-dialog textarea').evaluate(el=>({value:el.value,readonly:el.readOnly,start:el.selectionStart,end:el.selectionEnd,active:document.activeElement===el}));
  assert.equal(fallback.value,synthetic(focused));assert(fallback.readonly&&fallback.active);
  assert.equal(fallback.start,0);assert.equal(fallback.end,fallback.value.length,'The complete original path is selected for manual copying');
  assert.equal(await page.evaluate(()=>pathCopies.length),beforeReject,'A denied clipboard write does not report success');
  assert(await page.locator('#photo-path-dialog').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),'Fallback fits the phone viewport');
  await page.screenshot({path:OUT+'/P-path-fallback-phone.png'});
  await page.click('[data-close-path]');await page.waitForSelector('#photo-path-dialog',{state:'detached'});
  assert(await copyButton(page.locator('.filter-stage')).evaluate(el=>document.activeElement===el),'Closing the fallback returns focus to Copy path');
  await page.evaluate(()=>rejectPathCopy=false);

  // A path resolved for a previous route must not write to the clipboard or reopen an overlay.
  const beforeLeaving=await page.evaluate(()=>pathCopies.length);
  let releasePath;const waitingPath=new Promise(done=>{releasePath=done;});
  await page.route(/\/api\/photo\/\d+$/,async route=>{
    const response=await route.fetch(),data=await response.json();await waitingPath;
    await route.fulfill({response,json:{...data,original_path:synthetic(data.photo)}});
  },{times:1});
  const lookingUp=page.waitForRequest(r=>/\/api\/photo\/\d+$/.test(new URL(r.url()).pathname));
  await copyButton(page.locator('.filter-stage')).click();await lookingUp;
  await page.evaluate(()=>location.hash='#home');await page.waitForSelector('.journey');
  const lateReply=page.waitForResponse(r=>/\/api\/photo\/\d+$/.test(new URL(r.url()).pathname));releasePath();await lateReply;await page.waitForTimeout(120);
  assert.equal(await page.evaluate(()=>pathCopies.length),beforeLeaving,'Leaving during lookup cancels the clipboard action');
  assert.equal(await page.locator('dialog[open]').count(),0,'A stale lookup cannot open its fallback on the map');
  result.requests=requests;result.copies=await page.evaluate(()=>pathCopies);

  assert.deepEqual(problems,[]);console.log(JSON.stringify({...result,problems}));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page){console.error(JSON.stringify({route:new URL(page.url()).hash,problems}));await page.screenshot({path:OUT+'/P-path-failure.png'}).catch(()=>{});}process.exit(1);});
