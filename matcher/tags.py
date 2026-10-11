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
Z_TAG = 2.0          # a concept tags a photo this many standard deviations above the library's usual
CONCEPTS_PER_PHOTO = 3
VISIBLE_MAX = 6      # circles on the sea at once (more is a tangle); the rest wait in the tag tray
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
    "me": ("🙂", "You", "people"), "group_shot": ("👯", "Group shot", "people"), "smiling": ("😄", "Smiling", "people"),
    "bw": ("🎞️", "Black & white", "look"), "dark": ("🌑", "Dark", "look"), "blurry": ("🌫️", "Blurry", "look"),
    "eyes_closed": ("😑", "Eyes closed", "look"), "sunglasses": ("😎", "Sunglasses", "look"),
    "mirror_selfie": ("🪞", "Mirror selfie", "look"), "filter": ("✨", "Face filter", "look"),
    "smoking": ("🚬", "Smoking", "look"), "stunning": ("🌟", "Stunning", "look"),
    "outdoors": ("🌳", "Outdoors", "what"), "night_out": ("🪩", "Night out", "what"), "car_selfie": ("🚙", "In the car", "what"),
    "bed": ("🛏️", "Bed & bathroom", "what"), "dogs": ("🐶", "Dogs", "what"), "text": ("📝", "Text", "what"),
    "night": ("🌙", "Night", "when"),
}
PEOPLE_CONCEPTS = {"friends", "family", "selfie", "portrait", "formal", "serious", "party"}
LOOK_CONCEPTS = {"style", "hat", "glasses", "macro"}
# measured attribute (library.ATTRS) -> (tag, threshold)
ATTR_TAGS = {"sunglasses": ("sunglasses", 0.65), "mirror_selfie": ("mirror_selfie", 0.7), "filter": ("filter", 0.8),
             "smoking": ("smoking", 0.75), "blurry": ("blurry", 0.7), "outdoors": ("outdoors", 0.7),
             "nightlife": ("night_out", 0.75), "car": ("car_selfie", 0.7), "bathroom_bed": ("bed", 0.75),
             "dog": ("dogs", 0.75), "document": ("text", 0.5), "group": ("group_shot", 0.75)}


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

def auto_tags(lib, ident: dict, zs: dict, cats: list, flags: list, keep: np.ndarray, mode: str):
    """Every photo's automatic tags. Returns (meta: key -> (emoji, label, family), per photo: [(key, score)])."""
    n = len(lib.photos)
    per: list[dict[str, float]] = [dict() for _ in range(n)]
    meta: dict[str, tuple[str, str, str]] = dict(FIXED)
    meta["me"] = ("🙂", "You", "people") if mode != "gallery" else ("⭐", "Main character", "people")
    if not n:
        return meta, []
    # what's in it: its kind, and the concepts it stands out for in this library
    for i, c in enumerate(cats):
        if c:
            per[i][f"kind:{c}"] = 1.0
    for c, (emoji, label) in KINDS.items():
        meta[f"kind:{c}"] = (emoji, label, "what")
    cmeta = concept_meta()
    meta.update(cmeta)
    E = lib.emb / np.maximum(np.linalg.norm(lib.emb, axis=1, keepdims=True), 1e-9)
    ok = lib.has_emb
    if ok.any():
        C = themes.concept_scores(E)
        ref = C[ok & keep] if (ok & keep).sum() >= 8 else C[ok]
        Z = (C - ref.mean(0)) / np.maximum(ref.std(0), 1e-6)
        keys = [ALIAS.get(k, k) for k, _, _, _ in themes.CONCEPTS]
        for i in np.flatnonzero(ok):
            top = np.argsort(-Z[i])[:CONCEPTS_PER_PHOTO]
            for j in top:
                if Z[i, j] >= Z_TAG:
                    per[i][keys[j]] = max(per[i].get(keys[j], 0.0), float(Z[i, j]))
    # measured attributes
    for attr, (tag, t) in ATTR_TAGS.items():
        v = zs.get(attr)
        if v is None:
            continue
        for i in np.flatnonzero(np.nan_to_num(v, nan=0.0) >= t):
            per[i][tag] = max(per[i].get(tag, 0.0), float(v[i]))
    a = zs.get("aesthetic")
    if a is not None and ok.sum() >= 10:
        cut = max(0.6, float(np.nanpercentile(np.where(ok, a, np.nan), 90)))
        for i in np.flatnonzero(np.nan_to_num(a, nan=0.0) >= cut):
            per[i]["stunning"] = float(a[i])
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
        if (p.get("n_faces") or 0) >= 3:
            per[i]["group_shot"] = 1.0
        mine = [f for f in fs if f["id"] == me_face.get(pid)] if mode != "gallery" else fs
        smiles = [f.get("smile") or 0.0 for f in mine if f.get("smile") is not None]
        if smiles and max(smiles) > 0.5:
            per[i]["smiling"] = float(max(smiles))
        # how it looks
        fl = flags[i] if i < len(flags) else []
        if "eyes_closed" in fl:
            per[i]["eyes_closed"] = 1.0
        if "blurry" in fl:
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
    with store.tx() as c:
        c.execute("DELETE FROM photo_tags")
        c.executemany("INSERT INTO photo_tags(photo_id, tag, score) VALUES(?,?,?)", rows)
        for key in counts:
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
    for r in store.q("SELECT photo_id, tag FROM photo_tags"):
        out.setdefault(r["photo_id"], set()).add(r["tag"])
    for r in store.q("SELECT photo_id, tag, val FROM tag_edits"):
        s = out.setdefault(r["photo_id"], set())
        (s.add if r["val"] else s.discard)(r["tag"])
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
    """These shots k-means-clustered on their tags (rarer tags and the ones drawn as circles weigh more; broad kinds
    less), k picked by silhouette. Mutually exclusive: every tagged shot lands in exactly one cluster, named for the
    tags that set it apart."""
    reps = sorted(r for r in open_reps if sets.get(r))
    if len(reps) < 2:
        return []
    df = Counter(t for r in reps for t in sets[r])
    vocab = [t for t, c in df.items() if c >= 2 and not t.startswith("y:")] or list(df)
    col = {t: j for j, t in enumerate(vocab)}
    vis = set(visible)
    n = len(reps)
    w = np.array([math.log(1 + n / df[t]) * (1.0 if t in vis else 0.6) * (0.5 if t.startswith("kind:") else 1.0) for t in vocab])
    X = np.zeros((n, len(vocab)), np.float32)
    for i, r in enumerate(reps):
        for t in sets[r]:
            if t in col:
                X[i, col[t]] = w[col[t]]
    keep = np.linalg.norm(X, axis=1) > 0
    reps = [r for r, k in zip(reps, keep) if k]
    X = X[keep]
    n = len(reps)
    if n < 2:
        return []
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    S = X @ X.T

    def kmeans(k):
        rng = np.random.RandomState(0)
        cen = [X[rng.randint(n)]]
        for _ in range(1, k):  # k-means++: spread the starting centres
            d = np.clip(1 - np.max(X @ np.array(cen).T, axis=1), 0, None)  # (rounding can dip below zero)
            cen.append(X[rng.choice(n, p=d / d.sum())] if d.sum() > 1e-9 else X[rng.randint(n)])
        C = np.array(cen)
        lab = np.zeros(n, int)
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
        return lab

    def silhouette(lab):
        D = 1 - S
        out = []
        for i in range(n):
            same = lab == lab[i]
            if same.sum() <= 1:
                out.append(0.0)
                continue
            a = D[i, same].sum() / (same.sum() - 1)
            b = min((D[i, lab == j].mean() for j in set(lab.tolist()) if j != lab[i]), default=a)
            out.append((b - a) / max(a, b, 1e-9))
        return float(np.mean(out))
    best, best_lab = -2.0, np.zeros(n, int)
    for k in range(2, max(2, min(limit, n // 5)) + 1):  # five or more shots a group, on average
        lab = kmeans(k)
        if len(set(lab.tolist())) < 2:
            continue
        sc = silhouette(lab) - 0.015 * k  # a nudge toward fewer, bigger groups
        if sc > best:
            best, best_lab = sc, lab
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


def name_for(keys: list[str], meta: dict[str, dict], taken: set[str]) -> tuple[str, str]:
    """A name for a group of shots sharing these tags: a concept's catchy name if one leads, else the tags' own labels;
    when it was rides along at the end (Golden Hour Gang · Summer 2024)."""
    label = lambda k: (meta.get(k) or {}).get("label") or k  # noqa: E731
    fam = lambda k: (meta.get(k) or {}).get("family")  # noqa: E731
    order = {"season": 0, "y": 1, "day": 2}
    when = sorted((k for k in keys if fam(k) == "when"), key=lambda k: order.get(k.split(":")[0], 3))
    rest = [k for k in keys if fam(k) != "when"]
    catchy = {ALIAS.get(k, k): names for k, _, _, names in themes.CONCEPTS}
    catchy.update({f"kind:{k}": names for k, names in KIND_NAMES.items()})
    lead, main = (rest or when or ["?"])[0], None
    for k in rest:
        main = next((nm for nm in catchy.get(k, []) if nm.lower() not in taken), None)
        if main:
            lead = k
            break
    others = [label(k) for k in rest if k != lead and k != "me"]
    if main:
        parts = [main] + others[:1]
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
