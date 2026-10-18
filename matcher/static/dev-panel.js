// The developer panel (python -m matcher --debug, or ?debug=1 once in the address bar): the sea's macro order,
// micro order, renderer and camera knobs, live, with Export so a tuning session can be handed back as JSON.
const DevPanel = {
  init() {
    if (this.el) return;
    this.el = document.createElement("aside");
    this.el.id = "dev-panel"; this.el.setAttribute("aria-label", "Developer panel");
    try { this.open = localStorage.getItem("matcher-dev-open") !== "0"; } catch (_) { this.open = true; }
    document.body.append(this.el);
    this.render();
    this.statsTimer = setInterval(() => this.stats(), 500);
    document.addEventListener("keydown", (e) => { if (e.key === "F2") { e.preventDefault(); this.toggle(); } });
  },
  sea() { return typeof World !== "undefined" ? World.sea : null; },
  values() { return this.sea()?.tuning || seaTuningDefaults(); },
  changed() { const d = seaTuningDefaults(), v = this.values(), out = {}; for (const k of Object.keys(d)) if (v[k] !== d[k]) out[k] = v[k]; return out; },
  toggle(open = !this.open) {
    this.open = open; this.el.classList.toggle("collapsed", !open);
    try { localStorage.setItem("matcher-dev-open", open ? "1" : "0"); } catch (_) { /* private mode */ }
  },
  render() {
    const groups = [["macro", "Macro: visual geography"], ["micro", "Micro: boid mechanics"], ["waves", "Waves"], ["render", "Render"], ["camera", "Camera"], ["wobble", "Wobble"]];
    const v = this.values();
    const row = (p) => `<label class="dev-row" data-key="${p.key}" title="${esc(p.hint || "")}">
        <span class="dev-label">${esc(p.label)}</span>
        <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${v[p.key]}" aria-label="${esc(p.label)}">
        <input type="number" class="dev-num" min="${p.min}" max="${p.max}" step="${p.step}" value="${v[p.key]}" aria-label="${esc(p.label)} value">
        <button type="button" class="dev-reset" title="Back to the default (${p.value})" aria-label="Reset ${esc(p.label)}">↺</button></label>`;
    this.el.innerHTML = `<header class="dev-head"><button type="button" class="dev-toggle" aria-label="Collapse or expand the developer panel">DEV</button>
        <span class="dev-stats" aria-live="off"></span></header>
      <div class="dev-body">
        <p class="dev-note">Live on the sea. Values stay in this browser until Reset. <b>Export</b> copies JSON to the clipboard and downloads it.</p>
        <div class="dev-actions"><button type="button" class="btn primary" data-dev="export">Export</button><button type="button" class="btn" data-dev="import">Import</button><button type="button" class="btn ghost" data-dev="reset">Reset all</button><button type="button" class="btn ghost" data-dev="settle">Wake sea</button></div>
        ${groups.map(([g, title]) => `<details open class="dev-group" data-group="${g}"><summary>${title}</summary>${SEA_TUNING.filter((p) => p.group === g).map(row).join("")}</details>`).join("")}
        <textarea class="dev-import" hidden rows="6" placeholder='Paste exported JSON, then press Apply' aria-label="Tuning JSON"></textarea>
        <div class="dev-import-actions" hidden><button type="button" class="btn primary" data-dev="apply">Apply</button><button type="button" class="btn ghost" data-dev="cancel">Cancel</button></div>
      </div>`;
    this.el.classList.toggle("collapsed", !this.open);
    this.el.querySelector(".dev-toggle").onclick = () => this.toggle();
    for (const label of this.el.querySelectorAll(".dev-row")) {
      const key = label.dataset.key, range = label.querySelector("input[type=range]"), num = label.querySelector(".dev-num");
      const apply = (value) => { const n = Number(value); if (!Number.isFinite(n)) return; range.value = n; num.value = n; this.set(key, n); };
      range.oninput = () => apply(range.value); num.onchange = () => apply(num.value);
      label.querySelector(".dev-reset").onclick = () => apply(SEA_TUNING.find((p) => p.key === key).value);
    }
    this.el.querySelector("[data-dev=export]").onclick = () => this.export();
    this.el.querySelector("[data-dev=reset]").onclick = () => { this.sea()?.tuneReset(); this.refresh(); toast("Tuning back to the defaults."); };
    this.el.querySelector("[data-dev=settle]").onclick = () => { const sea = this.sea(); if (sea) { sea.worker?.postMessage({ kind: "tune", values: sea.tuning }); sea.kick(); } };
    const box = this.el.querySelector(".dev-import"), actions = this.el.querySelector(".dev-import-actions");
    this.el.querySelector("[data-dev=import]").onclick = () => { box.hidden = actions.hidden = false; box.focus(); };
    this.el.querySelector("[data-dev=cancel]").onclick = () => { box.hidden = actions.hidden = true; };
    this.el.querySelector("[data-dev=apply]").onclick = () => {
      try { const parsed = JSON.parse(box.value), values = parsed.tuning || parsed.changed || parsed; this.sea()?.tune(values); this.refresh(); box.hidden = actions.hidden = true; toast("Tuning applied."); }
      catch (e) { toast(`Not valid JSON: ${e.message}`); }
    };
    // The panel's own keys never reach the game.
    this.el.addEventListener("keydown", (e) => e.stopPropagation());
    this.el.addEventListener("wheel", (e) => e.stopPropagation());
  },
  set(key, value) { const sea = this.sea(); if (sea) sea.tune({ [key]: value }); },
  refresh() {
    const v = this.values();
    for (const label of this.el.querySelectorAll(".dev-row")) { const k = label.dataset.key; label.querySelector("input[type=range]").value = v[k]; label.querySelector(".dev-num").value = v[k]; }
  },
  stats() {
    const sea = this.sea(), out = this.el?.querySelector(".dev-stats"); if (!out) return;
    if (!sea) { out.textContent = "no sea"; return; }
    const c = sea.camera || { zoom: 1 };
    const d = sea.densityStats || {}, drawn = (sea.moving?.length || 0) + (d.dots || 0) + (d.raster || 0) + (d.cards || 0) + (d.blank || 0) + (d.gpu || 0);
    out.textContent = `${fmt(sea.items.size)} prints · ${fmt(sea.moving?.length || 0)} live · drawn ${fmt(drawn)}${d.gpu ? ` (${fmt(d.gpu)} on the GPU)` : ""}${d.blank ? ` (${fmt(d.blank)} blank)` : ""} · ${sea.settled ? "settled" : "moving"} · zoom ${c.zoom.toFixed(2)} · worker ${Math.round(sea.workerMs || 0)}ms`;
  },
  async export() {
    const sea = this.sea(), payload = { version: 1, when: new Date().toISOString(), library: S.lib?.save?.name || null, prints: sea?.items.size || 0,
      changed: this.changed(), tuning: this.values() };
    const text = JSON.stringify(payload, null, 2);
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (_) { /* clipboard blocked: the download still happens */ }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `matcher-sea-tuning-${payload.when.slice(0, 19).replace(/[:T]/g, "-")}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(copied ? "Tuning copied to the clipboard and downloaded." : "Tuning downloaded (clipboard blocked).");
    return payload;
  },
};
