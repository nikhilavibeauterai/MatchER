// Stacks is an arrangement of the world, with the same paper, camera, notes and image pyramid.
const StackLayout={
  arrange(shots,width,height,open=null){
    const n=shots.length,top=.23,bottom=.10,left=.055,right=.055,W=width*(1-left-right),H=height*(1-top-bottom);
    let columns=1,best=-1;
    for(let c=1;c<=Math.max(1,Math.ceil(Math.sqrt(n*W/H*1.55))+3);c++){
      const rows=Math.max(1,Math.ceil(n/c)),size=Math.min(132,W/c*.73,H/rows*.57),score=size*(1-.5*(c*rows-n)/Math.max(1,c*rows));
      if(score>best){best=score;columns=c;}
    }
    const rows=Math.max(1,Math.ceil(n/columns)),cw=W/columns,ch=H/rows,
      size=Math.min(132,cw*.73,ch*.57),homes=shots.map((shot,i)=>({id:shot.rep,x:left+(i%columns+.5)*cw/width,y:top+(Math.floor(i/columns)+.5)*ch/height,size:size/Math.min(width,height)}));
    if(open){
      const base=homes.find(p=>p.id===open.rep);if(base){
        const cols=Math.min(5,Math.max(1,Math.ceil(Math.sqrt(open.members.length*1.25)))),rows=Math.ceil(open.members.length/cols),
          paper=Math.min(160,Math.max(size*1.7,80),W/(cols*1.26),H/(rows*1.63)),dx=paper*1.27,dy=paper*1.64,
          fw=cols*dx,fh=rows*dy,cx=Math.max(width*left+fw/2,Math.min(width*(1-right)-fw/2,base.x*width)),
          cy=Math.max(height*top+fh/2,Math.min(height*(1-bottom)-fh/2,base.y*height));
        for(const [i,id]of open.members.entries()){
          const p={id,x:(cx+(i%cols-(cols-1)/2)*dx)/width,y:(cy+(Math.floor(i/cols)-(rows-1)/2)*dy)/height,size:paper/Math.min(width,height)};
          const old=homes.findIndex(p=>p.id===id);if(old>=0)homes[old]=p;else homes.push(p);
        }
      }
    }
    return homes;
  }
};

async function stacksPage(main){
  const view=S.view,signal=S.events.signal;
  let shots=[],dates=[],pairs=[],open=null,selected=null,epoch=0,busy=false;
  let order='look',stacksOnly=false;
  try{order=localStorage.getItem('matcher-stacks-order')==='time'?'time':'look';stacksOnly=localStorage.getItem('matcher-stacks-only')==='1';}catch(_){/* private mode */}
  const sea=World.live({onSelect:it=>{choose(it.id);sea.zoomToPrint(it);},onFocus:it=>choose(it.id),onStack:it=>fan(it.id),onDrop:drop,
    onCircle:null,onLasso:null,onSelectMatches:null});
  sea.catalogSuppressed=true;
  World.stackStage={view,refresh:()=>load(true),close:()=>{
    sea.arrangement=null;sea.onFocus=null;sea.focusKeys.clear();sea.focusCluster=null;sea.focusIds=null;
    for(const it of sea.items.values()){it.hidden=false;it.el.classList.remove('stack-fan-take');}
    sea.el.classList.remove('stack-field','stack-fan-open');sea.el.removeAttribute('data-stack-count');sea.el.removeAttribute('data-stack-fan');
  }};
  sea.el.classList.add('stack-field');
  main.innerHTML=`<div class="stacker stack-stage"><div class="stack-toolbar" aria-label="Stack arrangement">
    <span class="stack-census" role="status"><b data-stack-total>…</b> <span data-stack-word>shots</span></span>
    <span class="seg" role="group" aria-label="Stack order"><button class="seg-btn" data-stack-order="look">Similar</button><button class="seg-btn" data-stack-order="time">By date</button></span>
    <button class="chip" data-stacks-only>Stacks only</button><button class="btn ghost" data-stack-overview title="See every shot" aria-label="See every shot">Overview</button>
    <div class="stack-dates"></div>
    ${helpBtn('These are the same prints as the sea, arranged for stacking. Wheel or pinch to zoom, drag open water to pan. Click a print to bring it closer; drag one onto another to combine them. A paperclip opens its takes here. Right-click a photo for its notes. X sets the selected stack aside; Z undoes.')} </div>
    <section class="stack-tools" aria-label="Selected stack" hidden></section>
    <div class="stack-bottom"><span data-stack-hint>Gathering your shots…</span><a class="btn ghost" data-twins href="#stacks?check=1" hidden></a></div>
    <div class="stack-empty" hidden></div></div>`;
  const controls=$('.stack-tools',main),visible=()=>shots.filter(s=>!stacksOnly||s.members.length>1);
  setHint('Drag prints together; a paperclip opens the takes.');
  const setting=(key,value)=>{try{localStorage.setItem(key,value);}catch(_){/* private mode */}};
  $('[data-stacks-only]',main).onclick=()=>{stacksOnly=!stacksOnly;setting('matcher-stacks-only',stacksOnly?'1':'0');if(open&&!visible().some(s=>s.rep===open.rep))open=null;arrange();paint();};
  for(const b of $$('[data-stack-order]',main))b.onclick=()=>{if(order===b.dataset.stackOrder)return;order=b.dataset.stackOrder;setting('matcher-stacks-order',order);load(true,true);};
  $('[data-stack-overview]',main).onclick=()=>{open=null;selected=null;arrange();paint();sea.resetCamera();};
  controls.onclick=e=>{
    const b=e.target.closest('[data-stack-action]');if(!b||busy)return;
    const shot=open||shots.find(s=>s.members.includes(selected));if(!shot)return;
    const action=b.dataset.stackAction;
    if(action==='close'){open=null;selected=null;arrange();paint();sea.resetCamera();}
    else if(action==='open')fan(shot.rep);
    else if(action==='keep')act('/api/frame',{photo:selected},'That take now stands in for the stack.');
    else if(action==='split')act('/api/groups/split',{photo:selected},'Split out into its own shot.');
    else if(action==='unstack')act('/api/groups/unstack',{photo:shot.rep},'Split into separate shots.');
    else if(action==='aside')act('/api/filter/decision',{photos:shot.members,action:'aside'},'Set aside with every take.');
  };
  sea.el.addEventListener('click',e=>{if(e.target.closest('.ps-item,.vn-tag,.vn-lasso-tag,.vn-tray')||sea.pan?.moved||performance.now()-(sea.pannedAt||0)<180)return;
    if(selected||open){open=null;selected=null;arrange();paint();sea.resetCamera();}
  },{signal});
  window.addEventListener('resize',()=>{if(!left(view))arrange();},{signal});
  let dateTimer;
  window.addEventListener('sea-camera',e=>{
    if(e.detail.sea!==sea||left(view))return;
    $('.stack-stage',main).classList.toggle('stack-closeup',(sea.largestStackPaper||0)*e.detail.zoom*4/3>sea.height*.6);
    if(order!=='time')return;clearTimeout(dateTimer);dateTimer=setTimeout(dateNow,150);
  },{signal});
  signal.addEventListener('abort',()=>clearTimeout(dateTimer),{once:true});
  S.onKey=e=>{
    if(e.repeat)return;
    if(e.key==='Escape'&&(selected||open)){e.preventDefault();open=null;selected=null;arrange();paint();sea.resetCamera();}
    else if(e.key.toLowerCase()==='x'&&selected){const shot=shots.find(s=>s.members.includes(selected));if(shot){e.preventDefault();act('/api/filter/decision',{photos:shot.members,action:'aside'},'Set aside with every take.');}}
    else if(['ArrowLeft','ArrowRight'].includes(e.key)&&open){e.preventDefault();const i=open.members.indexOf(selected),step=e.key==='ArrowLeft'?-1:1;choose(open.members[(i+step+open.members.length)%open.members.length]);}
    else if(e.key==='Backspace'){e.preventDefault();drawUndo(()=>load(true));}
  };
  S.historyActions={undo:()=>drawUndo(()=>load(true)),redo:async()=>{await api('/api/draw/redo',{});if(!left(view))await load(true);}};
  function choose(id){selected=id;sea.select([id]);paint();}
  function fan(id){
    const shot=shots.find(s=>s.members.includes(id));if(!shot||shot.members.length<2)return;
    if(open?.rep===shot.rep){open=null;selected=shot.rep;arrange();paint();return;}
    open=shot;selected=shot.rep;arrange();paint();
    // The camera follows the existing pile into a fan; its takes retain their own physical card elements.
    setTimeout(()=>{if(!left(view)&&open===shot)fitFan();},240);
  }
  function fitFan(){
    const homes=sea.arrangement?.filter(p=>open?.members.includes(p.id));if(!homes?.length)return;
    const W=sea.width,H=sea.height,unit=Math.min(W,H),x0=Math.min(...homes.map(p=>p.x*W-p.size*unit*.7)),x1=Math.max(...homes.map(p=>p.x*W+p.size*unit*.7)),
      y0=Math.min(...homes.map(p=>p.y*H-p.size*unit*.85)),y1=Math.max(...homes.map(p=>p.y*H+p.size*unit*.85)),z=Math.max(1,Math.min(5,W*.82/(x1-x0),H*.57/(y1-y0)));
    sea.glideCamera({zoom:z,tx:W/2-(x0+x1)/2*z,ty:H*.52-(y0+y1)/2*z});
  }
  function arrange(){
    if(left(view))return;
    const rows=visible(),allowed=new Set(rows.flatMap(s=>s.members)),cover=new Map(),fanIds=new Set(open?.members||[]);
    for(const s of shots)for(const id of s.members)cover.set(id,s);
    sea.arrangement=StackLayout.arrange(rows,sea.el.clientWidth,sea.el.clientHeight,open);
    sea.largestStackPaper=Math.max(0,...sea.arrangement.map(p=>p.size*Math.min(sea.el.clientWidth,sea.el.clientHeight)));
    const items=World.extras([]);
    for(const it of items){
      const shot=cover.get(it.id);it.hidden=!allowed.has(it.id);
      if(shot){it.rep=fanIds.has(it.id)?it.id:shot.rep;it.take=it.rep!==it.id;it.n=it.id===shot.rep?shot.members.length:1;it.members=it.id===shot.rep?shot.members:[it.id];}
      if(fanIds.has(it.id))it.badge=it.id===open.rep?'Cover':`Take ${open.members.indexOf(it.id)+1}`;
    }
    sea.setVenn([],items,[]);
    sea.catalogSuppressed=true;sea.tray.hidden=true;
    for(const it of sea.items.values()){it.el.classList.toggle('stack-fan-take',fanIds.has(it.id));const clip=it.el.querySelector('.stack-clip');clip?.setAttribute('aria-expanded',String(open?.rep===it.id));}
    sea.el.classList.toggle('stack-fan-open',!!open);sea.el.dataset.stackFan=open?.rep||'';sea.el.dataset.stackCount=rows.length;
    sea.focusIds=fanIds.size?fanIds:null;sea.focusPrimary=fanIds;sea.highlight(fanIds.size?fanIds:null);sea.scheduleCull(true);sea.kick();
  }
  function paint(){
    if(left(view))return;
    $('[data-stack-total]',main).textContent=fmt(visible().length);$('[data-stack-word]',main).textContent=stacksOnly?'stacks':'shots';
    for(const b of $$('[data-stack-order]',main)){b.classList.toggle('on',b.dataset.stackOrder===order);b.setAttribute('aria-pressed',String(b.dataset.stackOrder===order));}
    $('[data-stacks-only]',main).classList.toggle('on',stacksOnly);$('[data-stacks-only]',main).setAttribute('aria-pressed',String(stacksOnly));
    const shot=open||shots.find(s=>s.members.includes(selected));controls.hidden=!shot;
    if(shot)controls.innerHTML=`<span>${open?`Open stack · ${plural(shot.members.length,'take')}`:shot.members.length>1?plural(shot.members.length,'take'):'Loose photo'}</span>
      ${!open&&shot.members.length>1?'<button class="btn" data-stack-action="open">Open stack</button>':''}
      ${open?`${selected!==shot.rep?'<button class="btn primary" data-stack-action="keep">Use this take</button>':''}${shot.crownable!==false?`<a class="btn crown-btn" href="#duel?stack=${shot.rep}">👑 Crown this stack</a>`:''}<button class="btn ghost" data-stack-action="split">Split this take</button><button class="btn ghost" data-stack-action="unstack">Split all</button>`:''}
      <button class="btn ghost danger" data-stack-action="aside">Set aside <kbd>X</kbd></button><button class="btn ghost" data-stack-action="close" aria-label="Close selection">×</button>`;
    const twins=$('[data-twins]',main);twins.hidden=!pairs.length;twins.textContent=`Twin check · ${fmt(pairs.length)} pairs →`;
    $('[data-stack-hint]',main).textContent=open?'Click a take to inspect it. Drag it onto another stack to move it.':`${plural(shots.filter(s=>s.members.length>1).length,'stack')} · ${plural(shots.filter(s=>s.members.length===1).length,'loose photo')}`;
    const empty=$('.stack-empty',main);empty.hidden=!!visible().length;empty.textContent=stacksOnly?'No stacks yet. Turn off Stacks only to combine loose photos.':'No eligible shots yet. Return to Filter to bring some in.';
    setForward({label:'Next: Crown →',name:'Crown',href:'#duel?stage=stacks'});
    dateControls();
  }
  function dateControls(){
    const host=$('.stack-dates',main);if(order!=='time'||!dates.length){host.replaceChildren();delete host.dataset.dates;return;}
    const signature=JSON.stringify(dates.map(d=>d.date));if(host.dataset.dates===signature)return;host.dataset.dates=signature;
    host.innerHTML=`<div class="date-jump" role="group" aria-label="Browse dates"><button class="btn ghost" data-date-step="-1" aria-label="Previous date">‹</button><label><span>Jump to</span><select data-date-jump aria-label="Jump to date">${dates.map(d=>`<option value="${d.date}">${esc(dateWord(d.date))} · ${fmt(d.count)}</option>`).join('')}</select></label><button class="btn ghost" data-date-step="1" aria-label="Next date">›</button></div>`;
    const select=$('select',host);select.onchange=()=>jump(select.value);
    for(const b of $$('[data-date-step]',host))b.onclick=()=>{const i=dates.findIndex(d=>d.date===select.value)+Number(b.dataset.dateStep);if(dates[i]){select.value=dates[i].date;jump(select.value);}};
  }
  function jump(day){
    if(open){open=null;arrange();paint();}
    const shot=visible().find(s=>shotDate(s)===day),p=sea.arrangement?.find(p=>p.id===shot?.rep);if(!p)return;
    const z=Math.max(1,Math.min(12,Math.max(sea.camera.zoom,90/(p.size*Math.min(sea.width,sea.height)))));
    sea.glideCamera({zoom:z,tx:sea.width*.5-p.x*sea.width*z,ty:sea.height*.46-p.y*sea.height*z});
  }
  function dateNow(){
    const select=$('[data-date-jump]',main);if(!select||document.activeElement===select||open)return;
    const [x,y]=sea.toWorld(sea.width*.5,sea.height*.46),near=visible().map(s=>({s,it:sea.items.get(s.rep)})).filter(x=>x.it)
      .sort((a,b)=>Math.hypot(a.it.x-x,a.it.y-y)-Math.hypot(b.it.x-x,b.it.y-y))[0];if(near)select.value=shotDate(near.s);
  }
  async function drop(ids,target){
    if(target.kind!=='photo'||busy)return;
    const source=ids.length===1&&open?.members.includes(ids[0])&&ids[0]!==open.rep;
    await act(source?'/api/groups/move':'/api/groups/merge',source?{photo:ids[0],target:target.id}:{photos:[...ids,target.id]},source?'Moved into that stack.':'Combined into one stack.');
  }
  async function act(path,body,message){
    if(busy)return;busy=true;try{await api(path,body);if(left(view))return;await load(true);toastOnce(message,`${message} Z undoes it.`);refreshHud(true);Sound.play('pick');}
    catch(e){if(!left(view))toast(e.message);}finally{busy=false;}
  }
  async function load(refresh=false,reorder=false){
    const token=++epoch,old=open;
    try{
      const query=`/api/groups?view=all&order=${order}&per=500`,[first,suggest]=await Promise.all([api(`${query}&page=0&dates=1${reorder?'&reorder=1':''}`),api('/api/groups?view=suggest')]);
      if(left(view)||token!==epoch)return;
      const batches=[first];for(let page=1;page<first.pages;page++){batches.push(await api(`${query}&page=${page}`));if(left(view)||token!==epoch)return;}
      if(!refresh||World.photoSource!==S.lib?.source)await World.allPhotos();if(left(view)||token!==epoch)return;
      const previous=new Set(shots.flatMap(s=>s.members));shots=batches.flatMap(b=>b.shots);dates=first.dates||[];pairs=suggest.suggestions;
      const present=new Set(shots.flatMap(s=>s.members));
      for(const id of previous)if(!present.has(id)){const p=World.photos.get(id);if(p)p.cut=true;}
      for(const shot of shots)for(const id of shot.members){const p=World.photos.get(id);if(p){p.rep=shot.rep;p.members=id===shot.rep?shot.members:[id];p.cut=false;}}
      open=old&&shots.find(s=>s.members.length>1&&s.members.some(id=>old.members.includes(id)))||null;
      if(selected&&!shots.some(s=>s.members.includes(selected)))selected=null;
      arrange();paint();World.last=performance.now();
    }catch(e){if(!left(view)&&token===epoch){$('[data-stack-hint]',main).textContent=e.message;toast(e.message);}}
  }
  await load();
}
if(typeof module!=='undefined')module.exports={StackLayout};
