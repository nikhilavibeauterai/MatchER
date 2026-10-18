// Filter changes eligibility, not the files. Rules stay a draft until their preview is applied.
async function viewFilter(main, params) {
  const view=S.view,signal=S.events.signal,draftKey=`matcher-filter-draft:${S.lib.source}`;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const ordered=value=>Array.isArray(value)?value.map(ordered).sort():value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
  const same=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
  let saved=null,draft=null,preview=null,sea=null,oldCatalog=true,oldLassos=true,busy=false,epoch=0,mode=params.get('view')==='sea'?'sea':'review',focus=null;
  let rows=[],page=0,total=0,more=false,catalogueLoading=false,state='all',current=null;
  let queue=null,seen=new Set(),deferred=[],reviewCalls=[],redoCalls=[],reviewLoading=0,schedulerEmpty=false;
  let noticed='',base=null,learning=null,protectedRules=new Set(),fitObserver=null;
  let initializing=true,work=0,queuedUndo=false,recovery=null;
  let forecast=null,thresholdTimer=null,flowTimer=null,thresholdPreviewing=false,thresholdDragging=false,thresholdHistory=[],thresholdFuture=[];
  const learned=()=>learning?.changes?.filter(change=>!protectedRules.has(change.key))||[];
  const alive=()=>!left(view),dirty=()=>saved&&draft&&!same(draft,saved.policy),validPreview=()=>preview&&same(preview.policy,draft);
  const shown=()=>forecast||(validPreview()?preview:saved);
  const persist=()=>{try{if(dirty())sessionStorage.setItem(draftKey,JSON.stringify({version:1,policy:draft,base,savedPolicy:saved.policy,learning,protected:[...protectedRules]}));else sessionStorage.removeItem(draftKey);}catch(_){}};
  const photoUrl=id=>`/api/filter${validPreview()?`/preview?token=${encodeURIComponent(preview.token)}&`:'?'}photo=${id}&per=1`;
  const blocked=()=>initializing||busy||work>0||!!recovery;
  function beginWork(){work++;busy=true;renderActions();}
  async function drainUndo(){if(!alive()||blocked()||reviewLoading||!queuedUndo)return;queuedUndo=false;await action('undo');}
  async function endWork(){work--;busy=work>0;if(alive()){renderActions();await drainUndo();}}
  async function freshSummary(){try{return await api('/api/filter?per=24');}catch(_){return api('/api/filter?per=24');}}
  async function reconcile(task){
    // The write has committed. Retry its reads, never the player's choice.
    recovery=task;try{await task();if(alive())recovery=null;}catch(e){if(alive()){note('Saved · refresh needed');toast(e.message);}}
  }
  function note(text){noticed=text;const el=$('#filter-status',main);if(el)el.textContent=text;}
  function title(row){return row.reason_text||row.reasons?.map(k=>saved.labels?.[k]||k).join(' · ')||(row.disposition==='keep'?'In play':'Set aside');}
  const passes=(fit,threshold)=>fit>0&&(fit>=1||fit>=threshold);
  function resultBadge(row){const fail=!row.playable||(Number.isFinite(row.fit)?!passes(row.fit,draft.fit_threshold??.5):!!row.reasons?.length);return `<span class="filter-result ${fail?'fail':'pass'}" role="img" aria-label="${fail?'Fails':'Passes'} ${dirty()?'preview':'current'} rules" title="${fail?'Fails':'Passes'} ${dirty()?'preview':'current'} rules">${fail?'✕':'✓'}</span>`;}
  // The spotlight is one polaroid (CSS sizes the card); the take is contained in its window, or zoomed to its subject.
  function fitReview(){const print=$('.filter-print',main),img=print?.querySelector('.window > img');if(!print||!img)return;const dims=[img.naturalWidth||current?.metrics?.width||1,img.naturalHeight||current?.metrics?.height||1],box=World.photos.get(current?.id)?.box;print.dataset.photo=current.id;framePhoto(print,{dims,box});World.fence();}
  function learningText(){return learned().length?'Preview':learning?.samples?.reviewed?'Learning…':'';}
  function feedback(kind){const el=$('.filter-stage',main);if(!el)return;el.dataset.feedback=kind;clearTimeout(feedback.timer);feedback.timer=setTimeout(()=>{if(alive())delete el.dataset.feedback;},1100);}
  function reviewPool(scope=focus){const d=shown();return [...new Set(scope&&scope!=='all'?d.ids?.[scope]||[]:[...(d.ids?.changed||[]),...(d.ids?.aside||[]),...(d.ids?.kept||[])])];}
  function nextReviewIds(scope=queue?queue.scope:focus){const pool=reviewPool(scope),allowed=new Set(pool);return [...new Set([...deferred.filter(id=>allowed.has(id)),...pool])].filter(id=>!seen.has(id)).slice(0,6);}
  function setCurrent(row){current=row;}
  function previewText(){const c=validPreview()?preview.counts:null;return c?`${fmt(c.to_aside||0)} would leave · ${fmt(c.to_keep||0)} would return`:'';}
  function help(){return helpBtn('The sea runs from <b>out on the left</b> to <b>in on the right</b>. Drag the dividing line to change the cutoff. <b>← / A</b> tosses this take; <b>→ / D</b> keeps it. <b>↑ / W</b> teaches more like this; <b>↓ / S</b> teaches less like this, moving related takes while this one stays in focus. <b>Space</b> skips, <b>Z</b> undoes, <b>X</b> tosses. <b>C</b> toggles auto-crop; <b>F</b> toggles enhancement. The moving sea previews your criteria. <b>Enter</b> saves the preview and continues to Stacks whenever you are ready. <b>Esc</b> opens Browse, the sea and other tools.');}
  function positionThreshold(){
    if(!sea)return;const line=$('#filter-line',main),range=$('#filter-threshold',main),rail=$('.filter-boundary',main),field=$('.filter-field',main);if(!line||!rail||!field)return;
    const world=sea.el.getBoundingClientRect(),r=rail.getBoundingClientRect(),f=field.getBoundingClientRect(),value=draft.fit_threshold??.5,x=world.left+sea.screenX(sea.outcomeX(value));
    line.style.left=`${x}px`;line.style.top=`${f.top}px`;line.style.height=`${Math.max(0,r.top+r.height/2-f.top)}px`;line.hidden=mode==='catalogue';line.setAttribute('aria-valuenow',Math.round(value*100));
    range.style.left=`${world.left+sea.screenX(sea.outcomeX(0))-r.left-12}px`;range.style.width=`${(sea.outcomeX(1)-sea.outcomeX(0))*sea.camera.zoom+24}px`;range.value=value;range.setAttribute('aria-valuetext',`${Math.round(value*100)}% cutoff`);
  }
  function forecastThreshold(source){
    const scores=source.scores||{},threshold=draft.fit_threshold??.5,kept=[],aside=[],changed=[],toKeep=[],toAside=[],wasKept=new Set(saved.ids?.kept||[]);
    for(const [key,fit] of Object.entries(scores)){const id=Number(key),inside=passes(fit,threshold);(inside?kept:aside).push(id);if(inside!==wasKept.has(id)){changed.push(id);(inside?toKeep:toAside).push(id);}}
    forecast={...source,policy:copy(draft),scores,ids:{...source.ids,kept,aside,failing:aside,changed},counts:{...source.counts,kept:kept.length,aside:aside.length,changed:changed.length,to_keep:toKeep.length,to_aside:toAside.length}};
  }
  function moveThreshold(value,remember=true){
    if((blocked()&&!thresholdPreviewing)||!saved)return;value=Math.max(0,Math.min(1,Math.round(Number(value)*100)/100));if(!Number.isFinite(value)||value===(draft.fit_threshold??.5))return;
    if(remember){thresholdFuture=[];if(!thresholdDragging)thresholdHistory.push(draft.fit_threshold??.5);}
    const source=shown();base.fit_threshold=draft.fit_threshold=value;protectedRules.add('fit_threshold');forecastThreshold(source);preview=null;focus=null;epoch++;persist();note('Preview');positionThreshold();renderCounts();renderActions();
    const badge=$('.filter-result',main);if(badge&&current)badge.outerHTML=resultBadge(current);
    if(!flowTimer)flowTimer=setTimeout(()=>{flowTimer=null;if(alive()&&sea){const d=shown();sea.setOutcomeFlow({kept:d.ids.kept,aside:d.ids.aside,changed:d.ids.changed,scores:d.scores,threshold:draft.fit_threshold});}},80);
    clearTimeout(thresholdTimer);thresholdTimer=setTimeout(flushThreshold,180);
  }
  async function flushThreshold(){
    if(!alive()||!forecast)return;if(blocked()){thresholdTimer=setTimeout(flushThreshold,100);return;}
    const submitted=copy(draft);thresholdPreviewing=true;try{await previewDraft();}finally{thresholdPreviewing=false;if(alive()&&forecast){if(same(submitted,draft)){forecast=null;renderCounts();renderActions();}else{clearTimeout(thresholdTimer);thresholdTimer=setTimeout(flushThreshold,180);}}}
  }
  function bindThreshold(){
    const range=$('#filter-threshold',main),line=$('#filter-line',main);
    let gestureStart=null;
    const start=()=>{if(blocked())return false;gestureStart=draft.fit_threshold??.5;thresholdHistory.push(gestureStart);thresholdDragging=true;return true;};
    const end=()=>{if(gestureStart!==null&&gestureStart===(draft.fit_threshold??.5))thresholdHistory.pop();gestureStart=null;thresholdDragging=false;clearTimeout(thresholdTimer);thresholdTimer=setTimeout(flushThreshold,0);};
    range.onpointerdown=()=>start();range.oninput=()=>moveThreshold(range.value);range.onchange=()=>{clearTimeout(thresholdTimer);thresholdTimer=setTimeout(flushThreshold,0);};range.onpointerup=range.onpointercancel=()=>{end();range.blur();};
    range.onkeydown=e=>{if(e.key.toLowerCase()==='z'){e.preventDefault();e.stopPropagation();action('undo');}};
    line.onpointerdown=e=>{if(e.button!==0||!start())return;e.preventDefault();line.setPointerCapture(e.pointerId);};
    line.onpointermove=e=>{if(line.hasPointerCapture(e.pointerId))moveThreshold(sea.outcomeScore(sea.worldX(e.clientX-sea.el.getBoundingClientRect().left)));};
    const finish=e=>{if(!line.hasPointerCapture(e.pointerId))return;line.releasePointerCapture(e.pointerId);end();line.blur();};line.onpointerup=finish;line.onpointercancel=finish;
    line.onkeydown=e=>{const delta={ArrowLeft:-.01,a:-.01,ArrowRight:.01,d:.01,PageDown:-.1,PageUp:.1}[e.key];if(delta!=null||['Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();moveThreshold(e.key==='Home'?0:e.key==='End'?1:(draft.fit_threshold??.5)+delta);}};
  }
  function shell(){
    main.innerHTML=`<section class="screen filter-stage">
      <header class="screen-head" data-open-water><h1 data-solid>Filter</h1><span id="filter-total" hidden></span><span class="filter-help" data-solid>${help()}</span></header>
      <div id="filter-line" class="filter-line" role="slider" tabindex="0" aria-label="Filter boundary: out to the left, in to the right" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div>
      <div class="screen-body filter-field"><div id="filter-content"></div><div class="filter-boundary-bar"><div class="filter-boundary"><input id="filter-threshold" type="range" min="0" max="1" step=".01" value=".5" aria-label="Filter cutoff: left of the line is out, right is in"></div><div class="filter-outcomes" id="filter-outcomes"></div></div></div>
      <footer class="screen-bar action-bar" id="filter-actions" data-open-water></footer>
    </section>`;
    bindThreshold();renderBody();renderCounts();renderActions();
  }
  function renderCounts(){
    const d=shown(),c=d.counts||{},isPreview=!!forecast||!!validPreview();$('#filter-total',main).textContent=`${fmt(c.total||0)} takes`;
        $('#filter-outcomes',main).innerHTML=['aside','kept'].map(key=>{const ids=d.ids?.[key]||[],label=key==='kept'?'In play':'Set aside',tag=ids.length?'button':'div';return `<${tag} class="filter-outcome ${key} ${focus===key?'on':''}" data-solid title="${label}${isPreview?' · preview':''}" ${ids.length?`data-outcome="${key}" aria-pressed="${focus===key}"`:''} aria-label="${label}: ${fmt(c[key]||0)}${isPreview?' in preview':''}"><span aria-hidden="true">${key==='kept'?'✓':'✕'}</span><b>${fmt(c[key]||0)}</b></${tag}>`;}).join('');
    $$('[data-outcome]',main).forEach(b=>b.onclick=()=>{if(blocked())return;const next=focus===b.dataset.outcome&&mode==='sea'?null:b.dataset.outcome;action('sea');focus=next;focusSea();renderCounts();renderActions();});
  }
  function renderActions(){
    const pending=dirty(),p=validPreview(),c=shown().counts||{},canReview=!schedulerEmpty&&nextReviewIds(focus).length,remaining=queue?.pending.length;
    S.historyActions={undo:()=>action('undo'),redo:()=>action('redo')};
    S.pauseActivity={title:'Filter',forward:()=>action('finish'),canForward:()=>!blocked()&&!forecast&&shown().counts.kept>0,actions:[
      ...(mode!=='review'&&(remaining||canReview)?[{id:'filter-review',label:remaining?'Resume filtering':'Filter takes',run:()=>action('review')}]:[]),
      {id:'filter-catalogue',label:'Browse takes',run:()=>openCatalogue('all')},
      {id:'filter-sea',label:'Explore sea',run:()=>action('sea')},
      ...(pending?[{id:'filter-reset',label:'Discard preview',run:()=>action('reset')}]:[]),
      ...(pending&&!p?[{id:'filter-preview',label:'Refresh preview',run:()=>action('preview')}]:[]),
      ...(p&&preview.counts.changed?[{id:'filter-inspect',label:'Inspect preview changes',run:()=>action('inspect')}]:[]),
      ...(saved.undo||thresholdHistory.length?[{id:'filter-undo',label:'Undo last change',run:()=>action('undo')}]:[]),
      ...(redoCalls.length||thresholdFuture.length?[{id:'filter-redo',label:'Redo last change',run:()=>action('redo')}]:[]),
      ...(current?.override?[{label:'Follow rules for this take',run:()=>decision('reset')}]:[])]};
    $('.filter-stage',main).dataset.mode=mode;$('.filter-stage',main).dataset.preview=!!pending;positionThreshold();
    const waiting=busy||work||initializing||forecast;
    const canForward=!blocked()&&!forecast&&shown().counts.kept>0;
    $('#filter-actions',main).innerHTML=`<span id="filter-status" role="status">${esc(noticed||learningText())}</span>${waiting?'<span class="filter-thinking" role="status" aria-label="Learning"><i></i><i></i><i></i></span>':recovery?'<button class="btn" data-filter-action="retry">Refresh</button>':''}`;
    // The way on is the HUD's next slot: coral once the preview can be applied, a quiet arrow while it cannot.
    S.forward=canForward?{label:'Next: Stacks →',name:'Stacks',run:()=>action('finish')}:null;
    $('#filter-content',main).inert=!!recovery&&!work;
    $$('[data-filter-action]',main).forEach(b=>b.onclick=()=>action(b.dataset.filterAction));
    paintTrack();
  }
  function renderBody(){
    fitObserver?.disconnect();fitObserver=null;const body=$('#filter-content',main);body.className=`filter-content ${mode}`;
    if(mode==='sea')body.innerHTML='';
    else if(mode==='catalogue'){
      body.innerHTML=`<section class="filter-catalogue" data-solid><header><div class="seg" aria-label="Take catalogue">${['all','aside','kept',...(validPreview()?['changed']:[])].map(key=>`<button class="seg-btn ${state===key?'on':''}" data-catalog-state="${key}">${({all:'Every take',aside:'Set aside',kept:'In play',changed:'Changes'})[key]}</button>`).join('')}</div><span class="muted small">${validPreview()?'Preview':'Current'} · ${fmt(total)}</span></header>
        <div class="filter-gallery">${rows.map(row=>`<button class="filter-take ${row.disposition==='aside'?'aside':''} ${row.changed?'changed':''}" data-review-photo="${row.id}" aria-label="Review ${esc(row.rel||'take '+row.id)}">${row.playable?`<img src="${T(row.id)}" alt="" loading="lazy">`:'<span class="filter-unreadable">🛠️</span>'}<span>${esc(title(row))}</span>${row.override?'<i title="Your call">✋</i>':''}</button>`).join('')||`<div class="filter-empty">${catalogueLoading?'Opening takes…':'No takes here'}</div>`}</div>
        <footer>${page?'<button class="btn ghost" data-catalog-page="back">← Previous</button>':'<span></span>'}<span class="muted small">${total?`${fmt(page*24+1)}–${fmt(Math.min(total,(page+1)*24))}`:'0'}</span>${more?'<button class="btn" data-catalog-page="next">More →</button>':'<span></span>'}</footer></section>`;
      $$('[data-catalog-state]',main).forEach(b=>b.onclick=()=>openCatalogue(b.dataset.catalogState));
      $$('[data-catalog-page]',main).forEach(b=>b.onclick=()=>{if(!blocked())loadCatalogue(page+(b.dataset.catalogPage==='next'?1:-1));});
      $$('[data-review-photo]',main).forEach(b=>b.onclick=()=>openReview(Number(b.dataset.reviewPhoto)));
    }else if(current){
      body.innerHTML=`<section class="filter-review">
        <div class="filter-spotlight" data-solid>${current.playable?`<div class="filter-shot" data-photo="${current.id}"><div class="filter-print print"><div class="paper"><div class="window"><img src="${P(current.id)}" alt="Take to review" draggable="false"></div>${resultBadge(current)}</div>${photoPathButton(current.id)}</div></div>`:'<div class="filter-unreadable"><span>🛠️</span><b>Couldn’t read this take</b></div>'}<span class="filter-pulse" aria-hidden="true"></span></div>
        <div class="filter-review-controls" role="group" aria-label="Directional choices">${current.playable?'<button class="btn" data-solid data-tune="toward" aria-label="Love this take and its kin" title="Keep this take and teach the filter to keep its kin"><kbd>↑</kbd><span>Love</span><small data-help-hint>this &amp; its kin</small></button>':''}<button class="btn big" data-solid data-decision="aside"><kbd>←</kbd> Toss</button><button class="btn ghost" data-solid data-review-next title="Return to this take later"><span>Skip</span><kbd>Space</kbd></button>${current.playable?'<button class="btn big primary" data-solid data-decision="keep">Keep <kbd>→</kbd></button><button class="btn" data-solid data-tune="away" aria-label="Hate this take and its kin" title="Set aside this take and teach the filter to set aside its kin"><span>Hate</span><small data-help-hint>this &amp; its kin</small><kbd>↓</kbd></button>':''}</div></section>`;
      $$('[data-decision]',main).forEach(b=>b.onclick=()=>decision(b.dataset.decision));$('[data-review-next]',main).onclick=()=>nextReview();
      $$('[data-tune]',main).forEach(b=>b.onclick=()=>decision(b.dataset.tune));
    }else body.innerHTML='<div class="filter-empty" data-solid>Dealing…</div>';
    const image=$('.filter-print img',main);if(image){image.addEventListener('load',fitReview,{once:true,signal});fitObserver=new ResizeObserver(fitReview);fitObserver.observe($('.filter-shot',main));fitReview();}
    World.fence();
  }
  function focusSea(){
    if(!sea)return;sea.focusKeys.clear();sea.focusCluster=mode==='sea'&&focus?`gfilter-${focus}`:null;sea.focusIds=mode==='sea'&&focus?new Set(shown().ids?.[focus]||[]):null;sea.applyFocus();
  }
  function paintSea(){
    if(!sea||!saved)return;const d=shown(),aside=new Set(d.ids?.aside||[]),changedIds=new Set(d.ids?.changed||[]),unreadable=new Set(d.ids?.unreadable||[]);
    const items=[...World.photos.values()].filter(p=>!unreadable.has(p.id)).map(p=>({id:p.id,photo:p.id,rep:p.id,members:[p.id],n:1,take:false,visual:p.visual,dims:p.dims,box:p.box,tags:p.tags||[],group:`filter-${aside.has(p.id)?'aside':'kept'}`,cut:aside.has(p.id),badge:changedIds.has(p.id)?'↔':'',title:changedIds.has(p.id)?'Preview changes this take':aside.has(p.id)?'Set aside':'In play'}));
    sea.setVenn([],items,[{id:'gfilter-kept',kind:'group',html:'In play'},{id:'gfilter-aside',kind:'group',html:'Set aside'}]);
    sea.setOutcomeFlow({kept:d.ids?.kept||[],aside:d.ids?.aside||[],changed:[...changedIds],scores:d.scores,threshold:draft.fit_threshold??.5});sea.onRelease=dropped;
    const failing=new Set(d.ids?.failing||d.ids?.aside||[]);for(const it of sea.items.values()){const fail=Number.isFinite(d.scores?.[it.id])?!passes(d.scores[it.id],draft.fit_threshold??.5):failing.has(it.id);it.el.dataset.filterResult=fail?'fail':'pass';it.el.dataset.filterChange=changedIds.has(it.id);it.el.title+=` · ${fail?'Fails':'Passes'} ${validPreview()?'preview':'current'} rules`;it.el.setAttribute('aria-label',it.el.title);}
    sea.lassos.get('gfilter-kept').hue=151;sea.lassos.get('gfilter-aside').hue=27;focusSea();fitReview();World.fence();positionThreshold();
  }
  async function loadCatalogue(next=0){
    const request=++epoch;page=next;const url=validPreview()?`/api/filter/preview?token=${encodeURIComponent(preview.token)}&`:'/api/filter?';
    try{const d=await api(`${url}page=${page}&per=24&state=${state}`);if(!alive()||request!==epoch)return;if(page&&d.total<=page*24)return loadCatalogue(Math.max(0,Math.ceil(d.total/24)-1));rows=d.photos||[];total=d.total;more=d.more;catalogueLoading=false;renderBody();}
    catch(e){if(alive()&&request===epoch){if(e.status===409)await stalePreview();else toast(e.message);}}
  }
  async function openCatalogue(which='all'){if(blocked())return;const gone=World.grab($('#filter-content',main));mode='catalogue';focusSea();state=which;page=0;current=null;rows=[];total=0;more=false;catalogueLoading=true;renderBody();World.swap($('#filter-content',main),gone);renderActions();await loadCatalogue();}
  async function refreshVisible(){
    if(mode==='catalogue')return loadCatalogue(page);
    if(mode!=='review'||!current)return;const request=++epoch,id=current.id;
    try{const d=await api(photoUrl(id));if(alive()&&request===epoch){setCurrent(d.photos?.[0]||null);renderBody();}}catch(e){if(alive()&&request===epoch)toast(e.message);}
  }
  async function openReview(id,resume=false,scope=undefined,internal=false){
    if((internal?busy:blocked())||reviewLoading)return;
    const request=++epoch;reviewLoading=request;$('.filter-review',main)?.setAttribute('aria-busy','true');
    try{
      if(!resume){
        scope=scope===undefined?(mode==='catalogue'&&state!=='all'?state:focus):scope;
        const policy=copy(draft),review=()=>api('/api/filter/review',{...(validPreview()?{token:preview.token}:{policy}),seen:[...seen],deferred,scope:scope||'all',limit:6});
        let d=await review();if(!d.ids.length&&seen.size&&alive()&&request===epoch){seen.clear();d=await review();}
        if(!alive()||request!==epoch||!same(policy,draft))return;
        const ids=[...new Set([...(id==null?[]:[id]),...d.ids])].slice(0,6);
        queue={ids,pending:[...ids],calls:[],skipped:[],scope,why:d.why||{}};schedulerEmpty=!ids.length;deferred=deferred.filter(pid=>!ids.includes(pid));id=ids[0];
      }
      mode='review';focusSea();
      if(id==null){mode='sea';current=null;renderBody();renderActions();return;}
      const d=await api(photoUrl(id));if(!alive()||request!==epoch)return;setCurrent(d.photos?.[0]||null);const gone=World.grab($('#filter-content',main));renderBody();World.swap($('#filter-content',main),gone);renderActions();
    }catch(e){if(alive()&&request===epoch){if(e.status===409)await stalePreview();else{toast(e.message);mode='sea';current=null;renderBody();renderActions();}}}
    finally{if(reviewLoading===request){reviewLoading=0;if(alive()){
      // A newer rule edit can cancel the next take after Later has already advanced the queue.
      if(mode==='review'&&(!current||queue&&queue.pending[0]!==current.id)){mode='sea';current=null;focusSea();renderBody();renderActions();}
      $('.filter-review',main)?.removeAttribute('aria-busy');
      await drainUndo();
    }}}
  }
  async function nextReview(skip=true){
    if((skip?blocked():busy)||reviewLoading||!queue||!current||queue.pending[0]!==current.id)return;
    const id=current.id;queue.pending=queue.pending.filter(pid=>pid!==id);
    if(skip){seen.add(id);queue.skipped.push(id);if(!deferred.includes(id))deferred.push(id);}
    if(!queue.pending.length){await openReview(undefined,false,queue.scope,true);return;}
    await openReview(queue.pending[0],true,undefined,true);
  }
  async function previewDraft(refresh=true,internal=false,required=false){
    if(internal?busy:blocked())return;const request=++epoch,policy=copy(draft),cataloguePage=page;beginWork();
    try{const d=await api('/api/filter/preview',{policy,per:24,state:'changed'});if(!alive()||request!==epoch||!same(policy,draft))return;for(const key of Object.keys(d.policy))if(same(base[key],policy[key]))base[key]=copy(d.policy[key]);draft=copy(d.policy);persist();forecast=null;preview=d;focus=null;
      note('Preview');paintSea();
      renderCounts();if(mode==='catalogue')await loadCatalogue(cataloguePage);else if(refresh&&mode==='review'&&current){const id=current.id,row=(await api(photoUrl(id))).photos?.[0];if(alive()&&request===epoch&&same(d.policy,draft)&&current?.id===id&&row){setCurrent(row);renderBody();}}
    }catch(e){if(alive()&&request===epoch){
      // A committed call is not reconciled until its wider effect can be shown. Recovery retries reads only.
      if(required)throw e;
      if(e.status===409)await stalePreview();else toast(e.message);
    }}finally{await endWork();}
  }
  async function stalePreview(){
    const request=++epoch;preview=null;focus=null;paintSea();renderCounts();note('Refresh preview');renderActions();
    try{const fresh=await api('/api/filter?per=24');if(!alive()||request!==epoch)return;saved=fresh;persist();paintSea();renderCounts();if(mode==='catalogue')await loadCatalogue(page);else if(mode==='review'&&current){const id=current.id,d=await api(photoUrl(id));if(alive()&&request===epoch&&current?.id===id){setCurrent(d.photos?.[0]||null);renderBody();}}if(alive())renderActions();}catch(e){if(alive()&&request===epoch)toast(e.message);}
  }
  async function learnDraft(proposal=null,submitted=null){
    const policy=copy(base),request=++epoch;
    const result=proposal&&same(base,submitted)?proposal:(await api('/api/filter/learn',{policy})).learning;
    if(!alive()||request!==epoch||!same(policy,base))return;
    learning=result;forecast=null;draft=copy(base);for(const change of learned())draft[change.key]=copy(result.policy[change.key]);persist();
  }
  async function reloadAfterCall(proposal=null,submitted=null,refresh=true){
    const fresh=await freshSummary();if(!alive())return;
    if(same(base,saved.policy)&&!learned().length)base=copy(fresh.policy);
    saved=fresh;forecast=null;preview=null;if(focus==='changed')focus=null;await learnDraft(proposal,submitted);if(!alive())return;
    paintSea();renderCounts();
    if(dirty()){busy=false;await previewDraft(refresh,true,true);}else if(refresh)await refreshVisible();
  }
  function releaseDecision(id,which){
    const it=sea?.items.get(id);if(!it||!World.lifted.has(id)||!['keep','aside'].includes(which))return;
    // Only its hidden sea copy moves; the visible print flies from the table to this new outcome.
    it.el.classList.add('lifted');it.lifted=true;it.x=sea.outcomeX(which==='keep'?1:0);
    sea.paintItem(it,true);sea.released([it]);
  }
  async function decision(which){
    if(blocked()||reviewLoading||!current||queue&&queue.pending[0]!==current.id||(which==='keep'&&!current.playable))return;thresholdHistory=[];thresholdFuture=[];redoCalls=[];clearTimeout(thresholdTimer);note('');beginWork();const id=current.id,submitted=copy(base),before=queue?copy(queue):null,row=copy(current),wasSeen=seen.has(id),tuning=['toward','away'].includes(which);
    feedback(which);Sound.play(which==='aside'?'toss':tuning?'whoop':'pick');
    try{const r=await api(tuning?'/api/filter/tune':'/api/filter/decision',tuning?{photo:id,direction:which,policy:submitted}:{photos:[id],action:which,policy:submitted});if(!alive())return;updateHudQuiet(r.game);saved.undo=r.undo;if(queue){queue.calls.push({id,action:which});seen.add(id);if(r.edited!==false)reviewCalls.push({id,action:which,undo:tuning?`filter tune ${which}`:`filter ${which}`,before,row,wasSeen});}
      // The call is already saved. A failed refresh must not offer it again or replace its undo snapshot.
      forecast=null;preview=null;if(focus==='changed')focus=null;
      // Love and Hate decide this take too (the server saved its keep or toss next to the lesson): it flies to its side
      // and the next take comes, while the lesson's preview plays out in the sea.
      await reconcile(async()=>{await reloadAfterCall(r.learning,submitted,tuning);if(!alive())return;busy=false;releaseDecision(id,which==='toward'?'keep':which==='away'?'aside':which);await nextReview(false);refreshHud(true);});}
    catch(e){if(alive())toast(e.message);}finally{await endWork();}
  }
  // Throwing prints across the line decides them: right of the divider keeps, left of it tosses. The server saves
  // one undo step; the sea's outcome flow then gives the print its new home on that side, where it already is.
  async function throwAcross(ids,which){
    if(blocked()||busy||!saved||!ids.length)return;thresholdHistory=[];thresholdFuture=[];redoCalls=[];clearTimeout(thresholdTimer);note('');beginWork();const submitted=copy(base);
    feedback(which);Sound.play(which==='aside'?'toss':'pick');
    try{const r=await api('/api/filter/decision',{photos:ids,action:which,policy:submitted});if(!alive())return;updateHudQuiet(r.game);saved.undo=r.undo;
      if(queue){queue.pending=queue.pending.filter(p=>!ids.includes(p));for(const id of ids){queue.calls.push({id,action:which});seen.add(id);}}
      forecast=null;preview=null;if(focus==='changed')focus=null;
      await reconcile(async()=>{await reloadAfterCall(r.learning,submitted,false);if(!alive())return;busy=false;refreshHud(true);});}
    catch(e){if(alive())toast(e.message);}finally{await endWork();}
  }
  function dropped(items){
    const threshold=draft.fit_threshold??.5,line=sea.outcomeX(threshold),ids=[];let which=null;
    for(const it of items){
      if(it.lifted||it.pileLifted||!Number.isFinite(it.x))continue;
      const side=it.x>line?'keep':'aside',score=sea.outcomeFlow?.scores?.[it.id];
      if(Number.isFinite(score)&&passes(score,threshold)===(side==='keep'))continue;  // it landed on the side it already had
      if(which&&which!==side)continue;which=side;ids.push(it.id);
    }
    if(ids.length)throwAcross(ids,which);
  }
  async function showThresholdHistory(){
    const step={label:'threshold'};
    HistoryHUD.present({undo:thresholdHistory.length?step:null,redo:thresholdFuture.length?step:null});
    const generation=HistoryHUD.generation;
    try{const history=await api('/api/draw/history');if(alive()&&generation===HistoryHUD.generation)HistoryHUD.present({undo:thresholdHistory.length?step:history.undo,redo:thresholdFuture.length?step:history.redo});}catch(_){}
  }
  async function action(which){
    if(which==='undo'&&(blocked()||reviewLoading)){queuedUndo=true;return;}
    if(which==='retry'&&recovery&&!work&&!initializing){const task=recovery;beginWork();try{await reconcile(task);}finally{await endWork();}return;}
    if(blocked())return;
    if(which==='finish'){
      if(forecast||!shown().counts.kept)return;
      if(dirty()&&!validPreview())await previewDraft();
      if(!alive()||blocked()||!shown().counts.kept)return;
      if(dirty()){if(!validPreview())return;await action('apply');if(!alive()||blocked()||dirty())return;}
    }
    if(which==='undo'&&thresholdHistory.length){thresholdFuture.push(draft.fit_threshold??.5);moveThreshold(thresholdHistory.pop(),false);showThresholdHistory();return;}
    if(which==='redo'&&thresholdFuture.length){thresholdHistory.push(draft.fit_threshold??.5);moveThreshold(thresholdFuture.pop(),false);showThresholdHistory();return;}
    if(which==='preview')return previewDraft();
    if(which==='review')return queue?.pending.length?openReview(queue.pending[0],true):openReview();
    if(which==='inspect')return openCatalogue('changed');
    if(which==='sea'){const gone=World.grab($('#filter-content',main));epoch++;reviewLoading=0;mode='sea';current=null;focusSea();renderBody();World.swap($('#filter-content',main),gone);renderActions();return;}
    if(which==='release'){focus=null;focusSea();renderCounts();renderActions();return;}
    if(which==='reset'){clearTimeout(thresholdTimer);thresholdHistory=[];thresholdFuture=[];forecast=null;draft=copy(saved.policy);base=copy(draft);learning=null;protectedRules.clear();preview=null;focus=null;persist();note('');paintSea();renderCounts();renderActions();return refreshVisible();}
    beginWork();
    try{
      if(which==='undo'){
        const r=await api('/api/draw/undo',{});if(!alive())return;updateHudQuiet(r.game);Sound.play('undo');saved.undo=r.undo;forecast=null;preview=null;if(focus==='changed')focus=null;
        const call=reviewCalls.at(-1);if(call&&r.undone===call.undo){reviewCalls.pop();redoCalls.push(call);queue=copy(call.before);if(!call.wasSeen)seen.delete(call.id);deferred=deferred.filter(id=>!queue.pending.includes(id));mode='review';setCurrent(call.row);renderBody();}
        await reconcile(async()=>{await reloadAfterCall(null,null,false);if(!alive())return;if(mode==='review'&&current){busy=false;await openReview(current.id,true,undefined,true);}else await refreshVisible();note('Undone');});
      }
      else if(which==='redo'){
        const r=await api('/api/draw/redo',{});if(!alive())return;updateHudQuiet(r.game);saved.undo=r.undo;forecast=null;preview=null;
        const call=redoCalls.at(-1);if(call&&r.redone===call.undo){redoCalls.pop();reviewCalls.push(call);queue=copy(call.before);mode='review';setCurrent(copy(call.row));seen.add(call.id);}
        await reconcile(async()=>{await reloadAfterCall(null,null,true);if(!alive())return;busy=false;if(call&&r.redone===call.undo)await nextReview(false);note('Redone');refreshHud(true);});
      }
      else if(which==='apply'&&validPreview()){
        const submitted=copy(draft),applied=preview,r=await api('/api/filter/apply',{token:preview.token,finish:true});if(!alive())return;updateHudQuiet(r.game);
        // Apply consumes its token. Adopt that committed policy before any fallible refresh.
        saved={...saved,policy:submitted,counts:r.counts,stage:r.stage,undo:r.undo,scores:applied.scores,ids:{...applied.ids,changed:[]}};
        thresholdHistory=[];thresholdFuture=[];forecast=null;draft=copy(submitted);base=copy(draft);learning=null;protectedRules.clear();preview=null;focus=null;persist();paintSea();renderCounts();
        await reconcile(async()=>{saved=await freshSummary();if(!alive())return;paintSea();renderCounts();await refreshVisible();note('Applied');Sound.play('crown');refreshHud(true);});
      }else if(which==='finish'){const r=await api('/api/filter/finish',{});if(!alive())return;updateHudQuiet(r.game);refreshHud(true);await stageSplash(r);if(alive())location.hash='#stacks';}
    }catch(e){if(alive()){if(e.status===409)await stalePreview();else toast(e.message);}}
    finally{await endWork();}
  }
  // Filter's reward moment: the same clear card as every stage, shown briefly on the way to Stacks.
  let splash=null;
  function stageSplash(r){
    const c=r.counts||shown().counts||{},field=$('#filter-content',main);if(!field)return Promise.resolve();
    World.release(field);mode='clear';current=null;$('.filter-stage',main).dataset.mode='clear';
    field.className='filter-content clear';field.innerHTML=stageClearHtml({icon:'🎛️',title:'Filter complete!',xp:r.game?.stage_xp?.filter||0,
      text:`${plural(c.kept||0,'take')} in play · ${fmt(c.aside||0)} set aside. Every set-aside take stays recoverable.`,summary:'Next: the stacks'});
    $('#filter-actions',main).innerHTML='';setForward(null);World.calm(true);Sound.play('crown');confetti(window.innerWidth/2,window.innerHeight/3,60);
    setHint('Stage clear! On to the stacks (Enter skips ahead).');
    return new Promise(resolve=>{const done=()=>{if(splash!==done)return;splash=null;clearTimeout(timer);resolve();};const timer=setTimeout(done,reduceMotion?400:2000);splash=done;signal.addEventListener('abort',done,{once:true});});
  }
  document.addEventListener('keydown',e=>{
    if(e.key!=='Enter'||e.target.isContentEditable||e.target.closest('dialog,textarea,select,input:not([type=range])')||$('dialog[open]'))return;
    e.preventDefault();e.stopImmediatePropagation();if(e.repeat)return;if(splash){splash();return;}action('finish');
  },{capture:true,signal});
  S.onKey=e=>{
    if(e.repeat||e.target.closest('input,select,textarea'))return;
    if(['Enter',' '].includes(e.key)&&e.target.closest('button,a,[role="button"],summary'))return;
    const key=e.key.toLowerCase();
    if(key==='z'){e.preventDefault();action('undo');}
    else if(key==='escape'){e.preventDefault();action(mode==='sea'?'release':'sea');}
    else if(mode==='review'&&['arrowleft','arrowright','arrowup','arrowdown','x',' '].includes(key)){e.preventDefault();if(key===' ')nextReview();else decision(({arrowleft:'aside',x:'aside',arrowright:'keep',arrowup:'toward',arrowdown:'away'})[key]);}
    else if(key==='enter'){e.preventDefault();action('finish');}
  };
  window.addEventListener('photo-render-change',fitReview,{signal});
  signal.addEventListener('abort',()=>{if(sea.onRelease===dropped)sea.onRelease=null;},{once:true});
  window.addEventListener('resize',positionThreshold,{signal});
  window.addEventListener('sea-camera',positionThreshold,{signal});  // the line follows the sea's pan and zoom
  main.innerHTML=LOADING('Opening the gate…');
  try{
    saved=await api('/api/filter?per=24');if(!alive())return;
    // Static files update on reload; the running Python process may still have the previous teaching engine.
    if(!(saved.teaching_revision>=2))throw Object.assign(new Error('Restart MatchER, then reload this page to update the filter. Your saved choices are kept.'),{filterUpdate:true});
    draft=copy(saved.policy);base=copy(draft);
    try{const old=JSON.parse(sessionStorage.getItem(draftKey)||'null');if(old&&typeof old==='object'&&!Array.isArray(old)){if(old.version===1&&old.policy&&old.base){if((!old.savedPolicy||same(old.savedPolicy,saved.policy))&&!same(old.policy,old.savedPolicy)){draft={...draft,...old.policy};base={...base,...old.base};learning=old.learning;protectedRules=new Set(old.protected||[]);}}else{draft={...draft,...old};base=copy(draft);}}}catch(_){}
    shell();oldCatalog=World.sea.catalog;oldLassos=World.sea.lassos_on;sea=World.live({clickToZoom:false,onSelect:it=>openReview(it.id),onDrop:()=>{},onCircle:()=>{},onLasso:()=>{}});sea.catalog=false;sea.lassos_on=false;sea.el.classList.add('filter-world');sea.dock?.classList.remove('tag-dock');sea.dock=null;sea.tray.hidden=true;
    const boundaryObserver=new ResizeObserver(positionThreshold);boundaryObserver.observe($('.filter-field',main));
    signal.addEventListener('abort',()=>{clearTimeout(feedback.timer);clearTimeout(thresholdTimer);clearTimeout(flowTimer);fitObserver?.disconnect();boundaryObserver.disconnect();sea.setOutcomeFlow(null);sea.el.classList.remove('filter-world');for(const it of sea.items.values()){delete it.el.dataset.filterResult;delete it.el.dataset.filterChange;}sea.catalog=oldCatalog;sea.lassos_on=oldLassos;sea.focusKeys.clear();sea.focusIds=null;sea.focusCluster=null;sea.applyFocus();World.stale=true;},{once:true});
    const worldReady=World.allPhotos(()=>{if(alive())paintSea();});worldReady.catch(e=>{if(alive())toast(e.message);});paintSea();await learnDraft();if(!alive())return;if(dirty())await previewDraft(true,true);
    if(mode==='review'&&!current&&!queue)await openReview(undefined,false,undefined,true);
  }catch(e){if(alive()){
    main.innerHTML=FAILED(e.message);
    if(e.filterUpdate){const message=$('.empty.error',main),text=document.createElement('span');text.textContent=e.message;message.classList.add('filter-update');message.replaceChildren(text);
      document.body.classList.add('filter-update-required');signal.addEventListener('abort',()=>document.body.classList.remove('filter-update-required'),{once:true});}
  }}
  finally{if(alive()&&$('.filter-stage',main)){initializing=false;renderActions();await drainUndo();}}
}
