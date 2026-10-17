// ---------------------------------------------------------------- the photo sea: pictures floating into order
// Photo interaction and rendering live here; the worker owns motion and contour geometry.
class PhotoSea {
  constructor(el, { onDrop, onSelect } = {}) {
    this.el = el;
    this.onDrop = onDrop; this.onSelect = onSelect;
    this.items = new Map();
    this.moving = [];
    // Tunable parameters (sea-tuning.js), with any values a developer-panel session saved in this browser.
    this.tuning = seaTuningDefaults();
    try {
      const saved = JSON.parse(localStorage.getItem("matcher-sea-tuning") || "null"), t = saved?.tuning || {};
      if ((saved?.version || 1) < 2) delete t.zoomMax;  // the camera reaches much further now: a cap saved by the old panel would hold it back
      if((saved?.version||1)<3)for(const [key,old]of Object.entries({margin:.25,domLimit:1000,liveMin:22,dotLod:6}))if(t[key]===old)delete t[key];
      Object.assign(this.tuning, t);
    } catch (_) { /* no saved tuning */ }
    if (typeof Cards !== "undefined") Cards.tune(this.tuning);
    this.domLimit = this.liveCap();
    this.mouse = { x: -1e5, y: -1e5, vx: 0, vy: 0 };
    this.s = 72; this.raf = 0; this.last = 0; this.drag = null; this.hover = null; this.alive = true;
    this.events = new AbortController();
    el.classList.add("photo-sea");
    // The sea has a camera: prints sit in world units on one layer that pans and zooms as a whole. At zoom 1
    // the world is the viewport, so everything fits; zooming in is how you explore.
    this.layer=document.createElement("div");this.layer.className="sea-layer";el.append(this.layer);
    this.camera={zoom:1,tx:0,ty:0};this.cameraOn=false;this.pan=null;this.touches=new Map();
    el.addEventListener("pointermove", (e) => this.pointer(e), {signal:this.events.signal});
    el.addEventListener("pointerleave", () => { if (!this.drag) this.mouse.x = this.mouse.y = -1e5; }, {signal:this.events.signal});
    el.addEventListener("pointerdown", (e) => this.down(e), {signal:this.events.signal});
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(el);
  }
  destroy() { this.alive = false;for(const it of this.items.values())this.cancelImage(it);this.events.abort(); this.ro.disconnect(); cancelAnimationFrame(this.raf); }
  local(e) { const r = this.el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  toWorld(sx,sy){const c=this.camera;return [(sx-c.tx)/c.zoom,(sy-c.ty)/c.zoom];}
  toScreen(x,y){const c=this.camera;return [x*c.zoom+c.tx,y*c.zoom+c.ty];}
  screenX(x){return x*this.camera.zoom+this.camera.tx;}
  worldX(sx){return (sx-this.camera.tx)/this.camera.zoom;}
  localWorld(e){const [sx,sy]=this.local(e);return this.toWorld(sx,sy);}
  enableCamera(on){this.cameraOn=!!on;this.resetCamera();}
  // Bound independent image elements. A deliberate tuning override stands; smaller devices can lower the default.
  liveCap(){const auto=(navigator.deviceMemory||4)*(innerWidth<760?60:250),set=this.tuning.domLimit;return Math.max(40,set===seaTuningDefaults().domLimit?Math.min(set,auto):set);}
  bigCap(){return this.domLimit;}
  // Texture slots are square; their photo's aspect belongs to the card, never to padding baked into the atlas.
  atlasCell(img,index,dims){
    const x=index%50*16,y=Math.floor(index/50)*16;
    return {img,x,y,aspect:dims?.[0]&&dims?.[1]?dims[0]/dims[1]:1};
  }
  // A live sea print keeps the same paper and picture while it is hovered, dragged or focused. Only its
  // resolution changes. Framing and enhancement happen on decode or an edit, never on a camera frame.
  frameImage(it){
    if(this.el.id!=='world')return;
    const img=it.el.querySelector('.pile-cover');if(!img?.naturalWidth)return;
    const old=img.getAnimations().find(a=>a.animationName==='cardwobble'),time=old?.currentTime;
    it.el.dataset.photo=it.photo;Cards.focus(it.el);
    const paper=it.el.querySelector(':scope > .paper');
    if(time!=null){const motion=paper.getAnimations().find(a=>a.animationName==='cardwobble');if(motion)motion.currentTime=time;}
    const edits=typeof Toolbelt!=='undefined'&&Toolbelt.source===S.lib?.source?Toolbelt.current(it.photo):{};
    const size=(it.size||this.s)*this.camera.zoom;it.el.classList.toggle('is-tiny',size<this.tuning.tinyMax);it.el.classList.toggle('is-small',size<this.tuning.badgeMin);
    Object.assign(it.el.dataset,{frame:'own',box:JSON.stringify(it.box||null),crop:edits.crop??'',cropDefault:'global',
      rotate:String(edits.rotate||0),enhance:edits.enhance==null?'':edits.enhance?'on':'off',look:JSON.stringify(edits.look||null)});
    const dims=it.dims?.[0]>0&&it.dims?.[1]>0?it.dims:[img.naturalWidth,img.naturalHeight];
    framePhoto(it.el,{dims,box:it.box},
      {crop:edits.crop??S.crop,rotate:edits.rotate||0,enhance:edits.enhance??S.filter,knobs:edits.look?knobsOf(edits.look):null});
  }
  // Keep the atlas print visible until its replacement has decoded. A slow or failed preview must not leave a hole.
  watchImage(it){
    const img=it.el.querySelector('.pile-cover');if(!img)return;
    this.cancelImage(it);
    const valid=()=>this.alive&&this.items.get(it.id)===it&&!it.density&&it.el.querySelector('.pile-cover')===img;
    const pending=on=>{if(!valid())return;it.imagePending=on;it.el.classList.toggle('image-pending',on);this.densityDirty=this.spritesDirty=true;this.paintSoon?.();this.kick();
      if(!on&&this.el.id==='world'&&this.cameraOn&&this.fullSize(it))window.dispatchEvent(new Event('sea-image-ready'));};
    const ready=()=>{const source=img.currentSrc||img.src;img.decode().then(()=>{
      if(valid()&&(img.currentSrc||img.src)===source&&img.naturalWidth){this.frameImage(it);pending(false);}
    }).catch(()=>{});};
    img.addEventListener('load',ready);img.addEventListener('error',()=>pending(true));
    it.imagePending=true;it.el.classList.add('image-pending');
    if(img.complete&&img.naturalWidth)ready();
  }
  cancelImage(it){clearTimeout(it.imageRetry);it.imageRetry=null;if(it.imageRequest)it.imageRequest.img.src='';it.imageRequest=null;it.wantedImage=null;}
  requestImage(it,source,attempt=0){
    const img=it.el.querySelector('.pile-cover');if(!img)return;
    if(it.wantedImage!==source){clearTimeout(it.imageRetry);it.imageRetry=null;it.wantedImage=source;}
    if(it.imageRequest||it.imageRetry||img.getAttribute('src')===source&&(!img.complete||img.naturalWidth))return;
    // The visible picture changes only after decoding. A failed original must not replace a good preview with
    // an atlas cell, and rapid camera changes share one pending image instead of decoding each intermediate size.
    const next=new Image(),task={img:next,source};it.imageRequest=task;next.src=source;
    const valid=()=>this.alive&&this.items.get(it.id)===it&&!it.density&&it.el.querySelector('.pile-cover')===img;
    next.decode().then(()=>{
      if(valid()&&it.wantedImage===source)img.src=source;
    }).catch(()=>{
      if(valid()&&it.wantedImage===source&&source.includes('m=full')&&attempt<2){
        it.imageRetry=setTimeout(()=>{
          it.imageRetry=null;const c=this.camera,W=this.el.clientWidth,H=this.el.clientHeight;
          if(valid()&&it.wantedImage===source&&this.fullSize(it)&&this.inView(it,-c.tx/c.zoom,-c.ty/c.zoom,(W-c.tx)/c.zoom,(H-c.ty)/c.zoom,0))this.requestImage(it,source,attempt+1);
        },400*(attempt+1));
      }
    }).finally(()=>{
      if(it.imageRequest===task)it.imageRequest=null;
      if(valid()&&it.wantedImage!==source)this.requestImage(it,it.wantedImage);
    });
  }
  // Live tuning: the worker, the print size and the camera limits all read the new values at once.
  tune(values,persist=true){
    Object.assign(this.tuning,values||{});
    if(persist){try{localStorage.setItem("matcher-sea-tuning",JSON.stringify({version:3,tuning:this.tuning}));}catch(_){}}
    this.domLimit=this.liveCap();
    this.worker?.postMessage({kind:"tune",values:this.tuning});if(typeof Cards!=="undefined")Cards.tune(this.tuning);this.layout();this.kick();
  }
  tuneReset(){this.tuning=seaTuningDefaults();try{localStorage.removeItem("matcher-sea-tuning");}catch(_){}this.tune({},false);}
  setCamera(zoom,tx,ty){
    const W=this.el.clientWidth,H=this.el.clientHeight,z=Math.max(1,Math.min(this.tuning.zoomMax,zoom)),c=this.camera;
    // Zoomed in, the camera may overshoot the sea's edge by half a view, so a print at the edge can sit under the
    // pointer (and in the middle of the screen) while you zoom into it.
    const sx=z>1?W/2:0,sy=z>1?H/2:0;
    c.zoom=z;c.tx=Math.min(sx,Math.max(W*(1-z)-sx,tx));c.ty=Math.min(sy,Math.max(H*(1-z)-sy,ty));
    this.layer.style.transform=z===1&&!c.tx&&!c.ty?'':`translate(${c.tx.toFixed(2)}px,${c.ty.toFixed(2)}px) scale(${z.toFixed(4)})`;this.el.style.setProperty('--zoom',z.toFixed(4));
    this.el.dataset.zoom=z.toFixed(2);this.followCamera();this.scheduleCull();
    // Both renderers draw only the current viewport. Camera movement never changes a print's paint order.
    this.densityDirty=true;this.paintSoon();
    // Zoomed in until one print fills the view, the sea is a picture: physics and wobble stop, the chrome hides
    // (the wheel and a drag still work), everything returns on the way out.
    const deep=z>=3&&this.el.id==='world'&&this.oneInView(W,H);
    if(deep!==!!this.deep){this.deep=deep;document.body.classList.toggle('sea-deep',deep);this.el.dataset.deep=deep?'1':'';if(deep)this.deepSource();else this.kick();}
    this.worker?.postMessage({kind:'view',rect:z===1?null:{x0:-c.tx/z,y0:-c.ty/z,x1:(W-c.tx)/z,y1:(H-c.ty)/z}});  // physics only for what is on screen
    window.dispatchEvent(new CustomEvent('sea-camera',{detail:{sea:this,zoom:z}}));this.kick();
  }
  resetCamera(){const c=this.camera;if(c.zoom!==1||c.tx||c.ty)this.setCamera(1,0,0);}
  // The lasso raster follows the camera by transform while it moves (its lines a touch thick for a moment) and is
  // drawn crisp again once the camera rests: a wheel zoom is never sixty tessellations a second.
  followCamera(){
    const r=this.contourRaster,c=this.camera;
    if(!r?.cam||!this.canvas){this.geometryAt=0;return;}
    const k=c.zoom/r.cam.zoom;this.canvas.style.transformOrigin='0 0';this.canvas.style.transform=`translate(${(c.tx-r.cam.tx*k).toFixed(2)}px,${(c.ty-r.cam.ty*k).toFixed(2)}px) scale(${k.toFixed(5)})`;
    clearTimeout(this.contourTimer);this.contourTimer=setTimeout(()=>{this.contourTimer=0;if(this.alive&&this.el.isConnected)this.draw(this.width||this.el.clientWidth,this.height||this.el.clientHeight);},150);
  }
  // Whether at most one print's card touches the view (sea coordinates).
  oneInView(W,H){
    const c=this.camera,x0=-c.tx/c.zoom,y0=-c.ty/c.zoom,x1=x0+W/c.zoom,y1=y0+H/c.zoom;let n=0;
    for(const it of this.items.values()){if(it.take)continue;const s=it.size||this.s;
      if(it.x+s/2>x0&&it.x-s/2<x1&&it.y+s*2/3>y0&&it.y-s*2/3<y1&&++n>1)return false;}
    return n<=1;
  }
  zoomAt(factor,sx,sy){const c=this.camera,z=Math.max(1,Math.min(this.tuning.zoomMax,c.zoom*factor)),k=z/c.zoom;this.setCamera(z,sx-(sx-c.tx)*k,sy-(sy-c.ty)*k);}
  // Capture the custom pan so native dragging cannot cancel it. A pointer that never travels is a click.
  panStart(e){if(!this.cameraOn||this.pan||(e.button&&e.button!==1))return;e.preventDefault();this.el.setPointerCapture(e.pointerId);const c=this.camera;this.pan={id:e.pointerId,x0:e.clientX,y0:e.clientY,tx:c.tx,ty:c.ty,moved:false};}
  // Over-zoomed: the print under the pointer, frame and all, takes three quarters of the screen's height or more
  // (a click's zoom lands at four fifths, safely past it, so the drag that follows pans rather than grabs).
  overZoomed(target){
    const el=target?.closest?.('.ps-item'),it=el&&this.items.get(Number(el.dataset.id));
    return !!it&&(it.size||this.s)*4/3*this.camera.zoom>=.75*this.el.clientHeight;
  }
  // A print whose card fills four fifths of the screen's height or more shows the original file (the owner's rule);
  // at most a couple of prints can at once, so the originals stay bounded.
  fullSize(it){return (it.size||this.s)*4/3*this.camera.zoom>=.8*this.el.clientHeight-.5;}  // tolerate subpixel rounding at the click's exact 80% destination
  // Deep in one print the physics tick (which refreshes a live print's picture) stops, so that print, promoted if
  // it was a sprite, is given its original here.
  deepSource(){
    const W=this.el.clientWidth,H=this.el.clientHeight,c=this.camera,x0=-c.tx/c.zoom,y0=-c.ty/c.zoom,x1=x0+W/c.zoom,y1=y0+H/c.zoom;
    for(const it of this.items.values()){
      if(it.take||!this.inView(it,x0,y0,x1,y1,0))continue;
      if(it.density)this.promote(it.id,false);
      this.requestImage(it,M(it.photo,(it.size||this.s)*c.zoom,this.fullSize(it)));
      return;
    }
  }
  // Whether a print's card reaches into the view (sea coordinates) widened by pad.
  inView(it,x0,y0,x1,y1,pad){const s=it.size||this.s;return it.x+s/2>x0-pad&&it.x-s/2<x1+pad&&it.y+s*2/3>y0-pad&&it.y-s*2/3<y1+pad;}
  // A drag on an over-zoomed print pans the camera, like dragging the water (a print that fills the screen is not
  // being rearranged); the middle button pans at any zoom.
  panAnywhere(e){return this.cameraOn&&(e.button===1||this.overZoomed(e.target))&&!e.target.closest('button,a,input,textarea,.ps-badge,.ps-stack');}
  // A click on a print zooms in until its card fills four fifths of the height, centred; a short glide there.
  zoomToPrint(it){
    const W=this.el.clientWidth,H=this.el.clientHeight,size=(it.size||this.s)*4/3,z=Math.max(1,Math.min(this.tuning.zoomMax,.8*H/size));
    const from={...this.camera},to={zoom:z,tx:W/2-it.x*z,ty:H/2-it.y*z},start=performance.now(),ms=reduceMotion?0:320;
    const step=now=>{const t=ms?Math.min(1,(now-start)/ms):1,k=1-Math.pow(1-t,3);
      // Zoom blends geometrically so the glide feels even from 1× to 100×; the pan follows linearly.
      const zoom=from.zoom*Math.pow(to.zoom/from.zoom,k);this.setCamera(zoom,from.tx+(to.tx-from.tx)*k,from.ty+(to.ty-from.ty)*k);
      if(t<1)requestAnimationFrame(step);};
    requestAnimationFrame(step);
  }
  panMove(e){const p=this.pan;if(!p||e.pointerId!==p.id)return false;const dx=e.clientX-p.x0,dy=e.clientY-p.y0;if(!p.moved&&Math.hypot(dx,dy)<4)return true;
    if(!p.moved){p.moved=true;document.body.classList.add('sea-panning');}this.setCamera(this.camera.zoom,p.tx+dx,p.ty+dy);return true;}
  panEnd(e){const p=this.pan;if(!p||e&&e.pointerId!==p.id)return;this.pan=null;if(this.el.hasPointerCapture(p.id))this.el.releasePointerCapture(p.id);document.body.classList.remove('sea-panning');if(p.moved)this.pannedAt=performance.now();}
  // Two fingers zoom about their midpoint and carry the camera with them.
  pinch(e){
    const t=this.touches;if(e.pointerType!=='touch'||!this.cameraOn)return false;
    if(e.type==='pointerdown')t.set(e.pointerId,{x:e.clientX,y:e.clientY});
    else if(e.type==='pointermove'&&t.has(e.pointerId)){
      const before=[...t.values()],was=t.get(e.pointerId);t.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(t.size===2){const now=[...t.values()],d0=Math.hypot(before[0].x-before[1].x,before[0].y-before[1].y),d1=Math.hypot(now[0].x-now[1].x,now[0].y-now[1].y);
        const r=this.el.getBoundingClientRect(),mx=(now[0].x+now[1].x)/2-r.left,my=(now[0].y+now[1].y)/2-r.top,px=(before[0].x+before[1].x)/2-r.left,py=(before[0].y+before[1].y)/2-r.top;
        if(d0>0)this.zoomAt(d1/d0,mx,my);this.setCamera(this.camera.zoom,this.camera.tx+mx-px,this.camera.ty+my-py);this.panEnd();return true;}
      if(was&&t.size>2)return true;
    }else if(e.type==='pointerup'||e.type==='pointercancel')t.delete(e.pointerId);
    return false;
  }
  // Scrollable panels, controls and prints keep their own wheel and clicks; only open water takes the camera.
  uiTarget(target,overPrints=false){
    if(!target||!(target instanceof Element))return false;
    if(overPrints&&target.closest('.ps-item')&&!target.closest('.inspect,dialog'))return false;
    if(target.closest('button,a,input,select,textarea,dialog,.side,.tile,.pop-card,.screen-head,.screen-bar,.screen-rail,.vn-catalog,[data-solid],.ps-item,.inspect,.menu-list,.gt-rows,.bins,.sections,.lookgrid,.filter-review-controls,.filter-catalogue,.filter-line,.filter-boundary,.filter-spotlight'))return true;
    for(let el=target;el&&el!==document.body;el=el.parentElement){const o=getComputedStyle(el).overflowY;if((o==='auto'||o==='scroll')&&el.scrollHeight>el.clientHeight+1)return true;}
    return false;
  }
  // The cull runs once the camera has rested a moment (and at least every 400 ms while it keeps moving): the GPU
  // sprites carry a zoom in flight, and cards come up live where it stops.
  scheduleCull(force=false){
    this.cullForce=this.cullForce||force;if(!force&&this.camera.zoom===1&&!this.culled)return;
    const now=performance.now();this.cullSince=this.cullSince||now;
    clearTimeout(this.cullTimer);
    this.cullTimer=setTimeout(()=>{this.cullTimer=null;this.cullSince=0;const f=this.cullForce;this.cullForce=false;if(this.alive)this.cull(f);},Math.max(0,Math.min(150,400-(now-this.cullSince))));
  }
  // The bounded live set (prints with an image element of their own) is what you work with plus the prints on
  // screen big enough to need a real picture; every other print is an atlas sprite, a thumbnail at any size.
  cull(force=false){
    const c=this.camera,W=this.el.clientWidth,H=this.el.clientHeight;
    if(!force&&c.zoom===1&&!this.culled)return;this.culled=c.zoom!==1;
    const x0=-c.tx/c.zoom,y0=-c.ty/c.zoom,x1=x0+W/c.zoom,y1=y0+H/c.zoom,pad=0;
    const keep=it=>it.focused||it.selected||!it.density&&(it.id===this.held||!!this.drag?.members.has(it)||it.el.classList.contains('lifted'));
    const liveMin=this.tuning.liveMin??22;
    const visible=[...this.items.values()].filter(it=>!it.take&&this.inView(it,x0,y0,x1,y1,pad)&&(keep(it)||(it.size||this.s)*c.zoom>=liveMin*(it.density?1:.85))).sort((a,b)=>Number(keep(b))-Number(keep(a))||Number(this.inView(b,x0,y0,x1,y1,0))-Number(this.inView(a,x0,y0,x1,y1,0))||Number(a.density)-Number(b.density)||(b.size||0)-(a.size||0));
    const wanted=new Set(visible.slice(0,this.domLimit).map(it=>it.id));for(const it of this.items.values())if(keep(it))wanted.add(it.id);
    let changed=false,more=false,budget=this.tuning.promoteBudget??80;
    for(const it of this.items.values()){
      if(it.take)continue;
      const want=wanted.has(it.id);
      // Prints come up live a few dozen per pass (each is an element and a picture to fetch) and the rest stay
      // sprites until the next pass, so a deep zoom never stalls a frame.
      if(want&&it.density){if(budget<=0){more=true;continue;}budget--;it.density=false;it.el.innerHTML=`<img class="pile-cover" src="${M(it.photo,(it.size||this.s)*c.zoom)}" alt="" draggable="false">${pilePhotos(it.photo,it.members,it.n)}${it.badge?`<span class="ps-badge">${esc(it.badge)}</span>`:""}`;it.imageKey=imageKey();this.watchImage(it);this.layer.append(it.el);this.paintItem?.(it,true);changed=true;}
      else if(!want&&!it.density&&!keep(it)){it.density=true;this.cancelImage(it);this.smallPreview(it);it.el.replaceChildren();it.el.remove();changed=true;}
      // A live print on screen carries the pyramid level its size needs, both ways as the camera moves; off screen
      // it keeps what it has. One filling four fifths of the screen gets the original file.
      if(!it.density&&this.inView(it,x0,y0,x1,y1,pad))this.requestImage(it,M(it.photo,(it.size||this.s)*c.zoom,this.fullSize(it)));
    }
    if(changed){this.moving=[...this.items.values()].filter(it=>!it.density);this.densityDirty=this.spritesDirty=true;this.el.dataset.density=this.items.size-this.moving.length;this.presentation?.follow();this.kick();}
    if(more)this.scheduleCull(force);
  }
  // Filter's divider and its homes share this fixed axis in sea-local coordinates.
  outcomeX(score) { return (this.width||this.el.clientWidth)*(.08+.84*Math.max(0,Math.min(1,score))); }
  outcomeScore(x) { return Math.max(0,Math.min(1,(x/(this.width||this.el.clientWidth)-.08)/.84)); }
  pointer(e) {
    const [x, y] = this.localWorld(e), m = this.mouse;
    if (m.x > -1e4) { m.vx = m.vx * 0.5 + (x - m.x) * 0.5; m.vy = m.vy * 0.5 + (y - m.y) * 0.5; }
    m.x = x; m.y = y;
    if (this.drag) {
      const d = this.drag;
      if (!d.moving && Math.hypot(x - d.x0, y - d.y0) > 6 / this.camera.zoom) { d.moving = true; d.items.forEach((it) => it.el.classList.add("dragging")); }
      if (d.moving) {
        d.items.forEach((it, k) => { it.x = x + (k ? Math.cos(k * 2.4) * this.s * 0.35 : 0); it.y = y + (k ? Math.sin(k * 2.4) * this.s * 0.35 : 0); it.vx = it.vy = 0; this.paintItem?.(it); });
        const bin = this.binAt(e);
        $$(".bin.hot").forEach((b) => b !== bin && b.classList.remove("hot"));
        if (bin) { bin.classList.add("hot"); this.mark(null); } else this.mark(this.target(x, y, d.items));
      }
    }
    this.kick();
  }
  down(e, photo) {
    if(this.drag)return;
    if(this.panAnywhere(e)){this.panStart(e);return;}  // over-zoomed (or the middle button): the drag pans the camera instead
    const el = photo || e.target.closest(".ps-item");
    if (!el || e.button > 0) return;
    const it = this.items.get(Number(el.dataset.id));
    if (!it) return;
    e.preventDefault();
    const [x, y] = this.localWorld(e);
    const group = it.selected ? [...this.items.values()].filter((o) => o.selected) : [it];
    // Selecting several takes still grabs one physical stack, with one pin and one eventual edit.
    const grabbed=this.items.get(it.stack)||it,bodies=new Map([[grabbed.id,grabbed]]);
    for(const photo of group){const rep=this.items.get(photo.stack)||photo;bodies.set(rep.id,rep);}
    const items=[...bodies.values()];
    items.forEach(o=>this.catchItem?.(o));
    this.drag = { items, members:new Set(items), original:items.map(o=>({id:o.id,x:o.x,y:o.y})), x0: x, y0: y, moving: false };
    this.el.setPointerCapture(e.pointerId);
    const up = (ev) => {
      this.el.removeEventListener("pointerup", up);
      this.el.removeEventListener("pointercancel", up);
      this.el.removeEventListener("lostpointercapture", up);
      const d = this.drag;
      if(!d)return;
      if(ev.type!=='pointerup'){
        for(const p of d.original){const item=this.items.get(p.id);if(item){item.x=p.x;item.y=p.y;item.el.classList.remove('dragging');}}
        this.drag=null;this.released?.(d.items);this.mark(null);$$(".bin.hot").forEach(b=>b.classList.remove('hot'));return;
      }
      const bin = d.moving ? this.binAt(ev) : null;  // (while the dragged photo still lets the pointer through)
      const [ux, uy] = this.localWorld(ev), t = d.moving && !bin ? this.target(ux, uy, d.items) : null;
      this.drag = null;
      if(d.moving)this.released?.(d.items);
      this.mark(null);
      d.items.forEach((o) => o.el.classList.remove("dragging"));
      // On the map a click zooms to the print (a double-click grabs it); elsewhere a click selects it.
      if (!d.moving) { if (this.el.id === 'world' && this.cameraOn) this.zoomToPrint(it); else if (this.onSelect) this.onSelect(it, ev); return; }
      $$(".bin.hot").forEach((b) => b.classList.remove("hot"));
      if (bin) { if (this.onDrop) this.onDrop(d.items.map((o) => o.id), { kind: "bin", id: bin.dataset.bin }); this.kick(); return; }
      if (t.kind === "sea") d.items.forEach((o) => { o.hx = ux + (Math.random() - 0.5) * this.s; o.hy = uy + (Math.random() - 0.5) * this.s; });
      if (this.onDrop) this.onDrop(d.items.map((o) => o.id), t);
      this.kick();
    };
    this.el.addEventListener("pointerup", up, {signal:this.events.signal});
    this.el.addEventListener("pointercancel", up, {signal:this.events.signal});
    this.el.addEventListener("lostpointercapture", up, {signal:this.events.signal});
  }
  // A group's bin in the side list under the pointer (a drag can leave the field to drop a photo on one).
  binAt(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && !this.el.contains(el) ? el.closest("[data-bin]") : null;
  }
  // Photos in, photos out (gone ones fade where they are), and each one's picture, stack count and group badge.
  syncItems(items, partial = false) {
    if(!partial&&!items.length){this.spawnHomes?.clear();this.freshTags?.clear();}
    const keep = new Set(items.map((x) => x.id));
    for (const [id, it] of this.items) {
      if (partial || keep.has(id)) continue;
      it.el.classList.add("leaving");  // stacked into another photo, or gone: it fades where it is
      this.cancelImage(it);
      setTimeout(() => it.el.remove(), 500);
      this.items.delete(id);
    }
    const key = imageKey(), repaint = new Set(), fresh = new Set();
    for (const x of items) {
      let it = this.items.get(x.id);
      if (!it) {
        fresh.add(x.id);
        const [sx, sy] = this.spawn(x);
        it = { id: x.id, x: sx, y: sy, vx: 0, vy: 0, ph: Math.random() * 6.28, w: 0.3 + Math.random() * 0.4, sel: false };
        it.el = document.createElement("div");
        it.el.className = "ps-item entering";
        it.el.dataset.id = x.id;
        it.el.tabIndex = -1;
        it.el.setAttribute("role", "button");
        it.el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.onSelect?.(it, e); } };
        setTimeout(() => it.el.classList.remove("entering"), 30);
        this.items.set(x.id, it);
      }
      if (it.photo !== x.photo || it.imageKey !== key || it.n !== x.n || it.badge !== (x.badge || "")) repaint.add(it.id);
      it.el.classList.toggle("stacked", x.n > 1);
      it.el.classList.toggle("set-aside", !!x.cut);
      it.el.classList.toggle("take", !!x.take);
      it.el.setAttribute("aria-label", x.title || "Photo");
      it.el.title = x.title || "";
      it.photo = x.photo; it.n = x.n; it.badge = x.badge || "";
      this.adopt(it, x);
    }
    // Budget across the retained collection before creating images. A small tag update must not promote its whole batch.
    // A big sea keeps the same cap the frames enforce, so a full set never raises 400 prints only to drop 240 again.
    // Use the complete collection's footprint before choosing renderers. The constructor's provisional size
    // would briefly promote hundreds of cards, then replace them with tiny sprites after the first layout.
    if(this.el.id==='world')this.homes(this.el.clientWidth,this.el.clientHeight);
    const all = [...this.items.values()].sort((a,b)=>(a.stack||a.id)-(b.stack||b.id)||Number(b.take)-Number(a.take)||a.id-b.id),dom=new Set(),dragged=new Set(this.drag?.items||[]);
    const c=this.camera,W=this.el.clientWidth,H=this.el.clientHeight,onScreen=it=>this.inView(it,-c.tx/c.zoom,-c.ty/c.zoom,(W-c.tx)/c.zoom,(H-c.ty)/c.zoom,0);
    // A stack's takes stay under its cover even when their atlas sheets differ or its cover becomes live.
    this.paintOrder=all;all.forEach((it,i)=>{it.order=i+1;});
    const limit = this.items.size > 400 ? this.bigCap() : this.domLimit;
    for (const it of all) if (!it.take && dom.size < limit && (it.focused || !it.density &&
      (it.selected || it.id === this.held || dragged.has(it) || it.el.classList.contains('lifted')))) dom.add(it.id);
    // A partial update keeps the live set as it is; only what just arrived may come up live (it is what you watch).
    if (partial) { const zoom = this.camera?.zoom || 1, liveMin = this.tuning.liveMin ?? 22;
      for (const it of all) if (!it.take && onScreen(it) && dom.size < limit && (fresh.has(it.id) && (it.size || this.s) * zoom >= liveMin || (!it.density && it.el.isConnected))) dom.add(it.id); }
    // Otherwise the prints big enough on screen to need a real picture, largest first, up to the cap. Smaller ones
    // are atlas sprites (a thumbnail at any size, free on the GPU), so a big sea at rest has no live cards at all.
    else { const zoom = this.camera?.zoom || 1, liveMin = this.tuning.liveMin ?? 22;
      for (const it of all.filter((it) => !it.take && !dom.has(it.id) && onScreen(it) && (it.size || this.s) * zoom >= liveMin).sort((a, b) => (b.size || this.s) - (a.size || this.s))) { if (dom.size >= limit) break; dom.add(it.id); } }
    this.moving = [];
    for (const it of all) {
      const density = !dom.has(it.id);
      if (density) {
        if (!it.density) { this.cancelImage(it);this.smallPreview(it); it.el.replaceChildren(); it.el.remove(); }
      } else {
        if (!it.el.isConnected) { this.layer.append(it.el); repaint.add(it.id); }
        if (repaint.has(it.id)) {
          it.el.innerHTML = `<img class="pile-cover" src="${M(it.photo,(it.size||this.s)*(this.camera?.zoom||1))}" alt="" draggable="false">${it.take ? "" : pilePhotos(it.photo,it.members,it.n)}${it.badge
            ? `<span class="ps-badge">${esc(it.badge)}</span>` : ""}`;
          it.imageKey = key;
          this.watchImage(it);
        }
        this.moving.push(it);
      }
      it.density = density;
    }
    this.el.dataset.photos = this.items.size;
    this.el.dataset.density = this.items.size - this.moving.length;
    this.presentation?.follow();
    this.densityDirty=this.spritesDirty=true;
    if(this.camera.zoom>1)this.scheduleCull();
  }
  smallPreview(it) {
    const img = it.el.querySelector(".pile-cover, img:not(.under)");
    if (!img || it.preview || this.sprites?.has(it.id)) return;  // its atlas cell serves; a copy would decode the whole picture
    const copy = () => {
      if(!this.alive||!img.naturalWidth)return;
      const index=this.previewCount||0;this.previewCount=index+1;this.previewPages=this.previewPages||[];
      const page=Math.floor(index/1000),slot=index%1000;
      let canvas=this.previewPages[page];if(!canvas){canvas=document.createElement('canvas');canvas.width=800;canvas.height=320;this.previewPages[page]=canvas;}
      const cell=this.atlasCell(canvas,slot,[img.naturalWidth,img.naturalHeight]);
      canvas.getContext('2d').drawImage(img,cell.x,cell.y,16,16);it.preview=cell;
      this.previewVersions=this.previewVersions||new WeakMap();this.previewVersions.set(canvas,(this.previewVersions.get(canvas)||0)+1);
      this.densityDirty=this.spritesDirty=true;this.kick();
    };
    if (img.complete) copy(); else img.addEventListener("load",copy,{once:true});
  }
  promote(id, relayout=true) {
    let it = this.items.get(Number(id));
    if(it?.take)it=this.items.get(it.stack)||it;
    if (!it || !it.density) return it;
    const eligible=x=>!x.focused&&x.id!==this.held&&!this.drag?.members.has(x)&&!x.el.classList.contains('lifted');
    const old = this.moving.length>=this.domLimit ? this.moving.find(x=>eligible(x)&&!x.selected) || this.moving.find(eligible) : null;  // room is made only at the cap
    if (old) { old.density = true;this.cancelImage(old);this.smallPreview(old); old.el.remove(); old.el.replaceChildren(); }
    it.density = false; it.el.innerHTML = `<img class="pile-cover" src="${M(it.photo,(it.size||this.s)*(this.camera?.zoom||1))}" alt="" draggable="false">${it.take ? "" : pilePhotos(it.photo,it.members,it.n)}`;
    this.layer.append(it.el); this.moving = [...this.items.values()].filter((x) => !x.density);
    this.watchImage(it);this.densityDirty=this.spritesDirty=true;
    this.paintItem?.(it,true);
    this.presentation?.follow();
    if(relayout)this.layout(); return it;
  }
  // Light up some photos (a group or a suggestion you're pointing at) and dim the rest; null clears it.
  highlight(ids) {
    const on = ids ? new Set(ids) : null;
    this.highlightIds=on;
    this.el.classList.toggle("ps-dim", !!on);
    for (const it of this.items.values()) it.el.classList.toggle("ps-glow", !!on && on.has(it.id));
    this.densityDirty=this.spritesDirty=true;this.kick();
  }
  select(ids) {
    const on = new Set(ids);
    for (const it of this.items.values()) { it.selected = on.has(it.id); it.el.classList.toggle("selected", it.selected); }
    this.kick();
  }
  kick() { if (!this.raf && this.alive) this.raf = requestAnimationFrame((t) => this.tick(t)); }
}

// The tag sea: flocks emerge from shared tags; lassos describe where they settle. Tags stay in a steady bottom row.
// A focus gives its members anchors, while dragging only changes their position.
// Consecutive group IDs need distinct colours too.
const hueOf = (key) => [...String(key)].reduce((h, ch) => (Math.imul(h,31)+ch.charCodeAt(0))>>>0, 7)*137.508%360;

class VennSea extends PhotoSea {
  constructor(el, opts = {}) {
    super(el, opts);
    this.onCircle = opts.onCircle; this.onLasso = opts.onLasso;
    this.circles = new Map(); this.keys = []; this.lassos = new Map();
    this.catalog = opts.catalog !== false;
    this.source=S.lib?.source;
    this.tray = document.createElement("div"); this.tray.className = "vn-catalog"; this.tray.hidden = true;
    this.tray.setAttribute("aria-label","Recognized tags"); el.append(this.tray);
    this.tray.onkeydown=(e)=>{if(e.key==='Enter'||e.key===' '){e.stopPropagation();return;}const list=[...this.tray.querySelectorAll("button")].filter(b=>!b.closest('[hidden]')), i=list.indexOf(e.target);
      if(i<0||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key))return;
      e.preventDefault();e.stopPropagation();const next=e.key==="Home"?0:e.key==="End"?list.length-1:(i+(["ArrowLeft","ArrowUp"].includes(e.key)?-1:1)+list.length)%list.length;
      list.forEach((b,k)=>b.tabIndex=k===next?0:-1);list[next].focus();};
    el.classList.add("venn-sea");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "vn-canvas";
    el.prepend(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.hint = document.createElement("div");
    this.hint.className = "vn-hint";
    this.hint.hidden = true;
    el.append(this.hint);
    this.focusKeys=new Set();this.focusAny=false;
    this.focusBar=document.createElement('div');this.focusBar.className='vn-focus';this.focusBar.hidden=true;this.tray.prepend(this.focusBar);
    this.tagRow=document.createElement('div');this.tagRow.className='vn-tags';this.tray.append(this.tagRow);
    this.worker=new Worker('/static/sea-worker.js');this.worker.onmessage=({data})=>this.receive(data);
    this.wake=()=>{if(!document.hidden&&!this.paused)this.kick();};document.addEventListener('visibilitychange',this.wake);
    // The World lets clicks through to the game. Only a thumbnail in clear water captures a pointer.
    this.proxyPointer=e=>{
      if(this.el.id!=='world'||this.paused)return;
      if(e.type==='pointerup'||e.type==='pointercancel'){this.pinch(e);this.panEnd(e);return;}
      if(this.pinch(e))return;
      if(e.type==='pointermove'&&this.panMove(e))return;
      if(this.el.contains(e.target))return;
      if(e.target.closest('button,a,input,select,textarea,dialog,.side,.tile,.pop-card,.screen-head,.screen-bar,.screen-rail,.vn-catalog,[data-solid]'))return;
      const [x,y]=this.localWorld(e);if((this.obstacles||[]).some(o=>x>o.x0&&x<o.x1&&y>o.y0&&y<o.y1))return;
      const near=e.type==='pointerdown'&&!e.button?this.smallAt(x,y):null;this.pointer(e);
      // Over-zoomed, a press anywhere on the sea pans (a tiny print hidden under the big one must not grab it).
      if(e.type==='pointerdown'&&this.panAnywhere(e)&&(near||e.target.closest('.ps-item')))this.panStart(e);
      else if(near){this.promote(near.id);this.down(e,near.el);}
      else if(e.type==='pointerdown'&&!this.uiTarget(e.target))this.panStart(e);
    };
    document.addEventListener('pointermove',this.proxyPointer);document.addEventListener('pointerdown',this.proxyPointer);
    document.addEventListener('pointerup',this.proxyPointer);document.addEventListener('pointercancel',this.proxyPointer);
    // The wheel zooms about the pointer; a double-click on open water brings the whole sea back into view.
    this.wheelZoom=e=>{
      if(this.el.id!=='world'||!this.cameraOn||this.paused||this.uiTarget(e.target,true))return;
      e.preventDefault();const r=this.el.getBoundingClientRect();this.zoomAt(Math.exp(-e.deltaY*this.tuning.wheelSpeed),e.clientX-r.left,e.clientY-r.top);
    };
    this.doubleReset=e=>{if(this.el.id!=='world'||!this.cameraOn)return;
      const el=e.target.closest('.ps-item'),it=el&&this.items.get(Number(el.dataset.id));
      // A double-click on a print grabs it; on an over-zoomed print (which a drag pans, not rearranges) or on open
      // water it brings the whole sea back into view.
      if(it&&!this.overZoomed(el)){this.onSelect?.(it,e);return;}
      if(it||!this.uiTarget(e.target))this.resetCamera();};
    document.addEventListener('wheel',this.wheelZoom,{passive:false});document.addEventListener('dblclick',this.doubleReset);
  }
  // circles: [{id: tag key, label, emoji, html}]; items: [{id, photo, tags, group, sugg, n, title, badge}];
  // lassos: [{id, kind: "group" | "sugg", html, bin}] (a group's label takes drops like its bin in the side list)
  setVenn(circles, items, lassos = [], partial = false) {
    const keep = new Set(circles.map((c) => c.id));
    for (const [id, c] of this.circles) if (!keep.has(id)) { c.tag.remove(); this.circles.delete(id); }
    for (const c of circles) {
      let v = this.circles.get(c.id);
      if (!v) {
        v = { id: c.id, cx: this.el.clientWidth / 2, cy: this.el.clientHeight / 2, r: 0, hue: hueOf(c.id) };
        v.tag = document.createElement("button");
        v.tag.className = "ps-tag vn-tag";
        v.tag.onclick = (e) => { e.stopPropagation(); this.toggleTag(c.id); };
        v.tag.oncontextmenu=(e)=>{e.preventDefault();e.stopPropagation();this.onCircle?.(c.id,v.tag);};
        v.tag.onpointerenter = () => {v.still=true;v.hot=true;this.highlight([...this.items.values()].filter((it)=>it.tags.includes(c.id)).map((it)=>it.id));this.kick();};
        v.tag.onpointerleave = () => {v.still=false;v.hot=false;this.highlight(null);this.kick();};
        this.el.append(v.tag);
        this.circles.set(c.id, v);
      }
      if (v.tag.innerHTML !== c.html) { v.tag.innerHTML = c.html; v.w = 0; }  // (re-measure its width)
      v.label = c.label; v.catchy = c.catchy || null;
      v.ring = false;
      v.tag.dataset.tag = c.id; v.tag.style.setProperty("--tag-hue",v.hue);
      if(this.el.id==='an-sea'&&c.id!=='x:cut')v.tag.dataset.foundTag=c.id;
      v.tag.tabIndex=this.catalog && this.tray.children.length===0?0:-1;
      if (this.catalog && v.tag.parentElement !== this.tagRow) this.tagRow.append(v.tag);
      else if (!this.catalog && v.tag.parentElement !== this.el) this.el.append(v.tag);
    }
    this.keys = circles.map((c) => c.id);
    this.catalogTabStop();
    const lk = new Set(lassos.map((l) => l.id));
    for (const [id, l] of this.lassos) if (!lk.has(id) && !l.auto) { l.tag.remove(); this.lassos.delete(id); }
    for (const l of lassos) {
      let v = this.lassos.get(l.id);
      if (!v) {
        v = { id: l.id, hue: hueOf(l.id), x: this.el.clientWidth / 2, y: 0 };
        v.tag = document.createElement("button");
        v.tag.className = `vn-lasso-tag is-${l.kind}`;
        v.tag.tabIndex = -1; v.tag.dataset.lasso = l.id;
        v.tag.onclick = e=>{e.stopPropagation();this.focusLasso(l.id);};
        v.tag.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();this.onLasso?.(l.id,v.tag);};
        v.tag.onpointerenter = () => {v.still=true;this.draw(this.width,this.height);};
        v.tag.onpointerleave = () => {v.still=false;this.draw(this.width,this.height);};
        this.tagRow.append(v.tag);v.tag.hidden=true;
        this.lassos.set(l.id, v);
      }
      v.kind = l.kind;
      if (v.tag.innerHTML !== l.html) { v.tag.innerHTML = l.html; v.w = 0; }
      if (l.bin != null) v.tag.dataset.bin = l.bin; else delete v.tag.dataset.bin;
    }
    this.syncItems(items, partial);
    this.layout();
    this.stir(240);
  }
  spawn(x) {
    const key = x.group != null ? `g${x.group}` : x.sugg != null ? `s${x.sugg}` : (x.tags || [])[0];
    const at = this.spawnHomes?.get(key), W = this.el.clientWidth, H = this.el.clientHeight;
    const margin=Math.min(20,W/8,H/8),reflect=(n,max)=>{const span=Math.max(1,max-margin*2),t=((n-margin)%(span*2)+span*2)%(span*2);return margin+(t>span?span*2-t:t);};
    for(let i=0;i<12;i++){
      const p=[reflect(at&&i<6?at.x+(Math.random()-.5)*160:Math.random()*W,W),reflect(at&&i<6?at.y+(Math.random()-.5)*160:Math.random()*H,H)];
      if(!(this.obstacles||[]).some(o=>p[0]>o.x0-margin&&p[0]<o.x1+margin&&p[1]>o.y0-margin&&p[1]<o.y1+margin))return p;
    }
    // A new batch starts in available water rather than being projected into a row along the nearest panel.
    const water=this.water||[{x0:0,y0:0,x1:W,y1:H}],total=water.reduce((n,r)=>n+(r.x1-r.x0)*(r.y1-r.y0),0);
    let pick=Math.random()*total;
    const r=water.find(r=>(pick-=(r.x1-r.x0)*(r.y1-r.y0))<=0)||water[0];
    return r?[r.x0+Math.random()*(r.x1-r.x0),r.y0+Math.random()*(r.y1-r.y0)]:[W/2,H/2];
  }
  adopt(it, x) { it.tags = x.tags || []; it.tagSet = new Set(it.tags); it.group = x.group ?? null; it.sugg = x.sugg ?? null; it.free = false;
    it.visual=x.visual||null;
    it.dims=x.dims||it.dims||null;
    it.box=x.box||null;
    it.members = x.members || [x.photo]; it.stack = x.rep || x.id; it.take = !!x.take; it.cut = !!x.cut; it.category = x.category;
    if(!it.take&&it.pileLifted){it.pileLifted=false;it.el.classList.remove('pile-lifted');}
    this.freshTags = this.freshTags || new Map(); this.spawnHomes = this.spawnHomes || new Map();
    for (const t of it.tags) { if (!this.freshTags.has(t)) this.freshTags.set(t, performance.now()); this.spawnHomes.set(t, it); }
    if (it.group != null) this.spawnHomes.set(`g${it.group}`, it);
  }
  layout() {  // the tile size from how many photos share the field (it holds while little changes)
    if (!this.alive) return;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    this.width=W;this.height=H;
    if(this.camera.zoom!==1)this.setCamera(this.camera.zoom,this.camera.tx,this.camera.ty);
    this.water = this.openWater(W,H);
    this.tray.hidden = !!this.paused || !this.catalog || !!this.catalogSuppressed || (!this.keys.length && !this.lassos.size);
    if (!this.tray.hidden) {
      const dock=this.el.id==='world'?$('#main > .screen, #main > #view-duel'):this.el.closest('.screen');
      if(this.dock!==dock){this.dock?.classList.remove('tag-dock');this.dock=dock;}
      this.tray.classList.toggle('is-docked',!!dock);
      if(dock){dock.classList.add('tag-dock');if(this.tray.parentElement!==dock)dock.append(this.tray);this.tray.style.cssText='';}
      else{if(this.tray.parentElement!==this.el)this.el.append(this.tray);this.tray.style.cssText='left:12px;right:12px;bottom:12px';}
      const r=this.tray.getBoundingClientRect(),base=this.el.getBoundingClientRect();
      this.catalogRect=this.el.id==='world'?null:{x0:r.left-base.left-10,y0:r.top-base.top-10,x1:r.right-base.left+10,y1:r.bottom-base.top+10};
      if(this.catalogRect)this.water=this.openWater(W,H,[this.catalogRect]);
    } else {
      this.catalogRect=null;
      this.dock?.classList.remove('tag-dock');this.dock=null;
      if(this.tray.parentElement!==this.el)this.el.append(this.tray);
    }
    this.homes(W, H);
    this.loadSprites();
    this.densityDirty=this.spritesDirty=true;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`; this.canvas.style.height = `${H}px`;
    }
    this.kick();
  }
  openWater(W,H,extra=[]) {
    let water=[{x0:3,y0:3,x1:W-3,y1:H-3}];
    // The shared world flows beneath ethereal chrome. Only its photos occupy physical space.
    if(this.el.id==='world')return water;
    for (const o of [...(this.obstacles || []),...extra]) {
      const next=[];
      for (const r of water) {
        const x0=Math.max(r.x0,o.x0-4),y0=Math.max(r.y0,o.y0-4),x1=Math.min(r.x1,o.x1+4),y1=Math.min(r.y1,o.y1+4);
        if(x0>=x1||y0>=y1){next.push(r);continue;}
        if(y0>r.y0)next.push({...r,y1:y0});if(y1<r.y1)next.push({...r,y0:y1});
        if(x0>r.x0)next.push({x0:r.x0,x1:x0,y0,y1});if(x1<r.x1)next.push({x0:x1,x1:r.x1,y0,y1});
      }
      water=next;
    }
    return water;
  }
  drawDensity(W, H) {
    if (!this.densityCanvas) {
      this.densityCanvas = document.createElement("canvas"); this.densityCanvas.className = "vn-density";
      this.el.prepend(this.densityCanvas);
      if(this.gpu===undefined)this.gpu=this.initSprites();
      this.el.addEventListener("pointerdown", (e) => {
        if (e.target !== this.el && e.target!==this.densityCanvas && e.target!==this.spriteCanvas || e.button) return;
        const [x, y] = this.local(e);
        const near=this.smallAt(x,y);
        if (near) { this.promote(near.id); this.down(e,near.el); }
      }, {signal:this.events.signal});
    }
    if(this.gpu){this.drawSprites(W,H);return;}
    const canvas = this.densityCanvas,cam=this.camera||{zoom:1,tx:0,ty:0};
    const dpr=Math.min(2,devicePixelRatio||1),ox=0,oy=0,cw=Math.round(W*dpr),ch=Math.round(H*dpr);
    if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;canvas.style.width=`${W}px`;canvas.style.height=`${H}px`;}
    canvas.style.transform='';
    const ctx = this.densityCtx||(this.densityCtx=canvas.getContext("2d")); ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
    // Tiny prints share pre-scaled atlas pixels. One upload avoids thousands of canvas draw calls per frame.
    const raster=this.items.size>4000;
    if(raster&&(!this.densityPixels||this.densityPixels.width!==canvas.width||this.densityPixels.height!==canvas.height)){
      this.densityPixels=ctx.createImageData(canvas.width,canvas.height);
    }
    // Real atlas thumbnails remain visible even at the smallest size. The optional dot shortcut is off by default.
    const dotLod=this.tuning?.dotLod??0,dots=[];let filled=false;
    const deferred=[],{zoom,tx,ty}=this.camera||{zoom:1,tx:0,ty:0};
    this.densityStats={dots:0,raster:0,cards:0};
    const cols=Math.ceil(W/16),rows=Math.ceil(H/16);
    if(!this.hitGrid||this.hitCols!==cols||this.hitRows!==rows)this.hitGrid=new Map();
    else for(const cell of this.hitGrid.values())cell.length=0;
    this.hitCols=cols;this.hitRows=rows;
    let alpha=1,max=0;
    for (const it of this.paintOrder||this.items.values()) if (it.density||it.imagePending) {
      if(it.lifted||it.pileLifted)continue;
      const size = (it.size || this.densitySize || 4)*(it.density?1:it.renderScale||1);if(size>max)max=size;
      const hit=Math.floor(it.y/16)*this.hitCols+Math.floor(it.x/16);let cell=this.hitGrid.get(hit);
      if(!cell){cell=[];this.hitGrid.set(hit,cell);}if(cell.length<24)cell.push(it);
      const opacity=this.highlightIds&&!this.highlightIds.has(it.id)?.22:it.cut?.4:1;
      const sprite = this.sprites?.get(it.id), preview = it.preview;
      const source=sprite&&(sprite.img instanceof HTMLCanvasElement||sprite.img.complete&&sprite.img.naturalWidth)?sprite:preview;
      // A sprite is the same 3:4 polaroid as a live print: paper, a dark window, the picture inside.
      const sx=(it.x-size/2)*zoom+tx,sy=(it.y-size*2/3)*zoom+ty,shown=size*zoom,tall=shown*4/3;
      if(sx>W+ox||sy>H+oy||sx+shown<-ox||sy+tall<-oy)continue;  // outside the drawn region: culled from drawing
      // Every print is on the sea: one whose picture has not arrived yet (its sheet still loading) is a blank card.
      if(!source){dots.push({source:null,sx,sy,shown,tall,opacity});this.densityStats.blank=(this.densityStats.blank||0)+1;continue;}
      if(raster&&Math.round(shown*dpr)<=dotLod){dots.push({source,sx,sy,shown,tall,opacity});this.densityStats.dots++;continue;}
      if(raster){
        if(!filled){this.densityPixels.data.fill(0);filled=true;}
        if(!this.paintTiny(source,sx+ox,sy+oy,shown,opacity,dpr))deferred.push({source,sx,sy,shown,opacity,id:it.id});else this.densityStats.raster++;
      }else{
        if(alpha!==opacity){ctx.globalAlpha=opacity;alpha=opacity;}
        this.densityStats.cards++;
        this.drawCard(ctx,source,sx,sy,shown,it.id);
      }
    }
    if(raster&&filled)ctx.putImageData(this.densityPixels,0,0);  // canvas space: putImageData ignores the transform
    if(raster)for(const {source,sx,sy,shown,opacity,id}of deferred){ctx.globalAlpha=opacity;this.densityStats.cards++;this.drawCard(ctx,source,sx,sy,shown,id);}
    for(const d of dots){
      ctx.globalAlpha=d.opacity;ctx.fillStyle='#f4efe6';ctx.fillRect(d.sx,d.sy,d.shown,d.tall);
      ctx.fillStyle=d.source?this.cellColour(d.source):'#c9c2b4';ctx.fillRect(d.sx+d.shown*.055,d.sy+d.shown*.055,d.shown*.89,Math.min(d.shown*.89,d.tall-d.shown*.225));
    }
    ctx.globalAlpha=1;
    // Projected Filter changes mark the real tiny prints too, without promoting thousands of DOM nodes.
    if(this.outcomeChanges?.size){
      ctx.beginPath();ctx.strokeStyle='#ffe099';ctx.lineWidth=1;
      for(const id of this.outcomeChanges){const it=this.items.get(id);if(!it?.density||it.lifted||it.pileLifted)continue;const size=((it.size||this.densitySize||4)+4)*zoom;ctx.rect(it.x*zoom+tx-size/2,it.y*zoom+ty-size*2/3,size,size*4/3);}
      ctx.stroke();
    }
    this.spriteMax=max;this.spritesDirty=false;this.densityDirty=false;
  }
  // The GPU sprite layer (sea-gl.js), unless the knob is off or the browser has no WebGL2; then the 2D canvas above.
  initSprites(){
    if(!(this.tuning.gpu??1)||typeof SpriteLayer==='undefined')return null;
    const canvas=document.createElement('canvas');canvas.className='vn-density vn-sprites';
    try{const layer=new SpriteLayer(canvas);this.el.prepend(canvas);this.spriteCanvas=canvas;return layer;}
    catch(_){canvas.remove();return null;}
  }
  // Every sprite as an instanced quad. The batches (one per sheet) are rebuilt only when a print moved, arrived or
  // changed its look or the visible set changed. A wobble tick reuses them. The hit grid comes along.
  drawSprites(W,H){
    const {zoom,tx,ty}=this.camera||{zoom:1,tx:0,ty:0},dpr=Math.min(2,devicePixelRatio||1);
    const viewKey=`${W}:${H}:${zoom}:${tx}:${ty}`;
    if(this.spritesDirty||!this.glBatches||this.spriteView!==viewKey){
      if(this.spritesDirty||!this.spriteImages){
        // Off-screen quads are culled, but their collection's sheets stay uploaded for the next pan back.
        this.spriteImages=new Set();
        for(const it of this.items.values()){const image=(this.sprites?.get(it.id)||it.preview)?.img;if(image)this.spriteImages.add(image);}
      }
      const stats=this.densityStats={dots:0,raster:0,cards:0,gpu:0},cols=Math.ceil(W/16),rows=Math.ceil(H/16);
      if(!this.hitGrid||this.hitCols!==cols||this.hitRows!==rows)this.hitGrid=new Map();else for(const cell of this.hitGrid.values())cell.length=0;
      this.hitCols=cols;this.hitRows=rows;
      const previous=new Map((this.glBatches||[]).map(b=>[b.image,b])),batches=new Map(),S=SpriteLayer.STRIDE;let max=0;
      for(const it of this.paintOrder||this.items.values())if(it.density||it.imagePending){
        if(it.lifted||it.pileLifted)continue;
        const size=(it.size||this.densitySize||4)*(it.density?1:it.renderScale||1);
        const half=size*zoom/2,tall=size*zoom*2/3,sx=it.x*zoom+tx,sy=it.y*zoom+ty;
        if(sx+half<0||sx-half>W||sy+tall<0||sy-tall>H){stats.culled=(stats.culled||0)+1;continue;}
        const hit=Math.floor(it.y/16)*this.hitCols+Math.floor(it.x/16);let cell=this.hitGrid.get(hit);if(!cell){cell=[];this.hitGrid.set(hit,cell);}if(cell.length<24)cell.push(it);
        const opacity=this.highlightIds&&!this.highlightIds.has(it.id)?.22:it.cut?.4:1;
        const sprite=this.sprites?.get(it.id),preview=it.preview;
        const source=sprite&&(sprite.img instanceof HTMLCanvasElement||sprite.img.complete&&sprite.img.naturalWidth)?sprite:preview;
        const image=source?source.img:null;
        let b=batches.get(image);if(!b){const old=previous.get(image);b={image,version:-1,data:old?.data||new Float32Array(S*256),n:0,upload:true,buffer:old?.buffer||null};if(old)old.buffer=null;batches.set(image,b);}
        if((b.n+1)*S>b.data.length){const grown=new Float32Array(b.data.length*2);grown.set(b.data);b.data=grown;}
        const o=b.n*S,d=b.data,[r1,r2,r3]=this.wobbleRandoms(it.id);
        d[o]=it.x;d[o+1]=it.y;d[o+2]=size;
        if(source){d[o+3]=source.x;d[o+4]=source.y;d[o+5]=source.w||16;d[o+6]=source.h||16;stats.gpu++;}
        else{d[o+3]=d[o+4]=d[o+5]=d[o+6]=0;stats.blank=(stats.blank||0)+1;}
        d[o+7]=opacity;d[o+8]=r1;d[o+9]=r2;d[o+10]=r3;d[o+11]=source?.aspect||0;
        d[o+12]=.8-1.6*((it.order||1)/(this.items.size+1));b.n++;if(size>max)max=size;
      }
      this.gpu.release([...previous.values()]);this.glBatches=[...batches.values()];this.spriteMax=max;this.spritesDirty=false;this.spriteView=viewKey;
    }
    for(const b of this.glBatches)if(b.image)b.version=this.previewVersions?.get(b.image)||0;  // a mutable preview page is uploaded again when it changed
    const T=this.tuning||{};
    this.gpu.draw({W,H,dpr,zoom,tx,ty,time:this.wobbleNow||performance.now(),wobble:[(T.wobblePeriod||5.6)*1000,T.wobbleDeg??1,T.wobbleSpeedSpread??.25,T.wobbleForceSpread??.35,T.wobbleDelaySpread??1]},this.glBatches,this.spriteImages);
    this.drawOutcomeMarks(W,H,dpr,zoom,tx,ty);
    this.densityRegion=null;this.densityDirty=false;this.wobbleLoop();
  }
  // Projected Filter changes mark the sprites on the 2D canvas, which lies over the sprite layer.
  drawOutcomeMarks(W,H,dpr,zoom,tx,ty){
    const canvas=this.densityCanvas,ctx=this.densityCtx||(this.densityCtx=canvas.getContext('2d')),marks=this.outcomeChanges?.size||0;
    if(!marks&&!this.marksDrawn)return;this.marksDrawn=marks;
    const cw=Math.round(W*dpr),ch=Math.round(H*dpr);
    if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;canvas.style.width=`${W}px`;canvas.style.height=`${H}px`;}
    canvas.style.transform='';ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
    if(!marks)return;
    ctx.beginPath();ctx.strokeStyle='#ffe099';ctx.lineWidth=1;
    for(const id of this.outcomeChanges){const it=this.items.get(id);if(!it?.density||it.lifted||it.pileLifted)continue;const size=((it.size||this.densitySize||4)+4)*zoom;ctx.rect(it.x*zoom+tx-size/2,it.y*zoom+ty-size*2/3,size,size*4/3);}
    ctx.stroke();
  }
  // A sprite repaint on the next frame, outside the physics tick: a camera move at rest must not wait for one.
  paintSoon(){if(this.paintRaf||!this.alive)return;this.paintRaf=requestAnimationFrame(()=>{this.paintRaf=0;if(this.alive&&this.densityDirty&&this.el.isConnected)this.drawDensity(this.width||this.el.clientWidth,this.height||this.el.clientHeight);});}
  // Sprites big enough for their wobble to show (a card over thirty pixels) rock at a gentle rate on the GPU. At
  // rest with small sprites, or deep in one print, nothing is drawn at all.
  wobbleLoop(){
    const T=this.tuning||{};
    if(this.wobbleTimer||!this.gpu||!this.alive||this.deep||document.hidden||!(T.wobbleDeg??1)||(this.spriteMax||0)*(this.camera?.zoom||1)<30||!this.glBatches?.length)return;
    this.wobbleTimer=setTimeout(()=>{this.wobbleTimer=0;if(!this.alive)return;this.wobbleNow=performance.now();this.densityDirty=true;this.paintSoon();},45);
  }
  // The card's three wobble randoms (start, speed, force): the same generator as cards.js, so a sprite and its
  // live card rock alike.
  wobbleRandoms(id){
    this.wobbleSeeds=this.wobbleSeeds||new Map();let r=this.wobbleSeeds.get(id);if(r)return r;
    let seed=((id||0)*2654435761)>>>0;const next=()=>{seed=(seed+0x6D2B79F5)>>>0;let t=seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};
    r=[next(),next(),next()];this.wobbleSeeds.set(id,r);return r;
  }
  // One colour per atlas cell for the dot level of detail: the sheet is read once at a quarter scale (every 16-px
  // cell becomes a 4×4 block), then each cell's mean is kept; a mutable preview page is re-read when its version moves.
  cellColour(source){
    this.dotColours=this.dotColours||new WeakMap();
    const image=source.img,version=this.previewVersions?.get(image)||0;
    let cache=this.dotColours.get(image);
    if(!cache||cache.version!==version){
      const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
      const small=document.createElement('canvas');small.width=Math.max(1,Math.ceil(width/4));small.height=Math.max(1,Math.ceil(height/4));
      const ctx=small.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,small.width,small.height);
      cache={version,pixels:ctx.getImageData(0,0,small.width,small.height),colours:new Map()};this.dotColours.set(image,cache);
    }
    const key=`${source.x},${source.y}`;let colour=cache.colours.get(key);
    if(!colour){
      const {data,width,height}=cache.pixels,x0=Math.floor(source.x/4),y0=Math.floor(source.y/4);let r=0,g=0,b=0,n=0;
      for(let y=y0;y<Math.min(height,y0+4);y++)for(let x=x0;x<Math.min(width,x0+4);x++){const i=(y*width+x)*4;if(!data[i+3])continue;r+=data[i];g+=data[i+1];b+=data[i+2];n++;}
      colour=n?`rgb(${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)})`:'#8a8a8a';cache.colours.set(key,colour);
    }
    return colour;
  }
  // The polaroid in canvas: paper 3:4, the window 5.5% in from the sides and top with a 17% chin, the picture
  // contained inside it, exactly like the CSS card every DOM print wears.
  // Geometry is shared with paintTiny (the raster path): at 16 px and under it is integer and square-cornered.
  cardGeometry(x,y,w){
    if(w<=16){const W=Math.max(1,Math.round(w)),X=Math.round(x),Y=Math.round(y),ww=Math.max(1,Math.round(W*.89)),inset=Math.round(W*.055);return {x:X,y:Y,w:W,h:Math.round(W*4/3),wx:X+inset,wy:Y+inset,ww,wh:Math.round(W*4/3)-inset-Math.round(W*.17),r:0};}
    return {x,y,w,h:w*4/3,wx:x+w*.055,wy:y+w*.055,ww:w*.89,wh:w*4/3-w*.225,r:w*.015};
  }
  drawCard(ctx,source,x0,y0,w0,id){
    const {x,y,w,h,wx,wy,ww,wh,r}=this.cardGeometry(x0,y0,w0),T=this.tuning||{};
    // The same wobble as the CSS cards: three randoms seeded by the photo id give this sprite its start, speed and force.
    const [r1,r2,r3]=this.wobbleRandoms(id),period=(T.wobblePeriod||5.6)*1000*(1+(r2*2-1)*(T.wobbleSpeedSpread??.25)),deg=(T.wobbleDeg??1)*(1+(r3*2-1)*(T.wobbleForceSpread??.35));
    const angle=deg?Math.sin(((this.wobbleNow||0)/period+r1*(T.wobbleDelaySpread??1))*2*Math.PI)*deg*Math.PI/180:0;
    if(angle){ctx.save();ctx.translate(x+w/2,y+h/2);ctx.rotate(angle);ctx.translate(-(x+w/2),-(y+h/2));}
    ctx.fillStyle='#f4efe6';if(r&&ctx.roundRect){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();}else ctx.fillRect(x,y,w,h);
    const sw=source.w||16,sh=source.h||16,aspect=source.aspect||sw/sh,pw=Math.min(ww,wh*aspect),ph=pw/aspect;
    ctx.drawImage(source.img,source.x,source.y,sw,sh,wx+(ww-pw)/2,wy,pw,ph);
    if(angle)ctx.restore();
  }
  paintTiny(source,x,y,size,opacity,dpr){
    // Photos with a non-square aspect use the native path; the square-picture blitter cannot preserve it.
    if((source.w||16)!==16||(source.h||16)!==16||source.aspect&&source.aspect!==1)return false;
    const side=Math.max(1,Math.round(size*dpr));if(side>16)return false;
    // The same polaroid as drawCard: paper over the card, then the cell contained at the top of its window.
    const g=this.cardGeometry(x*dpr,y*dpr,side),target=this.densityPixels,to=target.data;
    for(let row=Math.max(0,g.y);row<Math.min(target.height,g.y+g.h);row++)for(let col=Math.max(0,g.x);col<Math.min(target.width,g.x+g.w);col++){
      const b=(row*target.width+col)*4,sa=255*opacity,da=to[b+3]*(1-sa/255),sum=sa+da;
      to[b]=(244*sa+to[b]*da)/sum;to[b+1]=(239*sa+to[b+1]*da)/sum;to[b+2]=(230*sa+to[b+2]*da)/sum;to[b+3]=sum;
    }
    return this.blitCell(source,g.wx,g.wy,g.ww,opacity);
  }
  blitCell(source,left,top,side,opacity){
    this.densityTiles=this.densityTiles||new WeakMap();
    const image=source.img,version=this.previewVersions?.get(image)||0;
    let cache=this.densityTiles.get(image);
    if(!cache||cache.version!==version){cache={version,levels:new Map()};this.densityTiles.set(image,cache);}
    let atlas=cache.levels.get(side);
    if(!atlas){
      const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
      const scaled=document.createElement('canvas');scaled.width=Math.ceil(width/16)*side;scaled.height=Math.ceil(height/16)*side;
      const ctx=scaled.getContext('2d');ctx.drawImage(image,0,0,scaled.width,scaled.height);
      atlas=ctx.getImageData(0,0,scaled.width,scaled.height);cache.levels.set(side,atlas);
      if(cache.levels.size>3)cache.levels.delete(cache.levels.keys().next().value);
      scaled.width=scaled.height=0;
    }
    const target=this.densityPixels,sx=Math.round(source.x/16)*side,sy=Math.round(source.y/16)*side;
    const from=atlas.data,to=target.data,x0=Math.max(0,-left),x1=Math.min(side,target.width-left),y0=Math.max(0,-top),y1=Math.min(side,target.height-top);
    for(let row=y0;row<y1;row++){
      let a=((sy+row)*atlas.width+sx+x0)*4,b=((top+row)*target.width+left+x0)*4;
      for(let col=x0;col<x1;col++,a+=4,b+=4){
        const sa=from[a+3]*opacity,da=to[b+3]*(1-sa/255),sum=sa+da;if(!sum)continue;
        to[b]=(from[a]*sa+to[b]*da)/sum;to[b+1]=(from[a+1]*sa+to[b+1]*da)/sum;to[b+2]=(from[a+2]*sa+to[b+2]*da)/sum;to[b+3]=sum;
      }
    }
    return true;
  }
  // All bodies move in the worker, including the tiny atlas previews. LOD only changes their presentation.
  loadSprites(){
    if(this.el.id!=='an-sea')return;
    this.sprites=this.sprites||new Map();
    const missing=[...this.items.values()].filter(it=>(it.density||it.imagePending)&&!this.sprites.has(it.id));
    for(let k=0;k<missing.length;k+=500){
      const batch=missing.slice(k,k+500),img=new Image();
      batch.forEach((it,i)=>this.sprites.set(it.id,this.atlasCell(img,i,it.dims)));
      img.onload=()=>{if(this.alive){this.densityDirty=this.spritesDirty=true;this.kick();}};
      img.onerror=()=>{if(this.alive){batch.forEach(it=>this.sprites.delete(it.id));setTimeout(()=>this.alive&&this.loadSprites(),2000);}};  // a lost sheet is asked for again
      img.src=`/img/atlas.jpg?layout=2&v=${imageKey()}&ids=${batch.map(it=>it.photo).join(',')}`;
    }
  }
  smallAt(x,y){
    const cx=Math.floor(x/16),cy=Math.floor(y/16),radius=8/(this.camera?.zoom||1);let near=null,distance=radius*radius;
    for(let a=cx-1;a<=cx+1;a++)for(let b=cy-1;b<=cy+1;b++)for(let it of this.hitGrid?.get(b*this.hitCols+a)||[]){
      if(it.take)it=this.items.get(it.stack)||it;
      const d=(it.x-x)**2+(it.y-y)**2;if(d<distance){near=it;distance=d;}}
    return near;
  }
  // Live cards are bounded; tiny prints use the atlas hit grid. A stack only targets another physical stack,
  // inside its actual paper, so dragging through open water cannot quietly merge nearby photos.
  photoAt(x,y,excluded=[]){
    const skip=new Set((Array.isArray(excluded)?excluded:[excluded]).filter(Boolean).map(it=>it.stack||it.id));
    let near=null,top=-Infinity,distance=Infinity;
    const check=it=>{
      if(it.take)it=this.items.get(it.stack);
      if(!it||skip.has(it.stack||it.id)||it.lifted||it.pileLifted||it.el.classList.contains('lifted'))return;
      const size=(it.size||this.s)*(it.id===this.held?1.15:1),dx=(x-it.x)/size,dy=(y-it.y)/size;
      if(Math.abs(dx)>.5||Math.abs(dy)>2/3)return;
      const z=it.density?0:100+(it.id===this.held?19:it.focused?8:it.dropped?5:0),d=dx*dx+dy*dy;
      if(z>top||z===top&&d<distance){near=it;top=z;distance=d;}
    };
    for(const it of this.moving)check(it);
    const cx=Math.floor(x/16),cy=Math.floor(y/16),reach=Math.ceil((this.spriteMax||this.densitySize||this.s)*2/3/16);
    for(let a=cx-reach;a<=cx+reach;a++)for(let b=cy-reach;b<=cy+reach;b++)for(const it of this.hitGrid?.get(b*this.hitCols+a)||[])if(it.density)check(it);
    return near;
  }
  pointer(e){
    super.pointer(e);
    if(this.drag)return;
    const el=e.target.closest('.ps-item'),it=el&&this.items.get(Number(el.dataset.id));
    if(it&&this.held!==it.stack)this.hold(it.stack);
    else if(!e.target.closest('.ps-item,.vn-tag,.vn-lasso-tag,.vn-catalog')){
      const near=this.smallAt(this.mouse.x,this.mouse.y);if(near){this.promote(near.id);this.paintItem(near);this.hold(near.stack);}
    }
  }
  // Catch the visible position, not the worker's next destination. A reached-for print must stop under the pointer.
  catchItem(it){
    if(it.el.isConnected&&!it.lifted&&it.transform){
      const r=it.el.getBoundingClientRect(),base=this.el.getBoundingClientRect();
      [it.x,it.y]=this.toWorld(r.left+r.width/2-base.left,r.top+r.height/2-base.top);
    }
    this.paintItem(it);it.el.classList.add('pinned');
  }
  hold(id){
    if(this.held===id)return;
    this.settled=false;
    const before=this.items.get(this.held);if(before&&!this.drag?.members.has(before))before.el.classList.remove('pinned');
    this.held=id;
    const it=this.items.get(id);if(it)this.catchItem(it);
  }
  paintItem(it,instant=false){
    if(instant||!it.transform){
      it.el.style.transition='none';
      requestAnimationFrame(()=>requestAnimationFrame(()=>{if(this.alive)it.el.style.transition='';}));
    }
    const held=it.id===this.held,drag=this.drag?.members.has(it),size=it.size||this.s;
    const scale=drag&&this.drag.moving?1.32:held?1.15:1;
    const transform=`translate3d(${it.x.toFixed(2)}px, ${it.y.toFixed(2)}px,0) translate(-50%,-50%) scale(${scale})${it.take?` rotate(${it.pileTurn||0}deg)`:''}`;
    const changed=it.transform!==transform||it.renderSize!==size;it.renderScale=scale;
    if(it.transform!==transform){it.el.style.transform=transform;it.transform=transform;}
    if(it.renderSize!==size){it.renderSize=size;it.el.style.width=`${size}px`;it.el.style.height=`${size*4/3}px`;}  // every print is a 3:4 card
    it.el.classList.toggle('pinned',held||!!drag);
    const priority=drag?4:held?3:it.focused?2:it.dropped?1:0;
    it.el.style.zIndex=String(priority*(this.items.size+1)+(it.order||1));
    if(this.presentation?.item===it)this.presentation.follow();
    if(changed&&it.imagePending){this.densityDirty=this.spritesDirty=true;this.paintSoon();}
  }
  released(items){this.releasePins=items.map(it=>({id:it.stack,x:it.x,y:it.y}));for(const it of items)it.dropped=true;this.kick();this.onRelease?.(items);}  // a print you placed lies on top; a stage may read the release
  homes(W,H) {
    const area=(this.water||[]).reduce((n,r)=>n+(r.x1-r.x0)*(r.y1-r.y0),0),count=new Set([...this.items.values()].map(it=>it.stack||it.id)).size;
    const room=Math.max(0,...(this.water||[]).map(r=>Math.min(r.x1-r.x0,r.y1-r.y0)));
    // One physical footprint for every ambient shot; then, only as far as needed, prints shrink so their contact
    // footprints fit the water inside the edge margin (a small library of big prints keeps its geography).
    // The edge margin gives way, only as far as needed, when the library is too big to fit inside it at a
    // readable print size (seven pixels), so five thousand prints spread across the water instead of piling up.
    const T=this.tuning;this.marginEff=this.marginFor(count,area);
    const inner=area*Math.max(.25,1-2*this.marginEff)**2;
    // Footprints may fill about 70% of that water: packed edge to edge, every drop would shove the whole sea.
    const share=Math.sqrt(area*T.sizeShare/Math.max(1,count))/T.sizeDivisor,fits=Math.sqrt(inner*.7/Math.max(1,count))/(2*(T.gap||.74));
    const before=this.s;this.s=Math.max(2,Math.min(T.sizeMax,room/2,share,fits));
    this.densitySize=this.s;
    if(this.s!==before&&this.items.size)this.scheduleCull(true);
    this.el.style.setProperty('--ps',`${this.s}px`);
    for(const it of this.items.values())if(it.take){const rep=this.items.get(it.stack),i=Math.max(1,rep?.members.indexOf(it.id)||1);it.pileX=((i*7)%11-5)*.018;it.pileY=((i*5)%9-4)*.018;it.pileTurn=((i*13)%17)-8;}
    this.scheduleBodies();
  }
  scheduleBodies() {
    if(this.bodyTimer)return;
    this.bodyTimer=setTimeout(()=>{this.bodyTimer=null;this.sendBodies();},100);
  }
  sendBodies() {
    if(!this.alive)return;
    const groups=new Map();
    for(const it of this.items.values()){
      const rep=this.items.get(it.stack)||it;
      let body=groups.get(rep.id);if(!body){body={it:rep,tags:new Set()};groups.set(rep.id,body);}
      for(const t of it.tags)body.tags.add(t);
    }
    this.bodies=[...groups.values()].map(({it,tags})=>{
      it.bodyTags=[...tags];
      return {id:it.id,x:it.x,y:it.y,visual:it.visual,baseSize:this.s*(it.n>1?1.12:1),label:it.group!=null&&!String(it.group).startsWith('cup:')&&this.lassos.has(`g${it.group}`)?`g${it.group}`:null,tags:tags.size?[...tags]:it.group!=null?[`group:${it.group}`]:[]};
    });
    this.takes=[...this.items.values()].filter(it=>it.take);
    this.focusMatches();
    this.generation=(this.generation||0)+1;this.ready=false;this.settled=false;
    this.worker.postMessage({kind:'set',generation:this.generation,items:this.bodies,focus:this.focusState(),tuning:this.tuning,...this.bounds()});
    this.ready=true;this.kick();
  }
  // The world is calm: prints settle and rest. The analysis sea keeps drifting while discoveries arrive.
  bounds(){return {width:this.width||this.el.clientWidth,height:this.height||this.el.clientHeight,water:this.water,calm:this.el.id==='world',margin:this.marginEff??this.tuning?.margin,obstacles:this.el.id==='world'?[]:[...(this.obstacles||[]),...(this.catalogRect?[this.catalogRect]:[])]};}
  marginFor(count,area){const T=this.tuning,base=T.margin||0,needed=count*(2*(T.gap||.74)*7)**2/.7;return Math.max(.02,Math.min(base,(1-Math.sqrt(Math.min(1,needed/Math.max(1,area))))/2));}
  labelOf(it){const actual=it.group!=null?`g${it.group}`:null;return actual&&this.lassos.has(actual)&&!String(it.group).startsWith('cup:')?actual:it.cluster||null;}
  stir(){this.kick();}
  setOutcomeFlow(flow){
    this.settled=false;
    this.outcomeFlow=flow||null;
    this.outcomeChanges=new Set(flow?.changed||[]);this.densityDirty=this.spritesDirty=true;
    this.worker.postMessage({kind:'outcomes',flow:this.outcomeFlow});this.kick();
  }
  catalogTabStop(){
    const buttons=[...this.tagRow.querySelectorAll('button')];
    for(const b of buttons)if(b.hidden)b.tabIndex=-1;
    if(!buttons.some(b=>!b.hidden&&b.tabIndex===0))buttons.find(b=>!b.hidden)?.setAttribute('tabindex','0');
  }
  focusState(){return {keys:[...(this.focusKeys||[])],any:!!this.focusAny,ids:[...(this.focusIds||[])],cluster:this.focusCluster||null};}
  releaseFocus(){
    if(!this.focusKeys.size&&!this.focusCluster&&!this.focusIds)return;
    this.focusKeys.clear();this.focusIds=null;this.focusCluster=null;this.applyFocus();
  }
  focusLasso(id){
    this.focusKeys.clear();
    if(this.focusCluster===id){this.focusCluster=null;this.focusIds=null;}
    else{this.focusCluster=id;this.focusIds=new Set([...this.items.values()].filter(it=>this.labelOf(it)===id).map(it=>it.stack));}
    this.applyFocus();
  }
  toggleTag(key){
    this.focusCluster=null;this.focusIds=null;this.focusKeys=this.focusKeys||new Set();
    this.focusKeys.has(key)?this.focusKeys.delete(key):this.focusKeys.add(key);this.applyFocus();
  }
  applyFocus(){
    this.resetCamera();
    this.highlight(null);
    this.mouse.x=this.mouse.y=-1e5;this.hold(null);
    const keys=this.focusKeys||new Set(),active=keys.size||this.focusCluster;
    this.focusBar.hidden=!active;
    this.focusBar.innerHTML=active?`<button type="button" class="btn ghost" data-match-mode aria-label="Tag matching mode">${this.focusAny?'Any':'All'} selected tags</button><span class="muted small" data-focus-count></span><button type="button" class="btn ghost" data-select-matches>Select matches</button><button type="button" class="btn ghost" data-clear-focus>Release focus ×</button>`:'';
    if(active){
      const mode=this.focusBar.querySelector('[data-match-mode]');mode.hidden=!keys.size;mode.onclick=()=>{this.focusAny=!this.focusAny;this.applyFocus();};
      this.focusBar.querySelector('[data-clear-focus]').onclick=()=>{this.focusKeys.clear();this.focusIds=null;this.focusCluster=null;this.applyFocus();};
      this.focusBar.querySelector('[data-select-matches]').onclick=()=>{if(this.onSelectMatches)this.onSelectMatches(this.matchIds||[]);else this.select(this.matchIds||[]);};
    }
    for(const [key,c]of this.circles)c.tag.setAttribute('aria-pressed',String(keys.has(key)));
    this.el.classList.toggle('has-focus',!!active);this.focusMatches();
    if(this.el.id==='world'){document.body.classList.toggle('sea-focus',!!active);const body=$('#main .screen-body');if(body)body.inert=!!active&&World.mode==='ambient';World.fence();}
    this.layout();
    this.settled=false;this.worker.postMessage({kind:'focus',focus:this.focusState()});this.kick();
  }
  focusMatches(){
    const f=this.focusState(),active=f.keys.length||f.cluster,ids=new Set(f.ids);
    const hits=(this.bodies||[]).filter(b=>active&&(ids.size?ids.has(b.id):f.cluster?this.items.get(b.id)?.cluster===f.cluster:f.any?f.keys.some(t=>b.tags.includes(t)):f.keys.every(t=>b.tags.includes(t)))).map(b=>b.id);
    this.focusPrimary=new Set(hits.slice(0,12));
    const signature=`${f.keys.join('|')}:${f.any}:${f.cluster}:${hits.join(',')}`;if(signature===this.focusSignature)return;this.focusSignature=signature;
    this.matchIds=hits;
  }
  clusterLabels(clusters,membership){
    const incoming=new Set(clusters.map(c=>c.id)),previous=[...this.lassos.values()].filter(l=>l.auto),used=new Set();
    const members=new Map(clusters.map(c=>[c.id,new Set()]));
    this.bodies.forEach((body,i)=>{const it=this.items.get(body.id),id=clusters[membership[i]-1]?.id;if(it)it.cluster=id;members.get(id)?.add(body.id);});
    const names=new Set();
    for(const c of clusters){
      let l=this.lassos.get(c.id);
      // A new descriptor must not replace the same flock's colour, control and outline. A genuinely new flock does.
      if(!l){
        const ids=members.get(c.id);let best=.75;
        for(const old of previous){
          if(used.has(old)||incoming.has(old.id)||!old.members||!old.tags?.some(t=>c.tags.includes(t)))continue;
          let shared=0;for(const id of ids)if(old.members.has(id))shared++;
          const overlap=shared/Math.max(ids.size,old.members.size);
          if(overlap>=best){l=old;best=overlap;}
        }
        if(l){const old=l.id;this.lassos.delete(old);l.id=c.id;l.tag.dataset.lasso=c.id;this.lassos.set(c.id,l);
          const shape=this.contours?.get(old);if(shape)this.contours.set(c.id,shape);
          if(this.focusCluster===old)this.focusCluster=c.id;
        }
      }
      if(!l){l={id:c.id,auto:true,kind:'sugg',hue:hueOf(c.id),x:0,y:0,tag:document.createElement('button')};l.tag.className='vn-lasso-tag is-auto';l.tag.dataset.lasso=c.id;l.tag.tabIndex=-1;
        l.tag.onclick=e=>{e.stopPropagation();this.focusLasso(l.id);};
        l.tag.onpointerenter=()=>{l.still=true;this.draw(this.width,this.height);};l.tag.onpointerleave=()=>{l.still=false;this.draw(this.width,this.height);};
        this.tagRow.append(l.tag);this.lassos.set(c.id,l);}
      used.add(l);l.members=members.get(c.id);l.tags=c.tags;l.count=c.count;l.tag.hidden=!c.count;
      const words=c.tags.map(t=>this.circles.get(t)?.label||t.replace(/^[^:]+:/,'').replaceAll('_',' '));
      const first=words[0]||'Photo';
      // One voice with the Groups page: the lead tag's playful name (from the server), else the tags themselves.
      const lead=c.tags.map(t=>this.circles.get(t)).find(v=>v?.catchy?.length)?.catchy||[];
      let name=lead.find(n=>!names.has(n))||lead[0]||(words[1]?`${first} & ${words[1]}`:`${first} crew`);
      if(names.has(name))name+=` · ${words[1]||first}`;if(names.has(name))name+=` ${names.size+1}`;names.add(name);
      const html=`<b>${esc(name)}</b> <span class="ps-count">${fmt(c.count)}</span><small>${words.slice(0,2).map(esc).join(' · ')}</small>`;
      if(l.tag.innerHTML!==html){l.tag.innerHTML=html;l.w=0;}l.tag.title=words.join(' · ');
    }
    for(const l of previous)if(!used.has(l)){l.tag.remove();this.lassos.delete(l.id);}
    // Only opening or closing the shelf changes available water; ordinary label updates cannot restart the worker.
    const shelf=!!(this.catalog&&!this.catalogSuppressed&&!this.paused&&(this.keys.length||this.lassos.size));
    if(this.tray.hidden===shelf&&!this.catalogLayoutQueued){this.catalogLayoutQueued=true;requestAnimationFrame(()=>{
      this.catalogLayoutQueued=false;if(this.alive)this.layout();
    });}
  }
  receive(m){
    this.busy=false;this.settled=!!m.settled;
    if(!this.alive||m.generation!==this.generation){this.kick();return;}
    this.buffer=m.positions.buffer;this.workerMs=m.ms;
    const now=performance.now(),gap=this.arrivedAt?now-this.arrivedAt:50;this.arrivedAt=now;
    this.glideMs=Math.max(35,Math.min(100,(this.glideMs||50)*.8+Math.min(gap,150)*.2));
    const glide=`${Math.round(this.glideMs)}ms`;if(this.glide!==glide){this.el.style.setProperty('--sea-glide',glide);this.glide=glide;}
    if(m.clusters)this.clusterLabels(m.clusters,m.membership);
    if(m.contours)this.contours=new Map(m.contours.map(c=>[c.id,c]));
    // A large selection needs constant-time membership checks for each returning worker body.
    const wanted=[],released=new Set((this.releasePins||[]).map(p=>p.id));let moved=false;
    this.bodies.forEach((body,i)=>{
      const it=this.items.get(body.id);if(!it)return;
      if(it.id!==this.held&&!this.drag?.members.has(it)&&!released.has(it.id)){const x=m.positions[i*3],y=m.positions[i*3+1];if((it.density||it.imagePending)&&(x!==it.x||y!==it.y))moved=true;it.x=x;it.y=y;}
      const size=m.positions[i*3+2];if((it.density||it.imagePending)&&size!==it.size)moved=true;it.size=size;it.focused=!!this.focusPrimary?.has(it.id);
      if(it.focused&&wanted.length<48)wanted.push(it.id);
    });
    if(moved)this.densityDirty=this.spritesDirty=true;
    // Only the working shots need individual image nodes and large previews.
    let promoted=false;for(const id of wanted){const it=this.items.get(id);if(it.density){this.promote(id,false);promoted=true;}}
    if(promoted)this.layout();
    const cap=this.bigCap();
    if(this.items.size>400){for(const it of this.moving)if(this.moving.length>cap&&!it.focused&&!it.selected&&it.id!==this.held&&!this.drag?.members.has(it)&&!it.el.classList.contains('lifted')){it.density=true;this.cancelImage(it);this.smallPreview(it);it.el.replaceChildren();it.el.remove();this.moving=this.moving.filter(x=>x!==it);this.densityDirty=this.spritesDirty=true;if(this.presentation?.item===it)this.presentation.follow();}}
    for(const it of this.moving){const lifted=it.el.classList.contains('lifted');if(it.imagePending&&it.lifted!==lifted)this.densityDirty=this.spritesDirty=true;it.lifted=lifted;}
    for(const it of this.takes||[]){
      // A metadata update can separate a take before the debounced body list catches up.
      if(!it.take)continue;
      const rep=this.items.get(it.stack),hidden=!!rep?.lifted;
      if(it.pileLifted!==hidden){if(it.density||it.imagePending)this.densityDirty=this.spritesDirty=true;it.pileLifted=hidden;it.el.classList.toggle('pile-lifted',hidden);}
      if(rep){const x=rep.x+(it.pileX||0)*(rep.size||this.s),y=rep.y+(it.pileY||0)*(rep.size||this.s);if((it.density||it.imagePending)&&(x!==it.x||y!==it.y||rep.size!==it.size))this.densityDirty=this.spritesDirty=true;it.x=x;it.y=y;it.size=rep.size;it.cluster=rep.cluster;}
    }
    const {zoom=1,tx=0,ty=0}=this.camera||{},x0=-tx/zoom,y0=-ty/zoom,x1=x0+this.width/zoom,y1=y0+this.height/zoom;
    for(const it of this.moving){
      const size=(it.size||this.s)*zoom;this.paintItem(it);
      // A print whose size and focus have not changed keeps its classes and picture: a thousand live prints must
      // not cost a thousand lookups a frame while only the camera moves.
      if(it.shownSize===size&&it.shownFocus===!!it.focused)continue;
      it.shownSize=size;it.shownFocus=!!it.focused;
      it.el.classList.toggle('focused',!!it.focused);it.el.classList.toggle('is-tiny',size<this.tuning.tinyMax);it.el.classList.toggle('is-small',size<this.tuning.badgeMin);
      // Only a print on screen fetches the level its size needs; one filling four fifths of the screen the original.
      const onScreen=this.inView(it,x0,y0,x1,y1,0);
      if(onScreen){const full=this.fullSize(it);this.requestImage(it,it.focused&&size>64&&!full?P(it.photo):M(it.photo,size,full));}
    }
    const count=this.focusBar.querySelector('[data-focus-count]'),text=`${fmt(m.focusCount)} shots`;if(count&&count.textContent!==text)count.textContent=text;
    const select=this.focusBar.querySelector('[data-select-matches]');if(select)select.hidden=!m.focusCount;
    if(this.densityDirty&&(this.gpu||!this.densityAt||now-this.densityAt>(this.items.size>4000?80:32))){
      this.drawDensity(this.width,this.height);this.densityAt=now;
    }
    if(m.contours||!this.geometryAt||now-this.geometryAt>300){this.draw(this.width,this.height);this.geometryAt=now;}
    this.el.dataset.photos=this.items.size;this.el.dataset.density=this.items.size-this.moving.length;
    this.kick();
  }
  tick(now){
    this.raf=0;
    if(!this.alive||!this.el.isConnected){this.destroy();return;}
    if(this.paused||document.hidden||this.deep)return;  // deep in one print nothing moves; setCamera kicks on the way out
    if(this.busy||!this.ready){this.kick();return;}
    // A settled world asks the worker rarely; a hold, drag or pin brings the full rate back.
    const idle=this.settled&&!this.drag&&this.held==null&&!this.releasePins&&!this.pan;
    const sprites=this.items.size>this.moving.length;
    if(this.last&&now-this.last<(idle?(sprites?100:200):this.items.size>400?32:16)){this.kick();return;}this.last=now;this.wobbleNow=now;if(idle&&sprites&&!this.gpu&&(this.spriteMax||0)*(this.camera?.zoom||1)>=30)this.densityDirty=true;  // a visible sprite wobble on the 2D canvas; the GPU has its own loop
    const m=this.mouse;
    let held=this.drag?this.dropTarget?.stack||null:null;
    if(!this.drag&&!this.bounds().obstacles.some(o=>m.x>o.x0&&m.x<o.x1&&m.y>o.y0&&m.y<o.y1)){
      const previous=this.items.get(this.held),items=previous?[previous,...this.moving]:this.moving;
      for(const it of items){const s=it.size||this.s;if(!it.lifted&&Math.abs(it.x-m.x)<s*.62&&Math.abs(it.y-m.y)<s*.62){held=it.stack;break;}}
    }
    this.hold(held);
    if(this.settled&&!this.drag&&this.held==null&&!this.releasePins&&!this.pan){
      if(this.densityDirty)this.drawDensity(this.width,this.height);
      return;
    }
    const pinned=[...(this.drag?.items||[])],caught=this.items.get(this.held);if(caught)pinned.push(caught);
    const message={kind:'step',time:now,held:this.held,pins:[...(this.releasePins||[]),...pinned.map(it=>({id:it.stack,x:it.x,y:it.y}))],dragged:this.drag?.moving?this.drag.items.map(it=>it.stack):[],lifted:this.moving.filter(it=>it.el.classList.contains('lifted')).map(it=>it.stack),buffer:this.buffer};this.releasePins=null;
    this.busy=true;
    this.worker.postMessage(message,this.buffer?[this.buffer]:[]);this.buffer=null;
  }
  destroy(){
    this.densityPixels=null;this.densityTiles=null;this.previewVersions=null;this.paintOrder=null;this.spriteImages=null;
    clearTimeout(this.wobbleTimer);clearTimeout(this.contourTimer);cancelAnimationFrame(this.paintRaf);this.gpu?.destroy();this.gpu=null;this.glBatches=null;
    clearTimeout(this.bodyTimer);cancelAnimationFrame(this.contourFadeRaf);this.contourFadeRaf=null;
    if(this.contourRaster){for(const canvas of new Set([this.contourRaster.current,this.contourRaster.spare]))if(canvas)canvas.width=canvas.height=0;this.contourRaster=null;}
    this.worker?.terminate();document.removeEventListener('visibilitychange',this.wake);for(const type of ['pointermove','pointerdown','pointerup','pointercancel'])document.removeEventListener(type,this.proxyPointer);
    document.removeEventListener('wheel',this.wheelZoom);document.removeEventListener('dblclick',this.doubleReset);clearTimeout(this.cullTimer);this.dock?.classList.remove('tag-dock');this.tray.remove();super.destroy();
  }
  draw(W, H) {
    const x=this.ctx,dpr=window.devicePixelRatio||1,now=performance.now(),layers=[];let catalogDirty=false;
    this.contourPaintAt=now;
    if(this.contourCountsGeneration!==this.generation){
      this.contourCounts=new Map();this.contourCountsGeneration=this.generation;
      for(const body of this.bodies||[]){const it=this.items.get(body.id),id=it&&this.labelOf(it);if(id)this.contourCounts.set(id,(this.contourCounts.get(id)||0)+1);}
      catalogDirty=true;
    }
    const geometry=[],style=[];
    for(const [id,l]of this.lassos){
      const shape=this.contours?.get(id),hidden=!(this.contourCounts?.get(id)||l.auto&&l.count);
      if(l.tag.hidden!==hidden){l.tag.hidden=hidden;catalogDirty=true;}
      if(l.tag.parentElement!==this.tagRow){this.tagRow.append(l.tag);l.tag.style.transform='';catalogDirty=true;}
      l.contourCurrent=shape;l.contourFrom=null;
      if(this.lassos_on===false||hidden)continue;
      const hot=l.still||this.focusCluster===id;
      style.push(`${id}:${l.hue}:${l.kind}:${!!hot}`);
      if(!shape)continue;
      const paths=hot?shape.hotPaths||shape.paths:shape.paths;
      if(!paths?.length)continue;
      layers.push({l,shape,paths,hot});
      geometry.push(`${id}:${shape.key??shape}:${Math.round((shape.opacity??1)*100)}`);
    }
    const {zoom,tx,ty}=this.camera||{zoom:1,tx:0,ty:0},size=`${W}:${H}:${dpr}:${zoom.toFixed(3)}:${Math.round(tx)}:${Math.round(ty)}`,signature=geometry.join('|'),appearance=style.join('|');
    let raster=this.contourRaster;
    if(!raster||raster.signature!==signature||raster.appearance!==appearance||raster.size!==size){
      const sameSize=raster?.size===size,sameStyle=raster?.appearance===appearance;
      const canvas=raster?.spare||document.createElement('canvas'),ctx=canvas.getContext('2d');
      const width=Math.max(1,Math.round(W*dpr)),height=Math.max(1,Math.round(H*dpr));
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
      // Tessellate each new shore once, in screen pixels (a dash is a dash at any zoom; under the zoom transform a
      // shore at 40× was tens of thousands of dashes) and only the shores that reach into the view. Crossfade
      // frames only composite these two bounded bitmaps.
      const X=v=>v*zoom+tx,Y=v=>v*zoom+ty,reach=4;
      for(const {l,shape,paths,hot}of layers){
        let any=false;ctx.globalAlpha=hot?1:shape.opacity??1;ctx.beginPath();
        for(const h of paths){
          let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const p of h){if(p[0]<x0)x0=p[0];if(p[0]>x1)x1=p[0];if(p[1]<y0)y0=p[1];if(p[1]>y1)y1=p[1];}
          if(X(x1)<-reach||X(x0)>W+reach||Y(y1)<-reach||Y(y0)>H+reach)continue;any=true;
          const last=h[h.length-1];ctx.moveTo(X((last[0]+h[0][0])/2),Y((last[1]+h[0][1])/2));
          for(let i=0;i<h.length;i++){const p=h[i],q=h[(i+1)%h.length];ctx.quadraticCurveTo(X(p[0]),Y(p[1]),X((p[0]+q[0])/2),Y((p[1]+q[1])/2));}ctx.closePath();
        }
        if(!any)continue;
        ctx.fillStyle=`hsla(${l.hue},80%,60%,${hot?.12:.035})`;ctx.fill('evenodd');
        ctx.lineWidth=hot?2:1.3;ctx.setLineDash(l.kind==='sugg'&&zoom<8?[6,7]:[]);
        ctx.strokeStyle=`hsla(${l.hue},85%,70%,${hot?.8:.55})`;ctx.stroke();
      }
      ctx.globalAlpha=1;ctx.setLineDash([]);
      const animate=!reduceMotion&&(!raster||sameSize&&sameStyle);
      raster=this.contourRaster={signature,appearance,size,cam:{zoom,tx,ty},current:canvas,spare:raster?.current,
        previous:animate&&sameSize?raster?.current:null,since:animate?now:now-220,nonempty:!!layers.length};
      catalogDirty=true;
    }
    x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,W,H);x.save();if(this.canvas.style.transform)this.canvas.style.transform='';  // drawn for this camera: crisp again
    for(const o of [...(this.obstacles||[]),...(this.catalogRect?[this.catalogRect]:[])]){
      x.beginPath();x.rect(0,0,W,H);x.rect(o.x0,o.y0,o.x1-o.x0,o.y1-o.y0);x.clip('evenodd');
    }
    const progress=reduceMotion?1:Math.min(1,(now-raster.since)/220);
    if(raster.previous&&progress<1){x.globalAlpha=1-progress;x.drawImage(raster.previous,0,0,W,H);}
    if(progress&&raster.nonempty){x.globalAlpha=progress;x.drawImage(raster.current,0,0,W,H);}
    x.globalAlpha=1;x.restore();
    if(progress===1)raster.previous=null;
    if(catalogDirty||this.catalogContours!==this.contours){this.catalogTabStop();this.catalogContours=this.contours;}
    // Hover/focus is immediate; only geometry changes receive a short, bounded fade.
    if(progress<1&&(raster.previous||raster.nonempty)&&!this.contourFadeRaf&&!this.paused&&!document.hidden){
      const next=()=>{this.contourFadeRaf=null;if(!this.alive||this.paused||document.hidden)return;
        if(performance.now()-this.contourPaintAt<32)this.contourFadeRaf=requestAnimationFrame(next);else this.draw(this.width,this.height);
      };
      this.contourFadeRaf=requestAnimationFrame(next);
    }
    this.dockChanged=false;
  }
  binAt(e) {  // a group's label in the sea, or its bin in the side list
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && !el.closest(".ps-item") && !el.closest('.vn-lasso-tag') ? el.closest("[data-bin]") : null;
  }
  // A print takes priority over its group's lasso: drop on paper to stack, or in the surrounding water to file.
  // Filter keeps its own throwing gesture; comparison screens keep their own choices.
  target(x,y,excluded=[]){
    if(this.cameraOn&&this.el.id==='world'&&!this.outcomeFlow&&!this.el.classList.contains('filter-world')){
      const [sx,sy]=this.toScreen(x,y),r=this.el.getBoundingClientRect();
      if(!this.uiTarget(document.elementFromPoint(r.left+sx,r.top+sy),true)){
        const photo=this.photoAt(x,y,excluded);if(photo)return {kind:'photo',id:photo.id};
      }
    }
    const inside=(path,px,py)=>{let hit=false;for(let i=0,j=path.length-1;i<path.length;j=i++){const [xi,yi]=path[i],[xj,yj]=path[j];if((yi>py)!==(yj>py)&&px<(xj-xi)*(py-yi)/(yj-yi)+xi)hit=!hit;}return hit;};
    for(const [key,shape] of this.contours||[]){
      if(!/^g\d+$/.test(key)||this.lassos.get(key)?.kind!=='group')continue;
      for(const path of shape?.paths||[])if(path.length>2&&inside(path,x,y))return {kind:'group',id:Number(key.slice(1))};
    }
    return {kind:'sea'};
  }
  mark(target) {
    const next=target?.kind==='photo'?this.items.get(target.id):null;
    if(next!==this.dropTarget){
      this.dropTarget?.el.classList.remove('ps-hot');this.dropTarget=next;
      if(next?.density){this.promote(next.id,false);this.densityDirty=this.spritesDirty=true;this.kick();}
      this.hold(next?.stack||null);
      if(next){next.el.classList.add('ps-hot');this.paintItem(next);}
    }
    this.hint.hidden=!next;
    if(next){
      this.hint.textContent='Drop to stack';
      const [x,y]=this.toScreen(next.x,next.y+(next.size||this.s)*2/3*1.15);
      this.hint.style.transform=`translate(${Math.max(66,Math.min(this.el.clientWidth-66,x))}px,${Math.max(8,Math.min(this.el.clientHeight-40,y+12))}px) translateX(-50%)`;
    }
  }

}
