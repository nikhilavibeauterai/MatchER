// The toolbelt: a pen and a marker in four inks, your own sticky notes and an eraser, for any photo on show. It sits
// on every screen but the welcome and the saves, draws over any polaroid pane (a `.print` with a photo id) and keeps
// what you draw with that shot (`/api/edit`: `marks` as strokes in card widths, `notes` as sticky notes), so it is
// there again wherever the photo appears: the Leaderboard's card, a duel pane, the Finals, the reveal.
// Cut a swept circular brush out of the polylines. Keeping the untouched pieces lets an erase be saved and undone
// like any other drawing, without deleting a whole stroke or laying opaque paint over the photo.
function eraseMarks(marks, from, to, radius) {
  const vx=to[0]-from[0],vy=to[1]-from[1],length2=vx*vx+vy*vy;
  const clip=(value,delta,lo,hi)=>{
    if(Math.abs(delta)<1e-10)return value>=lo&&value<=hi?[0,1]:null;
    const a=(lo-value)/delta,b=(hi-value)/delta;
    const start=Math.max(0,Math.min(a,b)),end=Math.min(1,Math.max(a,b));return start<=end?[start,end]:null;
  };
  const disk=(a,dx,dy,centre,r)=>{
    const x=a[0]-centre[0],y=a[1]-centre[1],A=dx*dx+dy*dy,C=x*x+y*y-r*r;
    if(A<1e-10)return C<=0?[0,1]:null;
    const B=2*(x*dx+y*dy),D=B*B-4*A*C;if(D<0)return null;
    const start=Math.max(0,(-B-Math.sqrt(D))/(2*A)),end=Math.min(1,(-B+Math.sqrt(D))/(2*A));
    return start<=end?[start,end]:null;
  };
  let changed=false;
  const result=[];
  for(const mark of marks){
    const points=mark.p,r=radius+(mark.t==='marker'?1.6:.275),pieces=[];let current=[],touched=false;
    const push=p=>{if(!current.length||Math.hypot(p[0]-current.at(-1)[0],p[1]-current.at(-1)[1])>1e-7)current.push(p);};
    const finish=()=>{if(current.length)pieces.push({...mark,p:current});current=[];};
    for(let i=0;i<Math.max(1,points.length-1);i++){
      const a=points[i],b=points[i+1]||a,dx=b[0]-a[0],dy=b[1]-a[1];
      const ranges=[disk(a,dx,dy,from,r),disk(a,dx,dy,to,r)].filter(Boolean);
      if(length2>1e-10){
        const x=a[0]-from[0],y=a[1]-from[1];
        const along=clip(x*vx+y*vy,dx*vx+dy*vy,0,length2),width=r*Math.sqrt(length2);
        const across=clip(x*vy-y*vx,dx*vy-dy*vx,-width,width);
        if(along&&across){const start=Math.max(along[0],across[0]),end=Math.min(along[1],across[1]);if(start<=end)ranges.push([start,end]);}
      }
      if(!ranges.length){push(a);push(b);continue;}
      const start=Math.min(...ranges.map(p=>p[0])),end=Math.max(...ranges.map(p=>p[1]));
      if(end-start<1e-9&&Math.hypot(dx,dy)>1e-9){push(a);push(b);continue;}
      changed=touched=true;
      if(start>1e-9){push(a);push([a[0]+dx*start,a[1]+dy*start]);}
      finish();
      if(end<1-1e-9){push([a[0]+dx*end,a[1]+dy*end]);push(b);}
    }
    finish();result.push(...(touched?pieces:[mark]));
  }
  return changed?result:marks;
}

const Toolbelt = {
  TOOLS: [["hand", "✋", "Hand: select, move or choose a photo"], ["pen", "✏️", "Pen: write or draw on a photo's card"],
    ["marker", "🖍️", "Marker: highlight on a photo's card"], ["note", "📝", "Sticky note: click a card to stick one on"], ["eraser", "🧽", "Eraser: rub across marks to erase them"]],
  INKS: { ink: "var(--ink)", coral: "var(--marker)", green: "var(--green)", gold: "var(--gold)" },
  tool: "hand", ink: "ink", radius: 2.6, edits: new Map(), loading: new Map(), listeners: new Set(), jobs: new Map(), saving: new Map(),
  // Every host of a photo's card: panes, sea prints, tiles, takes in a fan, and the wrapper cards.js gives bare pictures.
  HOSTS: ".print, .ps-item, .tile, .ftile, .polaroid, .shot-select",
  init() {
    if (this.el) return;
    this.el = document.createElement("aside");
    this.el.id = "toolbelt"; this.el.className = "toolbelt rail-card"; this.el.setAttribute("aria-label", "Toolbelt");
    document.body.append(this.el);
    this.paint();
    // A browser still sends a click after a pointer gesture. Catch it before a pane can interpret it as a vote,
    // and before a sea print can interpret a double-click or a native drag as the hand tool.
    for(const type of ['click','dblclick','dragstart'])document.addEventListener(type,e=>{
      const note=e.target.closest?.('.user-note,.photo-sticky');
      const host=e.target.closest?.(`${this.HOSTS}, .side, .swipe-card, .shot-select`);
      const control=e.target.closest?.('button,a,input,select,textarea');
      const consumed=this.clickUntil>performance.now()&&e.pointerId===this.clickPointer;
      const armed=host&&(host.dataset.belt||host.querySelector('[data-belt]'));
      if(consumed||note?.classList.contains('user-note')||note&&!control||this.tool!=='hand'&&armed&&(!control||!host.contains(control))){
        if(!note||!control)e.preventDefault();e.stopImmediatePropagation();
      }
    },true);
    document.addEventListener('pointerdown',e=>{
      this.clickUntil=0;
      if(this.tool==='hand'||e.button||e.target.closest?.('.user-note,.photo-notes-paper')||this.tool==='note'&&e.target.closest?.('.photo-sticky'))return;
      const print=e.target.closest?.(this.HOSTS);
      if(!print)return;this.arm(print);
      const control=e.target.closest?.('button,a,input,select,textarea');if(control&&print.contains(control))return;
      const svg=print.querySelector(':scope > svg.marks');
      if(svg){e.stopImmediatePropagation();this.down(e,print,svg);}
    },true);
    window.addEventListener('hashchange',()=>{this.cancel();this.cursor?.remove();this.cursor=null;});
    window.addEventListener('blur',()=>this.cancel());
    document.addEventListener('keydown',e=>{
      if(!this.gesture||e.target.closest('input,textarea,select')||!['Escape','z','Z',' ','Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','a','A','c','C','f','F'].includes(e.key))return;
      e.preventDefault();e.stopImmediatePropagation();if(e.key==='Escape'||e.key.toLowerCase()==='z')this.cancel();
    },true);
    // Panes come and go with every screen: whatever shows a photo's card is armed as it appears.
    let queued = false;
    const pending = new Set();
    this.observer = new MutationObserver(records => {
      for(const record of records){
        if(record.target.closest?.('svg.marks, .user-note, .photo-notes-paper, .photo-sticky, #toolbelt, #af-defs, #topbar, #journey-dock, #history-hud'))continue;
        const host=record.target.closest?.(this.HOSTS);
        if(host)pending.add(host);
        for(const node of record.addedNodes)if(node.nodeType===1)pending.add(node);
      }
      if(queued)return;queued=true;
      requestAnimationFrame(()=>{
        queued=false;
        const roots=new Set([...pending].filter(node=>node.isConnected));pending.clear();
        for(const root of roots){
          let parent=root.parentElement;while(parent&&!roots.has(parent))parent=parent.parentElement;
          if(!parent)this.arm(root);
        }
        for(const print of this.sized)if(!print.isConnected){this.sizes.unobserve(print);this.sized.delete(print);}
      });
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    if (typeof matchMedia === "function") matchMedia("(max-width: 900px)").addEventListener("change", () => this.paint());
    this.sizes=new ResizeObserver(entries=>{for(const {target,contentRect} of entries)target.style.setProperty('--note-unit',`${contentRect.width/100}px`);});
    this.sized=new Set();this.arm(document.body);
  },
  // On a phone the belt folds to the one tool in hand, in a corner clear of the stage; a tap opens the whole belt.
  narrow() { return typeof matchMedia === "function" && matchMedia("(max-width: 900px)").matches; },
  paint() {
    document.body.dataset.tool = this.tool;
    const folded = this.narrow() && !this.open, current = this.TOOLS.find(([t]) => t === this.tool) || this.TOOLS[0];
    this.el.classList.toggle("folded", folded);
    if (folded) {
      this.el.innerHTML = `<button class="btn ghost belt-tool belt-fold" aria-label="Toolbelt: ${current[2]}" title="Open the toolbelt">${current[1]}</button>`;
      this.el.querySelector(".belt-fold").onclick = () => { this.open = true; this.paint(); };
      return;
    }
    this.el.innerHTML = `${this.TOOLS.map(([t, icon, title]) => `<button class="btn ghost belt-tool" data-tool="${t}" aria-pressed="${this.tool === t}" title="${title}" aria-label="${title}">${icon}</button>`).join("")}
      <div class="belt-inks" ${["pen", "marker"].includes(this.tool) ? "" : "hidden"}>${Object.keys(this.INKS).map((c) => `<button class="belt-ink" data-ink="${c}" aria-pressed="${this.ink === c}" style="--ink-colour:${this.INKS[c]}" aria-label="${c} ink" title="${c}"></button>`).join("")}</div>`;
    if(this.tool==='eraser')this.el.insertAdjacentHTML('beforeend',`<label class="belt-size"><span>Size</span><input type="range" min="1" max="7" step="0.2" value="${this.radius}" aria-label="Eraser size"></label>`);
    $$("[data-tool]", this.el).forEach((b) => (b.onclick = () => { this.cancel();this.cursor?.remove();this.cursor=null;this.tool = b.dataset.tool; if (this.narrow() && !["pen", "marker", "eraser"].includes(this.tool)) this.open = false; this.paint(); }));
    $$("[data-ink]", this.el).forEach((b) => (b.onclick = () => { this.ink = b.dataset.ink; this.open = false; this.paint(); }));
    const size=this.el.querySelector('.belt-size input');if(size)size.oninput=()=>{this.radius=Number(size.value);};
  },
  // The photo a pane shows: its own id, the nearest photo element's, or the picture's address.
  pidOf(print) {
    const own = Number(print.dataset.photo || print.dataset.dragFrame);
    if (own) return own;
    const img = print.querySelector(".pile-cover, img:not(.under)");  // a stack's cover, not a take peeking out under it
    return Number(/\/img\/[pt]\/(\d+)\.jpg/.exec(img?.getAttribute("src") || "")?.[1]) || Number(print.closest('[data-photo]')?.dataset.photo) || null;
  },
  // Tell the belt what a shot's edits are (a view that already has them), or let it fetch them.
  know(pid, edits) {
    this.syncSource();
    this.edits.set(pid, edits || {});
    if(typeof AutoLook!=='undefined')AutoLook.repaint(pid);
    this.render(pid);
    for (const fn of this.listeners) fn(pid, this.current(pid));
  },
  syncSource() {
    const source=typeof S==='undefined'?'':S.lib?.source||'';
    if(this.source===source)return;
    clearTimeout(this.loadTimer);this.loadTimer=0;
    for(const job of this.loadQueue?.values()||[])job.resolve();this.loadQueue=new Map();
    this.cancel();this.source=source;this.edits.clear();this.loading.clear();this.jobs.clear();this.saving.clear();this.draft=null;
    if(source&&typeof HistoryHUD!=='undefined'){
      HistoryHUD.photoEdit=null;const generation=HistoryHUD.generation;
      api('/api/history?stage=home').then(history=>{if(source===this.source&&generation===HistoryHUD.generation)HistoryHUD.photoEdit=history.undo?.label==='edit';}).catch(()=>{});
    }
  },
  current(pid) {
    let edits=this.edits.get(pid)||{};
    for(const job of this.jobs.get(pid)||[])edits={...edits,...(typeof job==='function'?job(edits):job)};
    return edits;
  },
  load(pid) {
    this.syncSource();
    if(this.edits.has(pid))return Promise.resolve();if(this.loading.has(pid))return this.loading.get(pid);
    let resolve;const promise=new Promise(done=>resolve=done);this.loading.set(pid,promise);
    this.loadQueue||=new Map();this.loadQueue.set(pid,{resolve,promise});
    if(!this.loadTimer)this.loadTimer=setTimeout(()=>this.loadBatch(),16);
    return promise;
  },
  async loadBatch() {
    this.loadTimer=0;const source=this.source,batch=[...this.loadQueue].slice(0,120);
    for(const [pid]of batch)this.loadQueue.delete(pid);
    if(this.loadQueue.size)this.loadTimer=setTimeout(()=>this.loadBatch(),16);
    try{
      const data=await api(`/api/edits?photos=${batch.map(([pid])=>pid).join(',')}`).catch(async error=>{
        // A running server can predate freshly reloaded static files. Its saved drawings must still load.
        if(error.status!==404)throw error;
        const reads=await Promise.allSettled(batch.map(([pid])=>api(`/api/edit?photo=${pid}`)));
        return {photos:reads.filter(read=>read.status==='fulfilled').map(read=>read.value)};
      });this.syncSource();
      if(source===this.source)for(const {photo,edits}of data.photos)if(!this.edits.has(photo))this.know(photo,edits||{});
    }catch(_){/* A missing or unplugged library tries again when its cards return. */}
    finally{for(const [pid,job]of batch){if(this.loading.get(pid)===job.promise)this.loading.delete(pid);job.resolve();}}
  },
  save(pid, change) {
    this.syncSource();
    const source=this.source,jobs=this.jobs.get(pid)||[];jobs.push(change);this.jobs.set(pid,jobs);this.render(pid);
    if(this.saving.has(pid))return this.saving.get(pid);
    const task=(async()=>{
      let failed=false;
      await this.loading.get(pid);
      this.syncSource();
      while(jobs.length&&source===this.source){
        const job=jobs[0];
        try{
          const patch=typeof job==='function'?job(this.edits.get(pid)||{}):job;
          const r=await api('/api/edit',{photo:pid,...patch});
          this.syncSource();
          if(source!==this.source)return;
          jobs.shift();this.know(pid,r.edits||{});
          if(typeof refreshHud==='function')refreshHud(true);
        }catch(e){if(source!==this.source)return;failed=true;jobs.shift();this.render(pid);toast(e.message);}
      }
      return !failed;
    })();
    this.saving.set(pid,task);
    task.finally(()=>{if(this.saving.get(pid)===task){this.saving.delete(pid);this.jobs.delete(pid);}});
    return task;
  },
  async flush() {
    await Promise.all([...this.saving.values()]);
  },
  arm(root) {
    this.syncSource();
    const prints = [...(root.matches?.(this.HOSTS) ? [root] : []), ...(root.querySelectorAll?.(this.HOSTS) || [])];
    for (const print of prints) {
      // Flights, the analysis show (its library is not open yet) and a card without its picture yet are not armed; a
      // card the sea rebuilt (its marks went with its old picture) is armed again.
      if (print.classList.contains("world-fly") || print.closest(".an-grab, #an-sea, .world-fly, #topbar, #journey-dock, #history-hud, #toolbelt") || !print.querySelector("img")) continue;
      if(print.matches('.shot-select')&&!print.closest('.tile.open'))continue;
      // ResizeObserver supplies the initial width before paint; reading clientWidth here forced a layout per card.
      if(this.sizes&&!this.sized.has(print)){this.sized.add(print);this.sizes.observe(print);}
      if (print.dataset.belt && print.querySelector(":scope > svg.marks")) continue;
      const pid = this.pidOf(print);
      if (!pid) continue;
      print.dataset.belt = pid;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "marks"); svg.setAttribute("viewBox", "0 0 100 133.333"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
      print.append(svg);
      svg.addEventListener('pointermove',e=>this.showCursor(e,svg));
      svg.addEventListener('pointerleave',()=>{if(!this.gesture){this.cursor?.remove();this.cursor=null;}});
      if (this.edits.has(pid)) this.render(pid,[print]); else this.load(pid);
    }
  },
  // Draw what a shot carries on every armed pane that shows it.
  render(pid, prints = $$(`[data-belt="${pid}"]`)) {
    const e = this.current(pid);
    for (const print of prints) {
      const svg = print.querySelector(":scope > svg.marks");
      if (svg) this.renderMarks(svg,this.gesture?.print===print?this.gesture.marks:e.marks||[]);
      // A saved stroke arriving while someone types must not replace their textarea or move its caret.
      if(print.querySelector('.user-note:focus-within'))continue;
      print.querySelectorAll(":scope > .user-note").forEach((n) => n.remove());
      const notes=[...(e.notes||[])];if(this.draft?.print===print)notes.push(this.draft.note);
      notes.forEach((n, i) => {
        const note = document.createElement("div");
        note.className = "meta sticky user-note"; note.dataset.noteIndex = i;
        note.style.cssText = `--note-x:${n.x};--note-y:${n.y};--note-turn:${((i * 37) % 11) - 5}deg`;
        note.innerHTML = `<textarea class="note-text" rows="3" maxlength="400" placeholder="write…" aria-label="Your note">${esc(n.text || "")}</textarea>`;
        print.append(note);
        for(const type of ['pointerdown','pointerup','click','dblclick'])note.addEventListener(type,event=>event.stopPropagation());
        const text = note.querySelector("textarea");
        this.dragNote(note, print, (x, y) => {
          if(this.draft?.print===print&&i===(e.notes||[]).length){this.draft.note.x=x;this.draft.note.y=y;}
          else this.save(pid,old=>({notes:(old.notes||[]).map((o,j)=>j===i?{...o,x,y}:o)}));
        });
        text.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Escape") text.blur(); };
        text.onblur = () => {
          const words=text.value.trim(),draft=this.draft?.print===print&&i===(e.notes||[]).length;
          if(draft){this.draft=null;if(words)this.save(pid,old=>({notes:[...(old.notes||[]),{...n,text:words}]}));else note.remove();}
          else if(words!==(n.text||''))this.save(pid,old=>({notes:(old.notes||[]).map((o,j)=>j===i?{...o,text:words}:o).filter(o=>o.text)}));
        };
        if(this.draft?.print===print&&i===(e.notes||[]).length)text.focus();
      });
    }
  },
  renderMarks(svg,marks) {
    svg.querySelectorAll('polyline').forEach(line=>line.remove());
    svg.insertAdjacentHTML('afterbegin',marks.map((m,i)=>`<polyline data-stroke="${i}" points="${(m.p.length===1?[m.p[0],m.p[0]]:m.p).map(([x,y])=>`${x},${y}`).join(' ')}" stroke="${this.INKS[m.c]||this.INKS.ink}" stroke-width="${m.t==='marker'?3.2:.55}" opacity="${m.t==='marker'?.45:1}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join(''));
  },
  point(e,svg) {
    const matrix=svg.getScreenCTM();if(!matrix)return [0,0];
    const point=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());
    return [point.x,point.y].map(v=>Math.round(v*10)/10);
  },
  showCursor(e,svg) {
    if(this.tool!=='eraser')return;
    if(this.cursor?.parentElement!==svg){this.cursor?.remove();this.cursor=document.createElementNS('http://www.w3.org/2000/svg','circle');this.cursor.setAttribute('class','eraser-cursor');svg.append(this.cursor);}
    const [x,y]=this.point(e,svg);this.cursor.setAttribute('cx',x);this.cursor.setAttribute('cy',y);this.cursor.setAttribute('r',this.radius);
  },
  cancel() {this.gesture?.end(false);},
  // A pen or marker saves on lifting; an eraser gesture saves its local cuts together, and the note waits for words.
  down(e, print, svg) {
    const pid = Number(print.dataset.belt), edits = this.current(pid);
    if (e.button || !["pen", "marker", "eraser", "note"].includes(this.tool)) return;
    e.preventDefault(); e.stopPropagation();
    if(this.gesture)return;
    if(print.matches('.ps-item')&&typeof World!=='undefined'&&World.sea?.el.contains(print)){
      const item=World.sea.items.get(Number(print.dataset.id));if(item)World.sea.hold(item.stack);
    }
    this.clickPointer=e.pointerId;this.clickUntil=performance.now()+1500;
    if (this.tool === "note") {
      const [x,y]=this.point(e,svg);document.activeElement?.blur();
      this.draft={pid,print,note:{x,y,text:''}};this.render(pid);return;
    }
    const tool=this.tool,stroke={t:tool,c:this.ink,p:[this.point(e,svg)]},original=edits.marks||[];
    const gesture={print,marks:tool==='eraser'?eraseMarks(original,stroke.p[0],stroke.p[0],this.radius):[...original,stroke]};
    print.classList.add('is-marking');
    const move=ev=>{
      if(ev.pointerId!==e.pointerId)return;ev.preventDefault();ev.stopPropagation();
      const p=this.point(ev,svg),last=stroke.p.at(-1);
      if(tool==='eraser'){gesture.marks=eraseMarks(gesture.marks,last,p,this.radius);stroke.p=[p];}
      else if(Math.hypot(p[0]-last[0],p[1]-last[1])>=.2&&stroke.p.length<600)stroke.p.push(p);
      this.renderMarks(svg,gesture.marks);this.showCursor(ev,svg);
    };
    const end=commit=>{
      if(this.gesture!==gesture)return;
      this.gesture=null;print.classList.remove('is-marking');this.clickUntil=performance.now()+1500;
      svg.removeEventListener('pointermove',move);svg.removeEventListener('pointerup',up);svg.removeEventListener('pointercancel',cancel);svg.removeEventListener('lostpointercapture',cancel);
      if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);
      if(commit&&(tool!=='eraser'||gesture.marks!==original))this.save(pid,tool==='eraser'?{marks:gesture.marks}:old=>({marks:[...(old.marks||[]),stroke]}));
      else this.render(pid);
    };
    const up=ev=>{if(ev.pointerId!==e.pointerId)return;move(ev);ev.stopPropagation();end(true);};
    const cancel=ev=>{if(ev.pointerId===e.pointerId){ev.stopPropagation();end(false);}};
    gesture.end=end;this.gesture=gesture;this.renderMarks(svg,gesture.marks);svg.setPointerCapture(e.pointerId);
    svg.addEventListener('pointermove',move);svg.addEventListener('pointerup',up);svg.addEventListener('pointercancel',cancel);svg.addEventListener('lostpointercapture',cancel);
  },
  // Your note drags like the sorter's, within the viewport; where it lands is kept with the shot.
  dragNote(note, print, onDrop) {
    note.addEventListener("pointerdown", (e) => {
      if (e.button || e.target.closest("button, a, input, textarea") || !["hand", "note"].includes(this.tool)) return;
      e.preventDefault(); e.stopPropagation();
      const unit = print.getBoundingClientRect().width / 100, x0 = Number(note.style.getPropertyValue("--note-x")) || 0, y0 = Number(note.style.getPropertyValue("--note-y")) || 0, start = [e.clientX, e.clientY];
      let pos = [x0, y0];
      note.setPointerCapture(e.pointerId); note.classList.add("dragging");
      const move = (ev) => {
        const r = print.getBoundingClientRect(), n = note.getBoundingClientRect(), w = n.width, h = n.height;
        const leftPx = Math.max(4, Math.min(innerWidth - w - 4, r.left + x0 * unit + ev.clientX - start[0])), topPx = Math.max(4, Math.min(innerHeight - h - 4, r.top + y0 * unit + ev.clientY - start[1]));
        pos = [(leftPx - r.left) / unit, (topPx - r.top) / unit];
        note.style.setProperty("--note-x", pos[0].toFixed(1)); note.style.setProperty("--note-y", pos[1].toFixed(1));
      };
      const up = () => {
        note.removeEventListener("pointermove", move); note.removeEventListener("pointerup", up); note.removeEventListener("pointercancel", up);
        note.classList.remove("dragging");
        if (Math.hypot(pos[0] - x0, pos[1] - y0) >= 0.5) onDrop(Math.round(pos[0] * 10) / 10, Math.round(pos[1] * 10) / 10);
      };
      note.addEventListener("pointermove", move); note.addEventListener("pointerup", up); note.addEventListener("pointercancel", up);
    });
  },
};
if (typeof document !== "undefined" && document.body) Toolbelt.init();
if (typeof module !== "undefined") module.exports = { Toolbelt, eraseMarks };
