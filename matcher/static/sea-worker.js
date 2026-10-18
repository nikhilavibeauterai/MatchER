// The swarm and its tag clustering run away from the UI thread. Thumbnails never enter this worker.
const contourField = typeof module !== 'undefined' ? require('./sea-contours.js').seaContours : (importScripts('/static/sea-contours.js'), seaContours);
const tuningDefaults = typeof module !== 'undefined' ? require('./sea-tuning.js').seaTuningDefaults : (importScripts('/static/sea-tuning.js'), seaTuningDefaults);
const seaHash = (s) => { let h=2166136261; for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0; };
const seaSimilarity = (a,b) => {
  if(!a.length||!b.length)return 0;
  let i=0,j=0,shared=0;
  while(i<a.length&&j<b.length){if(a[i]===b[j]){shared++;i++;j++;}else if(a[i]<b[j])i++;else j++;}
  return shared/Math.sqrt(a.length*b.length);
};
// A softened inverse square force has a finite reach and a contact buffer. Partial tag overlap blends the forces.
const seaForce = (similarity,distance,buffer,reach) => {
  if(distance>=reach)return 0;
  if(distance<buffer)return -.8*(1-distance/buffer);
  const fade=(1-(distance/reach)**2)**2;
  return fade*buffer*buffer/(distance*distance+buffer*buffer*.25)*(similarity-.5);
};
// The same measurements always describe the same neighbourhood, regardless of tags or library size.
const seaVisualHome = (visual,width,height,id) => {
  const colour=Number.isFinite(visual?.colorfulness)?visual.colorfulness:visual?.saturation;
  if(!Number.isFinite(colour)||!Number.isFinite(visual?.brightness))return null;
  const clamp=v=>Math.max(0,Math.min(1,v)),phase=seaHash(id)*.0001;
  // A fixed curve gives ordinary camera colours space; per-library quantiles would move every home on import.
  return {x:width*(.08+.84*Math.sqrt(clamp(colour))+Math.cos(phase)*.025),
    y:height*(.92-.84*clamp(visual.brightness)+Math.sin(phase)*.025)};
};
const seaOutcomeX = (score,width) => width*(.08+.84*Math.max(0,Math.min(1,score)));
// The host resends every print's visual summary with each layout; only a different one is a change.
const seaSameVisual=(a,b)=>(!a&&!b)||(!!a&&!!b&&a.colorfulness===b.colorfulness&&a.saturation===b.saturation&&a.brightness===b.brightness);
class SeaField {
  constructor(){this.items=[];this.byId=new Map();this.steering=new Map();this.frame=0;this.clusterAt=-Infinity;this.contourAt=-Infinity;this.T=tuningDefaults();}
  // Live tuning from the developer panel: homes and forces read the current values on every step.
  tune(values){Object.assign(this.T,values||{});this.tuningKey=JSON.stringify(values||{});this.visualHomes();this.wake('tune');}
  // Settled means nothing moved for a while and nothing is held, dragged or pinned anew: the field then sleeps
  // until the next change wakes it, so prints only move when something about them changed.
  wake(reason='change'){this.calmFrames=0;this.settled=false;for(const it of this.items){it.age=0;it.shoved=0;}this.note(`wake:${reason}`);}
  // Physics applies to what is on screen: the host sends the camera's view (sea coordinates) and prints outside it,
  // plus a margin of two prints, hold still and cost nothing. What comes into view is woken so it settles in.
  setView(rect){
    const old=this.view,pad=this.viewPad||60;this.view=rect;
    if(!rect)return;
    const inside=(it,r)=>!r||(it.x>=r.x0-pad&&it.x<=r.x1+pad&&it.y>=r.y0-pad&&it.y<=r.y1+pad);
    // A rested sea stays at rest as the camera moves over it: only a sea still settling wakes what comes into view
    // (at a deep zoom a sub-pixel settle would be a visible shake).
    if(!this.settled)for(const it of this.items)if(inside(it,rect)&&!inside(it,old))this.wakeItem(it);
  }
  // A short log of what woke the field, for the developer panel and the suites' probes.
  note(what){(this.log||=[]).push([this.frame||0,what]);if(this.log.length>60)this.log.shift();}
  // A local wake restarts one print's clock; its neighbours follow only through contact.
  wakeItem(it){if(!it)return;it.age=0;it.shoved=0;this.calmFrames=0;this.settled=false;this.note(`wakeItem:${it.id}`);}
  set(message){
    this.generation=message.generation;this.marginEff=message.margin;
    // The host resends its bodies whenever its layout runs. Only a real change (prints, water, focus, tuning or
    // calm) may wake a resting sea; an identical resend leaves every print asleep where it is.
    let changed=this.calm!==!!message.calm;this.calm=!!message.calm;
    const tuningKey=message.tuning?JSON.stringify(message.tuning):'';
    if(tuningKey!==this.tuningKey){this.tuningKey=tuningKey;changed=true;if(message.tuning)Object.assign(this.T,message.tuning);}
    if(this.resize(message,false))changed=true;
    const old=this.byId;this.byId=new Map();const vocabulary=new Map(),touched=new Set();let semanticChange=old.size!==message.items.length;
    this.items=message.items.map(x=>{
      const previous=old.get(x.id), it={...x,fresh:!previous,cluster:previous?.cluster,x:previous?.x??x.x,y:previous?.y??x.y,vx:previous?.vx||0,vy:previous?.vy||0,age:previous?.age||0,heat:previous?.heat||0,push:previous?.push||0,shoved:previous?.shoved||0,home:previous?.home,placed:previous?.placed};
      // New arrivals shrink the common footprint slightly. That creates room without waking the whole sea.
      if(!previous||x.baseSize>previous.baseSize+.5||previous.label!==x.label||!seaSameVisual(previous.visual,x.visual))touched.add(it.id);
      // Only a saved, numeric group is a deliberate team. Categories, set-aside and automatic shores are not.
      it.assignedGroup=typeof x.label==='string'&&/^g\d+$/.test(x.label)?x.label:null;
      it.tags=[...new Set(x.tags)].sort();
      if(!previous||it.tags.length!==previous.tags.length||it.tags.some((tag,i)=>tag!==previous.tags[i])){semanticChange=true;touched.add(it.id);}
      it.vector=it.tags.map(t=>{if(!vocabulary.has(t))vocabulary.set(t,vocabulary.size);return vocabulary.get(t);}).sort((a,b)=>a-b);
      this.byId.set(it.id,it);return it;
    });
    // A moving panel or Filter outcome changes the water, not the meaning of every photo.
    this.clusterDirty||=semanticChange;this.membershipDirty=true;
    const focusKey=JSON.stringify(message.focus||{});if(focusKey!==this.focusKey){this.focusKey=focusKey;changed=true;}
    const homesMoved=this.visualHomes();
    if(changed||!this.calm){if(homesMoved||semanticChange||changed)this.wake(homesMoved?'homes':semanticChange?'tags':'set');}
    else for(const it of this.items){
      const was=old.get(it.id)?.home,now=it.home;
      // Streaming a tag must not restart every resting photo's cooling clock. Only changed prints and homes wake;
      // nearby contacts make room through the ordinary local shove.
      if(touched.has(it.id)||!!was!==!!now||was&&now&&(Math.abs(was.x-now.x)>.5||Math.abs(was.y-now.y)>.5))this.wakeItem(it);
    }
    // A calm sea shows the macro order at once: a new print starts at its home and only its neighbours adjust it.
    if(this.calm)for(const it of this.items)if(it.fresh&&it.home){it.x=it.home.x;it.y=it.home.y;it.vx=it.vy=0;}
    this.focus(message.focus||{},false);
  }
  spaceLimit(water){return Math.max(1,...water.map(r=>Math.min(r.x1-r.x0,r.y1-r.y0)/1.5));}
  resize({width,height,water,obstacles},wake=true){  // returns whether the canvas, water or obstacles changed
    const nextWater=water||[{x0:0,y0:0,x1:width,y1:height}],nextObstacles=obstacles||[];
    const key=`${width}x${height}|${JSON.stringify(nextWater)}|${JSON.stringify(nextObstacles)}`;
    if(key===this.boundsKey)return false;this.boundsKey=key;
    // Preserve the flock's spread across a viewport change, instead of clamping every old position to one edge.
    if(this.width&&this.height&&(this.width!==width||this.height!==height))for(const it of this.items){it.x*=width/this.width;it.y*=height/this.height;}
    this.width=width;this.height=height;this.water=nextWater;this.obstacles=nextObstacles;this.waterLimit=this.spaceLimit(this.water);
    if(wake){this.visualHomes();this.wake('resize');}
    return true;
  }
  // The macro order spreads the library across the whole canvas: colourfulness by rank left to right, brightness
  // by rank bottom to top. A mostly muted library then fills the width instead of piling into one half.
  ranks(key){
    const sorted=this.items.filter(it=>Number.isFinite(key(it))).sort((a,b)=>key(a)-key(b)),q=new Map(),n=sorted.length;
    for(let i=0;i<n;i++){let j=i;while(j+1<n&&key(sorted[j+1])===key(sorted[i]))j++;const value=n>1?((i+j)/2)/(n-1):.5;for(let k=i;k<=j;k++)q.set(sorted[k].id,value);i=j;}
    return q;
  }
  visualHomes(){  // returns whether any home moved, so a caller wakes the sea only for a real change
    const T=this.T,colourOf=it=>Number.isFinite(it.visual?.colorfulness)?it.visual.colorfulness:it.visual?.saturation,brightOf=it=>it.visual?.brightness;
    const spread=Math.max(0,Math.min(1,T.spread)),qx=spread?this.ranks(colourOf):null,qy=spread?this.ranks(brightOf):null,m=this.marginEff??T.margin,span=1-2*m;
    const clamp=v=>Math.max(0,Math.min(1,v)),before=this.items.map(it=>it.home);
    for(const it of this.items){
      let target=seaVisualHome(it.visual,this.width,this.height,it.id);
      if(target){
        // Blend the absolute curves (a known colour always lands in the same place) with the library's rank order.
        const phase=seaHash(it.id)*.0001,cx=clamp(Math.sqrt(clamp(colourOf(it)))),cy=clamp(brightOf(it));
        const ux=qx?.has(it.id)?spread*qx.get(it.id)+(1-spread)*cx:cx,uy=qy?.has(it.id)?spread*qy.get(it.id)+(1-spread)*cy:cy;
        target={x:this.width*(m+span*ux+Math.cos(phase)*T.jitter),y:this.height*(1-m-span*uy+Math.sin(phase)*T.jitter)};
      }
      const score=this.outcomeScores?.get(it.id),scored=Number.isFinite(score);
      it.outcomeBank=0;
      const light=Number.isFinite(it.visual?.brightness)?Math.max(0,Math.min(1,it.visual.brightness)):.5,restY=target?.y??this.height*(.92-.84*light+Math.sin(seaHash(it.id)*.0001)*.025);
      if(scored){
        // Fit replaces colour only while filtering. Brightness and the familiar vertical geography remain.
        target={x:seaOutcomeX(score,this.width),y:restY};
      }else{
        // A forecast without scores still sends every take to its shore: a soft home, not a current.
        const bank=this.outcomeSide?.get(it.id);if(bank)target={x:this.width*(bank<0?.32:.68),y:restY};
      }
      it.home=target;
      it.visualPoint=target?{x:target.x/this.width,y:target.y/this.height}:null;
      if(!target)continue;
      const margin=Math.min(it.baseSize*.8+12,this.waterLimit*.7),side=scored?(score>0&&(score>=1||score>=this.outcomeThreshold)?1:-1):0;
      const divider=seaOutcomeX(this.outcomeThreshold??.5,this.width);let best=null,bank=null;
      // A panel borrows space from the map. Choose nearby open water once per layout, never every frame.
      for(const r of this.water){
        if(r.x1-r.x0<margin*2||r.y1-r.y0<margin*2)continue;
        const x=Math.max(r.x0+margin,Math.min(r.x1-margin,target.x)),y=Math.max(r.y0+margin,Math.min(r.y1-margin,target.y)),d=(x-target.x)**2+(y-target.y)**2;
        if(!best||d<best.d)best={x,y,d};
        if(side){
          const x0=Math.max(r.x0+margin,side>0?divider:0),x1=Math.min(r.x1-margin,side<0?divider:this.width);
          if(x0>x1)continue;
          const bx=Math.max(x0,Math.min(x1,target.x)),bd=(bx-target.x)**2+(y-target.y)**2;
          if(!bank||bd<bank.d)bank={x:bx,y,d:bd};
        }
      }
      // Prefer the correct side of the threshold, even when a centre panel is its nearest obstruction.
      if(bank){best=bank;it.outcomeBank=side;}
      if(best)it.home={x:best.x,y:best.y};
      if(it.placed&&!scored)it.home={...it.placed};  // placed by hand: the geography is only a default
    }
    return this.items.some((it,i)=>{const was=before[i],now=it.home;return !!was!==!!now||!!(was&&now&&(Math.abs(was.x-now.x)>.5||Math.abs(was.y-now.y)>.5));});
  }
  outcomes(flow){
    // A forecast changes soft destinations, never the photos' positions or momentum.
    this.outcomeSide=new Map();
    for(const id of flow?.aside||[])this.outcomeSide.set(id,-1);
    for(const id of flow?.kept||[])this.outcomeSide.set(id,1);
    this.outcomeScores=new Map();
    for(const [id,score] of flow?.scores instanceof Map?flow.scores:Object.entries(flow?.scores||{}))
      if(Number.isFinite(score))this.outcomeScores.set(Number(id),Math.max(0,Math.min(1,score)));
    this.outcomeThreshold=Number.isFinite(flow?.threshold)?Math.max(0,Math.min(1,flow.threshold)):.5;
    this.visualHomes();this.wake('outcomes');
  }
  focusRegion(){
    // Panels split the water into strips. Join their shared open space before choosing the working area.
    const edges=[...new Set(this.water.flatMap(r=>[r.x0,r.x1]))].sort((a,b)=>a-b);let best=null;
    for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++){
      const x0=edges[i],x1=edges[j],spans=this.water.filter(r=>r.x0<=x0&&r.x1>=x1).sort((a,b)=>a.y0-b.y0);
      let y0=0,y1=-Infinity;
      const save=()=>{const area=(x1-x0)*(y1-y0);if(!best||area>best.area)best={x0,x1,y0,y1,area};};
      for(const r of spans){if(r.y0>y1){if(y1>-Infinity)save();y0=r.y0;y1=r.y1;}else y1=Math.max(y1,r.y1);}if(y1>-Infinity)save();
    }
    return best;
  }
  focus(focus,wake=true){
    if(wake)this.wake('focus');
    this.filter=focus;const keys=focus.keys||[], ids=new Set(focus.ids||[]), active=keys.length||focus.cluster||ids.size;
    const hits=this.items.filter(it=>active&&(ids.size?ids.has(it.id):focus.cluster?it.cluster===focus.cluster:focus.any?keys.some(t=>it.tags.includes(t)):keys.every(t=>it.tags.includes(t))));
    this.focusCount=hits.length;
    this.focusZone=null;this.focusWater=this.water;
    this.ambientLimit=this.waterLimit;
    for(const it of this.items){it.anchor=null;it.size=active?it.baseSize*.65:it.baseSize;}
    if(!hits.length)return;
    const region=this.focusRegion();
    if(!region)return;
    const w=region.x1-region.x0,h=region.y1-region.y0,area=w*h;
    const big=hits.slice(0,Math.min(12,hits.length)), small=hits.slice(big.length);
    let size=Math.max(4,Math.min(220,Math.sqrt(area*.34/Math.max(1,big.length))/1.5));const r=Math.min(w,h)*.38;
    const anchors=big.map((it,j)=>{const a=j*2.399963,rad=big.length===1?0:Math.sqrt((j+.5)/big.length)*r;return [Math.cos(a)*rad,Math.sin(a)*rad];});
    for(const [x,y]of anchors)size=Math.min(size,Math.max(4,Math.min(w/2-Math.abs(x)-8,h/2-Math.abs(y)-8)/.72));
    for(let i=0;i<anchors.length;i++)for(let j=0;j<i;j++)size=Math.min(size,Math.max(Math.abs(anchors[i][0]-anchors[j][0]),Math.abs(anchors[i][1]-anchors[j][1]))*.8);
    for(let i=0;i<hits.length;i++){
      const it=hits[i],large=i<big.length,n=large?big.length:small.length,j=large?i:i-big.length;
      const a=j*2.399963, radius=large?Math.sqrt((j+.5)/Math.max(1,n))*r:r+Math.sqrt((j+.5)/Math.max(1,n))*Math.min(w,h)*.09;
      it.size=large?size:Math.min(size*.35,it.baseSize*1.4,Math.sqrt(area*.17/Math.max(1,small.length))/1.5);
      it.anchor={x:(region.x0+region.x1)/2+(large?anchors[i][0]:Math.cos(a)*radius),y:(region.y0+region.y1)/2+(large?anchors[i][1]:Math.sin(a)*radius)};
    }
    if(big.length){
      const o={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
      for(const it of big){o.x0=Math.min(o.x0,it.anchor.x-it.size*.7-16);o.y0=Math.min(o.y0,it.anchor.y-it.size*.7-16);o.x1=Math.max(o.x1,it.anchor.x+it.size*.7+16);o.y1=Math.max(o.y1,it.anchor.y+it.size*.7+16);}
      this.focusZone=o;this.focusWater=[];
      for(const r of this.water){const x0=Math.max(r.x0,o.x0),y0=Math.max(r.y0,o.y0),x1=Math.min(r.x1,o.x1),y1=Math.min(r.y1,o.y1);if(x0>=x1||y0>=y1){this.focusWater.push(r);continue;}if(y0>r.y0)this.focusWater.push({...r,y1:y0});if(y1<r.y1)this.focusWater.push({...r,y0:y1});if(x0>r.x0)this.focusWater.push({x0:r.x0,x1:x0,y0,y1});if(x1<r.x1)this.focusWater.push({x0:x1,x1:r.x1,y0,y1});}
      this.ambientLimit=this.spaceLimit(this.focusWater);
    }
  }
  // Sampled spherical k-means uses equal-weight sparse tag vectors. Position only breaks close semantic ties.
  cluster(){
    const before=new Map(this.items.map(it=>[it.id,it.cluster]));  // a re-cluster only wakes prints whose cluster moved
    const tagged=this.items.filter(it=>it.tags.length), sample=[];
    const stride=Math.max(1,tagged.length/384);
    for(let i=0;i<tagged.length;i+=stride)sample.push(tagged[Math.floor(i)]);
    const centers=[], maximum=Math.min(18,Math.max(2,Math.ceil(Math.sqrt(tagged.length))));
    const center=it=>({vector:new Map(it.tags.map(t=>[t,1/Math.sqrt(it.tags.length)])),x:it.x,y:it.y});
    const semanticDistance=(it,c)=>{
      let dot=0;for(const t of it.tags)dot+=c.vector.get(t)||0;
      return 1-dot/Math.sqrt(it.tags.length);
    };
    const distance=(it,c)=>semanticDistance(it,c)+.04*(((it.x-c.x)/this.width)**2+((it.y-c.y)/this.height)**2);
    // Geography can split a semantic tie, but cannot invent two meanings for the same tag vector.
    const signatures=sample.map(it=>JSON.stringify(it.tags)),seeded=new Set();
    if(sample.length){centers.push(center(sample[0]));seeded.add(signatures[0]);}
    const nearestSeed=new Float64Array(sample.length);nearestSeed.fill(Infinity);
    while(centers.length<maximum){
      let far=-1,furthest=.18;
      for(let i=0;i<sample.length;i++){const it=sample[i],d=nearestSeed[i]=Math.min(nearestSeed[i],semanticDistance(it,centers[centers.length-1]));if(!seeded.has(signatures[i])&&d>furthest){far=i;furthest=d;}}
      if(far<0)break;centers.push(center(sample[far]));seeded.add(signatures[far]);
    }
    const nearest=it=>{let at=0,best=Infinity;centers.forEach((c,i)=>{const d=distance(it,c);if(d<best){best=d;at=i;}});return at;};
    for(let pass=0;pass<4&&centers.length;pass++){
      const sums=centers.map(()=>({vector:new Map(),x:0,y:0,n:0}));
      for(const it of sample){const c=sums[nearest(it)],scale=1/Math.sqrt(it.tags.length);c.x+=it.x;c.y+=it.y;c.n++;for(const t of it.tags)c.vector.set(t,(c.vector.get(t)||0)+scale);}
      sums.forEach((c,i)=>{if(!c.n)return;const norm=Math.hypot(...c.vector.values());for(const [t,v]of c.vector)c.vector.set(t,v/norm);c.x/=c.n;c.y/=c.n;centers[i]=c;});
    }
    const groups=centers.map(()=>({counts:new Map(),ids:[]}));
    for(const it of this.items){it.cluster=null;if(!it.tags.length||!centers.length)continue;const c=groups[nearest(it)];c.ids.push(it.id);for(const t of it.tags)c.counts.set(t,(c.counts.get(t)||0)+1);}
    const totals=new Map();for(const c of groups)for(const [t,n]of c.counts)totals.set(t,(totals.get(t)||0)+n);
    const suggestions=new Map();
    for(const c of groups){
      if(!c.ids.length)continue;
      const score=([t,n])=>n/c.ids.length-(totals.get(t)||0)/Math.max(1,tagged.length);
      // A useful name describes most of its members and distinguishes them from the rest of the sea.
      const tags=[...c.counts].filter(([t,n])=>n>=3&&n/c.ids.length>=.6&&score([t,n])>.1)
        .sort((a,b)=>score(b)-score(a)||b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,3).map(([t])=>t);
      if(!tags.length)continue;
      const signature=JSON.stringify([...tags].sort());let suggestion=suggestions.get(signature);
      if(!suggestion){suggestion={id:`a${seaHash(signature)}`,tags,count:0};suggestions.set(signature,suggestion);}
      for(const id of c.ids)this.byId.get(id).cluster=suggestion.id;
      suggestion.count+=c.ids.length;
    }
    const result=[...suggestions.values()];
    this.clusters=result;this.focus(this.filter||{},false);
    for(const it of this.items)if(before.get(it.id)!==it.cluster)this.wakeItem(it);
    return result;
  }
  index(cell){
    this.cell=cell;this.cols=Math.max(1,Math.ceil(this.width/cell));this.rows=Math.max(1,Math.ceil(this.height/cell));
    const n=this.cols*this.rows;if(this.heads?.length!==n)this.heads=new Int32Array(n);this.heads.fill(-1);
    if(this.links?.length!==this.items.length)this.links=new Int32Array(this.items.length);
    const start=this.frame%Math.max(1,this.items.length);
    for(let k=0;k<this.items.length;k++){const i=(start+k)%this.items.length,it=this.items[i];const x=Math.max(0,Math.min(this.cols-1,Math.floor(it.x/cell))),y=Math.max(0,Math.min(this.rows-1,Math.floor(it.y/cell)));const at=y*this.cols+x;this.links[i]=this.heads[at];this.heads[at]=i;}
  }
  neighbours(it,limit,visit){
    const cx=Math.floor(it.x/this.cell),cy=Math.floor(it.y/this.cell);
    for(let y=Math.max(0,cy-1);y<=Math.min(this.rows-1,cy+1);y++)for(let x=Math.max(0,cx-1);x<=Math.min(this.cols-1,cx+1);x++){
      let checked=0;for(let j=this.heads[y*this.cols+x];j>=0&&checked<limit;j=this.links[j],checked++)if(this.items[j]!==it)visit(this.items[j],j);
    }
  }
  place(it){
    if(it.fixed)return;it.size=Math.min(it.size,it.anchor?this.waterLimit:this.ambientLimit);const margin=it.size*.72;
    it.x=Math.max(margin,Math.min(this.width-margin,it.x));it.y=Math.max(margin,Math.min(this.height-margin,it.y));
    const focus=this.focusZone,insideFocus=!it.anchor&&focus&&it.x>focus.x0-margin&&it.x<focus.x1+margin&&it.y>focus.y0-margin&&it.y<focus.y1+margin;
    if(!insideFocus&&!this.obstacles.some(o=>it.x>o.x0-margin&&it.x<o.x1+margin&&it.y>o.y0-margin&&it.y<o.y1+margin))return;
    let best=null;
    for(const r of it.anchor?this.water:this.focusWater){if(r.x1-r.x0<margin*2||r.y1-r.y0<margin*2)continue;const x=Math.max(r.x0+margin,Math.min(r.x1-margin,it.x)),y=Math.max(r.y0+margin,Math.min(r.y1-margin,it.y)),d=(x-it.x)**2+(y-it.y)**2;if(!best||d<best.d)best={x,y,d};}
    if(best){it.x=best.x;it.y=best.y;it.vx*=.5;it.vy*=.5;}
  }
  avoid(it) {
    // Steer before contact. Projecting into open rectangles alone traps a flock in straight lines along panels.
    const margin=it.size*.72,reach=Math.max(16,Math.min(48,it.size*1.8));
    const x=it.x+it.vx*6,y=it.y+it.vy*6;
    let ax=0,ay=0;
    for(const o of this.barriers){
      const x0=o.x0-margin,x1=o.x1+margin,y0=o.y0-margin,y1=o.y1+margin;
      if(x<x0-reach||x>x1+reach||y<y0-reach||y>y1+reach)continue;
      let dx=x-Math.max(x0,Math.min(x1,x)),dy=y-Math.max(y0,Math.min(y1,y)),d=Math.hypot(dx,dy);
      if(d<.01){
        const side=Math.min(x-x0,x1-x,y-y0,y1-y);
        if(side===x-x0){dx=-1;dy=0;}else if(side===x1-x){dx=1;dy=0;}else if(side===y-y0){dx=0;dy=-1;}else{dx=0;dy=1;}d=1;
      }
      if(d<reach){const f=1.8*(1-d/reach)**2;ax+=dx/d*f;ay+=dy/d*f;}
    }
    return [ax,ay];
  }
  // Physics advances in frames. A slow host (a busy main thread, a throttled tab) sends its steps late, so a
  // message two or more frames late is split into sub-steps of about one frame, up to six, and the sea settles
  // in the same wall time. Ordinary jitter stays one step, so alternating intervals still integrate exactly.
  // Sub-steps spend at most ~60% of the host's interval, so a worker that is itself the slow part (ten thousand
  // prints) never adds sub-steps that make its next message later still.
  step(message){
    const started=performance.now(),elapsed=this.last==null?16.67:Math.max(0,message.time-this.last);
    const n=elapsed<33.3?1:Math.max(1,Math.min(6,Math.floor(elapsed/16.67),Math.floor(elapsed*.6/Math.max(.5,this.subMs||1))));
    const from=this.last??message.time-16.67;
    for(let k=1;k<=n;k++){const at=performance.now();this.substep({...message,time:from+elapsed*k/n});this.subMs=performance.now()-at;}
    this.ms=performance.now()-started;
  }
  substep({time,pins=[],held,lifted=[],dragged=[]}){
    const start=performance.now(),dt=this.last==null?1:Math.min(6,Math.max(0,(time-this.last)/16.67));this.last=time;this.frame++;
    const liftedIds=new Set(lifted),draggedIds=new Set(dragged),frozen=new Set(liftedIds);if(held!=null)frozen.add(held);
    // A new hold, pin, drag or lift is a change worth moving for; the same ones frame after frame are not.
    const stateKey=`${held}|${pins.map(p=>`${p.id}:${Math.round(p.x)}:${Math.round(p.y)}`).join(',')}|${dragged.join(',')}|${lifted.join(',')}`;
    if(stateKey!==this.stateKey){
      // The prints concerned (and the ones just released) wake; their neighbours follow through contact.
      this.stateKey=stateKey;const touched=new Set([held,...pins.map(p=>p.id),...dragged,...lifted].filter(id=>id!=null));
      // Where you put a print is where it stays: a print that just left your hand keeps its drop point as its home.
      const moving=new Set([...dragged,...pins.map(p=>p.id)]);
      for(const id of this.moving||[])if(!moving.has(id)){const it=this.byId.get(id);if(it&&!it.lifted){it.placed={x:it.x,y:it.y};it.home={x:it.x,y:it.y};}}
      this.moving=moving;
      for(const id of new Set([...touched,...(this.touched||[])]))this.wakeItem(this.byId.get(id));this.touched=touched;
    }
    if(this.settled){this.ms=0;return;}
    for(const it of this.items){it.px=it.x;it.py=it.y;}
    this.barriers=this.focusZone?[...this.obstacles,this.focusZone]:this.obstacles;
    for(const p of pins){const it=this.byId.get(p.id);if(it){it.x=p.x;it.y=p.y;frozen.add(it.id);}}
    // Steering belongs to the photo, so a tag refresh neither resets its momentum nor keeps deleted photos alive.
    if(this.motionItems!==this.items){for(const id of this.steering.keys())if(!this.byId.has(id))this.steering.delete(id);this.motionItems=this.items;}
    let maxSize=8;
    const view=this.view,pad=this.viewPad||60;
    for(const it of this.items){
      it.fixed=frozen.has(it.id);it.lifted=liftedIds.has(it.id);it.dragged=draggedIds.has(it.id);maxSize=Math.max(maxSize,it.size);
      it.off=!!view&&!it.fixed&&!it.anchor&&(it.x<view.x0-pad||it.x>view.x1+pad||it.y<view.y0-pad||it.y>view.y1+pad);
      let motion=this.steering.get(it.id);if(!motion){motion={ax:0,ay:0,at:time-dt*16.67,phase:seaHash(it.id)%628/100};this.steering.set(it.id,motion);}it.motion=motion;
    }
    this.viewPad=maxSize*2;
    const T=this.T,reach=Math.max(T.reachMin,Math.min(T.reachMax,maxSize*T.reachFactor));this.index(reach);
    const motionCoefficients=new Map(),drag=this.calm?T.calmDrag:T.drag;
    // A calm field cools print by print: full dynamics for a grace period after a print's own wake, then its
    // forces and corrections fade. A disturbance resolves locally while the rest of the sea sleeps on.
    const heatOf=it=>{const age=it.age||0;return this.calm?(age<T.settleGrace?1:Math.max(0,1-(age-T.settleGrace)/Math.max(1,T.coolFrames))):1;};
    let anyHeat=false;
    for(const it of this.items){
      const motion=it.motion;
      // Held, pinned, lifted and gathered prints stay hot: whatever they touch moves out of their way in full.
      if(it.fixed){it.age=0;it.heat=1;anyHeat=true;it.vx=it.vy=motion.ax=motion.ay=0;motion.at=time;continue;}
      if(it.off){it.heat=0;it.vx=it.vy=motion.ax=motion.ay=0;motion.at=time;continue;}  // off screen: holds still
      if(it.anchor){it.age=0;it.heat=1;anyHeat=true;
        const step=Math.min(6,Math.max(0,(time-motion.at)/16.67)),blend=1-Math.pow(.84,step);motion.at=time;motion.ax=motion.ay=0;
        const dx=(it.anchor.x-it.x)*blend,dy=(it.anchor.y-it.y)*blend;
        it.vx=step?dx/step:0;it.vy=step?dy/step:0;it.x+=dx;it.y+=dy;this.place(it);continue;
      }
      const heat=it.heat=heatOf(it);it.age=(it.age||0)+dt;
      if(!heat){it.vx=it.vy=motion.ax=motion.ay=0;motion.at=time;continue;}
      anyHeat=true;
      const rate=this.items.length>1000&&it.size<8?2:1;
      if(rate===2&&(it.id+this.frame)%2)continue;
      // Tiny photos skip work, not elapsed time. Uneven worker replies must not alternate their acceleration.
      const step=Math.min(6,Math.max(0,(time-motion.at)/16.67));motion.at=time;if(!step)continue;
      const a=time/14000+motion.phase;
      const avoidance=this.avoid(it);
      // Affinity acts between neighbours. Global tag centres collapse broad tags like Faces behind a spotlight.
      // The macro order is the visual geography (home); boid rules act only between neighbours. A calm field
      // adds no wander, so a print's home and its neighbours decide where it rests.
      const wander=this.calm?T.wander:.025;
      let ax=Math.cos(a)*wander+avoidance[0],ay=Math.sin(a)*wander+avoidance[1];
      if(it.home){
        const dx=it.home.x-it.x,dy=it.home.y-it.y,d=Math.hypot(dx,dy),strength=Math.min(T.homeMax,d*T.homeRate);
        if(d>1){ax+=dx/d*strength;ay+=dy/d*strength;}
      }
      if(it.outcomeBank){
        // The divider is a soft current, not a wall: focus, hover and a moving threshold never snap a photo.
        const side=it.outcomeBank,edge=seaOutcomeX(this.outcomeThreshold,this.width)+side*(it.size*.65+6),distance=(edge-it.x)*side;
        if(distance>0)ax+=side*Math.min(T.bankMax,distance*T.bankRate);
      }
      const side=this.outcomeSide?.get(it.id);
      if(side&&!it.home){
        // Legacy forecasts without scores still get a directional current for unmeasured photos.
        // Broad shores leave room for semantic flocks and contact spacing, instead of attracting to a point.
        const edge=this.width*(side<0?.32:.68),distance=(edge-it.x)*side;
        if(distance>0)ax+=side*.09*Math.min(1,distance/Math.max(1,this.width*.2));
      }
      let vx=0,vy=0,weight=0,urgent=Math.hypot(avoidance[0],avoidance[1])>.05;
      this.neighbours(it,4,other=>{
        let dx=other.x-it.x,dy=other.y-it.y,square=dx*dx+dy*dy;if(square>=reach*reach)return;let d=Math.sqrt(square);
        if(d<.1){const a=(it.id-other.id)*2.399963;dx=Math.cos(a);dy=Math.sin(a);d=1;}
        const similarity=seaSimilarity(it.vector,other.vector),same=it.assignedGroup!=null&&it.assignedGroup===other.assignedGroup;
        const separate=it.assignedGroup!=null&&other.assignedGroup!=null&&!same;
        // Your grouping is an additional local preference, even when its members have unlike tags. The same
        // force still repels inside the print buffer and disappears beyond reach; no group has a fixed home.
        const affinity=similarity+(same?T.groupCohesion:separate?-T.groupSeparation:0),alignment=same?1:separate?0:similarity;
        const buffer=(it.size+other.size)*T.buffer;let f=seaForce(affinity,d,buffer,reach)*(d<buffer?T.repel/.8:T.affinity);
        // A broad shared tag must not drag opposite corners of the colour map into one clump.
        if(f>0&&it.visualPoint&&other.visualPoint){const a=it.visualPoint,b=other.visualPoint;f/=1+T.geoDamping*((a.x-b.x)**2+(a.y-b.y)**2);}
        if(d<buffer)urgent=true;
        ax+=dx/d*f;ay+=dy/d*f;vx+=other.vx*alignment;vy+=other.vy*alignment;weight+=alignment;
      });
      if(weight){ax+=(vx/weight-it.vx)*T.align;ay+=(vy/weight-it.vy)*T.align;}
      const margin=it.size;
      if(it.x<margin*2||it.x>this.width-margin*2||it.y<margin*2||it.y>this.height-margin*2)urgent=true;
      if(it.x<margin*2)ax+=(margin*2-it.x)*.02;if(it.x>this.width-margin*2)ax-=(it.x-this.width+margin*2)*.02;
      if(it.y<margin*2)ay+=(margin*2-it.y)*.02;if(it.y>this.height-margin*2)ay-=(it.y-this.height+margin*2)*.02;
      // Ease steering into velocity, like a weighted brush. Integrate both exponential responses over real time;
      // a changing neighbour sample can bend the path, but cannot kick it into a new direction in one frame.
      const force=Math.hypot(ax,ay),limit=urgent?T.urgentLimit:T.forceLimit;if(force>limit){ax*=limit/force;ay*=limit/force;}
      // Far from home a print hurries: extra pull past the limiter, sized so it reaches the hurry speed against the
      // drag; near home the pull fades and the ordinary cap and limiter take over (`hurry` 0 turns it off).
      if(it.home&&T.hurry){const hx=it.home.x-it.x,hy=it.home.y-it.y,hd=Math.hypot(hx,hy),want=Math.min(8,hd*T.hurry);if(hd>1&&want>T.speedCap){ax+=hx/hd*want*drag;ay+=hy/hd*want*drag;}}
      ax*=heat;ay*=heat;if(heat<1){it.vx*=heat;it.vy*=heat;}
      // Most bodies share one of two elapsed steps. Reuse their exact coefficients instead of repeating exponentials.
      let row=motionCoefficients.get(step),coefficients=row?.[urgent?1:0];
      if(!coefficients){
        const smooth=urgent?.4:.16,fade=-Math.expm1(-drag*step),ease=-Math.expm1(-smooth*step),travel=fade/drag;
        coefficients={fade,ease,travel,coupling:(fade-ease)/(drag-smooth),accelTravel:(ease/smooth-travel)/(drag-smooth)};
        if(!row&&motionCoefficients.size<16){row=[];motionCoefficients.set(step,row);}if(row)row[urgent?1:0]=coefficients;
      }
      const {fade,ease,travel,coupling,accelTravel}=coefficients;
      let dx=it.vx*travel+ax/drag*(step-travel)+(motion.ax-ax)*accelTravel;
      let dy=it.vy*travel+ay/drag*(step-travel)+(motion.ay-ay)*accelTravel;
      it.vx=it.vx*(1-fade)+ax*travel+(motion.ax-ax)*coupling;
      it.vy=it.vy*(1-fade)+ay*travel+(motion.ay-ay)*coupling;
      motion.ax+=(ax-motion.ax)*ease;motion.ay+=(ay-motion.ay)*ease;
      // A print creeps near its home but may hurry while it is far from it (a Filter bank, a new geography).
      const cap=Math.max(T.speedCap,Math.min(8,(it.home?Math.hypot(it.home.x-it.x,it.home.y-it.y):0)*(T.hurry||0)));
      const speed=Math.hypot(it.vx,it.vy);if(speed>cap){it.vx*=cap/speed;it.vy*=cap/speed;}
      const distance=Math.hypot(dx,dy);if(distance>cap*step){dx*=cap*step/distance;dy*=cap*step/distance;}
      it.x+=dx;it.y+=dy;this.place(it);
    }
    // Resolve rectangular prints after the soft forces; no lattice or assigned territories are involved.
    // A sleeping print moves only when pushed. A push carries its pusher's strength on for a few frames, so a
    // shove loses two thirds of its strength at every print it passes and fades, while nothing else in the sea wakes.
    let anyPush=false;for(const it of this.items){it.push=(it.push||0)*.7;if(it.push<.05)it.push=0;else anyPush=true;}
    let passes=this.items.length<400?4:1;
    for(let pass=0;pass<passes;pass++){
      this.index(maxSize*1.65);
      this.items.forEach((it,i)=>{if(this.items.length>1000&&it.size<8&&(it.id+this.frame)%2)return;this.neighbours(it,this.items.length>1000?4:8,(other,j)=>{
        const fixed=it.fixed||!!it.anchor||it.off,otherFixed=other.fixed||!!other.anchor||other.off;
        // A print in your hand floats over the others; its neighbours make room when you let go of it.
        if(j>=i||fixed&&otherFixed||it.dragged||other.dragged)return;const gap=(it.size+other.size)*T.gap;
        let dx=it.x-other.x,dy=it.y-other.y,square=dx*dx+dy*dy;if(square>=gap*gap)return;
        if(square<.001){const angle=(it.id-other.id)*2.399963;dx=Math.cos(angle)*.01;dy=Math.sin(angle)*.01;square=.0001;}
        // Awake prints resolve their contacts in full, so a rested sea holds no latent overlaps. A shove into
        // sleeping prints loses half its strength at every print it passes through, so it stays in the neighbourhood.
        const hi=it.heat>0?1:it.push||0,ho=other.heat>0?1:other.push||0,strength=Math.max(hi,ho);if(!strength)return;
        const d=Math.sqrt(square),amount=(gap-d+.05)*strength,first=fixed?0:otherFixed?1:.5,second=otherFixed?0:fixed?1:.5;
        let a=amount*first,b=amount*second;
        // A resting print gives way only a little (`yield` of its size) to a print dropped on it; the rest overlaps.
        if(a&&!it.heat){const room=Math.max(0,it.size*(T.yield??.3)-(it.shoved||0));a=Math.min(a,room);it.shoved=(it.shoved||0)+a;}
        if(b&&!other.heat){const room=Math.max(0,other.size*(T.yield??.3)-(other.shoved||0));b=Math.min(b,room);other.shoved=(other.shoved||0)+b;}
        it.x+=dx/d*a;it.y+=dy/d*a;other.x-=dx/d*b;other.y-=dy/d*b;
        if(a>.2&&hi<ho){it.push=Math.max(it.push||0,ho*.35);anyPush=true;}
        if(b>.2&&ho<hi){other.push=Math.max(other.push||0,hi*.35);anyPush=true;}
        // Remove only the closing velocity; otherwise each next frame taps the same contact again.
        const closing=((it.vx-other.vx)*dx+(it.vy-other.vy)*dy)/d;
        if(closing<0){it.vx-=dx/d*closing*first;it.vy-=dy/d*closing*first;other.vx+=dx/d*closing*second;other.vy+=dy/d*closing*second;}
      });});for(const it of this.items)this.place(it);
      // A contact can push its neighbour into an earlier pair. Keep relaxing only while prints still overlap.
      if(this.items.length<400&&pass===passes-1&&passes<16){
        this.index(maxSize*1.65);let overlap=false;
        for(let i=0;i<this.items.length&&!overlap;i++){
          const it=this.items[i];
          this.neighbours(it,Infinity,(other,j)=>{
            if(j>=i||(it.fixed||it.anchor)&&(other.fixed||other.anchor))return;
            const edge=(it.size+other.size)/2;
            if(Math.abs(it.x-other.x)<edge&&Math.abs(it.y-other.y)<edge)overlap=true;
          });
        }
        if(overlap)passes+=2;
      }
      if(!anyHeat&&!anyPush)break;
    }
    if(this.calm){
      // Settled means every print rests. Cooling stops an oscillating pair, so the fastest mover decides.
      let moved=0;for(const it of this.items)if(!it.off)moved=Math.max(moved,Math.abs(it.x-it.px),Math.abs(it.y-it.py));
      this.calmFrames=moved<T.settleMove&&!dragged.length?this.calmFrames+1:0;this.settled=this.calmFrames>=T.settleFrames;
      // Settled means asleep: a print still cooling would otherwise resume its residual drift at the next local wake.
      if(this.settled)for(const it of this.items){it.age=Math.max(it.age||0,T.settleGrace+T.coolFrames);it.heat=0;it.push=0;}
    }
    this.ms=performance.now()-start;
  }
}
if(typeof module!=='undefined')module.exports={SeaField,seaSimilarity,seaForce,seaVisualHome,seaOutcomeX};
else {
  const field=new SeaField();
  self.onmessage=({data:m})=>{
    if(m.kind==='set'){field.set(m);return;}
    if(m.kind==='resize'){const changed=field.resize(m);field.focus(field.filter||{},changed);return;}
    if(m.kind==='focus'){const key=JSON.stringify(m.focus||{}),same=key===field.focusKey;field.focusKey=key;field.focus(m.focus,!same);return;}  // the same focus again wakes nobody
    if(m.kind==='outcomes'){field.outcomes(m.flow);return;}
    if(m.kind==='tune'){field.tune(m.values);return;}
    if(m.kind==='view'){field.setView(m.rect);return;}
    if(m.kind==='debug'){self.postMessage({kind:'debug',log:field.log||[],frame:field.frame,settled:!!field.settled});return;}
    if(m.kind!=='step')return;
    const started=performance.now();
    // Recognition arrives in short bursts. Coalesce it instead of rerunning k-means on every metadata update.
    let clusters=field.membershipDirty?field.clusters:null,clusterMs=0;
    if(!field.settled&&m.time-field.clusterAt>(field.clusterDirty?1000:4000)){clusters=field.cluster();field.clusterAt=m.time;field.clusterDirty=false;clusterMs=performance.now()-started;}
    field.membershipDirty=false;
    field.step(m);
    // A sleeping field keeps its shores; nothing moved, so nothing needs tracing.
    let contours=null;if(!field.settled&&m.time-field.contourAt>300){contours=contourField(field.items,field.width,field.height,field.contourHistory||=new Map());field.contourAt=m.time;}
    const positions=m.buffer?.byteLength===field.items.length*12?new Float32Array(m.buffer):new Float32Array(field.items.length*3);
    field.items.forEach((it,i)=>{positions[i*3]=it.x;positions[i*3+1]=it.y;positions[i*3+2]=it.size;});
    const membership=clusters?Uint16Array.from(field.items,it=>clusters.findIndex(c=>c.id===it.cluster)+1):null;
    self.postMessage({kind:'positions',generation:field.generation,positions,clusters,membership,contours,focusCount:field.focusCount,settled:!!field.settled,clusterMs,ms:performance.now()-started},membership?[positions.buffer,membership.buffer]:[positions.buffer]);
  };
}
