// A focused print carries its writing and sticky notes. The longer story stays on the sheet underneath it.
// Only focused, live cards load that story; the thousands of thumbnails and sea sprites stay lightweight.
const PhotoNotes = {
  hosts:new Map(), cache:new Map(), pending:new Map(), drafts:new Map(), source:null, paperID:0, page:'notes',
  init() {
    const queue=()=>{if(this.queued)return;this.queued=requestAnimationFrame(()=>{this.queued=0;this.scan();});};
    this.queue=queue;
    this.observer=new MutationObserver(records=>{
      if(records.some(r=>!r.target.closest?.('#world,.photo-notes-paper,.photo-notes-tab,.photo-writing,.photo-sticky,svg.marks,.user-note,#toolbelt,#history-hud,#af-defs')&&
        [...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1)))queue();
    });
    this.observer.observe(document.body,{childList:true,subtree:true});
    window.addEventListener('sea-camera',e=>this.camera(e.detail.sea));
    window.addEventListener('sea-image-ready',()=>{if(!this.seaDetail)this.camera();});
    window.addEventListener('resize',()=>{queue();requestAnimationFrame(()=>{this.repaint();this.position();});});
    window.addEventListener('photo-render-change',()=>this.repaint());
    document.addEventListener('visibilitychange',()=>{if(document.hidden&&this.active)this.saveWriting(this.active);});
    window.addEventListener('hashchange',()=>{this.close(false);this.clearSea();queue();});
    document.addEventListener('close',e=>{if(!e.target.open&&e.target.contains(this.sheet))this.close(false);},true);
    // Escape dismisses this local layer first. Inputs and the searchable picker keep their native keys.
    document.addEventListener('keydown',e=>{
      if(!this.sheet)return;
      if(e.target.closest('.photo-crop-editor,.photo-mask-editor'))return;
      if(e.key==='Escape'){
        if(e.target.closest('.tag-picker')?.querySelector('[aria-expanded=true]'))return;
        e.preventDefault();e.stopImmediatePropagation();this.close();return;
      }
      if(!this.sheet.contains(e.target)&&!e.target.closest('input,textarea,select,#toolbelt')&&
        ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Enter','w','a','s','d','x','c','f','r'].includes(e.key.toLowerCase().startsWith('arrow')?e.key:e.key.toLowerCase())){
        e.preventDefault();e.stopImmediatePropagation();
      }
    },true);
    window.addEventListener('photo-changed',e=>{
      if(e.detail.source!==S.lib?.source)return;
      this.cache.clear();this.pending.clear();clearTimeout(this.refreshTimer);
      if(this.busy)return; // The sheet action refreshes its card and sheet together.
      this.refreshTimer=setTimeout(()=>{
        this.scan();
        if(this.sheet&&e.detail.path!=='/api/edit')this.reload().catch(error=>toast(error.message));
      },80);
    });
    Toolbelt.listeners.add((pid,edits)=>{
      const sea=World.sea;for(const it of sea?.moving||[])if(it.photo===pid)sea.frameImage(it);
      for(const [host,state] of this.hosts)if(state.pid===pid){if(state.data)state.data.edits=edits;this.decorate(host,state);}
      if(this.active?.pid===pid&&this.active.data){
        const active=this.active;active.data.edits=edits;
        if(active.draft&&!active.dirty&&!active.writing){active.draft=this.writingOf(edits);this.fillWriting();}
        this.controls();
      }
    });
    queue();
  },
  scan() {
    const source=S.lib?.source||'';
    if(source!==this.source){this.close(false);this.clearSea();this.source=source;this.cache.clear();this.pending.clear();for(const host of this.hosts.keys())this.detach(host);}
    for(const [host,state] of this.hosts){
      if(!host.isConnected||!host.getClientRects().length||Toolbelt.pidOf(host)!==state.pid)this.detach(host);
    }
    if(!source)return;
    for(const host of $$('.print:not(.world-fly)'))if(!host.closest('#world'))this.attach(host);
    for(const [host,state] of this.hosts)if(!state.loading&&!this.cache.has(state.pid))this.load(host,state);
    if(this.active&&!this.active.host.isConnected)this.close(false);
  },
  clearSea() {
    clearTimeout(this.seaTimer);this.seaTimer=null;
    this.cameraVersion=(this.cameraVersion||0)+1;
    if(this.seaDetail){this.detach(this.seaDetail);this.seaDetail.remove();this.seaDetail=null;}
    if(this.seaPose&&this.seaPose.sea.presentation===this.seaPose)this.seaPose.sea.presentation=null;
    this.seaLayer?.remove();this.seaLayer=null;this.seaPose=null;
    this.seaSource?.classList.remove('photo-detail-source');this.seaSource=null;
  },
  followSea() {
    const pose=this.seaPose;if(!pose)return;
    const {sea,item:it,zoom,size}=pose,c=sea.camera,s=it.size||sea.s;
    if(!sea.alive||sea!==World.sea||sea.items.get(it.id)!==it||it.photo!==pose.photo||it.take||it.density||!it.el.isConnected||it.el.classList.contains('lifted')||
      !sea.inView(it,-c.tx/c.zoom,-c.ty/c.zoom,(sea.el.clientWidth-c.tx)/c.zoom,(sea.el.clientHeight-c.ty)/c.zoom,0)){
      this.clearSea();return;
    }
    // These are the world's two transforms, with a fixed reference size for the writing and stickies. Moving the
    // camera never reframes, reloads or replaces the photograph, or restarts its paper animation.
    const camera=`translate(${c.tx.toFixed(2)}px,${c.ty.toFixed(2)}px) scale(${(c.zoom/zoom).toFixed(7)})`;
    if(this.seaLayer.style.transform!==camera)this.seaLayer.style.transform=camera;
    const [wx,wy]=sea.waveOffset(it),px=Number(it.x.toFixed(2))+wx,py=Number(it.y.toFixed(2))+wy,
      body=`translate3d(${(px*zoom).toFixed(3)}px,${(py*zoom).toFixed(3)}px,0) translate(-50%,-50%) scale(${(it.renderScale||1)*s/size})`;
    if(this.seaDetail.style.transform!==body)this.seaDetail.style.transform=body;
    this.seaDetail.classList.toggle('pinned',it.el.classList.contains('pinned'));
    // The sheet follows the print, but lays out its writing in screen pixels. Scaling its controls with the
    // world made a perfectly ordinary font unreadable after zooming back from a close-up.
    const under=this.seaDetail.querySelector('.sea-note-underlay');
    if(under){
      const scale=c.zoom/zoom*(it.renderScale||1)*s/size,width=size*zoom*scale,height=width*4/3;
      under.style.width=`${width}px`;under.style.height=`${height}px`;under.style.transform=`scale(${1/scale})`;
      if(this.active?.host===this.seaDetail)this.seaSheet(under,{width,height,
        left:px*c.zoom+c.tx-width/2,top:py*c.zoom+c.ty-height/2});
    }
  },
  seaSheet(under,photo) {
    const {margin,width,height}=this.paperSize(photo.width),
      left=Math.max(margin,Math.min(photo.left+photo.width+18,innerWidth-margin-width-52)),
      top=Math.max(margin,Math.min(photo.top,innerHeight-margin-height-132));
    for(const [key,value] of Object.entries({width,height,x:left-photo.left,y:top-photo.top}))this.sheet.style.setProperty(`--notes-${key}`,`${value}px`);
    under.classList.toggle('notes-overlap',left<photo.left+photo.width);
  },
  paperSize(photoWidth) {
    const actions=this.active?.host?.closest('.viewer')?.querySelector('.viewer-actions'),bottom=Math.min(innerHeight,actions?actions.getBoundingClientRect().top-8:innerHeight),
      margin=innerWidth<760?8:16,top=this.active?.host?.closest('.focus-camera')?Math.max(margin,$('#topbar').getBoundingClientRect().bottom+8):margin,
      maxWidth=Math.min(innerWidth-2*margin-52,(bottom-top-margin-132)*3/4),
      width=Math.max(Math.min(300,maxWidth),Math.min(photoWidth,maxWidth));
    return {margin,top,width,height:width*4/3,bottom};
  },
  camera(sea=World.sea) {
    if(sea!==World.sea)return;
    clearTimeout(this.seaTimer);this.seaTimer=null;this.cameraVersion=(this.cameraVersion||0)+1;
    if(!['ambient','live'].includes(World.mode)||!sea?.cameraOn||sea.camera.zoom<=1){this.clearSea();return;}
    this.followSea();
    const version=this.cameraVersion;
    this.seaTimer=setTimeout(()=>{
      if(!sea.cameraOn||this.seaDetail)return;
      const visible=[...sea.items.values()].filter(it=>!it.take&&!it.imagePending&&sea.fullSize(it)&&it.el.isConnected&&!it.el.classList.contains('lifted'));
      const chosen=visible.map(it=>({it,r:it.el.getBoundingClientRect()})).filter(({r})=>r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight)
        .sort((a,b)=>Math.hypot(a.r.left+a.r.width/2-innerWidth/2,a.r.top+a.r.height/2-innerHeight/2)-Math.hypot(b.r.left+b.r.width/2-innerWidth/2,b.r.top+b.r.height/2-innerHeight/2))[0];
      if(!chosen)return;
      const {it,r}=chosen,detail=document.createElement('div');detail.className='print sea-photo-detail';detail.dataset.photo=it.photo;
      const zoom=sea.camera.zoom,size=it.size||sea.s;
      detail.style.cssText=`left:0;top:0;width:${size*zoom}px;height:${size*zoom*4/3}px;transition:none`;
      const img=document.createElement('img');img.src=it.el.querySelector('.pile-cover')?.getAttribute('src')||M(it.photo,r.width,true);img.alt='Focused photo';img.draggable=false;detail.append(img);
      detail.onpointerdown=e=>{if(e.target.closest('button,a,input,textarea,select,label,summary,[contenteditable],.grade-wheel,.meta.sticky')||Toolbelt.tool!=='hand')return;e.stopPropagation();
        if(sea.overZoomed(it.el)||e.button===1)sea.panStart(e);else sea.down(e,it.el);};
      detail.ondblclick=e=>{if(e.target.closest('button,input,textarea,.meta.sticky'))return;e.preventDefault();e.stopPropagation();
        if(sea.overZoomed(it.el))sea.resetCamera();else sea.onSelect?.(it,e);};
      img.decode().then(()=>{
        if(this.seaDetail||this.cameraVersion!==version||!it.el.isConnected)return;
        this.seaDetail=detail;this.seaSource=it.el;
        const layer=document.createElement('div');layer.className='sea-photo-detail-layer';layer.append(detail);document.body.append(layer);this.seaLayer=layer;
        const pose={sea,item:it,photo:it.photo,zoom,size,follow:()=>this.followSea()};this.seaPose=pose;sea.presentation=pose;this.followSea();
        if(!this.seaDetail)return;
        it.el.classList.add('photo-detail-source');Cards.focus(detail);
        // The real clip stays on its pile; this matching control remains reachable above the focused notes layer.
        if(it.n>1)detail.insertAdjacentHTML('beforeend',Cards.stack(it.n,it.photo));
        this.attach(detail);this.followSea();Toolbelt.arm(detail);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{if(detail.isConnected)detail.style.transition='';}));
      }).catch(()=>{});
    },250);
  },
  attach(host) {
    if(this.hosts.has(host)||host.closest('#world,button,.an-grab,#an-sea,.world-fly,#history-hud')||!host.getClientRects().length)return;
    const pid=Toolbelt.pidOf(host);if(!pid)return;
    if(host.matches('.print'))Cards.focus(host);
    if(typeof FocusGlow!=='undefined'&&host!==this.seaDetail&&!host.closest('.tile:not(.board-card),.ftile')){
      const img=host.querySelector('.window img');
      if(img?.complete&&img.naturalWidth)FocusGlow.attach(host,img);
      else img?.addEventListener('load',()=>FocusGlow.attach(host,img),{once:true});
    }
    const tab=document.createElement('button');tab.type='button';tab.className='photo-notes-tab';
    tab.innerHTML='<span>notes</span>';tab.setAttribute('aria-label','Open photo notes');tab.setAttribute('aria-expanded','false');
    for(const type of ['pointerdown','dblclick','dragstart'])tab.addEventListener(type,e=>e.stopPropagation());
    tab.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key))e.stopPropagation();});
    tab.onclick=e=>{e.preventDefault();e.stopPropagation();this.active?.host===host?this.close():this.open(host);};
    const paper=document.createElement('div');paper.className='photo-notes-paper rail-card';paper.id=`photo-notes-${++this.paperID}`;
    paper.append(tab);host.classList.add('has-photo-notes');
    const under=document.createElement('div');under.className='photo-note-underlay'+(host===this.seaDetail?' sea-note-underlay':'');under.append(paper);host.append(under);
    paper.addEventListener('pointerdown',e=>{
      const zoom=Number(host.dataset.viewerZoom)||(host===this.seaDetail?World.sea?.camera.zoom:1);
      if(Toolbelt.tool!=='hand'||zoom<=1.001||!this.panTarget(e.target,e.pointerType))e.stopPropagation();
    });
    for(const type of ['click','dblclick','wheel'])paper.addEventListener(type,e=>e.stopPropagation());
    paper.addEventListener('click',()=>{if(!paper.classList.contains('photo-note-sheet')&&!paper.classList.contains('notes-returning'))this.open(host);});
    const state={pid,tab,paper,data:null,motion:0};this.hosts.set(host,state);this.load(host,state);
  },
  detach(host) {
    if(this.active?.host===host)this.close(false);
    const state=this.hosts.get(host);if(state)state.motion++;
    for(const el of $$(':scope > .photo-note-underlay,:scope > .photo-writing,:scope > .photo-facts',host))el.remove();
    host.classList.remove('has-photo-notes','has-photo-sticky');this.hosts.delete(host);
  },
  async get(pid) {
    if(this.cache.has(pid))return this.cache.get(pid);
    if(this.pending.has(pid))return this.pending.get(pid);
    const source=this.source;
    const task=api(`/api/photo/${pid}/notes`).then(data=>{
      if(source!==this.source||this.pending.get(pid)!==task)return null;
      if(this.cache.size>=100)this.cache.delete(this.cache.keys().next().value);
      this.cache.set(pid,data);return data;
    }).finally(()=>{if(this.pending.get(pid)===task)this.pending.delete(pid);});
    this.pending.set(pid,task);return task;
  },
  async load(host,state) {
    state.loading=true;
    try{
      const data=await this.get(state.pid);if(!data||this.hosts.get(host)!==state)return;
      state.data={...data,edits:Toolbelt.edits.has(state.pid)?Toolbelt.current(state.pid):data.edits};
      if(!Toolbelt.edits.has(state.pid)&&!Toolbelt.loading.has(state.pid))Toolbelt.know(state.pid,data.edits);
      this.decorate(host,state);
    }catch(_){/* The tab can retry and show an error without interrupting play. */}
    finally{state.loading=false;}
  },
  decorate(host,state) {
    const p=state.data;if(!p)return;
    let writing=$(':scope > .photo-writing',host);
    if(!writing){writing=document.createElement('div');writing.className='photo-writing';host.append(writing);}
    // The Leaderboard already writes the file and date on its chin; a personal title takes the place above it.
    writing.textContent=p.edits?.title||(!host.querySelector('.chin')?p.rel.split(/[\\/]/).at(-1):'');
    writing.hidden=!writing.textContent;
    const chin=host.querySelector('.chin');
    if(chin){
      let title=$('.chin-title',chin);
      if(p.edits?.title){if(!title){title=document.createElement('span');title.className='chin-title';chin.prepend(title);}title.textContent=p.edits.title;}
      else title?.remove();writing.hidden=true;
    }
    host.classList.toggle('notes-caption',!!host.querySelector('.paper > .role,.paper > .stack:not(.stack-clip)'));
    let facts=$(':scope > .photo-sticky',host);
    host.classList.add('has-photo-sticky');host.dataset.note=JSON.stringify(p.edits?.note||null);
    if(!host.querySelector('.meta.sticky:not(.user-note):not(.photo-sticky)')){
      if(!facts){
        facts=document.createElement('div');facts.className='meta sticky photo-sticky photo-facts';facts.title='Drag me where you like';host.append(facts);
        for(const type of ['pointerdown','pointerup','click','dblclick'])facts.addEventListener(type,event=>event.stopPropagation());
        Toolbelt.dragNote(facts,host,(x,y)=>Toolbelt.save(state.pid,{note:[x,y]}));
      }
      const ranking=p.ranking;
      facts.innerHTML=photoSticky({photo:p.id,rank:ranking?.rank,p_in:ranking?.inclusion,appeal:ranking?.appeal,duels:ranking?.duels,
        bubble:ranking?.bubble,active:ranking?.active??!p.cut,frames:p.stack.members.length,flags:p.flags,
        rescued:p.flags.some(f=>f.startsWith('rescued:')),added:p.pick||facts.dataset.noteAdded==='true'},p.tags,
        {change:facts.dataset.noteChange||'',controls:host.matches('.board-card')});
    }else facts?.remove();
    placeNote(host);
    if(host.matches('.print')||host.classList.contains('framed-photo')||['crop','rotate','look','enhance','straighten','auto_align','skew','auto_skew','composition'].some(k=>k in (p.edits||{})))this.preview(host,p,p.edits);
  },
  repaint() {
    const sea=World.sea;for(const it of sea?.moving||[])sea.frameImage(it);
    for(const [host,state] of this.hosts)if(state.data&&host.isConnected&&host.matches('.print,.framed-photo')){placeNote(host);this.preview(host,state.data,Toolbelt.current(state.pid));}
    this.controls();
  },
  preview(host,p,edits) {
    AutoLook.know(p.id,p.auto_look);
    if(this.active?.host===host&&this.active.comparing)edits=this.originalEdits();
    if(host===this.seaDetail&&this.seaPose?.photo===p.id){
      // The detail layer carries the writing, not a second visible photograph. Every preview must reach the
      // real print, and decoding a new image level must keep that preview until it is released or saved.
      this.seaPose.previewEdits=edits;this.seaPose.sea.frameImage(this.seaPose.item);
    }
    let img=host.querySelector('.window img');
    if(!img){
      Cards.focus(host);img=host.querySelector('.window img');if(!img)return;
    }
    const frame=()=>{
      if(!host.isConnected)return;
      host.dataset.photo=p.id;host.dataset.frame='own';host.dataset.box=JSON.stringify(p.subject||null);
      host.dataset.crop=this.cropFor(host,edits);
      host.dataset.cropBox=JSON.stringify(edits.crop_box||null);
      host.dataset.rotate=String(edits.rotate||0);host.dataset.enhance=(edits.enhance??(host.matches('.board-card')?true:S.filter))?'on':'off';
      host.dataset.look=JSON.stringify(edits.look||null);
      host.dataset.straighten=String(edits.straighten??'');host.dataset.autoAlign=edits.auto_align==null?'':edits.auto_align?'on':'off';host.dataset.finishing=JSON.stringify({grade:edits.grade,masks:edits.masks,auto_amount:edits.auto_amount,auto_parts:edits.auto_parts});
      host.dataset.geometry=JSON.stringify({composition:edits.composition,skew:edits.skew,auto_skew:edits.auto_skew});
      framePhoto(host,{dims:[p.width||img.naturalWidth||1,p.height||img.naturalHeight||1],box:p.subject},
        {crop:host.dataset.crop,rotate:edits.rotate||0,enhance:host.dataset.enhance==='on',knobs:edits.look?knobsOf(edits.look):null});
      if(host.closest('#stage,#f-arena,.twin-arena'))placeNote(host);
    };
    if(img.complete&&img.naturalWidth)frame();else img.addEventListener('load',frame,{once:true});
  },
  async open(host) {
    this.close(false);const state=this.hosts.get(host);if(!state)return;
    this.cache.delete(state.pid);
    const sheet=state.paper;state.motion++;sheet.inert=false;sheet.scrollTop=0;
    sheet.classList.remove('notes-returning');sheet.classList.add('photo-note-sheet','notes-opening');
    sheet.setAttribute('role','dialog');sheet.setAttribute('aria-label','Photo notes');sheet.tabIndex=-1;sheet.dataset.solid='';
    sheet.innerHTML='<button class="btn notes-close" aria-label="Close photo notes">×</button><p role="status">Opening notes…</p>';
    this.sheet=sheet;this.active={...state,host,source:this.source,page:this.page,draft:null,dirty:false};state.tab.setAttribute('aria-expanded','true');state.tab.setAttribute('aria-controls',sheet.id);
    sheet.onkeydown=e=>e.stopPropagation();
    $('.notes-close',sheet).onclick=e=>{e.stopPropagation();this.close();};this.position(true);sheet.getBoundingClientRect();sheet.classList.add('is-open');sheet.focus({preventScroll:true});
    this.afterMotion(host,state,()=>sheet.classList.remove('notes-opening'));
    try{await this.reload();}catch(e){if(this.sheet===sheet){$('p',sheet).textContent=e.message;
      const retry=document.createElement('button');retry.className='btn';retry.textContent='Try again';retry.onclick=()=>this.reload().catch(error=>toast(error.message));sheet.append(retry);}}
  },
  close(focus=true) {
    const active=this.active;this.sheet=null;this.active=null;if(!active)return;
    this.compare(false,active);
    if(active.dirty&&active.writeState!=='error')this.saveWriting(active);
    clearTimeout(active.writeTimer);
    const {host,paper,tab}=active,state=this.hosts.get(host);if(state)state.motion++;
    paper.classList.remove('is-open','photo-note-sheet','notes-opening');paper.classList.add('notes-returning');paper.inert=true;
    host.style.removeProperty('--notes-shift');tab.setAttribute('aria-expanded','false');tab.removeAttribute('aria-controls');
    const tuck=()=>{
      paper.replaceChildren(tab);paper.inert=false;paper.scrollTop=0;paper.classList.remove('notes-returning');paper.removeAttribute('role');paper.removeAttribute('tabindex');host.classList.remove('notes-active');
      for(const key of ['width','height','x','y'])paper.style.removeProperty(`--notes-${key}`);
      const under=paper.closest('.photo-note-underlay');under?.classList.remove('notes-overlap');
      if(host!==this.seaDetail)under?.removeAttribute('style');
      if(focus&&tab.isConnected)tab.focus({preventScroll:true});
    };
    if(!focus||reduceMotion)tuck();else if(state)this.afterMotion(host,state,tuck);
  },
  afterMotion(host,state,done) {
    const version=++state.motion;
    if(reduceMotion){done();return;}
    requestAnimationFrame(async()=>{
      const motion=[...state.paper.getAnimations(),...host.getAnimations()].filter(a=>a.effect?.getTiming().iterations!==Infinity);
      await Promise.allSettled(motion.map(a=>a.finished));
      if(state.motion===version)done();
    });
  },
  panTarget(target,pointerType) {
    return !!target.closest('.photo-note-sheet')&&!target.closest('button,a,input,textarea,select,label,summary,[contenteditable],.grade-wheel')&&
      !(pointerType==='touch'&&target.closest('.notes-page'));  // Fingers still scroll the writing; a mouse drags the view.
  },
  position(reframe=false) {
    if(!this.sheet||!this.active)return;
    const host=this.active.host;host.classList.add('notes-active');
    let r=host.getBoundingClientRect();
    if(host===this.seaDetail){
      host.style.removeProperty('--notes-shift');this.followSea();
      const width=parseFloat(this.sheet.style.getPropertyValue('--notes-width'))||r.width;
      if(reframe&&innerWidth>=760&&r.width+width+18+52<=innerWidth-32){
        const shift=Math.max(16-r.left,Math.min(0,innerWidth-16-width-52-18-r.right)),sea=this.seaPose.sea;
        if(Math.abs(shift)>.5)sea.setCamera(sea.camera.zoom,sea.camera.tx+shift,sea.camera.ty);
      }
      return;
    }
    // The card may already be far from the centre and magnified by a parent camera. Cancel that scale on
    // the paper's underlay, then place readable writing relative to the card's actual on-screen position.
    const style=getComputedStyle(host),scale=r.width/parseFloat(style.width)||1,{margin,top,width,height,bottom}=this.paperSize(r.width),
      current=(parseFloat(style.translate)||0)*scale,left=r.left-current,right=r.right-current;
    let shift=(parseFloat(host.style.getPropertyValue('--notes-shift'))||0)*scale;
    if(innerWidth<760){shift=0;host.style.removeProperty('--notes-shift');}
    if(reframe&&Math.abs(scale-1)<.01){
      shift=innerWidth>=760&&r.width+width+18+52<=innerWidth-2*margin?Math.max(margin-left,Math.min(0,innerWidth-margin-width-52-18-right)):0;
      host.style.setProperty('--notes-shift',`${shift/scale}px`);
    }
    r={...r.toJSON(),left:left+shift,right:right+shift};
    const under=this.sheet.parentElement;
    under.style.width=`${r.width}px`;under.style.height=`${r.height}px`;under.style.transform=`scale(${1/scale})`;
    const x=Math.max(margin,Math.min(innerWidth<760?r.left+8:r.right+18,innerWidth-margin-width-52)),
      y=Math.max(top,Math.min(r.top+(innerWidth<760?10:0),bottom-margin-height-132));
    under.classList.toggle('notes-overlap',x<r.right);
    for(const [key,value] of Object.entries({width,height,x:x-r.left,y:y-r.top}))this.sheet.style.setProperty(`--notes-${key}`,`${value}px`);
  },
  async reload() {
    const active=this.active,sheet=this.sheet;if(!active||!sheet)return;
    const version=active.loadVersion=(active.loadVersion||0)+1;
    await active.writing;
    // A tucked-away sheet may still be saving this photo. Reopening reads its confirmed result.
    await Toolbelt.saving.get(active.pid);
    if(this.active!==active||version!==active.loadVersion)return;
    const [data,tags,history]=await Promise.all([this.get(active.pid),api('/api/tags?all=1'),api('/api/draw/history')]);
    if(this.active!==active||version!==active.loadVersion||!data)return;
    if(!Toolbelt.jobs.get(active.pid)?.length)Toolbelt.know(active.pid,data.edits);
    active.data={...data,edits:Toolbelt.current(active.pid)};active.tags=tags.tags;active.bins=data.available_groups||[];active.history=history;
    if(!active.draft){
      active.draft=this.drafts.get(this.draftKey(active))||this.writingOf(active.data.edits);
      active.dirty=!this.sameWriting(active.draft,active.data.edits);
      active.writeState=active.dirty?'unsaved':'saved';
    }
    for(const [host,state] of this.hosts)if(state.pid===active.pid){state.data=active.data;this.decorate(host,state);}
    this.render();
    if(active.dirty&&active.writeState!=='error')this.queueWriting(active);
  },
  writingOf(edits={}) { return {title:edits.title||'',description:edits.description||''}; },
  sameWriting(a,b) { return ['title','description'].every(k=>(a[k]||'').trim()===(b[k]||'').trim()); },
  draftKey(active) { return JSON.stringify([active.source,active.pid]); },
  queueWriting(active) {
    clearTimeout(active.writeTimer);
    active.writeTimer=setTimeout(()=>this.saveWriting(active),650);
  },
  async saveWriting(active=this.active) {
    if(!active?.draft)return true;
    clearTimeout(active.writeTimer);
    if(active.writing)return active.writing;
    if(!active.dirty)return true;
    if(active.source!==S.lib?.source)return false;
    const task=(async()=>{
      while(active.dirty&&active.source===S.lib?.source){
        const sent=active.draft,patch=Object.fromEntries(Object.entries(sent).map(([k,v])=>[k,v.trim()]));
        active.writeState='saving';this.writingStatus(active);
        try{await Toolbelt.save(active.pid,patch);}
        catch(_){active.writeState='error';this.writingStatus(active);return false;}
        if(active.source!==S.lib?.source)return false;
        if(!this.sameWriting(patch,Toolbelt.edits.get(active.pid)||{})){
          active.writeState='error';this.writingStatus(active);return false;
        }
        if(this.drafts.get(this.draftKey(active))===sent)this.drafts.delete(this.draftKey(active));
        active.dirty=!this.sameWriting(active.draft,patch);
      }
      active.writeState='saved';this.writingStatus(active);return true;
    })();
    active.writing=task;
    try{return await task;}
    finally{active.writing=null;if(this.active===active)this.refreshHistory(active);}
  },
  fillWriting() {
    if(!this.sheet||!this.active?.draft)return;
    for(const [key,value] of Object.entries(this.active.draft)){
      const input=$(`[name=${key}]`,this.sheet);if(input&&document.activeElement!==input)input.value=value;
    }
  },
  writingStatus(active=this.active) {
    if(!this.sheet||this.active!==active)return;
    const status=$('.notes-save-state',this.sheet);if(!status)return;
    status.textContent={saving:'Saving…',unsaved:'Not saved yet',error:'Couldn’t save',saved:'Saved to this photo'}[active.writeState]||'Saved to this photo';
    status.dataset.state=active.writeState;
    const retry=$('[data-retry-writing]',this.sheet);retry.hidden=active.writeState!=='error';
    const save=$('.notes-writing [type=submit]',this.sheet);if(save){save.hidden=!active.dirty||active.writeState==='saving';save.textContent=active.writeState==='error'?'Retry saving':'Save now';}
  },
  async refreshHistory(active=this.active) {
    if(!active||this.active!==active||active.source!==S.lib?.source)return;
    try{const history=await api('/api/draw/history');if(this.active===active){active.history=history;this.controls();}}
    catch(_){/* The saved writing stays saved if history is temporarily unavailable. */}
  },
  async edit(patch) {
    const active=this.active;if(!active)return;
    if(await Toolbelt.save(active.pid,patch)===false)return false;
    if(this.active===active){active.data.edits=Toolbelt.current(active.pid);this.controls();this.preview(active.host,active.data,active.data.edits);this.refreshHistory(active);}
    return true;
  },
  async action(path,body) {
    const active=this.active;if(!active||this.busy)return;this.busy=true;
    this.sheet.setAttribute('aria-busy','true');
    try{
      if(!await this.saveWriting(active)||this.active!==active)return;
      await Toolbelt.flush();
      const r=await api(path,body);if(active.source!==S.lib?.source)return;
      updateHudQuiet(r.game);refreshHud(true);this.cache.delete(active.pid);
      if(this.active===active){
        if(/\/draw\/(undo|redo)$/.test(path)){active.draft=null;active.dirty=false;}
        await this.reload();
      }
    }catch(e){toast(e.message);}finally{this.busy=false;this.sheet?.removeAttribute('aria-busy');this.controls();this.scan();}
  },
  render() { this.renderSheet(); },
  renderSheet() {
    const active=this.active,sheet=this.sheet,p=active.data;
    if(!$('.notes-nav',sheet)){
      const pages=[['notes','Notes'],['tags','Tags'],['look','Look'],['details','Details']];
      sheet.innerHTML=`<nav class="notes-nav" role="tablist" aria-label="Photo notes sheets">${pages.map(([key,label])=>`<div class="notes-leaf"><button type="button" role="tab" id="${sheet.id}-${key}-tab" data-notes-page="${key}" aria-controls="${sheet.id}-${key}" aria-label="Bring ${label.toLowerCase()} sheet to the top"><span>${label}</span></button></div>`).join('')}</nav>
        <div class="notes-face"><header class="notes-heading"><h2 id="${sheet.id}-title">Photo notes</h2><button type="button" class="btn notes-close" aria-label="Close photo notes">×</button></header>
        <div class="notes-body">${pages.map(([key])=>`<section class="notes-page" role="tabpanel" id="${sheet.id}-${key}" data-notes-panel="${key}" aria-labelledby="${sheet.id}-${key}-tab" tabindex="0" hidden></section>`).join('')}</div>
        <footer class="notes-footer"><div class="notes-save"><span class="notes-save-state" role="status" aria-live="polite"></span><button type="button" class="btn" data-retry-writing hidden>Retry</button></div>
          <div class="notes-history-actions"><button type="button" class="btn ghost" data-notes-undo hidden aria-label="Undo last photo change">↶ <span>Undo</span></button><button type="button" class="btn ghost" data-notes-redo hidden aria-label="Redo last photo change">↷ <span>Redo</span></button></div></footer></div>`;
      sheet.setAttribute('aria-labelledby',`${sheet.id}-title`);
      $('.notes-close',sheet).onclick=e=>{e.stopPropagation();this.close();};
      $('[data-retry-writing]',sheet).onclick=()=>this.saveWriting(active);
      for(const button of $$('[data-notes-page]',sheet)){
        button.onclick=()=>this.showPage(button.dataset.notesPage);
        button.onkeydown=event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          event.preventDefault();event.stopPropagation();const tabs=$$('[data-notes-page]',sheet),at=tabs.indexOf(button);
          const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(at+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
          this.showPage(tabs[next].dataset.notesPage);tabs[next].focus({preventScroll:true});
        };
      }
      for(const kind of ['undo','redo'])$(`[data-notes-${kind}]`,sheet).onclick=()=>this.action(`/api/draw/${kind}`,{});
      sheet.onkeydown=event=>{
        if(!event.repeat&&event.key.toLowerCase()==='z'&&!event.target.closest('input,textarea,select')&&!event.ctrlKey&&!event.metaKey){
          const kind=event.shiftKey?'redo':'undo',button=$(`[data-notes-${kind}]`,sheet);
          if(!button.hidden){event.preventDefault();button.click();}
        }
        event.stopPropagation();
      };
      this.renderWriting();this.renderLook();
    }
    const tagInput=$('.notes-new-tag input',sheet),query=tagInput?.value||'',tagFocused=tagInput===document.activeElement;
    const disclosures=new Set($$('details[open][data-notes-detail]',sheet).map(d=>d.dataset.notesDetail));
    this.renderTags();this.renderDetails();
    for(const detail of $$('details[data-notes-detail]',sheet))detail.open=disclosures.has(detail.dataset.notesDetail);
    const input=$('.notes-new-tag input',sheet);input.value=query;
    if(tagFocused)input.focus({preventScroll:true});
    this.fillWriting();
    $('.notes-context',sheet).innerHTML=`<span class="notes-status ${p.cut?'is-aside':''}">${p.cut?'Set aside':'In the running'}</span><button type="button" class="notes-context-link">${p.stack.members.length>1?`${p.stack.members.length} takes in this stack`:'One loose photo'}${p.group.name?` · ${esc(p.group.name)}`:''} →</button>`;
    $('.notes-context-link',sheet).onclick=()=>{this.showPage('details');$('.notes-collection',sheet).scrollIntoView({block:'start'});};
    this.showPage(active.page);this.controls();this.position();
  },
  showPage(page) {
    if(!this.sheet||!this.active)return;
    const changed=this.active.page!==page;if(changed)this.compare(false);
    if(page==='details'&&this.active.page!==page){
      const panel=$('[data-notes-panel=details]',this.sheet),open=new Set($$('details[open]',panel).map(d=>d.dataset.notesDetail));
      this.renderDetails();
      for(const detail of $$('details',panel))detail.open=open.has(detail.dataset.notesDetail);
    }
    const order=this.active.paperOrder||=['notes','tags','look','details'],depth=order.indexOf(page);
    if(depth>0){order.splice(depth,1);order.unshift(page);}
    if(changed&&!reduceMotion)$('.notes-face',this.sheet).animate([{transform:`translate(${depth*12}px,${depth*32}px) rotate(${depth*.4}deg)`},{transform:'none'}],{duration:240,easing:'cubic-bezier(.22,.8,.25,1)'});
    this.page=this.active.page=page;
    for(const button of $$('[data-notes-page]',this.sheet)){
      const selected=button.dataset.notesPage===page;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
      button.parentElement.style.setProperty('--sheet-depth',order.indexOf(button.dataset.notesPage));
    }
    for(const panel of $$('[data-notes-panel]',this.sheet))panel.hidden=panel.dataset.notesPanel!==page;
    this.sheet.dataset.page=page;
  },
  renderWriting() {
    const active=this.active,panel=$('[data-notes-panel=notes]',this.sheet);
    panel.innerHTML=`<p class="notes-intro">A title on the frame. The story on this sheet.</p>
      <form class="notes-writing"><label class="notes-title-label">Title on the frame<input name="title" type="text" maxlength="160" placeholder="Give this photo a title" autocomplete="off"></label>
        <label class="notes-story-label">The story<textarea name="description" maxlength="8000" rows="7" placeholder="A place, a memory, a reason to keep it…"></textarea></label>
        <div class="notes-writing-bar"><span class="notes-private">Your writing stays in MatchER.</span><button type="submit" class="btn" hidden>Save now</button></div></form>
      <div class="notes-context"></div>`;
    const form=$('.notes-writing',panel);
    form.oninput=()=>{
      active.draft={title:form.elements.title.value,description:form.elements.description.value};
      active.dirty=!this.sameWriting(active.draft,Toolbelt.edits.get(active.pid)||{});
      active.writeState=active.dirty?'unsaved':'saved';
      if(active.dirty){this.drafts.set(this.draftKey(active),active.draft);this.queueWriting(active);}
      else{this.drafts.delete(this.draftKey(active));clearTimeout(active.writeTimer);}
      this.writingStatus(active);this.previewTitle(active);
    };
    form.onsubmit=event=>{event.preventDefault();this.saveWriting(active);};
    form.addEventListener('focusout',event=>{if(!form.contains(event.relatedTarget))this.saveWriting(active);});
  },
  previewTitle(active) {
    const title=active.draft.title.trim();
    for(const [host,state] of this.hosts)if(state.pid===active.pid){
      const chin=host.querySelector('.chin'),writing=$(':scope > .photo-writing',host);
      if(chin){let label=$('.chin-title',chin);if(!title)label?.remove();else{if(!label){label=document.createElement('span');label.className='chin-title';chin.prepend(label);}label.textContent=title;}}
      else if(writing){writing.textContent=title||state.data?.rel.split(/[\\/]/).at(-1)||'';writing.hidden=!writing.textContent;}
    }
  },
  renderTags() {
    const {data:p,tags}=this.active,panel=$('[data-notes-panel=tags]',this.sheet),current=new Set(p.tags.map(t=>t.key));
    const families=[['what','What’s in it'],['people','People'],['look','How it looks'],['when','When'],['other','Your other tags']];
    const groups=new Map(families.map(([key])=>[key,[]]));
    for(const tag of p.tags)groups.get(groups.has(tag.family)?tag.family:'other').push(tag);
    panel.innerHTML=`<p class="notes-intro">Make the description yours. Corrections apply to this take.</p>
      <form class="notes-new-tag"><div class="tag-picker notes-tag-picker"></div><button type="submit" class="btn" aria-label="Add this tag">Add</button></form>
      <div class="notes-tags">${p.tags.length?families.filter(([key])=>groups.get(key).length).map(([key,label])=>`<section class="notes-tag-family"><h3>${label}</h3><ul>${groups.get(key).map(t=>{
        const manual=t.edited===true||t.user&&t.score==null;
        return `<li class="notes-tag ${manual?'is-personal':''}"><span class="notes-tag-name"><span aria-hidden="true">${esc(t.emoji||'🏷️')}</span> ${esc(t.label)}<small>${manual?'Added by you':'From analysis'}</small></span>
          <button type="button" class="notes-tag-remove" data-remove-tag="${esc(t.key)}" aria-label="Remove ${esc(t.label)} from this take" title="Remove this tag">×</button></li>`;
      }).join('')}</ul></section>`).join(''):'<p class="notes-empty">No tags yet. Add what makes this photo easy to find.</p>'}</div>
      ${p.tag_edits.some(t=>!t.on)?`<details class="notes-removed" data-notes-detail="removed"><summary>Removed from this take</summary><ul>${p.tag_edits.filter(t=>!t.on).map(t=>`<li><span>${esc(t.label)}</span><button type="button" class="btn ghost" data-restore-tag="${esc(t.key)}">Put back</button></li>`).join('')}</ul></details>`:''}`;
    const add=t=>this.action('/api/tags/set',{photos:[p.id],on:[t.key],exact:true});
    const create=label=>this.action('/api/tags/new',{label,photos:[p.id],exact:true});
    const input=tagPicker($('.notes-tag-picker',panel),tags,add,{label:'Find or add a tag',exclude:current,create});
    input.name='label';input.maxLength=40;input.placeholder='Search tags or write a new one';
    $('.notes-new-tag',panel).onsubmit=event=>{
      event.preventDefault();const label=input.value.trim();if(!label)return;
      const match=tags.find(t=>t.label.toLocaleLowerCase()===label.toLocaleLowerCase());
      if(match&&current.has(match.key)){toast('That tag is already on this take.');return;}
      match?add(match):create(label);
    };
    for(const button of $$('[data-remove-tag]',panel))button.onclick=()=>this.action('/api/tags/set',{photos:[p.id],off:[button.dataset.removeTag],exact:true});
    for(const button of $$('[data-restore-tag]',panel))button.onclick=()=>add({key:button.dataset.restoreTag});
  },
  renderLook() {
    const p=this.active.data,panel=$('[data-notes-panel=look]',this.sheet);
    panel.innerHTML=`<div class="notes-look-intro"><p class="notes-intro">Fine-tune this photo. Watch the print as you work.</p><button type="button" class="btn notes-compare" data-notes-compare aria-pressed="false">Hold for original</button></div>
      <div class="notes-finishing edit-sheet"><fieldset><legend>Light & colour</legend><section class="notes-auto"><p class="notes-auto-name"></p><p class="notes-hint notes-auto-why"></p>
        <div class="sheet-row"><button type="button" class="btn" data-auto-reset>Auto</button><button type="button" class="btn ghost" data-edit="enhance">Enhance</button></div>
        <label class="notes-auto-amount">Amount <output data-auto-value></output><input type="range" data-auto-amount min="0" max="1.5" step="0.01"></label>
        <details class="notes-adjustment" data-notes-detail="recipe"><summary>What Auto changes</summary><div class="notes-auto-parts">${[['tone','Light & contrast'],['colour','Colour balance'],['grade','Scene colour'],['detail','Detail'],['subject','Backlit subject']].map(([key,label])=>`<label data-auto-part-label="${key}"><input type="checkbox" data-auto-part="${key}">${label}</label>`).join('')}</div>
        <div class="sheet-row"><button type="button" class="btn ghost" data-auto-mask hidden>Edit subject mask…</button></div></details></section>
        </fieldset>
      <fieldset><legend>Framing</legend><div class="sheet-seg">${[['best','Best'],['subject','Subject'],['height','Fill height'],['width','Fill width'],['off','Whole photo'],['custom','Custom…']].map(([key,label])=>`<button type="button" class="btn ghost" data-crop="${key}" ${key==='subject'&&!p.subject?'hidden':''}>${label}</button>`).join('')}</div><p class="notes-crop-hint"></p>
        <details class="notes-adjustment" data-notes-detail="alignment" ${p.edits.straighten!=null||p.edits.rotate||p.edits.skew||p.edits.composition?'open':''}><summary>Align & perspective <small data-angle-state></small></summary>
        <div class="notes-composition sheet-seg" role="group" aria-label="Automatic composition">${[['natural','Natural','Balance structure, depth and breathing room'],['upright','Upright','Favour level horizons and parallel architecture'],['expressive','Expressive','Follow strong diagonals and keep the scene’s energy']].map(([key,label,hint])=>`<button type="button" class="btn ghost" data-composition="${key}" title="${hint}">${label}</button>`).join('')}</div><p class="notes-hint" data-composition-status aria-live="polite"></p>
        <div class="sheet-row"><button type="button" class="btn ghost" data-auto-align>Auto-align <kbd>A</kbd></button><button type="button" class="btn ghost" data-auto-skew>Auto-skew</button></div>
        <p class="notes-hint" data-align-status></p><div class="straighten-control"><label for="${this.sheet.id}-straighten">Straighten</label><output for="${this.sheet.id}-straighten" data-straighten-angle></output><input id="${this.sheet.id}-straighten" name="straighten" type="range" min="-45" max="45" step="0.01" value="${p.edits.straighten||0}"></div><div class="sheet-row"><button type="button" class="btn ghost" data-align-reset hidden>Use automatic angle</button><button type="button" class="btn ghost" data-align>Align horizon…</button></div>
        ${['horizontal','vertical'].map(axis=>`<div class="straighten-control"><label for="${this.sheet.id}-skew-${axis}">${axis[0].toUpperCase()+axis.slice(1)} perspective</label><output for="${this.sheet.id}-skew-${axis}" data-skew-value="${axis}"></output><input id="${this.sheet.id}-skew-${axis}" name="skew-${axis}" data-skew="${axis}" type="range" min="-0.6" max="0.6" step="0.001" value="0"></div>`).join('')}
        <p class="notes-hint" data-skew-status></p><button type="button" class="btn ghost" data-skew-reset hidden>Use automatic perspective</button>
        <div class="sheet-row notes-turn"><button type="button" class="btn ghost" data-turn="-90" aria-label="Turn a quarter anticlockwise">↺</button><output class="sheet-deg"></output><button type="button" class="btn ghost" data-turn="90" aria-label="Turn a quarter clockwise">↻</button></div></details></fieldset>
        <details class="notes-adjustment" data-notes-detail="light" ${p.edits.look?'open':''}><summary>Adjust light & colour <small data-light-state></small></summary><div class="sheet-row"><button type="button" class="btn ghost" data-edit="auto" hidden>Reset adjustments</button></div>
        <div class="sheet-knobs">${Object.entries(KNOBS).map(([key,[lo,hi]])=>`<div class="sheet-knob"><label for="${this.sheet.id}-${key}">${KNOB_WORD[key]}</label><input id="${this.sheet.id}-${key}" type="range" data-knob="${key}" min="${lo}" max="${hi}" step="0.05"><output for="${this.sheet.id}-${key}"></output><button type="button" class="notes-knob-reset" data-knob-reset="${key}" aria-label="Reset ${KNOB_WORD[key]}" hidden>↶</button></div>`).join('')}</div>
        </details><details class="notes-adjustment" data-notes-detail="grading" ${p.edits.grade?'open':''}><summary>Colour grading <small data-grade-state></small></summary><div class="notes-grading"><p class="notes-hint">Shape the colour after the light adjustments. Drag a wheel or enter exact values.</p>${PhotoFinish.wheels(p.edits.grade)}</div></details>
      <details class="notes-adjustment" data-notes-detail="masks" ${p.edits.masks?.length?'open':''}><summary>Local adjustments <small data-mask-state></small></summary><p class="notes-mask-summary"></p><button type="button" class="btn" data-masks>Paint masks…</button><p class="notes-hint">Brush exposure and colour onto part of the photo. Erase or soften the mask whenever you like.</p></details></div>`;
    const compare=$('[data-notes-compare]',panel),end=()=>this.compare(false);
    compare.onpointerdown=event=>{if(event.button)return;event.preventDefault();compare.setPointerCapture(event.pointerId);this.compare(true);};
    for(const type of ['pointerup','pointercancel','lostpointercapture','blur'])compare.addEventListener(type,end);
    compare.onkeydown=event=>{if([' ','Enter'].includes(event.key)){event.preventDefault();this.compare(true);}};
    compare.onkeyup=event=>{if([' ','Enter'].includes(event.key)){event.preventDefault();end();}};
    $('[data-edit=enhance]',panel).onclick=()=>this.edit({enhance:!this.enhanced()});
    $('[data-auto-reset]',panel).onclick=()=>this.edit({enhance:true,auto_amount:null,auto_parts:null});
    const autoAmount=$('[data-auto-amount]',panel);
    autoAmount.oninput=()=>{$('[data-auto-value]',panel).textContent=`${Math.round(Number(autoAmount.value)*100)}%`;this.preview(this.active.host,this.active.data,{...this.active.data.edits,enhance:true,auto_amount:Number(autoAmount.value)});};
    autoAmount.onchange=()=>this.edit({enhance:true,auto_amount:Number(autoAmount.value)});
    for(const input of $$('[data-auto-part]',panel))input.onchange=()=>this.edit({enhance:true,auto_parts:Object.fromEntries($$('[data-auto-part]',panel).map(i=>[i.dataset.autoPart,i.checked]))});
    $('[data-auto-align]',panel).onclick=()=>this.edit({auto_align:!(this.active.data.edits.auto_align??S.align)});
    $('[data-align-reset]',panel).onclick=()=>this.edit({straighten:null,auto_align:true});
    $('[data-auto-skew]',panel).onclick=()=>{const e=this.active.data.edits;this.edit({auto_skew:!(e.auto_skew??e.auto_align??S.align)});};
    $('[data-skew-reset]',panel).onclick=()=>this.edit({skew:null,auto_skew:true});
    for(const button of $$('[data-composition]',panel))button.onclick=()=>this.edit({composition:button.dataset.composition,straighten:null,skew:null,auto_align:true,auto_skew:true});
    $('[data-auto-mask]',panel).onclick=async()=>{
      const e=this.active.data.edits,mask=this.active.data.auto_look.masks?.[0];if(!mask)return;
      await this.edit({auto_parts:{...e.auto_parts,subject:false},masks:[...(e.masks||[]),{...mask,id:`subject-${Date.now()}`} ]});
      PhotoMask.open(this.active.data,patch=>this.edit(patch));
    };
    $('[data-edit=auto]',panel).onclick=()=>this.edit({look:null});
    for(const button of $$('[data-crop]',panel))button.onclick=()=>button.dataset.crop==='custom'?PhotoCrop.open(this.active.data,patch=>this.edit(patch)):this.edit({crop:button.dataset.crop});
    for(const button of $$('[data-turn]',panel))button.onclick=()=>this.edit({rotate:((this.active.data.edits.rotate||0)+Number(button.dataset.turn)+360)%360});
    const angle=$('[name=straighten]',panel);
    angle.oninput=()=>{if(angle.value!==''&&angle.checkValidity()){$('[data-straighten-angle]',panel).textContent=`${angle.valueAsNumber>0?'+':''}${angle.valueAsNumber.toFixed(2)}°`;this.preview(this.active.host,this.active.data,{...this.active.data.edits,straighten:angle.valueAsNumber});}};
    angle.onchange=()=>{if(angle.value!==''&&angle.checkValidity())this.edit({straighten:angle.valueAsNumber});};
    for(const input of $$('[data-skew]',panel)){
      const skew=()=>{const e=this.active.data.edits,axis=input.dataset.skew,other=axis==='horizontal'?'vertical':'horizontal',target=e.rotate%180?other:axis,
        value=PhotoGeometry.region({[axis]:input.valueAsNumber},(360-(e.rotate||0))%360);return {...e.skew,[target]:value[target]};};
      input.oninput=()=>{if(input.checkValidity()){$(`[data-skew-value=${input.dataset.skew}]`,panel).textContent=`${input.valueAsNumber>0?'+':''}${(input.valueAsNumber*100).toFixed(1)}%`;this.preview(this.active.host,this.active.data,{...this.active.data.edits,skew:skew()});}};
      input.onchange=()=>{if(input.checkValidity())this.edit({skew:skew()});};
    }
    $('[data-align]',panel).onclick=()=>PhotoCrop.open(this.active.data,patch=>this.edit(patch),true);
    $('[data-masks]',panel).onclick=()=>PhotoMask.open(this.active.data,patch=>this.edit(patch));
    PhotoFinish.bindWheels($('.notes-grading',panel),()=>this.active.data.edits.grade||{},grade=>this.preview(this.active.host,this.active.data,{...this.active.data.edits,grade}),grade=>this.edit({grade}));
    const knobs=()=>Object.fromEntries($$('[data-knob]',panel).map(r=>[r.dataset.knob,Number(r.value)]));
    for(const range of $$('[data-knob]',panel)){
      range.oninput=()=>{this.knobValue(range);this.preview(this.active.host,this.active.data,{...this.active.data.edits,look:knobs()});};
      range.onchange=()=>this.edit({look:knobs()});
    }
    for(const button of $$('[data-knob-reset]',panel))button.onclick=()=>this.edit({look:{...knobs(),[button.dataset.knobReset]:KNOBS[button.dataset.knobReset][2]}});
  },
  originalEdits(){return {crop:'off',rotate:0,straighten:0,auto_align:false,enhance:false};},
  compare(on,active=this.active) {
    if(!active?.data)return;
    active.comparing=on;
    if(active.host?.isConnected)this.preview(active.host,active.data,on?this.originalEdits():active.data.edits);
    if(this.active===active&&this.sheet){this.sheet.classList.toggle('notes-comparing',on);const button=$('[data-notes-compare]',this.sheet);if(button){button.setAttribute('aria-pressed',String(on));button.textContent=on?'Original':'Hold for original';}}
  },
  knobValue(range) {
    const key=range.dataset.knob,value=Number(range.value);
    range.nextElementSibling.textContent=['levels','colour'].includes(key)?`${Math.round(value*100)}%`:`${value>0?'+':''}${value.toFixed(2)}`;
    range.parentElement.querySelector('[data-knob-reset]').hidden=value===KNOBS[key][2];
  },
  facts(rows) {
    return `<dl class="notes-facts">${rows.filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([key,value])=>`<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
  },
  word(key) { return FLAG_LABELS[key]||TASTE_LABELS[key]||String(key).replace(/_/g,' '); },
  renderDetails() {
    const p=this.active.data,e=p.edits||{},panel=$('[data-notes-panel=details]',this.sheet),count=p.stack.members.length;
    const number=n=>typeof n==='number'?Number(n.toFixed(3)):n;
    const scoreRows=obj=>this.facts(Object.entries(obj||{}).filter(([,v])=>typeof v==='number').sort((a,b)=>b[1]-a[1]).map(([key,value])=>[this.word(key),number(value)]));
    const date=p.taken?new Date(p.taken):null,dateLabel=date&&!Number.isNaN(date.valueOf())?date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):p.taken;
    const size=p.size>=1048576?`${(p.size/1048576).toFixed(1)} MB`:p.size?`${Math.max(1,Math.round(p.size/1024))} KB`:null;
    panel.innerHTML=`<section class="notes-file"><h3>Original file</h3><p class="notes-filename">${esc(p.rel)}</p>
      ${this.facts([['Taken',dateLabel],['Date from',({exif:'Camera metadata',filename:'File name'})[p.taken_src]],['Camera',[p.make,p.model].filter(Boolean).join(' ')],['Size',p.width&&p.height?`${p.width.toLocaleString()} × ${p.height.toLocaleString()} px`:null],['File',[p.fmt,size].filter(Boolean).join(' · ')],['Problem',p.error]])}${photoPathButton(p.id)}</section>
      <section class="notes-collection"><h3>In your collection</h3><p class="notes-status ${p.cut?'is-aside':''}">${p.cut?`Set aside${p.override==='toss'?' by you':`: ${esc(this.word(p.cut))}`}`:p.override==='keep'?'Kept by you':'In the running'}</p>
        ${count>1?`<p>${count} takes in this stack${p.stack.rep===p.id?' · This is the cover.':''}</p><div class="sheet-row">${p.stack.rep!==p.id?'<button type="button" class="btn" data-photo-action="keep">Use as cover</button>':''}<button type="button" class="btn ghost" data-photo-action="split">Split from stack</button></div>`:'<p class="muted">A loose photo, ready to keep or stack.</p>'}
        ${this.active.bins.length?`<label>${count>1?'File the stack in':'File in a group'}<select class="notes-group"><option value="">No group</option>${this.active.bins.map(group=>`<option value="${group.id}" ${group.id===p.group.id?'selected':''}>${esc(group.emoji||'🗂️')} ${esc(group.name)}</option>`).join('')}</select></label>${count>1?'<p class="notes-hint">All takes in this stack stay in the same group.</p>':''}`:''}
        <button type="button" class="btn ${p.cut?'':'ghost'}" data-photo-action="${p.cut?'rescue':'toss'}">${p.cut?'Bring this take back':'Set this take aside'}</button></section>
      <section><h3>${count>1?'The stack’s results':'The results so far'}</h3>${p.ranking?this.facts([['Leaderboard',p.ranking.rank?`#${p.ranking.rank}`:p.ranking.bubble?'On the bubble':'Not in the shortlist'],['Shortlist chance',pct(p.ranking.inclusion)],['Comparisons',p.ranking.duels]]):'<p class="notes-empty">No comparisons yet.</p>'}</section>
      <details data-notes-detail="analysis"><summary>What the analysis found</summary><p class="notes-hint">Saved observations and measurements for this take.</p>
        ${this.facts([['Observations',p.flags.map(key=>this.word(key)).join(', ')],['Faces',p.n_faces],['Brightness',typeof p.luma==='number'?pct(p.luma/255):null],['Saturation',typeof p.saturation==='number'?pct(p.saturation):null]])}
        <details data-notes-detail="measurements"><summary>Measurements & match scores</summary><p class="notes-hint">Match scores describe the analysis, not a rating of your photo.</p>${this.facts([['Sharpness',number(p.sharp)],['Dark tones',number(p.luma_lo)],['Light tones',number(p.luma_hi)],['Colour range',number(p.chroma)],['Hue',number(p.hue)],['Starting appeal',number(p.prior)],['Current appeal',number(p.ranking?.appeal)],['Subject region',p.subject?.map(number).join(', ')],['Salient region',p.salient?.map(number).join(', ')]])}
        ${scoreRows(p.recognized_tags?.tags||p.recognized_tags)}${scoreRows(p.zs?.scores||p.zs)}
        ${p.faces.map((face,i)=>`<h4>Face ${i+1}${face.label==='me'?' · You':''}</h4>${this.facts(Object.entries(face).filter(([key])=>!['id','photo_id','idx','person','label'].includes(key)).map(([key,value])=>[this.word(key),number(value)]))}`).join('')}</details></details>
      <details data-notes-detail="saved"><summary>What you’ve changed</summary>${this.facts([['Writing',e.title||e.description?'Saved on this photo':null],['Pen & marker strokes',e.marks?.length],['Sticky notes',e.notes?.map(n=>n.text).join(' · ')],['Crop',e.crop],['Turn',e.rotate!==undefined?`${e.rotate}°`:null],['Straighten',e.straighten!=null?`${e.straighten}°`:null],['Composition',e.composition],['Perspective',e.skew?Object.entries(e.skew).map(([axis,value])=>`${axis} ${(value*100).toFixed(1)}%`).join(' · '):null],['Auto-align',e.auto_align!=null?e.auto_align?'On':'Off':null],['Auto-skew',e.auto_skew!=null?e.auto_skew?'On':'Off':null],['Colour grading',e.grade?Object.keys(e.grade).filter(k=>PhotoFinish.zones.includes(k)).join(', ')||'Custom blend':null],['Local masks',e.masks?.map(m=>`${m.name}${m.enabled===false?' (disabled)':''}`).join(' · ')],['Enhance',e.enhance!==undefined?e.enhance?'On':'Off':null],['Export selection',p.pick?'Added by you':null]])}
        ${p.tag_edits.length?this.facts(p.tag_edits.map(tag=>[tag.label,tag.on?'Added by you':'Removed by you'])):'<p class="notes-hint">Tag corrections will appear here.</p>'}</details>
      <details data-notes-detail="calls"><summary>Recent choices</summary>${p.history.length?`<ol class="notes-history">${p.history.map(call=>`<li><span>${esc(({duel:'Compared',frame:'Chose a stack cover',toss:'Set aside',great:'Loved',meh:'Disliked',skip:'Deferred'})[call.kind]||this.word(call.kind))}${call.winner===p.id?' · won':call.kind==='duel'&&call.winner?' · lost':''}${call.undone?' · undone':''}</span><time>${esc(ago(call.ts))}</time></li>`).join('')}</ol>`:'<p class="notes-empty">No choices recorded for this take yet.</p>'}</details>`;
    for(const button of $$('[data-photo-action]',panel))button.onclick=()=>{
      const name=button.dataset.photoAction;
      this.action(name==='keep'?'/api/frame':name==='split'?'/api/groups/split':'/api/rescue',
        ['rescue','toss'].includes(name)?{ids:[p.id],on:name==='rescue',reason:'tossed'}:{photo:p.id});
    };
    const group=$('.notes-group',panel);if(group)group.onchange=()=>this.action('/api/draw/move',{photos:[p.id],theme:group.value?Number(group.value):null});
  },
  enhanced(){return this.active.data.edits.enhance??(this.active.host.matches('.board-card')?true:S.filter);},
  cropFor(host,edits){return normCrop(edits.crop??(host.matches('.board-card')||host.closest('.twin-arena')?'off':S.crop));},
  controls() {
    if(!this.sheet||!this.active?.data)return;
    const sheet=this.sheet,e=this.active.data.edits,on=this.enhanced(),crop=this.cropFor(this.active.host,e);
    const toggle=$('[data-edit=enhance]',sheet);if(!toggle)return;
    for(const kind of ['undo','redo']){
      const button=$(`[data-notes-${kind}]`,sheet),entry=this.active.history?.[kind];button.hidden=!entry;
      if(entry)button.title=`${kind==='undo'?'Undo':'Redo'}: ${HistoryHUD.label(entry)}`;
      button.disabled=!!this.busy;
    }
    toggle.textContent=on?'Enhance on':'Enhance off';toggle.setAttribute('aria-pressed',String(on));
    const baseline=this.active.data.auto_look;
    $('.notes-auto-name',sheet).textContent=baseline?.label||'Preparing this photo’s baseline';
    $('.notes-auto-why',sheet).textContent=baseline?baseline.reasons.join(' · '):'Existing libraries prepare their baselines from saved previews in the background.';
    const amount=$('[data-auto-amount]',sheet);amount.disabled=!baseline;if(document.activeElement!==amount)amount.value=String(e.auto_amount??1);
    $('[data-auto-value]',sheet).textContent=`${Math.round((e.auto_amount??1)*100)}%`;
    $('[data-auto-reset]',sheet).disabled=!baseline;
    for(const input of $$('[data-auto-part]',sheet)){input.checked=e.auto_parts?.[input.dataset.autoPart]!==false;input.disabled=!baseline;
      input.closest('label').hidden=input.dataset.autoPart==='subject'&&!baseline?.masks?.length||input.dataset.autoPart==='grade'&&!Object.keys(baseline?.grade||{}).length;}
    const align=$('[data-auto-align]',sheet),aligned=e.auto_align??S.align,degrees=AutoLook.angle(baseline,{...e,auto_align:aligned});align.setAttribute('aria-pressed',String(aligned));
    $('[data-align-reset]',sheet).hidden=e.straighten==null;
    $('[data-align-status]',sheet).textContent=e.straighten!=null?'Your manual angle takes priority.':!aligned?'Automatic alignment is off.':`Automatic angle: ${degrees>0?'+':''}${degrees.toFixed(2)}°. The picture turns inside its frame.`;
    const style=e.composition||'natural',view=baseline?.composition?.views?.[style],geometry=AutoLook.geometry(baseline,{...e,auto_align:aligned}),skewed=e.auto_skew??aligned;
    for(const button of $$('[data-composition]',sheet)){button.disabled=!view;button.setAttribute('aria-pressed',String(button.dataset.composition===style&&e.straighten==null&&!e.skew));}
    $('[data-composition-status]',sheet).textContent=view?`${view.reasons.join(' · ')}. Keeps ${Math.round(view.retained*100)}% before your crop.`:'Finding the strongest framing from the saved preview…';
    $('[data-auto-skew]',sheet).setAttribute('aria-pressed',String(skewed));
    $('[data-skew-reset]',sheet).hidden=!e.skew;
    $('[data-skew-status]',sheet).textContent=e.skew?'Your manual perspective takes priority on the axes you adjusted.':!skewed?'Automatic perspective is off.':'Perspective follows the selected composition. Drag either slider to make it your own.';
    const displayGeometry=PhotoGeometry.region(geometry,e.rotate||0);
    for(const input of $$('[data-skew]',sheet))if(document.activeElement!==input){const v=displayGeometry[input.dataset.skew];input.value=String(v);$(`[data-skew-value=${input.dataset.skew}]`,sheet).textContent=`${v>0?'+':''}${(v*100).toFixed(1)}%`;}
    $('[data-auto-mask]',sheet).hidden=!baseline?.masks?.length||(e.masks?.length||0)>=8||e.auto_parts?.subject===false;
    $('[data-edit=auto]',sheet).hidden=!on||!e.look;$('.sheet-knobs',sheet).hidden=!on;
    for(const b of $$('[data-crop]',sheet))b.setAttribute('aria-pressed',String(b.dataset.crop===crop));
    $('.notes-crop-hint',sheet).textContent={best:'The fullest framing that keeps your subject.',subject:'A closer view of the subject.',height:'Fill the height of the window.',width:'Fill the width of the window.',off:'Keep the whole photo in view.',custom:'Your own framing. Open Custom to adjust the rectangle or its exact measurements.'}[crop]||'';
    $('.sheet-deg',sheet).textContent=`${e.rotate||0}°`;
    const angle=$('[name=straighten]',sheet);if(document.activeElement!==angle){angle.value=String(degrees);$('[data-straighten-angle]',sheet).textContent=`${degrees>0?'+':''}${degrees.toFixed(2)}°`;}
    if(!$('.notes-grading',sheet).contains(document.activeElement))PhotoFinish.fillWheels($('.notes-grading',sheet),e.grade||{});
    $('.notes-mask-summary',sheet).textContent=e.masks?.length?`${e.masks.length} editable ${e.masks.length===1?'mask':'masks'} on this photo.`:'Paint an area to adjust it without changing the rest of the photo.';
    $('[data-light-state]',sheet).textContent=e.look?'Adjusted':'';
    $('[data-grade-state]',sheet).textContent=e.grade?'Adjusted':'';
    $('[data-angle-state]',sheet).textContent=e.straighten!=null||e.skew?'Manual':e.rotate?`${e.rotate}°`:aligned||skewed?`${style[0].toUpperCase()+style.slice(1)}`:'';
    $('[data-mask-state]',sheet).textContent=e.masks?.length?plural(e.masks.length,'mask'):'';
    const k=knobsOf(e.look);for(const r of $$('[data-knob]',sheet))if(document.activeElement!==r){r.value=k[r.dataset.knob];this.knobValue(r);}
    this.writingStatus();
  }
};
if(typeof document!=='undefined')PhotoNotes.init();
if(typeof module!=='undefined')module.exports={PhotoNotes};
