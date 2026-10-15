// Crown releases the editor's tag focus and keeps the playable prints above the living sea.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {LINK,OUT}=process.env;
let page;const problems=[],result={};
(async()=>{
  const browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:2048,height:1152}});
  page.on('pageerror',e=>problems.push(e.message));
  const api=(path,body)=>page.evaluate(([path,body])=>api(path,body),[path,body]);
  const ready=()=>page.waitForFunction(()=>{
    const imgs=[...document.querySelectorAll('#stage.mini-stage .side .window > img')];
    return !S.busy&&S.current?.type==='mini'&&imgs.length===2&&imgs.every(i=>i.complete&&i.naturalWidth&&+getComputedStyle(i).opacity>.99)&&!World.flights?.size;
  },null,{timeout:20000});
  await page.goto(LINK);await page.click('#sample');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size===13&&!World.loading);
  const photos=(await api('/api/filter?per=200')).photos;
  await api('/api/filter/decision',{photos:photos.map(p=>p.id),action:'keep'});
  const family=photos.filter(p=>p.rel.startsWith('burst/')||p.rel==='ducreux-mocking.jpg').map(p=>p.id);
  assert.equal(family.length,5);
  await api('/api/groups/merge',{photos:family});await api('/api/draw/auto',{});
  await page.evaluate(()=>location.hash='#draw');await page.waitForSelector('.sorter');
  if(!await page.locator('.sorter.sea-view').count())await page.click('[data-mode=sea]');
  await page.waitForFunction(()=>World.sea?.catalog&&World.sea.circles.size>0&&!World.loading);
  const tag=await page.evaluate(ids=>{
    return [...World.sea.circles.keys()].find(key=>[...World.sea.items.values()].filter(it=>!it.take&&it.tags.includes(key)&&!ids.includes(it.id)).length>=2);
  },family);
  assert(tag,'A real sample tag must focus unrelated paintings before the Crown transition');
  await page.locator(`[data-tag="${tag}"]`).click();
  await page.waitForFunction(()=>World.sea.focusKeys.size>0&&[...World.sea.items.values()].some(it=>it.focused));
  result.focusBefore=await page.evaluate(()=>({keys:[...World.sea.focusKeys],photos:[...World.sea.items.values()].filter(it=>it.focused).map(it=>it.id)}));
  if(await page.locator('#game-help').getAttribute('aria-pressed')==='true')await page.click('#game-help');
  await page.evaluate(id=>location.hash=`#duel?stack=${id}`,family[0]);await ready();

  const inspect=async(label)=>{
    await page.mouse.move(8,200);await ready();
    const state=await page.evaluate(()=>{
      const visible=e=>!!e&&!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const rect=e=>e?.getBoundingClientRect().toJSON();
      return {viewport:{width:innerWidth,height:innerHeight},world:rect(World.sea.el),obstacles:World.sea.obstacles||[],
        focus:[...World.sea.focusKeys],cluster:World.sea.focusCluster,focused:[...World.sea.items.values()].filter(it=>it.focused).map(it=>it.id),
        header:visible(document.querySelector('.duel-head')),tray:visible(World.sea.tray),tagDock:!!document.querySelector('#view-duel.tag-dock'),hasFocus:World.sea.el.classList.contains('has-focus'),mini:rect(document.querySelector('.mini-bar')),
        title:rect(document.querySelector('#journey-title')),titleText:document.querySelector('#journey-title').textContent,
        controls:[...document.querySelectorAll('#controls [data-o]')].filter(visible).map(e=>({o:e.dataset.o,text:e.innerText.trim(),rect:rect(e)})),
        hints:[...document.querySelectorAll('#controls kbd')].filter(visible).map(e=>e.textContent),
        images:[...document.querySelectorAll('#stage .side .window > img')].map(rect),
        badges:[...document.querySelectorAll('#stage .side')].map(e=>{
          // The role is written on the card's chin: inside the paper, below the window.
          const paper=e.querySelector('.paper').getBoundingClientRect(),win=e.querySelector('.window').getBoundingClientRect();
          return {role:rect(e.querySelector('.role')),paper:rect(e.querySelector('.paper')),windowBottom:win.bottom,chin:{left:paper.left,right:paper.right,top:win.bottom,bottom:paper.bottom}};
        }),
        scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
        worldZ:+getComputedStyle(World.sea.el).zIndex,titleZ:+getComputedStyle(document.querySelector('#journey-dock')).zIndex};
    });
    result[label]=state;
    assert.equal(state.titleText,'Crown');assert.equal(state.header,false,'The HUD already supplies Crown’s only title');
    assert.equal(state.tray,false,'A duel does not carry the editor’s tag shelf');
    assert.equal(state.tagDock,false);assert.equal(state.hasFocus,false);
    assert.deepEqual(state.focus,[]);assert(!state.cluster);assert.deepEqual(state.focused,[],'Unrelated tag matches shrink back into the ambient sea');
    assert.deepEqual(state.obstacles,[],'The HUD and duel cards stay ethereal to sea motion');
    assert.equal(state.world.x,0);assert.equal(state.world.y,0);assert.equal(state.world.width,state.viewport.width);assert.equal(state.world.height,state.viewport.height);
    assert(state.titleZ>state.worldZ,'Sea thumbnails cannot paint over the shared stage title');
    assert.deepEqual(state.controls.map(c=>c.o).sort(),['a','b','skip']);assert.deepEqual(state.hints,[]);
    assert(state.controls.every(c=>c.rect.width>=44&&c.rect.height>=44&&c.rect.x>=0&&c.rect.right<=state.viewport.width&&c.rect.bottom<=state.viewport.height));
    assert(state.scroll<=state.viewport.width+1,'No sideways page scrolling');
    assert(state.images.every(r=>r.width>100&&r.height>130&&r.top>=state.title.bottom&&r.bottom<=Math.min(...state.controls.map(c=>c.rect.top))+4),'Both playable photos have usable space between the HUD and controls');
    assert(state.badges.every(({role,chin})=>role&&role.left>=chin.left-2&&role.right<=chin.right+2&&role.top>=chin.top-2&&role.bottom<=chin.bottom+2),'Role badges are written on the card\'s chin, whatever the take\'s shape');
    assert(!state.mini||state.mini.width<=Math.min(460,state.viewport.width-24),'Round progress is compact rather than a full-width panel');
    const forced=await page.evaluate(()=>{
      const sea=World.sea,side=document.querySelector('#stage .side'),r=side.querySelector('.print').getBoundingClientRect();
      const ambient=[...sea.items.values()].find(it=>!it.take&&!it.el.classList.contains('lifted')&&it.el.isConnected);
      if(!ambient)return null;
      const before={x:ambient.x,y:ambient.y,size:ambient.size};
      ambient.x=r.left+r.width/2;ambient.y=r.top+r.height/2;ambient.size=150;sea.paintItem(ambient,true);
      const photoRect=ambient.el.getBoundingClientRect(),hit=document.elementFromPoint(ambient.x,ambient.y);
      const value={photo:ambient.id,rect:photoRect.toJSON(),target:hit?.closest('#stage .side')===side};
      Object.assign(ambient,before);sea.paintItem(ambient,true);return value;
    });
    assert(forced?.target,'A sea print placed directly beneath a contender cannot intercept that choice');
    result[label].forcedOverlap=forced;
    // Observe actual moving frames: a one-time z-index or final-position check misses the screenshot’s obstruction.
    const hits=await page.evaluate(()=>new Promise(resolve=>{
      const start=performance.now(),misses=[];let frames=0;
      const tick=()=>{
        frames++;
        for(const side of document.querySelectorAll('#stage .side')){
          const r=side.querySelector('.print').getBoundingClientRect();
          for(const u of [.25,.5,.75])for(const v of [.25,.5,.75]){
            const hit=document.elementFromPoint(r.left+r.width*u,r.top+r.height*v);
            if(hit?.closest('#stage .side')!==side)misses.push({photo:side.dataset.photo,hit:hit?.className});
          }
        }
        if(performance.now()-start<1800)requestAnimationFrame(tick);else resolve({frames,misses});
      };requestAnimationFrame(tick);
    }));
    assert(hits.frames>10);assert.deepEqual(hits.misses,[],'Ambient photos must never intercept a choice while the sea moves');
    result[label].hitFrames=hits.frames;await page.screenshot({path:`${OUT}/C-crown-${label}.png`});
  };
  await inspect('desktop');
  const initial=await page.evaluate(()=>({...S.current,history:DuelSides.state().history.length}));
  const defenderSide=initial.a===initial.champ?'a':'b';
  const skip=page.waitForResponse(r=>r.url().endsWith('/api/vote')&&r.request().method()==='POST');
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Space');assert.equal((await(await skip).json()).skipped,true);await ready();
  assert.equal(await page.evaluate(()=>DuelSides.state().history.length),initial.history,'Skip defers without inventing a winner');
  assert.equal(await page.evaluate(side=>S.current[side],defenderSide),initial.champ,'The defender holds its side through a skip');
  const first=await page.evaluate(()=>({...S.current,history:DuelSides.state().history.length}));
  const vote=page.waitForResponse(r=>r.url().endsWith('/api/vote')&&r.request().method()==='POST');
  const right=await page.locator('#stage .side[data-side=b] .window > img').boundingBox();await page.mouse.click(right.x+right.width/2,right.y+right.height/2);
  const voted=await(await vote).json();assert.equal(voted.mini.winner,first.b);await ready();
  assert.equal(await page.evaluate(()=>S.current.b),first.b,'The clicked right-side winner continues on the right');
  assert.notEqual(await page.locator('#journey-next').getAttribute('aria-disabled'),'true','Forward re-enables after the saved vote');
  await page.keyboard.press('z');await ready();
  assert.deepEqual(await page.evaluate(()=>[S.current.a,S.current.b]),[first.a,first.b],'Undo restores the original displayed pair');
  assert.notEqual(await page.locator('#journey-next').getAttribute('aria-disabled'),'true','Forward re-enables after Undo');
  result.play={first:[first.a,first.b],winner:voted.mini.winner,skipped:true,undone:true};
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(800);await inspect('phone');
  await page.reload();await ready();assert.equal(await page.locator('#game-help').getAttribute('aria-pressed'),'false');
  await inspect('phone-reload');
  const posts=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/vote'))posts.push(r.postDataJSON());});
  await page.locator('#controls [data-o=a]').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!location.hash.startsWith('#duel'));
  assert.deepEqual(posts,[],'Enter advances even when a choice button has focus; it must not cast that choice');
  await page.evaluate(()=>location.hash='#draw');await page.waitForSelector('.sorter');
  if(!await page.locator('.sorter.sea-view').count())await page.click('[data-mode=sea]');
  await page.waitForSelector('.sorter.sea-view');
  await page.waitForFunction(()=>World.sea.catalog&&!World.sea.tray.hidden&&World.sea.tray.getClientRects().length>0);
  result.returnedTags=await page.locator('.vn-catalog [data-tag]:visible').count();assert(result.returnedTags>0,'The tag shelf returns to its editor');
  const landscapes=photos.filter(p=>['great-wave.jpg','starry-night.jpg'].includes(p.rel)).map(p=>p.id);assert.equal(landscapes.length,2);
  await api('/api/groups/merge',{photos:landscapes});
  await page.setViewportSize({width:1440,height:900});await page.evaluate(id=>location.hash=`#duel?stack=${id}`,landscapes[0]);await ready();
  await inspect('landscape');assert(result.landscape.images.every(r=>r.width>r.height),'This comparison exercises real landscape letterboxing');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({...result,problems},null,1));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack,JSON.stringify({...result,problems}));if(page)await page.screenshot({path:OUT+'/C-crown-failure.png'}).catch(()=>{});process.exit(1);});
