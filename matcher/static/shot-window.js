// A long roster keeps its full scroll height, but only nearby rows carry live paper and pictures. Rows keep their
// actual cards while visible; scrolling never sends them flying back to the sea or changes the selection.
class ShotWindow {
  constructor(root, shots, selected, boxes, scrollport) {
    Object.assign(this,{root,shots,selected,boxes,scrollport,rows:[],mounted:new Map(),byPhoto:new Map()});
    root.classList.add('windowed-shots');root.shotWindow=this;
    this.tab=e=>{
      if(e.key!=='Tab')return;
      const el=e.target.closest('.shot-window-row'),row=el?.shotRow;if(!row)return;
      const controls=[...el.querySelectorAll('button:not(:disabled),a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(node=>node.getClientRects().length);
      if(e.target===(e.shiftKey?controls[0]:controls.at(-1))){const next=this.rows[this.rows.indexOf(row)+(e.shiftKey?-1:1)];if(next)this.mount(next);}
    };
    root.addEventListener('keydown',this.tab);
    this.resize=new ResizeObserver(entries=>{
      let changed=false;
      for(const {target,contentRect}of entries){const row=target.shotRow;if(!row)continue;
        const height=Math.ceil(contentRect.height);if(Math.abs(height-row.height)>1){row.height=height;changed=true;}
      }
      if(changed){this.offsets();this.update();}
    });
    this.layout();
  }
  static plan(shots,cols,width,gap=8) {
    const rows=[],packs=[],card=(width-gap*(cols-1))/cols;let next=[];
    for(const family of shotFamilies(shots))for(let i=0;i<family.items.length;i+=cols){
      const part=family.items.slice(i,i+cols);
      if(next.length+part.length>cols){packs.push(next);next=[];}
      next.push(...part);
    }
    if(next.length)packs.push(next);
    for(const items of packs){
      let height=card*4/3;
      // The dashed family box adds its two 8px insets, 30px heading and 3px of border. Keep a small family
      // together at the row boundary, just as the ordinary grid does, rather than turning its ends into singles.
      for(const family of shotFamilies(items))if(family.items.length>1)height=Math.max(height,(card-19/family.items.length)*4/3+41);
      rows.push({shots:items,height:Math.ceil(height),top:0});
    }
    return rows;
  }
  layout() {
    const width=this.root.clientWidth;if(!width||width===this.width)return;
    const top=this.root.getBoundingClientRect().top,edge=this.scrollport.getBoundingClientRect().top,
      old=this.rows.find(row=>this.mounted.has(row)&&top+row.top>=edge),
      anchor=old&&{photo:old.shots[0].rep,y:top+old.top},open=this.root.querySelector('.tile.open');
    this.width=width;this.cols=innerWidth<=760?3:Math.max(1,Math.floor((width+8)/126));
    for(const el of this.mounted.values()){this.resize.unobserve(el);el.remove();}this.mounted.clear();
    this.rows=ShotWindow.plan(this.shots,this.cols,width);this.byPhoto.clear();
    for(const row of this.rows)for(const shot of row.shots)this.byPhoto.set(shot.rep,row);
    this.offsets();this.update();
    if(open){const target=this.ensure(Number(open.dataset.sel));if(target){target.replaceWith(open);this.measure();}}
    if(anchor){const row=this.byPhoto.get(anchor.photo);if(row)this.scrollport.scrollTop+=this.root.getBoundingClientRect().top+row.top-anchor.y;this.update();}
  }
  offsets() {
    let top=0;for(const row of this.rows){row.top=top;top+=row.height+8;}
    this.root.style.height=`${Math.max(0,top-8)}px`;
    for(const [row,el]of this.mounted)el.style.top=`${row.top}px`;
  }
  mount(row) {
    let el=this.mounted.get(row);if(el)return el;
    el=document.createElement('div');el.className='lookgrid shot-window-row';el.shotRow=row;
    el.style.cssText=`top:${row.top}px;min-height:${row.height}px;grid-template-columns:repeat(${this.cols},minmax(0,1fr))`;
    el.innerHTML=shotTiles(row.shots,this.selected,this.boxes);
    for(const family of el.querySelectorAll(':scope > .fam-tiles')){
      const n=family.children.length;family.style.gridColumn=`span ${n}`;family.style.gridTemplateColumns=`repeat(${n},minmax(0,1fr))`;
    }
    // DOM order remains reading order for tab navigation, including rows brought back by keyboard focus.
    const next=[...this.mounted].find(([other])=>other.top>row.top)?.[1];this.root.insertBefore(el,next||null);
    this.mounted.set(row,el);this.mounted=new Map([...this.mounted].sort(([a],[b])=>a.top-b.top));this.resize.observe(el);return el;
  }
  update() {
    if(!this.root.isConnected)return;
    const rect=this.root.getBoundingClientRect(),edge=this.scrollport.getBoundingClientRect(),pad=Math.max(240,edge.height*.6),
      top=edge.top-rect.top-pad,bottom=edge.bottom-rect.top+pad;
    for(const [row,el]of this.mounted)if((row.top+row.height<top||row.top>bottom)&&!el.contains(document.activeElement)&&!el.querySelector('.open,.dragging')&&!el.contains(Toolbelt.gesture?.print)){
      this.resize.unobserve(el);el.remove();this.mounted.delete(row);
    }
    for(const row of this.rows)if(row.top+row.height>=top&&row.top<=bottom)this.mount(row);
  }
  ensure(photo) {
    const row=this.byPhoto.get(photo);return row&&this.mount(row).querySelector(`[data-sel="${photo}"]`);
  }
  measure() {
    // Opening a fan changes only its row. Read the mounted rows together before moving later ones.
    const heights=[...this.mounted].map(([row,el])=>[row,Math.ceil(el.getBoundingClientRect().height)]);
    for(const [row,height]of heights)row.height=height;this.offsets();
  }
  destroy(){this.resize.disconnect();this.root.removeEventListener('keydown',this.tab);delete this.root.shotWindow;}
}
if(typeof module!=='undefined')module.exports={ShotWindow};
