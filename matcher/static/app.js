"use strict";

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n || 0).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const plural = (n, word, many = `${word}s`) => `${fmt(n)} ${n === 1 ? word : many}`;
const imageKey = () => encodeURIComponent(S.lib?.image_key || 'local');
const P = (id) => `/img/p/${id}.jpg?v=${imageKey()}`;
const T = (id) => `/img/t/${id}.jpg?v=${imageKey()}`;
// The pyramid: the smallest stored halving of a photo (50, 100, 200, 400, 800, 1600 px) that still has a device
// pixel for every screen pixel of a card `cssPx` wide, so a print never decodes more than it shows. The thumbnail
// and preview addresses carry the level (`&m=`), so every rule that recognises a card still does.
const MIPS = [50, 100, 200, 400, 800, 1600];
// Only a caller that says so (a print filling four fifths of the screen) gets the original file; every other
// size stops at the preview.
const M = (id, cssPx, full = false) => {
  if (full) return `${P(id)}&m=full&rev=2`;  // bypass cached lossy conversions from earlier versions
  const need = Math.max(1, cssPx) * (devicePixelRatio || 1), level = MIPS.find((l) => l >= need) || 1600;
  return level === 1600 ? P(id) : level === 400 ? T(id) : level === 800 ? `${P(id)}&m=800` : `${T(id)}&m=${level}`;
};
const F = (id) => `/img/f/${id}.jpg?v=${imageKey()}`;
const groupHue = (id) => hueOf(`g${id}`);  // the lasso's hue (photo-sea.js), so a team keeps one colour everywhere

async function api(path, body) {
  const source=S.lib?.source||'';
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MatchER": "1" },
    body: JSON.stringify(body),
  };
  const displaySettings=path==='/api/settings'&&body&&Object.keys(body).length&&Object.keys(body).every(key=>['help','sea_axes'].includes(key));
  if(displaySettings)opts.keepalive=true;
  const r = await fetch(path, opts);
  let data = null;
  try { data = await r.json(); } catch (_) { /* not JSON */ }
  if (!r.ok) {
    const e = new Error((data && data.error) || r.statusText || "Request failed");
    e.status = r.status;
    if (r.status === 403 && /printed when it started/.test(e.message)) location.reload();  // cookie gone: show the lock page
    throw e;
  }
  // a change to what's in the cup, its groups, stacks or tags: the sea behind every screen catches up
  if (body !== undefined && !displaySettings && (/^\/api\/(draw|tags|groups|rescue|sweep|cup|settings|frame|undo|people)/.test(path)
    || /^\/api\/filter\/(apply|decision)$/.test(path) || path==="/api/stacks/auto" || path==="/api/vote"&&(data?.crowned||data?.swap)) && typeof World !== "undefined") World.dirty();
  if(body!==undefined&&path==='/api/vote'&&typeof World!=='undefined'&&[World.sea?.axes?.x,World.sea?.axes?.y].includes('ranking')){
    World.stale=true;World.photosSource=null;if(World.mode==='ambient')World.dirty();
  }
  if(body!==undefined&&path==="/api/undo")DuelSides.undo(data,source);
  if(body!==undefined&&path==='/api/edit'&&typeof Toolbelt!=='undefined'&&!Toolbelt.jobs.get(body.photo)?.length)
    Toolbelt.know(body.photo,data.edits||{});
  if(body!==undefined&&typeof HistoryHUD!=="undefined")HistoryHUD.reply(path,data);
  if(body!==undefined&&typeof window!=='undefined'&&/^\/api\/(edit|tags|groups|draw|rescue|undo|frame|vote|cup|sweep|people|stacks\/auto|filter\/(apply|decision))\b/.test(path))
    window.dispatchEvent(new CustomEvent('photo-changed',{detail:{path,source}}));
  return data;
}

let toastTimer = null;
// Routine confirmations explain themselves once per session; the undo chip in the HUD says the rest afterwards.
const toastedOnce = new Set();
function toastOnce(key, msg, ms) { if (toastedOnce.has(key)) return; toastedOnce.add(key); toast(msg, ms); }

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function askInGame(message, action = "Continue") {
  const m = $("#modal");
  m.className = "";
  m.onclick = null;
  m.innerHTML = `<h2>${esc(action)}</h2><p>${esc(message)}</p><div class="row spread">
    <button class="btn" data-answer="no">Back</button><button class="btn primary" data-answer="yes">${esc(action)}</button></div>`;
  return new Promise((resolve) => {
    let answer = false;
    m.addEventListener("close", () => resolve(answer), { once: true });
    $("[data-answer=no]",m).onclick = () => m.close();
    $("[data-answer=yes]",m).onclick = () => { answer = true; m.close(); };
    m.showModal();
  });
}

const LOCK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17 9h-1V7a4 4 0 1 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-7-2a2 2 0 1 1 4 0v2h-4V7z"/></svg>`;

const FLAG_LABELS = {
  eyes_closed: "eyes closed", one_eye: "mid-blink", group: "group", with_someone: "with someone",
  not_prominent: "not the focus", profile: "side profile", full_body: "full body", sunglasses: "sunglasses",
  smoking: "cigarette?", mirror_selfie: "mirror selfie", car: "car selfie", bathroom_bed: "bathroom/bed",
  nightlife: "nightlife", filter: "filter", dog: "dog", bw: "b&w", old: "older photo", dark: "dark",
  blurry: "blurry", text: "text / screen",
};
const TASTE_LABELS = {
  face_size: "your face filling the frame", eyes_closed: "eyes closed", one_eye: "mid-blink", smile: "smiling",
  frontal: "facing the camera", face_sharp: "a sharp face", exposure: "a well-lit face", dark: "dark photos",
  others: "other people in the shot", not_prominent: "someone else being the focus", sunglasses: "sunglasses",
  smoking: "a cigarette", mirror_selfie: "mirror selfies", car: "car selfies", bathroom_bed: "bathroom / bed shots",
  nightlife: "nightlife", outdoors: "outdoors in daylight", blurry: "blur", great: "polished, portrait-like shots",
  filter: "face filters", dog: "a dog in the shot", age: "older photos", low_res: "low resolution", bw: "black & white",
  aesthetic: "beautiful, well-composed shots", sharp: "crisp, sharp detail", colorful: "vivid colour",
  textish: "text and screens", accidental: "accidental-looking shots", people: "people", nature: "landscapes & nature",
  places: "places & cities", animals: "animals", food: "food & drink",
};
const MODE = () => (S.lib && S.lib.mode) || "me";
const tasteLabel = (f) => (MODE() === "gallery" && f === "exposure" ? "good exposure" : TASTE_LABELS[f]);
const QUESTION = {
  me: "Which one would make a stranger want to meet you?",
  gallery: "Which photo is better?",
};
const WARN_FLAGS = new Set(["eyes_closed", "one_eye", "sunglasses", "smoking", "filter", "not_prominent", "old"]);
const flagHtml = (flags) => (flags || []).filter((f) => FLAG_LABELS[f])
  .map((f) => `<span class="flag ${WARN_FLAGS.has(f) ? "warn" : ""}">${FLAG_LABELS[f]}</span>`).join("");

// ---------------------------------------------------------------- state + routing
const S = { lib: null, recent: [], poll: null, cards: [], current: null, shownAt: 0, busy: false, progress: null, milestone: 0,
  crop: (() => { try { return localStorage.getItem("matcher-crop") !== "off"; } catch (_) { return true; } })() };
const VIEWS = { onboard: viewOnboard, analyze: viewAnalyze, home: viewHome, ready: viewHome, filter: viewFilter, duel: viewDuel,
  shortlist: viewShortlist, leaderboard: viewShortlist, draw: viewDraw, cuts: viewCuts, people: viewPeople,
  sweep: viewSweep, finals: viewFinals, reveal: viewReveal, saves: viewSaves, stacks: viewStacks, tournament: viewTournament, tags: viewTags };

let stateRequest = 0;
async function loadState() {
  const request = ++stateRequest;
  const st = await api("/api/state");
  if (request !== stateRequest) return st;
  if (S.lib?.source !== st.library?.source) { S.journey = null; S.game = null; S.homeTag = null; }
  S.lib = st.library;
  const pending=readHelpPreference(S.lib);
  if(pending){S.lib.settings={...S.lib.settings,help:pending.value};saveHelpPreference(S.lib,pending.value);}
  S.recent = st.recent || [];
  return st;
}

function stopPolling() {
  if (S.poll) clearInterval(S.poll);
  S.poll = null;
}

function route() {
  stopPolling();
  closeHelp();
  clearTimeout(toastTimer);$('#toast').classList.remove('show');
  S.events?.abort();
  S.events = new AbortController();
  // Pending replies belong to the old screen; its input queue must leave with it.
  S.busy = false; S.queued = []; S.undoQueued = 0;
  if (S.lr) cancelAnimationFrame(S.lr.raf);
  S.lr = null; S.lrLevel = null;
  let [name, query] = location.hash.slice(1).split("?");
  if (name === "groups") name = "draw";  // the Draw grew out of the Groups page
  let v = name;
  const asked = new URLSearchParams(query || "");
  if (v === "saves" && S.recent.length) { /* the save screen works with or without a folder open */ }
  else if (v === "onboard" && asked.get("new")) { /* starting another save */ }
  else if (!S.lib) v = S.recent.length ? "saves" : "onboard";
  else if (S.lib.analyzing || !S.lib.analyzed) v = "analyze";
  else if (!VIEWS[v] || v === "onboard" || v === "analyze" || v === "ready") v = "home";
  if (v !== name) { history.replaceState(null, "", `#${v}`); query = ""; }
  const bare = v === "onboard" || v === "analyze" || v === "saves";
  $("#topbar").hidden = bare;
  $("#journey-dock").hidden = bare;
  document.body.classList.toggle("no-bar", bare);
  document.body.classList.toggle("mode-gallery", MODE() === "gallery");
  document.body.classList.remove("is-dragging");
  paintSaveChip();
  S.hint=null;paintGameHelp();
  if (!bare) paintTrack();
  S.onKey = null; S.pauseActivity = null; S.historyActions = null; S.forward = null;
  S.filter = filterPref();
  S.crop = cropPref();
  S.view = (S.view || 0) + 1;
  const main = $("#main");
  if (typeof World !== "undefined") World.release(main);
  main.innerHTML = "";
  window.scrollTo(0, 0); main.scrollTop = 0;
  if (typeof World !== "undefined") {
    const q2 = new URLSearchParams(query || "");
    const groupsView = (() => { try { return localStorage.getItem("matcher-groups-view"); } catch (_) { return null; } })() || (innerWidth >= 900 ? "sea" : "list");
    World.setMode(bare ? "hidden" : v === "draw" ? (q2.get("sort") || q2.get("play") ? "focus" : groupsView === "sea" ? "live" : "dim")
      : v === "stacks" && q2.get("check") ? "focus" : WORLD_MODES[v] || "dim");
  }
  VIEWS[v](main, new URLSearchParams(query || ""));
  if (!bare && v !== "home") refreshHud();
}

// Keep native typing intact; game screens receive one shared directional vocabulary.
function gameInput(e) {
  const key = {w:"ArrowUp",a:"ArrowLeft",s:"ArrowDown",d:"ArrowRight"}[e.key.toLowerCase()];
  if (!key) return e;
  return new Proxy(e, {get(event, prop) {
    if (prop === "key") return key;
    const value = Reflect.get(event, prop, event);
    return typeof value === "function" ? value.bind(event) : value;
  }});
}
const gamePhotoTarget = (root = document) => root && ($(".side[data-photo]:focus-within", root) || $(".side[data-photo]:hover", root));

window.addEventListener("hashchange", route);
document.addEventListener("keydown", (e) => {  // each activity gives the shared directions their meaning
  if(e.key==="Escape"&&!e.defaultPrevented){
    if($(".help-pop")){e.preventDefault();e.stopImmediatePropagation();closeHelp(true);return;}
    if($("dialog[open]"))return;  // the top native dialog owns its cancel key
    if($(".inspect,.ceremony")){S.onKey?.(e);e.preventDefault();e.stopImmediatePropagation();return;}
    const reason=$('.filter-stage [data-reason-toggle][aria-expanded="true"]');
    if(reason){e.preventDefault();e.stopImmediatePropagation();reason.click();reason.focus({preventScroll:true});return;}
    // A selection or focused group is a local layer: dismiss it before pausing the activity.
    const [name,query]=location.hash.slice(1).split('?'),params=new URLSearchParams(query||'');
    if(['draw','groups'].includes(name)&&!params.has('play')&&!params.has('sort')&&
      ($('[data-sel-act="clear"]')||World.sea?.focusCluster||World.sea?.focusKeys.size)){S.onKey?.(e);if(e.defaultPrevented){e.stopImmediatePropagation();return;}}
    if(!e.target.closest('input,select,textarea,.island-pop,.emoji-pop,.bin-editor')){
      e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)openMenu();return;
    }
  }
  if (e.defaultPrevented || e.target.isContentEditable || e.target.closest("input, select, textarea, dialog, .vn-catalog, .vn-tag, .vn-lasso-tag, .island-pop, .sea-tag-pop") || e.ctrlKey || e.metaKey || (e.altKey && !/^Digit/.test(e.code))
    || $("dialog[open]")) return;
  if (["Enter", " "].includes(e.key) && e.target.closest("button, a, summary, [role=button]")) return;
  e = gameInput(e);
  if (e.repeat && [" ","z","x","c","f","enter","arrowleft","arrowright","arrowup","arrowdown"].includes(e.key.toLowerCase())) { e.preventDefault(); return; }
  if(e.key.toLowerCase()==='z'&&S.lib&&typeof HistoryHUD!=='undefined') { e.preventDefault();HistoryHUD.act('undo');return; }
  if (S.onKey) S.onKey(e);
  if (e.defaultPrevented || e.repeat || location.hash.startsWith("#duel") || !S.lib) return;
  if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFilter(); }  // the auto-filter and auto-crop, anywhere
  else if (e.key === "c" || e.key === "C") { e.preventDefault(); toggleCrop(); }
  else if (e.key.toLowerCase() === "z" && typeof HistoryHUD !== "undefined") { e.preventDefault(); HistoryHUD.fallback('undo'); }
  else if (e.key === "Enter" && (!document.activeElement || document.activeElement === document.body)) {
    const go = $("#journey-next.ready") || $$(".screen-bar .bar-right .btn.primary, .next-up a.btn.primary").find(b=>!b.disabled&&b.getClientRects().length);  // Enter takes the visible way forward, including exports.
    if (go) { e.preventDefault(); go.click(); }
  }
});

// While a screen loads (or if it can't), the same frame it will fill, so nothing jumps from a page to a screen.
const LOADING = (text = "Loading…") => `<div class="screen no-rail"><div class="screen-body fill"><div class="empty loading" role="status">${text}</div></div></div>`;
const FAILED = (msg) => `<div class="screen no-rail"><div class="screen-body fill"><div class="empty error">${esc(msg)}</div></div></div>`;

// True once the person has moved on from the page that started this request (its reply must not render).
const left = (token) => token !== S.view;

// Removable media can change while a picker stays open. Check only connectivity, and leave with the view.
function watchStorage(url, update) {
  const view = S.view, signal = S.events.signal;
  let pending = null;
  const refresh = () => {
    if (pending) return pending;
    const path = url();
    if (signal.aborted || left(view) || document.hidden || !path) return Promise.resolve();
    pending = (async () => {
      try {
        const data = await api(path);
        if (!signal.aborted && !left(view) && path === url()) await update(data);
      } finally { pending = null; }
    })();
    return pending;
  };
  const check = () => { refresh().catch(() => {}); };  // A temporary connection failure keeps the last known state.
  const timer = setInterval(check, 1500);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  window.addEventListener("focus", check, { signal });
  document.addEventListener("visibilitychange", check, { signal });
  check();
  return refresh;
}

// ---------------------------------------------------------------- onboarding
function viewOnboard(main) {
  const view = S.view;
  let browsing = 0, opening = false, browserPath = null, browserExists = true, browserLoading = false;
  main.innerHTML = `
    <div class="screen onboard no-rail">
      <div class="screen-head">
        <div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i></span>MatchER</div>
        <h1>New save</h1>
        <span class="grow"></span>
        ${helpBtn(`Each folder is its own save. It learns your taste as you play and ranks even the photos you haven't compared.<br><br>${STAGES.map(([,icon,,title,line])=>`<b>${icon} ${title}</b>: ${line}`).join('<br><br>')}`)}
      </div>
      <div class="screen-body onboard-body">
        <div class="onboard-hero">
          <h2 class="hero-title">Photo tournaments that find your best shots.</h2>
          <p class="lede">Your photos. Your calls. A shortlist worth keeping.</p>
          <ol class="onboard-path" aria-label="How it plays">${[
            ['🎛️','Choose','Preview what stays in play. Every set-aside photo can return.'],
            ['🧩','Organize','Gather similar takes into stacks and themes into teams.'],
            ['🏆','Play','Pick your favourites in quick duels. Crown and save your best.'],
          ].map(([icon,title,line]) =>
            `<li><span class="op-ico">${icon}</span><span><b>${title}</b><span class="muted small">${line}</span></span></li>`).join("")}</ol>
          <div class="lock">${LOCK}<span>Runs entirely on this computer. Nothing is uploaded; the export is a folder you decide to share.</span></div>
        </div>
        <div class="card onboard-setup">
          <div class="steps">
            <div class="step now"><div>
              <h3>What are we sorting?</h3>
              <div class="modes">
                <button class="mode-card on" data-mode="gallery" aria-pressed="true"><span class="mi" aria-hidden="true">🌄</span><b>My best photos</b>
                  <span>Any folder: trips, landscapes, food, pets, friends. Each kind of photo gets a cup of its own.</span></button>
                <button class="mode-card" data-mode="me" aria-pressed="false"><span class="mi" aria-hidden="true">💘</span><b>Photos of me</b>
                  <span>Profile pics: it finds you in every shot and cares about smiles, eyes and light.</span></button>
              </div>
            </div></div>
            <div class="step now"><div>
              <h3>Pick the folder</h3>
              <div class="pickers">
                <div class="row"><button class="btn ghost" id="toggle-browse">Browse here</button>
                  <span class="muted small">or use your desktop's folder dialog: the button bottom right</span></div>
                <div id="browser" class="browser" hidden></div>
                <div class="row">
                  <input type="text" id="path" placeholder="…or paste a path, e.g. ~/Pictures/photodump" spellcheck="false" autocomplete="off">
                  <button class="btn" id="use-path">Use</button>
                </div>
                <div id="pick-error" class="error" hidden></div>
                <div class="sample-row"><span class="muted small">No photos handy?</span>
                  <button class="btn ghost" id="sample">Try it with sample photos</button>
                  <span class="faint small" id="sample-note">Public-domain meme faces and classics · works offline</span></div>
              </div>
            </div></div>
          </div>
        </div>
      </div>
      <div class="screen-bar action-bar">
        <div class="bar-left">${S.recent.length ? `<a class="btn big" href="#saves">← Your saves</a>` : ""}</div>
        <div class="bar-mid"></div>
        <div class="bar-right"><button class="btn primary big" id="native">Choose folder…</button></div>
      </div>
    </div>`;

  const err = (msg) => { const e = $("#pick-error", main); if (left(view) || !e) return; e.textContent = msg || ""; e.hidden = !msg; };
  let mode = "gallery";
  $$(".mode-card").forEach((b) => (b.onclick = () => {
    mode = b.dataset.mode;
    $$(".mode-card").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
  }));
  $("#native").onclick = async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.textContent = "Waiting for the folder dialog…";
    err("");
    try {
      const r = window.matcherDesktop ? await window.matcherDesktop.chooseFolder() : await api("/api/pick-native", { start: "" });
      if (left(view)) return;
      if (!r.available) { toast("No desktop folder dialog found; browse here instead."); openBrowser(); }
      else if (r.path) await openLibrary(r.path);
    } catch (e) { err(e.message); }
    b.disabled = false;
    b.textContent = "Choose folder…";
  };
  $("#toggle-browse").onclick = () => {
    const box = $("#browser");
    if (box.hidden) openBrowser(browserPath);
    else { box.hidden = true; browsing++; browserLoading = false; }
  };
  $("#sample").onclick = async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    err("");
    let st;
    try { st = await api("/api/sample", {}); } catch (e) { err(e.message); b.disabled = false; return; }
    if (left(view)) return;
    while (st.state === "running") {
      $("#sample-note").textContent = `Preparing… ${st.done} of ${st.total}`;
      await sleep(1200);
      if (left(view)) return;
      try { st = await api("/api/sample"); } catch (e) { st = { state: "error", error: e.message }; }
      if (left(view)) return;
    }
    if (st.state === "error") { err(st.error); b.disabled = false; $("#sample-note").textContent = ""; return; }
    mode = "gallery";
    await openLibrary(st.path);
  };
  $("#use-path").onclick = () => openLibrary($("#path").value);
  $("#path").addEventListener("keydown", (e) => { if (e.key === "Enter") openLibrary($("#path").value); });

  const refreshStorage = watchStorage(() => $("#browser", main)?.hidden || !browserPath || browserLoading ? null
    : `/api/storage?browse=1&path=${encodeURIComponent(browserPath)}`, async (data) => {
    const box = $("#browser", main);
    showSuggestions(data.suggestions);
    if (!data.folder || data.folder.exists === browserExists) return;
    browserExists = data.folder.exists;
    $("#use-this", box).disabled = !browserExists;
    $(".dirs", box).hidden = !browserExists;
    $(".browser-missing", box).hidden = browserExists;
    if (browserExists) await openBrowser(browserPath);
  });

  function showSuggestions(items) {
    const el = $("#browser .suggest", main), signature = JSON.stringify(items);
    if (!el || el.dataset.items === signature) return;
    el.dataset.items = signature;
    el.innerHTML = items.map((s) => `<button class="chip" data-go="${esc(s.path)}">${esc(s.label)}</button>`).join("");
    $$("[data-go]", el).forEach((b) => (b.onclick = () => openBrowser(b.dataset.go)));
  }

  async function openBrowser(path) {
    const request = ++browsing;
    browserLoading = true;
    const box = $("#browser");
    box.hidden = false;
    let d;
    try { d = await api(`/api/browse?path=${encodeURIComponent(path || "")}`); }
    catch (e) { if (request === browsing) { browserLoading = false; err(e.message); } return; }
    if (left(view) || request !== browsing) return;
    browserLoading = false;
    browserPath = d.path;
    browserExists = true;
    err("");
    const crumbs = d.crumbs.map((p) => `<button data-go="${esc(p.path)}">${esc(p.label)}</button>`).join('<span class="faint">/</span>');
    box.innerHTML = `
      <div class="suggest"></div>
      <div class="crumbs">${crumbs}</div>
      <div class="dir faint browser-missing" role="status" hidden>Folder disconnected. Plug the drive back in, or choose another folder.</div>
      <div class="dirs">${d.dirs.length ? d.dirs.map((x) => `
        <button class="dir" data-go="${esc(x.path)}"><span>${esc(x.name)}</span>
          <span class="n ${x.photos ? "has" : ""}">${x.photos ? `${fmt(x.photos)} photo${x.photos === 1 ? "" : "s"}` : ""}</span></button>`).join("")
        : `<div class="dir faint">No subfolders</div>`}</div>
      <div class="browser-foot">
        <span class="muted small">${d.photos == null ? "Photos in this folder and its subfolders will be scanned after you choose it." : d.photos ? plural(d.photos,"photo")+" directly in this folder" : "No photos directly in this folder"}</span>
        <button class="btn primary" id="use-this">Use this folder</button>
      </div>`;
    $$("[data-go]", box).forEach((b) => (b.onclick = () => openBrowser(b.dataset.go)));
    showSuggestions(d.suggestions);
    $("#use-this", box).onclick = async () => {
      try { await refreshStorage(); } catch (e) { err(e.message); return; }
      if (!left(view) && browserExists) openLibrary(d.path);
    };
    refreshStorage().catch(() => {});
  }

  async function openLibrary(path, resume = false) {
    if (opening || left(view)) return;
    err("");
    if (!path || !path.trim()) { err("Pick or paste a folder first."); return; }
    opening = true;
    try {
      await api("/api/library", resume ? { path: path.trim() } : { path: path.trim(), mode });
      await loadState();
      location.hash = "analyze";
      route();
    } catch (e) { err(e.message); } finally { opening = false; }
  }
}

// ---------------------------------------------------------------- saves: one per folder
const ago = (ts) => {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  if (s < 30 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const CLASSES = { gallery: "🌄 Gallery", me: "💘 Profile" };

function paintSaveChip() {
  const chip = $("#save-chip");
  if (!chip) return;
  const sv = S.lib && S.lib.save;
  chip.hidden = !sv;
  if (!sv) return;
  const g = S.game || sv;
  const xp = g.level_next ? Math.round(((g.xp - g.level_floor) / (g.level_next - g.level_floor)) * 100) : 100;
  chip.innerHTML = `${sv.cover ? `<img src="/img/save/${esc(sv.slug)}/${sv.cover}.jpg" alt="">` : `<span class="chip-blank">${MODE() === "gallery" ? "🌄" : "💘"}</span>`}
    <span class="chip-text"><span class="chip-name">${esc(sv.name)}</span>
      ${g.xp != null ? `<span class="chip-lvl">${g.level ? `Lv ${g.level} · ` : ""}${fmt(g.xp)} XP</span>` : ""}
      <span class="xpbar"><i style="width:${xp}%"></i></span></span>`;
  chip.title = `${sv.name} · ${g.level ? `Lv ${g.level} · ` : ""}${g.xp != null ? `${fmt(g.xp)} XP` : ""}: switch save`;
}

async function viewSaves(main) {
  main.innerHTML = LOADING();
  const view = S.view;
  let d;
  try { d = await api("/api/saves"); } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  const card = (sv, i) => {
    const xp = sv.level_next ? Math.round(((sv.xp - sv.level_floor) / (sv.level_next - sv.level_floor)) * 100) : 100;
    return `
    <div class="save-card ${sv.current ? "current" : ""} ${sv.exists ? "" : "missing"}" data-save="${i}" role="group"
      aria-label="${esc(sv.name)}${sv.current ? " (playing now)" : ""}" style="--i:${i}">
      <button class="save-open" aria-label="Play ${esc(sv.name)}" aria-disabled="${!sv.exists}">
      <span class="save-art">${sv.cover ? `<img src="/img/save/${esc(sv.slug)}/${sv.cover}.jpg" alt="" loading="lazy">`
        : `<span class="save-blank">${sv.mode === "me" ? "💘" : "🌄"}</span>`}
        ${sv.current ? `<span class="save-ribbon">Playing</span>` : ""}
        ${sv.mode ? `<span class="save-class">${CLASSES[sv.mode]}</span>` : ""}</span>
      <span class="save-body">
        <b class="save-name" title="${esc(sv.path)}">${esc(sv.name)}</b>
        ${sv.fresh || !sv.analyzed ? `<span class="muted small">${sv.fresh ? "New: not analyzed yet" : "Analysis not finished"}</span>` : `
        <span class="save-lvl"><span class="lvl-n">Lv ${sv.level}</span> ${esc(sv.level_name)}</span>
        <span class="xpbar"><i style="width:${xp}%"></i></span>
        <span class="save-stats"><span title="Photos">📷 ${fmt(sv.photos)}</span><span title="Calls">⚔️ ${fmt(sv.calls)}</span>
          <span title="Themed groups">🗂️ ${fmt(sv.groups)}</span><span title="Champions">🏆 ${fmt(sv.champions)}</span></span>`}
        <span class="save-status faint small">${sv.exists ? (sv.played ? `Played ${ago(sv.played)}` : "") : "Folder missing (moved or unplugged?)"}</span>
      </span>
      </button><button class="save-forget" data-forget="${i}" title="Forget this save" aria-label="Forget the save for ${esc(sv.name)}">✕</button>
    </div>`;
  };
  let cur = d.saves.findIndex((sv) => sv.current && sv.exists), go;
  main.innerHTML = `
    <div class="screen saves no-rail">
      <div class="screen-head">
        <div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i></span>MatchER</div>
        <h1>Choose your save</h1>
        <span class="stat-chip"><b>${d.saves.length}</b> ${d.saves.length === 1 ? "save" : "saves"}</span>
        <span class="grow"></span>
        ${helpBtn(`Every folder is its own save, with its own level, trophies, groups and champions. Switch whenever you like; each one
          picks up exactly where you left it. Arrow keys pick a save, Enter plays it; ✕ forgets one (your photos are never touched).`)}
      </div>
      <div class="screen-body"><div class="save-grid">${d.saves.map(card).join("")}
        <a class="save-card new" href="#onboard?new=1" style="--i:${d.saves.length}"><span class="plus" aria-hidden="true">＋</span><b>New save</b>
          <span class="muted small">Any folder of photos: trips, pets, food, friends, selfies</span></a></div></div>
      <div class="screen-bar action-bar">
        <div class="bar-left"><span class="lock">${LOCK}<span>Runs entirely on this computer. Nothing is uploaded.</span></span></div>
        <div class="bar-mid">${cur >= 0 ? `<a class="btn ghost" href="#onboard?new=1">＋ New save</a>` : ""}</div>
        <div class="bar-right">${cur >= 0 ? `<button class="btn primary big" id="continue">Continue this save <kbd>Enter</kbd></button>`
          : `<a class="btn primary big" href="#onboard?new=1">＋ New save</a>`}</div>
      </div>
    </div>`;
  let opening = false;
  const open = async (sv) => {
    if (opening) return;
    opening = true;
    try {
      await refreshStorage();
      if (left(view)) return;
      if (!sv.exists) { toast("That folder isn't there any more. Plug it back in, or forget the save."); return; }
      if (sv.current && S.lib) { location.hash = "#home"; return; }
      await api("/api/library", { path: sv.path });
      if (left(view)) return;
      await loadState();
      if (left(view)) return;
      S.game = null;
      Sound.play("level");
      location.hash = S.lib && S.lib.analyzed && !S.lib.analyzing ? "#home" : "#analyze";
      route();
    } catch (e) { if (!left(view)) toast(e.message); }
    finally { opening = false; }
  };
  $$("[data-save]", main).forEach((el) => {
    el.onclick = (e) => { if (!e.target.closest("[data-forget]")) open(d.saves[Number(el.dataset.save)]); };
    el.onkeydown = (e) => { if (e.target === el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(d.saves[Number(el.dataset.save)]); } };
  });
  const bindContinue = () => {
    go = $("#continue", main);
    if (go) go.onclick = () => open(d.saves[cur]);
  };
  bindContinue();
  const refreshStorage = watchStorage(() => "/api/storage", (data) => {
    const availability = new Map(data.saves.map((sv) => [sv.path, sv.exists]));
    d.saves.forEach((sv, i) => {
      const exists = availability.get(sv.path);
      if (exists === undefined || exists === sv.exists) return;
      sv.exists = exists;
      const el = $(`[data-save="${i}"]`, main);
      el.classList.toggle("missing", !exists);
      $(".save-open", el).setAttribute("aria-disabled", !exists);
      $(".save-status", el).textContent = exists ? (sv.played ? `Played ${ago(sv.played)}` : "") : "Folder missing (moved or unplugged?)";
    });
    const current = d.saves.findIndex((sv) => sv.current && sv.exists);
    if (cur === current) return;
    cur = current;
    $(".bar-mid", main).innerHTML = cur >= 0 ? `<a class="btn ghost" href="#onboard?new=1">＋ New save</a>` : "";
    $(".bar-right", main).innerHTML = cur >= 0 ? `<button class="btn primary big" id="continue">Continue this save <kbd>Enter</kbd></button>`
      : `<a class="btn primary big" href="#onboard?new=1">＋ New save</a>`;
    bindContinue();
  });
  // arrows walk the saves like a game's save menu; Enter plays the focused one (or the one you were playing)
  S.onKey = (e) => {
    const cards = $$(".save-open, .save-card.new", main), at = cards.indexOf(document.activeElement);
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      cards[at < 0 ? Math.max(0, cur) : (at + step + cards.length) % cards.length].focus();
    } else if (e.key === "Enter" && at < 0 && go) { e.preventDefault(); go.click(); }
  };
  $$("[data-forget]", main).forEach((b) => (b.onclick = async () => {
    const sv = d.saves[Number(b.dataset.forget)];
    if (!await askInGame(`Forget the save for ${sv.name}? Its level, groups, votes and previews are deleted. Your photos themselves are never touched.`, "Forget this save")) return;
    try { await api("/api/library/forget", { path: sv.path }); } catch (e) { toast(e.message); return; }
    await loadState();
    route();
  }));
}

// ---------------------------------------------------------------- analysis progress
const PHASES = [
  ["models", "Checking the face and scene models"],
  ["listing", "Listing your photos"],
  ["reading", "Reading photos: faces, blinks, smiles"],
  ["understanding", "Understanding each scene"],
  ["identity", "Working out which face is you"],
  ["details", "Looking closer: what's in each photo, who, how it looks"],
  ["organizing", "Folding bursts, setting aside throw-outs"],
];
const GALLERY_PHASES = {
  reading: "Reading photos: light, sharpness, faces",
  understanding: "Working out what each photo shows",
  identity: "Spotting the people",
  details: "Looking closer at the people in them: what's there, how it looks",
  organizing: "Folding bursts, sorting photos into cups",
};


const KINDS = { people: ["🧑‍🤝‍🧑", "People"], nature: ["🏔️", "Nature"], places: ["🏙️", "Places"], animals: ["🐾", "Animals"],
  food: ["🍜", "Food"], things: ["🎲", "Things"] };
const STEP_ICONS = { models: "📦", listing: "📂", reading: "👀", understanding: "🧠", identity: "🙂", details: "🔍", organizing: "🧩" };

function viewAnalyze(main) {
  main.innerHTML = `
    <div class="screen no-rail analyzing">
      <div class="screen-head">
        <h1>✨ <span class="an-title-long">Getting to know your photos</span><span class="an-title-short">Meet your photos</span></h1>
        <span class="stat-chip" id="an-src"></span>
        <span class="grow"></span>
        <ol class="an-steps" id="an-steps"></ol>
      </div>
      <div class="screen-body fill an-body" id="an-body">
        <div class="ps-field an-field" id="an-sea"></div>
        <aside class="an-panel" id="an-panel" hidden></aside>
      </div>
      <div class="screen-bar an-foot">
        <div class="an-progress"><div class="row spread"><b id="an-label">Starting…</b><span class="muted small" id="an-eta"></span></div>
          <div class="bar"><i id="an-bar"></i></div></div>
        <div class="an-go-slot" id="an-forward"></div>
        <div class="error" id="an-error" hidden></div>
      </div>
    </div>`;
  $("#an-src").textContent = S.lib ? S.lib.source.split("/").filter(Boolean).pop() || S.lib.source : "";
  // The sea: every photo it reads joins it and stays. Every tag it finds pulls the photos that share it together (the
  // same tag physics as the Groups page), with lassos following its flocks. One photo at a time is grabbed out of
  // the sea to the middle, bigger, with what's being found shown right on it, then shrinks back among its kind.
  const sea = new VennSea($("#an-sea"), {calm:true});
  sea.enableCamera(true);
  const info = new Map(), changed = new Set(), meta = new Map(), counts = new Map(), queue = [], forced = [];
  const facesOf = new Map(), catOf = new Map();
  let dirty = false, dripTimer = null, lastRead = null, lastCat = null, lastSeen = null;
  let scene = null, worked = false, finale = false, orgPlayed = false;
  const fr = { read: 0, cats: 0, seen: 0, identity: 0, org: 0 };
  let lastIdentity = null, feeding = false, catchingUp = true;
  const words = () => (MODE() === "gallery" ? GALLERY_PHASES : {});
  const tagOf = (key, emoji, label) => { if (!meta.has(key)) meta.set(key, { emoji, label }); return key; };
  const addPhoto = (id) => { if (!info.has(id)) { info.set(id, { tags: new Set(), n: 1 }); changed.add(id); dirty = true; } return info.get(id); };
  const give = (id, key) => { const r = addPhoto(id); if (!r.tags.has(key)) { r.tags.add(key); counts.set(key, (counts.get(key) || 0) + 1); changed.add(id); dirty = true; } };
  // tags land a few at a time, so photos drift toward each other as you watch instead of jumping in one go
  const drip = () => {
    if (!queue.length || left(view0) || !$("#an-sea")) { clearInterval(dripTimer); dripTimer = null; return; }
    for (let k = Math.max(4, Math.ceil(queue.length / 10)); k > 0 && queue.length; k--) { const [id, key] = queue.shift(); give(id, key); }
    flush();
  };
  const enqueue = (id, key) => {
    if(catchingUp){give(id,key);return;}  // a refreshed page restores discoveries already made, rather than replaying them
    queue.push([id, key]); if (!dripTimer) dripTimer = setInterval(drip, 120);
  };
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    const top = [...counts].filter(([,n])=>n>0).map(([k])=>k);
    sea.setVenn(top.map((k) => { const m = meta.get(k) || { emoji: "🏷️", label: k };
      return { id: k, label: m.label, emoji: m.emoji, catchy: m.catchy, html: `${esc(m.emoji)} ${esc(m.label)} <span class="ps-count">${fmt(counts.get(k) || 0)}</span>` }; }),
      [...changed].map((id) => { const r = info.get(id); return { id, photo: id, tags: [...r.tags], n: r.n,
        group:r.group,sugg:r.sugg,cut:r.cut,members:r.members,rep:r.rep,category:r.category,visual:r.visual,dims:r.dims,take:r.rep&&r.rep!==id }; }),
      [], true);
    changed.clear();
  };
  // everything the analysis found since the last look, photo by photo: none is skipped however fast they go
  async function readFeed() {
    if (feeding || left(view0)) return false;
    feeding = true;
    let f;
    try { f = await api(`/api/analysis/feed?${new URLSearchParams(fr)}`); } catch (_) { feeding = false; return false; }
    feeding = false;
    if (left(view0)) return false;
    for (const k of Object.keys(fr)) fr[k] += (f[k] || []).length;
    for (const [id, boxes, smiles, blinks, visual, dims] of f.read) {
      addPhoto(id).visual=visual;addPhoto(id).dims=dims;changed.add(id);dirty=true;
      facesOf.set(id, { boxes, smiles, blinks });
      if (boxes.length) enqueue(id, tagOf("faces", "🙂", "Faces"));
      if (smiles) enqueue(id, tagOf("smiling", "😄", "Smiling"));
      if (blinks) enqueue(id, tagOf("eyes_closed", "😑", "Eyes closed"));
      lastRead = id;
    }
    for (const [id, kind, themes] of f.cats) {
      addPhoto(id);
      const [icon, name] = KINDS[kind] || ["🏷️", kind];
      if(kind)enqueue(id, tagOf(`kind:${kind}`, icon, name));
      for (const [emoji, label, score, key] of themes) enqueue(id, tagOf(key || `t:${label}`, emoji, label));
      catOf.set(id, [kind, themes]);
      addPhoto(id).sugg = kind ? `kind:${kind}` : null;addPhoto(id).category=kind||null;changed.add(id);dirty=true;
      lastCat = id;
    }
    for (const [id, box, found] of f.seen) {
      addPhoto(id);
      if (box) seenOf.set(id, box);
      for (const [emoji, label, score, key] of found || []) enqueue(id, tagOf(key || `t:${label}`, emoji, label));
      lastSeen = [id, box, found || []];
    }
    for (const row of f.identity || []) { lastIdentity = row; addPhoto(row[0]); }
    for (const row of f.org || []) {
      const r = addPhoto(row[0]); r.group = row[3] ? "cut" : null; r.cut = !!row[3]; r.n = row[0] === row[2] ? row[4].length : 1;
      r.members = row[4]; r.rep = row[2]; changed.add(row[0]); dirty = true;
    }
    flush();
    const more=Object.keys(fr).some((k) => fr[k] < (f[`${k}_n`] || 0));
    if(!more&&(fr.read||!['idle','listing','models'].includes(S.lib.progress?.phase)))catchingUp=false;
    return more;
  }
  // the grab: a photo lifts out of its spot, grows into the middle with what's being found on it, then goes back
  let grabbing = false, grabEpoch = 0, cancelGrab = () => {};
  // The grab always lands in the same place, so the sea is parted there once (and again only when the viewport
  // changes), never closed and reopened around every photo that comes up: that re-arranged thousands of prints twice
  // per grab. The zone is sized from the field alone, so it is the same for every grab.
  const grabZone = () => {
    const field = $("#an-sea");
    if (!field) return null;
    const fw = field.clientWidth, fh = field.clientHeight, h = Math.min(fh * .42, fw * .5 * 4 / 3), w = h * 3 / 4, x0 = (fw - w) / 2, y0 = Math.max(12, (fh - h) / 2 - 50);
    const cw = Math.min(fw - 32, Math.max(w, 320)), pad = Math.max(24, h * .08 + w * .075);
    return { x0: x0 + (w - Math.max(w, cw)) / 2 - pad, y0: y0 - pad, x1: x0 + (w + Math.max(w, cw)) / 2 + pad, y1: y0 + h + Math.max(150, h * .3) + 24 };
  };
  const partSea = () => {
    const z = grabZone(), o = sea.obstacles?.[0];
    if (!z || (o && ["x0", "y0", "x1", "y1"].every((k) => Math.abs(o[k] - z[k]) < 8))) return;
    sea.obstacles = [z]; sea.layout(); sea.stir(120);
  };
  const seenOf = new Map();  // photo id -> its subject box, once "looking closer" has found one
  // The subject to frame on, as auto-crop would: the subject box if found, otherwise every face found so far.
  const subjectOf = (id) => {
    if (seenOf.get(id)) return seenOf.get(id);
    const faces = facesOf.get(id)?.boxes || [];
    if (!faces.length) return null;
    const x0 = Math.min(...faces.map((f) => f[0])), y0 = Math.min(...faces.map((f) => f[1]));
    return [x0, y0, Math.max(...faces.map((f) => f[0] + f[2])) - x0, Math.max(...faces.map((f) => f[1] + f[3])) - y0];
  };
  const clearGrab = () => { cancelGrab(); ++grabEpoch; grabbing = false; cancelGrab = () => {}; };
  // Inspecting a print takes precedence over the automatic spotlight; discoveries keep arriving in the sea.
  window.addEventListener('sea-camera',e=>{if(e.detail.sea===sea&&e.detail.zoom>1)clearGrab();},{signal:S.events.signal});
  async function grab(id, overlay, chrome, members = []) {
    const field = $("#an-sea"), it = sea.items.get(id);
    if (grabbing || finale || sea.camera.zoom>1 || !field || !it) return;
    grabbing = true;
    const epoch = ++grabEpoch;
    const img = new Image();
    img.src = P(id);
    try { await img.decode(); } catch (_) { if (epoch === grabEpoch) grabbing = false; return; }
    if (epoch !== grabEpoch || finale || !$("#an-sea")) return;
    const box = document.createElement("div");
    box.className = "an-grab";
    box.dataset.photo = id;
    box.innerHTML = `<div class="an-grab-photo print ${members.length > 1 ? "stacked" : ""}">${pilePhotos(id,members,members.length,false)}<div class="paper"><div class="window"><div class="picture"><img class="${members.length > 1 ? "pile-cover" : ""}" src="${P(id)}" alt="">${overlay}</div></div></div></div><div class="an-grab-chrome">${chrome}</div>`;
    const photo=$('.an-grab-photo',box),cover=$('.an-grab-photo .picture > img',box),picture=$('.an-grab-photo .picture',box);
    photo.style.opacity='0';
    field.append(box);
    let returning=false,flight=null;
    const fit=()=>{
      if(returning||epoch!==grabEpoch)return;
      // One polaroid card as large as fits; the picture is contained in its window, with the overlays on it.
      const fw=field.clientWidth,fh=field.clientHeight,h=Math.min(fh*.42,fw*.5*4/3),w=h*3/4,x0=(fw-w)/2,y0=Math.max(12,(fh-h)/2-50);
      Object.assign(photo.style,{width:`${w}px`,height:`${h}px`});
      // Framed by the crop mode (C), on the subject or the faces found so far; the overlays ride on the picture.
      const ww=w*.89,wh=h-w*.225,rect=frameRect(ww,wh,img.naturalWidth||1,img.naturalHeight||1,subjectOf(id),normCrop(S.crop));
      Object.assign(picture.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.w}px`,height:`${rect.h}px`});
      Object.assign(box.style,{left:`${x0}px`,top:`${y0}px`,width:`${w}px`,gap:`${members.length>1?h*.08+w*.075+10:10}px`});
      const cw=Math.min(fw-32,Math.max(w,320));
      box.style.setProperty('--chrome-width',`${cw}px`);
      partSea();
    };
    fit();const resize=new ResizeObserver(fit);resize.observe(field);
    S.refitGrab=fit;  // C during the show reframes the photo in hand
    const source=sea.promote(id)||it,from=World.rect(source.el.querySelector('.pile-cover')||source.el);
    const lifted=members.length>1?[...sea.items.values()].filter(p=>p.stack===it.stack):[it];
    lifted.forEach(p=>p.el.classList.add('lifted'));
    cancelGrab = () => { ++grabEpoch;flight?.cancel();resize.disconnect();box.remove();lifted.forEach(p=>p.el.classList.remove('lifted'));grabbing=false;S.refitGrab=null; };
    box.classList.add("open");
    if(from?.width)flight=World.fly(P(id),from,()=>World.rect(cover),{ms:450,valid:()=>epoch===grabEpoch&&box.isConnected,frameTo:()=>World.frameOf(cover),
      finish:()=>{if(epoch===grabEpoch&&!returning)photo.style.opacity='';}});
    else photo.style.opacity='';
    await sleep(members.length>1?1350:2600);
    if (epoch !== grabEpoch) return;
    const back = sea.items.get(id);
    const origin={...(flight&&!flight.img.isConnected?World.rect(cover):flight?.rect||World.rect(cover))},shown=World.frameOf(cover);
    returning=true;resize.disconnect();flight?.cancel();S.refitGrab=null;
    box.classList.remove("open");
    photo.style.opacity='0';
    if(back&&origin.width){flight=World.fly(P(id),origin,()=>World.rect(back.el.querySelector('.pile-cover')||back.el),{
      ms:450,valid:()=>epoch===grabEpoch&&box.isConnected,frameFrom:shown});await flight.promise;}
    if (epoch !== grabEpoch) return;
    box.remove();
    lifted.forEach(p=>p.el.classList.remove('lifted'));
    grabbing = false;
    cancelGrab = () => {};
  }
  // The spotlight is a quick discovery, not the classifier's whole score sheet. Every tag still joins the shelf.
  const findings = (list, caption) => {
    const seen = new Set(), top = list.filter(([,label]) => {
      const key = String(label || "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 5);
    return `<div class="an-grab-findings"><div class="an-grab-tags">${top.map(([emoji, label], i) =>
      `<span class="tag-chip on" style="--i:${i}">${esc(emoji)} ${esc(label)}</span>`).join("")}</div>
      <span class="an-grab-caption">${esc(caption)}</span></div>`;
  };
  let spotlightKey=null;
  const grabTimer = setInterval(() => {
    if (left(view0) || !$("#an-sea")) { clearInterval(grabTimer); return; }
    if (grabbing || finale || sea.camera.zoom>1) return;
    const current=scene==='reading'?lastRead:scene==='understanding'?lastCat:scene==='details'?lastSeen?.[0]:scene==='identity'?lastIdentity?.[0]:null;
    const key=`${scene}:${current}`;if(current==null||key===spotlightKey)return;spotlightKey=key;
    if (scene === "reading" && lastRead != null) {
      const f = facesOf.get(lastRead) || { boxes: [], smiles: 0, blinks: 0 };
      grab(lastRead, f.boxes.map(([x, y, w, h]) => `<i class="face-box" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></i>`).join(""),
        f.boxes.length ? findings([["🙂", plural(f.boxes.length, "face")], ...(f.smiles ? [["😄", plural(f.smiles, "smile")]] : []),
          ...(f.blinks ? [["😑", plural(f.blinks, "blink")]] : [])], "Face scan complete")
          : `<span class="muted">No faces: light, colour and sharpness read</span>`);
    } else if (scene === "understanding" && lastCat != null) {
      const [kind, themes] = catOf.get(lastCat) || ["", []];
      const [icon, name] = KINDS[kind] || ["🏷️", kind];
      const f = facesOf.get(lastCat);
      grab(lastCat, "", findings([...(kind ? [[icon, name]] : []), ...themes], `${kind||themes.length?"Scene recognized":"Scene scan complete"}${f?.boxes.length ? ` · ${plural(f.boxes.length, "face")}` : ""}`));
    } else if (scene === "details" && lastSeen) {
      const [id, [x, y, w, h], found] = lastSeen;
      grab(id, `<i class="crop-box" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></i>`,
        findings(found, found.length ? "Details recognized" : "Closer look complete"));
    } else if (scene === "identity" && lastIdentity) {
      const [id, similarity, face, n] = lastIdentity;
      grab(id, "", `<b>Finding you</b><span>${similarity != null ? `${pct(similarity)} similarity to you` : "No matching face"} · ${plural(n || 0, "face")}</span>${face ? `<img class="identity-face" src="${F(face)}" alt="Matched face">` : ""}`);
    }
  }, 650);
  const panel=(html)=>{const p=$('#an-panel');if(p.dataset.scene!==scene){p.dataset.scene=scene;p.innerHTML=html;}return p;};
  function stage(p) {
    if(p.phase!==scene){clearGrab();scene=p.phase;$('#an-body').dataset.scene=scene;}
    if(['reading','understanding','details'].includes(scene))worked=worked||p.total>0;
    if(scene==='organizing'||p.phase==='done'&&!orgPlayed)playOrganizing(p.org||{});
    flush();
  }
  // Organizing plays back what the last step really did: who it found, what it set aside and why, the bursts it stacked.
  function playOrganizing(org) {
    if (orgPlayed || !org.stacks || !org.tags) {  // the report arrives in parts; wait for the stacks and their tags
      panel(`<h2>Putting it all in order</h2><ul class="an-checks" id="an-checks"></ul>`);
      return;
    }
    orgPlayed = true;
    scene = "organizing";
    const labels = (S.lib && S.lib.labels) || {};
    panel(`<h2>Putting it all in order</h2><p class="muted small">The rules that set photos aside, burst takes folded into stacks, and photos
      grouped into scenes.</p><ul class="an-checks" id="an-checks"></ul>`);
    const steps = [
      ["people", "👥", () => org.people ? `${plural(org.people.people, "person", "people")} recognized` : "People recognized"],
      ["throwouts", "🗃️", () => { const c = (org.throwouts || {}).counts || {}; const n = Object.values(c).reduce((a, b) => a + b, 0);
        return `${plural(n, "photo")} set aside${n ? `: ${Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, k]) => `${fmt(k)} ${esc(labels[r] || r)}`).join(", ")}` : ""}`; }],
      ["stacks", "🧩", () => org.stacks ? `${plural(org.stacks.folded, "burst take")} folded into stacks · ${plural(org.stacks.shots, "shot")} in the running` : "Stacks"],
      ["scenes", "🎬", () => org.scenes ? `${plural(org.scenes.scenes, "scene")}` : "Scenes"],
      ["tags", "🏷️", () => org.tags ? `${plural(org.tags.tags, "tag")}: everything it recognized, ready for grouping` : "Tags"],
    ];
    const list = $("#an-checks");
    list.innerHTML = steps.map(([k, icon, text]) => `<li data-step="${k}"><span class="an-check">${icon}</span><span>${text()}</span></li>`).join("");
    const focus = (step,id,chrome,members=[]) => {
      clearGrab();
      list.querySelector('[aria-current]')?.removeAttribute("aria-current");
      list.querySelector(`[data-step="${step}"]`).setAttribute("aria-current","step");
      grab(id,"",chrome,members);
    };
    let t = 0;
    const at = (ms, fn) => setTimeout(() => { if (!left(view0)) fn(); }, (t += ms));
    at(200, () => list.querySelector('[data-step="people"]').classList.add("done"));
    if (org.throwouts && org.throwouts.cut.length) {  // the throw-outs gather in a circle of their own
      at(500, () => {
        forced.push(tagOf("x:cut", "🗃️", "Set aside"));
        org.throwouts.cut.forEach(([id]) => give(id, "x:cut"));
        flush();
        const [id,reason] = org.throwouts.cut[0];
        focus("throwouts",id,`<b>🫙 Set aside</b><br><span>${esc(labels[reason] || reason)}</span>`);
      });
    }
    at(1400, () => list.querySelector('[data-step="throwouts"]').classList.add("done"));
    for (const st of ((org.stacks || {}).stacks || []).slice(0, 10)) {  // each burst's frames gather, then choose their cover
      const frames = st.slice(0,8), id = frames[0], n = st.length > 8 ? st[8] : frames.length;
      at(350, () => {
        frames.forEach((id) => addPhoto(id)); flush();
        const members = info.get(id).members || frames;
        focus("stacks",id,`<b>⧉ ${plural(n,"take")} of the same shot</b><br><span>Folding this stack · best guess on top</span>`,members);
      });
      at(1500, () => {
        const members = info.get(id).members || frames;
        frames.forEach((pid) => { const take = addPhoto(pid); take.rep = id; take.members = members; take.n = pid === id ? n : 1; changed.add(pid); });
        dirty = true; flush();
      });
    }
    at(500, () => { list.querySelector('[data-step="stacks"]').classList.add("done"); list.querySelector('[aria-current]')?.removeAttribute("aria-current"); });
    at(700, () => list.querySelector('[data-step="scenes"]').classList.add("done"));
    if (org.tags && org.tags.top && org.tags.top.length) {  // what it recognized, one tag at a time
      at(300, () => { list.insertAdjacentHTML("afterend", `<div class="an-tagcloud">${org.tags.top.map(([emoji, label, n], i) =>
        `<span class="tag-chip on" style="--i:${i}">${esc(emoji)} ${esc(label)} <b>${fmt(n)}</b></span>`).join("")}</div>`); });
      at(org.tags.top.length * 110 + 300, () => list.querySelector('[data-step="tags"]').classList.add("done"));
    } else at(300, () => list.querySelector('[data-step="tags"]')?.classList.add("done"));
    at(900, () => { orgDone = true; });
  }
  let orgDone = false;
  const view0 = S.view;
  function reveal(found) {
    finale = true;
    clearInterval(grabTimer);
    clearGrab();
    const cut = found.cut || {}, labels = (S.lib && S.lib.labels) || {};
    const reasons = Object.entries(cut).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const cutN = Object.values(cut).reduce((a, b) => a + b, 0);
    const kinds = Object.entries(found.cats || {}).sort((a, b) => b[1] - a[1]);
    $("#an-steps").innerHTML = Object.entries(STEP_ICONS).map(([, i]) => `<li class="done">${i}</li>`).join("");
    $("#an-body").dataset.scene = "reveal";
    $("#an-panel").className = "an-panel an-reveal-panel";
    $("#an-panel").hidden=false;
    $("#an-panel").innerHTML = `<div class="an-reveal">
      <h2>Here's what I found</h2>
      <div class="an-cards">
        <div class="an-card" style="--i:0"><span class="an-card-ico">📷</span><b>${fmt(found.photos)}</b><span>photos</span></div>
        <div class="an-card" style="--i:1"><span class="an-card-ico">🧩</span><b>${fmt(found.in_bursts)}</b><span>burst takes stacked</span>
          <span class="an-thumbs">${(found.stacked || []).map((id) => `<img src="${T(id)}" alt="">`).join("")}</span></div>
        <div class="an-card" style="--i:2"><span class="an-card-ico">🗃️</span><b>${fmt(cutN)}</b><span>set aside${reasons.length ? `: ${reasons.map(([r, n]) => `${fmt(n)} ${esc(labels[r] || r)}`).join(", ")}` : ""}</span>
          <span class="an-thumbs">${(found.cut_photos || []).map((id) => `<img src="${T(id)}" alt="">`).join("")}</span></div>
        ${found.me && MODE() !== "gallery" ? `<div class="an-card" style="--i:3"><span class="an-card-ico">🙂</span><b>${fmt(found.me.photos)}</b><span>photos of you</span>
          <span class="an-thumbs round">${(found.me.faces || []).slice(0, 6).map((f) => `<img src="${F(f)}" alt="">`).join("")}</span></div>`
          : `<div class="an-card" style="--i:3"><span class="an-card-ico">🙂</span><b>${fmt(found.faces || 0)}</b><span>faces</span></div>`}
        <div class="an-card wide" style="--i:4"><span class="an-card-ico">🧠</span><b>${fmt(found.shots)}</b><span>shots in the running</span>
          <span class="an-kinds-mini">${kinds.map(([k, n]) => `<span>${(KINDS[k] || ["", k])[0]} ${fmt(n)}</span>`).join("")}</span></div>
        ${found.tags ? `<div class="an-card wide" style="--i:5"><span class="an-card-ico">🏷️</span><b>${fmt(found.tags.tags)}</b><span>tags, the groups are worked out from</span>
          <span class="an-kinds-mini">${(found.tags.top || []).slice(0, 8).map(([emoji, label, n]) => `<span>${esc(emoji)} ${esc(label)} ${fmt(n)}</span>`).join("")}</span></div>` : ""}
      </div></div>`;
    $("#an-forward").innerHTML=`<a class="btn primary big" href="#home" id="an-go">Let's play → <kbd>Enter</kbd></a>`;
    $("#an-label").textContent = "All done";
    $("#an-bar").style.width = "100%";
    $("#an-eta").textContent = "";
    Sound.play("crown");
    confetti(window.innerWidth / 2, window.innerHeight / 3, 80);
    $("#an-go").onclick = () => World.handover(sea);
    $("#an-go").focus();
    S.onKey = (e) => { if (e.key === "Enter" || e.key === "ArrowRight") { e.preventDefault(); World.handover(sea); location.hash = "#home"; } };
  }
  const tick = async () => {
    if (finale || left(view0)) return;
    try { await loadState(); } catch (_) { return; }
    if (left(view0)) return;
    if (!S.lib) { route(); return; }
    if (left(view0) || !$("#an-sea")) return;
    const p = S.lib.progress || {};
    const initial=catchingUp;
    let more=await readFeed();
    while(initial&&more&&!left(view0)){await sleep(0);more=await readFeed();}
    if (S.lib.analyzed && !S.lib.analyzing) {
      while (await readFeed()) { await sleep(0); }
      while (queue.length) { const [id, key] = queue.shift(); give(id, key); }
      flush();
    }
    if (left(view0) || !$("#an-sea")) return;
    const order = Object.keys(STEP_ICONS);
    const idx = order.indexOf(p.phase);
    if (idx >= 0) $("#an-steps").innerHTML = order.map((k, i) => `<li class="${i < idx ? "done" : i === idx ? "now" : ""}"
      title="${esc(words()[k] || (PHASES.find((x) => x[0] === k) || [, k])[1])}">${STEP_ICONS[k]}</li>`).join("");
    if (S.lib.analyzed && !S.lib.analyzing) {
      if (!worked || !p.found) { stopPolling(); location.hash = "home"; route(); return; }
      if (!orgPlayed) {  // show what organizing did before the reveal
        $("#an-label").textContent = words().organizing || PHASES.find((x) => x[0] === "organizing")[1];
        $("#an-bar").style.width = "100%";
        $("#an-eta").textContent = "";
        stage({ ...p, phase: "organizing" });
      }
      if (!orgDone) return;
      stopPolling();
      return reveal({ ...p.found, tags: (p.org || {}).tags });
    }
    const label = idx >= 0 ? words()[p.phase] || PHASES[PHASES.findIndex(([k]) => k === p.phase)][1] : p.phase === "error" ? "Something went wrong" : "Starting…";
    $("#an-label").textContent = p.total ? `${label} · ${fmt(p.done)} / ${fmt(p.total)}` : label;
    $("#an-bar").style.width = `${Math.round((p.total ? p.done / p.total : 0) * 100)}%`;
    let eta = "";
    if (p.total && p.done - (p.start_done||0) > 8 && p.started) {
      const rate = (p.done-(p.start_done||0)) / Math.max(1, Date.now() / 1000 - p.started);
      const rest = (p.total - p.done) / Math.max(rate, 0.01);
      eta = rest > 90 ? `about ${Math.round(rest / 60)} min left in this step` : `${Math.max(1, Math.round(rest))} s left in this step`;
    }
    $("#an-eta").textContent = eta;
    if (p.phase && p.phase !== "done") stage(p);
    const e = $("#an-error");
    e.hidden = p.phase !== "error";
    if (p.phase === "error") {
      e.innerHTML = `${esc(p.error || "Unknown error")} <button class="btn" id="retry">Try again</button>`;
      $("#retry").onclick = async () => { try { await api("/api/rescan", {}); } catch (e) { if (!left(view0)) toast(e.message); } };
    }
  };
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try { await tick(); } catch (e) { if (!left(view0)) toast(e.message); }
    finally { polling = false; }
  };
  poll();
  S.poll = setInterval(poll, 600);
}

// ---------------------------------------------------------------- home: the journey
// The journey, in order. Filter chooses contenders, then organize: stacks (the same picture or burst), then groups (every stack
// and shot into a theme). Then play: crown (duels inside each stack), the group stage (duels inside each group), the
// knockouts (the best of each group), the finals, the reveal. The sweep is a side quest. The map (home) and the track
// in the top HUD both read journeyStatus.
const STAGES = [
  ["filter", "🎛️", "Filter", "Choose your contenders", "Preview quality and subject rules. Every set-aside photo can come back."],
  ["stacks", "🧩", "Stacks", "Stack the takes", "The same picture (a crop, a copy) or a burst: one stack each. Check the possible twins."],
  ["crown", "👑", "Crown", "Crown the stacks", "Each stack's takes duel for the one that plays on."],
  ["draw", "🗂️", "Groups", "Group them", "Every stack and single shot goes into a themed group."],
  ["groups", "⚽", "Group stage", "Group stage", "A mini-tournament inside each group. The best of each go through."],
  ["duels", "⚔️", "Knockouts", "Knockouts", "The group winners face off. Every call moves the leaderboard."],
  ["finals", "🏆", "Finals", "Finals", "Your top 8 in a bracket: quarterfinals, semis, bronze, the final."],
  ["reveal", "🎉", "Reveal", "Reveal", "The podium, what you go for, and your best shots to keep."],
];
// The HUD's track also carries the two places around the game: the map (home: every photo on the sea) before Filter
// and the leaderboard (the finishing stage) after Reveal. They are waypoints, not stages of the journey's order.
const TRACK = [["map", "🗺️", "Map", "The map", "Every photo on the sea: home."], ...STAGES,
  ["board", "🏅", "Leaderboard", "Leaderboard", "Your best, one still card at a time, finished and kept."]];
const ring = (frac) => `<svg viewBox="0 0 36 36" class="ring" aria-hidden="true"><circle cx="18" cy="18" r="15.5" class="ring-bg"/>
  ${frac > 0 ? `<circle cx="18" cy="18" r="15.5" class="ring-fg" stroke-dasharray="${(Math.min(1, frac) * 97.4).toFixed(1)} 97.4"/>` : ""}</svg>`;

// Groups lead on to the group stage: the kickoff the first time, the matches once it has started.
function groupStageForward() {
  const g = S.journey?.stages?.groups;
  return { label: "Next: Group stage →", name: "Group stage", href: g?.played ? "#duel?stage=groups" : "#tournament?kickoff=1" };
}

function journeyStatus(j) {
  const st = j.stages, fin = st.finals;
  const out = {
    map: { line: "Every photo on the sea", go: "#home", label: "Map" },
    filter: { done: !!st.filter?.done, line: st.filter?.done ? `${plural(st.filter.kept,"photo")} in · ${fmt(st.filter.aside)} set aside`
        : "Choose what enters the tournament", go: "#filter", label: st.filter?.done ? "Review filter" : "Start Filter" },
    stacks: st.stacks.twins ? { line: `${plural(st.stacks.twins, "possible twin")} to check · ${plural(st.stacks.stacks, "stack")} so far`,
      go: "#stacks", label: "Check them" }
      : { done: true, line: `Stacks look right · ${plural(st.stacks.stacks, "stack")}`, go: "#stacks", label: "Open" },
    crown: st.crown.left ? { line: `${plural(st.crown.left, "stack")} still to crown${st.crown.total ? ` of ${fmt(st.crown.total)}` : ""}`,
      go: "#duel?stage=stacks", label: st.crown.left < st.crown.total ? "Continue" : "Crown them",
      bar: st.crown.total ? 1 - st.crown.left / st.crown.total : 0 }
      : { done: true, line: st.crown.total ? `All ${plural(st.crown.total, "stack")} crowned` : "No stacks to crown here", go: "#duel?stage=stacks", label: "Open" },
    draw: st.draw.done ? { done: true, line: `Every shot is in a group (${plural(st.draw.groups, "group")})`, go: "#draw", label: "Open" }
      : { line: st.draw.drawn ? `${fmt(st.draw.drawn)} of ${fmt(st.draw.total)} grouped · ${plural(st.draw.groups, "group")}`
          : `${plural(st.draw.total, "shot")} waiting for a group`,
          go: "#draw", label: st.draw.drawn ? "Continue" : "Start grouping", bar: st.draw.total ? st.draw.drawn / st.draw.total : 0 },
    groups: !st.groups.groups ? { line: "Kicks off once you've made some groups", go: "#draw", label: "Groups" }
      : st.groups.done ? { done: true, line: `All ${plural(st.groups.groups, "group")} decided · ${fmt(st.groups.through)} through to the knockouts`,
          go: "#duel?stage=groups", label: "Open" }
      : { line: `${st.groups.now ? `Now: Group ${st.groups.now.letter}, ${esc(st.groups.now.emoji)} ${esc(st.groups.now.name)} · ` : ""}${fmt(st.groups.settled)} of ${fmt(st.groups.groups)} decided`,
          go: st.groups.played ? "#duel?stage=groups" : "#tournament?kickoff=1", label: st.groups.played ? "Continue" : "Kick off", bar: st.groups.settled / st.groups.groups },
    duels: { done: st.duels.done || fin.state === "done", skipped: !!st.duels.skipped, go: st.duels.skipped ? "#finals" : "#duel?stage=knockouts",
      label: st.duels.skipped ? "Finals" : st.duels.votes ? "Keep playing" : "Play",
      line: st.duels.skipped ? `Skipped: ${plural(st.duels.knockouts?.qualified?.length || 4,"finalist")} went straight to the bracket`
        : st.duels.done ? `${plural(st.duels.knockouts?.qualified?.length || 8,"finalist")} qualified` : st.duels.knockouts?.rounds?.length ? `${plural(st.duels.left,"match")} left in the current round` : "Elimination rounds decide who reaches the finals", bar: st.duels.done ? 1 : 0 },
    finals: fin.state === "done" ? { done: true, line: "Champion crowned", go: "#finals", label: "Bracket", thumb: fin.champion }
      : fin.state === "playing" ? { line: "The bracket is on", go: "#finals", label: "Continue" }
      : !fin.eligible ? { line: "Needs at least 4 shots in this cup", go: "#finals", label: "Finals" }
      : fin.state === "ready" ? { line: "Your finalists are ready to face off", go: "#finals", label: "Start the finals" }
      : { line: `Fairest from 80% (you're at ${pct(st.duels.quality)})`, go: "#finals", label: "Finals" },
    reveal: { line: st.reveal.ready ? "Ready when you are" : "Best after the finals", go: "#reveal", label: "Open" },
    board: { line: fin.state === "done" ? "Your best, finished and kept" : "Your best so far, one card at a time", go: "#shortlist", label: "Leaderboard" },
    sweep: !st.sweep.done ? { line: `${plural(st.sweep.left, "quick keep-or-toss call")} on photos the sorter wasn't sure about`, go: "#sweep", label: "Sweep" }
      : { done: true, line: "Swept", go: "#sweep", label: "Open" },
  };
  for (const [k,pid] of Object.entries(j.thumbs || {})) if (out[k] && pid) out[k].thumb=pid;
  out.next = (j.order || STAGES.map((x) => x[0])).find((k) => !out[k].done) || "reveal";
  return out;
}

// ---------------------------------------------------------------- the HUD: your save, the journey track, the menu
S.journey = null;
let hudAt = 0, hudBusy = null, hudSource = null;
async function refreshHud(force) {
  if (!S.lib || !S.lib.analyzed || S.lib.analyzing) return;
  const source = `${S.lib.source}:${S.lib.cup}`;
  if (!force && hudSource === source && hudBusy) return hudBusy;
  if (!force && hudSource === source && S.journey && performance.now() - hudAt < 2000) { paintTrack(); return; }
  hudAt = performance.now();
  hudSource = source;
  const request = api("/api/journey").then((j) => {
    if (hudBusy !== request || source !== `${S.lib?.source}:${S.lib?.cup}`) return;
    S.journey = j; if (j.progress && j.progress.game && !S.game) S.game = j.progress.game;
  }).catch(() => {}).finally(() => {
    if (hudBusy !== request) return;
    hudBusy = null; paintTrack(); paintSaveChip();
  });
  hudBusy = request;
  return request;
}
function currentStage() {
  const [name, q] = location.hash.slice(1).split("?");
  const p = new URLSearchParams(q || "");
  if (["filter","draw","finals","reveal","stacks"].includes(name)) return name;
  if (["home","ready","map",""].includes(name)) return "map";
  if (["shortlist","leaderboard"].includes(name)) return "board";
  if (["cuts","sweep","people"].includes(name)) return "filter";
  if (name === "tags") return "draw";
  if (name === "tournament" && p.get("kickoff") === "1") return "groups";
  if (name === "duel") {
    const st = p.get("stage") || S.stage;
    return st === "stacks" ? "crown" : st === "groups" ? "groups" : st === "open" ? null : "duels";
  }
  return null;
}
function paintTrack() {
  const nav = $("#track"),j=S.journey;
  if (!nav) return;
  if (!j) { nav.replaceChildren(); nav.journeyMarkup = null; return; }
  const st=journeyStatus(j),here=currentStage(),index=TRACK.findIndex(([k])=>k===here);
  // The map's forward arrow leads to the journey's next stage, every other place's to its neighbour on the track.
  const next=here&&here!=='map'?TRACK[index+1]?.[0]:st.next,previous=here?TRACK[index-1]?.[0]:null;
  const label=key=>({stacks:'Stack',draw:'Group'})[key]||TRACK.find(([k])=>k===key)?.[2];
  const title=here&&here!=='map'?label(here):menuActivity().title;
  const available=S.pauseActivity?.canForward,canForward=(typeof available==='function'?available():available)!==false;
  const ready=S.forward;
  const step=(id,key,icon)=>id==='next'&&ready?`<a id="journey-next" class="journey-step ready" href="${esc(ready.href||'#')}" aria-disabled="false" aria-label="Next: ${esc(ready.name||label(key)||'')}" title="${esc(ready.label)}"><span class="journey-go">${esc(ready.label)}</span></a>`
    :key?`<a id="journey-${id}" class="journey-step" href="${st[key].go}"${id==='next'?` aria-disabled="${!canForward}"`:""} aria-label="${id==='prev'?'Previous':'Next'}: ${label(key)}" title="${label(key)}">${icon}</a>`:`<span class="journey-step empty" aria-hidden="true"></span>`;
  const html=`${step('prev',previous,'‹')}<ol class="track-stages">${TRACK.map(([k,icon,short,description])=>{
    const n=STAGES.findIndex(([s])=>s===k)+1,skipped=!!st[k].skipped,state=k===here?'Current':st[k].done?'Complete':k===next?'Next':n?`Stage ${n}`:short;
    return `<li><a class="tnode ${st[k].done?'done':''} ${skipped?'skipped':''} ${k===next?'next':''} ${k===here?'here':''}"
      data-stage="${k}" href="${st[k].go}" aria-label="${short}: ${state.toLowerCase()}${st[k].done&&k===here?', complete':''}${skipped?', skipped':''}"
      title="${esc(description)}: ${esc(st[k].line.replace(/<[^>]+>/g,''))}" ${k===here?'aria-current="step"':''}>
      <span class="tico" aria-hidden="true">${icon}${st[k].done?`<i class="tcheck ${skipped?'skip':''}">${skipped?'–':'✓'}</i>`:''}</span><span class="twords"><span class="tlabel">${label(k)}</span></span></a></li>`;
  }).join('')}</ol>${step('next',next,'›')}<h1 id="journey-title" title="Back to the map" tabindex="0" role="link">${esc(title)}</h1>`;
  // HUD refreshes must not steal keyboard focus while someone walks the journey.
  if(nav.journeyMarkup===html)return;
  const focused=nav.contains(document.activeElement)?document.activeElement:null,stage=focused?.dataset.stage,id=focused?.id;
  nav.innerHTML=html;nav.journeyMarkup=html;
  if(stage)nav.querySelector(`[data-stage="${stage}"]`)?.focus({preventScroll:true});else if(id)$(`#${id}`,nav)?.focus({preventScroll:true});
  const forward=$('#journey-next',nav);
  if(forward)forward.onclick=e=>{
    // A ready stage runs its own way on; otherwise Filter's arrow confirms its preview before leaving the stage.
    // The pressed button lets go of keyboard focus: the next screen's game keys (Space, arrows) belong to the game.
    if(S.forward){forward.blur();if(S.forward.run){e.preventDefault();S.forward.run();}return;}
    if(!S.pauseActivity?.forward)return;
    e.preventDefault();
    const allowed=S.pauseActivity?.canForward;
    if((typeof allowed==='function'?allowed():allowed)===false)return;
    S.pauseActivity.forward();
  };
}
// The one way forward lives in the HUD's next slot. A view declares it when its stage is ready to proceed
// ({label, name, href} or {label, name, run}); until then the slot stays the quiet arrow.
function setForward(forward) { S.forward = forward || null; paintTrack(); }
function forwardGo() { const f = S.forward; if (!f) return false; if (f.run) f.run(); else if (f.href) location.hash = f.href; return true; }
function paintGameHelp() {
  const button=$('#game-help'),hint=$('#game-help-hint'),bare=document.body.classList.contains('no-bar');
  if(!button)return;button.hidden=hint.hidden=bare;
  const on=S.lib?.settings?.help!==false;
  document.body.classList.toggle('help-off',!on);
  button.setAttribute('aria-pressed',String(on));button.setAttribute('aria-label',`Helpful overlays ${on?'on':'off'}`);
  button.title=`Turn helpful overlays ${on?'off':'on'}`;
  hint.textContent=S.hint??defaultHint();
}
// A hint describes the current state, not just the view: finish screens and minigames set their own; route() clears it.
function defaultHint() {
  const [name,query]=location.hash.slice(1).split('?'),p=new URLSearchParams(query||'');
  if(name==='filter')return 'Drag the line. Takes on the right stay in play.';
  if(name==='stacks')return p.has('check')?'Same shot? Right stacks them; left keeps them apart.':'Open a stack to spread its takes.';
  if(name==='draw')return p.has('sort')?'→ files it in the starred group. ↑ ↓ pick another, N starts a new one.':p.has('play')?'→ adds it to the group, ← leaves it out.':'Gather photos by tag, then shape your groups.';
  if(name==='duel'||name==='finals')return 'Choose a photo. Space saves this match for later.';
  if(name==='reveal')return 'Enter saves your best shots to a folder.';
  if(name==='shortlist'||name==='leaderboard')return '← → browse your best. Right-click a photo for its notes and finishing controls.';
  if(name==='tags')return 'Choose a tag to see its photos. Rename, merge or correct it here.';
  if(name==='cuts')return 'Nothing was deleted. Click a set-aside photo to bring it back.';
  if(name==='tournament')return 'Pick a group to play, or kick off from the first.';
  return 'Drag photos onto each other to stack. Click to zoom; double-click grabs. Enter starts the next stage.';
}
function setHint(text) { S.hint=text||null; paintGameHelp(); }
const helpPreferenceKey=library=>library?.source?`matcher-help:${library.source}`:null;
function readHelpPreference(library) {
  const key=helpPreferenceKey(library);if(!key)return null;
  try{const saved=JSON.parse(localStorage.getItem(key)||'null');return saved?.pending&&typeof saved.value==='boolean'?saved:null;}catch(_){return null;}
}
const helpSaves=new Map();
async function saveHelpPreference(library,value) {
  const key=helpPreferenceKey(library);if(!key)return;
  const existing=helpSaves.get(key);if(existing){await existing.catch(()=>{});if(readHelpPreference(library)?.value!==value)return;}
  if(S.lib?.source!==library.source)return;  // A queued preference belongs to the save that produced it.
  // Cache before sending: an immediate reload must not resurrect the first-time hints.
  const task=api('/api/settings',{help:value});helpSaves.set(key,task);
  try{const reply=await task,pending=readHelpPreference(library);if(reply.settings?.help===value&&pending?.value===value)localStorage.removeItem(key);}
  catch(_){/* A pending per-save preference is retried when this save is opened again. */}
  finally{if(helpSaves.get(key)===task)helpSaves.delete(key);}
}
function toggleGameHelp() {
  if(!S.lib)return;const library=S.lib,value=library.settings?.help===false;
  library.settings={...library.settings,help:value};
  try{localStorage.setItem(helpPreferenceKey(library),JSON.stringify({value,pending:true}));}catch(_){}
  paintGameHelp();saveHelpPreference(library,value);
}
$('#game-help').onclick=toggleGameHelp;
// Pause keeps the current activity mounted; leaving it is an explicit choice.
function playTime() {
  const now=performance.now();
  return now-(S.pauseTotal||0)-(S.pause?now-S.pause.at:0);
}
function menuActivity() {
  const [name,query]=location.hash.slice(1).split('?'),p=new URLSearchParams(query||'');
  if(S.pauseActivity)return S.pauseActivity;
  if(name==='tags'&&p.has('play'))return {title:'Tag check',label:'Back to Tag lab',href:`#tags?key=${encodeURIComponent(p.get('play'))}`};
  if(name==='stacks'&&p.has('check'))return {title:'Same shot?',label:'Back to Stacks',href:'#stacks'};
  if(['draw','groups'].includes(name)&&(p.has('play')||p.has('sort')))return {title:p.has('play')?'Find more':'Quick sort',label:'Back to Groups',href:p.has('play')?`#draw?g=${encodeURIComponent(p.get('play'))}`:'#draw'};
  if(name==='duel'){
    const back={stacks:['Back to Stacks','#stacks'],groups:['Back to Groups','#draw'],knockouts:['Back to Tournament','#tournament']}[S.stage]||['Leave activity · Map','#home'];
    return {title:S.lr?'Lightning round':({stacks:'Crown',groups:'Group stage',knockouts:'Knockouts',open:'Open arena'}[S.stage]||'Duels'),label:back[0],href:back[1]};
  }
  if(name==='finals')return {title:'Finals',label:'Back to Tournament',href:'#tournament'};
  if(name==='sweep')return {title:'Clean-up sweep',label:'Back to Filter',href:'#filter'};
  if(name==='people')return {title:"Who's who",label:'Leave activity · Map',href:'#home'};
  return {title:({home:'The map',filter:'Filter',draw:'Groups',groups:'Groups',stacks:'Stacks',tags:'Tag lab',finals:'Finals',reveal:'Reveal',shortlist:'Leaderboard',leaderboard:'Leaderboard',cuts:'Set aside',tournament:'Tournament',saves:'Your saves',onboard:'New save',analyze:'Analysis'}[name]||'MatchER')};
}
function closeMenu(resume=true) {
  const pause=S.pause,m=$('#menu');
  if(!pause){if(m.open)m.close();return;}
  S.pauseTotal=(S.pauseTotal||0)+performance.now()-pause.at;
  S.pause=null;pause.signal?.removeEventListener('abort',pause.abort);document.body.classList.remove('game-paused');
  if(m.open)m.close();
  if(left(pause.view))return;
  if(pause.sea&&pause.sea===World.sea){pause.sea.paused=pause.seaPaused;if(resume&&!pause.seaPaused){pause.sea.last=0;pause.sea.kick();}}
  if(resume){
    const now=performance.now(),lr=S.lr;
    if(lr?.pausedAt!=null){lr.ends+=now-lr.pausedAt;delete lr.pausedAt;lr.tick?.();}
    if(pause.focus?.isConnected)pause.focus.focus({preventScroll:true});
  }
}
function openMenu() {
  const m=$('#menu');if(m.open)return;
  if(S.pause)closeMenu();
  const analysisPage=location.hash.startsWith('#analyze'),running=!!S.lib?.analyzing,ready=S.lib?.analyzed&&!running;
  const activity=menuActivity(),sea=World.sea,signal=S.events?.signal;
  const pause=S.pause={view:S.view,at:performance.now(),focus:document.activeElement,sea,seaPaused:sea?.paused,signal};
  pause.abort=()=>closeMenu(false);signal?.addEventListener('abort',pause.abort,{once:true});
  if(sea){sea.paused=true;cancelAnimationFrame(sea.raf);sea.raf=0;}
  if(S.lr){S.lr.pausedAt=performance.now();cancelAnimationFrame(S.lr.raf);}
  document.body.classList.add('game-paused');closeHelp();
  const sw=S.journey?.stages.sweep,cup=S.journey?.cups?.find(c=>c.key===S.journey.cup);let menuPage='';
  function paint(page='',focus=true){
    menuPage=page;
    const title=({play:'Activities',view:'Picture & sound',library:'Library'})[page]||activity.title;
    const pages={
      play:`<a href="#home">🗺️ <span>The map</span></a><a href="#tournament">🏟️ <span>Tournament board</span></a><a href="#shortlist">🏅 <span>Leaderboard</span></a>
        <a href="#filter">✦ <span>Filter</span></a><a href="#tags">🏷️ <span>Tag lab</span></a>
        <a href="#sweep">🧹 <span>Clean-up sweep</span>${sw&&!sw.done&&sw.left?`<b class="menu-badge">${fmt(sw.left)}</b>`:''}</a>
        <a href="#cuts">🗃️ <span>Set aside</span></a>${MODE()==='me'?'<a href="#people">🧑 <span>People</span></a>':''}
        ${S.homeTag?`<a href="#tags?play=${encodeURIComponent(S.homeTag)}">🏷️ <span>Tag check</span></a>`:''}
        ${cup?.shots>=2?'<a href="#duel?stage=open">⚔️ <span>Open arena</span></a><a href="#duel?stage=open&lightning=1">⚡ <span>60-second round</span></a>':''}
        <button data-m="trophies">🏆 <span>Trophies</span></button>`,
      view:`<button data-m="sound">${Sound.on?'🔊':'🔇'} <span>Sound ${Sound.on?'on':'off'}</span></button>
        <button data-m="sea">🌊 <span>Colour wash ${Sea.on?'on':'off'}</span></button>
        ${ready?'<button data-m="axes">↔ <span>Sea axes</span></button>':''}
        ${ready?`<button data-m="filter">🎨 <span>Enhance ${S.filter?'on':'off'}</span><kbd>F</kbd></button>
        <button data-m="crop">🔲 <span>Auto-crop ${CROP_MENU[normCrop(S.crop)]}</span><kbd>C</kbd></button>`:''}`,
      library:`${S.lib||S.recent.length?'<a href="#saves">💾 <span>Switch save</span></a>':''}${ready?'<button data-m="settings">⚙️ <span>Settings</span></button>':''}`
    };
    const played=S.journey?.progress||S.progress,confidence=ready&&played?.k&&played.quality!=null?` · leaderboard at ${pct(played.quality)} of its best`:'';
    m.innerHTML=`<div class="menu-head"><div><span class="muted small">${running?'Analysis continues':ready?'Paused':'Menu'}${confidence}</span><h2>${esc(title)}</h2></div><button class="icon" id="menu-close" aria-label="Resume">✕</button></div>
      <div class="menu-play"><button class="btn primary big" id="menu-resume">${analysisPage?'Back to analysis':'Resume'} <kbd>Esc</kbd></button>
      ${!page&&activity.label?`<button class="btn" id="menu-leave">${esc(activity.label)}</button>`:''}</div>
      <nav class="menu-list" aria-label="Game tools">${page?`<button id="menu-back">← <span>Back</span></button>${pages[page]}`:
        `${(activity.actions||[]).map((a,i)=>`<button data-menu-action="${i}"${a.id?` id="${esc(a.id)}"`:''}>↶ <span>${esc(a.label)}</span></button>`).join('')}${ready&&!location.hash.startsWith('#home')&&location.hash!==''?'<a href="#home">🗺️ <span>The map</span></a>':''}${ready?'<button data-menu-page="play">🎮 <span>Activities</span>›</button>':''}${$('#main [data-help]')?'<button data-m="help">? <span>How this works</span></button>':''}${ready&&!location.hash.startsWith('#filter')?'<button data-m="history-undo">↶ <span>Undo last change</span><kbd>Z</kbd></button>':''}<button data-menu-page="view">🎨 <span>Picture & sound</span>›</button>${S.lib||S.recent.length?'<button data-menu-page="library">💾 <span>Library</span>›</button>':''}`}</nav>`;
    $('#menu-close',m).onclick=$('#menu-resume',m).onclick=()=>closeMenu();
    if(page)$('#menu-back',m).onclick=()=>paint();
    const leave=$('#menu-leave',m);if(leave)leave.onclick=()=>{closeMenu();if(activity.leave)activity.leave();else location.hash=activity.href;};
    $$('[data-menu-page]',m).forEach(b=>b.onclick=()=>paint(b.dataset.menuPage));
    $$('[data-menu-action]',m).forEach(b=>b.onclick=()=>{closeMenu();activity.actions[Number(b.dataset.menuAction)].run();});
    $$('.menu-list a',m).forEach(a=>a.onclick=()=>closeMenu());
    $$('[data-m]',m).forEach(b=>b.onclick=()=>{
      if(b.dataset.m==='help'){closeMenu();queueMicrotask(()=>showHelp($('#main [data-help]')?.dataset.help,$('#game-help')));return;}
      if(b.dataset.m==='history-undo'){closeMenu();if(typeof HistoryHUD!=='undefined')HistoryHUD.act('undo');return;}
      if(b.dataset.m==='trophies'){openTrophies();return;}
      if(b.dataset.m==='settings'){openSettings();return;}
      if(b.dataset.m==='axes'){closeMenu();openSeaAxes();return;}
      if(b.dataset.m==='sea'){Sea.toggle();b.innerHTML=`🌊 <span>Colour wash ${Sea.on?'on':'off'}</span>`;}
      else if(b.dataset.m==='filter'){toggleFilter();b.querySelector('span').textContent=`Enhance ${S.filter?'on':'off'}`;}
      else if(b.dataset.m==='crop'){toggleCrop();b.querySelector('span').textContent=`Auto-crop ${CROP_MENU[normCrop(S.crop)]}`;}
      else {Sound.toggle();paintSound();b.innerHTML=`${Sound.on?'🔊':'🔇'} <span>Sound ${Sound.on?'on':'off'}</span>`;}
    });
    if(focus)$(page?'#menu-back':'#menu-resume',m).focus();
  }
  paint('',false);
  m.onclick=e=>{if(e.target===m)closeMenu();};
  m.oncancel=e=>{e.preventDefault();if(menuPage)paint();else closeMenu();};
  m.onclose=()=>{if(!m.open&&S.pause===pause)closeMenu();};
  m.showModal();$('#menu-resume',m).focus();
}

let seaAxisSaving=Promise.resolve();
function openSeaAxes(){
  if(!S.lib||!World.sea)return;
  const modal=$('#modal'),source=S.lib.source,opener=document.activeElement;
  let axes=SeaAxes.normalize(S.lib.settings?.sea_axes),revision=0;
  modal.className='sea-axis-dialog';modal.onclick=e=>{if(e.target===modal)modal.close();};
  modal.innerHTML=`<header class="sea-axis-head"><div><span class="sea-axis-kicker">A different way to look</span><h2 id="sea-axis-title">Arrange the sea</h2></div><button class="icon" data-axis-close aria-label="Close sea axes">✕</button></header>
    <p class="sea-axis-intro">Choose what draws photos together. Their colours travel with them.</p>
    <div class="sea-axis-fields">${['x','y'].map(axis=>`<section class="sea-axis-field"><label for="sea-axis-${axis}"><b>${axis.toUpperCase()}</b> ${axis==='x'?'Across the sea':'Up the sea'}</label>
      <select id="sea-axis-${axis}" data-axis="${axis}">${SeaAxes.options.map(o=>`<option value="${o.key}">${esc(o.label)}</option>`).join('')}</select>
      <button class="sea-axis-direction" data-axis-reverse="${axis}" aria-pressed="false"></button></section>`).join('')}</div>
    <p class="sea-axis-hint">Photos without a measurement sit near the middle. Stacks stay together.</p>
    <form class="sea-axis-date" hidden><label for="sea-axis-day">Find a day</label><div><input type="date" id="sea-axis-day" required><button class="btn" type="submit">Jump →</button></div><small></small></form>
    <footer class="sea-axis-footer"><button class="btn" data-axis-reset>Reset axes</button><button class="btn primary" data-axis-close>Done</button></footer><p class="sea-axis-status" role="status"></p>`;
  modal.setAttribute('aria-labelledby','sea-axis-title');
  const status=$('.sea-axis-status',modal),dateForm=$('.sea-axis-date',modal),dates=[...(World.photos?.values()||[])].filter(p=>Number.isFinite(p.measurements?.date)).sort((a,b)=>a.measurements.date-b.measurements.date),
    day=p=>p.taken?.slice(0,10)||new Date(p.measurements.date*1000).toISOString().slice(0,10);
  function paint(){
    for(const axis of ['x','y']){
      const option=SeaAxes.options.find(o=>o.key===axes[axis]),reverse=axes[axis==='x'?'reverseX':'reverseY'],button=$(`[data-axis-reverse="${axis}"]`,modal);
      $(`[data-axis="${axis}"]`,modal).value=axes[axis];button.setAttribute('aria-pressed',String(reverse));
      const low=reverse?option.high:option.low,high=reverse?option.low:option.high;
      button.textContent=axis==='x'?`${low} → ${high} ⇄`:`↑ ${high} · ↓ ${low} ⇄`;
      button.setAttribute('aria-label',`Reverse ${axis.toUpperCase()} axis; ${axis==='x'?`${low} at the left, ${high} at the right`:`${high} at the top, ${low} at the bottom`}`);
    }
    dateForm.hidden=!(axes.x==='date'||axes.y==='date')||!dates.length;
    $('.sea-axis-hint',modal).textContent=[axes.x,axes.y].includes('ranking')?'Your ranking learns from comparisons. Photos without a measurement sit near the middle.':
      [axes.x,axes.y].includes('quality')?'Photo quality is the analysis estimate. Photos without a measurement sit near the middle.':'Photos without a measurement sit near the middle. Stacks stay together.';
    if(dates.length){const input=$('#sea-axis-day',modal);input.min=day(dates[0]);input.max=day(dates.at(-1));if(!input.value)input.value=input.min;$('small',dateForm).textContent=`${input.min} — ${input.max}`;}
  }
  function apply(){
    axes=SeaAxes.normalize(axes);S.lib.settings={...S.lib.settings,sea_axes:axes};
    const sea=World.sea;sea.axes=axes;if(sea.cameraOn){sea.releaseFocus();sea.resetCamera();}sea.sendBodies();
    window.dispatchEvent(new Event('sea-axes'));paint();
    const edit=++revision,snapshot={...axes};status.textContent='Saving…';
    const task=seaAxisSaving.catch(()=>{}).then(()=>S.lib?.source===source?api('/api/settings',{sea_axes:snapshot}):null);seaAxisSaving=task;
    task.then(reply=>{
      if(reply&&S.lib?.source===source&&edit===revision&&SeaAxes.equal(S.lib.settings.sea_axes,snapshot)){
        S.lib.settings={...S.lib.settings,sea_axes:reply.settings.sea_axes};status.textContent='Saved with this library';
      }
    }).catch(error=>{if(edit===revision)status.textContent=`Could not save: ${error.message}`;});
  }
  $$('[data-axis]',modal).forEach(select=>select.onchange=()=>{axes={...axes,[select.dataset.axis]:select.value};apply();});
  $$('[data-axis-reverse]',modal).forEach(button=>button.onclick=()=>{const key=button.dataset.axisReverse==='x'?'reverseX':'reverseY';axes={...axes,[key]:!axes[key]};apply();});
  $('[data-axis-reset]',modal).onclick=()=>{axes={...SeaAxes.defaults};apply();};
  $$('[data-axis-close]',modal).forEach(button=>button.onclick=()=>modal.close());
  dateForm.onsubmit=e=>{
    e.preventDefault();const target=$('#sea-axis-day',modal).value;if(!target)return;
    const stamp=new Date(`${target}T12:00:00`).getTime()/1000,closest=dates.reduce((best,p)=>Math.abs(p.measurements.date-stamp)<Math.abs(best.measurements.date-stamp)?p:best);
    const pid=closest.rep||closest.id;modal.close();
    if(World.sea.cameraOn){const it=World.sea.items.get(pid);if(it)World.sea.zoomToPrint(it);}
    else{World.jumpPhoto={source,pid};location.hash='#home';}
  };
  modal.addEventListener('close',()=>{modal.removeAttribute('aria-labelledby');if(opener?.isConnected)opener.focus({preventScroll:true});},{once:true});
  paint();modal.showModal();$('#sea-axis-x',modal).focus();
}

// The map is the sea. Its activities and cup choices live in the pause menu.
async function viewHome(main) {
  main.innerHTML=LOADING();const view=S.view,signal=S.events.signal;let j,tags;
  try{[j,tags]=await Promise.all([api('/api/journey'),api('/api/tags?all=1').then(r=>r.tags||[]).catch(()=>[])]);}
  catch(e){if(!left(view))main.innerHTML=FAILED(e.message);return;}
  if(left(view))return;
  S.journey=j;hudAt=performance.now();S.game=j.progress.game||{};
  S.homeTag=tags.filter(t=>t.count).sort((a,b)=>b.count-a.count)[0]?.key||null;
  const status=journeyStatus(j),forward=()=>{location.hash=status[status.next].go;};
  S.pauseActivity={title:'The map',forward,actions:j.cups.length>1?[{id:'home-cups',label:'Choose cup',run:chooseCup}]:[]};
  S.onKey=e=>{if(e.key==='Enter'){e.preventDefault();forward();}};
  const nextStage=STAGES.find(([k])=>k===status.next);
  main.innerHTML=`<div class="screen map journey no-rail"><span hidden data-help="${esc('Explore the sea or choose a stage above. The coral Next button and Enter continue your journey. Activities, cups and trophies are in the menu.')}" aria-hidden="true"></span><div class="screen-body map-body"><div class="map-sea" aria-hidden="true"></div></div></div>`;
  setForward({label:`Next: ${nextStage?.[2]||'Reveal'} →`,name:nextStage?.[2]||'Reveal',href:status[status.next].go});
  $('.map-body',main).insertAdjacentHTML('beforeend','<div class="map-readout" data-solid><div class="map-census stat-chip" role="status"></div><button class="sea-axis-chip" id="sea-layout" aria-label="Change sea axes"></button></div>');
  const axisChip=()=>{const axes=SeaAxes.normalize(S.lib?.settings?.sea_axes);$('#sea-layout',main).textContent=`↔ ${SeaAxes.label(axes.x)} · ↕ ${SeaAxes.label(axes.y)}`;};
  $('#sea-layout',main).onclick=openSeaAxes;window.addEventListener('sea-axes',axisChip,{signal});axisChip();
  const census=()=>{
    const target=$('.map-census',main);if(!target)return;
    if(World.photosSource!==S.lib.source){target.textContent=`Loading ${fmt(World.photos?.size)} of ${fmt(World.total)} photos…`;return;}
    const prints=[...World.photos.values()].filter(p=>p.id===p.rep),stacks=prints.filter(p=>p.members.length>1).length;
    target.textContent=`${plural(World.photos.size,'photo')} · ${plural(stacks,'stack')} · ${fmt(prints.length-stacks)} loose`;
    target.title='Every photo is represented. Takes in the same stack overlap as one pile; loose photos have their own print.';
    const jump=World.jumpPhoto,it=jump?.source===S.lib.source&&World.sea.items.get(jump.pid);
    if(it){World.jumpPhoto=null;requestAnimationFrame(()=>{if(!left(view))World.sea.zoomToPrint(it);});}
  };
  window.addEventListener('world-ready',census,{signal});census();
  const sea=World.sea,catalog=sea.catalog;sea.catalog=false;sea.el.classList.add('home-world');
  sea.dock?.classList.remove('tag-dock');sea.dock=null;sea.el.append(sea.tray);sea.tray.hidden=true;
  // The previous tag shelf can catch the pointer while Home loads. Hiding it also releases its hover.
  sea.highlight(null);for(const circle of sea.circles.values()){circle.hot=false;circle.still=false;}sea.layout();
  signal.addEventListener('abort',()=>{sea.catalog=catalog;sea.el.classList.remove('home-world');},{once:true});
  // The ranker's starting guesses wear no leaderboard ranks: badges appear once there are calls behind them.
  paintTrack();paintSaveChip();Ach.check(S.game);World.ranks((j.progress?.votes||0)>0?(j.top||[]).slice(0,9).map(x=>x.photo):[]);
  function chooseCup(){
    const modal=$('#modal');modal.className='';modal.onclick=null;
    modal.innerHTML=`<div class="row spread"><h2>Cups</h2><button class="btn" id="cups-close">Close</button></div><div class="cup-list">${j.cups.map(c=>`<button class="cup-row ${c.key===j.cup?'on':''}" data-cup="${esc(c.key)}" aria-pressed="${c.key===j.cup}">${c.cover?`<img src="${T(c.cover)}" alt="">`:'<span class="cup-blank"></span>'}<span><b>${esc(c.icon)} ${esc(c.name)}</b><span class="muted small">${plural(c.shots,'shot')}${c.champion?' · 🏆 crowned':c.finals==='playing'?' · finals on':''}</span></span></button>`).join('')}</div>`;
    $('#cups-close',modal).onclick=()=>modal.close();
    let busy=false;
    $$('[data-cup]',modal).forEach(button=>button.onclick=async()=>{
      if(busy)return;if(button.dataset.cup===j.cup){modal.close();return;}busy=true;
      try{await api('/api/cup',{cup:button.dataset.cup});await loadState();if(left(view))return;modal.close();Sound.play('pick');route();}
      catch(error){if(!left(view))toast(error.message);}finally{busy=false;}
    });
    modal.showModal();signal.addEventListener('abort',()=>modal.close(),{once:true});
  }
}

// ---------------------------------------------------------------- duel
function viewDuel(main, params) {
  const stack=params.get("stack"),crown=!!stack||params.get("stage")==="stacks";
  main.innerHTML = `
    <section id="view-duel" class="${crown ? "crown-play" : ["groups","knockouts"].includes(params.get("stage")) ? "with-table" : ""}">
      <div class="duel-head">
        <div class="question" id="duel-q">${QUESTION[MODE()]} <span>Gut call.</span></div>
        <span class="learnt" id="duel-learnt"></span>
        <div class="hud">
          <button class="icon bolt" id="hud-bolt" ${crown ? "hidden" : ""} title="Lightning round: as many calls as you can in 60 seconds" aria-label="Start a lightning round">⚡</button>
          <span class="streak" id="hud-streak" title="Quick calls in a row (under 4 s)"><span class="flame">🔥</span><b>0</b></span>
          <span id="duel-feedback" class="duel-feedback"></span>
          <div class="meter" title="How close your current leaderboard is to the best possible one (estimated; near-misses count as nearly as good)">
            <span id="m-votes"></span><div class="bar"><i id="m-bar"></i></div><span id="m-conf"></span>
          </div>
          <button class="icon" id="hud-sound" title="Sound effects" aria-label="Sound effects"></button>
          ${helpBtn(crown ? `Choose the better take: click it, or use <b>←</b> / <b>→</b> (<b>A</b> / <b>D</b>).
            <b>Space</b> saves the challenger for later; <b>Z</b> undoes. Point at a take and press <b>X</b> to set it aside.
            <b>C</b> toggles crop; <b>F</b> toggles enhancement. <b>Enter</b> continues to the group stage.
            Picture controls and keeping the remaining best guesses are in the menu.` : `Two photos, one gut call: click the better one, or <b>←</b> / <b>→</b>. <b>↑</b> both great, <b>↓</b> both meh,
            <b>Space</b> skips, <b>X</b> tosses the photo you point at, <b>Z</b> undoes. Set-aside photos stay recoverable in Filter.
            <b>WASD</b> also works. <b>C</b> crops to the face, <b>F</b> toggles photo enhancement. Calls under 4 s build your streak; ⚡ starts a 60-second lightning round.`)}
        </div>
      </div>
      <div id="lr-slot"></div>
      <div id="done-slot" aria-live="polite"></div>
      <div id="stage" class="arena"><div class="empty">Loading…</div></div>
      <div class="group-table" id="group-table" hidden></div>
      <div class="controls action-bar" id="controls">
        <div class="bar-left"><button class="btn big" data-o="a"><kbd>←</kbd> <span class="lbl-wide">Left wins</span><span class="lbl-narrow">Top wins</span></button></div>
        <div class="bar-mid">
          <div class="dpad"><button class="btn" data-o="great"><kbd>↑</kbd> Both great</button>
            <button class="btn" data-o="skip"><kbd>Space</kbd> Skip</button>
            <button class="btn" data-o="meh"><kbd>↓</kbd> Both meh</button></div>
          <div class="tools"><button class="btn ghost" data-o="undo"><kbd>Z</kbd> Undo</button>
            <button class="btn ghost" data-o="crop" id="crop-btn"><kbd>C</kbd> <span>${CROP_WORD[normCrop(S.crop)]}</span></button>
            <button class="btn ghost filter-btn" data-o="filter"><kbd>F</kbd> <span>${S.filter ? "Enhance on" : "Enhance off"}</span></button></div>
        </div>
        <div class="bar-right"><button class="btn big" data-o="b"><span class="lbl-wide">Right wins</span><span class="lbl-narrow">Bottom wins</span> <kbd>→</kbd></button></div>
      </div>
      <div class="controls action-bar" id="finish-bar" hidden></div>
    </section>`;
  $$("#controls [data-o]").forEach((b) => (b.onclick = () =>
    (b.dataset.o === "undo" ? undo() : b.dataset.o === "crop" ? toggleCrop() : b.dataset.o === "filter" ? toggleFilter()
      : decide(b.dataset.o))));
  $("#hud-sound").onclick = () => { Sound.toggle(); paintSound(); };
  $("#hud-bolt").onclick = () => (S.lr ? endLightning() : startLightning());
  S.crop = cropPref();
  $("#crop-btn span").textContent = CROP_WORD[normCrop(S.crop)];
  S.stage = crown ? "stacks" : ["groups", "knockouts", "open"].includes(params.get("stage")) ? params.get("stage") : null;
  if(crown){
    const forward=()=>{if(!S.busy)location.hash='#tournament?kickoff=1';};
    S.pauseActivity={title:'Crown',label:'Back to Stacks',href:'#stacks',forward,canForward:()=>!S.busy,
      get actions(){return S.stacksLeft>1?[{id:'crown-rest',label:'Keep best guesses for remaining stacks',run:crownBestGuesses}]:[];}};
    // Enter advances even after a choice button has focus; it must never cast another vote.
    document.addEventListener('keydown',e=>{
      if(e.key!=='Enter'||e.ctrlKey||e.metaKey||e.altKey||e.target.isContentEditable||e.target.closest('dialog,input,textarea,select,.photo-note-sheet,.photo-notes-tab')||$('dialog[open]'))return;
      e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)forward();
    },{capture:true,signal:S.events.signal});
  }
  S.groupFocus = params.get("group"); S.koMatch = params.get("match");
  S.table = null;
  S.tableExpanded = false;
  S.lr = null;
  S.autoLightning = params.get("lightning")==="1"&&!crown;
  paintSound();
  S.cards = [];
  S.current = null;
  S.game = null;
  S.stagePhotos = [];
  if (stack) history.replaceState(null, "", "#duel?stage=stacks");
  loadCards(stack);
}

const preloaded = new Map();
function preload(cards) {
  for (const c of cards) {
    const ids = ["duel","final","knockout"].includes(c.type) ? [c.a, c.b] : c.type === "mini" ? c.frames : c.members || [];
    for (const id of ids) {
      const src = P(id);
      if (preloaded.has(src)) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = src;
      preloaded.set(src, img);
      if (preloaded.size > 80) preloaded.delete(preloaded.keys().next().value);
    }
  }
}

async function loadCards(stack) {
  const view = S.view;
  try {
    const r = await api("/api/deal?n=2" + (stack ? `&stack=${encodeURIComponent(stack)}` : "") + (S.stage ? `&stage=${S.stage}` : "")
      + (S.groupFocus ? `&group=${encodeURIComponent(S.groupFocus)}` : "") + (S.koMatch != null ? `&match=${encodeURIComponent(S.koMatch)}` : ""), {});
    if (left(view)) return;
    S.groupFocus = null; S.koMatch = null;
    S.cards = r.cards;
    S.stage = r.stage || (S.stage === "open" ? "open" : null);  // plain Play follows the journey: groups, then knockouts
    S.drawInfo = r.draw;
    paintTrack();
    if (S.stage === "stacks") S.stacksLeft = r.left;
    if(S.stage==="knockouts")S.finalists=r.knockouts?.qualified?.length || r.knockouts?.target || 8;
    preload(S.cards);
    updateMeter(r.progress);
    showNext();
    if(S.autoLightning&&S.current){
      S.autoLightning=false;
      const query=new URLSearchParams(location.hash.split('?')[1]);query.delete('lightning');
      history.replaceState(null,'',`#duel${query.size?'?'+query:''}`);
      startLightning();
    }
  } catch (e) {
    if (!left(view)) { $("#stage").innerHTML = `<div class="empty">${esc(e.message)}<button class="btn primary" id="deal-again">Try again</button><a class="btn" href="#home">The map →</a></div>`; $("#deal-again").onclick=()=>loadCards(stack); }
  }
}

// Cards can arrive before the previous call. Choose their displayed sides only when they reach the arena.
const DuelSides = {
  key(card){return `${card.type}:${Math.min(card.a,card.b)}:${Math.max(card.a,card.b)}`;},
  state(source=S.lib?.source||''){
    if(this.current?.source===source)return this.current;
    let saved;try{saved=JSON.parse(sessionStorage.getItem(`matcher-duel-sides:${source}`)||'null');}catch(_){}
    const valid=x=>x&&Number.isFinite(x.photo)&&['a','b'].includes(x.side);
    const history=Array.isArray(saved?.history)?saved.history.filter(x=>x&&typeof x.key==='string'&&Number.isFinite(x.a)&&Number.isFinite(x.b)&&(!x.winner||valid(x.winner))).slice(-64):[];
    const state={source,history,defender:valid(saved?.defender)?saved.defender:null,base:valid(saved?.base)?saved.base:null,last:history.slice().reverse().find(x=>x.winner)?.winner||(valid(saved?.base)?saved.base:null)};
    if(source===(S.lib?.source||''))this.current=state;
    return state;
  },
  save(state){
    state.last=state.history.slice().reverse().find(x=>x.winner)?.winner||state.base;
    try{sessionStorage.setItem(`matcher-duel-sides:${state.source}`,JSON.stringify({history:state.history,base:state.base,defender:state.defender}));}catch(_){}
  },
  present(card){
    if(!card||!['mini','duel','knockout','final'].includes(card.type))return card;
    const state=this.state(),wire=card.wire||{a:card.a,b:card.b};let {a,b}=card;
    const anchor=state.last&&[a,b].includes(state.last.photo)?state.last:card.type==='mini'&&state.defender?.photo===card.champ?state.defender:null;
    if(state.replay?.key===this.key(card))({a,b}=state.replay);
    else if(anchor&&[a,b].includes(anchor.photo)&&({a,b})[anchor.side]!==anchor.photo)[a,b]=[b,a];
    state.replay=null;
    let commentary=card.commentary;
    if(a!==card.a){
      if(commentary?.startsWith('Rematch:'))commentary=commentary.replace(/\b(left|right)\b/g,x=>x==='left'?'right':'left');
      else if(/^#(?:\d+|–) · #(?:\d+|–)$/.test(commentary))commentary=commentary.split(' · ').reverse().join(' · ');
    }
    return {...card,a,b,wire,commentary};
  },
  outcome(card,outcome){
    const side=outcome.startsWith('toss_')?outcome.slice(5):outcome;
    if(!card.wire||!['a','b'].includes(side))return outcome;
    return `${outcome.startsWith('toss_')?'toss_':''}${card[side]===card.wire.a?'a':'b'}`;
  },
  pick(card,outcome){
    if(!['mini','duel','knockout','final'].includes(card.type))return null;
    if(card.type==='mini'&&outcome==='skip') {
      // The first challenger can be deferred before anyone has won. Remember position, not a victory.
      const state=this.state();state.defender={photo:card.champ,side:card.champ===card.a?'a':'b'};this.save(state);return null;
    }
    const state=this.state(),photo=outcome==='a'?card.a:outcome==='b'?card.b:card.type==='mini'?card.champ:null;
    const entry={key:this.key(card),a:card.a,b:card.b,kind:card.type==='duel'?(['a','b'].includes(outcome)?'duel':outcome.startsWith('toss_')?'toss':outcome):card.type==='mini'?'mini':card.type,
      winner:photo==null?null:{photo,side:photo===card.a?'a':'b'}};
    state.history.push(entry);if(state.history.length>64){const old=state.history.shift();if(old.winner)state.base=old.winner;}
    this.save(state);return {state,entry};
  },
  reject(ticket){
    if(!ticket)return;const {state,entry}=ticket,index=state.history.indexOf(entry);
    if(index>=0){state.history.splice(index,1);this.save(state);}
  },
  undo(reply,source){
    if(!reply?.undone)return;
    const state=this.state(source),kind=reply.undone==='frame'?'mini':reply.undone,card=reply.cards?.[0]||reply.card;
    let index=state.history.length-1;
    while(index>=0&&state.history[index].kind!==kind)index--;
    if(index<0)return;
    const [entry]=state.history.splice(index,1);
    if(card&&entry.key===this.key(card))state.replay=entry;
    this.save(state);
  },
};

function showNext() {
  const gone = World.grab($("#stage"));
  showCard();
  World.swap($("#stage"), gone);
}
function showCard() {
  S.current = DuelSides.present(S.cards.shift() || null);
  const stage = $("#stage");
  if (!stage) return;
  const c = S.current;
  $("#finish-bar").hidden = true;
  World.calm(false); setForward(null);
  if (!c && S.stage === "stacks") { stagesDone(); return; }
  if (!c && S.stage === "groups") { groupStageDone(); return; }
  if (!c && S.progress && S.progress.shots < 2) {
    finishStage({ icon: "🫙", title: "Not enough to duel", undo: false, next: ["#cuts", "Set aside →"],
      text: `This ${MODE() === "gallery" ? "cup" : "folder"} has ${plural(S.progress.shots, "shot")} in the running; duels need two.
        Bring some back from Set aside, or add photos.` });
    return;
  }
  if (!c && S.stage === "knockouts") { knockoutsDone(); return; }
  if (!c) { stage.className = "arena"; stage.innerHTML = `<div class="empty">No pair is ready.<button class="btn primary" id="deal-again">Deal again</button><a class="btn" href="#home">The map →</a></div>`; $("#deal-again").onclick=()=>loadCards(); return; }
  if (c.type === "mini") {
    renderMini(stage, c);
  } else if (c.type === "duel" || c.type === "knockout") {
    stage.className = "arena";
    $("#controls").classList.remove("mini-mode");
    const rowOf = (pid) => S.table && c.group && S.table.id === c.group.id && S.table.rows?.find((r) => r.photo === pid);
    const ra = rowOf(c.a), rb = rowOf(c.b);
    const decider = ra && rb && (ra.through !== rb.through || (Math.abs(ra.odds - 0.5) < 0.25 && Math.abs(rb.odds - 0.5) < 0.25));
    $("#duel-q").innerHTML = c.group
      ? `⚽ <b>Group ${esc(c.group.letter)}</b> <span>${esc(c.group.emoji)} ${esc(c.group.name)} · match ${fmt(Math.min(c.group.played + 1, c.group.budget))}/${fmt(c.group.budget)}</span>${decider ? ` <span class="decider">⚡ Decider: this one can send a photo through</span>` : ""}`
      : S.stage === "knockouts" ? `⚔️ <b>${esc(c.label || "Knockouts")}</b> <span>Win to advance · ${esc(c.commentary || "")}</span>`
      : `${QUESTION[MODE()]} <span>${esc(c.commentary || "Gut call.")}</span>`;
    if (c.group && (!S.table || S.table.id !== c.group.id)) loadTable(c.group.id);
    else if (!c.group && S.stage === "knockouts") loadSeats(c);  // the knockouts: the race for the finals' seats beside the duel
    else if (!c.group) renderTable(null);
    stage.innerHTML = ["a", "b"].map((side) => {
      const n = photoInfo(c, c[side]).frames, team = c.group || c.teams?.[c[side]];
      return `
      <div class="slot slot-${side}"><div class="side ${n > 1 ? "stacked pile" : ""}" data-side="${side}" data-photo="${c[side]}" tabindex="0" title="Point here and press X to toss"${team?.id != null ? ` style="--team-hue:${groupHue(team.id)}"` : ""}>
        <div class="print">${pilePhotos(c[side],photoInfo(c,c[side]).members,n)}<div class="paper"><div class="window"><img class="pile-cover" src="${P(c[side])}" alt="${side === "a" ? "Left" : "Right"} photo" draggable="false"></div></div></div>
        ${c.teams && c.teams[c[side]] ? `<span class="team-chip" title="Plays for ${esc(c.teams[c[side]].name)}">${esc(c.teams[c[side]].emoji)} <b>${esc(c.teams[c[side]].letter)}</b> ${side === "b" && c.teams[c.a]?.letter === c.teams[c.b]?.letter ? "" : esc(c.teams[c[side]].name)}</span>` : ""}
        <button class="toss" ${c.type === "knockout" ? "hidden" : ""} data-toss="${side}" title="Never show this shot again (${side === "a" ? "Q" : "E"})">Toss ✕</button>
      </div></div>`;
    }).join("");
    $$(".side", stage).forEach((el) => (el.onclick = (ev) => {
      const t = ev.target.closest("[data-toss]");
      decide(t ? `toss_${t.dataset.toss}` : el.dataset.side);
    }));
    $("#controls").hidden = false;
    $$("#controls [data-o=great],#controls [data-o=meh]").forEach((b)=>b.hidden=c.type==="knockout");
    setHint(c.type==="knockout"?"Win to advance. Space saves this match for later.":c.group?"Pick the better photo. ↑ both great, ↓ both meh, Space skips.":"Gut call: pick the better photo. Space skips it.");
  }
  layoutStage();
  dressStage(stage);
  S.shownAt = playTime();
}

// New pairs pop in; hovering a pane bubbles it up (with a soft "vwhoop" if sound is on).
let lastWhoop = 0;
function dressStage(stage) {
  stage.classList.remove("enter");
  void stage.offsetWidth;  // restart the entrance animation
  stage.classList.add("enter");
  $$(".slot", stage).forEach((slot) => slot.addEventListener("mouseenter", () => {
    const now = performance.now();
    if (now - lastWhoop > 140) { Sound.play("whoop"); lastWhoop = now; }
  }));
}

// ---------------------------------------------------------------- auto-crop
// Every pane shows the same 4:5 window. Each photo is zoomed and positioned so your face sits in that
// window the same way (the server's head-and-shoulders box fills it), the photo always covers the
// window of its polaroid card; the card clips whatever spills past the window.
const MAX_ZOOM = 1.5;      // never enlarge the preview beyond this (CSS px per preview px)

function photoInfo(card, id) {
  return (card && card.photos && card.photos[id]) || { dims: [1, 1], box: null, frames: 1 };
}

// A subject box ([x, y, w, h] as fractions) after turning the picture `deg` clockwise (matcher/touchup.py agrees).
function rotateBox(b, deg) {
  const [x, y, w, h] = b, d = ((deg % 360) + 360) % 360;
  return d === 90 ? [1 - (y + h), x, h, w] : d === 180 ? [1 - (x + w), 1 - (y + h), w, h] : d === 270 ? [y, 1 - (x + w), h, w] : [x, y, w, h];
}
// `opts` are one photo's own choices (the Leaderboard's): crop, a clockwise quarter turn, enhancement; the global
// toggles otherwise.
function framePhoto(side, info, opts = {}) {
  // The pane holds one polaroid (`.print > .paper > .window`); the photo is sized inside the window.
  const win = side.querySelector(".window"), img = win?.querySelector("img");
  // Sea windows can be only a few world pixels across. Integer client sizes would magnify that rounding into
  // visible gaps at deep zoom, even though their paper and the camera both use fractional sizes.
  const style=win&&getComputedStyle(win),W=parseFloat(style?.width),H=parseFloat(style?.height);
  if (!img || !W || !H) return;
  const rotate = (((opts.rotate || 0) % 360) + 360) % 360, enhance = opts.enhance ?? S.filter, mode = normCrop(opts.crop ?? S.crop);
  const straighten=Number(opts.straighten??side.dataset.straighten)||0;
  let finishing=opts.finishing;
  if(!finishing){try{finishing=JSON.parse(side.dataset.finishing||'null');}catch(_){/* no local adjustments */}}
  let manual=null;try{manual=mode==='custom'?(opts.cropBox??JSON.parse(side.dataset.cropBox||'null')):null;}catch(_){/* no saved rectangle */}
  let [iw, ih] = info.dims, b = manual||(mode !== "off" ? info.box : null);  // "best" without a subject frames the middle
  if (rotate % 180) [iw, ih] = [ih, iw];
  if (b && rotate) b = rotateBox(b, rotate);
  const base = "position:absolute;left:0;top:0;max-width:none;object-fit:fill;";
  // The element keeps the picture's own width and height and turns about its centre, so the turned box lands
  // where the framing put it.
  const place = (x, y, w, h) => {
    const [ew, eh] = rotate % 180 ? [h, w] : [w, h];
    if(side.matches('.ps-item')){
      // A sea body's size can ease between anchors. Relative geometry follows it without another layout,
      // crop calculation or filter rebuild on each physics frame.
      img.style.cssText=base+`left:${(x+w/2-ew/2)/W*100}%;top:${(y+h/2-eh/2)/H*100}%;width:${ew/W*100}%;height:${eh/H*100}%;${rotate?`transform:rotate(${rotate}deg)`:'transform:none'}`;
    }else img.style.cssText = base + `width:${ew}px;height:${eh}px;transform:translate(${x + w / 2 - ew / 2}px,${y + h / 2 - eh / 2}px)${rotate ? ` rotate(${rotate}deg)` : ""}`;
    if(manual){const [cx,cy,cw,ch]=manual;img.style.clipPath=`inset(${cy*100}% ${(1-cx-cw)*100}% ${(1-cy-ch)*100}% ${cx*100}%)`;}
    paintFilter(img, Number(side.dataset.photo), enhance, opts.knobs || null,finishing);
    photoSampling(img,opts.pixelScale??((Number(side.dataset.viewerZoom)||1)/basis));
  };
  // A deeply zoomed sea window uses larger local coordinates without changing its crop or subject zoom limit.
  const basis=Number(side.dataset.imageScale)||1;
  const { x, y, w, h } = frameRect(W/basis, H/basis, iw, ih, b, mode);
  let picture=img.parentElement.matches('.picture')?img.parentElement:null;
  if(straighten){
    if(!picture){picture=document.createElement('div');picture.className='picture';img.before(picture);picture.append(img);}
    const scale=w/iw,roi=manual?b:[Math.max(0,-x/scale)/iw,Math.max(0,-y/scale)/ih,Math.min(iw,w>W/basis?W/basis/scale:iw)/iw,Math.min(ih,h>H/basis?H/basis/scale:ih)/ih],
      rw=roi[2]*iw,rh=roi[3]*ih,a=straighten*Math.PI/180,c=Math.cos(a),s=Math.sin(a),
      trim=Math.min(rw/(rw*Math.abs(c)+rh*Math.abs(s)),rh/(rw*Math.abs(s)+rh*Math.abs(c))),
      ow=rw*trim,oh=rh*trim,k=Math.min(W/ow,H/oh),pw=ow*k,ph=oh*k,
      dx=(roi[0]+roi[2]/2-.5)*iw,dy=(roi[1]+roi[3]/2-.5)*ih,
      cx=pw/2-(dx*c-dy*s)*k,cy=ph/2-(dx*s+dy*c)*k,
      ew=info.dims[0]*k,eh=info.dims[1]*k;
    picture.style.cssText=`position:absolute;overflow:hidden;left:${(W-pw)/2/W*100}%;top:0;width:${pw/W*100}%;height:${ph/H*100}%`;
    img.style.cssText=base+`left:${(cx-ew/2)/pw*100}%;top:${(cy-eh/2)/ph*100}%;width:${ew/pw*100}%;height:${eh/ph*100}%;transform:rotate(${rotate+straighten}deg)`;
    paintFilter(img,Number(side.dataset.photo),enhance,opts.knobs||null,finishing);photoSampling(img,opts.pixelScale??((Number(side.dataset.viewerZoom)||1)/basis));return;
  }
  if(picture)picture.style.cssText='position:absolute;inset:0;width:100%;height:100%;overflow:hidden';
  place(x*basis, y*basis, w*basis, h*basis);
}
// Beyond native resolution, show the original's actual pixels instead of blending neighbouring pixels.
// Previews and reduced originals keep smooth sampling, including on high-density screens.
function photoSampling(img,scale=1) {
  if(!img)return;
  const original=img.getAttribute('src')?.includes('m=full')&&img.naturalWidth,
    width=original?parseFloat(getComputedStyle(img).width)*scale*(devicePixelRatio||1):0;
  img.classList.toggle('photo-pixels',!!original&&width>=img.naturalWidth-.5);
}
// Where a picture of iw×ih goes in a W×H window (CSS px): "off" contains it at the top; "best" fills the window
// exactly (the least paper showing), the subject or the centre deciding which part; "subject" zooms in past that
// until the subject fills the window's height (never past MAX_ZOOM), centred on it unless that would leave a gap;
// "height" and "width" fill one way and let the subject decide the other (the top and centre without one).
// matcher/touchup.py `crop_box` is the same rule for the export.
function frameRect(W, H, iw, ih, b, mode) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if(mode==='custom'&&b){
    const s=Math.min(W/(iw*b[2]),H/(ih*b[3]));
    return {x:(W-iw*b[2]*s)/2-iw*b[0]*s,y:-ih*b[1]*s,w:iw*s,h:ih*s};
  }
  if (mode === "best") {
    // The crop that uses the most of the window among focus subject (when there is one), fill height and fill
    // width; on a tie focus subject wins, then whichever fill covers more (the owner's rule).
    const used = { height: Math.min(1, iw * (H / ih) / W), width: Math.min(1, ih * (W / iw) / H) };
    if (b && b[3] > 0) used.subject = 1;
    const order = ["subject", "height", "width"].filter((m) => m in used);
    return frameRect(W, H, iw, ih, b, order.reduce((a, m) => (used[m] > used[a] ? m : a), order[0]));
  }
  if (mode === "height" || mode === "width") {
    const s = mode === "height" ? H / ih : W / iw, dw = iw * s, dh = ih * s;
    const x = dw <= W ? (W - dw) / 2 : clamp(b ? W / 2 - (b[0] + b[2] / 2) * dw : (W - dw) / 2, W - dw, 0);
    const y = dh <= H ? 0 : clamp(b ? H / 2 - (b[1] + b[3] / 2) * dh : 0, H - dh, 0);
    return { x, y, w: dw, h: dh };
  }
  if (mode === "off" || (mode === "subject" && !b)) {  // whole photo, contained in the window and nested at its top: the dead space below joins the chin
    const s = Math.min(W / iw, H / ih);
    return { x: (W - iw * s) / 2, y: 0, w: iw * s, h: ih * s };
  }
  const cover = Math.max(W / iw, H / ih);                       // the photo always fills the window
  const s = mode === "subject" ? Math.min(Math.max(H / (b[3] * ih), cover), Math.max(cover, MAX_ZOOM)) : cover;
  const dw = iw * s, dh = ih * s, cx = b ? b[0] + b[2] / 2 : 0.5, cy = b ? b[1] + b[3] / 2 : 0.5;
  return { x: clamp(W / 2 - cx * dw, W - dw, 0),  // the subject (or the middle) centred in the window,
    y: clamp(H / 2 - cy * dh, H - dh, 0), w: dw, h: dh };  // unless that would leave a gap
}

// ---------------------------------------------------------------- auto-filter
// A gentle auto-edit laid over the photo as an SVG filter: levels, a little white balance, midtones toward a
// natural brightness, a touch of vibrance. Worked out on the fly from a 64-px sample of the photo itself, so
// nothing is written to your files; F flips it on every judging screen.
const FILTERS = new Map();  // photo id -> filter id, for the current library and analysis
let filterCanvas = null, filterSource = null, filterSerial = 0;

function filterPref() {
  try { return localStorage.getItem(`matcher-filter-${MODE()}`) === "on"; } catch (_) { return false; }
}

// The Leaderboard's knobs on the auto look, name: [low, high, default]; matcher/touchup.py KNOBS agrees.
const KNOBS = { levels: [0, 2, 1], light: [-1, 1, 0], contrast: [-1, 1, 0], colour: [0, 2, 1], warmth: [-1, 1, 0] };
const KNOB_WORD = { levels: "Levels", light: "Light", contrast: "Contrast", colour: "Colour", warmth: "Warmth" };
function knobsOf(look) {
  const out = {};
  for (const [k, [lo, hi, d]] of Object.entries(KNOBS)) { const v = Number(look?.[k]); out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
  return out;
}
const LOOKS = new Map();  // photo id -> its measured auto look (levels, gamma, saturation)
// The look of one photo from a 64-px proof of it: black and white points at 0.5% / 99.5% (per channel only 40% of
// the way, three quarters of a full auto-levels), a gamma that brings the mean towards mid-grey, saturation
// unless it is black and white. matcher/touchup.py measures the same.
function measureLook(img) {
  const w = 64, h = Math.max(1, Math.round((64 * img.naturalHeight) / img.naturalWidth));
  filterCanvas = filterCanvas || document.createElement("canvas");
  filterCanvas.width = w;
  filterCanvas.height = h;
  const ctx = filterCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, n = d.length / 4;
  const hist = [0, 1, 2, 3].map(() => new Uint32Array(256)), sum = [0, 0, 0];
  let chroma = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    hist[0][r]++; hist[1][g]++; hist[2][b]++; hist[3][(0.299 * r + 0.587 * g + 0.114 * b) | 0]++;
    sum[0] += r; sum[1] += g; sum[2] += b;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const pctl = (hh, q) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hh[v]; if (acc >= q * n) return v; } return 255; };
  const stretch = (hh) => {  // black and white points at 0.5% / 99.5%
    const lo = pctl(hh, 0.005), hi = pctl(hh, 0.995), a = Math.min(2.2, 255 / Math.max(48, hi - lo));
    return [a, (-lo / 255) * a];
  };
  const [aL, bL] = stretch(hist[3]);
  const lin = [0, 1, 2].map((k) => {
    const [a, b] = stretch(hist[k]);
    const a2 = aL + (a - aL) * 0.4, b2 = bL + (b - bL) * 0.4;  // per-channel only 40% of the way: sunsets stay warm
    return [1 + (a2 - 1) * 0.75, b2 * 0.75];                   // three quarters of a full auto-levels
  });
  const W3 = [0.299, 0.587, 0.114];
  const mean = W3.reduce((m, wk, k) => m + wk * Math.min(1, Math.max(0, lin[k][0] * (sum[k] / n / 255) + lin[k][1])), 0);
  const g0 = Math.log(0.46) / Math.log(Math.min(0.95, Math.max(0.05, mean)));
  const gamma = 1 + (Math.min(1.35, Math.max(0.65, g0)) - 1) * 0.6;
  const sat = chroma / n < 10 ? 1 : 1.12;  // nothing to boost in black & white
  return { lin, gamma, sat };
}
// The auto look turned by the knobs: levels scaled, mid-tones lifted or lowered, a contrast slope about mid-grey,
// colour scaled, a warm or cool cast (matcher/touchup.py `tuned` is the same chain).
function tunedLook(look, knobs) {
  const k = knobsOf(knobs), slope = 1 + 0.6 * k.contrast;
  return { lin: look.lin.map(([a, b]) => [1 + (a - 1) * k.levels, b * k.levels]), gamma: Math.min(2.2, Math.max(0.4, look.gamma * (1 - 0.45 * k.light))),
    contrast: [slope, (1 - slope) / 2], sat: Math.max(0, look.sat * k.colour), warmth: k.warmth };
}
function filterMarkup(t) {
  const fn = (attrs) => ["R", "G", "B"].map((c, k) => `<feFunc${c} ${attrs(k)}/>`).join("");
  const r = 1 + 0.12 * t.warmth, b = 1 - 0.12 * t.warmth;
  return `<feComponentTransfer>${fn((k) => `type="linear" slope="${t.lin[k][0].toFixed(4)}" intercept="${t.lin[k][1].toFixed(4)}"`)}</feComponentTransfer>
    <feComponentTransfer>${fn(() => `type="gamma" amplitude="1" exponent="${t.gamma.toFixed(4)}" offset="0"`)}</feComponentTransfer>
    ${t.contrast[0] !== 1 ? `<feComponentTransfer>${fn(() => `type="linear" slope="${t.contrast[0].toFixed(4)}" intercept="${t.contrast[1].toFixed(4)}"`)}</feComponentTransfer>` : ""}
    <feColorMatrix type="saturate" values="${t.sat.toFixed(4)}"/>
    ${t.warmth ? `<feColorMatrix type="matrix" values="${r.toFixed(4)} 0 0 0 0  0 1 0 0 0  0 0 ${b.toFixed(4)} 0 0  0 0 0 1 0"/>` : ""}`;
}
// Bare thumbnails also paint their own paper. Keep it outside the enhancement's mask; focused photos already
// have a separate clipped window, so their filter covers only the image.
function paperFilterMask(img) {
  if(img.closest('.window,.picture,.rank-pop,.save-chip')||!img.naturalWidth)return null;
  const window=[.055,.04125,.89,.83125];
  if(img.style.objectViewBox||['fill','cover'].includes(img.style.objectFit))return window;
  const aspect=img.naturalWidth/img.naturalHeight,W=.89,H=.83125*4/3;
  const w=Math.min(W,H*aspect),h=w/aspect;
  return [.055+(W-w)/2,.04125,w,h*3/4];
}
// One SVG filter per photo and paper mask (with knobs, rebuilt in place as the knobs move).
function autoFilterId(img, pid, knobs = null, finishing = null, on = true) {
  const source = imageKey();
  if (filterSource !== source) {
    FILTERS.clear(); LOOKS.clear(); $("#af-defs")?.replaceChildren(); filterSource = source;
    $$("img[style*='filter']").forEach((shown) => { shown.style.filter = ""; });
  }
  if (!img.complete || !img.naturalWidth) return null;
  const mask=paperFilterMask(img),maskKey=mask?mask.map(v=>Math.round(v*10000)).join('-'):'';
  const key = `${pid}${knobs?'|knobs':''}${finishing?'|finish':''}${on?'':'|manual'}${mask?'|paper'+maskKey:''}`;
  const signature=JSON.stringify([knobs,finishing,on]);
  if (FILTERS.has(key) && $(`#${FILTERS.get(key)}`)?.dataset.signature===signature) return FILTERS.get(key);
  if (FILTERS.size >= 1200) {
    const used = new Set($$("img[style*='filter']").map((shown) => /#(af-[\w-]+)/.exec(shown.style.filter)?.[1]));
    for (const [photo, id] of FILTERS) if (!used.has(id)) { $(`#${id}`)?.remove(); FILTERS.delete(photo); }
    if (FILTERS.size >= 1200) return null;
  }
  let look = LOOKS.get(pid);
  if (!look) { look = measureLook(img); LOOKS.set(pid, look); }
  let defs = $("#af-defs");
  if (!defs) {
    document.body.insertAdjacentHTML("beforeend", `<svg id="af-defs" width="0" height="0" style="position:absolute" aria-hidden="true"></svg>`);
    defs = $("#af-defs");
  }
  const id = FILTERS.get(key) || (knobs ? `af-k${pid}-${++filterSerial}` : `af-${++filterSerial}`);
  let filter = $(`#${id}`, defs);
  if (!filter) { defs.insertAdjacentHTML("beforeend", `<filter id="${id}" color-interpolation-filters="sRGB"></filter>`); filter = $(`#${id}`, defs); }
  const markup=(on?filterMarkup(tunedLook(look, knobs)):'')+(typeof PhotoFinish!=='undefined'&&finishing?PhotoFinish.markup(finishing,[img.naturalWidth,img.naturalHeight],mask):'');
  filter.dataset.signature=signature;
  filter.setAttribute('primitiveUnits','objectBoundingBox');filter.setAttribute('x','0');filter.setAttribute('y','0');filter.setAttribute('width','1');filter.setAttribute('height','1');
  if(mask){
    filter.innerHTML=markup+`<feComposite in2="SourceAlpha" operator="in" result="adjusted"/><feFlood flood-color="white" x="${mask[0]}" y="${mask[1]}" width="${mask[2]}" height="${mask[3]}" result="photo-mask"/>
      <feComposite in="adjusted" in2="photo-mask" operator="in" result="photo"/><feComposite in="SourceGraphic" in2="photo-mask" operator="out" result="paper"/>
      <feMerge><feMergeNode in="paper"/><feMergeNode in="photo"/></feMerge>`;
  }else filter.innerHTML=markup;
  FILTERS.set(key, id);
  return id;
}

function paintFilter(img, pid, on = S.filter, knobs = null, finishing = null) {
  if (!img || !pid) return;
  if (!on&&!finishing?.grade&&!finishing?.masks?.length) { img.style.filter = ""; return; }
  const id = autoFilterId(img, pid, knobs,finishing,on);
  if (id) img.style.filter = `url(#${id})`;
  else if (!img.complete) img.addEventListener("load", () => paintFilter(img, pid, on, knobs,finishing), { once: true });
}

function paintFilters() {
  $$(".side[data-photo], .swipe-card[data-photo]").forEach((el) => paintFilter(el.querySelector("img"), Number(el.dataset.photo)));
  paintThumbFilters();
  paintCrops();
}
// F shows on every screen: thumbnails (boards, the sea, bins, the leaderboard) get the filter too, up to a cap so a
// board of thousands stays smooth. New thumbnails pick it up as they're drawn.
const THUMB_FILTER_MAX = 800;
function paintThumbFilters() {
  const main = $("#main");
  if (!main) return;
  // The Leaderboard's card follows its own photo's choice, not the global toggle.
  if (!S.filter) { $$("img[style*='filter']", main).forEach((img) => { if (!img.closest("[data-frame]")) img.style.filter = ""; }); return; }
  let n = 0;
  for (const img of $$("img[src^='/img/t/'], img[src^='/img/p/']", main)) {
    if (img.closest("[data-frame]")) continue;
    if (++n > THUMB_FILTER_MAX) break;
    if (img.style.filter) continue;
    const m = /\/img\/[tp]\/(\d+)\.jpg/.exec(img.getAttribute("src"));
    if (m) paintFilter(img, Number(m[1]));
  }
}
let thumbQueued = false;
new MutationObserver(() => {
  if (!S.filter || thumbQueued) return;
  thumbQueued = true;
  requestAnimationFrame(() => { thumbQueued = false; paintThumbFilters(); });
}).observe($("#main"), { childList: true, subtree: true });
// Auto-crop beyond the duel: a big photo card with a known subject fills its frame, centred on the subject.
// A bare card picture (a stack tile, a take in a fan) framed by the crop mode: the picture's window-mapped
// region through object-view-box where the browser has it (Chromium), else cover with the subject's position.
// "off" leaves the tile's own look (the picture covering its window).
const VIEW_BOX = typeof CSS !== "undefined" && !!CSS.supports?.("object-view-box", "xywh(0px 0px 1px 1px)");
function frameTileImage(img) {
  if (img.closest("[data-frame], .swipe-card, #f-arena, .world-fly, .ps-item")) return;
  const apply = () => {
    const iw = img.naturalWidth, ih = img.naturalHeight, mode = normCrop(S.crop);
    if (!iw || !ih || !img.isConnected) return;
    const refresh=()=>{const id=Number(/\/img\/[pt]\/(\d+)\.jpg/.exec(img.getAttribute('src')||'')?.[1]);if(id)paintFilter(img,id);};
    if (mode === "off") { img.style.objectFit = ""; img.style.objectPosition = ""; img.style.objectViewBox = ""; refresh();return; }
    let box = null; try { box = JSON.parse(img.dataset.box || "null"); } catch (_) { /* no subject */ }
    const W = img.clientWidth || 3, H = img.clientHeight || 4, { x, y, w, h } = frameRect(W, H, iw, ih, box, mode);
    if (VIEW_BOX) { img.style.objectFit = "fill"; img.style.objectPosition = ""; img.style.objectViewBox = `xywh(${(-x / w * iw).toFixed(1)}px ${(-y / h * ih).toFixed(1)}px ${(W / w * iw).toFixed(1)}px ${(H / h * ih).toFixed(1)}px)`; }
    else { const cover = w >= W - .5 && h >= H - .5; img.style.objectFit = cover ? "cover" : "contain"; img.style.objectPosition = cover && box ? `${((box[0] + box[2] / 2) * 100).toFixed(1)}% ${((box[1] + box[3] / 2) * 100).toFixed(1)}%` : "center top"; }
    refresh();
  };
  if (img.complete && img.naturalWidth) apply(); else img.addEventListener("load", apply, { once: true });
}
// Every such picture frames itself as it loads, wherever it was inserted; C frames them all again.
document.addEventListener("load", (e) => { if (e.target instanceof HTMLImageElement && e.target.dataset.box !== undefined) frameTileImage(e.target); }, true);
function paintCrops() {
  $$("img[data-box]").forEach(frameTileImage);
  // Twin check compares the complete takes: cropping can hide the difference that decides whether they match.
  $$(".swipe-card[data-photo]").forEach((el) => {
    const img = el.querySelector("img");
    if (!img) return;
    let box = null;
    try { box = JSON.parse(el.dataset.box || "null"); } catch (_) { /* no subject */ }
    if (normCrop(S.crop) !== "off" && box) {
      img.style.objectFit = "cover";
      img.style.objectPosition = facePos(box).replace("object-position:", "");
    } else {
      img.style.objectFit = "";
      img.style.objectPosition = "";
    }
  });
  // Finals panes frame their picture inside the card's window exactly like a duel: contained whole, or zoomed to
  // the subject when auto-crop is on.
  $$("#f-arena .side[data-photo]").forEach((side) => {
    const img = side.querySelector(".window > img");
    if (!img) return;
    let box = null;
    try { box = JSON.parse(side.dataset.box || "null"); } catch (_) { /* no subject */ }
    const frame = () => framePhoto(side, { dims: [img.naturalWidth || 1, img.naturalHeight || 1], box });
    if (img.naturalWidth) frame(); else img.addEventListener("load", frame, { once: true });
  });
  $$("[data-frame=own]").forEach(frameBoardCard);
}

function toggleFilter() {
  S.filter = !S.filter;
  try { localStorage.setItem(`matcher-filter-${MODE()}`, S.filter ? "on" : "off"); } catch (_) { /* private mode */ }
  $$(".filter-btn span").forEach((l) => (l.textContent = S.filter ? "Enhance on" : "Enhance off"));
  paintFilters();
  window.dispatchEvent(new Event('photo-render-change'));
  toast(S.filter ? "Enhance on" : "Enhance off", 1000);
}

function layoutStage() {
  $$("#stage .side[data-photo]").forEach((side) => framePhoto(side, photoInfo(S.current, Number(side.dataset.photo))));
  $$("[data-frame=own]").forEach(frameBoardCard);
}

// C cycles the ways to frame a photo: best (the least paper showing in the window), focus subject (zoomed in on
// its subject), fill height, fill width, off.
const CROP_MODES = ["best", "subject", "height", "width", "off"];
const CROP_WORD = { best: "Crop: best", subject: "Crop: focus subject", height: "Crop: fill height", width: "Crop: fill width", off: "Crop off", custom:"Crop: custom" };
const CROP_MENU = { best: "best", subject: "focus subject", height: "fill height", width: "fill width", off: "off" };
const normCrop = (v) => v === true || v === "auto" ? "subject" : v==='custom'?'custom':CROP_MODES.includes(v) ? v : "off";
window.addEventListener("photo-render-change", () => S.refitGrab?.());  // the analysis show reframes the photo in hand
function toggleCrop() {
  S.crop = CROP_MODES[(CROP_MODES.indexOf(normCrop(S.crop)) + 1) % CROP_MODES.length];
  try { localStorage.setItem(`matcher-crop-${MODE()}`, S.crop); } catch (_) { /* private mode */ }
  const label = $("#crop-btn span");
  if (label) label.textContent = CROP_WORD[S.crop];
  layoutStage();
  paintCrops();
  window.dispatchEvent(new Event("photo-render-change"));
  toast(S.crop === "off" ? "Whole photo" : `Auto-crop: ${CROP_MENU[S.crop]}`, 1000);
}

let resizeQueued = false;
window.addEventListener("resize", () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; layoutStage(); });
});

function animate(outcome) {
  const sides = $$("#stage .side");
  if (!["duel", "mini", "knockout"].includes(S.current?.type) || sides.length < 2) return;
  const [a, b] = sides;
  if (outcome === "a") { a.classList.add("won"); b.classList.add("lost"); }
  else if (outcome === "b") { b.classList.add("won"); a.classList.add("lost"); }
  else if (outcome === "great") { a.classList.add("flash-good"); b.classList.add("flash-good"); }
  else if (outcome === "meh") { a.classList.add("flash-meh"); b.classList.add("flash-meh"); }
  else if (outcome === "toss_a") a.classList.add("lost");
  else if (outcome === "toss_b") b.classList.add("lost");
}

async function decide(outcome, choice) {
  if (!S.current) return;
  if (S.busy) {  // the next pair is already up; remember the call and make it as soon as the last one lands
    S.queued = (S.queued || []).slice(-2).concat([{ card: S.current.id, outcome, choice }]);
    return;
  }
  S.busy = true;
  if(S.stage==='stacks')paintTrack();
  const view = S.view;
  const card = S.current;
  if (card.type === "knockout" && !["a","b","skip"].includes(outcome)) { S.busy=false; return; }
  if (card.type === "knockout" && outcome === "skip") {
    try {const r=await api("/api/vote",{card:card.id,outcome:"skip",stage:S.stage});if(left(view))return;
      Sound.play("skip");S.cards=r.cards||[];updateMeter(r.progress);
      if(S.cards[0]?.match===card.match){location.hash="tournament";return;}
      showNext();
    }catch(error){if(!left(view))toast(error.message);}finally{if(!left(view))settle();}return;
  }
  const ms = Math.round(playTime() - S.shownAt);
  animate(outcome);
  if (card.type === "duel" || card.type === "knockout") Sound.play({ a: "pick", b: "pick", great: "great", meh: "meh", skip: "skip" }[outcome] || "toss");
  const lr = S.lr && performance.now() < S.lr.ends ? S.lr.id : null;
  if (lr && ["a", "b", "great", "meh", "skip"].includes(outcome)) lightningTick();
  const sides=DuelSides.pick(card,outcome);
  const req = api("/api/vote", { card: card.id, outcome:DuelSides.outcome(card,outcome), ms, choice: choice ?? null, pending: S.cards.map((c) => c.id),
    lr, stage: S.stage }).catch(e=>{DuelSides.reject(sides);throw e;});
  req.catch(() => {});  // the entrance animation may outlast an immediate network failure
  if (card.type === "mini") {
    // Wait for the reply: the next round, or (after the last one) the duel this stack was holding up.
    try {
      const r = await req;
      if (left(view)) return;
      if (r.swap) applySwap(r.swap);
      S.cards.unshift(...r.cards);
      preload(r.cards);
      if (card.type === "mini") {
        Sound.play(r.skipped ? "skip" : r.mini && r.mini.defended ? "defend" : "pick");
        if(r.skipped&&r.cards?.[0]&&[r.cards[0].a,r.cards[0].b].every(id=>[card.a,card.b].includes(id))){location.hash="stacks";return;}
        if (r.crowned) {
          S.stagePhotos = [...new Set([...(S.stagePhotos||[]),r.crowned.photo])].slice(-6);
          await crowning(r.crowned.photo, r.crowned.overruled);
          if (left(view)) return;
        }
      }
      updateMeter(r.progress, outcome);
      showNext();
    } catch (e) {
      if (left(view)) return;
      toast(e.status === 409 ? "Refreshing pairs…" : e.message);
      await loadCards();
    } finally {
      if (!left(view)) settle();
    }
    return;
  }
  await sleep(130);
  if (left(view)) { await req.catch(()=>{}); return; }
  if (S.cards.length) showNext();
  else { S.current = null; $("#stage").innerHTML = `<div class="empty">Thinking…</div>`; }
  try {
    const r = await req;
    if (left(view)) return;
    if (r.swap) applySwap(r.swap);
    S.cards.push(...r.cards);
    preload(r.cards);
    updateMeter(r.progress, outcome);
    if (r.ranks) rankPop(r.ranks, outcome, card, r.story, r.group);
    if (r.group) { renderTable(r.group); if (r.group.just_settled) groupDecided(r.group); }
    if(r.knockouts?.qualified?.length){S.stagePhotos=r.knockouts.qualified.slice(0,6);S.finalists=r.knockouts.qualified.length;}
    if (!S.current) showNext();

  } catch (e) {
    if (left(view)) return;
    toast(e.status === 409 ? "Refreshing pairs…" : e.message);
    await loadCards();
  } finally {
    if (!left(view)) settle();
  }
}

// A frame pick replaces the shot's photo everywhere it's already queued or on screen.
function applySwap({ from, to, photo }) {
  const fix = (c) => {
    if (c && c.type === "duel" && (c.a === from || c.b === from)) {
      if (c.a === from) c.a = to;
      if (c.b === from) c.b = to;
      c.photos = { ...(c.photos || {}), [to]: photo };
    }
  };
  S.cards.forEach(fix);
  preload([{ type: "duel", a: to, b: to }]);
}

const UNDONE = {
  duel: "Undone. That pair is back.", great: "Undone. That pair is back.", meh: "Undone. That pair is back.",
  skip: "Undone. That pair is back.", toss: "Toss undone. The photo's back, and so is the pair.",
  mini: "Round undone. Call it again.", knockout:"Elimination match undone. Call it again.",
  sweep: "Sweep call undone.", final: "Finals pick undone. It's on the finals page.",
  qualification: "Qualification undone. Group comparisons are open again.",
};

function cropPref() {
  try {
    const v = localStorage.getItem(`matcher-crop-${MODE()}`) || (MODE() === "me" ? localStorage.getItem("matcher-crop") : null);
    if (v) return v === "on" ? "best" : normCrop(v);
  } catch (_) { /* private mode */ }
  return MODE() === "me" ? "best" : "off";  // profile pics frame around you; a gallery shows whole photos
}

// Where your pick landed on the leaderboard, for a moment.
function rankPop(ranks, outcome, card, story, group) {
  const pid = outcome === "a" ? card.a : outcome === "b" ? card.b : null;
  const r = ranks.find((x) => x.photo === pid);
  if (!r) return;
  const d = r.was - r.rank;
  $$(".rank-pop").forEach((x) => x.remove());
  const el = document.createElement("div");
  el.className = `rank-pop ${reduceMotion ? "still" : ""}`;
  el.setAttribute("role", "status");
  const place = group?.rows.findIndex((x)=>x.photo===pid), labels = {upset:"Upset!",rematch:"Rematch",revenge:"Revenge!","giant-killer":"Giant-killer!","into-finals":"Into the finals!"};
  el.innerHTML = `${story ? `<em class="story ${story}">${labels[story]||esc(story)}</em>` : ""}<img src="${T(pid)}" alt="">
    <span>#${r.rank}</span>${d > 0 ? `<b class="up">▲${d}</b>` : d < 0 ? `<b class="down">▼${-d}</b>` : `<b class="flat">=</b>`}`;
  if (place>=0) el.insertAdjacentHTML("beforeend",`<small>${place+1}${place===0?"st":place===1?"nd":place===2?"rd":"th"} in Group ${esc(group.letter)} ${group.rows[place].through?"✓":""}</small>`);
  const host=innerWidth<=760?$("#duel-feedback"):$("#duel-learnt");
  if (!host) return;
  host.replaceChildren(el);
  setTimeout(() => el.classList.add("out"), 1100);
  setTimeout(() => {if(host.contains(el))host.textContent=host.dataset.learning||"";}, 1500);
}

// ---- lightning round: 60 seconds, as many calls as you can
const LR_SECONDS = 60;
function startLightning() {
  if (!$("#lr-slot") || !S.current || S.lr) return;
  if (S.stage === "stacks") { toast("Lightning rounds are for duels: crown the stacks first."); return; }
  S.lr = { id: Math.random().toString(36).slice(2, 10), ends: performance.now() + LR_SECONDS * 1000, calls: 0,
           xp0: (S.game && S.game.xp) || 0, best0: (S.game && S.game.lightning_best) || 0 };
  $("#lr-slot").innerHTML = `<div class="lr-bar"><i></i><span class="lr-text">⚡ GO! <b id="lr-calls">0</b> calls</span><span id="lr-secs">${LR_SECONDS}s</span></div>`;
  $("#hud-bolt").classList.add("on");
  Sound.play("level");
  banner(`<small>Lightning round</small><b>⚡ 60 seconds. Go!</b>`, 900);
  const tick = () => {
    if (!S.lr || S.lr.pausedAt!=null || !$("#lr-slot")) return;
    const left = Math.max(0, S.lr.ends - performance.now());
    const bar = $(".lr-bar i");
    if (bar) bar.style.width = `${(left / (LR_SECONDS * 1000)) * 100}%`;
    const secs = $("#lr-secs");
    if (secs) secs.textContent = `${Math.ceil(left / 1000)}s`;
    $(".lr-bar")?.classList.toggle("hurry", left < 10000);
    if (left <= 0) { endLightning(); return; }
    S.lr.raf = requestAnimationFrame(tick);
  };
  S.lr.tick=tick;
  if(S.pause?.view===S.view)S.lr.pausedAt=performance.now();else tick();
}

function lightningTick() {
  S.lr.calls += 1;
  const c = $("#lr-calls");
  if (c) { c.textContent = S.lr.calls; c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); }
}

async function endLightning() {
  const lr = S.lr, view = S.view;
  if (!lr) return;
  const elapsed=Math.max(1,Math.min(LR_SECONDS,Math.round(((lr.pausedAt??performance.now())-(lr.ends-LR_SECONDS*1000))/1000)));
  S.lr = null;
  cancelAnimationFrame(lr.raf);
  $("#hud-bolt")?.classList.remove("on");
  $("#lr-slot") && ($("#lr-slot").innerHTML = "");
  await sleep(450);  // let the last answer land
  let g = S.game;
  if (left(view)) return;
  try { g = (await api("/api/game")).stats; } catch (_) { /* keep what we have */ }
  if (left(view)) return;
  const record = lr.calls > lr.best0 && lr.calls > 0;
  if (record) { Sound.play("achieve"); confetti(window.innerWidth / 2, window.innerHeight / 3, 60); }
  const m = $("#modal");
  m.className = "";
  m.onclick = null;
  m.innerHTML = `<div class="lr-result">
      <div class="lr-big">⚡ ${fmt(lr.calls)}</div>
      <div class="muted">calls in ${elapsed} seconds${elapsed<LR_SECONDS?" · stopped early":""}</div>
      ${record ? `<div class="lr-record">New record!</div>` : lr.best0 ? `<div class="muted small">Your record: ${fmt(lr.best0)}</div>` : ""}
      <div class="lr-xp">+${fmt(Math.max(0, ((g && g.xp) || 0) - lr.xp0))} XP</div>
      ${S.lrLevel ? `<div class="lr-record">Level up: Lv ${S.lrLevel.level} · ${esc(S.lrLevel.level_name)}</div>` : ""}
      <div class="row" style="justify-content:center;margin-top:18px">
        <button class="btn" id="lr-done">Done</button><button class="btn primary" id="lr-again">⚡ Again</button></div>
    </div>`;
  S.lrLevel = null;
  $("#lr-done").onclick = () => m.close();
  $("#lr-again").onclick = () => { m.close(); startLightning(); };
  m.showModal();
}

// A stage's finish: the message where the photos were, the way on in the bar (the next stage bottom-right, on Enter).
// Every stage ends on the same card: the stamp, the stage's icon, a title, one line, the bonus and what came through.
// `clear` false is a plain ending (nothing to play, or a stage that was skipped), which earns no stamp.
function stageClearHtml({ icon, title, text = "", xp = 0, photos = [], summary = "", clear = true, bonusKey = null }) {
  return `<div class="empty stage-done" data-solid>${clear ? `<div class="clear-stamp">Stage clear</div>` : ""}<div class="big-emoji">${icon}</div><h2>${title}</h2>${text ? `<p class="muted">${text}</p>` : ""}
    ${clear ? `<div class="stage-results">${xp ? `<b>+${fmt(xp)} XP · stage bonus</b>` : bonusKey ? `<b data-stage-bonus="${bonusKey}" hidden></b>` : ""}${photos.length ? `<div class="result-strip">${photos.map((p) => `<img src="${T(p)}" alt="Stage result">`).join("")}</div>` : ""}${summary ? `<span>${summary}</span>` : ""}</div>` : ""}</div>`;
}
// The actions under it: back on the left, Undo in the middle (the history HUD shows it). The way on is the HUD's
// next slot (`setForward`), never a second button down here.
function clearActionsHtml({ back = ["#home", "The map"], undo = null, undoAttr = 'data-fin="undo"' } = {}) {
  return `<div class="bar-left"><a class="btn big" href="${back[0]}">${back[1]}</a></div>
    <div class="bar-mid">${undo ? `<button class="btn ghost" ${undoAttr}><kbd>Z</kbd> ${undo}</button>` : ""}</div>
    <div class="bar-right"></div>`;
}
// A bonus the page didn't know yet (the stage closed in this very call) is filled in once the journey reports it.
async function fillStageBonus(key, root) {
  const view = S.view;
  try { const j = await api("/api/journey"); if (left(view)) return; S.game = j.progress?.game || S.game; S.journey = j; paintSaveChip(); paintTrack(); }
  catch (_) { return; }
  const xp = S.game?.stage_xp?.[key], el = $(`[data-stage-bonus="${key}"]`, root);
  if (el && xp) { el.textContent = `+${fmt(xp)} XP · stage bonus`; el.hidden = false; }
}
function finishStage({ icon, title, text, next, undo: canUndo = true, clear = canUndo && !!next, summary, photos }) {
  const stage = $("#stage");
  World.release();
  stage.className = "arena finished";
  $("#controls").hidden = true;
  const key=S.stage==="stacks"?"crown":S.stage, xp=clear?(S.game?.stage_xp?.[key]||0):0;
  stage.innerHTML = stageClearHtml({ icon, title, text, xp, clear, photos: photos || S.stagePhotos || [],
    summary: summary ?? (key==="crown"?`${plural(S.game?.crowned||0,"stack")} crowned · ${fmt(S.game?.overrules||0)} machine guesses overruled`:key==="groups"?"Your group winners advance together.":key==="knockouts"?`${plural(S.finalists||8,"place")} won for the finals.`:"") });
  if (clear) { Sound.play("crown"); confetti(window.innerWidth / 2, window.innerHeight / 3, 70); }
  World.calm(true);  // a reading moment: the sea stays, dimmed, instead of drawing over the words
  const bar = $("#finish-bar");
  bar.innerHTML = clearActionsHtml({ undo: canUndo ? "Undo the last call" : null });
  setForward(next ? { label: next[1], href: next[0] } : null);
  bar.hidden = false;
  const u = $("[data-fin=undo]", bar);
  if (u) u.onclick = () => undo();
  setHint(next ? `Enter continues to the next stage.${canUndo ? " Z undoes the last call." : ""}` : "Nothing to play here yet. The map is bottom-left.");
}

function stagesDone() {
  $("#duel-q").innerHTML = `👑 <b>Stacks crowned</b> <span>Every burst has its best take.</span>`;
  finishStage({ icon: "👑", title: "All crowned!", next: ["#draw", "Next: Groups →"],
    text: "Every stack now plays as its best take. Next, every shot goes into a themed group." });
  refreshHud(true);
}

// The group stage: each group's standings under the photos, ranked by rating (who you beat counts, not just how
// often), with a line under the places that go through.
async function loadTable(id) {
  const view = S.view, loading = { id };
  S.table = loading;
  try {
    const r = await api(`/api/draw/table/${id}`);
    if (!left(view) && S.table === loading && S.current?.group?.id === id) renderTable(r.table);
  } catch (_) { /* the next vote brings it */ }
}
function renderDuelTable(title, status, content, qualify=false) {
  const box=$("#group-table");if(!box)return;
  box.classList.toggle("expanded",!!S.tableExpanded);
  box.innerHTML=`<div class="gt-head"><b class="gt-title">${title}</b>
    <button class="gt-toggle" aria-expanded="${!!S.tableExpanded}" aria-controls="gt-body"><b>${title}</b><span>${status}</span><i aria-hidden="true">⌄</i></button>
    ${qualify?'<button class="btn ghost gt-qualify" id="group-qualify">Qualify leaders</button>':''}</div>
    <div class="gt-body" id="gt-body">${content}</div>`;
  $(".gt-toggle",box).onclick=()=>{
    S.tableExpanded=!S.tableExpanded;box.classList.toggle("expanded",S.tableExpanded);
    $(".gt-toggle",box).setAttribute("aria-expanded",S.tableExpanded);
  };
  const choose=$("#group-qualify",box);if(choose)choose.onclick=qualifyGroups;
}
function renderTable(t) {
  const box = $("#group-table");
  if (!box) return;
  S.table = t;
  $("#view-duel")?.classList.toggle("with-table", !!t);
  if (!t) { box.hidden = true; return; }
  box.hidden = false;
  renderDuelTable(`<span class="team-letter" style="--team-hue:${groupHue(t.id)}">${esc(t.letter)}</span>Group ${esc(t.letter)} standings`,`${t.settled?"Decided":`${fmt(t.played)} played`} · top ${t.adv}`,
    `<div class="muted small gt-description">${t.settled ? "Decided" : `Top ${t.adv} go through`}${t.played ? ` · ${plural(t.played, "match")} played` : ""}</div>
    <ol class="gt-rows">${t.rows.map((r, i) => `<li class="${r.through ? "through" : ""} ${i === t.adv ? "cut" : ""}" title="${r.w} won · ${r.l} lost${r.d ? ` · ${r.d} level` : ""}${t.played ? ` · ${Math.round(r.odds * 100)}% to go through` : ""}">
      <span class="gt-pos">${i + 1}</span><img src="${T(r.photo)}" alt=""><span class="gt-wl">${r.w}–${r.l}</span>
      <span class="gt-odds" title="Chance of going through">${r.through ? "✓" : ""}${t.played && !r.through ? `${Math.round(r.odds * 100)}%` : ""}</span></li>`).join("")}</ol>`,!t.settled);
}
async function qualifyGroups() {
  if(S.busy)return;
  const view=S.view,signal=S.events.signal;S.busy=true;
  try {
    const d=await api('/api/draw/qualify');if(left(view))return;
    const m=$('#modal');m.className='qualification';m.onclick=null;
    m.innerHTML=`<h2>Send the current leaders through?</h2><p>${plural(d.total,'photo')} advance using the current ratings. More comparisons can change these choices. No extra matches are recorded.</p>
      <div class="qualify-groups">${d.groups.map(g=>`<section><b>${esc(g.emoji)} ${esc(g.name)} <span>${g.adv} of ${g.n}</span></b><div>${g.photos.slice(0,8).map(id=>`<img src="${T(id)}" alt="Current leader">`).join('')}${g.photos.length>8?`<span>+${g.photos.length-8}</span>`:''}</div></section>`).join('')}</div>
      <div class="row spread"><button class="btn" id="qualify-back">Keep playing</button><button class="btn primary" id="qualify-confirm">Qualify ${d.total} →</button></div>`;
    const chosen=await new Promise(resolve=>{let yes=false;const cancel=()=>m.close();signal.addEventListener('abort',cancel,{once:true});m.addEventListener('close',()=>{signal.removeEventListener('abort',cancel);resolve(yes);},{once:true});$('#qualify-back',m).onclick=()=>m.close();$('#qualify-confirm',m).onclick=()=>{yes=true;m.close();};m.showModal();});
    if(!chosen||left(view))return;
    const r=await api('/api/draw/qualify',{basis:d.basis});if(left(view))return;
    updateHudQuiet(r.game);S.current=null;S.cards=[];await loadCards();refreshHud(true);
  }catch(e){if(!left(view))toast(e.status===409?'The leaders changed. Review them again.':e.message);}
  finally{if(!left(view))settle();}
}
function knockoutHtml(st, compact = false) {
  if (!st) return `<p class="muted">Seeded when the group advancers begin.</p>`;
  return `<div class="ko-rounds ${compact ? "compact" : ""}">${st.rounds.map((r)=>`<section><h3>Round of ${r.size}</h3>${r.matches.map((m,k)=>`<${m.winner ? "div" : "a"} class="ko-match ${m.winner ? "settled" : ""}" ${m.winner ? "" : `href="#duel?stage=knockouts&match=${k}"`}>
    ${[m.a,m.b].map((p)=>p ? `<img src="${T(p)}" alt="${m.winner === p ? "Advanced" : "Contender"}" class="${m.winner === p ? "qualified" : ""}">` : `<span class="muted">Bye</span>`).join("<span>vs</span>")}</${m.winner ? "div" : "a"}>`).join("")}</section>`).join("")}
    ${st.qualified?.length ? `<section><h3>${plural(st.qualified.length,"finalist")}</h3><div class="ko-qualified">${st.qualified.map((p)=>`<img src="${T(p)}" alt="Finalist">`).join("")}</div></section>` : ""}</div>`;
}
async function loadSeats(c) {
  const view = S.view, box = $("#group-table");
  if (!box) return;
  S.table = {seats:true}; $("#view-duel")?.classList.add("with-table"); box.hidden=false;
  let d;
  try { d=await api("/api/knockouts"); } catch (e) { if (!left(view)) toast(e.message); return; }
  if (left(view) || S.current?.id !== c.id) return;
  renderDuelTable("🎟️ Road to the finals","Bracket",`<div class="gt-description"><a href="#tournament">Full bracket →</a></div>${knockoutHtml(d.knockouts,true)}`);
}
function groupDecided(t) {
  Sound.play("crown");
  const through = t.rows.filter((r) => r.through).slice(0, 5);
  S.stagePhotos=through.map((r)=>r.photo);
  rewardNotice(t.emoji, `${t.name} · ${t.adv} through`, `Group ${t.letter} decided. ${plural(t.adv, "photo")} through to the knockouts.`,()=>{location.hash="tournament";});
}
async function groupStageDone() {
  const view = S.view;
  $("#controls").hidden = true;
  renderTable(null);
  $("#duel-q").innerHTML = `⚽ <b>Every group decided</b>`;
  let g = S.drawInfo || {}, direct = false;
  try {
    const j = await api("/api/journey"); g = j.stages.groups; direct = !!j.stages.duels?.direct;
    // Nothing to eliminate: seed the advancers now, so the bracket is theirs and the rail shows the stage skipped.
    if (direct && g.done && !j.stages.duels?.done) await api("/api/knockouts/start", {});
  } catch (_) { /* use what we had */ }
  if (left(view) || S.stage !== "groups" || !$("#stage") || S.current) return;
  // Four advancers (or exactly eight) go straight into the bracket: the way on names where you land.
  finishStage(g.groups
    ? { icon: "⚽", title: "Group stage complete!", next: direct ? ["#finals", "Next: Finals →"] : ["#duel?stage=knockouts", "Next: Knockouts →"],
      text: `${g.chosen?'Current leaders chosen':`${plural(g.groups, "group")} decided`} · ${plural(g.through, "photo")} go through${direct ? " straight to the finals" : " to the knockouts"}.`,
      summary: direct ? "Your group winners are the finalists." : "Your group winners advance together." }
    : { icon: "⚽", title: "No groups to play yet", undo: false, next: ["#draw", "Next: Groups →"],
      text: "Make some groups first: every shot goes into one." });
  refreshHud(true);

}

async function knockoutsDone() {
  const view = S.view;
  let skipped = false;
  try { skipped = !!(await api("/api/journey")).stages.duels?.skipped; } catch (_) { /* assume rounds were played */ }
  if (left(view) || S.stage !== "knockouts" || !$("#stage") || S.current) return;
  $("#duel-q").innerHTML = skipped ? `⚔️ <b>Nothing to eliminate</b>` : `⚔️ <b>Finalists decided</b>`;
  finishStage(skipped
    ? { icon: "🎟️", title: "Straight to the finals", undo: false, clear: false, next: ["#finals", "Next: Finals →"],
      text: `With ${plural(S.finalists || 4, "finalist")} there are no elimination rounds to play: the bracket is ready.` }
    : { icon: "🎟️", title: "Finalists qualified!", next: ["#finals", "Next: Finals →"],
      text: `The elimination rounds are complete. Your ${S.finalists || 8} finalists play for the title.` });
}

// Z while an answer is still on its way isn't dropped: it runs as soon as that answer lands.
async function undo() {
  if (S.busy) { S.undoQueued = (S.undoQueued || 0) + 1; return; }
  S.busy = true;
  if(S.stage==='stacks')paintTrack();
  const view = S.view;
  try {
    const r = await api("/api/undo", { stage: S.stage });
    if (left(view)) return;
    if (r.undone) Sound.play("undo");
    S.cards = r.cards;
    preload(S.cards);
    updateMeter(r.progress);
    showNext();
    if (!r.undone) toast("Nothing to undo", 1000);
    refreshHud(true);
  } catch (e) { if (!left(view)) toast(e.message); }
  if (!left(view)) settle();
}

function settle() {
  S.busy = false;
  if(S.stage==='stacks')paintTrack();
  if (S.undoQueued) { S.undoQueued -= 1; undo(); return; }
  while (S.queued?.length) {
    const q = S.queued.shift();
    if (S.current?.id === q.card) { decide(q.outcome, q.choice); break; }
  }
}

function updateMeter(p, outcome) {
  if(p&&Number.isFinite(p.crown_left))S.stacksLeft=p.crown_left;
  if (!p || !p.k) return;
  S.progress = p;
  if (p.game) updateHud(p.game, outcome);
  const v = $("#m-votes");
  if (!v) return;
  v.textContent = `${fmt(p.votes)} duels · ${p.minutes} min`;
  $("#m-bar").style.width = pct(p.quality);
  $("#m-conf").textContent = `top ${p.k} at ${pct(p.quality)} of best`;
  const learning = $("#duel-learnt");
  if(learning){const f=p.learning?.features?.[0]; learning.textContent=p.learning ? `${f?`Learning: ${tasteLabel(f.feature)||f.feature} ${f.up?"▲":"▼"} · `:""}${plural(p.learning.unseen,"unseen photo")} re-ranked` : "";learning.dataset.learning=learning.textContent;learning.title=learning.textContent;}
  const slot = $("#done-slot");
  if (p.done && S.stage === "open" && slot && !slot.dataset.shown) {
    slot.dataset.shown = "1";
    slot.innerHTML = `<div class="done-banner"><span>Your top ${p.k} is settled; more duels would mostly reshuffle near-ties.</span>
      <a class="btn primary" href="#finals">Next: the finals →</a></div>`;
    refreshHud(true);
  }
  const m = Math.floor(p.votes / 50) * 50;
  if (m > 0 && m > S.milestone) {
    if (S.milestone) toast(`${fmt(m)} duels in. Your top ${p.k} is at ${pct(p.quality)} of the best possible.`);
    S.milestone = m;
  } else if (!S.milestone) S.milestone = m;
}

function pressed(o) {
  const b = $(`#controls [data-o="${o}"]`);
  if (!b) return;
  b.classList.remove("pressed");
  void b.offsetWidth;
  b.classList.add("pressed");
}

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || !location.hash.startsWith("#duel") || e.target.closest("input, select, textarea, dialog, .vn-catalog, .vn-tag, .vn-lasso-tag, .island-pop, .sea-tag-pop") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (["Enter", " "].includes(e.key) && e.target.closest("button, a, summary, [role=button]")) return;
  if ($("dialog[open]") || $(".inspect")) return;  // (a photo grabbed out of the sea has the keys)
  const c = S.current;
  const k = gameInput(e).key;
  if (e.target.isContentEditable) return;
  if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); if (!e.repeat) undo(); return; }
  if (k === "c" || k === "C") { e.preventDefault(); if (!e.repeat) toggleCrop(); return; }
  if (k === "f" || k === "F") { e.preventDefault(); if (!e.repeat) toggleFilter(); return; }
  const fin = $("#finish-bar");
  if (k === "Enter" && fin && !fin.hidden && S.forward) { e.preventDefault(); forwardGo(); return; }
  if (k === "Escape") { e.preventDefault(); location.hash = "home"; return; }
  if (!c) return;
  if (k.toLowerCase() === "x") {
    e.preventDefault();
    const target = gamePhotoTarget($("#stage"));
    if (!e.repeat && target) {
      if (c.type === "duel") decide(`toss_${target.dataset.side}`);
      else if (!S.busy) {
        const view=S.view; S.busy=true;
        api("/api/sweep",{photo:Number(target.dataset.photo),keep:false,wait:true}).then(async()=>{
          if(!left(view)){Sound.play("toss");S.cards=[];await loadCards();}
        }).catch(error=>{if(!left(view))toast(error.message);}).finally(()=>{if(!left(view))S.busy=false;});
      }
    }
    return;
  }
  if (c.type === "mini") {
    const m = { ArrowLeft: "a", a: "a", A: "a", ArrowRight: "b", d: "b", D: "b", " ": "skip" }[k];
    if (m) { e.preventDefault(); if (!e.repeat) { pressed(m); decide(m); } }
    return;
  }
  const map = { ArrowLeft: "a", a: "a", A: "a", ArrowRight: "b", d: "b", D: "b", ArrowUp: "great", w: "great", W: "great",
    ArrowDown: "meh", s: "meh", S: "meh", " ": "skip", q: "toss_a", Q: "toss_a", e: "toss_b", E: "toss_b" };
  if (map[k]) { e.preventDefault(); if (!e.repeat) { pressed(map[k]); decide(map[k]); } }
});

// ---------------------------------------------------------------- the game layer
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Tiny synthesized sound effects (no audio files). Off with the speaker button; remembered.
const Sound = {
  on: (() => { try { return localStorage.getItem("matcher-sound") !== "off"; } catch (_) { return true; } })(),
  ctx: null,
  toggle() {
    this.on = !this.on;
    try { localStorage.setItem("matcher-sound", this.on ? "on" : "off"); } catch (_) { /* private mode */ }
    if (this.on) this.play("pick");
  },
  tone(freq, start, dur, type = "sine", vol = 0.05, slide = 0) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(), t = c.currentTime + start;
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  },
  play(name) {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === "suspended") this.ctx.resume();
      const streak = Math.min(20, (S.game && S.game.streak) || 0);  // picks climb in pitch as a streak builds
      const f = {
        pick: () => this.tone(520 + streak * 22, 0, 0.07, "triangle", 0.045),
        great: () => { this.tone(660, 0, 0.08, "triangle"); this.tone(880, 0.07, 0.1, "triangle"); },
        meh: () => this.tone(240, 0, 0.12, "sine", 0.05, -60),
        skip: () => this.tone(380, 0, 0.05, "sine", 0.03),
        toss: () => this.tone(320, 0, 0.18, "sawtooth", 0.025, -220),
        undo: () => this.tone(420, 0, 0.12, "sine", 0.04, -140),
        defend: () => this.tone(440, 0, 0.09, "square", 0.025),
        crown: () => [523, 659, 784, 1047].forEach((n, i) => this.tone(n, i * 0.09, 0.22, "triangle", 0.05)),
        drumroll: () => { for(let i=0;i<12;i++)this.tone(90+i*9,i*0.065,0.06,"triangle",0.028); },
        level: () => [392, 523, 659, 784, 1047].forEach((n, i) => this.tone(n, i * 0.07, 0.25, "square", 0.03)),
        achieve: () => { this.tone(880, 0, 0.12, "triangle"); this.tone(1320, 0.1, 0.25, "triangle"); },
        whoop: () => this.tone(260, 0, 0.13, "sine", 0.018, 520),
      }[name];
      if (f) f();
    } catch (_) { /* no audio here; the game works without it */ }
  },
};

function paintSound() {
  const b = $("#hud-sound");
  if (b) {
    b.textContent = Sound.on ? "🔊" : "🔈";
    b.title = Sound.on ? "Sound on (click to mute)" : "Sound off (click to unmute)";
  }
}

function confetti(x, y, n = 36) {
  if (reduceMotion) return;
  const colors = ["#ff6b5b", "#ffb36b", "#ffd86b", "#57d19b", "#7fb2ff", "#f4f1ec"];
  const box = document.createElement("div");
  box.className = "confetti";
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("i");
    const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 180;
    p.style.setProperty("--dx", `${Math.cos(a) * d}px`);
    p.style.setProperty("--dy", `${Math.sin(a) * d - 120}px`);
    p.style.setProperty("--r", `${Math.random() * 720 - 360}deg`);
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.08}s`;
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 1400);
}

function floatText(text, el, cls = "") {
  if (reduceMotion || !el) return;
  const r = el.getBoundingClientRect();
  const f = document.createElement("div");
  f.className = `floaty ${cls}`;
  f.textContent = text;
  f.style.left = `${r.left + r.width / 2}px`;
  f.style.top = `${r.top + r.height * 0.45}px`;
  document.body.append(f);
  setTimeout(() => f.remove(), 900);
}

const shows = [];  // banners wait their turn
let showing = false;
function banner(html, ms = 1700) {
  shows.push([html, ms]);
  if (!showing) nextShow();
}
function nextShow() {
  const next = shows.shift();
  if (!next) { showing = false; return; }
  showing = true;
  const [html, ms] = next;
  const b = document.createElement("div");
  b.className = "banner";
  b.innerHTML = html;
  document.body.append(b);
  setTimeout(() => b.classList.add("out"), ms);
  setTimeout(() => { b.remove(); setTimeout(nextShow, 150); }, ms + 400);
}

// Level-ups mid-duel don't cover the photos: the level chip celebrates, and a lightning round saves it for the end.
function levelUp(g) {
  Sound.play("level");
  const chip = $("#save-chip");
  if (chip && !chip.hidden && (S.current || S.lr)) {
    chip.classList.remove("leveled");
    void chip.offsetWidth;
    chip.classList.add("leveled");
    floatText(`Lv ${g.level}!`, chip, "bonus");
    const r = chip.getBoundingClientRect();
    confetti(r.left + r.width / 2, r.bottom, 30);
    if (!S.lr) rewardNotice("✦", `Lv ${g.level} · ${g.level_name}`, "Level up!", openTrophies);
    else S.lrLevel = g;
    return;
  }
  banner(`<small>Level up!</small><b>Lv ${g.level} · ${esc(g.level_name)}</b>`);
  confetti(window.innerWidth / 2, window.innerHeight / 3, 70);
}

// Each achievement pops once, wherever it's earned (duels, Groups, export). This browser remembers which
// ones you've seen, so trophies earned by calls made before the game layer existed get a welcome instead.
const Ach = {
  seen: null,
  welcomed: new Set(),
  check(g, catalog) {
    if (!g || !g.unlocked) return;
    if (!g.welcomed && location.hash.startsWith("#home") && !this.welcomed.has(S.lib?.source)) {
      this.welcomed.add(S.lib?.source); if(g.judged>0)welcome(g); api("/api/welcome",{}).catch((e)=>toast(e.message));
    }
    if (!this.seen) {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem("matcher-ach-seen") || "null"); } catch (_) { /* private mode */ }
      if (!Array.isArray(stored)) {
        if (!location.hash.startsWith("#home")) return;  // wait for the home screen to say hello
        this.seen = new Set(g.unlocked);
        this.save();
        return;
      }
      this.seen = new Set(stored);
    }
    const fresh = g.unlocked.filter((id) => !this.seen.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => this.seen.add(id));
    this.save();
    const source=S.lib?.source;
    const show = (list) => fresh.forEach((id, i) => {
      const a = list.find((x) => x.id === id);
      if (a) setTimeout(() => {if(S.lib?.source===source)achievementPop(a);}, i * 650);
    });
    if (catalog) show(catalog);
    else api("/api/game").then((d) => show(d.achievements)).catch(() => {});
  },
  save() {
    try { localStorage.setItem("matcher-ach-seen", JSON.stringify([...this.seen])); } catch (_) { /* private mode */ }
  },
};

function gameCheck() {
  const source=S.lib?.source;
  api("/api/game").then((d) => {if(S.lib?.source===source)Ach.check(d.stats, d.achievements);}).catch(() => {});
}

// Rewards share one place in the HUD. The next choice keeps all of its space; trophies keep the full detail.
const rewardQueue=[];
let rewardTimer=null;
function rewardNotice(icon,title,detail,action=openTrophies) {
  rewardQueue.push({icon,title,detail,action,source:S.lib?.source});
  if(!rewardTimer)pumpRewards();
}
function pumpRewards() {
  const el=$("#hud-reward"),item=rewardQueue.shift();
  if(!el)return;
  if(!item){el.hidden=true;el.onclick=null;rewardTimer=null;return;}
  if(item.source!==S.lib?.source)return pumpRewards();
  el.innerHTML=`<span aria-hidden="true">${esc(item.icon)}</span><b>${esc(item.title)}</b>`;
  el.title=item.detail;el.setAttribute("aria-label",`${item.title}. ${item.detail}`);el.onclick=item.action;el.hidden=false;
  rewardTimer=setTimeout(()=>{rewardTimer=null;pumpRewards();},2600);
}
function achievementPop(a) {
  rewardNotice(a.icon,a.title,`Achievement unlocked: ${a.desc}`);
  Sound.play("achieve");
}
window.addEventListener("hashchange",()=>{
  clearTimeout(rewardTimer);rewardTimer=null;rewardQueue.length=0;
  const el=$("#hud-reward");if(el){el.hidden=true;el.onclick=null;}
});

function welcome(g) {
  const n = g.unlocked.length;
  banner(`<small>Welcome to the game</small><b>Lv ${g.level} · ${esc(g.level_name)}</b>
    <span>Your ${fmt(g.judged)} earlier calls count${n ? ` · ${n} ${n === 1 ? "trophy" : "trophies"} already yours` : ""}</span>`, 3400);
  Sound.play("level");
  confetti(window.innerWidth / 2, window.innerHeight / 3, 60);
}

function updateHud(g, outcome) {
  const prev = S.game;
  S.game = g;
  Ach.check(g);
  paintSaveChip();
  const st = $("#hud-streak");
  if (!st) return;
  st.querySelector("b").textContent = g.streak;
  st.classList.toggle("hot", g.streak >= 5);
  st.classList.toggle("blazing", g.streak >= 15);
  if (!prev || !outcome) return;  // first paint of a session: nothing to celebrate yet
  const gained = g.xp - prev.xp;
  if (gained > 0) {
    const sides = $$("#stage .side");
    const where = outcome === "a" ? sides[0] : outcome === "b" ? sides[1] : $("#save-chip");
    floatText(`+${gained} XP`, where || $("#save-chip"), gained >= 15 ? "bonus" : "");
    st.classList.remove("bump");
    void st.offsetWidth;  // restart the bump animation
    st.classList.add("bump");
  }
  if (g.level > prev.level) levelUp(g);
  if ([5, 10, 15, 25, 50].includes(g.streak) && g.streak > (prev.streak || 0)) {
    floatText(`🔥 ${g.streak} in a row!`, st, "bonus");
    Sound.play(g.streak >= 15 ? "crown" : "level");
    if (g.streak >= 10) confetti(st.getBoundingClientRect().left + 20, st.getBoundingClientRect().top + 12, g.streak >= 25 ? 60 : 30);
  } else if ((prev.streak || 0) >= 5 && g.streak === 0) {
    floatText(`streak of ${prev.streak} ended`, st, "");
    Sound.play("undo");
  }
  goalCheck(g);
}

// The daily goal gets its moment once a day.
function goalCheck(g) {
  if (!g || !g.daily_goal || g.today < g.daily_goal) return;
  const day = new Date().toDateString();
  try {
    if (localStorage.getItem("matcher-goal") === day) return;
    localStorage.setItem("matcher-goal", day);
  } catch (_) { return; }
  Sound.play("achieve");
  rewardNotice("🎯", `Daily goal · ${g.daily_goal} calls`, `${g.days > 1 ? `${g.days}-day streak. ` : ""}Your calls are saved.`, openTrophies);
}

let trophyRequest=0;
async function openTrophies() {
  const request=++trophyRequest,view=S.view,source=S.lib?.source,signal=S.events?.signal;
  const m=$("#modal"),contents=m.firstChild,wasOpen=m.open;
  let d;
  try { d = await api("/api/game"); } catch (e) { if(!left(view)&&request===trophyRequest)toast(e.message); return; }
  if(left(view)||request!==trophyRequest||S.lib?.source!==source||m.firstChild!==contents||m.open!==wasOpen)return;
  const g = d.stats;
  m.className = "wide";
  const pctLevel = g.level_next ? Math.round(((g.xp - g.level_floor) / (g.level_next - g.level_floor)) * 100) : 100;
  const next = g.level_next ? `${fmt(g.level_next - g.xp)} XP to Lv ${g.level + 1}` : "Max level. Legendary.";
  m.innerHTML = `
    <div class="row spread"><h2 style="margin:0">Trophy case</h2><button class="btn" id="close-modal">Close</button></div>
    <div class="trophy-head">
      <div class="big-lvl">Lv ${g.level}</div>
      <div class="trophy-level"><b>${esc(g.level_name)}</b><div class="muted small">${fmt(g.xp)} XP · ${next}</div>
        <div class="bar" style="margin-top:8px"><i style="width:${pctLevel}%"></i></div></div>
      <div class="trophy-stats">
        <div><b>${fmt(g.judged)}</b><span>calls</span></div>
        <div><b>${fmt(g.best_streak)}</b><span>best streak</span></div>
        <div><b>${fmt(g.crowned)}</b><span>stacks crowned</span></div>
        <div><b>${fmt(g.today||0)} / ${fmt(g.daily_goal||30)}</b><span>calls today</span></div>
        <div><b>${fmt(g.days||0)}</b><span>day streak</span></div>
      </div>
    </div>
    ${[...new Set(d.achievements.map((a)=>a.stage))].map((stage)=>`<h3>${esc(stage)}</h3><div class="trophies">${d.achievements.filter((a)=>a.stage===stage).map((a) => `
      <div class="trophy ${a.unlocked ? "got" : ""}"><span class="ico">${a.unlocked ? a.icon : "🔒"}</span>
        <b>${esc(a.title)}</b><span class="muted small">${esc(a.desc)}</span></div>`).join("")}</div>`).join("")}`;
  $("#close-modal").onclick = () => m.close();
  m.onclick = (e) => { if (e.target === m) m.close(); };
  const cancel=()=>m.close();signal?.addEventListener('abort',cancel,{once:true});
  m.addEventListener('close',()=>signal?.removeEventListener('abort',cancel),{once:true});
  m.showModal();
}

async function crownBestGuesses() {
  if(S.busy)return;const view=S.view;
  if (!await askInGame(`Keep the machine's best guess for the other ${fmt(S.stacksLeft)} stacks? You can still change any of them later.`, "Keep best guesses")) return;
  if(left(view)||S.busy)return;
  S.busy=true;paintTrack();
  try {
    const r=await api('/api/stacks/auto',{});if(left(view))return;
    updateMeter(r.progress);S.cards=[];S.current=null;stagesDone();
  }catch(e){if(!left(view))toast(e.message);}
  finally{if(!left(view))settle();}
}

// A stack's favourite defends its place. The little roster leaves the two takes the screen.
function renderMini(stage, c) {
  stage.className = "mini-stage";
  $("#controls").hidden = false;
  $("#controls").classList.add("mini-mode");
  $("#duel-q").textContent = S.stage === "stacks" ? "Crown" : "Which take is better?";
  setHint("Pick the better take. Space saves this round for later.");
  const challenger = c.a === c.champ ? c.b : c.a;
  const label = { champ: "Champion", now: "Challenger", out: "Beaten", next: "Up next" };
  const shown=[c.champ,challenger,...c.frames.filter(f=>f!==c.champ&&f!==challenger)].slice(0,5);
  const strip = shown.map((f) => {
    const st = f === c.champ ? "champ" : f === challenger ? "now" : c.beaten.includes(f) ? "out" : "next";
    return `<span class="mf ${st}" title="${label[st]}"><img src="${T(f)}" alt="${label[st]}">${st === "champ" ? "<i>👑</i>" : ""}</span>`;
  }).join("");
  stage.innerHTML = `
    <div class="mini-bar" aria-label="Round ${c.round} of ${c.total}"><span class="mini-round">${c.round} / ${c.total}</span><span class="mini-strip">${strip}${c.frames.length>shown.length?`<span class="mini-more">+${c.frames.length-shown.length}</span>`:''}</span></div>
    <div class="arena">${["a", "b"].map((side) => `
      <div class="slot slot-${side}"><div class="side ${c[side] === c.champ ? "is-champ" : ""}" data-side="${side}" data-photo="${c[side]}" tabindex="0" title="Point here and press X to toss">
        <div class="print"><div class="paper"><div class="window"><img src="${P(c[side])}" alt="${side === "a" ? "Left" : "Right"} take" draggable="false"></div>
        <span class="role" aria-label="${c[side]===c.champ?'Champion':'Challenger'}">${c[side]===c.champ?'👑':'⚔️'} <span data-help-hint>${c[side]===c.champ?'Champion':'Challenger'}</span></span></div></div>
      </div></div>`).join("")}</div>`;
  $$(".side", stage).forEach((el) => (el.onclick = () => decide(el.dataset.side)));
}

function crowning(photo, overruled) {
  return new Promise((resolve) => {
    Sound.play("crown");
    const stage = $("#stage");
    const r = stage.getBoundingClientRect();
    stage.insertAdjacentHTML("beforeend", `<div class="crowning"><div class="crown-card"><img src="${P(photo)}" alt="">
      <span class="crown">👑</span></div><div class="crown-text">${overruled?"Your pick beat the machine's!":"Crowned!"}</div></div>`);
    confetti(r.left + r.width / 2, r.top + r.height / 2, 60);
    setTimeout(resolve, reduceMotion ? 300 : 1100);
  });
}


// ---------------------------------------------------------------- sweep: keep or toss
async function viewSweep(main) {
  main.innerHTML = LOADING();
  let d;
  const view = S.view;
  try { d = await api("/api/sweep"); } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  const cards = d.cards, labels = d.labels || {};
  let i = 0, kept = 0, tossed = 0, busy = false;
  const done = [];
  if (!cards.length) {
    main.innerHTML = `<div class="screen sweep no-rail">
      <div class="screen-head"><h1>🧹 Clean-up sweep</h1><span class="stat-chip good"><b>0</b> to check</span></div>
      <div class="screen-body fill"><div class="empty quest-clear" data-solid><span class="clear-stamp">All clear</span><div class="big-emoji">🧹</div><h2>Nothing to sweep</h2></div></div>
      <div class="screen-bar action-bar"><div class="bar-left"><a class="btn big" href="#cuts">Set aside</a></div><div class="bar-mid"></div>
        <div class="bar-right"><a class="btn primary big" href="#home">The map → <kbd>Enter</kbd></a></div></div></div>`;
    S.onKey = (e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); location.hash = "home"; } };
    return;
  }
  main.innerHTML = `
    <div class="screen sweep">
      <div class="screen-head">
        <h1>🧹 Clean-up sweep</h1>
        <span class="stat-chip"><span id="sw-count"></span></span>
        <span class="grow"></span>
        ${helpBtn(`A side quest: quick keep-or-toss calls where the sorter wasn't sure. <b>Keep</b> brings a set-aside photo back into
          the running; <b>toss</b> takes one out. Swipe, or use the arrow keys. Nothing is deleted, and <b>Z</b> undoes.`)}
      </div>
      <div class="screen-body fill"><div class="deck" id="deck"></div></div>
      <aside class="screen-rail">
        <div class="rail-card"><h3>This sweep</h3><div class="bar"><i id="sw-bar"></i></div>
          <div class="sw-tally"><span>✅ kept <b id="sw-kept">0</b></span><span>🗑️ tossed <b id="sw-tossed">0</b></span></div></div>
        <div class="rail-card grow"><h3>Up next</h3><div class="up-next" id="sw-next"></div></div>
      </aside>
      <div class="screen-bar action-bar sweep-controls">
        <div class="bar-left"><button class="btn big toss-btn" data-s="toss"><kbd>←</kbd> Toss</button></div>
        <div class="bar-mid"><button class="btn ghost" data-s="skip"><kbd>Space</kbd> Skip</button><button class="btn ghost" data-s="undo"><kbd>Z</kbd> Undo</button>
          <button class="btn ghost filter-btn" data-s="filter"><kbd>F</kbd> <span>${S.filter ? "Enhance on" : "Enhance off"}</span></button></div>
        <div class="bar-right"><button class="btn big keep-btn" data-s="keep">Keep <kbd>→</kbd></button></div>
      </div>
      <div class="screen-bar action-bar" id="sw-finish" hidden>
        <div class="bar-left"><a class="btn big" href="#cuts">Set aside</a></div>
        <div class="bar-mid"><button class="btn ghost" id="sw-undo"><kbd>Z</kbd> Undo the last one</button></div>
        <div class="bar-right"><a class="btn primary big" href="#home">The map → <kbd>Enter</kbd></a></div>
      </div>
    </div>`;
  const why = (c) => (c.kind === "cut" ? `Set aside as "${labels[c.reason] || c.reason}", but it scores fine`
    : `Might be junk${c.flags && c.flags.length ? `: ${c.flags.map((f) => FLAG_LABELS[f] || f).join(", ")}` : ""}`);
  function paint() {
    $("#sw-count").textContent = `${fmt(Math.min(i + 1, cards.length))} / ${fmt(cards.length)}`;
    $("#sw-bar").style.width = pct(i / cards.length);
    $("#sw-kept").textContent = fmt(kept);
    $("#sw-tossed").textContent = fmt(tossed);
    $("#sw-next").innerHTML = cards.slice(i + 1, i + 9).map((c) => `<img src="${T(c.photo)}" alt="">`).join("");
    if (i >= cards.length) { finish(); return; }
    const c = cards[i], nx = cards[i + 1];
    const gone = World.grab($("#deck"));
    $("#deck").innerHTML = `${nx ? `<div class="swipe-card under" data-photo="${nx.photo}"><div class="print"><img src="${P(nx.photo)}" alt="" draggable="false"></div></div>` : ""}
      <div class="swipe-card top" id="top" data-photo="${c.photo}" data-box='${JSON.stringify((c.view || {}).box || null)}'><div class="print"><img src="${P(c.photo)}" alt="Photo to keep or toss" draggable="false"></div>
        <span class="why ${c.kind}">${esc(why(c))}</span><span class="stamp keep">KEEP</span><span class="stamp toss">TOSS</span></div>`;
    drag($("#top"));
    World.swap($("#deck"), gone);
    paintFilters();
  }
  async function decide(keep) {
    if (busy || i >= cards.length) return;  // A call always belongs to the take currently visible.
    busy = true;
    const el = $("#top");
    el.style.transform = "";
    el.classList.add(keep ? "fly-right" : "fly-left");
    Sound.play(keep ? "pick" : "toss");
    floatText("+3 XP", el);
    try {
      const r = await api("/api/sweep", { photo: cards[i].photo, keep });
      if (left(view)) return;
      done.push(keep);
      keep ? kept++ : tossed++;
      if (r.progress && r.progress.game) { Ach.check(r.progress.game); S.game = r.progress.game; }
    } catch (e) { if(!left(view)){toast(e.message);el.classList.remove("fly-right", "fly-left");}busy = false;return; }
    await sleep(200);
    if (left(view)) return;
    i++;
    busy = false;
    paint();
  }
  async function undoOne() {
    if (busy || !done.length) return;
    busy = true;
    try {
      const r = await api("/api/undo", {});
      if (left(view)) return;
      if (r.undone === "sweep") {
        done.pop() ? kept-- : tossed--;
        i = Math.max(0, i - 1);
        Sound.play("undo");
        $(".sweep-controls").hidden = false;
        $("#sw-finish").hidden = true;
      }
      else toast(UNDONE[r.undone] || "Nothing to undo here.");
    } catch (e) { toast(e.message); }
    if (left(view)) return;
    busy = false;
    paint();
  }
  function drag(el) {  // swipe: past a third of the card's width it counts
    let x0 = null, dx = 0;
    el.addEventListener("pointerdown", (e) => { x0 = e.clientX; dx = 0; el.setPointerCapture(e.pointerId); el.classList.add("held"); });
    el.addEventListener("pointermove", (e) => {
      if (x0 == null) return;
      dx = e.clientX - x0;
      el.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
      el.style.setProperty("--keep", Math.max(0, Math.min(1, dx / 120)));
      el.style.setProperty("--toss", Math.max(0, Math.min(1, -dx / 120)));
    });
    const up = (e) => {
      if (x0 == null) return;
      x0 = null;
      el.classList.remove("held");
      if (e.type !== "pointercancel" && Math.abs(dx) > Math.min(140, el.clientWidth / 3)) decide(dx > 0);
      else { el.style.transform = ""; el.style.setProperty("--keep", 0); el.style.setProperty("--toss", 0); }
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
  function finish() {
    $("#sw-count").textContent = "Done";
    $(".sweep-controls").hidden = true;
    $("#sw-finish").hidden = false;
    $("#deck").innerHTML = `<div class="sweep-done"><div class="big-emoji">🧹</div><h2>Swept!</h2>
      <p class="muted">Kept ${fmt(kept)} · tossed ${fmt(tossed)}</p></div>`;
    api("/api/sweep/done", {}).catch(() => {});
    Sound.play("crown");
    confetti(window.innerWidth / 2, window.innerHeight / 3, 50);
  }
  const skip = () => {
    if (busy || i >= cards.length) return;
    if (cards.length-i < 2) { location.hash="filter"; return; }
    cards.push(cards.splice(i,1)[0]); Sound.play("skip"); paint();
  };
  $$("[data-s]").forEach((b) => (b.onclick = () => (b.dataset.s === "undo" ? undoOne() : b.dataset.s === "skip" ? skip() : b.dataset.s === "filter" ? toggleFilter()
    : decide(b.dataset.s === "keep"))));
  $("#sw-undo").onclick = () => undoOne();
  S.onKey = (e) => {
    const k = e.key;
    if (k === "Escape" || (k === "Enter" && i >= cards.length)) { e.preventDefault(); location.hash = "home"; }
    else if (k === "ArrowRight" || k === "Enter" || k === "d" || k === "D") { e.preventDefault(); if (!e.repeat) decide(true); }
    else if (k === "ArrowLeft" || k.toLowerCase() === "x") { e.preventDefault(); if (!e.repeat) decide(false); }
    else if (k === " ") { e.preventDefault(); if (!e.repeat) skip(); }
    else if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); if (!e.repeat) undoOne(); }
    else if (k === "f" || k === "F") { e.preventDefault(); toggleFilter(); }
  };
  paint();
}

// ---------------------------------------------------------------- finals: the bracket
async function viewFinals(main) {
  main.innerHTML = LOADING();
  let d;
  const view = S.view;
  try { d = await api("/api/finals"); } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  renderFinals(main, d);
}

function bracketHtml(f, now) {
  const seed = (pid) => f.seeds.indexOf(pid) + 1;
  const slot = (m, side) => {
    const pid = m[side];
    const cls = !m.winner ? "" : m.winner === pid ? "win" : "lose";
    return `<div class="bs ${cls}">${pid ? `<img src="${T(pid)}" alt=""><span>${seed(pid)}</span>` : `<i>?</i>`}</div>`;
  };
  const box = (k) => `<div class="bm ${k === now ? "now" : ""} ${f.matches[k].winner ? "played" : ""}">${slot(f.matches[k], "a")}${slot(f.matches[k], "b")}</div>`;
  const n = f.matches.length;
  const cols = f.size === 8 ? [["Quarterfinals", [0, 1, 2, 3]], ["Semifinals", [4, 5]], ["Final", [n - 1]]]
    : [["Semifinals", [0, 1]], ["Final", [n - 1]]];
  return cols.map(([title, ks]) => `<div class="bcol"><h4>${title}</h4>${ks.map(box).join("")}${title === "Final"
    ? `<h4 class="bronze-h">Bronze</h4>${box(n - 2)}` : ""}</div>`).join("") +
    `<div class="bcol champ-col"><h4>Champion</h4><div class="bchamp">${f.champion ? `<img src="${T(f.champion)}" alt=""><span>👑</span>` : `<i>?</i>`}</div></div>`;
}

function podiumHtml(ids, rescued = new Set(), members = {}, byPhoto = {}) {
  const [gold, silver, bronze] = ids;
  const pod = (pid, cls, medal, place) => pid ? `<div class="pod ${cls}"><div class="pod-photo print tile-pile" ${cardData(byPhoto[pid] || { photo: pid }, true)}>${pilePhotos(pid, members[pid] || [])}<div class="paper"><div class="window"><img src="${P(pid)}" alt="" data-view="${pid}"></div></div>
    ${place === 1 ? `<span class="pod-crown">👑</span>` : ""}<span class="medal">${medal}</span>${rescued.has(pid)?`<span class="rescue-mark" title="Rescued in the Sweep">🧹</span>`:""}</div><div class="pod-step">${place}</div></div>` : "";
  return `<div class="podium">${pod(silver, "silver", "🥈", 2)}${pod(gold, "gold", "🥇", 1)}${pod(bronze, "bronze", "🥉", 3)}</div>`;
}

// The bracket a seeding would make right now (the same pairings the server uses), to show before it's seeded.
function previewBracket(seeds) {
  const size = seeds.length >= 8 ? 8 : 4;
  const pairs = size === 8 ? [[0, 7], [3, 4], [1, 6], [2, 5]] : [[0, 3], [1, 2]];
  const blank = () => ({ a: null, b: null, winner: null });
  const matches = pairs.map(([x, y]) => ({ a: seeds[x], b: seeds[y], winner: null }));
  if (size === 8) matches.push(blank(), blank());
  matches.push(blank(), blank());
  return { size, seeds, matches, champion: null };
}

const FINALS_HELP = `The knockout survivors go into a bracket: quarterfinals, semifinals, a bronze match and the final. A small cup
  has four finalists and starts at the semifinals. Every match also teaches your taste. You can seed early from the leaderboard;
  the fairest early bracket starts once it's at 80% of its best. <b>←</b>/<b>→</b> or <b>A</b>/<b>D</b> pick. <b>Space</b> skips, <b>X</b> tosses the photo you point at, <b>Z</b> undoes. <b>C</b> crops; <b>F</b> enhances.`;

function renderFinals(main, d) {
  const gone = World.grab(main);
  renderBracket(main, d);
  World.swap(main, gone);
}
function renderBracket(main, d) {
  const view = S.view;
  World.calm(false);
  const bracketOpen=main.dataset.finalsView===String(view)&&main.dataset.finalsOpen==='true';
  main.dataset.finalsView=String(view);
  main.dataset.finalsOpen=String(bracketOpen);
  const f = d.finals;
  const q = (d.progress && d.progress.quality) || 0;
  if (!f) {
    main.dataset.finalsOpen='false';
    const seeds = d.preview || [];
    const qualified=d.seed_source==='knockouts';
    main.innerHTML = `
      <div class="screen finals no-rail">
        <div class="screen-head">
          <h1>🏆 Finals</h1>
          ${seeds.length ? `<span class="stat-chip ${qualified?'good':''}"><b>${seeds.length}</b> ${qualified?'finalists qualified':'seeds'}</span>` : ""}
          ${qualified?'':`<span class="stat-chip ${q < 0.8 ? "warn" : "good"}"><b>${pct(q)}</b> of its best${q < 0.8 ? " · fairest from 80%" : ""}</span>`}
          <span class="grow"></span>
          ${helpBtn(FINALS_HELP)}
        </div>
        <div class="screen-body fill finals-body">${d.eligible && seeds.length ? `
          <div class="finals-caption">${qualified?`Your bracket is set. Time for the title.`:`If you seed it now, these ${seeds.length} go in`}</div>
          <div class="bracket preview" id="bracket">${bracketHtml(previewBracket(seeds), -1)}</div>`
          : `<div class="empty"><div class="big-emoji">🏆</div><h2>Not enough for a bracket</h2>
            <p class="muted">This cup needs at least 4 shots in the running. Bring some back from <a href="#cuts">Set aside</a>.</p></div>`}
        </div>
        <div class="screen-bar action-bar">
          <div class="bar-left"><a class="btn big" href="${qualified?'#tournament':'#duel'}">${qualified?'Board':'More duels first'}</a></div>
          <div class="bar-mid">${d.eligible && !qualified && q < 0.8 ? `<span class="muted small">The leaderboard is at ${pct(q)} of its best; seeding now is fine, just less fair.</span>` : ""}</div>
          <div class="bar-right"></div>
        </div>
      </div>`;
    let starting = false;
    const start = async () => {
      if (starting || left(view)) return;
      starting = true;
      try { const r = await api("/api/finals/start", {}); if (left(view)) return; Sound.play("level"); renderFinals(main, { ...r, progress: d.progress }); }
      catch (e) { if (!left(view)) toast(e.message); }
      finally { starting = false; }
    };
    setForward(d.eligible ? { label: qualified ? "Start Finals →" : "Seed the bracket →", name: "Finals", run: start } : null);
    setHint(d.eligible && seeds.length ? (qualified ? "Enter starts the finals." : "Enter seeds the bracket from the leaderboard.") : "Bring photos back from Set aside to fill a bracket.");
    S.onKey = (e) => {
      if (e.key === "Enter" && d.eligible) { e.preventDefault(); start(); }
      else if (e.key.toLowerCase() === "z") {
        e.preventDefault();if(starting)return;starting=true;
        api("/api/undo",{}).then(async r=>{if(!left(view)){if(r.undone)Sound.play("undo");await viewFinals(main);}})
          .catch(error=>{if(!left(view))toast(error.message);}).finally(()=>{starting=false;});
      }
    };
    return;
  }
  const card = DuelSides.present(d.card);
  const seed = (pid) => f.seeds.indexOf(pid) + 1;
  const sameRound = card ? f.matches.map((m, k) => [m, k]).filter(([m]) => m.round === card.round) : [];
  const nth = card ? sameRound.findIndex(([, k]) => k === card.match) + 1 : 0;
  const played = f.matches.filter((m) => m.winner).length;
  main.innerHTML = `
    <div class="screen finals">
      <div class="screen-head">
        <h1>🏆 Finals</h1>
        ${card ? `<span class="stat-chip match-title"><b>${esc(card.label)}</b>${sameRound.length > 1 ? ` ${nth} of ${sameRound.length}` : ""}</span>`
          : f.champion ? `<span class="stat-chip good">👑 <b>Champion crowned</b></span>` : ""}
        <span class="stat-chip"><b>${played}</b> of ${f.matches.length} matches</span>
        <span class="grow"></span>
        ${helpBtn(FINALS_HELP)}
      </div>
      <div class="screen-body fill" id="f-match">${card ? `
        <div class="arena finals-arena enter ${card.round === "final" ? "is-final" : ""}" id="f-arena">${["a", "b"].map((side) => `
          <div class="slot slot-${side}"><div class="side" data-side="${side}" data-photo="${card[side]}" tabindex="0" title="Point here and press X to toss"
            data-box='${JSON.stringify(((d.photos || {})[card[side]] || {}).box || null)}'${card.teams?.[card[side]]?.id != null ? ` style="--team-hue:${groupHue(card.teams[card[side]].id)}"` : ""}>
            <div class="print"><div class="paper"><div class="window"><img class="whole" src="${P(card[side])}" alt="${side === "a" ? "Left" : "Right"}" draggable="false"></div>
            <span class="role">Seed ${seed(card[side])}</span></div></div>
            ${card.teams?.[card[side]]?`<span class="team-chip">${esc(card.teams[card[side]].emoji)} <b>${esc(card.teams[card[side]].letter)}</b> ${side==="b"&&card.teams[card.a]?.letter===card.teams[card.b]?.letter?"":esc(card.teams[card[side]].name)}</span>`:""}</div></div>`).join("")}</div>`
        : f.champion ? `<div class="finals-done">${stageClearHtml({ icon: "🏆", title: "Champion!", bonusKey: "finals", xp: S.game?.stage_xp?.finals || 0,
            summary: `Seed ${seed(f.champion)} takes the title${f.runner_up ? ` over seed ${seed(f.runner_up)}` : ""}.` })}${podiumHtml([f.champion, f.runner_up, f.bronze])}</div>` : ""}
      </div>
      <aside class="screen-rail"><div class="rail-card grow finals-bracket ${bracketOpen?'expanded':''}"><div class="finals-bracket-head"><h3>Bracket</h3>
        <button id="f-bracket-toggle" class="finals-bracket-toggle" aria-expanded="${bracketOpen}" aria-controls="bracket"><b>Bracket</b><span>${played}/${f.matches.length} played</span><i aria-hidden="true">⌄</i></button>
        <button class="btn ghost" id="f-reset" title="Throw this bracket away and seed a new one">Replay</button></div>
        <div class="bracket" id="bracket">${bracketHtml(f, card ? card.match : -1)}</div></div></aside>
      <div class="screen-bar action-bar">${card ? `
        <div class="bar-left"><button class="btn big" data-f="a"><kbd>←</kbd> <span class="lbl-wide">Left wins</span><span class="lbl-narrow">Top wins</span></button></div>
        <div class="bar-mid"><div class="dpad"><button class="btn" data-f="skip"><kbd>Space</kbd> Skip</button></div>
          <div class="tools"><button class="btn ghost" data-f="undo"><kbd>Z</kbd> Undo</button>
          <button class="btn ghost" data-f="crop" id="crop-btn"><kbd>C</kbd> <span>${CROP_WORD[normCrop(S.crop)]}</span></button>
          <button class="btn ghost filter-btn" data-f="filter"><kbd>F</kbd> <span>${S.filter ? "Enhance on" : "Enhance off"}</span></button></div></div>
        <div class="bar-right"><button class="btn big" data-f="b"><span class="lbl-wide">Right wins</span><span class="lbl-narrow">Bottom wins</span> <kbd>→</kbd></button></div>` :
        clearActionsHtml({ undo: "Undo the final", undoAttr: 'data-f="undo"' })}
      </div>
    </div>`;
  const shownAt = playTime();
  if (card) { setForward(null); setHint(`Pick the winner${card.round === "final" ? " of the final" : ""}. Space saves this match for later.`); }
  else if (f.champion) {
    setForward({ label: "Next: Reveal →", name: "Reveal", href: "#reveal" });
    // The champion's moment lives on the page itself: one podium, one way forward, the sea calmed behind it.
    World.calm(true); setHint("Enter continues to the reveal."); fillStageBonus("finals", main);
    if (d.crowned) { Sound.play("crown"); setTimeout(() => { if (!left(view)) Sound.play("level"); }, 500);
      for (let k = 0; k < 4; k++) setTimeout(() => { if (!left(view)) confetti(window.innerWidth * (0.2 + 0.2 * k), window.innerHeight * 0.3, 50); }, k * 250); }
    $("#journey-next")?.focus({ preventScroll: true });
  }
  $('#f-bracket-toggle').onclick=()=>{
    const open=main.dataset.finalsOpen!=='true';main.dataset.finalsOpen=String(open);
    $('.finals-bracket',main).classList.toggle('expanded',open);$('#f-bracket-toggle').setAttribute('aria-expanded',String(open));World.fence();
  };
  if(card?.round==="final")Sound.play("drumroll");
  let busy = false;
  const pick = async (outcome) => {
    if (busy || !card) return;
    busy = true;
    const sides = $$("#f-arena .side");
    sides[outcome === "a" ? 0 : 1].classList.add("won");
    sides[outcome === "a" ? 1 : 0].classList.add("lost");
    Sound.play(card.round === "final" ? "crown" : card.round === "sf" ? "level" : "pick");
    const ws = seed(outcome === "a" ? card.a : card.b), ls = seed(outcome === "a" ? card.b : card.a);  // the moment: who goes on
    floatText(card.round === "final" ? `👑 Seed ${ws} takes the title!` : ws > ls ? `Upset! Seed ${ws} advances` : `Seed ${ws} advances`,
      sides[outcome === "a" ? 0 : 1], ws > ls || card.round === "final" ? "bonus" : "");
    const orientation=DuelSides.pick(card,outcome);
    try {
      const r = await api("/api/vote", { card: card.id, outcome:DuelSides.outcome(card,outcome), ms: Math.round(playTime() - shownAt) })
        .catch(e=>{DuelSides.reject(orientation);throw e;});
      if (left(view)) return;
      if (r.progress && r.progress.game) updateHudQuiet(r.progress.game);
      await sleep(260);
      if (left(view)) return;
      if (r.result && r.result.round === "final") { renderFinals(main, { ...r, progress: r.progress, crowned: true }); refreshHud(true); return; }
      renderFinals(main, r);
    } catch (e) {
      if (left(view)) return;
      toast(e.message);
      sides.forEach((el) => el.classList.remove("won", "lost"));
      if (e.status === 409 && !left(view)) viewFinals(main);
      busy = false;
    }
  };
  const skip = async () => {
    if(busy||!card)return;busy=true;
    try{const r=await api("/api/vote",{card:card.id,outcome:"skip"});if(left(view))return;Sound.play("skip");
      if(r.card?.match===card.match){location.hash="tournament";return;}renderFinals(main,r);
    }catch(error){if(!left(view))toast(error.message);busy=false;}
  };
  const toss = async () => {
    const target=gamePhotoTarget($("#f-arena"));if(busy||!target)return;busy=true;
    try{await api("/api/sweep",{photo:Number(target.dataset.photo),keep:false,wait:true});if(!left(view)){Sound.play("toss");await viewFinals(main);}}
    catch(error){if(!left(view))toast(error.message);busy=false;}
  };
  const undoPick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await api("/api/undo", {});
      if (left(view)) return;
      if (r.undone === "final") { Sound.play("undo"); renderFinals(main, r); refreshHud(true); return; }
      if (r.undone === "sweep") { Sound.play("undo"); await viewFinals(main); refreshHud(true); return; }
      toast(UNDONE[r.undone] || "Nothing to undo here.");
    } catch (e) { toast(e.message); }
    busy = false;
  };
  $$("[data-f]").forEach((b) => (b.onclick = () => (b.dataset.f === "undo" ? undoPick() : b.dataset.f === "skip" ? skip() : b.dataset.f === "filter" ? toggleFilter()
    : b.dataset.f === "crop" ? toggleCrop() : pick(b.dataset.f))));
  paintFilters(); paintCrops();
  $$("#f-arena .side").forEach((el) => (el.onclick = () => pick(el.dataset.side)));
  $("#f-reset").onclick = async () => {
    if (busy) return;
    if (!await askInGame("Throw this bracket away and seed a new one from the current leaderboard?", "Replay finals")) return;
    if (left(view)) return;
    busy = true;
    try {const r=await api("/api/finals/reset", {});if(left(view))return;renderFinals(main,{...r,progress:d.progress});}
    catch(e){if(!left(view))toast(e.message);return;}
    finally { busy = false; }
    refreshHud(true);
  };
  S.onKey = (e) => {
    const k = e.key;
    if (["ArrowLeft", "a", "A"].includes(k)) { e.preventDefault(); if (!e.repeat) pick("a"); }
    else if (["ArrowRight", "d", "D"].includes(k)) { e.preventDefault(); if (!e.repeat) pick("b"); }
    else if (["z", "Z", "Backspace"].includes(k)) { e.preventDefault(); if (!e.repeat) undoPick(); }
    else if (k === "f" || k === "F") { e.preventDefault(); toggleFilter(); }
    else if ((k === "c" || k === "C") && card) { e.preventDefault(); toggleCrop(); }
    else if (k === " ") { e.preventDefault(); if (!e.repeat) skip(); }
    else if (k.toLowerCase() === "x") { e.preventDefault(); if (!e.repeat) toss(); }
    else if (k === "Enter" && !card && f.champion) { e.preventDefault(); location.hash = "reveal"; }
  };
}

// Achievements and level-ups from pages without the duel HUD.
function updateHudQuiet(g) {
  const prev = S.game;
  S.game = g;
  Ach.check(g);
  if (prev && g.level > prev.level) levelUp(g);
  goalCheck(g);
}

// ---------------------------------------------------------------- the tournament board
// The whole tournament on one board, like a broadcast: every group's roster and standings (who's through, the cut),
// the race for the finals' eight seats with the next ones in line, and the bracket.
async function viewTournament(main, params = new URLSearchParams()) {
  main.innerHTML = LOADING();
  const view = S.view;
  let d;
  try { d = await api("/api/tournament"); } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  const st = S.journey ? journeyStatus(S.journey) : null;
  const next = st && STAGES.find(([k]) => k === st.next);
  const decided = d.groups.filter((g) => g.settled).length;
  const kickoff=params.get("kickoff")==="1", closeGroups=d.groups.filter((g)=>g.rows.length>g.adv);
  const death=closeGroups.sort((a,b)=>(a.rows[a.adv-1].odds-a.rows[a.adv].odds)-(b.rows[b.adv-1].odds-b.rows[b.adv].odds))[0]?.id;
  const team = (t) => (t ? `<span class="team-chip mini">${esc(t.emoji)} <b>${esc(t.letter)}</b></span>` : "");
  const group = (g) => `
    <div class="tb-group ${g.settled ? "settled" : ""} ${kickoff ? "kickoff-team" : ""}" style="--i:${d.groups.indexOf(g)};--team-hue:${groupHue(g.id)}">
      <div class="tb-ghead"><span class="tb-letter">${esc(g.letter)}</span><span class="tb-gname">${esc(g.emoji)} ${esc(g.name)}</span>
        <span class="tb-gstate">${g.settled ? "✓ Decided · " : g.played ? `${plural(g.played, "match")} played · ` : ""}${g.adv} through</span></div>
      ${kickoff&&g.id===death?`<span class="death-badge">🔥 Group of death · the closest fight for a place</span>`:""}
      <ol class="tb-roster">${g.rows.map((r, i) => `
        <li class="${r.through ? "through" : ""} ${i === g.adv ? "cut" : ""}" title="${r.w} won · ${r.l} lost${r.d ? ` · ${r.d} level` : ""}">
          <span class="tb-pos">${i + 1}</span><img src="${T(r.photo)}" alt="" data-view="${r.photo}">
          <span class="tb-wl">${r.w}–${r.l}</span>
          <span class="tb-odds"><i style="width:${g.played ? pct(r.odds) : "0"}"></i></span><span class="tb-pct">${r.through ? "✓" : g.played ? `${Math.round(r.odds * 100)}%` : ""}</span></li>`).join("")}</ol>
      ${!g.settled?`<a class="btn ghost small" href="#duel?stage=groups&group=${g.id}">Play this group →</a>`:""}
    </div>`;
  const seat = (x, i, bubble) => `<div class="tb-seat ${bubble ? "bubble" : ""}" style="--i:${i}">
      <span class="tb-seatno">${bubble ? i + 9 : i + 1}</span><img src="${T(x.photo)}" alt="" data-view="${x.photo}">${team(x.team)}</div>`;
  const f = d.finals;
  main.innerHTML = `
    <div class="screen tournament no-rail">
      <div class="screen-head">
        <h1>${kickoff?"⚽ Kick-off draw":"🏟️ Tournament"}</h1>
        <span class="stat-chip"><b>${fmt(d.groups.length)}</b> ${d.groups.length === 1 ? "group" : "groups"} · ${fmt(decided)} decided</span>
        ${f && f.champion ? `<span class="stat-chip good">👑 champion crowned</span>` : ""}
        <span class="grow"></span>
        ${helpBtn(`The whole tournament at a glance. <b>Group stage:</b> each group's photos in standings order (who you beat counts, not just how
          often); the places above the dashed line go through. <b>Knockouts:</b> elimination rounds decide the finalists; a loss ends that run.
          <b>Finals:</b> eight finalists, or four in a small cup, play for the podium. Click a photo to see it big.`)}
      </div>
      <div class="screen-body tb-body">
        <section class="tb-section ${kickoff ? "kickoff" : ""}">${kickoff ? "" : "<h2>⚽ Group stage</h2>"}
          ${d.groups.length ? `<div class="tb-groups ${kickoff ? "kickoff" : ""}">${d.groups.map(group).join("")}</div>` : `<p class="muted">No groups yet: every shot goes into a themed group first.</p>`}</section>
        <section class="tb-section" ${kickoff?"hidden":""}><h2>⚔️ Knockouts <span class="muted small">elimination rounds into the finals</span></h2>
          ${d.knockouts?knockoutHtml(d.knockouts):d.seats.length ? `<div class="tb-seats">${d.seats.map((x, i) => seat(x, i)).join("")}</div>
            ${d.bubble.length ? `<div class="tb-bubble"><span class="muted small">On the bubble</span>${d.bubble.map((x, i) => seat(x, i, true)).join("")}</div>` : ""}`
            : `<p class="muted">The seats fill once there are enough shots in the running.</p>`}</section>
        <section class="tb-section" ${kickoff?"hidden":""}><h2>🏆 Finals</h2>
          ${f ? `<div class="bracket tb-bracket">${bracketHtml(f, d.card ? d.card.match : -1)}</div>`
            : d.preview && d.preview.length ? `<div class="bracket tb-bracket preview">${bracketHtml(previewBracket(d.preview), -1)}</div><p class="muted small">If the bracket were seeded now.</p>`
            : `<p class="muted">Not enough shots for a bracket yet.</p>`}</section>
      </div>
      <div class="screen-bar action-bar">
        <div class="bar-left"><a class="btn big" href="#home">The map</a></div>
        <div class="bar-mid"><a class="btn ghost" href="#shortlist">🏅 Leaderboard</a></div>
        <div class="bar-right"></div>
      </div>
    </div>`;
  $$("[data-view]", main).forEach((img) => (img.onclick = () => openViewer(Number(img.dataset.view))));
  setHint(kickoff ? "Meet the teams. Enter kicks off the first group." : "Pick a group to play, or continue bottom-right.");
  if(kickoff)Sound.play("level");
  setForward(kickoff ? { label: "Kick off →", name: "Group stage", href: "#duel?stage=groups" }
    : next && st[next[0]] ? { label: `Next: ${next[2]} →`, name: next[2], href: st[next[0]].go } : { label: "Play knockouts →", name: "Knockouts", href: "#duel?stage=knockouts" });
  S.onKey=(e)=>{if(e.key==="Enter"){e.preventDefault();forwardGo();}};
}

// ---------------------------------------------------------------- reveal
async function viewReveal(main) {
  main.innerHTML = LOADING();
  let d;
  const view = S.view;
  try { d = await api("/api/reveal"); } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  const g = (d.progress && d.progress.game) || {}, p = d.progress || {};
  const named = (d.taste || []).filter((t) => TASTE_LABELS[t.feature]);
  const loves = named.filter((t) => t.effect > 0.04).sort((a, b) => b.effect - a.effect).slice(0, 4);
  const skips = named.filter((t) => t.effect < -0.04).sort((a, b) => a.effect - b.effect).slice(0, 4);
  const li = (xs) => xs.map((t) => `<li>${esc(tasteLabel(t.feature))}</li>`).join("") || `<li class="muted">nothing strong yet</li>`;
  const cup = d.cup || { name: "Your cup", icon: "🏆" };
  const nextCup = (d.cups || []).find((c) => c.key !== (d.cup && d.cup.key) && !c.champion && c.shots >= 4);
  main.innerHTML = `
    <div class="screen reveal">
      <div class="screen-head">
        <h1>🎉 Reveal</h1>
        <span class="stat-chip">${cup.icon} <b>${esc(cup.name)}</b></span>
        <span class="stat-chip ${d.from_finals ? "good" : ""}">${d.from_finals ? "👑 crowned in the finals" : "from the leaderboard so far"}</span>
        <span class="grow"></span>
        ${helpBtn(`Your podium and your top ${d.top.length}${d.from_finals ? `: the finals decided the top ${Math.min(8, d.top.length)}, the leaderboard the rest`
          : ", straight from the leaderboard: play the finals to settle the top 8"}. <b>Save my best</b> copies the original files into a folder, named by
          rank; the <b>blind review package</b> is a shuffled, metadata-free set to send to someone for a second opinion.`)}
      </div>
      <div class="screen-body reveal-body">
        ${d.from_finals && d.path?.length ? `<div class="title-road" aria-label="Road to the title"><b>Road to the title</b><div>${d.path.map((step,i)=>`<span style="--i:${i}"><img src="${T(step.beaten)}" alt="Take beaten"><small>${esc(step.stage)}</small><b class="defeated" aria-label="Defeated opponent">✕</b></span>`).join("")}</div></div>` : ""}
        ${podiumHtml(d.podium, new Set(d.top.filter((p)=>p.rescued).map((p)=>p.photo)), Object.fromEntries(d.top.map((p)=>[p.photo,p.members||[]])), Object.fromEntries(d.top.map((p)=>[p.photo,p])))}
        ${d.top.length > 3 ? `<div class="reveal-strip">${d.top.slice(3).map((it) => `<div class="tile ${it.members?.length > 1 ? "stacked" : ""}"><div class="tile-pile print" ${cardData(it, true)}>${pilePhotos(it.photo, it.members)}<div class="paper"><div class="window"><img src="${T(it.photo)}" alt="" loading="lazy" data-view="${it.photo}"></div></div><span class="rank">${it.rank}</span>${it.rescued?`<span class="rescue-mark" title="Rescued in the Sweep">🧹</span>`:""}</div></div>`).join("")}</div>` : ""}
      </div>
      <aside class="screen-rail">
        <div class="rail-card taste"><h3>Your taste</h3>
          <div class="taste-cols"><div><b>You go for</b><ul>${li(loves)}</ul></div><div><b>Not your thing</b><ul>${li(skips)}</ul></div></div>
          ${(p.votes || 0) < 60 ? `<p class="faint small">Early days: mostly its starting guesses so far.</p>` : ""}</div>
        <div class="rail-card"><h3>Your run</h3><div class="stat-grid">
          <div><b>${fmt(g.judged)}</b><span>${g.judged === 1 ? "call" : "calls"}</span></div><div><b>${(p.minutes || 0) < 1 ? "<1" : Math.round(p.minutes)}</b><span>${(p.minutes || 0) < 1.5 ? "minute" : "minutes"}</span></div>
          <div><b>${fmt(g.best_streak)}</b><span>best streak</span></div><div><b>${fmt(g.crowned)}</b><span>${g.crowned === 1 ? "stack" : "stacks"} crowned</span></div>
          <div><b>${fmt(g.sweep)}</b><span>swept</span></div><div><b>Lv ${g.level || 1}</b><span>${esc(g.level_name || "")}</span></div>
        </div></div>
        ${nextCup ? `<div class="rail-card next-cup"><div><b>Next up: ${nextCup.icon} ${esc(nextCup.name)}</b>
          <div class="muted small">${plural(nextCup.shots, "shot")} · about ${Math.max(3, Math.round(nextCup.shots / 6))} minutes to a champion</div></div>
          <button class="btn primary" data-next-cup="${nextCup.key}">Play it</button></div>` : ""}
      </aside>
      <div class="screen-bar action-bar">
        <div class="bar-left">${d.from_finals ? "" : `<a class="btn big" href="#finals">Play the finals</a>`}<a class="btn big" href="#shortlist" title="One shot at a time: finish them and save your best">🏅 Leaderboard</a></div>
        <div class="bar-mid"><button class="btn ghost" id="x-card">Share card (image)</button>
          <button class="btn ghost" id="x-review">Blind review package</button></div>
        <div class="bar-right"><button class="btn primary big" id="x-best">Save my best <kbd>Enter</kbd></button></div>
      </div>
    </div>`;
  const nx = $("[data-next-cup]", main);
  if (nx) nx.onclick = async () => {
    try { await api("/api/cup", { cup: nx.dataset.nextCup }); } catch (e) { toast(e.message); return; }
    location.hash = "home";
  };
  $("#x-card").onclick = () => shareCard(d, cup, loves, skips);
  $$("[data-view]", main).forEach((img) => (img.onclick = () => openViewer(Number(img.dataset.view))));
  $$("[data-frame=own]", main).forEach(frameBoardCard);  // the podium and the strip frame by each shot's choices, or C and F
  $("#x-best").onclick = (e) => exportFlow("bestof", e.currentTarget, nextCup, () => $("#x-card").click());
  $("#x-review").onclick = (e) => exportFlow("review", e.currentTarget);
  S.onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#x-best").click(); } };
  if (d.from_finals && !reduceMotion) {
    const delay=Math.min(2400,(d.path?.length||0)*180);
    $(".podium",main).style.animationDelay=`${delay}ms`;
    setTimeout(() => {if(!left(view))confetti(window.innerWidth / 2, window.innerHeight * 0.25, 70);},delay+400);
  }
}

// A picture of your result to send people: the podium and your taste, drawn fresh (no photo metadata in it).
async function shareCard(d, cup, loves, skips) {
  const W = 1080, H = 1350, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const bg = x.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1d1410"); bg.addColorStop(1, "#0d0e10");
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  x.fillStyle = "#ffd86b"; x.font = "800 64px system-ui, sans-serif"; x.textAlign = "center";
  x.fillText(`${cup.name}`, W / 2, 120, W - 120);
  x.fillStyle = "#9ba1a8"; x.font = "500 32px system-ui, sans-serif";
  x.fillText(d.from_finals ? "crowned in the finals" : "my top three so far", W / 2, 172);
  const load = (id) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = P(id); });
  const ims = await Promise.all(d.podium.slice(0, 3).map(load));
  const slots = [[W / 2 - 190, 230, 380, 500, "#ffd86b", "1"], [70, 380, 300, 400, "#c0c6cc", "2"], [W - 370, 420, 300, 400, "#d9a066", "3"]];
  [1, 2, 0].forEach((k) => {
    const im = ims[k], [sx, sy, sw, sh, col, place] = slots[k];
    if (!im) return;
    const sc = Math.max(sw / im.width, sh / im.height), cw = sw / sc, ch = sh / sc;
    x.save();
    x.beginPath(); x.roundRect(sx, sy, sw, sh, 24); x.clip();
    x.drawImage(im, (im.width - cw) / 2, (im.height - ch) / 2, cw, ch, sx, sy, sw, sh);
    x.restore();
    x.lineWidth = 8; x.strokeStyle = col; x.beginPath(); x.roundRect(sx, sy, sw, sh, 24); x.stroke();
    x.fillStyle = col; x.font = "900 54px system-ui, sans-serif"; x.fillText(place, sx + sw / 2, sy + sh + 66);
  });
  x.textAlign = "left";
  const list = (title, items, left) => {  // two columns of what the model learned you like and don't
    x.fillStyle = "#f4f1ec"; x.font = "800 36px system-ui, sans-serif"; x.fillText(title, left, 1000, 420);
    x.fillStyle = "#c9ccd0"; x.font = "500 26px system-ui, sans-serif";
    items.slice(0, 3).forEach((t,k)=>{
      const lines=[''];
      for(const word of `• ${tasteLabel(t.feature)}`.split(/\s+/)){
        const at=lines.length-1,next=lines[at]?`${lines[at]} ${word}`:word;
        if(lines[at]&&x.measureText(next).width>420&&lines.length<2)lines.push(word);else lines[at]=next;
      }
      lines.forEach((line,i)=>x.fillText(line,left,1047+k*58+i*28,420));
    });
  };
  if (loves.length) list("I go for", loves, 90);
  if (skips.length) list("Not my thing", skips, loves.length ? 570 : 90);
  if (d.path?.length) {
    x.fillStyle = "#ffd86b"; x.font = "600 26px system-ui, sans-serif"; x.textAlign = "center";
    const rounds=[...new Set(d.path.map((s)=>s.stage))];
    x.fillText(`${plural(d.path.length,"win")} · ${rounds.join(" → ")}`,W/2,H-100,W-100);
  }
  x.fillStyle = "#6b7178"; x.font = "600 26px system-ui, sans-serif"; x.textAlign = "center";
  x.fillText("Sorted with MatchER", W / 2, H - 50);
  const a = document.createElement("a");
  a.href = c.toDataURL("image/png");
  a.download = `matcher-${(cup.name || "result").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
  a.click();
  toast("Saved your share card.");
}

// A path wraps at its slashes, never mid-word.
const pathHtml = (path) => esc(path).replace(/\//g, "/<wbr>");
// The export lands as a reward card over the screen (not pushed into the page, where it would shift everything).
// The run ends on the next cup or the share card; the folder is the secondary action.
async function exportFlow(kind, b, nextCup = null, share = null) {
  const label = b.innerHTML;
  b.disabled = true;
  b.textContent = "Saving…";
  try {
    const r = await api("/api/export", { kind });
    const m = $("#modal");
    m.className = "";
    m.onclick = null;
    m.innerHTML = kind === "bestof" ? `
      <div class="exported stack">
        <h2>🏆 Saved your top ${r.count}</h2>
        <p class="muted">The original files, untouched (metadata and all), named by rank: 01 is your best.${r.touched ? ` <b>touched up/</b> has a copy of each${r.touched < r.count ? ` (${r.touched} of ${r.count})` : ""} the way the Leaderboard shows it: enhanced unless you switched that off, cropped or turned where you chose, full size, EXIF kept.` : ""}</p>
        <div class="export-where"><code class="path">${pathHtml(r.dir)}</code><button class="btn ghost" id="open-export">Open folder</button></div>
        <div class="row spread"><button class="btn" id="close-modal">Close</button>
          ${nextCup ? `<button class="btn primary" id="export-next">Play: ${esc(nextCup.icon)} ${esc(nextCup.name)} →</button>`
            : share ? `<button class="btn primary" id="export-next">Share card (image) →</button>` : `<a class="btn primary" id="export-next" href="#home">The map →</a>`}</div>
      </div>` : `
      <div class="exported stack">
        <h2>📦 Exported ${plural(r.count, "photo")} for review</h2>
        <div><code class="path">${esc(r.zip)}</code></div>
        <p class="muted">Send <b>share/review_photos.zip</b> (P001.jpg… in shuffled order, no EXIF/GPS) to whoever is reviewing.
          Keep <b>KEY.PRIVATE.csv</b> (next to the share folder) to yourself until the reviews are back; it maps P-numbers to your files and ranks.
          Have a quick look first for anything in the frame you wouldn't want a stranger to see.</p>
        <div class="row spread"><button class="btn" id="close-modal">Close</button><button class="btn primary" id="open-export">Open folder</button></div>
      </div>`;
    $("#open-export", m).onclick = () => api("/api/open", { path: r.dir });
    $("#close-modal", m).onclick = () => m.close();
    const onwards = $("#export-next", m);
    if (onwards && nextCup) onwards.onclick = async () => { try { await api("/api/cup", { cup: nextCup.key }); } catch (e) { toast(e.message); return; } m.close(); location.hash = "home"; };
    else if (onwards && share && onwards.tagName === "BUTTON") onwards.onclick = () => { m.close(); share(); };
    m.showModal();
    (onwards || $("#open-export", m)).focus();
    Sound.play("achieve");
    gameCheck();
  } catch (e) { toast(e.message); }
  b.disabled = false;
  b.innerHTML = label;
}

// ---------------------------------------------------------------- shortlist (the leaderboard)
// One card at a time, as big as the stage allows, with everything the sorter knows about it on a square sticky
// note hanging from the frame (seeded by the photo, kept clear of its picture); ← and → walk the ranks,
// then the bubble. The rail keeps the taste card and the hand-picked list; the bar keeps the exports.
const boardPos = { source: null, at: 0 };
// "1 May 2024 14:32" from the stored "2024-05-01T14:32:10": the way you would write it on a frame.
function prettyDate(taken) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(taken || ""));
  if (!m) return String(taken || "");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] || m[2]} ${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`;
}
function seededRandom(id) {
  let seed = ((Number(id) || 0) * 2654435761) >>> 0;
  return () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// The same square sticky follows a focused shot everywhere. Its tags and the sorter's confidence are visible;
// the longer evidence and editing controls live on the separate notes sheet.
function photoSticky(it, tagsOn, {change = "", controls = false} = {}) {
  const ranked=it.p_in!=null, status=it.rank?`#${it.rank}`:it.bubble?"On the bubble":it.active===false?"Set aside":"In the running";
  return `<div class="note-head"><b class="note-rank">${status}</b>${change?`<span class="note-change">${esc(change)}</span>`:""}</div>
    ${ranked?`<div class="note-line">${pct(it.p_in)} sure · ${it.duels} duel${it.duels===1?"":"s"}</div>
      <div class="conf" title="Chance it belongs on the leaderboard: ${pct(it.p_in)}"><i style="width:${pct(it.p_in)}"></i></div>`:""}
    <div class="note-line">${ranked?`appeal ${(it.appeal>0?"+":"")+Number(it.appeal||0).toFixed(2)} · `:""}${it.frames>1
      ?controls?`<button class="note-link" data-frames="${it.photo}" title="Swap which take stands in for this stack">${it.frames} takes</button>`:`${it.frames} takes`:"one take"}${it.rescued?" · 🧹 rescued":""}</div>
    ${tagsOn.length?`<div class="note-tags">${tagsOn.map(t=>`<span>${esc(t.emoji||"🏷️")} ${esc(t.label)}</span>`).join("")}</div>`:""}
    ${it.flags?.length?`<div class="flags">${flagHtml(it.flags)}</div>`:""}
    ${controls&&it.bubble?`<div class="actions">${it.added?`<button class="btn" data-unpick="${it.photo}">Added ✓</button>`:`<button class="btn" data-pick="${it.photo}" title="It rides along in the export without a rank">+ Add</button>`}</div>`:""}`;
}
// Hang the adhesive edge from the bottom of the paper, leaving the picture and its handwriting clear. Focused
// panes reserve space for the loose end; a sea print keeps its camera size and uses a side edge if needed.
function placeNote(card) {
  const note=card?.querySelector(":scope > .photo-sticky");
  if(!note||note.classList.contains("dragging"))return;
  const rnd=seededRandom(card.dataset.photo),r1=rnd(),r2=rnd();
  let saved=null;
  try{saved=JSON.parse(card.dataset.note||"null");}catch(_){/* never moved */}
  let size=38,font=2.3;
  const place=()=>{
    note.style.setProperty("--note-size",size);note.style.setProperty("--note-font",font);
    card.style.setProperty("--sticky-tail",size-1);
    card.style.setProperty("--sticky-ratio",(1+(size-1)/133.3333).toFixed(4));
    const cw=card.clientWidth||1,ch=card.clientHeight/cw*100;
    let x=4+r1*Math.max(0,66-size),y=ch-4;
    if(Array.isArray(saved)&&saved.length===2)[x,y]=saved;
    else if(card.matches('.sea-photo-detail')||!card.matches('.board-fit > *, .side > *, .filter-shot > *, .viewer-stage > *')){
      const r=card.getBoundingClientRect(),w=cw*size/100;
      if(r.bottom+(size-4)*cw/100>innerHeight-12){
        if(r.left>=w+12){x=2-size;y=Math.max(6,ch-size-5);}
        else if(innerWidth-r.right>=w+12){x=98;y=Math.max(6,ch-size-5);}
      }
    }
    note.style.setProperty("--note-x",x);note.style.setProperty("--note-y",y);
    note.style.setProperty("--note-turn",`${((r2*2-1)*3).toFixed(1)}deg`);
  };
  place();
  for(let guard=0;guard<24&&note.scrollHeight>note.clientHeight+1;guard++){
    if(size<78)size+=4;else if(font>1.3)font=Math.round((font-.2)*10)/10;else break;
    place();
  }
}
async function viewShortlist(main) {
  main.innerHTML = LOADING();
  let d, meta = { tags: [] }, board = { groups: [] };
  const view = S.view;
  try { [d, meta, board] = await Promise.all([api("/api/shortlist"), api("/api/tags?all=1").catch(() => meta), api("/api/draw/board?per=1&uper=1").catch(() => board)]); }
  catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  const p = d.progress || {};
  const rankKey=`matcher-ranks:${S.lib?.source || ""}:${S.journey?.cup || "all"}`;
  let previous={}; try { previous=JSON.parse(localStorage.getItem(rankKey)||"{}"); } catch(_) { /* first visit */ }
  try { localStorage.setItem(rankKey,JSON.stringify(Object.fromEntries(d.items.map((it)=>[it.photo,it.rank])))); } catch (_) { /* storage can be unavailable or full */ }
  const entries = [...d.items, ...d.bubble.map((it) => ({ ...it, bubble: true }))];
  if (boardPos.source !== (S.lib?.source || "")) { boardPos.source = S.lib?.source || ""; boardPos.at = 0; }
  let at = Math.max(0, Math.min(boardPos.at, entries.length - 1));
  const tagMeta = new Map((meta.tags || []).map((t) => [t.key, t]));
  const groupOf = (pid) => {
    const w = World.photos?.get(pid), gid = w && w.theme >= 0 ? w.theme : World.sea?.items.get(pid)?.group;
    return (board.groups || []).find((g) => g.id === gid) || null;
  };
  const note = (it) => {
    const change=it.rank&&Object.keys(previous).length&&!previous[it.photo]?"NEW":it.rank&&previous[it.photo]>it.rank?`▲ ${previous[it.photo]-it.rank}`:"";
    const tagsOn=(World.photos?.get(it.photo)?.tags||[]).map(k=>tagMeta.get(k)).filter(Boolean);
    return `<div class="meta sticky photo-sticky" data-note-change="${esc(change)}" data-note-added="${!!it.added}" title="Drag me where you like">${photoSticky(it,tagsOn,{change,controls:true})}</div>`;
  };
  // The card is a pane like a duel's: its picture sits in the paper's window, so this photo's own crop, turn and
  // enhancement show exactly as Save my best will write them.
  // The chin, in handwriting: the file, its group and its date, within the frame.
  const chin = (it) => {
    const g = groupOf(it.photo), file = String(it.rel || "").split("/").pop();
    return `<div class="chin">${g ? `<b class="chin-group">${esc(g.emoji || "🗂️")} ${esc(g.name)}</b>` : ""}<span class="chin-file" title="${esc(it.rel || "")}">${esc(file)}${it.taken ? ` · ${esc(prettyDate(it.taken))}` : ""}</span></div>`;
  };
  const cropOf = (e) => normCrop(e.crop);
  const card = (it) => { const e = it.edits || {}; return `<div class="tile board-card print tile-pile has-photo-sticky ${it.frames > 1 ? "stacked" : ""}" ${cardData(it)}
      data-note="${esc(JSON.stringify(e.note || null))}">
      ${pilePhotos(it.photo, it.members)}<div class="paper"><div class="window"><img src="${P(it.photo)}" alt="" data-view="${it.photo}"></div>${chin(it)}</div>${note(it)}</div>`; };
  const phoneFinishing=matchMedia('(max-width: 760px)');
  main.innerHTML = `
    <div class="screen board">
      <div class="screen-head">
        <h1>🏅 Leaderboard</h1>
        <span class="stat-chip">top <b>${d.items.length}</b></span>
        <span class="stat-chip"><b>${fmt(p.votes)}</b> duels</span>
        <span class="stat-chip ${p.quality >= 0.8 ? "good" : ""}"><b>${pct(p.quality)}</b> of its best</span>
        ${d.settled ? `<span class="stat-chip good">👑 top <b>${d.settled}</b> from the finals</span>` : ""}
        <span class="stat-chip board-pos" ${entries.length ? "" : "hidden"}></span>
        <span class="grow"></span>
        ${helpBtn(`One shot at a time, best first: <b>←</b> and <b>→</b> (or A and D) walk the ranks and then <b>On the bubble</b>, the next
          ones in line. The sticky note is everything the sorter knows about the shot: how sure it is that it belongs here (more duels make
          it surer), its takes, tags and looks; drag it where you like. The sheet beside the card is the finishing: <b>F</b> enhance (with
          knobs for levels, light, contrast, colour and warmth), <b>C</b> walks the crops (best, focus subject, fill height, fill width, off), <b>R</b> turns a
          quarter; each is kept for that shot, shown in the card's window and baked into <b>Save my best</b> (Z takes one back). At most
          ${S.lib.settings.per_scene} per scene, so it stays varied. Add a bubble shot by hand and it rides along in the export without a rank.
          Pull out the photo's notes corner for its details and finishing controls. Click the photo to see it big.`)}
      </div>
      <div class="screen-body board-body">
        ${entries.length ? `<div class="board-stage">
          <button class="btn ghost board-arrow" data-step="-1" aria-label="Previous (←)" title="Previous (←)">‹</button>
          <div class="board-fit"></div>
          <button class="btn ghost board-arrow" data-step="1" aria-label="Next (→)" title="Next (→)">›</button>
        </div>` : `<div class="empty">Nothing on the board yet: play some duels first.</div>`}
      </div>
      <aside class="screen-rail"><details class="board-insights" ${phoneFinishing.matches?'':'open'}><summary>About this shortlist</summary><div class="board-insight-pages">
        ${tasteHtml(d.taste, p.votes)}
        <div class="rail-card"><h3>Added by hand</h3>
          ${d.added.length ? `<div class="added-list">${d.added.map((it) => `<div class="added-item"><img src="${T(it.photo)}" alt="" data-view="${it.photo}">
            <button class="btn ghost" data-unpick="${it.photo}" title="Take it out of the export">Remove</button></div>`).join("")}</div>`
            : `<p class="muted small">Nothing yet. Add favourites from <b>On the bubble</b>; they ride along in the export without a rank.</p>`}
        </div>
      </div></details></aside>
      <div class="screen-bar action-bar">
        <div class="bar-left"><a class="btn big" href="#duel">Keep dueling</a></div>
        <div class="bar-mid"><button class="btn ghost" id="export">Blind review package</button></div>
        <div class="bar-right"><button class="btn primary big" id="export-best">Save my best</button></div>
      </div>
    </div>`;
  const pick = async (b,on) => {try {await api("/api/pick",{photo:Number(on?b.dataset.pick:b.dataset.unpick),on});if(!left(view))viewShortlist(main);}catch(e){if(!left(view))toast(e.message);}};
  const bind = (root) => {
    root.onclick = e => {
      const b=e.target.closest('[data-pick],[data-unpick],[data-view],[data-frames]');if(!b||!root.contains(b))return;
      e.stopPropagation();
      if(b.hasAttribute('data-pick'))pick(b,true);
      else if(b.hasAttribute('data-unpick'))pick(b,false);
      else if(b.hasAttribute('data-view'))openViewer(Number(b.dataset.view));
      else openFrames(Number(b.dataset.frames),()=>viewShortlist(main));
    };
  };
  bind($(".screen-rail", main));
  const fit = $(".board-fit", main), pos = $(".board-pos", main);
  phoneFinishing.addEventListener('change',event=>{$$('.board-insights',main).forEach(details=>details.open=!event.matches);},{signal:S.events.signal});
  // The toolbelt (toolbelt.js) draws on the card; it is told this shot's edits so it never has to fetch them, and
  // what it saves (marks, notes) comes back into this view's copy.
  const fromBelt = (pid, edits) => { if (left(view)) { Toolbelt.listeners.delete(fromBelt); return; } const it = entries.find((x) => x.photo === pid); if (it) it.edits = edits; };
  Toolbelt.listeners.add(fromBelt);
  // Cards slide in from one random direction and out along another: no scaling, nothing rising from the sea.
  const away = (angle) => `translate(${Math.round(Math.cos(angle) * 1200)}px, ${Math.round(Math.sin(angle) * 1200)}px) rotate(${((angle * 3) % 1 - 0.5) * 24}deg)`;
  const show = (i, slide = true) => {
    if (!fit || !entries.length) return;
    at = boardPos.at = Math.max(0, Math.min(i, entries.length - 1));
    const it = entries[at], old = $$(".board-card", fit), holder = document.createElement("div");
    holder.innerHTML = card(it);
    const el = holder.firstElementChild, img = el.querySelector(".window > img");
    el.style.visibility = "hidden";  // framed before it is seen: no landing and then snapping into its crop
    fit.append(el);
    const leaving = slide && !reduceMotion && old.length;
    if (leaving) for (const o of old) { o.style.pointerEvents = "none"; o.animate([{ transform: "none", opacity: 1 }, { transform: away(Math.random() * 6.2832), opacity: 0.5 }], { duration: 360, easing: "cubic-bezier(.4,0,.9,.5)", fill: "forwards" }).finished.then(() => o.remove(), () => o.remove()); }
    else old.forEach((o) => o.remove());
    pos.innerHTML = it.rank ? `#<b>${it.rank}</b> of ${d.items.length}` : `on the bubble <b>${at - d.items.length + 1}</b> of ${d.bubble.length}`;
    $$(".board-arrow", main).forEach((b) => { const next = at + Number(b.dataset.step); b.style.visibility = next < 0 || next >= entries.length ? "hidden" : ""; });
    bind(el);
    dragNote(el); Toolbelt.know(it.photo, it.edits || {});
    const ready = img && !(img.complete && img.naturalWidth) ? img.decode().catch(() => {}) : Promise.resolve();
    ready.then(() => {
      if (!el.isConnected || left(view)) return;
      placeNote(el); frameBoardCard(el);
      el.style.visibility = "";
      if (leaving) el.animate([{ transform: away(Math.random() * 6.2832), opacity: 0.5 }, { transform: "none", opacity: 1 }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
  };
  const dragNote = (card) => Toolbelt.dragNote(card.querySelector('.photo-sticky'),card,(x,y)=>Toolbelt.save(Number(card.dataset.photo),{note:[x,y]}));
  // Finishing a shot: this photo's own enhancement and its knobs, crop mode and turn, saved and undoable, baked
  // into Save my best. The card re-renders in place (no slide).
  let editing = false;
  const edit = async (change) => {
    const it = entries[at];
    if (!it || editing || !change) return;
    editing = true;
    try {
      const r = await api("/api/edit", { photo: it.photo, ...change });
      if (left(view)) return;
      it.edits = r.edits || {};
      show(at, false); refreshHud(true);
      Toolbelt.know(it.photo, it.edits);
    } catch (err) { if (!left(view)) toast(err.message); }
    finally { editing = false; }
  };
  // C walks the crop modes for this shot: best, focus subject (with a subject), fill height, fill width, off.
  const nextCrop = (it) => {
    const order = CROP_MODES.filter((m) => m !== "subject" || it.box), m = order[(order.indexOf(cropOf(it.edits || {})) + 1) % order.length];
    return m === "off" ? "none" : m;
  };
  $$(".board-arrow", main).forEach((b) => (b.onclick = () => show(at + Number(b.dataset.step))));
  show(at);
  if (fit && typeof ResizeObserver !== "undefined") {  // the window's size decides the framing
    const ro = new ResizeObserver(() => { if (left(view)) { ro.disconnect(); return; } const card = $$(".board-card", fit).at(-1); if (card) { placeNote(card); frameBoardCard(card); } });
    ro.observe(fit);
  }
  $("#export").onclick = (e) => exportFlow("review", e.currentTarget);
  $("#export-best").onclick = (e) => exportFlow("bestof", e.currentTarget);
  S.onKey = (e) => {
    if (e.repeat || e.target.closest("input, select, textarea")) return;  // a knob or a note keeps its own keys
    const k = e.key;
    if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); show(at + 1); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); show(at - 1); }
    else if (k === "Home") { e.preventDefault(); show(0); }
    else if (k === "End") { e.preventDefault(); show(entries.length - 1); }
    else if (k === "f" || k === "F") { e.preventDefault(); edit({ enhance: (entries[at]?.edits || {}).enhance === false }); }
    else if (k === "c" || k === "C") { e.preventDefault(); edit({ crop: nextCrop(entries[at]) }); }
    else if (k === "r" || k === "R") { e.preventDefault(); edit({ rotate: (((entries[at]?.edits || {}).rotate || 0) + 90) % 360 }); }
  };
}
// The data a card frames itself by (`frameBoardCard`): its subject and the Leaderboard's choices for that shot. A
// `global` card (the Reveal's podium and strip) follows the C and F toggles wherever no choice was made; the
// Leaderboard's own card shows the whole photo and enhances it unless told otherwise, as the export will.
function cardData(it, global = false) {
  const e = it?.edits || {}, crop = e.crop!=null?normCrop(e.crop):"";
  return `data-frame="own" data-photo="${it.photo}" data-box="${esc(JSON.stringify(it.box || null))}" data-crop="${crop}" data-crop-default="${global ? "global" : "off"}"
    data-enhance="${e.enhance === false ? "off" : e.enhance === true ? "on" : global && !e.look ? "" : "on"}" data-rotate="${e.rotate || 0}" data-look="${esc(JSON.stringify(e.look || null))}" data-crop-box="${esc(JSON.stringify(e.crop_box||null))}" data-straighten="${e.straighten||0}" data-finishing="${esc(JSON.stringify({grade:e.grade,masks:e.masks}))}"`;
}
// A card frames its picture by its own data attributes (see cardData), falling back to the global toggles.
function frameBoardCard(card) {
  const img = card?.querySelector(".window img");
  if (!img) return;
  let box = null;
  try { box = JSON.parse(card.dataset.box || "null"); } catch (_) { /* no subject */ }
  let knobs = null;
  try { knobs = JSON.parse(card.dataset.look || "null"); } catch (_) { /* auto */ }
  const crop = card.dataset.crop || (card.dataset.cropDefault === "global" ? undefined : "off");
  const enhance = card.dataset.enhance === "off" ? false : card.dataset.enhance === "on" ? true : undefined;
  const frame = () => framePhoto(card, { dims: [img.naturalWidth || 1, img.naturalHeight || 1], box },
    { crop, rotate: Number(card.dataset.rotate) || 0, enhance, knobs: knobs ? knobsOf(knobs) : null });
  if (img.naturalWidth) frame(); else img.addEventListener("load", frame, { once: true });
}

function facePos(box) {
  if (!box) return "";
  const c = (v) => Math.round(Math.min(100, Math.max(0, v * 100)));
  return `object-position:${c(box[0] + box[2] / 2)}% ${c(box[1] + box[3] * 0.36)}%`;
}

function tasteHtml(taste, votes) {
  if (!taste || !taste.length) return "";
  const named = taste.filter((t) => TASTE_LABELS[t.feature]);
  const pos = named.filter((t) => t.effect > 0.04).sort((a, b) => b.effect - a.effect).slice(0, 4);
  const neg = named.filter((t) => t.effect < -0.04).sort((a, b) => a.effect - b.effect).slice(0, 4);
  const note = (t) => {
    const d = t.effect - t.prior;
    if (Math.abs(d) < 0.08) return "";
    return `<span class="faint small"> (${(d > 0) === (t.effect > 0) ? "more" : "less"} than it assumed)</span>`;
  };
  const list = (xs) => xs.map((t) => `<li>${tasteLabel(t.feature)}${note(t)}</li>`).join("") || '<li class="muted">nothing strong yet</li>';
  return `<div class="rail-card taste">
      <h3>What it has learned about your taste</h3>${votes < 60 ? `<p class="faint small">Early days: mostly its starting guesses so far.</p>` : ""}
      <div class="taste-cols"><div><b>Pulls a shot up</b><ul>${list(pos)}</ul></div>
        <div><b>Pulls a shot down</b><ul>${list(neg)}</ul></div></div>
    </div>`;
}

function photoPathButton(id) {
  return `<button class="btn ghost copy-path" data-copy-path="${Number(id)}" aria-label="Copy original file path" title="Copy this take's original file path">Copy path</button>`;
}

async function copyPhotoPath(button) {
  if(button.dataset.copying)return;
  const view=S.view,source=S.lib?.source,dialog=button.closest('dialog'),inspection=button.closest('.inspect');
  const alive=()=>!left(view)&&S.lib?.source===source&&button.isConnected&&(!dialog||dialog.open)&&(!inspection||inspection.classList.contains('open'));
  button.dataset.copying='true';
  try {
    const data=await api(`/api/photo/${Number(button.dataset.copyPath)}`);
    if(!alive())return;
    try {
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(data.original_path);
      if(alive()){button.textContent='Copied';button.title=data.original_path;setTimeout(()=>{if(alive())button.textContent='Copy path';},1600);}
    } catch(_) {
      if(!alive())return;
      $('#photo-path-dialog')?.close();
      const box=document.createElement('dialog');box.id='photo-path-dialog';
      box.innerHTML='<h2>Original file path</h2><p class="muted small">Select and copy this path.</p><textarea readonly aria-label="Original file path" spellcheck="false"></textarea><div class="row"><button class="btn" data-close-path>Close</button></div>';
      $('textarea',box).value=data.original_path;document.body.append(box);
      const signal=S.events.signal,close=()=>box.close();signal.addEventListener('abort',close,{once:true});
      box.addEventListener('close',()=>{signal.removeEventListener('abort',close);box.remove();if(alive())button.focus();},{once:true});
      $('[data-close-path]',box).onclick=close;box.showModal();$('textarea',box).focus();$('textarea',box).select();
    }
  }catch(e){if(alive())toast(e.message);}finally{delete button.dataset.copying;}
}

// These controls may sit inside a selectable take; copying must never also cast a call or select its stack.
document.addEventListener('click',e=>{const b=e.target.closest('[data-copy-path]');if(b){e.preventDefault();e.stopPropagation();copyPhotoPath(b);}},true);
document.addEventListener('contextmenu',e=>{
  if(e.target.closest('#photo-path-dialog,.photo-crop-editor,.photo-mask-editor,.photo-notes-paper,.photo-sticky,.user-note,input,textarea,select,a'))return;
  const img=e.target.closest('img'),match=img?.getAttribute('src')?.match(/^\/img\/[tp]\/(\d+)\.jpg(?:\?|$)/),
    print=e.target.closest('.print,.ps-item,.shot-select,.ftile,.tile,.polaroid'),sea=World.sea;
  let id=match?Number(match[1]):print?Toolbelt.pidOf(print):0,host=print;
  if(!id&&sea?.alive&&!sea.uiTarget(e.target)&&!e.target.closest('dialog,.photo-sea:not(#world)')){
    const it=sea.photoAt(...sea.localWorld(e));if(it){id=it.photo;host=it.el;}
  }
  if(!id)return;
  e.preventDefault();e.stopPropagation();
  if(PhotoNotes.active?.pid===id){PhotoNotes.close();return;}
  if(host===PhotoNotes.seaSource)host=PhotoNotes.seaDetail;
  if(host&&PhotoNotes.hosts.has(host))PhotoNotes.open(host);
  else openViewer(id,{notes:true});
});

function openViewer(id,{notes=false}={}) {
  const m = $("#modal");
  m.viewerControls?.abort();
  const events=new AbortController(),{signal}=events;m.viewerControls=events;
  m.className = "wide photo-viewer";
  m.innerHTML = `<div class="viewer"><div class="viewer-stage" role="region" aria-label="Photo preview. Scroll to zoom; drag to pan when zoomed in."><div class="print"><img src="${T(id)}" alt="" draggable="false"></div></div><div class="viewer-actions">${photoPathButton(id)}<button class="btn" data-viewer-reset hidden>Reset view</button><button class="btn" data-viewer-notes hidden>Notes</button><button class="btn" id="close-modal">Close</button></div></div>`;
  const stage=$('.viewer-stage',m),card=$('.print',stage),img=$('img',card),resetButton=$('[data-viewer-reset]',m),notesButton=$('[data-viewer-notes]',m);
  let zoom=1,x=0,y=0,drag=null,suppressClick=false,sourceTimer=null,pendingSource=null,wantedSource=img.getAttribute('src');
  const loadSource=()=>{
    if(signal.aborted||!m.open||pendingSource||img.getAttribute('src')===wantedSource)return;
    const source=wantedSource,next=new Image();pendingSource=next;next.src=source;
    // Keep the currently decoded picture on the card until its replacement is ready. Only one resolution can
    // be loading at once, and an old response cannot replace the level the latest camera position needs.
    next.decode().then(()=>{
      if(!signal.aborted&&m.open&&source===wantedSource)img.src=source;
    }).catch(()=>{/* Retain the last good picture; the next zoom or resize can retry this level. */}).finally(()=>{
      if(pendingSource===next)pendingSource=null;
      if(source!==wantedSource)loadSource();
    });
  };
  const requestSource=()=>{
    clearTimeout(sourceTimer);
    sourceTimer=setTimeout(()=>{
      if(signal.aborted||!m.open)return;
      const r=card.getBoundingClientRect(),picture=img.getBoundingClientRect();
      photoSampling(img,zoom);
      wantedSource=M(id,Math.max(picture.width,picture.height),r.height>=innerHeight*.8);
      loadSource();
    },120);
  };
  const paint=()=>{
    card.style.transform=`translate(${x}px,${y}px) scale(${zoom})`;
    if(card.dataset.viewerZoom!==String(zoom)){card.dataset.viewerZoom=String(zoom);photoSampling(img,zoom);}
    stage.classList.toggle('zoomed',zoom>1.001);resetButton.hidden=notesButton.hidden=zoom<=1.001;
  };
  const reset=()=>{zoom=1;x=y=0;paint();requestSource();};
  const constrain=()=>{
    const r=card.getBoundingClientRect(),s=stage.getBoundingClientRect(),left=r.left-x,top=r.top-y;
    const bound=(value,lo,hi,base,size)=>size>hi-lo?Math.max(hi-24-base-size,Math.min(lo+24-base,value)):Math.max(lo+8-base,Math.min(hi-8-base-size,value));
    x=bound(x,s.left,s.right,left,r.width);y=bound(y,s.top,s.bottom,top,r.height);
  };
  const zoomAt=(next,cx,cy)=>{
    const r=card.getBoundingClientRect(),ratio=next/zoom;
    x+=(cx-r.left)*(1-ratio);y+=(cy-r.top)*(1-ratio);zoom=next;
    if(zoom<=1.001)reset();else{paint();constrain();paint();}
    requestSource();
  };
  stage.addEventListener('wheel',e=>{
    if(e.target.closest('.photo-notes-paper'))return;
    e.preventDefault();e.stopPropagation();
    const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?stage.clientHeight:1);
    zoomAt(Math.max(1,Math.min(12,zoom*Math.exp(-Math.max(-500,Math.min(500,delta))*.0015))),e.clientX,e.clientY);
  },{passive:false,signal});
  stage.addEventListener('pointerdown',e=>{
    if(e.button||zoom<=1.001||Toolbelt.tool!=='hand'||e.target.closest('button,a,input,textarea,.photo-sticky,.user-note'))return;
    e.preventDefault();e.stopPropagation();drag={id:e.pointerId,x:e.clientX,y:e.clientY,px:x,py:y,moved:false};
    stage.setPointerCapture(e.pointerId);stage.classList.add('panning');
  },{signal});
  stage.addEventListener('pointermove',e=>{
    if(!drag||e.pointerId!==drag.id)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.moved||=Math.hypot(dx,dy)>4;
    x=drag.px+dx;y=drag.py+dy;paint();constrain();paint();
  },{signal});
  const release=e=>{
    if(!drag||e.pointerId!==drag.id)return;
    suppressClick=drag.moved;drag=null;stage.classList.remove('panning');
    if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId);
  };
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,release,{signal});
  stage.addEventListener('dblclick',e=>{if(Toolbelt.tool==='hand'&&!e.target.closest('button,input,textarea,.photo-sticky,.user-note')){e.preventDefault();e.stopPropagation();reset();}},{signal});
  stage.addEventListener('click',e=>{if(e.target.closest('.photo-notes-tab'))reset();},{capture:true,signal});
  window.addEventListener('resize',reset,{signal});resetButton.onclick=reset;
  notesButton.onclick=()=>{reset();PhotoNotes.open(card);};
  m.onclick = e => {if(suppressClick){suppressClick=false;e.preventDefault();return;}if(!e.target.closest('.print,.viewer-actions,.photo-note-sheet'))m.close();};
  $('#close-modal',m).onclick=()=>m.close();
  const sizes=new ResizeObserver(requestSource);for(const el of [card,img,stage])sizes.observe(el);
  img.addEventListener('load',()=>{
    const state=PhotoNotes.hosts.get(card);if(state?.data)PhotoNotes.preview(card,state.data,Toolbelt.current(id));
    requestSource();
  },{signal});
  // A dialog's close event is queued: reopening it before that event arrives must keep the new viewer alive.
  m.addEventListener('close',()=>{if(!m.open)events.abort();},{signal});
  signal.addEventListener('abort',()=>{clearTimeout(sourceTimer);sizes.disconnect();if(pendingSource)pendingSource.src='';},{once:true});
  reset();
  m.showModal();
  if(notes){PhotoNotes.attach(card);PhotoNotes.open(card);}
}

async function openFrames(photo, done) {
  const view=S.view;
  let r; try { r = await api(`/api/group/${photo}`); } catch(e) {if(!left(view))toast(e.message);return;}
  if(left(view))return;
  const m = $("#modal");
  m.className = "wide";
  m.onclick = null;
  m.innerHTML = `<h2>Pick the take that stands in for this stack</h2>
    <div class="photo-fan" style="--takes:${r.members.length}">${r.members.map((id,i) => `<button class="tile pick frame-pick ${id === r.rep ? "rescued" : ""}" style="${fanStyle(i,r.members.length)}" data-swap="${id}" aria-label="${id===r.rep?'Kept take':'Keep take '+(i+1)}"><img src="${T(id)}" alt="Take ${i+1}"></button>`).join("")}</div>
    <div class="row spread" style="margin-top:14px"><span class="muted small">Its duel record carries over.</span><button class="btn" id="close-modal">Close</button></div>`;
  $("#close-modal").onclick = () => m.close();
  $$("[data-swap]", m).forEach((t) => (t.onclick = async () => {
    try {await api("/api/frame", { photo: Number(t.dataset.swap) });}catch(e){if(!left(view))toast(e.message);return;}
    m.close();
    toast("Take swapped.");
    if(!left(view))done?.();
  }));
  m.showModal();
}

// ---------------------------------------------------------------- stacks: the same shot, one stack
// The Stacks page: every stack, editable (open one to keep a different take, split a take out, or split it all), and
// the Twin check minigame for the pairs that look like the same shot but weren't stacked. Drag one stack onto another
// to merge them.
function viewStacks(main, params) {
  return params.get("check") ? twinCheck(main) : stacksPage(main);
}
const shotDate = shot => (shot.taken||'').slice(0,10)||'undated';
const dateWord = day => day==='undated'?'No date':new Date(`${day}T12:00:00`).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});

async function stacksPage(main) {
  const view = S.view;
  let shots = [], boxes = {}, twins = 0, undo = null, pairs = [], total = 0, nextPage = 1, pages = 0, paging = false;
  let order = (() => { try { return localStorage.getItem("matcher-stacks-order") === "time" ? "time" : "look"; } catch (_) { return "look"; } })();
  let firstPage=0,dates=[],dateRaf=0;
  let stacksOnly = (() => { try { return localStorage.getItem('matcher-stacks-only') === '1'; } catch (_) { return false; } })();
  const byRep = new Map();
  let cardObserver = null;
  const observed = new Set(), mounted = new Set();
  let loadEpoch = 0, shownPairs = '';
  const query = () => `/api/groups?view=${stacksOnly?'stacks':'all'}&order=${order}&per=120`;
  function mountCard(tile) {
    if(!tile?.classList.contains('sleeping'))return;
    const shot=byRep.get(Number(tile.dataset.dragShot));if(!shot)return;
    tile.innerHTML=shotTileContents(shot,null,boxes);tile.classList.remove('sleeping');mounted.add(tile);
  }
  function restCard(tile) {
    if(tile.near||tile.classList.contains('open')||tile.contains(document.activeElement)||tile.matches(':active')||tile.contains(Toolbelt.gesture?.print))return;
    tile.replaceChildren();tile.classList.add('sleeping');delete tile.dataset.belt;mounted.delete(tile);
  }
  // Keep each card's place in the grid; only nearby cards carry pictures, notes and drawing surfaces.
  function watchCards() {
    const body=$('.stacker .screen-body',main);if(!body)return;
    if(cardObserver?.root!==body){
      cardObserver?.disconnect();observed.clear();mounted.clear();
      cardObserver=new IntersectionObserver(entries=>{if(left(view))return;for(const {target,isIntersecting} of entries){
        if(!target.isConnected)continue;target.near=isIntersecting;if(isIntersecting)mountCard(target);else restCard(target);
      }dateNow();},{root:body,rootMargin:'300px 0px'});
      body.addEventListener('focusout',()=>queueMicrotask(()=>{for(const tile of mounted)restCard(tile);}));
    }
    for(const tile of observed)if(!tile.isConnected){cardObserver.unobserve(tile);observed.delete(tile);mounted.delete(tile);}
    for(const tile of $$('[data-drag-shot]',body))if(!observed.has(tile)){observed.add(tile);cardObserver.observe(tile);}
  }
  S.events.signal.addEventListener('abort',()=>cardObserver?.disconnect(),{once:true});
  function dateNow(){
    if(order!=='time'||dateRaf)return;
    dateRaf=requestAnimationFrame(()=>{
      dateRaf=0;if(left(view))return;
      const body=$('.stacker .screen-body',main),select=$('[data-date-jump]',main);if(!body||!select)return;
      const edge=body.getBoundingClientRect(),near=[...mounted].filter(t=>t.isConnected&&t.near).map(tile=>({tile,r:tile.getBoundingClientRect()}))
        .filter(x=>x.r.bottom>edge.top&&x.r.top<edge.bottom).sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left)[0];
      if(near&&document.activeElement!==select)select.value=shotDate(byRep.get(Number(near.tile.dataset.dragShot))||{});
      const i=dates.findIndex(d=>d.date===select.value);
      $('[data-date-step="-1"]',main)?.classList.toggle('invisible',i<=0);
      $('[data-date-step="1"]',main)?.classList.toggle('invisible',i<0||i>=dates.length-1);
    });
  }
  function dateMarkers(){
    const grid=$('.lookgrid',main);if(!grid)return;
    for(const h of $$(':scope > .date-divider',grid))h.remove();
    if(order!=='time')return;
    let last=null;
    for(const tile of $$(':scope > .tile[data-drag-shot]',grid)){
      const day=shotDate(byRep.get(Number(tile.dataset.dragShot))||{});if(day===last)continue;last=day;
      const h=document.createElement('h3');h.className='date-divider';h.dataset.date=day;h.textContent=dateWord(day);grid.insertBefore(h,tile);
    }
    dateTail();dateNow();
  }
  function dateTail(){
    const grid=$('.lookgrid',main),last=$$('.date-divider',grid||main).at(-1),tile=$$('[data-drag-shot]',grid||main).at(-1),body=$('.stacker .screen-body',main);
    if(grid&&body)grid.style.setProperty('--date-tail',`${order==='time'&&nextPage>=pages&&last&&tile?Math.max(0,body.clientHeight-(tile.getBoundingClientRect().bottom-last.getBoundingClientRect().top)):0}px`);
  }
  function dateJump(){
    if(order!=='time'||!dates.length)return '';
    let month=null;
    const options=dates.map(d=>{
      const key=d.date.slice(0,7),label=d.date==='undated'?'No date':new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined,{month:'long',year:'numeric'});
      const group=key!==month?`${month===null?'':'</optgroup>'}<optgroup label="${esc(label)}">`:'';month=key;
      return `${group}<option value="${d.date}">${esc(dateWord(d.date))} · ${plural(d.count,'shot')}</option>`;
    }).join('')+'</optgroup>';
    return `<div class="date-jump" role="group" aria-label="Browse dates"><button class="btn ghost" data-date-step="-1" aria-label="Previous date">‹</button><label><span>Jump to</span><select data-date-jump aria-label="Jump to date">${options}</select></label><button class="btn ghost" data-date-step="1" aria-label="Next date">›</button></div>`;
  }
  function sizeFamilies() {
    const grid = $(".stacker .lookgrid", main);if(!grid)return;
    const columns = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
    $$(":scope > .fam-tiles",grid).forEach(f=>{
      const n=Math.min(columns,f.children.length);
      f.style.gridColumn=`span ${n}`;f.style.gridTemplateColumns=`repeat(${n},minmax(0,1fr))`;
    });
    if(order==='time')dateTail();
  }
  window.addEventListener('resize',sizeFamilies,{signal:S.events.signal});
  async function load(keep, reorder = false, day = null) {
    if (left(view)) return;
    const request = ++loadEpoch;
    paging = false;
    const body = $(".screen-body", main), y = body?.scrollTop || 0, loadedPages = keep ? nextPage-firstPage : 1;
    if(!keep)firstPage=0;
    const expanded = keep && byRep.get(Number($(".tile.open", main)?.dataset.dragShot));
    const edge = body?.getBoundingClientRect(), visible = keep && edge ? $$(".tile[data-drag-shot]", body)
      .map(el=>({shot:byRep.get(Number(el.dataset.dragShot)),box:el.getBoundingClientRect()}))
      .filter(x=>x.shot&&x.box.bottom>edge.top&&x.box.top<edge.bottom)
      .sort((a,b)=>Number(b.shot===expanded)-Number(a.shot===expanded)||Math.abs(a.box.top-edge.top)-Math.abs(b.box.top-edge.top))[0] : null;
    const anchor = visible && {members:visible.shot.members,offset:visible.box.top-edge.top};
    let jump=null;
    try {
      const url = query();
      const [sug, first] = await Promise.all([api("/api/groups?view=suggest"), api(`${url}&page=${firstPage}${reorder?'&reorder=1':''}${order==='time'?'&dates=1':''}${day?`&date=${encodeURIComponent(day)}`:''}${keep&&order==='time'&&anchor?`&at=${anchor.members[0]}`:''}`)]);
      if (left(view) || request !== loadEpoch) return;
      firstPage=first.page;
      if(first.dates)dates=first.dates;
      jump=first.jump;
      const batches = [first, ...await Promise.all(Array.from({length:Math.max(0,Math.min(loadedPages,first.pages-firstPage)-1)},(_,i)=>api(`${url}&page=${firstPage+i+1}`)))];
      // Splitting at a page boundary can move the reached-for stack onto the next page.
      while(anchor && firstPage+batches.length<first.pages && !batches.some(b=>b.shots.some(x=>x.members.some(m=>anchor.members.includes(m))))) {
        batches.push(await api(`${url}&page=${firstPage+batches.length}`));
        if(left(view)||request!==loadEpoch)return;
      }
      if (left(view) || request !== loadEpoch) return;
      twins = sug.suggestions.length;
      pairs = sug.suggestions;
      shots = batches.flatMap(b=>b.shots); boxes = Object.assign({},...batches.map(b=>b.boxes)); undo = first.undo; total = first.total;
      nextPage = firstPage+batches.length; pages = first.pages;
    } catch (e) { if (!left(view) && request === loadEpoch) main.innerHTML = FAILED(e.message); return; }
    if (left(view)) return;
    byRep.clear();
    shots.forEach((x) => byRep.set(x.rep, x));
    render(keep);
    if (expanded) {
      const members = new Set(expanded.members), match = shots.map(x=>({shot:x,n:x.members.filter(m=>members.has(m)).length})).sort((a,b)=>b.n-a.n)[0];
      if(match?.n && match.shot.members.length>1){mountCard($(`[data-drag-shot="${match.shot.rep}"]`,main));const button=$(`[data-expand="${match.shot.rep}"]`,main);if(button&&!button.closest('.tile.open'))expandStack(main,match.shot,button,boxes,false);}
    }
    if (keep) {
      // Reattach the shared tag shelf before restoring scroll; its height changes the bottom scroll limit.
      World.sea?.layout();
      const body = $(".screen-body", main), match = anchor && shots.find(x=>x.members.some(m=>anchor.members.includes(m)));
      const tile = match && $(`[data-drag-shot="${match.rep}"]`,main);
      body.scrollTop = tile ? tile.getBoundingClientRect().top-body.getBoundingClientRect().top+body.scrollTop-anchor.offset : y;
    }
    if(jump)requestAnimationFrame(()=>{
      if(left(view)||request!==loadEpoch)return;
      const tile=$(`[data-drag-shot="${jump.photo}"]`,main),body=$('.screen-body',main);if(!tile||!body)return;
      const header=tile.previousElementSibling?.matches('.date-divider')?tile.previousElementSibling:tile;
      body.scrollTop+=header.getBoundingClientRect().top-body.getBoundingClientRect().top;
      const select=$('[data-date-jump]',main);if(select)select.value=jump.date;dateNow();
    });
    dateNow();
  }
  async function moreStacks() {
    if (paging || nextPage >= pages || left(view)) return;
    paging = true;
    const request = loadEpoch;
    try {
      const r = await api(`${query()}&page=${nextPage}`);
      if (left(view) || request !== loadEpoch) return;
      nextPage++;
      shots.push(...r.shots); Object.assign(boxes, r.boxes);
      for (const x of r.shots) byRep.set(x.rep, x);
      const grid = $(".lookgrid", main); if (grid) { patchShotTiles(grid,shots,null,boxes,true);dateMarkers();sizeFamilies();watchCards(); }
    } catch (e) { if (!left(view) && request === loadEpoch) toast(e.message); }
    finally { if (request === loadEpoch) paging = false; }
  }
  async function earlierStacks(){
    if(paging||firstPage<=0||left(view))return;
    paging=true;const request=loadEpoch,body=$('.screen-body',main),edge=body.getBoundingClientRect();
    const anchor=$$('[data-drag-shot]',body).find(tile=>tile.getBoundingClientRect().bottom>edge.top),offset=anchor?.getBoundingClientRect().top-edge.top;
    try{
      const r=await api(`${query()}&page=${firstPage-1}`);if(left(view)||request!==loadEpoch)return;
      firstPage--;shots.unshift(...r.shots);Object.assign(boxes,r.boxes);for(const shot of r.shots)byRep.set(shot.rep,shot);
      patchShotTiles($('.lookgrid',main),shots,null,boxes,true);dateMarkers();sizeFamilies();watchCards();
      if(anchor?.isConnected)body.scrollTop+=anchor.getBoundingClientRect().top-body.getBoundingClientRect().top-offset;
    }catch(e){if(!left(view))toast(e.message);}finally{if(request===loadEpoch)paging=false;}
  }
  function render(keep = false) {
    const current=keep&&$('.stacker',main);
    if(current&&shots.length&&$('.lookgrid',current)){
      patchShotTiles($('.lookgrid',current),shots,null,boxes,true);
      dateMarkers();
      if(order==='time'){
        const old=$('.date-jump',current),markup=dateJump();if(old)old.outerHTML=markup;
        bindDates();
      }
      $('[data-stack-total]',current).textContent=fmt(total||shots.length);
      $('[data-stack-word]',current).textContent=stacksOnly?((total||shots.length)===1?'stack':'stacks'):((total||shots.length)===1?'shot':'shots');
      $('[data-stack-twins]',current).innerHTML=twins?`🧐 <b>${fmt(twins)}</b> possible ${twins===1?'twin':'twins'} to check`:'✅ all checked';
      const button=$('#g-undo',current);button.hidden=!undo;
      $('.desktop-label',button).textContent=undo?`Undo ${DRAW_WORD[undo]||undo}`:'Undo';
      const pairKey=JSON.stringify(pairs);
      if(pairKey!==shownPairs){
        const oldRail=$('.screen-rail',current),rail=twinsRail();
        if(rail){if(oldRail)oldRail.outerHTML=rail;else $('.screen-bar',current).insertAdjacentHTML('beforebegin',rail);}else oldRail?.remove();
        shownPairs=pairKey;
      }
      current.classList.toggle('no-rail',!pairs.length);
      $('.bar-right',current).innerHTML=twinsAction();
      setForward(twins?null:{label:'Next: Crown →',name:'Crown',href:'#duel?stage=stacks'});
      sizeFamilies();watchCards();
      return;
    }
    main.innerHTML = `
      <div class="screen sorter stacker ${order==='time'?'by-date':''} ${pairs.length ? '' : 'no-rail'}">
        <div class="screen-head">
          <h1>🧩 Stacks</h1>
          <span class="stat-chip"><b data-stack-total>${fmt(total || shots.length)}</b> <span data-stack-word>${stacksOnly?((total||shots.length)===1?'stack':'stacks'):((total||shots.length)===1?'shot':'shots')}</span></span>
          <span class="stat-chip" data-stack-twins>${twins ? `🧐 <b>${fmt(twins)}</b> possible ${twins === 1 ? "twin" : "twins"} to check` : "✅ all checked"}</span>
          <span class="grow"></span>
          <button class="chip ${stacksOnly?'on':''}" data-stacks-only aria-pressed="${stacksOnly}">Stacks only</button>
          <span class="seg" role="group" aria-label="Stack order">
            <button class="seg-btn ${order === "look" ? "on" : ""}" data-stack-order="look" title="Put similar stacks next to each other">Similar</button>
            <button class="seg-btn ${order === "time" ? "on" : ""}" data-stack-order="time" title="Sort stacks by capture time">By date</button>
          </span>
          ${dateJump()}
          ${helpBtn(`The same picture (a crop, a copy) or a burst of nearly the same shot belongs in <b>one stack</b>, so it competes
            as one shot showing its best take. The obvious ones are stacked already.<br><br><b>Twin check</b> shows the pairs that look
            like the same shot but weren't stacked. Here, the <b>paperclip</b> opens a stack (keep a different take, split one out, split it
            all), and dragging one photo or stack onto another combines them. Loose photos are stacks of one;
            <b>Stacks only</b> hides them. <b>Z</b> undoes.`)}
        </div>
        <div class="screen-body">
          ${shots.length ? `<div class="lookgrid gsec-tiles">${shotTiles(shots, null, boxes,true)}</div>` : `<div class="empty">${stacksOnly?'No stacks yet. Turn off Stacks only to combine loose photos.':'No shots to stack yet.'}</div>`}
        </div>
        ${twinsRail()}
        <div class="screen-bar action-bar">
          <div class="bar-left"><a class="btn ghost" href="#filter">← Filter</a></div>
          <div class="bar-mid"><button class="btn ghost" id="g-undo" ${undo ? "" : "hidden"} title="Take back your last change (Z)"><kbd>Z</kbd> <span class="desktop-label">${undo ? `Undo ${DRAW_WORD[undo] || undo}` : "Undo"}</span><span class="phone-label">Undo</span></button></div>
          <div class="bar-right">${twinsAction()}</div>
        </div>
      </div>`;
    setForward(twins ? null : { label: "Next: Crown →", name: "Crown", href: "#duel?stage=stacks" });
    shownPairs=JSON.stringify(pairs);
    $("#g-undo").onclick = () => drawUndo(() => load(true));
    $('[data-stacks-only]',main).onclick=async()=>{
      stacksOnly=!stacksOnly;
      try{localStorage.setItem('matcher-stacks-only',stacksOnly?'1':'0');}catch(_){ /* private mode */ }
      main.innerHTML=LOADING();await load(false);$('[data-stacks-only]',main)?.focus();
    };
    $$("[data-stack-order]", main).forEach((b) => (b.onclick = async () => {
      if (b.dataset.stackOrder === order) return;
      order = b.dataset.stackOrder;
      try { localStorage.setItem("matcher-stacks-order", order); } catch (_) { /* private mode */ }
      main.innerHTML = LOADING();
      await load(false,true);
    }));
    const body = $(".screen-body", main);
    rememberShotTiles($('.lookgrid',main),shots,boxes);
    sizeFamilies();
    dateMarkers();bindDates();
    watchCards();
    body.onscroll = () => { dateNow();if(body.scrollTop<250&&firstPage>0)earlierStacks();else if (body.scrollHeight-body.scrollTop-body.clientHeight < 500) moreStacks(); };
    const page = $(".stacker", main);
    page.onclick = (e) => {
      const t = e.target.closest("[data-expand],[data-keep],[data-split],[data-unstack],[data-reset],[data-view]");
      if (!t) return;
      e.stopPropagation();
      if (t.dataset.expand) return expandStack(main, byRep.get(Number(t.dataset.expand)), t, boxes);
      if (t.dataset.keep) return act("/api/frame", { photo: Number(t.dataset.keep) }, "That take now stands in for the stack.");
      if (t.dataset.split) return act("/api/groups/split", { photo: Number(t.dataset.split) }, "Split out; it's its own shot now.");
      if (t.dataset.unstack) return act("/api/groups/unstack", { photo: Number(t.dataset.unstack) }, "Split apart into separate shots.");
      if (t.dataset.reset) return act("/api/groups/reset", { photos: [Number(t.dataset.reset)] }, "Back to automatic stacking.");
      if (t.dataset.asideStack) return setAsideStack(Number(t.dataset.asideStack));
      if (t.dataset.view) return openViewer(Number(t.dataset.view));
    };
    // X, or the bar's button, sets a whole stack aside with every take (the Set aside page can bring it back).
    const setAsideStack = (rep) => { const x = byRep.get(rep); if (!x) return; act("/api/filter/decision", { photos: x.members, action: "aside" }, x.members.length===1?'Set aside.':`Set aside with all ${x.members.length} takes.`); };
    S.onKey = (e) => {
      if (e.repeat) return;
      if (["z", "Z", "Backspace"].includes(e.key)) { e.preventDefault(); drawUndo(() => load(true)); return; }
      if (e.key !== "x" && e.key !== "X") return;
      const t = $(".tile.open", page) || document.activeElement?.closest?.(".tile") || $(".tile.picked", page);
      if (!t?.dataset.sel) return;
      e.preventDefault(); setAsideStack(Number(t.dataset.sel));
    };
    let drag = null;
    page.ondragstart = (e) => {
      const el = e.target.closest("[data-drag-frame],[data-drag-shot]");
      if (!el) return;
      drag = el.dataset.dragFrame ? { kind: "frame", id: Number(el.dataset.dragFrame) } : { kind: "shot", id: Number(el.dataset.dragShot) };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(drag.id));
    };
    page.ondragover = (e) => {
      // Dragging above or below the list scrolls it, from anywhere outside, not only a thin band at its edge.
      const body = $(".screen-body", page);
      if (drag && body) { const r = body.getBoundingClientRect(), edge = 48, up = r.top + edge - e.clientY, down = e.clientY - (r.bottom - edge); if (up > 0) body.scrollTop -= Math.min(36, up * .4); else if (down > 0) body.scrollTop += Math.min(36, down * .4); }
      const z = e.target.closest("[data-drop]");
      if (!z || !drag || (drag.kind === "shot" && Number(z.dataset.drop) === drag.id)) return;
      e.preventDefault();
      $$(".drop-hot", page).forEach((x) => x !== z && x.classList.remove("drop-hot"));
      z.classList.add("drop-hot");
    };
    page.ondrop = (e) => {
      const z = e.target.closest("[data-drop]"), d = drag;
      drag = null;
      if (!z || !d) return;
      e.preventDefault();
      if (d.kind === "frame") return act("/api/groups/move", { photo: d.id, target: Number(z.dataset.drop) }, "Moved into that stack.");
      act("/api/groups/merge", { photos: [d.id, Number(z.dataset.drop)] }, "Merged into one stack.");
    };
    page.ondragend=()=>{drag=null;$$('.drop-hot',page).forEach(tile=>tile.classList.remove('drop-hot'));for(const tile of mounted)restCard(tile);};
  }
  function bindDates(){
    const select=$('[data-date-jump]',main);if(!select)return;
    const jump=day=>{main.innerHTML=LOADING();load(false,false,day);};
    select.onchange=()=>jump(select.value);
    for(const button of $$('[data-date-step]',main))button.onclick=()=>{const i=dates.findIndex(d=>d.date===select.value)+Number(button.dataset.dateStep);if(dates[i])jump(dates[i].date);};
  }
  function twinsRail(){return pairs.length?`<aside class="screen-rail"><div class="rail-card grow"><h3>🧐 Possible twins</h3>
    <div class="twin-list">${pairs.map(x=>`<a class="twin-row" href="#stacks?check=1" title="${Math.round(x.similarity*100)}% alike">
    <img src="${T(x.a)}" alt=""><span>≈</span><img src="${T(x.b)}" alt=""><span class="muted small">${Math.round(x.similarity*100)}%</span></a>`).join('')}</div></div></aside>`:'';}
  function twinsAction(){return twins?`<a class="btn primary big" href="#stacks?check=1">🎮 Twin check <span class="btn-sub">${fmt(twins)} to check</span> <kbd>Enter</kbd></a>`:'';}
  async function act(path, payload, msg) {
    try { await api(path, payload); toastOnce(msg, `${msg} Z undoes it.`); Sound.play("pick"); } catch (e) { toast(e.message); return; }
    await load(true);
    refreshHud(true);
  }
  S.onKey = (e) => { if (["z", "Z", "Backspace"].includes(e.key) && !e.repeat) { e.preventDefault(); drawUndo(() => load(true)); } };
  main.innerHTML = LOADING();
  await load();
}

// Twin check (the Stacks minigame): two shots that look like the same shot but weren't stacked. → same shot (stack
// them), ← different. Same layout as every game screen.
async function twinCheck(main) {
  const view = S.view;
  let queue = [], done = 0, busy = false, shownAt = 0, total = 0;
  async function load(reset=false) {
    try {
      const page=await api("/api/groups?view=suggest"),fresh=page.suggestions;total=page.counts?.suggest??fresh.length;
      const key=x=>[x.a,x.b].sort((a,b)=>a-b).join(":"), by=new Map(fresh.map(x=>[key(x),x]));
      queue=reset?fresh:[...queue.filter(x=>by.has(key(x))).map(x=>{const next=by.get(key(x));by.delete(key(x));return next;}),...by.values()];
    } catch (e) {
      if (!left(view)) main.innerHTML = FAILED(e.message);
      return;
    }
    if (left(view)) return;
    paint();
  }
  function paint() {
    const gone = World.grab(main);
    paintPair();
    World.swap(main, gone);
  }
  function paintPair() {
    const x = queue[0];
    World.calm(false); setForward(null);
    if (!x) {
      main.innerHTML = `
        <div class="screen no-rail twins">
          <div class="screen-head"><h1>Twin check</h1><span class="stat-chip good"><b>0</b> pairs left</span>
            ${done ? `<span class="stat-chip"><b>${fmt(done)}</b> checked</span>` : ""}</div>
          <div class="screen-body fill">${stageClearHtml({ icon: "🧩", title: "All checked!", clear: done > 0,
            text: "Every likely twin is stacked or set apart. Next, each stack's takes duel for the one that plays on.", summary: done ? `${plural(done, "pair")} settled by you.` : "" })}</div>
          <div class="screen-bar action-bar">${clearActionsHtml({ back: ["#stacks", "The Stacks page"], undo: done ? "Undo the last call" : null, undoAttr: 'data-c="undo"' })}</div>
        </div>`;
      $$("[data-c]", main).forEach((b) => (b.onclick = () => undo()));
      setForward({ label: "Next: Crown →", name: "Crown", href: "#duel?stage=stacks" });
      if (done) { Sound.play("crown"); confetti(window.innerWidth / 2, window.innerHeight / 3, 50); World.calm(true); }
      setHint(`Enter continues to Crown.${done ? " Z undoes the last call." : ""}`);
      refreshHud(true);
      return;
    }
    const apart = x.seconds_apart == null ? "no dates" : x.seconds_apart < 90 ? `${x.seconds_apart} s apart`
      : x.seconds_apart < 7200 ? `${Math.round(x.seconds_apart / 60)} min apart` : `${Math.round(x.seconds_apart / 3600)} h apart`;
    main.innerHTML = `
      <div class="screen no-rail twins">
        <div class="screen-head">
          <h1>Twin check</h1>
          <span class="stat-chip"><b>${fmt(Math.max(total, queue.length))}</b> ${Math.max(total, queue.length) === 1 ? "pair" : "pairs"} left</span>
          <span class="stat-chip twin-evidence">${Math.round(x.similarity * 100)}% alike · ${apart}</span>
          <span class="grow"></span>
          <a class="btn" href="#stacks" title="Back to the Stacks page">Done</a>
          ${helpBtn(`Two shots that look like <b>the same shot</b> (a crop, a copy, or a burst) but weren't stacked. <b>→</b> stacks them: they
            compete as one shot showing its best take. <b>←</b> keeps them apart for good. Nothing is deleted. <b>Z</b> undoes, <b>Esc</b> opens the pause menu.`)}
        </div>
        <div class="screen-body fill twin-stage"><div class="twin-arena">
          <div class="side" data-photo="${x.a}" tabindex="0" title="Point here and press X to toss"><div class="print"><img src="${P(x.a)}" alt="First shot" draggable="false"></div></div>
          <div class="side" data-photo="${x.b}" tabindex="0" title="Point here and press X to toss"><div class="print"><img src="${P(x.b)}" alt="Second shot" draggable="false"></div></div>
        </div></div>
        <div class="screen-bar action-bar"><div class="bar-left"><button class="btn big toss-btn" data-c="no"><kbd>←</kbd> Different shots</button></div>
          <div class="bar-mid"><button class="btn ghost" data-c="skip"><kbd>Space</kbd> Skip</button><button class="btn ghost" data-c="undo"><kbd>Z</kbd> Undo</button></div>
          <div class="bar-right"><button class="btn big keep-btn" data-c="yes">Same shot <kbd>→</kbd></button></div></div>
      </div>`;
    $$("[data-c]", main).forEach((b) => (b.onclick = () => (b.dataset.c === "undo" ? undo() : b.dataset.c === "skip" ? skip() : call(b.dataset.c === "yes"))));
    paintFilters();
    shownAt = playTime();
  }
  async function call(same) {
    const x = queue[0];
    if (busy || !x) return;
    busy = true;
    Sound.play(same ? "great" : "toss");
    const arena = $(".twin-arena");
    if (arena) arena.classList.add(same ? "merge" : "apart");
    try {
      const reply = same ? await api("/api/groups/merge", { photos: [x.a, x.b] }) : await api("/api/groups/dismiss", { a: x.a, b: x.b });
      if(left(view))return;
      if(reply.game){updateHudQuiet(reply.game);paintSaveChip();}
      floatText(same ? "+5 XP" : "+2 XP", arena);
    } catch (e) { toast(e.message); busy = false; return load(); }
    await sleep(reduceMotion ? 0 : 220);
    if (left(view)) return;
    done++;
    busy = false;
    if (same) return load();  // stacking changes which pairs are left
    queue.shift();
    paint();
  }
  function skip() {
    if (busy || !queue.length) return;
    if (queue.length<2) { location.hash="stacks"; return; }
    queue.push(queue.shift()); Sound.play("skip"); paint();
  }
  async function toss() {
    const target=gamePhotoTarget($(".twin-arena")); if(busy||!target)return; busy=true;
    try { await api("/api/draw/toss",{photo:Number(target.dataset.photo)}); if(!left(view)){Sound.play("toss");await load();} }
    catch(error){if(!left(view))toast(error.message);}finally{busy=false;}
  }
  function undo() { if (!busy) drawUndo(()=>load(true)); }
  S.onKey = (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); location.hash = "#stacks"; }
    else if (!queue[0] && k === "Enter") { e.preventDefault(); location.hash = "#duel?stage=stacks"; }
    else if (k === "ArrowRight" || k === "Enter" || k === "d" || k === "D") { e.preventDefault(); call(true); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); call(false); }
    else if (k === " ") { e.preventDefault(); skip(); }
    else if (k.toLowerCase() === "x") { e.preventDefault(); toss(); }
    else if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); undo(); }
    else if (k === "f" || k === "F") { e.preventDefault(); toggleFilter(); }
  };
  main.innerHTML = LOADING();
  await load();
}

// ---------------------------------------------------------------- the Draw: themed groups
// Every shot goes into a themed group: pick a starter (it comes with a name), then call the likely matches it deals
// (in, out, or "same shot": stacked). Groups play the group stage; their winners the knockouts. Z undoes anything.
const DRAW_WORD = { edit: "touch-up", "new group": "new group", add: "add", "not this one": "skip", twin: "twin stack", "bulk add": "batch",
  rename: "rename", emoji: "emoji change", toss: "toss", tags: "tag change", reorder: "reorder", "auto-draw": "auto-group", place: "placement", "to the wildcards": "wildcard",
  move: "move", unsort: "move", "merge groups": "group merge", dissolve: "dissolve", merge: "stack merge", split: "split",
  unstack: "split-apart", reset: "reset", keep: "take pick", "not twins": "not-twins call", "best guesses": "best guesses" };

const EMOJIS = ["🏖️", "🌅", "🏔️", "🌲", "💧", "❄️", "🌸", "☁️", "🏜️", "🦋", "🌧️", "🌈", "🌊", "🍂", "🌙", "⭐",
  "🏙️", "🌃", "🏛️", "🚶", "⚓", "✈️", "🛣️", "🏎️", "🛋️", "🐶", "🐱", "🐦", "🦒", "🍝", "🍰", "☕", "🍹", "🍳", "🎂",
  "🎉", "🎸", "🪩", "👯", "👨‍👩‍👧", "🤵", "🕶️", "😎", "🧢", "🤓", "🤳", "🪞", "🚙", "🛏️", "💪", "⚽", "🏕️", "🏊", "🌞",
  "😄", "🖤", "📸", "🎨", "📝", "💻", "💼", "🎞️", "🎄", "🎓", "🏆", "❤️", "🔥", "✨", "🃏", "🗂️"];

// The emoji index (scripts/make_emoji.py): [emoji, words, 1 if it has everyday words], fetched the first time it's needed.
let emojiIndex = null;
function loadEmoji() {
  if (!emojiIndex) emojiIndex = fetch("/static/emoji.json").then((r) => r.json()).catch(() => { emojiIndex = null; return []; });
  return emojiIndex;
}
// Best matches first: every word you type must start a word of its name; whole-word matches and everyday emoji win.
function searchEmoji(list, q) {
  const qs = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  list.forEach(([e, words, common], k) => {
    const ws = words.split(" ");
    let score = 0;
    for (const x of qs) {
      if (ws.includes(x)) score += 2;
      else if (ws.some((w) => w.startsWith(x))) score += 1;
      else return;
    }
    hits.push([score + common, k, e]);
  });
  return hits.sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 96).map((h) => h[2]);
}

// A searchable emoji picker under `anchor`: favourites until you type, then matches (Enter takes the first; a pasted
// emoji works too). Calls pick(emoji). Esc or a click elsewhere closes it.
function emojiPicker(anchor, pick) {
  $(".emoji-pop")?.remove();
  const pop = document.createElement("div");
  pop.className = "emoji-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Pick an emoji");
  pop.innerHTML = `<input class="emoji-search" id="emoji-q" maxlength="40" placeholder="Search emoji: laptop, dog, party… or paste one"
      aria-label="Search emoji" autocomplete="off" spellcheck="false">
    <div class="emoji-grid" id="emoji-grid"></div><div class="muted small emoji-empty" id="emoji-empty" hidden>No match. Try another word.</div>`;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${Math.max(62,Math.min(r.bottom+8,innerHeight-pop.offsetHeight-12))+window.scrollY}px`;
  const close = () => { pop.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); };
  const away = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); anchor.focus(); } };
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", esc, true);
  const done = (e) => { const v = (e || "").trim(); if (v) { close(); pick(v); } };
  const grid = $("#emoji-grid", pop), q = $("#emoji-q", pop);
  let shown = EMOJIS;
  const paint = (list) => {
    shown = list;
    grid.innerHTML = list.map((e) => `<button data-emoji="${e}" aria-label="${e}">${e}</button>`).join("");
    $("#emoji-empty", pop).hidden = list.length > 0;
    $$("[data-emoji]", grid).forEach((b) => (b.onclick = () => done(b.dataset.emoji)));
  };
  paint(EMOJIS);
  const isEmoji = (t) => /\p{Extended_Pictographic}/u.test(t) && !/[a-z0-9]/i.test(t);
  q.oninput = async () => {
    const t = q.value.trim();
    if (!t) return paint(EMOJIS);
    if (isEmoji(t)) return paint([t]);
    const list = await loadEmoji();
    if (q.value.trim() === t) paint(searchEmoji(list, t));
  };
  q.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); done(isEmoji(q.value.trim()) ? q.value : shown[0]); }
    else if (e.key === "ArrowDown") { e.preventDefault(); $("[data-emoji]", grid)?.focus(); }
    else if (e.key === "Escape") { close(); anchor.focus(); }
  };
  loadEmoji();
  q.focus();
}

// "?" in a screen's top strip: the explanation a page would spell out in a paragraph, there when you want it.
const helpBtn = (html) => `<button class="help-btn" data-help="${esc(html + "<br><br><b>WASD</b> = arrow keys · <b>Space</b> skips · <b>Z</b> undoes · <b>X</b> tosses the focused photo · <b>C</b> auto-crops · <b>F</b> enhances.")}" aria-label="How this works" aria-expanded="false">?</button>`;
function closeHelp(focus=false) {
  const source=$("[data-help][aria-expanded=true],#game-help[aria-expanded=true]");
  $$(".help-pop").forEach(pop=>pop.remove());
  $$("[data-help][aria-expanded=true],#game-help[aria-expanded=true]").forEach(b=>b.setAttribute("aria-expanded","false"));
  if(focus)source?.focus();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-help]");
  const open = $(".help-pop");
  const same=open&&b&&open.dataset.for===b.dataset.help;
  if(open)closeHelp();
  if(same)return;
  if (!b) return;
  showHelp(b.dataset.help,b);
});
function showHelp(html,anchor) {
  if(!html||!anchor)return;closeHelp();
  const pop=document.createElement('div');pop.className='help-pop';pop.dataset.for=html;pop.innerHTML=html;document.body.append(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.left=`${Math.max(8,Math.min(r.right-pop.offsetWidth,innerWidth-pop.offsetWidth-8))}px`;
  pop.style.top=`${Math.max(8,Math.min(r.bottom+8,innerHeight-pop.offsetHeight-12))+window.scrollY}px`;
  anchor.setAttribute('aria-expanded','true');
}

// Swap a button for a text box in place; save(text) on Enter or blur (null if unchanged), Esc keeps the old one.
function inlineRename(btn, current, save, opt = {}) {
  const inp = document.createElement("input");
  inp.className = opt.cls || "t-input";
  inp.maxLength = opt.max || 60;
  inp.value = current;
  if (opt.placeholder) inp.placeholder = opt.placeholder;
  inp.setAttribute("aria-label", opt.label || "Group name");
  btn.replaceWith(inp);
  inp.focus();
  inp.select();
  let over = false;
  const done = (keep) => {
    if (over) return;
    over = true;
    const name = inp.value.trim();
    save(keep && name !== current && (name || opt.empty) ? name : null);
  };
  inp.onkeydown = (e) => { if (e.key === "Enter") done(true); else if (e.key === "Escape") done(false); e.stopPropagation(); };
  inp.onblur = () => done(true);
}

let drawUndoing = false;
async function drawUndo(after) {
  if (drawUndoing) return;
  drawUndoing = true;
  const view = S.view;
  try {
    const r = await api("/api/draw/undo", {});
    if (left(view)) return;
    Sound.play("undo");

    if (after) await after(r);
  } catch (e) { if (!left(view)) toast(e.message); }
  finally { drawUndoing = false; }
}

// A card you can fling or carry: let go over a group bin and it drops there; otherwise a fling past a third of its
// width counts (right / left), or up when `up` is given.
function carryable(el, { right, left, up, drop }) {
  let x0 = null, y0 = 0, dx = 0, dy = 0, hot = null;
  const binAt = (x, y) => {
    el.style.pointerEvents = "none";
    const t = document.elementFromPoint(x, y);
    el.style.pointerEvents = "";
    return t && t.closest("[data-bin]");
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
    el.setPointerCapture(e.pointerId);
    el.classList.add("held");
  });
  el.addEventListener("pointermove", (e) => {
    if (x0 == null) return;
    dx = e.clientX - x0;
    dy = e.clientY - y0;
    el.style.transform = `translate(${dx}px, ${drop || up ? dy : 0}px) rotate(${dx / 22}deg)`;
    el.style.setProperty("--keep", Math.max(0, Math.min(1, dx / 120)));
    el.style.setProperty("--toss", Math.max(0, Math.min(1, -dx / 120)));
    const b = drop ? binAt(e.clientX, e.clientY) : null;
    if (b !== hot) { hot?.classList.remove("hot"); hot = b; hot?.classList.add("hot"); el.classList.toggle("over-bin", !!b); }
  });
  const end = (e) => {
    if (x0 == null) return;
    x0 = null;
    el.classList.remove("held", "over-bin");
    if (e.type === "pointercancel") {
      hot?.classList.remove("hot"); hot = null;
      el.style.transform = ""; el.style.setProperty("--keep", 0); el.style.setProperty("--toss", 0);
      return;
    }
    if (hot) { const id = hot.dataset.bin; hot.classList.remove("hot"); hot = null; drop(id); return; }
    if (up && -dy > Math.min(140, el.clientHeight / 4) && Math.abs(dy) > Math.abs(dx)) up();
    else if (right && dx > Math.min(140, el.clientWidth / 3)) right();
    else if (left && -dx > Math.min(140, el.clientWidth / 3)) left();
    else { el.style.transform = ""; el.style.setProperty("--keep", 0); el.style.setProperty("--toss", 0); }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// Every group as a numbered bin (stable order: the order they were made), plus "new group". `fits` stars the groups
// this shot is most like. Keys: the number (two digits for 10+), N for new.
function binsHtml(bins, current, fits, focusable = false) {
  return bins.map((g, i) => `
    <div class="bin ${g.id === current ? "current" : ""} ${fits && fits[0] === g.id ? "fit" : ""}" data-bin="${g.id}" role="group" tabindex="-1"
      title="${esc(g.name)}: ${plural(g.size, "shot")}. ${groupKeyLabel(i) ? `Key ${groupKeyLabel(i)}` : "Drag here"}${g.id === current ? " (or →)" : ""}">
      <button class="bin-place" aria-label="${esc(g.name)}"><span class="bin-n">${groupKeyLabel(i)}</span><img src="${T(g.cover)}" alt="" loading="lazy">
        <span class="bin-name"><span class="bin-label">${g.id === current ? "This group" : esc(g.name)}</span>
        ${g.adv ? `<small>· ${g.adv} through</small>` : ""}</span><span class="bin-size">${fmt(g.size)}</span></button>
      <button class="bin-emoji" data-emoji-bin="${g.id}" title="Change the emoji" aria-label="Change emoji for ${esc(g.name)}">${esc(g.emoji || "🗂️")}</button>
      <button class="bin-edit" data-rename-bin="${g.id}" title="Rename" aria-label="Rename ${esc(g.name)}">✏️</button>
      ${focusable && g.size ? `<button class="btn ghost bin-focus" data-focus-bin="${g.id}" aria-label="Focus ${esc(g.name)}" aria-pressed="false">Focus</button>` : ""}
      ${fits && fits[0] === g.id ? `<span class="bin-star" title="Looks most like this group">★</span>` : ""}
    </div>`).join("") + `
    <div class="bin new" data-bin="new" role="button" tabindex="0" title="Start a new group from this shot (N)"><span class="bin-n">N</span>
      <span class="bin-plus" aria-hidden="true">＋</span><span class="bin-name">New group</span></div>`;
}

// Your order of groups (it sets their keys): move one by `delta` places, or drop one before another. Returns the new
// order of ids after saving it.
async function saveOrder(ids) {
  try { await api("/api/draw/order", { order: ids }); } catch (e) { toast(e.message); return null; }
  return ids;
}
function moveInOrder(ids, id, delta) {
  const k = ids.indexOf(id), to = Math.max(0, Math.min(ids.length - 1, k + delta));
  if (k < 0 || to === k) return null;
  const out = ids.slice();
  out.splice(k, 1);
  out.splice(to, 0, id);
  return out;
}
// Bins can be dragged up and down their list to reorder the groups; done(newIds) once it's saved.
function sortableBins(box, ids, done) {
  let dragId = null;
  $$("[data-bin]:not(.new)", box).forEach((el) => {
    el.draggable = true;
    el.ondragstart = (e) => {
      if (e.target.closest(".bin-input")) { e.preventDefault(); return; }
      dragId = Number(el.dataset.bin);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `group:${dragId}`);
      el.classList.add("reordering");
    };
    el.ondragend = () => { el.classList.remove("reordering"); $$(".drop-above, .drop-below", box).forEach((x) => x.classList.remove("drop-above", "drop-below")); };
    el.ondragover = (e) => {
      if (dragId == null || Number(el.dataset.bin) === dragId) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(), below = e.clientY > r.top + r.height / 2;
      $$(".drop-above, .drop-below", box).forEach((x) => x !== el && x.classList.remove("drop-above", "drop-below"));
      el.classList.toggle("drop-above", !below);
      el.classList.toggle("drop-below", below);
    };
    el.ondrop = async (e) => {
      if (dragId == null) return;
      e.preventDefault();
      const target = Number(el.dataset.bin), below = el.classList.contains("drop-below");
      el.classList.remove("drop-above", "drop-below");
      const out = ids.filter((x) => x !== dragId);
      out.splice(out.indexOf(target) + (below ? 1 : 0), 0, dragId);
      dragId = null;
      if (await saveOrder(out)) { toast("Reordered. Z undoes it."); done(out); }
    };
  });
}

// A click in a side list of bins: ✏️ renames that group, its emoji opens the picker, anywhere else drops the photo there.
// Returns true when it handled the click itself (rename / emoji).
function binTools(e, binEl, group, redraw) {
  if (e.target.closest(".bin-input")) return true;
  if (e.target.closest("[data-rename-bin]")) { e.stopPropagation(); renameBin(binEl, group, redraw); return true; }
  const em = e.target.closest("[data-emoji-bin]");
  if (em) {
    e.stopPropagation();
    emojiPicker(em, async (emoji) => {
      try { await api("/api/draw/rename", { theme: group.id, emoji }); group.emoji = emoji; toast("New emoji. Z undoes it."); } catch (err) { toast(err.message); }
      redraw();
    });
    return true;
  }
  return false;
}
// Arrow navigation can focus the group itself; its separate buttons also work with the keyboard.
document.addEventListener("keydown", (e) => {
  const b = e.target.closest && e.target.closest(".bin");
  if (b && e.target === b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); b.click(); }
}, true);

// The editor sits over the bin, outside its buttons, so typing never places a photo.
function renameBin(binEl, group, done) {
  if (!group || $(".bin-editor")) return;
  const view = S.view, rect = binEl.getBoundingClientRect(), editor = document.createElement("div");
  editor.className = "bin-editor";
  editor.style.cssText = `left:${Math.max(8,Math.min(innerWidth-220,rect.left))}px;top:${Math.max(8,Math.min(innerHeight-60,rect.top))}px;width:${Math.min(rect.width,innerWidth-16)}px`;
  const inp = document.createElement("input");
  inp.className = "bin-input";
  inp.maxLength = 60;
  inp.value = group.name;
  inp.setAttribute("aria-label", "Group name");
  editor.append(inp); document.body.append(editor);
  inp.focus();
  inp.select();
  let over = false;
  const finish = async (save) => {
    if (over) return;
    over = true;
    const v = inp.value.trim();
    if (save && v && v !== group.name) {
      try { await api("/api/draw/rename", { theme: group.id, name: v }); group.name = v; toast("Renamed. Z undoes it."); } catch (e) { toast(e.message); }
    }
    editor.remove();
    if (!left(view)) done();
  };
  for (const ev of ["click", "pointerdown", "keyup", "keypress"]) inp.addEventListener(ev, (e) => e.stopPropagation());
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); };
  inp.onblur = () => finish(true);
}

// Group keys: 1–9, then 0 for the 10th; Alt+1…9 and Alt+0 for the 11th to the 20th; Alt+Shift for the 21st to the 30th.
const groupKeyLabel = (i) => {
  const n = i + 1, d = String(((n - 1) % 10) + 1).replace("10", "0");
  return n <= 10 ? d : n <= 20 ? `Alt ${d}` : n <= 30 ? `Alt⇧${d}` : "";
};
function groupKey(e) {  // the group index a key press picks, or null
  if (!/^(Digit|Numpad)[0-9]$/.test(e.code) || e.ctrlKey || e.metaKey || (e.shiftKey && !e.altKey)) return null;  // the numpad counts too
  const d = Number(e.code.slice(-1)), n = (d === 0 ? 10 : d) + (e.altKey ? (e.shiftKey ? 20 : 10) : 0);
  return n - 1;
}

function viewDraw(main, params) {
  if (params.get("play")) return drawPlay(main, Number(params.get("play")));
  if (params.get("sort")) return drawQuickSort(main);
  return drawSorter(main, params.get("g"));
}

let tagPickerId=0;
// Search friendly names while keeping the exact tag key behind each choice, including duplicate names.
function tagPicker(root,list,choose,{label='Find a tag',exclude=null,create=null}={}) {
  const id=`tag-picker-${++tagPickerId}`;
  root.innerHTML=`<label>${esc(label)}<input class="hint-input" type="search" role="combobox" aria-autocomplete="list" aria-controls="${id}" aria-expanded="false" autocomplete="off"></label><div class="tag-options rail-card" role="listbox" id="${id}" hidden></div>`;
  const input=$('input',root),options=$('.tag-options',root);let matches=[],at=-1;
  const close=()=>{options.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');};
  const pick=t=>{close();input.value='';t.create?create(t.label):choose(t);};
  const paint=()=>{
    const value=input.value.trim(),q=value.toLocaleLowerCase();matches=list.filter(t=>!(exclude instanceof Set?exclude.has(t.key):t.key===exclude)&&t.label.toLocaleLowerCase().includes(q)).slice(0,100);at=-1;
    if(create&&value&&!list.some(t=>t.label.toLocaleLowerCase()===q))matches.push({label:value,create:true});
    options.innerHTML=matches.length?matches.map((t,i)=>`<button type="button" role="option" id="${id}-${i}" aria-selected="false" tabindex="-1" data-tag-option="${i}">${t.create?`＋ Create “${esc(t.label)}”`:`${esc(t.emoji||'🏷️')} ${esc(t.label)}`}</button>`).join(''):'<span class="muted">No matching tags</span>';
    options.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');
    for(const button of $$('[data-tag-option]',options)){button.onpointerdown=e=>e.preventDefault();button.onclick=()=>pick(matches[Number(button.dataset.tagOption)]);}
  };
  input.oninput=input.onfocus=paint;
  input.onkeydown=e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return;}
    if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();e.stopPropagation();if(options.hidden)paint();if(!matches.length)return;
      at=at<0?(e.key==='ArrowDown'?0:matches.length-1):(at+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length;
      $$('[role=option]',options).forEach((b,i)=>b.setAttribute('aria-selected',String(i===at)));
      const active=$(`#${id}-${at}`,options);input.setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'});
    }else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(!options.hidden&&(at>=0||matches.length===1))pick(matches[at>=0?at:0]);}
  };
  root.addEventListener('focusout',e=>{if(!root.contains(e.relatedTarget))close();});
  return input;
}

// Every tag has an editable roster and a finite set of borderline calls to teach it.
async function viewTags(main, params) {
  const view = S.view, play = params.get("play");
  main.innerHTML = LOADING();
  let data;
  try { data = await api("/api/tags?all=1"); await World.allPhotos(); }
  catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  const list = data.tags.filter(t=>t.count>0).sort((a,b)=>b.count-a.count || a.label.localeCompare(b.label));
  const selected=new Set();
  let key = play || params.get("key") || list[0]?.key, shown = 80, busy = false;
  if (!list.some((t)=>t.key===key)) key=list[0]?.key;
  const update = (r) => { if (r.game) { updateHudQuiet(r.game); paintSaveChip(); } };
  const act = async (path, body, message) => {
    if (busy) return; busy = true;
    try { const r=await api(path,body);update(r); if (!left(view)) { toast(message); viewTags(main, new URLSearchParams({key: r.key || body.key || key || ""})); } }
    catch (e) { if (!left(view)) toast(e.message); }
    finally { busy = false; }
  };
  if (play) {
    const tag = list.find((t)=>t.key===play);
    if (!tag) { location.hash = "#tags"; return; }
    let cards;
    try { cards = (await api(`/api/tags/deck?key=${encodeURIComponent(play)}`)).cards; }
    catch(e) { if (!left(view)) main.innerHTML=FAILED(e.message); return; }
    if (left(view)) return;
    let index=0, calls=[];
    main.innerHTML=`<div class="screen tag-game no-rail"><div class="screen-head"><h1>🏷️ Tag check</h1><span id="tag-count" class="stat-chip"></span><span class="grow"></span>
      ${helpBtn("Does the tag describe this photo? → or Enter adds it; ← removes it. Z undoes your last call. Esc opens the pause menu.")}</div>
      <div class="screen-body tag-call" id="tag-call"></div><div class="screen-bar action-bar">
      <div class="bar-left"><button class="btn ghost" id="tag-skip"><kbd>Space</kbd> Skip</button><button class="btn ghost" id="tag-undo" hidden>Undo <kbd>Z</kbd></button></div>
      <div class="bar-mid"><button class="btn danger" id="tag-no">Doesn't fit <kbd>←</kbd></button></div><div class="bar-right"><button class="btn primary big" id="tag-yes">Fits <kbd>→</kbd></button></div></div></div>`;
    const paint = () => {
      const c=cards[index]; $("#tag-count").textContent=`${index} of ${cards.length} checked`;
      $("#tag-undo").hidden=!calls.length; $("#tag-skip").hidden=$("#tag-no").hidden=$("#tag-yes").hidden=!c;
      $("#tag-call").innerHTML=c ? `<h2>Is this ${esc(tag.emoji || "🏷️")} ${esc(tag.label)}?</h2><div class="print"><img src="${P(c.photo)}" alt="Photo to check"></div>
        `
        : `<div class="empty"><div class="clear-stamp">All checked</div><p>Your calls override automatic guesses.</p><a class="btn primary" href="#tags?key=${encodeURIComponent(play)}">See the tag's photos →</a></div>`;
    };
    const call = async (yes) => {
      const c=cards[index]; if (!c || busy) return; busy=true;
      try { update(await (yes === "toss" ? api("/api/draw/toss",{photo:c.photo}) : api("/api/tags/set",{photos:[c.photo],on:yes?[play]:[],off:yes?[]:[play]})));
        if (left(view)) return; calls.push(index++); Sound.play(yes===true?"keep":"toss"); paint(); }
      catch(e) { if (!left(view)) toast(e.message); } finally {busy=false;}
    };
    const undo = async () => { if (!calls.length || busy) return; busy=true;
      try { update(await api("/api/draw/undo",{})); if (!left(view)) {index=calls.pop();paint();} }
      catch(e) { if (!left(view)) toast(e.message); } finally {busy=false;}
    };
    const skip=()=>{if(busy||!cards[index])return;if(cards.length-index<2){location.hash=`#tags?key=${encodeURIComponent(play)}`;return;}
      cards.push(cards.splice(index,1)[0]);Sound.play("skip");paint();};
    $("#tag-skip").onclick=skip;
    $("#tag-yes").onclick=()=>call(true); $("#tag-no").onclick=()=>call(false); $("#tag-undo").onclick=undo;
    S.onKey=(e)=>{if(e.repeat)return; if(["ArrowRight","Enter","ArrowLeft"," ","x","X","z","Z","Escape"].includes(e.key))e.preventDefault();
      if(e.key==="ArrowRight"||e.key==="Enter") cards[index]?call(true):location.hash=`#tags?key=${encodeURIComponent(play)}`;
      else if(e.key==="ArrowLeft")call(false); else if(e.key===" ")skip(); else if(e.key.toLowerCase()==="x")call("toss"); else if(e.key==="z"||e.key==="Z")undo(); else if(e.key==="Escape")location.hash=`#tags?key=${encodeURIComponent(play)}`;};
    paint(); return;
  }
  main.innerHTML=`<div class="screen tags-page"><div class="screen-head"><h1>🏷️ Tags</h1><span class="stat-chip">${plural(list.length,"tag")}</span><span class="grow"></span>
      ${helpBtn("Every recognition becomes a tag. Rename people, combine duplicate tags, or correct the machine. Select tags in the sea to gather their photos. Every edit can be undone with Z.")}</div>
    <div class="screen-body tag-roster" id="tag-roster"></div><aside class="screen-rail"><label>Find a tag<input class="hint-input" id="tag-search" type="search"></label>
      <div class="tag-list" id="tag-list"></div><form id="tag-new"><label>New tag<input class="hint-input" name="label" maxlength="40" required></label><button class="btn">＋ Create tag</button></form></aside>
    <div class="screen-bar action-bar"><div class="bar-left"><a class="btn" href="#draw">Groups</a><button class="btn ghost" id="tags-undo">Undo <kbd>Z</kbd></button></div>
      <div class="bar-mid"></div><div class="bar-right"><a class="btn primary big" id="tag-play">Check this tag → <kbd>Enter</kbd></a></div></div></div>`;
  const paintList=()=> { const q=$("#tag-search").value.toLowerCase(); $("#tag-list").innerHTML=`<button class="tag-row ${!key?'on':''}" data-tag-all>All photos</button>`+list.filter((t)=>t.label.toLowerCase().includes(q))
    .map((t)=>`<button class="tag-row ${t.key===key?"on":""}" data-tag="${esc(t.key)}"><span>${esc(t.emoji || "🏷️")} ${esc(t.label)}</span><b>${fmt(t.count)}</b></button>`).join("");
    $('[data-tag-all]',main).onclick=()=>{key=null;shown=80;paintList();paint();};
    $$("[data-tag]",main).forEach((b)=>b.onclick=()=>{key=b.dataset.tag;shown=80;paintList();paint();}); };
  const paint=()=>{
    const t=list.find((t)=>t.key===key), roster=$("#tag-roster");
    $("#tag-play").hidden=!t;
    if(t)$("#tag-play").href=`#tags?play=${encodeURIComponent(key)}`;
    const photos=[...World.photos.values()].filter((p)=>!t||p.tags.includes(key));
    roster.innerHTML=`${t?`<div class="tag-edit" data-solid><form id="tag-edit"><button type="button" class="btn" id="tag-emoji">${esc(t.emoji||"🏷️")}</button>
      <label>Name<input class="hint-input" name="label" value="${esc(t.label)}" maxlength="40" required></label><button class="btn">Save name</button></form>
      <div class="row wrap"><div class="tag-picker" id="tag-merge"></div><button class="btn ghost danger" id="tag-delete">Delete tag</button></div>
      <p class="muted">${plural(photos.length,"photo")} · includes takes and photos set aside</p></div>`:'<p>Select photos to give them a new tag.</p>'}
      <div class="grid tag-photos">${photos.slice(0,shown).map((p)=>`<div class="tag-photo-card"><button class="tag-photo ${p.cut?"dim":""}" type="button" data-tag-photo="${p.id}" aria-label="Open photo"><img src="${T(p.id)}" alt="" loading="lazy" draggable="false"></button><label class="tag-photo-pick"><input type="checkbox" data-tag-pick="${p.id}" aria-label="Select photo for a new tag" ${selected.has(p.id)?'checked':''}></label></div>`).join("")}</div>
      ${photos.length>shown?`<button class="btn" id="tag-more">More photos (${fmt(photos.length-shown)} left)</button>`:""}`;
    if(t){$("#tag-edit").onsubmit=(e)=>{e.preventDefault();act("/api/tags/meta",{key,label:new FormData(e.target).get("label")},"Renamed. Z undoes it.");};
    $("#tag-emoji").onclick=(e)=>emojiPicker(e.currentTarget,(emoji)=>act("/api/tags/meta",{key,emoji},"New emoji. Z undoes it."));
    tagPicker($('#tag-merge'),list,t=>act('/api/tags/merge',{source:key,key:t.key},'Tags merged. Z undoes it.'),{label:'Merge into',exclude:key});
    $("#tag-delete").onclick=()=>act("/api/tags/delete",{source:key},"Deleted. Z restores the tag.");}
    for(const box of $$('[data-tag-pick]',roster))box.onchange=()=>{const id=Number(box.dataset.tagPick);box.checked?selected.add(id):selected.delete(id);newTagState();};
    $$("[data-tag-photo]",roster).forEach((b)=>b.onclick=()=>World.inspect(Number(b.dataset.tagPhoto)));
    if($("#tag-more"))$("#tag-more").onclick=()=>{shown+=80;paint();};
  };
  const newTagState=()=>{const button=$('#tag-new button');button.disabled=!selected.size;button.textContent=selected.size?`＋ Tag ${plural(selected.size,'photo')}`:'Select photos to make a tag';};
  const newTagInput=$('#tag-new input');
  newTagInput.onfocus=newTagInput.oninput=()=>$('.tags-page',main).classList.add('choosing-tag-photos');
  newTagInput.onblur=()=>{if(!newTagInput.value.trim()&&!selected.size)$('.tags-page',main).classList.remove('choosing-tag-photos');};
  $("#tag-search").oninput=paintList;
  $("#tag-new").onsubmit=(e)=>{e.preventDefault();if(selected.size)act("/api/tags/new",{label:new FormData(e.target).get("label"),photos:[...selected]},"Tag created. Z undoes it.");};
  $("#tags-undo").onclick=()=>act("/api/draw/undo",{},"Undone.");
  S.onKey=(e)=>{if(e.key==="z"||e.key==="Z"){e.preventDefault();$("#tags-undo").click();}else if(e.key==="Enter"){e.preventDefault();$("#tag-play").click();}};
  paintList();paint();newTagState();
}

// Real takes peek out from under the kept print. Stable offsets keep a pile still while you reach for it.
function pilePhotos(rep, members = [], count = members.length, open = true) {
  return members.filter((p)=>p!==rep).slice(0,4).reverse().map((p,i)=>`<img class="pile-take under" src="${T(p)}" alt="" loading="lazy" draggable="false"
    style="--pile-x:${[5,-6,7,-3][i]}%;--pile-y:${[4,-3,-5,6][i]}%;--pile-turn:${[7,-8,3,-4][i]}deg;--pile-z:${i}">`).join("")+Cards.stack(count,open?rep:null);
}
const fanStyle = (i,n) => `--i:${i};--fan-turn:${Math.max(-12,Math.min(12,(i-(n-1)/2)*4))}deg;--fan-y:${Math.min(16,Math.abs(i-(n-1)/2)*2)}px`;
// A shot (or a clipped stack) as a tile: click selects it, drag it onto another to stack them, ⤢ views it larger.
function shotTile(x, selected, boxes = null, defer = false) {
  const on = selected && selected.has(x.rep);
  return `
    <div class="tile pick ${defer?'sleeping':''} ${on ? "picked" : ""} ${x.members.length > 1 ? "stacked" : ""}" data-sel="${x.rep}" draggable="true" data-drag-shot="${x.rep}"
      data-drop="${x.rep}" role="group" title="${x.taken ? esc(x.taken.replace("T", " ")) : "no date"}">
      ${defer?'':shotTileContents(x,selected,boxes)}
    </div>`;
}
function shotTileContents(x,selected,boxes=null){
  const on=selected&&selected.has(x.rep);
  return `
      <div class="shot-pile"><button class="shot-select" aria-label="Select shot" aria-pressed="${!!on}">${pilePhotos(x.rep,x.members,false)}<img class="pile-cover" src="${T(x.rep)}" alt="Shot" loading="lazy" draggable="false" data-box="${esc(JSON.stringify(boxes?.[x.rep] || null))}">${selected ? `<span class="shot-selected" aria-hidden="true" title="Selected" ${on ? "" : "hidden"}>✓</span>` : ""}</button>
      ${x.members.length > 1 ? `<span class="kept-crown" title="The take that stands in for this stack">👑</span>
        <button class="badge expand stack-clip" data-expand="${x.rep}" title="Show all ${x.members.length} takes" aria-label="Open stack of ${x.members.length} takes" aria-expanded="false">${Cards.stackFace(x.members.length)}</button>` : ""}</div>
      ${x.solo ? `<button class="rank undo-split" data-reset="${x.rep}" title="Hand it back to automatic stacking">split by you · undo</button>` : ""}
      <button class="zoom" data-view="${x.rep}" title="View larger" aria-label="View larger">⤢</button>`;
}
function shotFamilies(list) {
  const out = [];
  for (const x of list) {
    const last = out[out.length - 1];
    if (x.family != null && last && last.family === x.family) last.items.push(x);
    else out.push({ family: x.family, items: [x] });
  }
  return out;
}
function shotTiles(list, selected, boxes = null, defer = false) {  // consecutive look-alikes (2+) share a dashed box
  return shotFamilies(list).map((k) => (k.items.length > 1 ? `<div class="fam-tiles" data-family="${esc(k.family)}">${k.items.map((x) => shotTile(x, selected, boxes,defer)).join("")}</div>`
    : shotTile(k.items[0], selected, boxes,defer))).join("");
}
const shotSnapshot = (shot,boxes) => JSON.stringify([shot,boxes?.[shot.rep]||null]);
function rememberShotTiles(grid,shots,boxes) {
  if(!grid)return;
  const keys=new Map(shots.map(shot=>[shot.rep,shotSnapshot(shot,boxes)]));
  for(const tile of $$('[data-drag-shot]',grid))if(keys.has(Number(tile.dataset.dragShot)))tile.shotSnapshot=keys.get(Number(tile.dataset.dragShot));
}
// A merge changes two piles. Reuse the rest, including their decoded pictures, notes and keyboard focus.
function patchShotTiles(grid,shots,selected,boxes,defer=false) {
  const tiles=new Map($$('[data-drag-shot]',grid).map(tile=>[Number(tile.dataset.dragShot),tile]));
  const families=new Map();
  for(const family of $$(':scope > .fam-tiles',grid)){
    const siblings=families.get(family.dataset.family)||[];siblings.push(family);families.set(family.dataset.family,siblings);
  }
  const reconcile=(parent,children)=>{
    let cursor=parent.firstElementChild;
    for(const child of children){if(child===cursor)cursor=cursor.nextElementSibling;else parent.insertBefore(child,cursor);}
    while(cursor){const next=cursor.nextElementSibling;cursor.remove();cursor=next;}
  };
  const blocks=shotFamilies(shots).map(group=>{
    const children=group.items.map(shot=>{
      const key=shotSnapshot(shot,boxes);let tile=tiles.get(shot.rep);
      if(!tile||tile.shotSnapshot!==key){
        const holder=document.createElement('template');holder.innerHTML=shotTile(shot,selected,boxes,defer);
        tile=holder.content.firstElementChild;tile.shotSnapshot=key;
      }
      return tile;
    });
    if(children.length===1)return children[0];
    const family=families.get(String(group.family))?.shift()||document.createElement('div');
    family.className='fam-tiles';family.dataset.family=group.family;
    reconcile(family,children);return family;
  });
  reconcile(grid,blocks);
}
// Open the pile into a fan: overlapping prints, every take reachable to keep or split out.
function expandStack(root, x, btn, boxes, reveal = true) {
  const t = btn.closest(".tile");
  const open = t.classList.contains("open");
  $$(".tile.open", root).forEach((o) => { o.classList.remove("open"); o.style.gridRow = ""; $(".tile-frames", o)?.remove(); $("[data-expand]", o)?.setAttribute("aria-expanded", "false"); });
  if (open || !x) return;
  t.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  t.insertAdjacentHTML("beforeend", `
    <div class="tile-frames">
      <div class="tile-frames-bar">${x.crownable!==false?`<a class="btn primary crown-btn" href="#duel?stack=${x.rep}" title="Play this stack's mini-tournament">👑 Crown</a>`:""}
        <button class="btn" data-unstack="${x.rep}" title="Split the whole stack into separate shots">Split all</button>
        <button class="btn ghost" data-aside-stack="${x.rep}" title="Set this stack aside with all its takes (X)">🗑 Set aside <kbd>X</kbd></button></div>
      <div class="photo-fan" style="--takes:${x.members.length}">${x.members.map((m,i) => `
        <div class="ftile ${m===x.rep?'kept':''}" style="${fanStyle(i,x.members.length)}" draggable="true" data-drag-frame="${m}" title="Drag onto another shot to move this take" tabindex="0">
          <img src="${T(m)}" alt="Take" loading="lazy" data-view="${m}" draggable="false" data-box="${esc(JSON.stringify(boxes?.[m] || null))}">
          <div class="ftile-actions">${m===x.rep?'<span>👑 Kept</span>':`<button data-keep="${m}">Keep</button>`}<button data-split="${m}">Split out</button>${photoPathButton(m)}</div>
        </div>`).join("")}</div>
    </div>`);
  if(reveal)requestAnimationFrame(()=>{if(t.isConnected)t.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});});
}

// The Groups page: every group (and the unsorted pile) as a section of its shots, all editable in place. Drag photos
// between groups (or onto the numbered groups beside you), drop one photo on another to stack them, or select some
// and press a group's number. Quick sort (the minigame) deals the unsorted ones one at a time.
async function drawSorter(main, focus) {
  const view = S.view;
  const selected = new Set(), full = new Set();
  let b = null, busy = false, sea = null;
  // 🌊 sea: every photo floating, groups as islands (the default on a big screen); ▦ list: sections of tiles
  let mode = (() => { try { return localStorage.getItem("matcher-groups-view"); } catch (_) { return null; } })() || (innerWidth >= 900 ? "sea" : "list");
  const byRep = new Map();
  let loadEpoch = 0, listPages = 1, openedStack = null;
  const matchingShot = (rows, members, rep) => {
    const ids=new Set(members);
    return rows.map(shot=>({shot,n:shot.members.filter(m=>ids.has(m)).length})).filter(x=>x.n)
      .sort((a,b)=>b.n-a.n||Number(b.shot.rep===rep)-Number(a.shot.rep===rep))[0]?.shot;
  };
  async function load(keep, edit = null) {
    const epoch = ++loadEpoch, body=$("#sections",main), y=body?.scrollTop||0;
    const expanded=keep&&(byRep.get(Number($(".tile.open[data-sel]",body||main)?.dataset.sel))||openedStack);
    const members=expanded?.members.filter(m=>m!==edit?.split);
    const edge=body?.getBoundingClientRect(),visible=keep&&edge?$$(".tile[data-sel]",body)
      .map(el=>({shot:byRep.get(Number(el.dataset.sel)),box:el.getBoundingClientRect()}))
      .filter(x=>x.shot&&x.box.bottom>edge.top&&x.box.top<edge.bottom)
      .sort((a,b)=>Number(b.shot===expanded)-Number(a.shot===expanded)||Math.abs(a.box.top-edge.top)-Math.abs(b.box.top-edge.top))[0]:null;
    const anchor=visible&&{members:visible.shot===expanded?members:visible.shot.members,rep:visible.shot.rep,offset:visible.box.top-edge.top};
    const circles = Number(localStorage.getItem("matcher-circles") || 6);
    const q = mode === "sea" ? `per=400&uper=600&tags=1&circles=${circles}` : `per=24${full.size ? `&full=${[...full].join(",")}` : ""}`;
    try {
      const [board, allTags] = await Promise.all([api(`/api/draw/board?${q}`), mode==="sea"?api("/api/tags?all=1"):Promise.resolve(null)]);
      if (left(view) || epoch !== loadEpoch) return;
      b = board; if(allTags)b.allTags=allTags;
      if(mode==="list"){
        const loaded=keep?listPages:1;let page=0;
        const rows=()=>[b.unsorted,...b.groups].flatMap(g=>g.shots);
        // A changed cover can sort onto a later page. Find the remaining stack before rebuilding its fan.
        while(b.more&&(page+1<loaded||members?.length&&!matchingShot(rows(),members,expanded.rep))){
          const next=await api(`/api/draw/board?${q}&page=${++page}`);
          if(left(view)||epoch!==loadEpoch)return;
          for(const g of [b.unsorted,...b.groups]){
            const add=g===b.unsorted?next.unsorted:next.groups.find(x=>x.id===g.id),seen=new Set(g.shots.map(x=>x.rep));
            if(add)g.shots.push(...add.shots.filter(x=>!seen.has(x.rep)));
          }
          Object.assign(b.boxes,next.boxes);b.more=next.more;
        }
        listPages=page+1;
      }
      if (b.game) { Ach.check(b.game); S.game = b.game; paintSaveChip(); }
      const paint = () => {
        byRep.clear(); [b.unsorted, ...b.groups].forEach((g) => g.shots.forEach((x) => byRep.set(x.rep, x)));
        if (mode === "sea") renderSea(); else { if (sea) { sea = null; World.setMode("dim"); } render(); }
      };
      paint();
      if (mode === "sea") {
        let page = 0;
        while (b.more && !left(view) && epoch === loadEpoch) {
          const next = await api(`/api/draw/board?per=400&uper=600&page=${++page}`);
          if (left(view) || epoch !== loadEpoch) return;
          for (const g of next.groups) b.groups.find((x) => x.id === g.id)?.shots.push(...g.shots);
          b.unsorted.shots.push(...next.unsorted.shots); b.more = next.more;
          paint(); await sleep(0);
        }
        await World.allPhotos(() => { if (!left(view) && epoch === loadEpoch) renderSea(); });
      }
      if (left(view) || epoch !== loadEpoch) return;
      for (const r of [...selected]) if (!byRep.has(r) && !World.photos?.has(r)) selected.delete(r);
      if (keep && $("#sections", main)) {
        if(expanded){
          const match=matchingShot([...byRep.values()],members,expanded.rep),button=match&&$(`[data-expand="${match.rep}"]`,main);
          if(button&&match.members.length>1){expandStack(main,match,button,b.boxes,false);openedStack=match;}
        }
        World.sea?.layout();
        const body=$("#sections",main),match=anchor&&matchingShot([...byRep.values()],anchor.members,anchor.rep),tile=match&&$(`[data-sel="${match.rep}"]`,body);
        body.scrollTop=tile?tile.getBoundingClientRect().top-body.getBoundingClientRect().top+body.scrollTop-anchor.offset:y;
      }
      else if (focus) $(`#gsec-${focus}`)?.scrollIntoView({ block: "start" });
    } catch (e) { if (!left(view)) { if (!b) main.innerHTML = FAILED(e.message); else toast(e.message); } }
  }
  const viewToggle = () => `<span class="seg" role="group" aria-label="View">
    <button class="seg-btn ${mode === "sea" ? "on" : ""}" data-mode="sea" title="Photos flock together by their tags">🫧 Sea</button>
    <button class="seg-btn ${mode === "list" ? "on" : ""}" data-mode="list" title="Groups as sections of tiles">▦ List</button></span>`;
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    openedStack=null;
    try { localStorage.setItem("matcher-groups-view", m); } catch (_) { /* private mode */ }
    if (sea) { sea = null; World.setMode("dim"); }
    main.innerHTML = LOADING();
    load();
  }
  const barHtml = () => {
    const left_ = b.unsorted.count;
    return `<div class="bar-left"><span id="sel-count" class="muted small"></span></div>
      <div class="bar-mid">
        <button class="btn ghost" data-sel-act="clear"><kbd>Esc</kbd> Clear</button>
        <button class="btn" data-sel-act="inspect">Grab selected</button>
        <button class="btn" data-sel-act="unsort"><kbd>U</kbd> Unsorted</button>
        <button class="btn" data-sel-act="stack" title="They're the same shot: one stack">Stack them</button>
        <button class="btn" data-sel-act="new"><kbd>N</kbd> New group</button>
        <button class="btn" data-sel-act="tag" title="A tag of your own on these"><kbd>T</kbd> Tag</button>
        <button class="btn ghost" id="g-undo" ${b.undo ? "" : "hidden"} title="Take back your last change (Z)"><kbd>Z</kbd> <span class="desktop-label">${b.undo ? `Undo ${DRAW_WORD[b.undo] || b.undo}` : "Undo"}</span><span class="phone-label">Undo</span></button>
      </div>
      <div class="bar-right">${left_ ? `<a class="btn primary big" href="#draw?sort=1">🎮 Quick sort <span class="btn-sub">${fmt(left_)} left</span> <kbd>Enter</kbd></a>` : ""}</div>`;
  };
  const forwardState = () => setForward(b.unsorted.count ? null : groupStageForward());
  const seaHead = () => {
    const T = b.tagging || { tags: [], visible: [] };
    return `
    <h1>🗂️ Groups</h1>
    <span class="stat-chip" title="Shots in a group">${ring(b.total ? b.drawn / b.total : 0)}<b>${fmt(b.drawn)}</b>/ ${fmt(b.total)} grouped · ${plural(b.groups.length, "group")}</span>
    <a class="btn ghost" href="#tags">Edit tags</a><button class="btn ghost" id="more-circles">${Sea.on?'Hide sea colours':'Show sea colours'}</button>
    <button class="stat-chip chip-btn" id="tag-tray" title="Find a tag to focus">🏷️ <b>${fmt((b.allTags?.tags||T.tags).length)}</b> tags</button>
    <span class="grow"></span>
    ${viewToggle()}
    ${b.unsorted.count ? `<button class="btn" id="d-auto" title="Groups everything that's left for you (rename, merge or dissolve after)">✨ Auto-group the rest</button>` : ""}
    ${helpBtn(`Photos sharing <b>tags</b> flock together, leaving room between prints. Lassos follow the neighbourhoods they form.<br><br>
      Select tags to gather their photos onto steady spots. <b>All</b> selected tags narrows the focus; <b>Any</b> widens it.
      Click a group in the side list to bring it into focus. With photos selected, clicking a group moves them there; its <b>Focus</b> button still just looks.
      Drop a print onto another to stack their takes, or in the coloured water between a group's prints to file it there.
      Drag into open water to rearrange the swarm. Group keys work the same way as the side list.
      Right-click a tag or group label to edit it. <b>T</b> tags the selection, <b>Z</b> undoes edits.`)}`;
  };
  // The tag sea: the field stays put across reloads, so a change is photos swimming somewhere new, not a redraw.
  function renderSea() {
    if (!b.tagging) { mode = "list"; return render(); }
    if (!sea || !$("#venn-rail", main)) {
      main.innerHTML = `
        <div class="screen sorter sea-view venn-view">
          <div class="screen-head" id="sea-head"></div>
          <div class="screen-body fill" id="ps"></div>
          <aside class="screen-rail" id="venn-rail"></aside>
          <div class="screen-bar action-bar" id="mergebar"></div>
        </div>`;
      sea = World.live({
        onSelectMatches: ids=>{if(left(view))return;selected.clear();for(const id of World.groupSelection(ids))selected.add(id);updateSelection();},
        onSelect: (it, e) => { if (World.stackWith) return World.stackPick(it.id);
          if (e?.altKey || e?.detail > 1) return World.inspect(it.id, null, () => load(true));
          selected.has(it.id) ? selected.delete(it.id) : selected.add(it.id); updateSelection(); },
        onStack: (it,source)=>World.inspect(it.id,[it.id],()=>load(true),{stackOpen:true,source}),
        onDrop: (ids, t) => {
          if (t.kind === "photo") return act("/api/groups/merge", { photos: [...ids, t.id] }, "Stacked: same shot, one stack.", true);
          if (t.kind === "bin") return moveTo(ids, t.id === "new" ? "new" : String(t.id));
          if (t.kind === "group") return moveTo(ids, String(t.id));
          if (t.kind === "tags") return dropTags(ids, t.on, t.off);
        },
        onCircle: (key, el) => tagMenu(key, el),
        onLasso: (id, el) => {
          if(id.startsWith("gcup:"))return World.tagMenu(`kind:${id.slice(5)}`,el);
          if(id==="gcut"){location.hash="#cuts";return;}
          if (id[0] === "g") return groupMenu(b.groups.find((g) => `g${g.id}` === id), el);
          const sg = b.tagging.suggestions.find((x) => `s${x.key}` === id);
          if (sg) makeSuggestion(sg);
        },
      });
      sea.tray.addEventListener("click", updateGroupFocus, {signal: S.events.signal});
      World.fence();
    }
    const T = b.tagging, meta = new Map((b.allTags?.tags || T.tags).map((t) => [t.key, t]));
    $("#sea-head", main).innerHTML = seaHead();
    $("#mergebar", main).innerHTML = barHtml(); forwardState();
    const groupAt = new Map(b.groups.map((g, i) => [g.id, i]));
    const circles = [...meta.values()].filter((t)=>t.count || t.user).map((t) => { return { id: t.key, label: t.label, emoji: t.emoji, catchy: t.catchy, ring:T.visible.includes(t.key),
      html: `${esc(t.emoji || "🏷️")} ${esc(t.label)} <span class="ps-count">${fmt(t.count)}</span>` }; });
    const items = [], suggOf = new Map();
    T.suggestions.forEach((sg) => sg.shots.forEach((rep) => suggOf.set(rep, sg.key)));
    const add = (x, g) => {
      byRep.set(x.rep, { ...x, island: g ? g.id : null });
      const tg = T.shot_tags[x.rep] || [];
      items.push({ id: x.rep, photo: x.rep, tags: tg, n: x.members.length, members:x.members, rep:x.rep, group: g ? g.id : null, sugg: g ? null : suggOf.get(x.rep) ?? null,
        badge: g ? groupKeyLabel(groupAt.get(g.id)) || "•" : "",
        title: `${g ? `${g.emoji} ${g.name}` : "Not in a group yet"}${tg.length ? ` · ${tg.map((k) => (meta.get(k) || {}).label || k).join(", ")}` : ""}` });
    };
    b.groups.forEach((g) => g.shots.forEach((x) => add(x, g)));
    b.unsorted.shots.forEach((x) => add(x, null));
    const lassos = [
      ...b.groups.map((g, i) => ({ id: `g${g.id}`, kind: "group", bin: String(g.id),
        html: `${groupKeyLabel(i) ? `<b class="ps-num">${groupKeyLabel(i)}</b> ` : ""}${esc(g.emoji || "🗂️")} ${esc(g.name)} <span class="ps-count">${fmt(g.size)}</span>` })),
      ...T.suggestions.map((sg) => ({ id: `s${sg.key}`, kind: "sugg", html: `＋ ${esc(sg.emoji)} ${esc(sg.name)} <span class="ps-count">${fmt(sg.shots.length)}</span>` })),
    ];
    World.board = b; World.tagMeta = meta;
    const focusedGroup = b.groups.find(g => `g${g.id}` === sea.focusCluster);
    if (focusedGroup) sea.focusIds = new Set(items.filter(it => it.group === focusedGroup.id).map(it => it.id));
    sea.setVenn(circles, World.extras(items), [...lassos, ...World.categories(items), { id: "gcut", kind: "group", html: "🫙 Set aside" }]);
    renderRail();
    bindSea();
    updateSelection();
  }
  function updateGroupFocus() {
    for (const el of $$("#venn-rail [data-bin]", main)) {
      const on = sea?.focusCluster === `g${el.dataset.bin}`;
      el.classList.toggle("focused-group", on);
      const button = $("[data-focus-bin]", el);
      if (button) {
        button.setAttribute("aria-pressed", String(on)); button.textContent = on ? "Release" : "Focus";
        button.setAttribute("aria-label", `${on ? "Release" : "Focus"} ${b.bins.find(g => String(g.id) === el.dataset.bin)?.name || "group"}`);
      }
    }
  }
  function focusGroup(id) {
    const group = b.groups.find(g => String(g.id) === String(id));
    if (!sea || !group?.size) return;
    sea.focusLasso(`g${group.id}`);
    updateGroupFocus();
  }
  // The side list: the groups the tags suggest (point at one to see its shots), then your groups to drop photos on.
  function renderRail() {
    const T = b.tagging, rail = $("#venn-rail", main);
    const lab = (k) => esc((T.tags.find((t) => t.key === k) || {}).label || k);
    rail.innerHTML = `
      ${T.suggestions.length || b.unsorted.count ? `<div class="rail-card sugg-card"><h3>💡 Suggested groups ${T.suggestions.length > 1 ? `<button class="btn primary sugg-all" id="make-all" title="Make every suggestion a group">Lock in all ${T.suggestions.length}</button>` : ""}</h3>
        ${T.suggestions.length ? `<div class="sugg-list">${T.suggestions.map((g, i) => `
          <div class="sugg" data-sugg="${i}">
            <span class="sugg-emoji">${esc(g.emoji)}</span>
            <span class="sugg-body"><b>${esc(g.name)}</b><span class="muted small">${g.tags.map(lab).join(" ∩ ")} · ${plural(g.shots.length, "shot")}</span></span>
            <button class="btn" data-make="${i}" title="Make this a group">Make</button></div>`).join("")}</div>`
          : `<p class="muted small">Nothing yet: tag more photos, or focus a tag (🏷️).</p>`}
      </div>` : ""}
      <div class="rail-card grow bins-wrap"><h3>Groups</h3>
        <div class="bins" id="bins">${binsHtml(b.bins, null, null, true)}</div></div>`;
    $$("[data-sugg]", rail).forEach((el) => {
      const g = T.suggestions[Number(el.dataset.sugg)];
      el.onmouseenter = () => sea && sea.highlight(g.shots);
      el.onmouseleave = () => sea && sea.highlight(null);
    });
    $$("[data-make]", rail).forEach((x) => (x.onclick = () => makeSuggestion(T.suggestions[Number(x.dataset.make)])));
    const all = $("#make-all", rail);
    if (all) all.onclick = () => makeAll();
    $$("[data-bin]", rail).forEach((el) => {
      const g = b.bins.find((x) => String(x.id) === el.dataset.bin);
      el.onmouseenter = () => { if (sea && g) sea.highlight(b.groups.find((x) => x.id === g.id)?.shots.map((s) => s.rep) || []); };
      el.onmouseleave = () => sea && sea.highlight(null);
      el.onclick = (e) => {
        if (e.target.closest("[data-focus-bin]")) { focusGroup(el.dataset.bin); return; }
        if (g && binTools(e, el, g, () => load(true))) return;
        if (selected.size) moveTo([...selected], el.dataset.bin);
        else if (g) focusGroup(g.id);
        else toast("Select photos first (or drag them here) to start a group.");
      };
    });
    updateGroupFocus();
  }
  function makeSuggestion(g) {
    if (sea) sea.highlight(null);
    act("/api/tags/group", { photos: g.shots, name: g.name, emoji: g.emoji }, `New group: ${g.emoji} ${g.name}.`, true);
  }
  // Every suggestion becomes a group at once (one undo step each, so Z walks them back one by one).
  async function makeAll() {
    const list = b.tagging.suggestions;
    if (!list.length || busy) return;
    busy = true;
    let made = 0;
    for (const g of list) {
      try { await api("/api/tags/group", { photos: g.shots, name: g.name, emoji: g.emoji }); made++; } catch (_) { /* already grouped */ }
    }
    busy = false;
    Sound.play("crown");
    confetti(window.innerWidth / 2, window.innerHeight / 3, 60);
    toast(`${plural(made, "new group")}: every suggestion locked in. Z takes them back one at a time.`);
    selected.clear();
    await load(true);
    refreshHud(true);
    gameCheck();
  }
  // Where you dropped photos among the circles: the tags of the circles there on, the other shown ones off.
  async function dropTags(ids, on, off) {
    const T = b.tagging;
    const changes = ids.some((id) => { const has = new Set(T.shot_tags[id] || []); return on.some((k) => !has.has(k)) || off.some((k) => has.has(k)); });
    if (!changes) return;
    const lab = (k) => (T.tags.find((t) => t.key === k) || {}).label || k;
    const said = [...on.filter((k) => ids.some((id) => !(T.shot_tags[id] || []).includes(k))).map((k) => `＋${lab(k)}`),
      ...off.filter((k) => ids.some((id) => (T.shot_tags[id] || []).includes(k))).map((k) => `−${lab(k)}`)].join(" ");
    await act("/api/tags/set", { photos: ids, on, off }, `Tags: ${said}.`);
  }
  // A group's menu (its bubble's label): rename, emoji, what to look for, deal more for it, merge it, dissolve it.
  function groupMenu(g, anchor) {
    if (!g) return;
    $(".island-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "pop-card island-pop";
    pop.innerHTML = `<div class="ip-head"><button class="t-emoji ip-emoji" data-ip="emoji" title="Change the emoji">${esc(g.emoji || "🗂️")}</button>
        <input class="hint-input ip-name" value="${esc(g.name)}" maxlength="60" aria-label="Group name"></div>
      <label class="ip-row">🔎 <input class="hint-input ip-hint" value="${esc(g.hint || "")}" maxlength="120" placeholder="what to look for: laptops, screens…" aria-label="What to look for"></label>
      <span class="muted small">${plural(g.size, "shot")}${g.tagline ? ` · ${esc(g.tagline)}` : ""}</span>
      <div class="ip-order"><span class="muted small">Place ${b.groups.indexOf(g) + 1} of ${b.groups.length}${groupKeyLabel(b.groups.indexOf(g)) ? ` · key ${groupKeyLabel(b.groups.indexOf(g))}` : ""}</span>
        <button class="btn ghost" data-ip="earlier" ${b.groups.indexOf(g) ? "" : "hidden"}>◀ Earlier</button>
        <button class="btn ghost" data-ip="later" ${b.groups.indexOf(g) < b.groups.length - 1 ? "" : "hidden"}>Later ▶</button></div>
      <div class="ip-actions">
        ${b.unsorted.count ? `<a class="btn" href="#draw?play=${g.id}">🎮 Find more</a>` : ""}
        ${b.groups.length > 1 ? `<select class="ip-merge" aria-label="Merge into"><option value="">Merge into…</option>${b.groups.filter((x) => x.id !== g.id)
          .map((x) => `<option value="${x.id}">${esc(x.emoji)} ${esc(x.name)}</option>`).join("")}</select>` : ""}
        <button class="btn ghost danger" data-ip="dissolve">Dissolve</button>
      </div>`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - pop.offsetWidth / 2, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(62,Math.min(r.bottom+8,innerHeight-pop.offsetHeight-12))+window.scrollY}px`;
    const close = () => { pop.remove(); document.removeEventListener("pointerdown", away, true); };
    const away = (e) => { if (!pop.contains(e.target) && !e.target.closest(".emoji-pop")) close(); };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    const name = $(".ip-name", pop), hint = $(".ip-hint", pop);
    name.onkeydown = hint.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") close(); };
    name.onchange = () => { const v = name.value.trim(); if (v && v !== g.name) { close(); act("/api/draw/rename", { theme: g.id, name: v }, "Renamed."); } };
    hint.onchange = () => { const v = hint.value.trim(); if (v !== (g.hint || "")) { close(); act("/api/draw/hint", { theme: g.id, hint: v }, v ? "Find more will look for that." : "Cleared."); } };
    $("[data-ip=emoji]", pop).onclick = (e) => emojiPicker(e.currentTarget, (emoji) => { close(); act("/api/draw/rename", { theme: g.id, emoji }, "New emoji."); });
    for (const [k, d] of [["earlier", -1], ["later", 1]]) $(`[data-ip=${k}]`, pop).onclick = async () => {
      const ids = moveInOrder(b.groups.map((x) => x.id), g.id, d);
      if (ids && (await saveOrder(ids))) { close(); toast("Moved. Z undoes it."); await load(true); }
    };
    $("[data-ip=dissolve]", pop).onclick = () => { close(); act("/api/draw/dissolve", { theme: g.id }, "Dissolved. Z undoes it."); };
    if ($(".ip-merge", pop)) $(".ip-merge", pop).onchange = (e) => {
      const into = Number(e.target.value);
      if (into) { close(); act("/api/draw/merge", { from: g.id, into }, "Merged. Z undoes it."); }
    };
    name.focus();
  }
  // A tag's edit menu: its name, emoji and photo selection.
  function tagMenu(key, anchor) {
    const t = (b.allTags?.tags || b.tagging.tags).find((x) => x.key === key);
    if (!t) return;
    $(".island-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "pop-card island-pop tag-pop";
    pop.innerHTML = `<div class="ip-head"><button class="t-emoji ip-emoji" data-tp="emoji" title="Change the emoji">${esc(t.emoji || "🏷️")}</button>
        <input class="hint-input ip-name" value="${esc(t.label)}" maxlength="40" aria-label="Tag name"></div>
      <span class="muted small">${plural(t.count, "shot")} · ${{ what: "what's in it", people: "who", look: "how it looks", when: "when" }[t.family] || "your tag"}${t.user ? " · yours" : ""}</span>
      <div class="ip-actions"><button class="btn" data-tp="select">Select its photos</button></div>`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - pop.offsetWidth / 2, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(62,Math.min(r.bottom+8,innerHeight-pop.offsetHeight-12))+window.scrollY}px`;
    const close = () => { pop.remove(); document.removeEventListener("pointerdown", away, true); };
    const away = (e) => { if (!pop.contains(e.target) && !e.target.closest(".emoji-pop")) close(); };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    const name = $(".ip-name", pop);
    name.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") name.blur(); if (e.key === "Escape") close(); };
    name.onchange = () => { const v = name.value.trim(); if (v && v !== t.label) { close(); act("/api/tags/meta", { key, label: v }, "Renamed."); } };
    $("[data-tp=emoji]", pop).onclick = (e) => emojiPicker(e.currentTarget, (emoji) => { close(); act("/api/tags/meta", { key, emoji }, "New emoji."); });
    $("[data-tp=select]", pop).onclick = () => {
      close();
      for(const it of sea.items.values())if(it.tags.includes(key))selected.add(it.id);
      updateSelection();
    };
    name.focus();
  }
  // Every tag, by kind: click one to narrow the sea's focus.
  function tagTray(anchor) {
    $(".island-pop")?.remove();
    const T = {...b.tagging,tags:b.allTags?.tags||b.tagging.tags}, shown = sea.focusKeys;
    const pop = document.createElement("div");
    pop.className = "pop-card island-pop tag-tray";
    const fam = { what: "What's in it", people: "Who", look: "How it looks", when: "When" };
    const paint = (q) => {
      const hit = (t) => !q || t.label.toLowerCase().includes(q);
      $(".tray-body", pop).innerHTML = Object.entries(fam).map(([f, title]) => {
        const list = T.tags.filter((t) => (t.family || "what") === f && hit(t));
        return list.length ? `<div class="tray-fam"><b>${title}</b><div class="tray-chips">${list.map((t) => `<button class="tag-chip ${shown.has(t.key) ? "on" : ""}"
          data-chip="${esc(t.key)}" title="Focus this tag">${esc(t.emoji || "🏷️")} ${esc(t.label)} <b>${fmt(t.count)}</b></button>`).join("")}</div></div>` : "";
      }).join("") || `<p class="muted small">No tags match.</p>`;
      $$("[data-chip]", pop).forEach((c) => (c.onclick = () => {
        const k = c.dataset.chip;
        close();
        sea.toggleTag(k);
      }));
    };
    pop.innerHTML = `<input class="hint-input tray-q" placeholder="Find a tag" aria-label="Find a tag"><div class="tray-body"></div>`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(62,Math.min(r.bottom+8,innerHeight-pop.offsetHeight-12))+window.scrollY}px`;
    const close = () => { pop.remove(); document.removeEventListener("pointerdown", away, true); };
    const away = (e) => { if (!pop.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    const q = $(".tray-q", pop);
    q.oninput = () => paint(q.value.trim().toLowerCase());
    q.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Escape") close(); };
    paint("");
    q.focus();
  }
  // T: a tag of your own on the selected photos.
  function tagSelection(anchor) {
    if (!selected.size) return toast("Select photos first, then press T to tag them.");
    $(".island-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "pop-card island-pop";
    pop.innerHTML = `<label class="ip-row">🏷️ <input class="hint-input" maxlength="40" placeholder="a tag for these ${plural(selected.size, "shot")}" aria-label="New tag"></label>`;
    document.body.append(pop);
    const r = (anchor || $("#mergebar")).getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 10) + window.scrollY}px`;
    const close = () => { pop.remove(); document.removeEventListener("pointerdown", away, true); };
    const away = (e) => { if (!pop.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    const inp = $("input", pop);
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
      if (e.key === "Enter" && inp.value.trim()) { const v = inp.value.trim(); close(); act("/api/tags/new", { label: v, photos: [...selected] }, `Tagged ${plural(selected.size, "shot")} ${v}.`); }
    };
    inp.focus();
  }
  function bindSea() {
    const more = $("#more-circles", main);
    if (more) more.onclick = () => Sea.toggle();
    $$("[data-mode]", main).forEach((x) => (x.onclick = () => setMode(x.dataset.mode)));
    $("#g-undo").onclick = () => drawUndo(() => load(true));
    $$("[data-sel-act]", main).forEach((x) => (x.onclick = () => selAct(x.dataset.selAct, x)));
    $("#tag-tray").onclick = (e) => tagTray(e.currentTarget);
    if ($("#d-auto")) $("#d-auto").onclick = async () => {
      $("#d-auto").disabled = true;
      await act("/api/draw/auto", {}, "Grouped.", true);
    };
  }
  const tiles = (list) => shotTiles(list, selected);
  const more = (key, g) => (g.count > g.shots.length ? `<button class="btn ghost more" data-more="${key}">Show all ${fmt(g.count)}</button>`
    : full.has(key) && g.count > 24 ? `<button class="btn ghost more" data-less="${key}">Show fewer</button>` : "");
  function render() {
    const left_ = b.unsorted.count;
    const opts = (id) => b.groups.filter((g) => g.id !== id).map((g) => `<option value="${g.id}">${esc(g.emoji)} ${esc(g.name)}</option>`).join("");
    main.innerHTML = `
      <div class="screen sorter">
        <div class="screen-head">
          <h1>🗂️ Groups</h1>
          <span class="stat-chip" title="Shots in a group">${ring(b.total ? b.drawn / b.total : 0)}<b>${fmt(b.drawn)}</b>/ ${fmt(b.total)} grouped · ${plural(b.groups.length, "group")}</span>
          <span class="grow"></span>
          ${viewToggle()}
          ${left_ ? `<button class="btn" id="d-auto" title="Groups everything that's left for you (rename, merge or dissolve after)">✨ Auto-group the rest</button>` : ""}
          ${helpBtn(`Every shot goes into a <b>themed group</b>; each group then plays its own mini-tournament.<br><br>
            <b>Move</b>: drag photos into a section or onto a group on the right, or click to select some and press the group's
            key (1–9, 0 for the 10th, Alt+1… for the 11th on). <b>N</b> makes a new group from the selection, <b>U</b> sends them back to
            Unsorted, <b>M</b> stacks them (same shot), <b>Z</b> undoes.<br><br><b>Edit</b>: click a group's name or emoji;
            🔎 adds words <i>Find more</i> looks for. Drop one photo on another to stack them.`)}
        </div>
        <div class="screen-body sections" id="sections">
            <section class="gsec unsorted" id="gsec--1" data-drop-group="none">
              <header class="gsec-head"><span class="gsec-title">🗃️ <b>Unsorted</b></span><span class="muted small">${plural(left_, "shot")}</span>
                ${left_ ? `<span class="gsec-actions"><a class="btn" href="#draw?sort=1">🎮 Quick sort these</a></span>` : ""}</header>
              ${left_ ? `<div class="lookgrid gsec-tiles">${tiles(b.unsorted.shots)}</div>${more(-1, b.unsorted)}`
                : `<p class="muted small gsec-empty">Nothing left unsorted. 🎉</p>`}
            </section>
            ${b.groups.map((g, i) => `
            <section class="gsec" id="gsec-${g.id}" data-drop-group="${g.id}">
              <header class="gsec-head">
                <span class="gsec-order"><button class="icon ${i ? "" : "invisible"}" data-order-up="${g.id}" ${i ? "" : `tabindex="-1"`} title="Earlier in your order" aria-label="Move earlier">▲</button>
                  <button class="icon ${i < b.groups.length - 1 ? "" : "invisible"}" data-order-down="${g.id}" ${i < b.groups.length - 1 ? "" : `tabindex="-1"`} title="Later in your order" aria-label="Move later">▼</button></span>
                <span class="bin-n" title="Select photos and press ${groupKeyLabel(i) || "drag them here"}">${groupKeyLabel(i) || "·"}</span>
                <button class="t-emoji gsec-emoji" data-emoji-for="${g.id}" title="Change the emoji" aria-label="Change the emoji">${esc(g.emoji || "🗂️")}</button>
                <span class="gsec-title"><button class="t-name" data-rename="${g.id}" title="Rename">${esc(g.name)}</button></span>
                <span class="muted small">${plural(g.size, "shot")}${g.tagline ? ` · ${esc(g.tagline)}` : ""}</span>
                <button class="linkish small" data-hint="${g.id}" title="Words Find more looks for">🔎 ${g.hint ? `<b>${esc(g.hint)}</b>` : "look for…"}</button>
                <span class="gsec-actions">
                  ${left_ ? `<a class="btn" href="#draw?play=${g.id}" title="Deals the unsorted shots likeliest to belong here">🎮 Find more</a>` : ""}
                  ${b.groups.length > 1 ? `<select data-merge="${g.id}" aria-label="Merge this group into another"><option value="">Merge into…</option>${opts(g.id)}</select>` : ""}
                  <button class="btn ghost danger" data-dissolve="${g.id}" title="Put its shots back in the unsorted pile">Dissolve</button></span>
              </header>
              ${g.count ? `<div class="lookgrid gsec-tiles">${tiles(g.shots)}</div>${more(g.id, g)}` : `<p class="muted small gsec-empty">Empty: drag photos here.</p>`}
            </section>`).join("")}
        </div>
        <aside class="screen-rail bins-wrap" aria-label="Groups"><div class="bins-head"><b>Groups</b>
          <span class="muted small">drag photos here, or select some and press a number</span></div><div class="bins" id="bins"></div></aside>
        <div class="screen-bar action-bar" id="mergebar">
          <div class="bar-left"><a class="btn ghost" id="groups-tag-lab" href="#tags">🏷️ Tag lab</a><span id="sel-count" class="muted small"></span></div>
          <div class="bar-mid">
            <button class="btn ghost" data-sel-act="clear"><kbd>Esc</kbd> Clear</button>
            <button class="btn" data-sel-act="inspect">Grab selected</button>
            <button class="btn" data-sel-act="unsort"><kbd>U</kbd> Unsorted</button>
            <button class="btn" data-sel-act="stack" title="They're the same shot: one stack">Stack them</button>
            <button class="btn" data-sel-act="new"><kbd>N</kbd> New group</button>
            <button class="btn ghost" id="g-undo" ${b.undo ? "" : "hidden"} title="Take back your last change (Z)"><kbd>Z</kbd> <span class="desktop-label">${b.undo ? `Undo ${DRAW_WORD[b.undo] || b.undo}` : "Undo"}</span><span class="phone-label">Undo</span></button>
          </div>
          <div class="bar-right">${left_ ? `<a class="btn primary big" href="#draw?sort=1">🎮 Quick sort <span class="btn-sub">${fmt(left_)} left</span> <kbd>Enter</kbd></a>` : ""}</div>
        </div>
      </div>`;
    forwardState();
    $("#bins").innerHTML = binsHtml(b.bins, null, null);
    bind();
    updateSelection();
    sizeFamilies();
  }
  function sizeFamilies() {  // a look-alike box spans as many grid columns as it has shots (up to a full row)
    $$(".gsec-tiles", main).forEach((grid) => {
      const cols = Math.max(1, Math.floor((grid.clientWidth + 12) / 162));
      $$(".fam-tiles", grid).forEach((f) => {
        const k = Math.min(f.querySelectorAll(":scope > .tile").length, cols);
        f.style.gridColumn = `span ${k}`;
        f.style.gridTemplateColumns = `repeat(${k}, minmax(0, 1fr))`;
      });
    });
  }
  const onResize = () => (left(view) ? window.removeEventListener("resize", onResize) : sizeFamilies());
  window.addEventListener("resize", onResize, { signal: S.events.signal });
  function updateSelection(anchor = null) {
    const lab=$("#groups-tag-lab",main);if(lab)lab.hidden=selected.size>0;
    $$("[data-sel]", main).forEach((el) => {
      const on = selected.has(Number(el.dataset.sel));el.classList.toggle("picked", on);
      const button=$(".shot-select",el),mark=$(".shot-selected",el);
      button?.setAttribute("aria-pressed",on);if(mark)mark.hidden=!on;
    });
    const bar = $("#mergebar");
    const movable=World.groupSelection([...selected],b.cup);
    $("#sel-count").innerHTML = selected.size ? `<b>${plural(selected.size, "photo")} selected</b><span class="selection-help">${movable.length ? ` · ${plural(movable.length,"shot")} can move to a group` : " · grab them or edit their tags"}</span>`
      : sea ? "Click a group to focus · select photos to move them" : "Click photos to select them, or drag one straight to a group";
    $$("[data-sel-act]", bar).forEach((x) => { x.hidden = !selected.size || (x.dataset.selAct === "stack" && selected.size < 2)
      || (["new","unsort"].includes(x.dataset.selAct) && !movable.length); });
    if (sea) sea.select([...selected]);
    // Selection actions can grow the phone bar; keep the print just chosen in the remaining play area.
    else if(anchor&&selected.has(Number(anchor.dataset.sel)))$(".shot-select",anchor)?.scrollIntoView({block:"nearest",inline:"nearest"});
  }
  async function act(path, payload, msg, cheer) {
    if (busy) return;
    busy = true;
    try {
      const r=await api(path, payload);if(left(view))return;
      if(path==="/api/draw/auto")msg=`Placed ${plural(r.placed,"shot")} in ${plural(r.groups,"new group")}.`;
      if(path!=="/api/groups/merge")toast(`${msg} Z undoes it.`);
    } catch (e) { if(!left(view))toast(e.message); busy = false; return; }
    if (cheer) Sound.play("great"); else Sound.play("pick");
    selected.clear();
    busy = false;
    await load(true,path==="/api/groups/split"?{split:Number(payload.photo)}:null);
    refreshHud(true);
    if (/\/(merge|move|new)$/.test(path)) gameCheck();
  }
  const groupName = (id) => { const g = b.groups.find((x) => x.id === id); return g ? `${g.emoji} ${g.name}` : "that group"; };
  const moveTo = (photos, target) => {
    const reps=World.groupSelection(photos,b.cup);if(!reps.length)return;
    return target === "new" ? act("/api/draw/new", { photos: reps }, `New group from ${plural(reps.length, "shot")}.`, true)
      : act("/api/draw/move", { photos: reps, theme: target === "none" ? null : Number(target) },
        target === "none" ? "Back in the unsorted pile." : `${plural(reps.length,"shot")} into ${groupName(Number(target))}.`);
  };
  const expand = (rep, btn) => {
    openedStack=btn.closest(".tile").classList.contains("open")?null:byRep.get(rep);
    expandStack(main,byRep.get(rep),btn,b.boxes);
  };
  function bind() {
    $$("[data-mode]", main).forEach((x) => (x.onclick = () => setMode(x.dataset.mode)));
    $("#g-undo").onclick = () => drawUndo(() => load(true));
    if ($("#d-auto")) $("#d-auto").onclick = async () => {
      const btn = $("#d-auto");
      btn.disabled = true;
      btn.textContent = "Grouping…";
      await act("/api/draw/auto", {}, "Grouped.", true);
      confetti(window.innerWidth / 2, window.innerHeight / 3, 50);
    };
    $$("[data-sel-act]", main).forEach((x) => (x.onclick = () => selAct(x.dataset.selAct, x)));
    $$("[data-bin]", $("#bins")).forEach((x) => (x.onclick = () => {
      if (selected.size) moveTo([...selected], x.dataset.bin);
      else if (x.dataset.bin !== "new") $(`#gsec-${x.dataset.bin}`)?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
      else toast("Select some photos first, then press N (or drag a photo onto New group).");
    }));
    const page = $(".sorter", main);
    page.onclick = (e) => {
      const ord = e.target.closest("[data-order-up],[data-order-down]");
      if (ord) {
        e.stopPropagation();
        const id = Number(ord.dataset.orderUp || ord.dataset.orderDown), ids = moveInOrder(b.groups.map((x) => x.id), id, ord.dataset.orderUp ? -1 : 1);
        if (ids) saveOrder(ids).then((ok) => ok && load(true));
        return;
      }
      const t = e.target.closest("[data-expand],[data-keep],[data-split],[data-unstack],[data-reset],[data-view],[data-more],[data-less],[data-rename],[data-emoji-for],[data-hint],[data-dissolve]");
      if (t) {
        e.stopPropagation();
        if (t.dataset.expand) return expand(Number(t.dataset.expand), t);
        if (t.dataset.keep) return act("/api/frame", { photo: Number(t.dataset.keep) }, "That take now stands in for the stack.");
        if (t.dataset.split) return act("/api/groups/split", { photo: Number(t.dataset.split) }, "Split out; it's its own shot now.");
        if (t.dataset.unstack) return act("/api/groups/unstack", { photo: Number(t.dataset.unstack) }, "Split apart into separate shots.");
        if (t.dataset.reset) return act("/api/groups/reset", { photos: [Number(t.dataset.reset)] }, "Back to automatic stacking.");
        if (t.dataset.view) return openViewer(Number(t.dataset.view));
        if (t.dataset.more) { full.add(Number(t.dataset.more)); return load(true); }
        if (t.dataset.less) { full.delete(Number(t.dataset.less)); return load(true); }
        const id = Number(t.dataset.rename || t.dataset.emojiFor || t.dataset.hint || t.dataset.dissolve);
        const g = b.groups.find((x) => x.id === id);
        if (t.dataset.rename) return inlineRename(t, g.name, (name) => (name ? act("/api/draw/rename", { theme: id, name }, "Renamed.") : render()));
        if (t.dataset.emojiFor) return emojiPicker(t, (emoji) => act("/api/draw/rename", { theme: id, emoji }, "New emoji."));
        if (t.dataset.hint) return inlineRename(t, g.hint || "", (hint) => (hint !== null ? act("/api/draw/hint", { theme: id, hint }, hint ? "Find more will look for that." : "Cleared.") : render()),
          { cls: "hint-input", max: 120, label: "What to look for", placeholder: "laptops, screens, desks", empty: true });
        if (t.dataset.dissolve) {
          act("/api/draw/dissolve", { theme: id }, "Dissolved. Z undoes it.");
          return;
        }
      }
      const sel = e.target.closest("[data-sel]");
      if (sel && !e.target.closest("a, .tile-frames")) { const r = Number(sel.dataset.sel); selected.has(r) ? selected.delete(r) : selected.add(r); updateSelection(sel); }
    };
    page.onchange = (e) => {
      const m = e.target.closest("[data-merge]");
      if (!m || !m.value) return;
      const from = Number(m.dataset.merge), into = Number(m.value);
      act("/api/draw/merge", { from, into }, "Merged. Z undoes it.");
    };
    page.onkeydown = (e) => {  // tiles are buttons: Enter or Space selects one
      const sel = e.target.closest(".tile[data-sel]");
      if (sel && e.target === sel && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sel.click(); }
    };
    let drag = null;
    const zone = (el) => el.closest("[data-drop]") || el.closest("[data-bin]") || el.closest("[data-drop-group]");
    page.ondragstart = (e) => {
      const el = e.target.closest && e.target.closest("[data-drag-frame],[data-drag-shot]");
      if (!el) return;
      const id = Number(el.dataset.dragFrame || el.dataset.dragShot);
      drag = el.dataset.dragFrame ? { kind: "frame", id } : { kind: "shot", id, reps: selected.has(id) ? [...selected] : [id] };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(id));
      el.classList.add("dragging");
      document.body.classList.add("is-dragging");
    };
    page.ondragend = () => {
      $$(".dragging, .drop-hot, .hot", main).forEach((x) => x.classList.remove("dragging", "drop-hot", "hot"));
      document.body.classList.remove("is-dragging");
    };
    page.ondragover = (e) => {
      if (!drag) return;
      const z = zone(e.target);
      if (!z || (z.dataset.drop && drag.kind === "shot" && drag.reps.includes(Number(z.dataset.drop)))) return;
      if (z.dataset.bin === "new" && drag.kind === "frame") return;
      e.preventDefault();
      $$(".drop-hot, .hot", main).forEach((x) => x !== z && x.classList.remove("drop-hot", "hot"));
      z.classList.add(z.dataset.bin ? "hot" : "drop-hot");
    };
    page.ondrop = async (e) => {
      const d = drag, z = d && zone(e.target);
      drag = null;
      if (!z) return;
      e.preventDefault();
      z.classList.remove("drop-hot", "hot");
      const r = z.getBoundingClientRect();
      if (z.dataset.drop) {  // onto a shot: same shot, one stack (and it joins that shot's group)
        confetti(r.left + r.width / 2, r.top + Math.min(r.height, 200) / 2, 24);
        if (d.kind === "frame") return act("/api/groups/move", { photo: d.id, target: Number(z.dataset.drop) }, "Moved into that stack.", true);
        return act("/api/groups/merge", { photos: [...d.reps, Number(z.dataset.drop)] }, "Stacked: same shot, one stack.", true);
      }
      if (d.kind === "frame") { toast("Drop a take onto another shot to move it there."); return; }
      moveTo(d.reps, z.dataset.bin || z.dataset.dropGroup);
    };
  }
  function selAct(a, el) {
    const reps = [...selected];
    if (a === "clear") { selected.clear(); return updateSelection(); }
    if (!reps.length) return;
    if (a === "inspect") return World.inspect(reps[0], reps, () => load(true));
    if (a === "tag") return tagSelection(el);
    if (a === "unsort") return moveTo(reps, "none");
    if (a === "new") return moveTo(reps, "new");
    if (a === "stack" && reps.length > 1) return act("/api/groups/merge", { photos: reps }, "Stacked: same shot, one stack.", true);
  }
  S.onKey = (e) => {
    if (e.repeat || !b) return;
    const k = e.key;
    const gi = groupKey(e);
    if (gi != null) { e.preventDefault(); if (b.bins[gi]) { if (selected.size) moveTo([...selected], String(b.bins[gi].id)); else focusGroup(b.bins[gi].id); } return; }
    else if (k === "Escape" && selected.size) { e.preventDefault(); selAct("clear"); }
    else if (k === "Escape" && sea && !sea.focusBar.hidden) { e.preventDefault(); $("[data-clear-focus]", sea.focusBar)?.click(); }
    else if ((k === "n" || k === "N") && selected.size) { e.preventDefault(); selAct("new"); }
    else if ((k === "m" || k === "M") && selected.size > 1) { e.preventDefault(); selAct("stack"); }
    else if ((k === "u" || k === "U") && selected.size) { e.preventDefault(); selAct("unsort"); }
    else if ((k === "t" || k === "T") && selected.size) { e.preventDefault(); selAct("tag", $("[data-sel-act=tag]", main)); }
    else if (["z", "Z", "Backspace"].includes(k)) { e.preventDefault(); drawUndo(() => load(true)); }
  };
  main.innerHTML = LOADING();
  await load();
}

// Find more (a minigame for one group): it deals the unsorted shots likeliest to belong to this group first, and each
// one gets a home on the spot: this group (→), any other group (its number, or drag it onto the bin), or a new group
// (N). Same layout as every game screen: the group up top, the card in the middle with every group's bin beside it,
// the action bar at the bottom with the way forward always on its right.
async function drawPlay(main, tid) {
  const view = S.view;
  let deck = null, theme = null, busy = false, roll = 0, shownAt = 0, ticks = null, mode = "card", stay = 0;
  const nobulk = new Set();
  history.replaceState(null, "", `#draw?play=${tid}`);
  async function load() {
    if (left(view)) return;
    try { deck = await api(`/api/draw/deck?theme=${tid}&n=10${nobulk.size ? `&nobulk=${[...nobulk].slice(-200).join(",")}` : ""}`); } catch (e) {
      if (left(view)) return;
      if (e.status === 404 || e.status === 400) { location.hash = "#draw"; return; }
      main.innerHTML = FAILED(e.message);
      return;
    }
    if (left(view)) return;
    theme = deck.theme;
    ticks = deck.bulk.length ? new Set(deck.bulk.map((c) => c.photo)) : null;
    preload(deck.cards.slice(0, 3).map((c) => ({ type: "duel", a: c.photo, b: c.photo })));
    if (!$("#ddeck", main)) paint();
    else { paintHead(); paintCrew(); showCard(); }
  }
  async function refill() {
    if (left(view)) return;
    try {
      const d = await api(`/api/draw/deck?theme=${tid}&n=10${nobulk.size ? `&nobulk=${[...nobulk].slice(-200).join(",")}` : ""}`);
      if (left(view)) return;
      const have = new Set(deck.cards.map((c) => c.photo));
      deck.left = d.left;
      deck.bins = d.bins;
      deck.cards = deck.cards.concat(d.cards.filter((c) => !have.has(c.photo)));
      if (!deck.cards.length && d.bulk.length) { deck.bulk = d.bulk; ticks = new Set(d.bulk.map((c) => c.photo)); }
      if (mode === "thin" || (!deck.cards.length && !deck.bulk.length)) showCard();
      else paintBins();
    } catch (_) { /* the next call retries */ }
  }
  function paint() {
    if (left(view)) return;
    main.innerHTML = `
      <div class="screen draw-play">
        <div class="screen-head play-head" id="t-head"></div>
        <div class="screen-body fill"><div class="deck" id="ddeck"></div></div>
        <aside class="screen-rail bins-wrap" aria-label="Groups"><div class="bins-head"><b>Groups</b>
          <span class="muted small">↑ ↓</span></div><div class="bins" id="bins"></div></aside>
        <div class="screen-bar action-bar" id="dctl"></div>
      </div>`;
    paintHead();
    showCard();
  }
  function paintHead() {
    if (left(view)) return;
    const h = $("#t-head");
    h.innerHTML = `
      <span class="muted small play-kind">🎮 Find more</span>
      <button class="t-emoji play-emoji" id="t-emoji" title="Change the emoji" aria-label="Change the emoji">${esc(theme.emoji || "🗂️")}</button>
      <h1><button class="t-name" id="t-name" title="Rename">${esc(theme.name)}</button></h1>
      <button class="icon" id="t-roll" title="Another name (R)" aria-label="Another name">🎲</button>
      <span class="stat-chip"><b>${fmt(theme.size)}</b> in · ${fmt(deck.left)} unsorted</span>
      <button class="linkish small" id="t-hint" title="Words it should look for: it deals photos that match them first">🔎 ${theme.hint
        ? `Looking for <b>${esc(theme.hint)}</b>` : "Tell it what to look for"}</button>
      <div class="crew grow" id="crew" aria-label="In this group so far"></div>
      <a class="btn" href="#draw?g=${tid}" title="Back to the Groups page">Done</a>
      ${helpBtn(`It deals the unsorted photos <b>likeliest to belong to this group</b> first, and every one gets a home on the spot:
        <b>→</b> this group, <b>a number</b> (or drag it onto a group on the right) for another, <b>N</b> for a new group.
        <b>↑</b> stacks a photo with a near-twin already in the group. <b>🔎</b> words steer what comes first. <b>Z</b> undoes, <b>Esc</b> opens the pause menu.`)}`;
    paintCrew();
    $("#t-name").onclick = (e) => inlineRename(e.currentTarget, theme.name, async (name) => {
      if (name) {
        try { theme = { ...theme, ...(await api("/api/draw/rename", { theme: tid, name })).theme }; } catch (err) { toast(err.message); }
        if (!theme.hint) return load();  // a name of yours steers the deal too
      }
      paintHead();
    });
    $("#t-hint").onclick = (e) => inlineRename(e.currentTarget, theme.hint || "", async (hint) => {
      if (hint !== null) {
        toast(hint ? `Looking for ${hint}…` : "Back to looks alone.");
        try { theme = { ...theme, ...(await api("/api/draw/hint", { theme: tid, hint })).theme }; } catch (err) { toast(err.message); }
        stay = 0;
        return load();
      }
      paintHead();
    }, { cls: "hint-input", max: 120, label: "What to look for", placeholder: "laptops, screens, desks", empty: true });
    $("#t-emoji").onclick = (e) => emojiPicker(e.currentTarget, async (emoji) => {
      try { theme = { ...theme, ...(await api("/api/draw/rename", { theme: tid, emoji })).theme }; } catch (err) { toast(err.message); return; }
      Sound.play("pick");
      paintHead();
      paintBins();
    });
    $("#t-roll").onclick = reroll;
  }
  function paintCrew() {
    if (left(view)) return;
    $("#crew").innerHTML = deck.members.map((id) => `<img src="${T(id)}" alt="" data-crew="${id}">`).join("");
  }
  function paintBins() {
    if (left(view)) return;
    const c = mode === "card" || mode === "pick" ? deck.cards[0] : null;
    const box = $("#bins");
    box.innerHTML = binsHtml(deck.bins.map((b) => (b.id === tid ? { ...b, name: theme.name, emoji: theme.emoji } : b)), tid, c && c.fits);
    box.classList.toggle("picking", mode === "pick");
    box.classList.toggle("idle", !c);
    $$(".bin-place",box).forEach((button)=>button.hidden=!c);
    $$("[data-bin]", box).forEach((b) => (b.onclick = (e) => {
      const g = deck.bins.find((x) => String(x.id) === b.dataset.bin);
      if (g && binTools(e, b, g.id === tid ? { ...g, name: theme.name } : g, () => (g.id === tid ? load() : paintBins()))) return;
      if (c) place(b.dataset.bin);
    }));
    sortableBins(box, deck.bins.map((b) => b.id), (ids) => { deck.bins.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); paintBins(); });
    if (mode === "pick") paintPick();  // (keep the ↑/↓ highlight through a redraw)
  }
  // The bar always has three slots: back / elsewhere (left), the in-betweens, forward (right).
  function bar(left_, middle, right, hint) {
    const btn = (b) => (!b ? "<span></span>" : `<button class="btn big ${b.cls || ""}" data-c="${b.c}">${b.label}</button>`);
    $("#dctl").innerHTML = `<div class="bar-left">${btn(left_)}</div>
      <div class="bar-mid">${middle.map((b) => `<button class="btn ${b.cls || "ghost"}" data-c="${b.c}">${b.label}</button>`).join("")}</div>
      <div class="bar-right">${btn(right)}</div>`;
    $("#dctl").title = "WASD or arrows · Space skips · Z undoes · X tosses";
    $$("[data-c]", $("#dctl")).forEach((b) => (b.onclick = () => command(b.dataset.c)));
  }
  const UNDO = { c: "undo", label: "<kbd>Z</kbd> Undo" };
  const SKIP = { c: "skip", label: "<kbd>Space</kbd> Skip" };
  const NEW = { c: "new", label: "<kbd>N</kbd> New group" };
  function command(c) {
    ({ undo, skip, toss, roll: reroll, done, dig: keepDigging, pick: startPick, cancel: cancelPick, new: () => place("new"), aim: pickAim,
      bulkin: () => bulk(true), onebyone: () => bulk(false), in: () => act("in"), twin: () => act("twin"),
      next: () => (location.hash = "#duel?stage=stacks") }[c] || (() => {}))();
  }
  function done() { location.hash = `#draw?g=${tid}`; }
  function showCard() {
    if (left(view)) return;
    const box = $("#ddeck");
    if (!box) return;
    if (deck.bulk.length) {
      mode = "bulk";
      box.innerHTML = `<div class="bulk-card"><div class="bulk-head"><b>⚡ ${plural(deck.bulk.length, "sure thing")}</b>
        <span class="muted small">These look just like the group. Untick any that don't belong: they come back one by one.</span></div>
        <div class="bulk-grid">${deck.bulk.map((c) => `<button class="bulk-tile ${ticks.has(c.photo) ? "on" : ""}" data-tick="${c.photo}"
          aria-pressed="${ticks.has(c.photo)}"><img src="${T(c.photo)}" alt=""><span class="tick">✓</span></button>`).join("")}</div></div>`;
      $$("[data-tick]", box).forEach((b) => (b.onclick = () => {
        const id = Number(b.dataset.tick);
        ticks.has(id) ? ticks.delete(id) : ticks.add(id);
        b.classList.toggle("on", ticks.has(id));
        b.setAttribute("aria-pressed", ticks.has(id));
      }));
      bar({ c: "onebyone", label: "<kbd>←</kbd> One by one" }, [UNDO], { c: "bulkin", cls: "keep-btn", label: "Add the ticked ones <kbd>→</kbd>" },
        "Tap a photo to untick it.");
      return paintBins();
    }
    const c = deck.cards[0];
    if (!c || (stay >= 6 && c.long)) {
      mode = "thin";
      box.innerHTML = `<div class="deck-note"><span class="big-emoji">${c ? "🧐" : "🏁"}</span>
        <b>${c ? "Looks like that's the crew" : "Everything's sorted"}</b>
        <span class="muted">${c ? "The rest look like long shots for this group." : "No unsorted shots left."}
          ${esc(theme.name)} has ${plural(theme.size, "shot")}.</span></div>`;
      bar(c ? { c: "dig", label: "<kbd>←</kbd> Keep sorting" } : { c: "done", label: "The Groups page" }, [UNDO],
        c ? { c: "done", cls: "primary", label: "Done <kbd>→</kbd>" } : { c: "next", cls: "primary", label: "Next: crown the stacks <kbd>→</kbd>" });
      return paintBins();
    }
    mode = "card";
    const nx = deck.cards[1];
    box.innerHTML = `${nx ? `<div class="swipe-card under"><div class="print"><img src="${P(nx.photo)}" alt="" draggable="false"></div></div>` : ""}
      <div class="swipe-card top" id="dtop" data-photo="${c.photo}" data-box='${JSON.stringify((c.view || {}).box || null)}'><div class="print"><img src="${P(c.photo)}" alt="Which group does this belong in?" draggable="false"></div>
        ${c.long ? `<span class="why kept">Long shot for this group</span>` : ""}
        ${c.twin ? `<div class="twin-ask"><img src="${T(c.twin.of)}" alt=""><span><b>Same shot as this one?</b>
          ${c.twin.apart != null ? `${c.twin.apart < 120 ? `${c.twin.apart} s` : c.twin.apart < 7200 ? `${Math.round(c.twin.apart / 60)} min` : `${Math.round(c.twin.apart / 3600)} h`} apart · ` : ""}↑ stacks them</span></div>` : ""}
        <span class="stamp keep">IN</span></div>`;
    carryable($("#dtop"), { right: () => act("in"), left: startPick, up: c.twin ? () => act("twin") : null, drop: place });
    bar({ c: "pick", label: "<kbd>←</kbd> Another group" },
      [...(c.twin ? [{ c: "twin", cls: "twin-btn", label: "<kbd>↑</kbd> Same shot" }] : []), SKIP, UNDO],
      { c: "in", cls: "keep-btn", label: `Into this group <kbd>→</kbd>` },
      "Every photo gets a group: → or Enter for this one, ← to pick another (or its key, or a drag), N for a new one. Esc opens the pause menu.");
    paintBins();
    paintFilters();
    shownAt = playTime();
  }
  let pcur = 0;
  function startPick() {
    if (mode !== "card") return;
    mode = "pick";
    Sound.play("whoop");
    const fit = deck.cards[0].fits[0];
    pcur = Math.max(0, deck.bins.findIndex((b) => b.id === (fit != null ? fit : -1)));
    bar({ c: "cancel", label: "Back" }, [NEW, UNDO], { c: "aim", cls: "keep-btn", label: "Into it <kbd>→</kbd>" },
      `Which group? ↑ ↓ to pick one${fit != null ? " (it starts on the ★ one)" : ""} and → to drop it there, or its number, a drag, N for a new group.`);
    paintBins();
    paintPick();
  }
  function paintPick() {
    const els = $$("#bins [data-bin]");
    els.forEach((el, i) => el.classList.toggle("cursor", mode === "pick" && i === pcur));
    if (mode !== "pick") return;
    if (els[pcur]) els[pcur].scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    const b = deck.bins[pcur], btn = $(".bar-right [data-c=aim]");
    if (btn) btn.innerHTML = b ? `Into ${b.id === tid ? "this group" : "that group"} <kbd>→</kbd>` : "New group <kbd>→</kbd>";
  }
  const pickAim = () => place(pcur < deck.bins.length ? String(deck.bins[pcur].id) : "new");
  function cancelPick() { if (mode === "pick") showCard(); }
  function keepDigging() { stay = -999; Sound.play("whoop"); showCard(); }
  function flyTo(el, target) {
    if (!el || !target || reduceMotion) return;
    const a = el.getBoundingClientRect(), b = target.getBoundingClientRect();
    el.style.transition = "transform 0.28s ease-in, opacity 0.28s";
    el.style.transform = `translate(${b.left + b.width / 2 - (a.left + a.width / 2)}px, ${b.top + b.height / 2 - (a.top + a.height / 2)}px) scale(0.12)`;
    el.style.opacity = "0.2";
  }
  // Somewhere other than this group: another group's bin, or a new group of its own.
  async function place(bin) {
    if (busy || !(mode === "card" || mode === "pick")) return;
    if (Number(bin) === tid) return act("in");
    const c = deck.cards[0];
    if (!c) return;
    busy = true;
    const el = $("#dtop"), target = $(`[data-bin="${bin}"]`);
    flyTo(el, target);
    Sound.play("pick");
    let r;
    try {
      r = bin === "new" ? await api("/api/draw/new", { photos: [c.photo] }) : await api("/api/draw/place", { photo: c.photo, theme: Number(bin) });
    } catch (e) { toast(e.message); busy = false; return load(); }
    if (left(view)) return;
    if (r.game) { Ach.check(r.game); S.game = r.game; }
    if (bin === "new") {
      deck.bins.push({ id: r.theme.id, name: r.theme.name, emoji: r.theme.emoji, size: 1, cover: c.photo });
      toast(`New group: ${r.theme.emoji} ${r.theme.name}. Rename it any time on the Groups page.`);
    } else {
      const b = deck.bins.find((x) => x.id === Number(bin));
      if (b) { b.size++; toast(`Into ${b.emoji} ${b.name}.`, 1400); }
    }
    stay++;
    deck.left = Math.max(0, deck.left - 1);
    deck.cards.shift();
    await sleep(reduceMotion ? 0 : 230);
    if (left(view)) return;
    busy = false;
    paintHead();
    showCard();
    if (deck.cards.length < 4) refill();
  }
  async function act(call) {
    if (busy || !(mode === "card" || mode === "pick")) return;
    const c = deck.cards[0];
    if (!c || (call === "twin" && !c.twin)) return;
    busy = true;
    const el = $("#dtop");
    el.style.transform = "";
    el.classList.add(call === "twin" ? "fly-up" : "fly-right");
    Sound.play(call === "twin" ? "great" : "pick");
    floatText(call === "twin" ? "+5 XP" : "+2 XP", el, call === "twin" ? "bonus" : "");
    const req = api("/api/draw/call", { theme: tid, photo: c.photo, call, twin: c.twin ? c.twin.of : null,
      ms: Math.round(playTime() - shownAt) });
    req.catch(() => {});
    deck.cards.shift();
    stay = 0;
    if (call === "in") { theme.size++; deck.left = Math.max(0, deck.left - 1); deck.members.unshift(c.photo); }
    const b = deck.bins.find((x) => x.id === tid);
    if (b && call === "in") b.size++;
    paintHead();
    paintCrew();
    const img = $(`[data-crew="${call === "twin" ? c.twin.of : c.photo}"]`);
    if (img) img.classList.add("joined");
    await sleep(reduceMotion ? 0 : 170);
    if (left(view)) { await req.catch(() => {}); return; }
    if (call === "twin") {  // the stacking changed: deal again
      try { await req; } catch (e) { if (!left(view)) toast(e.message); busy = false; return load(); }
      if (left(view)) return;
      toastOnce("stacked", "Stacked: same shot, one stack. Z undoes it.");
      busy = false;
      return load();
    }
    showCard();
    try {
      const r = await req;
      if (left(view)) return;
      if (r.game) { Ach.check(r.game); S.game = r.game; }
    } catch (e) { toast(e.message); busy = false; return load(); }
    busy = false;
    if (deck.cards.length < 4) refill();
  }
  async function bulk(yes) {
    if (busy) return;
    busy = true;
    const add = yes ? [...ticks] : [];
    deck.bulk.forEach((c) => { if (!add.includes(c.photo)) nobulk.add(c.photo); });  // unticked ones come back one by one
    try {
      if (add.length) {
        await api("/api/draw/bulk", { theme: tid, add, reject: [] });
        if (left(view)) return;
        Sound.play("great");
        const r = $("#ddeck").getBoundingClientRect();
        confetti(r.left + r.width / 2, r.top + r.height / 3, 30);
        toast(`${plural(add.length, "shot")} added. Z undoes the batch.`);
      }
    } catch (e) { toast(e.message); }
    busy = false;
    deck.bulk = [];
    await load();
  }
  async function reroll() {
    try {
      const r = await api("/api/draw/rename", { theme: tid, roll: ++roll });
      if (left(view)) return;
      theme = { ...theme, ...r.theme };
      Sound.play("whoop");
      paintHead();
      paintBins();
    } catch (e) { toast(e.message); }
  }
  async function skip() {
    if(busy)return;if(mode==="bulk")return bulk(false);
    if(!deck.cards[0]||!["card","pick","thin"].includes(mode))return; busy=true;
    try {if(deck.cards.length<2)await refill();if(left(view))return;
      if(deck.cards.length<2){done();return;}deck.cards.push(deck.cards.shift());stay=-999;Sound.play("skip");showCard();
    } finally {busy=false;}
  }
  async function toss() {
    if(busy||!deck.cards[0]||!["card","pick","thin"].includes(mode))return;busy=true;
    try{await api("/api/draw/toss",{photo:deck.cards[0].photo});if(!left(view)){deck.cards.shift();Sound.play("toss");await load();}}
    catch(error){if(!left(view))toast(error.message);}finally{busy=false;}
  }
  function undo() {
    if (busy) return;
    drawUndo(async (r) => {
      if ((r.created || []).includes(tid)) { location.hash = "#draw"; return; }  // this group itself was the last step
      stay = Math.max(0, stay - 1);
      await load();
    });
  }
  S.onKey = (e) => {
    if (e.repeat) return;
    const k = e.key;
    const gi = groupKey(e);
    if (gi != null) { e.preventDefault(); if ((mode === "card" || mode === "pick") && deck.bins[gi]) place(String(deck.bins[gi].id)); return; }
    if (mode === "pick" && (k === "ArrowUp" || k === "ArrowDown") && e.shiftKey && deck.bins[pcur]) {  // move the group itself
      e.preventDefault();
      const id = deck.bins[pcur].id, ids = moveInOrder(deck.bins.map((b) => b.id), id, k === "ArrowUp" ? -1 : 1);
      if (ids) saveOrder(ids).then((ok) => { if (!ok) return; deck.bins.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); pcur = deck.bins.findIndex((b) => b.id === id); paintBins(); });
      return;
    }
    if (mode === "pick" && (k === "ArrowUp" || k === "ArrowDown")) {
      e.preventDefault();
      pcur = (pcur + (k === "ArrowUp" ? -1 : 1) + deck.bins.length + 1) % (deck.bins.length + 1);
      return paintPick();
    }
    if (mode === "pick" && (k === "ArrowRight" || k === "Enter")) { e.preventDefault(); return pickAim(); }
    if (mode === "pick" && (k === "e" || k === "E") && deck.bins[pcur]) {
      e.preventDefault();
      const g = deck.bins[pcur];
      return renameBin($$("#bins [data-bin]")[pcur], g.id === tid ? { ...g, name: theme.name } : g, () => (g.id === tid ? load() : paintBins()));
    }
    const forward = { thin: deck.cards[0] ? "done" : "next", bulk: "bulkin", pick: null }[mode] ?? "in";
    if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); if (forward) command(forward); }
    else if (k === "Enter") { e.preventDefault(); if (forward) command(forward); }  // Enter confirms, like →
    else if (k === "Escape" && mode !== "pick") { e.preventDefault(); done(); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") {
      e.preventDefault();
      command({ thin: "dig", bulk: "onebyone", pick: "cancel", card: "pick" }[mode] || "");
    } else if (k === "Escape") { if (mode === "pick") { e.preventDefault(); cancelPick(); } }
    else if (k === "ArrowUp" || k === "w" || k === "W") { e.preventDefault(); act("twin"); }
    else if (k === "n" || k === "N") { if (mode === "card" || mode === "pick") { e.preventDefault(); place("new"); } }
    else if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); undo(); }
    else if (k === "r" || k === "R") { e.preventDefault(); reroll(); }
    else if (k === " ") { e.preventDefault(); skip(); }
    else if (k.toLowerCase() === "x") { e.preventDefault(); toss(); }
    else if (k === "f" || k === "F") { e.preventDefault(); toggleFilter(); }
  };
  main.innerHTML = LOADING("Dealing…");
  await load();
}

// Quick sort (the Groups minigame): the unsorted shots one at a time, each straight into the group it looks most like
// (→, the ★ one), another (its number, or drag it onto the bin), or a new group of its own (N). Same layout as every
// game screen.
async function drawQuickSort(main) {
  const view = S.view;
  let cards = [], bins = [], busy = false, left_ = 0, cur = 0;
  const resolved = new Set();
  const called = { right: 0, total: 0, combo: 0, last: 0 };  // the ★ guess, and placements in quick succession
  const aimed = () => (cur < bins.length ? String(bins[cur].id) : "new");
  function paintCursor() {
    if (left(view)) return;
    $$("#bins [data-bin]", main).forEach((el, i) => el.classList.toggle("cursor", i === cur));
    const el = $$("#bins [data-bin]", main)[cur];
    if (el) el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    const b = bins[cur], btn = $("[data-c=star]", main) || $(".bar-right [data-c=new]", main);
    if (btn) btn.innerHTML = b ? "Into this group <kbd>→</kbd>" : "New group <kbd>→</kbd>";
  }
  async function load(render = true) {
    if (left(view)) return;
    let fresh;
    try { fresh = await api("/api/draw/stragglers"); } catch (e) {
      if (!left(view)) main.innerHTML = FAILED(e.message);
      return;
    }
    if (left(view)) return;
    bins = fresh.bins; left_ = fresh.left;
    const pending = new Map(fresh.cards.map(c => [c.photo, c])), next = [];
    const take = id => { if (pending.has(id)) { next.push(pending.get(id)); pending.delete(id); } };
    // Reload hints without undoing a skip. An undone placement or toss comes back to the front.
    for (const c of fresh.cards) if (resolved.delete(c.photo)) take(c.photo);
    for (const c of cards) take(c.photo);
    cards = [...next, ...pending.values()];
    if (render) paint();
    return true;
  }
  function paint(selected = null) {
    if (left(view)) return;
    const gone = World.grab(main);
    paintCard(selected);
    World.swap(main, gone);
  }
  function paintCard(selected) {
    const c = cards[0];
    World.calm(false); setForward(null);
    if (!c) {
      main.innerHTML = `
        <div class="screen draw-play no-rail">
          <div class="screen-head play-head"><h1>🎮 Quick sort</h1><span class="stat-chip good"><b>0</b> unsorted · ${plural(bins.length, "group")}</span></div>
          <div class="screen-body fill">${stageClearHtml({ icon: "🗂️", title: "Everything's grouped", bonusKey: "draw",
            text: "Every shot has a group. Next, the stacks crown their best takes, then each group plays its own mini-tournament.",
            photos: bins.map((g) => g.cover).filter(Boolean).slice(0, 8), summary: `${plural(bins.length, "team")} ready for the group stage.` })}</div>
          <div class="screen-bar action-bar">${clearActionsHtml({ back: ["#draw", "The Groups page"], undo: "Undo the last one", undoAttr: 'data-c="undo"' })}</div>
        </div>`;
      $("[data-c=undo]", main).onclick = undo;
      setForward(groupStageForward());
      Sound.play("crown"); confetti(window.innerWidth / 2, window.innerHeight / 3, 60); World.calm(true);
      setHint("Enter continues to Crown. Z undoes the last one.");
      fillStageBonus("draw", main);
      return;
    }
    const star = c.options[0];
    main.innerHTML = `
      <div class="screen draw-play">
        <div class="screen-head play-head">
          <h1>🎮 Quick sort</h1>
          <span class="stat-chip"><b>${fmt(left_)}</b> unsorted · ${plural(bins.length, "group")}</span>
          ${called.total ? `<span class="stat-chip ${called.right / called.total >= 0.7 ? "good" : ""}" title="How often its ★ guess was the group you picked">★ called it <b>${called.right}</b>/${called.total}</span>` : ""}
          ${called.combo >= 3 ? `<span class="stat-chip good">🔥 ×<b>${called.combo}</b></span>` : ""}
          <span class="grow"></span>
          <a class="btn" href="#draw" title="Back to the Groups page">Done</a>
          ${helpBtn(`The unsorted photos one at a time, in the order they were taken. <b>→</b> puts it in the group it looks most like
            (★), <b>a number</b> or a drag onto a group puts it in another, <b>N</b> starts a new group with it (it gets a name you can
            change on the Groups page), <b>←</b> sets it aside (out of the running; Z brings it back). <b>↑</b> / <b>↓</b> walk the groups, <b>E</b> renames the
            highlighted one. <b>Space</b> skips it until later. <b>Z</b> undoes, <b>Esc</b> opens the pause menu.`)}
        </div>
        <div class="screen-body fill"><div class="deck"><div class="swipe-card top" id="dtop" data-photo="${c.photo}" data-box='${JSON.stringify((c.view || {}).box || null)}'><div class="print"><img src="${P(c.photo)}" alt="Which group does this belong in?" draggable="false"></div><span class="stamp toss">SET ASIDE</span></div></div></div>
        <aside class="screen-rail bins-wrap" aria-label="Groups"><div class="bins-head"><b>Groups</b>
          <span class="muted small">↑ ↓</span></div>
          <div class="bins" id="bins">${binsHtml(bins, null, c.options.map((o) => o.id))}</div></aside>
        <div class="screen-bar action-bar"><div class="bar-left"><button class="btn ghost toss-btn" data-c="toss" title="Out of the running: it goes to Set aside (Z undoes)"><kbd>←</kbd> Set aside</button>
          <button class="btn ghost" data-c="skip" title="Leave this take for later"><kbd>Space</kbd> Skip</button></div>
          <div class="bar-mid"><button class="btn ghost" data-c="new"><kbd>N</kbd> New group</button><button class="btn ghost" data-c="undo"><kbd>Z</kbd> Undo</button></div>
          <div class="bar-right">${star ? `<button class="btn big keep-btn" data-c="star">Into this group <kbd>→</kbd></button>`
            : `<button class="btn big keep-btn" data-c="new">New group <kbd>→</kbd></button>`}</div>
        </div>
      </div>`;
    cur = selected === "new" ? bins.length : selected != null ? Math.max(0, bins.findIndex(b => String(b.id) === selected))
      : star ? Math.max(0, bins.findIndex((b) => b.id === star.id)) : bins.length;  // ↑/↓ walk the groups from the ★ one
    carryable($("#dtop"), { right: () => place(aimed()), left: toss, drop: (b) => place(b) });
    $$("[data-bin]", main).forEach((b) => (b.onclick = (e) => {
      const g = bins.find((x) => String(x.id) === b.dataset.bin);
      if (g && binTools(e, b, g, paint)) return;
      place(b.dataset.bin);
    }));
    $$("[data-c=new]", main).forEach((x) => (x.onclick = () => place("new")));
    $("[data-c=toss]", main).onclick = toss;
    if ($("[data-c=skip]", main)) $("[data-c=skip]", main).onclick = skip;
    $("[data-c=undo]", main).onclick = undo;
    if ($("[data-c=star]", main)) $("[data-c=star]", main).onclick = () => place(aimed());
    sortableBins($("#bins", main), bins.map((b) => b.id), (ids) => { bins.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); paint(); });
    paintCursor();
    paintFilters();
  }
  async function skip() {
    if (busy || !cards[0]) return;
    if (left_ < 2) { location.hash="draw"; return; }
    busy = true;
    const selected = aimed();
    try {
      // The last card of a dealt batch can still have more unsorted takes waiting on the server.
      if (cards.length < 2 && !await load(false)) return;
      if (cards.length < 2) return;
      const card = cards.shift();
      cards.splice(1 + Math.floor(Math.random() * cards.length), 0, card);
      paint(selected);
    } finally { busy = false; }
  }
  async function undo() {
    if (busy) return;
    busy = true;
    try { await drawUndo(() => load()); } finally { busy = false; }
  }
  async function place(bin) {
    if (busy || !cards[0]) return;
    busy = true;
    try {
      if (bin === "new") {
        const r = await api("/api/draw/new", { photos: [cards[0].photo] });
        if (left(view)) return;
        toast(`New group: ${r.theme.emoji} ${r.theme.name}. Rename it any time on the Groups page.`);
        resolved.add(cards[0].photo);
        cards.shift();
        await load();  // the new group is a bin now, and the hints change
        busy = false;
        return;
      }
      await api("/api/draw/place", { photo: cards[0].photo, theme: Number(bin) });
      if (left(view)) return;
      Sound.play("pick");
      const star = cards[0].options[0], now = playTime();
      called.total++;
      if (star && String(star.id) === String(bin)) called.right++;
      called.combo = now - called.last < 2500 ? called.combo + 1 : 1;
      called.last = now;
      floatText(called.combo >= 3 ? `+2 XP · ×${called.combo} combo!` : "+2 XP", $("#dtop"), called.combo >= 3 ? "bonus" : "");
      if (called.combo >= 3 && called.combo % 5 === 0) Sound.play("level");
      left_ = Math.max(0, left_ - 1);
      const g = bins.find((x) => String(x.id) === String(bin));
      if (g) g.size++;  // its count goes up right away
      resolved.add(cards[0].photo);
      cards.shift();
    } catch (e) { toast(e.message); }
    busy = false;
    if (cards.length) paint(); else await load();
  }
  // ← : a throw-out. Out of the running, into Set aside (as tossed), like a toss in a duel or the sweep.
  async function toss() {
    if (busy || !cards[0]) return;
    busy = true;
    const el = $("#dtop");
    if (el) { el.style.transform = ""; el.classList.add("fly-left"); }
    Sound.play("toss");
    try {
      await api("/api/draw/toss", { photo: cards[0].photo });
      await sleep(reduceMotion ? 0 : 200);
      if (left(view)) return;
      left_ = Math.max(0, left_ - 1);
      resolved.add(cards[0].photo);
      cards.shift();
    } catch (e) { toast(e.message); if (el) el.classList.remove("fly-left"); busy = false; return; }
    busy = false;
    if (cards.length) paint(); else await load();
  }
  S.onKey = (e) => {
    if (e.repeat || e.defaultPrevented || e.target?.isContentEditable) return;
    const k = e.key;
    if (!cards[0]) {  // the finish screen: the way on, back, or undo the last one
      if (k === "Enter") { e.preventDefault(); location.hash = "#duel?stage=stacks"; }
      else if (k === "Escape") { e.preventDefault(); location.hash = "#draw"; }
      else if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); undo(); }
      return;
    }
    const gi = groupKey(e);
    if (gi != null) { e.preventDefault(); if (bins[gi]) place(String(bins[gi].id)); }
    else if ((k === "ArrowUp" || k === "ArrowDown") && e.shiftKey && bins[cur]) {  // Shift: move the highlighted group itself
      e.preventDefault();
      const id = bins[cur].id, ids = moveInOrder(bins.map((b) => b.id), id, k === "ArrowUp" ? -1 : 1);
      if (ids) saveOrder(ids).then((ok) => { if (!ok) return; bins.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); const keep = id; paint(); cur = bins.findIndex((b) => b.id === keep); paintCursor(); });
    }
    else if (k === "ArrowUp" || k === "ArrowDown") { e.preventDefault(); cur = (cur + (k === "ArrowUp" ? -1 : 1) + bins.length + 1) % (bins.length + 1); paintCursor(); }
    else if ((k === "e" || k === "E") && bins[cur]) { e.preventDefault(); renameBin($$("#bins [data-bin]", main)[cur], bins[cur], paint); }
    else if (k === "ArrowRight" || k === "Enter") { e.preventDefault(); place(aimed()); }  // Enter confirms, like →
    else if (k === "ArrowLeft" || k.toLowerCase() === "x") { e.preventDefault(); toss(); }
    else if (k === " " && !e.target?.closest("input, select, textarea, button, a, [role=button]")) { e.preventDefault(); skip(); }
    else if (k === "Escape") { e.preventDefault(); location.hash = "#draw"; }
    else if (k === "n" || k === "N") { e.preventDefault(); place("new"); }
    else if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); undo(); }
  };
  main.innerHTML = LOADING();
  await load();
}

// ---------------------------------------------------------------- set aside (cuts)
async function viewCuts(main, params) {
  main.innerHTML = `<div class="screen no-rail"><div class="screen-head"><h1>🗑️ Set aside</h1></div><div class="screen-body"><div class="empty">Loading…</div></div></div>`;
  const view = S.view;
  let d;
  try { d = await api("/api/cuts"); } catch (e) { if (!left(view)) $(".screen-body", main).innerHTML = `<div class="empty error">${esc(e.message)}</div>`; return; }
  if (left(view)) return;
  const by = {};
  for (const p of d.photos) (by[p.reason] = by[p.reason] || []).push(p);
  const reasons = Object.keys(by).sort((a, b) => by[b].length - by[a].length);
  let current = params.get("reason") && by[params.get("reason")] ? params.get("reason") : reasons[0];
  let busy = false;
  const label = (r) => esc(d.labels[r] || r);

  const send = async (items, on) => {
    if (!items.length || busy || left(view)) return false;
    busy = true;
    try {
      await api("/api/rescue", { ids: items.map((p) => p.id), on, reason: current });
      items.forEach((p) => (p.rescued = on));
      return !left(view);
    } catch (e) { if (!left(view)) toast(e.message); return false; }
    finally { busy = false; }
  };

  // the tabs (one per reason) and the bar's bulk buttons: only the ones that would do something
  const paint = () => {
    if (left(view)) return;
    const list = by[current] || [];
    const back = list.filter((p) => p.rescued);
    const aside = list.length - back.length;
    $("#cut-remaining").textContent=fmt(d.photos.filter(p=>!p.rescued).length);
    $("#cut-tabs").innerHTML = reasons.map((r) => {
      const nb = by[r].filter((p) => p.rescued).length;
      return `<button class="chip ${r === current ? "on" : ""}" data-r="${esc(r)}">${label(r)} <b>${fmt(by[r].length)}</b>${nb ? `<span class="back-n">· ${fmt(nb)} back in</span>` : ""}</button>`;
    }).join("");
    $("#cut-hint").innerHTML = list.length ? `${plural(list.length, "photo")}${back.length ? ` · <span class="back-n">${fmt(back.length)} back in the tournament</span>` : ""}` : "";
    $("#cut-bulk").innerHTML = `${aside ? `<button class="btn ghost" id="all-back">Bring back all ${fmt(aside)}</button>` : ""}
      ${back.length ? `<button class="btn ghost" id="all-aside">Set all ${fmt(back.length)} aside again</button>` : ""}`;
    $$("[data-r]").forEach((b) => (b.onclick = () => {
      current = b.dataset.r;
      history.replaceState(null, "", `#cuts?reason=${current}`);
      render();
    }));
    const bulk = async (items, on) => {
      if (!await send(items, on)) return;
      render();  // the user may have opened a different reason while this saved
      toast(on ? `${fmt(items.length)} photos back in the tournament.` : `${fmt(items.length)} photos set aside again.`);
    };
    const all = $("#all-back");
    if (all) all.onclick = () => bulk(list.filter((p) => !p.rescued), true);
    const none = $("#all-aside");
    if (none) none.onclick = () => bulk(list.filter((p) => p.rescued), false);
  };

  const render = () => {
    if (left(view)) return;
    const list = by[current] || [];
    main.innerHTML = `
      <div class="screen cuts no-rail">
        <div class="screen-head">
          <h1>🗑️ Set aside</h1>
          <span class="stat-chip"><b id="cut-remaining">${fmt(d.photos.filter(p=>!p.rescued).length)}</b> set aside</span>
          <span class="cut-tabs" id="cut-tabs"></span>
          <span class="grow"></span>
          ${helpBtn(`What it decided were obvious throw-outs, by reason. Click a photo (or Enter / Space on it) to bring it back into the
            tournament; click again to set it aside again. Nothing here is ever deleted.`)}
        </div>
        <div class="screen-body">${list.length ? `<div class="grid">${list.map((p) => `
          <div class="tile pick ${p.rescued ? "rescued" : ""}" data-id="${p.id}" title="${esc(p.rel)}" tabindex="0" role="button"
            aria-pressed="${p.rescued}" aria-label="${esc(p.rel)}"><img src="${T(p.id)}" alt="" loading="lazy"></div>`).join("")}</div>`
          : `<div class="empty"><div class="big-emoji">✨</div><h2>Nothing was set aside</h2><p class="muted">Every photo is in the running.</p></div>`}</div>
        <div class="screen-bar action-bar">
          <div class="bar-left"><span class="muted small" id="cut-hint"></span></div>
          <div class="bar-mid" id="cut-bulk"></div>
          <div class="bar-right"><a class="btn primary big" href="#home">The map → <kbd>Enter</kbd></a></div>
        </div>
      </div>`;
    paint();
    $$(".tile[data-id]").forEach((t) => (t.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); t.click(); }
    }));
    $$(".tile[data-id]").forEach((t) => (t.onclick = async () => {
      const p = list.find((x) => x.id === Number(t.dataset.id));
      if (!await send([p], !p.rescued)) return;
      t.classList.toggle("rescued", p.rescued);
      t.setAttribute("aria-pressed", p.rescued);
      paint();
      toast(p.rescued ? "Back in the tournament." : "Set aside again.");
    }));
  };
  render();
}

// ---------------------------------------------------------------- people
async function viewPeople(main) {
  main.innerHTML = LOADING();
  const view = S.view;
  let d;
  try { d = await api("/api/people"); } catch(e) { if (!left(view)) main.innerHTML=FAILED(e.message); return; }
  if (left(view)) return;
  main.innerHTML = `
    <div class="screen people-screen no-rail">
      <div class="screen-head">
        <h1>🙂 People</h1>
        <span class="stat-chip">you're in <b>${fmt(d.me.n_photos)}</b> ${d.me.n_photos === 1 ? "photo" : "photos"}</span>
        <span class="cut-tabs" title="How close a face has to be to count as you">
          ${["strict", "normal", "loose"].map((m) => `<button class="chip ${d.match === m ? "on" : ""}" data-match="${m}">${m}</button>`).join("")}</span>
        <span class="grow"></span>
        ${helpBtn(`It works out which face is you from who shows up most. Photos without you get set aside; exclude anyone you don't want
          in your leaderboard (an ex, say) and their photos go too. Strangers among <b>least sure</b>? Go <b>strict</b>. Your own photos under
          Set aside → Not you? Go <b>loose</b>.`)}
      </div>
      <div class="screen-body">
        <div class="card stack">
          <h2 style="margin:0">This is you</h2>
          <div class="faces">${d.me.faces.map((f) => `<img src="${F(f)}" alt="" loading="lazy">`).join("")}</div>
          ${d.me.borderline.length ? `<h3 class="muted" style="margin:12px 0 0">Least sure these are you</h3>
          <div class="faces">${d.me.borderline.map((f) => `<img src="${F(f)}" alt="" loading="lazy">`).join("")}</div>` : ""}
        </div>
        <h2 class="board-h">Other people who show up often</h2>
        <div class="people">${d.people.length ? d.people.map((p) => `
          <div class="card person ${p.excluded ? "excluded" : ""} stack">
            <div class="faces">${p.faces.map((f) => `<img src="${F(f)}" alt="" loading="lazy">`).join("")}</div>
            <div class="row spread"><span class="muted">in ${plural(p.n_photos, "photo")}</span>
              <span class="row">
                ${p.excluded ? `<button class="btn" data-act="include" data-k="${p.key}">Include again</button>`
                  : `<button class="btn" data-act="exclude" data-k="${p.key}">Exclude their photos</button>`}
                <button class="btn ghost" data-act="me" data-k="${p.key}">That's me too</button>
              </span></div>
          </div>`).join("") : `<p class="muted">Nobody else shows up often.</p>`}</div>
      </div>
      <div class="screen-bar action-bar">
        <div class="bar-left"><button class="btn ghost" id="not-me">That's not me at all</button></div>
        <div class="bar-mid">${d.last ? `<button class="btn ghost" id="people-undo"><kbd>Z</kbd> Undo last change</button>` : ""}</div>
        <div class="bar-right"><a class="btn primary big" href="#home">The map → <kbd>Enter</kbd></a></div>
      </div>
    </div>`;
  const act = async (key, action, msg) => {
    try { await api(`/api/people/${key}`, { action }); } catch(e) { if (!left(view)) toast(e.message); return; }
    if (left(view)) return;
    toast(msg);
    setTimeout(() => { if (!left(view)) viewPeople(main); }, 1200);
  };
  $("#not-me").onclick = async () => {
    if (!await askInGame("Tell it these faces aren't you? It will look for someone else who shows up often. You can undo this.", "Find someone else")) return;
    act(0, "not_me", "Got it, re-working out which face is you…");
  };
  const undoBtn = $("#people-undo");
  S.onKey=e=>{if(e.key.toLowerCase()==="z"&&undoBtn){e.preventDefault();if(!e.repeat)undoBtn.click();}else if(e.key==="Escape"){e.preventDefault();location.hash="home";}};
  if (undoBtn) undoBtn.onclick = async () => {
    try { await api("/api/people/undo", {}); } catch (e) { if(!left(view))toast(e.message); return; }
    if(left(view))return;
    toast("Undone. Re-sorting your photos…");
    setTimeout(() => { if (!left(view)) viewPeople(main); }, 1200);
  };
  $$("[data-match]").forEach((b) => (b.onclick = async () => {
    try { await api("/api/settings", { match: b.dataset.match });await loadState(); }catch(e){if(!left(view))toast(e.message);return;}
    if(left(view))return;
    toast(`Face matching: ${b.dataset.match}. Re-sorting your photos…`);
    setTimeout(() => { if (!left(view)) viewPeople(main); }, 1500);
  }));
  $$("[data-act]").forEach((b) => (b.onclick = () => act(b.dataset.k, b.dataset.act,
    { exclude: "Excluded; their photos are being set aside.", include: "Included again.", me: "Merged into you." }[b.dataset.act])));
}

// ---------------------------------------------------------------- settings
$("#open-menu").onclick = openMenu;
function openSettings() {
  const s = S.lib.settings;
  const d = $("#settings");
  let busy = false;
  const change = async (action) => {
    if (busy || !d.open) return;
    busy = true;
    try { await action(); } catch (e) { toast(e.message); }
    finally { busy = false; }
  };
  const opt = (vals, cur, fmtv = (v) => v) => vals.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${fmtv(v)}</option>`).join("");
  d.innerHTML = `
    <h2>Settings</h2>
    <label>What you're sorting<select id="s-mode">
      <option value="gallery" ${MODE() === "gallery" ? "selected" : ""}>My best photos (anything: a cup per kind of photo)</option>
      <option value="me" ${MODE() === "me" ? "selected" : ""}>Photos of me (profile pics)</option></select></label>
    <label>Leaderboard size (at most; small cups use a quarter of their shots)<select id="s-k">${opt([20, 25, 30, 40, 50, 60], s.finalists)}</select></label>
    <label>At most this many shots from one scene<select id="s-cap">${opt([1, 2, 3, 4, 5], s.per_scene)}</select></label>
    <button class="btn ghost" id="s-filter">🎛️ Tune quality, age and subjects in Filter →</button>
    <p class="muted small">Folder: <code class="path">${esc(S.lib.source)}</code></p>
    <div class="row spread" style="margin-top:18px">
      <span class="row"><button class="btn ghost" id="s-rescan">Re-scan for new photos</button><button class="btn ghost" id="s-change">Switch save</button>
        <button class="btn ghost danger" id="s-forget" title="Delete everything MatchER keeps about this folder">Forget this save</button></span>
      <span class="row"><button class="btn" id="s-cancel">Cancel</button><button class="btn primary" id="s-save">Save</button></span>
    </div>`;
  $("#s-cancel").onclick = () => d.close();
  $("#s-save").onclick = () => change(async () => {
    const mode = $("#s-mode").value;
    await api("/api/settings", { finalists: Number($("#s-k").value), per_scene: Number($("#s-cap").value), mode });
    const changed = mode !== MODE();
    await loadState();
    d.close();
    toast(changed ? "Re-sorting your photos for the new mode; give it a few seconds." : "Saved.");
    if (changed) location.hash = "home";
    route();
  });
  $("#s-rescan").onclick = () => change(async () => { await api("/api/rescan", {}); await loadState(); d.close(); location.hash = "analyze"; route(); });
  $("#s-filter").onclick = () => { if(busy)return;d.close();location.hash="#filter"; };
  $("#s-change").onclick = () => { d.close(); location.hash = "#saves"; };
  $("#s-forget").onclick = () => change(async () => {
    if (!await askInGame("Delete everything MatchER keeps about this folder: your calls, face data, previews and exports? Your photos themselves aren't touched. This can't be undone.", "Forget this save")) return;
    await api("/api/library/forget", { path: S.lib.source });
    await loadState();
    d.close();
    toast("Forgotten.");
    location.hash = "onboard";
    route();
  });
  d.showModal();
}

// ---------------------------------------------------------------- the sea of colour
// The colours of the photos on screen bleed out into the space behind everything: soft blobs born inside each photo
// drift out to its edges and circle there on springs; the pointer pushes them away and stirs them along. When the
// next photo takes the same spot (the next duel, the next card) the colours morph rather than pop. Drawn at a quarter
// of the window's size and blurred up (cheap), paused in a hidden tab, still under "reduce motion", and off in ☰.
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const vivid = (c) => { const [h, s, l] = rgbToHsl(c); return hslToRgb([h, Math.min(1, s * 1.35 + 0.1), Math.min(0.5, Math.max(0.3, l))]); };

// Where a photo actually shows on screen (object-fit: contain leaves bars), or null if it's off screen or tiny.
function shownRect(img, minimum = 48) {
  if (!img.offsetParent || img.closest(".under, .help-pop")) return null;
  const r = img.getBoundingClientRect();
  if (r.width < minimum || r.height < minimum || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
  let { left: x, top: y, width: w, height: h } = r;
  const style = getComputedStyle(img);
  if (img.naturalWidth && style.objectFit === "contain") {
    const a = img.naturalWidth / img.naturalHeight;
    const [px = '50%', py = '50%'] = style.objectPosition.split(' ');
    const offset = (value, spare) => value.endsWith('%') ? spare * parseFloat(value) / 100 : parseFloat(value) || 0;
    if (w / h > a) { const nw = h * a; x += offset(px,w-nw); w = nw; } else { const nh = w / a; y += offset(py,h-nh); h = nh; }
  }
  return w * h >= (minimum ? 2500 : 0) ? { x, y, w, h } : null;
}

const Sea = {
  on: (() => { try { return localStorage.getItem("matcher-sea") !== "off"; } catch (_) { return true; } })(),
  SCALE: 0.25,   // canvas pixels per window pixel (blurred up by CSS)
  MAX: 170,      // blobs at most
  GROW: 7,       // a blob's radius, in multiples of a fair share of its photo's size: big washes of colour
  blobs: [], emitters: new Map(), palettes: new Map(), mouse: { x: -1e5, y: -1e5, vx: 0, vy: 0 }, raf: 0, last: 0,
  init() {
    const c = document.createElement("canvas");
    c.id = "sea";
    c.setAttribute("aria-hidden", "true");
    document.body.prepend(c);
    this.canvas = c;
    this.ctx = c.getContext("2d");
    this.size();
    addEventListener("resize", () => { this.size(); this.scanSoon(); });
    addEventListener("pointermove", (e) => {
      const m = this.mouse;
      if (m.x > -1e4) { m.vx = m.vx * 0.5 + (e.clientX - m.x) * 0.5; m.vy = m.vy * 0.5 + (e.clientY - m.y) * 0.5; }
      m.x = e.clientX; m.y = e.clientY;
      this.kick();
    }, { passive: true });
    document.documentElement.addEventListener("pointerleave", () => { this.mouse.x = this.mouse.y = -1e5; });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { this.last = 0; this.kick(); } });
    new MutationObserver(() => this.scanSoon()).observe($("#main"), { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "class"] });
    addEventListener("scroll", () => this.scanSoon(), { passive: true, capture: true });
    setInterval(() => this.scan(), 1500);
    document.body.classList.toggle("sea-on", this.on);
    this.scan();
  },
  size() {
    this.canvas.width = Math.ceil(innerWidth * this.SCALE);
    this.canvas.height = Math.ceil(innerHeight * this.SCALE);
    if (reduceMotion) this.draw();
  },
  toggle() {
    this.on = !this.on;
    try { localStorage.setItem("matcher-sea", this.on ? "on" : "off"); } catch (_) { /* private mode */ }
    document.body.classList.toggle("sea-on", this.on);
    if(World.sea){World.sea.coloursOn=this.on;World.sea.paintWater();}
    const button=$('#more-circles');if(button)button.textContent=this.on?'Hide sea colours':'Show sea colours';
    if (this.on) this.scan(); else { this.blobs = []; this.emitters.clear(); this.draw(); }
  },
  scanSoon() {
    if (this.queued) return;
    this.queued = true;
    setTimeout(() => { this.queued = false; this.scan(); }, 140);
  },
  // A photo's few most vivid colours (vivid beats dull, each distinct from the last), from a 24×24 sample.
  palette(img) {
    const key = img.currentSrc || img.src;
    if (this.palettes.has(key)) return this.palettes.get(key);
    if (!img.complete || !img.naturalWidth) { img.addEventListener("load", () => this.scanSoon(), { once: true }); return null; }
    const n = 24, cv = document.createElement("canvas");
    cv.width = cv.height = n;
    const g = cv.getContext("2d", { willReadFrequently: true });
    let px;
    try { g.drawImage(img, 0, 0, n, n); px = g.getImageData(0, 0, n, n).data; } catch (_) { this.palettes.set(key, []); return []; }
    const bins = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], gg = px[i + 1], b = px[i + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const sat = mx ? (mx - mn) / mx : 0, lum = (mx + mn) / 510;
      const w = (0.12 + sat) * (0.2 + Math.min(lum, 1 - lum * 0.6));
      const k = ((r >> 5) << 6) | ((gg >> 5) << 3) | (b >> 5);
      const e = bins.get(k) || { w: 0, r: 0, g: 0, b: 0 };
      e.w += w; e.r += r * w; e.g += gg * w; e.b += b * w;
      bins.set(k, e);
    }
    const out = [];
    for (const e of [...bins.values()].sort((a, b) => b.w - a.w)) {
      const c = [e.r / e.w, e.g / e.w, e.b / e.w];
      if (out.every((o) => Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2]) > 80)) out.push(vivid(c));
      if (out.length >= 4) break;
    }
    this.palettes.set(key, out);
    if (this.palettes.size > 400) this.palettes.delete(this.palettes.keys().next().value);
    return out;
  },
  // A blob's resting place: a point on its photo's edge (or just inside it), pushed out by its own distance.
  anchor(b, r) {
    const side = Math.floor(b.u) % 4, t = b.u % 1, d = b.out * Math.min(r.w, r.h);
    const [x, y, nx, ny] = side === 0 ? [r.x + t * r.w, r.y, 0, -1] : side === 1 ? [r.x + r.w, r.y + t * r.h, 1, 0]
      : side === 2 ? [r.x + (1 - t) * r.w, r.y + r.h, 0, 1] : [r.x, r.y + (1 - t) * r.h, -1, 0];
    b.ax = x + nx * d;
    b.ay = y + ny * d;
    b.tr = Math.max(300, Math.min(2600, b.size * Math.sqrt(r.w * r.h) * this.GROW));
  },
  spawn(key, em, i) {
    const r = em.rect;
    const b = { key, u: Math.random() * 4, out: Math.random() < 0.2 ? -0.15 : 0.05 + Math.random() * 0.4, size: 0.22 + Math.random() * 0.3,
      x: r.x + r.w * (0.3 + Math.random() * 0.4), y: r.y + r.h * (0.3 + Math.random() * 0.4), vx: 0, vy: 0, r: 10, a: 0,
      orbit: 18 + Math.random() * 60, w: 0.25 + Math.random() * 0.5, ph: Math.random() * 6.28 };
    b.c = [...em.pal[i % em.pal.length]];
    b.tc = b.c;
    this.anchor(b, r);
    if (reduceMotion) { b.x = b.ax; b.y = b.ay; b.r = b.tr; b.a = 1; }
    return b;
  },
  // Which photos are on screen now: new ones bleed blobs out, gone ones let theirs fade, a new photo in the same spot
  // recolours the blobs it finds there.
  hasWorldSurface(){return World.mode!=='hidden'&&World.sea?.coloursOn!==false&&!!World.sea?.contourRaster?.nonempty;},
  scan() {
    if (!this.on || !this.canvas) return;
    // The photo sea already fills the viewport. A second, hidden colour animation only consumes battery and
    // can leak unrelated colours through a dimmed screen; the older wash remains for pages without the world.
    if(this.hasWorldSurface()){
      cancelAnimationFrame(this.raf);this.raf=0;this.blobs=[];this.emitters.clear();this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);return;
    }
    const found = [];
    for (const img of $$("#main img, dialog[open] img")) {
      const r = shownRect(img);
      if (r) found.push([r.w * r.h, img, r]);
    }
    found.sort((a, b) => b[0] - a[0]);
    const now = new Map();
    for (const [, img, r] of found.slice(0, 10)) {
      const pal = this.palette(img);
      if (!pal || !pal.length) continue;
      const key = `${Math.round((r.x + r.w / 2) / 90)}:${Math.round((r.y + r.h / 2) / 90)}:${Math.round(Math.sqrt(r.w * r.h) / 90)}`;
      if (!now.has(key)) now.set(key, { rect: r, pal });
    }
    for (const key of [...this.emitters.keys()]) {
      if (now.has(key)) continue;
      this.emitters.delete(key);
      this.blobs.forEach((b) => { if (b.key === key) b.dying = true; });
    }
    for (const [key, em] of now) {
      this.emitters.set(key, em);
      const mine = this.blobs.filter((b) => b.key === key && !b.dying);
      mine.forEach((b, i) => { b.tc = em.pal[i % em.pal.length]; this.anchor(b, em.rect); });
      const want = Math.max(2, Math.min(14, Math.round(Math.sqrt(em.rect.w * em.rect.h) / 55)));
      for (let i = mine.length; i < want && this.blobs.length < this.MAX; i++) this.blobs.push(this.spawn(key, em, i));
    }
    if (reduceMotion) this.draw(); else this.kick();
  },
  kick() {
    if (!this.raf && this.on && !reduceMotion && !document.hidden && this.blobs.length&&!this.hasWorldSurface()) this.raf = requestAnimationFrame((t) => this.frame(t));
  },
  frame(now) {
    this.raf = 0;
    if (!this.on || document.hidden) return;
    if(this.hasWorldSurface()){this.scan();return;}
    if (this.last && now - this.last < 30) { this.kick(); return; }  // ~30 frames a second is plenty for a slow sea
    const dt = Math.min(3, this.last ? (now - this.last) / 16.67 : 1);
    this.last = now;
    const T = now / 1000, m = this.mouse, R = 420;
    for (const b of this.blobs) {
      const tx = b.ax + Math.cos(T * b.w + b.ph) * b.orbit, ty = b.ay + Math.sin(T * b.w * 0.83 + b.ph) * b.orbit;
      b.vx += (tx - b.x) * 0.0022 * dt;  // a spring to its spot on the photo's edge
      b.vy += (ty - b.y) * 0.0022 * dt;
      const dx = b.x - m.x, dy = b.y - m.y, d2 = dx * dx + dy * dy;
      if (d2 < R * R) {  // the pointer pushes it away and drags it along
        const d = Math.sqrt(d2) || 1, f = 1 - d / R;
        b.vx += ((dx / d) * f * f * 2.4 + m.vx * f * 0.08) * dt;
        b.vy += ((dy / d) * f * f * 2.4 + m.vy * f * 0.08) * dt;
      }
      const damp = Math.pow(0.93, dt);
      b.vx *= damp;
      b.vy *= damp;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const k = Math.min(1, 0.035 * dt);
      b.c = [b.c[0] + (b.tc[0] - b.c[0]) * k, b.c[1] + (b.tc[1] - b.c[1]) * k, b.c[2] + (b.tc[2] - b.c[2]) * k];
      b.a += ((b.dying ? 0 : 1) - b.a) * Math.min(1, (b.dying ? 0.05 : 0.022) * dt);
      b.r += (b.tr - b.r) * Math.min(1, 0.03 * dt);
    }
    this.blobs = this.blobs.filter((b) => !(b.dying && b.a < 0.02));
    m.vx *= Math.pow(0.85, dt);
    m.vy *= Math.pow(0.85, dt);
    this.draw();
    this.kick();
  },
  draw() {
    const g = this.ctx, s = this.SCALE;
    if (!g) return;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.globalCompositeOperation = "source-over";  // patches mix where they overlap instead of adding up to white
    for (const b of this.blobs) {
      if (b.a < 0.01) continue;
      const x = b.x * s, y = b.y * s, r = Math.max(1, b.r * s), [cr, cg, cb] = b.c.map(Math.round);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(${cr},${cg},${cb},${0.45 * b.a})`);
      grd.addColorStop(0.45, `rgba(${cr},${cg},${cb},${0.2 * b.a})`);
      grd.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);  // (big radial gradients are soft already: no blur needed)
    }
  },
};

// ---------------------------------------------------------------- the world: one sea behind the whole game
// Every screen sits on the same sea of photos: the cup's shots floating with their tags, groups held in lasso
// bubbles, stacks as piles, dimmed behind whatever you're doing. The photos a screen brings to you lift out of their
// spot in the sea and grow into place; when you're done with them they sink back (a winner glowing on the way).
const World = {
  el: null, sea: null, stale: true, loading: null, mode: "hidden", lifted: new Set(), last: 0,
  init() {
    this.el = $("#world");
    if (!this.el) return;
    this.el.removeAttribute("aria-hidden");
    this.sea = new VennSea(this.el, {catalog:true});
    this.sea.coloursOn=Sea.on;
    this.plain = { clickToZoom:true,onSelect: (it, e) => { if (e?.shiftKey) { it.selected = !it.selected; this.sea.select([...this.sea.items.values()].filter((x) => x.selected).map((x) => x.id)); } else this.inspect(it.id); },
      onDrop:(ids,target)=>this.drop(ids,target),
      onCircle:(key,anchor)=>this.tagMenu(key,anchor),onLasso:(id,anchor)=>{if(id.startsWith("gcup:"))return this.tagMenu(`kind:${id.slice(5)}`,anchor);location.hash=id==="gcut"?"#cuts":`#draw?g=${id.slice(1)}`;} };
    Object.assign(this.sea, this.plain);
    const main = $("#main");
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled || this.mode === "hidden") return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (this.mode === "hidden") return;
        for (const {pid,img,area} of this.images(main)) {
          const old=this.recycled?.get(pid), r=old?.getBoundingClientRect();
          if (old && old !== img && (!old.isConnected || (main.contains(old)&&area>r.width*r.height*1.2))) {
            if(old.isConnected){const copy=old.cloneNode(false);copy.onclick=old.onclick;copy.onload=old.onload;old.replaceWith(copy);}
            for (const a of [...old.attributes]) old.removeAttribute(a.name);
            for (const a of [...img.attributes]) old.setAttribute(a.name, a.value);
            old.onclick = img.onclick; old.onload=img.onload; img.replaceWith(old);
          }
        }
        const gone = this.focused || [];
        this.swap(main, gone); this.focused = this.grab(main); this.fence();
      });
    }).observe(main, { childList: true, subtree: true });
  },
  // ambient: the sea is the map; focus: a screen is showing you photos; dim: a page of its own. In every mode the sea's
  // photos continue behind its translucent controls.
  setMode(mode) {
    if (this.handlers && mode !== "live") {  // the Groups page let go of the sea: back to the plain world
      this.handlers = null;
      Object.assign(this.sea, { onSelect: null, onDrop: null, onCircle: null, onLasso: null, onSelectMatches:null }, this.plain);
      this.sea.select([]);
      this.sea.highlight(null);
      this.stale = true;
    }
    this.mode = mode;
    document.body.dataset.world = mode;
    document.body.classList.remove("world-calm");
    document.body.classList.toggle('sea-focus',!!this.sea?.el.classList.contains('has-focus'));
    const body=$('#main .screen-body');if(body)body.inert=mode==='ambient'&&!!this.sea?.el.classList.contains('has-focus');
    if (this.sea) {
      this.sea.axes=SeaAxes.normalize(S.lib?.settings?.sea_axes);
      // The map and the editors are explorable (pan and zoom); a comparison or a page uses the whole sea at rest.
      this.sea.enableCamera(mode==='ambient'||mode==='live');
      // The tag shelf belongs to the editors (Groups, Filter): reading and comparison screens keep the bottom edge clear.
      this.sea.catalogSuppressed=mode!=='live';
      if(mode!=='live'){
        this.sea.releaseFocus();
        for(const c of this.sea.circles.values())if(c.tag.parentElement!==this.sea.tagRow)this.sea.tagRow.append(c.tag);
      }
      this.sea.highlight(null);
      for(const l of this.sea.lassos.values())l.docked=false;
      this.sea.paused=mode==='hidden'||S.pause?.view===S.view;
      if(mode==='hidden'){
        cancelAnimationFrame(this.sea.raf);this.sea.raf=0;
        this.sea.dock?.classList.remove('tag-dock');this.sea.dock=null;this.sea.el.append(this.sea.tray);this.sea.tray.hidden=true;
      }else{this.sea.last=0;this.sea.layout();this.sea.kick();}
    }
    if (mode !== "hidden" && mode !== "live" && this.stale) this.sync();
    clearInterval(this.watch);
    if (mode !== "hidden") { this.watch = setInterval(() => this.fence(), 700); setTimeout(() => this.fence(), 60); }
  },
  // The Groups page works the sea itself: it feeds it (tags as circles, groups and suggestions) and handles its drops.
  live(handlers) {
    this.handlers = handlers;
    Object.assign(this.sea, {clickToZoom:true}, handlers);
    this.setMode("live");
    return this.sea;
  },
  // A reward or reading moment dims the sea behind the words; the next route or card brings it back.
  calm(on) { document.body.classList.toggle("world-calm", !!on); },
  // Older views still request a fence update; chrome no longer changes the sea physics.
  fence() {
    // Controls float over the world. Only photos participate in its collision avoidance.
    if(!this.sea||!this.sea.obstacles?.length)return;
    this.fenced='';this.sea.obstacles=[];this.sea.layout();
  },
  // the top of the leaderboard wear their rank in the sea (the map shows them there instead of a strip of its own)
  ranks(ids) {
    this.top = new Map((ids || []).map((id, i) => [Number(id), i + 1]));
    if (this.sea) for (const it of this.sea.items.values()) this.badge(it);
  },
  badge(it) {
    const r = this.top && this.top.get(it.id);
    let b = it.el.querySelector(".ps-rank");
    if (!r) { b?.remove(); return; }
    if (!b) { b = document.createElement("span"); b.className = "ps-rank"; it.el.append(b); }
    b.textContent = r;
    b.classList.toggle("gold", r <= 3);
  },
  groupSelection(ids,cup=S.journey?.cup || "all") {
    return [...new Set(ids.map((id)=>{const p=this.photos?.get(Number(id)),rep=p?.rep || Number(id),r=this.photos?.get(rep) || p;
      return r && (r.cut || (cup!=="all" && r.category!==cup)) ? null : rep;}).filter((id)=>id!=null))];
  },
  async drop(ids,target) {
    let path,body;
    if(target.kind==="photo"){path="/api/groups/merge";body={photos:[...ids,target.id]};}
    else if(target.kind==="tags" && (target.on.length || target.off.length)) {
      path="/api/tags/set";body={photos:ids,on:target.on,off:target.off};
    } else if(target.kind==="bin") {
      const photos=this.groupSelection(ids);if(!photos.length)return;
      path=target.id==="new"?"/api/draw/new":"/api/draw/move";body={photos,...(target.id==="new"?{}:{theme:Number(target.id)})};
    } else if(target.kind==="group") {  // dropped inside a group's lasso on the map
      const photos=this.groupSelection(ids);if(!photos.length)return;
      path="/api/draw/move";body={photos,theme:target.id};
    } else return;
    const view=S.view;
    try {const r=await api(path,body);if(left(view))return;updateHudQuiet(r.game);paintSaveChip();
      if(path==="/api/groups/merge"){toastOnce("stacked","Stacked. Z undoes it.");this.sync();}
      else toast("Saved. Z undoes it.");this.sea.select([]);refreshHud(true);
    } catch(e){if(!left(view))toast(e.message);}
  },
  dirty() {
    this.stale = true; this.photosSource = null;
    if (this.mode !== "hidden") setTimeout(() => this.sync(), Math.max(0, 1200 - (performance.now() - this.last)));
  },
  async allPhotos(onPage) {
    const source = S.lib?.source;
    if (this.photoLoading && this.photoSource === source) { await this.photoLoading; if(source===S.lib?.source)onPage?.(); return; }
    if (this.photosSource === source && this.photos?.size === this.total) { onPage?.(); return; }
    const retain=this.photoSource===source;this.photoSource = source;
    const loading = (async () => {
      let after = 0, more = true;
      const fromAnalysis=this.sea.source===source;
      const seed=fromAnalysis?[...this.sea.items.values()].map(it=>[it.id,{id:it.id,rep:it.stack,members:it.take?[it.id]:it.members,tags:it.tags,theme:typeof it.group==='number'?it.group:-1,category:it.category,cut:it.cut,visual:it.visual,dims:it.dims}]):[];
      const photos = new Map(retain?this.photos:seed),seen=new Set();this.photos = photos;
      this.sprites=retain?this.sprites||new Map():fromAnalysis?this.sea.sprites||new Map():new Map();this.sea.sprites=this.sprites;
      if(!retain){this.recycled=new Map();this.lifted.clear();}
      if(!fromAnalysis&&!retain)this.sea.syncItems([]);this.sea.source=source;
      while (more && source === S.lib?.source) {
        const before = after;
        const page = await api(`/api/world?per=1000&after=${after}`);
        if (source !== S.lib?.source) return;
        const sheet = new Image(),key=imageKey();
        sheet.onload = () => { if(source!==S.lib?.source||key!==imageKey())return;page.photos.forEach((p,i)=>this.sprites.set(p.id,this.sea.atlasCell(sheet,i,p.dims)));this.sea.densityDirty=this.sea.spritesDirty=true;this.sea.refreshColours();this.sea.kick(); };
        // A sheet that fails to arrive is asked for again (a few times): without it a thousand prints would stay blank.
        sheet.onerror = () => { if(source!==S.lib?.source||key!==imageKey()||(sheet.tries=(sheet.tries||0)+1)>3)return;setTimeout(()=>{if(source===S.lib?.source)sheet.src=`${sheet.src.split('&t=')[0]}&t=${Date.now()}`;},2000*sheet.tries); };
        page.photos.forEach(p=>{photos.set(p.id,p);seen.add(p.id);});
        sheet.src = `/img/atlas.jpg?layout=2&per=1000&after=${before}&v=${imageKey()}`;
        this.total = page.total; after = page.after; more = page.more;
        onPage?.(page); await sleep(0);
      }
      if(source!==S.lib?.source)return;
      for(const id of photos.keys())if(!seen.has(id)){photos.delete(id);this.sprites.delete(id);}
      this.photosSource = source;
      onPage?.();
    })();
    this.photoLoading=loading;
    try { await loading; } finally { if(this.photoLoading===loading)this.photoLoading = null; }
  },
  extras(items) {
    for(const it of items){const photo=this.photos?.get(it.photo||it.id);it.visual ||= photo?.visual;it.measurements ||= photo?.measurements;}
    const have = new Set(items.map((x) => x.id)), covers=new Map(items.map((x)=>[x.id,x]));
    for (const p of this.photos?.values() || []) if (!have.has(p.id)) {
      const rep=covers.get(p.rep), group=p.cut?"cut":p.theme>=0?p.theme:p.category?`cup:${p.category}`:null;
      const it={id:p.id,photo:p.id,tags:p.tags||[],group:rep?rep.group:group,sugg:rep?.sugg,
        n:p.members.length,members:p.members,rep:p.rep,category:p.category,cut:!!p.cut,take:p.rep!==p.id,box:p.box,visual:p.visual,measurements:p.measurements,dims:p.dims};
      items.push(it);if(p.rep===p.id)covers.set(p.id,it);
    }
    return items;
  },
  categories(items) {
    const counts=new Map();for(const it of items)if(typeof it.group==="string"&&it.group.startsWith("cup:"))counts.set(it.group,(counts.get(it.group)||0)+1);
    return [...counts].map(([key,n])=>({id:`g${key}`,kind:"group",html:`${esc(KINDS[key.slice(4)]?.[0]||"🗂️")} <span class="ps-count">${fmt(n)}</span>`}));
  },
  sync() {
    if (!this.sea || this.loading || this.mode === "live" || !S.lib || !S.lib.analyzed || S.lib.analyzing) return this.loading;
    this.stale = false;
    this.last = performance.now();
    const source = S.lib.source;let failed=false;
    this.loading = (async () => {
      const [b,tags] = await Promise.all([api("/api/draw/board?per=4&uper=4&tags=1"),api("/api/tags?all=1")]);
      if (source !== S.lib?.source || this.mode === "live" || this.mode==='hidden') return;
      this.board = b;
      this.tagMeta = new Map(tags.tags.map((t) => [t.key, t]));
      // Publish the complete collection once. Rehoming after each metadata page makes the map visibly reorganize
      // several times; atlas sheets can still download in parallel while the existing geography remains on view.
      await this.allPhotos();
      if (source !== S.lib?.source || this.mode === "live" || this.mode==='hidden') return;
      const items = this.extras([]);
      this.sea.setVenn(tags.tags.filter((t)=>t.count||t.user).map((t)=>({id:t.key,label:t.label,emoji:t.emoji,catchy:t.catchy,ring:tags.visible.includes(t.key),
        html:`${esc(t.emoji||"🏷️")} ${esc(t.label)} <span class="ps-count">${fmt(t.count)}</span>`})), items, [...b.groups.map((g) => ({ id: `g${g.id}`, kind: "group",bin:g.id,
        html: `${esc(g.emoji || "🗂️")} ${esc(g.name)} · ${g.adv || 0} through` })),
        ...this.categories(items), { id: "gcut", kind: "group", html: "🫙 Set aside" }]);
      for (const pid of this.lifted) this.tileOf(pid)?.classList.add("lifted");
      for (const it of this.sea.items.values()) this.badge(it);
      this.fence();window.dispatchEvent(new Event('world-ready'));
    })().catch((e) => { failed=true;this.stale = true; toast(e.message); }).finally(() => {
      this.loading = null;
      if(this.stale){this.photosSource=null;if(!failed && this.mode!=="hidden" && this.mode!=="live")setTimeout(()=>this.sync(),1200);}
    });
    return this.loading;
  },
  tileOf(pid) { const it = this.sea?.promote(Number(pid)); return it ? it.el : null; },
  rect(img) {
    if (!img?.isConnected) return null;
    // Every photo is a polaroid and a flight carries the whole card, so the rectangle is the card's box: a pane's
    // picture sits in a `.window` inside its `.print`, a bare image carries its own paper.
    const card=img.closest?.('.print,.ps-item')||img;
    const box=card.getBoundingClientRect();if(!box.width||!box.height)return null;
    const style=getComputedStyle(img),bare=card===img&&!(parseFloat(style.paddingBottom)>0);let a=1,b=0,c=0,d=1;
    // Keep the actual wobble/scale as well as contain's letterboxing. The element's outer rectangle includes both.
    for(let el=card;el;el=el.parentElement){
      const computed=getComputedStyle(el),transform=computed.transform,scale=computed.scale;
      if(transform==='none'&&(!scale||scale==='none'))continue;
      const [sx=1,sy=sx]=(scale&&scale!=='none'?scale:'1').split(/\s+/).map(Number);
      const m=new DOMMatrixReadOnly(transform==='none'?undefined:transform),aa=sx*(m.a*a+m.c*b),bb=sy*(m.b*a+m.d*b),cc=sx*(m.a*c+m.c*d),dd=sy*(m.b*c+m.d*d);
      a=aa;b=bb;c=cc;d=dd;
    }
    let width=box.width,height=box.height,cx=box.left+width/2,cy=box.top+height/2;
    if(bare&&img.naturalWidth&&style.objectFit==='contain'&&img.clientWidth&&img.clientHeight){
      const w=img.clientWidth,h=img.clientHeight,k=Math.min(w/img.naturalWidth,h/img.naturalHeight);
      const pw=img.naturalWidth*k,ph=img.naturalHeight*k,[px='50%',py='50%']=style.objectPosition.split(' ');
      const offset=(value,space)=>value.endsWith('%')?parseFloat(value)*space/100:parseFloat(value)||0;
      const dx=offset(px,w-pw)+(pw-w)/2,dy=offset(py,h-ph)+(ph-h)/2;
      cx+=a*dx+c*dy;cy+=b*dx+d*dy;width=Math.abs(a)*pw+Math.abs(c)*ph;height=Math.abs(b)*pw+Math.abs(d)*ph;
    }
    const clip=bare?img.dataset.frameClip?.split(',').map(Number):null;
    return {left:cx-width/2,top:cy-height/2,width,height,angle:Math.atan2(b,a),position:style.objectPosition,filter:style.filter,
      clip:clip?.length===4&&clip.every(Number.isFinite)?clip:[0,0,0,0],mask:bare?style.maskImage:'none',maskComposite:style.maskComposite};
  },
  animateFlights() {
    if(this.flightRaf)return;
    this.flightRaf=requestAnimationFrame(now=>{
      this.flightRaf=0;
      // A roster can lift many photos at once. Read all their destinations before any write forces layout again.
      const frame=[...(this.activeFlights||[])].map(flight=>[flight,flight.measure()]);
      for(const [flight,to]of frame)flight.tick(now,to);
      if(this.activeFlights?.size)this.animateFlights();
    });
  },
  // How a pane shows its picture, as fractions of its window: where the framing (a crop, a turn) has put it. A bare
  // card (a sea print, a tile) contains the whole picture, which is `null` here.
  frameOf(img) {
    const win = img?.closest?.(".window");
    if (!win) return null;
    const r = img.getBoundingClientRect(), w = win.getBoundingClientRect();
    if (!w.width || !w.height || !r.width) return null;
    return { x: (r.left - w.left) / w.width, y: (r.top - w.top) / w.height, w: r.width / w.width, h: r.height / w.height };
  },
  // A flight is a whole polaroid: paper, window and the picture framed inside it. The framing travels too, from how
  // the origin showed the picture to how the destination will (a crop is there from the first frame, so nothing
  // lands and then snaps into it).
  fly(src, from, target, { ms = 360, cls = "", pid, kind, valid = () => true, finish = () => {}, frameFrom = null, frameTo = null } = {}) {
    this.flights ||= new Map();
    const replaced=pid!=null?this.flights.get(pid):null;
    const img = document.createElement("div");
    img.className = `world-fly print ${cls}`;
    img.innerHTML = `<div class="paper"><div class="window"><img src="${src}" alt=""></div></div>`;
    const picture = img.querySelector("img");
    let resolve,ended=false,current={...from,angle:from.angle||0,clip:[...(from.clip||[0,0,0,0])]},previous=null,start=null,end=null,progress=0;
    const promise=new Promise(ok=>resolve=ok),flight={img,picture,kind,rect:current,promise,cancel:()=>done(false)};
    const contain=(W,H)=>{const iw=picture.naturalWidth,ih=picture.naturalHeight;if(!iw||!ih)return null;const k=Math.min(W/iw,H/ih);return {x:(W-iw*k)/2/W,y:0,w:iw*k/W,h:ih*k/H};};
    const paint=()=>{
      const co=Math.abs(Math.cos(current.angle)),si=Math.abs(Math.sin(current.angle)),den=Math.max(.1,co*co-si*si);
      const width=Math.max(1,(co*current.width-si*current.height)/den),height=Math.max(1,(co*current.height-si*current.width)/den);
      Object.assign(img.style,{left:`${current.left+(current.width-width)/2}px`,top:`${current.top+(current.height-height)/2}px`,
        width:`${width}px`,height:`${height}px`,transform:`rotate(${current.angle}rad)`,
        clipPath:current.clip.some(v=>v>0)?`inset(${current.clip.map(v=>`${v*100}%`).join(' ')} round var(--radius))`:'none',
        maskImage:current.mask||'none',maskComposite:current.maskComposite||'add'});
      // The picture inside the window: the origin's framing blended into the destination's as the card travels.
      const W=width*.89,H=height*.83125,a=frameFrom||contain(W,H),b=(typeof frameTo==='function'?frameTo():frameTo)||contain(W,H);
      const f=a&&b?{x:a.x+(b.x-a.x)*progress,y:a.y+(b.y-a.y)*progress,w:a.w+(b.w-a.w)*progress,h:a.h+(b.h-a.h)*progress}:a||b;
      if(f)Object.assign(picture.style,{left:`${f.x*W}px`,top:`${f.y*H}px`,width:`${f.w*W}px`,height:`${f.h*H}px`,objectFit:'fill'});
      else Object.assign(picture.style,{left:'0px',top:'0px',width:'100%',height:'100%',objectFit:'contain'});
    };
    const done=arrived=>{
      if(ended)return;ended=true;this.activeFlights?.delete(flight);
      finish(arrived,flight);img.remove();if(pid!=null&&this.flights.get(pid)===flight)this.flights.delete(pid);resolve(arrived);
    };
    if(pid!=null)this.flights.set(pid,flight);
    replaced?.cancel();
    paint();
    document.body.append(img);
    flight.measure=()=>valid()&&(typeof target==='function'?target():target);
    flight.tick=(now,to)=>{
      if(ended)return;
      if(!to?.width||!to.height){done(false);return;}
      if(start==null){start=now;end=now+(reduceMotion?0:ms);}
      // Follow the live destination. A dock, decoded image or resized viewport may move it during the flight.
      if(previous&&Math.max(...['left','top','width','height'].map(k=>Math.abs(to[k]-previous[k])))>6)
        end=Math.min(start+ms+700,Math.max(end,now+180));
      const remaining=Math.max(0,end-now),elapsed=previous?Math.max(0,now-previous.time):0;
      const blend=remaining?1-Math.pow(remaining/(remaining+elapsed),3):1;
      progress+=(1-progress)*blend;
      for(const key of ['left','top','width','height'])current[key]+=(to[key]-current[key])*blend;
      current.angle+=((to.angle||0)-current.angle)*blend;
      const clip=to.clip||[0,0,0,0];current.clip=current.clip.map((v,i)=>v+(clip[i]-v)*blend);
      current.mask=to.mask;current.maskComposite=to.maskComposite;
      picture.style.filter=[to.filter==='none'?'':to.filter,cls==='lose'?'grayscale(.5)':''].filter(Boolean).join(' ');
      paint();previous={...to,time:now};img.classList.add('flying');
      if(!remaining){done(true);return;}
    };
    this.activeFlights ||= new Set();this.activeFlights.add(flight);this.animateFlights();
    return flight;
  },
  // A photo can also appear in a roster or a pile. Its largest main copy is the one that flies and gets recycled.
  images(root) {
    const best=new Map(),clips=new Map();
    for(const img of root?.querySelectorAll('img[src*="/img/"]') || []) {
      const match=img.getAttribute("src").match(/\/img\/[pt]\/(\d+)\.jpg/);
      // Scrolling an overview changes which cards are mounted, not where the photos belong. Treating that as a
      // scene change launches ghost copies to and from the sea and hides the freshly mounted thumbnails.
      if(!match||img.closest(".under, .screen-rail, .board-card, .stacker .lookgrid"))continue;
      const pid=Number(match[1]),rect=img.getBoundingClientRect();
      if(!rect.width||!rect.height||rect.bottom<=0||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth)continue;
      // A long overview can contain thousands of pictures. Only prints visible through its scrollports fly.
      let clipped=false;
      for(let box=img.closest('.screen-body, .photo-fan');box;box=box.parentElement?.closest('.screen-body, .photo-fan')){
        if(!clips.has(box))clips.set(box,box.getBoundingClientRect());const edge=clips.get(box);
        if(rect.bottom<=edge.top||rect.top>=edge.bottom||rect.right<=edge.left||rect.left>=edge.right){clipped=true;break;}
      }
      if(clipped)continue;
      const area=rect.width*rect.height,old=best.get(pid);
      if(!old||area>old.area)best.set(pid,{pid,img,rect,area});
    }
    return [...best.values()];
  },
  // the photos on show in `root` now (call it before `root` re-renders)
  grab(root) {
    if (!root || this.mode === "hidden" || reduceMotion) return [];
    return this.images(root).map(({pid,img})=>({pid,rect:this.flights?.get(pid)?.rect||this.arrivals?.get(pid)?.from||this.rect(img),frame:this.frameOf(img),
      fate:img.closest(".won")?"win":img.closest(".lost")?"lose":"back"})).filter(x=>x.rect?.width&&x.rect.height);
  },
  // after `root` re-rendered: the photos that left sink back to the sea, the new ones rise out of it
  swap(root, gone) {
    if (this.mode === "hidden" || reduceMotion || !this.sea) return;
    const now = this.images(root).map(x=>x.img);
    const pidOf = (img) => Number(img.getAttribute("src").match(/\/img\/[pt]\/(\d+)\.jpg/)[1]);
    const here = new Set(now.map(pidOf));
    for (const g of gone) if (!here.has(g.pid)) this.sink(g.pid, g.rect, g.fate, g.frame);
    const had = new Set(gone.map((g) => g.pid));
    for (const img of now) {
      const pid = pidOf(img);
      const arrival=this.arrivals?.get(pid);
      // Recycling replaces nodes while the same photo is flying. Transfer its live endpoint and reveal ownership.
      if(arrival&&arrival.img!==img){
        if(arrival.img.worldFlight===arrival.token){delete arrival.img.worldFlight;arrival.img.style.opacity='';}
        arrival.img=img;img.worldFlight=arrival.token;img.style.opacity='0';
      }
      if (had.has(pid) || this.lifted.has(pid)&&this.flights?.get(pid)?.kind!=='sink') continue;
      const tile = this.tileOf(pid);
      if (!img || !tile) continue;
      const view=S.view,token={},from={...(this.flights?.get(pid)?.rect||this.rect(tile.querySelector('.pile-cover')||tile))};
      if (!from?.width) continue;
      this.flights?.get(pid)?.cancel();
      this.lifted.add(pid);
      const incoming={img,token,from};this.arrivals ||= new Map();this.arrivals.set(pid,incoming);
      img.worldFlight=token;img.style.opacity = "0";
      const valid=()=>!left(view)&&incoming.img.isConnected&&incoming.img.worldFlight===token;
      const reveal=()=>{const current=incoming.img;if(current.worldFlight===token){delete current.worldFlight;current.style.opacity='';}
        if(this.arrivals.get(pid)===incoming)this.arrivals.delete(pid);};
      // Decode before measuring contain, then let the live destination absorb later layout and wobble changes.
      img.decode().catch(()=>{}).then(()=>{
        if(!valid()){reveal();return;}
        this.lifted.add(pid);tile.classList.add('lifted');
        this.fly(incoming.img.currentSrc||incoming.img.src,from,()=>this.rect(incoming.img),{pid,kind:'rise',valid,finish:reveal,frameTo:()=>this.frameOf(incoming.img)});
      });
    }
  },
  sink(pid, rect, fate, frame = null) {
    const tile = this.tileOf(pid);
    if (!tile) {this.flights?.get(pid)?.cancel();this.lifted.delete(pid);return;}
    const from=this.flights?.get(pid)?.rect||rect;
    this.lifted.add(pid);tile.classList.add('lifted');
    this.fly(P(pid),from,()=>this.rect(tile.querySelector('.pile-cover')||tile),{pid,kind:'sink',ms:440,frameFrom:frame,
      cls:fate==='win'?'win':fate==='lose'?'lose':'',valid:()=>tile.isConnected&&this.mode!=='hidden',finish:(arrived,flight)=>{
        if(this.flights.get(pid)!==flight)return;
        this.lifted.delete(pid);tile.classList.remove('lifted');
        if(arrived&&fate==='win'){tile.classList.remove('ps-won');void tile.offsetWidth;tile.classList.add('ps-won');}
      }});
  },
  // The grab: any photo in the sea comes up to the middle, bigger, with everything about it and what you can do with
  // it; Esc (or a click outside) shrinks it back to its spot.
  tagMenu(key, anchor) {
    const tag=this.tagMeta?.get(key);if(!tag)return;
    $(".island-pop")?.remove();
    const photos=[...this.photos.values()].filter((p)=>p.tags.includes(key)),pop=document.createElement("div");
    pop.className="pop-card island-pop sea-tag-pop";
    pop.innerHTML=`<form><button class="btn" type="button" data-tag-emoji>${esc(tag.emoji||"🏷️")}</button><input class="hint-input" aria-label="Tag name" name="label" value="${esc(tag.label)}" maxlength="40" required><button class="btn">Save</button></form>
      <p class="muted small">${plural(photos.length,"photo")} · includes takes and photos set aside</p>
      <div class="sea-tag-photos">${photos.slice(0,12).map((p)=>`<button data-tag-photo="${p.id}" aria-label="Open photo"><img src="${T(p.id)}" alt="" loading="lazy"></button>`).join("")}</div>
      <div class="row"><button class="btn" data-tag-select ${photos.length?"":"hidden"}>Select its photos</button><a class="btn" href="#tags?key=${encodeURIComponent(key)}">Edit tag & roster</a><a class="btn primary" href="#tags?play=${encodeURIComponent(key)}">Check tag →</a></div>`;
    document.body.append(pop);const r=anchor.getBoundingClientRect();
    pop.style.left=`${Math.max(8,Math.min(r.left,innerWidth-pop.offsetWidth-8))}px`;
    pop.style.top=`${Math.max(62,Math.min(r.bottom+8,innerHeight-pop.offsetHeight-12))+window.scrollY}px`;
    const close=()=>{pop.remove();this.sea.highlight(null);document.removeEventListener("pointerdown",away,true);};
    const away=(e)=>{if(!pop.contains(e.target)&&!e.target.closest(".emoji-pop"))close();};
    setTimeout(()=>document.addEventListener("pointerdown",away,true),0);
    const save=async(body)=>{try{const result=await api("/api/tags/meta",{key,...body});updateHudQuiet(result.game);close();toast("Saved. Z undoes it.");}catch(e){toast(e.message);}};
    $("form",pop).onsubmit=(e)=>{e.preventDefault();save({label:new FormData(e.target).get("label")});};
    $("[data-tag-emoji]",pop).onclick=(e)=>emojiPicker(e.currentTarget,(emoji)=>save({emoji}));
    $("[data-tag-select]",pop).onclick=()=>{close();this.sea.select(photos.map((p)=>p.id));this.sea.highlight(photos.map((p)=>p.id));toast(`${plural(photos.length,"photo")} selected. Click one to work with them.`);};
    $$("[data-tag-photo]",pop).forEach((button)=>button.onclick=()=>{close();this.inspect(Number(button.dataset.tagPhoto));});
    $$("a",pop).forEach((link)=>link.onclick=close);
    pop.onkeydown=(e)=>{e.stopPropagation();if(e.key==="Escape")close();};
  },
  async stackPick(pid) {
    const first = this.stackWith; this.stackWith = null;
    if (!first || first === Number(pid)) return;
    try { const r = await api("/api/groups/merge", {photos:[first,Number(pid)]}); updateHudQuiet(r.game); paintSaveChip(); toastOnce("stacked", "Stacked. Z undoes it."); }
    catch(e) {toast(e.message);}
  },
  openStack(pid,source) {
    const it=this.sea?.items.get(Number(pid));if(!it)return;
    if(this.mode==='live'&&this.handlers?.onStack)return this.handlers.onStack(it,source);
    return this.inspect(pid,[Number(pid)],null,{stackOpen:true,source});
  },
  async inspect(pid, selection, changed, {stackOpen=false,source=null} = {}) {
    if (this.stackWith&&!stackOpen) return this.stackPick(pid);
    const tile = this.tileOf(pid), it = this.sea && this.sea.items.get(Number(pid));
    if (!tile || !it || this.inspecting) return;
    this.inspecting = true;
    const view = S.view, chosen = selection || (it.selected ? [...this.sea.items.values()].filter((x)=>x.selected).map((x)=>x.id) : [Number(pid)]);
    let b, meta, stack;
    try { [b,meta,stack] = await Promise.all([api("/api/draw/board?per=1&uper=1"),api("/api/tags?all=1"),api(`/api/group/${pid}`)]); }
    catch(e) { this.inspecting=false; if(!left(view))toast(e.message);return; }
    if(left(view)){this.inspecting=false;return;}
    const g = b.groups.find((x) => x.id === it.group);
    const rank = this.top && this.top.get(it.id);
    const tags = meta.tags.filter((t)=>(it.tags||[]).includes(t.key));
    const movable=this.groupSelection(chosen,b.cup);
    const ov = document.createElement("div");
    ov.className = `inspect${stackOpen?' stack-open':''}`;
    ov.innerHTML = `<div class="inspect-card">
        <div class="inspect-pictures">${chosen.slice(0,4).map((p)=>`<div class="print"><img class="inspect-photo" src="${P(p)}" alt=""></div>`).join("")}</div>
        <div class="inspect-chrome">
          <div class="inspect-line">${g ? `<span class="team-chip static">${esc(g.emoji || "🗂️")} ${esc(g.name)}</span>` : `<span class="muted">Not in a group yet</span>`}
            ${rank ? `<span class="stat-chip good">#<b>${rank}</b> on the board</span>` : ""}${chosen.length>1?`<span class="stat-chip">${plural(chosen.length,"photo")} selected</span>`:""}
            ${stack.members.length > 1 ? `<button class="btn ghost" data-in="stack" aria-expanded="false">Open ${plural(stack.members.length,"take")}</button>` : ""}</div>
          ${tags.length ? `<div class="inspect-tags">${tags.map((t, i) => `<span class="tag-chip on" style="--i:${i}">${esc(t.emoji || "🏷️")} ${esc(t.label)}</span>`).join("")}</div>` : ""}
          <div class="inspect-edit">${movable.length?`<details><summary>Move ${plural(movable.length,"shot")} to a group</summary><div class="inspect-bins">${binsHtml(b.bins,null,null)}</div></details>`:""}
            <details><summary>Edit tags</summary><div class="inspect-tag-edit">${meta.tags.map((t)=>`<button class="tag-chip ${(it.tags||[]).includes(t.key)?"on":""}" data-in-tag="${esc(t.key)}">${esc(t.emoji||"🏷️")} ${esc(t.label)}</button>`).join("")}</div>
              <form id="inspect-new-tag"><input class="hint-input" name="label" maxlength="40" placeholder="New tag" aria-label="New tag" required><button class="btn">Add tag</button></form></details></div>
          <div class="inspect-fan" hidden></div>
          <div class="inspect-actions"><button class="btn ghost" data-in="full">⤢ Full size</button>${photoPathButton(pid)}
            <button class="btn ghost" data-in="merge">${chosen.length>1?"Stack these photos":"Stack with another photo"}</button>
            <button class="btn ghost ${it.cut?"":"danger"}" data-in="toss" title="${it.cut?"Back into the running":"Out of the running: it goes to Set aside"}">${it.cut?"Rescue":"Toss"}</button>
            <button class="btn ghost" data-in="undo" ${b.undo?"":"hidden"}>Undo <kbd>Z</kbd></button>
            <button class="btn primary" data-in="close">Back to the sea <kbd>Esc</kbd></button></div>
        </div></div>`;
    document.body.append(ov);
    const img = $(".inspect-photo", ov);
    ov.style.visibility='hidden';img.style.opacity='0';
    await Promise.all($$('.inspect-photo',ov).map(photo=>photo.decode().catch(()=>{})));
    if(left(view)){ov.remove();this.inspecting=false;return;}
    const from=this.rect(source?.querySelector('.pile-cover,.window img')||tile.querySelector('.pile-cover')||tile),wasLifted=tile.classList.contains('lifted');
    tile.classList.add("lifted");
    this.sea.presentation?.follow(); // A deep, resting sea has no physics tick to withdraw its old notes layer.
    ov.style.visibility='';
    ov.classList.add("open");
    const keys = S.onKey;
    let done = false, dirty = false, busy = false;
    const close = (immediate=false) => {
      if (done) return;
      done = true;
      if (S.onKey === handler) S.onKey = keys;
      const back = this.tileOf(pid);
      const destination=source?.isConnected?source:back;
      const origin={...(this.flights?.get(pid)?.rect||this.rect(img))};
      this.flights?.get(pid)?.cancel();
      ov.classList.remove("open");
      img.style.opacity='0';
      const cleanup=()=>{ov.remove();back?.classList.toggle('lifted',wasLifted);this.inspecting=false;
        if(typeof PhotoNotes!=='undefined')PhotoNotes.camera();
        if(this.closeInspect===cancel)this.closeInspect=null;if(dirty&&!left(view))changed?.();};
      if(immediate||!destination||!origin.width){cleanup();return;}
      this.fly(img.currentSrc||img.src,origin,()=>this.rect(destination.querySelector('.pile-cover,.window img')||destination),{
        pid,kind:'inspect-sink',ms:420,valid:()=>ov.isConnected&&!left(view),finish:cleanup});
    };
    const cancel=()=>close(true);this.closeInspect=cancel;
    if(from?.width)this.fly(img.currentSrc||img.src,from,()=>this.rect(img),{pid,kind:'inspect-rise',ms:420,
      valid:()=>ov.isConnected&&!done&&!left(view),finish:()=>{if(!done)img.style.opacity='';}});
    else img.style.opacity='';
    const act = async (path, body, exit=true) => {
      if(busy || done)return;busy=true;
      try {const r=await api(path,body);if(r.game){updateHudQuiet(r.game);paintSaveChip();}dirty=true;
        $("[data-in=undo]",ov).hidden=false;toast("Saved. Z undoes it.");if(exit)close();return r;}
      catch(e){if(!left(view))toast(e.message);}finally{busy=false;}
    };
    const handler = (e) => {const gi=groupKey(e); if(gi!=null && b.bins[gi] && movable.length) {e.preventDefault();act("/api/draw/move",{photos:movable,theme:b.bins[gi].id});}
      else if(e.key==="z"||e.key==="Z"){e.preventDefault();act("/api/draw/undo",{});}
      else if(e.key.toLowerCase()==="x"&&!it.cut){e.preventDefault();$("[data-in=toss]",ov).click();}
      else if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); close(); } };
    S.onKey = handler;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    $("[data-in=close]", ov).onclick = () => close();
    $("[data-in=full]", ov).onclick = () => { close(); openViewer(Number(pid)); };
    $$("[data-bin]",ov).forEach((el)=>el.onclick=(e)=>{
      const group=b.bins.find((g)=>g.id===Number(el.dataset.bin));
      if(group&&binTools(e,el,group,()=>{}))return;
      act(el.dataset.bin==="new"?"/api/draw/new":"/api/draw/move",{photos:movable,...(group?{theme:group.id}:{})});
    });
    $$("[data-in-tag]",ov).forEach((button)=>button.onclick=async()=>{
      const k=button.dataset.inTag, on=button.classList.contains("on");
      if(await act("/api/tags/set",{photos:chosen,on:on?[]:[k],off:on?[k]:[]},false))button.classList.toggle("on",!on);
    });
    $("#inspect-new-tag",ov).onsubmit=(e)=>{e.preventDefault();act("/api/tags/new",{photos:chosen,label:new FormData(e.target).get("label")});};
    $("[data-in=undo]",ov).onclick=()=>act("/api/draw/undo",{});
    $("[data-in=merge]",ov).onclick=()=>{if(chosen.length>1)act("/api/groups/merge",{photos:chosen});else{close();this.stackWith=Number(pid);toast("Choose another photo in the sea to stack with this one.");}};
    const fan=$(".inspect-fan",ov), open=$("[data-in=stack]",ov);
    if(open)open.onclick=()=>{fan.hidden=!fan.hidden;open.setAttribute('aria-expanded',String(!fan.hidden));open.textContent=`${fan.hidden?'Open':'Hide'} ${plural(stack.members.length,'take')}`;if(!fan.hidden){
      fan.classList.add("photo-fan");fan.style.setProperty("--takes",stack.members.length);
      fan.innerHTML=stack.members.map((p,i)=>`<div class="ftile" tabindex="0" style="${fanStyle(i,stack.members.length)}"><img src="${T(p)}" alt="Take" loading="lazy"><div class="ftile-actions">
        ${p===stack.rep?"👑 Kept":`<button data-in-keep="${p}">Keep</button>`}<button data-in-split="${p}">Split out</button>${photoPathButton(p)}</div></div>`).join("");
      $$("[data-in-keep]",fan).forEach((x)=>x.onclick=()=>act("/api/frame",{photo:Number(x.dataset.inKeep)}));
      $$("[data-in-split]",fan).forEach((x)=>x.onclick=()=>act("/api/groups/split",{photo:Number(x.dataset.inSplit)}));
    }};
    if(stackOpen)open?.click();
    $("[data-in=toss]", ov).onclick = async () => {
      if(it.cut)return act("/api/rescue",{ids:chosen,on:true});
      if(await act("/api/draw/toss",{photos:chosen}))Sound.play("toss");
    };
  },
  release(root) {
    // Focus is an activity, not library state. Carrying it into the next stage grows unrelated photos over play.
    this.sea?.releaseFocus();
    if(this.sea){this.sea.mouse.x=this.sea.mouse.y=-1e5;this.sea.hold(null);this.sea.select([]);}
    const gone = this.grab(root || $("#main"));
    this.recycled = this.recycled || new Map();
    const outgoing=root || $("#main");
    for (const {pid,img} of this.images(outgoing)) {
      const old=this.recycled.get(pid);
      this.recycled.set(pid,old&&outgoing.contains(old)&&!old.closest(".under")?old:img);
    }
    this.closeInspect?.();
    for (const pid of [...this.lifted]) {
      const photo = gone.find((x) => x.pid === pid);
      if (photo) this.sink(pid, photo.rect, "back"); else {this.flights?.get(pid)?.cancel();this.lifted.delete(pid);this.tileOf(pid)?.classList.remove("lifted");}
    }
    this.focused = [];
  },
  handover(sea) {
    this.sea.destroy(); this.el.remove();
    this.el = sea.el; this.sea = sea;
    this.el.id = "world"; this.el.classList.remove("an-field", "ps-field");
    this.el.removeAttribute("aria-hidden"); sea.catalog=true;sea.highlight(null);document.body.prepend(this.el);
    Object.assign(sea, this.plain); this.stale = true;
  },
};
const WORLD_SOLID = ["#main .screen-head", "#main .screen-bar", "#main .screen-rail > *", "#main .duel-head", "#main .controls:not([hidden])",
  "#main #stage", "#main #done-slot > *", "#main .group-table:not([hidden])", "#main .deck", "#main .twin-arena", "#main .screen-body > .empty:not(.loading)",
  "#main .card", "#main .grid", "#main .podium", "#main .reveal-strip", "#main .bracket", "#main .finals-arena",
  "#main .finals-done", "#main .an-panel", "#main .save-grid", "#main .onboard-body > *", "#main .sections", "#main .tb-section",
  "#main .people", "#main .screen-body > h2", "#main .map-note", "#main .title-road", "#main .tag-call", "#main .stage-results", "#main .vn-catalog",
  "#game-help", "#game-help-hint", "#main .shot-select", "#main .tile-frames-bar", "#main .photo-fan > .ftile", "#main [data-solid]"].join(", ");
const WORLD_MODES = { home: "ambient", ready: "ambient", duel: "focus", sweep: "focus", finals: "focus", stacks: "dim", shortlist: "dim",
  leaderboard: "dim", reveal: "dim", cuts: "dim", people: "dim" };

// ---------------------------------------------------------------- boot
(async () => {
  let state;
  try { state = await loadState(); } catch (e) { $("#main").innerHTML = `<div class="page"><p class="error">Can't reach MatchER: ${esc(e.message)}</p></div>`; return; }
  World.init();
  document.addEventListener("click", (e) => { if (e.target.closest?.("#journey-title")) location.hash = "#home"; });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "journey-title") location.hash = "#home"; });
  // Developer mode: --debug on the server, ?debug=1 once in the address bar (remembered), or debug=0 to forget it.
  const asked = new URLSearchParams(location.search).get("debug");
  try { if (asked === "1") localStorage.setItem("matcher-debug", "1"); else if (asked === "0") localStorage.removeItem("matcher-debug"); } catch (_) { /* private mode */ }
  let remembered = false; try { remembered = localStorage.getItem("matcher-debug") === "1"; } catch (_) { /* private mode */ }
  S.debug = !!state?.debug || remembered;
  if (S.debug && typeof DevPanel !== "undefined") DevPanel.init();
  route();
  Sea.init();
})();
