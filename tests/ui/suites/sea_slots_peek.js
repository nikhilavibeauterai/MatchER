// A large feed keeps real moving mini photos and distinct new arrivals, without assigned cells.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { LINK, LIB, OUT } = process.env;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(LINK); await page.fill("#path",LIB); await page.click("#use-path");
  await page.waitForSelector("#an-go", {timeout:300000}); await page.click("#an-go");
  await page.waitForSelector(".journey");
  const res = await page.evaluate(async () => {
    const photos = (await api("/api/world")).photos;
    const im = new Image(); im.src=T(photos[0].id); await im.decode();
    const preview=document.createElement("canvas"); preview.width=preview.height=16;
    preview.getContext("2d").drawImage(im,0,0,16,16);
    const div=document.createElement("div"); div.style.cssText="position:fixed;left:20px;top:100px;width:1200px;height:700px;z-index:40;background:#172033";
    document.body.append(div);
    const sea=new VennSea(div); window.testSea=sea;
    const circles=[{id:"new",label:"New tag",emoji:"✨",html:"✨ New tag"}];
    const lassos=[0,1,2,3].map((id)=>({id:`g${id}`,kind:"group",html:`Group ${id+1}`}));
    for(let start=0;start<2000;start+=200){
      const batch=Array.from({length:200},(_,k)=>({id:start+k+10000,photo:photos[(start+k)%photos.length].id,tags:["new"],group:(start+k)%4,n:1,title:"Public-domain fixture"}));
      sea.setVenn(circles,batch,lassos,true);
      for(const it of sea.items.values())it.preview={img:preview,x:0,y:0};
      await sleep(20);
    }
    sea.layout();
    const positions=[...sea.items.values()].map(it=>[it.x,it.y]);
    sea.setVenn(circles,[],lassos,true);
    await sleep(900);
    const moved=[...sea.items.values()].filter((it,i)=>Math.hypot(it.x-positions[i][0],it.y-positions[i][1])>1).length;
    const data=sea.densityCanvas.getContext("2d").getImageData(0,0,sea.densityCanvas.width,sea.densityCanvas.height).data;
    let painted=0;for(let i=3;i<data.length;i+=4)if(data[i])painted++;
    return {photos:sea.items.size,dom:div.querySelectorAll(".ps-item").length,limit:sea.domLimit,density:sea.items.size-sea.moving.length,painted,moved,
      newest:sea.items.get(11999).el.isConnected,distinct:new Set(sea.moving.map((it)=>`${Math.round(it.x)},${Math.round(it.y)}`)).size};
  });
  assert.equal(res.photos,2000); assert(res.dom<=res.limit); assert(res.density>0);
  assert(res.painted>1000); assert(res.moved>1000); assert(res.newest); assert(res.distinct>100);
  await page.waitForTimeout(500); await page.screenshot({path:`${OUT}/A-2000-sea.png`});
  const larger=await page.evaluate(()=>{
    const sea=window.testSea, sample=[...sea.items.values()][0];
    const items=Array.from({length:20000},(_,k)=>({id:k+10000,photo:sample.photo,tags:[],group:k%4,n:1}));
    sea.setVenn([],items,[0,1,2,3].map((id)=>({id:`g${id}`,kind:"group",html:`Group ${id+1}`})));
    for(const it of sea.items.values())it.preview=sample.preview;
    sea.layout();return {photos:sea.items.size,dom:sea.moving.length};
  });
  assert.equal(larger.photos,20000); assert(larger.dom<=res.limit);
  await page.waitForTimeout(3000);await page.screenshot({path:`${OUT}/A-20000-sea.png`});
  await page.evaluate(()=>{testSea.destroy();testSea.el.remove();});
  assert.deepEqual(problems,[]); console.log(JSON.stringify({...res,larger,problems}));
  await browser.close();
})().catch((e)=>{console.error("FAILED:",e.message);process.exit(1);});
