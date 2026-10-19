// The measured correction changes actual pixels, and the live SVG, atlas and exported look agree.
const {chromium}=require('playwright-core'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {boot}=require('./stack-helpers.cjs'),{OUT}=process.env;
const python=require('node:path').resolve(__dirname,'../../../.venv/bin/python');let page;
(async()=>{
  const fixture=JSON.parse(execFileSync(python,['-c',`
import base64, io, json
import numpy as np
from PIL import Image
from matcher import auto_look
x=np.tile(np.linspace(.02,.42,320),(240,1))
im=Image.fromarray(np.round(np.repeat(x[...,None],3,axis=2)*255).astype(np.uint8))
buf=io.BytesIO();im.save(buf,'PNG')
print(json.dumps(dict(recipe=auto_look.measure(im),png=base64.b64encode(buf.getvalue()).decode())))
`],{cwd:'../..',encoding:'utf8'}));
  const browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1200,height:900},reducedMotion:'reduce'});
  const problems=[];page.on('pageerror',e=>problems.push(e.message));await boot(page);
  const pid=await page.evaluate(()=>[...World.photos.keys()][0]);
  const cursors=[],reloads=[];
  const watch=r=>{if(/\/api\/world\b|\/img\/atlas\.jpg/.test(r.url()))reloads.push(r.url());};page.on('request',watch);
  await page.route('**/api/auto-looks?*',route=>{
    const after=Number(new URL(route.request().url()).searchParams.get('after'));cursors.push(after);
    return route.fulfill({json:{working:cursors.length===1,after:pid,more:false,version:fixture.recipe.version,
      recipes:cursors.length===1?[{id:pid,recipe:fixture.recipe}]:[]}});
  });
  const upgraded=await page.evaluate(async({pid,recipe})=>{
    AutoLook.recipes.set(pid,{...recipe,version:2,curve:undefined});World.photos.get(pid).auto_look=AutoLook.recipes.get(pid);
    const sea=World.sea,objects=new Map([...sea.items].map(([id,it])=>[id,it.el])),camera=JSON.stringify(sea.camera);
    await World.pollLooks(S.lib.source);
    return {version:World.photos.get(pid).auto_look.version,same:[...sea.items].every(([id,it])=>objects.get(id)===it.el),camera:camera===JSON.stringify(sea.camera)};
  },{pid,recipe:fixture.recipe});
  page.off('request',watch);await page.unroute('**/api/auto-looks?*');
  assert.deepEqual(cursors,[0,pid]);assert.deepEqual(upgraded,{version:fixture.recipe.version,same:true,camera:true});
  assert.equal(reloads.length,0,'Background corrections update the existing photos without reloading the world or its atlas');
  await page.evaluate(async({pid,fixture})=>{
    const host=document.createElement('div');host.id='tone-proof';host.style.cssText='position:fixed;left:300px;top:250px;width:320px;height:240px;z-index:99999;';
    host.innerHTML='<div class="window" style="position:static;width:320px;height:240px;overflow:hidden;border-radius:0"><img alt="Tone proof" style="position:static;display:block;width:320px;height:240px;max-width:none;padding:0;transform:none;animation:none"></div>';
    document.body.append(host);const img=host.querySelector('img');img.src='data:image/png;base64,'+fixture.png;await img.decode();
    AutoLook.know(pid,fixture.recipe);Toolbelt.edits.set(pid,{});paintFilter(img,pid,false);
  },{pid,fixture});
  const img=page.locator('#tone-proof img'),before=await img.screenshot();
  await img.evaluate((img,pid)=>paintFilter(img,pid,true),pid);const after=await img.screenshot({path:OUT+'/auto-tone-corrected.png'});
  const compare=JSON.parse(execFileSync(python,['-c',`
import base64, io, json, sys
import numpy as np
from PIL import Image
from matcher import auto_look, finishing, touchup
data=json.load(sys.stdin)
im=Image.open(io.BytesIO(base64.b64decode(data['before']))).convert('RGB')
actual=np.asarray(Image.open(io.BytesIO(base64.b64decode(data['after']))).convert('RGB'),dtype=float)
how=auto_look.resolve(data['recipe'])
out=finishing.apply(touchup.apply(auto_look.detail(im,how['detail']),how),how,im.size,(0,0,*im.size))
diff=np.abs(actual[8:-8,8:-8]-np.asarray(out,dtype=float)[8:-8,8:-8])
print(json.dumps(dict(mean=float(diff.mean()),p95=float(np.quantile(diff,.95)),before=im.getpixel((160,120)),after=actual[120,160].tolist())))
`],{cwd:'../..',input:JSON.stringify({before:before.toString('base64'),after:after.toString('base64'),recipe:fixture.recipe}),encoding:'utf8'}));
  assert(compare.mean<2.5&&compare.p95<4,`Visible SVG agrees with the exported correction: ${JSON.stringify(compare)}`);
  assert(compare.after[0]-compare.before[0]>30,`Dim photos get a visible correction: ${JSON.stringify(compare)}`);
  await img.evaluate((img,pid)=>paintFilter(img,pid,true,null,{auto_amount:0}),pid);const zero=await img.screenshot();
  assert(before.equals(zero),'Amount zero restores the source pixels');
  const atlas=await page.evaluate(async pid=>{
    const c=document.createElement('canvas');c.width=800;c.height=16;const ctx=c.getContext('2d');ctx.drawImage(document.querySelector('#tone-proof img'),0,0,16,16);
    const raw=[...ctx.getImageData(8,8,1,1).data].slice(0,3),sheet=new Image();sheet.src=c.toDataURL();await sheet.decode();
    S.filter=true;S.align=false;const painted=AutoLook.sheet(sheet,[{id:pid,dims:[320,240]}]);
    return {raw,pixel:[...painted.getContext('2d').getImageData(8,8,1,1).data].slice(0,3)};
  },pid);
  const expected=JSON.parse(execFileSync(python,['-c',`
import json,sys
from PIL import Image
from matcher import auto_look,touchup,finishing
d=json.load(sys.stdin);how=auto_look.resolve(d['recipe']);im=Image.new('RGB',(1,1),tuple(d['raw']))
out=finishing.apply(touchup.apply(im,how),how,im.size,(0,0,1,1))
print(json.dumps(out.getpixel((0,0))))
`],{cwd:'../..',input:JSON.stringify({raw:atlas.raw,recipe:fixture.recipe}),encoding:'utf8'}));
  assert(atlas.pixel.every((v,i)=>Math.abs(v-expected[i])<=2),`Atlas agrees with export: ${JSON.stringify({atlas,expected})}`);
  assert.deepEqual(problems,[]);console.log(JSON.stringify({pid,upgraded,cursors,compare,atlas,expected,problems}));await browser.close();
})().catch(async e=>{console.error(e.stack);if(page)await page.screenshot({path:OUT+'/auto-tone-failure.png'}).catch(()=>{});process.exit(1);});
