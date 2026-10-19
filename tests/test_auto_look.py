"""Saved scene-aware baselines, editable components, and the same recipe at export."""
import json
import subprocess

import numpy as np
import pytest
from PIL import Image

from matcher import auto_look, finishing, touchup
from tests.test_draw import client, post, single


def render(im, recipe, edits=None):
    how = auto_look.resolve(recipe, edits)
    return finishing.apply(touchup.apply(im, how), how, im.size, (0, 0, *im.size))


def test_flat_photos_do_not_turn_black_and_monochrome_stays_neutral():
    im = Image.new("RGB", (120, 160), (100, 100, 100))
    recipe = auto_look.measure(im)
    out = np.asarray(render(im, recipe))
    assert 100 <= out.mean() <= 115
    assert recipe["label"] == "Monochrome" and recipe["grade"] == {} and recipe["sat"] == 1
    assert np.array_equal(out[..., 0], out[..., 1]) and np.array_equal(out[..., 1], out[..., 2])


@pytest.mark.parametrize("colour", [(28, 8, 45), (170, 25, 210), (230, 140, 50), (60, 105, 170)])
def test_the_baseline_preserves_coloured_light_and_dark_atmosphere(colour):
    im = Image.new("RGB", (160, 120), colour)
    recipe = auto_look.measure(im)
    out = np.asarray(render(im, recipe))[0, 0].astype(float)
    assert list(np.argsort(out)) == list(np.argsort(colour))
    before = np.array(colour, dtype=float)
    assert np.max(np.abs(out - before)) < 22
    if max(colour) < 50:
        assert recipe["label"] == "Night light" and out.mean() < before.mean() * 1.2


def test_amount_zero_and_component_overrides_are_identity_and_match_the_browser():
    im = Image.fromarray(np.random.default_rng(4).integers(0, 255, (120, 160, 3), dtype=np.uint8))
    recipe = auto_look.measure(im)
    assert np.array_equal(np.asarray(render(im, recipe, {"auto_amount": 0})), np.asarray(im))
    off = {"auto_parts": dict.fromkeys(auto_look.PARTS, False)}
    assert auto_look.resolve(recipe, off)["levels"] == [(1, 0)] * 3
    for edits in ({}, {"auto_amount": .37}, off, {"auto_parts": {"tone": False, "grade": False}}):
        js = subprocess.check_output(["node", "-e", "const {AutoLook}=require('./matcher/static/auto-look.js');process.stdout.write(JSON.stringify(AutoLook.resolve(...JSON.parse(process.argv[1]))))", json.dumps([recipe, edits])], text=True)
        actual, expected = json.loads(js), auto_look.resolve(recipe, edits)
        assert np.allclose(actual["lin"], expected["levels"])
        assert actual["gamma"] == expected["gamma"] and actual["sat"] == expected["saturation"]
        assert (actual["grade"] or {}) == expected["grade"] and actual["masks"] == expected["masks"]


def test_backlit_subject_mask_is_original_relative_and_can_be_edited():
    im = Image.new("RGB", (160, 120), (150, 170, 190))
    recipe = auto_look.measure(im, [{"x": .3, "y": .2, "w": .15, "h": .2, "luma": 40}])
    mask = recipe["masks"][0]
    assert finishing.masks([mask])
    assert mask["strokes"][0]["p"][0] == pytest.approx([.375, .3])
    assert auto_look.resolve(recipe, {"auto_parts": {"subject": False}})["masks"] == []


def test_old_libraries_upgrade_from_previews_once_without_touching_edits(client, monkeypatch):
    s = client.matcher.session
    pid = single(client, 0)
    s._looks_thread.join()
    with s.store.tx() as c:
        c.execute("UPDATE photos SET auto_look=NULL,auto_version=0,edits=? WHERE id=?", (json.dumps({"title": "My original", "auto_amount": .5}), pid))
    monkeypatch.setattr(touchup.imageio, "decode", lambda *_a, **_k: pytest.fail("Never decode an original to upgrade a baseline"))
    assert auto_look.fill_missing(s.store, s.workdir) == 1
    photo = client.get(f"/api/photo/{pid}/notes").get_json()
    assert photo["auto_look"]["version"] == auto_look.VERSION and photo["edits"]["title"] == "My original"
    before = s.store.conn().total_changes
    assert auto_look.fill_missing(s.store, s.workdir) == 0
    assert s.store.conn().total_changes == before


def test_auto_choices_and_manual_changes_share_one_undo_step(client):
    pid = single(client, 0)
    patch = {"photo": pid, "enhance": True, "auto_amount": .4, "auto_parts": {"grade": False}, "look": {"light": .2}}
    assert post(client, "/api/edit", patch).status_code == 200
    saved = client.get(f"/api/edit?photo={pid}").get_json()["edits"]
    assert saved["auto_amount"] == .4 and saved["auto_parts"] == {"grade": False} and saved["look"]["light"] == .2
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit"
    assert client.get(f"/api/edit?photo={pid}").get_json()["edits"] == {}
    post(client, "/api/draw/redo")
    assert client.get(f"/api/edit?photo={pid}").get_json()["edits"] == saved
    for value in (-.1, 1.51, True, float("nan"), "1"):
        assert post(client, "/api/edit", {"photo": pid, "auto_amount": value, "title": "Should not save"}).status_code == 400
    for value in ([], {"grade": 1}, {"missing": False}):
        assert post(client, "/api/edit", {"photo": pid, "auto_parts": value}).status_code == 400
    assert client.get(f"/api/edit?photo={pid}").get_json()["edits"] == saved


def test_export_reuses_the_recipe_and_applies_manual_grade_after_it(tmp_path, monkeypatch):
    im = Image.new("RGB", (120, 160), (140, 90, 60))
    recipe = auto_look.measure(im)
    recipe["detail"] = {}
    src, dst = tmp_path / "original.png", tmp_path / "edited.jpg"
    im.save(src)
    edits = {"auto_amount": .6, "grade": {"shadows": {"hue": 230, "amount": .2}}}
    monkeypatch.setattr(touchup, "look", lambda *_: pytest.fail("Export must not remeasure a saved look"))
    touchup.touch_up(src, dst, edits, recipe=recipe, quality=100)
    expected = finishing.apply(render(im, recipe, edits), edits, im.size, (0, 0, *im.size))
    assert np.abs(np.asarray(Image.open(dst)).astype(float) - np.asarray(expected)).mean() < 2
    assert np.array_equal(np.asarray(Image.open(src)), np.asarray(im))
