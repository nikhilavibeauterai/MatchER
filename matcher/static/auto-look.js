// A photo's saved baseline survives every change of image resolution. Manual finishing always follows it.
const AutoLook={
  version:3,
  recipes:new Map(),pages:new Map(),source:null,
  sync(){if(this.source!==S.lib?.source){this.source=S.lib?.source;this.recipes.clear();this.pages.clear();}},
  know(pid,recipe){
    this.sync();if(!recipe?.version)return;pid=Number(pid);const first=this.recipes.get(pid)?.version!==recipe.version;this.recipes.set(pid,recipe);
    if(first&&typeof PhotoNotes!=='undefined'&&PhotoNotes.source===this.source){
      const cached=PhotoNotes.cache.get(pid);if(cached)cached.auto_look=recipe;
      for(const state of PhotoNotes.hosts.values())if(state.pid===pid&&state.data)state.data.auto_look=recipe;
      if(PhotoNotes.active?.pid===pid&&PhotoNotes.active.data){PhotoNotes.active.data.auto_look=recipe;PhotoNotes.controls();}
    }
  },
  upgrade(rows){
    const changed=new Set();
    for(const {id,recipe} of rows){
      if(!recipe?.version||(this.recipes.get(id)?.version||0)>=recipe.version)continue;
      this.know(id,recipe);const photo=World.photos?.get(id);if(photo)photo.auto_look=recipe;changed.add(id);
    }
    if(!changed.size)return;
    for(const page of this.pages.values())if(page.photos.some(p=>changed.has(p.id)))page.variants.clear();
    paintFilters();PhotoNotes.repaint();
  },
  resolve(recipe,edits={}){
    const r=recipe||{lin:[[1,0],[1,0],[1,0]],gamma:1,sat:1},amount=edits.auto_amount??1,parts=edits.auto_parts||{},n=key=>parts[key]===false?0:amount;
    const tone=n('tone'),colour=n('colour');
    return {lin:r.lin.map(([a,b],i)=>[(1+(a-1)*tone)*(1+((r.wb?.[i]??1)-1)*colour),b*tone]),curve:this.mixCurve(r.curve,tone),gamma:1+(r.gamma-1)*tone,sat:1+(r.sat-1)*colour,
      grade:n('grade')?Object.fromEntries(Object.entries(r.grade||{}).map(([k,v])=>[k,typeof v==='object'?{...v,amount:(v.amount||0)*n('grade'),light:(v.light||0)*n('grade')}:v])):null,
      masks:n('subject')?(r.masks||[]).map(m=>({...m,opacity:(m.opacity??1)*Math.min(1,n('subject'))})):[],
      detail:Object.fromEntries(Object.entries(r.detail||{}).map(([k,v])=>[k,k==='basis'?v:v*n('detail')]))};
  },
  mixCurve(curve,amount){
    if(!curve)return null;let previous=0;
    return curve.map((v,i)=>{const x=i/(curve.length-1);return previous=Math.max(previous,Math.max(0,Math.min(1,x+(v-x)*amount)));});
  },
  sample(curve,x){
    if(!curve)return x;const p=Math.max(0,Math.min(1,x))*(curve.length-1),i=Math.min(curve.length-2,Math.floor(p));
    return curve[i]+(curve[i+1]-curve[i])*(p-i);
  },
  angle(recipe,edits={}){
    if(edits.straighten!=null)return Number(edits.straighten)||0;
    return edits.auto_align===false||(recipe?.version??3)<3?0:recipe?.straighten||0;
  },
  detailMarkup(detail,dims){
    const smooth=detail.smooth||0,sharp=detail.sharp||0;if(!smooth&&!sharp)return '';
    const radius=.7/Math.max(1,detail.basis||800),max=Math.max(...dims),x=radius*max/dims[0],y=radius*max/dims[1];
    return `<feComposite in2="SourceAlpha" operator="in" result="detail-source"/><feGaussianBlur stdDeviation="${x} ${y}" result="detail-blur"/>
      <feComposite in="detail-source" in2="detail-blur" operator="arithmetic" k2="${1-smooth+sharp}" k3="${smooth-sharp}"/>`;
  },
  // The tiny prints use one already-decoded atlas. Bake its colour once per page or edit, never during a camera frame.
  sheet(image,photos){
    const page={image,photos,variants:new Map(),signatures:new Map(photos.map(p=>[p.id,this.signature(p)]))};this.pages.set(image,page);return this.paintPage(page);
  },
  signature(photo){const e=Toolbelt.edits.get(photo.id)||photo.render_edits||{};return JSON.stringify(['enhance','look','grade','auto_amount','auto_parts','auto_align','straighten'].map(k=>e[k]??null));},
  paintPage(page){
    const on=!!S.filter,key=`${on}/${!!S.align}`;let canvas=page.variants.get(key);
    if(!canvas){
      canvas=document.createElement('canvas');canvas.width=page.image.naturalWidth;canvas.height=page.image.naturalHeight;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(page.image,0,0);
      page.photos.forEach((photo,index)=>{
        const e=Toolbelt.edits.get(photo.id)||photo.render_edits||{},degrees=this.angle(this.recipes.get(photo.id),{...e,auto_align:e.auto_align??S.align});
        if(!degrees)return;
        const cell=World.sea.atlasCell(page.image,index,photo.dims),[w,h]=photo.dims,a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a),
          trim=Math.min(w/(w*Math.abs(c)+h*Math.abs(s)),h/(w*Math.abs(s)+h*Math.abs(c)));
        ctx.save();ctx.beginPath();ctx.rect(cell.x,cell.y,16,16);ctx.clip();
        ctx.transform(c/trim,s*w/h/trim,-s*h/w/trim,c/trim,cell.x+8,cell.y+8);
        ctx.drawImage(page.image,cell.x,cell.y,16,16,-8,-8,16,16);ctx.restore();
      });
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),d=pixels.data;
      page.photos.forEach((photo,index)=>{
        const e=Toolbelt.edits.get(photo.id)||photo.render_edits||{},enabled=e.enhance??on,r=this.recipes.get(photo.id),base=this.resolve(r,e),t=enabled&&r?tunedLook(base,e.look):null;
        const grades=[...(enabled&&r&&base.grade?[PhotoFinish.tables(base.grade)]:[]),...(e.grade?[PhotoFinish.tables(e.grade)]:[])];
        if(!t&&!grades.length)return;
        const table=[0,1,2].map(c=>Array.from({length:256},(_,i)=>{
          if(!t)return i/255;const [a,b]=t.lin[c],[slope,offset]=t.contrast;
          return Math.max(0,Math.min(1,this.sample(t.curve,Math.max(0,Math.min(1,a*i/255+b)))**t.gamma*slope+offset));
        }));
        const cell=World.sea.atlasCell(page.image,index,photo.dims);
        for(let y=cell.y;y<cell.y+16;y++)for(let x=cell.x;x<cell.x+16;x++){
          const p=(y*canvas.width+x)*4,rgb=[0,1,2].map(c=>table[c][d[p+c]]);
          if(t){const grey=rgb[0]*.213+rgb[1]*.715+rgb[2]*.072;for(let c=0;c<3;c++)rgb[c]=Math.max(0,Math.min(1,(grey+(rgb[c]-grey)*t.sat)*(1+(c===0?.12:c===2?-.12:0)*t.warmth)));}
          for(const grade of grades)for(let c=0;c<3;c++)rgb[c]=grade[c][Math.round(rgb[c]*255)];
          for(let c=0;c<3;c++)d[p+c]=Math.round(rgb[c]*255);
        }
      });
      ctx.putImageData(pixels,0,0);page.variants.set(key,canvas);
    }
    page.photos.forEach((p,i)=>World.sprites.set(p.id,World.sea.atlasCell(canvas,i,p.dims)));
    World.sea.spritesDirty=World.sea.densityDirty=true;World.sea.kick();return canvas;
  },
  repaint(pid){
    this.sync();for(const page of this.pages.values()){
      const photo=pid&&page.photos.find(p=>p.id===pid);if(pid&&!photo)continue;
      if(photo){const signature=this.signature(photo);if(page.signatures.get(pid)===signature)continue;page.signatures.set(pid,signature);page.variants.clear();}
      this.paintPage(page);
    }
  },
};
if(typeof module!=='undefined')module.exports={AutoLook};
