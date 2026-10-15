// Every photo in MatchER is the same polaroid card. This is the one place that touches all of them, laid over the
// markup and the physics: a bare image in a row or a button gets a `.card` wrapper, so its paper is sized by the
// card and not by whatever it sits in, and every card gets its own wobble phase, so cards breathe out of step.
const Cards = {
  SELECTOR: 'img[src^="/img/t/"], img[src^="/img/p/"]',
  // Boxes that already are the card: the image fills them and their paper is sized by them.
  HOSTS: ".ps-item, .print, .window, .picture, .shot-select, .tile, .ftile, .bulk-tile, .filter-take, .crown-card, .pod-photo, .tb-seat, .mf, .bchamp, .polaroid, .up-next, .rank-pop, .save-chip",
  init() {
    if (this.observer) return;
    this.observer = new MutationObserver((records) => { for (const r of records) for (const node of r.addedNodes) if (node.nodeType === 1) this.dress(node); });
    this.observer.observe(document.body, { childList: true, subtree: true });
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
    // A card with notes stuck on it wobbles as a group: the group takes its own photo's phase (app.css animates it).
    const group = (img.classList.contains("pile-cover") || img.closest(".window")) && img.closest(".tile-pile");
    if (group) this.phase(group, group.dataset.photo || key);
    if (img.classList.contains("pile-take") || img.classList.contains("world-fly") || img.closest(this.HOSTS)) return;
    const span = document.createElement("span");
    span.className = "polaroid";
    img.replaceWith(span);
    span.append(img);
  },
};
if (typeof document !== "undefined" && document.body) { Cards.init(); if (typeof seaTuningDefaults === "function") Cards.tune(seaTuningDefaults()); }
if (typeof module !== "undefined") module.exports = { Cards };
