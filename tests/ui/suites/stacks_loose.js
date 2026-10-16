// Loose photos share the real Stacks overview and the same reversible drag-and-drop as a pile of takes.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.goto(BASE+'/#stacks');await page.waitForSelector('.stacker [data-drag-shot]');
  const before=await page.evaluate(()=>api('/api/groups?view=all&per=500'));
  const loose=before.shots.filter(x=>x.members.length===1),stack=before.shots.find(x=>x.members.length>1);assert(loose.length>=2&&stack);
  assert.equal(await page.locator('.stacker [data-drag-shot]').count(),before.total);
  assert.equal(await page.locator('[data-stacks-only]').getAttribute('aria-pressed'),'false');
  await page.screenshot({path:OUT+'/K-loose-desktop.png'});
  await page.click('[data-stacks-only]');await page.waitForFunction(()=>document.querySelector('[data-stacks-only]')?.getAttribute('aria-pressed')==='true'&&!document.querySelector('.stacker .tile:not(.stacked)'));
  await page.reload();await page.waitForSelector('[data-stacks-only][aria-pressed=true]');
  await page.click('[data-stacks-only]');await page.waitForFunction(n=>document.querySelectorAll('.stacker [data-drag-shot]').length===n,before.total);
  const merge=async(a,b,members)=>{
    await page.locator(`[data-drag-shot="${a}"]`).dragTo(page.locator(`[data-drag-shot="${b}"]`));
    await page.waitForFunction(n=>Number(document.querySelector('[data-stack-total]').textContent.replaceAll(',',''))===n,before.total-1);
    const after=await page.evaluate(()=>api('/api/groups?view=all&per=500'));
    const combined=after.shots.find(x=>x.members.includes(a));assert.deepEqual([...combined.members].sort((a,b)=>a-b),members.sort((a,b)=>a-b));
    await page.keyboard.press('z');await page.waitForFunction(n=>document.querySelectorAll('.stacker [data-drag-shot]').length===n,before.total);
    const undone=await page.evaluate(()=>api('/api/groups?view=all&per=500'));assert.deepEqual(undone.shots.map(x=>x.members),before.shots.map(x=>x.members));
  };
  await merge(loose[0].rep,stack.rep,[loose[0].rep,...stack.members]);
  await merge(loose[0].rep,loose[1].rep,[loose[0].rep,loose[1].rep]);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await page.screenshot({path:OUT+'/K-loose-phone.png'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(problems,[]);
  console.log(JSON.stringify({total:before.total,loose:loose.length,stacks:before.total-loose.length,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
