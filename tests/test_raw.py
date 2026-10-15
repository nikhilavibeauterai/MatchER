"""Camera raw files (.nef, .dng, .raw …) are photos: scanned, decoded through LibRaw (faked here: no raw file is
small enough to ship), dated through their EXIF."""
import sys
import types

import numpy as np
from PIL import Image

from matcher import config, imageio


class _Raw:
    def __init__(self, w, h):
        self.sizes = types.SimpleNamespace(width=w, height=h)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def postprocess(self, **kw):
        self.calls.append(kw)
        w, h = self.sizes.width, self.sizes.height
        if kw.get("half_size"):
            w, h = w // 2, h // 2
        arr = np.zeros((h, w, 3), np.uint8)
        arr[..., 0] = np.linspace(0, 255, w, dtype=np.uint8)  # a red gradient to recognise
        return arr


def _fake_raw(monkeypatch, w=4000, h=3000):
    raws = []
    rawpy = types.ModuleType("rawpy")
    rawpy.imread = lambda src: raws.append(_Raw(w, h)) or raws[-1]
    exifread = types.ModuleType("exifread")
    exifread.process_file = lambda f, details=False: {"EXIF DateTimeOriginal": "2024:05:01 14:32:10", "Image Make": "Nikon ", "Image Model": "Z 6"}
    monkeypatch.setitem(sys.modules, "rawpy", rawpy)
    monkeypatch.setitem(sys.modules, "exifread", exifread)
    return raws


def test_raw_extensions_count_as_photos():
    assert {".nef", ".dng", ".raw"} <= config.PHOTO_EXTS and config.RAW_EXTS <= config.PHOTO_EXTS


def test_a_raw_file_decodes_through_libraw_with_its_exif(tmp_path, monkeypatch):
    raws = _fake_raw(monkeypatch)
    src = tmp_path / "Café 猫 DSC_0001.NEF"
    src.write_bytes(b"not really raw")
    d = imageio.decode(src, max_edge=400)
    assert d.fmt == "RAW" and (d.width, d.height) == (4000, 3000) and max(d.image.size) == 400
    assert raws[-1].calls[-1]["half_size"] and raws[-1].calls[-1]["use_camera_wb"]  # a small preview decodes at half size
    assert d.taken.isoformat() == "2024-05-01T14:32:10" and d.taken_src == "exif" and (d.make, d.model) == ("Nikon", "Z 6")
    full = imageio.decode(src)
    assert full.image.size == (4000, 3000) and not raws[-1].calls[-1]["half_size"]
    assert np.asarray(full.image)[0, -1, 0] == 255  # the picture came through, not a placeholder


def test_raw_decoder_receives_an_open_stream_for_unicode_paths(tmp_path, monkeypatch):
    raws = _fake_raw(monkeypatch, 600, 400)
    def read(stream):
        assert stream.read() == b"synthetic raw bytes"
        raws.append(_Raw(600, 400))
        return raws[-1]
    sys.modules["rawpy"].imread = read
    src = tmp_path / "旅行 photo.dng"
    src.write_bytes(b"synthetic raw bytes")
    assert imageio.decode(src).image.size == (600, 400)


def test_a_raw_file_without_exif_takes_its_date_from_its_name(tmp_path, monkeypatch):
    _fake_raw(monkeypatch, 600, 400)
    sys.modules["exifread"].process_file = lambda f, details=False: {}
    src = tmp_path / "IMG_20240501_143210.dng"
    src.write_bytes(b"x")
    d = imageio.decode(src, max_edge=200)
    assert d.taken_src == "filename" and d.taken.year == 2024 and d.image.size == (200, 133)
