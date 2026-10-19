"""A small, saved recipe for each photo, measured once on its upright preview.

The baseline corrects the photo's light and colour, with separate treatment for low-key and high-key scenes.
The photographer's adjustments come afterwards. Geometry uses a separate, confidence-gated alignment choice.
"""
from __future__ import annotations

import colorsys
import json
import math

import cv2
import numpy as np
from PIL import Image, ImageFilter

from . import alignment

VERSION = 3
PARTS = ("tone", "colour", "grade", "detail", "subject")
IDENTITY = {"lin": [[1, 0]] * 3, "gamma": 1, "sat": 1}


def _curve(points):
    """A smooth, monotone tone curve. Flat or repeated quantiles never create a reversed or vertical segment."""
    kept = [points[0]]
    for x, y in points[1:-1]:
        if .003 < x < .997 and x - kept[-1][0] > .003:
            kept.append((x, y))
    kept.append(points[-1])
    x, y = np.array(kept).T
    y = np.maximum.accumulate(np.clip(y, 0, 1))
    h, d = np.diff(x), np.diff(y) / np.diff(x)
    slopes = np.zeros(len(x))
    slopes[0], slopes[-1] = d[0], d[-1]
    for i in range(1, len(x) - 1):
        if d[i - 1] > 0 and d[i] > 0:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            slopes[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    v = np.linspace(0, 1, 65)
    i = np.clip(np.searchsorted(x, v, side="right") - 1, 0, len(x) - 2)
    t = (v - x[i]) / h[i]
    out = (2*t**3 - 3*t**2 + 1)*y[i] + (t**3 - 2*t**2 + t)*h[i]*slopes[i]
    out += (-2*t**3 + 3*t**2)*y[i+1] + (t**3 - t**2)*h[i]*slopes[i+1]
    return np.maximum.accumulate(np.clip(out, 0, 1))


def _balance(rgb, y, mono):
    """Only neutral-looking samples spread across the picture may suggest a white-balance correction.

    A sky, wall or pool of stage light must not turn the entire picture into its opposite colour.
    """
    high, low = rgb.max(2), rgb.min(2)
    saturation = (high - low) / np.maximum(.02, high)
    neutral = (saturation < .32) & (y > .12) & (y < .88)
    if mono or neutral.sum() < 100 or neutral.mean() < .035:
        return np.ones(3), 0
    h, w = y.shape
    occupied = sum(neutral[a:h if a else h//2, b:w if b else w//2].mean() > .025
                   for a in (0, h//2) for b in (0, w//2))
    if occupied < 3:
        return np.ones(3), 0
    samples = np.log(np.maximum(.02, rgb[neutral]))
    samples -= samples.mean(1, keepdims=True)
    cast = np.median(samples, axis=0)
    scatter = float(np.median(np.linalg.norm(samples - cast, axis=1)))
    confidence = min(1, neutral.mean() / .2) * max(0, 1 - scatter / .12)
    # The correction approaches the neutral evidence without extinguishing the scene's light.
    gains = np.exp(-cast * .7 * confidence)
    gains /= np.dot(gains, [.299, .587, .114])
    return np.clip(gains, .80, 1.25), confidence


def measure(im, faces=()):
    proof = im.convert("RGB").copy()
    proof.thumbnail((256, 256), Image.Resampling.BOX)
    rgb = np.asarray(proof, dtype=float) / 255
    y = rgb @ np.array([.299, .587, .114])
    chroma = rgb.max(2) - rgb.min(2)
    mono = float(chroma.mean()) < .018
    gains, confidence = _balance(rgb, y, mono)
    balanced = np.clip(rgb * gains, 0, 1)
    y = balanced @ np.array([.299, .587, .114])
    lo, p10, median, p75, p90, hi = (float(v) for v in np.quantile(y, [.005, .1, .5, .75, .9, .995]))
    span, mean = hi - lo, float(y.mean())
    sat = float(np.mean(chroma / np.maximum(.02, rgb.max(2))))
    # A dim exposure is not automatically a night scene. Sparse lights above a dark field are stronger evidence.
    night = median < .20 and ((hi > .55 and hi > median * 3.5 and p75 < .25) or (sat > .48 and hi < .5) or span < .08)
    bright = median > .72 and p10 > .60 and lo > .35
    uniform = span < .08
    if uniform:
        target = median + min(.025, max(-.025, .44 - median)) * (.25 if night or bright else .65)
        offset = (target - median) / max(.02, median * (1 - median))
        v = np.linspace(0, 1, 65)
        curve = np.clip(v + offset * v * (1 - v), 0, 1)
        black, white = lo, hi
    else:
        strength = min(1, max(0, (span - .06) / .20))
        target = median + min(.20, max(-.17, .46 - median)) * .8 * strength
        black = lo - min(.18, max(0, lo - .012) * .78) * strength
        white = hi + min(.26, max(0, .96 - hi) * .82) * strength
        if night or bright:
            target = median + min(.012, max(-.012, .46 - median))
            black, white = lo * .95, hi + min(.012, max(0, .98 - hi))
        target = min(white - .005, max(black + .005, target))
        # Separate shadow and highlight anchors reveal detail without simply raising the black floor or clipping whites.
        shadow = black + (target - black) * (max(0, (p10 - lo) / max(.001, median - lo)) ** (.82 if p10 < .14 and hi > .8 and not night else 1))
        highlight = target + (white - target) * (max(0, (p90 - median) / max(.001, hi - median)) ** (1.12 if p90 > .85 and not bright else 1))
        curve = _curve([(0, 0), (lo, black), (p10, shadow), (median, target), (p90, highlight), (hi, white), (1, 1)])
    if night and not uniform:
        # Open readable midtones above the night blacks instead of dragging the entire dark field toward grey.
        v = np.linspace(0, 1, len(curve))
        gate = np.clip((v - .05) / .16, 0, 1)
        curve = np.maximum.accumulate(np.clip(curve + .07 * 4 * v * (1 - v) * gate**2 * (3 - 2 * gate), 0, 1))
    toned = np.interp(balanced, np.linspace(0, 1, len(curve)), curve)
    toned_sat = float(np.mean((toned.max(2) - toned.min(2)) / np.maximum(.02, toned.max(2))))
    diversity = min(1, float(np.std(balanced - y[..., None], axis=(0, 1)).mean()) / .035)
    saturation = 1 if mono or uniform else 1 + min(.28, max(0, .50 - toned_sat) * .65) * diversity
    if faces:
        saturation = min(saturation, 1.14)
    # Choose the strongest useful colour correction that adds very little out-of-gamut clipping.
    gray = (toned @ np.array([.213, .715, .072]))[..., None]
    clipped = float(np.any((toned < .001) | (toned > .999), axis=2).mean())
    for _ in range(6):
        candidate = gray + (toned - gray) * saturation
        if np.any((candidate < 0) | (candidate > 1), axis=2).mean() <= clipped + .008:
            break
        saturation = 1 + (saturation - 1) * .65
    # A chromatic centroid describes the light already present; it never imposes a generic teal/orange look.
    scene_chroma = balanced.max(2) - balanced.min(2)
    pigment = np.maximum(0, scene_chroma - .03)
    colour = (balanced * pigment[..., None]).sum((0, 1)) / max(.001, pigment.sum())
    hue = colorsys.rgb_to_hsv(*np.clip(colour, 0, 1))[0] * 360
    warm = hue < 65 or hue > 335
    cool = 170 < hue < 295
    label = "Monochrome" if mono else "Night light" if night else "Bright light" if bright else "Warm light" if warm else "Cool air" if cool else "Natural light"
    grade_amount = (.018 if sat > .5 or uniform else .04) * min(1, float(scene_chroma.mean()) / .15)
    grade = {} if mono or grade_amount < .003 else {"midtones": {"hue": round(hue, 2), "amount": round(grade_amount, 4)}, "blending": .8}
    linear = lambda v: v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
    exposure = math.log2(max(.001, linear(target)) / max(.001, linear(median)))
    reasons = ["Keep the night dark" if night else "Protect the bright atmosphere" if bright else
               f"Lift underexposed midtones ({exposure:+.1f} EV)" if exposure > .15 else
               f"Balance bright midtones ({exposure:+.1f} EV)" if exposure < -.15 else "Keep the midtone exposure"]
    if black < lo - .02 or white > hi + .04:
        reasons.append("Restore depth with separate black, shadow and highlight points")
    if max(abs(gains - 1)) > .02:
        reasons.append("Balance the neutral colours")
    reasons.append("Preserve monochrome" if mono else "Bring muted colour forward" if saturation > 1.10 else "Keep the scene’s own colour")
    # Detail is measured at one fixed preview size, independent of whichever mip the browser first displays.
    detail_proof = im.convert("L").copy()
    detail_proof.thumbnail((800, 800), Image.Resampling.BOX)
    gray = np.asarray(detail_proof, dtype=np.float32)
    residual = gray - cv2.GaussianBlur(gray, (3, 3), .7)
    flat = np.abs(cv2.Laplacian(gray, cv2.CV_32F)) < 7
    noise = float(np.median(np.abs(residual[flat]))) if flat.sum() > 100 else 0
    detail = {"smooth": min(.25, max(0, noise - 1.2) * .06), "sharp": .28 if noise < 1.8 else .12 if noise < 3 else .04,
              "basis": max(detail_proof.size)}
    masks = []
    for face in faces[:1]:
        f = dict(face)
        if not all(f.get(k) is not None for k in ("x", "y", "w", "h", "luma")):
            continue
        if f["w"] * f["h"] < .003 or f["w"] * f["h"] > .25 or f["luma"] / 255 >= mean * .72 or night:
            continue
        lift = min(.85, max(.18, math.log2(max(.01, mean * .85) / max(.01, f["luma"] / 255)) * .45))
        masks.append({"id": "auto-subject", "name": "Lift the backlit subject", "feather": 1, "opacity": .85,
                      "adjust": {"exposure": round(lift, 3)}, "strokes": [{"mode": "paint", "r": min(.3, max(f["w"], f["h"]) * .85),
                      "p": [[f["x"] + f["w"] / 2, f["y"] + f["h"] / 2]]}]})
        reasons.append("Open the backlit face without lifting the whole scene")
    boundary = alignment.measure(im)
    return {"version": VERSION, "label": label, "reasons": reasons, "lin": [[1, 0]] * 3, "wb": [round(float(g), 6) for g in gains],
            "curve": [round(float(v), 6) for v in curve], "gamma": 1, "sat": round(saturation, 6),
            "measured": {"exposure": round(exposure, 2), "neutral_confidence": round(confidence, 2)},
            "grade": grade, "detail": detail, "masks": masks, "straighten": boundary["degrees"] if boundary else None,
            "alignment": boundary}


def mix_curve(curve, amount):
    if not curve:
        return None
    identity = np.linspace(0, 1, len(curve))
    return np.maximum.accumulate(np.clip(identity + (np.array(curve) - identity) * amount, 0, 1)).tolist()


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
            "curve": mix_curve(r.get("curve"), tone),
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


def fill_missing(store, workdir, cancel=lambda: False, on_photo=lambda _pid: None):
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
            on_photo(after)
    return count
