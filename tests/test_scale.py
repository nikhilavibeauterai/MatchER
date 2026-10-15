"""Synthetic scale budgets: no files or pixels from a real library."""
import sqlite3
import time
import tracemalloc

import numpy as np
import pytest

from matcher import library, tags
from matcher.ranker import Ranker
from matcher.server import Session, create_app


@pytest.mark.parametrize("n", [5000, 20000])
def test_tag_clustering_has_bounded_time_and_memory(n):
    sets = {i: {f"t:family{i%8}", f"t:look{i%32}", "kind:people"} for i in range(n)}
    meta = {key: {"label": key, "family": "what"} for keys in sets.values() for key in keys}
    tracemalloc.start(); start = time.monotonic()
    try:
        groups = tags.cluster(sets, set(sets), ["kind:people"], meta, set())
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert time.monotonic() - start < 15
    assert peak < 50 * 2**20
    assigned = [p for g in groups for p in g["shots"]]
    assert len(assigned) == n and len(set(assigned)) == n


@pytest.mark.parametrize("n", [5000, 20000])
def test_stacking_has_bounded_time_and_memory(n):
    rng = np.random.default_rng(2026)
    emb = rng.normal(size=(n, 32)).astype(np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    photos = [{"id": i+1, "taken_ts": 1700000000 + i*7201} for i in range(n)]
    lib = library.Lib(photos, [], {}, {}, emb, np.ones(n,bool), emb, np.ones(n,bool), np.empty((0,128)))
    tracemalloc.start(); start = time.monotonic()
    try:
        groups = library.group_shots(lib, np.ones(n,bool), np.arange(n,dtype=float))
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert time.monotonic() - start < 25
    assert peak < (350 if n == 5000 else 120) * 2**20
    assert sorted(p for g in groups for p in g) == list(range(n))


def test_shortlist_above_sqlite_variable_limit(tmp_path, monkeypatch):
    n = 33010
    s = Session(tmp_path / "synthetic", tmp_path / "scratch")
    try:
        with s.store.tx() as c:
            c.executemany("INSERT INTO photos(id,rel,status,prior) VALUES(?,?,'analyzed',0)",
                          [(i, f"synthetic/{i}.jpg") for i in range(1,n+1)])
        s.store.conn().setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER,999)
        s.reps = list(range(1,n+1)); s.gids = s.reps.copy(); s.gidx = {p:i for i,p in enumerate(s.reps)}
        s.groups = {p:{"members":[p]} for p in s.reps}; s.photo_group = {p:p for p in s.reps}
        s.names = ["sharp", "light"]; s.n_hand = 2; s.cats = ["things"]*n
        s.ranker = Ranker(np.zeros((n,2)),np.zeros(2),np.ones(2),np.arange(n),k=8)
        s.ranker.fit([])
        monkeypatch.setattr(s,"ensure_ranker",lambda **kw:s.ranker)
        monkeypatch.setattr(s,"progress",lambda:{})
        start = time.monotonic(); shortlist = s.shortlist()
        assert len(shortlist["items"]) == 8 and len(shortlist["bubble"]) == 24
        assert time.monotonic()-start < 3
    finally:
        s.shutdown()


@pytest.mark.parametrize("n", [5000,20000])
def test_board_and_world_pages_have_bounded_time_and_memory(n,tmp_path,monkeypatch):
    s=Session(tmp_path/"synthetic",tmp_path/"scratch")
    app=create_app(tmp_path/"scratch",allowed_hosts={"localhost"})
    app.config["MATCHER"].session=s
    try:
        with s.store.tx() as c:
            c.executemany("INSERT INTO photos(id,rel,status,group_id,category) VALUES(?,?,'analyzed',?,'things')",
                          [(i,f"synthetic/{i}.jpg",i) for i in range(1,n+1)])
            c.executemany("INSERT INTO groups(id,rep,members) VALUES(?,?,?)",[(i,i,f"[{i}]") for i in range(1,n+1)])
        s.store.conn().setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER,999)
        s.reps=list(range(1,n+1));s.gids=s.reps.copy();s.gidx={p:i for i,p in enumerate(s.reps)}
        s.groups={p:{"rep":p,"members":[p],"scene":p,"checked":True} for p in s.reps};s.photo_group={p:p for p in s.reps}
        s.base_active=np.ones(n,bool);s.cats=["things"]*n;s.names=["sharp","light"];s.n_hand=2;s.view={}
        s.ranker=Ranker(np.zeros((n,2)),np.zeros(2),np.ones(2),np.arange(n),k=8);s.ranker.fit([])
        monkeypatch.setattr(s,"ensure_ranker",lambda **kw:s.ranker);monkeypatch.setattr(s,"progress",lambda:{})
        c=app.test_client();tracemalloc.start();start=time.monotonic()
        try:
            board=c.get("/api/draw/board?per=24&uper=24").get_json()
            page=c.get("/api/world?per=1000").get_json()
            peak=tracemalloc.get_traced_memory()[1]
        finally:tracemalloc.stop()
        assert board["total"]==page["total"]==n and len(board["unsorted"]["shots"])==24
        assert len(page["photos"])==1000 and page["more"]
        assert time.monotonic()-start<4 and peak<80*2**20
        # Selecting a whole tag's roster must edit every photo, including those beyond the old 2000 cap.
        reply=c.post("/api/tags/new",json={"label":"Whole library","photos":s.reps},headers={"X-MatchER":"1"})
        assert reply.status_code==200,reply.get_json()
        key=reply.get_json()["key"]
        assert s.store.one("SELECT COUNT(*) AS n FROM tag_edits WHERE tag=?",(key,))["n"]==n
        undo=c.post("/api/draw/undo",json={},headers={"X-MatchER":"1"})
        assert undo.status_code==200 and not s.store.one("SELECT key FROM tags WHERE key=?",(key,))
    finally:s.shutdown()
