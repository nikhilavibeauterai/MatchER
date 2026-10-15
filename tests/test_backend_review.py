"""Regressions from the backend review, using synthetic saves and tag sets only."""
import threading
from itertools import combinations

import numpy as np
import pytest

from matcher import library, tags
from matcher.analyze import Analyzer
from matcher.ranker import Obs, Ranker
from matcher.server import Session, create_app
from matcher.store import ClosedStoreError, Store, f16
from tests.test_draw import client, post, single


def test_request_keeps_its_save_when_another_request_switches(client, monkeypatch, tmp_path):
    old = client.matcher.session
    other = Session(tmp_path / "other-photos", tmp_path / "other-save")
    client.matcher._sessions[str(other.source)] = other
    lock = old.lock

    class SwitchOnLock:
        def __enter__(self):
            lock.acquire()
            client.matcher.session = other

        def __exit__(self, *exc):
            lock.release()

    monkeypatch.setattr(old, "lock", SwitchOnLock())
    monkeypatch.setattr(old, "ranker", object())
    monkeypatch.setattr(old, "progress", lambda: {"game": {"unlocked": ["first"]}})
    assert post(client, "/api/welcome").status_code == 200
    assert old.store.get_meta("welcomed") is True
    assert other.store.get_meta("welcomed") is None
    assert old.store.get_meta("achievements") == ["first"]
    assert other.store.get_meta("achievements") is None


def test_unicode_keys_are_refused_without_an_internal_error(tmp_path):
    app = create_app(tmp_path / "empty-save", secret="test-secret")
    c = app.test_client()
    assert c.get("/?k=not-ascii-é").status_code == 403
    c.set_cookie("matcher_k", "not-ascii-é")
    assert c.get("/api/state").status_code == 403


def test_oversized_ids_fail_before_sqlite_binding(client):
    huge = 10**30
    assert post(client, "/api/tags/set", {"photos": [huge], "on": ["faces"]}).status_code == 400
    assert client.get(f"/api/world?after={huge}").status_code == 400
    assert client.get(f"/img/f/{huge}.jpg").status_code == 400


def test_request_that_outlives_a_forgotten_save_gets_a_conflict(client, monkeypatch):
    def closed(*args, **kwargs):
        raise ClosedStoreError("This save is closed.")

    monkeypatch.setattr(client.matcher.session.store, "q", closed)
    response = client.get("/api/cuts")
    assert response.status_code == 409 and response.get_json()["error"] == "This save is closed."


def test_failed_transaction_entry_releases_the_store_lock(tmp_path):
    store = Store(tmp_path / "closed.db")
    store.close()
    with pytest.raises(RuntimeError, match="closed"):
        with store.tx():
            pass
    acquired = []

    def attempt():
        got = store.lock.acquire(timeout=0.2)
        acquired.append(got)
        if got:
            store.lock.release()

    worker = threading.Thread(target=attempt)
    worker.start()
    worker.join(1)
    assert acquired == [True]


def test_rollback_invalidates_votes_read_inside_the_transaction(tmp_path):
    store = Store(tmp_path / "rollback.db")
    try:
        with pytest.raises(ValueError):
            with store.tx() as c:
                c.execute("INSERT INTO votes(ts,kind,a) VALUES(1,'great',1)")
                assert len(store.votes()) == 1
                revision = store.vote_revision
                raise ValueError("cancel the write")
        assert not store.votes()
        assert store.vote_revision > revision
    finally:
        store.close()


@pytest.mark.parametrize("action", ["merge", "dissolve"])
def test_group_removal_includes_hidden_cups_and_set_aside_photos(client, monkeypatch, action):
    s = client.matcher.session
    a, b, c = [single(client, i) for i in (1, 2, 3)]
    source = post(client, "/api/draw/new", {"photos": [a, b]}).get_json()["theme"]["id"]
    target = post(client, "/api/draw/new", {"photos": [c]}).get_json()["theme"]["id"]
    cut = s.store.one("SELECT id FROM photos WHERE cut IS NOT NULL")["id"]
    with s.store.tx() as con:
        con.execute("UPDATE photos SET theme_id=? WHERE id=?", (source, cut))
    pool = s.draw.pool_mask()
    pool[s._item(b)] = False
    monkeypatch.setattr(s.draw, "pool_mask", lambda: pool.copy())
    payload = {"from": source, "into": target} if action == "merge" else {"theme": source}
    assert post(client, f"/api/draw/{action}", payload).status_code == 200
    expected = target if action == "merge" else None
    assert [r["theme_id"] for r in s.store.q("SELECT theme_id FROM photos WHERE id IN (?,?,?)", (a, b, cut))] == [expected] * 3
    assert post(client, "/api/draw/undo").status_code == 200
    assert [r["theme_id"] for r in s.store.q("SELECT theme_id FROM photos WHERE id IN (?,?,?)", (a, b, cut))] == [source] * 3


def test_undo_restores_rejected_candidates_when_an_empty_group_returns(client):
    s = client.matcher.session
    a, b, rejected = [single(client, i) for i in (1, 2, 3)]
    source = post(client, "/api/draw/new", {"photos": [a]}).get_json()["theme"]["id"]
    target = post(client, "/api/draw/new", {"photos": [b]}).get_json()["theme"]["id"]
    assert post(client, "/api/draw/call", {"theme": source, "photo": rejected, "call": "out"}).status_code == 200
    assert post(client, "/api/draw/move", {"photos": [a], "theme": target}).status_code == 200
    assert not s.store.one("SELECT id FROM themes WHERE id=?", (source,))
    assert post(client, "/api/draw/undo").status_code == 200
    assert s.store.one("SELECT photo_id FROM theme_no WHERE theme_id=? AND photo_id=?", (source, rejected))


def test_membership_never_promotes_inactive_photos_to_fill_scene_caps():
    active = np.array([True, True, False, False])
    r = Ranker(np.zeros((4, 1)), np.zeros(1), np.ones(1), np.array([0, 0, 1, 2]), k=3, cap=1, active=active)
    post = r.fit([])
    assert np.all(post.p_in[~active] == 0)
    assert post.p_in.sum() == pytest.approx(1)


def test_balanced_large_history_has_a_finite_stationary_fit():
    n = 260
    r = Ranker(np.zeros((n, 1)), np.zeros(1), np.ones(1), np.arange(n), k=8)
    obs = [o for i in range(n) for o in (Obs("above", i), Obs("below", i))]
    post = r.fit(obs)
    assert np.isfinite(post.mu).all() and np.isfinite(post.var).all()
    np.testing.assert_allclose(post.mu, 0)


def test_year_tags_cluster_equally_and_visibility_does_not_change_membership():
    sets = {i: {"common", "y:2025" if i < 10 else "y:2026"} for i in range(20)}
    meta = {t: {"label": t, "family": "when"} for ts in sets.values() for t in ts}
    groups = tags.cluster(sets, set(sets), ["common"], meta, set())
    members = {frozenset(g["shots"]) for g in groups}
    assert members == {frozenset(range(10)), frozenset(range(10, 20))}
    assert members == {frozenset(g["shots"]) for g in tags.cluster(sets, set(sets), ["y:2025"], meta, set())}


def test_large_vocabulary_keeps_every_tagged_photo():
    sets = {i: {f"group:{i // 2}"} for i in range(600)}
    meta = {t: {"label": t, "family": "what"} for ts in sets.values() for t in ts}
    groups = tags.cluster(sets, set(sets), [], meta, set())
    assert sorted(p for g in groups for p in g["shots"]) == list(sets)


def test_sparse_and_dense_clustering_agree_on_separate_flocks(monkeypatch):
    sets = {i: {f"flock:{i // 10}:{t}" for t in range(80)} for i in range(40)}
    meta = {t: {"label": t, "family": "what"} for ts in sets.values() for t in ts}
    sparse = {frozenset(g["shots"]) for g in tags.cluster(sets, set(sets), [], meta, set())}
    monkeypatch.setattr(tags, "CLUSTER_VOCAB", 1000)
    dense = {frozenset(g["shots"]) for g in tags.cluster(sets, set(sets), [], meta, set())}
    assert sparse == dense == {frozenset(range(i, i + 10)) for i in range(0, 40, 10)}


def test_excluding_every_face_leaves_a_finite_no_match_result(tmp_path):
    store = Store(tmp_path / "identity.db")
    try:
        emb = np.zeros((3, 128), np.float32)
        emb[:, 0] = 1
        store.set_meta("not_me_anchors", [emb[0].tolist()])
        photos = [{"id": i + 1} for i in range(3)]
        faces = [{"id": i + 1, "photo_id": i + 1, "px": 100, "score": 1} for i in range(3)]
        lib = library.Lib(photos, faces, {i + 1: i for i in range(3)}, {i + 1: [i] for i in range(3)},
                          np.empty((3, 768)), np.zeros(3, bool), np.empty((3, 768)), np.zeros(3, bool), emb)
        found = library.identify(lib, store)
        assert found["centroid"] is None and not found["is_me"].any()
        assert all(np.isfinite(x) for x in found["me_sim"].values())
        store.set_meta("not_me_anchors", [])
        faces[0]["label"] = "other"
        faces[1]["photo_id"] = 1
        emb[1, 1] = 0.1
        emb[1] /= np.linalg.norm(emb[1])
        lib.faces_by_photo = {1: [0, 1], 3: [2]}
        assert library.identify(lib, store)["me_face"][1] == 2
        store.set_meta("me_centroid", emb[0].tolist())
        library.refresh(store, identity_only=True)
        assert store.get_meta("me_centroid") is None
    finally:
        store.close()


def test_rescan_resets_its_show_and_keeps_one_image_generation(tmp_path, monkeypatch):
    store = Store(tmp_path / "analysis.db")
    analyzer = Analyzer(store, tmp_path / "source", tmp_path / "work")
    done = threading.Event()
    monkeypatch.setattr(analyzer, "_run", lambda: done.wait(2))
    analyzer.progress.update(faces=90, cats={"things": 30}, found={"photos": 30}, error="previous failure")
    analyzer.feed["cats"] = [[1, "things", []]]
    try:
        analyzer.start()
        assert analyzer.progress["faces"] == 0 and analyzer.progress["cats"] == {}
        assert analyzer.progress["found"] is None and analyzer.progress["error"] is None
        assert analyzer.feed["cats"] == []
        generation, worker = analyzer.started, analyzer.thread
        analyzer._set("understanding", total=10)
        analyzer.start()
        assert analyzer.started == generation and analyzer.thread is worker
    finally:
        done.set()
        analyzer.thread.join()
        store.close()


def test_shutdown_joins_refresh_and_releases_derived_state(tmp_path, monkeypatch):
    s = Session(tmp_path / "photos", tmp_path / "save")
    entered, finish, stopped = threading.Event(), threading.Event(), threading.Event()

    def refresh(store):
        entered.set()
        assert finish.wait(2)
        store.set_meta("finished", True)

    monkeypatch.setattr(library, "regroup", refresh)
    library._BASE[str(s.store.path)] = {"synthetic": True}
    s.refresh_async(full=False)
    assert entered.wait(1)
    worker = threading.Thread(target=lambda: (s.shutdown(), stopped.set()))
    worker.start()
    try:
        assert not stopped.wait(0.05)
    finally:
        finish.set()
        worker.join(2)
    assert stopped.is_set() and s.store._closed and s._refresh_error is None
    assert str(s.store.path) not in library._BASE
    s.analyzer.start()
    assert s.analyzer.thread is None
    prior = s._refresh_thread
    s.refresh_async()
    assert s._refresh_thread is prior


def test_merge_suggestions_keep_the_exact_best_pairs_after_rejections(tmp_path):
    store = Store(tmp_path / "suggestions.db")
    try:
        with store.tx() as c:
            for pid in range(1, 81):
                c.execute("INSERT INTO photos(id,rel,status,emb,taken_ts) VALUES(?,?,'analyzed',?,1)",
                          (pid, f"synthetic-{pid}.jpg", f16(np.array([1, 0], np.float32))))
                c.execute("INSERT INTO groups(id,rep,members) VALUES(?,?,?)", (pid, pid, f"[{pid}]"))
        dismissed = {(79, 80), (78, 80)}
        store.set_meta("stack_dismissed", sorted(dismissed))
        expected = sorted(set(combinations(range(1, 81), 2)) - dismissed, reverse=True)[:7]
        found = library.suggest_merges(store, limit=7)
        assert [(p["a"], p["b"]) for p in found] == expected
        assert library.suggest_merges(store, limit=0) == []
    finally:
        store.close()


def test_stack_tag_suggestions_include_the_other_takes(client):
    s = client.matcher.session
    s.ensure_ranker()
    stack = next(g for g in s.groups.values() if len(g["members"]) > 1)
    take = next(p for p in stack["members"] if p != stack["rep"])
    with s.store.tx() as c:
        c.execute("INSERT INTO tags(key,label) VALUES('u:only-take','Only on another take')")
        c.execute("INSERT INTO tag_edits(photo_id,tag,val) VALUES(?,'u:only-take',1)", (take,))
    assert "u:only-take" in s.draw.tag_sets()[stack["rep"]]


def test_suggest_merges_reports_the_total_beyond_its_cap(tmp_path):
    """The Twin check counts every qualifying pair, not just the capped page it is handed."""
    store = Store(tmp_path / "totals.db")
    try:
        with store.tx() as c:
            for pid in range(1, 81):
                c.execute("INSERT INTO photos(id,rel,status,emb,taken_ts) VALUES(?,?,'analyzed',?,1)",
                          (pid, f"synthetic-{pid}.jpg", f16(np.array([1, 0], np.float32))))
                c.execute("INSERT INTO groups(id,rep,members) VALUES(?,?,?)", (pid, pid, f"[{pid}]"))
        store.set_meta("stack_dismissed", [[79, 80], [78, 80]])
        page, total = library.suggest_merges(store, limit=2, with_total=True)
        assert len(page) == 2
        assert total == len(list(combinations(range(1, 81), 2))) - 2
        assert library.suggest_merges(store, limit=0, with_total=True) == ([], 0)
        assert len(library.suggest_merges(store)) == 60  # the plain call still returns the capped page
    finally:
        store.close()
