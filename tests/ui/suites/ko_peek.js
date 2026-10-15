// Elimination matches, chosen directly from the board, survive undo and lead to Finals.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { BASE, LINK, LIB, OUT } = process.env;
(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await (await browser.newContext({viewport:{width:1600,height:900}})).newPage();
  const problems=[]; page.on("pageerror",e=>problems.push(e.message));
  await page.goto(LINK);await page.fill("#path",LIB);await page.click("#use-path");
  await page.waitForSelector("#an-go",{timeout:300000});await page.click("#an-go");
  await page.evaluate(async()=>{await api("/api/stacks/auto",{});await api("/api/draw/auto",{});await api("/api/knockouts/start",{});});
  await page.goto(BASE+"/#tournament");await page.waitForSelector(".ko-match:not(.settled)");
  const links=await page.$$eval(".ko-match:not(.settled)",es=>es.map(e=>e.getAttribute("href")));
  await page.goto(BASE+"/"+links.at(-1));await page.waitForSelector("#stage .side img");
  const chosen=await page.evaluate(()=>({id:S.current.id,type:S.current.type,a:S.current.a,b:S.current.b,round:S.current.round}));
  assert.equal(chosen.type,"knockout");assert.equal(chosen.id.split(":").at(-1),new URLSearchParams(links.at(-1).split("?")[1]).get("match"));
  // Space defers a match without deciding it (the rule for every stage); the undecided match returns later.
  assert.equal(await page.locator('[data-o="skip"]').isVisible(),true);assert.equal(await page.locator('[data-o="great"]').isVisible(),false);
  await page.waitForSelector("#group-table .ko-rounds");await page.screenshot({path:`${OUT}/K-duel.png`});
  await page.keyboard.press("ArrowLeft");await page.waitForTimeout(800);
  const after=await page.evaluate(async()=> (await api("/api/knockouts")).knockouts);
  assert(after.rounds.flatMap(r=>r.matches).some(m=>m.winner===chosen.a));
  await page.keyboard.press("z");await page.waitForTimeout(650);
  const restored=await page.evaluate(()=>S.current);assert.equal(restored.id,chosen.id);
  await page.evaluate(async()=>{for(let n=0;n<100;n++){const {card}=await api("/api/knockouts");if(!card)break;await api("/api/vote",{card:card.id,outcome:"a",stage:"knockouts"});}});
  await page.goto(BASE+"/#finals");await page.waitForSelector("#journey-next.ready");await page.click("#journey-next");
  await page.waitForSelector("#f-arena .side img");
  const res=await page.evaluate(async()=>({qualified:(await api("/api/knockouts")).knockouts.qualified,seeds:(await api("/api/finals")).finals.seeds}));
  assert.deepEqual(res.seeds,res.qualified);assert.equal(res.qualified.length,8);assert.deepEqual(problems,[]);
  console.log(JSON.stringify({...res,chosen,problems}));await browser.close();
})().catch(e=>{console.error("FAILED:",e.message);process.exit(1);});
