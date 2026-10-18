// Paint local adjustments without flattening the photo or turning the toolbelt's ink into an image edit.
const PhotoMask = {
  open(photo,save) {
    this.dialog?.close();
    const dialog=document.createElement('dialog');dialog.className='photo-crop-editor photo-mask-editor';dialog.setAttribute('aria-labelledby','mask-title');
    dialog.innerHTML=`<header><h2 id="mask-title">Paint local adjustments</h2><button type="button" class="btn" data-cancel aria-label="Close mask editor">×</button></header>
      <p>Paint the part you want to change. Masks stay with the original when you crop, straighten or turn it.</p>
      <div class="crop-work"><div class="crop-stage"><div class="mask-card"><img src="${P(photo.id)}" alt="Photo to adjust" draggable="false"></div></div>
      <form class="crop-controls mask-controls rail-card"><fieldset><legend>Adjustment masks</legend><div class="mask-layers"></div><button type="button" class="btn ghost" data-add-mask>Add mask</button></fieldset>
        <div class="mask-settings"><label>Mask name<input name="mask-name" maxlength="80"></label>
        <div class="mask-tools"><button type="button" class="btn" data-brush="paint">Brush</button><button type="button" class="btn ghost" data-brush="erase">Erase</button><button type="button" class="btn ghost" data-mask-undo>Undo mask edit</button></div>
        <label>Brush size <output></output><input type="range" name="brush-size" min="0.2" max="100" step="0.2" value="10"></label>
        <label>Feather <output></output><input type="range" name="feather" min="0" max="1" step="0.01"></label>
        <label>Opacity <output></output><input type="range" name="opacity" min="0" max="1" step="0.01"></label>
        ${Object.entries(PhotoFinish.local).map(([key,[lo,hi]])=>`<label>${key==='saturation'?'Colour':key[0].toUpperCase()+key.slice(1)} <output></output><input name="${key}" type="range" min="${lo}" max="${hi}" step="0.01" data-local="${key}"></label>`).join('')}
        <div class="mask-tools"><button type="button" class="btn ghost" data-fill-mask>Fill mask</button><button type="button" class="btn ghost" data-clear-mask>Clear painting</button></div></div>
        <label class="mask-check"><input name="show-mask" type="checkbox" checked>Show painted area</label>
        <p class="crop-error" role="alert"></p><div class="crop-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary" disabled>Apply masks</button></div></form></div>`;
    document.body.append(dialog);this.dialog=dialog;
    const card=$('.mask-card',dialog),img=$('img',card),form=$('form',dialog),apply=$('[type=submit]',form),error=$('.crop-error',form),turn=photo.edits?.rotate||0;
    card.dataset.photo=photo.id;Cards.focus(card);
    const paint=document.createElement('div');paint.className='mask-paint';paint.tabIndex=0;paint.setAttribute('aria-label','Paint mask. B selects brush; E selects eraser.');
    paint.innerHTML='<canvas class="mask-overlay"></canvas><div class="mask-brush" hidden></div>';card.append(paint);
    const overlay=$('canvas',paint),cursor=$('.mask-brush',paint),history=[];
    let layers=structuredClone(photo.edits?.masks||[]),selected=layers[0]?.id,tool='paint',stroke=null,beforeRange=null,ready=false,saving=false,frame=0,revision=0;
    const layer=()=>layers.find(l=>l.id===selected),snapshot=()=>structuredClone(layers),remember=state=>{history.push(state||snapshot());if(history.length>30)history.shift();};
    const add=()=>{layers.push({id:crypto.randomUUID(),name:`Mask ${layers.length+1}`,enabled:true,opacity:1,feather:.25,adjust:{exposure:.5},strokes:[]});selected=layers.at(-1).id;};
    if(!layers.length)add();
    const render=()=>{
      $('.mask-layers',form).innerHTML=layers.map(l=>`<div class="mask-layer"><button type="button" class="btn ghost" data-mask-enabled="${esc(l.id)}" aria-label="${l.enabled?'Disable':'Enable'} ${esc(l.name)}" aria-pressed="${l.enabled}">${l.enabled?'◉':'○'}</button><button type="button" class="btn ghost" data-select-mask="${esc(l.id)}" aria-pressed="${l.id===selected}">${esc(l.name)}</button><button type="button" class="btn ghost" data-delete-mask="${esc(l.id)}" aria-label="Delete ${esc(l.name)}">×</button></div>`).join('');
      $('[data-add-mask]',form).disabled=layers.length>=8;$('.mask-settings',form).hidden=!layer();
      for(const b of $$('[data-select-mask]',form))b.onclick=()=>{selected=b.dataset.selectMask;render();schedule();};
      for(const b of $$('[data-mask-enabled]',form))b.onclick=()=>{remember();const l=layers.find(l=>l.id===b.dataset.maskEnabled);l.enabled=!l.enabled;render();schedule();};
      for(const b of $$('[data-delete-mask]',form))b.onclick=()=>{remember();layers=layers.filter(l=>l.id!==b.dataset.deleteMask);selected=layers[0]?.id;render();schedule();};
      if(layer()){
        form.elements['mask-name'].value=layer().name;
        for(const input of $$('[data-local],[name=opacity],[name=feather]',form))input.value=String(input.dataset.local?(layer().adjust[input.name]??PhotoFinish.local[input.name][2]):layer()[input.name]);
      }
      for(const input of $$('input[type=range]',form))label(input);
      for(const b of $$('[data-brush]',form))b.setAttribute('aria-pressed',String(b.dataset.brush===tool));
      $('[data-mask-undo]',form).disabled=!history.length;
    };
    const label=input=>{const output=input.parentElement.querySelector('output');if(output)output.textContent=input.name==='brush-size'?`${Number(input.value)}%`:input.name==='exposure'?`${Number(input.value)>0?'+':''}${Number(input.value).toFixed(2)} EV`:['opacity','feather','saturation'].includes(input.name)?`${Math.round(Number(input.value)*100)}%`:Number(input.value).toFixed(2);};
    const draw=()=>{
      frame=0;if(!ready||!dialog.open)return;
      framePhoto(card,{dims:[photo.width,photo.height]},{crop:'off',rotate:turn,straighten:0,enhance:photo.edits?.enhance??S.filter,knobs:photo.edits?.look,
        finishing:{grade:photo.edits?.grade,masks:layers}});
      const r=img.getBoundingClientRect(),c=card.getBoundingClientRect();
      Object.assign(paint.style,{left:`${r.left-c.left}px`,top:`${r.top-c.top}px`,width:`${r.width}px`,height:`${r.height}px`});
      overlay.hidden=!form.elements['show-mask'].checked||!layer();
      if(!overlay.hidden){
        const serial=++revision,proof=new Image();proof.onload=()=>{
          if(serial!==revision||!dialog.open)return;
          overlay.width=Math.max(1,Math.round(r.width*(devicePixelRatio||1)));overlay.height=Math.max(1,Math.round(r.height*(devicePixelRatio||1)));
          const ctx=overlay.getContext('2d'),w=overlay.width,h=overlay.height;ctx.translate(w/2,h/2);ctx.rotate(turn*Math.PI/180);
          ctx.drawImage(proof,-(turn%180?h:w)/2,-(turn%180?w:h)/2,turn%180?h:w,turn%180?w:h);
          ctx.globalCompositeOperation='source-in';ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#ff4b79';ctx.fillRect(0,0,w,h);
        };proof.src=PhotoFinish.mask(layer(),[photo.width,photo.height]);
      }else revision++;
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(draw);};
    const point=e=>{const r=paint.getBoundingClientRect(),x=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y=Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));
      return rotateBox([x,y,0,0],(360-turn)%360).slice(0,2).map(v=>Number(v.toFixed(6)));};
    const move=e=>{const r=paint.getBoundingClientRect(),diameter=Number(form.elements['brush-size'].value)/100*Math.min(r.width,r.height);
      cursor.hidden=false;Object.assign(cursor.style,{left:`${e.clientX-r.left}px`,top:`${e.clientY-r.top}px`,width:`${diameter}px`,height:`${diameter}px`});};
    paint.onpointerdown=e=>{
      if(e.button||!ready||saving||!layer())return;e.preventDefault();e.stopPropagation();
      if(layer().strokes.length>=200||layers.reduce((n,l)=>n+l.strokes.reduce((n,s)=>n+s.p.length,0),0)>=39000){error.textContent='This mask has reached its brush detail limit. Clear some painting or start another photo.';return;}
      remember();stroke={mode:e.altKey?'erase':tool,r:Number(form.elements['brush-size'].value)/200,p:[point(e)]};layer().strokes.push(stroke);paint.setPointerCapture(e.pointerId);move(e);schedule();
    };
    paint.onpointermove=e=>{move(e);if(!stroke||!paint.hasPointerCapture(e.pointerId))return;
      const p=point(e),last=stroke.p.at(-1);if(Math.hypot(p[0]-last[0],p[1]-last[1])>.001&&stroke.p.length<1000){stroke.p.push(p);schedule();}};
    const release=e=>{if(!stroke)return;stroke=null;if(paint.hasPointerCapture(e.pointerId))paint.releasePointerCapture(e.pointerId);render();schedule();};
    for(const type of ['pointerup','pointercancel','lostpointercapture'])paint.addEventListener(type,release);
    paint.onpointerleave=()=>{if(!stroke)cursor.hidden=true;};
    paint.onkeydown=e=>{if(['b','e'].includes(e.key.toLowerCase())){tool=e.key.toLowerCase()==='e'?'erase':'paint';e.preventDefault();render();}};
    for(const b of $$('[data-brush]',form))b.onclick=()=>{tool=b.dataset.brush;render();};
    $('[data-add-mask]',form).onclick=()=>{if(layers.length<8){remember();add();render();schedule();}};
    $('[data-mask-undo]',form).onclick=()=>{if(history.length){layers=history.pop();if(!layer())selected=layers[0]?.id;render();schedule();}};
    $('[data-clear-mask]',form).onclick=()=>{remember();layer().strokes=[];render();schedule();};
    $('[data-fill-mask]',form).onclick=()=>{remember();const points=[];for(let y=0;y<=1;y+=.1)points.push([0,Number(y.toFixed(1))],[1,Number(y.toFixed(1))]);layer().strokes=[{mode:'paint',r:.5,p:points}];render();schedule();};
    form.elements['mask-name'].onchange=()=>{remember();layer().name=form.elements['mask-name'].value.trim()||'Mask';render();};
    for(const input of $$('input[type=range]',form)){
      input.oninput=()=>{label(input);if(input.name==='brush-size')return;if(!layer())return;beforeRange||=snapshot();
        if(input.dataset.local)layer().adjust[input.name]=Number(input.value);else layer()[input.name]=Number(input.value);schedule();};
      input.onchange=()=>{if(beforeRange){remember(beforeRange);beforeRange=null;render();}};
    }
    form.elements['show-mask'].onchange=schedule;
    form.onsubmit=async e=>{e.preventDefault();if(!ready||saving||stroke)return;saving=true;apply.disabled=true;error.textContent='';
      for(const el of form.elements)el.disabled=true;
      try{if(await save({masks:layers.length?layers:null})===false)throw new Error('Couldn’t save these masks. Your painting is still here; try again.');dialog.close();}
      catch(e){error.textContent=e.message;}finally{saving=false;for(const el of form.elements)el.disabled=false;render();}
    };
    for(const b of $$('[data-cancel]',dialog))b.onclick=()=>{if(!saving)dialog.close();};
    dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});
    dialog.addEventListener('keydown',e=>{if(!saving&&!e.repeat&&e.key.toLowerCase()==='z'&&!e.target.closest('input,textarea,select')&&!e.ctrlKey&&!e.metaKey){e.preventDefault();$('[data-mask-undo]',form).click();}e.stopPropagation();});dialog.addEventListener('pointerdown',e=>e.stopPropagation());
    const resize=new ResizeObserver(schedule);resize.observe(card);
    const loaded=()=>{ready=true;apply.disabled=false;schedule();};img.addEventListener('load',loaded,{once:true});if(img.complete&&img.naturalWidth)loaded();
    const leave=()=>dialog.close();window.addEventListener('hashchange',leave,{once:true});
    dialog.addEventListener('close',()=>{resize.disconnect();cancelAnimationFrame(frame);window.removeEventListener('hashchange',leave);dialog.remove();if(this.dialog===dialog)this.dialog=null;},{once:true});
    dialog.showModal();render();schedule();
  }
};
