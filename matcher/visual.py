"""Small measured colour coordinates for the sea, independent of similarity and stack membership."""
from __future__ import annotations

import math

import cv2
import numpy as np


def colour_metrics(bgr: np.ndarray) -> dict:
    """Reuse the decoder's bounded sample. Hue is circular and ignores colourless pixels."""
    height, width = bgr.shape[:2]
    if max(height, width) > 384:
        bgr = cv2.resize(bgr, (max(1, width * 384 // max(height, width)),
                               max(1, height * 384 // max(height, width))), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    saturation = hsv[..., 1] / 255
    weights = saturation * (hsv[..., 2] / 255)
    total = float(weights.sum())
    hue = None
    if total and float(saturation.mean()) >= .01:
        angle = hsv[..., 0] * (math.pi / 90)
        x, y = float((np.cos(angle) * weights).sum()), float((np.sin(angle) * weights).sum())
        # Opposing colours have no honest single hue, even when both are strongly saturated.
        if math.hypot(x, y) / total >= .08:
            hue = round((math.atan2(y, x) / math.tau) % 1, 6) % 1
    return {"saturation": round(float(saturation.mean()), 6), "hue": hue}


def descriptor(luma=None, chroma=None, saturation=None, hue=None) -> dict:
    """Both old and new libraries use the same measured colourfulness axis, without another decode."""
    def unit(value, scale=1):
        if not isinstance(value, (float, int)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= scale:
            return None
        return round(value / scale, 5)
    # Green/magenta reach about 192 on this YCrCb distance. It measures colourfulness, not HSV saturation.
    colour = unit(chroma, 255)
    return {"brightness": unit(luma, 255), "colorfulness": round(min(chroma / 192, 1), 5) if colour is not None else None,
            "saturation": unit(saturation),
            "hue": unit(hue), "chroma": unit(chroma, 255)}


def salient_box(bgr: np.ndarray, aspect: float = 0.8) -> list[float] | None:
    """A frame around what the eye lands on when there is no face to frame: a dog, a flower, a car, a person seen
    from behind. OpenCV's spectral-residual saliency (no model; a few milliseconds on the analysis sample), its
    peak region kept (the parts at least six tenths as salient as the most salient spot, joined where they sit
    together), boxed with a margin and brought to the portrait frame's aspect like the face frame (which may reach
    past the picture: the screen clamps it). None when nothing stands out: a flat field, a texture, or salience
    spread over the whole picture (a landscape), which the centre frames as well as anything. [x, y, w, h],
    normalized to the picture."""
    height, width = bgr.shape[:2]
    if height < 8 or width < 8 or not hasattr(cv2, "saliency"):
        return None
    ok, sal = cv2.saliency.StaticSaliencySpectralResidual_create().computeSaliency(bgr)
    if not ok or sal is None:
        return None
    sal = cv2.GaussianBlur(sal.astype(np.float32), (0, 0), max(1.0, min(width, height) / 64))
    peak = float(sal.max())
    if peak <= 1e-6:
        return None
    mask = (sal >= 0.6 * peak).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n < 2:
        return None
    areas = stats[1:, cv2.CC_STAT_AREA]
    lead = 1 + int(np.argmax(areas))
    lx, ly, lw, lh, larea = (int(v) for v in stats[lead])
    if larea < 0.002 * width * height:  # specks: nothing in particular stands out
        return None
    # The subject's other salient parts join the frame: regions a quarter the size or more, within a region's
    # reach of the largest one.
    x0, y0, x1, y1 = lx, ly, lx + lw, ly + lh
    reach = max(lw, lh)
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        if i == lead or area < 0.25 * larea:
            continue
        if abs(x + w / 2 - (lx + lw / 2)) <= reach and abs(y + h / 2 - (ly + lh / 2)) <= reach:
            x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x + w), max(y1, y + h)
    if (x1 - x0) * (y1 - y0) > 0.6 * width * height:  # salience everywhere: no particular subject
        return None
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    fw, fh = (x1 - x0) * 1.5, (y1 - y0) * 1.5
    if fw / fh > aspect:
        fh = fw / aspect
    else:
        fw = fh * aspect
    fx = (width - fw) / 2 if fw >= width else min(max(0.0, cx - fw / 2), width - fw)
    fy = (height - fh) / 2 if fh >= height else min(max(0.0, cy - fh / 2), height - fh)
    return [round(fx / width, 4), round(fy / height, 4), round(fw / width, 4), round(fh / height, 4)]
