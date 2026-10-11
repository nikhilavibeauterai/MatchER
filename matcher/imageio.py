"""Decode photos the way a phone shows them: upright, in sRGB, with all metadata dropped."""
from __future__ import annotations

import hashlib
import io
import math
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageCms, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # HEIC support is optional
    pass

Image.MAX_IMAGE_PIXELS = 150_000_000  # Pillow refuses outright past twice this (300 MP)
MAX_PIXELS_FULL = 120_000_000         # formats decoded at full size first (PNG, HEIC, WebP…): ~360 MB of RGB

EXIF_IFD = 0x8769
ORIENTATION, MAKE, MODEL = 0x0112, 271, 272
DATETIME_ORIGINAL, DATETIME_DIGITIZED, SUBSEC_ORIGINAL = 36867, 36868, 37521

_SRGB = ImageCms.createProfile("sRGB")
_TRANSFORMS: dict[tuple[bytes, str], object] = {}

# 20250612_183012, 2025-06-12_18-30-12, Screenshot_20261008-095104, PXL_20250612_183012345
_NAME_TS = re.compile(r"(?<!\d)((?:19|20)\d\d)[-_]?(\d\d)[-_]?(\d\d)[-_ T]?(\d\d)[-_.]?(\d\d)[-_.]?(\d\d)")
# IMG-20250612-WA0001 (date only)
_NAME_DATE = re.compile(r"(?<!\d)((?:19|20)\d\d)[-_]?(\d\d)[-_]?(\d\d)(?!\d)")


@dataclass
class Decoded:
    image: Image.Image   # RGB, upright, sRGB, metadata-free, at most max_edge on the long side
    width: int           # full-resolution upright size
    height: int
    fmt: str
    taken: datetime | None
    taken_src: str       # "exif", "filename" or ""
    make: str
    model: str


def taken_from_name(name: str) -> datetime | None:
    for rx, n in ((_NAME_TS, 6), (_NAME_DATE, 3)):
        for m in rx.finditer(name):
            try:
                return datetime(*(int(g) for g in m.groups()[:n]))
            except ValueError:
                continue
    return None


def _exif(im: Image.Image) -> tuple[datetime | None, str, str, int]:
    try:
        ex = im.getexif()
    except Exception:
        return None, "", "", 1
    ifd = {}
    try:
        if EXIF_IFD in ex:
            ifd = ex.get_ifd(EXIF_IFD)
    except Exception:
        pass
    taken = None
    raw = ifd.get(DATETIME_ORIGINAL) or ex.get(DATETIME_ORIGINAL) or ifd.get(DATETIME_DIGITIZED)
    if raw:
        try:
            if isinstance(raw, bytes):
                raw = raw.decode("ascii", "ignore")
            taken = datetime.strptime(str(raw).strip()[:19], "%Y:%m:%d %H:%M:%S")
            sub = str(ifd.get(SUBSEC_ORIGINAL) or "").strip()
            if sub.isdigit():
                taken = taken.replace(microsecond=int((sub + "000000")[:6]))
        except (ValueError, TypeError):
            taken = None

    def text(tag: int) -> str:
        v = ex.get(tag)
        if isinstance(v, bytes):
            v = v.decode("ascii", "ignore")
        return str(v).strip("\x00 ").strip() if v else ""

    try:
        orientation = int(ex.get(ORIENTATION, 1) or 1)
    except (TypeError, ValueError):
        orientation = 1
    return taken, text(MAKE), text(MODEL), orientation


def _to_srgb(im: Image.Image, icc: bytes | None) -> Image.Image:
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        flat = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        flat.alpha_composite(rgba)
        im = flat.convert("RGB")
    if icc and im.mode in ("RGB", "CMYK", "L"):
        key = (hashlib.sha1(icc).digest(), im.mode)
        if key not in _TRANSFORMS:
            try:
                src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
                _TRANSFORMS[key] = ImageCms.buildTransform(src, _SRGB, im.mode, "RGB",
                                                           renderingIntent=ImageCms.Intent.PERCEPTUAL)
            except Exception:
                _TRANSFORMS[key] = None
        transform = _TRANSFORMS[key]
        if transform is not None:
            try:
                return ImageCms.applyTransform(im, transform)
            except Exception:
                pass
    return im if im.mode == "RGB" else im.convert("RGB")


def decode(src: str | Path | bytes, max_edge: int | None = None, name: str = "") -> Decoded:
    """Open a photo upright and in sRGB. With max_edge, JPEGs are decoded at reduced scale (fast)."""
    if isinstance(src, bytes):
        src = io.BytesIO(src)
    with Image.open(src) as opened:
        fmt = opened.format or ""
        taken, make, model, orientation = _exif(opened)
        taken_src = "exif" if taken else ""
        if taken is None and name:
            taken = taken_from_name(name)
            taken_src = "filename" if taken else ""
        w0, h0 = opened.size
        if fmt not in ("JPEG", "MPO") and w0 * h0 > MAX_PIXELS_FULL:  # JPEGs decode at reduced scale instead
            raise ValueError(f"{w0}x{h0} is too large to open safely")
        full = (h0, w0) if orientation in (5, 6, 7, 8) else (w0, h0)
        icc = opened.info.get("icc_profile")
        if max_edge and fmt in ("JPEG", "MPO"):  # MPO = camera JPEG with an embedded preview (e.g. Sony)
            scale = max_edge / max(w0, h0)
            if scale < 1:
                opened.draft("RGB", (max(1, math.ceil(w0 * scale)), max(1, math.ceil(h0 * scale))))
        im = ImageOps.exif_transpose(opened)
        im = _to_srgb(im, icc)
    if max_edge and max(im.size) > max_edge:
        im.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS, reducing_gap=3.0)
    im.info.clear()
    return Decoded(im, full[0], full[1], fmt, taken, taken_src, make, model)


def save_jpeg(im: Image.Image, path: str | Path, quality: int, max_edge: int | None = None) -> None:
    """Write a metadata-free JPEG (no EXIF, GPS, XMP or ICC; pixels are already sRGB)."""
    if max_edge and max(im.size) > max_edge:
        im = im.copy()
        im.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS, reducing_gap=3.0)
    im.save(path, "JPEG", quality=quality)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()
