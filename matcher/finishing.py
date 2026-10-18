"""Deliberate colour and local brush adjustments, shared with static/photo-finish.js.

Masks stay in upright-original coordinates, so changing the crop or turning a photo never loses the painting.
Only the edited export is rasterised; the library keeps the strokes and the untouched source.
"""
from __future__ import annotations

import colorsys
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ZONES = ("shadows", "midtones", "highlights")
LOCAL = {"exposure": (-2, 2, 0), "contrast": (-1, 1, 0), "saturation": (0, 2, 1), "warmth": (-1, 1, 0)}


def number(value, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lo <= value <= hi:
        raise ValueError(f"Choose a number from {lo} to {hi}.")
    return round(value, 6)


def grade(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {*ZONES, "blending", "balance"}:
        raise ValueError("Colour grading uses shadows, midtones and highlights.")
    out = {}
    for zone in ZONES:
        if zone not in value:
            continue
        knobs = value[zone]
        if not isinstance(knobs, dict) or set(knobs) - {"hue", "amount", "light"}:
            raise ValueError("A colour wheel has hue, amount and light.")
        kept = {k: number(v, 0 if k != "light" else -1, 360 if k == "hue" else 1) for k, v in knobs.items()}
        if kept.get("amount", 0) or kept.get("light", 0):
            out[zone] = kept
    for key, lo, hi, default in (("blending", 0, 1, .5), ("balance", -1, 1, 0)):
        if key in value:
            v = number(value[key], lo, hi)
            if v != default:
                out[key] = v
    return out or None


def masks(value):
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 8:
        raise ValueError("Use up to eight adjustment masks per photo.")
    out, ids, total = [], set(), 0
    for layer in value:
        if not isinstance(layer, dict) or set(layer) - {"id", "name", "enabled", "opacity", "feather", "adjust", "strokes"}:
            raise ValueError("A mask has a name, brush strokes and adjustments.")
        ident, name = layer.get("id"), layer.get("name", "Mask")
        if not isinstance(ident, str) or not 1 <= len(ident) <= 64 or ident in ids or not isinstance(name, str) or len(name) > 80:
            raise ValueError("Give each mask its own name and identity.")
        ids.add(ident)
        enabled = layer.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("A mask is enabled or disabled.")
        adjust = layer.get("adjust", {})
        if not isinstance(adjust, dict) or set(adjust) - set(LOCAL):
            raise ValueError("Mask adjustments are exposure, contrast, saturation and warmth.")
        knobs = {key: number(v, *LOCAL[key][:2]) for key, v in adjust.items()}
        strokes = layer.get("strokes", [])
        if not isinstance(strokes, list) or len(strokes) > 200:
            raise ValueError("A mask holds up to 200 brush strokes.")
        kept = []
        for stroke in strokes:
            if not isinstance(stroke, dict) or set(stroke) != {"mode", "r", "p"} or stroke["mode"] not in ("paint", "erase"):
                raise ValueError("A stroke paints or erases a mask.")
            radius = number(stroke["r"], .001, .5)
            points = stroke["p"]
            if not isinstance(points, list) or not 1 <= len(points) <= 1000:
                raise ValueError("A brush stroke holds up to 1000 points.")
            clean = []
            for p in points:
                if not isinstance(p, list) or len(p) != 2:
                    raise ValueError("A brush point is two coordinates inside the photo.")
                clean.append([number(v, 0, 1) for v in p])
            total += len(clean)
            if total > 40000:
                raise ValueError("This photo has reached its brush detail limit.")
            kept.append({"mode": stroke["mode"], "r": radius, "p": clean})
        out.append({"id": ident, "name": name.strip() or "Mask", "enabled": enabled,
                    "opacity": number(layer.get("opacity", 1), 0, 1), "feather": number(layer.get("feather", .25), 0, 1),
                    "adjust": knobs, "strokes": kept})
    return out or None


def grade_table(value):
    """Three colour-balance curves. The browser uses these same 256 samples in sRGB component transfers."""
    value = value or {}
    v = np.linspace(0, 1, 256)
    t = np.clip(v + value.get("balance", 0) * .25, 0, 1)
    power = 1 + 3 * (1 - value.get("blending", .5))
    weights = ((1 - t) ** power, 1 - (1 - t) ** power - t ** power, t ** power)
    curves = np.tile(v[:, None], (1, 3))
    for zone, weight in zip(ZONES, weights):
        k = value.get(zone, {})
        rgb = np.array(colorsys.hsv_to_rgb(k.get("hue", 0) / 360, 1, 1))
        tint = (rgb - rgb.mean()) * k.get("amount", 0) * .3 + k.get("light", 0) * .25
        curves += weight[:, None] * tint
    return np.clip(curves, 0, 1)


def local_adjust(im, knobs):
    # A large RAW should not need several full-resolution floating-point copies for each mask.
    out = Image.new("RGB", im.size)
    weights = np.array([.213, .715, .072], dtype=np.float32)  # SVG's saturate matrix
    warmth = knobs.get("warmth", 0)
    gains = np.array([1 + .12 * warmth, 1, 1 - .12 * warmth], dtype=np.float32)
    for top in range(0, im.height, 256):
        bottom = min(im.height, top + 256)
        arr = np.asarray(im.crop((0, top, im.width, bottom)).convert("RGB"), dtype=np.float32) / 255
        arr *= 2 ** knobs.get("exposure", 0)
        np.clip(arr, 0, 1, out=arr)
        arr -= .5
        arr *= 1 + .6 * knobs.get("contrast", 0)
        arr += .5
        np.clip(arr, 0, 1, out=arr)
        luma = (arr * weights).sum(axis=2, keepdims=True)
        arr -= luma
        arr *= knobs.get("saturation", 1)
        arr += luma
        np.clip(arr, 0, 1, out=arr)
        arr *= gains
        np.clip(arr, 0, 1, out=arr)
        out.paste(Image.fromarray(np.round(arr * 255).astype(np.uint8)), (0, top))
    return out


def mask_image(layer, size):
    """Bounded brush proof, upsampled only over the exported crop. No full-RAW-sized mask allocation."""
    w, h = size
    scale = min(1, 1536 / max(w, h))
    w, h = max(1, round(w * scale)), max(1, round(h * scale))
    mask = Image.new("L", (w, h))
    draw = ImageDraw.Draw(mask)
    for stroke in layer["strokes"]:
        r = max(.5, stroke["r"] * min(w, h))
        points = [(x * w, y * h) for x, y in stroke["p"]]
        ink = 0 if stroke["mode"] == "erase" else 255
        if len(points) > 1:
            draw.line(points, fill=ink, width=max(1, round(r * 2)), joint="curve")
        for x, y in points:
            draw.ellipse((x - r, y - r, x + r, y + r), fill=ink)
    feather = layer.get("feather", .25) * min(w, h) * .02
    if feather:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    return mask


def apply(im, edits, original_size, rectangle, turn=0):
    if edits.get("grade"):
        lut = np.round(grade_table(edits["grade"]) * 255).astype(np.uint8)
        im = im.point(lut.T.reshape(-1).tolist())
    for layer in edits.get("masks", []):
        if not layer.get("enabled", True) or not layer.get("opacity", 1) or not layer.get("strokes"):
            continue
        mask = mask_image(layer, original_size)
        if turn:
            mask = mask.transpose({90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}[turn])
        source_w, source_h = original_size[::-1] if turn % 180 else original_size
        x0, y0, x1, y1 = rectangle
        extent = (x0 / source_w * mask.width, y0 / source_h * mask.height, x1 / source_w * mask.width, y1 / source_h * mask.height)
        mask = mask.transform(im.size, Image.Transform.EXTENT, extent, Image.Resampling.BILINEAR)
        if layer.get("opacity", 1) != 1:
            mask = mask.point(lambda v: round(v * layer["opacity"]))
        im = Image.composite(local_adjust(im, layer.get("adjust", {})), im, mask)
    return im


def straighten(im, degrees):
    """Keep the crop's aspect ratio and trim the rotated corners rather than introducing empty triangles."""
    if not degrees:
        return im
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    w, h = im.size
    scale = min(w / (w * abs(c) + h * abs(s)), h / (w * abs(s) + h * abs(c)))
    ow, oh = max(1, math.floor(w * scale)), max(1, math.floor(h * scale))
    return im.transform((ow, oh), Image.Transform.AFFINE,
                        (c, s, w / 2 - c * ow / 2 - s * oh / 2, -s, c, h / 2 + s * ow / 2 - c * oh / 2),
                        Image.Resampling.BICUBIC)
