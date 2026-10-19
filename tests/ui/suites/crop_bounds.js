// Subject zoom may extend the image, but its dimmed pixels must stay in that comparison pane.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
let page;
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1000}});
  const problems=[],cases=[],phonePanels=[];let compositing;page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.click('.mode-card[data-mode="gallery"]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const stack=await page.evaluate(async()=>{
    localStorage.setItem('matcher-crop-gallery','best');S.crop='best';
    await api('/api/stacks/auto',{});
    const stack=(await api('/api/groups?view=stacks&per=100')).shots.find(x=>x.crownable);
    // The offline sample is small: leave enough independent shots to exercise an elimination round too.
    for(const photo of stack.members.filter(id=>id!==stack.rep).slice(0,2))await api('/api/groups/split',{photo});
    return stack.rep;
  });
  // Deterministic tight crops on public photos reproduce a wide cover crossing the neighbouring pane.
  await page.route('**/api/deal*',async route=>{
    const response=await route.fetch(),body=await response.json();
    for(const card of body.cards||[])for(const [pid,info]of Object.entries(card.photos||{})){
      info.dims=[2400,1400];info.box=[.45,.32,.10,.08];
      info.frames=Math.max(2,info.frames);if(info.members.length<2)info.members=[Number(pid),card.a===Number(pid)?card.b:card.a];
    }
    await route.fulfill({response,json:body});
  });
  await page.evaluate(()=>{
    window.cropFlights=[];const fly=World.fly;
    World.fly=function(src,from,target,options={}){
      const finish=options.finish;
      return fly.call(this,src,from,target,{...options,finish:(arrived,flight)=>{
        const to=typeof target==='function'?target():target;
        // Flights carry whole cards now (nothing is clipped or masked): every arrival must land on its live card.
        if(arrived&&to?.width){
          const rect=flight.img.getBoundingClientRect();
          cropFlights.push({error:Math.max(...['left','top','width','height'].map(k=>Math.abs(rect[k]-to[k])))});
        }
        finish?.(arrived,flight);
      }});
    };
  });
  const liveBounds=async(root)=>page.evaluate(root=>{
    const errors=[];let piles=0;
    for(const side of document.querySelectorAll(`${root} .side[data-photo]`)){
      const slot=side.closest('.slot'),r=slot.getBoundingClientRect(),points=[];
      for(const t of [.05,.25,.5,.75,.95])points.push([r.left-2,r.top+t*r.height],[r.right+2,r.top+t*r.height],
        [r.left+t*r.width,r.top-2],[r.left+t*r.width,r.bottom+2]);
      for(const protectedEl of document.querySelectorAll(`${root} .side[data-photo],#controls,#group-table,.duel-head`)){
        if(protectedEl===side)continue;const p=protectedEl.getBoundingClientRect();
        if(!p.width||!p.height)continue;
        for(const x of [p.left+2,p.left+p.width/2,p.right-2])for(const y of [p.top+2,p.top+p.height/2,p.bottom-2])
          if(x<r.left-1||x>r.right+1||y<r.top-1||y>r.bottom+1)points.push([x,y]);
      }
      for(const img of side.querySelectorAll('img')){
        // Decorative prints normally ignore the pointer; enable hit testing just for this clipping probe.
        const pointer=img.style.pointerEvents;img.style.pointerEvents='auto';
        if(img.classList.contains('pile-take'))piles++;
        for(const [x,y]of points)if(x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&document.elementsFromPoint(x,y).includes(img))
          errors.push({photo:side.dataset.photo,pile:img.classList.contains('pile-take'),x,y});
        img.style.pointerEvents=pointer;
      }
    }
    return {errors,piles};
  },root);
  const coverBacking=async()=>{
    const compare=async(a,b)=>page.evaluate(async sources=>{
      const images=await Promise.all(sources.map(async src=>{const img=new Image();img.src=src;await img.decode();return img;}));
      const canvas=document.createElement('canvas');canvas.width=images[0].width;canvas.height=images[0].height;
      const ctx=canvas.getContext('2d',{willReadFrequently:true}),pixels=images.map(img=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data;});
      let changed=0,max=0;for(let i=0;i<pixels[0].length;i+=4){let delta=0;for(let c=0;c<4;c++)delta=Math.max(delta,Math.abs(pixels[0][i+c]-pixels[1][i+c]));if(delta)changed++;max=Math.max(max,delta);}
      return {fraction:changed/(canvas.width*canvas.height),max};
    },[a,b].map(buffer=>`data:image/png;base64,${buffer.toString('base64')}`));
    await page.evaluate(async()=>Promise.all([...document.querySelectorAll('#stage .pile-take')].map(img=>img.decode())));
    const freeze=await page.addStyleTag({content:'#stage .slot,#stage .side{animation:none!important;transform:none!important;scale:1!important;transition:none!important}#stage .paper,#stage img{animation:none!important;rotate:none!important}#achvs,#toast{visibility:hidden!important}'});
    const clips=await page.evaluate(()=>{
      const side=document.querySelector('#stage .side.pile'),card=side.querySelector('.print > .paper'),slot=side.closest('.slot'),r=card.getBoundingClientRect(),s=slot.getBoundingClientRect();
      const clip=(r,inset)=>({x:Math.ceil(r.left+inset),y:Math.ceil(r.top+inset),width:Math.floor(r.width-2*inset-1),height:Math.floor(r.height-2*inset-1)});
      return {inner:clip(r,3),whole:clip(s,0)};
    });
    const beforeInner=await page.screenshot({clip:clips.inner}),beforeWhole=await page.screenshot({clip:clips.whole});
    const hide=await page.addStyleTag({content:'#stage .pile-take{visibility:hidden!important}'});
    const afterInner=await page.screenshot({clip:clips.inner}),afterWhole=await page.screenshot({clip:clips.whole});
    await hide.evaluate(el=>el.remove());await freeze.evaluate(el=>el.remove());
    const inner=await compare(beforeInner,afterInner);
    compositing={inner};
    // Rebuilding a compositor layer can alter one fractional raster column; broad photo blending cannot pass.
    if(inner.fraction>.005||inner.max>20){
      require('node:fs').writeFileSync(`${OUT}/crop-backing-before.png`,beforeInner);
      require('node:fs').writeFileSync(`${OUT}/crop-backing-after.png`,afterInner);
    }
    assert(inner.fraction<=.005&&inner.max<=20,`The cover's paper must not reveal the underlying takes: ${JSON.stringify(inner)}`);
    assert(!beforeWhole.equals(afterWhole),'Stacked photo edges must still be visible outside the cover');
  };
  const check=async(name,root='#stage')=>{
    await page.waitForSelector(`${root} .side[data-photo]`);
    await page.waitForTimeout(450);
    await page.waitForFunction(()=>!document.querySelector('.world-fly'),{},{timeout:5000});
    const data=await page.evaluate(root=>{
      const sides=[...document.querySelectorAll(`${root} .side[data-photo]`)];
      // Freeze the existing wobble for exact boundary probes; then restore it for the screenshot.
      const animated=[...document.querySelectorAll(`${root} .slot, ${root} .side`)];
      const old=animated.map(el=>({el,animation:el.style.animation,transform:el.style.transform}));
      animated.forEach(el=>{el.style.animation='none';el.style.transform='none';});
      const out=sides.map((side,i)=>{
        // The picture sits in its polaroid's window: a tight crop zooms it past the window, which clips it.
        const img=side.querySelector('img:not(.pile-take)'),r=side.getBoundingClientRect(),ir=img.getBoundingClientRect(),win=img.closest('.window'),wr=(win||side).getBoundingClientRect();
        const other=sides[1-i].getBoundingClientRect(),hits=[];
        for(const fx of [.25,.5,.75])for(const fy of [.25,.5,.75]){
          const x=other.left+other.width*fx,y=other.top+other.height*fy;
          if(document.elementsFromPoint(x,y).includes(img))hits.push([x,y]);
        }
        return {hits,clip:win?getComputedStyle(win).overflow:getComputedStyle(img).clipPath,visible:r.width>40&&r.height>40&&Number(getComputedStyle(img).opacity)>.95,
          overflow:ir.width>wr.width+4||ir.height>wr.height+4,
          pile:side.classList.contains('pile'),wobble:getComputedStyle(side).animationName};
      });
      old.forEach(({el,animation,transform})=>{el.style.animation=animation;el.style.transform=transform;});return out;
    },root);
    assert.equal(data.length,2);assert(data.every(x=>x.visible&&x.hits.length===0),`${name}: both photos must remain visible without covering another pane ${JSON.stringify(data)}`);
    if(root==='#stage')assert(data.every(x=>x.overflow&&x.clip==='hidden'),`${name}: tight crop must exercise image overflow and clipping`);
    if(['open','groups','knockouts'].some(x=>name.includes(x)))assert(data.every(x=>x.pile),`${name}: exercise the overflowing stack style`);
    await page.waitForTimeout(450);
    const live=[];
    for(const side of await page.locator(`${root} .side[data-photo]`).all()){
      const box=await side.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      for(const ms of [80,220,300]){await page.waitForTimeout(ms);const bounds=await liveBounds(root);
        assert.deepEqual(bounds.errors,[],`${name}: hovered cover/under-print crossed its reserved comparison space`);live.push(bounds);}
    }
    await page.mouse.move(2,2);await page.waitForTimeout(350);const idle=await liveBounds(root);
    assert.deepEqual(idle.errors,[],`${name}: wobbling cover/under-print crossed its reserved comparison space`);
    if(name==='groups-desktop'){await coverBacking();await page.waitForTimeout(450);}
    cases.push({name,data,live,idle});await page.screenshot({path:`${OUT}/crop-${name}.png`});
  };
  const visit=async(hash,name,root)=>{
    const previous=await page.evaluate(()=>S.current?.id);
    await page.evaluate(hash=>{location.hash=hash;},hash);
    await page.waitForFunction(id=>S.current&&S.current.id!==id,previous);await check(name,root);
  };
  const phoneTable=async()=>{
    const measure=async(open)=>{
      await page.waitForTimeout(200);
      const panel=await page.evaluate(()=>{
        const dock=document.querySelector('#journey-dock').getBoundingClientRect(),slots=[...document.querySelectorAll('#stage .slot')];
        const controls=[...document.querySelectorAll('#controls [data-o]')].filter(el=>el.getBoundingClientRect().height>0).map(el=>{
          const r=el.getBoundingClientRect();return {key:el.dataset.o,visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=dock.bottom-1&&r.bottom<=innerHeight+1};
        });
        return {heights:slots.map(el=>el.getBoundingClientRect().height),controls,
          rows:[...document.querySelectorAll('#group-table .gt-rows li')].filter(el=>el.getBoundingClientRect().height>0).length,
          expanded:document.querySelector('.gt-toggle').getAttribute('aria-expanded')==='true',
          overflow:document.documentElement.scrollWidth>innerWidth+1};
      });
      assert.equal(panel.expanded,open);assert.equal(panel.heights.length,2);
      assert(panel.heights.every(h=>h>=(open?90:150)),`Phone standings must leave useful comparison photos: ${JSON.stringify(panel)}`);
      assert.deepEqual(panel.controls.map(x=>x.key).sort(),['a','b','great','meh','skip']);
      assert(panel.controls.every(x=>x.visible),'All phone duel controls stay below the stage HUD and within the viewport');
      assert.equal(panel.overflow,false);assert.equal(panel.rows>0,open);phonePanels.push(panel);
    };
    await page.waitForSelector('.gt-toggle');await measure(false);
    await page.click('.gt-toggle');await measure(true);
    await page.evaluate(()=>renderTable(S.table));await measure(true);
    await page.screenshot({path:`${OUT}/crop-groups-phone-expanded.png`});
    await page.click('.gt-toggle');await measure(false);
  };
  await visit('#duel?stage=open','open-desktop');
  await page.evaluate(()=>api('/api/knockouts/start',{}));await visit('#duel?stage=knockouts','knockouts-desktop');
  await page.evaluate(async()=>{const shots=(await api('/api/groups?view=all&per=400')).shots;await api('/api/draw/new',{photos:shots.map(x=>x.rep)});});
  await visit('#duel?stage=groups','groups-desktop');
  await page.setViewportSize({width:390,height:844});await phoneTable();await check('groups-phone');
  await visit(`#duel?stack=${stack}`,'crown-phone');
  const crownPhone=await page.evaluate(()=>{
    const dock=document.querySelector('#journey-dock').getBoundingClientRect();
    return {heights:[...document.querySelectorAll('#stage .slot')].map(el=>el.getBoundingClientRect().height),
      controls:[...document.querySelectorAll('#controls [data-o]')].filter(el=>el.getBoundingClientRect().height>0).map(el=>{
        const r=el.getBoundingClientRect();return {key:el.dataset.o,visible:r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth+1&&r.top>=dock.bottom-1&&r.bottom<=innerHeight+1};
      }),round:document.querySelector('.mini-round').textContent,overflow:document.documentElement.scrollWidth>innerWidth+1};
  });
  assert(crownPhone.heights.length===2&&crownPhone.heights.every(h=>h>=150),`Phone Crown needs usable comparison photos: ${JSON.stringify(crownPhone)}`);
  assert.deepEqual(crownPhone.controls.map(x=>x.key).sort(),['a','b','skip']);
  assert(crownPhone.controls.every(x=>x.visible)&&!crownPhone.overflow,'Every Crown action remains within the phone play area');
  // Presentation tools remain available by keyboard after their redundant buttons leave the play area.
  const presentation=await page.evaluate(()=>{document.activeElement?.blur();return {crop:S.crop,filter:S.filter};});
  await page.keyboard.press('c');assert.notEqual(await page.evaluate(()=>S.crop),presentation.crop);  // C cycles best, focus subject, fill height, fill width, off
  for(let k=0;k<4;k++)await page.keyboard.press('c');assert.equal(await page.evaluate(()=>S.crop),presentation.crop);
  await page.keyboard.press('f');assert.equal(await page.evaluate(()=>S.filter),!presentation.filter);
  await page.keyboard.press('f');assert.equal(await page.evaluate(()=>S.filter),presentation.filter);
  await page.setViewportSize({width:1600,height:1000});await check('crown-desktop');
  await page.evaluate(()=>{location.hash='#finals';});await page.waitForSelector('#journey-next.ready');await page.click('#journey-next');
  await check('finals-desktop','#f-arena');await page.setViewportSize({width:390,height:844});await check('finals-phone','#f-arena');
  const finalsPhone=async(open)=>{
    // Let the new bracket DOM reach its first layout before measuring its reserved comparison space.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const state=await page.evaluate(()=>{
      const slots=[...document.querySelectorAll('#f-arena .slot')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};});
      const dock=document.querySelector('#journey-dock').getBoundingClientRect();
      const bracket=document.querySelector('#bracket').getBoundingClientRect(),heading=document.querySelector('#bracket h4').getBoundingClientRect();
      return {slots,expanded:document.querySelector('#f-bracket-toggle').getAttribute('aria-expanded')==='true',bracket:bracket.height,headingVisible:heading.top>=bracket.top&&heading.bottom<=bracket.bottom,heading:{top:heading.top,bottom:heading.bottom,containerTop:bracket.top,containerBottom:bracket.bottom},
        controls:[...document.querySelectorAll('[data-f],#f-reset,#f-bracket-toggle')].filter(el=>el.getBoundingClientRect().height>0).map(el=>{
          const r=el.getBoundingClientRect();return {key:el.dataset.f||el.id,rect:r.toJSON(),visible:r.height>=44&&r.left>=0&&r.right<=innerWidth+1&&r.top>=dock.bottom-1&&r.bottom<=innerHeight+1};
        })};
    });
    assert.equal(state.expanded,open);assert.equal(state.bracket>0,open);
    if(open)assert(state.headingVisible,`The expanded bracket starts at the round headings: ${JSON.stringify(state.heading)}`);
    assert(state.slots[1].top>=state.slots[0].bottom&&state.slots.every(s=>s.height>=(open?100:150)),`Finals keeps the same useful stacked comparison: ${JSON.stringify(state)}`);
    assert.deepEqual(state.controls.map(x=>x.key).sort(),['a','b','f-bracket-toggle',...(open?['f-reset']:[]),'skip']);
    assert(state.controls.every(x=>x.visible),`Finals actions have 44px targets below the stage HUD and within the viewport: ${JSON.stringify(state.controls)}`);return state;
  };
  const finalPanels=[await finalsPhone(false)];await page.click('#f-bracket-toggle');finalPanels.push(await finalsPhone(true));
  await page.evaluate(async()=>renderFinals(document.querySelector('#main'),await api('/api/finals')));finalPanels.push(await finalsPhone(true));
  await page.waitForTimeout(450);await page.waitForFunction(()=>!document.querySelector('.world-fly'));
  await page.screenshot({path:`${OUT}/crop-finals-phone-expanded.png`});await page.click('#f-bracket-toggle');await finalsPhone(false);
  const flights=await page.evaluate(()=>cropFlights);
  assert(flights.length>=2,'Observe actual photo arrivals');
  assert(flights.every(x=>x.error<2),`Flights must reach their live card without a final jump: ${JSON.stringify(flights)}`);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({cases,flights,phonePanels,crownPhone,finalPanels,compositing,problems}));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page)await page.screenshot({path:OUT+'/crop-fail.png'}).catch(()=>{});process.exit(1);});
