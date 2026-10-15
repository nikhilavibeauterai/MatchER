"""The sea's colour coordinates use only measured pixels and synthetic fixtures."""
import math
import sqlite3
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
from PIL import Image

from matcher import analyze, imageio, visual
from matcher.store import SCHEMA, Store
from tests.test_filtering import client


@pytest.mark.parametrize("rgb,saturation,hue,brightness", [
    ((255, 255, 255), 0, None, 1), ((0, 0, 0), 0, None, 0),
    ((128, 128, 128), 0, None, 128 / 255), ((255, 0, 0), 1, 0, 76 / 255),
    ((0, 255, 0), 1, 1 / 3, 150 / 255), ((0, 0, 255), 1, 2 / 3, 29 / 255),
    ((128, 64, 64), .5, 0, 83 / 255),
])
def test_analysis_measures_colour_from_the_single_existing_decode(tmp_path, monkeypatch, rgb, saturation, hue, brightness):
    source = tmp_path / "synthetic.png"
    Image.new("RGB", (640, 480), rgb).save(source)
    calls, samples = [], []
    decode, measure = imageio.decode, visual.colour_metrics
    def decoded(*args, **kwargs):
        calls.append(1)
        return decode(*args, **kwargs)
    def measured(sample):
        samples.append(sample.shape)
        return measure(sample)
    monkeypatch.setattr(imageio, "decode", decoded)
    monkeypatch.setattr(visual, "colour_metrics", measured)
    monkeypatch.setitem(analyze._W, "det", SimpleNamespace(detect=lambda _: []))
    result = analyze.analyze_one((1, str(source), source.name, str(tmp_path / "preview.jpg"), str(tmp_path / "thumb.jpg")))
    assert result["status"] == "analyzed", result.get("error")
    assert len(calls) == len(samples) == 1 and max(samples[0][:2]) <= 384
    description = visual.descriptor(*(result[key] for key in ("luma", "chroma", "saturation", "hue")))
    assert description["saturation"] == pytest.approx(saturation, abs=.004)
    assert description["brightness"] == pytest.approx(brightness, abs=.004)
    assert description["hue"] is None if hue is None else description["hue"] == pytest.approx(hue, abs=.001)
    store = Store(tmp_path / "library.db")
    try:
        with store.tx() as c:
            c.execute("INSERT INTO photos(id,rel) VALUES(1,'synthetic.png')")
        analyze._save_phase1(store, [result])
        saved = store.one("SELECT luma,chroma,saturation,hue FROM photos WHERE id=1")
        assert visual.descriptor(*saved) == description
    finally:
        store.close()


def test_hue_wraps_around_red_and_abstains_for_opposing_colours():
    hsv = np.zeros((32, 32, 3), np.uint8)
    hsv[..., 1:] = 255
    hsv[:, :16, 0], hsv[:, 16:, 0] = 179, 1
    result = visual.colour_metrics(cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR))
    assert min(result["hue"], 1 - result["hue"]) < .01
    hsv[:, :16, 0], hsv[:, 16:, 0] = 0, 90
    result = visual.colour_metrics(cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR))
    assert result["saturation"] == 1 and result["hue"] is None


def test_visual_sampling_is_bounded_before_allocating_hsv(monkeypatch):
    convert, sizes = cv2.cvtColor, []
    def measured(image, code):
        sizes.append(image.shape)
        return convert(image, code)
    monkeypatch.setattr(cv2, "cvtColor", measured)
    result = visual.colour_metrics(np.zeros((2048, 4096, 3), np.uint8))
    assert result == {"saturation": 0, "hue": None}
    assert sizes == [(192, 384, 3)]


def test_old_schema_migrates_without_inventing_missing_saturation(tmp_path):
    path = tmp_path / "older.db"
    with sqlite3.connect(path) as connection:
        connection.executescript(SCHEMA.replace(", saturation REAL, hue REAL", ""))
        connection.execute("INSERT INTO photos(id,rel,status,luma,chroma) VALUES(1,'synthetic.jpg','analyzed',128,40)")
    for _ in range(2):
        store = Store(path)
        try:
            row = store.one("SELECT luma,chroma,saturation,hue FROM photos WHERE id=1")
            assert visual.descriptor(*row) == {"brightness": .50196, "colorfulness": .20833, "chroma": .15686, "saturation": None, "hue": None}
        finally:
            store.close()


@pytest.mark.parametrize("invalid", [math.nan, math.inf, -1, 500, True, "0.5"])
def test_invalid_saved_metrics_remain_unknown(invalid):
    assert visual.descriptor(invalid, invalid, invalid, invalid) == dict.fromkeys(("brightness", "colorfulness", "chroma", "saturation", "hue"))


def test_world_exposes_cached_measured_coordinates_and_never_decodes(client, monkeypatch):
    s = client.session
    ids = [r["id"] for r in s.store.q("SELECT id FROM photos ORDER BY id LIMIT 2")]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET luma=76,chroma=150,saturation=1,hue=0 WHERE id=?", (ids[0],))
        c.execute("UPDATE photos SET luma=128,chroma=40,saturation=NULL,hue=NULL WHERE id=?", (ids[1],))
    before = [tuple(row) for row in s.store.q("SELECT id,group_id,stack_key,theme_id FROM photos")]
    monkeypatch.setattr(imageio, "decode", lambda *_args, **_kw: pytest.fail("World must never reopen originals"))
    response = client.get("/api/world?per=2").get_json()
    assert len(response["photos"]) == 2 and response["more"]
    assert response["photos"][0]["visual"] == {"brightness": .29804, "colorfulness": .78125, "saturation": 1, "hue": 0, "chroma": .58824}
    assert response["photos"][1]["visual"] == {"brightness": .50196, "colorfulness": .20833, "saturation": None, "hue": None, "chroma": .15686}
    assert [tuple(row) for row in s.store.q("SELECT id,group_id,stack_key,theme_id FROM photos")] == before


def test_analysis_feed_delivers_the_same_saved_visual_descriptor(client, monkeypatch):
    s = client.session
    with s.store.tx() as c:
        c.execute("INSERT INTO photos(rel,status) VALUES('synthetic-new.png','new')")
    pid = s.store.one("SELECT id FROM photos WHERE rel='synthetic-new.png'")["id"]
    result = {"id": pid, "status": "analyzed", "faces": [], "n_faces": 0,
              "luma": 100, "chroma": 60, "saturation": .8, "hue": .25}
    monkeypatch.setattr(analyze, "_process_results", lambda *_args: (item for item in [result]))
    s.analyzer._phase1()
    response = client.get("/api/analysis/feed").get_json()
    read = next(row for row in response["read"] if row[0] == pid)
    assert read[:4] == [pid, [], 0, 0]
    assert read[4] == visual.descriptor(100, 60, .8, .25)
    saved = s.store.one("SELECT luma,chroma,saturation,hue FROM photos WHERE id=?", (pid,))
    assert read[4] == visual.descriptor(*saved)
