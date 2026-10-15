"""Decoding (orientation, color, formats) and the privacy of the export package."""
import csv
import zipfile
from datetime import datetime
from pathlib import Path

import pytest
from PIL import Image

from matcher import export, imageio
from tests.conftest import write_photo


def test_orientation_applied_and_full_size_reported(tmp_path):
    p = write_photo(tmp_path / "rot.jpg", (200, 30, 30), datetime(2025, 1, 2, 3, 4, 5), size=(400, 300), orientation=6)
    d = imageio.decode(p)
    assert d.image.size == (300, 400)            # rotated upright
    assert (d.width, d.height) == (300, 400)
    assert d.taken == datetime(2025, 1, 2, 3, 4, 5) and d.taken_src == "exif"
    assert d.make == "TestCam"


def test_reduced_decode_respects_max_edge(tmp_path):
    p = write_photo(tmp_path / "big.jpg", (10, 120, 200), datetime(2025, 1, 1), size=(4000, 3000))
    d = imageio.decode(p, max_edge=1600)
    assert max(d.image.size) == 1600
    assert (d.width, d.height) == (4000, 3000)


def test_png_alpha_and_filename_dates(tmp_path):
    p = tmp_path / "IMG_20240102_030405.png"
    Image.new("RGBA", (50, 40), (255, 0, 0, 0)).save(p)
    d = imageio.decode(p, name=p.name)
    assert d.image.mode == "RGB" and d.image.getpixel((0, 0)) == (255, 255, 255)  # transparent -> white
    assert d.taken_src == "filename" and d.taken.year == 2024


def test_heic_if_supported(tmp_path):
    import pytest
    pillow_heif = pytest.importorskip("pillow_heif")
    p = tmp_path / "x.heic"
    Image.new("RGB", (64, 48), (0, 200, 0)).save(p, format="HEIF")
    d = imageio.decode(p)
    assert d.image.size == (64, 48)


def test_saved_jpeg_has_no_metadata(tmp_path):
    p = write_photo(tmp_path / "gps.jpg", (90, 90, 200), datetime(2025, 1, 1))
    assert Image.open(p).getexif().get_ifd(0x8825)  # the fixture really has GPS
    out = tmp_path / "out.jpg"
    imageio.save_jpeg(imageio.decode(p).image, out, 90)
    with Image.open(out) as im:
        assert not im.getexif() and "icc_profile" not in im.info


def test_export_package_is_blind_and_clean(tmp_path):
    src = tmp_path / "src"
    rows = []
    for i in range(12):
        write_photo(src / f"d{i % 2}/IMG_{i}.jpg", (20 * i, 100, 150), datetime(2025, 1, 1 + i), size=(2400, 3200))
        rows.append({"photo_id": 100 + i, "rel": f"d{i % 2}/IMG_{i}.jpg", "rank": i + 1, "kind": "ranked",
                     "p_in": 0.9, "appeal": 2.0 - i * 0.1, "duels": 5, "flags": []})
    rows.append({"photo_id": 999, "rel": "d0/IMG_0.jpg", "rank": "", "kind": "added", "p_in": 0.2, "appeal": 0.1,
                 "duels": 1, "flags": ["dog"]})
    before = {p: p.read_bytes() for p in src.rglob("*.jpg")}
    r = export.build(src, tmp_path / "out", rows, edge=2048)
    assert r["count"] == 13 and r["added"] == 1
    with zipfile.ZipFile(r["zip"]) as z:
        names = sorted(z.namelist())
        assert names == [f"P{i:03d}.jpg" for i in range(1, 14)]
        for n in names:
            with z.open(n) as f, Image.open(f) as im:
                assert not im.getexif()
                assert max(im.size) == 2048
    with open(f"{r['dir']}/KEY.PRIVATE.csv") as f:
        key = list(csv.DictReader(f))
    order = [int(k["rank"]) for k in key if k["kind"] == "ranked"]
    assert order == sorted(order)                                   # key is sorted by rank...
    files_by_rank = [k["file"] for k in key if k["kind"] == "ranked"]
    assert files_by_rank != sorted(files_by_rank)                   # ...but P-numbers are shuffled
    assert {p: p.read_bytes() for p in src.rglob("*.jpg")} == before  # originals untouched
    r2 = export.build(src, tmp_path / "out", rows[:2])
    assert r2["dir"] != r["dir"]                                    # never overwrites an earlier export
    share = Path(r["dir"]) / "share"
    assert not list(share.rglob("KEY*")) and (Path(r["dir"]) / "KEY.PRIVATE.csv").exists()  # the key isn't with what you send
    with zipfile.ZipFile(r["zip"]) as z:
        assert {i.date_time for i in z.infolist()} == {(1980, 1, 1, 0, 0, 0)}


def test_export_refuses_a_jpeg_with_any_metadata_segment(tmp_path):
    clean, dirty = tmp_path / "clean.jpg", tmp_path / "dirty.jpg"
    Image.new("RGB", (64, 48), (90, 120, 30)).save(clean, "JPEG")
    export.check_clean(clean)
    Image.new("RGB", (64, 48), (90, 120, 30)).save(dirty, "JPEG", comment=b"Jane's flat, 4th floor")
    with pytest.raises(RuntimeError):
        export.check_clean(dirty)


def test_best_of_names_never_collide(tmp_path):
    src = tmp_path / "src"
    for d in ("a", "b"):
        write_photo(src / d / "IMG_1.jpg", (10, 20, 30), datetime(2025, 1, 1))
    r = export.bestof(src, tmp_path / "out", [{"rel": "a/IMG_1.jpg", "rank": None}, {"rel": "b/IMG_1.jpg", "rank": None}])
    assert r["count"] == 2 and len([p for p in Path(r["dir"]).iterdir() if p.is_file()]) == 2
    assert sorted(p.name for p in (Path(r["dir"]) / "touched up").iterdir()) == ["++ - IMG_1 (2).jpg", "++ - IMG_1.jpg"]
