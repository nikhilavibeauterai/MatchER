// Trace occupied water, not a bounding box. A scattered group can have several shores and empty holes.
// The coarse field bounds the work by viewport size; it never compares every photo with every other photo.
function simplifyShore(points,tolerance){
  // Raster stair steps add no visible detail at this scale. Retain each shore and hole within a pixel-sized error.
  if(points.length<10)return points;
  const line=[...points,points[0]],keep=new Uint8Array(line.length),pending=[[0,line.length-1]],limit=tolerance*tolerance;
  keep[0]=keep[line.length-1]=1;
  while(pending.length){
    const [a,b]=pending.pop(),p=line[a],q=line[b],dx=q[0]-p[0],dy=q[1]-p[1],length=dx*dx+dy*dy;let far=-1,best=limit;
    for(let i=a+1;i<b;i++){const at=line[i],t=length?Math.max(0,Math.min(1,((at[0]-p[0])*dx+(at[1]-p[1])*dy)/length)):0;
      const distance=(at[0]-p[0]-t*dx)**2+(at[1]-p[1]-t*dy)**2;if(distance>best){best=distance;far=i;}}
    if(far>=0){keep[far]=1;pending.push([a,far],[far,b]);}
  }
  const result=points.filter((_,i)=>keep[i]);return result.length>=4?result:points;
}
function seaContours(items, width, height, history = new Map(), now = performance.now()) {
  const resolution=items.length>4000?80:items.length>1000?100:120;
  const cell = Math.max(10, Math.min(28, Math.ceil(Math.max(width, height) / resolution)));
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell), stride = cols + 1, groups = new Map();
  for (const [itemIndex,it] of items.entries()) {
    const id = it.label || it.cluster;
    if (!id) continue;
    let group = groups.get(id);
    if (!group) { group = {cells:new Set(), members:new Map(), fixed:[], lifted:new Set(), count:0, footprint:0}; groups.set(id, group); }
    group.count++;group.footprint+=it.size;
    const memberId=it.id??itemIndex;
    // A spotlight or stationary hover still occupies its source spot. Removing that footprint can bisect the
    // shore. Only an actual drag uses the separate support rules instead of leaving a phantom bridge.
    if(it.fixed&&it.dragged){group.fixed.push({...it,id:memberId});continue;}
    if(it.lifted)group.lifted.add(memberId);
    const radius = it.size*.8+Math.max(5,Math.min(14,it.size*.35));
    let member=-1;
    for (let y = Math.max(0, Math.floor((it.y-radius)/cell)); y < Math.min(rows, Math.ceil((it.y+radius)/cell)); y++) {
      for (let x = Math.max(0, Math.floor((it.x-radius)/cell)); x < Math.min(cols, Math.ceil((it.x+radius)/cell)); x++) {
        if (((x+.5)*cell-it.x)**2 + ((y+.5)*cell-it.y)**2 <= Math.max(radius+cell*.3,cell*.72)**2) {
          const index=y*cols+x;group.cells.add(index);if(member<0)member=index;
        }
      }
    }
    if(member>=0){const members=group.members.get(member)||[];members.push(memberId);group.members.set(member,members);}
  }
  // A new compact shore needs three bodies. A brief gap or held member must not blink an established one off.
  for(const id of history.keys())if(!groups.has(id))history.delete(id);
  for(const [id,group]of groups){
    const previous=history.get(id)||[],shores=[],remaining=group.cells,occupied=new Set(),component=[],owner=new Map();
    for(const old of previous)for(const member of old.members)owner.set(member,old);
    const visit=next=>{if(remaining.delete(next))component.push(next);};
    while(remaining.size){
      component.length=0;const start=remaining.values().next().value;component.push(start);remaining.delete(start);
      const members=new Set();
      for(let i=0;i<component.length;i++){
        const index=component[i],x=index%cols;for(const member of group.members.get(index)||[])members.add(member);
        if(index>=cols)visit(index-cols);if(index<(rows-1)*cols)visit(index+cols);
        if(x)visit(index-1);if(x<cols-1)visit(index+1);
      }
      let visible=0;for(const member of members)if(!group.lifted.has(member))visible++;
      let qualified=members.size>=3&&visible>=2?now:null;
      if(qualified==null&&visible>=2){
        for(const old of new Set([...members].map(member=>owner.get(member)).filter(Boolean))){
          let shared=0;for(const member of members)if(old.members.has(member))shared++;
          if(shared<2)continue;
          const held=group.fixed.filter(it=>old.members.has(it.id)&&component.some(index=>{
            const x=(index%cols+.5)*cell,y=(Math.floor(index/cols)+.5)*cell;
            return (x-it.x)**2+(y-it.y)**2<(it.size+cell)**2;
          }));
          if(members.size+held.length>=3){qualified=now;for(const it of held)members.add(it.id);}
          else if(now-old.qualified<900)qualified=old.qualified;
          if(qualified!=null)break;
        }
      }
      if(qualified!=null){for(const index of component)occupied.add(index);shores.push({members,qualified});}
    }
    history.set(id,shores);
    group.cells=occupied;
  }
  // Intermingled suggestions have a name, but no tangled mesh. Their shores appear once a flock has room of its own.
  const coverage=new Uint16Array(cols*rows);
  for(const group of groups.values())for(const index of group.cells)coverage[index]++;
  const result = [];
  for (const [id, group] of groups) {
    const edges = new Map(), occupied = group.cells;
    let clear=0;for(const index of occupied)if(coverage[index]===1)clear++;
    // Confidence changes gradually as neighbours intermingle; crossing one purity percentage cannot erase a shore.
    // At thumbnail-sheet scale, hundreds of little shores can drown out the photos. Keep their geometry and
    // controls, but let the outlines recede with the prints; hovering a group still reveals its full outline.
    const lod=Math.min(1,group.footprint/group.count/14);
    const purity=occupied.size?clear/occupied.size:0,opacity=Math.min(1,Math.sqrt(purity)*1.4)*lod*lod;
    const edge = (a,b) => { const next=edges.get(a)||[]; next.push(b); edges.set(a,next); };
    for (const index of occupied) {
      const x=index%cols,y=Math.floor(index/cols),a=y*stride+x;
      if (!y || !occupied.has(index-cols)) edge(a,a+1);
      if (x===cols-1 || !occupied.has(index+1)) edge(a+1,a+stride+1);
      if (y===rows-1 || !occupied.has(index+cols)) edge(a+stride+1,a+stride);
      if (!x || !occupied.has(index-1)) edge(a+stride,a);
    }
    const paths=[];
    while (edges.size) {
      const start=edges.keys().next().value, points=[];
      let at=start;
      do {
        points.push([at%stride*cell,Math.floor(at/stride)*cell]);
        const next=edges.get(at);
        if (!next) break;
        const to=next.pop();if(!next.length)edges.delete(at);at=to;
      } while(at!==start);
      // Isolated specks already have a photo. Outlines are for a gathering, and preserve holes in that gathering.
      if(points.length>=8){
        let smooth=points;
        for(let pass=0;pass<2;pass++)smooth=smooth.map((p,i)=>{const a=smooth[(i+smooth.length-1)%smooth.length],b=smooth[(i+1)%smooth.length];return [(a[0]+p[0]*2+b[0])/4,(a[1]+p[1]*2+b[1])/4];});
        paths.push(simplifyShore(smooth,cell*.16));
      }
    }
    // Mix each cell before combining it: equal and opposite shore movement preserves a simple index sum.
    let hash=0,check=0;for(const index of occupied){
      let h=index+1;h=Math.imul(h^(h>>>16),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);h^=h>>>16;
      hash=(hash+h)>>>0;check=(check+Math.imul(h^(h>>>15),0x27d4eb2d))>>>0;
    }
    result.push({id, count:group.count, paths:opacity?paths:[], hotPaths:paths, opacity, purity,
      key:`${cols}:${rows}:${occupied.size}:${hash}:${check}:${opacity>0}`});
  }
  return result;
}
if (typeof module !== 'undefined') module.exports = {seaContours};
