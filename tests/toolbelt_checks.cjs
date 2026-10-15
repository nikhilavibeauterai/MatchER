const test=require('node:test');
const assert=require('node:assert/strict');
const {Toolbelt,eraseMarks}=require('../matcher/static/toolbelt.js');
const pen=p=>({t:'pen',c:'ink',p});

test('rubbing the middle of a stroke keeps both ends and the other marks',()=>{
  const marks=[pen([[10,50],[90,50]]),{t:'marker',c:'gold',p:[[10,90],[90,90]]}];
  const before=structuredClone(marks),cut=eraseMarks(marks,[50,50],[50,50],2);
  assert.equal(cut.length,3);
  assert.deepEqual(cut[0].p[0],[10,50]);assert.deepEqual(cut[1].p.at(-1),[90,50]);
  assert(Math.abs(cut[0].p.at(-1)[0]-47.725)<1e-6);
  assert(Math.abs(cut[1].p[0][0]-52.275)<1e-6);
  assert.deepEqual(cut[2],marks[1]);assert.deepEqual(marks,before,'Previewing an erase leaves the saved strokes intact');
});
test('a quick eraser drag cuts everything along its path between pointer events',()=>{
  const marks=[pen([[10,30],[90,30]]),pen([[10,70],[90,70]]),pen([[10,100],[90,100]])];
  const cut=eraseMarks(marks,[50,10],[50,85],3);
  assert.equal(cut.length,5);
  assert.deepEqual(cut.at(-1),marks.at(-1));
  assert(cut.slice(0,-1).every(m=>m.p.every(p=>p[0]<47)||m.p.every(p=>p[0]>53)));
});
test('the circular ends of the eraser and a diagonal sweep cut locally',()=>{
  const cut=eraseMarks([pen([[0,0],[100,100]])],[20,80],[80,20],2);
  assert.equal(cut.length,2);
  assert.deepEqual(cut[0].p[0],[0,0]);assert.deepEqual(cut[1].p.at(-1),[100,100]);
  assert(cut[0].p.at(-1)[0]<49&&cut[1].p[0][0]>51);
  const end=eraseMarks([pen([[0,50],[100,50]])],[50,10],[50,48],3);
  assert.equal(end.length,2,'A circle at the end of the sweep reaches the nearby line');
});
test('dots erase, blank paper does nothing, and duplicate points remain safe',()=>{
  const marks=[pen([[10,10]]),pen([[60,60],[60,60],[80,60]])];
  assert.equal(eraseMarks(marks,[30,30],[35,35],2),marks);
  assert.deepEqual(eraseMarks(marks,[10,10],[10,10],2),[marks[1]]);
  const cut=eraseMarks(marks,[60,60],[60,60],2);
  assert.equal(cut.length,2);assert(cut[1].p[0][0]>62);
  assert(cut.flatMap(m=>m.p.flat()).every(Number.isFinite));
});
test('a looping stroke keeps all its separate untouched pieces',()=>{
  const cut=eraseMarks([pen([[10,40],[90,40],[90,60],[10,60]])],[50,30],[50,70],2);
  assert.equal(cut.length,3);
  assert.deepEqual(cut[0].p[0],[10,40]);assert.deepEqual(cut[2].p.at(-1),[10,60]);
  assert(cut[1].p.some(p=>p[0]===90),'The far part of the loop survives');
});
test('quick consecutive strokes queue their saves without losing either stroke',async()=>{
  const belt=Object.assign(Object.create(Toolbelt),{source:'',edits:new Map([[7,{}]]),loading:new Map(),jobs:new Map(),saving:new Map(),listeners:new Set(),render(){}});
  let release;const gate=new Promise(r=>{release=r;}),requests=[];
  global.api=async(path,body)=>{requests.push(body);if(requests.length===1)await gate;return {edits:{marks:body.marks}};};
  global.toast=message=>{throw new Error(message);};
  const a=pen([[1,2],[3,4]]),b=pen([[5,6],[7,8]]);
  belt.save(7,old=>({marks:[...(old.marks||[]),a]}));
  belt.save(7,old=>({marks:[...(old.marks||[]),b]}));
  assert.deepEqual(belt.current(7).marks,[a,b],'Both strokes show before the first reply');
  await new Promise(r=>setImmediate(r));assert.equal(requests.length,1);
  release();await belt.flush();
  assert.deepEqual(requests.map(r=>r.marks.length),[1,2]);assert.deepEqual(belt.edits.get(7).marks,[a,b]);
  delete global.api;delete global.toast;
});
test('a late save reply cannot put one library\'s annotations into another library',async()=>{
  const belt=Object.assign(Object.create(Toolbelt),{source:'first',edits:new Map([[7,{}]]),loading:new Map(),jobs:new Map(),saving:new Map(),listeners:new Set(),render(){}});
  global.S={lib:{source:'first'}};
  let release;const gate=new Promise(r=>{release=r;});
  global.api=async(path,body)=>{await gate;return {edits:{marks:body.marks}};};
  const pending=belt.save(7,old=>({marks:[...(old.marks||[]),pen([[1,2],[3,4]])]}));
  await new Promise(r=>setImmediate(r));
  S.lib.source='second';release();await pending;
  assert.equal(belt.source,'second');assert(!belt.edits.has(7),'Photo ids are local to their save');
  delete global.api;delete global.S;
});
