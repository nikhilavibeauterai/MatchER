// A continuing winner stays put; the displayed key still votes for that photo on the real server.
const {chromium}=require('playwright-core');
const assert=require('node:assert/strict');
const {BASE,LINK,LIB,OUT}=process.env;
let page;
(async()=>{
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});
  const problems=[],rounds=[],modes=[];page.on('pageerror',e=>problems.push(e.message));
  const settled=selector=>page.waitForFunction(selector=>{
    const images=[...document.querySelectorAll(selector)];
    return images.length===2&&images.every(img=>img.complete&&img.naturalWidth&&Number(getComputedStyle(img).opacity)>.99)&&!document.querySelector('.world-fly');
  },selector,{timeout:15000});
  await page.goto(LINK);await page.click('.mode-card[data-mode="gallery"]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  const members=await page.evaluate(async()=>{
    await api('/api/stacks/auto',{});
    const shots=(await api('/api/groups?view=all&per=400')).shots;
    const ids=shots.filter(x=>x.members.length===1).slice(0,6).map(x=>x.rep);
    await api('/api/groups/merge',{photos:ids});return ids;
  });
  assert.equal(members.length,6,'Six distinct public fixture shots make a multi-round Crown');
  await page.goto(`${BASE}/#duel?stack=${members[0]}`);await page.waitForSelector('#stage.mini-stage');
  assert(!/keeps its crown/.test(await page.locator('.mini-bar').innerText()),'The old skip-as-victory helper is gone');
  const first=await page.evaluate(()=>({card:S.current,history:DuelSides.state().history.length}));
  const defenderSide=first.card.a===first.card.champ?'a':'b';
  const skipReply=page.waitForResponse(r=>r.url().endsWith('/api/vote')&&r.request().method()==='POST');
  await page.keyboard.press('Space');assert.equal((await (await skipReply).json()).skipped,true);
  await page.waitForFunction(id=>!S.busy&&S.current?.id!==id,first.card.id);
  assert.equal(await page.evaluate(side=>S.current[side],defenderSide),first.card.champ,'Deferring the first challenger keeps the original defender side');
  assert.equal(await page.evaluate(()=>DuelSides.state().history.length),first.history,'A deferral does not invent winner history');
  await page.reload();await page.waitForSelector('#stage.mini-stage');
  assert.equal(await page.evaluate(side=>S.current[side],defenderSide),first.card.champ,'The first defender keeps that side after reload');
  let last;
  for(let n=0;n<8;n++){
    const card=await page.evaluate(()=>S.current);if(!card||card.type!=='mini')break;
    assert(card.frames.every(p=>members.includes(p)));
    const outcome=n===0?'b':n===1?'skip':'a',winner=outcome==='skip'?card.champ:card[outcome];
    const side=card.a===winner?'a':'b';
    const reply=page.waitForResponse(r=>r.url().endsWith('/api/vote')&&r.request().method()==='POST');
    await page.keyboard.press(outcome==='skip'?'Space':outcome==='a'?'ArrowLeft':'ArrowRight');
    const response=await reply,result=await response.json();assert.equal(response.status(),200);if(outcome==='skip'){assert.equal(result.skipped,true);assert(!result.crowned);assert(!result.mini?.winner,'Skipping cannot claim a winner');}else assert.equal(result.mini.winner,winner);
    const sent=response.request().postDataJSON();assert.equal(sent.outcome,outcome==='skip'?'skip':card.wire.a===winner?'a':'b');
    await page.waitForFunction(id=>!S.busy&&S.current?.id!==id,card.id);
    const next=await page.evaluate(()=>S.current);
    if(next&&[next.a,next.b].includes(winner))assert.equal(next[side],winner,'The winner holds its displayed side');
    rounds.push({a:card.a,b:card.b,outcome,winner,side});last=card;
    if(n===0){
      await page.reload();await page.waitForSelector('#stage.mini-stage');
      assert.equal(await page.evaluate(side=>S.current[side],side),winner,'Reload remembers the winner’s side');
      await settled('#stage .side .window > img');
      await page.screenshot({path:OUT+'/sides-crown-reload.png'});
    }
    if(result.crowned){
      assert.equal(await page.evaluate(async p=>(await api(`/api/group/${p}`)).rep,members[0]),winner,'The real stack keeps the displayed winner');
      break;
    }
  }
  assert(rounds.length>=5,'Crown exercised defenders, challengers and Space');
  const skipped=rounds.findIndex(r=>r.outcome==='skip'),deferred=[rounds[skipped].a,rounds[skipped].b].find(p=>p!==rounds[skipped].winner);
  assert(rounds.slice(skipped+1).some(r=>[r.a,r.b].includes(deferred)),'The skipped challenger returns before a crown can be awarded');
  await page.keyboard.press('z');await page.waitForFunction(ids=>!S.busy&&S.current?.type==='mini'&&S.current.frames.every(x=>ids.includes(x)),members);
  assert.deepEqual(await page.evaluate(()=>[S.current.a,S.current.b]),[last.a,last.b],'Undo restores the same displayed pair despite a new server card');
  await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>!S.busy&&!S.current);
  // Force a canonical/display mismatch using controlled prior display history, then vote through each real UI.
  // The server still owns the unmodified card, bracket match and saved winner.
  const exercise=async(stage)=>{
    await page.goto(`${BASE}/#duel?stage=${stage}`);await page.waitForSelector('#stage .side');
    const shown=await page.evaluate(()=>{
      const current=S.current,raw={...current,a:current.wire.a,b:current.wire.b};delete raw.wire;
      DuelSides.pick({type:raw.type,a:raw.b,b:raw.a},'b');S.cards=[raw];showNext();
      return {id:S.current.id,type:S.current.type,a:S.current.a,b:S.current.b,wire:raw,match:raw.match};
    });
    assert.equal(shown.b,shown.wire.a);
    const reply=page.waitForResponse(r=>r.url().endsWith('/api/vote')&&r.request().method()==='POST');
    await page.keyboard.press('ArrowRight');const response=await reply,result=await response.json();
    assert.equal(response.status(),200);assert.equal(response.request().postDataJSON().outcome,'a');
    await page.waitForFunction(()=>!S.busy);
    if(stage==='knockouts')assert(result.knockouts.rounds.some(r=>r.matches.some(m=>m.a===shown.wire.a&&m.b===shown.wire.b&&m.winner===shown.b)));
    else {
      const replay=await page.evaluate(async()=>api('/api/undo',{stage:S.stage}));
      assert.equal(replay.undone,'duel');assert.equal(replay.cards[0].a,shown.wire.a);assert.equal(replay.cards[0].b,shown.wire.b);
      // Undo replays the actual stored a/b pair. Reapply that card to check the display history as well.
      await page.evaluate(r=>{S.cards=r.cards;showNext();},replay);
      assert.deepEqual(await page.evaluate(()=>[S.current.a,S.current.b]),[shown.a,shown.b]);
      return {stage,shown:shown.b,wire:shown.wire.a,undo:true};
    }
    await page.keyboard.press('z');await page.waitForFunction(id=>!S.busy&&S.current?.id===id,shown.id);
    assert.deepEqual(await page.evaluate(()=>[S.current.a,S.current.b]),[shown.a,shown.b]);
    return {stage,shown:shown.b,wire:shown.wire.a,undo:true};
  };
  modes.push(await exercise('open'));
  await page.evaluate(()=>api('/api/knockouts/start',{}));modes.push(await exercise('knockouts'));
  await page.evaluate(async()=>{const shots=(await api('/api/groups?view=all&per=400')).shots;await api('/api/draw/new',{photos:shots.map(x=>x.rep)});});
  modes.push(await exercise('groups'));
  await page.goto(`${BASE}/#finals`);await page.waitForSelector('#journey-next.ready');await page.click('#journey-next');await page.waitForSelector('#f-arena .side');
  const final=await page.evaluate(async()=>{
    const data=await api('/api/finals'),card=data.card;
    DuelSides.pick({type:'final',a:card.b,b:card.a},'b');renderFinals(document.querySelector('#main'),data);
    return {id:card.id,a:card.a,b:card.b,match:card.match};
  });
  assert.equal(await page.locator('#f-arena .side[data-side="b"]').getAttribute('data-photo'),String(final.a));
  await settled('#f-arena .side .window > img');
  await page.screenshot({path:OUT+'/sides-finals.png'});
  const reply=page.waitForResponse(r=>r.url().endsWith('/api/vote')&&r.request().method()==='POST');await page.keyboard.press('ArrowRight');
  const response=await reply,result=await response.json();assert.equal(response.status(),200);assert.equal(response.request().postDataJSON().outcome,'a');
  assert.equal(result.finals.matches[final.match].winner,final.a,'Finals saves the displayed right-hand winner in the original bracket slot');
  await page.waitForFunction(()=>document.querySelector('#bracket')?.querySelectorAll('.bm.played').length>0);
  await page.keyboard.press('z');await page.waitForFunction(id=>document.querySelector('#f-arena .side[data-side="b"]')?.dataset.photo===String(id),final.a);
  const restored=await page.evaluate(()=>api('/api/finals'));assert.equal(restored.card.id,final.id);assert.equal(restored.finals.matches[final.match].winner,null);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({rounds,modes,final,problems}));await browser.close();
})().catch(async e=>{console.error('FAILED:',e.stack);if(page)await page.screenshot({path:OUT+'/sides-fail.png'}).catch(()=>{});process.exit(1);});
