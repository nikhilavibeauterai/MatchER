"""Edited copies use the saved automatic baseline, then manual light, colour, masks and framing.
The old proof-based look remains a fallback for exports from libraries that have not finished upgrading.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

from . import auto_look, finishing, geometry, imageio

PROOF = 64                 # the look is measured on a 64px-wide proof, like the on-screen filter
LOW, HIGH = 0.005, 0.995   # black and white points
QUALITY = 92
WINDOW = (0.89, 0.83125 * 4 / 3)   # the polaroid's window in card widths: what auto-crop frames on screen
ZOOM_CAP = 3.0                      # at most this much tighter than filling the window (the screen caps by preview pixels)
TURNS = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}  # clockwise
CROPS = ("best", "subject", "height", "width")  # auto-crop modes ("auto" is the old word for "subject"); anything else is off
# The Leaderboard's knobs on the auto look, name: (low, high, default). Mirrored by app.js (KNOBS).
KNOBS = {"levels": (0.0, 2.0, 1.0), "light": (-1.0, 1.0, 0.0), "contrast": (-1.0, 1.0, 0.0), "colour": (0.0, 2.0, 1.0), "warmth": (-1.0, 1.0, 0.0)}


def custom_crop(value) -> list[float] | None:
    """A manual rectangle in upright original-photo coordinates, independent of preview size or quarter turns."""
    if not isinstance(value, list) or len(value) != 4:
        return None
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
        return None
    x, y, w, h = value
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1.000001 or y + h > 1.000001:
        return None
    rectangle = [round(x, 6), round(y, 6), round(min(w, 1 - x), 6), round(min(h, 1 - y), 6)]
    return rectangle if min(rectangle[2:]) > 0 else None


def rotate_box(box, deg: int) -> list[float]:
    """A subject box ([x, y, w, h] as fractions) after turning the picture `deg` clockwise."""
    x, y, w, h = box
    deg = int(deg) % 360
    if deg == 90:
        return [1 - (y + h), x, h, w]
    if deg == 180:
        return [1 - (x + w), 1 - (y + h), w, h]
    if deg == 270:
        return [y, 1 - (x + w), h, w]
    return [x, y, w, h]


def crop_box(width: int, height: int, box, mode: str = "best") -> tuple[int, int, int, int]:
    """The pixel rectangle auto-crop shows, mirroring framePhoto() in app.js with the window in relative units since
    there is no screen here. "best": the crop that leaves the least paper showing in the window: the window filled
    exactly, preferring focus subject on a tie, then height or width. "subject": zoomed in until the subject
    fills the window's height (never more than ZOOM_CAP times tighter), centred on it unless that would leave a gap.
    "height": the picture fills the window's height and the subject is centred across (the whole width when the
    picture is narrower). "width": it fills the window's width and the subject is centred down it (the whole height
    when it is shorter)."""
    W, H = WINDOW
    cx = box[0] + box[2] / 2 if box else 0.5
    cy = box[1] + box[3] / 2 if box else 0.5
    if mode == "best":
        # The crop that uses the most of the window, among focus subject (when there is one), fill height and fill
        # width; on a tie focus subject wins, then whichever fill covers more (the owner's rule; frameRect in app.js
        # is the same).
        used = {"height": min(1.0, width * (H / height) / W), "width": min(1.0, height * (W / width) / H)}
        if box and box[3] > 0:
            used["subject"] = 1.0
        order = ("subject", "height", "width")
        mode = max(order, key=lambda m: (used.get(m, -1), -order.index(m)))
        return crop_box(width, height, box, mode)
    if mode == "height":
        s = H / height
        cw = min(width, W / s)
        x0 = min(width - cw, max(0.0, cx * width - cw / 2))
        return (int(round(x0)), 0, max(int(round(x0)) + 1, int(round(x0 + cw))), height)
    if mode == "width":
        s = W / width
        ch = min(height, H / s)
        y0 = min(height - ch, max(0.0, (cy * height - ch / 2) if box else 0.0))
        return (0, int(round(y0)), width, max(int(round(y0)) + 1, int(round(y0 + ch))))
    cover = max(W / width, H / height)
    s = min(max(H / (box[3] * height), cover), cover * ZOOM_CAP) if mode == "subject" and box and box[3] > 0 else cover
    dw, dh = width * s, height * s
    tx = min(0.0, max(W - dw, W / 2 - cx * dw))
    ty = min(0.0, max(H - dh, H / 2 - cy * dh))
    x0, y0 = -tx / s, -ty / s
    x1, y1 = min(width, x0 + W / s), min(height, y0 + H / s)
    return (int(round(x0)), int(round(y0)), max(int(round(x0)) + 1, int(round(x1))), max(int(round(y0)) + 1, int(round(y1))))


def knobs_of(look) -> dict:
    """The knobs with their defaults filled in and their ranges respected."""
    out = {}
    for key, (lo, hi, default) in KNOBS.items():
        try:
            value = float((look or {}).get(key, default))
        except (TypeError, ValueError):
            value = default
        out[key] = min(hi, max(lo, value)) if value == value else default
    return out


def tuned(how: dict, look=None) -> dict:
    """The auto look turned by the knobs: levels scaled, mid-tones lifted or lowered, a contrast slope about
    mid-grey, colour scaled, a warm or cool cast. app.js builds the same chain as an SVG filter."""
    k = knobs_of(look)
    slope = 1 + 0.6 * k["contrast"]
    return {"levels": [(1 + (a - 1) * k["levels"], b * k["levels"]) for a, b in how["levels"]],
            "curve": auto_look.mix_curve(how.get("curve"), k["levels"]),
            "gamma": min(2.2, max(0.4, how["gamma"] * (1 - 0.45 * k["light"]))),
            "contrast": (slope, (1 - slope) / 2), "saturation": max(0.0, how["saturation"] * k["colour"]),
            "warmth": k["warmth"]}


def look(im: Image.Image) -> dict:
    """Per-channel levels (slope and intercept on 0..1), gamma and saturation for one photo."""
    w = PROOF
    h = max(1, round(w * im.height / im.width))
    proof = np.asarray(im.convert("RGB").resize((w, h), Image.Resampling.BOX), dtype=np.float64)
    n = proof.shape[0] * proof.shape[1]
    chans = [proof[..., k].astype(np.int64) for k in range(3)]
    chans.append(np.floor(0.299 * chans[0] + 0.587 * chans[1] + 0.114 * chans[2]).astype(np.int64))  # luma, truncated

    def stretch(values: np.ndarray) -> tuple[float, float]:
        acc = np.cumsum(np.bincount(values.ravel(), minlength=256))
        lo = min(255, int(np.searchsorted(acc, LOW * n)))    # first level with at least that share below it
        hi = min(255, int(np.searchsorted(acc, HIGH * n)))
        a = min(2.2, 255 / max(48, hi - lo))
        return a, -lo / 255 * a

    luma_a, luma_b = stretch(chans[3])
    levels = []
    for k in range(3):
        a, b = stretch(chans[k])
        a2, b2 = luma_a + (a - luma_a) * 0.4, luma_b + (b - luma_b) * 0.4
        levels.append((1 + (a2 - 1) * 0.75, b2 * 0.75))
    weights = (0.299, 0.587, 0.114)
    mean = sum(wk * min(1.0, max(0.0, levels[k][0] * (chans[k].sum() / n / 255) + levels[k][1])) for k, wk in enumerate(weights))
    g0 = math.log(0.46) / math.log(min(0.95, max(0.05, mean)))
    gamma = 1 + (min(1.35, max(0.65, g0)) - 1) * 0.6
    chroma = float((proof.max(axis=2) - proof.min(axis=2)).sum())
    return {"levels": levels, "gamma": gamma, "saturation": 1.0 if chroma / n < 10 else 1.12}


def apply(im: Image.Image, how: dict | None = None, look_knobs=None) -> Image.Image:
    """The touched-up picture: levels, gamma and the contrast slope per channel (one lookup table), then the SVG
    `saturate` matrix and a warmth matrix in one colour conversion."""
    t = tuned(how or look(im), look_knobs)
    im = im.convert("RGB")
    x = np.arange(256) / 255
    slope, icpt = t["contrast"]
    lut: list[int] = []
    for a, b in t["levels"]:
        y = np.clip(a * x + b, 0, 1)
        if t["curve"]:
            y = np.interp(y, np.linspace(0, 1, len(t["curve"])), t["curve"])
        y = np.clip(y ** t["gamma"] * slope + icpt, 0, 1)
        lut.extend(int(v) for v in np.clip(np.round(y * 255), 0, 255))
    out = im.point(lut)
    s, w = t["saturation"], t["warmth"]
    if s != 1 or w:
        sat = np.array([[0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
                        [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
                        [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]])
        warm = np.diag([1 + 0.12 * w, 1.0, 1 - 0.12 * w])
        m = warm @ sat
        out = out.convert("RGB", tuple(float(v) for row in m for v in (*row, 0.0)))
    return out


def touch_up(src: str | Path, dst: str | Path, edits: dict | None = None, box=None, quality: int = QUALITY, recipe=None) -> dict | None:
    """Write `dst` as a JPEG of `src` the way the Leaderboard set it up: upright, turned (`rotate`, clockwise
    degrees), cropped (`crop` = "best" with a subject `box`, "height" or "width"), enhanced unless `enhance` is off,
    with its `look` knobs; full size, EXIF kept (its orientation reset, since the pixels are upright now). Returns
    the auto look applied, or None."""
    e = edits or {}
    rotate = int(e.get("rotate") or 0) % 360
    exif = None
    try:
        with Image.open(src) as opened:
            tags = opened.getexif()
            if tags:
                tags[0x0112] = 1
                exif = tags.tobytes()
    except Exception:  # no metadata worth keeping is not a reason to skip the picture
        exif = None
    im = imageio.decode(src).image
    original_size = im.size
    if rotate in TURNS:
        im = im.transpose(TURNS[rotate])
        box = rotate_box(box, rotate) if box else None
    baseline = auto_look.resolve(recipe, e) if recipe and e.get("enhance") is not False else None
    how = baseline or (look(im) if e.get("enhance") is not False else None)
    if baseline:
        im = auto_look.detail(im, baseline["detail"])
    mode = "subject" if e.get("crop") == "auto" else e.get("crop")
    manual = custom_crop(e.get("crop_box")) if mode == "custom" else None
    rectangle = (0, 0, im.width, im.height)
    if manual:
        x, y, w, h = rotate_box(manual, rotate)
        x0, y0 = round(x * im.width), round(y * im.height)
        rectangle = (x0, y0, max(x0 + 1, round((x + w) * im.width)), max(y0 + 1, round((y + h) * im.height)))
    elif mode in CROPS and (box or mode != "subject"):
        rectangle = crop_box(im.width, im.height, box, mode)
    im = im.crop(rectangle)
    out = apply(im, how, e.get("look")) if how else im.convert("RGB")
    if baseline:
        out = finishing.apply(out, baseline, original_size, rectangle, rotate)
    out = finishing.apply(out, e, original_size, rectangle, rotate)
    full_w, full_h = original_size[::-1] if rotate % 180 else original_size
    x0, y0, x1, y1 = rectangle
    view = geometry.region(geometry.resolve(recipe, e), rotate, (x0 / full_w, y0 / full_h, (x1-x0) / full_w, (y1-y0) / full_h))
    out = finishing.perspective(out, view)
    if exif:
        out.save(dst, "JPEG", quality=quality, exif=exif)
    else:
        out.save(dst, "JPEG", quality=quality)
    return how
