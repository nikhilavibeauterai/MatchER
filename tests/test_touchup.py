"""The automatic touch-up: the export's touched-up copies look like Enhance (F) on screen, stay full size and
upright, and keep their EXIF."""
import numpy as np
from PIL import Image

from matcher import export, touchup


def flat_photo(path, size=(120, 90), lo=70, hi=130, orientation=1):
    """A low-contrast warm gradient with an EXIF date and orientation, like a dull camera JPEG."""
    w, h = size
    x = np.linspace(lo, hi, w)
    arr = np.zeros((h, w, 3), np.uint8)
    arr[..., 0], arr[..., 1], arr[..., 2] = x, x * 0.9, x * 0.8
    exif = Image.Exif()
    exif[0x0112] = orientation
    exif[0x0132] = "2025:01:02 03:04:05"
    exif.get_ifd(0x8769)[0x9003] = "2025:01:02 03:04:05"  # DateTimeOriginal
    Image.fromarray(arr).save(path, "JPEG", quality=95, exif=exif.tobytes())


def test_the_look_is_the_on_screen_filter_maths():
    # A uniform mid-dark photo, worked by hand from autoFilterId(): both points at 100, so the slope caps at 2.2
    # and the levels come out at 1.9 / -0.647, the mean lands near 0.1 and the gamma floors at 0.79.
    im = Image.new("RGB", (64, 48), (100, 100, 100))
    how = touchup.look(im)
    assert all(abs(a - 1.9) < 1e-6 and abs(b + 0.64706) < 1e-4 for a, b in how["levels"])
    assert abs(how["gamma"] - 0.79) < 1e-9 and how["saturation"] == 1
    out = np.asarray(touchup.apply(im, how))
    assert abs(int(out[0, 0, 0]) - 41) <= 1 and (out == out[0, 0, 0]).all()


def test_touch_up_stretches_a_flat_photo_and_keeps_its_metadata(tmp_path):
    src, dst = tmp_path / "flat.jpg", tmp_path / "out.jpg"
    flat_photo(src)
    how = touchup.touch_up(src, dst)
    before = np.asarray(Image.open(src).convert("L")).astype(int)
    after = np.asarray(Image.open(dst).convert("L")).astype(int)
    assert after.max() - after.min() > (before.max() - before.min()) * 1.5  # the dull range opens up
    assert how["saturation"] == 1.12 and how["levels"][0][0] > 1
    with Image.open(dst) as o:
        tags = o.getexif()
        assert o.size == (120, 90) and tags.get(0x0112) == 1 and tags.get(0x0132) == "2025:01:02 03:04:05"
        assert tags.get_ifd(0x8769).get(0x9003) == "2025:01:02 03:04:05"


def test_touch_up_writes_an_upright_copy(tmp_path):
    src, dst = tmp_path / "side.jpg", tmp_path / "out.jpg"
    flat_photo(src, orientation=6)  # stored sideways, shown upright as 90x120
    touchup.touch_up(src, dst)
    with Image.open(dst) as o:
        assert o.size == (90, 120) and o.getexif().get(0x0112) == 1


def test_black_and_white_stays_black_and_white():
    grey = Image.fromarray(np.tile(np.linspace(40, 200, 64).astype(np.uint8), (48, 1))).convert("RGB")
    how = touchup.look(grey)
    assert how["saturation"] == 1
    out = np.asarray(touchup.apply(grey, how))
    assert (out[..., 0] == out[..., 1]).all() and (out[..., 1] == out[..., 2]).all()


def test_best_of_export_touches_up_every_copy_and_survives_a_bad_file(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    flat_photo(src / "IMG_1.jpg")
    flat_photo(src / "IMG_2.jpg", orientation=6)
    (src / "IMG_3.jpg").write_bytes(b"not a photo")
    r = export.bestof(src, tmp_path / "out", [{"rel": "IMG_1.jpg", "rank": 1}, {"rel": "IMG_2.jpg", "rank": 2},
                                              {"rel": "IMG_3.jpg", "rank": 3}])
    out = __import__("pathlib").Path(r["dir"])
    assert r["count"] == 3 and r["touched"] == 2 and r["touched_dir"] == str(out / "touched up")
    assert sorted(p.name for p in (out / "touched up").iterdir()) == ["01 - IMG_1.jpg", "02 - IMG_2.jpg"]
    assert (out / "03 - IMG_3.jpg").read_bytes() == b"not a photo"  # the original still comes along untouched
    with Image.open(out / "touched up" / "02 - IMG_2.jpg") as o:
        assert o.size == (90, 120)
    plain = export.bestof(src, tmp_path / "out2", [{"rel": "IMG_1.jpg", "rank": 1}], touch=False)
    assert plain["touched"] == 0 and plain["touched_dir"] is None and not (__import__("pathlib").Path(plain["dir"]) / "touched up").exists()


def test_rotating_a_box_follows_the_picture_round():
    box = [0.1, 0.2, 0.3, 0.4]
    turned = touchup.rotate_box(box, 90)
    assert [round(v, 6) for v in turned] == [0.4, 0.1, 0.4, 0.3]  # top-left of the picture ends up top-right
    assert [round(v, 6) for v in touchup.rotate_box(touchup.rotate_box(turned, 90), 180)] == box
    assert touchup.rotate_box(box, 0) == box and touchup.rotate_box(box, 360) == box


def test_the_best_crop_leaves_the_least_paper_showing():
    # Both crops fill the window; focus subject wins the tie, just as it does on screen.
    box = [0.8, 0.3, 0.15, 0.3]
    x0, y0, x1, y1 = touchup.crop_box(1600, 1200, box, "best")
    assert (x0, y0, x1, y1) == touchup.crop_box(1600, 1200, box, "subject")
    assert y1 - y0 < 1200 and abs((x1 - x0) / (y1 - y0) - touchup.WINDOW[0] / touchup.WINDOW[1]) < 0.01
    assert x0 <= 0.8 * 1600 and x1 >= 0.95 * 1600  # the subject stays inside
    assert touchup.crop_box(1600, 1200, None, "best")[0] > 0  # no subject: the middle
    # A portrait also prefers its focus subject when both options fill the window.
    assert touchup.crop_box(900, 1600, [0.5, 0.9, 0.1, 0.1], "best") == touchup.crop_box(900, 1600, [0.5, 0.9, 0.1, 0.1], "subject")


def test_the_subject_crop_zooms_in_on_the_subject_like_the_screen():
    # A landscape with its subject on the left: the crop is the polaroid's window, zoomed in on the subject.
    x0, y0, x1, y1 = touchup.crop_box(1600, 1200, [0.05, 0.3, 0.2, 0.3], "subject")
    w, h = x1 - x0, y1 - y0
    assert 0 <= x0 < x1 <= 1600 and 0 <= y0 < y1 <= 1200
    assert abs(w / h - touchup.WINDOW[0] / touchup.WINDOW[1]) < 0.01  # the window's shape
    assert x0 <= 0.05 * 1600 and x1 >= 0.25 * 1600 and abs((x0 + x1) / 2 - 0.15 * 1600) <= 2  # the subject inside, centred
    assert h < 1200  # tighter than the whole picture
    assert touchup.crop_box(1600, 1200, [0.0, 0.3, 0.1, 0.3], "subject")[0] == 0  # a subject at the edge: no gap, the crop stops at the edge
    # A subject that fills the frame cannot zoom in: the crop is the whole height.
    _, _, x1, y1 = touchup.crop_box(1600, 1200, [0.0, 0.0, 1.0, 1.0], "subject")
    assert y1 == 1200


def test_touch_up_turns_crops_and_leaves_the_pixels_alone_when_asked(tmp_path):
    src = tmp_path / "src.jpg"
    flat_photo(src, size=(160, 120))
    plain = np.asarray(Image.open(src).convert("RGB")).astype(int)
    touchup.touch_up(src, tmp_path / "turned.jpg", {"rotate": 90, "enhance": False})
    with Image.open(tmp_path / "turned.jpg") as o:
        assert o.size == (120, 160)
        turned = np.asarray(o.convert("RGB")).astype(int)
    assert np.abs(turned - np.rot90(plain, k=-1)).mean() < 3  # a clockwise quarter turn, nothing else
    touchup.touch_up(src, tmp_path / "cropped.jpg", {"crop": "subject"}, box=[0.6, 0.1, 0.3, 0.5])
    with Image.open(tmp_path / "cropped.jpg") as o:
        assert o.width < 160 and o.height <= 120 and abs(o.width / o.height - touchup.WINDOW[0] / touchup.WINDOW[1]) < 0.05
    assert touchup.touch_up(src, tmp_path / "off.jpg", {"enhance": False}) is None
    assert np.abs(np.asarray(Image.open(tmp_path / "off.jpg").convert("RGB")).astype(int) - plain).mean() < 2


def test_fill_crops_keep_one_whole_side():
    # Fill height: the whole height, the window's shape across, centred on the subject; a narrow picture is whole.
    x0, y0, x1, y1 = touchup.crop_box(1600, 1200, [0.4, 0.2, 0.2, 0.4], "height")
    assert (y0, y1) == (0, 1200) and abs((x1 - x0) / 1200 - touchup.WINDOW[0] / touchup.WINDOW[1]) < 0.01
    assert abs((x0 + x1) / 2 - 0.5 * 1600) <= 1
    assert touchup.crop_box(1600, 1200, [0.7, 0.2, 0.2, 0.4], "height")[2] == 1600  # a subject at the edge: no gap
    assert touchup.crop_box(600, 1200, [0.5, 0.5, 0.1, 0.1], "height") == (0, 0, 600, 1200)
    # Fill width: the whole width, down from the top without a subject, centred on one with it.
    assert touchup.crop_box(1200, 1600, None, "width")[:3] == (0, 0, 1200)
    x0, y0, x1, y1 = touchup.crop_box(1200, 1600, [0.4, 0.8, 0.2, 0.15], "width")
    assert (x0, x1) == (0, 1200) and y1 == 1600 and y0 > 0  # the subject near the bottom pulls the crop down


def test_knobs_turn_the_auto_look():
    im = Image.new("RGB", (64, 48), (120, 110, 100))
    how = touchup.look(im)
    flat = touchup.tuned(how, {"levels": 0})
    assert all(abs(a - 1) < 1e-9 and abs(b) < 1e-9 for a, b in flat["levels"])  # no stretch at all
    assert touchup.tuned(how, {"colour": 0})["saturation"] == 0
    grey = np.asarray(touchup.apply(im, how, {"colour": 0}))
    assert (grey[..., 0] == grey[..., 1]).all() and (grey[..., 1] == grey[..., 2]).all()
    warm = np.asarray(touchup.apply(im, how, {"warmth": 1})).astype(int)
    cool = np.asarray(touchup.apply(im, how, {"warmth": -1})).astype(int)
    assert warm[0, 0, 0] > cool[0, 0, 0] and warm[0, 0, 2] < cool[0, 0, 2]
    light = np.asarray(touchup.apply(im, how, {"light": 1})).astype(int)
    dark = np.asarray(touchup.apply(im, how, {"light": -1})).astype(int)
    assert light.mean() > dark.mean()
    assert touchup.knobs_of({"levels": 9, "warmth": "x"}) == {"levels": 2.0, "light": 0.0, "contrast": 0.0, "colour": 1.0, "warmth": 0.0}
