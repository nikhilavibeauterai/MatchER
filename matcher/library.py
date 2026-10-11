"""Derived state, recomputed in well under a second whenever inputs change:

  identity   which detected face is you (the dominant identity in your own camera roll)
  judgment   obvious throw-outs (cut, with a reason) and softer flags
  shots      burst frames and duplicates folded into one tournament item, best frame on top
  scenes     same place/outfit/session, so the shortlist isn't ten frames of one evening
  features   per-shot numbers the ranker learns your taste from, plus a hand-set prior
"""
from __future__ import annotations

import bisect
import hashlib
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

from .config import DEFAULT_SETTINGS, MODELS_DIR, PREVIEW_EDGE
from .store import Store, unblob

DERIVED_VERSION = 6  # bump when refresh() starts producing something new; old libraries refresh on open
ME_T = 0.32          # SFace cosine to your centroid that counts as "you" (strangers in a real library
                     # peaked at 0.10-0.15 and stopped at ~0.30; your own reflections scored 0.35-0.80)
MATCH_T = {"strict": 0.40, "normal": ME_T, "loose": 0.27}  # the People page's "face matching" setting
PERSON_T = 0.45      # same-person threshold for clustering other people
RELIABLE_PX = 40     # faces smaller than this (preview px) are too small to identify

SCREENSHOT_NAME = re.compile(r"screen[\s_-]?(shot|cap|record)|^scr_|_scr\d", re.I)

# Zero-shot attribute prompts for SigLIP: P(attribute) = softmax mass of the positive prompts.
_PHOTO_OF = ["a photograph of a landscape", "a photograph of a person", "a photograph of an animal",
             "a photograph of food", "a photograph of a city", "a photograph of an object"]
ATTRS: dict[str, tuple[str, list[str], list[str]]] = {
    "screenshot": ("full", ["a screenshot of a phone screen", "a screenshot of a text message conversation",
                            "a screenshot of a social media app", "a screenshot of a video call",
                            "a meme with text", "a scanned document"],
                   ["a photograph of a person", "a selfie", "a photo taken with a camera"]),
    "no_person": ("full", ["a photo of a landscape with no people", "a photo of food", "a photo of an object",
                           "a photo of a building", "a photo of an animal", "a photo of a car"],
                  ["a photo of a person", "a selfie", "a photo of a man"]),
    "filter": ("full", ["a selfie with a snapchat face filter", "a photo with cartoon dog ears added",
                        "a photo covered in stickers and emoji"],
               ["a natural photo of a person", "a selfie", "a portrait photo", "a photo of a group of people",
                "a snapshot of people at an event", "a photo of a man"]),
    "sunglasses": ("crop", ["a person wearing sunglasses", "a man wearing dark sunglasses"],
                   ["a person with their eyes visible", "a man wearing clear glasses", "a man's face"]),
    "smoking": ("full", ["a person smoking a cigarette", "a man holding a cigarette", "a person vaping"],
                ["a man's face", "a man holding a drink", "a man holding a phone"]),
    "mirror_selfie": ("full", ["a mirror selfie taken with a phone", "a man photographing himself in a mirror"],
                      ["a selfie taken at arm's length", "a photo of a man taken by someone else"]),
    "car": ("full", ["a selfie taken inside a car"], ["a selfie taken outdoors", "a selfie taken indoors"]),
    "bathroom_bed": ("full", ["a selfie in a bathroom", "a selfie lying in bed"],
                     ["a selfie outdoors", "a selfie in a living room", "a photo in a restaurant"]),
    "nightlife": ("full", ["a photo taken in a dark bar at night", "a photo taken in a nightclub"],
                  ["a photo taken in daylight", "a photo taken at home"]),
    "outdoors": ("full", ["a photo taken outdoors in natural daylight"],
                 ["a photo taken indoors", "a photo taken at night"]),
    "blurry": ("full", ["a blurry out of focus photo", "a photo with motion blur"], ["a sharp, in focus photo"]),
    "great": ("full", ["a great dating profile photo of a smiling man", "a professional portrait with flattering light"],
              ["a bad, unflattering photo", "a low quality phone snapshot"]),
    "dog": ("full", ["a person with a dog"], ["a person"]),
    "group": ("full", ["a group photo of several friends"], ["a photo of one person"]),
    # whole-gallery mode
    "document": ("full", ["a photo of a receipt", "a photo of a printed document", "a photo of a whiteboard with writing",
                          "a photo of a computer screen", "a photo of a paper form", "a QR code",
                          "a photo of a page of text", "a screenshot of a phone screen", "a meme with text"],
                 _PHOTO_OF),
    "accidental": ("full", ["an accidental photo taken inside a pocket", "a completely black photo",
                            "a blurry photo of the floor", "a finger covering the camera lens",
                            "an extremely dark photo where nothing is visible"], _PHOTO_OF),
    "aesthetic": ("full", ["a beautiful, award-winning photograph", "a stunning professional photo with great composition",
                           "a gorgeous photo with beautiful light"],
                  ["a boring, low quality snapshot", "an ugly, badly composed photo", "a dull, poorly lit photo"]),
}

# What a photo is mostly of: each category with enough shots becomes a cup of its own in gallery mode.
CATEGORIES: dict[str, list[str]] = {
    "people": ["a photo of a person", "a portrait of a person", "a selfie", "a group photo of people",
               "people at a party", "a family photo"],
    "nature": ["a landscape photo", "a photo of mountains", "a photo of a beach and the ocean", "a photo of a forest",
               "a sunset", "a photo of a lake", "a photo of flowers"],
    "places": ["a photo of a city street", "a photo of a building", "a city skyline", "a photo of architecture",
               "the inside of a building", "a photo of a monument"],
    "animals": ["a photo of a dog", "a photo of a cat", "a photo of a bird", "a photo of a wild animal", "a photo of a pet"],
    "food": ["a photo of food on a plate", "a photo of a drink", "a cup of coffee", "a photo of a dessert",
             "a meal at a restaurant"],
    "things": ["a photo of an object", "a photo of a car", "a photo of a gadget", "a still life photo",
               "a photo of a painting"],
}

# Hand-set prior: (feature, weight, prior sd of the learned weight). Units are logit "skill".
HAND = [
    ("face_size", 0.35, 0.35), ("eyes_closed", -1.2, 0.6), ("one_eye", -0.4, 0.4), ("smile", 1.0, 0.6),
    ("frontal", 0.4, 0.4), ("face_sharp", 0.25, 0.3), ("exposure", 0.5, 0.4), ("dark", -0.4, 0.4),
    ("others", -0.4, 0.4), ("not_prominent", -0.5, 0.4), ("sunglasses", -0.8, 0.5), ("smoking", -1.0, 0.5),
    ("mirror_selfie", -0.5, 0.4), ("car", -0.4, 0.4), ("bathroom_bed", -0.4, 0.4), ("nightlife", -0.4, 0.4),
    ("outdoors", 0.4, 0.4), ("blurry", -0.6, 0.4), ("great", 0.6, 0.4), ("filter", -1.0, 0.5),
    ("dog", 0.2, 0.3), ("age", -0.15, 0.15), ("low_res", -0.3, 0.3), ("bw", -0.1, 0.3),
]
# Whole-gallery mode: how good a photo is, whatever it shows. Category weights start at zero and are learned,
# so the model finds out whether you rate landscapes above food (and the taste card can say so).
HAND_GALLERY = [
    ("aesthetic", 0.9, 0.5), ("sharp", 0.35, 0.3), ("exposure", 0.35, 0.3), ("dark", -0.4, 0.4),
    ("blurry", -0.6, 0.4), ("colorful", 0.15, 0.3), ("bw", 0.0, 0.3), ("low_res", -0.3, 0.3),
    ("textish", -0.8, 0.5), ("accidental", -1.0, 0.5), ("smile", 0.4, 0.4), ("eyes_closed", -0.8, 0.5),
    ("people", 0.0, 0.4), ("nature", 0.0, 0.4), ("places", 0.0, 0.4), ("animals", 0.0, 0.4), ("food", 0.0, 0.4),
]
PCA_FULL, PCA_CROP, PCA_SD = 24, 12, 0.12


def hand_spec(mode: str) -> list[tuple[str, float, float]]:
    return HAND_GALLERY if mode == "gallery" else HAND

CUT_LABELS = {
    "unreadable": "Couldn't open", "tiny": "Tiny image", "screenshot": "Screenshot / not a photo",
    "no_person": "No person", "no_face": "No visible face", "not_you": "Not you",
    "too_small": "You're too small", "blurry": "Blurry", "exposure": "Badly exposed",
    "excluded_person": "Has someone you excluded", "old": "Too old", "tossed": "Tossed by you",
    "document": "Document / receipt / text", "accidental": "Accidental shot",
}


# Auto-crop: every photo framed the same way around your face (the UI fades whatever falls outside).
FRAME_FACES = 3.6    # frame height, in face heights: head, shoulders, a little torso
FRAME_ASPECT = 0.8   # 4:5 portrait, like a dating-app card
FACE_LINE = 0.36     # the face centre sits this far down the frame


def _num(v, default: float) -> float:
    """A stored measurement, or `default` when there is none (0.0 is a real value: a grey photo has chroma 0)."""
    return default if v is None else v


def subject_box(pw: int, ph: int, face: dict | None) -> list[float] | None:
    """[x, y, w, h] of the frame, normalized to the photo. Kept inside the photo where it fits;
    where the frame is bigger than the photo it's centred (the UI clamps it to the photo)."""
    if not face:
        return None
    ch = FRAME_FACES * face["h"] * ph
    cw = ch * FRAME_ASPECT
    x0 = (face["x"] + face["w"] / 2) * pw - cw / 2
    y0 = (face["y"] + face["h"] / 2) * ph - FACE_LINE * ch
    x0 = (pw - cw) / 2 if cw >= pw else min(max(0.0, x0), pw - cw)
    y0 = (ph - ch) / 2 if ch >= ph else min(max(0.0, y0), ph - ch)
    return [round(x0 / pw, 4), round(y0 / ph, 4), round(cw / pw, 4), round(ch / ph, 4)]


def preview_size(w: int, h: int) -> tuple[int, int]:
    s = min(1.0, PREVIEW_EDGE / max(w, h, 1))
    return max(1, round(w * s)), max(1, round(h * s))


def _norm(v: np.ndarray) -> np.ndarray:
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9)


# ----------------------------------------------------------------------------- loading

@dataclass
class Lib:
    photos: list[dict]
    faces: list[dict]
    pidx: dict[int, int]
    faces_by_photo: dict[int, list[int]]
    emb: np.ndarray        # (n, 768) full-image SigLIP, zeros if missing
    has_emb: np.ndarray
    crop: np.ndarray       # (n, 768) upper-body crop SigLIP
    has_crop: np.ndarray
    femb: np.ndarray       # (m, 128) face identity embeddings


def load(store: Store) -> Lib:
    photos = [dict(r) for r in store.q(
        "SELECT id, rel, status, error, size, sha256, width, height, fmt, make, model, taken, taken_ts, taken_src, "
        "phash, luma, luma_lo, luma_hi, sharp, chroma, n_faces, emb, crop_emb, crop_face, override, rep_pref, pick, "
        "stack_key FROM photos WHERE status IN ('analyzed', 'error') ORDER BY id")]
    faces = [dict(r) for r in store.q(
        "SELECT f.* FROM faces f JOIN photos p ON p.id = f.photo_id WHERE p.status='analyzed' ORDER BY f.id")]
    pidx = {p["id"]: i for i, p in enumerate(photos)}
    n = len(photos)
    emb = np.zeros((n, 768), np.float32)
    crop = np.zeros((n, 768), np.float32)
    has_emb = np.zeros(n, bool)
    has_crop = np.zeros(n, bool)
    for i, p in enumerate(photos):
        e = unblob(p.pop("emb"))
        if e is not None:
            emb[i], has_emb[i] = e, True
        c = unblob(p.pop("crop_emb"))
        if c is not None:
            crop[i], has_crop[i] = c, True
        p["pw"], p["ph"] = preview_size(p["width"] or 1, p["height"] or 1)
    fbp: dict[int, list[int]] = {}
    femb = np.zeros((len(faces), 128), np.float32)
    for j, f in enumerate(faces):
        femb[j] = unblob(f.pop("emb"), np.float32)
        fbp.setdefault(f["photo_id"], []).append(j)
        p = photos[pidx[f["photo_id"]]]
        f["px"] = min(f["w"] * p["pw"], f["h"] * p["ph"])
    return Lib(photos, faces, pidx, fbp, emb, has_emb, crop, has_crop, femb)


# ----------------------------------------------------------------------------- identity

def identify(lib: Lib, store: Store) -> dict:
    """Your face = the dominant identity across your own photos (plus any People-page corrections)."""
    settings = store.get_meta("settings", {}) or {}
    ME_T = MATCH_T.get(settings.get("match", "normal"), MATCH_T["normal"])
    faces, E = lib.faces, lib.femb
    me_face = {p["id"]: None for p in lib.photos}
    me_sim = {p["id"]: None for p in lib.photos}
    person = np.full(len(faces), -1)
    if not len(faces):
        return {"me_face": me_face, "me_sim": me_sim, "person": person, "centroid": None, "people": [],
                "is_me": np.zeros(0, bool)}
    anchors_me = [np.asarray(a, np.float32) for a in store.get_meta("me_anchors", [])]
    anchors_not = [np.asarray(a, np.float32) for a in store.get_meta("not_me_anchors", [])]
    reliable = np.array([f["px"] >= RELIABLE_PX for f in faces])
    idx = np.flatnonzero(reliable) if reliable.sum() >= 3 else np.arange(len(faces))
    R = E[idx]
    blocked = np.zeros(len(faces), bool)
    for a in anchors_not:
        blocked |= (E @ a) >= ME_T + 0.05
    counts = np.zeros(len(idx), np.int64)
    for b0 in range(0, len(idx), 2048):  # how many faces each face matches, a block of rows at a time
        counts[b0:b0 + 2048] = ((R[b0:b0 + 2048] @ R.T) >= ME_T).sum(1)
    counts -= blocked[idx] * 10**6
    seed = int(np.argmax(counts))
    member = ((R @ R[seed]) >= ME_T) & ~blocked[idx]
    centroid = _norm(R[member].mean(0))
    for _ in range(4):
        sim = R @ centroid
        member = (sim >= ME_T) & ~blocked[idx]
        for a in anchors_me:
            member |= (R @ a) >= ME_T + 0.05
        if member.sum() == 0:
            break
        centroid = _norm(R[member].mean(0))
    sim_all = E @ centroid
    for a in anchors_me:
        sim_all = np.maximum(sim_all, E @ a)
    is_me = (sim_all >= ME_T) & ~blocked
    # Borderline matches must at least look like a real face: confident detection or readable landmarks.
    # (Hands, textures and half-faces scored 0.32-0.40 in testing; your own faces there almost always pass.)
    shaky = np.array([f["score"] < 0.75 and f.get("blink_l") is None for f in faces])
    is_me &= ~((sim_all < 0.40) & shaky)
    for j, f in enumerate(faces):
        if f.get("label") == "me":
            is_me[j], sim_all[j] = True, max(sim_all[j], 1.0)
        elif f.get("label") == "other":
            is_me[j] = False
    for pid, js in lib.faces_by_photo.items():
        best = max(js, key=lambda j: sim_all[j])
        me_sim[pid] = float(sim_all[best])
        if is_me[best]:
            me_face[pid] = faces[best]["id"]
            person[best] = 0

    # Other recurring people (for the People page and "exclude this person").
    others = [j for j in np.argsort([-f["px"] for f in faces]) if not is_me[j] and faces[j]["px"] >= RELIABLE_PX]
    leaders: list[int] = []
    LE = np.zeros((len(others), E.shape[1]), np.float32)
    for j in others:
        if leaders:
            s = LE[:len(leaders)] @ E[j]
            k = int(np.argmax(s))
            if s[k] >= PERSON_T:
                person[j] = k + 1
                continue
        LE[len(leaders)] = E[j]
        leaders.append(j)
        person[j] = len(leaders)
    people = []
    for k, lead in enumerate(leaders, start=1):
        js = np.flatnonzero(person == k)
        photos_k = {faces[j]["photo_id"] for j in js}
        if len(photos_k) >= 3:
            sample = sorted(js, key=lambda j: -faces[j]["px"])[:6]
            # keyed by the leading face's id, which survives a refresh (a list position wouldn't)
            people.append({"key": int(faces[lead]["id"]), "n_photos": len(photos_k), "faces": [int(faces[j]["id"]) for j in sample],
                           "centroid": _norm(E[js].mean(0)).tolist()})
        else:
            person[js] = -1
    people.sort(key=lambda p: -p["n_photos"])
    return {"me_face": me_face, "me_sim": me_sim, "person": person, "centroid": centroid, "people": people,
            "is_me": is_me, "keys": [int(faces[lead]["id"]) for lead in leaders]}


# ----------------------------------------------------------------------------- zero-shot attributes

def _prompt_embeddings(prompts: list[str]) -> np.ndarray:
    cache = MODELS_DIR / "prompt_cache.npz"
    keys = [hashlib.sha1(p.encode()).hexdigest() for p in prompts]
    stored: dict[str, np.ndarray] = {}
    try:
        with np.load(cache) as z:
            stored = {k: z[k] for k in z.files}
    except (OSError, ValueError):
        pass
    todo = [p for p, k in zip(prompts, keys) if k not in stored]
    if todo:
        from .vision import SigLIP

        sig = SigLIP(threads=6, text=True)
        for p, e in zip(todo, sig.embed_texts(todo)):
            stored[hashlib.sha1(p.encode()).hexdigest()] = e
        try:
            np.savez(cache, **stored)
        except OSError:
            pass
    return np.stack([stored[k] for k in keys]).astype(np.float32)


def zero_shot(lib: Lib) -> dict[str, np.ndarray]:
    from .models import SIGLIP_LOGIT_SCALE

    prompts = sorted({p for _, pos, neg in ATTRS.values() for p in pos + neg})
    T = _prompt_embeddings(prompts)
    col = {p: i for i, p in enumerate(prompts)}
    out = {}
    for name, (src, pos, neg) in ATTRS.items():
        X, ok = (lib.emb, lib.has_emb) if src == "full" else (lib.crop, lib.has_crop)
        ids = [col[p] for p in pos + neg]
        logits = SIGLIP_LOGIT_SCALE * (X @ T[ids].T)
        logits -= logits.max(1, keepdims=True)
        prob = np.exp(logits)
        prob = prob[:, :len(pos)].sum(1) / prob.sum(1)
        out[name] = np.where(ok, prob, np.nan)
    return out


def categorize(lib: Lib) -> list[str]:
    """What each photo is mostly of (a CATEGORIES key; "" without an embedding). A clearly visible face tips
    a photo toward people."""
    from .models import SIGLIP_LOGIT_SCALE

    keys = list(CATEGORIES)
    prompts = [q for k in keys for q in CATEGORIES[k]]
    T = _prompt_embeddings(prompts)
    logits = SIGLIP_LOGIT_SCALE * (lib.emb @ T.T)
    logits -= logits.max(1, keepdims=True)
    prob = np.exp(logits)
    prob /= prob.sum(1, keepdims=True)
    edges = np.cumsum([0] + [len(CATEGORIES[k]) for k in keys])
    per = np.stack([prob[:, edges[k]:edges[k + 1]].sum(1) for k in range(len(keys))], 1)
    face = np.array([any(lib.faces[j]["px"] >= 60 for j in lib.faces_by_photo.get(p["id"], [])) for p in lib.photos])
    if len(face):
        per[:, keys.index("people")] += 0.35 * face
    return [keys[k] if lib.has_emb[i] else "" for i, k in enumerate(per.argmax(1))] if len(per) else []


# ----------------------------------------------------------------------------- judgment

def judge(lib: Lib, ident: dict, zs: dict, settings: dict, excluded: list[np.ndarray]) -> tuple[list, list, dict]:
    """Per photo: a cut reason (or None), soft flags, and the measurements the prior uses."""
    if settings.get("mode") == "gallery":
        return _judge_gallery(lib, zs, settings)
    now = time.time()
    cuts, flags, measures = [], [], {}
    face_by_id = {f["id"]: (j, f) for j, f in enumerate(lib.faces)}
    max_age = float(settings.get("max_age_years") or 0)
    for i, p in enumerate(lib.photos):
        pid = p["id"]
        fl: list[str] = []
        m = {k: float(v[i]) if not np.isnan(v[i]) else None for k, v in zs.items()}
        cut = None
        name = p["rel"].rsplit("/", 1)[-1]
        js = lib.faces_by_photo.get(pid, [])
        me = face_by_id.get(ident["me_face"].get(pid)) if ident["me_face"].get(pid) else None
        age = (now - p["taken_ts"]) / (365.25 * 86400) if p.get("taken_ts") else None
        if p["status"] == "error":
            cut = "unreadable"
        elif min(p["width"] or 0, p["height"] or 0) < 400:
            cut = "tiny"
        elif SCREENSHOT_NAME.search(name) or ((m.get("screenshot") or 0) > 0.85 and not p.get("make")):
            cut = "screenshot"
        elif excluded and any(float(lib.femb[j] @ a) >= PERSON_T for j in js for a in excluded):
            cut = "excluded_person"
        elif not js:
            cut = "no_person" if (m.get("no_person") or 0) > 0.6 else "no_face"
        elif me is None:
            cut = "not_you" if any(lib.faces[j]["px"] >= 48 for j in js) else "no_face"
        else:
            j, f = me
            if f["h"] < 0.025:
                cut = "too_small"
            elif f["px"] >= 80 and (f["sharp"] or 0) < 8 and (p["sharp"] or 0) < 15:
                cut = "blurry"
            elif f["luma"] is not None and (f["luma"] < 28 or f["luma"] > 240):
                cut = "exposure"
        if cut is None and max_age and age is not None and age > max_age:
            cut = "old"

        # soft flags + measurements (also computed for cut photos, for display)
        if me is not None:
            j, f = me
            bl, br = f.get("blink_l"), f.get("blink_r")
            if bl is not None:
                lo, hi = min(bl, br), max(bl, br)
                if lo >= 0.55:
                    fl.append("eyes_closed")
                elif hi >= 0.6 and lo < 0.4:
                    fl.append("one_eye")
            # other faces that are also you (mirror reflections, a photo of you in frame) don't count
            strangers = [k for k in js if k != j and not ident["is_me"][k]]
            others = [k for k in strangers if lib.faces[k]["px"] >= 0.5 * f["px"]]
            if len(others) >= 2:
                fl.append("group")
            elif others:
                fl.append("with_someone")
            if any(lib.faces[k]["px"] > 1.3 * f["px"] for k in strangers):
                fl.append("not_prominent")
            if f.get("yaw") is not None and abs(f["yaw"]) > 45:
                fl.append("profile")
            if f["h"] < 0.08:
                fl.append("full_body")
        # Display flags only when the zero-shot model is fairly sure; the raw scores feed the prior regardless.
        for attr, thr in (("sunglasses", 0.65), ("smoking", 0.75), ("mirror_selfie", 0.7), ("car", 0.7),
                          ("bathroom_bed", 0.75), ("nightlife", 0.75), ("filter", 0.8), ("dog", 0.75)):
            if (m.get(attr) or 0) >= thr:
                fl.append(attr)
        if _num(p.get("chroma"), 99) < 3.5:
            fl.append("bw")
        if age is not None and age >= 3:
            fl.append("old")
        if _num(p.get("luma"), 128) < 55:
            fl.append("dark")
        if p.get("override") == "keep" and cut:
            fl.append("rescued:" + cut)
            cut = None
        if p.get("override") == "toss":
            cut = "tossed"
        cuts.append(cut)
        flags.append(fl)
        measures[pid] = {"zs": m, "me": me[1] if me else None, "age": age}
    return cuts, flags, measures


def _judge_gallery(lib: Lib, zs: dict, settings: dict) -> tuple[list, list, dict]:
    """Whole-gallery mode: no "is it you" rules, only what nobody keeps (screens, documents, pocket shots,
    hopeless blur or exposure). The subject is the most prominent face, if there is one."""
    now = time.time()
    max_age = float(settings.get("max_age_years") or 0)
    cuts, flags, measures = [], [], {}
    for i, p in enumerate(lib.photos):
        pid = p["id"]
        m = {k: float(v[i]) if not np.isnan(v[i]) else None for k, v in zs.items()}
        name = p["rel"].rsplit("/", 1)[-1]
        face = max((lib.faces[j] for j in lib.faces_by_photo.get(pid, [])), key=lambda f: f["px"], default=None)
        face = face if face is not None and face["px"] >= 48 else None
        age = (now - p["taken_ts"]) / (365.25 * 86400) if p.get("taken_ts") else None
        luma = p.get("luma")
        cut = None
        if p["status"] == "error":
            cut = "unreadable"
        elif min(p["width"] or 0, p["height"] or 0) < 400:
            cut = "tiny"
        elif SCREENSHOT_NAME.search(name) or ((m.get("screenshot") or 0) > 0.85 and not p.get("make")):
            cut = "screenshot"
        elif (m.get("document") or 0) > 0.9:
            cut = "document"
        elif (luma is not None and luma < 14) or ((m.get("accidental") or 0) > 0.85
                                                  and (_num(luma, 128) < 45 or _num(p.get("sharp"), 1e9) < 60)):
            cut = "accidental"  # the scene model alone isn't enough: it also has to be dark or a smear
        elif _num(p.get("sharp"), 1e9) < 25 and (m.get("blurry") or 0) > 0.8:
            cut = "blurry"
        elif luma is not None and luma > 245:
            cut = "exposure"
        if cut is None and max_age and age is not None and age > max_age:
            cut = "old"
        fl: list[str] = []
        if face is not None and face["h"] >= 0.12 and face.get("blink_l") is not None:
            if min(face["blink_l"], face["blink_r"]) >= 0.55:
                fl.append("eyes_closed")
        if (m.get("blurry") or 0) >= 0.7:
            fl.append("blurry")
        if (m.get("document") or 0) >= 0.5 and cut is None:
            fl.append("text")
        if _num(p.get("chroma"), 99) < 3.5:
            fl.append("bw")
        if _num(luma, 128) < 55:
            fl.append("dark")
        if p.get("override") == "keep" and cut:
            fl.append("rescued:" + cut)
            cut = None
        if p.get("override") == "toss":
            cut = "tossed"
        cuts.append(cut)
        flags.append(fl)
        measures[pid] = {"zs": m, "me": face, "age": age}
    return cuts, flags, measures


def hand_features(lib: Lib, measures: dict, flags: list, mode: str = "me", cats: list[str] | None = None) -> np.ndarray:
    """Rows of the mode's hand-set features for every photo (natural scales, roughly 0..1)."""
    if mode == "gallery":
        return _hand_gallery(lib, measures, flags, cats or [""] * len(lib.photos))
    X = np.zeros((len(lib.photos), len(HAND)), np.float32)
    names = [h[0] for h in HAND]
    fs = []
    for i, p in enumerate(lib.photos):
        f = measures[p["id"]]["me"]
        fs.append(np.log1p(f["sharp"]) if f and f.get("sharp") is not None else np.nan)
    fs = np.array(fs, np.float64)
    mu, sd = np.nanmean(fs) if np.isfinite(fs).any() else 0.0, np.nanstd(fs) if np.isfinite(fs).any() else 1.0
    for i, p in enumerate(lib.photos):
        meas = measures[p["id"]]
        f, zs = meas["me"], meas["zs"]
        v = dict.fromkeys(names, 0.0)
        if f:
            v["face_size"] = float(np.clip(np.log10(max(f["w"] * f["h"], 1e-4)) + 1.5, -1.5, 1.2))
            if f.get("blink_l") is not None:
                lo, hi = sorted((f["blink_l"], f["blink_r"]))
                v["eyes_closed"] = float(np.clip((lo - 0.3) / 0.4, 0, 1))
                v["one_eye"] = float(np.clip((hi - lo - 0.25) / 0.4, 0, 1))
                v["smile"] = float(np.clip(f["smile"], 0, 1))
                v["frontal"] = float(1 - min(abs(f["yaw"]), 60) / 60)
            if np.isfinite(fs[i]):
                v["face_sharp"] = float(np.clip((fs[i] - mu) / (sd + 1e-9), -2.5, 2.5))
            if f.get("luma") is not None:
                v["exposure"] = float(-min(abs(f["luma"] - 135) / 60, 2.0))
        v["dark"] = float(np.clip((60 - _num(p.get("luma"), 128)) / 40, 0, 1))
        fl = flags[i]
        v["others"] = 1.0 if "group" in fl else 0.5 if "with_someone" in fl else 0.0
        v["not_prominent"] = 1.0 if "not_prominent" in fl else 0.0
        for k in ("sunglasses", "smoking", "mirror_selfie", "car", "bathroom_bed", "nightlife", "outdoors",
                  "blurry", "great", "filter", "dog"):
            v[k] = float(zs.get(k) or 0.0)
        v["age"] = float(np.clip((meas["age"] or 0) - 1, 0, 7))
        v["low_res"] = 1.0 if min(p["width"] or 0, p["height"] or 0) < 1000 else 0.0
        v["bw"] = 1.0 if "bw" in fl else 0.0
        X[i] = [v[k] for k in names]
    return X


def _hand_gallery(lib: Lib, measures: dict, flags: list, cats: list[str]) -> np.ndarray:
    names = [h[0] for h in HAND_GALLERY]
    X = np.zeros((len(lib.photos), len(names)), np.float32)
    ls = np.array([np.log1p(p["sharp"]) if p.get("sharp") is not None else np.nan for p in lib.photos], np.float64)
    ok = np.isfinite(ls)
    mu, sd = (ls[ok].mean(), ls[ok].std()) if ok.any() else (0.0, 1.0)
    for i, p in enumerate(lib.photos):
        meas = measures[p["id"]]
        zs, f, fl = meas["zs"], meas["me"], flags[i]
        v = dict.fromkeys(names, 0.0)
        v["aesthetic"] = float(zs.get("aesthetic") or 0.0)
        if ok[i]:
            v["sharp"] = float(np.clip((ls[i] - mu) / (sd + 1e-9), -2.5, 2.5))
        luma = p.get("luma")
        if luma is not None:
            v["exposure"] = float(-min(abs(luma - 120) / 70, 2.0))
            v["dark"] = float(np.clip((60 - luma) / 40, 0, 1))
        v["blurry"] = float(zs.get("blurry") or 0.0)
        v["colorful"] = float(np.clip(_num(p.get("chroma"), 0) / 40, 0, 1.2))
        v["bw"] = 1.0 if "bw" in fl else 0.0
        v["low_res"] = 1.0 if min(p["width"] or 0, p["height"] or 0) < 1000 else 0.0
        v["textish"] = float(max(zs.get("document") or 0.0, zs.get("screenshot") or 0.0))
        v["accidental"] = float(zs.get("accidental") or 0.0)
        if f is not None and f["h"] >= 0.12 and f.get("blink_l") is not None:  # a portrait: the face matters
            v["eyes_closed"] = float(np.clip((min(f["blink_l"], f["blink_r"]) - 0.3) / 0.4, 0, 1))
            v["smile"] = float(np.clip(f.get("smile") or 0.0, 0, 1))
        if cats[i] in v:
            v[cats[i]] = 1.0
        X[i] = [v[k] for k in names]
    return X


LOOKALIKE_T = 0.86  # average similarity at which shots count as look-alikes on the Groups page
LOOKALIKE_MAX = 2500  # shots seriated together; more are done in consecutive stretches


def lookalike_order(E: np.ndarray, tau: float = LOOKALIKE_T) -> tuple[list[int], list[int]]:
    """Order shots so look-alikes sit side by side: average-linkage clustering of their embeddings (nearest-
    neighbour chain, O(n^2)), read off in tree order with each merge oriented so the most similar ends meet.
    Returns (order, family): `family[i]` is shared by shots whose clusters joined at similarity >= tau."""
    n = len(E)
    if n > LOOKALIKE_MAX:  # callers pass shots in time order; look-alikes are found within each stretch
        order: list[int] = []
        family: list[int] = [0] * n
        for c0 in range(0, n, LOOKALIKE_MAX):
            o, f = lookalike_order(E[c0:c0 + LOOKALIKE_MAX], tau)
            order += [c0 + i for i in o]
            for i, fam in enumerate(f):
                family[c0 + i] = c0 + fam
        return order, family
    if n < 2:
        return list(range(n)), list(range(n))
    S0 = E @ E.T
    S = S0.astype(np.float64)
    np.fill_diagonal(S, -np.inf)
    size = np.ones(n)
    alive = np.ones(n, bool)
    runs = {i: [i] for i in range(n)}   # each cluster's shots, in display order
    up = list(range(n))                 # union-find over shots, for families

    def find(i: int) -> int:
        while up[i] != i:
            up[i] = up[up[i]]
            i = up[i]
        return i

    chain: list[int] = []
    left = n
    while left > 1:
        if not chain:
            chain.append(int(np.argmax(alive)))
        a = chain[-1]
        b = int(np.argmax(S[a]))
        if len(chain) > 1 and S[a, chain[-2]] >= S[a, b]:
            b = chain[-2]
        if len(chain) == 1 or b != chain[-2]:
            chain.append(b)
            continue
        chain.pop()
        chain.pop()
        A, B = runs[a], runs.pop(b)
        ends = [(S0[A[-1], B[0]], A, B), (S0[A[-1], B[-1]], A, B[::-1]),
                (S0[A[0], B[0]], A[::-1], B), (S0[A[0], B[-1]], A[::-1], B[::-1])]
        _, A, B = max(ends, key=lambda e: e[0])
        runs[a] = A + B
        if S[a, b] >= tau:
            up[find(B[0])] = find(A[0])
        S[a] = (size[a] * S[a] + size[b] * S[b]) / (size[a] + size[b])
        S[:, a] = S[a]
        S[a, a] = -np.inf
        S[b] = -np.inf
        S[:, b] = -np.inf
        alive[b] = False
        size[a] += size[b]
        left -= 1
    return runs[int(np.argmax(alive))], [find(i) for i in range(n)]


def _pca_fit(fit: np.ndarray, k: int) -> dict | None:
    """Top-k principal axes of `fit`, scaled so each component has unit spread over `fit`."""
    if len(fit) < 3:
        return None
    mean = fit.mean(0)
    Xc = (fit - mean).astype(np.float64)
    _, vecs = np.linalg.eigh(Xc.T @ Xc)  # 768x768, far cheaper than an SVD of every shot
    basis = vecs[:, ::-1][:, :k].T
    return {"mean": mean, "basis": basis, "scale": (Xc @ basis.T).std(0) + 1e-9}


def _pca_apply(model: dict | None, X: np.ndarray, k: int) -> np.ndarray:
    out = np.zeros((len(X), k), np.float32)
    if model is not None and len(X):
        Z = ((X - model["mean"]) @ model["basis"].T) / model["scale"]
        out[:, :Z.shape[1]] = Z
    return out


# ----------------------------------------------------------------------------- shots and scenes

def _hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


SIMS_MAX = 6000      # kept photos up to which every pair's similarity is held in memory (144 MB)
BURST_WINDOW = 2 * 3600  # past SIMS_MAX, look-alike checks only reach this far in time (exact copies: any time)


def _group_big(lib: Lib, order: list[int]) -> list[list[int]]:
    """group_shots for libraries too big for the all-pairs matrix. Exact and near-exact copies are found by
    hash at any distance in time; look-alike frames only among stack leaders within BURST_WINDOW (photos
    without a time are compared with the other undated leaders). Same rules otherwise."""
    E = lib.emb
    groups: dict[int, list[int]] = {}
    by_sha: dict[str, int] = {}
    ph_leads: list[int] = []
    ph_vals = np.zeros(len(order), np.uint64)  # leaders' perceptual hashes, filled as they appear
    LE = np.zeros((len(order), E.shape[1]), np.float32)
    t_keys: list[float] = []
    t_lead: list[int] = []
    undated: list[int] = []
    nl = 0
    lead_of: list[int] = []
    for i in order:
        p = lib.photos[i]
        home = None
        if p.get("sha256") and p["sha256"] in by_sha:
            home = by_sha[p["sha256"]]
        ph = int(p["phash"], 16) if p.get("phash") else None
        if home is None and ph is not None and ph_leads:
            d = np.bitwise_count(ph_vals[:len(ph_leads)] ^ np.uint64(ph))
            k = int(np.argmin(d))
            if d[k] <= 6:
                home = ph_leads[k]
        if home is None and lib.has_emb[i]:
            ts = p.get("taken_ts")
            if ts:
                a, b = bisect.bisect_left(t_keys, ts - BURST_WINDOW), bisect.bisect_right(t_keys, ts + BURST_WINDOW)
                cand = t_lead[a:b]
            else:
                cand = undated
            if cand:
                cos = LE[cand] @ E[i]
                for k in np.argsort(-cos)[:12]:
                    li = lead_of[cand[k]]
                    q = lib.photos[li]
                    if not lib.has_emb[li]:
                        continue
                    burst = (cos[k] >= 0.90 and ts and q.get("taken_ts") and abs(ts - q["taken_ts"]) <= 30)
                    if cos[k] >= 0.975 or burst:
                        home = li
                        break
        if home is not None:
            groups[home].append(i)
            continue
        groups[i] = [i]
        LE[nl] = E[i]
        lead_of.append(i)
        if p.get("sha256"):
            by_sha.setdefault(p["sha256"], i)
        if ph is not None:
            ph_vals[len(ph_leads)] = ph
            ph_leads.append(i)
        if p.get("taken_ts"):
            k = bisect.bisect_right(t_keys, p["taken_ts"])
            t_keys.insert(k, p["taken_ts"])
            t_lead.insert(k, nl)
        else:
            undated.append(nl)
        nl += 1
    return list(groups.values())


COPY_SECONDS = 1    # two photos taken within this of each other and COPY_SIM alike are one photo: an edited copy, a crop
COPY_SIM = 0.85     # or an export keeps the original's capture time while its pixels change too much for the hash
STACK_CAP = 60      # a stack built by joining stacks stops growing here


def _belong(lib: Lib, i: int, j: int, cos: float) -> bool:
    """Whether two frames are the same shot by the stacking rules (the frame-to-leader ones, plus same capture time)."""
    p, q = lib.photos[i], lib.photos[j]
    if p.get("sha256") and p["sha256"] == q.get("sha256"):
        return True
    if p.get("phash") and q.get("phash") and _hamming(int(p["phash"], 16), int(q["phash"], 16)) <= 6:
        return True
    if not (lib.has_emb[i] and lib.has_emb[j]):
        return False
    ti, tj = p.get("taken_ts"), q.get("taken_ts")
    dt = abs(ti - tj) if ti and tj else None
    return cos >= 0.975 or (dt is not None and ((cos >= 0.90 and dt <= 30) or (cos >= COPY_SIM and dt <= COPY_SECONDS)))


def join_stacks(lib: Lib, groups: list[list[int]], dismissed=frozenset(), cap: int = STACK_CAP) -> list[list[int]]:
    """Second pass over the automatic stacks: two stacks become one when any frame of one belongs with any frame of the
    other (the _belong rules). Leader-based stacking misses these: a long burst drifts away from its first frame and
    starts a second stack, and an edited copy or a crop changes the pixels. Candidates are stacks close in look or
    within a minute of each other; the strongest matches join first, a pair of photos you said aren't the same shot
    never ends up in one stack, and a stack stops at `cap` frames."""
    n = len(groups)
    if n < 2:
        return groups
    E = lib.emb
    stack_of = np.full(len(lib.photos), -1, np.int64)
    for k, g in enumerate(groups):
        stack_of[g] = k
    cen = np.zeros((n, E.shape[1]), np.float32)
    for k, g in enumerate(groups):
        m = [i for i in g if lib.has_emb[i]]
        if m:
            v = E[m].mean(0)
            cen[k] = v / max(float(np.linalg.norm(v)), 1e-9)
    pa, pb = [], []
    span = sorted((min(ts), max(ts), k) for k, g in enumerate(groups)
                  if (ts := [lib.photos[i]["taken_ts"] for i in g if lib.photos[i].get("taken_ts")]))

    def nearest(rows: np.ndarray, cols: np.ndarray) -> None:  # each row stack's few most alike among cols
        kk = min(8, len(cols) - 1)
        if kk < 1:
            return
        for b0 in range(0, len(rows), 1024):
            r = rows[b0:b0 + 1024]
            S = cen[r] @ cen[cols].T
            S[r[:, None] == cols[None, :]] = -1
            nb = np.argpartition(-S, kk - 1, axis=1)[:, :kk]
            ok = np.take_along_axis(S, nb, 1) >= 0.80
            pa.append(np.repeat(r, kk)[ok.ravel()])
            pb.append(cols[nb.ravel()[ok.ravel()]])
    if n <= SIMS_MAX:  # close in look, anywhere in the library
        nearest(np.arange(n), np.arange(n))
    else:  # a big library: close in look within BURST_WINDOW (undated stacks among themselves), as _group_big does
        starts = [x[0] for x in span]
        dated = np.array([x[2] for x in span], np.int64)
        for x, (t0, _, k) in enumerate(span):
            lo, hi = bisect.bisect_left(starts, t0 - BURST_WINDOW), bisect.bisect_right(starts, t0 + BURST_WINDOW)
            nearest(np.array([k]), dated[lo:hi])
        undated = np.array(sorted(set(range(n)) - set(dated.tolist())), np.int64)
        for c0 in range(0, len(undated), SIMS_MAX):
            chunk = undated[c0:c0 + SIMS_MAX]
            nearest(chunk, chunk)
    for x in range(len(span)):  # close in time: time ranges within a minute of each other
        for y in range(x + 1, len(span)):
            if span[y][0] - span[x][1] > 60:
                break
            pa.append(np.array([span[x][2]]))
            pb.append(np.array([span[y][2]]))
    by_sha: dict[str, int] = {}  # identical files anywhere
    for k, g in enumerate(groups):
        for i in g:
            sha = lib.photos[i].get("sha256")
            if sha and by_sha.setdefault(sha, k) != k:
                pa.append(np.array([by_sha[sha]]))
                pb.append(np.array([k]))
    if not pa:
        return groups
    a, b = np.concatenate(pa), np.concatenate(pb)
    pairs = np.unique(np.stack([np.minimum(a, b), np.maximum(a, b)], 1), axis=0)
    pairs = pairs[pairs[:, 0] != pairs[:, 1]]
    if not len(pairs):
        return groups
    # every frame pair of every candidate stack pair, checked at once
    sizes = np.array([len(g) for g in groups])
    fi, fj, pk = [], [], []
    for k, (x, y) in enumerate(pairs):
        A, B = groups[x], groups[y]
        if len(A) == 1 and len(B) == 1:
            fi.append(A[0]); fj.append(B[0]); pk.append(k)
        else:
            for i in A:
                for j in B:
                    fi.append(i); fj.append(j); pk.append(k)
    fi, fj, pk = np.array(fi), np.array(fj), np.array(pk)
    cos = np.einsum("ij,ij->i", E[fi], E[fj])
    sha = np.array([hash(p.get("sha256")) if p.get("sha256") else -1 for p in lib.photos], np.int64)
    ph = np.array([int(p["phash"], 16) if p.get("phash") else 0 for p in lib.photos], np.uint64)
    has_ph = np.array([bool(p.get("phash")) for p in lib.photos])
    ts = np.array([p.get("taken_ts") or np.nan for p in lib.photos], float)
    dt = np.abs(ts[fi] - ts[fj])
    both = lib.has_emb[fi] & lib.has_emb[fj]
    belong = ((sha[fi] == sha[fj]) & (sha[fi] != -1)) \
        | (has_ph[fi] & has_ph[fj] & (np.bitwise_count(ph[fi] ^ ph[fj]) <= 6)) \
        | (both & ((cos >= 0.975) | ((cos >= 0.90) & (dt <= 30)) | ((cos >= COPY_SIM) & (dt <= COPY_SECONDS))))
    if not belong.any():
        return groups
    best = np.full(len(pairs), -np.inf)
    np.maximum.at(best, pk[belong], np.where(both[belong], cos[belong], 1.0))
    found = [(best[k], int(pairs[k, 0]), int(pairs[k, 1])) for k in np.flatnonzero(np.isfinite(best))]
    no = {frozenset(map(int, d)) for d in dismissed}
    up = list(range(n))
    members = {k: [int(lib.photos[i]["id"]) for i in g] for k, g in enumerate(groups)}

    def find(k: int) -> int:
        while up[k] != k:
            up[k] = up[up[k]]
            k = up[k]
        return k

    for _, x, y in sorted(found, reverse=True):
        rx, ry = find(x), find(y)
        if rx == ry or len(members[rx]) + len(members[ry]) > cap:
            continue
        if no and any(frozenset((p, q)) in no for p in members[rx] for q in members[ry]):
            continue
        up[ry] = rx
        members[rx] += members.pop(ry)
    joined: dict[int, list[int]] = {}
    for k, g in enumerate(groups):
        joined.setdefault(find(k), []).extend(g)
    return list(joined.values())


def similarities(lib: Lib, keep: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Cosine of every pair of kept photos, for group_shots (and reused by regroup). None for a library
    too big to hold them all; group_shots then goes photo by photo."""
    idx = np.flatnonzero(keep)
    if len(idx) > SIMS_MAX:
        return None
    at = np.full(len(lib.photos), -1)
    at[idx] = np.arange(len(idx))
    return lib.emb[idx] @ lib.emb[idx].T, at


def group_shots(lib: Lib, keep: np.ndarray, quality: np.ndarray,
                sims: tuple[np.ndarray, np.ndarray] | None = None, dismissed=frozenset()) -> list[list[int]]:
    """Fold bursts and duplicates into shots. Your merges/splits (photos.stack_key) are hard rules:
    "m:<key>" photos stack together and nothing else joins them, "solo:<id>" photos stand alone.
    Everything else is grouped automatically, leader-based so long sessions don't chain together, then stacks that
    belong together are joined (join_stacks; `dismissed`: photo-id pairs you said aren't the same shot)."""
    manual: dict[str, list[int]] = {}
    fixed: list[list[int]] = []
    keep = keep.copy()
    for i, p in enumerate(lib.photos):
        key = p.get("stack_key")
        if keep[i] and key:
            keep[i] = False
            if key.startswith("solo:"):
                fixed.append([i])
            else:
                manual.setdefault(key, []).append(i)
    # Leaders are picked by quality alone: which frame you crowned decides the stack's cover, not its members.
    order = [int(i) for i in np.argsort(-quality, kind="stable") if keep[i]]
    E = lib.emb
    if sims is None:
        sims = similarities(lib, keep)
    if sims is None:
        return join_stacks(lib, _group_big(lib, order), dismissed) + list(manual.values()) + fixed
    S, at = sims
    oi = at[order]  # each photo's row in S
    lead = np.zeros(len(order), np.int64)  # positions in `order` of each shot's leader, as they appear
    nl = 0
    groups: dict[int, list[int]] = {}
    ph = [int(p["phash"], 16) if p.get("phash") else None for p in lib.photos]
    for pos, i in enumerate(order):
        p = lib.photos[i]
        home = None
        if nl:
            cos = S[oi[pos], oi[lead[:nl]]] if lib.has_emb[i] else np.zeros(nl, np.float32)
            top = np.argpartition(-cos, 12)[:12] if nl > 12 else np.arange(nl)
            for k in top[np.argsort(-cos[top])]:  # the 12 most similar leaders, most similar first
                li = order[lead[k]]
                q = lib.photos[li]
                same_bytes = p.get("sha256") and p["sha256"] == q.get("sha256")
                near = ph[i] is not None and ph[li] is not None and _hamming(ph[i], ph[li]) <= 6
                both = lib.has_emb[i] and lib.has_emb[li]
                twin = both and cos[k] >= 0.975
                burst = (both and cos[k] >= 0.90 and p.get("taken_ts") and q.get("taken_ts")
                         and abs(p["taken_ts"] - q["taken_ts"]) <= 30)
                if same_bytes or near or twin or burst:
                    home = li
                    break
        if home is None:
            lead[nl] = pos
            nl += 1
            groups[i] = [i]
        else:
            groups[home].append(i)
    return join_stacks(lib, list(groups.values()), dismissed) + list(manual.values()) + fixed


def suggest_merges(store: Store, limit: int = 60) -> list[dict]:
    """Shots that look like the same moment but weren't stacked: very similar, and close in time
    (or no time to go on). Pairs you dismissed don't come back."""
    rows = store.q("SELECT g.id AS gid, g.rep, p.emb, p.taken_ts FROM groups g JOIN photos p ON p.id = g.rep "
                   "WHERE p.emb IS NOT NULL")
    if len(rows) < 2:
        return []
    E = np.stack([unblob(r["emb"]) for r in rows])
    ts = np.array([r["taken_ts"] if r["taken_ts"] is not None else np.nan for r in rows])
    dismissed = {tuple(sorted(d)) for d in (store.get_meta("stack_dismissed", []) or [])}
    found: list[tuple[float, int, int]] = []
    for b0 in range(0, len(rows), 1024):
        S = E[b0:b0 + 1024] @ E.T
        dt = np.abs(ts[b0:b0 + 1024, None] - ts[None, :])
        ok = ((S >= 0.88) & np.where(np.isnan(dt), False, dt <= 15 * 60)) | (S >= 0.93)
        ok &= np.arange(len(rows))[None, :] > np.arange(b0, b0 + len(S))[:, None]  # each pair once
        for a, b in zip(*np.nonzero(ok)):
            found.append((float(S[a, b]), b0 + int(a), int(b)))
    out = []
    for sim, a, b in sorted(found, reverse=True):
        ra, rb = rows[a], rows[b]
        if tuple(sorted((ra["rep"], rb["rep"]))) in dismissed:
            continue
        gap = abs(ts[a] - ts[b])
        out.append({"a": ra["rep"], "b": rb["rep"], "similarity": round(sim, 3),
                    "seconds_apart": None if np.isnan(gap) else int(gap)})
        if len(out) >= limit:
            break
    return out


SCENE_REACH = 300  # a shot joins one of the last this-many scenes of its session (an endless "session" stays fast)


def group_scenes(lib: Lib, reps: list[int]) -> list[int]:
    """Scene label per shot: same session (no >45 min gap) and similar look, or very similar look."""
    scene = [-1] * len(reps)
    timed = sorted((lib.photos[r]["taken_ts"], k) for k, r in enumerate(reps) if lib.photos[r].get("taken_ts"))
    sessions: list[list[int]] = []
    last = None
    for ts, k in timed:
        if last is None or ts - last > 45 * 60:
            sessions.append([])
        sessions[-1].append(k)
        last = ts
    untimed = [k for k, r in enumerate(reps) if not lib.photos[r].get("taken_ts")]
    nxt = 0
    for members, thr in [(s, 0.84) for s in sessions] + [(untimed, 0.88)]:
        leaders: list[int] = []
        LE = np.zeros((len(members), lib.emb.shape[1]), np.float32)
        for k in members:
            e = lib.emb[reps[k]]
            if leaders:
                lo = max(0, len(leaders) - SCENE_REACH)  # the session's recent scenes, not all of them
                s = LE[lo:len(leaders)] @ e
                b = int(np.argmax(s))
                if s[b] >= thr:
                    scene[k] = scene[leaders[lo + b]]
                    continue
            LE[len(leaders)] = e
            leaders.append(k)
            scene[k] = nxt
            nxt += 1
    return scene


# ----------------------------------------------------------------------------- refresh

def refresh(store: Store, identity_only: bool = False, report=None) -> dict:
    """Re-derive everything from the analysis and your choices. `report(step, **found)`, if given, hears about each
    step as it finishes (the analysis screen shows them): people, throw-outs, stacks, scenes."""
    with store.refresh_lock:
        return _refresh(store, identity_only, report)


# What the last full refresh worked out that doesn't depend on how photos are stacked, per database. Merges,
# splits and frame picks reuse it (regroup) instead of re-running identity, the scene model and the rules.
_BASE: dict[str, dict] = {}


def _inputs_sig(store: Store) -> str:
    """Fingerprint of everything a refresh depends on except the stacking (stack_key, rep_pref)."""
    h = hashlib.sha1()
    for key in ("settings", "excluded_people", "me_anchors", "not_me_anchors"):
        h.update(json.dumps(store.get_meta(key), sort_keys=True).encode())
    row = store.one("SELECT group_concat(id || ',' || status || ',' || ifnull(override, ''), ';') "
                    "AS s FROM (SELECT * FROM photos WHERE status IN ('analyzed', 'error') ORDER BY id)")
    h.update((row["s"] or "").encode())
    return h.hexdigest()


def warm(store: Store) -> None:
    """Work out what regroup reuses ahead of time (nothing is written), so the first merge after a start is
    as quick as the rest."""
    with store.refresh_lock:
        if str(store.path) not in _BASE:
            sig = _inputs_sig(store)
            lib = load(store)
            base = _judge_all(store, lib, identify(lib, store), sig)[0]
            reps = [lib.pidx[r["rep"]] for r in store.q("SELECT rep FROM groups") if r["rep"] in lib.pidx]
            base["pca"] = (_pca_fit(lib.emb[reps], PCA_FULL), _pca_fit(base["crops"][reps], PCA_CROP))
            base["sims"] = similarities(lib, base["keep"])
            _BASE[str(store.path)] = base


def regroup(store: Store) -> dict:
    """Re-stack after merges, splits and frame picks: only the stacking changed, so reuse the rest of the
    last refresh (a small fraction of the cost). If anything else changed since, do a full refresh."""
    with store.refresh_lock:
        base = _BASE.get(str(store.path))
        if base is None or store.get_meta("derived_version") != DERIVED_VERSION or base["sig"] != _inputs_sig(store):
            return _refresh(store, False)
        t0 = time.time()
        now = {r["id"]: r for r in store.q("SELECT id, stack_key, rep_pref FROM photos")}
        for p in base["lib"].photos:
            p["stack_key"], p["rep_pref"] = now[p["id"]]["stack_key"], now[p["id"]]["rep_pref"]
        return _stack(store, base, t0)


def _refresh(store: Store, identity_only: bool, report=None) -> dict:
    t0 = time.time()
    report = report or (lambda step, **found: None)
    sig = _inputs_sig(store)
    lib = load(store)
    ident = identify(lib, store)
    with store.tx() as c:
        c.executemany("UPDATE photos SET me_face=?, me_sim=? WHERE id=?",
                      [(ident["me_face"][p["id"]], ident["me_sim"][p["id"]], p["id"]) for p in lib.photos])
        c.executemany("UPDATE faces SET person=? WHERE id=?",
                      [(int(ident["person"][j]), f["id"]) for j, f in enumerate(lib.faces)])
        c.execute("DELETE FROM people")
        c.executemany("INSERT INTO people(id, n_photos, faces) VALUES(?,?,?)",
                      [(p["key"], p["n_photos"], json.dumps(p["faces"])) for p in ident["people"]])
    store.set_meta("people_centroids", {str(p["key"]): p["centroid"] for p in ident["people"]})
    excluded = store.get_meta("excluded_people", []) or []
    if excluded:  # people are keyed by face now; point each exclusion at whoever it matches today
        cents = {p["key"]: np.asarray(p["centroid"], np.float32) for p in ident["people"]}
        keys = []
        for k, cen in enumerate(excluded):
            sims = {key: float(c @ np.asarray(cen, np.float32)) for key, c in cents.items()}
            best = max(sims, key=sims.get) if sims else None
            keys.append(best if best is not None and sims[best] >= PERSON_T else -(k + 1))
        store.set_meta("excluded_keys", keys)
    if ident["centroid"] is not None:
        store.set_meta("me_centroid", ident["centroid"].tolist())
    report("people", people=len(ident["people"]), me=int(sum(1 for v in ident["me_face"].values() if v is not None)))
    if identity_only:
        _BASE.pop(str(store.path), None)
        return {"seconds": time.time() - t0}
    base, judged = _judge_all(store, lib, ident, sig)
    from . import tags  # (tags builds on themes, which builds on this module)
    found = tags.write_auto(store, lib, *tags.auto_tags(lib, ident, base["zs"], base["cats"], base["flags"], base["keep"], base["mode"]))
    cut = [(lib.photos[i]["id"], j[0]) for i, j in enumerate(judged) if j[0]]
    report("throwouts", cut=cut[:60], counts=base["cut"],
           kinds={k: int(n) for k, n in zip(*np.unique([c for c, keep in zip(base["cats"], base["keep"]) if c and keep], return_counts=True))}
           if any(base["cats"]) else {})
    summary = _stack(store, base, t0, judged, report)
    report("tags", **found)
    _BASE[str(store.path)] = base
    return summary


def _judge_all(store: Store, lib: Lib, ident: dict, sig: str) -> tuple[dict, list]:
    """Throw-outs, flags, hand features and priors for every photo: what regroup reuses, plus the rows to write."""
    settings = {**DEFAULT_SETTINGS, **(store.get_meta("settings", {}) or {})}
    mode = settings.get("mode", "me")
    zs = zero_shot(lib) if len(lib.photos) else {}
    cats = categorize(lib) if len(lib.photos) else []
    excluded = [np.asarray(a, np.float32) for a in store.get_meta("excluded_people", [])]
    cuts, flags, measures = judge(lib, ident, zs, settings, excluded)
    spec = hand_spec(mode)
    H = hand_features(lib, measures, flags, mode, cats)
    prior = H @ np.array([h[1] for h in spec], np.float32)
    base = {
        "sig": sig, "lib": lib, "H": H, "prior": prior, "keep": np.array([c is None for c in cuts]),
        "hand": spec, "cats": cats, "zs": zs, "flags": flags, "mode": mode,
        # Tossed photos stay in the model as inactive items: what you threw out teaches your taste.
        "tossed": [i for i, p in enumerate(lib.photos) if p.get("override") == "toss" and lib.has_emb[i]],
        "crops": np.where(lib.has_crop[:, None], lib.crop, lib.emb), "pca": None,
        "cut": {k: int(sum(1 for c in cuts if c == k)) for k in CUT_LABELS if any(c == k for c in cuts)},
    }
    judged = [(cuts[i], json.dumps(flags[i]), float(prior[i]),
               json.dumps(subject_box(p["pw"], p["ph"], measures[p["id"]]["me"])), cats[i] or None)
              for i, p in enumerate(lib.photos)]
    return base, judged


def _stack(store: Store, base: dict, t0: float, judged: list | None = None, report=None) -> dict:
    """Fold photos into shots (best frame first), group scenes, and write the shots and the ranker's features.
    A full refresh passes `judged` (each photo's cut, flags, prior, subject box) to write as well."""
    lib, H, prior, tossed, crops, spec = base["lib"], base["H"], base["prior"], base["tossed"], base["crops"], base["hand"]
    if "sims" not in base:
        base["sims"] = similarities(lib, base["keep"])
    shots = group_shots(lib, base["keep"], prior, base["sims"], store.get_meta("stack_dismissed", []) or [])
    # Best frame first: the user's pick, else the highest prior.
    shots = [sorted(g, key=lambda i: (-lib.photos[i]["rep_pref"], -prior[i])) for g in shots]
    reps = [g[0] for g in shots]
    if report:
        multi = sorted((g for g in shots if len(g) > 1), key=len, reverse=True)
        report("stacks", stacks=[[lib.photos[i]["id"] for i in g[:8]] + ([len(g)] if len(g) > 8 else []) for g in multi[:24]],
               shots=len(shots), folded=int(sum(len(g) - 1 for g in shots)))
    scenes = group_scenes(lib, reps)
    if report:
        report("scenes", scenes=len(set(scenes)))
    if base["pca"] is None:  # fitted on a full refresh; a merge or split moves one shot, not the axes
        base["pca"] = (_pca_fit(lib.emb[reps], PCA_FULL), _pca_fit(crops[reps], PCA_CROP))
    pf, pc = base["pca"]
    rows = reps + tossed

    def feats(ix: list[int]) -> np.ndarray:
        return np.hstack([H[ix], _pca_apply(pf, lib.emb[ix], PCA_FULL), _pca_apply(pc, crops[ix], PCA_CROP)]).astype(np.float32)
    X = feats(rows)
    frames = [i for g in shots if len(g) > 1 for i in g]  # every frame of a stack: what mini-tournament calls teach
    w0_all = np.concatenate([[h[1] for h in spec], np.zeros(PCA_FULL + PCA_CROP)]).astype(np.float32)
    sd_all = np.concatenate([[h[2] for h in spec], np.full(PCA_FULL + PCA_CROP, PCA_SD)]).astype(np.float32)
    gids = [min(lib.photos[i]["id"] for i in g) for g in shots] + [-lib.photos[i]["id"] for i in tossed]
    item_reps = [lib.photos[g[0]]["id"] for g in shots] + [lib.photos[i]["id"] for i in tossed]
    active = np.array([True] * len(shots) + [False] * len(tossed))

    gid_of = {i: (-lib.photos[i]["id"], None) for i in tossed}
    group_rows = []
    for g, scene in zip(shots, scenes):
        gid = min(lib.photos[i]["id"] for i in g)
        group_rows.append((gid, lib.photos[g[0]]["id"], json.dumps([lib.photos[i]["id"] for i in g]), int(scene),
                           int(any(lib.photos[i]["rep_pref"] for i in g))))
        for i in g:
            gid_of[i] = (gid, int(scene))
    placed = [(*gid_of.get(i, (None, None)), p["id"]) for i, p in enumerate(lib.photos)]
    if judged is None:  # only the stacking changed: touch just the photos that moved
        was = {r["id"]: (r["group_id"], r["scene_id"]) for r in store.q("SELECT id, group_id, scene_id FROM photos")}
        placed = [r for r in placed if was.get(r[2]) != (r[0], r[1])]
    with store.tx() as c:
        c.execute("DELETE FROM groups")
        c.executemany("INSERT INTO groups(id, rep, members, scene, frame_checked) VALUES(?,?,?,?,?)", group_rows)
        if judged is not None:
            c.executemany("UPDATE photos SET cut=?, flags=?, prior=?, subject=?, category=?, group_id=?, scene_id=? "
                          "WHERE id=?", [(*j, *r) for j, r in zip(judged, placed)])
        else:
            c.executemany("UPDATE photos SET group_id=?, scene_id=? WHERE id=?", placed)
    feat_path = store.path.parent / "features.npz"
    tmp = store.path.parent / "features.tmp.npz"
    np.savez(tmp, gids=np.array(gids, np.int64), reps=np.array(item_reps, np.int64),
             scenes=np.array(list(scenes) + [-1] * len(tossed), np.int64), X=X, w0=w0_all, sd=sd_all,
             active=active, cats=np.array([base["cats"][g[0]] for g in shots] + [base["cats"][i] for i in tossed], dtype=str),
             fx_ids=np.array([lib.photos[i]["id"] for i in frames], np.int64), fx=feats(frames),
             n_hand=np.array(len(spec)),
             names=np.array([h[0] for h in spec] + [f"pf{k}" for k in range(PCA_FULL)] + [f"pc{k}" for k in range(PCA_CROP)]))
    tmp.replace(feat_path)
    summary = {"photos": len(lib.photos), "shots": len(shots), "in_bursts": int(sum(len(g) - 1 for g in shots)),
               "cut": base["cut"], "seconds": round(time.time() - t0, 2)}
    store.set_meta("summary", summary)
    store.set_meta("derived_version", DERIVED_VERSION)
    store.set_meta("state_version", time.time())
    return summary
