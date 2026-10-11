"""Identity, throw-outs, burst folding and the features file, on a synthetic library."""
import json

import numpy as np

from matcher import library
from tests.conftest import _unit


def by_rel(store):
    return {r["rel"]: dict(r) for r in store.q("SELECT * FROM photos")}


def test_refresh_finds_you_cuts_strangers_and_screenshots(lib_env):
    src, work, store, specs = lib_env
    summary = library.refresh(store)
    rows = by_rel(store)
    assert all(rows[f"other/stranger_{i}.jpg"]["cut"] == "not_you" for i in range(3))
    assert rows["Screenshot_20261000-101010_Chat.jpg"]["cut"] == "screenshot"
    assert rows["cam/IMG_0001.jpg"]["cut"] is None
    assert rows["cam/IMG_0000.jpg"]["me_face"] is not None          # you, even with a friend in frame
    assert "with_someone" in json.loads(rows["cam/IMG_0000.jpg"]["flags"])
    assert summary["cut"]["not_you"] == 3


def test_bursts_fold_into_one_shot_with_the_best_frame_on_top(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    rows = by_rel(store)
    gids = {rows[f"cam/burst_{k}.jpg"]["group_id"] for k in range(4)}
    assert len(gids) == 1
    g = store.one("SELECT * FROM groups WHERE id=?", (gids.pop(),))
    members = json.loads(g["members"])
    assert len(members) == 4
    priors = {r["id"]: r["prior"] for r in rows.values()}
    assert g["rep"] == max(members, key=lambda m: priors[m])        # biggest smile wins by default


def test_user_frame_choice_overrides_the_prior(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    rows = by_rel(store)
    worst = min((rows[f"cam/burst_{k}.jpg"] for k in range(4)), key=lambda r: r["prior"])
    with store.tx() as c:
        c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (worst["id"],))
    library.refresh(store)
    g = store.one("SELECT rep FROM groups WHERE id=?", (by_rel(store)[worst["rel"]]["group_id"],))
    assert g["rep"] == worst["id"]


def test_same_filename_in_two_folders_stays_two_photos(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    rows = by_rel(store)
    a, b = rows["a/IMG_9999.jpg"], rows["b/IMG_9999.jpg"]
    assert a["id"] != b["id"] and a["group_id"] != b["group_id"]


def test_rescue_and_toss_overrides(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    rows = by_rel(store)
    stranger, keeper = rows["other/stranger_0.jpg"], rows["cam/IMG_0002.jpg"]
    with store.tx() as c:
        c.execute("UPDATE photos SET override='keep' WHERE id=?", (stranger["id"],))
        c.execute("UPDATE photos SET override='toss' WHERE id=?", (keeper["id"],))
    library.refresh(store)
    rows = by_rel(store)
    assert rows["other/stranger_0.jpg"]["cut"] is None
    assert rows["cam/IMG_0002.jpg"]["cut"] == "tossed"
    z = np.load(work / "features.npz")
    tossed_item = list(z["gids"]).index(-keeper["id"])
    assert not z["active"][tossed_item]                              # stays in the model, inactive


def test_excluding_a_person_sets_their_photos_aside(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    people = store.q("SELECT * FROM people")
    assert people, "the recurring friend should show up as a person"
    cen = store.get_meta("people_centroids")[str(people[0]["id"])]
    store.set_meta("excluded_people", [cen])
    library.refresh(store)
    rows = by_rel(store)
    assert rows["cam/IMG_0000.jpg"]["cut"] == "excluded_person"
    assert rows["cam/IMG_0001.jpg"]["cut"] is None


def test_features_file_is_consistent(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    z = np.load(work / "features.npz")
    n = len(z["gids"])
    assert z["X"].shape == (n, len(library.HAND) + library.PCA_FULL + library.PCA_CROP)
    assert len(z["reps"]) == len(z["scenes"]) == len(z["active"]) == n
    assert np.isfinite(z["X"]).all()
    groups = store.q("SELECT id FROM groups")
    assert len(groups) == int(z["active"].sum())


def test_taken_from_filename():
    from matcher.imageio import taken_from_name
    assert taken_from_name("20250612_183012.jpg").isoformat() == "2025-06-12T18:30:12"
    assert taken_from_name("Screenshot_20261008-095104_Tinder.jpg").isoformat() == "2026-10-08T09:51:04"
    assert taken_from_name("PXL_20250612_183012345.jpg").isoformat() == "2025-06-12T18:30:12"
    assert taken_from_name("IMG-20250612-WA0001.jpg").isoformat() == "2025-06-12T00:00:00"
    assert taken_from_name("IMG_1234.jpg") is None


def test_subject_box_frames_the_face_consistently():
    from matcher.library import FRAME_ASPECT, subject_box
    face = {"x": 0.4, "y": 0.2, "w": 0.1, "h": 0.075}           # a smallish face in a 1200x1600 photo
    x, y, w, h = subject_box(1200, 1600, face)
    assert abs((w * 1200) / (h * 1600) - FRAME_ASPECT) < 1e-3     # 4:5 portrait in pixels
    assert x <= face["x"] and x + w >= face["x"] + face["w"]      # face inside, horizontally
    assert y <= face["y"] and y + h >= face["y"] + face["h"]      # ...and vertically
    assert 0 <= x and x + w <= 1 and 0 <= y and y + h <= 1        # fits, so stays inside the photo
    big = {"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.6}                 # a close-up selfie: frame bigger than photo
    bx, by, bw, bh = subject_box(1200, 1600, big)
    assert bw > 1 and abs(bx + bw / 2 - 0.5) < 1e-3                # centred; the UI clamps to the photo
    assert subject_box(1200, 1600, None) is None


def test_your_merges_and_splits_beat_the_automatic_stacker(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    rows = by_rel(store)
    a, b = rows["cam/IMG_0003.jpg"], rows["cam/IMG_0007.jpg"]           # unrelated singles
    burst = [rows[f"cam/burst_{k}.jpg"] for k in range(4)]              # stacked automatically
    with store.tx() as c:
        c.execute("UPDATE photos SET stack_key='m:mine' WHERE id IN (?, ?)", (a["id"], b["id"]))
        c.execute("UPDATE photos SET stack_key=? WHERE id=?", (f"solo:{burst[0]['id']}", burst[0]["id"]))
    library.refresh(store)
    rows = by_rel(store)
    assert rows["cam/IMG_0003.jpg"]["group_id"] == rows["cam/IMG_0007.jpg"]["group_id"]
    assert len({rows[f"cam/burst_{k}.jpg"]["group_id"] for k in range(1, 4)}) == 1   # the rest still stacked
    assert rows["cam/burst_0.jpg"]["group_id"] != rows["cam/burst_1.jpg"]["group_id"]  # yours stands alone


def test_lookalike_order_puts_families_side_by_side():
    rng = np.random.default_rng(3)
    centres = rng.normal(size=(4, 64))
    E = np.vstack([c + rng.normal(scale=0.12, size=(3, 64)) for c in centres])     # 4 families of 3
    E = E[rng.permutation(len(E))]
    E /= np.linalg.norm(E, axis=1, keepdims=True)
    truth = [int(np.argmax(centres @ e)) for e in E]
    order, family = library.lookalike_order(E.astype(np.float32), tau=0.9)
    assert sorted(order) == list(range(len(E)))
    runs = [truth[i] for i in order]
    assert sum(a != b for a, b in zip(runs, runs[1:])) == 3                 # each family is one contiguous run
    assert all((family[i] == family[j]) == (truth[i] == truth[j]) for i in range(len(E)) for j in range(len(E)))
    assert library.lookalike_order(E[:1].astype(np.float32)) == ([0], [0])


def test_regroup_stacks_exactly_like_a_full_refresh(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    rows = by_rel(store)
    a, b, burst0 = rows["cam/IMG_0003.jpg"], rows["cam/IMG_0007.jpg"], rows["cam/burst_0.jpg"]
    with store.tx() as c:
        c.execute("UPDATE photos SET stack_key='m:mine' WHERE id IN (?, ?)", (a["id"], b["id"]))
        c.execute("UPDATE photos SET stack_key=? WHERE id=?", (f"solo:{burst0['id']}", burst0["id"]))
        c.execute("UPDATE photos SET rep_pref=1 WHERE id=?", (rows["cam/burst_2.jpg"]["id"],))

    def state():
        z = np.load(work / "features.npz")
        return ({r["id"]: (r["rep"], r["members"], r["scene"]) for r in store.q("SELECT * FROM groups")},
                {r["id"]: (r["group_id"], r["scene_id"]) for r in store.q("SELECT id, group_id, scene_id FROM photos")},
                list(z["gids"]), list(z["reps"]), list(z["active"]))
    library.regroup(store)
    fast = state()
    library.refresh(store)
    assert fast == state()


def test_regroup_falls_back_to_a_full_refresh_when_more_changed(lib_env):
    src, work, store, specs = lib_env
    library.refresh(store)
    keeper = by_rel(store)["cam/IMG_0002.jpg"]["id"]
    with store.tx() as c:
        c.execute("UPDATE photos SET override='toss' WHERE id=?", (keeper,))
    library.regroup(store)
    assert store.one("SELECT cut FROM photos WHERE id=?", (keeper,))["cut"] == "tossed"


def test_join_stacks_rejoins_a_drifting_burst_and_a_crop_but_not_a_pair_you_split():
    from types import SimpleNamespace

    rng = np.random.default_rng(4)
    base, drift = _unit(rng.normal(0, 1, 768)), _unit(rng.normal(0, 1, 768))
    photos, embs = [], []

    def add(e, ts, ph):
        photos.append({"id": 100 + len(photos), "sha256": f"s{len(photos)}", "phash": ph, "taken_ts": ts})
        embs.append(_unit(e))

    # a burst over 49 s that drifts: neighbours alike, the ends not (the leader rules split it in two)
    for k in range(8):
        add(base + 0.09 * k * drift + rng.normal(0, 0.004, 768), 1000.0 + 7 * k, f"{rng.integers(0, 2**62):016x}")
    first_half, second_half = list(range(4)), list(range(4, 8))
    # an edited crop of another photo: the same capture time, alike but not near-identical, a different hash
    other = _unit(rng.normal(0, 1, 768))
    add(other, 5000.0, f"{rng.integers(0, 2**62):016x}")
    add(_unit(other + 0.62 * _unit(rng.normal(0, 1, 768))), 5000.0, f"{rng.integers(0, 2**62):016x}")
    # an unrelated photo a minute later
    add(rng.normal(0, 1, 768), 5060.0, f"{rng.integers(0, 2**62):016x}")
    lib = SimpleNamespace(photos=photos, emb=np.stack(embs).astype(np.float32), has_emb=np.ones(len(photos), bool))
    E = lib.emb
    assert float(E[0] @ E[7]) < 0.90 and float(E[3] @ E[4]) >= 0.90          # the ends differ, neighbours don't
    assert library.COPY_SIM <= float(E[8] @ E[9]) < 0.90                        # the crop: below the look-alike line
    groups = [first_half, second_half, [8], [9], [10]]
    joined = sorted(sorted(g) for g in library.join_stacks(lib, groups))
    assert joined == [list(range(8)), [8, 9], [10]]
    # you said the crop and the original are different shots: they stay apart
    apart = sorted(sorted(g) for g in library.join_stacks(lib, groups, dismissed=[[108, 109]]))
    assert [8, 9] not in apart and [8] in apart and [9] in apart
    # and a cap keeps a join from swallowing everything
    capped = library.join_stacks(lib, groups, cap=5)
    assert max(len(g) for g in capped) <= 5
