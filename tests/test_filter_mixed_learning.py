"""A new lesson can revise copied examples without rewriting an unrelated subject's history."""
import numpy as np
import pytest

from matcher import library
from matcher.store import f16
from tests.test_filter_fit import subjects
from tests.test_filter_precedence import choice, preview
from tests.test_filter_tuning import tune
from tests.test_filtering import client, fetch, post


def copies(client, tagged=True):
    s = client.session
    ids = list(map(int, s.reps[:5]))
    subjects(s, {pid: ["u:dogs", "u:beach"] if tagged else [] for pid in ids})
    with s.store.tx() as c:
        # Four identical visual copies and one different picture with the same tags and measurements.
        c.execute("UPDATE photos SET width=1600,height=1200,luma=128,luma_lo=20,luma_hi=230,"
                  "sharp=50,chroma=20,saturation=.5,hue=.3 WHERE id IN (?,?,?,?,?)", ids)
        vectors = np.eye(2, 768, dtype=np.float32)
        c.executemany("UPDATE photos SET emb=? WHERE id=?", [
            (f16(vectors[0 if pid in ids[:4] else 1]), pid) for pid in ids])
    s.refresh_async(); s.wait_refresh()
    return ids


@pytest.mark.parametrize("tagged", [True, False])
@pytest.mark.parametrize("direction,opposite,endpoint", [("toward", "away", 1), ("away", "toward", 0)])
def test_latest_copy_lesson_resolves_mixed_history_only_in_its_visual_neighbourhood(client, tagged, direction, opposite, endpoint):
    ids = copies(client, tagged)
    source, earlier, pinned, untouched, different = ids
    choice(client, pinned, "aside" if endpoint else "keep")
    baseline = fetch(client)
    assert baseline["teaching_revision"] == 2
    first = tune(client, source, direction)
    tune(client, earlier, opposite)
    latest = tune(client, source, direction)
    assert latest["edited"]
    assert next(e for e in latest["learning"]["policy"]["fit_examples"] if e["photo"] == source)["seq"] > first["learning"]["policy"]["fit_examples"][0]["seq"]
    actual = fetch(client)
    proposal = preview(client, latest["learning"]["policy"])
    side = "kept" if endpoint else "aside"
    assert actual["scores"][str(source)] == endpoint
    assert actual["scores"][str(pinned)] == 1 - endpoint
    assert set(ids[:4]) <= set(proposal["ids"][side])
    assert pinned in proposal["ids"]["changed"] and earlier in proposal["ids"]["changed"]
    assert proposal["scores"][str(different)] == baseline["scores"][str(different)], "Equal tags and measurements alone are not copy identity"
    assert post(client, "/api/filter/apply", {"token": proposal["token"]}).status_code == 200
    assert fetch(client)["scores"] == proposal["scores"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["scores"] == actual["scores"]
    assert post(client, "/api/draw/undo").status_code == 200
    undone = post(client, "/api/filter/learn").get_json()["learning"]["policy"]
    assert untouched in preview(client, undone)["ids"]["aside" if endpoint else "kept"]
    assert post(client, "/api/draw/redo").status_code == 200
    restored = post(client, "/api/filter/learn").get_json()["learning"]["policy"]
    assert restored == latest["learning"]["policy"]
    assert preview(client, restored)["scores"] == proposal["scores"]
    # A later local exception remains local and protected until the player gives a new lesson.
    choice(client, pinned, "aside" if endpoint else "keep")
    for threshold in (0, .5, 1):
        assert preview(client, {**restored, "fit_threshold": threshold})["scores"][str(pinned)] == 1 - endpoint
    repeated = tune(client, source, direction)
    assert pinned in preview(client, repeated["learning"]["policy"])["ids"][side]


@pytest.mark.parametrize("tagged", [True, False])
@pytest.mark.parametrize("legacy_store", ["filter_policy", "filter_preferences"])
def test_new_copy_lesson_supersedes_unsequenced_legacy_opposition(client, tagged, legacy_store):
    ids = copies(client, tagged)
    source, earlier, pinned = ids[:3]
    choice(client, pinned, "aside")
    s = client.session
    if legacy_store == "filter_policy":
        old = {**fetch(client)["policy"], "fit_examples": [{"photo": earlier, "direction": "away"}]}
        staged = preview(client, old)
        assert post(client, "/api/filter/apply", {"token": staged["token"]}).status_code == 200
    else:
        s.store.set_meta("filter_preferences", [{"photo": earlier, "action": "toss"}])
    result = tune(client, source, "toward")
    assert any(item["photo"] == earlier and "seq" not in item for item in result["learning"]["policy"]["fit_examples"])
    proposal = preview(client, result["learning"]["policy"])
    assert set(ids[:4]) <= set(proposal["ids"]["kept"])
    assert proposal["scores"][str(pinned)] > .5
    assert fetch(client)["scores"][str(pinned)] == 0


def test_loading_old_derived_admission_reconciles_applied_mixed_lessons(client, monkeypatch):
    ids, s = copies(client), client.session
    policy = {**fetch(client)["policy"], "fit_examples": [
        {"photo": ids[0], "direction": "away", "seq": 1},
        {"photo": ids[1], "direction": "toward", "seq": 2}]}
    s.store.set_meta("filter_policy", policy)
    s.store.set_meta("derived_version", 10)
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET cut='filter',override=NULL WHERE id=?", [(pid,) for pid in ids[:4]])
    refreshed, refresh = [], library.refresh
    def capture(*args, **kwargs):
        refreshed.append(True)
        return refresh(*args, **kwargs)
    monkeypatch.setattr(library, "refresh", capture)
    s.ensure_ranker(wait=True)
    assert refreshed == [True]
    assert s.store.get_meta("derived_version") == library.DERIVED_VERSION
    assert all(s.store.one("SELECT cut FROM photos WHERE id=?", (pid,))["cut"] is None for pid in ids[:4])
    data = fetch(client)
    assert all(data["scores"][str(pid)] > .5 for pid in ids[:4])
