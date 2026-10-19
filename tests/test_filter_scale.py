"""Real Filter HTTP paths at scale, using synthetic saved evidence and no vision or photos."""
import json
import sqlite3
import threading
import time

import pytest

from matcher import filtering, library
from matcher.server import Session, create_app
from tests.test_filtering import client, fetch, post


@pytest.fixture
def large_filter(tmp_path, monkeypatch):
    s = Session(tmp_path / "source", tmp_path / "save")
    app = create_app(tmp_path / "app", allowed_hosts={"localhost"})
    app.config["MATCHER"].session = s
    s.store.set_meta("settings", {"mode": "gallery"})
    s.store.set_meta("derived_version", library.DERIVED_VERSION)
    s.store.set_meta("state_version", 1)
    evidence = json.dumps({"scores": {f"concept-{j}": j / 100 for j in range(48)},
                           "face": {"h": .25, "px": 300, "sharp": 140, "luma": 110}})
    with s.store.tx() as c:
        c.executemany("INSERT INTO photos(id,rel,status,width,height,sharp,luma,zs,group_id) VALUES(?,?,'analyzed',1200,1600,100,128,?,?)",
                      [(i, f"synthetic-{i}.jpg", evidence, i) for i in range(1, 10001)])
        c.executemany("INSERT INTO tags(key,label,family) VALUES(?,?,'what')", [(f"subject:{j}", f"Subject {j}") for j in range(617)])
        c.executemany("INSERT INTO photo_tags(photo_id,tag,score) VALUES(?,?,.9)",
                      [(i, f"subject:{(i * 7 + j * 31) % 617}") for i in range(1, 10001) for j in range(12)])
    monkeypatch.setattr(s, "ensure_ranker", lambda *a, **kw: object())
    client = app.test_client()
    client.session = s
    yield client
    s.shutdown()


def test_single_photo_route_reads_one_take_and_returns_a_small_reply(large_filter, monkeypatch):
    c, rows = large_filter, []
    original = c.session.store.q
    def query(sql, args=()):
        result = original(sql, args)
        rows.append((sql, len(result)))
        return result
    monkeypatch.setattr(c.session.store, "q", query)
    monkeypatch.setattr(c.session, "ensure_ranker", lambda *a, **kw: pytest.fail("A photo detail read rebuilt the ranker"))
    start = time.perf_counter()
    reply = c.get("/api/filter?photo=9876&per=1")
    elapsed = time.perf_counter() - start
    assert reply.status_code == 200, reply.get_json()
    assert [r["id"] for r in reply.get_json()["photos"]] == [9876]
    print(f"10k Filter photo: {elapsed:.4f}s, {len(reply.data)} bytes, largest query={max(n for _, n in rows)} rows")
    assert len(reply.data) < 10000
    assert max(n for sql, n in rows if "FROM photos" in sql) == 1
    assert max(n for sql, n in rows if "FROM photo_tags" in sql) == 12


def test_preview_photo_turns_reuse_validation_across_request_threads(large_filter, monkeypatch):
    c, s = large_filter, large_filter.session
    p = filtering.policy(s.store, s.settings)
    preview = c.post("/api/filter/preview", json={"policy": p}, headers={"X-MatchER": "1"}).get_json()
    replies = []
    monkeypatch.setattr(filtering, "snapshot", lambda *_: pytest.fail("An unchanged preview scanned every photo again"))
    monkeypatch.setattr(s, "ensure_ranker", lambda *a, **kw: pytest.fail("Preview detail rebuilt the ranker"))
    started = time.perf_counter()
    def load(pid):
        reply = c.get(f"/api/filter/preview?token={preview['token']}&photo={pid}&per=1")
        replies.append((reply.status_code, reply.get_json(), len(reply.data)))
    for pid in range(1, 13):
        worker = threading.Thread(target=load, args=(pid,))
        worker.start(); worker.join(5)
        assert not worker.is_alive()
    assert len(replies) == 12 and all(status == 200 and size < 10000 for status, _, size in replies)
    assert [data["photos"][0]["id"] for _, data, _ in replies] == list(range(1, 13))
    print(f"10k preview: 12 detail HTTP requests in {time.perf_counter() - started:.4f}s")


@pytest.mark.parametrize("other_connection", [False, True])
def test_preview_fast_validation_detects_writes_from_every_connection(large_filter, other_connection):
    c, s = large_filter, large_filter.session
    preview = c.post("/api/filter/preview", json={"policy": filtering.policy(s.store, s.settings)},
                     headers={"X-MatchER": "1"}).get_json()
    if other_connection:
        conn = sqlite3.connect(s.store.path)
        try:
            conn.execute("UPDATE photos SET width=12 WHERE id=9999")
            conn.commit()
        finally:
            conn.close()
    else:
        with s.store.tx() as conn:
            conn.execute("UPDATE photos SET width=12 WHERE id=9999")
    # A mutation outside this take must invalidate the whole-library preview too.
    reply = c.get(f"/api/filter/preview?token={preview['token']}&photo=1&per=1")
    assert reply.status_code == 409


def test_preview_age_boundary_expires_without_a_database_write(large_filter, monkeypatch):
    c, s = large_filter, large_filter.session
    now = time.time()
    with s.store.tx() as conn:
        conn.execute("UPDATE photos SET taken_ts=? WHERE id=1", (now - 365.25 * 86400 + 10,))
    monkeypatch.setattr(filtering.time, "time", lambda: now)
    p = {**filtering.policy(s.store, s.settings), "max_age_years": 1}
    preview = c.post("/api/filter/preview", json={"policy": p}, headers={"X-MatchER": "1"}).get_json()
    url = f"/api/filter/preview?token={preview['token']}&photo=1&per=1"
    assert c.get(url).status_code == 200
    monkeypatch.setattr(filtering.time, "time", lambda: now + 11)
    assert c.get(url).status_code == 409


@pytest.mark.parametrize("other_connection", [False, True])
def test_current_filter_pages_reuse_assessment_and_notice_every_connection(large_filter, monkeypatch, other_connection):
    c, s = large_filter, large_filter.session
    first = c.get('/api/filter?per=4').get_json()
    original, calls = filtering.catalogue, []
    def catalogue(*a, **kw):
        calls.append(1)
        return original(*a, **kw)
    monkeypatch.setattr(filtering, 'catalogue', catalogue)
    assert c.get('/api/filter?page=1&per=4').get_json()['photos'][0]['id'] == 5
    assert c.get('/api/filter?state=kept&per=4').status_code == 200
    assert calls == [], 'Paging and changing the displayed reason do not assess 10,000 photos again'
    if other_connection:
        conn = sqlite3.connect(s.store.path)
        try:
            conn.execute("UPDATE photos SET override='toss' WHERE id=1"); conn.commit()
        finally:
            conn.close()
    else:
        with s.store.tx() as conn:
            conn.execute("UPDATE photos SET override='toss' WHERE id=1")
    changed = c.get('/api/filter?per=4').get_json()
    assert len(calls) == 1 and changed['photos'][0]['override'] == 'toss'
    assert changed['counts']['manual_aside'] == first['counts']['manual_aside'] + 1


def test_current_filter_cache_refreshes_at_an_age_boundary(large_filter, monkeypatch):
    c, s = large_filter, large_filter.session
    now = time.time()
    with s.store.tx() as conn:
        conn.execute('UPDATE photos SET taken_ts=? WHERE id=1', (now - 365.25 * 86400 + 10,))
    s.store.set_meta('filter_policy', {**filtering.policy(s.store, s.settings), 'max_age_years': 1})
    monkeypatch.setattr(filtering.time, 'time', lambda: now)
    before = c.get('/api/filter?per=1').get_json()['photos'][0]
    cached = s.filter_catalogue
    monkeypatch.setattr(filtering.time, 'time', lambda: now + 11)
    after = c.get('/api/filter?per=1').get_json()['photos'][0]
    assert s.filter_catalogue is not cached and 'old' not in before['reasons'] and 'old' in after['reasons']


def test_filter_undo_rebuilds_stacks_once_and_restores_admission(client, monkeypatch):
    data = fetch(client)
    pid = data["ids"]["kept"][0]
    assert post(client, "/api/filter/decision", {"photos": [pid], "action": "aside"}).status_code == 200
    calls = []
    refresh, regroup = library.refresh, library.regroup
    def full(*a, **kw):
        calls.append("full")
        return refresh(*a, **kw)
    def stacks(*a, **kw):
        calls.append("stacks")
        return regroup(*a, **kw)
    monkeypatch.setattr(library, "refresh", full)
    monkeypatch.setattr(library, "regroup", stacks)
    assert post(client, "/api/draw/undo").status_code == 200
    assert calls == ["full"]
    assert pid in fetch(client)["ids"]["kept"]
    i = client.session._item(pid)
    assert i is not None and client.session.ranker.active[i]
