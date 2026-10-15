"""Directional calls decide their own take and teach a preview for similar takes, in one undo step."""
from matcher import filtering
from matcher.store import Store
from tests.test_filter_learning import StoredSession, trained
from tests.test_filtering import client, fetch, post


def tune(client, pid, direction, **extra):
    response = post(client, "/api/filter/tune", {"photo": pid, "direction": direction, **extra})
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def preferences(s):
    reviews = s.store.get_meta("filter_reviews")
    s.store.set_meta("filter_preferences", reviews)
    s.store.set_meta("filter_reviews", None)
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override=NULL")


def subjects(s, mapping):
    with s.store.tx() as c:
        c.executemany("INSERT OR IGNORE INTO tags(key,label,emoji,family) VALUES(?,?,'','what')",
                      [(tag, tag) for tag in sorted({tag for values in mapping.values() for tag in values})])
        c.executemany("INSERT INTO photo_tags(photo_id,tag,score) VALUES(?,?,?)",
                      [(pid, tag, .99 if i else .01) for pid, values in mapping.items() for i, tag in enumerate(values)])


def test_tuning_decides_the_source_and_teaches_reversibly_in_one_step(client):
    s, data = client.session, fetch(client)
    pid = data["ids"]["kept"][0]
    original = [tuple(row) for row in s.store.q("SELECT id,cut,override,stack_key,rep_pref FROM photos")]
    previous = post(client, "/api/filter/preview", {"policy": data["policy"]}).get_json()
    first = tune(client, pid, "away")
    assert first["edited"] and first["changed"] == 1
    assert first["learning"]["samples"]["aside"] == 1 and first["learning"]["samples"]["preferences"] == 1
    assert first["learning"]["ready"] and not first["learning"]["global_ready"]
    assert first["learning"]["changes"][0]["key"] == "fit_examples"
    assert fetch(client)["policy"] == data["policy"]
    current = [tuple(row) for row in s.store.q("SELECT id,cut,override,stack_key,rep_pref FROM photos")]
    assert [row for row in current if row[0] != pid] == [row for row in original if row[0] != pid]
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "toss"
    assert post(client, "/api/filter/apply", {"token": previous["token"]}).status_code == 409
    again = tune(client, pid, "away")
    assert not again["edited"] and again["learning"]["revision"] == first["learning"]["revision"]
    changed = tune(client, pid, "toward")
    assert changed["learning"]["samples"]["keep"] == 1 and changed["learning"]["samples"]["aside"] == 0
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "keep"
    assert post(client, "/api/draw/undo").status_code == 200
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "toss"
    assert post(client, "/api/filter/learn").get_json()["learning"]["revision"] == first["learning"]["revision"]
    assert tune(client, pid, "reset")["learning"]["samples"]["preferences"] == 0
    assert post(client, "/api/draw/undo").status_code == 200
    assert post(client, "/api/filter/learn").get_json()["learning"]["revision"] == first["learning"]["revision"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert not post(client, "/api/filter/learn").get_json()["learning"]["ready"]
    assert [tuple(row) for row in s.store.q("SELECT id,cut,override,stack_key,rep_pref FROM photos")] == original


def test_numeric_direction_examples_survive_reopen_without_overrides(trained):
    s, p = trained([{"width": n} for n in (600, 650, 700, 1400, 1500, 1600)])
    preferences(s)
    result = filtering.learning(s, p)
    assert result["ready"] and result["policy"]["min_pixels"] == 750
    assert result["samples"]["preferences"] == 6
    assert not any(row["override"] for row in s.store.q("SELECT override FROM photos"))
    reopened = Store(s.store.path)
    try:
        again = filtering.learning(StoredSession(store=reopened, source=s.source), p)
        assert again == result
    finally:
        reopened.close()


def test_repeated_direction_replaces_a_later_opposite_individual_choice_and_undo_restores_both(client):
    s, pid = client.session, fetch(client)["ids"]["kept"][0]
    first = tune(client, pid, "away")
    post(client, "/api/filter/decision", {"photos": [pid], "action": "keep"})
    preferred = s.store.get_meta("filter_preferences")
    repeated = tune(client, pid, "away")
    assert repeated["edited"] and repeated["changed"] == 1
    assert s.store.get_meta("filter_preferences")[0]["seq"] > preferred[0]["seq"]
    assert fetch(client)["scores"][str(pid)] == 0
    assert not tune(client, pid, "away")["edited"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["scores"][str(pid)] == 1
    assert s.store.get_meta("filter_preferences") == preferred
    assert first["learning"]["policy"]["fit_examples"][0]["seq"] < repeated["learning"]["policy"]["fit_examples"][0]["seq"]


def test_learned_directional_boundary_previews_applies_and_undo_keeps_examples(client):
    s, data = client.session, fetch(client)
    ids = [int(pid) for pid in s.reps[:6]]
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET width=?,height=2000 WHERE id=?", list(zip((600, 650, 700, 1400, 1500, 1600), ids)))
    s.refresh_async(); s.wait_refresh()
    before = {r["id"]: r["cut"] for r in s.store.q("SELECT id,cut FROM photos")}
    for i, pid in enumerate(ids):
        result = tune(client, pid, "away" if i < 3 else "toward")
    learned = result["learning"]
    assert learned["ready"] and learned["policy"]["min_pixels"] == 750
    current = {r["id"]: r["cut"] for r in s.store.q("SELECT id,cut FROM photos")}
    assert all(current[pid] == "tossed" for pid in ids[:3])
    assert all(current[pid] == value for pid, value in before.items() if pid not in ids[:3])
    preview = post(client, "/api/filter/preview", {"policy": learned["policy"]}).get_json()
    assert set(ids[:3]) <= set(preview["ids"]["aside"])
    assert not set(ids) & set(preview["ids"]["changed"])
    assert preview["counts"]["to_aside"] == len(preview["ids"]["changed"])
    assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 200
    assert fetch(client)["policy"]["min_pixels"] == 750
    assert {row["id"]: row["override"] for row in s.store.q("SELECT id,override FROM photos") if row["id"] in ids} == {
        pid: "toss" if i < 3 else "keep" for i, pid in enumerate(ids)}
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["policy"] == data["policy"]
    assert len(s.store.get_meta("filter_preferences")) == 6
    assert post(client, "/api/draw/undo").status_code == 200
    assert len(s.store.get_meta("filter_preferences")) == 5
    assert not post(client, "/api/filter/learn").get_json()["learning"]["global_ready"]


def test_equal_tag_evidence_learns_a_combination_not_one_arbitrary_subject(trained):
    s, p = trained([{} for _ in range(6)])
    preferences(s)
    subjects(s, {1: ["dogs", "park"], 2: ["beaches", "cats"], 3: ["cats", "park"],
                 4: ["dogs", "beaches"], 5: ["beaches", "dogs"], 6: ["dogs", "beaches"]})
    result = filtering.learning(s, p)
    assert result["ready"] and result["policy"]["require_tags"] == ["beaches", "dogs"]
    assert result["policy"]["require_mode"] == "all" and result["policy"]["exclude_tags"] == []
    assert result["changes"][0]["photos"]["corrected"] == [1, 2, 3]
    assert s.store.get_meta("filter_policy") is None
    # Keep/Aside has individual scope, even when those calls could explain a global boundary.
    calls = s.store.get_meta("filter_preferences")
    s.store.set_meta("filter_reviews", calls)
    s.store.set_meta("filter_preferences", None)
    with s.store.tx() as c:
        c.executemany("UPDATE photos SET override=? WHERE id=?", [(r["action"], r["photo"]) for r in calls])
    assert filtering.learning(s, p)["policy"] == p
    assert not filtering.learning(s, p)["ready"]


def test_ambiguous_subject_and_quality_examples_wait_for_contrasting_evidence(trained):
    s, p = trained([{"width": n} for n in (600, 650, 700, 1400, 1500, 1600)])
    preferences(s)
    subjects(s, {pid: ["cats" if pid <= 3 else "dogs"] for pid in range(1, 7)})
    result = filtering.learning(s, p)
    assert result["ready"] and not result["global_ready"]
    assert {**result["policy"], "fit_examples": []} == p
    assert {item["hint"] for item in result["ambiguities"]} >= {"size", "subject"}
    with s.store.tx() as c:
        c.execute("UPDATE photos SET width=1600 WHERE id=1")
        c.execute("UPDATE photos SET width=600 WHERE id=4")
    result = filtering.learning(s, p)
    assert result["ready"] and result["policy"]["require_tags"] == ["dogs"]
    assert result["policy"]["min_pixels"] == p["min_pixels"]


def test_directional_siblings_and_conflicts_do_not_multiply_support(trained):
    s, p = trained([{"width": n, **({"stack_key": "siblings"} if i < 3 else {})}
                    for i, n in enumerate((600, 650, 700, 1400, 1500, 1600))])
    preferences(s)
    result = filtering.learning(s, p)
    assert result["samples"]["aside"] == 1 and not result["global_ready"]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET stack_key='siblings' WHERE id=4")
    result = filtering.learning(s, p)
    assert result["samples"]["conflicted"] == 1 and result["samples"]["aside"] == 0


def test_manual_toss_provenance_still_groups_later_directional_examples(client):
    s = client.session
    siblings = next(group["members"] for group in s.groups.values() if len(group["members"]) >= 3)
    for pid in siblings[:3]:
        assert post(client, "/api/filter/decision", {"photos": [pid], "action": "aside"}).status_code == 200
    for pid in siblings[:3]:
        result = tune(client, pid, "toward")
    assert result["learning"]["samples"]["keep"] == 1 and result["learning"]["samples"]["aside"] == 0
    assert len({r["family"] for r in s.store.get_meta("filter_preferences")}) == 1


def test_tuning_preserves_manual_content_criteria_and_never_applies_policy(trained):
    s, p = trained([{} for _ in range(6)])
    preferences(s)
    subjects(s, {pid: ["cats" if pid <= 3 else "dogs", "beaches"] for pid in range(1, 7)})
    p = {**p, "require_tags": ["beaches"], "require_mode": "any", "exclude_tags": ["documents"]}
    result = filtering.learning(s, p)
    assert result["ready"] and result["policy"]["exclude_tags"] == ["cats", "documents"]
    assert result["policy"]["require_tags"] == ["beaches"] and result["policy"]["require_mode"] == "any"
    assert s.store.get_meta("filter_policy") is None


def test_small_samples_and_multi_subject_exclusions_abstain(trained):
    s, p = trained([{} for _ in range(4)])
    preferences(s)
    subjects(s, {pid: ["cats" if pid <= 2 else "dogs"] for pid in range(1, 5)})
    assert not filtering.learning(s, p)["global_ready"]
    s, p = trained([{} for _ in range(6)])
    preferences(s)
    subjects(s, {1: ["cats", "mountains"], 2: ["mountains", "cats"], 3: ["cats", "mountains"],
                 4: ["dogs"], 5: ["beaches"], 6: ["food"]})
    result = filtering.learning(s, p)
    assert not result["global_ready"], "A joint dislike does not justify excluding either subject independently"
    assert result["policy"]["exclude_tags"] == []


def test_invalid_direction_or_unreadable_example_is_read_only(client):
    s, data = client.session, fetch(client)
    pid = data["ids"]["kept"][0]
    before = [tuple(row) for row in s.store.q("SELECT key,value FROM meta ORDER BY key")]
    for body in ({"photo": pid, "direction": "up"}, {"photo": pid, "direction": []},
                 {"photo": True, "direction": "toward"}, {"direction": "away"},
                 {"photo": pid, "direction": "toward", "policy": {"min_pixels": -1}}):
        assert post(client, "/api/filter/tune", body).status_code == 400
    assert post(client, "/api/filter/tune", {"photo": 999999, "direction": "away"}).status_code == 404
    assert [tuple(row) for row in s.store.q("SELECT key,value FROM meta ORDER BY key")] == before
    with s.store.tx() as c:
        c.execute("UPDATE photos SET status='error' WHERE id=?", (pid,))
    assert post(client, "/api/filter/tune", {"photo": pid, "direction": "toward"}).status_code == 400


def test_tuning_learner_stays_bounded_in_ten_thousand_library(trained, monkeypatch):
    s, p = trained([{"width": 600 + i if i < 128 else 1400 + i} for i in range(256)])
    preferences(s)
    with s.store.tx() as c:
        c.executemany("INSERT INTO photos(id,rel,status,width,height) VALUES(?,?,'analyzed',1200,1600)",
                      [(i, f"unseen-{i}.jpg") for i in range(257, 10001)])
    calls, original = [], s.store.q
    def query(sql, args=()):
        result = original(sql, args)
        calls.append((sql, len(result)))
        return result
    monkeypatch.setattr(s.store, "q", query)
    result = filtering.learning(s, p)
    assert result["ready"] and result["samples"]["preferences"] == 256
    assert max(n for sql, n in calls if "FROM photos" in sql) == 256
    assert len(calls) <= 12  # The local proposal also validates its bounded example IDs.
