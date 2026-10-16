// Tags are editable rosters; their correction game is finite and every call can be undone.
const {chromium}=require("playwright-core");
const assert=require("node:assert/strict");
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[];page.on("pageerror",e=>problems.push(e.message));
  await page.goto(LINK);await page.fill("#path",LIB);await page.click("#use-path");
  await page.waitForSelector("#an-go",{timeout:300000});await page.click("#an-go");
  await page.goto(BASE+"/#tags");await page.waitForSelector("#tag-new").catch(async(e)=>{
    console.error(JSON.stringify({url:page.url(),text:await page.locator('#main').innerText(),problems}));
    await page.screenshot({path:`${OUT}/T-fail.png`});throw e;
  });
  const settled=async()=>{await page.waitForTimeout(100);await page.waitForFunction(()=>!World.activeFlights?.size&&!World.arrivals?.size&&[...document.querySelectorAll('#main img[src^="/img/"]')].every(img=>img.complete&&img.naturalWidth&&getComputedStyle(img).opacity!=='0'));};
  const geometry=async selector=>page.locator(selector).first().evaluate(el=>{const img=el.querySelector('img'),box=el.getBoundingClientRect(),s=getComputedStyle(el),p=getComputedStyle(img);
    const win=el.querySelector('.window'),paper=el.querySelector('.paper'),w=win?.getBoundingClientRect(),c=paper?.getBoundingClientRect();
    return {width:parseFloat(s.width),height:parseFloat(s.height),ratio:parseFloat(s.width)/parseFloat(s.height),border:s.borderTopStyle,borderWidth:s.borderTopWidth,background:s.backgroundColor,padding:[p.paddingTop,p.paddingRight,p.paddingBottom,p.paddingLeft],image:[parseFloat(p.width),parseFloat(p.height)],fit:p.objectFit,position:p.objectPosition,window:w&&{left:(w.left-c.left)/c.width,top:(w.top-c.top)/c.height,width:w.width/c.width,height:w.height/c.height},box:{x:box.x,y:box.y,right:box.right,bottom:box.bottom},body:[document.documentElement.scrollWidth,innerWidth]};});
  const uniform=(card,label)=>{
    assert(Math.abs(card.ratio-.75)<.006,`${label}: one 3:4 card ${JSON.stringify(card)}`);
    if(card.window){
      for(const [key,value] of Object.entries({left:.055,top:.04125,width:.89,height:.83125}))assert(Math.abs(card.window[key]-value)<.003,`${label}: shared paper window ${JSON.stringify(card)}`);
    }else{
      assert.equal(card.fit,'contain',`${label}: the whole photo fits its window`);
      for(const [i,fraction] of [.055,.055,.17,.055].entries())assert(Math.abs(parseFloat(card.padding[i])/card.image[0]-fraction)<.002,`${label}: shared paper margins ${JSON.stringify(card)}`);
    }
    assert.equal(card.borderWidth,'0px',`${label}: no second frame around the photo`);
    assert(card.body[0]<=card.body[1],`${label}: no page overflow`);
  };
  const reachable=async selector=>assert(await page.locator(selector).first().evaluate(el=>{const r=el.getBoundingClientRect();return [[.25,.3],[.5,.5],[.75,.7]].every(([x,y])=>el.contains(document.elementFromPoint(r.left+r.width*x,r.top+r.height*y)));}),'The photo stays above the ambient sea');
  await page.waitForSelector('.tag-photos .polaroid[data-belt] img');await settled();
  const rosterDesktop=await geometry('.tag-photos .polaroid');uniform(rosterDesktop,'Desktop roster');await reachable('.tag-photos .polaroid');await page.screenshot({path:OUT+'/T-roster-desktop.png'});
  assert.equal(await page.locator('.tag-photos .tag-photo').first().evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
  // The shared card remains a drawing surface even though clicking its surrounding button opens the photo.
  const first=page.locator('.tag-photos .polaroid').first(),photo=Number(await first.getAttribute('data-belt'));
  const marks=await page.evaluate(id=>api(`/api/edit?photo=${id}`).then(r=>(r.edits.marks||[]).length),photo);
  await page.click('#toolbelt [data-tool="pen"]');
  const points=await first.locator(':scope > svg.marks').evaluate(svg=>[new DOMPoint(30,30),new DOMPoint(65,50)].map(p=>{const q=p.matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y};}));
  await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();await page.mouse.move(points[1].x,points[1].y,{steps:5});await page.mouse.up();await page.evaluate(()=>Toolbelt.flush());
  assert.equal(await page.evaluate(id=>api(`/api/edit?photo=${id}`).then(r=>(r.edits.marks||[]).length),photo),marks+1);
  assert.equal(await page.locator('.inspect').count(),0,'Drawing does not open the photo');
  const undone=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/draw/undo'&&r.request().method()==='POST');await page.keyboard.press('z');assert.equal((await undone).status(),200);
  await page.waitForFunction(({photo,marks})=>!HistoryHUD.checking&&(Toolbelt.current(photo).marks||[]).length===marks,{photo,marks});await page.click('#toolbelt [data-tool="hand"]');
  // Tag pop-ups live outside #main; their thumbnails still use the very same card renderer.
  const tagKey=await page.locator('#tag-list [data-tag]').first().getAttribute('data-tag');
  const pop=async()=>{await page.waitForFunction(key=>World.tagMeta?.has(key),tagKey);await page.evaluate(key=>World.tagMenu(key,document.querySelector('#tag-emoji')),tagKey);await page.waitForSelector('.sea-tag-photos .polaroid');await page.waitForFunction(()=>getComputedStyle(document.querySelector('.sea-tag-pop')).opacity==='1');};
  const closePop=async()=>{await page.locator('.sea-tag-pop input').focus();await page.keyboard.press('Escape');await page.waitForSelector('.sea-tag-pop',{state:'hidden'});};
  await pop();const popDesktop=await geometry('.sea-tag-photos .polaroid');uniform(popDesktop,'Desktop tag pop-up');
  assert.equal(await page.locator('.sea-tag-photos button').first().evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
  await page.screenshot({path:OUT+'/T-pop-desktop.png'});await closePop();
  await page.setViewportSize({width:390,height:844});await settled();
  const rosterPhone=await geometry('.tag-photos .polaroid');uniform(rosterPhone,'Phone roster');
  await page.locator('.tag-photos .polaroid').first().scrollIntoViewIfNeeded();await reachable('.tag-photos .polaroid');await page.screenshot({path:OUT+'/T-roster-phone.png'});
  await pop();const popPhone=await geometry('.sea-tag-photos .polaroid');uniform(popPhone,'Phone tag pop-up');await page.screenshot({path:OUT+'/T-pop-phone.png'});await closePop();
  await page.setViewportSize({width:1440,height:900});
  assert(await page.locator('#tag-new button').isDisabled(),'An empty tag cannot be created');
  assert.equal(await page.locator('.tag-photo-pick:visible').count(),0,'Browsing photos has no selection boxes');
  await page.fill('#tag-new input',"Meme material");
  await page.locator('[data-tag-pick]').first().check();
  await page.fill('#tag-new input',"Meme material");await page.click('#tag-new button');
  await page.waitForFunction(()=>document.querySelector('#tag-edit input')?.value==="Meme material");
  await page.fill('#tag-edit input',"Classic meme material");await page.click('#tag-edit button:not([type=button])');
  await page.waitForFunction(()=>document.querySelector('#tag-edit input')?.value==="Classic meme material");
  await page.click('#tag-play');await page.waitForSelector('#tag-call .print .window img');
  await settled();const checkDesktop=await geometry('#tag-call .print');uniform(checkDesktop,'Desktop tag check');await reachable('#tag-call .print');await page.screenshot({path:OUT+'/T-check-desktop.png'});
  await page.setViewportSize({width:390,height:844});await settled();
  const checkPhone=await geometry('#tag-call .print');uniform(checkPhone,'Phone tag check');await reachable('#tag-call .print');await page.screenshot({path:OUT+'/T-check-phone.png'});
  await page.setViewportSize({width:1440,height:900});
  const key=await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('play'));
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('#tag-count')?.textContent.startsWith('1 of'));
  await page.keyboard.press('z');await page.waitForFunction(()=>document.querySelector('#tag-count')?.textContent.startsWith('0 of'));
  await page.keyboard.press('Escape');await page.click('#menu-leave');await page.waitForSelector('#tag-edit');
  await page.waitForTimeout(650);await page.screenshot({path:`${OUT}/T-tags.png`});
  const source=await page.locator('#tag-list .on[data-tag]').getAttribute('data-tag');
  const target=await page.evaluate(source=>[...document.querySelectorAll('#tag-list [data-tag]')].find(e=>e.dataset.tag!==source).dataset.tag,source);
  const targetName=await page.evaluate(async key=>(await api('/api/tags?all=1')).tags.find(t=>t.key===key).label,target);
  await page.fill('#tag-merge input',targetName.toUpperCase());
  const matches=await page.locator('#tag-merge [role=option]').allTextContents();
  assert(matches.length>0&&matches.every(t=>t.toLowerCase().includes(targetName.toLowerCase())),'Merge destinations are searched by their displayed names');
  await page.screenshot({path:OUT+'/T-merge-search.png'});
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.waitForFunction(async key=>!(await api('/api/tags?all=1')).tags.some(t=>t.key===key),source);
  await page.waitForSelector(`#tag-list .on[data-tag="${target}"]`);
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('z');await page.waitForSelector(`#tag-list [data-tag="${source}"]`);
  await page.locator(`#tag-list [data-tag="${source}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#tag-edit input')?.value==='Classic meme material');
  await page.click('#tag-delete');await page.waitForFunction(()=>!document.querySelector('#tag-edit input')?.value.includes('Classic meme'));
  await page.keyboard.press('z');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.tag-row')).some(e=>e.textContent.includes('Classic meme')));
  const nested=await page.locator('button button, button input').count();assert.equal(nested,0);assert.deepEqual(problems,[]);
  console.log(JSON.stringify({key,nested,rosterDesktop,rosterPhone,popDesktop,popPhone,checkDesktop,checkPhone,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
