"""Independent structural references, ambiguity checks, and saved manual alignment through undo and export."""
import json
import subprocess

import numpy as np
import pytest
from PIL import Image, ImageDraw

from matcher import alignment, auto_look, finishing, touchup
from tests.test_draw import client, post, single


def outline(degrees, size=(800, 600), vertical=False):
    im = Image.new("RGB", size, "#697482")
    draw = ImageDraw.Draw(im)
    draw.rectangle((260, 70, 520, 530) if vertical else (100, 160, 700, 440), fill="#c8c1b6", outline="white", width=3)
    return im.rotate(-degrees, Image.Resampling.BICUBIC, fillcolor="#697482")


@pytest.mark.parametrize("degrees", [-7, -2.5, 0, 3.25, 9])
@pytest.mark.parametrize("vertical", [False, True])
def test_horizontal_and_vertical_references_find_the_same_clockwise_correction(degrees, vertical):
    found = alignment.measure(outline(degrees, vertical=vertical))
    assert found is not None
    assert found["degrees"] == pytest.approx(-degrees, abs=.15)
    assert found["perimeter"] > 1 and found["agreement"] > .8


def test_tiny_edge_fragments_do_not_outvote_long_structural_references():
    im = outline(4)
    # Fine texture has many more edges but does not supply a long, straight level reference.
    draw = ImageDraw.Draw(im)
    for x in range(30, 770, 22):
        for y in (30, 65, 520, 560):
            draw.rectangle((x, y, x + 13, y + 12), outline="white", width=2)
    assert alignment.measure(im)["degrees"] == pytest.approx(-4, abs=.15)


def test_flat_noise_and_curved_boundaries_do_not_invent_alignment():
    flat = Image.new("RGB", (800, 600), "grey")
    curved = flat.copy()
    ImageDraw.Draw(curved).ellipse((70, 50, 730, 550), outline="white", width=4)
    noise = Image.fromarray(np.random.default_rng(19).integers(0, 256, (600, 800, 3), dtype=np.uint8))
    assert alignment.measure(flat) is None
    assert alignment.measure(curved) is None
    assert alignment.measure(noise) is None


def test_manual_zero_and_switch_are_independent_of_enhancement_and_match_the_browser():
    recipe = {"straighten": -3.25}
    for edits, expected in [({}, -3.25), ({"enhance": False}, -3.25), ({"auto_align": False}, 0),
                            ({"straighten": 0}, 0), ({"straighten": 2, "auto_align": False}, 2)]:
        assert alignment.angle(recipe, edits) == expected
        js = subprocess.check_output(["node", "-e", "const {AutoLook}=require('./matcher/static/auto-look.js');process.stdout.write(JSON.stringify(AutoLook.angle(...JSON.parse(process.argv[1]))))", json.dumps([recipe, edits])], text=True)
        assert json.loads(js) == expected


def test_alignment_choices_are_saved_atomically_and_undoable(client):
    pid = single(client, 0)
    saved = post(client, "/api/edit", {"photo": pid, "straighten": 0, "auto_align": False}).get_json()
    assert saved["edits"] == {"straighten": 0, "auto_align": False}
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit"
    assert client.get(f"/api/edit?photo={pid}").get_json()["edits"] == {}
    post(client, "/api/draw/redo")
    assert client.get(f"/api/edit?photo={pid}").get_json()["edits"] == saved["edits"]
    for value in (0, 1, "on", []):
        assert post(client, "/api/edit", {"photo": pid, "auto_align": value, "title": "Do not save"}).status_code == 400
    assert client.get(f"/api/edit?photo={pid}").get_json()["edits"] == saved["edits"]
    assert post(client, "/api/edit", {"photo": pid, "straighten": None, "auto_align": None}).get_json()["edits"] == {}


def test_legacy_suggestions_wait_for_independent_reference_measurement():
    assert alignment.angle({"version": 1, "straighten": 3}) == 0
    assert alignment.angle({"version": 2, "straighten": 3}) == 0
    assert alignment.angle({"version": 1, "straighten": 3}, {"straighten": 2}) == 2


@pytest.mark.parametrize("degrees", [-6, 3.5])
def test_a_single_long_horizon_can_supply_the_reference_without_a_closed_outline(degrees):
    im = Image.new("RGB", (800, 600), "#8aaec8")
    ImageDraw.Draw(im).rectangle((0, 280, 800, 600), fill="#465950")
    im = im.rotate(-degrees, Image.Resampling.BICUBIC, fillcolor="#8aaec8")
    found = alignment.measure(im)
    assert found is not None and found["reference"] == "horizon"
    assert found["degrees"] == pytest.approx(-degrees, abs=.2)


def test_conflicting_large_objects_do_not_invent_a_scene_angle():
    im = Image.new("RGB", (800, 600), "#697482")
    for x, degrees in [(10, 6), (410, -5)]:
        tile = Image.new("RGB", (380, 600), "#697482")
        ImageDraw.Draw(tile).rectangle((60, 60, 320, 540), fill="#c8c1b6", outline="white", width=3)
        im.paste(tile.rotate(-degrees, Image.Resampling.BICUBIC, fillcolor="#697482"), (x, 0))
    assert alignment.measure(im) is None


def test_level_architecture_is_not_rotated_to_match_a_tilted_foreground_object():
    im = Image.new("RGB", (800, 600), "#697482")
    draw = ImageDraw.Draw(im)
    for y in (65, 120, 490, 545):
        draw.line((30, y, 770, y), fill="white", width=3)
    for x in (65, 135, 665, 735):
        draw.line((x, 25, x, 575), fill="white", width=3)
    tile = Image.new("RGBA", (500, 360))
    ImageDraw.Draw(tile).rectangle((30, 30, 470, 330), fill="#9c7656", outline="white", width=4)
    tile = tile.rotate(-7, Image.Resampling.BICUBIC)
    im.paste(tile, (150, 120), tile)
    found = alignment.measure(im)
    assert found is None or abs(found["degrees"]) < .2


def test_export_reuses_alignment_even_with_enhancement_off_and_manual_zero_keeps_every_pixel(tmp_path):
    im = outline(4)
    recipe = auto_look.measure(im)
    assert recipe["straighten"] == pytest.approx(-4, abs=.15)
    src, dst = tmp_path / "outline.png", tmp_path / "straight.jpg"
    im.save(src)
    touchup.touch_up(src, dst, {"enhance": False}, recipe=recipe, quality=100)
    expected = finishing.straighten(im, recipe["straighten"])
    out = Image.open(dst)
    assert out.size == expected.size and out.size != im.size
    assert np.abs(np.asarray(out).astype(float) - np.asarray(expected)).mean() < 2
    for edits in ({"enhance": False, "straighten": 0}, {"enhance": False, "auto_align": False}):
        touchup.touch_up(src, dst, edits, recipe=recipe)
        assert Image.open(dst).size == im.size
