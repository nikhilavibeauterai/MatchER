"""Paths and constants shared across the app."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.environ.get("MATCHER_MODELS", ROOT / "models"))
DATA_DIR = Path(os.environ.get("MATCHER_DATA", ROOT / "data"))

PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".bmp", ".avif"}

PREVIEW_EDGE = 1600   # what the duel screen shows
THUMB_EDGE = 400      # grids
EXPORT_EDGE = 2048    # what gets sent out for review

DEFAULT_SETTINGS = {
    "finalists": 40,        # size of the shortlist the tournament settles
    "per_scene": 3,         # at most this many shots from one scene in the shortlist
    "max_age_years": 0,     # 0 = keep old photos (they only get a prior penalty)
    "match": "normal",      # how strictly a face must match yours: strict | normal | loose
    "mode": "me",           # me: photos of you (profile pics) | gallery: anything (landscapes, food, pets...)
}
