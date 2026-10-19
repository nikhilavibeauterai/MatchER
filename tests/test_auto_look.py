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
        assert np.allclose(actual["curve"], expected["curve"])
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
    updated = []
    assert auto_look.fill_missing(s.store, s.workdir, on_photo=updated.append) == 1
    assert updated == [pid]
    photo = client.get(f"/api/photo/{pid}/notes").get_json()
    assert photo["auto_look"]["version"] == auto_look.VERSION and photo["edits"]["title"] == "My original"
    before = s.store.conn().total_changes
    assert auto_look.fill_missing(s.store, s.workdir) == 0
    assert s.store.conn().total_changes == before


def test_progressive_baselines_are_bounded_and_cannot_skip_a_late_worker_update(client, monkeypatch):
    s = client.matcher.session
    first, second = single(client, 0), single(client, 1)
    s._looks_thread.join()
    monkeypatch.setattr(s._looks_thread, "is_alive", lambda: True)
    s._looks_after = first
    page = client.get("/api/auto-looks?per=1").get_json()
    assert page["working"] and len(page["recipes"]) == 1
    cursor = page["after"]
    while page["more"]:
        page = client.get(f"/api/auto-looks?after={cursor}&per=1").get_json()
        cursor = page["after"]
    assert cursor == first and all(row["id"] <= first for row in page["recipes"])
    s._looks_after = second
    page = client.get(f"/api/auto-looks?after={cursor}&per=1").get_json()
    assert [row["id"] for row in page["recipes"]] == [second]
    assert page["recipes"][0]["recipe"]["version"] == auto_look.VERSION
    assert not page["more"] and page["after"] == second
    monkeypatch.setattr(s._looks_thread, "is_alive", lambda: False)
    assert client.get("/api/auto-looks?per=99999").get_json()["working"] is False


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


def ramp(low, high):
    values = np.tile(np.linspace(low, high, 320), (240, 1))
    return Image.fromarray(np.round(np.repeat(values[..., None], 3, axis=2) * 255).astype(np.uint8))


def test_dim_exposure_is_corrected_visibly_instead_of_being_mistaken_for_night():
    im = ramp(.02, .42)
    recipe = auto_look.measure(im)
    out = np.asarray(render(im, recipe)) / 255
    assert recipe["label"] != "Night light"
    assert np.median(out) > np.median(np.asarray(im) / 255) + .12
    assert np.mean(out == 1) < .01 and np.mean(out == 0) < .01
    assert recipe["measured"]["exposure"] > 1


def test_washed_out_photo_gains_depth_and_overexposed_midtones_come_down():
    hazy = ramp(.28, .68)
    out = np.asarray(render(hazy, auto_look.measure(hazy))) / 255
    assert np.quantile(out, .9) - np.quantile(out, .1) > .48
    assert out.min() > 0 and out.max() < 1
    over = ramp(.25, .99)
    corrected = np.asarray(render(over, auto_look.measure(over))) / 255
    assert np.median(corrected) < np.median(np.asarray(over) / 255) - .09
    assert np.quantile(corrected, .99) > .94


def test_night_lights_and_high_key_scenes_keep_their_intended_atmosphere():
    night = np.full((240, 320, 3), 18, dtype=np.uint8)
    night[20:40, 30:80] = [255, 170, 45]
    night[120:145, 250:300] = [80, 170, 255]
    im = Image.fromarray(night)
    recipe = auto_look.measure(im)
    assert recipe["label"] == "Night light"
    assert np.median(np.asarray(render(im, recipe))) < 24
    high_key = ramp(.66, .99)
    recipe = auto_look.measure(high_key)
    assert "Protect the bright atmosphere" in recipe["reasons"]
    assert np.median(np.asarray(render(high_key, recipe))) > 200


def test_white_balance_uses_neutral_evidence_without_neutralising_saturated_light():
    neutral = np.repeat(np.tile(np.linspace(.20, .70, 320), (240, 1))[..., None], 3, axis=2)
    cast = np.array([1.15, 1, .86])
    im = Image.fromarray(np.round(neutral * cast * 255).astype(np.uint8))
    recipe = auto_look.measure(im)
    assert recipe["wb"][0] < .95 and recipe["wb"][2] > 1.05
    before = np.asarray(im, dtype=float).mean((0, 1))
    after = np.asarray(render(im, recipe), dtype=float).mean((0, 1))
    assert (after.max() - after.min()) / after.mean() < (before.max() - before.min()) / before.mean() * .60
    stage_light = auto_look.measure(Image.new("RGB", (320, 240), (115, 30, 190)))
    assert stage_light["wb"] == [1, 1, 1]


def test_tone_curves_stay_smooth_monotone_and_agree_with_browser_at_every_amount():
    rng = np.random.default_rng(57)
    for _ in range(15):
        low, high = sorted(rng.uniform(.01, .99, 2))
        recipe = auto_look.measure(ramp(low, high))
        for amount in (0, .35, 1, 1.5):
            curve = auto_look.resolve(recipe, {"auto_amount": amount})["curve"]
            assert min(curve) >= 0 and max(curve) <= 1 and np.min(np.diff(curve)) >= 0
        assert max(np.diff(recipe["curve"])) < .15
    js = subprocess.check_output(["node", "-e", "const {AutoLook}=require('./matcher/static/auto-look.js');process.stdout.write(JSON.stringify([0,.35,1,1.5].map(auto_amount=>AutoLook.resolve(JSON.parse(process.argv[1]),{auto_amount}).curve)))", json.dumps(recipe)], text=True)
    for amount, actual in zip((0, .35, 1, 1.5), json.loads(js)):
        assert np.allclose(actual, auto_look.resolve(recipe, {"auto_amount": amount})["curve"])
