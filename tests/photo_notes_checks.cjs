const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {PhotoNotes}=require('../matcher/static/photo-notes.js');

beforeEach(()=>{
  global.S={lib:{source:'synthetic-library'}};
  global.Toolbelt={edits:new Map(),save:async(pid,patch)=>Toolbelt.edits.set(pid,patch)};
  PhotoNotes.active=PhotoNotes.sheet=null;PhotoNotes.drafts.clear();
});
const draft=(pid=7,text='A remembered afternoon')=>{
  const active={pid,source:S.lib.source,draft:{title:'The keeper',description:text},dirty:true};
  PhotoNotes.drafts.set(PhotoNotes.draftKey(active),active.draft);return active;
};

test('writing is one atomic save, even after its sheet has closed',async()=>{
  const active=draft();
  assert.equal(await PhotoNotes.saveWriting(active),true);
  assert.deepEqual(Toolbelt.edits.get(7),active.draft);
  assert.equal(active.dirty,false);assert.equal(PhotoNotes.drafts.size,0);
});

test('typing during a slow save commits the latest words after the first acknowledgement',async()=>{
  const active=draft(),writes=[];let release;
  const gate=new Promise(r=>{release=r;});
  Toolbelt.save=async(pid,patch)=>{writes.push({...patch});if(writes.length===1)await gate;Toolbelt.edits.set(pid,patch);};
  const pending=PhotoNotes.saveWriting(active);
  active.draft={...active.draft,description:'The whole story, with the new ending.'};
  PhotoNotes.drafts.set(PhotoNotes.draftKey(active),active.draft);
  const again=PhotoNotes.saveWriting(active);release();
  assert.equal(await pending,true);assert.equal(await again,true);
  assert.equal(writes.length,2);assert.equal(Toolbelt.edits.get(7).description,active.draft.description);
  assert.equal(active.dirty,false);assert.equal(PhotoNotes.drafts.size,0);
});

test('a failed save retains the draft and can retry without erasing the words',async()=>{
  const active=draft();Toolbelt.save=async()=>{}; // The shared editor retains the last confirmed state on failure.
  assert.equal(await PhotoNotes.saveWriting(active),false);
  assert.equal(active.dirty,true);assert.equal(active.writeState,'error');
  assert.equal(PhotoNotes.drafts.get(PhotoNotes.draftKey(active)),active.draft);
  Toolbelt.save=async(pid,patch)=>Toolbelt.edits.set(pid,patch);
  assert.equal(await PhotoNotes.saveWriting(active),true);
  assert.equal(active.writeState,'saved');assert.equal(PhotoNotes.drafts.size,0);
});

test('a library switch never sends an old draft to the new library with the same photo id',async()=>{
  const old=draft();S.lib.source='another-synthetic-library';let writes=0;
  Toolbelt.save=async()=>{writes++;};
  assert.equal(await PhotoNotes.saveWriting(old),false);assert.equal(writes,0);
  const next=draft(7,'A different photo’s story');
  assert.notEqual(PhotoNotes.draftKey(old),PhotoNotes.draftKey(next));assert.equal(PhotoNotes.drafts.size,2);
});

test('holding the original is a reversible preview and preserves the saved finish',()=>{
  const saved={crop:'subject',rotate:90,enhance:true,look:{colour:.6}},calls=[];
  const active={data:{edits:saved},host:{isConnected:true}};
  const preview=PhotoNotes.preview;PhotoNotes.preview=(host,p,edits)=>calls.push(edits);
  try{PhotoNotes.compare(true,active);PhotoNotes.compare(false,active);}
  finally{PhotoNotes.preview=preview;}
  assert.deepEqual(calls[0],{crop:'off',rotate:0,enhance:false});
  assert.equal(calls[1],saved);assert.equal(active.data.edits,saved);
});
