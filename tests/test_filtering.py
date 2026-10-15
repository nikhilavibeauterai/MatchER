"""Filter previews and edits operate only on synthetic analysis and throwaway libraries."""
import json
import time
from types import SimpleNamespace

import numpy as np
import pytest

from matcher import filtering, game, library, tags
from matcher.server import _slug, create_app
from matcher.store import Store
from tests.conftest import build_library


def post(client, path, value=None):
    return client.post(path, json=value or {}, headers={"X-MatchER": "1"})


@pytest.fixture
def client(tmp_path, fake_prompts, monkeypatch):
    source, data = tmp_path / "photos", tmp_path / "data"
    store, _ = build_library(source, data / _slug(source.resolve()), n_singles=8, bursts=((3, "burst"),))
    store.set_meta("settings", {"mode": "gallery"})
    monkeypatch.setattr(library, "zero_shot", lambda lib: {k: np.full(len(lib.photos), .1) for k in library.ATTRS})
    library.refresh(store)
    store.set_meta("analyzed_at", time.time())
    app = create_app(data, allowed_hosts={"localhost"})
    app.config["MATCHER"].open(source, start=False)
    result = app.test_client()
    result.session = app.config["MATCHER"].session
    result.get("/api/journey")
    yield result
    result.session.shutdown()
    store.close()


def fetch(client):
    response = client.get("/api/filter?per=200")
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def apply(client, policy, **extra):
    preview = post(client, "/api/filter/preview", {"policy": policy})
    assert preview.status_code == 200, preview.get_json()
    response = post(client, "/api/filter/apply", {"token": preview.get_json()["token"], **extra})
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def test_defaults_preserve_existing_cuts_and_every_take_is_recoverable(client):
    data, s = fetch(client), client.session
    actual = {r["id"]: r["cut"] for r in s.store.q("SELECT id,cut FROM photos WHERE status IN ('analyzed','error')")}
    assert {p["id"]: p["cut"] for p in data["photos"]} == actual
    assert set(data["ids"]["kept"] + data["ids"]["aside"]) == set(actual)
    assert data["scope"] == "library" and not data["stage"]["done"]
    assert client.get("/api/journey").get_json()["order"][0] == "filter"
    one = client.get(f"/api/filter?photo={next(iter(actual))}").get_json()
    assert len(one["photos"]) == 1
    assert data["counts"]["total"] > len(s.groups)


def test_preview_is_read_only_and_apply_and_undo_restore_policy(client, monkeypatch):
    data, s = fetch(client), client.session
    before = [tuple(r) for r in s.store.q("SELECT id,cut,override,stack_key,rep_pref,theme_id FROM photos")]
    version, votes = s.version, s.store.vote_revision
    xp = s.progress()["game"]["xp"]
    draft = {**data["policy"], "min_pixels": 3000}
    with monkeypatch.context() as m:
        m.setattr(library, "zero_shot", lambda *_: pytest.fail("Preview ran a model"))
        m.setattr(library, "refresh", lambda *_: pytest.fail("Preview refreshed"))
        preview = post(client, "/api/filter/preview", {"policy": draft, "per": 3}).get_json()
        assert preview["counts"]["to_aside"] > 0 and len(preview["photos"]) == 3
        assert client.get(f"/api/filter/preview?token={preview['token']}&page=1&per=3").status_code == 200
    assert [tuple(r) for r in s.store.q("SELECT id,cut,override,stack_key,rep_pref,theme_id FROM photos")] == before
    assert (s.version, s.store.vote_revision, s.progress()["game"]["xp"]) == (version, votes, xp)
    assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 200
    assert fetch(client)["counts"]["kept"] == 0
    assert s.store.vote_revision == votes
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["policy"] == data["policy"]
    assert [tuple(r) for r in s.store.q("SELECT id,cut,override,stack_key,rep_pref,theme_id FROM photos")] == before


def test_relaxing_rules_restores_only_policy_cuts_and_respects_explicit_choices(client):
    data = fetch(client)
    kept = data["ids"]["kept"][:2]
    assert post(client, "/api/filter/decision", {"photos": [kept[0]], "action": "keep"}).status_code == 200
    assert post(client, "/api/filter/decision", {"photos": [kept[1]], "action": "aside"}).status_code == 200
    apply(client, {**data["policy"], "min_pixels": 3000})
    strict = fetch(client)
    assert strict["ids"]["kept"] == [kept[0]]
    assert kept[0] in strict["ids"]["failing"]  # The manual Keep does not pretend it passed the numeric rules.
    apply(client, data["policy"])
    relaxed = fetch(client)
    assert set(relaxed["ids"]["kept"]) == set(data["ids"]["kept"]) - {kept[1]}
    assert post(client, "/api/filter/decision", {"photos": [kept[1]], "action": "reset"}).status_code == 200
    assert kept[1] in fetch(client)["ids"]["kept"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert kept[1] in fetch(client)["ids"]["aside"]


def test_unreadable_rows_are_visible_but_cannot_be_made_playable(client):
    s = client.session
    with s.store.tx() as c:
        c.execute("INSERT INTO photos(rel,status,error) VALUES('broken.jpg','error','test read failure')")
    s.refresh_async(); s.wait_refresh()
    data = fetch(client)
    broken = next(p for p in data["photos"] if p["rel"] == "broken.jpg")
    assert not broken["playable"] and broken["cut"] == "unreadable"
    assert data["ids"]["unreadable"] == [broken["id"]]
    assert post(client, "/api/filter/decision", {"photos": [broken["id"]], "action": "keep"}).status_code == 400
    assert post(client, "/api/rescue", {"ids": [broken["id"]], "on": True}).status_code == 400
    assert s.store.one("SELECT override FROM photos WHERE id=?", (broken["id"],))["override"] is None


def test_stale_preview_and_invalid_draft_cannot_partially_apply(client):
    data, s = fetch(client), client.session
    preview = post(client, "/api/filter/preview", {"policy": {**data["policy"], "min_pixels": 3000}}).get_json()
    assert post(client, "/api/filter/decision", {"photos": [data["ids"]["kept"][0]], "action": "keep"}).status_code == 200
    assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 409
    assert s.store.get_meta("filter_policy") is None
    for draft in ({"min_pixels": True}, {"min_pixels": float("inf")}, {"require_tags": ["missing-tag"]}, {"require_tags": [{}]}, {"min_luma": 240, "max_luma": 12}):
        assert post(client, "/api/filter/preview", {"policy": draft}).status_code == 400
    for ids in (None, 1, "1", {}, []):
        assert post(client, "/api/filter/decision", {"photos": ids, "action": "keep"}).status_code == 400
    assert s.store.get_meta("filter_policy") is None


def test_preview_tokens_bind_the_library_source_and_tag_snapshot(client):
    s, data = client.session, fetch(client)
    preview = post(client, "/api/filter/preview", {"policy": data["policy"]}).get_json()
    source = s.source
    try:
        s.source = source.parent / "another-synthetic-library"
        assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 409
    finally:
        s.source = source
    key = tags.new_tag(s.store, "New discovery", None)
    tags.edit(s.store, [data["ids"]["kept"][0]], [key], [])
    assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 409
    assert s.store.get_meta("filter_policy") is None


def test_content_rules_obey_manual_tag_corrections_and_any_all(client):
    s, data = client.session, fetch(client)
    first, second = data["ids"]["kept"][:2]
    dog, beach = tags.new_tag(s.store, "Dogs", "🐕"), tags.new_tag(s.store, "Beach", "🏖️")
    tags.edit(s.store, [first], [dog, beach], [])
    tags.edit(s.store, [second], [dog], [])
    s.draw.tags_changed()
    p = {**data["policy"], "require_tags": [dog, beach], "require_mode": "all"}
    apply(client, p)
    assert fetch(client)["ids"]["kept"] == [first]
    apply(client, {**p, "require_mode": "any"})
    assert set(fetch(client)["ids"]["kept"]) == {first, second}
    apply(client, {**p, "require_mode": "any", "exclude_tags": [beach]})
    assert fetch(client)["ids"]["kept"] == [second]
    assert post(client, "/api/tags/set", {"photos": [first], "on": [], "off": [beach]}).status_code == 200
    assert set(fetch(client)["ids"]["kept"]) == {first, second}


def test_saved_content_rule_follows_merged_tags_and_deleted_keys(client):
    s, data = client.session, fetch(client)
    old, new = tags.new_tag(s.store, "Old name", None), tags.new_tag(s.store, "New name", None)
    pid = data["ids"]["kept"][0]
    tags.edit(s.store, [pid], [old], [])
    apply(client, {**data["policy"], "require_tags": [old]})
    assert post(client, "/api/tags/merge", {"source": old, "key": new}).status_code == 200
    current = fetch(client)
    assert current["policy"]["require_tags"] == [new] and current["ids"]["kept"] == [pid]
    assert post(client, "/api/filter/preview", {"policy": current["policy"]}).status_code == 200
    assert post(client, "/api/tags/delete", {"source": new}).status_code == 200
    assert fetch(client)["policy"]["require_tags"] == []
    assert set(fetch(client)["ids"]["kept"]) == set(data["ids"]["kept"])
    assert s.store.one("SELECT COUNT(*) AS n FROM photos WHERE cut='required_tags'")["n"] == 0


def test_failed_apply_restores_policy_decisions_and_current_brackets(client, monkeypatch):
    s, data = client.session, fetch(client)
    previous = {r["id"]: r["cut"] for r in s.store.q("SELECT id,cut FROM photos")}
    final = {"id": "synthetic-final", "seeds": data["ids"]["kept"][:4], "matches": []}
    s.store.set_meta("finals:all", final)
    preview = post(client, "/api/filter/preview", {"policy": {**data["policy"], "min_pixels": 3000}}).get_json()
    original, called = library.refresh, []
    def refresh(store):
        called.append(True)
        if len(called) == 1:
            raise ValueError("Synthetic refresh failure")
        return original(store)
    monkeypatch.setattr(library, "refresh", refresh)
    assert post(client, "/api/filter/apply", {"token": preview["token"]}).status_code == 400
    assert s.store.get_meta("filter_policy") is None and s.draw.last_step() is None
    assert {r["id"]: r["cut"] for r in s.store.q("SELECT id,cut FROM photos")} == previous
    assert s.store.get_meta("finals:all") == final


def test_undo_filter_rescue_does_not_revive_old_teaching_after_a_new_manual_toss(client):
    s, data = client.session, fetch(client)
    pid = data["ids"]["kept"][0]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override='toss' WHERE id=?", (pid,))
    first = s.store.add_vote("toss", pid, None, None, None, extra={"members": [pid]})
    s.refresh_async(); s.wait_refresh()
    assert post(client, "/api/filter/decision", {"photos": [pid], "action": "keep"}).status_code == 200
    assert s.store.one("SELECT undone FROM votes WHERE id=?", (first,))["undone"]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override='toss' WHERE id=?", (pid,))
    later = s.store.add_vote("toss", pid, None, None, None, extra={"members": [pid]})
    assert post(client, "/api/draw/undo").status_code == 200
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "toss"
    assert s.store.one("SELECT undone FROM votes WHERE id=?", (first,))["undone"]
    assert not s.store.one("SELECT undone FROM votes WHERE id=?", (later,))["undone"]


def test_completion_awards_once_and_reopens_on_policy_or_new_inputs_not_votes(client):
    s, data = client.session, fetch(client)
    base = s.progress()["game"]["xp"]
    assert post(client, "/api/filter/finish").get_json()["stage"]["done"]
    assert s.progress()["game"]["xp"] == base + game.STAGE_XP["filter"]
    last = s.draw.last_step()
    assert post(client, "/api/filter/finish").status_code == 200 and s.draw.last_step() == last
    s.store.add_vote("skip", data["ids"]["kept"][0], data["ids"]["kept"][1], None, 50)
    assert fetch(client)["stage"]["done"]
    pid = data["ids"]["kept"][0]
    assert post(client, "/api/filter/decision", {"photos": [pid], "action": "aside"}).get_json()["stage"]["done"]
    apply(client, {**data["policy"], "min_pixels": 450})
    assert not fetch(client)["stage"]["done"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert fetch(client)["stage"]["done"]
    with s.store.tx() as c:
        c.execute("INSERT INTO photos(rel,status,error) VALUES('new-broken.jpg','error','test')")
    s.refresh_async(); s.wait_refresh()
    assert not fetch(client)["stage"]["done"]


def test_changed_saved_recognition_reopens_completed_filter(client, monkeypatch):
    s = client.session
    assert post(client, "/api/filter/finish").get_json()["stage"]["done"]
    monkeypatch.setattr(library, "zero_shot", lambda lib: {k: np.full(len(lib.photos), .2) for k in library.ATTRS})
    s.refresh_async(); s.wait_refresh()
    assert not fetch(client)["stage"]["done"]


def test_changed_membership_archives_brackets_and_undo_restores_without_erasing_votes(client):
    s, data = client.session, fetch(client)
    seeds = data["ids"]["kept"][:4]
    final = {"id": "old-final", "seeds": seeds, "matches": [], "champion": seeds[0]}
    ko = {"id": "old-ko", "qualified": seeds, "rounds": []}
    s.store.set_meta("finals:all", final); s.store.set_meta("knockouts:all", ko)
    s.store.set_meta("champions", {"all": seeds[0]})
    vote = s.store.add_vote("duel", seeds[0], seeds[1], seeds[0], 50)
    assert post(client, "/api/filter/decision", {"photos": [seeds[0]], "action": "aside"}).status_code == 200
    assert s.store.get_meta("finals:all") is None and s.store.get_meta("knockouts:all") is None
    assert not s.store.get_meta("champions") and s.store.get_meta("filter_bracket_archive")
    assert not s.store.one("SELECT undone FROM votes WHERE id=?", (vote,))["undone"]
    assert post(client, "/api/draw/undo").status_code == 200
    assert s.store.get_meta("finals:all") == final and s.store.get_meta("knockouts:all") == ko
    assert s.store.get_meta("champions") == {"all": seeds[0]}
    assert post(client, "/api/filter/decision", {"photos": [seeds[0]], "action": "aside"}).status_code == 200
    s.store.set_meta("finals:all", {**final, "id": "new-final"})
    assert post(client, "/api/draw/undo").status_code == 200
    assert s.store.get_meta("finals:all") is None
    assert s.store.get_meta("filter_bracket_archive")[-1]["cups"]["all"]["finals"]["id"] == "new-final"


def test_content_tag_correction_retires_bracket_and_shared_undo_restores_it(client):
    s, data = client.session, fetch(client)
    ids = data["ids"]["kept"]
    key = tags.new_tag(s.store, "Playable subject", None)
    tags.edit(s.store, ids, [key], [])
    apply(client, {**data["policy"], "require_tags": [key]})
    final = {"id": "tag-final", "seeds": ids[:4], "matches": [], "champion": ids[0]}
    s.store.set_meta("finals:all", final); s.store.set_meta("champions", {"all": ids[0]})
    assert post(client, "/api/tags/set", {"photos": [ids[0]], "on": [], "off": [key]}).status_code == 200
    assert ids[0] in fetch(client)["ids"]["aside"]
    assert s.store.get_meta("finals:all") is None and not s.store.get_meta("champions")
    assert post(client, "/api/draw/undo").status_code == 200
    assert ids[0] in fetch(client)["ids"]["kept"]
    assert s.store.get_meta("finals:all") == final
    assert s.store.get_meta("champions") == {"all": ids[0]}


def test_filter_undo_retires_a_later_bracket_even_without_an_original_bracket(client):
    s, data = client.session, fetch(client)
    pid = data["ids"]["kept"][0]
    assert post(client, "/api/filter/decision", {"photos": [pid], "action": "aside"}).status_code == 200
    final = {"id": "later-final", "seeds": data["ids"]["kept"][1:5], "matches": []}
    s.store.set_meta("finals:all", final)
    vote = s.store.add_vote("duel", final["seeds"][0], final["seeds"][1], final["seeds"][0], 50)
    assert post(client, "/api/draw/undo").status_code == 200
    assert pid in fetch(client)["ids"]["kept"] and s.store.get_meta("finals:all") is None
    assert s.store.get_meta("filter_bracket_archive")[-1]["cups"]["all"]["finals"] == final
    assert not s.store.one("SELECT undone FROM votes WHERE id=?", (vote,))["undone"]


def test_filter_undo_does_not_restore_a_bracket_with_a_later_manually_tossed_seed(client):
    s, data = client.session, fetch(client)
    first, later = data["ids"]["kept"][:2]
    final = {"id": "saved-final", "seeds": data["ids"]["kept"][:4], "matches": []}
    s.store.set_meta("finals:all", final)
    assert post(client, "/api/filter/decision", {"photos": [first], "action": "aside"}).status_code == 200
    with s.store.tx() as c:
        c.execute("UPDATE photos SET override='toss' WHERE id=?", (later,))
    s.store.add_vote("toss", later, None, None, None, extra={"members": [later]})
    s.refresh_async(); s.wait_refresh()
    assert post(client, "/api/draw/undo").status_code == 200
    assert first in fetch(client)["ids"]["kept"] and later in fetch(client)["ids"]["aside"]
    assert s.store.get_meta("finals:all") is None
    assert s.store.get_meta("filter_bracket_archive")[-1]["cups"]["all"]["finals"] == final


@pytest.mark.parametrize("kind", ["final", "knockout"])
def test_old_tournament_vote_undo_cannot_revive_a_filter_archived_bracket(client, kind):
    s, data = client.session, fetch(client)
    seeds = data["ids"]["kept"][:4]
    old = {"cup": "all", "seeds": seeds, "size": 4, "matches": [],
           "rounds": [{"matches": [{"a": seeds[0], "b": seeds[1], "winner": None}]}]}
    s.store.set_meta(f"{kind}s:all", {**old, "id": "current-bracket"})
    vote = s.store.add_vote("duel", seeds[0], seeds[1], seeds[0], 50,
                            extra={kind: "all", "before": old, "champs_before": {}})
    assert post(client, "/api/filter/decision", {"photos": [seeds[0]], "action": "aside"}).status_code == 200
    assert post(client, "/api/undo").status_code == 200
    assert s.store.get_meta(f"{kind}s:all") is None and not s.store.get_meta("champions")
    assert seeds[0] in fetch(client)["ids"]["aside"]
    assert s.store.one("SELECT undone FROM votes WHERE id=?", (vote,))["undone"]


@pytest.mark.parametrize("change", [None, "keep"])
def test_old_sweep_undo_preserves_a_newer_filter_aside(client, change):
    s, data = client.session, fetch(client)
    pid = data["ids"]["kept"][0]
    if change:
        with s.store.tx() as c:
            c.execute("UPDATE photos SET override='keep' WHERE id=?", (pid,))
    vote = s.store.add_vote("sweep", pid, None, None, None,
                            extra={"keep": True, "prev": {str(pid): None}, "change": change})
    assert post(client, "/api/filter/decision", {"photos": [pid], "action": "aside"}).status_code == 200
    assert post(client, "/api/undo").status_code == 200
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "toss"
    assert pid in fetch(client)["ids"]["aside"]
    assert s.store.one("SELECT undone FROM votes WHERE id=?", (vote,))["undone"]


def test_missing_measurements_abstain_and_threshold_equality_passes():
    p = filtering.defaults({"mode": "gallery"})
    row = {"id": 1, "rel": "photo.jpg", "status": "analyzed", "width": 400, "height": 400, "sharp": 25, "luma": 245}
    assert filtering.evaluate(row, {"scores": {"blurry": .8}}, p, "gallery") == []
    assert filtering.evaluate({"id": 1, "rel": "unknown.jpg", "status": "analyzed"}, {}, p, "gallery") == []
    profile = filtering.defaults({"mode": "me"})
    assert filtering.evaluate({"id": 1, "rel": "unknown.jpg", "status": "analyzed"}, {}, profile, "me") == []
    assert filtering.evaluate(row, {"faces": False, "has_you": False}, profile, "me") == ["no_face"]


def test_ten_thousand_preview_rows_use_bounded_queries_and_pages(tmp_path, monkeypatch):
    store = Store(tmp_path / "synthetic.db")
    concepts = list(library.ATTRS) + [f"concept-{i}" for i in range(48 - len(library.ATTRS))]
    def evidence(i):
        return json.dumps({"scores": {key: .01 + ((i + j) % 29) / 100 for j, key in enumerate(concepts)},
                           "face": {"h": .25, "px": 300, "sharp": 140 + i % 40, "luma": 100 + i % 35},
                           "faces": 1 + i % 4, "has_you": True, "large_face": True, "excluded": False})
    keys = [f"what:synthetic-{i}" for i in range(617)]
    with store.tx() as c:
        c.executemany("INSERT INTO photos(id,rel,status,width,height,sharp,luma,zs) VALUES(?,?,'analyzed',1200,1600,100,128,?)",
                      [(i, f"test-{i}.jpg", evidence(i)) for i in range(1, 10001)])
        c.executemany("INSERT INTO tags(key,label,family) VALUES(?,?,'what')", [(key, f"Subject {i}") for i, key in enumerate(keys)])
        c.executemany("INSERT INTO photo_tags(photo_id,tag,score) VALUES(?,?,?)",
                      [(i, keys[(i * 7 + j * 31) % len(keys)], .9) for i in range(1, 10001) for j in range(12)])
    class StoredSession(SimpleNamespace):
        @property
        def settings(self):
            return self.store.get_meta("settings", {"mode": "gallery"})

        @property
        def mode(self):
            return self.settings.get("mode", "gallery")
    session = StoredSession(store=store, source=tmp_path, draw=SimpleNamespace(last_step=lambda: None))
    calls, original = [], store.q
    def query(sql, args=()):
        calls.append(sql)
        return original(sql, args)
    monkeypatch.setattr(store, "q", query)
    start = time.perf_counter()
    result = filtering.preview(session, {"policy": {**filtering.defaults(session.settings), "min_pixels": 2000,
                               "require_tags": keys[:3], "require_mode": "any", "exclude_tags": keys[3:5]}, "per": 72})
    first_seconds = time.perf_counter() - start
    assert len(result["photos"]) == 72 and result["more"] and result["counts"]["changed"] == 10000
    assert len(result["ids"]["aside"]) == 10000 and len(calls) < 30
    assert len(result["tags"]) == len(keys) and len(result["photos"][0]["metrics"]["scores"]) >= 48
    start = time.perf_counter()
    again = filtering.preview(session, {"policy": filtering.defaults(session.settings), "per": 30})
    repeat_seconds = time.perf_counter() - start
    assert len(again["photos"]) == 30 and len(calls) < 60
    print(f"10k Filter previews: first={first_seconds:.3f}s repeat={repeat_seconds:.3f}s; {len(calls)} total queries")
    assert store.get_meta("filter_policy") is None
    store.close()
