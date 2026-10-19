// The paper controls stay readable and reachable around the sea at desktop and phone sizes.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}}),problems=[],views=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForFunction(()=>World.photos?.size&&!World.loading);
  await page.evaluate(async()=>{await api('/api/draw/auto',{});localStorage.setItem('matcher-groups-view','list');});
  const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===390?844:900});
    for(const [name,hash,selector]of [['map','home','.journey'],['groups','draw','.sorter'],['stacks','stacks','.stacker'],['leaderboard','shortlist','.screen.board'],['duel','duel?stage=open','#stage .side']]){
      await page.goto(`${BASE}/#${hash}`);await page.waitForSelector(selector);await page.waitForTimeout(700);
      const proof=await page.evaluate(()=>{
        const box=el=>el.getBoundingClientRect().toJSON(),shown=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&r.top<innerHeight&&r.bottom>0;},
          tools=[...document.querySelectorAll('#game-help,#toolbelt')].filter(shown).map(box),
          actions=[...document.querySelectorAll('#main .screen-bar :is(.btn,button),#main .controls button')].filter(shown).map(el=>({text:el.textContent.trim(),...box(el)})),
          bins=document.querySelector('#bins'),head=document.querySelector('.screen.board .screen-head'),readout=document.querySelector('.map-readout');
        return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,tools,actions,
          bins:bins?{width:bins.clientWidth,scroll:bins.scrollWidth}:null,head:head?{width:head.clientWidth,scroll:head.scrollWidth}:null,
          readout:readout?box(readout):null};
      });
      assert(!proof.overflow,`${width} ${name}: page overflow`);
      if(name!=='groups')assert(!await page.locator('#toast').evaluate(el=>el.classList.contains('show')),'Feedback from a previous screen cannot cover this one');
      if(width===390){
        for(const action of proof.actions){assert(action.left>=0&&action.right<=width+1,JSON.stringify({name,action}));for(const tool of proof.tools)assert(!overlap(action,tool),JSON.stringify({name,action,tool}));}
        if(proof.bins)assert(proof.bins.scroll<=proof.bins.width+1,`Groups stay on their paper: ${JSON.stringify(proof)}`);
        if(proof.head)assert(proof.head.scroll<=proof.head.width+1,'Leaderboard stats fit without horizontal scrolling');
        if(proof.readout)for(const tool of proof.tools)assert(!overlap(proof.readout,tool),'The folded toolbelt stays clear of the chart key');
      }
      if(name==='groups'){
        const next=page.locator('#bins [data-bin=new]');await next.scrollIntoViewIfNeeded();const box=await next.boundingBox();assert(box.x>=0&&box.x+box.width<=width+1,'New group fits inside the roster');
        await next.click();assert.match(await page.locator('#toast').textContent(),/Select some photos/);
      }
      if(name==='leaderboard')assert.match(await page.locator('#game-help-hint').textContent(),/browse your best/);
      views.push({name,...proof});await page.screenshot({path:`${OUT}/paper-${name}-${width}.png`});
    }
  }
  assert.deepEqual(problems,[]);console.log(JSON.stringify({views,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
