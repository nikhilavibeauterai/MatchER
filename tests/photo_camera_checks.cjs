const {test}=require('node:test'),assert=require('node:assert/strict');
const {PhotoResolution}=require('../matcher/static/photo-camera.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(){
  const requests=[],previous=global.Image;
  global.Image=class{
    constructor(){requests.push(this);this.result=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});}
    decode(){return this.result;}
  };
  const image={src:'preview',getAttribute(){return this.src;}},loader=new PhotoResolution(()=>image);
  return {image,loader,requests,close(){loader.close();global.Image=previous;}};
}

test('one pending decode follows the newest camera level without showing stale pixels',async()=>{
  const f=fixture();try{
    f.loader.request('original');f.loader.request('medium');f.loader.request('small');
    assert.equal(f.requests.length,1);assert.equal(f.image.src,'preview');
    f.requests[0].resolve();await tick();
    assert.equal(f.image.src,'preview');assert.equal(f.requests.length,2);assert.equal(f.requests[1].src,'small');
    f.requests[1].resolve();await tick();assert.equal(f.image.src,'small');
    f.loader.request('small');assert.equal(f.requests.length,2,'The displayed level needs no extra decode');
  }finally{f.close();}
});

test('a paused original retries without another gesture, retaining the decoded preview',async()=>{
  const f=fixture();try{
    f.loader.request('original');f.requests[0].reject(new Error('Drive busy'));await tick();
    assert.equal(f.image.src,'preview');
    await new Promise(resolve=>setTimeout(resolve,790));
    assert.equal(f.requests.length,2);f.requests[1].resolve();await tick();assert.equal(f.image.src,'original');
  }finally{f.close();}
});

test('closing a camera rejects late decoding and later requests',async()=>{
  const f=fixture();try{
    f.loader.request('original');f.loader.close();f.requests[0].resolve();await tick();
    f.loader.request('other');assert.equal(f.image.src,'preview');assert.equal(f.requests.length,1);
  }finally{f.close();}
});

test('leaving after a failed upgrade cancels its scheduled retry',async()=>{
  const f=fixture();try{
    f.loader.request('original');f.requests[0].reject(new Error('Drive busy'));await tick();f.loader.close();
    await new Promise(resolve=>setTimeout(resolve,790));
    assert.equal(f.requests.length,1);assert.equal(f.image.src,'preview');
  }finally{f.close();}
});
