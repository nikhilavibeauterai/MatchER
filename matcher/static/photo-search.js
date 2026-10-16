// A library-wide search: visual phrases, tag names, file names and the writing kept with each take.
const PhotoSearchUI={
  init(){
    const form=document.createElement('form');form.id='photo-search';form.className='photo-search';form.dataset.solid='';
    form.innerHTML='<span aria-hidden="true">⌕</span><input type="search" maxlength="200" placeholder="Search photos…" aria-label="Search photos" autocomplete="off" aria-controls="photo-search-results" aria-expanded="false">';
    const pane=document.createElement('aside');pane.id='photo-search-results';pane.className='photo-search-results rail-card';pane.dataset.solid='';pane.hidden=true;
    document.body.append(form,pane);this.form=form;this.pane=pane;this.input=$('input',form);
    form.onsubmit=e=>{e.preventDefault();clearTimeout(this.timer);this.find();};
    this.input.oninput=()=>{clearTimeout(this.timer);if(!this.input.value.trim()){this.close();return;}this.timer=setTimeout(()=>this.find(),350);};
    this.input.onfocus=()=>{if(typeof PhotoNotes!=='undefined')PhotoNotes.close(false);};
    const keys=e=>{if(e.key==='Escape'){e.preventDefault();this.close();this.input.blur();}e.stopPropagation();};
    form.onkeydown=pane.onkeydown=keys;
    document.addEventListener('keydown',e=>{
      if(!form.hidden&&((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'||e.key==='/'&&!e.target.closest('input,textarea,select')&&!e.target.isContentEditable)){
        if($('dialog[open]'))return;e.preventDefault();e.stopPropagation();this.input.focus();this.input.select();
      }
    });
    document.addEventListener('pointerdown',e=>{if(!form.contains(e.target)&&!pane.contains(e.target))this.close();});
    window.addEventListener('hashchange',()=>{this.close();setTimeout(()=>this.sync(),0);});
    new MutationObserver(()=>this.sync()).observe($('#main'),{childList:true});this.sync();
  },
  sync(){
    this.form.hidden=!S.lib?.analyzed||S.lib?.analyzing||!!$('#main .onboard,#main .saves');
    if(this.source!==S.lib?.source){this.source=S.lib?.source;this.input.value='';this.close();}
  },
  close(){clearTimeout(this.timer);this.serial=(this.serial||0)+1;this.pane.hidden=true;this.input.setAttribute('aria-expanded','false');},
  async find(){
    const query=this.input.value.trim();if(!query)return this.close();
    const serial=(this.serial||0)+1,source=S.lib?.source;this.serial=serial;
    this.pane.hidden=false;this.input.setAttribute('aria-expanded','true');this.pane.innerHTML='<p role="status">Finding your photos…</p>';
    try{
      const data=await api(`/api/search?q=${encodeURIComponent(query)}`);
      if(serial!==this.serial||source!==S.lib?.source)return;
      this.pane.innerHTML=`<div class="row spread"><p role="status">${data.photos.length?`Closest photos for “${esc(query)}”`:'No photos to search yet.'}</p><button class="btn" aria-label="Close search results">×</button></div>
        <div class="search-photos">${data.photos.map(p=>`<button type="button" data-search-photo="${p.photo}" aria-label="Open ${esc(p.title||p.rel)}"><img src="${T(p.photo)}" alt="" loading="lazy" draggable="false"><span>${esc(p.title||p.rel.split(/[\\/]/).at(-1))}</span>${p.cut?'<small>Set aside</small>':''}</button>`).join('')}</div>`;
      $('.row button',this.pane).onclick=()=>{this.close();this.input.focus();};
      for(const button of $$('[data-search-photo]',this.pane))button.onclick=()=>{const photo=Number(button.dataset.searchPhoto);this.close();openViewer(photo);};
    }catch(e){if(serial===this.serial)this.pane.innerHTML=`<p role="alert">${esc(e.message)}</p>`;}
  }
};
PhotoSearchUI.init();
