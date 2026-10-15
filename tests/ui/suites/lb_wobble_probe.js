const {chromium}=require('playwright-core');const {BASE,LINK,LIB}=process.env;
(async()=>{const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(LINK);await page.click('.mode-card[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.goto(BASE+'/#duel?stage=open');
  for(let k=0;k<6;k++){await page.waitForSelector('#stage .side img',{timeout:15000});await page.keyboard.press('ArrowLeft');await page.waitForTimeout(400);}
  await page.goto(BASE+'/#shortlist');await page.waitForSelector('.board-card[data-photo]');await page.waitForTimeout(700);
  const out=await page.evaluate(()=>{const card=[...document.querySelectorAll('.board-card[data-photo]')].at(-1);return {inMain:!!card.closest('#main'),cards:document.querySelectorAll('.board-card').length,anim:[card,...card.querySelectorAll('*')].filter(el=>getComputedStyle(el).animationName!=='none').map(el=>`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}=${getComputedStyle(el).animationName}`)};});
  console.log('WOBBLE',JSON.stringify(out));await browser.close();})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
