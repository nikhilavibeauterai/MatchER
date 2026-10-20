"""Aesthetic geometry protects content, recognises both vanishing directions and matches the live paper."""
import json
import subprocess

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw

from matcher import auto_look, composition, finishing, geometry, touchup
from tests.test_alignment import outline
from tests.test_draw import client, post, single


def structure(horizontal=0, vertical=0, degrees=0):
    im = Image.new("RGB", (800, 600), "#697482")
    draw = ImageDraw.Draw(im)
    for x in (90, 250, 400, 550, 710):
        draw.line((x, 40, x, 560), fill="white", width=4)
    for y in (60, 210, 390, 540):
        draw.line((40, y, 760, y), fill="white", width=4)
    transform, _ = geometry.matrix(*im.size, degrees, horizontal, vertical)
    pixels = np.diag([800, 600, 1]) @ transform @ np.diag([1/800, 1/600, 1])
    return Image.fromarray(cv2.warpPerspective(np.array(im), pixels, im.size, borderMode=cv2.BORDER_REPLICATE))


@pytest.mark.parametrize("horizontal,vertical", [(0, .3), (-.25, 0), (.22, .25), (-.18, -.2)])
def test_two_vanishing_directions_are_independent_and_upright_is_not_always_the_natural_choice(horizontal, vertical):
    result = composition.measure(structure(horizontal, vertical))
    natural, upright = (result["views"][s] for s in ("natural", "upright"))
    assert set(result["views"]) == set(geometry.STYLES)
    for axis, source in (("horizontal", horizontal), ("vertical", vertical)):
        correction = upright["skew"][axis]
        assert correction * source < 0 if source else abs(correction) < .01
        if source:
            assert abs(correction) > abs(source) * .65
    assert natural["retained"] >= upright["retained"]
    assert natural["skew"] != upright["skew"]
    assert upright["retained"] >= .62


def test_a_face_near_an_edge_outweighs_a_mathematically_straighter_view():
    im = outline(8)
    assert composition.measure(im)["views"]["natural"]["straighten"] == pytest.approx(-8, abs=.15)
    result = composition.measure(im, [{"x": .85, "y": .02, "w": .14, "h": .22}])
    for view in result["views"].values():
        assert view["straighten"] == 0 and view["retained"] == 1
        assert "Protect faces" in " ".join(view["reasons"])


def test_a_subject_region_is_protected_even_without_a_recognised_face():
    views = composition.measure(outline(8), subject=[.85, .02, .14, .22])["views"]
    assert views["natural"]["retained"] > .9


def test_a_face_already_cut_by_the_source_never_discards_the_original_candidate():
    result = composition.measure(outline(8), [{"x": -.05, "y": .1, "w": .2, "h": .3}])
    assert all(view["retained"] >= .62 for view in result["views"].values())


def test_expressive_follows_a_real_diagonal_while_natural_preserves_the_photographers_tilt():
    im = Image.new("RGB", (800, 600), "#2a3940")
    draw = ImageDraw.Draw(im)
    for y in (60, 200, 340):
        draw.line((80, y, 700, y + 240), fill="#f9c458", width=5)
    views = composition.measure(im)["views"]
    assert views["natural"]["straighten"] == 0
    assert 2 <= views["expressive"]["straighten"] <= 6
    assert "diagonal" in " ".join(views["expressive"]["reasons"])


@pytest.mark.parametrize("kind", ["flat", "noise", "curve", "conflicting"])
def test_uncertain_scenes_do_not_invent_a_perspective(kind):
    im = Image.new("RGB", (800, 600), "grey")
    if kind == "noise":
        im = Image.fromarray(np.random.default_rng(71).integers(0, 256, (600, 800, 3), dtype=np.uint8))
    if kind == "curve":
        ImageDraw.Draw(im).ellipse((70, 50, 730, 550), outline="white", width=4)
    if kind == "conflicting":
        for x, angle in ((10, 6), (410, -5)):
            tile = Image.new("RGB", (380, 600), "grey")
            ImageDraw.Draw(tile).rectangle((60, 60, 320, 540), fill="#c8c1b6", outline="white", width=3)
            im.paste(tile.rotate(-angle, Image.Resampling.BICUBIC, fillcolor="grey"), (x, 0))
    for view in composition.measure(im)["views"].values():
        assert view["straighten"] == 0 and not any(view["skew"].values())


def test_saved_recipe_selection_and_manual_zero_match_the_browser():
    recipe = auto_look.measure(structure(.22, .25))
    assert recipe["version"] == 4 and recipe["composition"]["views"]["upright"]["skew"]["horizontal"]
    choices = [{}, {"composition": "upright"}, {"composition": "expressive"}, {"auto_align": False},
               {"auto_skew": False}, {"auto_align": False, "auto_skew": True}, {"enhance": False},
               {"skew": {"horizontal": 0}}, {"straighten": 0, "skew": {"horizontal": 0, "vertical": 0}},
               {"auto_skew": False, "skew": {"horizontal": .15}}]
    script = "const {PhotoGeometry:g}=require('./matcher/static/photo-geometry.js');const [r,es]=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(es.map(e=>g.resolve(r,e))));"
    actual = json.loads(subprocess.check_output(["node", "-e", script, json.dumps([recipe, choices])]))
    assert actual == [geometry.resolve(recipe, edits) for edits in choices]
    assert geometry.resolve(recipe, {"auto_align": False}) == {"straighten": 0, "horizontal": 0, "vertical": 0}
    assert geometry.resolve(recipe, {"auto_skew": False, "skew": {"horizontal": .15}})["horizontal"] == .15
    assert geometry.resolve({"version": 3, "straighten": 2, "skew": {"horizontal": .5}})["horizontal"] == 0


@pytest.mark.parametrize("turn", [0, 90, 180, 270])
def test_geometry_and_crop_basis_match_the_browser_and_never_leave_empty_corners(turn):
    random = np.random.default_rng(42)
    examples = []
    for _ in range(24):
        w, h = random.integers(200, 4000, size=2).tolist()
        value = {"straighten": float(random.uniform(-45, 45)), "horizontal": float(random.uniform(-.6, .6)), "vertical": float(random.uniform(-.6, .6))}
        box = [.12, .16, .7, .6]
        examples.append([w, h, geometry.region(value, turn, box)])
    script = "const {PhotoGeometry:g}=require('./matcher/static/photo-geometry.js');process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(([w,h,v])=>g.matrix(w,h,v))));"
    browser = json.loads(subprocess.check_output(["node", "-e", script, json.dumps(examples)]))
    for (w, h, value), found in zip(examples, browser):
        matrix, trim = geometry.matrix(w, h, value["straighten"], value["horizontal"], value["vertical"])
        assert np.max(abs(matrix - found["matrix"])) < 1e-12 and trim == pytest.approx(found["trim"], abs=1e-12)
        corners = geometry.points(np.linalg.inv(matrix), [(0, 0), (1, 0), (1, 1), (0, 1)])
        assert corners.min() >= -1e-12 and corners.max() <= 1 + 1e-12
    script = "const {PhotoGeometry:g}=require('./matcher/static/photo-geometry.js');process.stdout.write(JSON.stringify(g.region(...JSON.parse(process.argv[1]))));"
    value = {"horizontal": .2, "vertical": -.3, "straighten": 4}
    actual = json.loads(subprocess.check_output(["node", "-e", script, json.dumps([value, turn, box])]))
    assert actual == geometry.region(value, turn, box)


def test_composition_and_both_manual_axes_are_one_validated_undo_step(client):
    pid = single(client, 0)
    patch = {"composition": "expressive", "auto_align": True, "auto_skew": True, "straighten": 0,
             "skew": {"horizontal": .1234567, "vertical": 0}}
    saved = post(client, "/api/edit", {"photo": pid, **patch}).get_json()
    assert saved["edits"]["skew"] == {"horizontal": .123457, "vertical": 0}
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit"
    assert client.get(f"/api/edit?photo={pid}").get_json()["edits"] == {}
    assert post(client, "/api/draw/redo").get_json()["redone"] == "edit"
    read = lambda: client.get(f"/api/edit?photo={pid}").get_json()["edits"]
    for bad in ({"composition": "magic"}, {"composition": []}, {"auto_skew": 1}, {"skew": []},
                {"skew": {"horizontal": True}}, {"skew": {"horizontal": float("nan")}}, {"skew": {"vertical": .601}},
                {"skew": {"axis": 0}}):
        assert post(client, "/api/edit", {"photo": pid, "title": "Never save", **bad}).status_code == 400
        assert read() == saved["edits"]
    assert post(client, "/api/edit", {"photo": pid, **{key: None for key in patch}}).get_json()["edits"] == {}


@pytest.mark.parametrize("turn", [0, 90, 180, 270])
def test_export_preserves_original_coordinate_masks_crop_and_skew_without_enhancement(tmp_path, turn):
    im = Image.new("RGB", (600, 400), (90, 120, 150))
    ImageDraw.Draw(im).rectangle((160, 120, 360, 300), fill=(160, 100, 80))
    src, dst = tmp_path / "source.png", tmp_path / "edit.jpg"
    im.save(src)
    before = src.read_bytes()
    box = [.1, .15, .75, .7]
    edits = {"enhance": False, "rotate": turn, "crop": "custom", "crop_box": box, "straighten": 3,
             "skew": {"horizontal": .2, "vertical": -.3}, "grade": {"shadows": {"hue": 210, "amount": .3}}}
    touchup.touch_up(src, dst, edits, quality=100)
    turned = im.transpose(touchup.TURNS[turn]) if turn else im
    x, y, w, h = touchup.rotate_box(box, turn)
    rectangle = (round(x*turned.width), round(y*turned.height), round((x+w)*turned.width), round((y+h)*turned.height))
    expected = finishing.apply(turned.crop(rectangle), edits, im.size, rectangle, turn)
    value = geometry.region(geometry.resolve(None, edits), turn, (x, y, w, h))
    expected = finishing.perspective(expected, value)
    actual = np.asarray(Image.open(dst)).astype(float)
    assert actual.shape == np.asarray(expected).shape
    assert abs(actual - np.asarray(expected)).mean() < 2
    assert not np.any(np.all(actual < 10, axis=2))
    assert src.read_bytes() == before
