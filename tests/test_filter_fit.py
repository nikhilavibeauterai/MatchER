"""The Filter line previews real admission, including the first local teaching example."""
import numpy as np
import pytest

from matcher import filter_fit
from matcher.store import f16
from tests.test_filter_learning import trained
from tests.test_filtering import client, fetch, post
from tests.test_filter_tuning import tune


def subjects(s, mapping):
    keys = sorted({key for values in mapping.values() for key in values})
    existing = [row["key"] for row in s.store.q("SELECT key FROM tags")]
    with s.store.tx() as c:
        c.executemany("INSERT OR IGNORE INTO tags(key,label,emoji,family,user) VALUES(?,?,'','what',1)", [(key, key) for key in keys])
        c.executemany("INSERT OR REPLACE INTO tag_edits(photo_id,tag,val) VALUES(?,?,0)",
                      [(pid, key) for pid in mapping for key in existing])
        c.executemany("INSERT OR REPLACE INTO tag_edits(photo_id,tag,val) VALUES(?,?,1)",
                      [(pid, key) for pid, values in mapping.items() for key in values])


def test_first_away_moves_whole_subject_combination_only_in_preview_and_undo_restores_it(client):
    s = client.session
    ids = [int(pid) for pid in s.reps[:5]]
    subjects(s, {ids[0]: ["u:dogs", "u:beach"], ids[1]: ["u:dogs", "u:beach"],
                 ids[2]: ["u:dogs"], ids[3]: ["u:beach"], ids[4]: ["u:cats"]})
    s.refresh_async(); s.wait_refresh()
    before = fetch(client)
    original = [tuple(row) for row in s.store.q("SELECT id,cut,override FROM photos ORDER BY id")]
    result = tune(client, ids[0], "away")
    assert result["changed"] == 1 and result["learning"]["ready"] and not result["learning"]["global_ready"]
    example, = result["learning"]["policy"]["fit_examples"]
    assert example == {"photo": ids[0], "direction": "away", "seq": example["seq"]} and example["seq"] > 0
    preview = post(client, "/api/filter/preview", {"policy": result["learning"]["policy"]}).get_json()
    assert ids[1] in preview["ids"]["changed"] and ids[0] not in preview["ids"]["changed"]
    assert fetch(client)["scores"][str(ids[0])] == 0
    assert all(preview["scores"][str(pid)] < .5 for pid in ids[:2])
    assert all(preview["scores"][str(pid)] == before["scores"][str(pid)] for pid in ids[2:])
    current = [tuple(row) for row in s.store.q("SELECT id,cut,override FROM photos ORDER BY id")]
    assert [row for row in current if row[0] != ids[0]] == [row for row in original if row[0] != ids[0]]
    assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 200
    after = fetch(client)
    assert set(ids[:2]) <= set(after["ids"]["aside"])
    assert after["scores"] == preview["scores"], "Derived refresh and preview use exactly the same scoring"
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["policy"] == before["policy"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert not post(client, "/api/filter/learn").get_json()["learning"]["ready"]
    assert [tuple(row) for row in s.store.q("SELECT id,cut,override FROM photos ORDER BY id")] == original


def test_toward_rescues_related_quality_failures_but_preserves_newer_toss_and_unreadable(client):
    s = client.session
    ids = [int(pid) for pid in s.reps[:4]]
    subjects(s, {pid: ["u:dogs"] for pid in ids})
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET width=300 WHERE id=?", [(pid,) for pid in ids])
        c.execute("UPDATE photos SET status='error' WHERE id=?", (ids[3],))
    s.refresh_async(); s.wait_refresh()
    result = tune(client, ids[0], "toward")
    assert post(client, "/api/filter/decision", {"photos": [ids[2]], "action": "aside"}).status_code == 200
    preview = post(client, "/api/filter/preview", {"policy": result["learning"]["policy"]}).get_json()
    assert set(ids[:2]) <= set(preview["ids"]["kept"])
    assert set(ids[2:]) <= set(preview["ids"]["aside"])
    assert all(preview["scores"][str(pid)] == 0 for pid in ids[2:])
    actual = fetch(client)
    assert actual["scores"][str(ids[0])] == 1 and ids[0] in actual["ids"]["kept"]
    assert all(pid in actual["ids"]["aside"] for pid in ids[1:])


@pytest.mark.parametrize("action,endpoint", [("keep", 1), ("aside", 0)])
def test_first_keep_or_toss_affects_only_that_take_and_undo_restores_it(client, action, endpoint):
    s = client.session
    ids = [int(pid) for pid in s.reps[:3]]
    subjects(s, {ids[0]: ["u:dogs"], ids[1]: ["u:dogs"], ids[2]: ["u:cats"]})
    s.refresh_async(); s.wait_refresh()
    before = fetch(client)
    result = post(client, "/api/filter/decision", {"photos": [ids[0]], "action": action}).get_json()
    assert not result["learning"]["ready"] and not result["learning"]["global_ready"]
    assert result["learning"]["policy"] == before["policy"]
    preview = post(client, "/api/filter/preview", {"policy": result["learning"]["policy"]}).get_json()
    assert preview["scores"][str(ids[0])] == endpoint
    related_before, related_after = before["scores"][str(ids[1])], preview["scores"][str(ids[1])]
    assert related_after == related_before
    assert preview["scores"][str(ids[2])] == before["scores"][str(ids[2])]
    assert fetch(client)["scores"][str(ids[1])] == related_before
    assert post(client, "/api/draw/undo").status_code == 200
    learned = post(client, "/api/filter/learn").get_json()["learning"]
    assert not learned["ready"] and learned["policy"]["fit_examples"] == []
    assert fetch(client)["scores"] == before["scores"]


def test_explicit_direction_beats_keep_exception_for_same_example(client):
    pid = fetch(client)["ids"]["kept"][0]
    taught = tune(client, pid, "away")
    result = post(client, "/api/filter/decision", {"photos": [pid], "action": "keep"}).get_json()
    assert result["learning"]["policy"]["fit_examples"] == taught["learning"]["policy"]["fit_examples"]
    assert fetch(client)["scores"][str(pid)] == 1


def test_even_repeated_contrasting_individual_calls_never_solve_global_rules(client):
    s = client.session
    ids = [int(pid) for pid in s.reps[:6]]
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET width=?,height=2000 WHERE id=?", list(zip((600, 650, 700, 1400, 1500, 1600), ids)))
    s.refresh_async(); s.wait_refresh()
    before = fetch(client)
    for i, pid in enumerate(ids):
        result = post(client, "/api/filter/decision", {"photos": [pid], "action": "aside" if i < 3 else "keep"}).get_json()
        assert not result["learning"]["ready"] and result["learning"]["policy"] == before["policy"]
    assert post(client, "/api/filter/learn").get_json()["learning"]["policy"] == before["policy"]


def test_line_is_continuous_read_only_and_manual_endpoints_survive_every_threshold(client):
    s = client.session
    ids = [int(pid) for pid in s.reps[:4]]
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET width=?,height=2000,luma=128 WHERE id=?", list(zip((450, 550, 750, 950), ids)))
        c.execute("UPDATE photos SET override='keep' WHERE id=?", (ids[2],))
        c.execute("UPDATE photos SET override='toss' WHERE id=?", (ids[3],))
    s.refresh_async(); s.wait_refresh()
    before = fetch(client)
    assert .5 < before["scores"][str(ids[0])] < before["scores"][str(ids[1])] < 1
    assert before["scores"][str(ids[2])] == 1 and before["scores"][str(ids[3])] == 0
    threshold = (before["scores"][str(ids[0])] + before["scores"][str(ids[1])]) / 2
    preview = post(client, "/api/filter/preview", {"policy": {**before["policy"], "fit_threshold": threshold}}).get_json()
    assert ids[0] in preview["ids"]["aside"] and ids[1] in preview["ids"]["kept"]
    assert fetch(client)["ids"] == before["ids"]
    for value in (0, 1):
        extremes = post(client, "/api/filter/preview", {"policy": {**before["policy"], "fit_threshold": value}}).get_json()
        assert ids[2] in extremes["ids"]["kept"] and ids[3] in extremes["ids"]["aside"]
    token = post(client, "/api/filter/preview", {"policy": preview["policy"]}).get_json()["token"]
    assert post(client, "/api/filter/apply", {"token": token}).status_code == 200
    assert fetch(client)["ids"]["aside"] == preview["ids"]["aside"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["policy"] == before["policy"]


def test_untagged_examples_use_close_saved_embeddings_and_opposing_examples_cancel(trained):
    s, p = trained([{} for _ in range(4)])
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override=NULL")
        c.executemany("UPDATE photos SET emb=? WHERE id=?", [(f16(np.asarray(vector)), pid)
                      for pid, vector in enumerate(([1, 0, 0], [.96, .28, 0], [0, 1, 0], [1, 0, 0]), 1)])
    rows = [dict(row) for row in s.store.q("SELECT * FROM photos ORDER BY id")]
    away = {**p, "fit_examples": [{"photo": 1, "direction": "away"}]}
    result = filter_fit.assess(s.store, rows, {}, away, "gallery")
    assert result[1][1] < .5 and result[2][1] < .5 and result[3][1] > .5
    both = {**away, "fit_examples": away["fit_examples"] + [{"photo": 4, "direction": "toward"}]}
    base = filter_fit.assess(s.store, rows, {}, p, "gallery")
    assert filter_fit.assess(s.store, rows, {}, both, "gallery") == base
    duplicate = {**away, "fit_examples": away["fit_examples"] + [{"photo": 4, "direction": "away"}]}
    assert filter_fit.assess(s.store, rows, {}, duplicate, "gallery") == result


def test_opposing_subject_examples_find_the_measured_context_instead_of_cancelling_everywhere(trained):
    s, p = trained([{"luma": value} for value in (60, 200, 64, 196, 62, 198, None)])
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override=NULL")
    subjects(s, {pid: ["u:dogs" if pid not in {5, 6} else "u:cats"] for pid in range(1, 8)})
    from matcher import tags
    sets = tags.effective(s.store)
    rows = [dict(row) for row in s.store.q("SELECT * FROM photos ORDER BY id")]
    before = filter_fit.assess(s.store, rows, sets, p, "gallery")
    draft = {**p, "fit_examples": [{"photo": 1, "direction": "away"}, {"photo": 2, "direction": "toward"}]}
    learned = filter_fit.assess(s.store, rows, sets, draft, "gallery")
    assert all(learned[pid][1] < .5 for pid in (1, 3))
    assert all(learned[pid][1] > before[pid][1] for pid in (2, 4))
    assert all(learned[pid] == before[pid] for pid in (5, 6, 7)), "Other subjects and unknown light cannot inherit this preference"
    assert p["min_luma"] == draft["min_luma"] and p["max_luma"] == draft["max_luma"]


def test_contrasting_measurements_are_used_together_without_choosing_an_arbitrary_angle(trained):
    s, p = trained([{"luma": light, "sharp": sharp} for light, sharp in ((64, 3), (160, 63), (64, 63), (160, 3))])
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override=NULL")
    subjects(s, {pid: ["u:dogs"] for pid in range(1, 5)})
    from matcher import tags
    sets, rows = tags.effective(s.store), [dict(row) for row in s.store.q("SELECT * FROM photos ORDER BY id")]
    before = filter_fit.assess(s.store, rows, sets, p, "gallery")
    learned = filter_fit.assess(s.store, rows, sets,
                              {**p, "fit_examples": [{"photo": 1, "direction": "away"}, {"photo": 2, "direction": "toward"}]}, "gallery")
    assert learned[1][1] < .5 and learned[2][1] > before[2][1]
    assert learned[3] == before[3] and learned[4] == before[4], "Crossed examples need another choice to separate light from detail"


def test_a_specific_subject_context_can_be_an_exception_to_a_broader_preference(trained):
    s, p = trained([{} for _ in range(5)])
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override=NULL")
    subjects(s, {1: ["u:dogs"], 2: ["u:dogs", "u:beach"], 3: ["u:dogs", "u:beach"],
                 4: ["u:dogs", "u:park"], 5: ["u:cats", "u:beach"]})
    from matcher import tags
    sets, rows = tags.effective(s.store), [dict(row) for row in s.store.q("SELECT * FROM photos ORDER BY id")]
    before = filter_fit.assess(s.store, rows, sets, p, "gallery")
    draft = {**p, "fit_examples": [{"photo": 1, "direction": "toward"}, {"photo": 2, "direction": "away"}]}
    learned = filter_fit.assess(s.store, rows, sets, draft, "gallery")
    assert all(learned[pid][1] < .5 for pid in (2, 3))
    assert all(learned[pid][1] > before[pid][1] for pid in (1, 4))
    assert learned[5] == before[5]


@pytest.mark.parametrize("difference", [0, 1, 8])
def test_indistinguishable_or_tiny_contrasts_do_not_invent_a_scope(trained, difference):
    s, p = trained([{"luma": 120}, {"luma": 120 + difference}, {"luma": 124}])
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override=NULL")
    subjects(s, {pid: ["u:dogs"] for pid in range(1, 4)})
    from matcher import tags
    sets, rows = tags.effective(s.store), [dict(row) for row in s.store.q("SELECT * FROM photos ORDER BY id")]
    before = filter_fit.assess(s.store, rows, sets, p, "gallery")
    learned = filter_fit.assess(s.store, rows, sets,
                              {**p, "fit_examples": [{"photo": 1, "direction": "away"}, {"photo": 2, "direction": "toward"}]}, "gallery")
    assert learned == before


def test_contextual_tuning_keeps_newer_manual_exceptions_and_apply_undo_parity(client):
    s = client.session
    ids = [int(pid) for pid in s.reps[:5]]
    subjects(s, {pid: ["u:dogs"] for pid in ids})
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET luma=? WHERE id=?", list(zip((60, 200, 64, 196, 62), ids)))
        c.execute("UPDATE photos SET override='keep' WHERE id=?", (ids[4],))
    s.refresh_async(); s.wait_refresh()
    before = fetch(client)
    tune(client, ids[0], "away")
    learned = tune(client, ids[1], "toward")["learning"]
    assert not learned["global_ready"]
    assert post(client, "/api/filter/decision", {"photos": [ids[4]], "action": "keep"}).status_code == 200
    preview = post(client, "/api/filter/preview", {"policy": learned["policy"]}).get_json()
    assert set((ids[0], ids[2])) <= set(preview["ids"]["aside"])
    assert set((ids[1], ids[3], ids[4])) <= set(preview["ids"]["kept"])
    assert preview["scores"][str(ids[4])] == 1
    assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 200
    assert fetch(client)["scores"] == preview["scores"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["scores"][str(ids[0])] == 0 and fetch(client)["scores"][str(ids[1])] == 1
    assert post(client, "/api/draw/undo").status_code == 200
    assert post(client, "/api/draw/undo").status_code == 200
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["scores"] == before["scores"]


def test_local_tag_scoring_is_bounded_for_ten_thousand_takes(trained, monkeypatch):
    s, p = trained([{}])
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override=NULL")
        c.executemany("INSERT INTO photos(id,rel,status,width,height,luma,sharp) VALUES(?,?,'analyzed',1400,2000,128,100)",
                      [(i, f"synthetic-{i}.jpg") for i in range(2, 10001)])
        c.execute("INSERT INTO tags(key,label,family) VALUES('dogs','Dogs','what')")
    rows = [dict(row) for row in s.store.q("SELECT * FROM photos")]
    sets = {pid: {"dogs"} if pid <= 5000 else {"cats"} for pid in range(1, 10001)}
    monkeypatch.setattr(filter_fit, "_embeddings", lambda *_: pytest.fail("Semantic tags should not load vectors"))
    calls, original = [], s.store.q
    def query(sql, args=()):
        calls.append(sql)
        return original(sql, args)
    monkeypatch.setattr(s.store, "q", query)
    result = filter_fit.assess(s.store, rows, sets, {**p, "fit_examples": [{"photo": 1, "direction": "away"}]}, "gallery")
    assert sum(score < .5 for _, score in result.values()) == 5000
    assert len(calls) < 6
    # Finding the context is also bounded: no all-photo pair comparisons or extra photo reads.
    for row in rows:
        row["luma"] = 60 if row["id"] % 2 else 200
    with s.store.tx() as c:
        c.execute("UPDATE photos SET luma=CASE WHEN id%2=1 THEN 60 ELSE 200 END")
    calls.clear()
    scoped = {**p, "fit_examples": [{"photo": 1, "direction": "away"}, {"photo": 2, "direction": "toward"}]}
    result = filter_fit.assess(s.store, rows, sets, scoped, "gallery")
    assert sum(score < .5 for _, score in result.values()) == 2500
    assert len(calls) < 6


@pytest.mark.parametrize("value", [{"fit_threshold": -1}, {"fit_threshold": True}, {"fit_threshold": float("nan")},
    {"fit_examples": [{"photo": True, "direction": "away"}]}, {"fit_examples": [{"photo": 1, "direction": []}]},
    {"fit_examples": [{"photo": 1, "direction": "away", "strength": 100}]}, {"fit_examples": [1]}])
def test_invalid_fit_policy_is_read_only(client, value):
    before = fetch(client)
    assert post(client, "/api/filter/preview", {"policy": {**before["policy"], **value}}).status_code == 400
    assert fetch(client)["policy"] == before["policy"]
