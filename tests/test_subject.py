"""Subject frames for photos without a face: the salient region from the analysis, filled in for older libraries,
and the best crop's tie rule (focus subject wins) on screen and in the export."""
import json
import threading

import cv2
import numpy as np
from PIL import Image

from matcher import library, touchup, visual
from tests.conftest import lib_env  # noqa: F401  (fixture)


def _blob_picture(width=384, height=288, at=(0.7, 0.4)):
    """A flat grey field with one textured, contrasting thing in it: what the eye lands on."""
    bgr = np.full((height, width, 3), 120, np.uint8)
    cx, cy = int(at[0] * width), int(at[1] * height)
    cv2.circle(bgr, (cx, cy), 28, (30, 40, 200), -1)
    cv2.circle(bgr, (cx + 8, cy - 6), 9, (240, 240, 240), -1)
    cv2.rectangle(bgr, (cx - 18, cy + 10), (cx + 18, cy + 22), (10, 10, 10), -1)
    return bgr


def test_salient_box_frames_the_thing_in_the_picture_and_nothing_in_a_flat_one():
    box = visual.salient_box(_blob_picture())
    assert box is not None
    x, y, w, h = box
    assert abs((w * 384) / (h * 288) - 0.8) < 0.02, "the frame has the portrait aspect, like the face frame"
    assert x < 0.7 < x + w and y < 0.4 < y + h, "the frame holds the thing"
    assert w < 0.7, "and does not just take the whole picture"
    assert visual.salient_box(np.full((288, 384, 3), 120, np.uint8)) is None, "nothing stands out in a flat field"
    rng = np.random.default_rng(3)
    noise = rng.integers(0, 255, (288, 384, 3), dtype=np.uint8)
    assert visual.salient_box(noise) is None, "a texture has no particular subject"


def test_fill_salient_gives_faceless_photos_a_subject_frame_and_leaves_face_frames_alone(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    faced = store.one("SELECT id, subject FROM photos WHERE n_faces > 0 AND subject IS NOT NULL")
    bare = store.one("SELECT id FROM photos WHERE n_faces = 0")
    assert faced and bare
    # The faceless photo's thumbnail gets a thing in it; the face photo's thumbnail stays flat.
    Image.fromarray(cv2.cvtColor(_blob_picture(240, 320, (0.3, 0.6)), cv2.COLOR_BGR2RGB)).save(work / "thumbs" / f"{bare['id']}.jpg")
    seen = []
    n = library.fill_salient(store, work, on_box=lambda pid, box: seen.append((pid, box)))
    assert n == store.one("SELECT count(*) AS n FROM photos WHERE status='analyzed'")["n"]
    assert library.fill_salient(store, work) == 0, "measured photos stay measured"
    row = store.one("SELECT subject, salient FROM photos WHERE id=?", (bare["id"],))
    assert json.loads(row["salient"]) is not None and json.loads(row["subject"]) == json.loads(row["salient"])
    assert seen == [(bare["id"], json.loads(row["salient"]))], "a live session hears about the new frame"
    assert store.one("SELECT subject FROM photos WHERE id=?", (faced["id"],))["subject"] == faced["subject"], "the face frame wins"
    # A refresh keeps the salient frame for the faceless photo (the face frame first, then the salient one).
    library.refresh(store)
    assert json.loads(store.one("SELECT subject FROM photos WHERE id=?", (bare["id"],))["subject"]) == json.loads(row["salient"])


def test_fill_salient_stops_when_cancelled(lib_env):
    src, work, store, specs = lib_env
    stop = threading.Event()
    stop.set()
    assert library.fill_salient(store, work, cancel=stop.is_set) == 0
    assert store.one("SELECT count(*) AS n FROM photos WHERE salient IS NULL")["n"] > 0


def test_best_crop_prefers_focus_subject_on_a_tie_and_the_fuller_fill_without_one():
    width, height, box = 1600, 1200, [0.55, 0.3, 0.2, 0.3]
    assert touchup.crop_box(width, height, box, "best") == touchup.crop_box(width, height, box, "subject")
    # Without a subject, "best" is whichever fill leaves the least paper showing (here fill height on a wide picture).
    assert touchup.crop_box(width, height, None, "best") == touchup.crop_box(width, height, None, "height")
    assert touchup.crop_box(900, 1600, None, "best") == touchup.crop_box(900, 1600, None, "width")
