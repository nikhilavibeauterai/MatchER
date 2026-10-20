"""Look for agreement between independent, long structural edges, with a single clear horizon as a fallback."""
from __future__ import annotations

import math

import cv2
import numpy as np


def _median(values, weights):
    order = np.argsort(values)
    return float(np.array(values)[order][np.searchsorted(np.cumsum(np.array(weights)[order]), sum(weights) / 2)])


def detect(im, max_angle=12):
    proof = im.convert("L").copy()
    proof.thumbnail((800, 800))
    gray = np.asarray(proof)
    h, w = gray.shape
    short = min(h, w)
    if short < 32:
        return (w, h), []
    detected = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD).detect(gray)[0]
    if detected is None:
        return (w, h), []
    lines = []
    for x0, y0, x1, y1 in detected.reshape(-1, 4):
        a, b = np.array([x0, y0]), np.array([x1, y1])
        length = float(np.linalg.norm(b - a))
        if length < max(32, short * .17):
            continue
        direction = (b - a) / length
        angle = (math.degrees(math.atan2(direction[1], direction[0])) + 45) % 90 - 45
        midpoint = (a + b) / 2
        vertical = abs(direction[1]) > abs(direction[0])
        # The image border, a letterbox or a vignette is not evidence about the scene's level.
        border = midpoint[0] < w * .025 or midpoint[0] > w * .975 if vertical else midpoint[1] < h * .025 or midpoint[1] > h * .975
        if abs(angle) > max_angle or border:
            continue
        lines.append(dict(a=a, b=b, length=length, direction=direction, angle=angle, mid=midpoint, vertical=vertical))
    # One edge often produces two detections. Repeated edges and long fragments of the same line get one vote.
    unique = []
    for line in sorted(lines, key=lambda s: s["length"], reverse=True)[:160]:
        duplicate = False
        for other in unique:
            if line["vertical"] != other["vertical"] or abs(line["angle"] - other["angle"]) > 1:
                continue
            delta, d = line["mid"] - other["mid"], other["direction"]
            distance = abs(delta[0] * d[1] - delta[1] * d[0])
            positions = sorted(float(np.dot(p - other["a"], d)) for p in (line["a"], line["b"]))
            overlap = max(0, min(other["length"], positions[1]) - max(0, positions[0]))
            if distance < max(3, short * .008) and overlap > line["length"] * .45:
                duplicate = True
                break
        if not duplicate:
            unique.append(line)
        if len(unique) >= 80:
            break
    return (w, h), unique


def measure(im, evidence=None):
    (w, h), unique = evidence if evidence is not None else detect(im)
    unique = [s for s in unique if abs(s["angle"]) <= 12]
    short = min(w, h)
    candidates = []
    for reference in unique:
        group = [s for s in unique if abs(s["angle"] - reference["angle"]) < 1.3]
        if not group:
            continue
        weights = [min(s["length"] / short, .9) for s in group]
        angle = _median([s["angle"] for s in group], weights)
        spread = sum(abs(s["angle"] - angle) * n for s, n in zip(group, weights)) / sum(weights)
        horizontal = [s for s in group if not s["vertical"]]
        vertical = [s for s in group if s["vertical"]]
        # Spatially separated references are more convincing than all four sides of a small tilted object.
        points = np.array([s["mid"] / [w, h] for s in group])
        extent = np.ptp(points, axis=0)
        parallel = len(horizontal) >= 2 and extent[1] > .15 or len(vertical) >= 2 and extent[0] > .15
        structure = len(group) >= 3 and horizontal and vertical and max(extent) > .28
        horizon = any(s["length"] > w * .68 and .15 < s["mid"][1] / h < .85 for s in horizontal)
        if spread > .65 or not (parallel or structure or horizon):
            continue
        cells = {}
        for s, weight in zip(group, weights):
            cell = (*np.floor(s["mid"] / [w, h] * 4).astype(int), s["vertical"])
            cells[cell] = min(1, cells.get(cell, 0) + weight)
        score = sum(cells.values()) * (1 + min(1, float(extent.sum())) * .5)
        if horizontal and vertical:
            score *= 1.25
        if len(vertical) >= 3 and extent[0] > .25:
            score *= 1.2
        candidates.append(dict(score=score, angle=angle, spread=spread, group=group,
                               reference="structure" if horizontal and vertical else "verticals" if vertical else "horizon"))
    if not candidates:
        return None
    candidates.sort(key=lambda c: c["score"], reverse=True)
    best = candidates[0]
    # Perspective, a tilted foreground object and a level background can disagree. Leave those to the manual slider.
    if any(c["score"] > best["score"] * .65 and abs(c["angle"] - best["angle"]) > 2 for c in candidates[1:]):
        return None
    angle = best["angle"]
    return {"degrees": round(-angle, 2) if abs(angle) >= .15 else 0,
            "perimeter": round(sum(s["length"] for s in best["group"]) / short, 2),
            "agreement": round(1 - best["spread"] / 1.3, 2), "support": len(best["group"]), "reference": best["reference"]}


def angle(recipe, edits=None):
    """Manual zero is a choice too. Alignment is independent of colour enhancement and cropping."""
    from .geometry import resolve
    return resolve(recipe, edits)["straighten"]
