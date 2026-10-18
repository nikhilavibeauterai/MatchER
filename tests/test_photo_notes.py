"""A take's sheet reads saved evidence and keeps its own writing and tag corrections undoable."""
import json

import pytest

from tests.test_draw import client, post, single  # shared synthetic library, never an owner's save


def test_sheet_reads_an_exact_take_before_the_ranker_is_loaded(client, monkeypatch):
    s = client.matcher.session
    row = s.store.one("SELECT id,rel,group_id FROM photos WHERE status='analyzed' LIMIT 1")
    before = s.store.conn().total_changes
    monkeypatch.setattr(s, "ensure_ranker", lambda *a, **kw: pytest.fail("A sheet must only read saved evidence"))
    response = client.get(f"/api/photo/{row['id']}/notes")
    assert response.status_code == 200
    p = response.get_json()
    assert p["id"] == row["id"] and p["rel"] == row["rel"]
    assert p["width"] and p["height"] and isinstance(p["tags"], list)
    assert p["id"] in p["stack"]["members"]
    assert not {"emb", "crop_emb", "sha256", "phash", "mtime_ns"} & p.keys()
    assert all("emb" not in f and "lm" not in f for f in p["faces"])
    json.dumps(p)
    assert s.store.conn().total_changes == before
    assert client.get("/api/photo/999999/notes").status_code == 404


def test_frame_title_and_long_notes_save_together_and_undo(client):
    pid = single(client, 0)
    original = client.get(f"/api/edit?photo={pid}").get_json()["edits"]
    r = post(client, "/api/edit", {"photo": pid, "title": "  Morning walk  ", "description": "Warm light.\nKeep the landscape crop."})
    assert r.status_code == 200
    p = client.get(f"/api/photo/{pid}/notes").get_json()
    assert p["edits"]["title"] == "Morning walk"
    assert p["edits"]["description"] == "Warm light.\nKeep the landscape crop."
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit"
    assert client.get(f"/api/edit?photo={pid}").get_json()["edits"] == original
    post(client, "/api/draw/redo")
    assert client.get(f"/api/photo/{pid}/notes").get_json()["edits"]["title"] == "Morning walk"
    post(client, "/api/edit", {"photo": pid, "title": " ", "description": None})
    assert "title" not in client.get(f"/api/edit?photo={pid}").get_json()["edits"]


def test_sticky_ranking_matches_the_leaderboard_without_writing(client, monkeypatch):
    board = client.get("/api/shortlist").get_json()
    assert board["items"]
    s = client.matcher.session
    before = s.store.conn().total_changes
    monkeypatch.setattr(s, "ensure_ranker", lambda *a, **kw: pytest.fail("A sticky must not refit the ranker"))
    for item in board["items"] + board["bubble"][:1]:
        photo = client.get(f"/api/photo/{item['photo']}/notes").get_json()
        ranking = photo["ranking"]
        assert ranking["rank"] == item["rank"]
        assert ranking["inclusion"] == item["p_in"]
        assert ranking["appeal"] == item["appeal"]
        assert ranking["duels"] == item["duels"]
        assert len(photo["stack"]["members"]) == item["frames"]
        assert photo["flags"] == item["flags"]
    assert s.store.conn().total_changes == before


@pytest.mark.parametrize("field,value", [("title", "a" * 161), ("description", "a" * 8001), ("title", []), ("description", 4)])
def test_invalid_writing_is_atomic(client, field, value):
    pid = single(client, 0)
    before = client.get(f"/api/edit?photo={pid}").get_json()
    assert post(client, "/api/edit", {"photo": pid, "title": "Should not save", field: value}).status_code == 400
    assert client.get(f"/api/edit?photo={pid}").get_json() == before


def test_sheet_tags_affect_one_take_and_empty_tags_disappear_until_undo(client):
    s = client.matcher.session
    s.ensure_ranker()
    members = next(g["members"] for g in s.groups.values() if len(g["members"]) > 1)
    pid = members[-1]
    r = post(client, "/api/tags/new", {"label": "One special take", "photos": [pid], "exact": True})
    assert r.status_code == 200
    key = r.get_json()["key"]
    assert [r["photo_id"] for r in s.store.q("SELECT photo_id FROM tag_edits WHERE tag=? AND val=1", (key,))] == [pid]
    assert any(t["key"] == key for t in client.get(f"/api/photo/{pid}/notes").get_json()["tags"])
    assert not any(t["key"] == key for t in client.get(f"/api/photo/{members[0]}/notes").get_json()["tags"])
    post(client, "/api/tags/set", {"photos": [pid], "off": [key], "exact": True})
    assert key not in {t["key"] for t in client.get("/api/tags?all=1").get_json()["tags"]}
    post(client, "/api/draw/undo")
    assert next(t for t in client.get("/api/tags?all=1").get_json()["tags"] if t["key"] == key)["count"] == 1
    post(client, "/api/draw/undo")
    assert key not in {t["key"] for t in client.get("/api/tags?all=1").get_json()["tags"]}


def test_sheet_can_set_aside_one_take_without_tossing_its_stack_and_undo(client):
    s = client.matcher.session
    s.ensure_ranker()
    members = next(g["members"] for g in s.groups.values() if len(g["members"]) > 2)
    post(client, "/api/rescue", {"ids": members, "on": True})
    s.wait_refresh()
    before = {pid: s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] for pid in members}
    pid = members[-1]
    reply = post(client, "/api/rescue", {"ids": [pid], "on": False, "reason": "tossed"})
    assert reply.status_code == 200 and reply.get_json()["undo"]
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "toss"
    assert all(s.store.one("SELECT override FROM photos WHERE id=?", (other,))["override"] == before[other]
               for other in members if other != pid)
    post(client, "/api/draw/undo")
    assert {member: s.store.one("SELECT override FROM photos WHERE id=?", (member,))["override"] for member in members} == before
