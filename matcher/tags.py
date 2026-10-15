"""Tags: everything the analysis recognizes about a photo, many per photo (what's in it, who's in it, how it looks,
when it was taken), plus the ones you add or take away. The Groups page draws them as overlapping circles (Venn
diagrams that fall out of how tags share photos), and the places where tags intersect suggest themed groups.

Automatic tags are rewritten on every full refresh; your edits (`tag_edits`) sit on top and survive it."""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from datetime import datetime

import numpy as np

from . import themes

FAMILIES = ("what", "people", "look", "when")
RECOGNITION_VERSION = 1
VISIBLE_MAX = 6      # circles on the sea at once (more is a tangle); the rest wait in the tag tray
CLUSTER_SAMPLE = 512
CLUSTER_VOCAB = 256  # use the sparse path above this; every tag still contributes
DAY_MIN = 6          # a day with this many photos (or 3% of them) is an outing worth a tag

# a kind leading a suggested group gets one of these names
KIND_NAMES = {"people": ["People Watching", "Familiar Faces"], "nature": ["Into the Wild", "Great Outdoors"],
              "places": ["Out and About", "Places & Spaces"], "animals": ["Critter Corner", "Wild Things"],
              "food": ["Foodie Finds", "Snack Attack"], "things": ["Odds & Ends", "Bits & Bobs"]}
KINDS = {"people": ("🧑‍🤝‍🧑", "People"), "nature": ("🏔️", "Nature"), "places": ("🏙️", "Places"),
         "animals": ("🐾", "Animals"), "food": ("🍜", "Food"), "things": ("🎲", "Things")}
SEASON_EMOJI = {"Winter": "❄️", "Spring": "🌸", "Summer": "☀️", "Autumn": "🍂"}
# Concepts that mean the same as a measured attribute share its tag (either one sets it).
ALIAS = {"sunglasses": "sunglasses", "mirror": "mirror_selfie", "car_selfie": "car_selfie", "bed": "bed",
         "smile": "smiling", "bw": "bw", "text": "text", "dogs": "dogs", "night_out": "night_out"}
# (key) -> (emoji, label, family) for tags that don't come straight from a concept
FIXED = {
    "me": ("🙂", "You", "people"), "faces": ("🙂", "Faces", "people"),
    "group_shot": ("👯", "Group shot", "people"), "smiling": ("😄", "Smiling", "people"),
    "bw": ("🎞️", "Black & white", "look"), "dark": ("🌑", "Dark", "look"), "blurry": ("🌫️", "Blurry", "look"),
    "eyes_closed": ("😑", "Eyes closed", "look"), "sunglasses": ("😎", "Sunglasses", "look"),
    "mirror_selfie": ("🪞", "Mirror selfie", "look"), "filter": ("✨", "Face filter", "look"),
    "smoking": ("🚬", "Smoking", "look"), "stunning": ("🌟", "Stunning", "look"),
    "outdoors": ("🌳", "Outdoors", "what"), "night_out": ("🪩", "Night out", "what"), "car_selfie": ("🚙", "In the car", "what"),
    "bed": ("🛏️", "Bed & bathroom", "what"), "dogs": ("🐶", "Dogs", "what"), "text": ("📝", "Text", "what"),
    "night": ("🌙", "Night", "when"),
}
# Fixed tags lead groups too; these keep them in the concepts' playful voice rather than "The Faces bunch".
FIXED_NAMES = {
    "me": ["Me, Myself & I", "Main Character"], "faces": ["Face Value", "Familiar Faces"],
    "group_shot": ["Squad Goals", "The Whole Crew"], "smiling": ["Grin Squad", "All Smiles"],
    "bw": ["Monochrome Mood", "Shades of Grey"], "dark": ["After Dark", "Low Light Club"], "blurry": ["Soft Focus", "Motion Blur"],
    "eyes_closed": ["Blink Brigade", "Caught Napping"], "sunglasses": ["Shades On", "Cool Customers"],
    "mirror_selfie": ["Mirror Mirror", "Reflections"], "filter": ["Filter Fun", "Face Paint"],
    "smoking": ["Smoke Break", "Up in Smoke"], "stunning": ["Showstoppers", "Pure Gold"],
    "outdoors": ["Great Outdoors", "Fresh Air Club"], "night_out": ["Night Owls", "After Hours"], "car_selfie": ["Road Trip", "Backseat Drivers"],
    "bed": ["Lazy Days", "Duvet Day"], "dogs": ["Paw Pals", "Good Dogs"], "text": ["Fine Print", "Words & Pictures"],
    "night": ["Night Owls", "Moonlighting"],
}
PEOPLE_CONCEPTS = {"friends", "family", "selfie", "portrait", "formal", "serious", "party"}
LOOK_CONCEPTS = {"style", "hat", "glasses", "macro"}
# measured attribute (library.ATTRS) -> (tag, threshold)
ATTR_TAGS = {"sunglasses": ("sunglasses", 0.65), "mirror_selfie": ("mirror_selfie", 0.7), "filter": ("filter", 0.8),
             "smoking": ("smoking", 0.75), "blurry": ("blurry", 0.7), "outdoors": ("outdoors", 0.7),
             "nightlife": ("night_out", 0.75), "car": ("car_selfie", 0.7), "bathroom_bed": ("bed", 0.75),
             "dog": ("dogs", 0.75), "document": ("text", 0.5), "group": ("group_shot", 0.75),
             "aesthetic": ("stunning", 0.9)}
_ATTR_CACHE = (None, None, None)


def _pretty(key: str) -> str:
    return key.replace("_", " ").capitalize()


def concept_meta() -> dict[str, tuple[str, str, str]]:
    out = {}
    for key, emoji, _, _ in themes.CONCEPTS:
        k = ALIAS.get(key, key)
        if k in FIXED:
            continue
        fam = "people" if key in PEOPLE_CONCEPTS else "look" if key in LOOK_CONCEPTS else "what"
        out[k] = (emoji, _pretty(key).replace("Night city", "City at night"), fam)
    return out


# ----------------------------------------------------------------------------- recognizing

def discovery(raw) -> tuple[dict, bool]:
    found = json.loads(raw or "{}")
    if not isinstance(found, dict):
        return {}, False
    versioned = isinstance(found.get("tags"), dict)
    return (found["tags"] if versioned else found), versioned and found.get("version") == RECOGNITION_VERSION


def discovery_json(found: dict) -> str:
    return json.dumps({"version": RECOGNITION_VERSION, "tags": found})


def recognize(full: np.ndarray, crop: np.ndarray | None = None) -> list[dict[str, float]]:
    """The same evidence gate for live discoveries and saved automatic tags, independent of other photos."""
    from . import library
    from .models import SIGLIP_LOGIT_SCALE
    global _ATTR_CACHE
    if not len(full):
        return []
    full = full / np.maximum(np.linalg.norm(full, axis=1, keepdims=True), 1e-9)
    if crop is not None:
        crop = crop / np.maximum(np.linalg.norm(crop, axis=1, keepdims=True), 1e-9)
    C = themes.concept_scores(full)
    accepted = themes.evidence_mask(C)
    keys = [ALIAS.get(k, k) for k, _, _, _ in themes.CONCEPTS]
    per = [{keys[j]: float(C[i, j]) for j in np.flatnonzero(accepted[i])} for i in range(len(full))]
    if _ATTR_CACHE[0] is not library._prompt_embeddings:
        prompts = sorted({p for name in ATTR_TAGS for p in library.ATTRS[name][1] + library.ATTRS[name][2]})
        _ATTR_CACHE = (library._prompt_embeddings, library._prompt_embeddings(prompts), {p: i for i, p in enumerate(prompts)})
    P, col = _ATTR_CACHE[1:]
    full_scores, crop_scores = full @ P.T, crop @ P.T if crop is not None else None
    for name, (tag, threshold) in ATTR_TAGS.items():
        src, pos, neg = library.ATTRS[name]
        scores = full_scores if src == "full" else crop_scores
        if scores is None:
            continue
        positive, negative = scores[:, [col[p] for p in pos]], scores[:, [col[p] for p in neg]]
        peak = positive.max(1)
        # Equal prior mass per side: adding paraphrases must not manufacture confidence.
        logits = SIGLIP_LOGIT_SCALE * np.hstack([positive, negative])
        prob = np.exp(logits - logits.max(1, keepdims=True))
        yes, no = prob[:, :len(pos)].mean(1), prob[:, len(pos):].mean(1)
        probability = yes / (yes + no)
        gate = (themes.evidence_mask(peak[:, None], C)[:, 0] & (peak >= .065) & (probability >= max(.85, threshold))
                & (peak >= negative.max(1) + .015))
        for i in np.flatnonzero(gate):
            # A narrow binary comparison cannot bypass contradictory subject evidence.
            if tag in keys and tag not in per[i]:
                continue
            per[i][tag] = max(per[i].get(tag, 0.0), float(probability[i]))
    return per


def auto_tags(lib, ident: dict, zs: dict, cats: list, flags: list, keep: np.ndarray, mode: str, recognized=None):
    """Every photo's automatic tags. Returns (meta: key -> (emoji, label, family), per photo: [(key, score)])."""
    n = len(lib.photos)
    per: list[dict[str, float]] = recognize(lib.emb, lib.crop) if recognized is None else [dict(row) for row in recognized]
    meta: dict[str, tuple[str, str, str]] = dict(FIXED)
    meta["me"] = ("🙂", "You", "people") if mode != "gallery" else ("⭐", "Main character", "people")
    if not n:
        return meta, []
    # Confirmed kinds and concepts, never a quota from this library's score distribution.
    for i, c in enumerate(cats):
        if c:
            per[i][f"kind:{c}"] = 1.0
    for c, (emoji, label) in KINDS.items():
        meta[f"kind:{c}"] = (emoji, label, "what")
    cmeta = concept_meta()
    meta.update(cmeta)
    # Current discoveries share this gate. Old unversioned claims must earn their tags again.
    for i, p in enumerate(lib.photos):
        found, current = discovery(p.get("recognized_tags"))
        if not current:
            continue
        for key, score in found.items():
            key = ALIAS.get(key, key)
            if key in meta:
                per[i][key] = float(score)
    # who's in it
    keys_of = ident.get("keys") or []
    people = {p["key"]: p for p in ident.get("people", [])}
    for rank, p in enumerate(ident.get("people", []), start=1):
        meta[f"person:{p['key']}"] = ("👤", f"Person {rank}", "people")
    me_face = ident.get("me_face") or {}
    for j, f in enumerate(lib.faces):
        i = lib.pidx.get(f["photo_id"])
        if i is None:
            continue
        k = int(ident["person"][j]) if len(ident.get("person", [])) > j else -1
        if k >= 1 and k <= len(keys_of) and keys_of[k - 1] in people:
            per[i][f"person:{keys_of[k - 1]}"] = 1.0
    faces_of = lib.faces_by_photo
    for i, p in enumerate(lib.photos):
        pid = p["id"]
        if me_face.get(pid) is not None:
            per[i]["me"] = 1.0
        fs = [lib.faces[j] for j in faces_of.get(pid, [])]
        if fs or (p.get("n_faces") or 0):
            per[i]["faces"] = 1.0
        if (p.get("n_faces") or 0) >= 3:
            per[i]["group_shot"] = 1.0
        mine = [f for f in fs if f["id"] == me_face.get(pid)] if mode != "gallery" else fs
        smiles = [f.get("smile") or 0.0 for f in mine if f.get("smile") is not None]
        if smiles and max(smiles) > 0.5:
            per[i]["smiling"] = float(max(smiles))
        if any(min(f.get("blink_l") or 0, f.get("blink_r") or 0) >= 0.55 for f in fs):
            per[i]["eyes_closed"] = 1.0
        # how it looks
        fl = flags[i] if i < len(flags) else []
        if "eyes_closed" in fl:
            per[i]["eyes_closed"] = 1.0
        if "blurry" in fl and (p.get("sharp") is not None and p["sharp"] < 25):
            per[i]["blurry"] = 1.0
        if p.get("chroma") is not None and p["chroma"] < 3.5:
            per[i]["bw"] = 1.0
        if p.get("luma") is not None and p["luma"] < 55:
            per[i]["dark"] = 1.0
    # when
    days = Counter()
    for i, p in enumerate(lib.photos):
        t = p.get("taken")
        if not t:
            continue
        try:
            d = datetime.fromisoformat(t)
        except ValueError:
            continue
        per[i][f"y:{d.year}"] = 1.0
        meta[f"y:{d.year}"] = ("📅", str(d.year), "when")
        s = themes.SEASONS[d.month]
        per[i][f"season:{s.lower()}"] = 1.0
        meta[f"season:{s.lower()}"] = (SEASON_EMOJI[s], s, "when")
        if p.get("taken_src") == "exif" and (d.hour >= 20 or d.hour < 5):
            per[i]["night"] = 1.0
        days[d.date().isoformat()] += 1
    busy = {day for day, k in days.items() if k >= max(DAY_MIN, math.ceil(0.03 * n))}
    for i, p in enumerate(lib.photos):
        day = (p.get("taken") or "")[:10]
        if day in busy:
            per[i][f"day:{day}"] = 1.0
            d = datetime.fromisoformat(day)
            meta[f"day:{day}"] = ("🗓️", f"{d.day} {d:%b %Y}", "when")
    return meta, [sorted(x.items()) for x in per]


def write_auto(store, lib, meta: dict, per: list) -> dict:
    """Store the automatic tags (yours are kept apart, in tag_edits) and the tag list. Returns a summary for the
    analysis screen: how many tags, and the biggest ones."""
    rows = [(p["id"], k, float(v)) for p, tags in zip(lib.photos, per) for k, v in tags]
    counts = Counter(k for _, k, _ in rows)
    aliases = {r["source"] for r in store.q("SELECT source FROM tag_aliases")}
    with store.tx() as c:
        c.execute("DELETE FROM photo_tags")
        c.executemany("INSERT INTO photo_tags(photo_id, tag, score) VALUES(?,?,?)", rows)
        for photo, accepted in zip(lib.photos, per):
            raw = photo.get("recognized_tags")
            found, current = discovery(raw)
            if raw is not None and not current:
                valid = dict(accepted)
                kept = {ALIAS.get(k, k): float(v) for k, v in found.items() if ALIAS.get(k, k) in valid}
                c.execute("UPDATE photos SET recognized_tags=? WHERE id=?", (discovery_json(kept), photo["id"]))
        for key in counts:
            if key in aliases:
                continue
            emoji, label, fam = meta.get(key, ("🏷️", key, "what"))
            c.execute("INSERT INTO tags(key, label, emoji, family) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
                      "label=CASE WHEN named THEN label ELSE excluded.label END, "
                      "emoji=CASE WHEN named THEN emoji ELSE excluded.emoji END, family=excluded.family",
                      (key, label, emoji, fam))
    top = [[meta.get(k, ("🏷️", k))[0], meta.get(k, ("🏷️", k, ""))[1], n] for k, n in counts.most_common(14)]
    return {"tags": len(counts), "top": top}


# ----------------------------------------------------------------------------- reading and editing

def rows(store) -> dict[str, dict]:
    return {r["key"]: dict(r) for r in store.q("SELECT * FROM tags")}


def effective(store, pids=None) -> dict[int, set[str]]:
    """Each photo's tags as they stand: the automatic ones, plus yours, minus the ones you took away."""
    out: dict[int, set[str]] = {}
    def read(table, cols):
        if pids is None:
            return store.q(f"SELECT {cols} FROM {table}")
        ids, found = list(pids), []
        for start in range(0, len(ids), 500):
            part = ids[start:start + 500]
            found += store.q(f"SELECT {cols} FROM {table} WHERE photo_id IN ({','.join('?' * len(part))})", part)
        return found
    for r in read("photo_tags", "photo_id, tag"):
        out.setdefault(r["photo_id"], set()).add(r["tag"])
    edits = read("tag_edits", "photo_id, tag, val")
    for r in edits:
        s = out.setdefault(r["photo_id"], set())
        (s.add if r["val"] else s.discard)(r["tag"])
    aliases = {r["source"]: r["target"] for r in store.q("SELECT * FROM tag_aliases")}
    if aliases:
        def resolve(tag):
            seen = set()
            while tag in aliases and tag not in seen:
                seen.add(tag)
                tag = aliases[tag]
            return tag if tag not in seen else None
        out = {p: {t for key in ts if (t := resolve(key)) is not None} for p, ts in out.items()}
        for r in edits:
            if not r["val"] and r["tag"] not in aliases:
                out.setdefault(r["photo_id"], set()).discard(r["tag"])
    if pids is not None:
        want = set(pids)
        out = {p: t for p, t in out.items() if p in want}
    return out


def edit(store, photos: list[int], on: list[str], off: list[str]) -> list:
    """Your change to these photos' tags. Returns the undo rows: [photo, tag, previous edit or None]."""
    before = {}
    if photos:
        for k in range(0, len(photos), 500):
            chunk = photos[k:k + 500]
            for r in store.q(f"SELECT photo_id, tag, val FROM tag_edits WHERE photo_id IN ({','.join('?' * len(chunk))})", chunk):
                before[(r["photo_id"], r["tag"])] = r["val"]
    undo = []
    with store.tx() as c:
        for pid in photos:
            for tag, val in [(t, 1) for t in on] + [(t, 0) for t in off]:
                undo.append([pid, tag, before.get((pid, tag))])
                c.execute("INSERT INTO tag_edits(photo_id, tag, val) VALUES(?,?,?) ON CONFLICT(photo_id, tag) DO UPDATE SET val=excluded.val",
                          (pid, tag, val))
    return undo


def unedit(c, undo: list) -> None:
    """Put tag edits back as they were (inside an open transaction)."""
    for pid, tag, val in reversed(undo):
        if val is None:
            c.execute("DELETE FROM tag_edits WHERE photo_id=? AND tag=?", (pid, tag))
        else:
            c.execute("INSERT INTO tag_edits(photo_id, tag, val) VALUES(?,?,?) ON CONFLICT(photo_id, tag) DO UPDATE SET val=excluded.val",
                      (pid, tag, val))


def new_tag(store, label: str, emoji: str | None) -> str:
    label = re.sub(r"\s+", " ", label).strip()[:40]
    key = "u:" + (re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "tag")
    with store.tx() as c:
        c.execute("INSERT INTO tags(key, label, emoji, family, user, named) VALUES(?,?,?,?,1,1) "
                  "ON CONFLICT(key) DO UPDATE SET hidden=0", (key, label, emoji or "🏷️", "what"))
    return key


# ----------------------------------------------------------------------------- the sea and the suggestions

def choose_visible(sets: dict, meta: dict[str, dict], limit: int = VISIBLE_MAX) -> list[str]:
    """Which tags get a circle: the ones you pinned, then the ones that sort these shots best (cover many shots no
    other circle covers, without being nearly everything or nearly the same as a circle already chosen)."""
    n = len(sets)
    if not n:
        return []
    count = Counter(t for s in sets.values() for t in s)
    members: dict[str, set] = {}
    for rep, s in sets.items():
        for t in s:
            members.setdefault(t, set()).add(rep)
    chosen = [k for k, r in meta.items() if r.get("pinned") and count.get(k)]
    lo, hi = max(2, math.ceil(0.03 * n)), max(3, int(0.85 * n))
    cand = [k for k, m in count.items() if lo <= m <= hi and not (meta.get(k) or {}).get("hidden") and k not in chosen]
    covered = set().union(*(members[k] for k in chosen)) if chosen else set()
    fam = Counter((meta.get(k) or {}).get("family") for k in chosen)
    while len(chosen) < limit and cand:
        def gain(k):
            m = members[k]
            same = max((len(m & members[c]) / len(m | members[c]) for c in chosen), default=0.0)
            if same > 0.7 or fam[(meta.get(k) or {}).get("family")] >= 4:
                return -1.0
            # a broad kind (Things, Places) sorts less than a specific tag (Dogs, Mountains), so it counts for less
            weight = 0.55 if k.startswith("kind:") else 0.85 if (meta.get(k) or {}).get("family") == "look" else 1.0
            return (len(m - covered) + 0.25 * len(m)) * weight
        best = max(cand, key=gain)
        if gain(best) <= 0:
            break
        chosen.append(best)
        covered |= members[best]
        fam[(meta.get(best) or {}).get("family")] += 1
        cand.remove(best)
    return chosen


def diagrams(visible: list[str], sets: dict) -> list[list[str]]:
    """Visible tags fall into separate Venn diagrams where they share no shots at all."""
    parent = {k: k for k in visible}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k
    vis = set(visible)
    for s in sets.values():
        t = [k for k in s if k in vis]
        for a, b in zip(t, t[1:]):
            parent[find(a)] = find(b)
    comp: dict[str, list[str]] = {}
    for k in visible:
        comp.setdefault(find(k), []).append(k)
    return sorted(comp.values(), key=lambda ks: -sum(1 for s in sets.values() if s & set(ks)))


def cluster(sets: dict, open_reps: set, visible: list[str], meta: dict[str, dict], taken: set[str], limit: int = 14) -> list[dict]:
    """Equal-weight tag cosine clusters, with k picked by sampled silhouette. Every tagged shot lands in one
    cluster; a sparse path keeps large vocabularies from dropping discoveries or building a huge dense matrix."""
    reps = sorted(r for r in open_reps if sets.get(r))
    if len(reps) < 2:
        return []
    df = Counter(t for r in reps for t in sets[r])
    vocab = sorted(df)
    col = {t: j for j, t in enumerate(vocab)}
    n = len(reps)

    def matrix(ids):
        X = np.zeros((len(ids), len(vocab)), np.float32)
        for i, r in enumerate(ids):
            for t in sets[r]:
                if t in col:
                    X[i, col[t]] = 1.0
        X /= np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-9)
        return X

    # Train and score on a fixed sample; assigning the rest in chunks never needs an n×n matrix.
    rng = np.random.RandomState(0)
    sample = sorted(rng.choice(n, min(n, CLUSTER_SAMPLE), replace=False)) if n > CLUSTER_SAMPLE else range(n)
    sampled = [reps[i] for i in sample]
    ns = len(sampled)
    sparse = len(vocab) > CLUSTER_VOCAB
    if sparse:
        postings = {}
        scale = np.array([1 / math.sqrt(len(sets[r])) for r in sampled], np.float32)
        for i, rep in enumerate(sampled):
            for tag in sets[rep]:
                postings.setdefault(tag, []).append(i)
        gram = np.zeros((ns, ns), np.float32)
        for ix in postings.values():
            gram[np.ix_(ix, ix)] += scale[ix, None] * scale[None, ix]
        X = None
    else:
        X = matrix(sampled)
        gram = X @ X.T
    D = np.maximum(0, 1 - gram)
    np.fill_diagonal(D, 0)

    def kmeans(k):
        rng = np.random.RandomState(0)
        if sparse:
            # Centroids are combinations of the sample rows, so training needs only a 512×512 Gram matrix.
            seeds = [rng.randint(ns)]
            for _ in range(1, k):
                d = np.clip(1 - gram[:, seeds].max(1), 0, None)
                seeds.append(rng.choice(ns, p=d / d.sum()) if d.sum() > 1e-9 else rng.randint(ns))
            C = np.eye(ns, dtype=np.float32)[:, seeds]
            lab = np.zeros(ns, int)
            for step in range(30):
                new = np.argmax(gram @ C, axis=1)
                if step and (new == lab).all():
                    break
                lab = new
                for j in range(k):
                    mask = lab == j
                    if mask.any():
                        C[:, j] = mask / mask.sum()
                C /= np.maximum(np.sqrt(np.maximum((C * (gram @ C)).sum(0), 0)), 1e-9)
            return lab, C
        cen = [X[rng.randint(ns)]]
        for _ in range(1, k):  # k-means++: spread the starting centres
            d = np.clip(1 - np.max(X @ np.array(cen).T, axis=1), 0, None)  # (rounding can dip below zero)
            cen.append(X[rng.choice(ns, p=d / d.sum())] if d.sum() > 1e-9 else X[rng.randint(ns)])
        C = np.array(cen)
        lab = np.zeros(ns, int)
        for _ in range(30):
            new = np.argmax(X @ C.T, axis=1)
            if _ and (new == lab).all():
                break
            lab = new
            for j in range(k):
                m = X[lab == j]
                if len(m):
                    c = m.mean(0)
                    C[j] = c / max(np.linalg.norm(c), 1e-9)
        return lab, C

    def silhouette(lab):
        labs, inv, counts = np.unique(lab, return_inverse=True, return_counts=True)
        means = np.column_stack([D[:, lab == j].mean(1) for j in labs])
        own = means[np.arange(ns), inv]
        a = own * counts[inv] / np.maximum(1, counts[inv] - 1)
        means[np.arange(ns), inv] = np.inf
        b = means.min(1)
        return float(np.mean(np.where(counts[inv] > 1, (b - a) / np.maximum(np.maximum(a, b), 1e-9), 0)))
    best, centers = -2.0, np.full((ns, 1), 1 / ns, np.float32) if sparse else np.mean(X, axis=0, keepdims=True)
    for k in range(2, max(2, min(limit, ns // 5)) + 1):
        lab, C = kmeans(k)
        if len(set(lab.tolist())) < 2:
            continue
        sc = silhouette(lab) - 0.015 * k  # a nudge toward fewer, bigger groups
        if sc > best:
            best, centers = sc, C.copy()
    if sparse:
        features = np.zeros((len(vocab), centers.shape[1]), np.float32)
        for i, rep in enumerate(sampled):
            features[[col[t] for t in sets[rep]]] += scale[i] * centers[i]
        best_lab = np.array([features[[col[t] for t in sets[r]]].sum(0).argmax() for r in reps])
    else:
        best_lab = np.concatenate([np.argmax(matrix(reps[i:i + 2048]) @ centers.T, axis=1)
                                   for i in range(0, n, 2048)])
    allfreq = {t: df[t] / len(open_reps) for t in vocab}
    out, used = [], set(taken)
    for j in sorted(set(best_lab.tolist()), key=lambda j: -(best_lab == j).sum()):
        members = [reps[i] for i in np.flatnonzero(best_lab == j)]
        cnt = Counter(t for r in members for t in sets[r] if t in col)
        common = [t for t, c in cnt.items() if c >= max(2, 0.5 * len(members))]
        common.sort(key=lambda t: -(cnt[t] / len(members)) / max(allfreq.get(t, 1), 1e-9))
        keys = common[:3] or [cnt.most_common(1)[0][0]]
        name, emoji = name_for(keys, meta, used)
        used.add(name.lower())
        out.append({"key": f"c{len(out)}", "tags": keys, "shots": sorted(members), "name": name, "emoji": emoji})
    return out


_CATCHY = None


def catchy_names(key: str) -> list[str]:
    """The playful names a tag hands to a group or flock it leads: its concept's, its kind's, or a fixed tag's.
    The Groups page, the suggestions and the sea's flocks all speak with this one voice."""
    global _CATCHY
    if _CATCHY is None:
        _CATCHY = {ALIAS.get(k, k): list(names) for k, _, _, names in themes.CONCEPTS}
        _CATCHY.update({f"kind:{k}": list(names) for k, names in KIND_NAMES.items()})
        for k, names in FIXED_NAMES.items():
            _CATCHY.setdefault(k, list(names))
    return list(_CATCHY.get(ALIAS.get(key, key), []))


def name_for(keys: list[str], meta: dict[str, dict], taken: set[str]) -> tuple[str, str]:
    """A name for a group of shots sharing these tags: a concept's catchy name if one leads, else the tags' own labels;
    when it was rides along at the end (Golden Hour Gang · Summer 2024)."""
    label = lambda k: (meta.get(k) or {}).get("label") or k  # noqa: E731
    fam = lambda k: (meta.get(k) or {}).get("family")  # noqa: E731
    order = {"season": 0, "y": 1, "day": 2}
    when = sorted((k for k in keys if fam(k) == "when"), key=lambda k: order.get(k.split(":")[0], 3))
    rest = [k for k in keys if fam(k) != "when"]
    lead, main = (rest or when or ["?"])[0], None
    for k in rest:
        main = next((nm for nm in catchy_names(k) if nm.lower() not in taken), None)
        if main:
            lead = k
            break
    # A catchy name stands alone (the tags it combines are listed beside the suggestion anyway).
    if main:
        parts = [main]
    else:
        parts = [" & ".join(label(k) for k in rest[:2])] if rest else []
    if when:
        parts.append(" ".join(label(k) for k in when[:2]))
    name = " · ".join(x for x in parts if x)[:60] or "Tagged"
    base, k = name, 2
    while name.lower() in taken:
        name = f"{base} {k}"
        k += 1
    return name, (meta.get(lead) or {}).get("emoji") or "🏷️"
