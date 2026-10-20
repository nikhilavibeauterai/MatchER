"""Choose a viewpoint, not just the straightest set of edges.

Long, independent lines propose perspective corrections. A bounded search then balances their alignment
against retained area, visual attention, faces, distortion and the original composition. Three tastes share
the same evidence; no model download or full-resolution search is needed. See docs/composition.md.
"""
from __future__ import annotations

import math

import cv2
import numpy as np
from PIL import Image

from . import alignment, geometry


def _family(lines, vertical, size):
    w, h = size
    group = [s for s in lines if s["vertical"] == vertical and abs(s["angle"]) < 23]
    if len(group) < 3:
        return None
    ends = np.array([[s["a"], s["b"]] for s in group]) / [w, h] - .5
    equations = np.cross(np.column_stack((ends[:, 0], np.ones(len(group)))),
                         np.column_stack((ends[:, 1], np.ones(len(group)))))
    equations /= equations[:, :1] if vertical else equations[:, 1:2]
    # Independent lines converging at one vanishing point form a line in this dual representation.
    x, y = equations[:, 2], equations[:, 1 if vertical else 0]
    weights = np.array([min(s["length"] / min(w, h), .9) for s in group])
    best = None
    for i in range(len(group)):
        for j in range(i):
            if abs(x[i] - x[j]) < .22:
                continue
            slope = (y[i] - y[j]) / (x[i] - x[j])
            if abs(slope) > .7:
                continue
            intercept = y[i] - slope * x[i]
            residual = np.abs(y - slope * x - intercept)
            keep = residual < .025
            score = float((weights * keep * (1 - np.minimum(1, residual / .025) * .4)).sum())
            if best is None or score > best[0]:
                best = score, keep
    if best is None:
        return None
    keep = best[1]
    if keep.sum() < 3 or weights[keep].sum() < weights.sum() * .68 or np.ptp(x[keep]) < .28:
        return None
    design = np.column_stack((x[keep], np.ones(keep.sum())))
    root = np.sqrt(weights[keep])
    slope, intercept = np.linalg.lstsq(design * root[:, None], y[keep] * root, rcond=None)[0]
    scatter = float(np.average(np.abs(y[keep] - slope * x[keep] - intercept), weights=weights[keep]))
    if scatter > .013 or abs(slope) > .6:
        return None
    return {"slope": float(slope), "intercept": float(intercept), "lines": [s for s, on in zip(group, keep) if on],
            "confidence": round(min(1., float(weights[keep].sum() / 2)) * max(0., 1 - scatter / .025), 3)}


def _attention(im, faces, subject=None):
    proof = im.convert("RGB").resize((40, 40), Image.Resampling.BOX)
    rgb = np.asarray(proof, dtype=np.float32) / 255
    contrast = np.linalg.norm(rgb - cv2.GaussianBlur(rgb, (0, 0), 5), axis=2)
    # Bounded, colour-aware attention protects distinctive subjects without claiming to recognise them.
    attention = np.maximum(0, contrast - np.quantile(contrast, .45)) + .003
    xy = (np.indices(attention.shape).transpose(1, 2, 0)[..., ::-1] + .5) / 40
    if subject and len(subject) == 4:
        x, y, w, h = subject
        if 0 < w * h < .5:
            attention += ((abs(xy[..., 0] - x - w / 2) < w * .6) & (abs(xy[..., 1] - y - h / 2) < h * .6)) * .5
    boxes = []
    for face in faces[:12]:
        f = dict(face)
        if not all(isinstance(f.get(k), (int, float)) and math.isfinite(f[k]) for k in ("x", "y", "w", "h")):
            continue
        x, y, w, h = (f[k] for k in ("x", "y", "w", "h"))
        right, bottom = min(1., x + w), min(1., y + h)
        x, y = max(0., x), max(0., y)
        w, h = right - x, bottom - y
        if w <= 0 or h <= 0:
            continue
        boxes.append(np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]))
        attention += ((abs(xy[..., 0] - x - w / 2) < w * .65) & (abs(xy[..., 1] - y - h / 2) < h * .65)) * .8
    return xy.reshape(-1, 2), attention.ravel() / attention.sum(), boxes


def _angles(transform, lines, size):
    if not lines:
        return np.array([])
    ends = np.array([[s["a"], s["b"]] for s in lines]) / size
    moved = geometry.points(transform, ends).reshape(-1, 2, 2)
    d = (moved[:, 1] - moved[:, 0]) * size
    return (np.degrees(np.arctan2(d[:, 1], d[:, 0])) + 45) % 90 - 45


def _placement(xy, weights):
    centre = np.average(xy, axis=0, weights=weights)
    # Centre and thirds are alternatives, not a command to drag every subject onto a third.
    anchors = np.array([[.5, .5], [1/3, 1/3], [2/3, 1/3], [1/3, 2/3], [2/3, 2/3]])
    return float(np.min(np.linalg.norm(anchors - centre, axis=1)))


def measure(im, faces=(), subject=None):
    size, lines = alignment.detect(im, 40)
    boundary = alignment.measure(im, (size, lines))
    families = {key: _family(lines, vertical, size) for key, vertical in (("horizontal", False), ("vertical", True))}
    horizontal, vertical = families["horizontal"], families["vertical"]
    kh, kv = (horizontal or {}).get("slope", 0), (vertical or {}).get("slope", 0)
    a, b = (horizontal or {}).get("intercept", 0), (vertical or {}).get("intercept", 0)
    divisor = 1 - a * b
    kx, ky = (kh + a * kv) / divisor, (kv + b * kh) / divisor
    kx, ky = (float(np.clip(kx, -.5, .5)) if horizontal else 0,
              float(np.clip(ky, -.5, .5)) if vertical else 0)
    if abs(kx) < .025:
        kx = 0
    if abs(ky) < .025:
        ky = 0
    references = list({id(s): s for family in (horizontal, vertical) if family for s in family["lines"]}.values())
    if not (kx or ky):
        references = [s for s in lines if boundary and abs(s["angle"] + boundary["degrees"]) < 1.3]
    perspective, _ = geometry.matrix(*size, horizontal=kx, vertical=ky)
    corrected = _angles(perspective, references, size)
    weights = np.array([min(s["length"] / min(size), .9) for s in references])
    degrees = -alignment._median(corrected, weights) if len(corrected) else 0
    # A strongly tilted camera is a compositional choice, not reliable evidence of a tilted building.
    if abs(degrees) > 12 or len(corrected) and np.average(abs(corrected + degrees), weights=weights) > 1.6:
        kx = ky = 0
        references, weights = [], np.array([])
        degrees = 0
    if boundary and not (kx or ky):
        degrees = boundary["degrees"]
    if abs(degrees) < .15:
        degrees = 0
    xy, attention, faces = _attention(im, faces, subject)
    subject_samples = np.zeros(len(xy), dtype=bool)
    if subject and len(subject) == 4 and .001 < subject[2] * subject[3] < .5:
        x, y, w, h = subject
        subject_samples = (abs(xy[:, 0] - x - w / 2) < w / 2) & (abs(xy[:, 1] - y - h / 2) < h / 2)
    original_placement = _placement(xy, attention)
    original_angles = _angles(np.eye(3), references, size)
    original_error = float(np.average(np.minimum(15, abs(original_angles)), weights=weights)) if references else 0
    diagonals = [s for s in lines if 16 < abs(s["angle"]) < 39]
    diagonal = alignment._median([s["angle"] for s in diagonals], [s["length"] for s in diagonals]) if diagonals else None
    candidates = {(0., 0., 0.)}
    for fraction in (0, .35, .65, 1):
        for roll in (0, .65, 1):
            candidates.add((degrees * roll, kx * fraction, ky * fraction))
            if kx and ky:
                candidates.add((degrees * roll, kx * fraction, 0.))
                candidates.add((degrees * roll, 0., ky * fraction))
    # Expressive may follow the scene's own diagonal rhythm, never invent a random tilt on a blank picture.
    expressive_angles = [0]
    if diagonal is not None and sum(s["length"] for s in diagonals) > min(size) * .9:
        target = math.copysign(30, diagonal)
        shift = float(np.clip(target - diagonal, -6, 6))
        expressive_angles += [shift / 2, shift]
        candidates.update((d, kx * f, ky * f) for d in expressive_angles for f in (0, .35, .65))
    evaluated = []
    for roll, x, y in sorted(candidates):
        transform, _ = geometry.matrix(*size, roll, x, y)
        retained = geometry.retained(transform)
        if retained < .62:
            continue
        moved = geometry.points(transform, xy)
        inside = np.all((moved >= 0) & (moved <= 1), axis=1)
        subject_loss = float((subject_samples & ~inside).sum() / max(1, subject_samples.sum()))
        if subject_loss > .2:
            continue
        loss = float(attention[~inside].sum())
        clipping = distortion = 0.
        for face in faces:
            corners = geometry.points(transform, face)
            clipping = max(clipping, float(np.maximum(0, -corners).sum() + np.maximum(0, corners - 1).sum()))
            centre = face.mean(axis=0)
            local = geometry.points(transform, [centre, centre + [.001, 0], centre + [0, .001]])
            jacobian = ((local[1:] - local[0]) * size).T / (np.array(size) * .001)
            singular = np.linalg.svd(jacobian, compute_uv=False)
            distortion = max(distortion, abs(math.log(max(.001, singular[0] / singular[1]))))
        if clipping > .025 or distortion > .24:
            continue
        error = float(np.average(np.minimum(15, abs(_angles(transform, references, size))), weights=weights)) if references else 0
        placement = original_placement - _placement(moved[inside], attention[inside]) if inside.any() else -1
        rhythm = 0 if diagonal is None else (abs(abs(diagonal) - 30) - abs(abs(diagonal + roll) - 30)) / 8
        evaluated.append({"straighten": round(roll, 2), "skew": {"horizontal": round(x, 5), "vertical": round(y, 5)},
                          "retained": round(retained, 3), "_gain": (original_error - error) / 12, "_loss": loss,
                          "_distortion": distortion, "_clip": clipping, "_subject": subject_loss, "_placement": placement, "_rhythm": rhythm})
    views = {}
    for style in geometry.STYLES:
        def score(v):
            effort = abs(v["skew"]["horizontal"]) * (1 if style == "upright" else 1.8) + abs(v["skew"]["vertical"])
            structure = 6 if style == "upright" else 3 if style == "natural" else 1.5
            return (structure * v["_gain"] - .55 * (1 - v["retained"]) - 1.1 * v["_loss"] - 7 * v["_clip"]
                    - .5 * v["_distortion"] - 2.8 * v["_subject"] - (.06 if style == "upright" else .18) * effort
                    + .8 * v["_placement"] + (.5 * v["_rhythm"] if style == "expressive" else 0))
        allowed = [v for v in evaluated if style == "expressive" or v["straighten"] in {0, round(degrees * .65, 2), round(degrees, 2)}]
        best = max(allowed, key=score)
        original = next(v for v in evaluated if not v["straighten"] and not any(v["skew"].values()))
        if score(best) < score(original) + .012:
            best = original
        reasons = []
        if best["straighten"]:
            reasons.append("Follow the scene’s diagonal rhythm" if style == "expressive" and best["_rhythm"] > .1 else
                           "Level the horizon" if boundary and boundary["reference"] == "horizon" else "Balance the structural lines")
        if best["skew"]["vertical"]:
            reasons.append("Ease converging verticals")
        if best["skew"]["horizontal"]:
            reasons.append("Balance horizontal perspective")
        if (kx or ky) and abs(best["skew"]["horizontal"]) + abs(best["skew"]["vertical"]) < (abs(kx) + abs(ky)) * .9:
            reasons.append("Keep some of the scene’s depth")
        if not reasons:
            reasons.append("Keep the original composition" if boundary or kx or ky or diagonal is not None else "No reliable structural reference; keep the original view")
        if faces:
            reasons.append("Protect faces and their proportions")
        views[style] = {k: v for k, v in best.items() if not k.startswith("_")}
        views[style]["reasons"] = reasons
    return {"version": 1, "views": views, "evidence": {"lines": len(lines), "horizontal": (horizontal or {}).get("confidence", 0),
            "vertical": (vertical or {}).get("confidence", 0)}, "alignment": boundary}
