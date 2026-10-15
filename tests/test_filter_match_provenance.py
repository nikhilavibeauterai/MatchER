"""Only a clearly matching newer teaching example may revisit an older individual call."""
import numpy as np

from matcher import filter_fit, tags
from matcher.store import f16
from tests.test_filter_fit import subjects
from tests.test_filter_learning import trained


def inputs(session):
    return [dict(row) for row in session.store.q("SELECT * FROM photos ORDER BY id")], tags.effective(session.store)


def test_match_provenance_keeps_specific_context_ahead_of_newer_broad_teaching(trained):
    s, _ = trained([{} for _ in range(5)])
    subjects(s, {1: ["u:dogs"], 2: ["u:dogs", "u:beach"], 3: ["u:dogs", "u:beach"],
                 4: ["u:dogs", "u:park"], 5: ["u:cats", "u:beach"]})
    photos, sets = inputs(s)
    examples = [{"photo": 1, "direction": "toward", "seq": 10}, {"photo": 2, "direction": "away", "seq": 4}]
    matches = {}
    pull = filter_fit.influence(s.store, photos, sets, examples, matched=matches)
    np.testing.assert_array_equal(pull, filter_fit.influence(s.store, photos, sets, examples))
    assert {pid: (row["direction"], row["seq"]) for pid, row in matches.items()} == {
        1: ("toward", 10), 2: ("away", 4), 3: ("away", 4), 4: ("toward", 10)}
    assert 5 not in matches


def test_duplicate_examples_keep_the_newest_matching_sequence_without_amplifying_learning(trained):
    s, _ = trained([{} for _ in range(3)])
    subjects(s, {pid: ["u:dogs"] for pid in range(1, 4)})
    photos, sets = inputs(s)
    examples = [{"photo": 1, "direction": "toward", "seq": 2}, {"photo": 2, "direction": "toward", "seq": 5}]
    matches = {}
    pull = filter_fit.influence(s.store, photos, sets, examples, matched=matches)
    np.testing.assert_array_equal(pull, np.ones(3))
    assert all(row == {"direction": "toward", "seq": 5, "strength": 1.0} for row in matches.values())


def test_ambiguous_opposed_examples_and_unsequenced_legacy_examples_cannot_revisit_calls(trained):
    s, _ = trained([{} for _ in range(3)])
    subjects(s, {pid: ["u:dogs"] for pid in range(1, 4)})
    photos, sets = inputs(s)
    matches = {100: {"seq": 99}}
    examples = [{"photo": 1, "direction": "toward", "seq": 2}, {"photo": 2, "direction": "away", "seq": 5}]
    pull = filter_fit.influence(s.store, photos, sets, examples, matched=matches)
    np.testing.assert_array_equal(pull, np.zeros(3))
    assert matches == {}
    pull = filter_fit.influence(s.store, photos, sets, [{"photo": 1, "direction": "away"}], matched=matches)
    np.testing.assert_array_equal(pull, -np.ones(3))
    assert matches == {}


def test_matched_sequence_follows_actual_measured_context_not_the_newest_example_everywhere(trained):
    s, _ = trained([{"luma": light, "sharp": sharp} for light, sharp in
                    ((64, 3), (160, 63), (66, 3), (158, 63), (64, 63), (160, 3))])
    subjects(s, {pid: ["u:dogs"] for pid in range(1, 7)})
    photos, sets = inputs(s)
    matches = {}
    filter_fit.influence(s.store, photos, sets,
                         [{"photo": 1, "direction": "away", "seq": 2},
                          {"photo": 2, "direction": "toward", "seq": 5}], matched=matches)
    assert {pid: (row["direction"], row["seq"]) for pid, row in matches.items()} == {
        1: ("away", 2), 2: ("toward", 5), 3: ("away", 2), 4: ("toward", 5)}


def test_visual_matches_need_strong_saved_similarity_and_an_unambiguous_direction(trained):
    s, _ = trained([{} for _ in range(4)])
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET emb=? WHERE id=?", [(f16(np.asarray(vector)), pid)
                      for pid, vector in enumerate(([1, 0], [.98, .2], [.86, .51], [0, 1]), 1)])
    photos, _ = inputs(s)
    matches = {}
    filter_fit.influence(s.store, photos, {}, [{"photo": 1, "direction": "away", "seq": 7}], matched=matches)
    assert set(matches) == {1, 2}
    assert all(row["seq"] == 7 and row["direction"] == "away" for row in matches.values())
