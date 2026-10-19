// Enhancement changes the picture, including white scenery, while the polaroid's paper keeps its colour.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),path=require('node:path');
const {LINK,OUT}=process.env;
(async()=>{
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:960,height:720}}),problems=[];
  page.on('pageerror',e=>problems.push(e.message));await page.goto(LINK);
  await page.waitForFunction(()=>typeof paintFilter==='function');
  const fixture=await page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=400;c.height=200;const x=c.getContext('2d');
    x.fillStyle='#c64422';x.fillRect(0,0,400,200);x.fillStyle='white';x.fillRect(180,0,40,200);return c.toDataURL().split(',')[1];
  });
  // Keep this legacy bare-image proof out of the automatic card wrapper, which handles real photo URLs.
  await page.route('**/filter-test-picture.png',r=>r.fulfill({contentType:'image/png',body:Buffer.from(fixture,'base64')}));
  await page.evaluate(()=>{
    const host=document.createElement('div');host.id='filter-proof';host.style.cssText='position:fixed;left:200px;top:100px;width:300px;height:400px;z-index:99999;background:#123';
    host.innerHTML='<img src="/filter-test-picture.png" alt="Filter proof" style="width:300px;height:400px;padding:16.5px 16.5px 51px;object-fit:contain;object-position:center top;box-sizing:border-box;background:var(--paper);animation:none">';
    document.querySelector('#main').append(host);
  });
  const img=page.locator('#filter-proof img');await img.evaluate(e=>e.decode());
  const before=await img.screenshot();
  await img.evaluate(e=>paintFilter(e,900001,true,{levels:1,light:.7,contrast:.3,colour:.4,warmth:.8}));
  const after=await img.screenshot({path:OUT+'/photo-filter-paper.png'});
  const compare=JSON.parse(execFileSync(path.resolve(__dirname,'../../../.venv/bin/python'),['-c',`
import base64, io, json, sys
from PIL import Image
before, after = [Image.open(io.BytesIO(base64.b64decode(s))).convert('RGB') for s in json.load(sys.stdin)]
paper_max = photo_changed = photo_total = 0
for y in range(before.height):
    for x in range(before.width):
        diff = max(abs(a-b) for a,b in zip(before.getpixel((x,y)), after.getpixel((x,y))))
        if x < 14 or x > 286 or y < 14 or y > 153:
            paper_max = max(paper_max, diff)
        elif 20 < x < 280 and 20 < y < 145:
            photo_total += 1
            photo_changed += diff > 3
print(json.dumps(dict(paperMax=paper_max, photoChanged=photo_changed/photo_total,
    whiteBefore=before.getpixel((150,80)), whiteAfter=after.getpixel((150,80)))))
`],{input:JSON.stringify([before.toString('base64'),after.toString('base64')]),encoding:'utf8'}));
  assert(compare.paperMax<=1,`Paper stays unchanged: ${JSON.stringify(compare)}`);
  assert(compare.photoChanged>.9,`The enhancement reaches the photo: ${JSON.stringify(compare)}`);
  assert.notDeepEqual(compare.whiteBefore,compare.whiteAfter,'White areas inside the photo can still be enhanced');
  assert.deepEqual(problems,[]);console.log(JSON.stringify({compare,problems}));await browser.close();
})().catch(e=>{console.error('FAILED:',e.stack);process.exit(1);});
