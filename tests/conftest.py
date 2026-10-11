"""Synthetic libraries: real image files and a fully 'analyzed' database, no models needed."""
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")  # as the app does (matcher/__main__.py)

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from PIL import Image  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from matcher import library  # noqa: E402
from matcher.store import Store, f16, f32  # noqa: E402


def _unit(v):
    return v / np.linalg.norm(v)


def write_photo(path: Path, color, taken: datetime | None = None, size=(1200, 1600), fmt="JPEG", orientation=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.new("RGB", size, color)
    for k in range(0, size[0], 97):  # some texture
        im.paste(tuple(int(c * 0.7) for c in color), (k, 0, k + 20, size[1]))
    kw = {}
    ex = Image.Exif()
    if taken is not None:
        ex.get_ifd(0x8769)[36867] = taken.strftime("%Y:%m:%d %H:%M:%S")
        ex[271], ex[272] = "TestCam", "T1"
        ex[0x8825] = {1: "N", 2: (40.0, 1.0, 1.0)}  # GPS block that must never leak
    if orientation:
        ex[0x0112] = orientation
    if len(ex) or taken is not None:
        kw["exif"] = ex
    im.save(path, fmt, **kw)
    return path


@pytest.fixture
def fake_prompts(monkeypatch):
    rng = np.random.default_rng(99)
    cache = {}

    def fake(prompts):
        for p in prompts:
            if p not in cache:
                cache[p] = _unit(rng.normal(0, 1, 768)).astype(np.float32)
        return np.stack([cache[p] for p in prompts])

    monkeypatch.setattr(library, "_prompt_embeddings", fake)
    return fake


def build_library(root: Path, workdir: Path, n_singles=24, bursts=((4, "burst"),), strangers=3, screenshots=1, seed=0):
    """Source photos on disk + an analyzed Store, as the Analyzer would leave it."""
    rng = np.random.default_rng(seed)
    src = root
    store = Store(workdir / "matcher.db")
    (workdir / "previews").mkdir(parents=True, exist_ok=True)
    (workdir / "thumbs").mkdir(parents=True, exist_ok=True)
    me = _unit(rng.normal(0, 1, 128))
    friend = _unit(rng.normal(0, 1, 128))
    t0 = datetime(2026, 5, 1, 12, 0, 0)
    specs = []
    for i in range(n_singles):
        specs.append(dict(rel=f"cam/IMG_{i:04d}.jpg", taken=t0 + timedelta(hours=3 * i), emb=_unit(rng.normal(0, 1, 768)),
                          faces=[(me, 0.25)] + ([(friend, 0.2)] if i % 6 == 0 else []), smile=float(rng.random())))
    for size, tag in bursts:
        base = _unit(rng.normal(0, 1, 768))
        for k in range(size):
            specs.append(dict(rel=f"cam/{tag}_{k}.jpg", taken=t0 + timedelta(days=40, seconds=2 * k),
                              emb=_unit(base + rng.normal(0, 0.006, 768)), faces=[(me, 0.3)], smile=0.2 + 0.15 * k))
    for i in range(strangers):
        specs.append(dict(rel=f"other/stranger_{i}.jpg", taken=t0 + timedelta(days=60 + i), emb=_unit(rng.normal(0, 1, 768)),
                          faces=[(_unit(rng.normal(0, 1, 128)), 0.3)], smile=0.5))
    for i in range(screenshots):
        specs.append(dict(rel=f"Screenshot_2026100{i}-101010_Chat.jpg", taken=None, emb=_unit(rng.normal(0, 1, 768)),
                          faces=[], smile=0))
    # same filename in two folders
    specs.append(dict(rel="a/IMG_9999.jpg", taken=t0 + timedelta(days=80), emb=_unit(rng.normal(0, 1, 768)), faces=[(me, 0.2)], smile=0.6))
    specs.append(dict(rel="b/IMG_9999.jpg", taken=t0 + timedelta(days=90), emb=_unit(rng.normal(0, 1, 768)), faces=[(me, 0.2)], smile=0.6))

    with store.tx() as c:
        for n, sp in enumerate(specs):
            color = tuple(int(x) for x in rng.integers(40, 220, 3))
            write_photo(src / sp["rel"], color, sp["taken"])
            cur = c.execute(
                "INSERT INTO photos(rel, size, mtime_ns, sha256, status, width, height, fmt, taken, taken_ts, taken_src, "
                "make, model, phash, luma, luma_lo, luma_hi, sharp, chroma, n_faces, emb, crop_emb) "
                "VALUES(?,?,?,?, 'analyzed', 1200, 1600, 'JPEG', ?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (sp["rel"], 1, 1, f"sha{n}", sp["taken"].isoformat() if sp["taken"] else None,
                 sp["taken"].timestamp() if sp["taken"] else None, "exif" if sp["taken"] else "",
                 "TestCam" if sp["taken"] else "", "T1" if sp["taken"] else "",
                 f"{int(rng.integers(0, 2**62)):016x}", 120.0, 20.0, 230.0, 200.0, 20.0, len(sp["faces"]),
                 f16(sp["emb"]), f16(sp["emb"])))
            pid = cur.lastrowid
            Image.new("RGB", (120, 160), color).save(workdir / "previews" / f"{pid}.jpg")
            Image.new("RGB", (60, 80), color).save(workdir / "thumbs" / f"{pid}.jpg")
            for k, (who, w) in enumerate(sp["faces"]):
                c.execute("INSERT INTO faces(photo_id, idx, x, y, w, h, score, lm, emb, sharp, luma, blink_l, blink_r, smile, "
                          "jaw, squint, yaw, pitch, roll) VALUES(?,?,?,?,?,?,0.95,'[]',?,120,130,0.1,0.1,?,0,0,0,0,0)",
                          (pid, k, 0.3 + 0.3 * k, 0.2, w, w * 0.75, f32(_unit(who + rng.normal(0, 0.08, 128))), sp["smile"]))
    return store, specs


@pytest.fixture
def lib_env(tmp_path, fake_prompts):
    src = tmp_path / "photos"
    work = tmp_path / "work"
    store, specs = build_library(src, work)
    return src, work, store, specs
