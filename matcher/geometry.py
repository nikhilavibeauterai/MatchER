"""Photo geometry in centred, original-image coordinates, mirrored by static/photo-geometry.js.

Perspective is a projective correction, not an affine shear. The largest centred rectangle without empty
corners keeps the crop's aspect ratio; previews and exports use the same inverse mapping.
"""
from __future__ import annotations

import math

import numpy as np

STYLES = ("natural", "upright", "expressive")


def resolve(recipe=None, edits=None):
    r, e = recipe or {}, edits or {}
    style = e.get("composition", "natural")
    view = ((r.get("composition") or {}).get("views") or {}).get(style, {})
    automatic = e.get("auto_align", True)
    degrees = e.get("straighten")
    if degrees is None:
        degrees = view.get("straighten", r.get("straighten")) if automatic and r.get("version", 3) >= 3 else 0
    skew = dict(view.get("skew", r.get("skew")) or {}) if e.get("auto_skew", automatic) and r.get("version", 0) >= 4 else {}
    skew.update(e.get("skew") or {})
    return {"straighten": degrees or 0, "horizontal": skew.get("horizontal", 0), "vertical": skew.get("vertical", 0)}


def region(value, turn=0, box=(0, 0, 1, 1)):
    """A saved perspective still describes the same scene after a quarter turn or a smaller source crop."""
    x, y = value.get("horizontal", 0), value.get("vertical", 0)
    turn %= 360
    x, y = (-y, x) if turn == 90 else (-x, -y) if turn == 180 else (y, -x) if turn == 270 else (x, y)
    left, top, w, h = box
    d = 1 + x * (left + w / 2 - .5) + y * (top + h / 2 - .5)
    return {"straighten": value.get("straighten", 0), "horizontal": x * w / d, "vertical": y * h / d}


def matrix(w, h, degrees=0, horizontal=0, vertical=0):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    rotation = np.array([[c, -s * h / w, 0], [s * w / h, c, 0], [0, 0, 1.]])
    project = np.array([[1., 0, 0], [0, 1, 0], [horizontal, vertical, 1]])
    # Each inverse-mapped output corner must remain on the positive side of all four source edges.
    trim = 1.
    for x, y in ((-.5, -.5), (.5, -.5), (.5, .5), (-.5, .5)):
        u, v = c * x + s * h / w * y, -s * w / h * x + c * y
        denominator = max(2 * abs(u), 2 * abs(v)) + horizontal * u + vertical * v
        if denominator > 0:
            trim = min(trim, 1 / denominator)
    shift = np.array([[1., 0, .5], [0, 1, .5], [0, 0, 1]])
    centre = np.array([[1., 0, -.5], [0, 1, -.5], [0, 0, 1]])
    transform = shift @ np.diag([1 / trim, 1 / trim, 1]) @ rotation @ project @ centre
    return transform, trim


def points(transform, xy):
    p = np.column_stack((np.asarray(xy).reshape(-1, 2), np.ones(np.asarray(xy).size // 2))) @ transform.T
    return p[:, :2] / p[:, 2:]


def retained(transform):
    corners = points(np.linalg.inv(transform), [(0, 0), (1, 0), (1, 1), (0, 1)])
    return float(abs(np.dot(corners[:, 0], np.roll(corners[:, 1], -1)) - np.dot(corners[:, 1], np.roll(corners[:, 0], -1))) / 2)
