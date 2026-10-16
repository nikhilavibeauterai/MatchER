// A focused print carries its writing and sticky notes. The longer story stays on the sheet underneath it.
// Only focused, live cards load that story; the thousands of thumbnails and sea sprites stay lightweight.
const PhotoNotes = {
  hosts:new Map(), cache:new Map(), pending:new Map(), source:null, paperID:0,
  init() {
    const queue=()=>{if(this.queued)return;this.queued=requestAnimationFrame(()=>{this.queued=0;this.scan();});};
    this.queue=queue;
    this.observer=new MutationObserver(records=>{
      if(records.some(r=>!r.target.closest?.('#world,.photo-notes-paper,.photo-notes-tab,.photo-writing,.photo-sticky,svg.marks,.user-note,#toolbelt,#history-hud,#af-defs')&&
        [...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1)))queue();
    });
    this.observer.observe(document.body,{childList:true,subtree:true});
    window.addEventListener('sea-camera',()=>this.camera());
    window.addEventListener('sea-image-ready',()=>{if(!this.seaDetail)this.camera();});
    window.addEventListener('resize',()=>{queue();requestAnimationFrame(()=>{this.repaint();this.position();});});
    window.addEventListener('photo-render-change',()=>this.repaint());
    window.addEventListener('hashchange',()=>{this.close(false);this.clearSea();queue();});
    document.addEventListener('close',e=>{if(e.target.contains(this.sheet))this.close(false);},true);
    // Escape dismisses this local layer first. Inputs and the searchable picker keep their native keys.
    document.addEventListener('keydown',e=>{
      if(!this.sheet)return;
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
      this.cache.clear();clearTimeout(this.refreshTimer);
      if(this.busy)return; // The sheet action refreshes its card and sheet together.
      this.refreshTimer=setTimeout(()=>{
        this.scan();
        if(this.sheet&&e.detail.path!=='/api/edit')this.reload().catch(error=>toast(error.message));
      },80);
    });
    Toolbelt.listeners.add((pid,edits)=>{
      for(const [host,state] of this.hosts)if(state.pid===pid){if(state.data)state.data.edits=edits;this.decorate(host,state);}
      if(this.active?.pid===pid&&this.active.data){this.active.data.edits=edits;this.controls();}
    });
    queue();
  },
  scan() {
    const source=S.lib?.source||'';
    if(source!==this.source){this.close(false);this.source=source;this.cache.clear();this.pending.clear();for(const host of this.hosts.keys())this.detach(host);}
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
    this.seaSource?.classList.remove('photo-detail-source');this.seaSource=null;
  },
  camera() {
    // Editing chrome lives in screen space. Never rebuild sprites, resize a world-space image or translate a
    // sea body while its camera is moving; a single full-size print gets a normal focused card after it rests.
    this.clearSea();
    const version=this.cameraVersion;
    if(!['ambient','live'].includes(World.mode)||World.sea?.camera.zoom<=1)return;
    this.seaTimer=setTimeout(()=>{
      const sea=World.sea;if(!sea?.cameraOn||this.seaDetail)return;
      const visible=[...sea.items.values()].filter(it=>!it.take&&!it.imagePending&&sea.fullSize(it)&&it.el.isConnected&&!it.el.classList.contains('lifted'));
      const chosen=visible.map(it=>({it,r:it.el.getBoundingClientRect()})).filter(({r})=>r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight)
        .sort((a,b)=>Math.hypot(a.r.left+a.r.width/2-innerWidth/2,a.r.top+a.r.height/2-innerHeight/2)-Math.hypot(b.r.left+b.r.width/2-innerWidth/2,b.r.top+b.r.height/2-innerHeight/2))[0];
      if(!chosen)return;
      const {it,r}=chosen,detail=document.createElement('div');detail.className='print sea-photo-detail';detail.dataset.photo=it.photo;
      detail.style.cssText=`left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      const img=document.createElement('img');img.src=it.el.querySelector('.pile-cover')?.getAttribute('src')||M(it.photo,r.width,true);img.alt='Focused photo';img.draggable=false;detail.append(img);
      detail.onpointerdown=e=>{if(e.target.closest('button,input,textarea,.meta.sticky')||Toolbelt.tool!=='hand')return;e.stopPropagation();sea.panStart(e);};
      detail.ondblclick=e=>{if(e.target.closest('button,input,textarea,.meta.sticky'))return;e.preventDefault();e.stopPropagation();sea.resetCamera();};
      img.decode().then(()=>{
        if(this.seaDetail||this.cameraVersion!==version||!it.el.isConnected)return;
        this.seaDetail=detail;this.seaSource=it.el;document.body.append(detail);it.el.classList.add('photo-detail-source');this.attach(detail);Toolbelt.arm(detail);
      }).catch(()=>{});
    },250);
  },
  attach(host) {
    if(this.hosts.has(host)||host.closest('#world,button,.an-grab,#an-sea,.world-fly,#history-hud')||!host.getClientRects().length)return;
    const pid=Toolbelt.pidOf(host);if(!pid)return;
    if(host.matches('.print'))Cards.focus(host);
    const tab=document.createElement('button');tab.type='button';tab.className='photo-notes-tab';
    tab.innerHTML='<span>notes</span>';tab.setAttribute('aria-label','Open photo notes');tab.setAttribute('aria-expanded','false');
    for(const type of ['pointerdown','dblclick','dragstart'])tab.addEventListener(type,e=>e.stopPropagation());
    tab.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key))e.stopPropagation();});
    tab.onclick=e=>{e.preventDefault();e.stopPropagation();this.active?.host===host?this.close():this.open(host);};
    const paper=document.createElement('div');paper.className='photo-notes-paper rail-card';paper.id=`photo-notes-${++this.paperID}`;
    paper.append(tab);host.classList.add('has-photo-notes');host.append(paper);
    for(const type of ['pointerdown','click','dblclick','wheel'])paper.addEventListener(type,e=>e.stopPropagation());
    paper.addEventListener('click',()=>{if(!paper.classList.contains('photo-note-sheet')&&!paper.classList.contains('notes-returning'))this.open(host);});
    const state={pid,tab,paper,data:null,motion:0};this.hosts.set(host,state);this.load(host,state);
  },
  detach(host) {
    if(this.active?.host===host)this.close(false);
    const state=this.hosts.get(host);if(state)state.motion++;
    for(const el of $$(':scope > .photo-notes-paper,:scope > .photo-writing,:scope > .photo-facts',host))el.remove();
    host.classList.remove('has-photo-notes','has-photo-sticky');this.hosts.delete(host);
  },
  async get(pid) {
    if(this.cache.has(pid))return this.cache.get(pid);
    if(this.pending.has(pid))return this.pending.get(pid);
    const source=this.source;
    const task=api(`/api/photo/${pid}/notes`).then(data=>{
      if(source!==this.source)return null;
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
    host.classList.toggle('notes-caption',!!host.querySelector('.paper > .role,.paper > .stack'));
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
    if(host.matches('.print')||host.classList.contains('framed-photo')||['crop','rotate','look','enhance'].some(k=>k in (p.edits||{})))this.preview(host,p,p.edits);
  },
  repaint() {
    for(const [host,state] of this.hosts)if(state.data&&host.isConnected&&host.matches('.print,.framed-photo')){placeNote(host);this.preview(host,state.data,Toolbelt.current(state.pid));}
    this.controls();
  },
  preview(host,p,edits) {
    let img=host.querySelector('.window img');
    if(!img){
      Cards.focus(host);img=host.querySelector('.window img');if(!img)return;
    }
    const frame=()=>{
      if(!host.isConnected)return;
      host.dataset.photo=p.id;host.dataset.frame='own';host.dataset.box=JSON.stringify(p.subject||null);
      host.dataset.crop=this.cropFor(host,edits);
      host.dataset.rotate=String(edits.rotate||0);host.dataset.enhance=(edits.enhance??(host.matches('.board-card')?true:S.filter))?'on':'off';
      host.dataset.look=JSON.stringify(edits.look||null);
      framePhoto(host,{dims:[p.width||img.naturalWidth||1,p.height||img.naturalHeight||1],box:p.subject},
        {crop:host.dataset.crop,rotate:edits.rotate||0,enhance:host.dataset.enhance==='on',knobs:edits.look?knobsOf(edits.look):null});
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
    this.sheet=sheet;this.active={...state,host};state.tab.setAttribute('aria-expanded','true');state.tab.setAttribute('aria-controls',sheet.id);
    sheet.onkeydown=e=>e.stopPropagation();
    $('.notes-close',sheet).onclick=()=>this.close();this.position();sheet.getBoundingClientRect();sheet.classList.add('is-open');sheet.focus({preventScroll:true});
    this.afterMotion(host,state,()=>sheet.classList.remove('notes-opening'));
    try{await this.reload();}catch(e){if(this.sheet===sheet)$('p',sheet).textContent=e.message;}
  },
  close(focus=true) {
    const active=this.active;this.sheet=null;this.active=null;if(!active)return;
    const {host,paper,tab}=active,state=this.hosts.get(host);if(state)state.motion++;
    paper.classList.remove('is-open','photo-note-sheet','notes-opening');paper.classList.add('notes-returning');paper.inert=true;
    host.style.removeProperty('--notes-shift');tab.setAttribute('aria-expanded','false');tab.removeAttribute('aria-controls');
    const tuck=()=>{
      paper.replaceChildren(tab);paper.inert=false;paper.scrollTop=0;paper.classList.remove('notes-returning');paper.removeAttribute('role');paper.removeAttribute('tabindex');host.classList.remove('notes-active');
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
  position() {
    if(!this.sheet||!this.active)return;
    const host=this.active.host;host.classList.add('notes-active');
    const r=host.getBoundingClientRect(),current=parseFloat(getComputedStyle(host).translate)||0,left=r.left-current,right=r.right-current;
    if(innerWidth<760){
      host.style.removeProperty('--notes-shift');return;
    }
    host.style.setProperty('--notes-shift',`${Math.max(16-left,Math.min(0,innerWidth-16-r.width-18-right))}px`);
  },
  async reload() {
    const active=this.active,sheet=this.sheet;if(!active||!sheet)return;
    const [data,tags,history]=await Promise.all([this.get(active.pid),api('/api/tags?all=1'),api('/api/history?stage=home')]);
    if(this.active!==active||!data)return;
    active.data={...data,edits:Toolbelt.edits.has(active.pid)?Toolbelt.current(active.pid):data.edits};active.tags=tags.tags;active.bins=data.available_groups||[];active.history=history;
    for(const [host,state] of this.hosts)if(state.pid===active.pid){state.data=active.data;this.decorate(host,state);}
    this.render();
  },
  async edit(patch) {
    const active=this.active;if(!active)return;
    await Toolbelt.save(active.pid,patch);
    if(this.active===active){active.data.edits=Toolbelt.current(active.pid);this.controls();this.preview(active.host,active.data,active.data.edits);}
  },
  async action(path,body) {
    const active=this.active;if(!active||this.busy)return;this.busy=true;
    try{const r=await api(path,body);updateHudQuiet(r.game);refreshHud(true);this.cache.delete(active.pid);if(this.active===active)await this.reload();}
    catch(e){toast(e.message);}finally{this.busy=false;this.scan();}
  },
  render() {
    const {data:p,tags,bins}=this.active,sheet=this.sheet,e=p.edits||{};
    const facts=rows=>`<dl class="notes-facts">${rows.filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    const num=n=>typeof n==='number'?Number(n.toFixed(3)):n;
    const words=k=>FLAG_LABELS[k]||TASTE_LABELS[k]||k.replace(/_/g,' ');
    const scores=obj=>facts(Object.entries(obj||{}).filter(([,v])=>typeof v==='number').sort((a,b)=>b[1]-a[1]).map(([k,v])=>[words(k),num(v)]));
    sheet.innerHTML=`<div class="notes-heading"><h2>Photo notes</h2><button class="btn notes-close" aria-label="Close photo notes">×</button></div>
      <form class="notes-writing"><label>Title<input name="title" type="text" maxlength="160" value="${esc(e.title||'')}" placeholder="Write on the frame"></label>
        <label>Private notes<textarea name="description" maxlength="8000" rows="3" placeholder="Anything else about this photo">${esc(e.description||'')}</textarea></label><button class="btn">Save writing</button><span class="notes-saved" role="status"></span></form>
      <section><h3>Tags</h3><div class="notes-tags">${p.tags.map(t=>`<button class="chip" data-remove-tag="${esc(t.key)}" title="Remove ${esc(t.label)} from this take">${esc(t.emoji||'🏷️')} ${esc(t.label)} ×</button>`).join('')||'<p class="muted">No tags yet.</p>'}</div>
        <div class="tag-picker notes-tag-picker"></div><form class="notes-new-tag"><input name="label" type="text" maxlength="40" aria-label="New tag name" placeholder="New tag" required><button class="btn">Add</button></form></section>
      <details class="notes-finishing" open><summary>Finish this photo</summary><div class="edit-sheet">
        <h3>Enhance</h3><div class="sheet-row"><button class="btn ghost" data-edit="enhance">On</button><button class="btn ghost" data-edit="auto">Back to auto</button></div>
        <div class="sheet-knobs">${Object.entries(KNOBS).map(([key,[lo,hi]])=>`<label class="sheet-knob"><span>${KNOB_WORD[key]}</span><input type="range" data-knob="${key}" min="${lo}" max="${hi}" step="0.05" aria-label="${KNOB_WORD[key]}"><output></output></label>`).join('')}</div>
        <h3>Crop</h3><div class="sheet-seg">${[['best','Best'],['subject','Focus subject'],['height','Fill height'],['width','Fill width'],['off','Off']].map(([key,label])=>`<button class="btn ghost" data-crop="${key}" ${key==='subject'&&!p.subject?'hidden':''}>${label}</button>`).join('')}</div>
        <h3>Turn</h3><div class="sheet-row"><button class="btn ghost" data-turn="-90" aria-label="Turn a quarter anticlockwise">↺</button><b class="sheet-deg"></b><button class="btn ghost" data-turn="90" aria-label="Turn a quarter clockwise">↻</button></div></div></details>
      <section><h3>Place in the game</h3>${facts([['Status',p.cut?`Set aside: ${words(p.cut)}`:'In the running'],['Your decision',p.override],['Stack',`${p.stack.members.length} ${p.stack.members.length===1?'take':'takes'}${p.stack.rep===p.id?' · kept take':''}`],['Group',p.group.name],['Hand added to export',p.pick?'Yes':null],['Appeal',num(p.ranking?.appeal)],['Shortlist confidence',p.ranking?pct(p.ranking.inclusion):null],['Duels',p.ranking?.duels]])}
        <div class="row wrap">${p.stack.members.length>1?`${p.stack.rep!==p.id?'<button class="btn" data-photo-action="keep">Keep this take</button>':''}<button class="btn" data-photo-action="split">Split out</button>`:''}<button class="btn ${p.cut?'':'danger'}" data-photo-action="${p.cut?'rescue':'toss'}">${p.cut?'Bring back':'Set aside'}</button></div>
        ${bins.length?`<label>Group<select class="notes-group"><option value="">No group</option>${bins.map(g=>`<option value="${g.id}" ${g.id===p.group.id?'selected':''}>${esc(g.emoji||'🗂️')} ${esc(g.name)}</option>`).join('')}</select></label>`:''}</section>
      <details><summary>File & metadata</summary>${facts([['File',p.rel],['Date',p.taken?.replace('T',' ')],['Date source',p.taken_src],['Camera',[p.make,p.model].filter(Boolean).join(' ')],['Dimensions',p.width&&p.height?`${p.width} × ${p.height}`:null],['Format',p.fmt],['File size',p.size?`${(p.size/1048576).toFixed(2)} MB`:null],['Read status',p.status],['Problem',p.error]])}${photoPathButton(p.id)}</details>
      <details><summary>What the analysis found</summary>${facts([['Observations',(p.flags||[]).map(words).join(', ')],['Faces',p.n_faces],['Brightness',num(p.luma)],['Dark tones',num(p.luma_lo)],['Light tones',num(p.luma_hi)],['Sharpness',num(p.sharp)],['Colour range',num(p.chroma)],['Saturation',num(p.saturation)],['Hue',num(p.hue)],['Starting appeal',num(p.prior)],['Subject region',p.subject?.map(num).join(', ')],['Salient region',p.salient?.map(num).join(', ')]])}
        <h4>Recognition scores</h4>${scores(p.recognized_tags?.tags||p.recognized_tags)}${scores(p.zs)}
        ${p.faces.map((f,i)=>`<h4>Face ${i+1}${f.label?` · ${esc(f.label)}`:''}</h4>${facts(Object.entries(f).filter(([k])=>!['id','photo_id','idx'].includes(k)).map(([k,v])=>[words(k),num(v)]))}`).join('')}</details>
      <details><summary>Your saved changes</summary>${facts([['Title',e.title],['Notes',e.description],['Pen & marker strokes',e.marks?.length],['Sticky notes',e.notes?.map(n=>n.text).join(' · ')],['Crop',e.crop],['Turn',e.rotate!==undefined?`${e.rotate}°`:null],['Enhance',e.enhance!==undefined?e.enhance?'On':'Off':null]])}
        ${p.tag_edits.length?facts(p.tag_edits.map(t=>[t.label,t.on?'Added by you':'Removed by you'])):'<p class="muted">No tag corrections.</p>'}</details>
      <details><summary>Recent calls</summary>${p.history.length?`<ol class="notes-history">${p.history.map(h=>`<li>${esc(words(h.kind))}${h.winner===p.id?' · won':''}${h.undone?' · undone':''}<time>${esc(new Date(h.ts*1000).toLocaleString())}</time></li>`).join('')}</ol>`:'<p class="muted">No calls for this take yet.</p>'}</details>
      <div class="notes-footer"><button class="btn ghost" data-notes-undo>Undo <kbd>Z</kbd></button><span>Kept with this photo</span></div>`;
    $('.notes-close',sheet).onclick=()=>this.close();
    $('.notes-writing',sheet).onsubmit=async event=>{
      event.preventDefault();const form=new FormData(event.target),pid=p.id,patch={title:form.get('title').trim(),description:form.get('description').trim()};
      await this.edit(patch);
      if(this.sheet===sheet){const saved=Toolbelt.current(pid);$('.notes-saved',sheet).textContent=Object.entries(patch).every(([k,v])=>(saved[k]||'')===v)?'Saved':'Could not save';}
    };
    tagPicker($('.notes-tag-picker',sheet),tags.filter(t=>!p.tags.some(on=>on.key===t.key)),t=>this.action('/api/tags/set',{photos:[p.id],on:[t.key],exact:true}),{label:'Add a tag'});
    for(const b of $$('[data-remove-tag]',sheet))b.onclick=()=>this.action('/api/tags/set',{photos:[p.id],off:[b.dataset.removeTag],exact:true});
    $('.notes-new-tag',sheet).onsubmit=event=>{event.preventDefault();this.action('/api/tags/new',{label:new FormData(event.target).get('label'),photos:[p.id],exact:true});};
    $('[data-edit=enhance]',sheet).onclick=()=>this.edit({enhance:!this.enhanced()});
    $('[data-edit=auto]',sheet).onclick=()=>this.edit({look:null});
    for(const b of $$('[data-crop]',sheet))b.onclick=()=>this.edit({crop:b.dataset.crop==='off'?'none':b.dataset.crop});
    for(const b of $$('[data-turn]',sheet))b.onclick=()=>this.edit({rotate:((this.active.data.edits.rotate||0)+Number(b.dataset.turn)+360)%360});
    const knobs=()=>Object.fromEntries($$('[data-knob]',sheet).map(r=>[r.dataset.knob,Number(r.value)]));
    for(const r of $$('[data-knob]',sheet)){
      r.oninput=()=>{r.nextElementSibling.textContent=Number(r.value).toFixed(2);this.preview(this.active.host,p,{...this.active.data.edits,look:knobs()});};
      r.onchange=()=>this.edit({look:knobs()});
    }
    for(const b of $$('[data-photo-action]',sheet))b.onclick=()=>{
      const name=b.dataset.photoAction;
      this.action(name==='keep'?'/api/frame':name==='split'?'/api/groups/split':name==='rescue'?'/api/rescue':'/api/draw/toss',name==='rescue'?{ids:[p.id],on:true}:{photo:p.id});
    };
    const group=$('.notes-group',sheet);if(group)group.onchange=()=>this.action('/api/draw/move',{photos:[p.id],theme:group.value?Number(group.value):null});
    $('[data-notes-undo]',sheet).onclick=()=>HistoryHUD.act('undo');
    sheet.onkeydown=event=>{if(event.key.toLowerCase()==='z'&&!event.target.closest('input,textarea,select')&&!event.ctrlKey&&!event.metaKey){event.preventDefault();HistoryHUD.act('undo');}event.stopPropagation();};
    this.controls();this.position();
  },
  enhanced(){return this.active.data.edits.enhance??(this.active.host.matches('.board-card')?true:S.filter);},
  cropFor(host,edits){return normCrop(edits.crop??(host.matches('.board-card')||host.closest('.twin-arena')?'off':S.crop));},
  controls() {
    if(!this.sheet||!this.active?.data)return;
    const sheet=this.sheet,e=this.active.data.edits,on=this.enhanced(),crop=this.cropFor(this.active.host,e);
    const toggle=$('[data-edit=enhance]',sheet);if(!toggle)return;
    $('[data-notes-undo]',sheet).hidden=!this.active.history?.undo&&!HistoryHUD.photoEdit;
    toggle.textContent=on?'On':'Off';toggle.setAttribute('aria-pressed',String(on));
    $('[data-edit=auto]',sheet).hidden=!on||!e.look;$('.sheet-knobs',sheet).hidden=!on;
    for(const b of $$('[data-crop]',sheet))b.setAttribute('aria-pressed',String(b.dataset.crop===crop));
    $('.sheet-deg',sheet).textContent=`${e.rotate||0}°`;
    const k=knobsOf(e.look);for(const r of $$('[data-knob]',sheet))if(document.activeElement!==r){r.value=k[r.dataset.knob];r.nextElementSibling.textContent=k[r.dataset.knob].toFixed(2);}
  }
};
PhotoNotes.init();
