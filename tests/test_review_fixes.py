"""Regression tests for the issues the October review found (each failed before its fix)."""
import json
import threading
import time
from datetime import datetime

import numpy as np
import pytest
from PIL import Image

from matcher import analyze, imageio, library
from matcher import ranker as R
from matcher.server import _slug, create_app, leaderboard_size
from tests.conftest import _unit, build_library, write_photo

H = {"X-MatchER": "1"}


def post(c, path, body=None):
    return c.post(path, json=body or {}, headers=H)


@pytest.fixture
def client(tmp_path, fake_prompts):
    src = tmp_path / "photos"
    data = tmp_path / "data"
    work = data / _slug(src.resolve())
    store, _ = build_library(src, work, n_singles=40, bursts=((5, "burst"), (3, "duo")))
    library.refresh(store)
    store.set_meta("analyzed_at", time.time())
    store.set_meta("source", str(src.resolve()))
    library.release(store)
    store.close()
    app = create_app(data, allowed_hosts={"localhost"})
    app.config["MATCHER"].open(src, start=False)
    c = app.test_client()
    c.matcher, c.src, c.data = app.config["MATCHER"], src, data
    yield c
    c.matcher.close()
    for session in c.matcher._sessions.values():
        session.shutdown()


def duels(c, n, outcome="a"):
    cards = post(c, "/api/deal?n=1").get_json()["cards"]
    for _ in range(n):
        card = cards[0]
        r = post(c, "/api/vote", {"card": card["id"], "outcome": outcome if card["type"] == "duel" else "a", "ms": 900}).get_json()
        cards = r["cards"]
    return r


def play_finals(c):
    f = post(c, "/api/finals/start").get_json()
    while f["card"]:
        f = post(c, "/api/vote", {"card": f["card"]["id"], "outcome": "b", "ms": 1200}).get_json()
    return f["finals"]


# ---------------------------------------------------------------- the arc
def test_the_sweep_runs_out_and_can_be_marked_done(client):
    cards = client.get("/api/sweep").get_json()["cards"]
    assert len(cards) <= 30
    for c in cards:
        post(client, "/api/sweep", {"photo": c["photo"], "keep": True})
    assert client.get("/api/sweep").get_json()["cards"] == []          # no endless refill of "weak" photos
    assert client.get("/api/journey").get_json()["stages"]["sweep"]["done"]


def test_the_finals_decide_the_top_of_the_leaderboard_and_the_export(client):
    duels(client, 25)
    st = play_finals(client)
    items = client.get("/api/shortlist").get_json()["items"]
    assert [x["photo"] for x in items[:3]] == [st["champion"], st["runner_up"], st["bronze"]]
    assert client.get("/api/reveal").get_json()["top"][0]["photo"] == st["champion"]
    r = post(client, "/api/export", {"kind": "bestof"}).get_json()
    first = sorted(p.name for p in __import__("pathlib").Path(r["dir"]).iterdir())[0]
    rel = next(x["rel"] for x in items if x["photo"] == st["champion"])
    assert first.startswith("01 - ") and first.endswith(rel.rsplit("/", 1)[-1])


def test_replaying_the_finals_clears_the_old_champion_and_undo_keeps_the_replay(client):
    s = client.matcher.session
    duels(client, 20)
    play_finals(client)
    assert s.store.get_meta("champions")["all"]
    post(client, "/api/finals/reset")
    assert "all" not in (s.store.get_meta("champions") or {})
    new = post(client, "/api/finals/start").get_json()["finals"]
    post(client, "/api/undo")                                           # the last vote belongs to the old bracket
    assert s.finals_state()["id"] == new["id"] and s.finals_state()["champion"] is None


# ---------------------------------------------------------------- what the model learns from
def test_sweep_tosses_and_mini_tournament_calls_teach_the_model(client):
    s = client.matcher.session
    kept = next(c for c in client.get("/api/sweep").get_json()["cards"] if c["kind"] == "kept")
    post(client, "/api/sweep", {"photo": kept["photo"], "keep": False})
    cards = post(client, "/api/deal?n=1&stage=stacks").get_json()["cards"]
    while cards:
        cards = post(client, "/api/vote", {"card": cards[0]["id"], "outcome": "a", "stage": "stacks"}).get_json()["cards"]
    obs, _, _ = s._observations()
    assert any(o.kind == "below" and s.reps[o.i] == kept["photo"] for o in obs)
    assert any(o.kind == "pair" for o in obs)


def test_rematches_are_called_out(client):
    s = client.matcher.session
    s.ensure_ranker()
    with s.lock:
        card = s._card("duel", ia=0, ib=1, a=s.reps[0], b=s.reps[1])
    post(client, "/api/vote", {"card": card["id"], "outcome": "a"})
    with s.lock:
        again = s._card("duel", ia=0, ib=1, a=s.reps[0], b=s.reps[1])
    r = post(client, "/api/vote", {"card": again["id"], "outcome": "a"}).get_json()
    assert r["story"] in ("rematch", "upset")


# ---------------------------------------------------------------- robustness
def test_a_vote_never_waits_behind_a_background_refresh(client):
    s = client.matcher.session
    s.ensure_ranker()
    s.store.set_meta("state_version", time.time())                     # a newer state is on disk...
    held = threading.Event()
    release = threading.Event()

    def hold():
        with s.store.refresh_lock:                                      # ...and a refresh is still writing it
            held.set()
            release.wait(5)
    threading.Thread(target=hold, daemon=True).start()
    held.wait(2)
    t0 = time.time()
    r = post(client, "/api/deal?n=1")
    release.set()
    assert r.status_code == 200 and time.time() - t0 < 1.0


def test_a_toss_survives_an_older_snapshot(client):
    s = client.matcher.session
    s.ensure_ranker()
    victim = s.reps[3]
    with s.store.tx() as c:                                             # tossed, but features.npz not rewritten yet
        c.execute("UPDATE photos SET override='toss' WHERE id=?", (victim,))
    s.version = None
    s.ensure_ranker(wait=True)
    assert not s.ranker.active[s._item(victim)]


def test_crowning_a_frame_keeps_its_stack_together(client):
    s = client.matcher.session
    s.ensure_ranker()
    gid, g = next((gid, g) for gid, g in s.groups.items() if len(g["members"]) == 5)
    worst = g["members"][-1]
    post(client, "/api/frame", {"photo": worst})
    s.ensure_ranker(wait=True)
    assert sorted(s.groups[s.photo_group[worst]]["members"]) == sorted(g["members"])


def test_people_keys_are_stable_and_corrections_undo(client):
    s = client.matcher.session
    keys = [p["key"] for p in client.get("/api/people").get_json()["people"]]
    library.refresh(s.store)
    assert [p["key"] for p in client.get("/api/people").get_json()["people"]] == keys
    me_before = s.store.one("SELECT COUNT(*) AS n FROM photos WHERE me_face IS NOT NULL")["n"]
    post(client, "/api/people/0", {"action": "not_me"})
    library.refresh(s.store)
    assert client.get("/api/people").get_json()["last"] == "not_me"
    post(client, "/api/people/undo")
    library.refresh(s.store)
    assert s.store.get_meta("not_me_anchors") == []
    assert s.store.one("SELECT COUNT(*) AS n FROM photos WHERE me_face IS NOT NULL")["n"] == me_before


def test_forgetting_a_library_deletes_its_data_but_not_the_photos(client):
    work = client.matcher.session.workdir
    photos = sorted(p.name for p in client.src.rglob("*.jpg"))
    post(client, "/api/library/forget", {"path": str(client.src)})
    assert not work.exists() and sorted(p.name for p in client.src.rglob("*.jpg")) == photos
    assert client.get("/api/state").get_json()["library"] is None


def test_only_export_folders_can_be_opened(client):
    assert post(client, "/api/open", {"path": str(client.matcher.session.workdir)}).status_code == 403
    assert post(client, "/api/open", {"path": "/etc"}).status_code == 403


def test_achievements_stay_earned(client):
    duels(client, 1)
    assert "first" in client.get("/api/game").get_json()["stats"]["unlocked"]
    while post(client, "/api/undo").get_json()["undone"]:
        pass
    assert "first" in client.get("/api/game").get_json()["stats"]["unlocked"]


# ---------------------------------------------------------------- measurements and limits
def test_a_grey_photo_is_black_and_white(lib_env):
    src, work, store, specs = lib_env
    with store.tx() as c:
        c.execute("UPDATE photos SET chroma=0.0 WHERE rel='cam/IMG_0001.jpg'")
    library.refresh(store)
    flags = json.loads(store.one("SELECT flags FROM photos WHERE rel='cam/IMG_0001.jpg'")["flags"])
    assert "bw" in flags                                               # 0.0 used to count as "no measurement"


def test_huge_libraries_stack_without_the_all_pairs_matrix(lib_env, monkeypatch):
    src, work, store, specs = lib_env
    library.refresh(store)
    small = {r["rel"]: r["group_id"] for r in store.q("SELECT rel, group_id FROM photos")}
    monkeypatch.setattr(library, "SIMS_MAX", 3)
    library._BASE.clear()
    library.refresh(store)
    big = {r["rel"]: r["group_id"] for r in store.q("SELECT rel, group_id FROM photos")}
    assert len({big[f"cam/burst_{k}.jpg"] for k in range(4)}) == 1     # the burst still stacks
    assert big == small


def test_leaderboard_size_fits_the_folder():
    assert leaderboard_size(1, 40) == 1 and leaderboard_size(3, 40) == 1 and leaderboard_size(12, 40) == 6
    assert leaderboard_size(58, 40) == 14 and leaderboard_size(800, 40) == 40


def test_oversized_images_and_folders_are_refused(tmp_path, monkeypatch):
    p = tmp_path / "big.png"
    Image.new("RGB", (300, 200), (1, 2, 3)).save(p)
    monkeypatch.setattr(imageio, "MAX_PIXELS_FULL", 1000)
    with pytest.raises(ValueError):
        imageio.decode(p)
    for k in range(3):
        write_photo(tmp_path / "lib" / f"{k}.jpg", (10, 10, 10), datetime(2025, 1, 1), size=(500, 500))
    with pytest.raises(analyze.TooManyPhotos):
        analyze.list_photos(tmp_path / "lib", limit=1)


# ---------------------------------------------------------------- the ranker
def test_membership_fills_the_top_k_even_with_big_scenes():
    rng = np.random.default_rng(0)
    n, k = 1900, 40
    scenes = np.concatenate([np.repeat(np.arange(4), 100), np.arange(4, 1504)])
    r = R.Ranker(rng.normal(size=(n, 4)), np.zeros(4), np.ones(4), scenes, k=k, cap=3)
    mu = np.concatenate([np.full(400, 3.0), rng.normal(size=1500)])
    assert abs(r.membership(mu, np.full(n, 0.3)).sum() - k) < 1e-6


def test_the_big_library_fit_matches_the_exact_one(monkeypatch):
    rng = np.random.default_rng(1)
    n, d = 400, 8
    X = rng.normal(size=(n, d))
    theta = X @ rng.normal(size=d) * 0.5
    obs = []
    for _ in range(900):
        i, j = rng.choice(n, 2, replace=False)
        w = i if rng.random() < 1 / (1 + np.exp(theta[j] - theta[i])) else j
        obs.append(R.Obs("duel", int(w), int(j if w == i else i)))
    obs.append(R.Obs("pair", -1, w=0.5, vec=_unit(rng.normal(size=d))))

    def fit(big):
        monkeypatch.setattr(R, "BIG_NB", big)
        r = R.Ranker(X, np.zeros(d), np.full(d, 0.5), np.arange(n), k=20)
        r.fit(obs)
        return r.post
    exact, approx = fit(10**9), fit(0)
    assert np.abs(exact.mu - approx.mu).max() < 1e-6
    assert np.median(approx.var / exact.var) == pytest.approx(1.0, abs=0.1)


def test_group_edits_undo_in_one_step(client):
    s = client.matcher.session
    s.ensure_ranker()
    before = {r["id"]: (r["group_id"], r["stack_key"]) for r in s.store.q("SELECT id, group_id, stack_key FROM photos")}
    singles = [x["rep"] for x in client.get("/api/groups?view=all&order=time").get_json()["shots"] if len(x["members"]) == 1]
    post(client, "/api/groups/merge", {"photos": singles[:3]})
    assert client.get("/api/groups?view=all").get_json()["undo"] == "merge"
    burst = next(g for g in s.groups.values() if len(g["members"]) == 5)
    post(client, "/api/groups/unstack", {"photo": burst["rep"]})
    assert post(client, "/api/draw/undo").get_json()["undone"] == "unstack"
    r = post(client, "/api/draw/undo").get_json()
    assert r["undone"] == "merge" and r["next"] is None
    after = {r["id"]: (r["group_id"], r["stack_key"]) for r in s.store.q("SELECT id, group_id, stack_key FROM photos")}
    assert after == before
    assert post(client, "/api/draw/undo").status_code == 400
