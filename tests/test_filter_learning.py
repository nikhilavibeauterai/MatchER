"""Filter learns explainable numeric boundaries from independent, reversible review calls."""
import json
from types import SimpleNamespace

import pytest

from matcher import filtering
from matcher.store import Store
from tests.test_filtering import client, fetch, post


def boundary_learning(s, policy):
    # These algorithm fixtures supply explicit training labels; live Keep/Toss calls are not labels.
    return filtering._boundary_learning(s, policy, examples=s.store.get_meta("filter_reviews", []))


class StoredSession(SimpleNamespace):
    @property
    def settings(self):
        return self.store.get_meta("settings", {"mode": "gallery"})

    @property
    def mode(self):
        return self.settings.get("mode", "gallery")


@pytest.fixture
def trained(tmp_path):
    stores = []
    def make(changes):
        store = Store(tmp_path / f"learning-{len(stores)}.db")
        stores.append(store)
        calls = []
        with store.tx() as c:
            for i, change in enumerate(changes, 1):
                row = {"id": i, "rel": f"synthetic-{i}.jpg", "status": "analyzed", "width": 1400,
                       "height": 2000, "sharp": 100, "luma": 128, "group_id": i,
                       "zs": json.dumps({"scores": {"blurry": .1, "document": .1, "accidental": .1}}),
                       "override": "toss" if i <= len(changes) // 2 else "keep", **change}
                c.execute(f"INSERT INTO photos({','.join(row)}) VALUES({','.join('?' * len(row))})", list(row.values()))
                calls.append({"photo": i, "action": row["override"]})
        store.set_meta("filter_reviews", calls)
        return StoredSession(store=store, source=tmp_path), filtering.defaults({"mode": "gallery"})
    yield make
    for store in stores:
        store.close()


def test_numeric_boundary_uses_raw_rules_and_never_applies_itself(trained):
    s, p = trained([{"width": n} for n in (600, 650, 700, 1400, 1500, 1600)])
    result = boundary_learning(s, p)
    assert result["ready"] and len(result["changes"]) == 1
    change = result["changes"][0]
    assert (change["key"], change["before"], change["after"]) == ("min_pixels", 400, 750)
    assert change["evidence"] == {"keep": 3, "aside": 3} and change["photos"]["corrected"] == [1, 2, 3]
    assert result["policy"]["min_pixels"] == 750 and p["min_pixels"] == 400
    assert s.store.get_meta("filter_policy") is None
    assert [r["override"] for r in s.store.q("SELECT override FROM photos ORDER BY id")] == ["toss"] * 3 + ["keep"] * 3
    # A draft already stricter than the saved defaults learns a relaxation against that exact draft.
    relaxed = boundary_learning(s, {**p, "min_pixels": 2000})
    assert relaxed["changes"][0]["before"] == 2000 and relaxed["changes"][0]["after"] == 1400
    assert relaxed["revision"] == result["revision"]


@pytest.mark.parametrize("field,rule", [("luma", "min_luma"), ("sharp", "blur_sharpness")])
def test_measured_zero_is_evidence_and_compound_blur_gate_is_respected(trained, field, rule):
    rows = [{field: n, "zs": json.dumps({"scores": {"blurry": .95}})} for n in (0, 2, 3, 80, 90, 100)]
    s, p = trained(rows)
    p = {**p, rule: 0, "accidental": False}
    result = boundary_learning(s, p)
    assert result["changes"][0]["key"] == rule and result["changes"][0]["after"] == 4
    if field == "sharp":
        with s.store.tx() as c:
            c.execute("UPDATE photos SET zs=?", (json.dumps({"scores": {"blurry": .1}}),))
        assert not boundary_learning(s, p)["ready"]


def test_upper_numeric_score_learns_without_toggling_scene_rules(trained):
    s, p = trained([{"zs": json.dumps({"scores": {"document": n}})} for n in (.97, .96, .95, .1, .2, .3)])
    result = boundary_learning(s, {**p, "document_confidence": 1})
    change = result["changes"][0]
    assert change["key"] == "document_confidence" and change["after"] == .94
    assert result["policy"]["document"] is True
    assert not boundary_learning(s, {**p, "document": False})["ready"]


def test_profile_learning_uses_face_measurements_without_changing_identity_rules(trained):
    s, _ = trained([{"zs": json.dumps({"faces": True, "has_you": True, "large_face": True,
                        "face": {"h": height, "px": 200, "sharp": 100, "luma": 128}})}
                    for height in (.02, .025, .03, .20, .22, .23)])
    s.store.set_meta("settings", {"mode": "me"})
    p = filtering.defaults(s.settings)
    result = boundary_learning(s, p)
    assert result["changes"][0]["key"] == "min_face_fraction"
    assert result["changes"][0]["after"] == .035
    assert result["policy"]["require_face"] and result["policy"]["require_you"]


def test_small_conflicting_and_missing_samples_abstain(trained):
    for widths in ((600, 650, 1400, 1500), (600, 1600, 700, 800, 900, 1000), (0, 650, 700, 1400, 1500, 1600)):
        s, p = trained([{"width": n} for n in widths])
        assert not boundary_learning(s, p)["ready"]
    s, p = trained([{"luma": None, "sharp": None} for _ in range(6)])
    assert not boundary_learning(s, p)["ready"]


def test_stack_duplicates_and_conflicting_take_labels_do_not_multiply_support(trained):
    s, p = trained([{"width": n, **({"group_id": 1} if i < 3 else {})}
                    for i, n in enumerate((600, 650, 700, 1400, 1500, 1600))])
    result = boundary_learning(s, p)
    assert result["samples"]["aside"] == 1 and result["needed"]["aside"] == 2 and not result["ready"]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET group_id=1 WHERE id=4")
    result = boundary_learning(s, p)
    assert result["samples"]["conflicted"] == 1 and result["samples"]["aside"] == 0


@pytest.mark.parametrize("field,value", [("stack_key", "merged-takes"), ("group_id", 91)])
def test_later_stack_merges_unify_persisted_review_families(trained, field, value):
    s, p = trained([{"width": n} for n in (600, 650, 700, 1400, 1500, 1600)])
    photos = [dict(r) for r in s.store.q("SELECT id,stack_key,group_id FROM photos")]
    s.store.set_meta("filter_reviews", filtering.reviewed([], {i: "toss" if i < 4 else "keep" for i in range(1, 7)}, photos))
    assert boundary_learning(s, p)["samples"]["aside"] == 3
    with s.store.tx() as c:
        c.execute(f"UPDATE photos SET {field}=? WHERE id IN (1,2)", (value,))
    merged = boundary_learning(s, p)
    assert merged["samples"]["aside"] == 2 and not merged["ready"]
    with s.store.tx() as c:
        c.execute(f"UPDATE photos SET {field}=? WHERE id=4", (value,))
    conflict = boundary_learning(s, p)
    assert conflict["samples"]["conflicted"] == 1 and conflict["samples"]["aside"] == 1
    assert conflict["samples"]["keep"] == 2 and not conflict["ready"]


def test_explicit_subject_rules_survive_numeric_learning(trained):
    s, p = trained([{"width": n} for n in (600, 650, 700, 1400, 1500, 1600)])
    with s.store.tx() as c:
        c.executemany("INSERT INTO photo_tags(photo_id,tag,score) VALUES(?,'dogs',1)", [(i,) for i in range(1, 7)])
    p = {**p, "require_tags": ["dogs"], "require_mode": "any", "exclude_tags": ["documents"]}
    result = boundary_learning(s, p)
    assert result["ready"]
    assert {k: result["policy"][k] for k in ("require_tags", "require_mode", "exclude_tags")} == {k: p[k] for k in ("require_tags", "require_mode", "exclude_tags")}


def test_same_override_records_once_without_teaching_and_shared_undo_restores_it(client):
    s, data = client.session, fetch(client)
    pid = data["ids"]["kept"][0]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override='keep' WHERE id=?", (pid,))
    s.refresh_async(); s.wait_refresh()
    preview = post(client, "/api/filter/preview", {"policy": data["policy"]}).get_json()
    first = post(client, "/api/filter/decision", {"photos": [pid], "action": "keep", "policy": data["policy"]}).get_json()
    assert first["learning"]["samples"]["keep"] == 0 and not first["learning"]["ready"]
    assert len(s.store.get_meta("filter_reviews")) == 1
    history = s.store.get_meta("group_history")
    again = post(client, "/api/filter/decision", {"photos": [pid], "action": "keep"}).get_json()
    assert again["learning"]["revision"] == first["learning"]["revision"] and s.store.get_meta("group_history") == history
    assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 409
    assert post(client, "/api/draw/undo").status_code == 200
    result = post(client, "/api/filter/learn", {"policy": data["policy"]}).get_json()["learning"]
    assert result["samples"]["reviewed"] == 0
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "keep"


def test_relabel_reset_and_undo_change_only_the_individual_decision(client):
    pid = fetch(client)["ids"]["kept"][0]
    first = post(client, "/api/filter/decision", {"photos": [pid], "action": "keep"}).get_json()["learning"]
    aside = post(client, "/api/filter/decision", {"photos": [pid], "action": "aside"}).get_json()["learning"]
    assert aside["samples"]["reviewed"] == 0 and aside["policy"] == first["policy"]
    assert client.session.store.get_meta("filter_reviews")[0]["action"] == "toss"
    assert post(client, "/api/draw/undo").status_code == 200
    restored = post(client, "/api/filter/learn", {}).get_json()["learning"]
    assert restored["revision"] == first["revision"]
    reset = post(client, "/api/filter/decision", {"photos": [pid], "action": "reset"}).get_json()["learning"]
    assert reset["samples"]["reviewed"] == 0
    assert post(client, "/api/draw/undo").status_code == 200
    assert post(client, "/api/filter/learn", {}).get_json()["learning"]["revision"] == first["revision"]


def test_aside_calls_preserve_auto_stack_family_across_real_refreshes(client):
    s = client.session
    members = next(group["members"] for group in s.groups.values() if len(group["members"]) >= 3)
    assert all(s.store.one("SELECT stack_key FROM photos WHERE id=?", (pid,))["stack_key"] is None for pid in members)
    for pid in members[:3]:
        response = post(client, "/api/filter/decision", {"photos": [pid], "action": "aside"})
        assert response.status_code == 200, response.get_json()
        learned = response.get_json()["learning"]
        assert learned["samples"]["aside"] == 0 and not learned["ready"]
    assert len({r["family"] for r in s.store.get_meta("filter_reviews")}) == 1
    assert sum("members" in r for r in s.store.get_meta("filter_reviews")) == 1


def test_explicit_tuning_returns_a_proposal_against_the_submitted_draft(client):
    s, data = client.session, fetch(client)
    ids = [int(pid) for pid in s.reps[:6]]
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET width=?,height=2000 WHERE id=?", list(zip((600, 650, 700, 1400, 1500, 1600), ids)))
    s.refresh_async(); s.wait_refresh()
    draft = {**data["policy"], "min_pixels": 2000}
    for i, pid in enumerate(ids):
        response = post(client, "/api/filter/tune", {"photo": pid, "direction": "away" if i < 3 else "toward", "policy": draft})
        assert response.status_code == 200, response.get_json()
    learning = response.get_json()["learning"]
    assert learning["ready"] and learning["changes"][0]["before"] == 2000
    assert learning["changes"][0]["after"] == 1400
    assert fetch(client)["policy"]["min_pixels"] == 400
    assert post(client, "/api/filter/learn", {"policy": draft}).get_json()["learning"] == learning


def test_learning_is_read_only_and_unrelated_votes_do_not_teach(client, monkeypatch):
    s, data = client.session, fetch(client)
    ids = data["ids"]["kept"]
    s.store.add_vote("duel", ids[0], ids[1], ids[0], 50)
    s.store.add_vote("sweep", ids[0], None, None, 50, extra={"keep": True, "change": None})
    before = [tuple(r) for r in s.store.q("SELECT key,value FROM meta ORDER BY key")]
    monkeypatch.setattr(s, "progress", lambda: pytest.fail("A read-only learner wrote achievements"))
    monkeypatch.setattr(s, "ensure_ranker", lambda *a, **kw: pytest.fail("A read-only learner ran the ranker"))
    result = post(client, "/api/filter/learn", {"policy": data["policy"]})
    assert result.status_code == 200 and result.get_json()["learning"]["samples"]["reviewed"] == 0
    assert [tuple(r) for r in s.store.q("SELECT key,value FROM meta ORDER BY key")] == before


def test_learning_queries_only_bounded_training_rows_in_a_ten_thousand_library(trained, monkeypatch):
    s, p = trained([{"width": 600 + i * 2 if i < 128 else 1400 + i, "zs": json.dumps({"scores": {f"metric-{j}": .1 for j in range(48)}})} for i in range(256)])
    with s.store.tx() as c:
        c.executemany("INSERT INTO photos(id,rel,status,width,height) VALUES(?,?,'analyzed',1200,1600)", [(i, f"unreviewed-{i}.jpg") for i in range(257, 10001)])
        c.executemany("INSERT INTO photo_tags(photo_id,tag,score) VALUES(?,?,.9)", [(i, f"subject:{j}") for i in range(1, 10001) for j in range(12)])
    calls, original = [], s.store.q
    def query(sql, args=()):
        result = original(sql, args)
        calls.append((sql, len(result)))
        return result
    monkeypatch.setattr(s.store, "q", query)
    result = boundary_learning(s, p)
    assert result["ready"] and result["samples"]["reviewed"] == 256
    assert len(calls) < 12
    assert max(n for sql, n in calls if "FROM photos" in sql) == 256
    assert max(n for sql, n in calls if "FROM photo_tags" in sql) == 256 * 12
    photos = [{"id": i, "stack_key": None, "group_id": i} for i in range(1, 10001)]
    bounded = filtering.reviewed([], {i: "keep" for i in range(1, 10001)}, photos)
    assert len(bounded) == filtering.LEARNING_LIMIT and bounded[-1]["photo"] == 10000
    calls.clear()
    round_ = filtering.review(s, {"policy": p, "limit": 12})
    assert len(round_["ids"]) == 12 and len(set(round_["ids"])) == 12
    assert len(calls) < 20, "Review must use bulk evidence, never a query per take"


@pytest.mark.parametrize("reason", ["subject", "exception", "light", "blur", "age"])
def test_intent_does_not_train_an_unrelated_size_rule(trained, reason):
    s, p = trained([{"width": n} for n in (600, 650, 700, 1400, 1500, 1600)])
    s.store.set_meta("filter_reviews", [{**r, "reason": reason} for r in s.store.get_meta("filter_reviews")])
    result = boundary_learning(s, p)
    assert not result["ready"] and result["changes"] == []
    if reason in {"subject", "exception"}:
        assert result["samples"]["personal"] == 6


def test_subject_confounding_needs_repeated_matching_intent(trained):
    s, p = trained([{"width": n} for n in (600, 650, 700, 1400, 1500, 1600)])
    with s.store.tx() as c:
        c.executemany("INSERT INTO photo_tags(photo_id,tag,score) VALUES(?,?,1)",
                      [(i, "dogs" if i <= 3 else "beaches") for i in range(1, 7)])
    result = boundary_learning(s, p)
    assert not result["ready"] and result["policy"] == p
    ambiguous = next(a for a in result["ambiguities"] if a["key"] == "min_pixels")
    assert ambiguous["hint"] == "size" and set(ambiguous["tags"]) == {"dogs", "beaches"}
    assert result["reason_hints"][1] == ["size", "subject", "exception"]
    reviews = s.store.get_meta("filter_reviews")
    reviews[0]["reason"] = "size"
    s.store.set_meta("filter_reviews", reviews)
    assert not boundary_learning(s, p)["ready"], "One reason must not generalize to unrelated calls"
    for record in reviews[:3]:
        record["reason"] = "size"
    s.store.set_meta("filter_reviews", reviews)
    learned = boundary_learning(s, p)
    change = learned["changes"][0]
    assert learned["ready"] and change["key"] == "min_pixels" and change["after"] == 750
    assert change["summary"] == "Favor larger photos."
    assert change["boundary"]["aside"][0] == {"photo": 3, "value": 700}
    assert change["boundary"]["keep"][0] == {"photo": 4, "value": 1400}
    assert change["boundary"]["unit"] == "px"
    assert p["exclude_tags"] == learned["policy"]["exclude_tags"] == []


def test_measured_quality_and_disposition_tags_are_not_subject_confounders(trained):
    s, p = trained([{"luma": n} for n in (0, 2, 3, 80, 90, 100)])
    with s.store.tx() as c:
        c.executemany("INSERT INTO photo_tags(photo_id,tag,score) VALUES(?,?,1)",
                      [(i, tag) for i in range(1, 4) for tag in ("dark", "x:cut")])
    result = boundary_learning(s, {**p, "min_luma": 0, "accidental": False})
    assert result["ready"] and result["changes"][0]["key"] == "min_luma"


def test_equally_predictive_size_and_light_wait_for_intent(trained):
    s, p = trained([{"width": width, "luma": light} for width, light in
                    zip((600, 650, 700, 1400, 1500, 1600), (30, 32, 34, 100, 110, 120))])
    result = boundary_learning(s, p)
    assert not result["ready"] and result["policy"] == p
    assert {a["key"] for a in result["ambiguities"]} == {"min_pixels", "min_luma"}
    assert set(result["reason_hints"][1]) == {"light", "size", "exception"}
    calls = s.store.get_meta("filter_reviews")
    for call in calls[:3]:
        call["reason"] = "light"
    s.store.set_meta("filter_reviews", calls)
    clarified = boundary_learning(s, p)
    assert clarified["ready"] and clarified["changes"][0]["key"] == "min_luma"
    assert clarified["policy"]["min_pixels"] == p["min_pixels"]


def test_reason_only_edits_are_deduplicated_and_undo_restores_exact_intent(client):
    s, data = client.session, fetch(client)
    pid = data["ids"]["kept"][0]
    first = post(client, "/api/filter/decision", {"photos": [pid], "action": "keep", "reason": "exception"}).get_json()
    assert first["edited"] and not first["learning"]["ready"]
    assert s.store.get_meta("filter_reviews")[0]["reason"] == "exception"
    again = post(client, "/api/filter/decision", {"photos": [pid], "action": "keep"}).get_json()
    assert not again["edited"] and again["learning"]["revision"] == first["learning"]["revision"]
    edited = post(client, "/api/filter/decision", {"photos": [pid], "action": "keep", "reason": "light"}).get_json()
    assert edited["edited"] and edited["changed"] == 0
    row = client.get(f"/api/filter?photo={pid}").get_json()["photos"][0]
    assert row["teaching_reason"] == "light"
    assert post(client, "/api/draw/undo").status_code == 200
    restored = post(client, "/api/filter/learn").get_json()["learning"]
    assert restored["revision"] == first["learning"]["revision"]
    assert client.get(f"/api/filter?photo={pid}").get_json()["photos"][0]["teaching_reason"] == "exception"
    cleared = post(client, "/api/filter/decision", {"photos": [pid], "action": "keep", "reason": None}).get_json()
    assert cleared["edited"] and cleared["learning"]["samples"]["keep"] == 0
    post(client, "/api/filter/decision", {"photos": [pid], "action": "keep", "reason": "size"})
    post(client, "/api/filter/decision", {"photos": [pid], "action": "aside"})
    assert client.get(f"/api/filter?photo={pid}").get_json()["photos"][0]["teaching_reason"] is None


def test_invalid_reason_never_changes_a_call(client):
    s, data = client.session, fetch(client)
    before = [tuple(r) for r in s.store.q("SELECT key,value FROM meta ORDER BY key")]
    for reason in ("sharpness", {}, ["blur"], True, 2):
        assert post(client, "/api/filter/decision", {"photos": [data["ids"]["kept"][0]], "action": "aside", "reason": reason}).status_code == 400
    assert [tuple(r) for r in s.store.q("SELECT key,value FROM meta ORDER BY key")] == before


def test_review_uses_the_draft_and_preview_without_writing_or_ranker_work(client, monkeypatch):
    s, data = client.session, fetch(client)
    draft = {**data["policy"], "min_pixels": 3000}
    preview = post(client, "/api/filter/preview", {"policy": draft}).get_json()
    before = [tuple(r) for r in s.store.q("SELECT key,value FROM meta ORDER BY key")]
    version = s.store.get_meta("state_version")
    monkeypatch.setattr(s, "progress", lambda: pytest.fail("Read-only review awarded achievements"))
    monkeypatch.setattr(s, "ensure_ranker", lambda *a, **kw: pytest.fail("Read-only review ran the ranker"))
    params = {"scope": "changed", "limit": 4}
    direct = post(client, "/api/filter/review", {**params, "policy": draft}).get_json()
    cached = post(client, "/api/filter/review", {**params, "token": preview["token"]}).get_json()
    assert direct == cached and len(direct["ids"]) == 4 and direct["policy"] == draft
    assert set(direct["ids"]) <= set(preview["ids"]["changed"])
    assert set(direct["why"]) == set(map(str, direct["ids"]))
    later = post(client, "/api/filter/review", {"policy": draft, "seen": direct["ids"][:2], "deferred": direct["ids"][2:], "limit": 4}).get_json()
    assert set(later["ids"]).isdisjoint(direct["ids"][:2])
    assert set(direct["ids"][2:]) <= set(later["ids"])
    assert [tuple(r) for r in s.store.q("SELECT key,value FROM meta ORDER BY key")] == before
    assert s.filter_preview["token"] == preview["token"] and s.store.get_meta("state_version") == version


def test_review_validates_bounded_inputs_and_rejects_stale_preview(client):
    data = fetch(client)
    for invalid in ({"seen": [True]}, {"deferred": [0]}, {"seen": [1] * 50001}, {"limit": 13}, {"limit": True},
                    {"scope": []}, {"scope": "other"}, {"token": "old", "policy": data["policy"]}, {"policy": {"min_pixels": -1}}):
        assert post(client, "/api/filter/review", invalid).status_code == 400
    preview = post(client, "/api/filter/preview", {"policy": data["policy"]}).get_json()
    post(client, "/api/filter/decision", {"photos": data["ids"]["kept"][:1], "action": "keep", "reason": "size"})
    assert post(client, "/api/filter/review", {"token": preview["token"]}).status_code == 409


def test_review_family_survives_tossed_siblings_and_later_merges():
    rows = [{"id": i, "group_id": -i, "stack_key": None} for i in range(1, 7)]
    rows[3]["stack_key"] = rows[4]["stack_key"] = "joined"
    old = [{"photo": 1, "action": "toss", "family": "p:1", "members": [1, 2, 3]},
           {"photo": 3, "action": "toss", "family": "p:1"},
           {"photo": 4, "action": "keep", "family": "p:4", "members": [4, 6]}]
    families = filtering.review_families(rows, old)
    assert families[1] == families[2] == families[3]
    assert families[4] == families[5] == families[6]
    assert families[1] != families[4]
