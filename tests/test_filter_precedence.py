"""Individual calls remain local; newer confident teaching can propose revisiting an older exception."""
import pytest

from tests.test_filter_fit import subjects
from tests.test_filter_tuning import tune
from tests.test_filtering import client, fetch, post


def choice(client, pid, action):
    response = post(client, "/api/filter/decision", {"photos": [pid], "action": action})
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def preview(client, policy):
    response = post(client, "/api/filter/preview", {"policy": policy})
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def cohort(client):
    s = client.session
    ids = [int(pid) for pid in s.reps[:4]]
    subjects(s, {ids[0]: ["u:dogs", "u:beach"], ids[1]: ["u:dogs", "u:beach"],
                 ids[2]: ["u:dogs"], ids[3]: ["u:cats"]})
    s.refresh_async(); s.wait_refresh()
    return ids


@pytest.mark.parametrize("direction,opposite,side,endpoint", [("away", "keep", "aside", 0), ("toward", "aside", "kept", 1)])
def test_new_teaching_revisits_only_older_confident_opposite_calls_in_preview(client, direction, opposite, side, endpoint):
    s, ids = client.session, cohort(client)
    for pid in ids:
        choice(client, pid, opposite)
    before = fetch(client)
    old_decisions = s.store.get_meta("filter_decisions")
    taught = tune(client, ids[0], direction)
    actual = fetch(client)
    assert actual["scores"][str(ids[0])] == endpoint
    assert all(actual["scores"][str(pid)] == before["scores"][str(pid)] for pid in ids[1:])
    proposal = preview(client, taught["learning"]["policy"])
    assert ids[1] in proposal["ids"][side] and ids[1] in proposal["ids"]["changed"]
    assert all(proposal["scores"][str(pid)] == before["scores"][str(pid)] for pid in ids[2:])
    assert proposal["scores"][str(ids[0])] == endpoint
    assert s.store.one("SELECT override FROM photos WHERE id=?", (ids[1],))[0] == ("keep" if opposite == "keep" else "toss")
    assert post(client, "/api/filter/apply", {"token": proposal["token"]}).status_code == 200
    assert fetch(client)["scores"] == proposal["scores"]
    assert s.store.one("SELECT override FROM photos WHERE id=?", (ids[1],))[0] is None
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["scores"] == actual["scores"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["scores"] == before["scores"]
    assert s.store.get_meta("filter_decisions") == old_decisions
    assert post(client, "/api/draw/redo").status_code == 200
    again = post(client, "/api/filter/learn").get_json()["learning"]["policy"]
    assert again == taught["learning"]["policy"]
    assert preview(client, again)["scores"] == proposal["scores"]


def test_later_individual_exception_survives_old_teaching_and_threshold_until_a_new_lesson(client):
    ids = cohort(client)
    first = tune(client, ids[0], "away")
    choice(client, ids[1], "keep")
    for threshold in (0, .5, 1):
        proposal = preview(client, {**first["learning"]["policy"], "fit_threshold": threshold})
        assert proposal["scores"][str(ids[1])] == 1 and ids[1] in proposal["ids"]["kept"]
    repeated = tune(client, ids[0], "away")
    assert repeated["edited"] and repeated["changed"] == 0
    assert repeated["learning"]["policy"]["fit_examples"][0]["seq"] > first["learning"]["policy"]["fit_examples"][0]["seq"]
    assert ids[1] in preview(client, repeated["learning"]["policy"])["ids"]["aside"]
    assert not tune(client, ids[0], "away")["edited"]


def test_legacy_or_ambiguous_lessons_cannot_release_a_manual_exception(client):
    s, ids = client.session, cohort(client)
    subjects(s, {ids[2]: ["u:dogs", "u:beach"]})
    with s.store.tx() as c:
        # Opposing teaching with identical saved measurements gives no basis for choosing a domain.
        c.execute("UPDATE photos SET width=1600,height=1200,luma=128,sharp=50,chroma=20,saturation=.5,hue=.3 WHERE id IN (?,?,?)", ids[:3])
    s.refresh_async(); s.wait_refresh()
    choice(client, ids[1], "keep")
    policy = fetch(client)["policy"]
    legacy = {**policy, "fit_examples": [{"photo": ids[0], "direction": "away"}]}
    assert preview(client, legacy)["scores"][str(ids[1])] == 1
    tune(client, ids[0], "away")
    result = tune(client, ids[2], "toward")
    assert preview(client, result["learning"]["policy"])["scores"][str(ids[1])] == 1


def test_sweep_calls_use_the_same_time_order_and_released_toss_votes_are_undoable(client):
    s, ids = client.session, cohort(client)
    assert post(client, "/api/sweep", {"photo": ids[1], "keep": False, "wait": True}).status_code == 200
    result = tune(client, ids[0], "toward")
    proposal = preview(client, result["learning"]["policy"])
    assert ids[1] in proposal["ids"]["kept"]
    assert post(client, "/api/filter/apply", {"token": proposal["token"]}).status_code == 200
    assert ids[1] in fetch(client)["ids"]["kept"]
    assert not any(v["kind"] == "sweep" and v["a"] == ids[1] for v in s.store.votes())
    assert post(client, "/api/draw/undo").status_code == 200
    assert ids[1] in fetch(client)["ids"]["aside"]
    assert any(v["kind"] == "sweep" and v["a"] == ids[1] for v in s.store.votes())
    assert post(client, "/api/sweep", {"photo": ids[1], "keep": False, "wait": True}).status_code == 200
    assert preview(client, result["learning"]["policy"])["scores"][str(ids[1])] == 0


@pytest.mark.parametrize("seq", [True, 0, -1, 1.5, 2**53, 10**100])
def test_teaching_sequence_is_bounded_and_validated_without_writes(client, seq):
    data = fetch(client)
    pid = data["ids"]["kept"][0]
    response = post(client, "/api/filter/preview", {"policy": {**data["policy"], "fit_examples": [{"photo": pid, "direction": "away", "seq": seq}]}})
    assert response.status_code == 400
    assert fetch(client)["scores"] == data["scores"]
