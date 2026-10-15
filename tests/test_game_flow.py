"""The game around the duels: gallery mode and its cups, sweeps, the stacks stage, finals, reveal, exports."""
import json
import time

import numpy as np
import pytest

from matcher import library
from matcher.server import MIN_CUP, _slug, create_app
from tests.conftest import _unit, build_library

H = {"X-MatchER": "1"}


def post(c, path, body=None):
    return c.post(path, json=body or {}, headers=H)


def _app(tmp_path, mode, craft=None):
    src = tmp_path / "photos"
    data = tmp_path / "data"
    work = data / _slug(src.resolve())
    store, specs = build_library(src, work, n_singles=40, bursts=((5, "burst"), (3, "duo")))
    store.set_meta("settings", {"mode": mode})
    if craft:
        craft(store)
    library.refresh(store)
    store.set_meta("analyzed_at", time.time())
    store.set_meta("source", str(src.resolve()))
    app = create_app(data, allowed_hosts={"localhost"})
    app.config["MATCHER"].open(src, start=False)
    c = app.test_client()
    c.matcher = app.config["MATCHER"]
    c.src = src
    return c


@pytest.fixture
def client(tmp_path, fake_prompts):
    c = _app(tmp_path, "me")
    yield c
    for session in c.matcher._sessions.values():
        session.shutdown()


@pytest.fixture
def gallery(tmp_path, fake_prompts, monkeypatch):
    """Gallery mode, with 14 landscapes and 14 plates of food among the singles (enough for two cups). With fake
    prompt embeddings the zero-shot scores would be noise, so they're pinned to "nothing special"."""
    monkeypatch.setattr(library, "zero_shot", lambda lib: {k: np.full(len(lib.photos), 0.1) for k in library.ATTRS})
    nature = fake_prompts(["a landscape photo"])[0]
    food = fake_prompts(["a photo of food on a plate"])[0]
    rng = np.random.default_rng(5)

    def craft(store):
        rows = store.q("SELECT id FROM photos WHERE rel LIKE 'cam/IMG_%' ORDER BY id")
        with store.tx() as c:
            for k, r in enumerate(rows[:28]):
                e = _unit((nature if k < 14 else food) + rng.normal(0, 0.02, 768)).astype(np.float16)
                c.execute("UPDATE photos SET emb=?, crop_emb=? WHERE id=?", (e.tobytes(), e.tobytes(), r["id"]))
    c = _app(tmp_path, "gallery", craft)
    yield c
    for session in c.matcher._sessions.values():
        session.shutdown()


def play_duels(c, n, outcome="a", lr=None):
    cards = post(c, "/api/deal?n=1").get_json()["cards"]
    last = None
    for _ in range(n):
        card = cards[0]
        if card["type"] == "mini":
            pick = "a" if card["a"] == card["champ"] else "b"
            last = post(c, "/api/vote", {"card": card["id"], "outcome": pick, "ms": 900, "lr": lr}).get_json()
        else:
            last = post(c, "/api/vote", {"card": card["id"], "outcome": outcome, "ms": 900, "lr": lr}).get_json()
        cards = last["cards"]
    return last


# ---------------------------------------------------------------- gallery mode and cups
def test_gallery_mode_keeps_everyone_and_sorts_photos_into_cups(gallery):
    s = gallery.matcher.session
    rows = {r["rel"]: dict(r) for r in s.store.q("SELECT rel, cut, category FROM photos")}
    assert all(rows[f"other/stranger_{i}.jpg"]["cut"] != "not_you" for i in range(3))   # no "is it you" rule here
    assert rows["Screenshot_20261000-101010_Chat.jpg"]["cut"] == "screenshot"
    j = gallery.get("/api/journey").get_json()
    assert j["mode"] == "gallery" and j["cup"] == "all"
    cups = {c["key"]: c for c in j["cups"]}
    assert {"all", "nature", "food"} <= set(cups) and cups["nature"]["shots"] >= MIN_CUP
    assert "aesthetic" in s.names and "nature" in s.names                         # the gallery's own features
    j = post(gallery, "/api/cup", {"cup": "nature"}).get_json()
    assert j["cup"] == "nature"
    nature = {r["id"] for r in s.store.q("SELECT id FROM photos WHERE category='nature'")}
    card = post(gallery, "/api/deal?n=1").get_json()["cards"][0]
    shown = {card["a"], card["b"]} if card["type"] == "duel" else set(card["frames"])
    assert shown <= nature
    assert post(gallery, "/api/cup", {"cup": "nowhere"}).status_code == 400


def test_switching_modes_in_settings_rejudges_the_library(client):
    s = client.matcher.session
    q = "SELECT COUNT(*) AS n FROM photos WHERE cut='not_you'"
    assert s.store.one(q)["n"] == 3
    assert post(client, "/api/settings", {"mode": "gallery"}).get_json()["settings"]["mode"] == "gallery"
    t0 = time.time()
    while time.time() - t0 < 10 and s.store.one(q)["n"]:
        time.sleep(0.05)
    assert s.store.one(q)["n"] == 0


# ---------------------------------------------------------------- feedback in the duels
def test_duel_answers_report_rank_moves_and_lightning_rounds_keep_a_record(client):
    r = play_duels(client, 1)
    assert r["ranks"] and all({"photo", "rank", "was"} <= set(x) for x in r["ranks"])
    play_duels(client, 6, lr="round-1")
    g = client.get("/api/game").get_json()["stats"]
    assert g["lightning_best"] == 6 and g["today"] >= 7 and g["days"] == 1


# ---------------------------------------------------------------- sweep
def test_sweep_rescues_and_tosses_and_undo_puts_it_back(client):
    s = client.matcher.session
    cards = client.get("/api/sweep").get_json()["cards"]
    cut = next(c for c in cards if c["kind"] == "cut")
    kept = next(c for c in cards if c["kind"] == "kept")
    assert post(client, "/api/sweep", {"photo": cut["photo"], "keep": True}).get_json()["change"] == "keep"
    assert post(client, "/api/sweep", {"photo": kept["photo"], "keep": False}).get_json()["change"] == "toss"
    assert s.store.one("SELECT override FROM photos WHERE id=?", (kept["photo"],))["override"] == "toss"
    left = {c["photo"] for c in client.get("/api/sweep").get_json()["cards"]}
    assert cut["photo"] not in left and kept["photo"] not in left                  # each photo is asked once
    u = post(client, "/api/undo").get_json()
    assert u["undone"] == "sweep" and u["photo"] == kept["photo"]
    assert s.store.one("SELECT override FROM photos WHERE id=?", (kept["photo"],))["override"] is None
    assert client.get("/api/game").get_json()["stats"]["sweep"] == 1


# ---------------------------------------------------------------- stacks stage
def test_the_stacks_stage_plays_only_mini_tournaments(client):
    r = post(client, "/api/deal?n=1&stage=stacks").get_json()
    left = r["left"]
    assert left >= 1 and r["cards"][0]["type"] == "mini"
    card, crowned = r["cards"][0], 0
    for _ in range(40):
        v = post(client, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "stacks"}).get_json()
        crowned += bool(v.get("crowned"))
        if not v["cards"]:
            break
        card = v["cards"][0]
        assert card["type"] == "mini"
    assert crowned >= left                     # crowning one can make another worth crowning
    assert post(client, "/api/deal?n=1&stage=stacks").get_json()["left"] == 0


# ---------------------------------------------------------------- finals
def test_finals_seed_a_bracket_crown_a_champion_and_undo_steps_back(client):
    s = client.matcher.session
    play_duels(client, 30)
    f = post(client, "/api/finals/start").get_json()
    st = f["finals"]
    assert st["size"] == 8 and [m["round"] for m in st["matches"]] == ["qf"] * 4 + ["sf"] * 2 + ["bronze", "final"]
    assert (st["matches"][0]["a"], st["matches"][0]["b"]) == (st["seeds"][0], st["seeds"][7])
    played = []
    while f["card"]:
        card = f["card"]
        played.append(card["round"])
        assert post(client, "/api/vote", {"card": card["id"], "outcome": "great"}).status_code == 400  # no ties
        f = client.get("/api/finals").get_json()
        card = f["card"]
        f = post(client, "/api/vote", {"card": card["id"], "outcome": "a", "ms": 1500}).get_json()
    assert played == ["qf"] * 4 + ["sf"] * 2 + ["bronze", "final"]
    st = f["finals"]
    assert st["champion"] == st["seeds"][0] and st["bronze"] and st["runner_up"]
    assert s.store.get_meta("champions")["all"] == st["champion"]
    j = client.get("/api/journey").get_json()
    assert j["stages"]["finals"]["state"] == "done" and j["cups"][0]["champion"] == st["champion"]
    rv = client.get("/api/reveal").get_json()
    assert rv["from_finals"] and rv["podium"][0] == st["champion"] and len(rv["podium"]) == 3
    assert "champion" in client.get("/api/game").get_json()["stats"]["unlocked"]
    u = post(client, "/api/undo").get_json()
    assert u["undone"] == "final" and u["finals"]["champion"] is None and u["card"]["round"] == "final"
    assert "all" not in (s.store.get_meta("champions") or {})


# ---------------------------------------------------------------- exports
def test_best_of_export_keeps_the_original_files(client):
    play_duels(client, 5)
    r = post(client, "/api/export", {"kind": "bestof"}).get_json()
    out = __import__("pathlib").Path(r["dir"])
    files = sorted(p.name for p in out.iterdir() if p.is_file())
    assert r["count"] == len(files) and files[0].startswith("01 - ")
    touched = sorted(p.name for p in (out / "touched up").iterdir())  # the same shots with Enhance baked in
    assert r["touched"] == len(touched) == len(files) and touched[0] == files[0].rsplit(".", 1)[0] + ".jpg"
    rel = next(x for x in client.get("/api/shortlist").get_json()["items"] if x["rank"] == 1)["rel"]
    assert (__import__("pathlib").Path(r["dir"]) / files[0]).read_bytes() == (client.src / rel).read_bytes()
    assert "ship" in client.get("/api/game").get_json()["stats"]["unlocked"]
