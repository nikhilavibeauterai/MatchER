// Every photo in MatchER is the same polaroid card. This is the one place that touches all of them, laid over the
// markup and the physics: a bare image in a row or a button gets a `.card` wrapper, so its paper is sized by the
// card and not by whatever it sits in, and every card gets its own wobble phase, so cards breathe out of step.
const Cards = {
  SELECTOR: 'img[src^="/img/t/"], img[src^="/img/p/"]',
  // Boxes that already are the card: the image fills them and their paper is sized by them.
  HOSTS: ".ps-item, .print, .window, .picture, .shot-select, .tile, .ftile, .bulk-tile, .filter-take, .crown-card, .pod-photo, .tb-seat, .mf, .bchamp, .polaroid, .up-next, .rank-pop, .save-chip",
  // One little count slip, held to a pile by a metal paperclip. The same face fits an editor's Open button.
  stackFace(count) {
    const n=Math.max(0,Math.floor(Number(count)||0));
    return `<span class="stack-slip" aria-hidden="true" style="--stack-digits:${String(n).length}">${n}</span><svg class="stack-paperclip" viewBox="0 0 40 100" aria-hidden="true" focusable="false" fill="none"><path class="clip-shadow" d="M26 24v52a8 8 0 0 1-16 0V20a12 12 0 0 1 24 0v57a16 16 0 0 1-32 0V29"/><path class="clip-wire" d="M26 24v52a8 8 0 0 1-16 0V20a12 12 0 0 1 24 0v57a16 16 0 0 1-32 0V29"/><path class="clip-shine" d="M25 25v51a7 7 0 0 1-14 0V20a11 11 0 0 1 22 0v57"/></svg>`;
  },
  stack(count, photo = null) {
    const n=Math.max(0,Math.floor(Number(count)||0)),pid=Math.floor(Number(photo)||0);
    return n>1?pid>0?`<button type="button" class="ps-stack stack-clip" data-open-stack="${pid}" aria-label="Pull up all ${n} takes" title="Pull up the whole stack">${this.stackFace(n)}</button>`:
      `<span class="ps-stack stack-clip" role="img" aria-label="Stack of ${n} takes">${this.stackFace(n)}</span>`:'';
  },
  init() {
    if (this.observer) return;
    this.observer = new MutationObserver((records) => { for (const r of records) for (const node of r.addedNodes) if (node.nodeType === 1) this.dress(node); });
    this.observer.observe(document.body, { childList: true, subtree: true });
    // A clip is a separate handle: opening the pile must never also pan, select its cover or cast a vote.
    for(const type of ['pointerdown','click','dblclick','keydown'])document.addEventListener(type,e=>{
      const clip=e.target.closest?.('[data-open-stack]');if(!clip)return;
      if(type==='keydown'&&!['Enter',' '].includes(e.key))return;
      e.stopImmediatePropagation();
      if(type==='click'){e.preventDefault();World.openStack(Number(clip.dataset.openStack),clip.closest('.print,.ps-item'));}
      else if(type==='dblclick'||type==='keydown'&&e.repeat)e.preventDefault();
    },true);
    this.dress(document.body);
  },
  dress(root) {
    if (root.matches?.(this.SELECTOR)) this.one(root);
    for (const img of root.querySelectorAll?.(this.SELECTOR) || []) this.one(img);
    if (root.matches?.(".paper")) this.phase(root, root.closest("[data-photo]")?.dataset.photo || "");
    for (const paper of root.querySelectorAll?.(".paper") || []) this.phase(paper, paper.closest("[data-photo]")?.dataset.photo || "");
  },
  // Three unit randoms per card from a generator seeded by the photo's id (so the same thumbnail always wobbles
  // the same way): --r1 picks where in the cycle it starts, --r2 its speed, --r3 its force. The CSS turns them
  // into offsets around the tunable bases, so the panel's knobs apply live.
  phase(el, key) {
    if (el.style.getPropertyValue("--r1")) return;
    const id = Number(String(key).match(/\d+/)?.[0]);
    let seed = (Number.isFinite(id) ? id * 2654435761 : 0) >>> 0;
    if (!Number.isFinite(id)) for (const ch of String(key)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const next = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    el.style.setProperty("--r1", next().toFixed(4)); el.style.setProperty("--r2", next().toFixed(4)); el.style.setProperty("--r3", next().toFixed(4));
  },
  // The wobble's bases and spreads come from the sea's tuning (the developer panel's Wobble group).
  tune(values) {
    const root = document.documentElement.style, v = values || {};
    if (v.focusGlowStrength != null) root.setProperty('--focus-glow-strength', v.focusGlowStrength);
    if (v.wobblePeriod != null) root.setProperty("--wobble-period", `${v.wobblePeriod}s`);
    if (v.wobbleDeg != null) root.setProperty("--wobble-deg", `${v.wobbleDeg}deg`);
    if (v.wobbleDelaySpread != null) root.setProperty("--wobble-delay-spread", v.wobbleDelaySpread);
    if (v.wobbleSpeedSpread != null) root.setProperty("--wobble-speed-spread", v.wobbleSpeedSpread);
    if (v.wobbleForceSpread != null) root.setProperty("--wobble-force-spread", v.wobbleForceSpread);
  },
  one(img) {
    if (img.dataset.card) return;
    img.dataset.card = "1";
    const key = (img.getAttribute("src") || "").replace(/\?.*/, "");
    this.phase(img, key);
    const focus=img.parentElement;
    if(focus?.matches('.print:not(.world-fly)')&&!img.matches('.under,.world-fly'))this.focus(focus);
    // A card with notes stuck on it wobbles as a group: the group takes its own photo's phase (app.css animates it).
    const group = (img.classList.contains("pile-cover") || img.closest(".window")) && img.closest(".tile-pile");
    if (group) this.phase(group, group.dataset.photo || key);
    if (img.classList.contains("pile-take") || img.classList.contains("world-fly") || img.closest(this.HOSTS)) return;
    const span = document.createElement("span");
    span.className = "polaroid";
    img.replaceWith(span);
    span.append(img);
    img.dataset.box??='null';queueMicrotask(()=>frameTileImage(img));
  },
  // Every focused picture gets the same paper and clipped window, including the large Stacks viewer, Tag check,
  // the inspector and the sorting games. Their marks and sticky notes stay on the outer card.
  focus(host) {
    if(host.querySelector(':scope > .paper'))return;
    const img=host.querySelector(':scope > img:not(.under)');if(!img)return;
    const paper=document.createElement('div'),win=document.createElement('div');paper.className='paper';win.className='window';
    img.replaceWith(paper);paper.append(win);win.append(img);host.classList.add('framed-photo');
    if(!host.matches('.print,.ps-item'))host.style.aspectRatio='3 / 4';
    img.style.cssText='position:absolute;width:100%;height:100%;object-fit:contain;object-position:center top';
    this.phase(paper,host.dataset.photo||img.getAttribute('src'));
  },
};
if (typeof document !== "undefined" && document.body) { Cards.init(); if (typeof seaTuningDefaults === "function") Cards.tune(seaTuningDefaults()); }
if (typeof module !== "undefined") module.exports = { Cards };
