// History appears when asked for, showing real reversible changes rather than replaying a vote.
const HistoryHUD = {
  timer:null, generation:0, history:null, mode:'draw', node:null,
  label(entry) {
    const names={'filter keep':'Keep this take','filter aside':'Set aside this take','filter reset':'Follow rules',
      'filter tune toward':'Keep and learn more like this','filter tune away':'Set aside and learn less like this',
      'filter apply':'Apply the filter','filter complete':'Continue from Filter',threshold:'Move the dividing line'};
    return names[entry.label] || (typeof DRAW_WORD!=='undefined'&&DRAW_WORD[entry.label]) || entry.label || 'Last change';
  },
  async reply(path,data) {
    if(!['/api/undo','/api/redo','/api/draw/undo','/api/draw/redo'].includes(path)){
      const preview=['/api/filter/preview','/api/filter/learn','/api/filter/review'].includes(path);
      if(!preview&&(data?.undo!==undefined||['/api/vote','/api/frame','/api/sweep','/api/finals/vote'].includes(path))){this.photoEdit=data?.undo==='edit';this.history=null;this.generation++;this.hide();}
      return;
    }
    const generation=++this.generation,source=S.lib?.source;
    this.mode=path.startsWith('/api/draw/')?'draw':'vote';
    try{
      const history=data.history||await api(this.mode==='draw'?'/api/draw/history':`/api/history?stage=${encodeURIComponent(S.stage||'')}`);
      if(generation===this.generation&&source===S.lib?.source)this.present({...history,undo_stream:this.mode,redo_stream:this.mode});
    }catch(_){/* A read failure must not repeat the history edit. */}
  },
  present(history,notice=null) {
    this.history=history;this.photoEdit=history.undo?.label==='edit';this.generation++;
    if(!this.node){this.node=document.createElement('aside');this.node.id='history-hud';this.node.setAttribute('aria-label','Undo and redo');document.body.append(this.node);
      this.node.addEventListener('pointerenter',()=>clearTimeout(this.timer));this.node.addEventListener('pointerleave',()=>this.arm());
      this.node.addEventListener('focusin',()=>clearTimeout(this.timer));this.node.addEventListener('focusout',()=>this.arm());}
    const card=(key,entry)=>entry?`<button class="history-action" data-history="${key}" aria-label="${key==='undo'?'Undo':'Redo'}: ${esc(this.label(entry))}"><span class="history-direction">${key==='undo'?'↶':'↷'}</span>${entry.photo?`<img src="${T(entry.photo)}" alt="">`:''}<span><b>${key==='undo'?'Undo':'Redo'}</b><small>${esc(this.label(entry))}</small></span></button>`:'';
    this.node.innerHTML=card('undo',history.undo)+card('redo',history.redo)+(notice?`<span class="history-notice">${esc(notice.label)}</span>`:'');
    this.node.hidden=!this.node.childElementCount;
    $$('[data-history]',this.node).forEach(button=>button.onclick=()=>this.act(button.dataset.history));
    this.arm();
  },
  arm(){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(this.node&&!this.node.matches(':hover,:focus-within'))this.node.hidden=true;},6500);},
  hide(){clearTimeout(this.timer);if(this.node)this.node.hidden=true;},
  async act(kind){
    if(this.checking){this.checkQueued=kind;return;}
    if(this.photoEdit===false&&!Toolbelt.saving.size&&this.history?.[kind]?.label!=='edit')return this.local(kind);
    // Marks live in the shared editor history even while a tournament is on screen. Prefer that latest edit over
    // the game's older vote, and wait for a stroke still being saved before deciding what Z should undo.
    if(!S.busy||typeof Toolbelt!=='undefined'&&Toolbelt.saving.size){
      this.checking=true;
      const view=S.view,source=S.lib?.source;
      try{
        if(typeof Toolbelt!=='undefined')await Toolbelt.flush();
        const history=await api('/api/history?stage=home');if(left(view)||source!==S.lib?.source)return;
        if(history[kind]?.label==='edit'&&history[`${kind}_stream`]==='group'){
          const photo=history[kind].photo,reply=await api(`/api/draw/${kind}`,{});
          if(left(view)||source!==S.lib?.source)return;
          const saved=await api(`/api/edit?photo=${photo}`);if(left(view))return;
          Toolbelt.know(photo,saved.edits||{});updateHudQuiet(reply.game);refreshHud(true);
          // A finishing change can also turn or crop the Leaderboard's photo. Rebuild that still card; a duel
          // keeps the exact pair and sides it was showing while only its annotations are repainted.
          if($('.screen.board'))route();
          const next=await api('/api/history?stage=home');if(source===S.lib?.source)this.present(next);
          return;
        }
      }catch(error){toast(error.message);return;}
      finally{
        this.checking=false;
        const queued=this.checkQueued;this.checkQueued=null;
        if(queued&&source===S.lib?.source)queueMicrotask(()=>this.act(queued));
      }
    }
    return this.local(kind);
  },
  local(kind){
    if(S.historyActions?.[kind])return S.historyActions[kind]();
    if(kind==='undo'){
      const event=new KeyboardEvent('keydown',{key:'z',cancelable:true});S.onKey?.(event);if(event.defaultPrevented)return;
      if(location.hash.startsWith('#duel'))return undo();
    }
    return this.fallback(kind);
  },
  async fallback(kind){
    if(this.busy){this.queued=kind;return;}this.busy=true;
    const view=S.view,source=S.lib?.source;
    try{
      const history=kind==='redo'&&this.history?.redo?this.history:await api('/api/history?stage=home');if(left(view)||!history[kind])return;
      this.mode=(history[`${kind}_stream`]||history.stream)==='vote'?'vote':'draw';
      const reply=await api(this.mode==='draw'?`/api/draw/${kind}`:`/api/${kind}`,{stage:S.stage});if(left(view))return;
      updateHudQuiet(reply.game||reply.progress?.game);World.dirty();route();
      const refreshed=S.view,next=await api('/api/history?stage=home');if(!left(refreshed))this.present(next);
    }
    catch(error){toast(error.message);}
    finally{this.busy=false;const queued=this.queued;this.queued=null;if(queued&&source===S.lib?.source)this.fallback(queued);}
  }
};
document.addEventListener('keydown',event=>{
  if(event.key.toLowerCase()!=='z'||!event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.target.isContentEditable||event.target.closest('input,textarea,select,dialog')||$('dialog[open]'))return;
  event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)HistoryHUD.act('redo');
},true);
window.addEventListener('hashchange',()=>HistoryHUD.hide());
