"""Resolving contradictory copy lessons requires direct saved identity and compatible context."""
import math

import numpy as np
import pytest

from matcher import filter_fit, tags
from matcher.store import f16
from tests.test_filter_fit import subjects
from tests.test_filter_learning import trained


def influence(s, examples):
    photos = [dict(row) for row in s.store.q("SELECT * FROM photos ORDER BY id")]
    matched = {}
    result = filter_fit.influence(s.store, photos, tags.effective(s.store), examples, matched=matched)
    return result, matched


def vectors(s, mapping):
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET emb=? WHERE id=?", [(f16(np.asarray(vector)), pid) for pid, vector in mapping.items()])


@pytest.mark.parametrize("distance,similarity,seconds,expected", [(6, .967, 900, 1), (12, .96, 6, 1),
                                                                  (12, .96, 31, 0), (12, .94, 6, 0),
                                                                  (13, .96, 6, 0), (6, .88, 6, 0)])
def test_saved_hash_and_burst_evidence_qualify_only_direct_near_copy_matches(trained, distance, similarity, seconds, expected):
    s, _ = trained([{"phash": "0000000000000000", "taken_ts": 1000} for _ in range(2)] + [
        {"phash": f"{(1 << distance) - 1:016x}", "taken_ts": 1000 + seconds}])
    subjects(s, {pid: ["u:dogs"] for pid in (1, 2, 3)})
    vectors(s, {1: [1, 0], 2: [1, 0], 3: [similarity, math.sqrt(1 - similarity**2)]})
    result, matched = influence(s, [{"photo": 1, "direction": "away", "seq": 1}, {"photo": 2, "direction": "toward", "seq": 2}])
    assert result[2] == expected
    assert (3 in matched) == bool(expected)


def test_identical_file_evidence_works_without_saved_embeddings(trained):
    s, _ = trained([{"sha256": "same-pixels"} for _ in range(3)] + [{"sha256": "other-pixels"}])
    subjects(s, {pid: ["u:dogs"] for pid in range(1, 5)})
    result, matched = influence(s, [{"photo": 1, "direction": "away", "seq": 1}, {"photo": 2, "direction": "toward", "seq": 2}])
    np.testing.assert_array_equal(result, [1, 1, 1, 0])
    assert set(matched) == {1, 2, 3}


@pytest.mark.parametrize("field,values", [("luma", [64, 160, 65, 159]), ("width", [900, 1800, 920, 1780])])
def test_visual_copy_identity_does_not_erase_meaningful_light_or_framing_contrast(trained, field, values):
    s, _ = trained([{field: value, "phash": "0000000000000000"} for value in values])
    subjects(s, {pid: ["u:dogs"] for pid in range(1, 5)})
    vectors(s, {pid: [1, 0] for pid in range(1, 5)})
    result, matched = influence(s, [{"photo": 1, "direction": "away", "seq": 1}, {"photo": 2, "direction": "toward", "seq": 2}])
    assert result[2] < -.7 and result[3] > .7
    assert matched[3]["direction"] == "away" and matched[4]["direction"] == "toward"


def test_near_copy_identity_preserves_a_more_specific_subject_lesson(trained):
    s, _ = trained([{} for _ in range(4)])
    subjects(s, {1: ["u:dogs", "u:beach"], 2: ["u:dogs"], 3: ["u:dogs", "u:beach"], 4: ["u:dogs", "u:park"]})
    vectors(s, {pid: [1, 0] for pid in range(1, 5)})
    result, matched = influence(s, [{"photo": 1, "direction": "away", "seq": 1}, {"photo": 2, "direction": "toward", "seq": 2}])
    assert result[2] == -1 and matched[3]["seq"] == 1
    assert result[3] == 1 and matched[4]["seq"] == 2


@pytest.mark.parametrize("same_hash", [False, True])
def test_unsequenced_or_tied_copy_lessons_do_not_invent_a_latest_choice(trained, same_hash):
    s, _ = trained([{"sha256": "same-pixels"} if same_hash else {} for _ in range(3)])
    subjects(s, {pid: ["u:dogs"] for pid in range(1, 4)})
    vectors(s, {pid: [1, 0] for pid in range(1, 4)})
    for extra in ({}, {"seq": 1}):
        result, matched = influence(s, [{"photo": 1, "direction": "away", **extra}, {"photo": 2, "direction": "toward", **extra}])
        np.testing.assert_array_equal(result, [0, 0, 0])
        assert matched == {}
