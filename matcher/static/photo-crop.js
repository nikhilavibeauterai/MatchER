// A deliberate crop is a rectangle of the upright original, not a correction to what the model recognized.
const PhotoCrop = {
  open(photo,save,align=false) {
    this.dialog?.close();
    const dialog=document.createElement('dialog'),turn=photo.edits?.rotate||0;
    dialog.className='photo-crop-editor';dialog.setAttribute('aria-labelledby','crop-title');
    dialog.innerHTML=`<header><h2 id="crop-title">Choose your crop</h2><button type="button" class="btn" data-cancel aria-label="Close crop editor">×</button></header>
      <p id="crop-help">Draw a rectangle around what you want to keep. Drag its middle to move it, or its corners to resize.</p>
      <div class="crop-work"><div class="crop-stage"><div class="crop-card"><img src="${P(photo.id)}" alt="Photo to crop" draggable="false"></div></div>
      <form class="crop-controls rail-card"><fieldset><legend>Exact crop <small>(%)</small></legend><div class="crop-fields">${['Left','Top','Width','Height'].map((name,i)=>`<label>${name}<input type="number" data-crop-param="${i}" min="${i<2?0:.1}" max="100" step="any" inputmode="decimal" required></label>`).join('')}</div></fieldset>
        <fieldset class="crop-aspect"><legend>Aspect ratio</legend><div class="crop-ratio-fields"><label><input type="number" name="ratio-width" aria-label="Ratio width" min="0.001" step="any" inputmode="decimal" placeholder="Width"></label><span>:</span><label><input type="number" name="ratio-height" aria-label="Ratio height" min="0.001" step="any" inputmode="decimal" placeholder="Height"></label><button type="button" class="btn ghost" data-swap-ratio aria-label="Swap ratio width and height">⇄</button></div><div class="crop-ratio-presets" role="group" aria-label="Aspect ratio presets">${['Free','Original','1:1','3:2','4:5','16:9'].map(name=>`<button type="button" class="btn ghost" data-ratio="${name}">${name}</button>`).join('')}</div></fieldset>
        <fieldset><legend>Alignment</legend><div class="straighten-control"><label for="crop-straighten">Straighten</label><output for="crop-straighten" data-straighten-angle></output><input id="crop-straighten" name="straighten" type="range" min="-45" max="45" step="0.01" value="${AutoLook.angle(photo.auto_look,{...photo.edits,auto_align:photo.edits?.auto_align??S.align})}"></div><div class="crop-actions"><button type="button" class="btn ghost" data-horizon>Align horizon</button><button type="button" class="btn ghost" data-level>Reset angle</button></div><p class="crop-horizon-help" hidden>Draw along a horizon or another line that should be level.</p></fieldset>
        <button type="button" class="btn" data-preview-crop aria-pressed="false">Preview crop & alignment</button>
        <div class="crop-actions"><button type="button" class="btn" data-draw-crop>Draw crop</button><button type="button" class="btn ghost" data-whole>Whole photo</button></div><p class="crop-size" aria-live="polite"></p><p class="crop-error" role="alert"></p>
        <div class="crop-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary" disabled>Apply crop</button></div></form></div>`;
    document.body.append(dialog);this.dialog=dialog;
    const card=$('.crop-card',dialog),img=$('img',card),form=$('form',dialog),fields=$$('[data-crop-param]',form),apply=$('[type=submit]',form),ratioFields=$$('.crop-ratio-fields input',form),error=$('.crop-error',form);
    let box=rotateBox(photo.edits?.crop_box||[0,0,1,1],turn),drag=null,ratio=null,ready=false,saving=false,drawing=!photo.edits?.crop_box,
      straighten=AutoLook.angle(photo.auto_look,{...photo.edits,auto_align:photo.edits?.auto_align??S.align}),angleTouched=false,horizon=false,previewing=false;
    const dims=turn%180?[photo.height,photo.width]:[photo.width,photo.height],clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    card.dataset.photo=photo.id;Cards.focus(card);
    const overlay=document.createElement('div');overlay.className='crop-viewport';overlay.setAttribute('aria-describedby','crop-help');
    overlay.innerHTML=`<div class="crop-shade"></div><div class="crop-selection" tabindex="0" role="group" aria-label="Crop rectangle. Arrow keys move it; Shift moves faster."><div class="crop-thirds"></div>${['nw','ne','sw','se'].map((corner,i)=>`<button type="button" class="crop-handle ${corner}" data-corner="${corner}" aria-label="Resize crop from ${['top left','top right','bottom left','bottom right'][i]}"></button>`).join('')}</div>`;
    overlay.insertAdjacentHTML('beforeend','<svg class="crop-horizon" viewBox="0 0 100 100" preserveAspectRatio="none"><line vector-effect="non-scaling-stroke"/></svg>');
    card.append(overlay);const selection=$('.crop-selection',overlay),shade=$('.crop-shade',overlay),angle=$('[name=straighten]',form),line=$('.crop-horizon line',overlay);
    const render=(editing=null)=>{
      const [x,y,w,h]=box,points=[x,y,x+w,y+h].map(n=>n*100);
      Object.assign(selection.style,{left:`${x*100}%`,top:`${y*100}%`,width:`${w*100}%`,height:`${h*100}%`});
      shade.style.clipPath=`polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,${points[0]}% ${points[1]}%,${points[0]}% ${points[3]}%,${points[2]}% ${points[3]}%,${points[2]}% ${points[1]}%,${points[0]}% ${points[1]}%)`;
      fields.forEach((field,i)=>{if(field!==editing)field.value=String(Number((box[i]*100).toFixed(3)));});
      $('.crop-size',form).textContent=`${Math.max(1,Math.round(w*dims[0]))} × ${Math.max(1,Math.round(h*dims[1]))} pixels kept. Your original stays untouched.`;
      $('[data-draw-crop]',form).setAttribute('aria-pressed',String(drawing));overlay.classList.toggle('is-drawing',drawing);
      $('[data-horizon]',form).setAttribute('aria-pressed',String(horizon));$('.crop-horizon-help',form).hidden=!horizon;
      $('[data-preview-crop]',form).setAttribute('aria-pressed',String(previewing));overlay.hidden=previewing;
      $('[data-straighten-angle]',form).textContent=`${straighten>0?'+':''}${straighten.toFixed(2)}°`;
    };
    const fit=()=>{
      if(!ready)return;
      framePhoto(card,{dims:[photo.width,photo.height]},{crop:previewing?'custom':'off',cropBox:rotateBox(box,(360-turn)%360),rotate:turn,straighten:previewing?straighten:0,enhance:false,
        finishing:{grade:photo.edits?.grade,masks:photo.edits?.masks}});
      if(previewing){render();return;}
      const r=img.getBoundingClientRect(),c=card.getBoundingClientRect();
      Object.assign(overlay.style,{left:`${r.left-c.left}px`,top:`${r.top-c.top}px`,width:`${r.width}px`,height:`${r.height}px`});render();
    };
    const resize=new ResizeObserver(fit);resize.observe(card);
    img.addEventListener('load',()=>{ready=true;apply.disabled=false;fit();},{once:true});
    if(img.complete&&img.naturalWidth){ready=true;apply.disabled=false;fit();}
    const point=event=>{const r=overlay.getBoundingClientRect();return [clamp((event.clientX-r.left)/r.width,0,1),clamp((event.clientY-r.top)/r.height,0,1)];};
    const size=(x0,y0,x1,y1)=>{
      let w=Math.abs(x1-x0),h=Math.abs(y1-y0);
      if(ratio){const aspect=ratio*dims[1]/dims[0];if(w/h>aspect)h=w/aspect;else w=h*aspect;
        const k=Math.min(1,(x1>=x0?1-x0:x0)/(w||1),(y1>=y0?1-y0:y0)/(h||1));w*=k;h*=k;}
      w=Math.max(.001,w);h=Math.max(.001,h);
      return [clamp(x1>=x0?x0:x0-w,0,1-w),clamp(y1>=y0?y0:y0-h,0,1-h),w,h];
    };
    overlay.onpointerdown=event=>{
      if(event.button||!ready||saving)return;event.preventDefault();event.stopPropagation();
      const p=point(event),corner=event.target.closest('[data-corner]')?.dataset.corner;
      if(horizon){drag={id:event.pointerId,p,horizon:true};line.setAttribute('x1',p[0]*100);line.setAttribute('y1',p[1]*100);line.setAttribute('x2',p[0]*100);line.setAttribute('y2',p[1]*100);overlay.setPointerCapture(event.pointerId);return;}
      drag={id:event.pointerId,p,box:[...box],corner,moving:!corner&&!drawing&&selection.contains(event.target)};
      if(!corner&&!drag.moving)box=size(...p,...p);
      overlay.setPointerCapture(event.pointerId);render();
    };
    overlay.onpointermove=event=>{
      if(!drag||event.pointerId!==drag.id)return;event.preventDefault();
      const [x,y]=point(event);
      if(drag.horizon){line.setAttribute('x2',x*100);line.setAttribute('y2',y*100);return;}
      const [bx,by,bw,bh]=drag.box;
      if(drag.moving)box=[clamp(bx+x-drag.p[0],0,1-bw),clamp(by+y-drag.p[1],0,1-bh),bw,bh];
      else if(drag.corner)box=size(drag.corner.includes('w')?bx+bw:bx,drag.corner.includes('n')?by+bh:by,x,y);
      else box=size(...drag.p,x,y);render();
    };
    const release=event=>{if(!drag||event.pointerId!==drag.id)return;
      if(drag.horizon&&event.type==='pointerup'){
        const [x,y]=point(event),dx=(x-drag.p[0])*dims[0],dy=(y-drag.p[1])*dims[1];
        if(Math.hypot(dx,dy)>5){let degrees=-Math.atan2(dy,dx)*180/Math.PI;while(degrees>90)degrees-=180;while(degrees< -90)degrees+=180;
          straighten=Number(clamp(degrees,-45,45).toFixed(2));angleTouched=true;angle.value=String(straighten);horizon=false;previewing=true;}
      }
      drag=null;drawing=false;if(overlay.hasPointerCapture(event.pointerId))overlay.releasePointerCapture(event.pointerId);fit();};
    for(const type of ['pointerup','pointercancel','lostpointercapture'])overlay.addEventListener(type,release);
    selection.onkeydown=event=>{
      const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;
      event.preventDefault();event.stopPropagation();const step=event.shiftKey ? .05 : .005;
      box=[clamp(box[0]+delta[0]*step,0,1-box[2]),clamp(box[1]+delta[1]*step,0,1-box[3]),box[2],box[3]];render();
    };
    for(const field of fields)field.oninput=()=>{
      if(field.value===''||!Number.isFinite(field.valueAsNumber))return;
      const i=Number(field.dataset.cropParam),value=field.valueAsNumber/100;
      box[i]=clamp(value,i<2?0:.001,i<2?.999:1-box[i-2]);
      if(i<2)box[i+2]=Math.min(box[i+2],1-box[i]);
      free();render(field);if(previewing)fit();
    };
    for(const field of fields)field.onchange=()=>{field.value=String(Number((box[Number(field.dataset.cropParam)]*100).toFixed(3)));};
    const fitRatio=()=>{
      if(ratio){const cx=box[0]+box[2]/2,cy=box[1]+box[3]/2,aspect=ratio*dims[1]/dims[0],w=Math.min(box[2],box[3]*aspect),h=w/aspect;
        box=[clamp(cx-w/2,0,1-w),clamp(cy-h/2,0,1-h),w,h];render();if(previewing)fit();}
    };
    const preset=name=>{for(const button of $$('[data-ratio]',form))button.setAttribute('aria-pressed',String(button.dataset.ratio===name));$('[data-swap-ratio]',form).disabled=!ratio;};
    const free=()=>{ratio=null;ratioFields.forEach(input=>input.value='');preset('Free');};
    for(const button of $$('[data-ratio]',form))button.onclick=()=>{
      const name=button.dataset.ratio;if(name==='Free'){free();return;}
      const values=name==='Original'?dims:name.split(':').map(Number);ratioFields.forEach((field,i)=>field.value=String(values[i]));
      ratio=values[0]/values[1];preset(name);fitRatio();
    };
    const readRatio=()=>{const [w,h]=ratioFields.map(field=>field.valueAsNumber);if(w>0&&h>0){ratio=w/h;preset('');fitRatio();}};
    for(const input of ratioFields)input.oninput=readRatio;
    $('[data-swap-ratio]',form).onclick=()=>{const [w,h]=ratioFields.map(field=>field.value);ratioFields[0].value=h;ratioFields[1].value=w;readRatio();};
    free();
    $('[data-whole]',form).onclick=()=>{box=[0,0,1,1];free();fit();};
    $('[data-draw-crop]',form).onclick=()=>{drawing=!drawing;horizon=false;previewing=false;fit();};
    $('[data-horizon]',form).onclick=()=>{horizon=!horizon;previewing=false;drawing=false;line.setAttribute('x2',line.getAttribute('x1')||0);line.setAttribute('y2',line.getAttribute('y1')||0);fit();};
    $('[data-level]',form).onclick=()=>{straighten=0;angleTouched=true;angle.value='0';fit();};
    angle.oninput=()=>{if(angle.value!==''&&angle.checkValidity()){straighten=angle.valueAsNumber;angleTouched=true;previewing=true;horizon=false;fit();}};
    $('[data-preview-crop]',form).onclick=()=>{previewing=!previewing;horizon=false;fit();};
    form.onsubmit=async event=>{
      event.preventDefault();if(!ready||saving)return;saving=true;apply.disabled=true;error.textContent='';
      // Framing alone must not turn an inherited automatic angle into a manual override.
      try{const saved=await save({crop:'custom',crop_box:rotateBox(box,(360-turn)%360).map(v=>Number(v.toFixed(6))),...(angleTouched?{straighten}:{})});
        if(saved===false)throw new Error('Couldn’t save this crop. Your selection is still here; try again.');dialog.close();}
      catch(e){error.textContent=e.message;}finally{saving=false;apply.disabled=false;}
    };
    const cancel=()=>{if(!saving)dialog.close();};
    for(const button of $$('[data-cancel]',dialog))button.onclick=cancel;
    dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
    dialog.addEventListener('keydown',event=>event.stopPropagation());
    dialog.addEventListener('pointerdown',event=>event.stopPropagation());
    const leave=()=>dialog.close();window.addEventListener('hashchange',leave,{once:true});
    dialog.addEventListener('close',()=>{resize.disconnect();window.removeEventListener('hashchange',leave);dialog.remove();if(this.dialog===dialog)this.dialog=null;},{once:true});
    dialog.showModal();if(align){horizon=true;drawing=false;}requestAnimationFrame(fit);
  }
};
