// Colour curves and original-coordinate brush masks. These match matcher/finishing.py's edited exports.
const PhotoFinish = {
  zones:['shadows','midtones','highlights'],
  local:{exposure:[-2,2,0],contrast:[-1,1,0],saturation:[0,2,1],warmth:[-1,1,0]},
  proofs:new Map(),
  rgb(h) {
    const k=n=>(n+h/60)%6,f=n=>1-Math.max(0,Math.min(k(n),4-k(n),1));return [f(5),f(3),f(1)];
  },
  tables(grade={}) {
    const tint=this.zones.map(zone=>{const k=grade[zone]||{},rgb=this.rgb(k.hue||0),mean=rgb.reduce((a,b)=>a+b)/3;
      return rgb.map(v=>(v-mean)*(k.amount||0)*.3+(k.light||0)*.25);});
    return [0,1,2].map(c=>Array.from({length:256},(_,i)=>{
      const v=i/255,t=Math.max(0,Math.min(1,v+(grade.balance||0)*.25)),p=1+3*(1-(grade.blending??.5)),s=(1-t)**p,h=t**p;
      return Math.max(0,Math.min(1,v+s*tint[0][c]+(1-s-h)*tint[1][c]+h*tint[2][c]));
    }));
  },
  mask(layer,dims) {
    const key=JSON.stringify([dims,layer.strokes,layer.feather]);if(this.proofs.has(key))return this.proofs.get(key);
    const scale=Math.min(1,1536/Math.max(...dims)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(dims[0]*scale));canvas.height=Math.max(1,Math.round(dims[1]*scale));
    const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
    ctx.lineCap=ctx.lineJoin='round';ctx.fillStyle=ctx.strokeStyle='white';
    for(const stroke of layer.strokes||[]){
      ctx.globalCompositeOperation=stroke.mode==='erase'?'destination-out':'source-over';const r=Math.max(.5,stroke.r*Math.min(w,h));ctx.lineWidth=r*2;
      ctx.beginPath();stroke.p.forEach(([x,y],i)=>i?ctx.lineTo(x*w,y*h):ctx.moveTo(x*w,y*h));ctx.stroke();
      for(const [x,y] of stroke.p){ctx.beginPath();ctx.arc(x*w,y*h,r,0,Math.PI*2);ctx.fill();}
    }
    const feather=(layer.feather??.25)*Math.min(w,h)*.02;
    if(feather){const copy=document.createElement('canvas');copy.width=w;copy.height=h;copy.getContext('2d').drawImage(canvas,0,0);ctx.clearRect(0,0,w,h);ctx.globalCompositeOperation='source-over';ctx.filter=`blur(${feather}px)`;ctx.drawImage(copy,0,0);}
    const url=canvas.toDataURL();if(this.proofs.size>=24)this.proofs.delete(this.proofs.keys().next().value);this.proofs.set(key,url);return url;
  },
  markup(edits,dims,area=null) {
    let out='';
    if(edits.grade)out+=`<feComponentTransfer>${this.tables(edits.grade).map((table,i)=>`<feFunc${'RGB'[i]} type="table" tableValues="${table.map(v=>v.toFixed(6)).join(' ')}"/>`).join('')}</feComponentTransfer>`;
    let n=0;
    for(const layer of edits.masks||[]){
      if(layer.enabled===false||layer.opacity===0||!layer.strokes?.length)continue;
      const k=layer.adjust||{},exposure=2**(k.exposure||0),contrast=1+.6*(k.contrast||0),warmth=k.warmth||0,index=++n,
        x=area?.[0]??0,y=area?.[1]??0,w=area?.[2]??1,h=area?.[3]??1;
      out+=`<feComposite in2="SourceAlpha" operator="in" result="base${index}"/>
        <feComponentTransfer>${[0,1,2].map(i=>`<feFunc${'RGB'[i]} type="linear" slope="${exposure}"/>`).join('')}</feComponentTransfer>
        <feComponentTransfer>${[0,1,2].map(i=>`<feFunc${'RGB'[i]} type="linear" slope="${contrast}" intercept="${(1-contrast)/2}"/>`).join('')}</feComponentTransfer>
        <feColorMatrix type="saturate" values="${k.saturation??1}"/>
        <feComponentTransfer>${[1+.12*warmth,1,1-.12*warmth].map((v,i)=>`<feFunc${'RGB'[i]} type="linear" slope="${v}"/>`).join('')}</feComponentTransfer>
        <feComposite in2="SourceAlpha" operator="in" result="adjust${index}"/>
        <feImage href="${this.mask(layer,dims)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" result="mask${index}"/>
        <feComponentTransfer result="coverage${index}"><feFuncA type="linear" slope="${layer.opacity??1}"/></feComponentTransfer>
        <feComposite in="adjust${index}" in2="coverage${index}" operator="in" result="inside${index}"/>
        <feComposite in="base${index}" in2="coverage${index}" operator="out" result="outside${index}"/>
        <feComposite in="inside${index}" in2="outside${index}" operator="arithmetic" k2="1" k3="1"/>`;
    }
    return out;
  },
  wheels(grade={}) {
    return `<div class="grade-wheels">${this.zones.map(zone=>{const k=grade[zone]||{};return `<fieldset class="grade-zone" data-zone="${zone}"><legend>${zone[0].toUpperCase()+zone.slice(1)}</legend>
      <div class="grade-wheel" tabindex="0" role="group" aria-label="${zone} colour wheel. Arrows change hue and strength."><span class="grade-puck"></span></div>
      <div class="grade-values"><label>Hue °<input data-grade="hue" type="number" min="0" max="360" step="any" value="${k.hue||0}"></label><label>Colour %<input data-grade="amount" type="number" min="0" max="100" step="any" value="${Math.round((k.amount||0)*100)}"></label></div>
      <label>Light<input data-grade="light" type="range" min="-1" max="1" step="0.01" value="${k.light||0}"></label><button type="button" class="btn ghost" data-grade-reset>Reset ${zone}</button></fieldset>`;}).join('')}</div>
      <div class="grade-mix"><label>Blending<input data-grade-mix="blending" type="range" min="0" max="1" step="0.01" value="${grade.blending??.5}"></label><label>Balance<input data-grade-mix="balance" type="range" min="-1" max="1" step="0.01" value="${grade.balance||0}"></label></div><button type="button" class="btn ghost" data-grade-clear>Reset colour grading</button>`;
  },
  bindWheels(root,read,preview,save) {
    const value=()=>{const g={};for(const zone of $$('.grade-zone',root)){g[zone.dataset.zone]=Object.fromEntries($$('[data-grade]',zone).map(i=>[i.dataset.grade,Number(i.value)/(i.dataset.grade==='amount'?100:1)]));}
      for(const i of $$('[data-grade-mix]',root))g[i.dataset.gradeMix]=Number(i.value);return g;};
    const paint=()=>{for(const zone of $$('.grade-zone',root)){const hue=Number($('[data-grade=hue]',zone).value)*Math.PI/180,amount=Number($('[data-grade=amount]',zone).value)/100;
      $('.grade-puck',zone).style.cssText=`left:${50+Math.cos(hue)*amount*46}%;top:${50+Math.sin(hue)*amount*46}%`;}};
    for(const input of $$('[data-grade],[data-grade-mix]',root)){input.oninput=()=>{if(!input.checkValidity()||input.value==='')return;paint();preview(value());};input.onchange=()=>{if(input.checkValidity()&&input.value!=='')save(value());};}
    for(const wheel of $$('.grade-wheel',root)){
      const zone=wheel.closest('.grade-zone'),h=$('[data-grade=hue]',zone),a=$('[data-grade=amount]',zone);
      const point=e=>{const r=wheel.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;h.value=String(Math.round((Math.atan2(y,x)*180/Math.PI+360)%360));a.value=String(Math.round(Math.min(1,Math.hypot(x,y)/.46)*100));paint();preview(value());};
      wheel.onpointerdown=e=>{if(e.button)return;e.preventDefault();wheel.setPointerCapture(e.pointerId);point(e);};
      wheel.onpointermove=e=>{if(wheel.hasPointerCapture(e.pointerId))point(e);};
      wheel.onpointerup=e=>{if(wheel.hasPointerCapture(e.pointerId)){wheel.releasePointerCapture(e.pointerId);save(value());}};
      wheel.onpointercancel=()=>{const g=read();this.fillWheels(root,g);preview(g);};
      wheel.onkeydown=e=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]}[e.key];if(!delta)return;e.preventDefault();h.value=String((Number(h.value)+delta[0]*(e.shiftKey?10:1)+360)%360);a.value=String(Math.max(0,Math.min(100,Number(a.value)+delta[1]*(e.shiftKey?10:1))));paint();preview(value());};
      wheel.onkeyup=e=>{if(e.key.startsWith('Arrow'))save(value());};
    }
    for(const button of $$('[data-grade-reset]',root))button.onclick=()=>{const g=value();delete g[button.closest('[data-zone]').dataset.zone];this.fillWheels(root,g);save(g);};
    $('[data-grade-clear]',root).onclick=()=>{this.fillWheels(root,{});save(null);};paint();
  },
  fillWheels(root,grade={}) {
    for(const zone of $$('.grade-zone',root))for(const input of $$('[data-grade]',zone))input.value=String((grade[zone.dataset.zone]?.[input.dataset.grade]||0)*(input.dataset.grade==='amount'?100:1));
    for(const input of $$('[data-grade-mix]',root))input.value=String(grade[input.dataset.gradeMix]??(input.dataset.gradeMix==='blending'?.5:0));
    for(const zone of $$('.grade-zone',root)){const h=Number($('[data-grade=hue]',zone).value)*Math.PI/180,a=Number($('[data-grade=amount]',zone).value)/100;$('.grade-puck',zone).style.cssText=`left:${50+Math.cos(h)*a*46}%;top:${50+Math.sin(h)*a*46}%`;}
  }
};
if(typeof module!=='undefined')module.exports={PhotoFinish};
