"""Paths and constants shared across the app."""
from __future__ import annotations

from pathlib import Path

from .platforms import storage_paths

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR, MODELS_DIR = storage_paths(ROOT)

RAW_EXTS = {".nef", ".dng", ".raw", ".arw", ".cr2", ".cr3", ".orf", ".rw2", ".raf", ".pef"}  # camera raw files, read through LibRaw
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".bmp", ".avif"} | RAW_EXTS

PREVIEW_EDGE = 1600   # what the duel screen shows
THUMB_EDGE = 400      # grids
EXPORT_EDGE = 2048    # what gets sent out for review

DEFAULT_SETTINGS = {
    "finalists": 40,        # size of the shortlist the tournament settles
    "per_scene": 3,         # at most this many shots from one scene in the shortlist
    "max_age_years": 0,     # 0 = keep old photos (they only get a prior penalty)
    "match": "normal",      # how strictly a face must match yours: strict | normal | loose
    "mode": "me",           # me: photos of you (profile pics) | gallery: anything (landscapes, food, pets...)
    "help": True,            # save-specific on-screen controls and guidance
}
