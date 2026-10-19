"""A small, saved recipe for each photo, measured once on its upright preview.

The baseline protects coloured light and low-key scenes. It is deliberately restrained: the photographer's
adjustments come afterwards, and geometry is suggested rather than silently throwing away part of the picture.
"""
from __future__ import annotations

import colorsys
import json
import math

import cv2
import numpy as np
from PIL import Image, ImageFilter

VERSION = 1
PARTS = ("tone", "colour", "grade", "detail", "subject")
IDENTITY = {"lin": [[1, 0]] * 3, "gamma": 1, "sat": 1}


def measure(im, faces=()):
    proof = im.convert("RGB").copy()
    proof.thumbnail((256, 256), Image.Resampling.BOX)
    rgb = np.asarray(proof, dtype=float) / 255
    y = rgb @ np.array([.299, .587, .114])
    lo, median, hi = (float(v) for v in np.quantile(y, [.01, .5, .99]))
    chroma = rgb.max(2) - rgb.min(2)
    sat = float(np.mean(chroma / np.maximum(.02, rgb.max(2))))
    mean = float(y.mean())
    night = median < .22
    bright = median > .70
    mono = float(chroma.mean()) < .018
    colourful = sat > .36
    # Flat or deliberately misty pictures must not have their entire histogram stretched to black and white.
    strength = .08 if night or bright else .18
    a = 1 + min(.18, max(0, 1 / max(.55, hi - lo) - 1) * strength) if hi - lo > .25 else 1
    b = -min(.035, lo * strength) if a > 1 else 0
    target = mean + min(.06, max(-.04, .44 - mean) * .24)
    if night:
        target = mean + min(.018, mean * .12)
    if bright:
        target = mean - min(.012, max(0, mean - .72) * .1)
    adjusted = min(.98, max(.02, a * mean + b))
    gamma = min(1.12, max(.86, math.log(max(.02, target)) / math.log(adjusted)))
    gains = np.ones(3)
    neutral = (chroma < .07) & (y > .18) & (y < .82)
    if not mono and not colourful and neutral.mean() > .12:
        grey = rgb[neutral].mean(0)
        gains = np.clip(1 + (grey.mean() / np.maximum(.08, grey) - 1) * .2, .975, 1.025)
    # A chromatic centroid describes the light already present; it never imposes a generic teal/orange look.
    pigment = np.maximum(0, chroma - .03)
    colour = (rgb * pigment[..., None]).sum((0, 1)) / max(.001, pigment.sum())
    hue = colorsys.rgb_to_hsv(*np.clip(colour, 0, 1))[0] * 360
    warm = hue < 65 or hue > 335
    cool = 170 < hue < 295
    label = "Monochrome" if mono else "Night light" if night else "Bright light" if bright else "Warm light" if warm else "Cool air" if cool else "Natural light"
    grade = {} if mono else {"midtones": {"hue": round(hue, 2), "amount": .025 if colourful else .018}, "blending": .8}
    reasons = ["Keep the night dark" if night else "Protect the bright atmosphere" if bright else "Gently balance the midtones",
               "Preserve monochrome" if mono else "Keep the scene’s own colour"]
    # Detail is measured at one fixed preview size, independent of whichever mip the browser first displays.
    detail_proof = im.convert("L").copy()
    detail_proof.thumbnail((800, 800), Image.Resampling.BOX)
    gray = np.asarray(detail_proof, dtype=np.float32)
    residual = gray - cv2.GaussianBlur(gray, (3, 3), .7)
    flat = np.abs(cv2.Laplacian(gray, cv2.CV_32F)) < 7
    noise = float(np.median(np.abs(residual[flat]))) if flat.sum() > 100 else 0
    detail = {"smooth": min(.12, max(0, noise - 1.2) * .025), "sharp": .06 if noise < 2 else .025,
              "basis": max(detail_proof.size)}
    masks = []
    for face in faces[:1]:
        f = dict(face)
        if not all(f.get(k) is not None for k in ("x", "y", "w", "h", "luma")):
            continue
        if f["w"] * f["h"] < .003 or f["w"] * f["h"] > .25 or f["luma"] / 255 >= mean * .72 or night:
            continue
        masks.append({"id": "auto-subject", "name": "Lift the backlit subject", "feather": 1, "opacity": .8,
                      "adjust": {"exposure": .18}, "strokes": [{"mode": "paint", "r": min(.3, max(f["w"], f["h"]) * .85),
                      "p": [[f["x"] + f["w"] / 2, f["y"] + f["h"] / 2]]}]})
        reasons.append("A little light for the backlit face")
    # Only long, agreeing near-horizontal lines justify a horizon suggestion. The user applies it explicitly.
    edges = cv2.Canny(gray.astype(np.uint8), 60, 140)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 720, 70, minLineLength=max(gray.shape) * .32, maxLineGap=12)
    angles = []
    for x0, y0, x1, y1 in lines.reshape(-1, 4) if lines is not None else []:
        angle = math.degrees(math.atan2(y1 - y0, x1 - x0))
        if .15 < abs(angle) < 5:
            angles.append(angle)
    straighten = round(-float(np.median(angles)), 2) if len(angles) >= 3 and np.std(angles) < .35 else None
    return {"version": VERSION, "label": label, "reasons": reasons, "lin": [[round(a, 6), round(b, 6)] for _ in gains], "wb": [round(float(g), 6) for g in gains],
            "gamma": round(gamma, 6), "sat": 1 if mono else round(1 + max(0, .32 - sat) * .15, 6),
            "grade": grade, "detail": detail, "masks": masks, "straighten": straighten}


def resolve(recipe, edits=None):
    """Return the baseline before manual knobs, grade and masks. Mirrored by static/auto-look.js."""
    r, e = recipe or IDENTITY, edits or {}
    amount = e.get("auto_amount", 1)
    parts = e.get("auto_parts") or {}
    n = lambda part: amount if parts.get(part, True) else 0
    tone, colour = n("tone"), n("colour")
    grade = {k: ({**v, "amount": v.get("amount", 0) * n("grade"), "light": v.get("light", 0) * n("grade")} if isinstance(v, dict) else v)
             for k, v in (r.get("grade") or {}).items()}
    masks = [{**m, "opacity": m.get("opacity", 1) * min(1, n("subject"))} for m in r.get("masks", [])] if n("subject") else []
    return {"levels": [((1 + (a - 1) * tone) * (1 + (r.get("wb", [1, 1, 1])[i] - 1) * colour), b * tone) for i, (a, b) in enumerate(r["lin"])],
            "gamma": 1 + (r["gamma"] - 1) * tone, "saturation": 1 + (r["sat"] - 1) * colour,
            "grade": grade if n("grade") else {}, "masks": masks,
            "detail": {k: v * n("detail") if k != "basis" else v for k, v in r.get("detail", {}).items()}}


def detail(im, how):
    smooth, sharp = how.get("smooth", 0), how.get("sharp", 0)
    radius = max(im.size) / max(1, how.get("basis", 800)) * .7
    blurred = im.filter(ImageFilter.GaussianBlur(radius)) if smooth or sharp else im
    if smooth:
        im = Image.blend(im, blurred, min(1, smooth))
    if sharp:
        # Work in strips so a full-resolution RAW does not need two additional float copies of the entire image.
        out = Image.new("RGB", im.size)
        for y in range(0, im.height, 256):
            box = (0, y, im.width, min(im.height, y + 256))
            a, b = np.asarray(im.crop(box), dtype=np.float32), np.asarray(blurred.crop(box), dtype=np.float32)
            out.paste(Image.fromarray(np.clip(a * (1 + sharp) - b * sharp, 0, 255).round().astype(np.uint8)), (0, y))
        im = out
    return im


def fill_missing(store, workdir, cancel=lambda: False):
    """Upgrade old libraries from cached previews in small batches; never re-run analysis or open originals."""
    after, count = 0, 0
    while not cancel():
        rows = store.q("SELECT id FROM photos WHERE id>? AND status='analyzed' AND auto_version<? ORDER BY id LIMIT 40", (after, VERSION))
        if not rows:
            break
        for row in rows:
            if cancel():
                return count
            after = row["id"]
            try:
                with Image.open(workdir / "previews" / f"{after}.jpg") as im:
                    recipe = measure(im, store.q("SELECT x,y,w,h,luma FROM faces WHERE photo_id=? ORDER BY w*h DESC LIMIT 1", (after,)))
            except (OSError, ValueError):
                continue  # missing caches remain eligible on the next open
            with store.tx() as c:
                c.execute("UPDATE photos SET auto_look=?,auto_version=? WHERE id=? AND auto_version<?", (json.dumps(recipe), VERSION, after, VERSION))
            count += 1
    return count
