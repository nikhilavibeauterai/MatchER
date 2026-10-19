"use strict";

// A camera keeps the last decoded level visible and permits one upgrade per print. Both kinds of close-up
// use the same stale-response guard and retry, including when a removable drive briefly stops responding.
class PhotoResolution {
  constructor(image,ready=(img,source)=>{img.src=source;},valid=()=>true){
    Object.assign(this,{image,ready,valid,wanted:null,pending:null,retry:null,failures:0,closed:false});
  }
  request(source){
    if(this.closed)return;
    if(source!==this.wanted){this.failures=0;clearTimeout(this.retry);}
    this.wanted=source;this.load();
  }
  load(){
    const img=this.image();
    if(this.closed||!this.valid()||this.pending||!img||img.getAttribute('src')===this.wanted)return;
    clearTimeout(this.retry);
    const source=this.wanted,next=new Image();this.pending=next;next.src=source;
    next.decode().then(()=>{
      const current=this.image();
      if(!this.closed&&this.valid()&&source===this.wanted&&current){this.ready(current,source);this.failures=0;}
    }).catch(()=>{
      if(!this.closed&&this.valid()&&source===this.wanted)this.retry=setTimeout(()=>this.load(),Math.min(8000,750*2**this.failures++));
    }).finally(()=>{
      if(this.pending===next)this.pending=null;
      if(!this.closed&&source!==this.wanted)this.load();
    });
  }
  close(){this.closed=true;clearTimeout(this.retry);if(this.pending)this.pending.src='';this.pending=null;}
}

// Focused prints and the popup own their camera listeners, decoding and teardown here. A stage supplies the
// paper; replacing that stage releases its gestures and pending images before the next one can receive input.
const PhotoCamera={
  active:null,
  release(){this.active?.close();},
  focus(layer,prints=[]) {
  prints=prints.filter(Boolean);
  const signature=prints.map(p=>Toolbelt.pidOf(p)).join(','),old=this.active;
  if(old&&old.layer===layer&&old.signature===signature&&prints.every((p,i)=>p===old.prints[i])){old.still();return;}
  old?.close();
  if(!layer||!prints.length||!World.sea)return;
  const sea=World.sea,events=new AbortController(),{signal}=events,viewSignal=S.events.signal;
  const controls='button,a,input,textarea,select,.photo-notes-paper,.photo-sticky,.user-note,.twin-ask';
  let sourceTimer,closed=false,gestureUntil=0;
  sea.enableCamera(true);sea.hold(null);sea.externalFocus=layer;layer.classList.add('focus-camera');
  if(layer.matches('.deck'))layer.classList.add('camera-deck');
  let previous={...sea.camera},x=0,y=0;
  const photos=prints.map(print=>({print,side:print.closest('.side'),pid:Toolbelt.pidOf(print),item:{el:print,size:print.getBoundingClientRect().width},
    source:new PhotoResolution(()=>print.querySelector('.window img'),(img,source)=>{img.src=source;photoSampling(img,sea.camera.zoom);})}));
  for(const p of photos){const img=p.print.querySelector('.window img');if(img?.complete&&img.naturalWidth)FocusGlow.attach(p.print,img);else img?.addEventListener('load',()=>FocusGlow.attach(p.print,img),{once:true,signal});}
  const unfreeze=p=>{if(!p.pose)return;Object.assign(p.side.style,p.pose);p.pose=null;};
  const cancelCarry=()=>{for(const card of $$('.held',layer))card.dispatchEvent(new Event('pointercancel'));};
  const paint=()=>{
    if(closed||!layer.isConnected)return;
    cancelCarry();
    // Fonts and help can move the deck after it is dealt. Continue from its visible position; scaling the
    // first layout rectangle instead magnifies that drift into a large crop jump at deep zoom.
    const c=sea.camera,r=sea.el.getBoundingClientRect(),base=layer.getBoundingClientRect(),ratio=c.zoom/previous.zoom;
    x=c.zoom===1?0:c.tx-previous.tx*ratio+x+(base.left-r.left)*(ratio-1);
    y=c.zoom===1?0:c.ty-previous.ty*ratio+y+(base.top-r.top)*(ratio-1);
    previous={...c};
    layer.style.transform=c.zoom===1?'':`translate(${x}px,${y}px) scale(${c.zoom})`;
    layer.classList.toggle('zoomed',c.zoom>1.001);
    for(const p of photos){p.print.dataset.viewerZoom=String(c.zoom);photoSampling(p.print.querySelector('.window img'),c.zoom);
      if(c.zoom>1.001){if(p.side&&!p.pose){p.pose={scale:p.side.style.scale,transition:p.side.style.transition};const scale=getComputedStyle(p.side).scale;p.side.style.transition='none';p.side.style.scale=scale;}sea.stillCard(p.item);}else unfreeze(p);}
    FocusGlow.place(layer,prints,c.zoom);
    if(prints.includes(PhotoNotes.active?.host))PhotoNotes.position();
    if(c.zoom<=1.001)sea.resumeCards(true);
    clearTimeout(sourceTimer);sourceTimer=setTimeout(()=>{
      if(closed)return;
      for(const p of photos){const img=p.print.querySelector('.window img');if(!img)continue;const r=p.print.getBoundingClientRect(),picture=img.getBoundingClientRect();
        if(r.right<=0||r.left>=innerWidth||r.bottom<=0||r.top>=innerHeight)continue;
        p.source.request(M(p.pid,Math.max(picture.width,picture.height),r.height>=innerHeight*.8));}
    },120);
  };
  const pointer=e=>{
    if(Toolbelt.tool!=='hand'||e.target.closest(controls)&&!PhotoNotes.panTarget(e.target,e.pointerType))return;
    const pinching=sea.pinch(e);
    if(pinching||e.pointerType==='touch'&&sea.touches.size>1){gestureUntil=performance.now()+600;cancelCarry();e.preventDefault();e.stopImmediatePropagation();return;}
    if(e.type==='pointerdown'&&sea.camera.zoom>1.001&&!e.button){gestureUntil=performance.now()+600;cancelCarry();sea.panStart(e);e.stopImmediatePropagation();}
  };
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])layer.addEventListener(type,pointer,{capture:true,signal});
  layer.addEventListener('click',e=>{if(!e.target.closest(controls)&&(sea.camera.zoom>1.001||performance.now()<gestureUntil)){e.preventDefault();e.stopImmediatePropagation();}},{capture:true,signal});
  layer.addEventListener('dblclick',e=>{if(Toolbelt.tool==='hand'&&!e.target.closest(controls)){e.preventDefault();e.stopPropagation();gestureUntil=performance.now()+350;sea.resetCamera();}},{signal});
  window.addEventListener('sea-camera',e=>{if(e.detail.sea===sea)paint();},{signal});
  window.addEventListener('resize',()=>{sea.resetCamera();for(const p of photos)p.item.size=p.print.getBoundingClientRect().width;},{signal});
  const sizing=new ResizeObserver(entries=>{for(const entry of entries){const p=photos.find(p=>p.print===entry.target);if(p)p.item.size=entry.contentRect.width;}paint();});
  for(const p of photos)sizing.observe(p.print);
  const focus=this.active={layer,prints,signature,still(){if(sea.camera.zoom>1.001)for(const p of photos)sea.stillCard(p.item);},close(){
    if(closed)return;closed=true;cancelCarry();events.abort();sizing.disconnect();viewSignal.removeEventListener('abort',focus.close);clearTimeout(sourceTimer);
    for(const p of photos){p.source.close();delete p.print.dataset.viewerZoom;unfreeze(p);}
    FocusGlow.release(layer,prints);
    layer.style.transform='';layer.classList.remove('focus-camera','camera-deck','zoomed');
    if(sea.externalFocus===layer)sea.externalFocus=null;sea.panEnd();sea.touches.clear();sea.resumeCards(true);sea.resetCamera();
    if(PhotoCamera.active===focus)PhotoCamera.active=null;
  }};
  viewSignal.addEventListener('abort',focus.close,{once:true});paint();
},
  viewer(id,{notes=false}={}) {
  const m = $("#modal");
  m.viewerControls?.abort();
  const events=new AbortController(),{signal}=events;m.viewerControls=events;
  const viewSignal=S.events.signal;
  m.className = "wide photo-viewer";
  m.innerHTML = `<div class="viewer"><div class="viewer-stage" role="region" aria-label="Photo preview. Scroll to zoom; drag to pan when zoomed in."><div class="print"><img src="${T(id)}" alt="" draggable="false"></div></div><div class="viewer-actions">${photoPathButton(id)}<button class="btn" data-viewer-reset hidden>Reset view</button><button class="btn" data-viewer-notes hidden>Notes</button><button class="btn" id="close-modal">Close</button></div></div>`;
  const stage=$('.viewer-stage',m),card=$('.print',stage),img=$('img',card),resetButton=$('[data-viewer-reset]',m),notesButton=$('[data-viewer-notes]',m);
  let zoom=1,x=0,y=0,drag=null,pinch=null,suppressClick=false,sourceTimer=null;
  const touches=new Map(),controls='button,a,input,textarea,select,label,summary,[contenteditable],.grade-wheel,.photo-sticky,.user-note';
  const touchPair=()=>{const [a,b]=touches.values();return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};};
  const source=new PhotoResolution(()=>img,undefined,()=>m.open);
  const requestSource=()=>{
    clearTimeout(sourceTimer);
    sourceTimer=setTimeout(()=>{
      if(signal.aborted||!m.open)return;
      const r=card.getBoundingClientRect(),picture=img.getBoundingClientRect();
      photoSampling(img,zoom);
      source.request(M(id,Math.max(picture.width,picture.height),r.height>=innerHeight*.8));
    },120);
  };
  const paint=()=>{
    card.style.transform=`translate(${x}px,${y}px) scale(${zoom})`;
    if(card.dataset.viewerZoom!==String(zoom)){card.dataset.viewerZoom=String(zoom);photoSampling(img,zoom);}
    stage.classList.toggle('zoomed',zoom>1.001);resetButton.hidden=notesButton.hidden=zoom<=1.001;
    if(PhotoNotes.active?.host===card)PhotoNotes.position();
  };
  const reset=()=>{zoom=1;x=y=0;paint();requestSource();};
  const constrain=()=>{
    const r=card.getBoundingClientRect(),s=stage.getBoundingClientRect(),left=r.left-x,top=r.top-y;
    const bound=(value,lo,hi,base,size)=>size>hi-lo?Math.max(hi-24-base-size,Math.min(lo+24-base,value)):Math.max(lo+8-base,Math.min(hi-8-base-size,value));
    x=bound(x,s.left,s.right,left,r.width);y=bound(y,s.top,s.bottom,top,r.height);
  };
  const zoomAt=(next,cx,cy)=>{
    const r=card.getBoundingClientRect(),ratio=next/zoom;
    x+=(cx-r.left)*(1-ratio);y+=(cy-r.top)*(1-ratio);zoom=next;
    if(zoom<=1.001)reset();else{paint();constrain();paint();}
    requestSource();
  };
  stage.addEventListener('wheel',e=>{
    if(e.target.closest('.photo-notes-paper'))return;
    e.preventDefault();e.stopPropagation();
    const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?stage.clientHeight:1);
    zoomAt(Math.max(1,Math.min(12,zoom*Math.exp(-Math.max(-500,Math.min(500,delta))*.0015))),e.clientX,e.clientY);
  },{passive:false,signal});
  stage.addEventListener('pointerdown',e=>{
    if(e.button||Toolbelt.tool!=='hand'||e.target.closest(controls)||
      e.target.closest('.photo-notes-paper')&&!PhotoNotes.panTarget(e.target,e.pointerType))return;
    if(e.pointerType==='touch'){
      touches.set(e.pointerId,{x:e.clientX,y:e.clientY});stage.setPointerCapture(e.pointerId);
      if(touches.size>=2){pinch=touchPair();drag=null;suppressClick=true;stage.classList.remove('panning');e.preventDefault();e.stopPropagation();return;}
    }
    if(zoom<=1.001)return;
    e.preventDefault();e.stopPropagation();drag={id:e.pointerId,x:e.clientX,y:e.clientY,px:x,py:y,moved:false};
    stage.setPointerCapture(e.pointerId);stage.classList.add('panning');
  },{signal});
  stage.addEventListener('pointermove',e=>{
    if(touches.has(e.pointerId))touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pinch&&touches.size>=2){
      e.preventDefault();e.stopPropagation();const next=touchPair();
      zoomAt(Math.max(1,Math.min(12,zoom*next.d/pinch.d)),pinch.x,pinch.y);
      if(zoom>1.001){x+=next.x-pinch.x;y+=next.y-pinch.y;paint();constrain();paint();}
      pinch=next;return;
    }
    if(!drag||e.pointerId!==drag.id)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.moved||=Math.hypot(dx,dy)>4;
    x=drag.px+dx;y=drag.py+dy;paint();constrain();paint();
  },{signal});
  const release=e=>{
    touches.delete(e.pointerId);
    if(pinch){pinch=null;drag=null;suppressClick=true;stage.classList.remove('panning');if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId);return;}
    if(!drag||e.pointerId!==drag.id)return;
    suppressClick=drag.moved;drag=null;stage.classList.remove('panning');
    if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId);
  };
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,release,{signal});
  stage.addEventListener('dblclick',e=>{if(Toolbelt.tool==='hand'&&!e.target.closest(`${controls},.photo-notes-paper`)){e.preventDefault();e.stopPropagation();reset();}},{signal});
  stage.addEventListener('click',e=>{if(e.target.closest('.photo-notes-tab'))reset();},{capture:true,signal});
  window.addEventListener('resize',reset,{signal});resetButton.onclick=reset;
  notesButton.onclick=()=>{reset();PhotoNotes.open(card);};
  m.onclick = e => {if(suppressClick){suppressClick=false;e.preventDefault();return;}if(!e.target.closest('.print,.viewer-actions,.photo-note-sheet'))m.close();};
  $('#close-modal',m).onclick=()=>m.close();
  const sizes=new ResizeObserver(requestSource);for(const el of [card,img,stage])sizes.observe(el);
  img.addEventListener('load',()=>{
    const state=PhotoNotes.hosts.get(card);if(state?.data)PhotoNotes.preview(card,state.data,Toolbelt.current(id));
    requestSource();
  },{signal});
  // A dialog's close event is queued: reopening it before that event arrives must keep the new viewer alive.
  m.addEventListener('close',()=>{if(!m.open)events.abort();},{signal});
  const leave=()=>{events.abort();if(m.contains(stage)&&m.open)m.close();};
  viewSignal.addEventListener('abort',leave,{once:true});
  signal.addEventListener('abort',()=>{clearTimeout(sourceTimer);sizes.disconnect();source.close();viewSignal.removeEventListener('abort',leave);},{once:true});
  reset();
  m.showModal();
  if(notes){PhotoNotes.attach(card);PhotoNotes.open(card);}
}

};

function openViewer(id,options){return PhotoCamera.viewer(id,options);}
if(typeof module!=='undefined')module.exports={PhotoResolution};
