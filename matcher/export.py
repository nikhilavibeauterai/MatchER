"""The review package: neutral filenames, shuffled order, no metadata; the key stays local."""
from __future__ import annotations

import csv
import hashlib
import json
import logging
import os
import secrets
import shutil
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from PIL import Image

from . import imageio, touchup
from .config import EXPORT_EDGE

log = logging.getLogger(__name__)

README = """\
share/review_photos.zip   send this (P001.jpg, P002.jpg, ... in shuffled order, no EXIF/GPS)
share/photos/             the same files loose, if a zip upload misbehaves
KEY.PRIVATE.csv           keep this: maps each P-number to the original file, its rank and the
                    model's confidence. Share it only after the reviews are back.

{n} photos: {ranked} from the tournament{rescued}.
Metadata is stripped; pixels are not. Look through them once for anything in the frame
you would not want a stranger to see (addresses, screens, other people).
"""


def build(source_root: Path, out_root: Path, rows: list[dict], edge: int = EXPORT_EDGE) -> dict:
    """rows: {photo_id, rel, rank (int or ''), kind ('ranked'|'added'), p_in, appeal, duels, flags}."""
    if not rows:
        raise ValueError("Nothing to export yet.")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = out_root / f"export-{stamp}"
    n = 1
    while dest.exists():
        n += 1
        dest = out_root / f"export-{stamp}-{n}"
    share = dest / "share"  # everything meant for other people, apart from the private key
    photos = share / "photos"
    photos.mkdir(parents=True)
    salt = secrets.token_hex(8)
    order = sorted(rows, key=lambda r: hashlib.sha256(f"{salt}:{r['photo_id']}".encode()).hexdigest())
    key = []
    for i, r in enumerate(order, 1):
        src = source_root / r["rel"]
        d = imageio.decode(src, max_edge=edge)  # upright, sRGB; JPEGs decoded at the nearest scale >= edge
        name = f"P{i:03d}.jpg"
        imageio.save_jpeg(d.image, photos / name, 92, edge)
        check_clean(photos / name)  # belt and braces: nothing but pixels and the tables to decode them
        key.append({"file": name, "rank": r.get("rank", ""), "kind": r["kind"], "original": str(src),
                    "taken": r.get("taken") or "", "in_top_k_probability": r.get("p_in", ""),
                    "appeal": r.get("appeal", ""), "duels": r.get("duels", ""), "flags": " ".join(r.get("flags") or [])})
    with (dest / "KEY.PRIVATE.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(key[0]))
        w.writeheader()
        w.writerows(sorted(key, key=lambda k: (k["kind"] != "ranked", k["rank"] if k["rank"] != "" else 10**6)))
    with zipfile.ZipFile(share / "review_photos.zip", "w", compression=zipfile.ZIP_STORED) as z:
        for p in sorted(photos.glob("P*.jpg")):
            info = zipfile.ZipInfo(p.name, date_time=(1980, 1, 1, 0, 0, 0))  # no export time inside either
            z.writestr(info, p.read_bytes())
    ranked = sum(1 for r in rows if r["kind"] == "ranked")
    added = len(rows) - ranked
    (dest / "README.txt").write_text(README.format(n=len(rows), ranked=ranked,
                                                   rescued=f" + {added} you added by hand" if added else ""))
    return {"dir": str(dest), "zip": str(share / "review_photos.zip"), "count": len(rows), "ranked": ranked,
            "added": added}


# JPEG segments a plain re-encoded photo needs; anything else (EXIF/XMP in APP1, ICC in APP2, IPTC in APP13,
# comments) could carry identifying data. SOF0-15 except DHT/JPG/DAC markers, plus restart markers in the scan.
_ALLOWED = {0xD8, 0xE0, 0xDB, 0xC4, 0xDD, 0xDA, 0xD9} | {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB,
                                                         0xCD, 0xCE, 0xCF}


def check_clean(path: Path) -> None:
    """Refuse a JPEG with any segment outside the allowlist (APP0 must be plain JFIF)."""
    data = path.read_bytes()
    i = 2
    if data[:2] != b"\xff\xd8":
        raise RuntimeError(f"{path.name} is not a JPEG")
    while i < len(data):
        if data[i] != 0xFF:
            raise RuntimeError(f"{path.name}: malformed JPEG")
        marker = data[i + 1]
        if marker == 0xD9:
            return
        if marker not in _ALLOWED:
            raise RuntimeError(f"metadata survived in {path.name} (segment 0x{marker:02X})")
        size = int.from_bytes(data[i + 2:i + 4], "big")
        if marker == 0xE0 and data[i + 4:i + 9] != b"JFIF\x00":
            raise RuntimeError(f"{path.name}: unexpected APP0 segment")
        if marker == 0xDA:  # entropy-coded data runs to the next real marker
            j = i + 2 + size
            while j < len(data) - 1 and not (data[j] == 0xFF and data[j + 1] not in (0x00, *range(0xD0, 0xD8))):
                j += 1
            i = j
            continue
        i += 2 + size


def bestof(source_root: Path, out_root: Path, rows: list[dict], label: str = "best", touch: bool = True) -> dict:
    """Your top shots as the original files (metadata and all), named by rank: for keeping, not for strangers.
    rows: {rel, rank (int, or None for ones you added by hand), edits (the Leaderboard's choices), box (subject)}.
    `touched up/` gets a copy of each the way the Leaderboard set it up: enhanced unless switched off, turned or
    cropped where chosen (full size, EXIF kept), unless `touch` is off."""
    if not rows:
        raise ValueError("Nothing to export yet.")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = out_root / f"{label}-{stamp}"
    n = 1
    while dest.exists():
        n += 1
        dest = out_root / f"{label}-{stamp}-{n}"
    dest.mkdir(parents=True)
    width = max(2, len(str(len(rows))))
    used: set[str] = set()
    copies: list[tuple[Path, str, dict, list | None, dict | None]] = []
    for r in rows:
        src = source_root / r["rel"]
        rank = str(r["rank"]).zfill(width) if r.get("rank") else "+" * width
        stem, suffix = Path(r["rel"]).stem, Path(r["rel"]).suffix
        name, n = f"{rank} - {stem}{suffix}", 2
        while name.lower() in used:  # two photos called IMG_0001.jpg from different folders
            name, n = f"{rank} - {stem} ({n}){suffix}", n + 1
        used.add(name.lower())
        shutil.copy2(src, dest / name)
        copies.append((src, name, r.get("edits") or {}, r.get("box"), r.get("auto_look")))
    touched = 0
    if touch:
        touched = touch_up_all(copies, dest / "touched up")
    return {"dir": str(dest), "count": len(rows), "kind": "bestof", "touched": touched,
            "touched_dir": str(dest / "touched up") if touch else None}


def touch_up_all(copies: list[tuple[Path, str, dict, list | None, dict | None]], where: Path) -> int:
    """Touched-up JPEG copies of (source, exported name, edits, subject box, saved baseline), a few at a time
    (decoding and encoding release the GIL). A photo that cannot be touched up is skipped, not fatal. Returns how
    many were written."""
    where.mkdir(exist_ok=True)
    taken: set[str] = set()
    jobs = []
    for src, name, edits, box, recipe in copies:
        out, n = f"{Path(name).stem}.jpg", 2
        while out.lower() in taken:  # IMG_1.png and IMG_1.jpg both become IMG_1.jpg
            out, n = f"{Path(name).stem} ({n}).jpg", n + 1
        taken.add(out.lower())
        jobs.append((src, where / out, edits, box, recipe))

    def one(job: tuple[Path, Path, dict, list | None, dict | None]) -> bool:
        src, dst, edits, box, recipe = job
        try:
            touchup.touch_up(src, dst, edits, box, recipe=recipe)
            return True
        except Exception as e:  # a corrupt or oversized file: the untouched original is still in the folder
            log.warning("could not touch up %s: %s", src, e)
            dst.unlink(missing_ok=True)
            return False
    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 1)) as pool:
        return sum(pool.map(one, jobs))
