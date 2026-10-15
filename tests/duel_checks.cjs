const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const app=fs.readFileSync(require.resolve('../matcher/static/app.js'),'utf8');
const helper=app.slice(app.indexOf('const DuelSides = {'),app.indexOf('\nfunction showNext()'));
function setup(storage=new Map()){
  const context={S:{lib:{source:'public-a'}},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}};
  vm.createContext(context);vm.runInContext(`${helper}\nglobalThis.sides=DuelSides;`,context);
  return {...context,storage};
}
const card=(a,b,type='mini',other={})=>({id:'test-card',type,a,b,champ:a,round:2,match:3,...other});
const pair=c=>[c.a,c.b];
test('the Crown winner keeps either displayed side while the challenger replaces its loser',()=>{
  const {sides}=setup();let c=sides.present(card(1,2));sides.pick(c,'b');
  c=sides.present(card(2,3));assert.deepEqual(pair(c),[3,2]);assert.equal(c.wire.a,2);
  sides.pick(c,'a');c=sides.present(card(4,3));assert.deepEqual(pair(c),[3,4]);
  assert.equal(sides.outcome(c,'a'),'b');
});
test('Space preserves the Crown defender without recording a victory, including before the first win',()=>{
  const {sides,storage}=setup();const c=sides.present(card(3,2,'mini',{champ:2}));assert.equal(sides.pick(c,'skip'),null);
  assert.equal(sides.state().history.length,0);assert.equal(sides.state().last,null);
  assert.deepEqual(pair(sides.present(card(2,4))),[4,2]);assert.equal(sides.outcome(c,'skip'),'skip');
  const resumed=setup(storage).sides;assert.deepEqual(pair(resumed.present(card(2,4))),[4,2]);
  assert.equal(resumed.state().history.length,0);assert.equal(resumed.state().last,null);
  const next=resumed.present(card(2,4));resumed.pick(next,'a');
  assert.deepEqual(pair(resumed.present(card(5,4,'mini',{champ:4}))),[4,5],'An actual new winner takes over the remembered side');
  resumed.pick(resumed.present(card(2,7,'duel')),'a');
  assert.deepEqual(pair(resumed.present(card(8,2,'mini',{champ:2}))),[2,8],'A newer actual win overrides an older skipped-defender position');
});
for(const type of ['duel','knockout','final'])test(`${type} presentation preserves IDs, bracket indices and canonical vote semantics`,()=>{
  const {sides}=setup();sides.pick(sides.present(card(1,2,type)),'b');
  const raw=card(2,3,type,{id:'same-server-card',match:7,commentary:'Rematch: left won last time'}),c=sides.present(raw);
  assert.deepEqual(pair(c),[3,2]);assert.deepEqual(pair(raw),[2,3]);assert.equal(c.id,raw.id);assert.equal(c.match,7);
  assert.equal(c.commentary,'Rematch: right won last time');
  for(const side of ['a','b']){const wire=sides.outcome(c,side);assert.equal(raw[wire],c[side]);assert.equal(sides.outcome(c,`toss_${side}`),`toss_${wire}`);}
  for(const outcome of ['skip','great','meh'])assert.equal(sides.outcome(c,outcome),outcome);
});
test('prefetched cards are oriented at display time; unrelated pairs stay as dealt',()=>{
  const {sides}=setup(),prefetched=card(1,3,'duel');
  sides.pick(sides.present(card(2,1,'duel')),'b');
  assert.deepEqual(pair(sides.present(prefetched)),[3,1]);assert.deepEqual(pair(sides.present(card(4,5,'duel'))),[4,5]);
});
test('rank commentary follows the displayed photos when the last winner keeps its side',()=>{
  const {sides}=setup();sides.pick(sides.present(card(1,2,'duel')),'b');
  assert.equal(sides.present(card(2,3,'duel',{commentary:'#12 · #6'})).commentary,'#6 · #12');
  assert.equal(sides.present(card(2,3,'duel',{commentary:'#– · #6'})).commentary,'#6 · #–');
  assert.equal(sides.present(card(3,2,'duel',{commentary:'#6 · #12'})).commentary,'#6 · #12');
  assert.equal(sides.present(card(2,3,'duel',{commentary:'A close match'})).commentary,'A close match');
});
test('undo restores the exact old display despite a freshly randomized replay card',()=>{
  const {sides}=setup();sides.pick(sides.present(card(1,2)),'b');
  const last=sides.present(card(2,3));assert.deepEqual(pair(last),[3,2]);sides.pick(last,'a');
  sides.undo({undone:'mini',cards:[card(2,3,'mini',{id:'new-replay'})]});
  assert.deepEqual(pair(sides.present(card(2,3))),[3,2]);
  assert.equal(sides.state().last.photo,2);assert.equal(sides.state().last.side,'b');
  sides.pick(sides.present(card(2,3)),'b');assert.deepEqual(pair(sides.present(card(2,4))),[4,2]);
});
test('reload retains the last winner while libraries keep independent histories',()=>{
  const first=setup();first.sides.pick(first.sides.present(card(1,2)),'b');
  const next=setup(first.storage);assert.deepEqual(pair(next.sides.present(card(2,3))),[3,2]);
  next.S.lib.source='public-b';assert.deepEqual(pair(next.sides.present(card(2,3))),[2,3]);
  next.sides.pick(next.sides.present(card(7,8)),'a');next.S.lib.source='public-a';
  assert.deepEqual(pair(next.sides.present(card(2,3))),[3,2]);
});
test('failed calls roll back without deleting a later successful winner',()=>{
  const {sides}=setup();sides.pick(sides.present(card(1,2)),'b');
  const failed=sides.pick(sides.present(card(2,3)),'a');
  sides.pick(sides.present(card(4,5)),'b');sides.reject(failed);
  assert.equal(sides.state().last.photo,5);assert.equal(sides.state().history.length,2);
  sides.undo({undone:'mini',cards:[card(5,4)]});assert.equal(sides.state().last.photo,2);
  assert.deepEqual(pair(sides.present(card(5,4))),[4,5]);
});
test('a delayed undo response updates its original library, never the newly opened one',async()=>{
  const context=setup();context.sides.pick(context.sides.present(card(1,2,'duel')),'b');
  let finish;context.fetch=()=>new Promise(resolve=>finish=resolve);
  vm.createContext(context);vm.runInContext(app.slice(app.indexOf('async function api('),app.indexOf('\nlet toastTimer')),context);
  // The helper and API share the same library object, even while the request is in flight.
  context.DuelSides=context.sides;
  const waiting=context.api('/api/undo',{});
  context.S.lib.source='public-b';context.sides.pick(context.sides.present(card(7,8,'duel')),'b');
  finish({ok:true,json:async()=>({undone:'duel',cards:[card(1,2,'duel')]})});await waiting;
  assert.equal(context.sides.state().last.photo,8);assert.equal(context.sides.state().history.length,1);
  context.S.lib.source='public-a';assert.equal(context.sides.state().last,null);assert.equal(context.sides.state().history.length,0);
});
test('non-winning ordinary calls never invent a new winner, and storage remains bounded and optional',()=>{
  const {sides,sessionStorage}=setup();sides.pick(sides.present(card(1,2,'duel')),'b');
  sides.pick(sides.present(card(3,4,'duel')),'skip');assert.equal(sides.state().last.photo,2);
  for(let i=0;i<90;i++)sides.pick(sides.present(card(10+i,200+i,'duel')),'a');
  assert.equal(sides.state().history.length,64);assert(sides.state().base);
  sessionStorage.setItem=()=>{throw Error('storage unavailable');};
  const ticket=sides.pick(sides.present(card(300,301,'duel')),'b');sides.reject(ticket);
  assert.equal(sides.state().last.photo,99);
});
