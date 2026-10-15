const {chromium}=require('playwright-core');const {LINK,LIB}=process.env;
(async()=>{const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:2048,height:1152}});
  await page.goto(LINK);await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading&&World.sprites?.size);
  const out=await page.evaluate(async()=>{
    const sea=World.sea,photos=[...World.photos.values()],sprites=new Map(World.sprites);
    const traces=[];const proto=Object.getPrototypeOf(sea),f=proto.receive;proto.receive=function(m){if(m.trace)traces.push({t:Math.round(performance.now()),...m.trace,replyGen:m.generation,n:m.clusters?.length});return f.call(this,m);};
    const sets=[];const post=sea.worker.postMessage.bind(sea.worker);sea.worker.postMessage=(m,t)=>{if(m.kind==='set')sets.push({t:Math.round(performance.now()),gen:m.generation,tagged:m.items.filter(it=>it.tags.length).length});return post(m,t);};
    const items=Array.from({length:1879},(_,i)=>({id:50000+i,photo:photos[i%photos.length].id,rep:50000+(i<755?i:(i-755)%755),n:1,tags:[],take:i>=755,group:i%23===0?'cut':null}));
    for(const it of items)if(!it.take){it.members=items.filter(p=>p.rep===it.id).map(p=>p.photo);it.n=it.members.length;}
    sea.setVenn([],items,[{id:'gcut',kind:'group',html:'Set aside'}]);
    sea.sprites=new Map(items.map(it=>[it.id,sprites.get(it.photo)||{img:null,x:0,y:0}]));
    await new Promise(r=>setTimeout(r,500));
    for(const it of items)it.tags=['year:2026',`subject:${(it.rep-50000)%18}`,`place:${(it.rep-50000)%7}`];
    const tags=[...new Set(items.flatMap(it=>it.tags))].map(id=>({id,label:id,html:id}));
    const t0=Math.round(performance.now());sea.setVenn(tags,items,[{id:'gcut',kind:'group',html:'Set aside'}]);World.fence();
    await new Promise(r=>setTimeout(r,3000));
    return {sets:sets.map(s=>({...s,t:s.t-t0})),traces:traces.map(x=>({...x,t:x.t-t0})),lassos:sea.lassos.size};
  });
  console.log('TRACE',JSON.stringify(out));await browser.close();})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
