const assert=require('node:assert/strict');
const {LINK,LIB,BASE}=process.env;
async function boot(page){
  await page.goto(LINK);await page.click('[data-mode=gallery]');await page.fill('#path',LIB);await page.click('#use-path');
  await page.waitForSelector('#an-go',{timeout:300000});await page.click('#an-go');await page.waitForSelector('.journey');
  await page.waitForFunction(()=>World.photos?.size&&!World.loading&&World.sea.settled);
}
async function ready(page,count){await page.waitForFunction(n=>{
  const sea=World.sea;return Number(document.querySelector('#world').dataset.stackCount)===n&&sea.settled&&sea.bodies.length===sea.arrangement?.length&&sea.arrangement.every(p=>{const it=sea.items.get(p.id);return it?.size>0&&Math.hypot(it.x-p.x*sea.width,it.y-p.y*sea.height)<.15;});
},count);}
async function drag(page,a,b){
  const points=await page.evaluate(({a,b})=>{
    const sea=World.sea,x=sea.items.get(a),y=sea.items.get(b),size=Math.max(x.size||sea.s,y.size||sea.s),z=Math.max(1,Math.min(90/size,innerWidth*.65/(Math.abs(x.x-y.x)+size*2),innerHeight*.48/(Math.abs(x.y-y.y)+size*2)));
    sea.hold(null);sea.setCamera(z,innerWidth/2-(x.x+y.x)/2*z,innerHeight*.5-(x.y+y.y)/2*z);sea.promote(a);sea.promote(b);
    return [a,b].map(id=>{const it=sea.items.get(id),[x,y]=sea.toScreen(it.x,it.y);return {x,y};});
  },{a,b});
  await page.waitForTimeout(220);await page.mouse.up();await page.mouse.move(points[0].x,points[0].y);await page.mouse.down();
  assert(await page.evaluate(()=>!!World.sea.drag),'The pointer grabs the actual print');
  await page.mouse.move(points[1].x,points[1].y,{steps:16});await page.mouse.up();await page.mouse.move(5,180);
}
async function synthetic(page,{count=160,takes=8,first=80000}={}){
  const sample=await page.evaluate(()=>({photo:[...World.photos.values()][0],source:S.lib.source}));
  const pixels=await(await page.request.get(new URL(`/img/t/${sample.photo.id}.jpg`,BASE).href)).body();
  await page.route(/\/img\/[tp]\/\d+\.jpg(?:\?|$)/,r=>Number(new URL(r.request().url()).pathname.match(/\/(\d+)\.jpg/)[1])>=first?r.fulfill({contentType:'image/jpeg',body:pixels}):r.continue());
  const state={rows:Array.from({length:count},(_,i)=>({rep:first+i*takes,members:Array.from({length:takes},(_,j)=>first+i*takes+j),family:Math.floor(i/2),taken:new Date(Date.UTC(2024,0,1+Math.floor(i/5))).toISOString()})),history:[],future:[],requests:[],merges:[]};
  await page.route('**/api/groups?*',r=>{
    const q=new URL(r.request().url()).searchParams;if(q.get('view')==='suggest')return r.fulfill({json:{suggestions:[],counts:{suggest:0}}});
    const page=Number(q.get('page')||0),per=Number(q.get('per')||120),rows=state.rows;state.requests.push({page,per,order:q.get('order')});
    const byDate=new Map();for(const s of rows){const date=s.taken.slice(0,10),old=byDate.get(date);if(old)old.count++;else byDate.set(date,{date,photo:s.rep,count:1});}
    return r.fulfill({json:{shots:rows.slice(page*per,(page+1)*per),boxes:{},undo:state.history.length?'merge':null,page,pages:Math.ceil(rows.length/per),total:rows.length,dates:[...byDate.values()]}});
  });
  const save=()=>{state.history.push(structuredClone(state.rows));state.future=[];};
  await page.route('**/api/groups/merge',r=>{
    const p=r.request().postDataJSON();state.merges.push(p);save();const selected=state.rows.filter(s=>p.photos.some(id=>s.members.includes(id))),index=state.rows.indexOf(selected[0]);assert(selected.length>=2);
    const target=selected.find(s=>s.members.includes(p.photos.at(-1))),combined={...target,members:selected.flatMap(s=>s.members)};
    state.rows=state.rows.filter(s=>!selected.includes(s));state.rows.splice(index,0,combined);return r.fulfill({json:{ok:true,undo:'merge'}});
  });
  await page.route('**/api/frame',r=>{save();const pid=r.request().postDataJSON().photo;state.rows.find(s=>s.members.includes(pid)).rep=pid;return r.fulfill({json:{ok:true,undo:'keep'}});});
  await page.route('**/api/groups/split',r=>{save();const pid=r.request().postDataJSON().photo,s=state.rows.find(s=>s.members.includes(pid));s.members=s.members.filter(id=>id!==pid);if(s.rep===pid)s.rep=s.members[0];state.rows.splice(state.rows.indexOf(s)+1,0,{...s,rep:pid,members:[pid]});return r.fulfill({json:{ok:true,undo:'split'}});});
  await page.route('**/api/draw/undo',r=>{state.future.push(structuredClone(state.rows));state.rows=state.history.pop()||state.rows;return r.fulfill({json:{undone:'merge',next:state.history.length?'merge':null}});});
  await page.route('**/api/draw/redo',r=>{state.history.push(structuredClone(state.rows));state.rows=state.future.pop()||state.rows;return r.fulfill({json:{redone:'merge'}});});
  await page.evaluate(({rows,sample})=>{
    const sprite=World.sprites.values().next().value;World.photos=new Map();World.sprites=new Map();World.sea.sprites=World.sprites;
    for(const s of rows)for(const id of s.members){World.photos.set(id,{...sample.photo,id,rep:s.rep,members:id===s.rep?s.members:[id],cut:false,theme:-1,taken:s.taken});World.sprites.set(id,sprite);}
    World.total=World.photos.size;World.photosSource=sample.source;World.photoSource=sample.source;World.stale=false;
  },{rows:state.rows,sample});
  return state;
}
module.exports={boot,ready,drag,synthetic};
