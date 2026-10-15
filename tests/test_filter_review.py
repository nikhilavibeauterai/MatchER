"""Filter samples useful contrasts without making a large library another manual checklist."""
import copy
import random
import time

import pytest

from matcher import filter_review, filtering


def take(pid, **changes):
    metrics = {"width": 2000, "height": 1600, "brightness": 128, "sharpness": 140,
               "scores": {"blurry": .1, "document": .1, "screenshot": .1, "accidental": .1}}
    metrics.update(changes.pop("metrics", {}))
    return {"id": pid, "status": "analyzed", "playable": True, "disposition": "keep", "reasons": [],
            "changed": False, "override": None, "metrics": metrics, **changes}


def schedule(rows, **kwargs):
    policy = kwargs.pop("policy", filtering.defaults({"mode": "gallery"}))
    return filter_review.schedule(rows, policy, kwargs.pop("mode", "gallery"), kwargs.pop("tags", {}), kwargs.pop("families", {}), **kwargs)


def test_round_covers_a_changed_take_both_sides_of_a_boundary_and_clear_audits():
    rows = [take(i) for i in range(1, 31)]
    rows[19]["changed"] = True
    rows[20]["metrics"]["width"] = 401
    rows[21].update(disposition="aside", reasons=["tiny"])
    rows[21]["metrics"]["width"] = 399
    rows[22].update(disposition="aside", reasons=["tiny"])
    rows[22]["metrics"]["width"] = 100
    result = schedule(rows)
    assert len(result["ids"]) == len(set(result["ids"])) == 12
    assert {20, 21, 22, 23} <= set(result["ids"])
    assert result["why"][20] == "Changed by this draft"
    assert result["why"][21] == result["why"][22] == "Near your size limit"
    assert "Spot-check an in-play take" in result["why"].values()
    assert result["why"][23] == "Spot-check a set-aside take"


def test_subject_diversity_and_stack_diversity_beat_file_order():
    rows = [take(i) for i in range(1, 25)]
    tags = {i: {"dogs"} if i < 20 else {f"subject:{i}"} for i in range(1, 25)}
    families = {i: "dog-burst" if i < 20 else f"family:{i}" for i in range(1, 25)}
    result = schedule(rows, tags=tags, families=families, limit=6)
    assert set(result["ids"]) == {1, 20, 21, 22, 23, 24}
    assert len({families[pid] for pid in result["ids"]}) == 6


def test_seen_family_waits_for_other_families_but_all_siblings_can_eventually_be_reviewed():
    rows = [take(i) for i in range(1, 10)]
    families = {i: "burst" if i < 6 else f"other:{i}" for i in range(1, 10)}
    seen = {1}
    result = schedule(rows, families=families, seen=seen, limit=4)
    assert set(result["ids"]) == {6, 7, 8, 9}
    seen.update(result["ids"])
    remainder = schedule(rows, families=families, seen=seen)
    assert set(remainder["ids"]) == {2, 3, 4, 5}
    assert schedule(rows, families=families, seen=seen | set(remainder["ids"])) == {"ids": [], "why": {}}


def test_later_returns_in_order_without_swamping_round_and_respects_scope():
    rows = [take(i, disposition="aside" if i % 2 else "keep") for i in range(1, 25)]
    result = schedule(rows, deferred=[21, 19, 17, 15], seen=[19], scope="aside")
    assert result["ids"][:2] == [21, 17]
    assert result["why"][21] == result["why"][17] == "Back from Later"
    assert all(pid % 2 for pid in result["ids"]) and 19 not in result["ids"]
    assert len([why for why in result["why"].values() if why == "Back from Later"]) == 2
    kept = schedule(rows, deferred=[21, 20], scope="kept", limit=1)
    assert kept["ids"] == [20]


def test_unreadable_and_seen_takes_are_never_dealt_even_when_deferred():
    rows = [take(1, status="error"), take(2, playable=False), take(3), take(4)]
    assert schedule(rows, seen=[3], deferred=[1, 2, 3, 4])["ids"] == [4]
    assert schedule(rows, deferred=[4], limit=0) == {"ids": [], "why": {}}


def test_round_is_reproducible_and_inputs_are_unchanged():
    rows = [take(i, changed=i % 7 == 0, metrics={"width": i * 50}) for i in range(1, 80)]
    tags = {row["id"]: {f"subject:{row['id'] % 9}"} for row in rows}
    before = copy.deepcopy((rows, tags))
    first = schedule(rows, tags=tags, deferred=[77, 33])
    shuffled = list(rows)
    random.Random(1234).shuffle(shuffled)
    assert schedule(shuffled, tags=tags, deferred=[77, 33]) == first
    assert (rows, tags) == before
    assert set(first["why"]) == set(first["ids"])


def test_only_changed_and_explicit_scopes_are_respected():
    rows = [take(i, changed=i in {3, 6, 9}) for i in range(1, 12)]
    assert set(schedule(rows, scope="changed")["ids"]) == {3, 6, 9}
    assert set(schedule(rows, scope={2, 8, 99})["ids"]) == {2, 8}
    with pytest.raises(ValueError, match="Unknown Filter review scope"):
        schedule(rows, scope="unknown")


def test_blur_boundary_requires_the_other_part_of_the_blur_check():
    policy = filtering.defaults({"mode": "gallery"})
    disabled = take(1, metrics={"sharpness": 25})
    enabled = take(2, metrics={"sharpness": 25, "scores": {"blurry": .99}})
    assert filter_review._boundary(disabled, policy, "gallery")[1] != "Near your blur limit"
    assert filter_review._boundary(enabled, policy, "gallery") == (0, "Near your blur limit")
    policy["document"] = False
    assert filter_review._boundary(take(3, metrics={"scores": {"document": .9}}), policy, "gallery")[1] != "Near your document check"


def test_profile_boundaries_use_face_light_and_unknown_measurements_abstain():
    policy = filtering.defaults({"mode": "me"})
    row = take(1, metrics={"brightness": policy["min_luma"], "face": {"luma": 128, "h": .4}})
    assert filter_review._boundary(row, policy, "me")[0] > 1
    row["metrics"]["face"]["luma"] = policy["min_luma"]
    assert filter_review._boundary(row, policy, "me") == (0, "Near your darkness limit")
    unknown = take(2, metrics={"width": None, "height": None, "brightness": float("nan"), "sharpness": float("inf"), "scores": {}, "face": {}})
    assert filter_review._boundary(unknown, policy, "me") == (None, None)
    assert schedule([unknown], policy=policy, mode="me")["ids"] == [2]


def test_subject_checks_do_not_claim_a_recognition_is_certain():
    rows = [take(i) for i in range(1, 30)]
    rows[28].update(disposition="aside", reasons=["required_tags"])
    result = schedule(rows)
    assert result["why"][29] == "Check a subject match"
    assert all("confidence" not in why.lower() for why in result["why"].values())


def test_ten_thousand_takes_use_one_measurement_pass_and_a_bounded_round(monkeypatch):
    rows = [take(i, changed=i % 41 == 0, metrics={"width": 300 + i % 1700}) for i in range(1, 10001)]
    tags = {i: {f"subject:{i % 31}", f"outing:{i % 17}"} for i in range(1, 10001)}
    families = {i: (i - 1) // 4 for i in range(1, 10001)}
    calls, original = [], filter_review._boundary
    def counted(row, policy, mode):
        calls.append(row["id"])
        return original(row, policy, mode)
    monkeypatch.setattr(filter_review, "_boundary", counted)
    start = time.monotonic()
    result = schedule(rows, tags=tags, families=families)
    elapsed = time.monotonic() - start
    assert len(calls) == len(rows)
    assert len(result["ids"]) == len({families[pid] for pid in result["ids"]}) == 12
    assert elapsed < 5, f"10k Filter scheduling took {elapsed:.2f}s"
