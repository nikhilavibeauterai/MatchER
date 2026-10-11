"use strict";

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n || 0).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const plural = (n, word, many = `${word}s`) => `${fmt(n)} ${n === 1 ? word : many}`;
const P = (id) => `/img/p/${id}.jpg`;
const T = (id) => `/img/t/${id}.jpg`;
const F = (id) => `/img/f/${id}.jpg`;

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MatchER": "1" },
    body: JSON.stringify(body),
  };
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
  if (body !== undefined && /^\/api\/(draw|tags|groups|rescue|sweep|cup|settings|frame|undo|people)/.test(path) && typeof World !== "undefined") World.dirty();
  return data;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
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
const VIEWS = { onboard: viewOnboard, analyze: viewAnalyze, home: viewHome, ready: viewHome, duel: viewDuel,
  shortlist: viewShortlist, leaderboard: viewShortlist, draw: viewDraw, cuts: viewCuts, people: viewPeople,
  sweep: viewSweep, finals: viewFinals, reveal: viewReveal, saves: viewSaves, stacks: viewStacks, tournament: viewTournament };

async function loadState() {
  const st = await api("/api/state");
  S.lib = st.library;
  S.recent = st.recent || [];
  return st;
}

function stopPolling() {
  if (S.poll) clearInterval(S.poll);
  S.poll = null;
}

function route() {
  stopPolling();
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
  document.body.classList.toggle("no-bar", bare);
  document.body.classList.toggle("mode-gallery", MODE() === "gallery");
  document.body.classList.remove("is-dragging");
  paintSaveChip();
  S.onKey = null;
  S.filter = filterPref();
  S.crop = cropPref();
  S.view = (S.view || 0) + 1;
  const main = $("#main");
  main.innerHTML = "";
  window.scrollTo(0, 0);
  if (typeof World !== "undefined") {
    World.release();
    const q2 = new URLSearchParams(query || "");
    const groupsView = (() => { try { return localStorage.getItem("matcher-groups-view"); } catch (_) { return null; } })() || (innerWidth >= 900 ? "sea" : "list");
    World.setMode(bare ? "hidden" : v === "draw" ? (q2.get("sort") || q2.get("play") ? "focus" : groupsView === "sea" ? "live" : "dim")
      : v === "stacks" && q2.get("check") ? "focus" : WORLD_MODES[v] || "dim");
  }
  VIEWS[v](main, new URLSearchParams(query || ""));
  if (!bare && v !== "home") refreshHud();
}

window.addEventListener("hashchange", route);
document.addEventListener("keydown", (e) => {  // the sweep and the finals bring their own keys
  if (e.target.closest("input, select, textarea, dialog") || e.ctrlKey || e.metaKey || (e.altKey && !/^Digit/.test(e.code))
    || $("dialog[open]")) return;
  if (S.onKey) S.onKey(e);
  if (e.defaultPrevented || e.repeat || location.hash.startsWith("#duel") || !S.lib) return;
  if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFilter(); }  // the auto-filter and auto-crop, anywhere
  else if (e.key === "c" || e.key === "C") { e.preventDefault(); toggleCrop(); }
  else if (e.key === "Enter" && (!document.activeElement || document.activeElement === document.body)) {
    const go = $(".screen-bar .bar-right a.btn.primary, .next-up a.btn.primary");  // Enter takes the way forward, on every screen
    if (go) { e.preventDefault(); go.click(); }
  }
});

// While a screen loads (or if it can't), the same frame it will fill, so nothing jumps from a page to a screen.
const LOADING = (text = "Loading…") => `<div class="screen no-rail"><div class="screen-body fill"><div class="empty">${text}</div></div></div>`;
const FAILED = (msg) => `<div class="screen no-rail"><div class="screen-body fill"><div class="empty error">${esc(msg)}</div></div></div>`;

// True once the person has moved on from the page that started this request (its reply must not render).
const left = (token) => token !== S.view;

// ---------------------------------------------------------------- onboarding
function viewOnboard(main) {
  main.innerHTML = `
    <div class="screen onboard no-rail">
      <div class="screen-head">
        <div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i></span>MatchER</div>
        <h1>New save</h1>
        <span class="grow"></span>
        ${helpBtn(`Point it at a folder. It clears out the junk on its own, then you play quick head-to-head duels. It learns your taste as
          you go, ranks everything (even the photos you never see), and crowns champions. Each folder is its own save.`)}
      </div>
      <div class="screen-body onboard-body">
        <div class="onboard-hero">
          <h2 class="hero-title">Photo tournaments that find your best shots.</h2>
          <p class="lede">Point it at a folder. It clears out the junk on its own, then you play quick head-to-head duels.
            It learns your taste as you go, ranks everything (even the photos you never see), and crowns champions.</p>
          <ol class="onboard-path" aria-label="How it plays">${STAGES.map(([, icon, , title, line]) =>
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
                  <span class="faint small" id="sample-note">about 45 public-domain photos from Wikimedia Commons, downloaded when you click</span></div>
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

  const err = (msg) => { const e = $("#pick-error"); e.textContent = msg || ""; e.hidden = !msg; };
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
      const r = await api("/api/pick-native", { start: "" });
      if (!r.available) { toast("No desktop folder dialog found; browse here instead."); openBrowser(); }
      else if (r.path) await openLibrary(r.path);
    } catch (e) { err(e.message); }
    b.disabled = false;
    b.textContent = "Choose folder…";
  };
  $("#toggle-browse").onclick = () => ($("#browser").hidden ? openBrowser() : ($("#browser").hidden = true));
  $("#sample").onclick = async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    err("");
    let st;
    try { st = await api("/api/sample", {}); } catch (e) { err(e.message); b.disabled = false; return; }
    while (st.state === "running") {
      $("#sample-note").textContent = `Downloading… ${st.done} of ${st.total}`;
      await sleep(1200);
      try { st = await api("/api/sample"); } catch (e) { st = { state: "error", error: e.message }; }
    }
    if (st.state === "error") { err(st.error); b.disabled = false; $("#sample-note").textContent = ""; return; }
    mode = "gallery";
    await openLibrary(st.path);
  };
  $("#use-path").onclick = () => openLibrary($("#path").value);
  $("#path").addEventListener("keydown", (e) => { if (e.key === "Enter") openLibrary($("#path").value); });

  async function openBrowser(path) {
    const box = $("#browser");
    box.hidden = false;
    let d;
    try { d = await api(`/api/browse?path=${encodeURIComponent(path || "")}`); } catch (e) { err(e.message); return; }
    const parts = d.path.split("/").filter(Boolean);
    const crumbs = `<button data-go="/">/</button>` + parts.map((p, i) =>
      `<button data-go="/${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`).join('<span class="faint">/</span>');
    box.innerHTML = `
      <div class="suggest">${d.suggestions.map((s) => `<button class="chip" data-go="${esc(s.path)}">${esc(s.label)}</button>`).join("")}</div>
      <div class="crumbs">${crumbs}</div>
      <div class="dirs">${d.dirs.length ? d.dirs.map((x) => `
        <button class="dir" data-go="${esc(x.path)}"><span>${esc(x.name)}</span>
          <span class="n ${x.photos ? "has" : ""}">${x.photos ? `${fmt(x.photos)} photo${x.photos === 1 ? "" : "s"}` : ""}</span></button>`).join("")
        : `<div class="dir faint">No subfolders</div>`}</div>
      <div class="browser-foot">
        <span class="muted small">${d.photos ? `${fmt(d.photos)} photos directly in this folder` : "No photos directly in this folder"}</span>
        <button class="btn primary" id="use-this">Use this folder</button>
      </div>`;
    $$("[data-go]", box).forEach((b) => (b.onclick = () => openBrowser(b.dataset.go)));
    $("#use-this", box).onclick = () => openLibrary(d.path);
  }

  async function openLibrary(path, resume = false) {
    err("");
    if (!path || !path.trim()) { err("Pick or paste a folder first."); return; }
    try {
      await api("/api/library", resume ? { path: path.trim() } : { path: path.trim(), mode });
      await loadState();
      location.hash = "analyze";
      route();
    } catch (e) { err(e.message); }
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
      ${g.level ? `<span class="chip-lvl">Lv ${g.level} <span class="chip-title">${esc(g.level_name || "")}</span></span>` : ""}
      <span class="xpbar"><i style="width:${xp}%"></i></span></span>`;
  chip.title = `${sv.name} · ${g.xp != null ? `${fmt(g.xp)} XP` : ""}: switch save`;
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
    <div class="save-card ${sv.current ? "current" : ""} ${sv.exists ? "" : "missing"}" data-save="${i}" tabindex="0" role="button"
      aria-label="${esc(sv.name)}${sv.current ? " (playing now)" : ""}" style="--i:${i}">
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
        <span class="faint small">${sv.exists ? (sv.played ? `Played ${ago(sv.played)}` : "") : "Folder missing (moved or unplugged?)"}</span>
      </span>
      <button class="save-forget" data-forget="${i}" title="Forget this save" aria-label="Forget the save for ${esc(sv.name)}">✕</button>
    </div>`;
  };
  const cur = d.saves.findIndex((sv) => sv.current && sv.exists);
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
        <div class="bar-right">${cur >= 0 ? `<button class="btn primary big" id="continue">Continue: ${esc(d.saves[cur].name)} <kbd>Enter</kbd></button>`
          : `<a class="btn primary big" href="#onboard?new=1">＋ New save</a>`}</div>
      </div>
    </div>`;
  const open = async (sv) => {
    if (sv.current && S.lib) { location.hash = "#home"; return; }
    if (!sv.exists) { toast("That folder isn't there any more. Plug it back in, or forget the save."); return; }
    try {
      await api("/api/library", { path: sv.path });
      await loadState();
      S.game = null;
      Sound.play("level");
      location.hash = S.lib && S.lib.analyzed && !S.lib.analyzing ? "#home" : "#analyze";
      route();
    } catch (e) { toast(e.message); }
  };
  $$("[data-save]", main).forEach((el) => {
    el.onclick = (e) => { if (!e.target.closest("[data-forget]")) open(d.saves[Number(el.dataset.save)]); };
    el.onkeydown = (e) => { if (e.target === el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(d.saves[Number(el.dataset.save)]); } };
  });
  const go = $("#continue", main);
  if (go) go.onclick = () => open(d.saves[cur]);
  // arrows walk the saves like a game's save menu; Enter plays the focused one (or the one you were playing)
  S.onKey = (e) => {
    const cards = $$(".save-card", main), at = cards.indexOf(document.activeElement);
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      cards[at < 0 ? Math.max(0, cur) : (at + step + cards.length) % cards.length].focus();
    } else if (e.key === "Enter" && at < 0 && go) { e.preventDefault(); go.click(); }
  };
  $$("[data-forget]", main).forEach((b) => (b.onclick = async () => {
    const sv = d.saves[Number(b.dataset.forget)];
    if (!confirm(`Forget the save for ${sv.name}? Its level, groups, votes and previews are deleted. Your photos themselves are never touched.`)) return;
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

const TIPS = [
  "Duels: two photos, one gut call. Fast calls (under 2.5 s) earn bonus XP and build your streak.",
  "Bursts and near-duplicates become stacks; each stack plays a mini-tournament to crown its best take.",
  "Losing once never knocks a photo out. Every call teaches it your taste, so it ranks the photos you never see.",
  "The finals: your top 8 face off in a bracket. Quarterfinals, semis, a bronze match, the final.",
  "⚡ Lightning round: 60 seconds, as many calls as you can. Beat your record.",
  "Hit 30 calls a day to keep your day streak alive.",
  "Set aside means set aside, not deleted. Anything the sorter got wrong comes back in one click.",
];

// The analysis, shown as it happens: each step gets a scene of what it's finding right now (faces on the photos it's
// reading, photos landing in their kind, your face, bursts folding), then a reveal of everything it found.
const KINDS = { people: ["🧑‍🤝‍🧑", "People"], nature: ["🏔️", "Nature"], places: ["🏙️", "Places"], animals: ["🐾", "Animals"],
  food: ["🍜", "Food"], things: ["🎲", "Things"] };
const STEP_ICONS = { models: "📦", listing: "📂", reading: "👀", understanding: "🧠", identity: "🙂", details: "🔍", organizing: "🧩" };

function viewAnalyze(main) {
  main.innerHTML = `
    <div class="screen no-rail analyzing">
      <div class="screen-head">
        <h1>✨ Getting to know your photos</h1>
        <span class="stat-chip" id="an-src"></span>
        <span class="grow"></span>
        <ol class="an-steps" id="an-steps"></ol>
      </div>
      <div class="screen-body fill an-body" id="an-body">
        <div class="ps-field an-field" id="an-sea"></div>
        <aside class="an-panel" id="an-panel"></aside>
      </div>
      <div class="screen-bar an-foot">
        <div class="an-progress"><div class="row spread"><b id="an-label">Starting…</b><span class="muted small" id="an-eta"></span></div>
          <div class="bar"><i id="an-bar"></i></div></div>
        <div class="tip" id="an-tip"></div>
        <div class="error" id="an-error" hidden></div>
      </div>
    </div>`;
  let tipAt = Math.floor(Math.random() * TIPS.length);
  const showTip = () => { const t = $("#an-tip"); if (t) t.innerHTML = `<b>How it plays</b> ${esc(TIPS[tipAt++ % TIPS.length])}`; };
  showTip();
  const tipTimer = setInterval(() => { if (!$("#an-tip")) clearInterval(tipTimer); else showTip(); }, 6000);
  $("#an-src").textContent = S.lib ? S.lib.source.split("/").filter(Boolean).pop() || S.lib.source : "";
  // The sea: every photo it reads joins it and stays. Every tag it finds pulls the photos that share it together (the
  // same tag physics as the Groups page), the biggest tags drawn as fuzzy circles. One photo at a time is grabbed out of
  // the sea to the middle, bigger, with what's being found shown right on it, then shrinks back among its kind.
  const sea = new VennSea($("#an-sea"), {});
  const info = new Map(), meta = new Map(), counts = new Map(), queue = [], forced = [];
  const facesOf = new Map(), catOf = new Map();
  let dirty = false, dripTimer = null, lastRead = null, lastCat = null, lastSeen = null;
  let scene = null, worked = false, finale = false, orgPlayed = false;
  const fr = { read: 0, cats: 0, seen: 0 };
  const words = () => (MODE() === "gallery" ? GALLERY_PHASES : {});
  const tagOf = (key, emoji, label) => { if (!meta.has(key)) meta.set(key, { emoji, label }); return key; };
  const addPhoto = (id) => { if (!info.has(id)) { info.set(id, { tags: new Set(), n: 1 }); dirty = true; } return info.get(id); };
  const give = (id, key) => { const r = addPhoto(id); if (!r.tags.has(key)) { r.tags.add(key); counts.set(key, (counts.get(key) || 0) + 1); dirty = true; } };
  // tags land a few at a time, so photos drift toward each other as you watch instead of jumping in one go
  const drip = () => {
    if (!queue.length || !$("#an-sea")) { clearInterval(dripTimer); dripTimer = null; return; }
    for (let k = Math.max(4, Math.ceil(queue.length / 10)); k > 0 && queue.length; k--) { const [id, key] = queue.shift(); give(id, key); }
    flush();
  };
  const enqueue = (id, key) => { queue.push([id, key]); if (!dripTimer) dripTimer = setInterval(drip, 120); };
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    const top = [...forced, ...[...counts].filter(([k]) => !forced.includes(k)).sort((a, b) => b[1] - a[1]).map(([k]) => k)].slice(0, 6);
    sea.setVenn(top.map((k) => { const m = meta.get(k) || { emoji: "🏷️", label: k };
      return { id: k, label: m.label, emoji: m.emoji, html: `${esc(m.emoji)} ${esc(m.label)} <span class="ps-count">${fmt(counts.get(k) || 0)}</span>` }; }),
      [...info].map(([id, r]) => ({ id, photo: id, tags: [...r.tags], n: r.n })), []);
  };
  // everything the analysis found since the last look, photo by photo: none is skipped however fast they go
  async function readFeed() {
    let f;
    try { f = await api(`/api/analysis/feed?read=${fr.read}&cats=${fr.cats}&seen=${fr.seen}`); } catch (_) { return; }
    fr.read += f.read.length; fr.cats += f.cats.length; fr.seen += f.seen.length;
    for (const [id, boxes, smiles, blinks] of f.read) {
      addPhoto(id);
      facesOf.set(id, { boxes, smiles, blinks });
      if (boxes.length) enqueue(id, tagOf("t:faces", "🙂", "Faces"));
      if (smiles) enqueue(id, tagOf("t:Smiling", "😄", "Smiling"));
      if (blinks) enqueue(id, tagOf("t:Eyes closed", "😑", "Eyes closed"));
      lastRead = id;
    }
    for (const [id, kind, themes] of f.cats) {
      addPhoto(id);
      const [icon, name] = KINDS[kind] || ["🏷️", kind];
      enqueue(id, tagOf(`kind:${kind}`, icon, name));
      for (const [emoji, label] of themes) enqueue(id, tagOf(`t:${label}`, emoji, label));
      catOf.set(id, [kind, themes]);
      lastCat = id;
    }
    for (const [id, box, found] of f.seen) {
      addPhoto(id);
      for (const [emoji, label] of found || []) enqueue(id, tagOf(`t:${label}`, emoji, label));
      lastSeen = [id, box, found || []];
    }
    flush();
  }
  // the grab: a photo lifts out of its spot, grows into the middle with what's being found on it, then goes back
  let grabbing = false;
  async function grab(id, overlay, chrome) {
    const field = $("#an-sea"), it = sea.items.get(id);
    if (grabbing || finale || !field || !it) return;
    grabbing = true;
    const img = new Image();
    img.src = P(id);
    try { await img.decode(); } catch (_) { grabbing = false; return; }
    if (!$("#an-sea")) return;
    const fw = field.clientWidth, fh = field.clientHeight, k = Math.min((fw * 0.46) / img.naturalWidth, (fh * 0.52) / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k, x0 = (fw - w) / 2, y0 = Math.max(12, (fh - h) / 2 - 50);
    const box = document.createElement("div");
    box.className = "an-grab";
    box.innerHTML = `<div class="an-grab-photo" style="width:${w}px;height:${h}px"><img src="${P(id)}" alt="">${overlay}</div><div class="an-grab-chrome">${chrome}</div>`;
    Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px` });
    const from = (t) => `translate(${t.x - sea.s / 2 - x0}px, ${t.y - sea.s / 2 - y0}px) scale(${sea.s / w})`;
    box.style.transform = from(it);
    field.append(box);
    it.el.classList.add("lifted");
    box.getBoundingClientRect();
    box.classList.add("open");
    box.style.transform = "none";
    sea.obstacles = [{ x0: x0 - 6, y0: y0 - 6, x1: x0 + w + 6, y1: y0 + h + 96, brief: true }];  // the sea makes room around it (for a moment: tiles keep their size)
    sea.layout(); sea.stir(120);
    await sleep(1700);
    const back = sea.items.get(id);
    box.classList.remove("open");
    sea.obstacles = [];
    sea.layout(); sea.stir(120);
    if (back) box.style.transform = from(back);
    await sleep(480);
    box.remove();
    back?.el.classList.remove("lifted");
    grabbing = false;
  }
  const chips = (list) => list.map(([emoji, label], i) => `<span class="tag-chip on" style="--i:${i}">${esc(emoji)} ${esc(label)}</span>`).join("");
  const grabTimer = setInterval(() => {
    if (!$("#an-sea")) { clearInterval(grabTimer); return; }
    if (grabbing || finale) return;
    if (scene === "reading" && lastRead != null) {
      const f = facesOf.get(lastRead) || { boxes: [], smiles: 0, blinks: 0 };
      grab(lastRead, f.boxes.map(([x, y, w, h]) => `<i class="face-box" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></i>`).join(""),
        f.boxes.length ? `<b>${plural(f.boxes.length, "face")}</b>${f.smiles ? ` · 😄 ${plural(f.smiles, "smile")}` : ""}${f.blinks ? ` · 😑 ${f.blinks} blinking` : ""}`
          : `<span class="muted">No faces: light, colour and sharpness read</span>`);
    } else if (scene === "understanding" && lastCat != null) {
      const [kind, themes] = catOf.get(lastCat) || ["", []];
      const [icon, name] = KINDS[kind] || ["🏷️", kind];
      grab(lastCat, "", `<div class="an-grab-tags">${chips([[icon, name], ...themes])}</div>`);
    } else if (scene === "details" && lastSeen) {
      const [id, [x, y, w, h], found] = lastSeen;
      grab(id, `<i class="crop-box" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%"></i>`,
        found.length ? `<div class="an-seen">${found.map(([emoji, label, conf], i) => `<div class="an-seen-row" style="--i:${i}">
          <span>${esc(emoji)} ${esc(label)}</span><div class="bar"><i style="width:${pct(conf)}"></i></div></div>`).join("")}</div>`
          : `<span class="muted">Nothing stands out in this one</span>`);
    }
  }, 2300);
  const cloud = () => [...counts].filter(([k]) => k !== "x:cut").sort((a, b) => b[1] - a[1]).slice(0, 24)
    .map(([k, n], i) => { const m = meta.get(k) || { emoji: "🏷️", label: k }; return `<span class="tag-chip on" style="--i:${i}">${esc(m.emoji)} ${esc(m.label)} <b>${fmt(n)}</b></span>`; }).join("");
  const panel = (html, cls = "") => { const p = $("#an-panel"); if (p.dataset.scene !== scene) { p.dataset.scene = scene; p.className = `an-panel ${cls}`; p.innerHTML = html; } return p; };
  function stage(p) {
    if (p.phase !== scene) {
      scene = p.phase;
      $("#an-body").dataset.scene = scene;
    }
    if (scene === "models") panel(`<div class="an-big">📦</div><h2>Fetching the models</h2><p class="muted">First run only: the face and scene
      models, checked byte for byte. <span id="an-model"></span></p>`, "center");
    if (scene === "models" && $("#an-model")) $("#an-model").textContent = p.detail || "";
    if (scene === "listing") {
      panel(`<div class="an-big an-bob">📂</div><h2>Looking through the folder</h2><p class="muted">Every photo, in every subfolder. Your files are only ever read.</p>
        <div class="an-counts one"><div><b id="c-listed">0</b><span>photos found</span></div><div><b id="c-new">0</b><span>new to analyze</span></div></div>`, "center");
      $("#c-listed").textContent = fmt(p.listed || 0);
      $("#c-new").textContent = fmt(p.new || 0);
    }
    if (scene === "reading") {
      worked = worked || p.total > 0;
      panel(`<h2>Reading every photo</h2><p class="muted small">Light, sharpness, and every face: where it is, whether it smiles, whether its
        eyes are open. Each photo joins the sea as it's read.</p>
        <div class="an-counts"><div><b id="c-read">0</b><span>photos read</span></div><div><b id="c-faces">0</b><span>faces found</span></div>
          <div><b id="c-smiles">0</b><span>smiles</span></div><div><b id="c-blinks">0</b><span>caught blinking</span></div></div>`);
      $("#c-read").textContent = fmt(p.done);
      $("#c-faces").textContent = fmt(p.faces || 0);
      $("#c-smiles").textContent = fmt(p.smiles || 0);
      $("#c-blinks").textContent = fmt(p.blinks || 0);
    }
    if (scene === "understanding") {
      worked = worked || p.total > 0;
      panel(`<h2>Working out what each photo shows</h2><p class="muted small">Every photo against a few hundred descriptions: what kind of photo it
        is and every theme it stands out for (beaches, dogs, night out, food, mountains…). Photos that share a tag drift together.</p>
        <h3 class="an-sub">Found so far</h3><div class="an-tagcloud live" id="an-cloud"></div>`);
      $("#an-cloud").innerHTML = cloud();
    }
    if (scene === "identity") {
      panel(`<h2>${MODE() === "gallery" ? "Spotting the people" : "Working out which face is you"}</h2><p class="muted small">Every face compared with
        every other: the one that turns up most is ${MODE() === "gallery" ? "the main character" : "you"}; mirror reflections still count as you.</p>
        <div class="an-faces" id="an-faces"></div><p class="muted" id="an-who-n"></p>`);
      const me = p.me;
      if (me && !$("#an-faces").children.length) {
        $("#an-faces").innerHTML = me.faces.map((f, i) => `<img src="${F(f)}" alt="" style="--i:${i}">`).join("");
        $("#an-who-n").textContent = MODE() === "gallery" ? `${plural(me.people, "person", "people")} turn up again and again`
          : `That's you: in ${plural(me.photos, "photo")}. ${plural(me.people, "other person", "other people")} come up too.`;
      }
    }
    if (scene === "details") {
      panel(`<h2>${MODE() === "gallery" ? "Looking closer at the people in them" : "Looking closer at you"}</h2>
        <p class="muted small">Head and shoulders picked out, then each photo checked against everything it knows: what's in it, who,
          how it looks. What it finds becomes the photo's tags, and pulls it toward the photos that share them.</p>
        <h3 class="an-sub">Found so far</h3><div class="an-tagcloud live" id="an-cloud"></div>`);
      $("#an-cloud").innerHTML = cloud();
    }
    if (scene === "organizing" || (p.phase === "done" && !orgPlayed)) playOrganizing(p.org || {});
    flush();
  }
  // Organizing plays back what the last step really did: who it found, what it set aside and why, the bursts it stacked.
  function playOrganizing(org) {
    if (orgPlayed || !(org.throwouts || org.stacks)) {
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
    let t = 0;
    const at = (ms, fn) => setTimeout(() => { if (!left(view0)) fn(); }, (t += ms));
    at(200, () => list.querySelector('[data-step="people"]').classList.add("done"));
    if (org.throwouts && org.throwouts.cut.length) {  // the throw-outs gather in a circle of their own
      at(500, () => {
        forced.push(tagOf("x:cut", "🗃️", "Set aside"));
        org.throwouts.cut.forEach(([id]) => give(id, "x:cut"));
        flush();
      });
    }
    at(1400, () => list.querySelector('[data-step="throwouts"]').classList.add("done"));
    for (const st of ((org.stacks || {}).stacks || []).slice(0, 10)) {  // each burst's frames gather, then fold into one
      const frames = st.filter((x) => x > 0 && !(st.length > 8 && x === st[st.length - 1]));
      at(350, () => { frames.forEach((id) => addPhoto(id)); flush(); });
      at(650, () => { frames.slice(1).forEach((id) => info.delete(id)); const rep = info.get(frames[0]); if (rep) rep.n = frames.length; dirty = true; flush(); });
    }
    at(500, () => list.querySelector('[data-step="stacks"]').classList.add("done"));
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
    const cut = found.cut || {}, labels = (S.lib && S.lib.labels) || {};
    const reasons = Object.entries(cut).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const cutN = Object.values(cut).reduce((a, b) => a + b, 0);
    const kinds = Object.entries(found.cats || {}).sort((a, b) => b[1] - a[1]);
    $("#an-steps").innerHTML = Object.entries(STEP_ICONS).map(([, i]) => `<li class="done">${i}</li>`).join("");
    $("#an-body").dataset.scene = "reveal";
    $("#an-panel").className = "an-panel an-reveal-panel";
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
    const tip = $("#an-tip");  // the way on takes the tip's place: bottom right, like every screen's forward action
    if (tip) tip.outerHTML = `<div class="an-go-slot"><a class="btn primary big" href="#home" id="an-go">Let's play → <kbd>Enter</kbd></a></div>`;
    $("#an-label").textContent = "All done";
    $("#an-bar").style.width = "100%";
    $("#an-eta").textContent = "";
    Sound.play("crown");
    confetti(window.innerWidth / 2, window.innerHeight / 3, 80);
    $("#an-go").focus();
    S.onKey = (e) => { if (e.key === "Enter" || e.key === "ArrowRight") { e.preventDefault(); location.hash = "#home"; } };
  }
  const tick = async () => {
    if (finale) return;
    try { await loadState(); } catch (_) { return; }
    if (!S.lib) { route(); return; }
    const p = S.lib.progress || {};
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
    await readFeed();
    const label = idx >= 0 ? words()[p.phase] || PHASES[PHASES.findIndex(([k]) => k === p.phase)][1] : p.phase === "error" ? "Something went wrong" : "Starting…";
    $("#an-label").textContent = p.total ? `${label} · ${fmt(p.done)} / ${fmt(p.total)}` : label;
    $("#an-bar").style.width = `${Math.round((p.total ? p.done / p.total : 0) * 100)}%`;
    let eta = "";
    if (p.total && p.done > 8 && p.started) {
      const rate = p.done / Math.max(1, Date.now() / 1000 - p.started);
      const rest = (p.total - p.done) / Math.max(rate, 0.01);
      eta = rest > 90 ? `about ${Math.round(rest / 60)} min left in this step` : `${Math.max(1, Math.round(rest))} s left in this step`;
    }
    $("#an-eta").textContent = eta;
    if (p.phase && p.phase !== "done") stage(p);
    const e = $("#an-error");
    e.hidden = p.phase !== "error";
    if (p.phase === "error") {
      e.innerHTML = `${esc(p.error || "Unknown error")} <button class="btn" id="retry">Try again</button>`;
      $("#retry").onclick = async () => { await api("/api/rescan", {}); };
    }
  };
  tick();
  S.poll = setInterval(tick, 600);
}

// ---------------------------------------------------------------- home: the journey
// The journey, in order. Organize first: stacks (the same picture or burst, one stack each), then groups (every stack
// and shot into a theme). Then play: crown (duels inside each stack), the group stage (duels inside each group), the
// knockouts (the best of each group), the finals, the reveal. The sweep is a side quest. The map (home) and the track
// in the top bar both read journeyStatus.
const STAGES = [
  ["stacks", "🧩", "Stacks", "Stack the takes", "The same picture (a crop, a copy) or a burst: one stack each. Check the possible twins."],
  ["draw", "🗂️", "Groups", "Group them", "Every stack and single shot goes into a themed group."],
  ["crown", "👑", "Crown", "Crown the stacks", "Each stack's takes duel for the one that plays on."],
  ["groups", "⚽", "Group stage", "Group stage", "A mini-tournament inside each group. The best of each go through."],
  ["duels", "⚔️", "Knockouts", "Knockouts", "The group winners face off. Every call moves the leaderboard."],
  ["finals", "🏆", "Finals", "Finals", "Your top 8 in a bracket: quarterfinals, semis, bronze, the final."],
  ["reveal", "🎉", "Reveal", "Reveal", "The podium, what you go for, and your best shots to keep."],
];
const ring = (frac) => `<svg viewBox="0 0 36 36" class="ring" aria-hidden="true"><circle cx="18" cy="18" r="15.5" class="ring-bg"/>
  ${frac > 0 ? `<circle cx="18" cy="18" r="15.5" class="ring-fg" stroke-dasharray="${(Math.min(1, frac) * 97.4).toFixed(1)} 97.4"/>` : ""}</svg>`;

function journeyStatus(j) {
  const st = j.stages, fin = st.finals;
  const out = {
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
          go: "#duel?stage=groups", label: st.groups.settled ? "Continue" : "Kick off", bar: st.groups.settled / st.groups.groups },
    duels: { done: st.duels.done || fin.state === "done", go: st.groups.groups ? "#duel?stage=knockouts" : "#duel?stage=open",
      label: st.duels.votes ? "Keep playing" : "Play",
      line: `Top ${st.duels.k} at <b>${pct(st.duels.quality)}</b> of its best · ${plural(st.duels.votes, "call")}`, bar: st.duels.quality },
    finals: fin.state === "done" ? { done: true, line: "Champion crowned", go: "#finals", label: "Bracket", thumb: fin.champion }
      : fin.state === "playing" ? { line: "The bracket is on", go: "#finals", label: "Continue" }
      : !fin.eligible ? { line: "Needs at least 4 shots in this cup", go: "#finals", label: "Finals" }
      : fin.state === "ready" ? { line: "Your top 8 are ready to face off", go: "#finals", label: "Start the finals" }
      : { line: `Fairest from 80% (you're at ${pct(st.duels.quality)})`, go: "#finals", label: "Finals" },
    reveal: { line: st.reveal.ready ? "Ready when you are" : "Best after the finals", go: "#reveal", label: "Open" },
    sweep: !st.sweep.done ? { line: `${plural(st.sweep.left, "quick keep-or-toss call")} on photos the sorter wasn't sure about`, go: "#sweep", label: "Sweep" }
      : { done: true, line: "Swept", go: "#sweep", label: "Open" },
  };
  out.next = (j.order || STAGES.map((x) => x[0])).find((k) => !out[k].done) || "reveal";
  return out;
}

// ---------------------------------------------------------------- the HUD: your save, the journey track, the menu
S.journey = null;
let hudAt = 0, hudBusy = null;
async function refreshHud(force) {
  if (!S.lib || !S.lib.analyzed || S.lib.analyzing) return;
  if (!force && S.journey && performance.now() - hudAt < 2000) { paintTrack(); return; }
  hudAt = performance.now();
  if (hudBusy) return hudBusy;
  hudBusy = api("/api/journey").then((j) => { S.journey = j; if (j.progress && j.progress.game && !S.game) S.game = j.progress.game; })
    .catch(() => {}).finally(() => { hudBusy = null; paintTrack(); paintSaveChip(); });
  return hudBusy;
}
function currentStage() {
  const [name, q] = location.hash.slice(1).split("?");
  const p = new URLSearchParams(q || "");
  if (name === "draw" || name === "finals" || name === "reveal" || name === "stacks") return name;
  if (name === "duel") {
    const st = p.get("stage") || S.stage;
    return st === "stacks" ? "crown" : st === "groups" ? "groups" : "duels";
  }
  return null;
}
function paintTrack() {
  const nav = $("#track");
  const j = S.journey;
  if (!nav || !j) return;
  const st = journeyStatus(j), here = currentStage();
  const cup = j.mode === "gallery" && j.cups.length > 1 ? j.cups.find((c) => c.key === j.cup) : null;
  nav.innerHTML = (cup ? `<a class="tcup" href="#home" title="${esc(cup.name)}: switch cups on the map">${cup.icon}</a>` : "") +
    STAGES.map(([k, icon, short, title], i) => `${i ? `<i class="tline ${st[STAGES[i - 1][0]].done ? "done" : ""}"></i>` : ""}
      <a class="tnode ${st[k].done ? "done" : ""} ${k === st.next ? "next" : ""} ${k === here ? "here" : ""}" href="${st[k].go}"
        title="${esc(title)}: ${esc(st[k].line.replace(/<[^>]+>/g, ""))}" ${k === here ? `aria-current="step"` : ""}>
        <span class="tico">${icon}</span>${st[k].done ? `<span class="tcheck" aria-label="done">✓</span>` : ""}<span class="tlabel">${short}</span></a>`).join("");
}
function openMenu() {
  const m = $("#menu");
  const sw = S.journey && S.journey.stages.sweep;
  m.innerHTML = `<div class="menu-head"><b>Menu</b><button class="icon" id="menu-close" aria-label="Close">✕</button></div>
    <nav class="menu-list">
      <a href="#home">🗺️ <span>The map</span></a>
      <a href="#shortlist">🏅 <span>Leaderboard</span></a>
      <a href="#sweep">🧹 <span>Side quest: clean-up sweep</span>${sw && !sw.done && sw.left ? `<b class="menu-badge">${fmt(sw.left)}</b>` : ""}</a>
      <a href="#cuts">🗃️ <span>Set aside</span></a>
      ${MODE() === "me" ? `<a href="#people">🧑 <span>People</span></a>` : ""}
      <button data-m="trophies">🏆 <span>Trophies</span></button>
      <a href="#saves">💾 <span>Switch save</span></a>
      <button data-m="sound">${Sound.on ? "🔊" : "🔇"} <span>Sound ${Sound.on ? "on" : "off"}</span></button>
      <button data-m="sea">🌊 <span>Sea of colour ${Sea.on ? "on" : "off"}</span></button>
      <button data-m="filter">🎨 <span>Auto-filter ${S.filter ? "on" : "off"}</span><kbd>F</kbd></button>
      <button data-m="crop">🔲 <span>Auto-crop ${S.crop ? "on" : "off"}</span><kbd>C</kbd></button>
      <button data-m="settings">⚙️ <span>Settings</span></button>
    </nav>`;
  $("#menu-close").onclick = () => m.close();
  $$(".menu-list a", m).forEach((a) => (a.onclick = () => m.close()));
  $$("[data-m]", m).forEach((b) => (b.onclick = () => {
    m.close();
    if (b.dataset.m === "trophies") openTrophies();
    else if (b.dataset.m === "settings") openSettings();
    else if (b.dataset.m === "sea") { Sea.toggle(); toast(Sea.on ? "Sea of colour on." : "Sea of colour off."); }
    else if (b.dataset.m === "filter") toggleFilter();
    else if (b.dataset.m === "crop") toggleCrop();
    else { Sound.toggle(); paintSound(); toast(Sound.on ? "Sound on." : "Sound off."); }
  }));
  m.onclick = (e) => { if (e.target === m) m.close(); };
  m.showModal();
}

// The map: where you are, the one thing to do next (always in the same spot, up top), then the whole journey.
async function viewHome(main) {
  main.innerHTML = LOADING();
  let j;
  const view = S.view;
  try { j = await api("/api/journey"); } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  S.journey = j;
  hudAt = performance.now();
  paintTrack();
  const g = j.progress.game || {};
  S.game = S.game || g;
  paintSaveChip();
  Ach.check(g);
  const s = j.summary || {}, cut = s.cut || {};
  const cup = j.cups.find((c) => c.key === j.cup) || j.cups[0] || { name: "Your cup", icon: "🏆", shots: 0 };
  const status = journeyStatus(j), next = status.next;
  const nx = STAGES.find((x) => x[0] === next);
  const days = g.days || 0;
  const xp = g.level_next ? Math.round(((g.xp - g.level_floor) / (g.level_next - g.level_floor)) * 100) : 100;
  main.innerHTML = `
    <div class="screen map journey">
      <div class="screen-head">
        <h1>${cup.icon} ${esc(cup.name)}</h1>
        <span class="stat-chip"><b>${fmt(cup.shots)}</b> shots in the running</span>
        <span class="stat-chip">${plural(s.photos, "photo")} · ${plural(s.in_bursts, "burst take")} stacked ·
          <a href="#cuts">${fmt(Object.values(cut).reduce((a, b) => a + b, 0))} set aside</a></span>
        <span class="grow"></span>
        ${helpBtn(`<b>Organize, then play.</b> Stack the same shots, sort everything into themed groups, then the tournament runs:
          each stack crowns its best take, each group plays its own mini-tournament, and the best of each group duel it out
          in the knockouts and the finals. Click any stage to go there; the glowing one is next.`)}
      </div>
      <div class="screen-body map-body">
        <ol class="world" style="--n:${STAGES.length}">${STAGES.map(([k, icon, , title, desc], i) => {
          const x = status[k];
          return `<li class="wnode ${x.done ? "done" : ""} ${k === next ? "next" : ""}" style="--i:${i}">
            <a href="${x.go}" title="${esc(desc)}"><span class="wico">${icon}${x.done ? `<i class="wcheck">✓</i>` : ""}</span>
              <span class="wstep">${i + 1}</span><b>${title}</b>
              <span class="wline">${x.thumb ? `<img class="mini-thumb" src="${T(x.thumb)}" alt="">` : ""}${x.line}</span>
              ${x.bar != null && !x.done ? `<span class="bar"><i style="width:${pct(x.bar)}"></i></span>` : ""}</a></li>`;
        }).join("")}</ol>
        <div class="map-sea"><span class="map-sea-note">${j.progress.votes ? "Every photo, in its groups: the top of the board wear their rank"
          : "Every photo, in its groups: the numbers are the machine's first guess at your best"} · <a class="linkish" href="#shortlist">Full leaderboard →</a></span></div>
        <div class="card next-up">
          <span class="node big">${nx[1]}</span>
          <div class="next-body"><small>Next up · stage ${STAGES.findIndex((x) => x[0] === next) + 1} of ${STAGES.length}</small><b>${nx[3]}</b>
            <span class="muted">${nx[4]}</span><span>${status[next].line}</span>
            ${status[next].bar != null ? `<div class="bar"><i style="width:${pct(status[next].bar)}"></i></div>` : ""}</div>
          <a class="btn primary big" href="${status[next].go}">${status[next].label} → <kbd>Enter</kbd></a>
        </div>
      </div>
      <aside class="screen-rail">
        <button class="rail-card player-card" id="j-trophies" title="Your trophy case">
          <span class="big-lvl">Lv ${g.level || 1}</span>
          <span class="player-name"><b>${esc(g.level_name || "")}</b><span class="muted small">${fmt(g.xp || 0)} XP${g.level_next ? ` · ${fmt(g.level_next - g.xp)} to Lv ${g.level + 1}` : ""}</span>
            <span class="xpbar"><i style="width:${xp}%"></i></span></span>
        </button>
        <div class="rail-card player-stats">
          <div class="pstat" title="Calls today (daily goal ${g.daily_goal || 30})">${ring((g.today || 0) / (g.daily_goal || 30))}
            <div><b>${fmt(g.today || 0)}<span class="faint">/${g.daily_goal || 30}</span></b><span>today</span></div></div>
          <div class="pstat" title="Days in a row with at least one call"><span class="pemoji ${days ? "" : "dim"}">🔥</span>
            <div><b>${days ? plural(days, "day") : "0 days"}</b><span>${days ? "streak" : "start one"}</span></div></div>
          <div class="pstat"><span class="pemoji ${(g.unlocked || []).length ? "" : "dim"}">🏆</span>
            <div><b>${fmt((g.unlocked || []).length)}</b><span>trophies</span></div></div>
        </div>
        ${j.cups.length > 1 ? `<div class="rail-card"><h3>Cups</h3><div class="cup-list">${j.cups.map((c) => `
          <button class="cup-row ${c.key === j.cup ? "on" : ""}" data-cup="${c.key}" title="Play the ${esc(c.name)}">
            ${c.cover ? `<img src="${T(c.cover)}" alt="" loading="lazy">` : `<span class="cup-blank"></span>`}
            <span><b>${c.icon} ${esc(c.name)}</b><span class="muted small">${plural(c.shots, "shot")}${c.champion ? " · 🏆 crowned" : c.finals === "playing" ? " · finals on" : ""}</span></span>
          </button>`).join("")}</div></div>` : ""}
        ${!status.sweep.done ? `<div class="rail-card side-quest"><small>Side quest</small><b>🧹 Clean-up sweep</b>
          <span class="muted small">${status.sweep.line}</span><a class="btn" href="#sweep">Sweep</a></div>` : ""}
      </aside>
    </div>`;
  $("#j-trophies").onclick = openTrophies;
  World.ranks((j.top || []).slice(0, 9).map((x) => x.photo));  // the top of the board wear their rank in the sea
  $$("[data-cup]").forEach((b) => (b.onclick = async () => {
    if (b.classList.contains("on")) return;
    try { await api("/api/cup", { cup: b.dataset.cup }); } catch (e) { toast(e.message); return; }
    Sound.play("pick");
    viewHome(main);
  }));
}

// ---------------------------------------------------------------- duel
function viewDuel(main, params) {
  main.innerHTML = `
    <section id="view-duel">
      <div class="duel-head">
        <div class="question" id="duel-q">${QUESTION[MODE()]} <span>Gut call.</span></div>
        <div class="hud">
          <button class="icon bolt" id="hud-bolt" title="Lightning round: as many calls as you can in 60 seconds" aria-label="Start a lightning round">⚡</button>
          <span class="streak" id="hud-streak" title="Quick calls in a row (under 4 s)"><span class="flame">🔥</span><b>0</b></span>
          <div class="meter" title="How close your current leaderboard is to the best possible one (estimated; near-misses count as nearly as good)">
            <span id="m-votes"></span><div class="bar"><i id="m-bar"></i></div><span id="m-conf"></span>
          </div>
          <button class="icon" id="hud-sound" title="Sound effects" aria-label="Sound effects"></button>
          ${helpBtn(`Two photos, one gut call: click the better one, or <b>←</b> / <b>→</b>. <b>↑</b> both great, <b>↓</b> both meh,
            <b>Space</b> skips, <b>Q</b> / <b>E</b> toss the left / right photo for good, <b>Z</b> undoes. <b>C</b> crops to the face,
            <b>F</b> toggles the auto-filter. Calls under 2.5 s build your streak; ⚡ starts a 60-second lightning round.`)}
        </div>
      </div>
      <div id="lr-slot"></div>
      <div id="done-slot"></div>
      <div id="stage" class="arena"><div class="empty">Loading…</div></div>
      <div class="group-table" id="group-table" hidden></div>
      <div class="controls action-bar" id="controls">
        <div class="bar-left"><button class="btn big" data-o="a"><kbd>←</kbd> <span class="lbl-wide">Left</span><span class="lbl-narrow">Top</span></button></div>
        <div class="bar-mid">
          <button class="btn" data-o="great"><kbd>↑</kbd> Both great</button>
          <button class="btn" data-o="skip"><kbd>Space</kbd> Skip</button>
          <button class="btn" data-o="meh"><kbd>↓</kbd> Both meh</button>
          <button class="btn ghost" data-o="undo"><kbd>Z</kbd> Undo</button>
          <button class="btn ghost" data-o="crop" id="crop-btn"><kbd>C</kbd> <span>${S.crop ? "Crop on" : "Crop off"}</span></button>
          <button class="btn ghost filter-btn" data-o="filter"><kbd>F</kbd> <span>${S.filter ? "Filter on" : "Filter off"}</span></button>
        </div>
        <div class="bar-right"><button class="btn big" data-o="b"><span class="lbl-wide">Right</span><span class="lbl-narrow">Bottom</span> <kbd>→</kbd></button></div>
      </div>
      <div class="controls action-bar" id="finish-bar" hidden></div>
    </section>`;
  $$("#controls [data-o]").forEach((b) => (b.onclick = () =>
    (b.dataset.o === "undo" ? undo() : b.dataset.o === "crop" ? toggleCrop() : b.dataset.o === "filter" ? toggleFilter()
      : decide(b.dataset.o))));
  $("#hud-sound").onclick = () => { Sound.toggle(); paintSound(); };
  $("#hud-bolt").onclick = () => (S.lr ? endLightning() : startLightning());
  S.crop = cropPref();
  $("#crop-btn span").textContent = S.crop ? "Crop on" : "Crop off";
  S.stage = params && ["stacks", "groups", "knockouts", "open"].includes(params.get("stage")) ? params.get("stage") : null;
  S.table = null;
  S.lr = null;
  paintSound();
  S.cards = [];
  S.current = null;
  S.game = null;
  const stack = params && params.get("stack");
  if (stack) history.replaceState(null, "", "#duel");
  loadCards(stack);
}

const preloaded = new Map();
function preload(cards) {
  for (const c of cards) {
    const ids = c.type === "duel" ? [c.a, c.b] : c.type === "mini" ? c.frames : c.members || [];
    for (const id of ids) {
      if (preloaded.has(id)) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = P(id);
      preloaded.set(id, img);
      if (preloaded.size > 80) preloaded.delete(preloaded.keys().next().value);
    }
  }
}

async function loadCards(stack) {
  const view = S.view;
  try {
    const r = await api("/api/next?n=2" + (stack ? `&stack=${encodeURIComponent(stack)}` : "") + (S.stage ? `&stage=${S.stage}` : ""));
    if (left(view)) return;
    S.cards = r.cards;
    S.stage = r.stage || (S.stage === "open" ? "open" : null);  // plain Play follows the journey: groups, then knockouts
    S.drawInfo = r.draw;
    paintTrack();
    if (S.stage === "stacks") S.stacksLeft = r.left;
    preload(S.cards);
    updateMeter(r.progress);
    showNext();
  } catch (e) {
    if (!left(view)) $("#stage").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function showNext() {
  const gone = World.grab($("#stage"));
  showCard();
  World.swap($("#stage"), gone);
}
function showCard() {
  S.current = S.cards.shift() || null;
  const stage = $("#stage");
  if (!stage) return;
  const c = S.current;
  $("#finish-bar").hidden = true;
  if (!c && S.stage === "stacks") { stagesDone(); return; }
  if (!c && S.stage === "groups") { groupStageDone(); return; }
  if (!c && S.progress && S.progress.shots < 2) {
    finishStage({ icon: "🫙", title: "Not enough to duel", undo: false, next: ["#cuts", "Set aside →"],
      text: `This ${MODE() === "gallery" ? "cup" : "folder"} has ${plural(S.progress.shots, "shot")} in the running; duels need two.
        Bring some back from Set aside, or add photos.` });
    return;
  }
  if (!c) { stage.className = "arena"; stage.innerHTML = `<div class="empty">Thinking…</div>`; return; }
  if (c.type === "mini") {
    renderMini(stage, c);
  } else if (c.type === "duel") {
    stage.className = "arena";
    $("#controls").classList.remove("mini-mode");
    const rowOf = (pid) => S.table && c.group && S.table.id === c.group.id && S.table.rows.find((r) => r.photo === pid);
    const ra = rowOf(c.a), rb = rowOf(c.b);
    const decider = ra && rb && (ra.through !== rb.through || (Math.abs(ra.odds - 0.5) < 0.25 && Math.abs(rb.odds - 0.5) < 0.25));
    $("#duel-q").innerHTML = c.group
      ? `⚽ <b>Group ${esc(c.group.letter)}</b> <span>${esc(c.group.emoji)} ${esc(c.group.name)} · match ${fmt(Math.min(c.group.played + 1, c.group.budget))}/${fmt(c.group.budget)}</span>${decider ? ` <span class="decider">⚡ Decider: this one can send a photo through</span>` : ""}`
      : S.stage === "knockouts" ? `⚔️ <b>Knockouts</b> <span>${QUESTION[MODE()]}</span>`
      : `${QUESTION[MODE()]} <span>Gut call.</span>`;
    if (c.group && (!S.table || S.table.id !== c.group.id)) loadTable(c.group.id);
    else if (!c.group && S.stage === "knockouts") loadSeats(c);  // the knockouts: the race for the finals' seats beside the duel
    else if (!c.group) renderTable(null);
    stage.innerHTML = ["a", "b"].map((side) => {
      const n = photoInfo(c, c[side]).frames;
      return `
      <div class="slot slot-${side}"><div class="side" data-side="${side}" data-photo="${c[side]}">
        <img src="${P(c[side])}" alt="${side === "a" ? "Left" : "Right"} photo" draggable="false">
        ${n > 1 ? `<span class="stack" title="A stack of ${n} takes; this is the one you kept">⧉ ${n} takes</span>` : ""}
        ${c.teams && c.teams[c[side]] ? `<span class="team-chip" title="Plays for ${esc(c.teams[c[side]].name)}">${esc(c.teams[c[side]].emoji)} <b>${esc(c.teams[c[side]].letter)}</b> ${esc(c.teams[c[side]].name)}</span>` : ""}
        <button class="toss" data-toss="${side}" title="Never show this shot again (${side === "a" ? "Q" : "E"})">Toss ✕</button>
      </div></div>`;
    }).join("");
    $$(".side", stage).forEach((el) => (el.onclick = (ev) => {
      const t = ev.target.closest("[data-toss]");
      decide(t ? `toss_${t.dataset.toss}` : el.dataset.side);
    }));
    $("#controls").hidden = false;
  } else {
    const n = c.members.length;
    const layout = n <= 3 ? `c${n}` : n === 4 ? "c2 r2" : "c3 r2";
    stage.className = "frames";
    stage.innerHTML = `<div class="question frame-q">Same shot, several takes: click the one to <b>keep</b>.
      <span>It stands in for this stack from now on. The others aren't deleted; you can swap later from the leaderboard.
      Keys 1–${n}; Enter keeps the current pick.</span></div>
      <div class="frame-grid ${layout}">${c.members.map((id, i) => `
      <div class="side ${id === c.current ? "current" : ""}" data-pick="${id}" data-photo="${id}" title="Keep this take">
        <span class="hint"><kbd>${i + 1}</kbd></span><img src="${P(id)}" alt="Frame ${i + 1}" draggable="false">
        <span class="keep">Keep this one</span></div>`).join("")}</div>`;
    $$(".side", stage).forEach((el) => (el.onclick = () => decide("frame", Number(el.dataset.pick))));
    $("#controls").hidden = true;
  }
  layoutStage();
  dressStage(stage);
  S.shownAt = performance.now();
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
// window, and whatever spills past the window's edge fades out on a gradient.
const WINDOW_FILL = 0.92;  // the window's share of the pane
const WINDOW_ASPECT = 0.8; // 4:5, like a dating-app card
const MAX_ZOOM = 1.5;      // never enlarge the preview beyond this (CSS px per preview px)
const FADE = 0.08;         // gradient width past the window edge, as a share of the window
const OUTSIDE = "rgba(0,0,0,0.35)";  // how much of the photo still shows beyond the fade

function photoInfo(card, id) {
  return (card && card.photos && card.photos[id]) || { dims: [1, 1], box: null, frames: 1 };
}

function framePhoto(side, info) {
  const img = side.querySelector("img");
  const W = side.clientWidth, H = side.clientHeight;
  if (!img || !W || !H) return;
  const [iw, ih] = info.dims;
  const b = S.crop ? info.box : null;
  const base = "position:absolute;left:0;top:0;max-width:none;object-fit:fill;";
  if (!b) {  // whole photo, letterboxed
    const s = Math.min(W / iw, H / ih);
    img.style.cssText = base + `width:${iw * s}px;height:${ih * s}px;transform:translate(${(W - iw * s) / 2}px,${(H - ih * s) / 2}px)`;
    paintFilter(img, Number(side.dataset.photo));
    return;
  }
  const winH = Math.min(WINDOW_FILL * H, (WINDOW_FILL * W) / WINDOW_ASPECT), winW = winH * WINDOW_ASPECT;
  const winL = (W - winW) / 2, winT = (H - winH) / 2;
  const cover = Math.max(winW / iw, winH / ih);                 // the photo always fills the window
  const s = Math.min(Math.max(winH / (b[3] * ih), cover), Math.max(cover, MAX_ZOOM));
  const dw = iw * s, dh = ih * s;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const tx = clamp(W / 2 - (b[0] + b[2] / 2) * dw, winL + winW - dw, winL);  // face centred in the window,
  const ty = clamp(H / 2 - (b[1] + b[3] / 2) * dh, winT + winH - dh, winT);  // unless that would leave a gap
  img.style.cssText = base + `width:${dw}px;height:${dh}px;transform:translate(${tx}px,${ty}px)`;
  const pc = (v) => `${(v * 100).toFixed(2)}%`;
  const band = (a, z, f, dir) => `linear-gradient(${dir}, ${OUTSIDE} ${pc(a - f)}, #000 ${pc(a)}, #000 ${pc(z)}, ${OUTSIDE} ${pc(z + f)})`;
  // ...and the photo's own borders feather out, so it never ends in a hard line against the pane.
  const feather = (e, dir) => `linear-gradient(${dir}, transparent 0%, #000 ${pc(e)}, #000 ${pc(1 - e)}, transparent 100%)`;
  const mask = [band((winL - tx) / dw, (winL + winW - tx) / dw, (FADE * winW) / dw, "to right"),
                band((winT - ty) / dh, (winT + winH - ty) / dh, (FADE * winH) / dh, "to bottom"),
                feather((0.04 * winW) / dw, "to right"), feather((0.04 * winH) / dh, "to bottom")].join(", ");
  img.style.webkitMaskImage = mask;
  img.style.maskImage = mask;
  img.style.webkitMaskComposite = "source-in";
  img.style.maskComposite = "intersect";
  paintFilter(img, Number(side.dataset.photo));
}

// ---------------------------------------------------------------- auto-filter
// A gentle auto-edit laid over the photo as an SVG filter: levels, a little white balance, midtones toward a
// natural brightness, a touch of vibrance. Worked out on the fly from a 64-px sample of the photo itself, so
// nothing is written to your files; F flips it on every judging screen.
const FILTERS = new Map();  // photo id -> filter id
let filterCanvas = null;

function filterPref() {
  try { return localStorage.getItem(`matcher-filter-${MODE()}`) === "on"; } catch (_) { return false; }
}

function autoFilterId(img, pid) {
  if (FILTERS.has(pid)) return FILTERS.get(pid);
  if (!img.complete || !img.naturalWidth) return null;
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
  let defs = $("#af-defs");
  if (!defs) {
    document.body.insertAdjacentHTML("beforeend", `<svg id="af-defs" width="0" height="0" style="position:absolute" aria-hidden="true"></svg>`);
    defs = $("#af-defs");
  }
  const fn = (attrs) => ["R", "G", "B"].map((c, k) => `<feFunc${c} ${attrs(k)}/>`).join("");
  const id = `af-${pid}`;
  defs.insertAdjacentHTML("beforeend", `<filter id="${id}" color-interpolation-filters="sRGB">
    <feComponentTransfer>${fn((k) => `type="linear" slope="${lin[k][0].toFixed(4)}" intercept="${lin[k][1].toFixed(4)}"`)}</feComponentTransfer>
    <feComponentTransfer>${fn(() => `type="gamma" amplitude="1" exponent="${gamma.toFixed(4)}" offset="0"`)}</feComponentTransfer>
    <feColorMatrix type="saturate" values="${sat}"/></filter>`);
  FILTERS.set(pid, id);
  return id;
}

function paintFilter(img, pid) {
  if (!img || !pid) return;
  if (!S.filter) { img.style.filter = ""; return; }
  const id = autoFilterId(img, pid);
  if (id) img.style.filter = `url(#${id})`;
  else img.addEventListener("load", () => paintFilter(img, pid), { once: true });
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
  if (!S.filter) { $$("img[style*='filter']", main).forEach((img) => (img.style.filter = "")); return; }
  let n = 0;
  for (const img of $$("img[src^='/img/t/'], img[src^='/img/p/']", main)) {
    if (img.style.filter) continue;
    if (++n > THUMB_FILTER_MAX) break;
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
function paintCrops() {
  $$(".swipe-card[data-photo], .twin-arena .side[data-photo], #f-arena .side[data-photo]").forEach((el) => {
    const img = el.querySelector("img");
    if (!img) return;
    let box = null;
    try { box = JSON.parse(el.dataset.box || "null"); } catch (_) { /* no subject */ }
    if (S.crop && box) {
      img.style.objectFit = "cover";
      img.style.objectPosition = facePos(box).replace("object-position:", "");
    } else {
      img.style.objectFit = "";
      img.style.objectPosition = "";
    }
  });
}

function toggleFilter() {
  S.filter = !S.filter;
  try { localStorage.setItem(`matcher-filter-${MODE()}`, S.filter ? "on" : "off"); } catch (_) { /* private mode */ }
  $$(".filter-btn span").forEach((l) => (l.textContent = S.filter ? "Filter on" : "Filter off"));
  paintFilters();
  toast(S.filter ? "Auto-filter on: a gentle auto-edit (levels, colour, brightness) over each photo. Your files aren't touched."
    : "Auto-filter off: photos as shot.");
}

function layoutStage() {
  $$("#stage .side[data-photo]").forEach((side) => framePhoto(side, photoInfo(S.current, Number(side.dataset.photo))));
}

function toggleCrop() {
  S.crop = !S.crop;
  try { localStorage.setItem(`matcher-crop-${MODE()}`, S.crop ? "on" : "off"); } catch (_) { /* private mode */ }
  const label = $("#crop-btn span");
  if (label) label.textContent = S.crop ? "Crop on" : "Crop off";
  layoutStage();
  paintCrops();
  toast(S.crop ? (MODE() === "me" ? "Auto-crop on: every photo framed the same way around you."
    : "Auto-crop on: photos with a face are framed around it; the rest stay whole.") : "Auto-crop off: whole photos.");
}

let resizeQueued = false;
window.addEventListener("resize", () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; layoutStage(); });
});

function animate(outcome) {
  const sides = $$("#stage .side");
  if (!["duel", "mini"].includes(S.current?.type) || sides.length < 2) return;
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
  const card = S.current;
  const ms = Math.round(performance.now() - S.shownAt);
  animate(outcome);
  if (card.type === "duel") Sound.play({ a: "pick", b: "pick", great: "great", meh: "meh", skip: "skip" }[outcome] || "toss");
  const lr = S.lr && performance.now() < S.lr.ends ? S.lr.id : null;
  if (lr && ["a", "b", "great", "meh", "skip"].includes(outcome)) lightningTick();
  const req = api("/api/vote", { card: card.id, outcome, ms, choice: choice ?? null, pending: S.cards.map((c) => c.id),
    lr, stage: S.stage });
  if (card.type === "frame" || card.type === "mini") {
    // Wait for the reply: the next round, or (after the last one) the duel this stack was holding up.
    try {
      const r = await req;
      if (r.swap) applySwap(r.swap);
      S.cards.unshift(...r.cards);
      preload(r.cards);
      if (card.type === "mini") {
        Sound.play(r.mini && r.mini.defended ? "defend" : "pick");
        if (r.crowned) {
          await crowning(r.crowned.photo);
          if (S.stage) S.stacksLeft = Math.max(0, (S.stacksLeft || 1) - 1);
        }
      }
      updateMeter(r.progress, outcome);
      showNext();
      if (card.type === "frame") toast(r.swap ? "Kept that frame; it's the one you'll see from now on." : "Kept the current frame.");
    } catch (e) {
      if (e.status === 409) { toast("Refreshing pairs…"); await loadCards(); } else toast(e.message);
    } finally {
      settle();
    }
    return;
  }
  await sleep(130);
  if (S.cards.length) showNext();
  else { S.current = null; $("#stage").innerHTML = `<div class="empty">Thinking…</div>`; }
  try {
    const r = await req;
    if (r.swap) applySwap(r.swap);
    S.cards.push(...r.cards);
    preload(r.cards);
    updateMeter(r.progress, outcome);
    if (r.ranks) rankPop(r.ranks, outcome, card, r.story);
    if (r.group) { renderTable(r.group); if (r.group.just_settled) groupDecided(r.group); }
    if (!S.current) showNext();
    if (outcome.startsWith("toss")) toast("Tossed. It won't come back (Z to undo).");
  } catch (e) {
    if (e.status === 409) { toast("Refreshing pairs…"); await loadCards(); }
    else toast(e.message);
  } finally {
    settle();
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
  frame: "Take pick undone. Choose again.", mini: "Round undone. Call it again.",
  sweep: "Sweep call undone.", final: "Finals pick undone. It's on the finals page.",
};

function cropPref() {
  try {
    const v = localStorage.getItem(`matcher-crop-${MODE()}`) || (MODE() === "me" ? localStorage.getItem("matcher-crop") : null);
    if (v) return v === "on";
  } catch (_) { /* private mode */ }
  return MODE() === "me";  // profile pics frame around you; a gallery shows whole photos
}

// Where your pick landed on the leaderboard, for a moment.
function rankPop(ranks, outcome, card, story) {
  const pid = outcome === "a" ? card.a : outcome === "b" ? card.b : null;
  const r = ranks.find((x) => x.photo === pid);
  if (!r) return;
  const d = r.was - r.rank;
  $$(".rank-pop").forEach((x) => x.remove());
  const el = document.createElement("div");
  el.className = `rank-pop ${reduceMotion ? "still" : ""}`;
  el.setAttribute("role", "status");
  el.innerHTML = `${story ? `<em class="story ${story}">${story === "upset" ? "Upset!" : "Rematch"}</em>` : ""}<img src="${T(pid)}" alt="">
    <span>#${r.rank}</span>${d > 0 ? `<b class="up">▲${d}</b>` : d < 0 ? `<b class="down">▼${-d}</b>` : `<b class="flat">=</b>`}`;
  const stage = $("#view-duel");
  if (!stage) return;
  stage.append(el);
  setTimeout(() => el.classList.add("out"), 1100);
  setTimeout(() => el.remove(), 1500);
}

// ---- lightning round: 60 seconds, as many calls as you can
const LR_SECONDS = 60;
function startLightning() {
  if (S.stage === "stacks") { toast("Lightning rounds are for duels: crown the stacks first."); return; }
  S.lr = { id: Math.random().toString(36).slice(2, 10), ends: performance.now() + LR_SECONDS * 1000, calls: 0,
           xp0: (S.game && S.game.xp) || 0, best0: (S.game && S.game.lightning_best) || 0 };
  $("#lr-slot").innerHTML = `<div class="lr-bar"><i></i><span class="lr-text">⚡ GO! <b id="lr-calls">0</b> calls</span><span id="lr-secs">${LR_SECONDS}s</span></div>`;
  $("#hud-bolt").classList.add("on");
  Sound.play("level");
  banner(`<small>Lightning round</small><b>⚡ 60 seconds. Go!</b>`, 900);
  const tick = () => {
    if (!S.lr || !$("#lr-slot")) return;
    const left = Math.max(0, S.lr.ends - performance.now());
    const bar = $(".lr-bar i");
    if (bar) bar.style.width = `${(left / (LR_SECONDS * 1000)) * 100}%`;
    const secs = $("#lr-secs");
    if (secs) secs.textContent = `${Math.ceil(left / 1000)}s`;
    $(".lr-bar")?.classList.toggle("hurry", left < 10000);
    if (left <= 0) { endLightning(); return; }
    S.lr.raf = requestAnimationFrame(tick);
  };
  tick();
}

function lightningTick() {
  S.lr.calls += 1;
  const c = $("#lr-calls");
  if (c) { c.textContent = S.lr.calls; c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); }
}

async function endLightning() {
  const lr = S.lr;
  if (!lr) return;
  S.lr = null;
  cancelAnimationFrame(lr.raf);
  $("#hud-bolt")?.classList.remove("on");
  $("#lr-slot") && ($("#lr-slot").innerHTML = "");
  await sleep(450);  // let the last answer land
  let g = S.game;
  try { g = (await api("/api/game")).stats; } catch (_) { /* keep what we have */ }
  const record = lr.calls > lr.best0 && lr.calls > 0;
  if (record) { Sound.play("achieve"); confetti(window.innerWidth / 2, window.innerHeight / 3, 60); }
  const m = $("#modal");
  m.className = "";
  m.innerHTML = `<div class="lr-result">
      <div class="lr-big">⚡ ${fmt(lr.calls)}</div>
      <div class="muted">calls in ${LR_SECONDS} seconds</div>
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
function finishStage({ icon, title, text, next, undo: canUndo = true }) {
  const stage = $("#stage");
  World.release();
  stage.className = "arena finished";
  $("#controls").hidden = true;
  const clear = canUndo && next;  // a stage won, not just an empty one
  stage.innerHTML = `<div class="empty stage-done">${clear ? `<div class="clear-stamp">Stage clear</div>` : ""}<div class="big-emoji">${icon}</div><h2>${title}</h2><p class="muted">${text}</p></div>`;
  if (clear) { Sound.play("crown"); confetti(window.innerWidth / 2, window.innerHeight / 3, 70); }
  const bar = $("#finish-bar");
  bar.innerHTML = `<div class="bar-left"><a class="btn big" href="#home">The map</a></div>
    <div class="bar-mid">${canUndo ? `<button class="btn ghost" data-fin="undo"><kbd>Z</kbd> Undo the last call</button>` : ""}</div>
    <div class="bar-right">${next ? `<a class="btn primary big" href="${next[0]}" id="fin-next">${next[1]} <kbd>Enter</kbd></a>` : ""}</div>`;
  bar.hidden = false;
  const u = $("[data-fin=undo]", bar);
  if (u) u.onclick = () => undo();
}

function stagesDone() {
  $("#duel-q").innerHTML = `👑 <b>Stacks crowned</b> <span>Every burst has its best take.</span>`;
  finishStage({ icon: "👑", title: "All crowned!", next: ["#duel?stage=groups", "Next: the group stage →"],
    text: "Every stack now plays as its best take. Next, each group plays its own mini-tournament." });
  refreshHud(true);
}

// The group stage: each group's standings under the photos, ranked by rating (who you beat counts, not just how
// often), with a line under the places that go through.
async function loadTable(id) {
  S.table = { id };
  try { renderTable((await api(`/api/draw/table/${id}`)).table); } catch (_) { /* the next vote brings it */ }
}
function renderTable(t) {
  const box = $("#group-table");
  if (!box) return;
  S.table = t;
  $("#view-duel")?.classList.toggle("with-table", !!t);
  if (!t) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="gt-head"><b>Group ${esc(t.letter)} standings</b>
    <span class="muted small">${t.settled ? "Decided" : `${fmt(t.played)} of ~${fmt(t.budget)} matches`} · top ${t.adv} go through · ranked by rating: beating strong photos counts more</span></div>
    <ol class="gt-rows">${t.rows.map((r, i) => `<li class="${r.through ? "through" : ""} ${i === t.adv ? "cut" : ""}" title="${r.w} won · ${r.l} lost${r.d ? ` · ${r.d} level` : ""}">
      <span class="gt-pos">${i + 1}</span><img src="${T(r.photo)}" alt=""><span class="gt-wl">${r.w}–${r.l}</span>
      <span class="gt-odds" title="Chance of going through">${r.through ? "✓ " : ""}${Math.round(r.odds * 100)}%</span></li>`).join("")}</ol>`;
}
async function loadSeats(c) {
  const box = $("#group-table");
  if (!box) return;
  S.table = { seats: true };
  $("#view-duel")?.classList.add("with-table");  // the rail is there from the first paint: the photos never resize for it
  box.hidden = false;
  if (!box.children.length) box.innerHTML = `<div class="gt-head"><b>🎟️ Race for the finals</b></div>`;
  let d;
  try { d = await api("/api/seats"); } catch (_) { return; }
  if (!$("#group-table") || !S.current || S.current.id !== c.id) return;
  const here = new Set([c.a, c.b]);
  const row = (x, i, bubble) => `<li class="${here.has(x.photo) ? "on-line" : ""} ${bubble ? "bubble" : ""}"><span class="gt-pos">${bubble ? i + 9 : i + 1}</span>
    <img src="${T(x.photo)}" alt="">${x.team ? `<span class="gt-wl">${esc(x.team.emoji)} ${esc(x.team.letter)}</span>` : "<span></span>"}
    <span class="gt-odds">${here.has(x.photo) ? "on the line" : ""}</span></li>`;
  box.innerHTML = `<div class="gt-head"><b>🎟️ Race for the finals</b><span class="muted small">eight seats in the bracket, as it stands; a duel here can
    change who's in</span></div><ol class="gt-rows seats">${d.seats.map((x, i) => row(x, i)).join("")}
    ${d.bubble.length ? `<li class="gt-sep muted small">on the bubble</li>${d.bubble.map((x, i) => row(x, i, true)).join("")}` : ""}</ol>`;
}
function groupDecided(t) {
  Sound.play("crown");
  const through = t.rows.filter((r) => r.through).slice(0, 5);
  banner(`<small>Group ${esc(t.letter)} decided</small><b>${esc(t.emoji)} ${esc(t.name)}</b>
    <span class="banner-row">${through.map((r) => `<img src="${T(r.photo)}" alt="">`).join("")}</span>
    <span>${plural(t.adv, "photo")} through to the knockouts</span>`, 2600);
  confetti(window.innerWidth / 2, window.innerHeight / 3, 60);
}
async function groupStageDone() {
  $("#controls").hidden = true;
  renderTable(null);
  $("#duel-q").innerHTML = `⚽ <b>Group stage</b>`;
  let g = S.drawInfo || {};
  try { g = (await api("/api/journey")).stages.groups; } catch (_) { /* use what we had */ }
  if (!$("#stage") || S.current) return;
  finishStage(g.groups
    ? { icon: "⚽", title: "Group stage complete!", next: ["#duel?stage=knockouts", "Next: the knockouts →"],
      text: `${plural(g.groups, "group")} decided · ${fmt(g.through)} photos go through to the knockouts.` }
    : { icon: "⚽", title: "No groups to play yet", undo: false, next: ["#draw", "Group them →"],
      text: "Make some groups first: every shot goes into one." });
  refreshHud(true);
  if (g.groups) { Sound.play("crown"); confetti(window.innerWidth / 2, window.innerHeight / 3, 70); }
}

// Z while an answer is still on its way isn't dropped: it runs as soon as that answer lands.
async function undo() {
  if (S.busy) { S.undoQueued = (S.undoQueued || 0) + 1; return; }
  S.busy = true;
  try {
    const r = await api("/api/undo", { stage: S.stage });
    if (r.undone) Sound.play("undo");
    S.cards = r.cards;
    preload(S.cards);
    updateMeter(r.progress);
    showNext();
    toast(UNDONE[r.undone] || "Nothing left to undo.");
  } catch (e) { toast(e.message); }
  settle();
}

function settle() {
  S.busy = false;
  if (S.undoQueued) { S.undoQueued -= 1; undo(); return; }
  const q = S.queued && S.queued.shift();
  if (q && S.current && S.current.id === q.card) decide(q.outcome, q.choice);  // for the card it was meant for
}

function updateMeter(p, outcome) {
  if (!p || !p.k) return;
  S.progress = p;
  if (p.game) updateHud(p.game, outcome);
  const v = $("#m-votes");
  if (!v) return;
  v.textContent = `${fmt(p.votes)} duels · ${p.minutes} min`;
  $("#m-bar").style.width = pct(p.quality);
  $("#m-conf").textContent = `top ${p.k} at ${pct(p.quality)} of best`;
  const slot = $("#done-slot");
  if (p.done && slot && !slot.dataset.shown) {
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
  if (!location.hash.startsWith("#duel") || e.target.closest("input, select, textarea, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($("dialog[open]") || $(".inspect")) return;  // (a photo grabbed out of the sea has the keys)
  const c = S.current;
  const k = e.key;
  if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); if (!e.repeat) undo(); return; }
  if (k === "c" || k === "C") { e.preventDefault(); toggleCrop(); return; }
  if (k === "f" || k === "F") { e.preventDefault(); toggleFilter(); return; }
  const fin = $("#finish-bar");
  if (k === "Enter" && fin && !fin.hidden && $("#fin-next")) { e.preventDefault(); $("#fin-next").click(); return; }
  if (k === "Escape" && (S.stage === "stacks" || (fin && !fin.hidden))) { e.preventDefault(); location.hash = "home"; return; }
  if (!c) return;
  if (c.type === "mini") {
    const m = { ArrowLeft: "a", a: "a", A: "a", ArrowRight: "b", d: "b", D: "b", " ": "skip" }[k];
    if (m) { e.preventDefault(); if (!e.repeat) { pressed(m); decide(m); } }
    return;
  }
  if (c.type === "frame") {
    const n = Number(k);
    if (n >= 1 && n <= c.members.length) { e.preventDefault(); decide("frame", c.members[n - 1]); }
    else if (k === "Enter") { e.preventDefault(); decide("frame", c.current); }
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
    if (!S.lr) toast(`Level up: Lv ${g.level} · ${g.level_name}`);
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
  check(g, catalog) {
    if (!g || !g.unlocked) return;
    if (!this.seen) {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem("matcher-ach-seen") || "null"); } catch (_) { /* private mode */ }
      if (!Array.isArray(stored)) {
        if (!location.hash.startsWith("#home")) return;  // wait for the home screen to say hello
        this.seen = new Set(g.unlocked);
        this.save();
        if (g.judged > 0) welcome(g);
        return;
      }
      this.seen = new Set(stored);
    }
    const fresh = g.unlocked.filter((id) => !this.seen.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => this.seen.add(id));
    this.save();
    const show = (list) => fresh.forEach((id, i) => {
      const a = list.find((x) => x.id === id);
      if (a) setTimeout(() => achievementPop(a), i * 650);
    });
    if (catalog) show(catalog);
    else api("/api/game").then((d) => show(d.achievements)).catch(() => {});
  },
  save() {
    try { localStorage.setItem("matcher-ach-seen", JSON.stringify([...this.seen])); } catch (_) { /* private mode */ }
  },
};

function gameCheck() {
  api("/api/game").then((d) => Ach.check(d.stats, d.achievements)).catch(() => {});
}

// Unlocks slide in from the corner, clear of the HUD and the controls. Two at most at a time: a burst of unlocks
// queues up instead of piling over the screen.
const achQueue = [];
let achShown = 0;
function achievementPop(a) {
  achQueue.push(a);
  pumpAchievements();
}
function pumpAchievements() {
  if (achShown >= 2 || !achQueue.length) return;
  const a = achQueue.shift();
  let box = $("#achvs");
  if (!box) {
    box = document.createElement("div");
    box.id = "achvs";
    document.body.append(box);
  }
  const el = document.createElement("div");
  el.className = "achv";
  el.innerHTML = `<span class="ico">${a.icon}</span><div><small>Achievement unlocked</small><b>${esc(a.title)}</b><span>${esc(a.desc)}</span></div>`;
  box.append(el);
  achShown++;
  Sound.play("achieve");
  const r = el.querySelector(".ico").getBoundingClientRect();
  confetti(r.left + r.width / 2, r.top + r.height / 2, 24);
  setTimeout(() => el.classList.add("out"), 3000);
  setTimeout(() => { el.remove(); achShown--; pumpAchievements(); }, 3400);
}

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
  toast(`🎯 Daily goal: ${g.daily_goal} calls today${g.days > 1 ? ` · ${g.days}-day streak` : ""}`, 3200);
}

async function openTrophies() {
  let d;
  try { d = await api("/api/game"); } catch (e) { toast(e.message); return; }
  const g = d.stats;
  const m = $("#modal");
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
      </div>
    </div>
    <div class="trophies">${d.achievements.map((a) => `
      <div class="trophy ${a.unlocked ? "got" : ""}"><span class="ico">${a.unlocked ? a.icon : "🔒"}</span>
        <b>${esc(a.title)}</b><span class="muted small">${esc(a.desc)}</span></div>`).join("")}</div>`;
  $("#close-modal").onclick = () => m.close();
  m.onclick = (e) => { if (e.target === m) m.close(); };
  m.showModal();
}

// A stack's mini-tournament: its champion frame defends the title against each challenger in turn.
function renderMini(stage, c) {
  stage.className = "mini-stage";
  $("#controls").hidden = false;
  $("#controls").classList.add("mini-mode");
  $("#duel-q").innerHTML = S.stage === "stacks"
    ? `👑 <b>Crown the stacks</b> <span>${S.stacksLeft ? `${fmt(S.stacksLeft)} to go · ` : ""}which take is better?</span>
       ${S.stacksLeft > 1 ? `<button class="linkish" id="crown-rest" title="Each remaining stack keeps the take it shows now (Z on the Stacks page undoes it)">⏩ Keep the best guess for the rest</button>` : ""}`
    : `👑 <b>Mini-tournament</b> <span>Same shot, several takes: which one is better?</span>`;
  if ($("#crown-rest")) $("#crown-rest").onclick = async () => {
    if (!confirm(`Keep the machine's best guess for the other ${fmt(S.stacksLeft)} stacks? You can still change any of them later.`)) return;
    try { const r = await api("/api/stacks/auto", {}); toast(`Kept the best guess for ${plural(r.crowned, "stack")}.`); } catch (e) { toast(e.message); return; }
    S.cards = [];
    S.current = null;
    stagesDone($("#stage"));
  };
  const challenger = c.a === c.champ ? c.b : c.a;
  const label = { champ: "Champion", now: "Challenger", out: "Beaten", next: "Up next" };
  const strip = c.frames.map((f) => {
    const st = f === c.champ ? "champ" : f === challenger ? "now" : c.beaten.includes(f) ? "out" : "next";
    return `<span class="mf ${st}" title="${label[st]}"><img src="${T(f)}" alt="">${st === "champ" ? "<i>👑</i>" : ""}</span>`;
  }).join("");
  stage.innerHTML = `
    <div class="mini-bar"><span class="mini-round">Round ${c.round} of ${c.total}</span><span class="mini-strip">${strip}</span>
      <span class="muted small">Space: can't tell (the champion keeps its crown)</span></div>
    <div class="arena">${["a", "b"].map((side) => `
      <div class="slot slot-${side}"><div class="side ${c[side] === c.champ ? "is-champ" : ""}" data-side="${side}" data-photo="${c[side]}">
        <img src="${P(c[side])}" alt="${side === "a" ? "Left" : "Right"} take" draggable="false">
        <span class="role">${c[side] === c.champ ? "👑 Champion" : "⚔️ Challenger"}</span>
      </div></div>`).join("")}</div>`;
  $$(".side", stage).forEach((el) => (el.onclick = () => decide(el.dataset.side)));
}

function crowning(photo) {
  return new Promise((resolve) => {
    Sound.play("crown");
    const stage = $("#stage");
    const r = stage.getBoundingClientRect();
    stage.insertAdjacentHTML("beforeend", `<div class="crowning"><div class="crown-card"><img src="${P(photo)}" alt="">
      <span class="crown">👑</span></div><div class="crown-text">Crowned!</div></div>`);
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
      <div class="screen-body fill"><div class="empty"><div class="big-emoji">🧹</div><h2>Nothing to sweep</h2>
        <p class="muted">The sorter is sure about everything here. Anything it set aside is still under Set aside.</p></div></div>
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
        <div class="bar-mid"><button class="btn ghost" data-s="undo"><kbd>Z</kbd> Undo</button>
          <button class="btn ghost filter-btn" data-s="filter"><kbd>F</kbd> <span>${S.filter ? "Filter on" : "Filter off"}</span></button></div>
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
    $("#deck").innerHTML = `${nx ? `<div class="swipe-card under" data-photo="${nx.photo}"><img src="${P(nx.photo)}" alt="" draggable="false"></div>` : ""}
      <div class="swipe-card top" id="top" data-photo="${c.photo}" data-box='${JSON.stringify((c.view || {}).box || null)}'><img src="${P(c.photo)}" alt="Photo to keep or toss" draggable="false">
        <span class="why ${c.kind}">${esc(why(c))}</span><span class="stamp keep">KEEP</span><span class="stamp toss">TOSS</span></div>`;
    drag($("#top"));
    World.swap($("#deck"), gone);
    paintFilters();
  }
  const pending = [];  // calls made while the last one was still saving
  async function decide(keep) {
    if (i >= cards.length) return;
    if (busy) { if (pending.length < 3) pending.push(keep); return; }
    busy = true;
    const el = $("#top");
    el.style.transform = "";
    el.classList.add(keep ? "fly-right" : "fly-left");
    Sound.play(keep ? "pick" : "toss");
    floatText("+3 XP", el);
    try {
      const r = await api("/api/sweep", { photo: cards[i].photo, keep });
      done.push(keep);
      keep ? kept++ : tossed++;
      if (r.progress && r.progress.game) { Ach.check(r.progress.game); S.game = r.progress.game; }
    } catch (e) { toast(e.message); el.classList.remove("fly-right", "fly-left"); busy = false; return; }
    await sleep(200);
    i++;
    busy = false;
    paint();
    if (pending.length) decide(pending.shift());
  }
  async function undoOne() {
    if (busy || !done.length) return;
    busy = true;
    try {
      const r = await api("/api/undo", {});
      if (r.undone === "sweep") {
        done.pop() ? kept-- : tossed--;
        i = Math.max(0, i - 1);
        Sound.play("undo");
        $(".sweep-controls").hidden = false;
        $("#sw-finish").hidden = true;
      }
      else toast(UNDONE[r.undone] || "Nothing to undo here.");
    } catch (e) { toast(e.message); }
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
    const up = () => {
      if (x0 == null) return;
      x0 = null;
      el.classList.remove("held");
      if (Math.abs(dx) > Math.min(140, el.clientWidth / 3)) decide(dx > 0);
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
  $$("[data-s]").forEach((b) => (b.onclick = () => (b.dataset.s === "undo" ? undoOne() : b.dataset.s === "filter" ? toggleFilter()
    : decide(b.dataset.s === "keep"))));
  $("#sw-undo").onclick = () => undoOne();
  S.onKey = (e) => {
    const k = e.key;
    if (k === "Escape" || (k === "Enter" && i >= cards.length)) { e.preventDefault(); location.hash = "home"; }
    else if (k === "ArrowRight" || k === "Enter" || k === "d" || k === "D") { e.preventDefault(); if (!e.repeat) decide(true); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); if (!e.repeat) decide(false); }
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

function podiumHtml(ids) {
  const [gold, silver, bronze] = ids;
  const pod = (pid, cls, medal, place) => pid ? `<div class="pod ${cls}"><div class="pod-photo"><img src="${P(pid)}" alt="">
    ${place === 1 ? `<span class="pod-crown">👑</span>` : ""}<span class="medal">${medal}</span></div><div class="pod-step">${place}</div></div>` : "";
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

const FINALS_HELP = `Your leaderboard's top 8 go into a bracket: quarterfinals, semifinals, a bronze match and the final. Eight calls
  crown your champion, and every match also counts as a duel. The bracket is fairest once the leaderboard is at 80% of its best:
  a few more duels first get the right 8 into it. <b>←</b>/<b>→</b> pick, <b>Z</b> undoes, <b>F</b> toggles the filter.`;

function renderFinals(main, d) {
  const gone = World.grab(main);
  renderBracket(main, d);
  World.swap(main, gone);
}
function renderBracket(main, d) {
  const f = d.finals;
  const q = (d.progress && d.progress.quality) || 0;
  if (!f) {
    const seeds = d.preview || [];
    main.innerHTML = `
      <div class="screen finals no-rail">
        <div class="screen-head">
          <h1>🏆 Finals</h1>
          ${seeds.length ? `<span class="stat-chip"><b>${seeds.length}</b> seeds</span>` : ""}
          <span class="stat-chip ${q < 0.8 ? "warn" : "good"}"><b>${pct(q)}</b> of its best${q < 0.8 ? " · fairest from 80%" : ""}</span>
          <span class="grow"></span>
          ${helpBtn(FINALS_HELP)}
        </div>
        <div class="screen-body fill finals-body">${d.eligible && seeds.length ? `
          <div class="finals-caption">If you seed it now, these ${seeds.length} go in</div>
          <div class="bracket preview" id="bracket">${bracketHtml(previewBracket(seeds), -1)}</div>`
          : `<div class="empty"><div class="big-emoji">🏆</div><h2>Not enough for a bracket</h2>
            <p class="muted">This cup needs at least 4 shots in the running. Bring some back from <a href="#cuts">Set aside</a>.</p></div>`}
        </div>
        <div class="screen-bar action-bar">
          <div class="bar-left"><a class="btn big" href="#duel">More duels first</a></div>
          <div class="bar-mid">${d.eligible && q < 0.8 ? `<span class="muted small">The leaderboard is at ${pct(q)} of its best; seeding now is fine, just less fair.</span>` : ""}</div>
          <div class="bar-right">${d.eligible ? `<button class="btn primary big" id="f-start">Seed the bracket <kbd>Enter</kbd></button>`
            : `<a class="btn primary big" href="#home">The map →</a>`}</div>
        </div>
      </div>`;
    const start = async () => {
      try { const r = await api("/api/finals/start", {}); Sound.play("level"); renderFinals(main, { ...r, progress: d.progress }); }
      catch (e) { toast(e.message); }
    };
    const b = $("#f-start");
    if (b) b.onclick = start;
    S.onKey = (e) => { if (e.key === "Enter" && b) { e.preventDefault(); start(); } };
    return;
  }
  const card = d.card;
  const seed = (pid) => f.seeds.indexOf(pid) + 1;
  const sameRound = card ? f.matches.map((m, k) => [m, k]).filter(([m]) => m.round === card.round) : [];
  const nth = card ? sameRound.findIndex(([, k]) => k === card.match) + 1 : 0;
  const played = f.matches.filter((m) => m.winner).length;
  main.innerHTML = `
    <div class="screen finals">
      <div class="screen-head">
        <h1>🏆 Finals</h1>
        ${card ? `<span class="stat-chip match-title"><b>${esc(card.label)}</b>${sameRound.length > 1 ? ` ${nth} of ${sameRound.length}` : ""}</span>
          <span class="stat-chip">Seed <b>${seed(card.a)}</b> vs seed <b>${seed(card.b)}</b></span>`
          : f.champion ? `<span class="stat-chip good">👑 <b>Champion crowned</b></span>` : ""}
        <span class="stat-chip"><b>${played}</b> of ${f.matches.length} matches</span>
        <span class="grow"></span>
        <button class="btn ghost" id="f-reset" title="Throw this bracket away and seed a new one">Replay</button>
        ${helpBtn(FINALS_HELP)}
      </div>
      <div class="screen-body fill" id="f-match">${card ? `
        <div class="arena finals-arena enter" id="f-arena">${["a", "b"].map((side) => `
          <div class="slot slot-${side}"><div class="side" data-side="${side}" data-photo="${card[side]}"
            data-box='${JSON.stringify(((d.photos || {})[card[side]] || {}).box || null)}'>
            <img class="whole" src="${P(card[side])}" alt="${side === "a" ? "Left" : "Right"}" draggable="false">
            <span class="role">Seed ${seed(card[side])}</span></div></div>`).join("")}</div>`
        : f.champion ? `<div class="finals-done">${podiumHtml([f.champion, f.runner_up, f.bronze])}</div>` : ""}
      </div>
      <aside class="screen-rail"><div class="rail-card grow"><h3>Bracket</h3>
        <div class="bracket" id="bracket">${bracketHtml(f, card ? card.match : -1)}</div></div></aside>
      <div class="screen-bar action-bar">${card ? `
        <div class="bar-left"><button class="btn big" data-f="a"><kbd>←</kbd> Left</button></div>
        <div class="bar-mid"><button class="btn ghost" data-f="undo"><kbd>Z</kbd> Undo</button>
          <button class="btn ghost filter-btn" data-f="filter"><kbd>F</kbd> <span>${S.filter ? "Filter on" : "Filter off"}</span></button></div>
        <div class="bar-right"><button class="btn big" data-f="b">Right <kbd>→</kbd></button></div>` : `
        <div class="bar-left"><a class="btn big" href="#home">The map</a></div>
        <div class="bar-mid"><button class="btn ghost" data-f="undo"><kbd>Z</kbd> Undo the final</button></div>
        <div class="bar-right"><a class="btn primary big" href="#reveal" id="f-next">Next: the reveal 🎉 <kbd>Enter</kbd></a></div>`}
      </div>
    </div>`;
  const shownAt = performance.now();
  let busy = false;
  const pick = async (outcome) => {
    if (busy || !card) return;
    busy = true;
    const sides = $$("#f-arena .side");
    sides[outcome === "a" ? 0 : 1].classList.add("won");
    sides[outcome === "a" ? 1 : 0].classList.add("lost");
    Sound.play("pick");
    const ws = seed(outcome === "a" ? card.a : card.b), ls = seed(outcome === "a" ? card.b : card.a);  // the moment: who goes on
    floatText(card.round === "final" ? `👑 Seed ${ws} takes the title!` : ws > ls ? `Upset! Seed ${ws} advances` : `Seed ${ws} advances`,
      sides[outcome === "a" ? 0 : 1], ws > ls || card.round === "final" ? "bonus" : "");
    try {
      const r = await api("/api/vote", { card: card.id, outcome, ms: Math.round(performance.now() - shownAt) });
      if (r.progress && r.progress.game) updateHudQuiet(r.progress.game);
      await sleep(260);
      if (r.result && r.result.round === "final") { renderFinals(main, { ...r, progress: r.progress }); championCeremony(r.finals); refreshHud(true); return; }
      renderFinals(main, r);
    } catch (e) {
      toast(e.message);
      if (e.status === 409) viewFinals(main);
      busy = false;
    }
  };
  const undoPick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await api("/api/undo", {});
      if (r.undone === "final") { Sound.play("undo"); renderFinals(main, r); refreshHud(true); return; }
      toast(UNDONE[r.undone] || "Nothing to undo here.");
    } catch (e) { toast(e.message); }
    busy = false;
  };
  $$("[data-f]").forEach((b) => (b.onclick = () => (b.dataset.f === "undo" ? undoPick() : b.dataset.f === "filter" ? toggleFilter()
    : pick(b.dataset.f))));
  paintFilters();
  $$("#f-arena .side").forEach((el) => (el.onclick = () => pick(el.dataset.side)));
  $("#f-reset").onclick = async () => {
    if (!confirm("Throw this bracket away and seed a new one from the current leaderboard?")) return;
    renderFinals(main, { ...(await api("/api/finals/reset", {})), progress: d.progress });
    refreshHud(true);
  };
  S.onKey = (e) => {
    const k = e.key;
    if (["ArrowLeft", "a", "A"].includes(k)) { e.preventDefault(); if (!e.repeat) pick("a"); }
    else if (["ArrowRight", "d", "D"].includes(k)) { e.preventDefault(); if (!e.repeat) pick("b"); }
    else if (["z", "Z", "Backspace"].includes(k)) { e.preventDefault(); if (!e.repeat) undoPick(); }
    else if (k === "f" || k === "F") { e.preventDefault(); toggleFilter(); }
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

function championCeremony(f) {
  Sound.play("crown");
  setTimeout(() => Sound.play("level"), 500);
  const box = document.createElement("div");
  box.className = "ceremony";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Champion crowned");
  box.innerHTML = `<div class="ceremony-inner"><div class="ceremony-title">Champion!</div>${podiumHtml([f.champion, f.runner_up, f.bronze])}
    <div class="row center"><button class="btn" id="cer-close">Close</button><a class="btn primary big" href="#reveal" id="cer-reveal">Next: the reveal 🎉</a></div></div>`;
  document.body.append(box);
  const keys = S.onKey;
  const close = () => { box.remove(); S.onKey = keys; };
  S.onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Tab") {  // keep focus inside the dialog
      const f2 = [$("#cer-reveal", box), $("#cer-close", box)];
      e.preventDefault();
      f2[(f2.indexOf(document.activeElement) + 1) % 2].focus();
    }
  };
  $("#cer-close", box).onclick = close;
  $("#cer-reveal", box).onclick = close;
  box.onclick = (e) => { if (e.target === box) close(); };
  $("#cer-reveal", box).focus();
  for (let k = 0; k < 4; k++) setTimeout(() => confetti(window.innerWidth * (0.2 + 0.2 * k), window.innerHeight * 0.3, 50), k * 250);
}

// ---------------------------------------------------------------- the tournament board
// The whole tournament on one board, like a broadcast: every group's roster and standings (who's through, the cut),
// the race for the finals' eight seats with the next ones in line, and the bracket.
async function viewTournament(main) {
  main.innerHTML = LOADING();
  const view = S.view;
  let d;
  try { d = await api("/api/tournament"); } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  const st = S.journey ? journeyStatus(S.journey) : null;
  const next = st && STAGES.find(([k]) => k === st.next);
  const decided = d.groups.filter((g) => g.settled).length;
  const team = (t) => (t ? `<span class="team-chip mini">${esc(t.emoji)} <b>${esc(t.letter)}</b></span>` : "");
  const group = (g) => `
    <div class="tb-group ${g.settled ? "settled" : ""}">
      <div class="tb-ghead"><span class="tb-letter">${esc(g.letter)}</span><span class="tb-gname">${esc(g.emoji)} ${esc(g.name)}</span>
        <span class="tb-gstate">${g.settled ? "✓ Decided" : `${fmt(g.played)} of ~${fmt(g.budget)}`}</span></div>
      <ol class="tb-roster">${g.rows.map((r, i) => `
        <li class="${r.through ? "through" : ""} ${i === g.adv ? "cut" : ""}" title="${r.w} won · ${r.l} lost${r.d ? ` · ${r.d} level` : ""}">
          <span class="tb-pos">${i + 1}</span><img src="${T(r.photo)}" alt="" data-view="${r.photo}">
          <span class="tb-wl">${r.w}–${r.l}</span>
          <span class="tb-odds"><i style="width:${pct(r.odds)}"></i></span><span class="tb-pct">${r.through ? "✓" : `${Math.round(r.odds * 100)}%`}</span></li>`).join("")}</ol>
    </div>`;
  const seat = (x, i, bubble) => `<div class="tb-seat ${bubble ? "bubble" : ""}" style="--i:${i}">
      <span class="tb-seatno">${bubble ? i + 9 : i + 1}</span><img src="${T(x.photo)}" alt="" data-view="${x.photo}">${team(x.team)}</div>`;
  const f = d.finals;
  main.innerHTML = `
    <div class="screen tournament no-rail">
      <div class="screen-head">
        <h1>🏟️ Tournament</h1>
        <span class="stat-chip"><b>${fmt(d.groups.length)}</b> ${d.groups.length === 1 ? "group" : "groups"} · ${fmt(decided)} decided</span>
        <span class="stat-chip ${(d.progress.quality || 0) >= 0.8 ? "good" : ""}">leaderboard at <b>${pct(d.progress.quality || 0)}</b></span>
        <span class="stat-chip ${f && f.champion ? "good" : ""}">${f ? (f.champion ? "👑 champion crowned" : `finals: <b>${f.matches.filter((m) => m.winner).length}</b> of ${f.matches.length}`) : "finals not seeded"}</span>
        <span class="grow"></span>
        ${helpBtn(`The whole tournament at a glance. <b>Group stage:</b> each group's photos in standings order (who you beat counts, not just how
          often); the places above the dashed line go through. <b>Knockouts:</b> the eight seats in the finals as the leaderboard stands now,
          and the next four, on the bubble. <b>Finals:</b> the bracket. Click a photo to see it big.`)}
      </div>
      <div class="screen-body tb-body">
        <section class="tb-section"><h2>⚽ Group stage</h2>
          ${d.groups.length ? `<div class="tb-groups">${d.groups.map(group).join("")}</div>` : `<p class="muted">No groups yet: every shot goes into a themed group first.</p>`}</section>
        <section class="tb-section"><h2>⚔️ Knockouts <span class="muted small">the race for the eight seats in the finals</span></h2>
          ${d.seats.length ? `<div class="tb-seats">${d.seats.map((x, i) => seat(x, i)).join("")}</div>
            ${d.bubble.length ? `<div class="tb-bubble"><span class="muted small">On the bubble</span>${d.bubble.map((x, i) => seat(x, i, true)).join("")}</div>` : ""}`
            : `<p class="muted">The seats fill once there are enough shots in the running.</p>`}</section>
        <section class="tb-section"><h2>🏆 Finals</h2>
          ${f ? `<div class="bracket tb-bracket">${bracketHtml(f, d.card ? d.card.match : -1)}</div>`
            : d.preview && d.preview.length ? `<div class="bracket tb-bracket preview">${bracketHtml(previewBracket(d.preview), -1)}</div><p class="muted small">If the bracket were seeded now.</p>`
            : `<p class="muted">Not enough shots for a bracket yet.</p>`}</section>
      </div>
      <div class="screen-bar action-bar">
        <div class="bar-left"><a class="btn big" href="#home">The map</a></div>
        <div class="bar-mid"><a class="btn ghost" href="#shortlist">Full leaderboard</a></div>
        <div class="bar-right">${next && st[next[0]] ? `<a class="btn primary big" href="${st[next[0]].go}">Play: ${esc(next[3])} → <kbd>Enter</kbd></a>` : ""}</div>
      </div>
    </div>`;
  $$("[data-view]", main).forEach((img) => (img.onclick = () => openViewer(Number(img.dataset.view))));
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
        ${podiumHtml(d.podium)}
        ${d.top.length > 3 ? `<div class="reveal-strip">${d.top.slice(3).map((it) => `<div class="tile"><span class="rank">${it.rank}</span>
          <img src="${T(it.photo)}" alt="" loading="lazy" data-view="${it.photo}" style="${facePos(it.box)}"></div>`).join("")}</div>` : ""}
      </div>
      <aside class="screen-rail">
        <div class="rail-card taste"><h3>Your taste</h3>
          <div class="taste-cols"><div><b>You go for</b><ul>${li(loves)}</ul></div><div><b>Not your thing</b><ul>${li(skips)}</ul></div></div>
          ${(p.votes || 0) < 60 ? `<p class="faint small">Early days: mostly its starting guesses so far.</p>` : ""}</div>
        <div class="rail-card"><h3>Your run</h3><div class="stat-grid">
          <div><b>${fmt(g.judged)}</b><span>calls</span></div><div><b>${(p.minutes || 0) < 1 ? "<1" : Math.round(p.minutes)}</b><span>minutes</span></div>
          <div><b>${fmt(g.best_streak)}</b><span>best streak</span></div><div><b>${fmt(g.crowned)}</b><span>stacks crowned</span></div>
          <div><b>${fmt(g.sweep)}</b><span>swept</span></div><div><b>Lv ${g.level || 1}</b><span>${esc(g.level_name || "")}</span></div>
        </div></div>
        ${nextCup ? `<div class="rail-card next-cup"><div><b>Next up: ${nextCup.icon} ${esc(nextCup.name)}</b>
          <div class="muted small">${plural(nextCup.shots, "shot")} · about ${Math.max(3, Math.round(nextCup.shots / 6))} minutes to a champion</div></div>
          <button class="btn primary" data-next-cup="${nextCup.key}">Play it</button></div>` : ""}
      </aside>
      <div class="screen-bar action-bar">
        <div class="bar-left">${d.from_finals ? `<a class="btn big" href="#shortlist">Full leaderboard</a>` : `<a class="btn big" href="#finals">Play the finals</a>`}</div>
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
  $("#x-best").onclick = (e) => exportFlow("bestof", e.currentTarget);
  $("#x-review").onclick = (e) => exportFlow("review", e.currentTarget);
  S.onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#x-best").click(); } };
  if (d.from_finals && !reduceMotion) setTimeout(() => confetti(window.innerWidth / 2, window.innerHeight * 0.25, 70), 400);
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
  x.fillText(`${cup.name}`, W / 2, 120);
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
    x.fillStyle = "#f4f1ec"; x.font = "800 36px system-ui, sans-serif"; x.fillText(title, left, 1060);
    x.fillStyle = "#c9ccd0"; x.font = "500 30px system-ui, sans-serif";
    items.slice(0, 3).forEach((t, k) => x.fillText(`• ${tasteLabel(t.feature)}`, left, 1110 + k * 44));
  };
  if (loves.length) list("I go for", loves, 90);
  if (skips.length) list("Not my thing", skips, loves.length ? 570 : 90);
  x.fillStyle = "#6b7178"; x.font = "600 26px system-ui, sans-serif"; x.textAlign = "center";
  x.fillText("Sorted with MatchER", W / 2, H - 50);
  const a = document.createElement("a");
  a.href = c.toDataURL("image/png");
  a.download = `matcher-${(cup.name || "result").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
  a.click();
  toast("Saved your share card.");
}

// The export lands as a reward card over the screen (not pushed into the page, where it would shift everything).
async function exportFlow(kind, b) {
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
        <div><code class="path">${esc(r.dir)}</code></div>
        <p class="muted">The original files, untouched (metadata and all), named by rank: 01 is your best.</p>
        <div class="row spread"><button class="btn" id="close-modal">Close</button><button class="btn primary" id="open-export">Open folder</button></div>
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
    m.showModal();
    $("#open-export", m).focus();
    Sound.play("achieve");
    gameCheck();
  } catch (e) { toast(e.message); }
  b.disabled = false;
  b.innerHTML = label;
}

// ---------------------------------------------------------------- shortlist (the leaderboard)
async function viewShortlist(main) {
  main.innerHTML = LOADING();
  let d;
  const view = S.view;
  try { d = await api("/api/shortlist"); } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
  if (left(view)) return;
  const p = d.progress || {};
  const tile = (it, extra = "") => `
    <div class="tile ${it.frames > 1 ? "stacked" : ""}" data-photo="${it.photo}">
      ${it.rank ? `<span class="rank">${it.rank}</span>` : ""}
      ${it.frames > 1 ? `<span class="badge" data-frames="${it.photo}" title="Swap which take stands in for this stack">${it.frames} takes</span>` : ""}
      <img src="${T(it.photo)}" alt="" loading="lazy" data-view="${it.photo}" style="${facePos(it.box)}">
      <div class="meta">
        <div class="conf" title="Chance it belongs in the shortlist: ${pct(it.p_in)}"><i style="width:${pct(it.p_in)}"></i></div>
        <div class="row spread"><span>${pct(it.p_in)} sure</span><span>${it.duels} duel${it.duels === 1 ? "" : "s"}</span></div>
        <div class="flags">${flagHtml(it.flags)}</div>
        ${extra}
      </div>
    </div>`;
  const scroll = $(".screen-body", main)?.scrollTop || 0;  // adding or removing one keeps your place
  main.innerHTML = `
    <div class="screen board">
      <div class="screen-head">
        <h1>🏅 Leaderboard</h1>
        <span class="stat-chip">top <b>${d.items.length}</b></span>
        <span class="stat-chip"><b>${fmt(p.votes)}</b> duels</span>
        <span class="stat-chip ${p.quality >= 0.8 ? "good" : ""}"><b>${pct(p.quality)}</b> of its best</span>
        ${d.settled ? `<span class="stat-chip good">👑 top <b>${d.settled}</b> from the finals</span>` : ""}
        <span class="grow"></span>
        ${helpBtn(`The best shots so far, best first. "Sure" is the chance a shot really belongs here; more duels make it surer.
          At most ${S.lib.settings.per_scene} per scene, so it stays varied. <b>On the bubble</b> are the next ones in line: add one by hand
          and it rides along in the export without a rank. Click a photo to see it big.`)}
      </div>
      <div class="screen-body board-body">
        <div class="grid">${d.items.map((it) => tile(it)).join("")}</div>
        <h2 class="board-h">On the bubble <span class="muted small">the next ones in line: add any that deserve a look anyway</span></h2>
        <div class="grid">${d.bubble.map((it) => tile(it, it.added ? `<div class="actions"><button class="btn" data-unpick="${it.photo}">Added ✓</button></div>`
          : `<div class="actions"><button class="btn" data-pick="${it.photo}">+ Add</button></div>`)).join("")}</div>
      </div>
      <aside class="screen-rail">
        ${tasteHtml(d.taste, p.votes)}
        <div class="rail-card"><h3>Added by hand</h3>
          ${d.added.length ? `<div class="added-list">${d.added.map((it) => `<div class="added-item"><img src="${T(it.photo)}" alt="" data-view="${it.photo}">
            <button class="btn ghost" data-unpick="${it.photo}" title="Take it out of the export">Remove</button></div>`).join("")}</div>`
            : `<p class="muted small">Nothing yet. Add favourites from <b>On the bubble</b>; they ride along in the export without a rank.</p>`}
        </div>
      </aside>
      <div class="screen-bar action-bar">
        <div class="bar-left"><a class="btn big" href="#duel">Keep dueling</a></div>
        <div class="bar-mid"><button class="btn ghost" id="export">Blind review package</button></div>
        <div class="bar-right"><button class="btn primary big" id="export-best">Save my best</button></div>
      </div>
    </div>`;
  $(".screen-body", main).scrollTop = scroll;
  $$("[data-pick]").forEach((b) => (b.onclick = async () => { await api("/api/pick", { photo: Number(b.dataset.pick), on: true }); viewShortlist(main); }));
  $$("[data-unpick]").forEach((b) => (b.onclick = async () => { await api("/api/pick", { photo: Number(b.dataset.unpick), on: false }); viewShortlist(main); }));
  $$("[data-view]", main).forEach((img) => (img.onclick = () => openViewer(Number(img.dataset.view))));
  $$("[data-frames]").forEach((b) => (b.onclick = () => openFrames(Number(b.dataset.frames), () => viewShortlist(main))));
  $("#export").onclick = (e) => exportFlow("review", e.currentTarget);
  $("#export-best").onclick = (e) => exportFlow("bestof", e.currentTarget);
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

function openViewer(id) {
  const m = $("#modal");
  m.className = "wide";
  m.innerHTML = `<div class="viewer"><img src="${P(id)}" alt=""></div>`;
  m.onclick = () => m.close();  // any click (or Esc) closes it
  m.showModal();
}

async function openFrames(photo, done) {
  const r = await api(`/api/group/${photo}`);
  const m = $("#modal");
  m.className = "wide";
  m.innerHTML = `<h2>Pick the take that stands in for this stack</h2>
    <div class="grid">${r.members.map((id) => `<div class="tile pick ${id === photo ? "rescued" : ""}" data-swap="${id}"><img src="${T(id)}" alt=""></div>`).join("")}</div>
    <div class="row spread" style="margin-top:14px"><span class="muted small">Its duel record carries over.</span><button class="btn" id="close-modal">Close</button></div>`;
  $("#close-modal").onclick = () => m.close();
  $$("[data-swap]", m).forEach((t) => (t.onclick = async () => {
    await api("/api/frame", { photo: Number(t.dataset.swap) });
    m.close();
    toast("Take swapped.");
    done && done();
  }));
  m.showModal();
}

// ---------------------------------------------------------------- the photo sea: pictures floating into order
// A field of photo cards with a little physics. Loose photos drift on a slow current in the open water; photos that
// belong somewhere swim to their island and settle into a sunflower spiral around it (first ones in the middle);
// everything makes room for its neighbours and gets pushed and stirred by the pointer. Moving a photo somewhere else
// is only a new target: it swims there. Drag a photo onto an island, onto another photo, or into open water.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
class PhotoSea {
  constructor(el, { onDrop, onSelect, onIsland, label } = {}) {
    this.el = el;
    this.onDrop = onDrop; this.onSelect = onSelect; this.onIsland = onIsland; this.label = label;
    this.items = new Map(); this.islands = new Map(); this.order = [];
    this.mouse = { x: -1e5, y: -1e5, vx: 0, vy: 0 };
    this.s = 72; this.raf = 0; this.last = 0; this.drag = null; this.hover = null; this.alive = true;
    el.classList.add("photo-sea");
    this.water = document.createElement("div");
    this.water.className = "ps-water";
    el.append(this.water);
    el.addEventListener("pointermove", (e) => this.pointer(e));
    el.addEventListener("pointerleave", () => { if (!this.drag) this.mouse.x = this.mouse.y = -1e5; });
    el.addEventListener("pointerdown", (e) => this.down(e));
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(el);
  }
  destroy() { this.alive = false; this.ro.disconnect(); cancelAnimationFrame(this.raf); }
  local(e) { const r = this.el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  pointer(e) {
    const [x, y] = this.local(e), m = this.mouse;
    if (m.x > -1e4) { m.vx = m.vx * 0.5 + (x - m.x) * 0.5; m.vy = m.vy * 0.5 + (y - m.y) * 0.5; }
    m.x = x; m.y = y;
    if (this.drag) {
      const d = this.drag;
      if (!d.moving && Math.hypot(x - d.x0, y - d.y0) > 6) { d.moving = true; d.items.forEach((it) => it.el.classList.add("dragging")); }
      if (d.moving) {
        d.items.forEach((it, k) => { it.x = x + (k ? Math.cos(k * 2.4) * this.s * 0.35 : 0); it.y = y + (k ? Math.sin(k * 2.4) * this.s * 0.35 : 0); it.vx = it.vy = 0; });
        const bin = this.binAt(e);
        $$(".bin.hot").forEach((b) => b !== bin && b.classList.remove("hot"));
        if (bin) { bin.classList.add("hot"); this.mark(null); } else this.mark(this.target(x, y, d.items[0]));
      }
    }
    this.kick();
  }
  down(e) {
    const el = e.target.closest(".ps-item");
    if (!el || e.button > 0) return;
    const it = this.items.get(Number(el.dataset.id));
    if (!it) return;
    e.preventDefault();
    const [x, y] = this.local(e);
    const group = it.selected ? [...this.items.values()].filter((o) => o.selected) : [it];
    this.drag = { items: [it, ...group.filter((o) => o !== it)], x0: x, y0: y, moving: false };
    this.el.setPointerCapture(e.pointerId);
    const up = (ev) => {
      this.el.removeEventListener("pointerup", up);
      this.el.removeEventListener("pointercancel", up);
      const d = this.drag;
      const bin = d.moving ? this.binAt(ev) : null;  // (while the dragged photo still lets the pointer through)
      this.drag = null;
      this.mark(null);
      d.items.forEach((o) => o.el.classList.remove("dragging"));
      if (!d.moving) { if (this.onSelect) this.onSelect(it); return; }
      $$(".bin.hot").forEach((b) => b.classList.remove("hot"));
      if (bin) { if (this.onDrop) this.onDrop(d.items.map((o) => o.id), { kind: "bin", id: bin.dataset.bin }); this.kick(); return; }
      const [ux, uy] = this.local(ev);
      const t = this.target(ux, uy, it);
      if (t.kind === "sea") d.items.forEach((o) => { o.hx = ux + (Math.random() - 0.5) * this.s; o.hy = uy + (Math.random() - 0.5) * this.s; });
      if (this.onDrop) this.onDrop(d.items.map((o) => o.id), t);
      this.kick();
    };
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
  }
  // A group's bin in the side list under the pointer (a drag can leave the field to drop a photo on one).
  binAt(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && !this.el.contains(el) ? el.closest("[data-bin]") : null;
  }
  // What's under a drop: another photo (stack them), an island (join it) or open water.
  target(x, y, self) {
    for (const it of this.items.values()) {
      if (it === self || (this.drag && this.drag.items.includes(it))) continue;
      if (Math.abs(it.x - x) < this.s * 0.42 && Math.abs(it.y - y) < this.s * 0.42) return { kind: "photo", id: it.id, item: it };
    }
    let best = null;
    for (const is of this.islands.values()) {
      const d = Math.hypot(is.cx - x, is.cy - y);
      if (d < is.r + this.s * 0.6 && (!best || d < best.d)) best = { kind: "island", id: is.id, d, island: is };
    }
    return best || { kind: "sea" };
  }
  mark(t) {
    const key = t ? `${t.kind}:${t.id}` : null;
    if (key === this.hover) return;
    this.hover = key;
    this.el.querySelectorAll(".ps-hot").forEach((x) => x.classList.remove("ps-hot"));
    if (t && t.kind === "photo") t.item.el.classList.add("ps-hot");
    if (t && t.kind === "island") { t.island.ring.classList.add("ps-hot"); t.island.tag.classList.add("ps-hot"); }
    if (t && t.kind === "sea") this.water.classList.add("ps-hot");
  }
  // islands: [{id, html}], in a stable order (their number); items: [{id, photo, island|null, n, title}]
  set(islands, items) {
    const keepI = new Set(islands.map((i) => i.id));
    for (const [id, is] of this.islands) if (!keepI.has(id)) { is.ring.remove(); is.tag.remove(); this.islands.delete(id); }
    this.order = islands.map((i) => i.id);
    for (const i of islands) {
      let is = this.islands.get(i.id);
      if (!is) {
        is = { id: i.id, cx: this.el.clientWidth / 2, cy: this.el.clientHeight / 2, r: 0 };
        is.ring = document.createElement("div");
        is.ring.className = "ps-ring";
        is.tag = document.createElement("button");
        is.tag.className = "ps-tag";
        is.tag.onclick = (e) => { e.stopPropagation(); if (this.onIsland) this.onIsland(i.id, is.tag); };
        this.el.append(is.ring, is.tag);
        this.islands.set(i.id, is);
      }
      is.tag.innerHTML = i.html;
      is.color = i.color;
    }
    this.syncItems(items);
    this.layout();
  }
  // Where a new photo first appears (its island, or somewhere mid-water), and what an item takes from its data.
  spawn(x) {
    const from = x.island != null && this.islands.get(x.island), cw = this.el.clientWidth, ch = this.el.clientHeight;
    return from ? [from.cx, from.cy] : [cw / 2 + (Math.random() - 0.5) * cw * 0.4, ch / 2 + (Math.random() - 0.5) * ch * 0.4];
  }
  adopt(it, x) { if (it.island !== x.island) { it.island = x.island; it.hx = null; } }
  // Photos in, photos out (gone ones fade where they are), and each one's picture, stack count and group badge.
  syncItems(items) {
    const keep = new Set(items.map((x) => x.id));
    for (const [id, it] of this.items) {
      if (keep.has(id)) continue;
      it.el.classList.add("leaving");  // stacked into another photo, or gone: it fades where it is
      setTimeout(() => it.el.remove(), 500);
      this.items.delete(id);
    }
    for (const x of items) {
      let it = this.items.get(x.id);
      if (!it) {
        const [sx, sy] = this.spawn(x);
        it = { id: x.id, x: sx, y: sy, vx: 0, vy: 0, ph: Math.random() * 6.28, w: 0.3 + Math.random() * 0.4, sel: false };
        it.el = document.createElement("div");
        it.el.className = "ps-item entering";
        it.el.dataset.id = x.id;
        it.el.tabIndex = 0;
        it.el.setAttribute("role", "button");
        this.el.append(it.el);
        setTimeout(() => it.el.classList.remove("entering"), 30);
        this.items.set(x.id, it);
      }
      it.el.classList.toggle("stacked", x.n > 1);
      if (it.photo !== x.photo || it.n !== x.n || it.badge !== (x.badge || "")) {
        it.el.innerHTML = `<img src="${T(x.photo)}" alt="" draggable="false">${x.n > 1 ? `<span class="ps-stack">⧉ ${x.n}</span>` : ""}${x.badge
          ? `<span class="ps-badge">${esc(x.badge)}</span>` : ""}`;
        it.photo = x.photo;
        it.n = x.n;
        it.badge = x.badge || "";
      }
      it.el.setAttribute("aria-label", x.title || "Photo");
      it.el.title = x.title || "";
      this.adopt(it, x);
    }
  }
  // Light up some photos (a group or a suggestion you're pointing at) and dim the rest; null clears it.
  highlight(ids) {
    const on = ids ? new Set(ids) : null;
    this.el.classList.toggle("ps-dim", !!on);
    for (const it of this.items.values()) it.el.classList.toggle("ps-glow", !!on && on.has(it.id));
  }
  select(ids) {
    const on = new Set(ids);
    for (const it of this.items.values()) { it.selected = on.has(it.id); it.el.classList.toggle("selected", it.selected); }
    this.kick();
  }
  // The biggest tile size at which every island and the open water fit; the water in the middle sized for the loose
  // photos; islands on a ring around it, pushed apart (and off the water) until nothing overlaps; members get spiral
  // slots; loose photos get a home somewhere in the water.
  layout() {
    if (!this.alive) return;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const isl = this.order.map((id) => this.islands.get(id));
    const count = new Map();
    let free = 0;
    for (const it of this.items.values()) {
      if (it.island != null && this.islands.has(it.island)) count.set(it.island, (count.get(it.island) || 0) + 1);
      else free++;
    }
    const radius = (s, n) => s * (0.7 + 0.62 * Math.sqrt(n + 0.5));
    const need = (s) => isl.reduce((a, is) => a + (2 * radius(s, count.get(is.id) || 0) + s * 0.6) ** 2, 0) + (2 * radius(s, free) + s) ** 2;
    let s = 104;
    while (s > 28 && need(s) > W * H * 0.82) s -= 2;
    // A photo or two coming and going shouldn't resize (and so move) everything: while the fitted size is about what it
    // was at the last resize, keep the size the last layout settled on (smaller than the fit if islands clashed there).
    if (this.fit != null && Math.abs(this.fit - s) <= 8 && need(this.s) <= W * H * 0.9) s = this.s;
    else this.fit = s;
    // Radii hold through small changes too (they grow with some headroom and shrink only past a fifth), so one photo
    // arriving or leaving doesn't push every island somewhere new.
    const hold = (cur, want, same) => (!same || !cur ? want : want > cur ? want * 1.12 : want < cur * 0.8 ? want : cur);
    const K = isl.length;
    let wr = 0, sig = "";
    for (let tries = 0; tries < 14; tries++) {  // place everything; if islands still overlap, try a size smaller
    wr = hold(this.wrHeld, free ? radius(s, free) * 1.1 : s * 0.8, this.wrS === s);  // the open water, held in the middle
    this.wx = W / 2; this.wy = H / 2 + 10; this.wr = wr;
    isl.forEach((is, k) => {
      is.n = count.get(is.id) || 0;
      is.r = hold(is.r, radius(s, is.n), is.rS === s);
      const a = -Math.PI / 2 + ((k + 0.5) / Math.max(1, K)) * Math.PI * 2;
      is.rx = W / 2 + Math.cos(a) * (W / 2 - is.r - 12);
      is.ry = H / 2 + Math.sin(a) * (H / 2 - is.r - 26);
      if (!is.placed || tries) { is.cx = is.rx; is.cy = is.ry; is.placed = true; }
    });
    sig = `${W}x${H}|${s}|${wr.toFixed(1)}|${isl.map((is) => `${is.id}:${is.r.toFixed(1)}`).join(",")}`;
    if (!tries && sig === this.sig) break;  // nothing that places the islands changed: they stay exactly where they are
    for (let pass = 0; pass < 120; pass++) {  // push islands apart and off the water; keep them on screen
      for (let i = 0; i < K; i++) {
        const a = isl[i];
        a.cx += (a.rx - a.cx) * 0.015;
        a.cy += (a.ry - a.cy) * 0.015;
        const wx = a.cx - this.wx, wy = a.cy - this.wy, wd = Math.hypot(wx, wy) || 1, wneed = a.r + wr + s * 0.4;
        if (wd < wneed) { a.cx += (wx / wd) * (wneed - wd); a.cy += (wy / wd) * (wneed - wd); }
        for (let j = i + 1; j < K; j++) {
          const b = isl[j], dx = b.cx - a.cx, dy = b.cy - a.cy, d = Math.hypot(dx, dy) || 1, gap = a.r + b.r + s * 0.4;
          if (d < gap) { const f = (gap - d) / 2 / d; a.cx -= dx * f; a.cy -= dy * f; b.cx += dx * f; b.cy += dy * f; }
        }
        a.cx = Math.max(a.r + 6, Math.min(W - a.r - 6, a.cx));
        a.cy = Math.max(a.r + 30, Math.min(H - a.r - 6, a.cy));
      }
    }
    const clash = isl.some((a, i) => Math.hypot(a.cx - this.wx, a.cy - this.wy) < a.r + wr - s * 0.2
      || isl.some((b, j) => j > i && Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r - s * 0.2));
    if (!clash || s <= 30) break;
    s -= 4;
    }
    this.s = s;
    this.sig = sig;
    this.wrHeld = wr; this.wrS = s;
    for (const is of isl) is.rS = s;
    this.el.style.setProperty("--ps", `${s}px`);
    for (const is of isl) {
      is.ring.style.transform = `translate(${is.cx - is.r}px, ${is.cy - is.r}px)`;
      is.ring.style.width = is.ring.style.height = `${2 * is.r}px`;
      if (is.color) is.ring.style.setProperty("--tint", is.color);
      is.tag.style.transform = `translate(-50%, -100%) translate(${is.cx}px, ${is.cy - is.r - 4}px)`;
    }
    // Spiral slots stay put: a photo keeps its slot, and one that leaves hands its slot to the island's outermost photo,
    // so one photo moves instead of every later one stepping round the spiral (which spun whole islands).
    const members = new Map();
    for (const it of this.items.values()) {
      if (it.island != null && this.islands.has(it.island)) (members.get(it.island) || members.set(it.island, new Set()).get(it.island)).add(it.id);
    }
    for (const is of isl) {
      const here = members.get(is.id) || new Set(), slots = is.slots || [];
      for (let k = 0; k < slots.length; k++) while (k < slots.length && !here.has(slots[k])) { slots[k] = slots[slots.length - 1]; slots.pop(); }
      const had = new Set(slots);
      for (const id of here) if (!had.has(id)) slots.push(id);
      is.slots = slots;
      slots.forEach((id, k) => {
        const it = this.items.get(id), rad = s * 0.62 * Math.sqrt(k + 0.5);
        it.tx = is.cx + Math.cos(k * GOLDEN) * rad;
        it.ty = is.cy + Math.sin(k * GOLDEN) * rad;
        it.free = false;
      });
    }
    for (const it of this.items.values()) {
      if (it.island != null && this.islands.has(it.island)) continue;
      it.free = true;
      if (it.hx == null || Math.hypot(it.hx - this.wx, it.hy - this.wy) > wr) {  // a home somewhere in the water
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * Math.max(0, wr - s * 0.6);
        it.hx = Math.max(s, Math.min(W - s, this.wx + Math.cos(a) * d));  // (and on screen, if the water spills over)
        it.hy = Math.max(s, Math.min(H - s, this.wy + Math.sin(a) * d));
      }
    }
    this.water.style.transform = `translate(${this.wx - wr}px, ${this.wy - wr}px)`;
    this.water.style.width = this.water.style.height = `${2 * wr}px`;
    this.kick();
  }
  kick() { if (!this.raf && this.alive) this.raf = requestAnimationFrame((t) => this.tick(t)); }
  tick(now) {
    this.raf = 0;
    if (!this.alive || !this.el.isConnected) { this.destroy(); return; }
    const dt = Math.min(3, this.last ? (now - this.last) / 16.67 : 1);
    this.last = now;
    const T = now / 1000, s = this.s, m = this.mouse, W = this.el.clientWidth, H = this.el.clientHeight;
    const grid = new Map(), cell = s;
    for (const it of this.items.values()) {
      const k = `${Math.floor(it.x / cell)},${Math.floor(it.y / cell)}`;
      (grid.get(k) || grid.set(k, []).get(k)).push(it);
    }
    let energy = 0;
    // The photo under the pointer holds still (you're reaching for it), photos near a slow pointer calm down, and only a
    // quick swish stirs the loose ones: nothing you're trying to grab runs away.
    const speed = Math.hypot(m.vx, m.vy);
    let held = null;
    if (!this.drag) for (const it of this.items.values()) if (Math.abs(it.x - m.x) < s * 0.55 && Math.abs(it.y - m.y) < s * 0.55) { held = it; break; }
    for (const it of this.items.values()) {
      if (this.drag && this.drag.moving && this.drag.items.includes(it)) continue;
      if (it === held) { it.vx *= 0.5; it.vy *= 0.5; it.x += it.vx * dt; it.y += it.vy * dt; continue; }
      let tx, ty, k;
      if (it.free) {  // floating: circling a home in the open water, carried by a slow current
        tx = it.hx + Math.cos(T * it.w + it.ph) * s * 0.35 + Math.sin(it.hy * 0.006 + T * 0.25) * s * 0.25;
        ty = it.hy + Math.sin(T * it.w * 0.8 + it.ph) * s * 0.3;
        k = 0.0016;
      } else {  // settled: its slot in the island's spiral, bobbing a little
        tx = it.tx + Math.sin(T * 0.9 + it.ph) * 1.5;
        ty = it.ty + Math.cos(T * 0.7 + it.ph) * 1.5;
        k = 0.012;
      }
      it.vx += (tx - it.x) * k * dt;
      it.vy += (ty - it.y) * k * dt;
      const cx = Math.floor(it.x / cell), cy = Math.floor(it.y / cell);  // make room for neighbours
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const o of grid.get(`${gx},${gy}`) || []) {
          if (o === it) continue;
          const dx = it.x - o.x, dy = it.y - o.y, d = Math.hypot(dx, dy) || 0.01, need = s * (it.free && o.free ? 1.02 : 0.9);
          if (d < need) { const f = ((need - d) / need) * (it.free ? 0.5 : 0.25) * dt; it.vx += (dx / d) * f; it.vy += (dy / d) * f; }
        }
      }
      const dx = it.x - m.x, dy = it.y - m.y, d2 = dx * dx + dy * dy, R = s * 2.2;
      let calm = 1;
      if (!this.drag && it.free && d2 < R * R) {
        const d = Math.sqrt(d2) || 1, f = 1 - d / R;
        if (speed > 9) {  // a deliberate swish stirs the water
          it.vx += ((dx / d) * f * f * 1.2 + m.vx * f * 0.04) * dt;
          it.vy += ((dy / d) * f * f * 1.2 + m.vy * f * 0.04) * dt;
        } else calm = 1 - f * 0.8;  // a slow hand stills the water around it
      }
      const damp = Math.pow((it.free ? 0.93 : 0.82) * (calm < 1 ? 0.75 + 0.25 * calm : 1), dt);
      it.vx *= damp; it.vy *= damp;
      it.x = Math.max(s / 2, Math.min(W - s / 2, it.x + it.vx * dt));
      it.y = Math.max(s / 2, Math.min(H - s / 2, it.y + it.vy * dt));
      energy += Math.abs(it.vx) + Math.abs(it.vy);
    }
    m.vx *= Math.pow(0.85, dt); m.vy *= Math.pow(0.85, dt);
    for (const it of this.items.values()) {
      const rot = it.free ? Math.sin(T * it.w + it.ph) * 5 : 0;
      const want = this.drag && this.drag.items.includes(it) ? 1.3 : it === held ? 1.14 : 1;  // under the pointer grows, held grows more
      it.k = (it.k || 1) + (want - (it.k || 1)) * 0.3;
      if (Math.abs(want - it.k) > 0.002) energy += 1;
      it.el.style.transform = `translate3d(${(it.x - s / 2).toFixed(1)}px, ${(it.y - s / 2).toFixed(1)}px, 0) rotate(${rot.toFixed(1)}deg) scale(${it.k.toFixed(3)})`;
      it.el.style.zIndex = it.k > 1.01 ? (want > 1.2 ? 12 : 9) : "";
    }
    if (!reduceMotion || energy > 0.5 * this.items.size) this.kick();  // still settling (or always drifting)
  }
}

// The tag sea: fuzzy Venn diagrams that grow out of the photos themselves. Every photo is a boid: it keeps a little
// apart from its neighbours and never piles onto them. Every tag pulls its photos together, and its circle is drawn
// around all of them, tightening as they gather (gravity between like photos); a photo keeps out of circles it
// doesn't belong to. Groups hold their members in a lasso bubble (yours solid, the suggested ones dashed). Dropping a
// photo somewhere gives it the tags of the circles there and takes away the ones it left.
const hullOf = (pts) => {  // convex hull (monotone chain)
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
};
const hueOf = (key) => [...String(key)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);

class VennSea extends PhotoSea {
  constructor(el, opts = {}) {
    super(el, opts);
    this.onCircle = opts.onCircle; this.onLasso = opts.onLasso;
    this.circles = new Map(); this.keys = []; this.lassos = new Map();
    el.classList.add("venn-sea");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "vn-canvas";
    el.prepend(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.hint = document.createElement("div");
    this.hint.className = "vn-hint";
    this.hint.hidden = true;
    el.append(this.hint);
    this.water.hidden = true;
  }
  // circles: [{id: tag key, label, emoji, html}]; items: [{id, photo, tags, group, sugg, n, title, badge}];
  // lassos: [{id, kind: "group" | "sugg", html, bin}] (a group's label takes drops like its bin in the side list)
  setVenn(circles, items, lassos = []) {
    const keep = new Set(circles.map((c) => c.id));
    for (const [id, c] of this.circles) if (!keep.has(id)) { c.tag.remove(); this.circles.delete(id); }
    for (const c of circles) {
      let v = this.circles.get(c.id);
      if (!v) {
        v = { id: c.id, cx: this.el.clientWidth / 2, cy: this.el.clientHeight / 2, r: 0, hue: hueOf(c.id) };
        v.tag = document.createElement("button");
        v.tag.className = "ps-tag vn-tag";
        v.tag.onclick = (e) => { e.stopPropagation(); if (this.onCircle) this.onCircle(c.id, v.tag); };
        v.tag.onpointerenter = () => (v.still = true);  // a label you're reaching for holds still
        v.tag.onpointerleave = () => (v.still = false);
        this.el.append(v.tag);
        this.circles.set(c.id, v);
      }
      if (v.tag.innerHTML !== c.html) { v.tag.innerHTML = c.html; v.w = 0; }  // (re-measure its width)
      v.label = `${c.emoji || ""} ${c.label}`.trim();
    }
    this.keys = circles.map((c) => c.id);
    const lk = new Set(lassos.map((l) => l.id));
    for (const [id, l] of this.lassos) if (!lk.has(id)) { l.tag.remove(); this.lassos.delete(id); }
    for (const l of lassos) {
      let v = this.lassos.get(l.id);
      if (!v) {
        v = { id: l.id, hue: hueOf(l.id), x: this.el.clientWidth / 2, y: 0 };
        v.tag = document.createElement(l.kind === "sugg" ? "button" : "div");
        v.tag.className = `vn-lasso-tag is-${l.kind}`;
        v.tag.onclick = (e) => { e.stopPropagation(); if (this.onLasso) this.onLasso(l.id, v.tag); };
        v.tag.onpointerenter = () => (v.still = true);
        v.tag.onpointerleave = () => (v.still = false);
        this.el.append(v.tag);
        this.lassos.set(l.id, v);
      }
      v.kind = l.kind;
      if (v.tag.innerHTML !== l.html) { v.tag.innerHTML = l.html; v.w = 0; }
      if (l.bin != null) v.tag.dataset.bin = l.bin; else delete v.tag.dataset.bin;
    }
    this.syncItems(items);
    this.layout();
    this.stir(240);
  }
  spawn(x) {  // near its tags' photos if there are any yet, else mid-sea
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const kin = [...this.items.values()].filter((o) => (x.group != null && o.group === x.group) || (x.sugg != null && o.sugg === x.sugg));
    const near = (kin.length ? kin : [...this.items.values()].filter((o) => (x.tags || []).some((t) => (o.tags || []).includes(t)))).slice(0, 12);
    const cx = near.length ? near.reduce((a, o) => a + o.x, 0) / near.length : W / 2, cy = near.length ? near.reduce((a, o) => a + o.y, 0) / near.length : H / 2;
    return [cx + (Math.random() - 0.5) * 80, cy + (Math.random() - 0.5) * 80];
  }
  adopt(it, x) { it.tags = x.tags || []; it.group = x.group ?? null; it.sugg = x.sugg ?? null; it.free = false; }
  layout() {  // the tile size from how many photos share the field (it holds while little changes)
    if (!this.alive) return;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const blocked = (this.obstacles || []).filter((o) => !o.brief).reduce((a, o) => a + Math.max(0, o.x1 - o.x0) * Math.max(0, o.y1 - o.y0), 0);
    const free = Math.max(W * H * 0.08, W * H - blocked);  // the photos live in the space the screen leaves open
    let s = Math.max(this.obstacles && this.obstacles.length ? 12 : 26, Math.min(86, Math.sqrt((free * 0.2) / Math.max(1, this.items.size))));
    if (this.s && Math.abs(this.s - s) < 4) s = this.s;
    this.s = Math.round(s);
    this.el.style.setProperty("--ps", `${this.s}px`);
    this.homes(W, H);
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`; this.canvas.style.height = `${H}px`;
    }
    this.kick();
  }
  // Each group (and suggestion) gets a home on the field, a cell of a grid shaped like it, so the bubbles spread out
  // and use the whole screen. A group made from a suggestion takes over its home; a new one takes the free cell
  // nearest its photos; nothing jumps.
  homes(W, H) {
    const keyOf = (it) => (it.group != null ? `g${it.group}` : it.sugg != null ? `s${it.sugg}` : null);
    const now = new Map();
    for (const it of this.items.values()) {
      const k = keyOf(it);
      if (!k) continue;
      const c = now.get(k) || now.set(k, { n: 0, x: 0, y: 0, ids: new Set() }).get(k);
      c.n++; c.x += it.x; c.y += it.y; c.ids.add(it.id);
    }
    for (const c of now.values()) { c.x /= c.n; c.y /= c.n; }
    const K = now.size, obs = this.obstacles || [], m = (this.s || 40) * 0.8;
    const open = (x, y) => !obs.some((o) => x > o.x0 - m && x < o.x1 + m && y > o.y0 - m && y < o.y1 + m);
    let cols = Math.max(1, Math.round(Math.sqrt((K * W) / H))), rows = Math.max(1, Math.ceil(K / cols)), cells = [];
    for (let grow = 0; grow < 12; grow++) {  // homes only in the open, never under the screen's own things
      cells = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = ((c + 0.5 + (r % 2 ? 0.18 : -0.18) * (cols > 1)) * W) / cols, y = ((r + 0.5) * H) / rows;
        if (open(x, y)) cells.push({ x, y });
      }
      if (cells.length >= K) break;
      cols++; rows++;
    }
    let free = [];  // the middle of the open water, where loose photos drift
    for (let x = W * 0.05; x < W; x += W / 24) for (let y = H * 0.05; y < H; y += H / 16) if (open(x, y)) free.push([x, y]);
    if (!free.length) free = [[W / 2, H / 2]];
    this.mid = [free.reduce((a, q) => a + q[0], 0) / free.length, free.reduce((a, q) => a + q[1], 0) / free.length];
    const old = this.anchors || new Map(), was = this.anchorIds || new Map(), same = this.grid === `${cols}x${rows}x${W}x${H}x${cells.length}`;
    const next = new Map(), taken = new Set();
    const nearestFree = (x, y) => { let best = -1; cells.forEach((p, i) => { if (!taken.has(i) && (best < 0 || Math.hypot(p.x - x, p.y - y) < Math.hypot(cells[best].x - x, cells[best].y - y))) best = i; }); return best; };
    const order = [...now.entries()].sort((a, b) => b[1].n - a[1].n);
    for (const [k, c] of order) {  // a home it had, or the one of the old group it mostly came from
      let from = old.has(k) ? k : null;
      if (!from) {
        let bestOverlap = 0;
        for (const [ok, ids] of was) if (!now.has(ok)) { let o = 0; for (const id of c.ids) if (ids.has(id)) o++; if (o > bestOverlap) { bestOverlap = o; from = ok; } }
      }
      const at = from ? old.get(from) : { x: c.x, y: c.y };
      const i = nearestFree(at.x, at.y);
      if (i < 0) continue;
      taken.add(i);
      next.set(k, same && from && old.get(from).cell === i ? old.get(from) : { ...cells[i], cell: i });
    }
    this.anchors = next;
    this.anchorIds = new Map([...now].map(([k, c]) => [k, c.ids]));
    this.grid = `${cols}x${rows}x${W}x${H}x${cells.length}`;
  }
  tick(now) {
    this.raf = 0;
    if (!this.alive || !this.el.isConnected) { this.destroy(); return; }
    const dt = Math.min(2.5, this.last ? (now - this.last) / 16.67 : 1);
    this.last = now;
    const s = this.s, W = this.el.clientWidth, H = this.el.clientHeight, m = this.mouse, vis = new Set(this.keys);
    // where each tag's, group's and suggestion's photos are gathered
    const cent = new Map(), gcent = new Map();
    const acc = (map, k, it) => { const c = map.get(k) || map.set(k, { x: 0, y: 0, n: 0 }).get(k); c.x += it.x; c.y += it.y; c.n++; };
    for (const it of this.items.values()) {
      for (const t of it.tags) acc(cent, t, it);
      if (it.group != null) acc(gcent, `g${it.group}`, it);
      else if (it.sugg != null) acc(gcent, `s${it.sugg}`, it);
    }
    for (const c of [...cent.values(), ...gcent.values()]) { c.x /= c.n; c.y /= c.n; }
    // each circle: around all its photos, easing as they gather or spread
    for (const k of this.keys) {
      const c = this.circles.get(k), at = cent.get(k);
      if (!at) { c.r = 0; continue; }
      const ds = [];  // around most of its photos (a straggler can sit just outside: the diagram is fuzzy)
      for (const it of this.items.values()) if (it.tags.includes(k)) ds.push(Math.hypot(it.x - at.x, it.y - at.y));
      ds.sort((p, q) => p - q);
      const r = (ds[Math.floor((ds.length - 1) * 0.85)] || 0) + s * 0.7;
      c.cx += (at.x - c.cx) * 0.25; c.cy += (at.y - c.cy) * 0.25; c.r += (r - c.r) * 0.2;
    }
    const grid = new Map(), cell = s;
    for (const it of this.items.values()) {
      const key = `${Math.floor(it.x / cell)},${Math.floor(it.y / cell)}`;
      (grid.get(key) || grid.set(key, []).get(key)).push(it);
    }
    let held = null;
    if (!this.drag) for (const it of this.items.values()) if (Math.abs(it.x - m.x) < s * 0.55 && Math.abs(it.y - m.y) < s * 0.55) { held = it; break; }
    // each group's (and suggestion's) reach: most of its photos, so other groups keep clear and the bubbles stay apart
    const reach = new Map();
    for (const [k, c] of gcent) reach.set(k, []);
    for (const it of this.items.values()) {
      const k = it.group != null ? `g${it.group}` : it.sugg != null ? `s${it.sugg}` : null;
      if (k && gcent.has(k)) reach.get(k).push(Math.hypot(it.x - gcent.get(k).x, it.y - gcent.get(k).y));
    }
    for (const [k, ds] of reach) { ds.sort((p, q) => p - q); gcent.get(k).r = (ds[Math.floor(ds.length * 0.8)] || 0) + s * 0.7; }
    let energy = 0;
    for (const it of this.items.values()) {
      if (this.drag && this.drag.moving && this.drag.items.includes(it)) continue;
      if (it === held) { it.vx *= 0.5; it.vy *= 0.5; it.x += it.vx * dt; it.y += it.vy * dt; continue; }
      const own = it.group != null ? `g${it.group}` : it.sugg != null ? `s${it.sugg}` : null;
      const home = own && this.anchors && this.anchors.get(own);
      // its group's home draws it (a loose photo just stays in view), and its group holds it together
      const mid = this.mid || [W / 2, H / 2];
      let ax = home ? (home.x - it.x) * 0.0016 : (mid[0] - it.x) * 0.0003, ay = home ? (home.y - it.y) * 0.0016 : (mid[1] - it.y) * 0.0003;
      const g = own && gcent.get(own);
      const blockedAt = (x, y) => (this.obstacles || []).some((o) => !o.brief && x > o.x0 && x < o.x1 && y > o.y0 && y < o.y1);
      if (g && g.n > 1 && !blockedAt(g.x, g.y)) { const w = it.group != null ? 0.007 : 0.0045; ax += (g.x - it.x) * w; ay += (g.y - it.y) * w; }
      for (const [k, c] of gcent) {  // other groups' bubbles push it out
        if (k === own || c.n < 1) continue;
        const dx = it.x - c.x, dy = it.y - c.y, d = Math.hypot(dx, dy) || 0.01, reachK = c.r + s * 0.5;
        if (d < reachK) { const f = ((reachK - d) / reachK) * 0.7; ax += (dx / d) * f; ay += (dy / d) * f; }
      }
      const norm = 1 / Math.sqrt(Math.max(1, it.tags.length));
      for (const t of it.tags) {  // a gentler pull toward its tags' photos (the shown tags pull hardest)
        const c = cent.get(t);
        if (!c || c.n < 2) continue;
        const w = (vis.has(t) ? 0.0009 : 0.00015) * norm;
        ax += (c.x - it.x) * w; ay += (c.y - it.y) * w;
      }
      for (const o of this.obstacles || []) {  // around the screen's own things, never under them
        const m2 = s * 0.6;
        if (it.x > o.x0 - m2 && it.x < o.x1 + m2 && it.y > o.y0 - m2 && it.y < o.y1 + m2) {
          const out = [[it.x - (o.x0 - m2), -1, 0], [o.x1 + m2 - it.x, 1, 0], [it.y - (o.y0 - m2), 0, -1], [o.y1 + m2 - it.y, 0, 1]]
            .sort((p, q) => p[0] - q[0])[0];
          const f = Math.min(1.4, 0.15 + out[0] * 0.07);  // a spring, not a kick: it settles instead of bouncing
          ax += out[1] * f; ay += out[2] * f;
          it.vx *= 0.8; it.vy *= 0.8;
        }
      }
      for (const k of this.keys) {  // and a nudge out of circles it doesn't belong to
        if (it.tags.includes(k)) continue;
        const c = this.circles.get(k), dx = it.x - c.cx, dy = it.y - c.cy, d = Math.hypot(dx, dy) || 0.01;
        if (d < c.r) { const f = ((c.r - d) / c.r) * 0.12; ax += (dx / d) * f; ay += (dy / d) * f; }
      }
      const gx = Math.floor(it.x / cell), gy = Math.floor(it.y / cell);  // boids: a little apart, never on top
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
        for (const o of grid.get(`${x},${y}`) || []) {
          if (o === it) continue;
          const dx = it.x - o.x, dy = it.y - o.y, d = Math.hypot(dx, dy) || 0.01, need = s * 1.14;
          if (d < need) { const f = ((need - d) / need) * 0.9; ax += (dx / d) * f; ay += (dy / d) * f; }
        }
      }
      for (const o of this.obstacles || []) {  // resting against a panel: whatever pulls it inward is cancelled
        if (o.brief) continue;
        const mg = s * 0.55 + 4;
        if (it.x > o.x0 - mg && it.x < o.x1 + mg && it.y > o.y0 - mg && it.y < o.y1 + mg) {
          const d = [it.x - (o.x0 - mg), o.x1 + mg - it.x, it.y - (o.y0 - mg), o.y1 + mg - it.y], k = d.indexOf(Math.min(...d));
          if ((k === 0 && ax > 0) || (k === 1 && ax < 0)) { ax = 0; it.vx = 0; }
          if ((k === 2 && ay > 0) || (k === 3 && ay < 0)) { ay = 0; it.vy = 0; }
        }
      }
      const dm = Math.hypot(it.x - m.x, it.y - m.y);
      const calm = !this.drag && dm < s * 2.2 ? 0.7 : 1;  // a hand nearby stills the water
      it.vx = (it.vx + ax * dt) * Math.pow(0.86 * calm, dt);
      it.vy = (it.vy + ay * dt) * Math.pow(0.86 * calm, dt);
      if (Math.abs(it.vx) + Math.abs(it.vy) < 0.07) it.vx = it.vy = 0;  // barely moving: at rest
      it.x = Math.max(s / 2, Math.min(W - s / 2, it.x + it.vx * dt));
      it.y = Math.max(s / 2, Math.min(H - s / 2, it.y + it.vy * dt));
      for (const o of this.obstacles || []) {  // a hard rule, not just a push: never under the screen's own things
        if (o.brief) continue;
        const mg = s * 0.55;
        if (it.x > o.x0 - mg && it.x < o.x1 + mg && it.y > o.y0 - mg && it.y < o.y1 + mg) {
          const exits = [[it.x - (o.x0 - mg), o.x0 - mg, null], [o.x1 + mg - it.x, o.x1 + mg, null], [it.y - (o.y0 - mg), null, o.y0 - mg], [o.y1 + mg - it.y, null, o.y1 + mg]]
            .filter((e) => (e[1] == null || (e[1] >= s / 2 && e[1] <= W - s / 2)) && (e[2] == null || (e[2] >= s / 2 && e[2] <= H - s / 2)))
            .sort((p, q) => p[0] - q[0]);
          const e = exits[0];
          if (e) {
            if (e[1] != null) { it.x += (e[1] - it.x) * 0.35; it.vx = 0; } else { it.y += (e[2] - it.y) * 0.35; it.vy = 0; }  // eased out, quickly
          }
        }
      }
      energy += Math.abs(it.vx) + Math.abs(it.vy);
    }
    m.vx *= Math.pow(0.85, dt); m.vy *= Math.pow(0.85, dt);
    for (const it of this.items.values()) {  // the photo under the pointer grows a little; one you're holding, a little more
      const want = this.drag && this.drag.moving && this.drag.items.includes(it) ? 1.32 : it === held || (this.drag && this.drag.items[0] === it) ? 1.15 : 1;
      it.k = (it.k || 1) + (want - (it.k || 1)) * 0.3;
      if (Math.abs(want - it.k) > 0.002) energy += 1;
      it.el.style.transform = `translate3d(${(it.x - s / 2).toFixed(1)}px, ${(it.y - s / 2).toFixed(1)}px, 0) scale(${it.k.toFixed(3)})`;
      it.el.style.zIndex = it.k > 1.01 ? (want > 1.2 ? 12 : 9) : "";
    }
    this.draw(W, H, s);
    // keep going while anything moves (or for a little after a change); once it's all at rest, stop (no busy loop)
    this.restless = Math.max(0, (this.restless || 0) - 1);
    if (energy > 0.02 || this.drag || this.restless > 0) this.kick();
  }
  kick() { if (!this.raf && this.alive) { this.raf = requestAnimationFrame((t) => this.tick(t)); } }
  stir(frames = 90) { this.restless = Math.max(this.restless || 0, frames); this.kick(); }
  // A label's spot, moved out from under the screen's panels and away from labels already placed this frame.
  clearSpot(lx, ly, w, h, taken) {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const inside = (e) => e[1] >= w / 2 + 2 && e[1] <= W - w / 2 - 2 && e[2] >= h / 2 + 2 && e[2] <= H - h / 2 - 2;  // (and on screen)
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const o of [...(this.obstacles || []).filter((q) => !q.brief), ...taken]) {
        if (lx + w / 2 > o.x0 && lx - w / 2 < o.x1 && ly + h / 2 > o.y0 && ly - h / 2 < o.y1) {
          const exits = [[ly + h / 2 - o.y0, lx, o.y0 - h / 2 - 2], [o.y1 - (ly - h / 2), lx, o.y1 + h / 2 + 2],
            [lx + w / 2 - o.x0, o.x0 - w / 2 - 2, ly], [o.x1 - (lx - w / 2), o.x1 + w / 2 + 2, ly]].filter(inside).sort((p, q) => p[0] - q[0]);
          if (!exits.length) continue;
          [, lx, ly] = exits[0];
          moved = true;
        }
      }
      if (!moved) break;
    }
    taken.push({ x0: lx - w / 2, y0: ly - h / 2, x1: lx + w / 2, y1: ly + h / 2 });
    return [lx, ly];
  }
  draw(W, H, s) {
    const x = this.ctx, dpr = window.devicePixelRatio || 1, taken = [];
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    // lassos: a bubble around each group's photos
    const members = new Map();
    for (const it of this.items.values()) {
      const k = it.group != null ? `g${it.group}` : it.sugg != null ? `s${it.sugg}` : null;
      if (k) (members.get(k) || members.set(k, []).get(k)).push([it.x, it.y]);
    }
    for (const [id, l] of this.lassos) {
      const pts = members.get(id);
      if (!pts || !pts.length || this.lassos_on === false) { l.tag.hidden = true; continue; }
      const core = hullOf(pts), ring = [];
      for (const [px, py] of core) for (let a = 0; a < 10; a++) ring.push([px + Math.cos(a * 0.628) * s * 0.78, py + Math.sin(a * 0.628) * s * 0.78]);
      const h = hullOf(ring);
      x.beginPath();
      h.forEach((p, i) => {  // through the midpoints, curving at the corners: a soft bubble
        const q = h[(i + 1) % h.length], mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        if (!i) x.moveTo(mx, my); else x.quadraticCurveTo(p[0], p[1], mx, my);
      });
      x.quadraticCurveTo(h[0][0], h[0][1], (h[0][0] + h[1 % h.length][0]) / 2, (h[0][1] + h[1 % h.length][1]) / 2);
      x.closePath();
      const sugg = l.kind === "sugg";
      x.fillStyle = `hsla(${l.hue}, 80%, 60%, ${sugg ? 0.05 : 0.11})`;
      x.fill();
      x.lineWidth = sugg ? 1.5 : 2.5;
      x.setLineDash(sugg ? [7, 7] : []);
      x.strokeStyle = `hsla(${l.hue}, 85%, ${sugg ? 75 : 65}%, ${sugg ? 0.55 : 0.85})`;
      x.stroke();
      const top = h.reduce((a, p) => (p[1] < a[1] ? p : a), h[0]);  // a label moves only when its bubble has really moved
      if (!l.still && (l.y === 0 || Math.hypot(top[0] - l.x, top[1] - l.y) > 16)) { l.x = Math.round(top[0]); l.y = Math.round(top[1]); }
      l.tag.hidden = false;
      const lw = l.w || (l.w = l.tag.offsetWidth || 160), lh = 26;
      const [px, py] = this.clearSpot(Math.max(lw / 2 + 4, Math.min(W - lw / 2 - 4, l.x)), Math.max(lh, l.y - 2) - lh / 2, lw, lh, taken);
      l.tag.style.transform = `translate(-50%, -50%) translate(${Math.round(px)}px, ${Math.round(py)}px)`;
    }
    // tag circles: fuzzy, tinted, their labels on the outer edge
    x.setLineDash([5, 6]);
    for (const k of this.keys) {
      const c = this.circles.get(k);
      if (!c.r) { c.tag.hidden = true; continue; }
      const grd = x.createRadialGradient(c.cx, c.cy, c.r * 0.2, c.cx, c.cy, c.r);
      grd.addColorStop(0, `hsla(${c.hue}, 85%, 62%, 0.10)`);
      grd.addColorStop(1, `hsla(${c.hue}, 85%, 62%, ${c.hot ? 0.16 : 0.04})`);
      x.beginPath();
      x.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
      x.fillStyle = grd;
      x.fill();
      x.lineWidth = c.hot ? 3 : 1.3;
      x.strokeStyle = `hsla(${c.hue}, 85%, 66%, ${c.hot ? 0.95 : 0.55})`;
      x.stroke();
      const ang = Math.atan2(c.cy - H / 2, c.cx - W / 2 || 0.01), lx = c.cx + Math.cos(ang) * (c.r + 4), ly = c.cy + Math.sin(ang) * (c.r + 4);
      if (!c.still && (c.lx == null || Math.hypot(lx - c.lx, ly - c.ly) > 16)) { c.lx = Math.round(lx); c.ly = Math.round(ly); }
      c.tag.hidden = false;
      const cw = c.w || (c.w = c.tag.offsetWidth || 140), ch = 26;
      const [px, py] = this.clearSpot(Math.max(cw / 2 + 4, Math.min(W - cw / 2 - 4, c.lx)), Math.max(ch / 2, Math.min(H - ch / 2, c.ly)), cw, ch, taken);
      c.tag.style.transform = `translate(-50%, -50%) translate(${Math.round(px)}px, ${Math.round(py)}px)`;
    }
    x.setLineDash([]);
  }
  binAt(e) {  // a group's label in the sea, or its bin in the side list
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && !el.closest(".ps-item") ? el.closest("[data-bin]") : null;
  }
  // A drop lands among the circles around it: those tags on, the other shown ones off.
  target(x, y, self) {
    for (const it of this.items.values()) {
      if (it === self || (this.drag && this.drag.items.includes(it))) continue;
      if (Math.abs(it.x - x) < this.s * 0.42 && Math.abs(it.y - y) < this.s * 0.42) return { kind: "photo", id: it.id, item: it };
    }
    const on = this.keys.filter((k) => { const c = this.circles.get(k); return c && c.r && Math.hypot(c.cx - x, c.cy - y) < c.r * 0.8; });
    return { kind: "tags", on, off: this.keys.filter((k) => !on.includes(k)) };
  }
  mark(t) {
    for (const c of this.circles.values()) c.hot = !!(t && t.kind === "tags" && t.on.includes(c.id));
    const key = t ? `${t.kind}:${t.kind === "photo" ? t.id : ""}` : null;
    if (key !== this.hover) {
      this.hover = key;
      this.el.querySelectorAll(".ps-item.ps-hot").forEach((e) => e.classList.remove("ps-hot"));
      if (t && t.kind === "photo") t.item.el.classList.add("ps-hot");
    }
    const it = this.drag && this.drag.items[0];
    if (!t || !it) { this.hint.hidden = true; return; }
    let html;
    if (t.kind === "photo") html = "⧉ Stack them: same shot";
    else {
      const was = new Set(it.tags.filter((k) => this.keys.includes(k)));
      const plus = t.on.filter((k) => !was.has(k)), minus = [...was].filter((k) => !t.on.includes(k));
      const lab = (k) => esc(this.circles.get(k)?.label || k);
      html = plus.length || minus.length ? [...plus.map((k) => `<b class="plus">＋ ${lab(k)}</b>`), ...minus.map((k) => `<b class="minus">− ${lab(k)}</b>`)].join(" ")
        : "<span>no change</span>";
    }
    this.hint.innerHTML = html;
    this.hint.hidden = false;
    this.hint.style.transform = `translate(${Math.min(this.mouse.x + 18, this.el.clientWidth - 220)}px, ${Math.max(4, this.mouse.y - 40)}px)`;
  }
}

// ---------------------------------------------------------------- stacks: the same shot, one stack
// The Stacks page: every stack, editable (open one to keep a different take, split a take out, or split it all), and
// the Twin check minigame for the pairs that look like the same shot but weren't stacked. Drag one stack onto another
// to merge them.
function viewStacks(main, params) {
  return params.get("check") ? twinCheck(main) : stacksPage(main);
}

async function stacksPage(main) {
  const view = S.view;
  let shots = [], boxes = {}, twins = 0, undo = null, pairs = [];
  const byRep = new Map();
  async function load(keep) {
    const y = ($(".screen-body", main) || {}).scrollTop || 0;
    try {
      const [sug, first] = await Promise.all([api("/api/groups?view=suggest"), api("/api/groups?view=stacks&order=time&per=500&page=0")]);
      twins = sug.suggestions.length;
      pairs = sug.suggestions;
      shots = first.shots; boxes = first.boxes; undo = first.undo;
      for (let p = 1; p < first.pages && shots.length < GROUPS_CAP; p++) {
        const d = await api(`/api/groups?view=stacks&order=time&per=500&page=${p}`);
        shots = shots.concat(d.shots); Object.assign(boxes, d.boxes);
      }
    } catch (e) { if (!left(view)) main.innerHTML = FAILED(e.message); return; }
    if (left(view)) return;
    byRep.clear();
    shots.forEach((x) => byRep.set(x.rep, x));
    render();
    if (keep) $(".screen-body", main).scrollTop = y;
  }
  function render() {
    main.innerHTML = `
      <div class="screen sorter stacker">
        <div class="screen-head">
          <h1>🧩 Stacks</h1>
          <span class="stat-chip"><b>${fmt(shots.length)}</b> ${shots.length === 1 ? "stack" : "stacks"}</span>
          <span class="stat-chip">${twins ? `🧐 <b>${fmt(twins)}</b> possible ${twins === 1 ? "twin" : "twins"} to check` : "✅ all checked"}</span>
          <span class="grow"></span>
          ${helpBtn(`The same picture (a crop, a copy) or a burst of nearly the same shot belongs in <b>one stack</b>, so it competes
            as one shot showing its best take. The obvious ones are stacked already.<br><br><b>Twin check</b> shows the pairs that look
            like the same shot but weren't stacked. Here, <b>⧉</b> opens a stack (keep a different take, split one out, split it
            all), and dragging one stack onto another merges them. <b>Z</b> undoes.`)}
        </div>
        <div class="screen-body">
          ${shots.length ? `<div class="lookgrid gsec-tiles">${shotTiles(shots, null)}</div>` : `<div class="empty">No stacks: every shot stands alone.</div>`}
        </div>
        <aside class="screen-rail">
          <div class="rail-card grow"><h3>🧐 Possible twins</h3>
            ${pairs.length ? `<div class="twin-list">${pairs.map((x) => `<a class="twin-row" href="#stacks?check=1" title="${Math.round(x.similarity * 100)}% alike">
              <img src="${T(x.a)}" alt=""><span>≈</span><img src="${T(x.b)}" alt=""><span class="muted small">${Math.round(x.similarity * 100)}%</span></a>`).join("")}</div>`
              : `<p class="muted small">None left to check.</p>`}</div>
        </aside>
        <div class="screen-bar action-bar">
          <div class="bar-left"><span class="muted small">⧉ opens a stack · drag a stack onto another to merge</span></div>
          <div class="bar-mid"><button class="btn ghost" id="g-undo" ${undo ? "" : "hidden"} title="Take back your last change (Z)"><kbd>Z</kbd> ${undo ? `Undo ${DRAW_WORD[undo] || undo}` : "Undo"}</button></div>
          <div class="bar-right">${twins ? `<a class="btn primary big" href="#stacks?check=1">🎮 Twin check <span class="btn-sub">${fmt(twins)} to check</span> <kbd>Enter</kbd></a>`
            : `<a class="btn primary big" href="#draw">Next: group them → <kbd>Enter</kbd></a>`}</div>
        </div>
      </div>`;
    $("#g-undo").onclick = () => drawUndo(() => load(true));
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
      if (t.dataset.view) return openViewer(Number(t.dataset.view));
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
  }
  async function act(path, payload, msg) {
    try { await api(path, payload); toast(`${msg} Z undoes it.`); Sound.play("pick"); } catch (e) { toast(e.message); return; }
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
  let queue = [], done = 0, busy = false, shownAt = 0;
  async function load() {
    try { queue = (await api("/api/groups?view=suggest")).suggestions; } catch (e) {
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
    if (!x) {
      main.innerHTML = `
        <div class="screen no-rail twins">
          <div class="screen-head"><h1>🎮 Twin check</h1><span class="stat-chip good"><b>0</b> pairs left</span>
            ${done ? `<span class="stat-chip"><b>${fmt(done)}</b> checked</span>` : ""}</div>
          <div class="screen-body fill"><div class="empty"><div class="big-emoji">🧩</div><h2>All checked!</h2>
            <p class="muted">Every likely twin is stacked or set apart. Next, every stack and shot goes into a themed group.</p></div></div>
          <div class="screen-bar action-bar"><div class="bar-left"><a class="btn big" href="#stacks">The Stacks page</a></div>
            <div class="bar-mid">${done ? `<button class="btn ghost" data-c="undo"><kbd>Z</kbd> Undo the last call</button>` : ""}</div>
            <div class="bar-right"><a class="btn primary big" href="#draw">Next: group them → <kbd>Enter</kbd></a></div></div>
        </div>`;
      $$("[data-c]", main).forEach((b) => (b.onclick = () => undo()));
      if (done) { Sound.play("crown"); confetti(window.innerWidth / 2, window.innerHeight / 3, 50); }
      refreshHud(true);
      return;
    }
    const apart = x.seconds_apart == null ? "no dates" : x.seconds_apart < 90 ? `${x.seconds_apart} s apart`
      : x.seconds_apart < 7200 ? `${Math.round(x.seconds_apart / 60)} min apart` : `${Math.round(x.seconds_apart / 3600)} h apart`;
    main.innerHTML = `
      <div class="screen no-rail twins">
        <div class="screen-head">
          <h1>🎮 Twin check</h1>
          <span class="stat-chip"><b>${fmt(queue.length)}</b> ${queue.length === 1 ? "pair" : "pairs"} left</span>
          <span class="stat-chip">${Math.round(x.similarity * 100)}% alike · ${apart}</span>
          <span class="grow"></span>
          <a class="btn" href="#stacks" title="Back to the Stacks page (Esc)"><kbd>Esc</kbd> Done</a>
          ${helpBtn(`Two shots that look like <b>the same shot</b> (a crop, a copy, or a burst) but weren't stacked. <b>→</b> stacks them: they
            compete as one shot showing its best take. <b>←</b> keeps them apart for good. Nothing is deleted. <b>Z</b> undoes, <b>Esc</b> leaves.`)}
        </div>
        <div class="screen-body fill"><div class="twin-arena">
          <div class="side" data-photo="${x.a}" data-box='${JSON.stringify(x.box_a || null)}'><img src="${P(x.a)}" alt="First shot" draggable="false"></div>
          <div class="side" data-photo="${x.b}" data-box='${JSON.stringify(x.box_b || null)}'><img src="${P(x.b)}" alt="Second shot" draggable="false"></div>
        </div></div>
        <div class="screen-bar action-bar"><div class="bar-left"><button class="btn big toss-btn" data-c="no"><kbd>←</kbd> Different shots</button></div>
          <div class="bar-mid"><button class="btn ghost" data-c="undo"><kbd>Z</kbd> Undo</button></div>
          <div class="bar-right"><button class="btn big keep-btn" data-c="yes">Same shot: stack them <kbd>→</kbd></button></div></div>
      </div>`;
    $$("[data-c]", main).forEach((b) => (b.onclick = () => (b.dataset.c === "undo" ? undo() : call(b.dataset.c === "yes"))));
    paintFilters();
    shownAt = performance.now();
  }
  async function call(same) {
    const x = queue[0];
    if (busy || !x) return;
    busy = true;
    Sound.play(same ? "great" : "toss");
    const arena = $(".twin-arena");
    if (arena) arena.classList.add(same ? "merge" : "apart");
    try {
      if (same) await api("/api/groups/merge", { photos: [x.a, x.b] });
      else await api("/api/groups/dismiss", { a: x.a, b: x.b });
      floatText("+2 XP", arena);
    } catch (e) { toast(e.message); busy = false; return load(); }
    await sleep(reduceMotion ? 0 : 220);
    done++;
    busy = false;
    if (same) return load();  // stacking changes which pairs are left
    queue.shift();
    paint();
  }
  function undo() { if (!busy) drawUndo(load); }
  S.onKey = (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); location.hash = "#stacks"; }
    else if (!queue[0] && k === "Enter") { e.preventDefault(); location.hash = "#draw"; }
    else if (k === "ArrowRight" || k === "Enter" || k === "d" || k === "D") { e.preventDefault(); call(true); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); call(false); }
    else if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); undo(); }
    else if (k === "f" || k === "F") { e.preventDefault(); toggleFilter(); }
  };
  main.innerHTML = LOADING();
  await load();
}

// ---------------------------------------------------------------- the Draw: themed groups
// Every shot goes into a themed group: pick a starter (it comes with a name), then call the likely matches it deals
// (in, out, or "same shot": stacked). Groups play the group stage; their winners the knockouts. Z undoes anything.
const DRAW_WORD = { "new group": "new group", add: "add", "not this one": "skip", twin: "twin stack", "bulk add": "batch",
  rename: "rename", emoji: "emoji change", toss: "toss", tags: "tag change", reorder: "reorder", "auto-draw": "auto-group", place: "placement", "to the wildcards": "wildcard",
  move: "move", unsort: "move", "merge groups": "group merge", dissolve: "dissolve", merge: "stack merge", split: "split",
  unstack: "split-apart", reset: "reset", keep: "take pick", "not twins": "not-twins call", "best guesses": "best guesses" };
const GROUPS_CAP = Math.max(3000, (navigator.deviceMemory || 4) * 2500);  // images on a board before it pauses

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
  pop.style.top = `${r.bottom + 8 + window.scrollY}px`;
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
const helpBtn = (html) => `<button class="help-btn" data-help="${esc(html)}" aria-label="How this works" aria-expanded="false">?</button>`;
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-help]");
  const open = $(".help-pop");
  if (open && (!b || open.dataset.for === b.dataset.help)) {
    open.remove();
    $$("[data-help][aria-expanded=true]").forEach((x) => x.setAttribute("aria-expanded", "false"));
    if (!b) return;
    if (open.dataset.for === b.dataset.help) return;
  }
  if (!b) return;
  const pop = document.createElement("div");
  pop.className = "help-pop";
  pop.dataset.for = b.dataset.help;
  pop.innerHTML = b.dataset.help;
  document.body.append(pop);
  const r = b.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${r.bottom + 8 + window.scrollY}px`;
  b.setAttribute("aria-expanded", "true");
});

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
  try {
    const r = await api("/api/draw/undo", {});
    Sound.play("undo");
    toast(`Undid the ${DRAW_WORD[r.undone] || r.undone}.${r.next ? " Z again for the one before." : ""}`);
    if (after) await after(r);
  } catch (e) { toast(e.message); }
  drawUndoing = false;
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
  const end = () => {
    if (x0 == null) return;
    x0 = null;
    el.classList.remove("held", "over-bin");
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
function binsHtml(bins, current, fits) {
  return bins.map((g, i) => `
    <div class="bin ${g.id === current ? "current" : ""} ${fits && fits[0] === g.id ? "fit" : ""}" data-bin="${g.id}" role="button" tabindex="0"
      title="${esc(g.name)}: ${plural(g.size, "shot")}. ${groupKeyLabel(i) ? `Key ${groupKeyLabel(i)}` : "Drag here"}${g.id === current ? " (or →)" : ""}">
      <span class="bin-n">${groupKeyLabel(i)}</span><img src="${T(g.cover)}" alt="" loading="lazy">
      <span class="bin-name"><span class="bin-emoji" data-emoji-bin="${g.id}" role="button" title="Change the emoji">${esc(g.emoji || "🗂️")}</span>
        <span class="bin-label">${g.id === current ? "This group" : esc(g.name)}</span></span><span class="bin-size">${fmt(g.size)}</span>
      <span class="bin-edit" data-rename-bin="${g.id}" role="button" title="Rename" aria-label="Rename ${esc(g.name)}">✏️</span>
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
// Bins are role=button: Enter or Space on a focused one (not on the text box inside) drops the photo there.
document.addEventListener("keydown", (e) => {
  const b = e.target.closest && e.target.closest(".bin[role=button]");
  if (b && e.target === b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); b.click(); }
}, true);

// Rename a group from its bin in a side list: the name turns into a text box; Enter saves, Esc keeps it.
function renameBin(binEl, group, done) {
  const name = binEl.querySelector(".bin-label");
  if (!name || binEl.querySelector(".bin-input")) return;
  const inp = document.createElement("input");
  inp.className = "bin-input";
  inp.maxLength = 60;
  inp.value = group.name;
  inp.setAttribute("aria-label", "Group name");
  name.replaceWith(inp);
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
    done();
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
  if (!/^Digit[0-9]$/.test(e.code) || e.ctrlKey || e.metaKey || (e.shiftKey && !e.altKey)) return null;
  const d = Number(e.code.slice(5)), n = (d === 0 ? 10 : d) + (e.altKey ? (e.shiftKey ? 20 : 10) : 0);
  return n - 1;
}

function viewDraw(main, params) {
  if (params.get("play")) return drawPlay(main, Number(params.get("play")));
  if (params.get("sort")) return drawQuickSort(main);
  return drawSorter(main, params.get("g"));
}

// A shot (or a stack, ⧉ n) as a tile: click selects it, drag it onto another to stack them, ⤢ views it larger.
function shotTile(x, selected) {
  const on = selected && selected.has(x.rep);
  return `
    <div class="tile pick ${on ? "picked" : ""} ${x.members.length > 1 ? "stacked" : ""}" data-sel="${x.rep}" draggable="true" data-drag-shot="${x.rep}"
      data-drop="${x.rep}" tabindex="0" role="button" aria-pressed="${!!on}" title="${x.taken ? esc(x.taken.replace("T", " ")) : "no date"}">
      <img src="${T(x.rep)}" alt="Shot" loading="lazy" draggable="false" style="${facePos(x.box)}">
      ${x.members.length > 1 ? `<span class="kept-crown" title="The take that stands in for this stack">👑</span>
        <button class="badge expand" data-expand="${x.rep}" title="Show all ${x.members.length} takes" aria-expanded="false">⧉ ${x.members.length}</button>` : ""}
      ${x.solo ? `<button class="rank undo-split" data-reset="${x.rep}" title="Hand it back to automatic stacking">split by you · undo</button>` : ""}
      <button class="zoom" data-view="${x.rep}" title="View larger" aria-label="View larger">⤢</button>
    </div>`;
}
function shotTiles(list, selected) {  // consecutive look-alikes (2+) share a dashed box
  const out = [];
  for (const x of list) {
    const last = out[out.length - 1];
    if (x.family != null && last && last.family === x.family) last.items.push(x);
    else out.push({ family: x.family, items: [x] });
  }
  return out.map((k) => (k.items.length > 1 ? `<div class="fam-tiles">${k.items.map((x) => shotTile(x, selected)).join("")}</div>`
    : shotTile(k.items[0], selected))).join("");
}
// A stack opens down its own column: the kept take on top, the other takes beneath (keep one, split one out, split all).
function expandStack(root, x, btn, boxes) {
  const t = btn.closest(".tile");
  const open = t.classList.contains("open");
  $$(".tile.open", root).forEach((o) => { o.classList.remove("open"); o.style.gridRow = ""; $(".tile-frames", o)?.remove(); $("[data-expand]", o)?.setAttribute("aria-expanded", "false"); });
  if (open || !x) return;
  t.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  if (getComputedStyle(t.parentElement).display === "grid") t.style.gridRow = `span ${x.members.length}`;
  t.insertAdjacentHTML("beforeend", `
    <div class="tile-frames">
      <div class="tile-frames-bar"><a class="btn primary crown-btn" href="#duel?stack=${x.rep}" title="Play this stack's mini-tournament">👑 Crown</a>
        <button class="btn" data-unstack="${x.rep}" title="Split the whole stack into separate shots">Split all</button></div>
      ${x.members.filter((m) => m !== x.rep).map((m) => `
        <div class="ftile" draggable="true" data-drag-frame="${m}" title="Drag onto another shot to move this take">
          <img src="${T(m)}" alt="Take" loading="lazy" data-view="${m}" draggable="false" style="${facePos(boxes[m])}">
          <div class="ftile-actions"><button data-keep="${m}">Keep</button><button data-split="${m}">Split out</button></div>
        </div>`).join("")}
    </div>`);
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
  async function load(keep) {
    const y = ($("#sections", main) || {}).scrollTop || 0;
    const q = mode === "sea" ? "per=400&uper=600&tags=1" : `per=24${full.size ? `&full=${[...full].join(",")}` : ""}`;
    try { b = await api(`/api/draw/board?${q}`); } catch (e) {
      if (!left(view)) main.innerHTML = FAILED(e.message);
      return;
    }
    if (left(view)) return;
    if (b.game) { Ach.check(b.game); S.game = b.game; paintSaveChip(); }
    byRep.clear();
    [b.unsorted, ...b.groups].forEach((g) => g.shots.forEach((x) => byRep.set(x.rep, x)));
    for (const r of [...selected]) if (!byRep.has(r)) selected.delete(r);
    if (mode === "sea") return renderSea();
    if (sea) { sea = null; World.setMode("dim"); }  // (the world sea lives on; it just stops being worked here)
    render();
    if (keep) $("#sections", main).scrollTop = y;
    else if (focus) $(`#gsec-${focus}`)?.scrollIntoView({ block: "start" });
  }
  const viewToggle = () => `<span class="seg" role="group" aria-label="View">
    <button class="seg-btn ${mode === "sea" ? "on" : ""}" data-mode="sea" title="Every photo in the circles of its tags">🫧 Tags</button>
    <button class="seg-btn ${mode === "list" ? "on" : ""}" data-mode="list" title="Groups as sections of tiles">▦ List</button></span>`;
  function setMode(m) {
    if (m === mode) return;
    mode = m;
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
        <button class="btn" data-sel-act="unsort"><kbd>U</kbd> Unsorted</button>
        <button class="btn" data-sel-act="stack" title="They're the same shot: one stack"><kbd>S</kbd> Stack them</button>
        <button class="btn" data-sel-act="new"><kbd>N</kbd> New group</button>
        <button class="btn" data-sel-act="tag" title="A tag of your own on these"><kbd>T</kbd> Tag</button>
        <button class="btn ghost" id="g-undo" ${b.undo ? "" : "hidden"} title="Take back your last change (Z)"><kbd>Z</kbd> ${b.undo ? `Undo ${DRAW_WORD[b.undo] || b.undo}` : "Undo"}</button>
      </div>
      <div class="bar-right">${left_ ? `<a class="btn primary big" href="#draw?sort=1">🎮 Quick sort <span class="btn-sub">${fmt(left_)} left</span> <kbd>Enter</kbd></a>`
        : `<a class="btn primary big" href="#duel?stage=stacks">Next: crown the stacks → <kbd>Enter</kbd></a>`}</div>`;
  };
  const seaHead = () => {
    const T = b.tagging || { tags: [], visible: [] };
    return `
    <h1>🗂️ Groups</h1>
    <span class="stat-chip" title="Shots in a group">${ring(b.total ? b.drawn / b.total : 0)}<b>${fmt(b.drawn)}</b>/ ${fmt(b.total)} grouped · ${plural(b.groups.length, "group")}</span>
    <button class="stat-chip chip-btn" id="tag-tray" title="Every tag: pick which ones are circles, rename them">🏷️ <b>${fmt(T.tags.length)}</b> tags · ${fmt(T.visible.length)} shown</button>
    <span class="grow"></span>
    ${viewToggle()}
    ${b.unsorted.count ? `<button class="btn" id="d-auto" title="Groups everything that's left for you (rename, merge or dissolve after)">✨ Auto-group the rest</button>` : ""}
    ${helpBtn(`Every photo floats in the circles of its <b>tags</b>: what it recognized (what's in it, who, how it looks, when) and the ones
      you add. Circles overlap as much as their tags share photos, so they fall into Venn diagrams on their own.<br><br>
      <b>Drag a photo</b> to where it belongs: it takes the tags of the circles you drop it in and loses the ones it left (onto another
      photo stacks them). The side list <b>suggests groups</b> from where tags meet: <b>Make</b> one, or drop photos on a group (or select
      and press its <b>number</b>). Click a circle's name to rename it (name the people!), change its emoji or hide it; 🏷️ lists every tag.
      <b>T</b> tags the selection, <b>Z</b> undoes.`)}`;
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
        onSelect: (it) => { selected.has(it.id) ? selected.delete(it.id) : selected.add(it.id); updateSelection(); },
        onDrop: (ids, t) => {
          if (t.kind === "photo") return act("/api/groups/merge", { photos: [...ids, t.id] }, "Stacked: same shot, one stack.", true);
          if (t.kind === "bin") return moveTo(ids, t.id === "new" ? "new" : String(t.id));
          if (t.kind === "tags") return dropTags(ids, t.on, t.off);
        },
        onCircle: (key, el) => tagMenu(key, el),
        onLasso: (id, el) => {
          if (id[0] === "g") return groupMenu(b.groups.find((g) => `g${g.id}` === id), el);
          const sg = b.tagging.suggestions.find((x) => `s${x.key}` === id);
          if (sg) makeSuggestion(sg);
        },
      });
      World.fence();
    }
    const T = b.tagging, meta = new Map(T.tags.map((t) => [t.key, t]));
    $("#sea-head", main).innerHTML = seaHead();
    $("#mergebar", main).innerHTML = barHtml();
    const groupAt = new Map(b.groups.map((g, i) => [g.id, i]));
    const circles = T.visible.filter((k) => meta.has(k)).map((k) => { const t = meta.get(k); return { id: k, label: t.label, emoji: t.emoji,
      html: `${esc(t.emoji || "🏷️")} ${esc(t.label)} <span class="ps-count">${fmt(t.count)}</span>` }; });
    const items = [], suggOf = new Map();
    T.suggestions.forEach((sg) => sg.shots.forEach((rep) => suggOf.set(rep, sg.key)));
    const add = (x, g) => {
      byRep.set(x.rep, { ...x, island: g ? g.id : null });
      const tg = T.shot_tags[x.rep] || [];
      items.push({ id: x.rep, photo: x.rep, tags: tg, n: x.members.length, group: g ? g.id : null, sugg: g ? null : suggOf.get(x.rep) ?? null,
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
    sea.setVenn(circles, items, lassos);
    renderRail();
    bindSea();
    updateSelection();
  }
  // The side list: the groups the tags suggest (point at one to see its shots), then your groups to drop photos on.
  function renderRail() {
    const T = b.tagging, rail = $("#venn-rail", main);
    const lab = (k) => esc((T.tags.find((t) => t.key === k) || {}).label || k);
    rail.innerHTML = `
      <div class="rail-card sugg-card"><h3>💡 Suggested groups ${T.suggestions.length > 1 ? `<button class="btn primary sugg-all" id="make-all" title="Make every suggestion a group">Lock in all ${T.suggestions.length}</button>` : ""}</h3>
        ${T.suggestions.length ? `<div class="sugg-list">${T.suggestions.map((g, i) => `
          <div class="sugg" data-sugg="${i}">
            <span class="sugg-emoji">${esc(g.emoji)}</span>
            <span class="sugg-body"><b>${esc(g.name)}</b><span class="muted small">${g.tags.map(lab).join(" ∩ ")} · ${plural(g.shots.length, "shot")}</span></span>
            <button class="btn" data-make="${i}" title="Make this a group">Make</button></div>`).join("")}</div>`
          : `<p class="muted small">${b.unsorted.count ? "Nothing yet: tag more photos, or show other tags as circles (🏷️)." : "Every shot is in a group."}</p>`}
      </div>
      <div class="rail-card grow bins-wrap"><h3>Groups <span class="muted small">drop photos here, or press a number</span></h3>
        <div class="bins" id="bins">${binsHtml(b.bins, null, null)}</div></div>`;
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
        if (g && binTools(e, el, g, () => load(true))) return;
        if (selected.size) moveTo([...selected], el.dataset.bin);
        else toast(el.dataset.bin === "new" ? "Select photos first (or drag them here) to start a group." : "Select photos (or drag them here) to put them in this group.");
      };
    });
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
    pop.style.top = `${r.bottom + 8 + window.scrollY}px`;
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
    $("[data-ip=dissolve]", pop).onclick = () => { if (confirm(`Dissolve ${g.name}? Its ${plural(g.size, "shot")} float back into open water.`)) { close(); act("/api/draw/dissolve", { theme: g.id }, "Dissolved."); } };
    if ($(".ip-merge", pop)) $(".ip-merge", pop).onchange = (e) => {
      const into = Number(e.target.value);
      if (into && confirm(`Merge ${g.name} into ${groupName(into)}?`)) { close(); act("/api/draw/merge", { from: g.id, into }, "Merged."); }
    };
    name.focus();
  }
  // A circle's menu: rename the tag (a person gets their name), its emoji, select its photos, hide it.
  function tagMenu(key, anchor) {
    const t = b.tagging.tags.find((x) => x.key === key);
    if (!t) return;
    $(".island-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "pop-card island-pop tag-pop";
    pop.innerHTML = `<div class="ip-head"><button class="t-emoji ip-emoji" data-tp="emoji" title="Change the emoji">${esc(t.emoji || "🏷️")}</button>
        <input class="hint-input ip-name" value="${esc(t.label)}" maxlength="40" aria-label="Tag name"></div>
      <span class="muted small">${plural(t.count, "shot")} · ${{ what: "what's in it", people: "who", look: "how it looks", when: "when" }[t.family] || "your tag"}${t.user ? " · yours" : ""}</span>
      <div class="ip-actions"><button class="btn" data-tp="select">Select its photos</button>
        <button class="btn ghost" data-tp="hide">Hide this circle</button></div>`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - pop.offsetWidth / 2, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom + 8 + window.scrollY}px`;
    const close = () => { pop.remove(); document.removeEventListener("pointerdown", away, true); };
    const away = (e) => { if (!pop.contains(e.target) && !e.target.closest(".emoji-pop")) close(); };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    const name = $(".ip-name", pop);
    name.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") name.blur(); if (e.key === "Escape") close(); };
    name.onchange = () => { const v = name.value.trim(); if (v && v !== t.label) { close(); act("/api/tags/meta", { key, label: v }, "Renamed."); } };
    $("[data-tp=emoji]", pop).onclick = (e) => emojiPicker(e.currentTarget, (emoji) => { close(); act("/api/tags/meta", { key, emoji }, "New emoji."); });
    $("[data-tp=select]", pop).onclick = () => {
      close();
      Object.entries(b.tagging.shot_tags).forEach(([rep, tg]) => { if (tg.includes(key) && byRep.has(Number(rep))) selected.add(Number(rep)); });
      updateSelection();
    };
    $("[data-tp=hide]", pop).onclick = () => { close(); act("/api/tags/meta", { key, hidden: true }, `${t.label} is off the sea (🏷️ brings it back).`); };
    name.focus();
  }
  // Every tag, by kind: click one to show it as a circle (or take it off the sea).
  function tagTray(anchor) {
    $(".island-pop")?.remove();
    const T = b.tagging, shown = new Set(T.visible);
    const pop = document.createElement("div");
    pop.className = "pop-card island-pop tag-tray";
    const fam = { what: "What's in it", people: "Who", look: "How it looks", when: "When" };
    const paint = (q) => {
      const hit = (t) => !q || t.label.toLowerCase().includes(q);
      $(".tray-body", pop).innerHTML = Object.entries(fam).map(([f, title]) => {
        const list = T.tags.filter((t) => (t.family || "what") === f && hit(t));
        return list.length ? `<div class="tray-fam"><b>${title}</b><div class="tray-chips">${list.map((t) => `<button class="tag-chip ${shown.has(t.key) ? "on" : ""}"
          data-chip="${esc(t.key)}" title="${shown.has(t.key) ? "Take it off the sea" : "Show it as a circle"}">${esc(t.emoji || "🏷️")} ${esc(t.label)} <b>${fmt(t.count)}</b></button>`).join("")}</div></div>` : "";
      }).join("") || `<p class="muted small">No tags match.</p>`;
      $$("[data-chip]", pop).forEach((c) => (c.onclick = () => {
        const k = c.dataset.chip;
        close();
        act("/api/tags/meta", shown.has(k) ? { key: k, hidden: true } : { key: k, pinned: true }, shown.has(k) ? "Taken off the sea." : "Shown as a circle.");
      }));
    };
    pop.innerHTML = `<input class="hint-input tray-q" placeholder="Find a tag" aria-label="Find a tag"><div class="tray-body"></div>`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom + 8 + window.scrollY}px`;
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
    $$("[data-mode]", main).forEach((x) => (x.onclick = () => setMode(x.dataset.mode)));
    $("#g-undo").onclick = () => drawUndo(() => load(true));
    $$("[data-sel-act]", main).forEach((x) => (x.onclick = () => selAct(x.dataset.selAct, x)));
    $("#tag-tray").onclick = (e) => tagTray(e.currentTarget);
    if ($("#d-auto")) $("#d-auto").onclick = async () => {
      if (!confirm(`Group the ${fmt(b.unsorted.count)} unsorted shots for you? You can rename, merge or dissolve any group after, and Z takes it all back.`)) return;
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
            Unsorted, <b>S</b> stacks them (same shot), <b>Z</b> undoes.<br><br><b>Edit</b>: click a group's name or emoji;
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
          <div class="bar-left"><span id="sel-count" class="muted small"></span></div>
          <div class="bar-mid">
            <button class="btn ghost" data-sel-act="clear"><kbd>Esc</kbd> Clear</button>
            <button class="btn" data-sel-act="unsort"><kbd>U</kbd> Unsorted</button>
            <button class="btn" data-sel-act="stack" title="They're the same shot: one stack"><kbd>S</kbd> Stack them</button>
            <button class="btn" data-sel-act="new"><kbd>N</kbd> New group</button>
            <button class="btn ghost" id="g-undo" ${b.undo ? "" : "hidden"} title="Take back your last change (Z)"><kbd>Z</kbd> ${b.undo ? `Undo ${DRAW_WORD[b.undo] || b.undo}` : "Undo"}</button>
          </div>
          <div class="bar-right">${left_ ? `<a class="btn primary big" href="#draw?sort=1">🎮 Quick sort <span class="btn-sub">${fmt(left_)} left</span> <kbd>Enter</kbd></a>`
            : `<a class="btn primary big" href="#duel?stage=stacks">Next: crown the stacks → <kbd>Enter</kbd></a>`}</div>
        </div>
      </div>`;
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
  window.addEventListener("resize", onResize);
  function updateSelection() {
    $$("[data-sel]", main).forEach((el) => { const on = selected.has(Number(el.dataset.sel)); el.classList.toggle("picked", on); el.setAttribute("aria-pressed", on); });
    const bar = $("#mergebar");
    $("#sel-count").innerHTML = selected.size ? `<b>${plural(selected.size, "shot")} selected</b> · press a group's key or drag them there`
      : "Click photos to select them, or drag one straight to a group";
    $$("[data-sel-act]", bar).forEach((x) => { x.hidden = !selected.size || (x.dataset.selAct === "stack" && selected.size < 2); });
    if (sea) sea.select([...selected]);
  }
  async function act(path, payload, msg, cheer) {
    if (busy) return;
    busy = true;
    try { await api(path, payload); toast(`${msg} Z undoes it.`); } catch (e) { toast(e.message); busy = false; return; }
    if (cheer) Sound.play("great"); else Sound.play("pick");
    selected.clear();
    busy = false;
    await load(true);
    refreshHud(true);
    if (/\/(merge|move|new)$/.test(path)) gameCheck();
  }
  const groupName = (id) => { const g = b.groups.find((x) => x.id === id); return g ? `${g.emoji} ${g.name}` : "that group"; };
  const moveTo = (reps, target) => (target === "new" ? act("/api/draw/new", { photos: reps }, `New group from ${plural(reps.length, "shot")}.`, true)
    : act("/api/draw/move", { photos: reps, theme: target === "none" ? null : Number(target) },
      target === "none" ? "Back in the unsorted pile." : `Into ${groupName(Number(target))}.`));
  const expand = (rep, btn) => expandStack(main, byRep.get(rep), btn, b.boxes);
  function bind() {
    $$("[data-mode]", main).forEach((x) => (x.onclick = () => setMode(x.dataset.mode)));
    $("#g-undo").onclick = () => drawUndo(() => load(true));
    if ($("#d-auto")) $("#d-auto").onclick = async () => {
      if (!confirm(`Group the ${fmt(b.unsorted.count)} unsorted shots for you? You can rename, merge or dissolve any group after, and Z takes it all back.`)) return;
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
          if (confirm(`Dissolve ${g.name}? Its ${plural(g.size, "shot")} go back to the unsorted pile.`)) act("/api/draw/dissolve", { theme: id }, "Dissolved.");
          return;
        }
      }
      const sel = e.target.closest("[data-sel]");
      if (sel && !e.target.closest("a, .tile-frames")) { const r = Number(sel.dataset.sel); selected.has(r) ? selected.delete(r) : selected.add(r); updateSelection(); }
    };
    page.onchange = (e) => {
      const m = e.target.closest("[data-merge]");
      if (!m || !m.value) return;
      const from = Number(m.dataset.merge), into = Number(m.value);
      if (confirm(`Merge ${groupName(from)} into ${groupName(into)}?`)) act("/api/draw/merge", { from, into }, "Merged.");
      else m.value = "";
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
    if (a === "tag") return tagSelection(el);
    if (a === "unsort") return moveTo(reps, "none");
    if (a === "new") return moveTo(reps, "new");
    if (a === "stack" && reps.length > 1) return act("/api/groups/merge", { photos: reps }, "Stacked: same shot, one stack.", true);
  }
  S.onKey = (e) => {
    if (e.repeat || !b) return;
    const k = e.key;
    const gi = groupKey(e);
    if (gi != null) { e.preventDefault(); if (selected.size && b.bins[gi]) moveTo([...selected], String(b.bins[gi].id)); return; }
    else if (k === "Escape" && selected.size) { e.preventDefault(); selAct("clear"); }
    else if ((k === "n" || k === "N") && selected.size) { e.preventDefault(); selAct("new"); }
    else if ((k === "s" || k === "S") && selected.size > 1) { e.preventDefault(); selAct("stack"); }
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
    main.innerHTML = `
      <div class="screen draw-play">
        <div class="screen-head play-head" id="t-head"></div>
        <div class="screen-body fill"><div class="deck" id="ddeck"></div></div>
        <aside class="screen-rail bins-wrap" aria-label="Groups"><div class="bins-head"><b>Groups</b>
          <span class="muted small">drag the photo here, or press its number</span></div><div class="bins" id="bins"></div></aside>
        <div class="screen-bar"><div class="action-bar" id="dctl"></div><p class="muted small center bar-hint" id="d-hint"></p></div>
      </div>`;
    paintHead();
    showCard();
  }
  function paintHead() {
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
      <a class="btn" href="#draw?g=${tid}" title="Back to the Groups page (Esc)"><kbd>Esc</kbd> Done</a>
      ${helpBtn(`It deals the unsorted photos <b>likeliest to belong to this group</b> first, and every one gets a home on the spot:
        <b>→</b> this group, <b>a number</b> (or drag it onto a group on the right) for another, <b>N</b> for a new group.
        <b>↑</b> stacks a photo with a near-twin already in the group. <b>🔎</b> words steer what comes first. <b>Z</b> undoes, <b>Esc</b> when you're done.`)}`;
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
    $("#crew").innerHTML = deck.members.map((id) => `<img src="${T(id)}" alt="" data-crew="${id}">`).join("");
  }
  function paintBins() {
    const c = mode === "card" || mode === "pick" ? deck.cards[0] : null;
    const box = $("#bins");
    box.innerHTML = binsHtml(deck.bins.map((b) => (b.id === tid ? { ...b, name: theme.name, emoji: theme.emoji } : b)), tid, c && c.fits);
    box.classList.toggle("picking", mode === "pick");
    box.classList.toggle("idle", !c);
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
    $("#d-hint").innerHTML = hint || "&nbsp;";
    $$("[data-c]", $("#dctl")).forEach((b) => (b.onclick = () => command(b.dataset.c)));
  }
  const UNDO = { c: "undo", label: "<kbd>Z</kbd> Undo" };
  const NEW = { c: "new", label: "<kbd>N</kbd> New group" };
  function command(c) {
    ({ undo, roll: reroll, done, dig: keepDigging, pick: startPick, cancel: cancelPick, new: () => place("new"), aim: pickAim,
      bulkin: () => bulk(true), onebyone: () => bulk(false), in: () => act("in"), twin: () => act("twin"),
      next: () => (location.hash = "#duel?stage=stacks") }[c] || (() => {}))();
  }
  function done() { location.hash = `#draw?g=${tid}`; }
  function showCard() {
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
    box.innerHTML = `${nx ? `<div class="swipe-card under"><img src="${P(nx.photo)}" alt="" draggable="false"></div>` : ""}
      <div class="swipe-card top" id="dtop" data-photo="${c.photo}" data-box='${JSON.stringify((c.view || {}).box || null)}'><img src="${P(c.photo)}" alt="Which group does this belong in?" draggable="false">
        ${c.long ? `<span class="why kept">Long shot for this group</span>` : ""}
        ${c.twin ? `<div class="twin-ask"><img src="${T(c.twin.of)}" alt=""><span><b>Same shot as this one?</b>
          ${c.twin.apart != null ? `${c.twin.apart < 120 ? `${c.twin.apart} s` : c.twin.apart < 7200 ? `${Math.round(c.twin.apart / 60)} min` : `${Math.round(c.twin.apart / 3600)} h`} apart · ` : ""}↑ stacks them</span></div>` : ""}
        <span class="stamp keep">IN</span></div>`;
    carryable($("#dtop"), { right: () => act("in"), left: startPick, up: c.twin ? () => act("twin") : null, drop: place });
    bar({ c: "pick", label: "<kbd>←</kbd> Another group" },
      [...(c.twin ? [{ c: "twin", cls: "twin-btn", label: "<kbd>↑</kbd> Same shot" }] : []), NEW, UNDO],
      { c: "in", cls: "keep-btn", label: `Into this group <kbd>→</kbd>` },
      "Every photo gets a group: → or Enter for this one, ← to pick another (or its key, or a drag), N for a new one. Esc when you're done.");
    paintBins();
    paintFilters();
    shownAt = performance.now();
  }
  let pcur = 0;
  function startPick() {
    if (mode !== "card") return;
    mode = "pick";
    Sound.play("whoop");
    const fit = deck.cards[0].fits[0];
    pcur = Math.max(0, deck.bins.findIndex((b) => b.id === (fit != null ? fit : -1)));
    bar({ c: "cancel", label: "<kbd>Esc</kbd> Back" }, [NEW, UNDO], { c: "aim", cls: "keep-btn", label: "Into it <kbd>→</kbd>" },
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
      ms: Math.round(performance.now() - shownAt) });
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
    if (call === "twin") {  // the stacking changed: deal again
      try { await req; } catch (e) { toast(e.message); }
      toast("Stacked: same shot, one stack. Z undoes it.");
      busy = false;
      return load();
    }
    showCard();
    try {
      const r = await req;
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
      theme = { ...theme, ...r.theme };
      Sound.play("whoop");
      paintHead();
      paintBins();
    } catch (e) { toast(e.message); }
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
  const called = { right: 0, total: 0, combo: 0, last: 0 };  // the ★ guess, and placements in quick succession
  const aimed = () => (cur < bins.length ? String(bins[cur].id) : "new");
  function paintCursor() {
    $$("#bins [data-bin]", main).forEach((el, i) => el.classList.toggle("cursor", i === cur));
    const el = $$("#bins [data-bin]", main)[cur];
    if (el) el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    const b = bins[cur], btn = $("[data-c=star]", main) || $(".bar-right [data-c=new]", main);
    if (btn) btn.innerHTML = b ? "Into this group <kbd>→</kbd>" : "New group <kbd>→</kbd>";
  }
  async function load() {
    try { ({ cards, bins, left: left_ } = await api("/api/draw/stragglers")); } catch (e) {
      if (!left(view)) main.innerHTML = FAILED(e.message);
      return;
    }
    if (left(view)) return;
    paint();
  }
  function paint() {
    const gone = World.grab(main);
    paintCard();
    World.swap(main, gone);
  }
  function paintCard() {
    const c = cards[0];
    if (!c) {
      main.innerHTML = `
        <div class="screen draw-play no-rail">
          <div class="screen-head play-head"><h1>🎮 Quick sort</h1><span class="stat-chip good"><b>0</b> unsorted · ${plural(bins.length, "group")}</span></div>
          <div class="screen-body fill"><div class="empty"><div class="big-emoji">🗂️</div><h2>Everything's grouped</h2>
            <p class="muted">Every shot has a group. Next, the stacks crown their best takes, then each group plays its own mini-tournament.</p></div></div>
          <div class="screen-bar action-bar"><div class="bar-left"><a class="btn big" href="#draw">The Groups page</a></div>
            <div class="bar-mid"><button class="btn ghost" data-c="undo"><kbd>Z</kbd> Undo the last one</button></div>
            <div class="bar-right"><a class="btn primary big" href="#duel?stage=stacks">Next: crown the stacks → <kbd>Enter</kbd></a></div></div>
        </div>`;
      $("[data-c=undo]", main).onclick = () => drawUndo(load);
      confetti(window.innerWidth / 2, window.innerHeight / 3, 50);
      refreshHud(true);
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
          <a class="btn" href="#draw" title="Back to the Groups page (Esc)"><kbd>Esc</kbd> Done</a>
          ${helpBtn(`The unsorted photos one at a time, in the order they were taken. <b>→</b> puts it in the group it looks most like
            (★), <b>a number</b> or a drag onto a group puts it in another, <b>N</b> starts a new group with it (it gets a name you can
            change on the Groups page), <b>←</b> tosses a throw-out (it goes to Set aside). <b>↑</b> / <b>↓</b> walk the groups, <b>E</b> renames the
            highlighted one. <b>Z</b> undoes, <b>Esc</b> leaves.`)}
        </div>
        <div class="screen-body fill"><div class="deck"><div class="swipe-card top" id="dtop" data-photo="${c.photo}" data-box='${JSON.stringify((c.view || {}).box || null)}'><img src="${P(c.photo)}" alt="Which group does this belong in?" draggable="false"><span class="stamp toss">TOSS</span></div></div></div>
        <aside class="screen-rail bins-wrap" aria-label="Groups"><div class="bins-head"><b>Groups</b>
          <span class="muted small">drag the photo here, or press its number</span></div>
          <div class="bins" id="bins">${binsHtml(bins, null, c.options.map((o) => o.id))}</div></aside>
        <div class="screen-bar"><div class="action-bar"><div class="bar-left"><button class="btn big toss-btn" data-c="toss" title="Out of the running: it goes to Set aside (Z undoes)"><kbd>←</kbd> Toss</button></div>
          <div class="bar-mid"><button class="btn ghost" data-c="new"><kbd>N</kbd> New group</button><button class="btn ghost" data-c="undo"><kbd>Z</kbd> Undo</button></div>
          <div class="bar-right">${star ? `<button class="btn big keep-btn" data-c="star">Into this group <kbd>→</kbd></button>`
            : `<button class="btn big keep-btn" data-c="new">New group <kbd>→</kbd></button>`}</div></div>
        <p class="muted small center bar-hint">${star ? "↑ ↓ pick a group (it starts on the ★ one), → or Enter puts the photo there; its key or a drag works too, N makes a new group, ← tosses it. E renames the highlighted group, Shift+↑ ↓ moves it (or drag it), its emoji changes it." : "Start your first group with this photo (→ or N), or toss it (←). It gets a name you can change."}</p></div>
      </div>`;
    cur = star ? Math.max(0, bins.findIndex((b) => b.id === star.id)) : bins.length;  // ↑/↓ walk the groups from the ★ one
    carryable($("#dtop"), { right: () => place(aimed()), left: toss, drop: (b) => place(b) });
    $$("[data-bin]", main).forEach((b) => (b.onclick = (e) => {
      const g = bins.find((x) => String(x.id) === b.dataset.bin);
      if (g && binTools(e, b, g, paint)) return;
      place(b.dataset.bin);
    }));
    $$("[data-c=new]", main).forEach((x) => (x.onclick = () => place("new")));
    $("[data-c=toss]", main).onclick = toss;
    $("[data-c=undo]", main).onclick = () => drawUndo(load);
    if ($("[data-c=star]", main)) $("[data-c=star]", main).onclick = () => place(aimed());
    sortableBins($("#bins", main), bins.map((b) => b.id), (ids) => { bins.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); paint(); });
    paintCursor();
    paintFilters();
  }
  async function place(bin) {
    if (busy || !cards[0]) return;
    busy = true;
    try {
      if (bin === "new") {
        const r = await api("/api/draw/new", { photos: [cards[0].photo] });
        toast(`New group: ${r.theme.emoji} ${r.theme.name}. Rename it any time on the Groups page.`);
        cards.shift();
        busy = false;
        return load();  // the new group is a bin now, and the hints change
      }
      await api("/api/draw/place", { photo: cards[0].photo, theme: Number(bin) });
      Sound.play("pick");
      const star = cards[0].options[0], now = performance.now();
      called.total++;
      if (star && String(star.id) === String(bin)) called.right++;
      called.combo = now - called.last < 2500 ? called.combo + 1 : 1;
      called.last = now;
      floatText(called.combo >= 3 ? `+2 XP · ×${called.combo} combo!` : "+2 XP", $("#dtop"), called.combo >= 3 ? "bonus" : "");
      if (called.combo >= 3 && called.combo % 5 === 0) Sound.play("level");
      left_ = Math.max(0, left_ - 1);
      const g = bins.find((x) => String(x.id) === String(bin));
      if (g) g.size++;  // its count goes up right away
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
      left_ = Math.max(0, left_ - 1);
      cards.shift();
    } catch (e) { toast(e.message); if (el) el.classList.remove("fly-left"); busy = false; return; }
    busy = false;
    if (cards.length) paint(); else await load();
  }
  S.onKey = (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (!cards[0]) {  // the finish screen: the way on, back, or undo the last one
      if (k === "Enter") { e.preventDefault(); location.hash = "#duel?stage=stacks"; }
      else if (k === "Escape") { e.preventDefault(); location.hash = "#draw"; }
      else if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); drawUndo(load); }
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
    else if (k === "ArrowLeft") { e.preventDefault(); toss(); }
    else if (k === "Escape") { e.preventDefault(); location.hash = "#draw"; }
    else if (k === "n" || k === "N") { e.preventDefault(); place("new"); }
    else if (k === "z" || k === "Z" || k === "Backspace") { e.preventDefault(); drawUndo(load); }
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
  const label = (r) => esc(d.labels[r] || r);

  const send = async (items, on) => {
    if (!items.length) return;
    await api("/api/rescue", { ids: items.map((p) => p.id), on, reason: current });
    items.forEach((p) => (p.rescued = on));
  };

  // the tabs (one per reason) and the bar's bulk buttons: only the ones that would do something
  const paint = () => {
    const list = by[current] || [];
    const back = list.filter((p) => p.rescued);
    const aside = list.length - back.length;
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
      await send(items, on);
      paint();
      $$(".tile[data-id]").forEach((t) => t.classList.toggle("rescued", list.find((x) => x.id === Number(t.dataset.id)).rescued));
      toast(on ? `${fmt(items.length)} photos back in the tournament.` : `${fmt(items.length)} photos set aside again.`);
    };
    const all = $("#all-back");
    if (all) all.onclick = () => bulk(list.filter((p) => !p.rescued), true);
    const none = $("#all-aside");
    if (none) none.onclick = () => bulk(list.filter((p) => p.rescued), false);
  };

  const render = () => {
    const list = by[current] || [];
    main.innerHTML = `
      <div class="screen cuts no-rail">
        <div class="screen-head">
          <h1>🗑️ Set aside</h1>
          <span class="stat-chip"><b>${fmt(d.photos.length)}</b> set aside</span>
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
      await send([p], !p.rescued);
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
  const d = await api("/api/people");
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
        <div class="bar-mid">${d.last ? `<button class="btn ghost" id="people-undo">Undo last change</button>` : ""}</div>
        <div class="bar-right"><a class="btn primary big" href="#home">The map → <kbd>Enter</kbd></a></div>
      </div>
    </div>`;
  const act = async (key, action, msg) => {
    await api(`/api/people/${key}`, { action });
    toast(msg);
    setTimeout(() => viewPeople(main), 1200);
  };
  $("#not-me").onclick = () => {
    if (!confirm("Tell it these faces aren't you? It will look for someone else who shows up often. (You can undo this.)")) return;
    act(0, "not_me", "Got it, re-working out which face is you…");
  };
  const undoBtn = $("#people-undo");
  if (undoBtn) undoBtn.onclick = async () => {
    try { await api("/api/people/undo", {}); } catch (e) { toast(e.message); return; }
    toast("Undone. Re-sorting your photos…");
    setTimeout(() => viewPeople(main), 1200);
  };
  $$("[data-match]").forEach((b) => (b.onclick = async () => {
    await api("/api/settings", { match: b.dataset.match });
    await loadState();
    toast(`Face matching: ${b.dataset.match}. Re-sorting your photos…`);
    setTimeout(() => viewPeople(main), 1500);
  }));
  $$("[data-act]").forEach((b) => (b.onclick = () => act(b.dataset.k, b.dataset.act,
    { exclude: "Excluded; their photos are being set aside.", include: "Included again.", me: "Merged into you." }[b.dataset.act])));
}

// ---------------------------------------------------------------- settings
$("#open-menu").onclick = openMenu;
function openSettings() {
  const s = S.lib.settings;
  const d = $("#settings");
  const opt = (vals, cur, fmtv = (v) => v) => vals.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${fmtv(v)}</option>`).join("");
  d.innerHTML = `
    <h2>Settings</h2>
    <label>What you're sorting<select id="s-mode">
      <option value="gallery" ${MODE() === "gallery" ? "selected" : ""}>My best photos (anything: a cup per kind of photo)</option>
      <option value="me" ${MODE() === "me" ? "selected" : ""}>Photos of me (profile pics)</option></select></label>
    <label>Leaderboard size (at most; small cups use a quarter of their shots)<select id="s-k">${opt([20, 25, 30, 40, 50, 60], s.finalists)}</select></label>
    <label>At most this many shots from one scene<select id="s-cap">${opt([1, 2, 3, 4, 5], s.per_scene)}</select></label>
    <label>Set aside photos older than<select id="s-age">${opt([0, 2, 3, 5, 8], s.max_age_years, (v) => (v ? `${v} years` : "never (just rank them lower)"))}</select></label>
    <p class="muted small">Folder: <code class="path">${esc(S.lib.source)}</code></p>
    <div class="row spread" style="margin-top:18px">
      <span class="row"><button class="btn ghost" id="s-rescan">Re-scan for new photos</button><button class="btn ghost" id="s-change">Switch save</button>
        <button class="btn ghost danger" id="s-forget" title="Delete everything MatchER keeps about this folder">Forget this save</button></span>
      <span class="row"><button class="btn" id="s-cancel">Cancel</button><button class="btn primary" id="s-save">Save</button></span>
    </div>`;
  $("#s-cancel").onclick = () => d.close();
  $("#s-save").onclick = async () => {
    const mode = $("#s-mode").value;
    await api("/api/settings", { finalists: Number($("#s-k").value), per_scene: Number($("#s-cap").value),
      max_age_years: Number($("#s-age").value), mode });
    const changed = mode !== MODE();
    await loadState();
    d.close();
    toast(changed ? "Re-sorting your photos for the new mode; give it a few seconds." : "Saved.");
    if (changed) location.hash = "home";
    route();
  };
  $("#s-rescan").onclick = async () => { await api("/api/rescan", {}); await loadState(); d.close(); location.hash = "analyze"; route(); };
  $("#s-change").onclick = () => { d.close(); location.hash = "#saves"; };
  $("#s-forget").onclick = async () => {
    if (!confirm("Delete everything MatchER keeps about this folder: your calls, face data, previews and exports? Your photos themselves aren't touched. This can't be undone.")) return;
    await api("/api/library/forget", { path: S.lib.source });
    await loadState();
    d.close();
    toast("Forgotten.");
    location.hash = "onboard";
    route();
  };
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
function shownRect(img) {
  if (!img.offsetParent || img.closest(".under, .help-pop")) return null;
  const r = img.getBoundingClientRect();
  if (r.width < 48 || r.height < 48 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
  let { left: x, top: y, width: w, height: h } = r;
  if (img.naturalWidth && getComputedStyle(img).objectFit === "contain") {
    const a = img.naturalWidth / img.naturalHeight;
    if (w / h > a) { const nw = h * a; x += (w - nw) / 2; w = nw; } else { const nh = w / a; y += (h - nh) / 2; h = nh; }
  }
  return w * h >= 2500 ? { x, y, w, h } : null;
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
  scan() {
    if (!this.on || !this.canvas) return;
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
    if (!this.raf && this.on && !reduceMotion && !document.hidden && this.blobs.length) this.raf = requestAnimationFrame((t) => this.frame(t));
  },
  frame(now) {
    this.raf = 0;
    if (!this.on || document.hidden) return;
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
    this.sea = new VennSea(this.el, {});
    this.plain = { onSelect: (it) => this.inspect(it.id) };  // anywhere but the Groups page, a click grabs a photo
    Object.assign(this.sea, this.plain);
  },
  // ambient: the sea is the map; focus: a screen is showing you photos; dim: a page of its own. In every mode the sea's
  // photos keep out from under the screen's own things and fly in the space around them.
  setMode(mode) {
    if (this.handlers && mode !== "live") {  // the Groups page let go of the sea: back to the plain world
      this.handlers = null;
      Object.assign(this.sea, { onSelect: null, onDrop: null, onCircle: null, onLasso: null }, this.plain);
      this.sea.select([]);
      this.sea.highlight(null);
      this.stale = true;
    }
    this.mode = mode;
    document.body.dataset.world = mode;
    if (this.sea) this.sea.lassos_on = mode === "live" || mode === "ambient";  // bubbles where there's open sea for them
    if (mode !== "hidden" && mode !== "live" && this.stale) this.sync();
    clearInterval(this.watch);
    if (mode !== "hidden") { this.watch = setInterval(() => this.fence(), 700); setTimeout(() => this.fence(), 60); }
  },
  // The Groups page works the sea itself: it feeds it (tags as circles, groups and suggestions) and handles its drops.
  live(handlers) {
    this.handlers = handlers;
    Object.assign(this.sea, handlers);
    this.setMode("live");
    return this.sea;
  },
  // what the screen has on it: the sea flows around these (head and bar strips, panels, the photos in focus)
  fence() {
    if (!this.sea || !this.el) return;
    const base = this.el.getBoundingClientRect();
    const list = [];
    for (const el of document.querySelectorAll(WORLD_SOLID)) {
      if (el.closest("[hidden]") || el.closest("dialog")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < base.top || r.top > base.bottom) continue;
      list.push({ x0: r.left - base.left, y0: r.top - base.top, x1: r.right - base.left, y1: r.bottom - base.top });
    }
    const sig = list.map((o) => [o.x0, o.y0, o.x1, o.y1].map(Math.round).join(",")).join("|");
    if (sig !== this.fenced) { this.fenced = sig; this.sea.obstacles = list; this.sea.layout(); this.sea.stir(120); }
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
  dirty() {
    this.stale = true;
    if (this.mode !== "hidden") setTimeout(() => this.sync(), Math.max(0, 1200 - (performance.now() - this.last)));
  },
  sync() {
    if (!this.sea || this.loading || this.mode === "live" || !S.lib || !S.lib.analyzed || S.lib.analyzing) return this.loading;
    this.stale = false;
    this.last = performance.now();
    this.loading = api("/api/draw/board?per=80&uper=500&tags=1").then((b) => {
      const T = b.tagging || { shot_tags: {}, suggestions: [], tags: [] };
      this.board = b;
      this.tagMeta = new Map((T.tags || []).map((t) => [t.key, t]));
      const suggOf = new Map();
      (T.suggestions || []).forEach((sg) => sg.shots.forEach((r) => suggOf.set(r, sg.key)));
      const items = [];
      b.groups.forEach((g) => g.shots.forEach((x) => items.push({ id: x.rep, photo: x.rep, tags: T.shot_tags[x.rep] || [], group: g.id, n: x.members.length })));
      b.unsorted.shots.forEach((x) => items.push({ id: x.rep, photo: x.rep, tags: T.shot_tags[x.rep] || [], sugg: suggOf.get(x.rep) ?? null, n: x.members.length }));
      this.sea.setVenn([], items, b.groups.map((g) => ({ id: `g${g.id}`, kind: "group", html: `${esc(g.emoji || "🗂️")} ${esc(g.name)}` })));
      for (const pid of this.lifted) this.tileOf(pid)?.classList.add("lifted");
      for (const it of this.sea.items.values()) this.badge(it);
      this.fence();
    }).catch(() => { this.stale = true; }).finally(() => { this.loading = null; });
    return this.loading;
  },
  tileOf(pid) { const it = this.sea && this.sea.items.get(Number(pid)); return it ? it.el : null; },
  fly(src, from, to, { ms = 360, cls = "" } = {}) {
    const img = document.createElement("img");
    img.src = src;
    img.className = `world-fly ${cls}`;
    img.alt = "";
    Object.assign(img.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.append(img);
    return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => {
      img.style.transition = `left ${ms}ms cubic-bezier(.2,.9,.3,1), top ${ms}ms cubic-bezier(.2,.9,.3,1), width ${ms}ms cubic-bezier(.2,.9,.3,1), height ${ms}ms cubic-bezier(.2,.9,.3,1), opacity ${ms}ms, border-radius ${ms}ms`;
      Object.assign(img.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
      img.classList.add("flying");
      setTimeout(() => { img.remove(); ok(); }, ms + 40);
    })));
  },
  // the photos on show in `root` now (call it before `root` re-renders)
  grab(root) {
    if (!root || this.mode === "hidden" || reduceMotion) return [];
    return [...root.querySelectorAll("[data-photo]:not(.under)")].map((el) => {
      const img = el.querySelector(":scope > img");
      return img && { pid: Number(el.dataset.photo), rect: img.getBoundingClientRect(), fate: el.classList.contains("won") ? "win" : el.classList.contains("lost") ? "lose" : "back" };
    }).filter((x) => x && x.rect.width);
  },
  // after `root` re-rendered: the photos that left sink back to the sea, the new ones rise out of it
  swap(root, gone) {
    if (this.mode === "hidden" || reduceMotion || !this.sea) return;
    const now = root ? [...root.querySelectorAll("[data-photo]:not(.under)")] : [];
    const here = new Set(now.map((el) => Number(el.dataset.photo)));
    for (const g of gone) if (!here.has(g.pid)) this.sink(g.pid, g.rect, g.fate);
    const had = new Set(gone.map((g) => g.pid));
    for (const el of now) {
      const pid = Number(el.dataset.photo);
      if (had.has(pid)) continue;
      const img = el.querySelector(":scope > img"), tile = this.tileOf(pid);
      if (!img || !tile) continue;
      const from = tile.getBoundingClientRect(), to = img.getBoundingClientRect();
      if (!to.width || !from.width) continue;
      tile.classList.add("lifted");  // its spot waits for it
      this.lifted.add(pid);
      img.style.opacity = "0";
      this.fly(T(pid), from, to).then(() => (img.style.opacity = ""));
    }
  },
  sink(pid, rect, fate) {
    const tile = this.tileOf(pid);
    this.lifted.delete(pid);
    if (!tile) return;
    const to = tile.getBoundingClientRect();
    this.fly(T(pid), rect, to, { ms: 440, cls: fate === "win" ? "win" : fate === "lose" ? "lose" : "" }).then(() => {
      tile.classList.remove("lifted");
      if (fate === "win") { tile.classList.remove("ps-won"); void tile.offsetWidth; tile.classList.add("ps-won"); }
    });
  },
  // The grab: any photo in the sea comes up to the middle, bigger, with everything about it and what you can do with
  // it; Esc (or a click outside) shrinks it back to its spot.
  async inspect(pid) {
    const tile = this.tileOf(pid), it = this.sea && this.sea.items.get(Number(pid));
    if (!tile || !it || this.inspecting) return;
    this.inspecting = true;
    const b = this.board || { groups: [] }, g = it.group != null ? b.groups.find((x) => x.id === it.group) : null;
    const rank = this.top && this.top.get(it.id);
    const tags = (it.tags || []).map((k) => this.tagMeta && this.tagMeta.get(k)).filter(Boolean);
    const ov = document.createElement("div");
    ov.className = "inspect";
    ov.innerHTML = `<div class="inspect-card">
        <img class="inspect-photo" src="${P(pid)}" alt="">
        <div class="inspect-chrome">
          <div class="inspect-line">${g ? `<span class="team-chip static">${esc(g.emoji || "🗂️")} ${esc(g.name)}</span>` : `<span class="muted">Not in a group yet</span>`}
            ${rank ? `<span class="stat-chip good">#<b>${rank}</b> on the board</span>` : ""}${it.n > 1 ? `<span class="stat-chip">⧉ <b>${it.n}</b> takes</span>` : ""}</div>
          ${tags.length ? `<div class="inspect-tags">${tags.map((t, i) => `<span class="tag-chip on" style="--i:${i}">${esc(t.emoji || "🏷️")} ${esc(t.label)}</span>`).join("")}</div>` : ""}
          <div class="inspect-actions"><button class="btn ghost" data-in="full">⤢ Full size</button><a class="btn ghost" href="#draw">🗂️ In Groups</a>
            <button class="btn ghost danger" data-in="toss" title="Out of the running: it goes to Set aside">Toss</button>
            <button class="btn primary" data-in="close">Back to the sea <kbd>Esc</kbd></button></div>
        </div></div>`;
    document.body.append(ov);
    const img = $(".inspect-photo", ov);
    try { await img.decode(); } catch (_) { /* shows anyway */ }
    const to = img.getBoundingClientRect(), from = tile.getBoundingClientRect();
    const at = (r) => `translate(${r.left - to.left}px, ${r.top - to.top}px) scale(${r.width / to.width}, ${r.height / to.height})`;
    img.style.transform = at(from);
    tile.classList.add("lifted");
    ov.getBoundingClientRect();
    ov.classList.add("open");
    img.style.transition = "transform 0.42s cubic-bezier(0.2, 0.9, 0.3, 1)";
    img.style.transform = "none";
    const keys = S.onKey;
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      S.onKey = keys;
      const back = this.tileOf(pid);
      ov.classList.remove("open");
      if (back) img.style.transform = at(back.getBoundingClientRect());
      setTimeout(() => { ov.remove(); back?.classList.remove("lifted"); this.inspecting = false; }, 430);
    };
    S.onKey = (e) => { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); close(); } };
    ov.onclick = (e) => { if (e.target === ov) close(); };
    $("[data-in=close]", ov).onclick = close;
    $("[data-in=full]", ov).onclick = () => { close(); openViewer(Number(pid)); };
    $("a", ov).onclick = () => close();
    $("[data-in=toss]", ov).onclick = async () => {
      try { await api("/api/draw/toss", { photo: Number(pid) }); toast("Tossed: it's under Set aside. Z on the Groups page undoes it."); Sound.play("toss"); }
      catch (err) { toast(err.message); }
      close();
    };
  },
  release() {  // a screen ended without handing its photos back: they just reappear in the sea
    for (const pid of this.lifted) this.tileOf(pid)?.classList.remove("lifted");
    this.lifted.clear();
  },
};
const WORLD_SOLID = ["#main .screen-head", "#main .screen-bar", "#main .screen-rail > *", "#main .duel-head", "#main .controls:not([hidden])",
  "#main #stage", "#main #done-slot > *", "#main .group-table:not([hidden])", "#main .deck", "#main .twin-arena", "#main .screen-body > .empty",
  "#main .card", "#main ol.world", "#main .grid", "#main .podium", "#main .reveal-strip", "#main .bracket", "#main .finals-arena",
  "#main .finals-done", "#main .an-panel", "#main .save-grid", "#main .onboard-body > *", "#main .sections", "#main .tb-section",
  "#main .people", "#main [data-solid]"].join(", ");
const WORLD_MODES = { home: "ambient", ready: "ambient", duel: "focus", sweep: "focus", finals: "focus", stacks: "dim", shortlist: "dim",
  leaderboard: "dim", reveal: "dim", cuts: "dim", people: "dim" };

// ---------------------------------------------------------------- boot
(async () => {
  try { await loadState(); } catch (e) { $("#main").innerHTML = `<div class="page"><p class="error">Can't reach MatchER: ${esc(e.message)}</p></div>`; return; }
  World.init();
  route();
  Sea.init();
})();
