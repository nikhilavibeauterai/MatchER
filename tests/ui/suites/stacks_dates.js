// Date navigation indexes the whole collection but jumps directly to one page; scrolling keeps the date visible.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {LINK,LIB,BASE,OUT}=process.env,FIRST=180000;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[],requests=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const thumbnail=await page.evaluate(()=>T(World.photos.values().next().value.id));
  const pixels=await(await page.request.get(new URL(thumbnail,BASE).href)).body();
  await page.route(/\/img\/[tp]\/18\d+\.jpg(?:\?|$)/,r=>r.fulfill({contentType:'image/jpeg',body:pixels}));
  const rows=Array.from({length:720},(_,i)=>({rep:FIRST+i,members:[FIRST+i],taken:new Date(Date.UTC(2024,0,1+Math.floor(i/5))).toISOString(),crownable:false}));
  const dates=[];for(let i=0;i<rows.length;i+=5)dates.push({date:rows[i].taken.slice(0,10),photo:rows[i].rep,page:Math.floor(i/120),count:5});
  await page.route('**/api/groups?*',r=>{
    const q=new URL(r.request().url()).searchParams;if(q.get('view')==='suggest')return r.fulfill({json:{suggestions:[]}});
    requests.push({order:q.get('order'),page:q.get('page'),date:q.get('date')});
    const jump=dates.find(d=>d.date===q.get('date')),p=jump?.page??Number(q.get('page')||0);
    return r.fulfill({json:{shots:rows.slice(p*120,(p+1)*120),page:p,pages:6,total:720,boxes:{},undo:null,...(q.get('order')==='time'?{dates,jump}: {})}});
  });
  await page.goto(BASE+'/#stacks');await page.waitForSelector('[data-stack-order=time]');await page.click('[data-stack-order=time]');
  await page.waitForSelector('[data-date-jump]');await page.waitForSelector('.date-divider');
  assert.equal(await page.locator('[data-date-jump] option').count(),dates.length,'Every date is available before loading every photo');
  const last=dates.at(-1),before=requests.length;await page.selectOption('[data-date-jump]',last.date);
  await page.waitForSelector(`[data-drag-shot="${last.photo}"]`);await page.waitForTimeout(350);
  assert.equal(requests[before].date,last.date);assert(requests.length-before<=2,'A far date jump fetches its page directly');
  const desktop=await page.evaluate(()=>({date:document.querySelector('[data-date-jump]').value,cards:document.querySelectorAll('.stacker [data-drag-shot]').length,
    heading:[...document.querySelectorAll('.date-divider')].filter(e=>{const r=e.getBoundingClientRect(),b=e.closest('.screen-body').getBoundingClientRect();return r.bottom>b.top&&r.top<b.bottom;}).map(e=>e.dataset.date)}));
  assert.equal(desktop.date,last.date);assert(desktop.cards<=240);assert(desktop.heading.includes(last.date));
  await page.screenshot({path:OUT+'/K-dates-desktop.png'});
  await page.click('[data-date-step="-1"]');await page.waitForFunction(day=>document.querySelector('[data-date-jump]')?.value===day,dates.at(-2).date);
  const body=page.locator('.stacker .screen-body');await body.evaluate(e=>e.scrollTop=0);await page.waitForFunction(()=>document.querySelectorAll('.stacker [data-drag-shot]').length>120);
  assert(requests.some(r=>r.page==='4'&&!r.date),'Scrolling backward can load the previous page');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);
  const phone=await page.locator('.date-jump').evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert(phone.left>=0&&phone.right<=390&&!phone.overflow,JSON.stringify(phone));await page.screenshot({path:OUT+'/K-dates-phone.png'});
  assert(await page.locator('[data-date-jump]').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>140;}),'The actual date picker stays usable on the phone');
  await page.reload();await page.waitForSelector('[data-date-jump]');assert.equal(await page.locator('[data-stack-order=time]').getAttribute('class'),'seg-btn on','Date ordering persists');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({desktop,phone,requests,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
