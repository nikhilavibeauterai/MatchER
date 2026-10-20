"""Saved evidence for useful sea arrangements. Reading axes never decodes or edits a photo."""
from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import PurePosixPath

KEYS = set("colorfulness brightness hue saturation date quality ranking sharpness aspect faces aesthetic technical "
           "shortlist uncertainty comparisons contrast dark_tones light_tones warmth time weekday month year "
           "megapixels width height file_size filename folder camera format face_size smile eyes_open face_angle "
           "head_tilt subject_size subject_x subject_y category stack_size tag_count group decision edited".split())


def measurements(photo, *, face=None, stack=None, theme=None, post=None, index=None, tag_count=0):
    p = dict(photo)
    f = dict(face or {})
    width, height = p.get("width"), p.get("height")
    sharp, lo, hi = p.get("sharp"), p.get("luma_lo"), p.get("luma_hi")
    evidence = json.loads(p["zs"]) if p.get("zs") else {}
    zs = evidence.get("scores", evidence)
    edits = json.loads(p["edits"]) if p.get("edits") else {}
    subject = json.loads(p["subject"]) if p.get("subject") else None
    taken = None
    try:
        taken = datetime.fromisoformat(p["taken"]) if p.get("taken") else None
    except (TypeError, ValueError):
        pass
    known_rank = index is not None and post is not None
    blinks = [f[k] for k in ("blink_l", "blink_r") if f.get(k) is not None]
    rel = PurePosixPath(p.get("rel") or "")
    tonal = max(0, hi - lo) / 255 if hi is not None and lo is not None else None
    focus = min(1, math.log1p(max(0, sharp)) / math.log(801)) if sharp is not None else None
    colourful = (p.get("saturation") or 0) > .04 and p.get("hue") is not None
    return {
        "date": p.get("taken_ts"), "quality": p.get("prior"),
        "ranking": float(post.mu[index]) if known_rank else None,
        "shortlist": float(post.p_in[index]) if known_rank else None,
        "uncertainty": math.sqrt(max(0, float(post.var[index]))) if known_rank else None,
        "comparisons": float(post.n_obs[index]) if known_rank else 0,
        "aesthetic": zs.get("aesthetic"), "technical": .65 * focus + .35 * tonal if focus is not None and tonal is not None else None,
        "sharpness": sharp, "aspect": width / height if width and height else None, "faces": p.get("n_faces"),
        "contrast": tonal, "dark_tones": lo, "light_tones": hi,
        "warmth": math.cos(math.radians(p["hue"] * 360 - 35)) if colourful else None,
        "time": taken.hour + taken.minute / 60 + taken.second / 3600 if taken else None,
        "weekday": taken.weekday() if taken else None, "month": taken.month if taken else None, "year": taken.year if taken else None,
        "megapixels": width * height / 1e6 if width and height else None, "width": width, "height": height,
        "file_size": p.get("size"), "filename": rel.name or None, "folder": str(rel.parent) if p.get("rel") else None,
        "camera": " ".join(dict.fromkeys(v for v in (p.get("make"), p.get("model")) if v)) or None,
        "format": rel.suffix.lstrip(".").upper() or p.get("fmt"),
        "face_size": f.get("w", 0) * f.get("h", 0) if f else None, "smile": f.get("smile"),
        "eyes_open": 1 - max(blinks) if blinks else None,
        "face_angle": abs(f["yaw"]) if f.get("yaw") is not None else None,
        "head_tilt": abs(f["roll"]) if f.get("roll") is not None else None,
        "subject_size": subject[2] * subject[3] if subject else None,
        "subject_x": subject[0] + subject[2] / 2 if subject else None,
        "subject_y": subject[1] + subject[3] / 2 if subject else None,
        "category": p.get("category"), "stack_size": len((stack or {}).get("members") or [p.get("id")]),
        "tag_count": tag_count, "group": (theme or {}).get("name"),
        "decision": 0 if p.get("cut") or p.get("override") == "toss" else 2 if p.get("override") == "keep" else 1,
        "edited": sum(k in edits for k in ("enhance", "look", "grade", "masks", "crop", "rotate", "straighten", "auto_amount", "auto_parts", "auto_skew", "skew", "composition")),
    }
