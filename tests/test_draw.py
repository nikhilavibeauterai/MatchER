"""The Draw (themed groups), the group stage it feeds, and the knockouts after it."""
import time
from datetime import datetime

import numpy as np
import pytest

from matcher import library, tags, themes
from matcher.server import _slug, create_app
from matcher.store import f16
from tests.conftest import _unit, build_library

H = {"X-MatchER": "1"}


def post(c, path, body=None):
    return c.post(path, json=body or {}, headers=H)


@pytest.fixture
def client(tmp_path, fake_prompts):
    """40 singles in four looks (ten each), a burst, plus the usual strangers and oddities; two of one look's
    singles are near-twins taken weeks apart (the stacking leaves them apart; the Draw asks)."""
    src = tmp_path / "photos"
    data = tmp_path / "data"
    work = data / _slug(src.resolve())
    store, specs = build_library(src, work, n_singles=40, bursts=((4, "burst"),))
    rng = np.random.default_rng(5)
    centers = [_unit(rng.normal(0, 1, 768)) for _ in range(4)]
    with store.tx() as c:
        for i in range(40):
            e = _unit(centers[i % 4] + rng.normal(0, 0.035, 768))
            if i == 4:  # a near-twin of IMG_0000 (same look), 12 hours later
                e = _unit(np.frombuffer(c.execute("SELECT emb FROM photos WHERE rel='cam/IMG_0000.jpg'").fetchone()[0],
                                        np.float16).astype(np.float32) + rng.normal(0, 0.012, 768))
            c.execute("UPDATE photos SET emb=?, crop_emb=? WHERE rel=?", (f16(e), f16(e), f"cam/IMG_{i:04d}.jpg"))
    library.refresh(store)
    store.set_meta("analyzed_at", time.time())
    store.set_meta("source", str(src.resolve()))
    app = create_app(data, allowed_hosts={"localhost"})
    app.config["MATCHER"].open(src, start=False)
    c = app.test_client()
    c.matcher = app.config["MATCHER"]
    yield c
    c.matcher.close()
    for session in c.matcher._sessions.values():
        session.shutdown()


def single(c, k):
    """The photo id of single number k (cam/IMG_000k)."""
    s = c.matcher.session
    s.ensure_ranker()
    return s.store.one("SELECT id FROM photos WHERE rel=?", (f"cam/IMG_{k:04d}.jpg",))["id"]


def rel_of(c, pid):
    return c.matcher.session.store.one("SELECT rel FROM photos WHERE id=?", (pid,))["rel"]


def look(c, pid):
    """Which of the four looks a single belongs to (None for anything else)."""
    r = rel_of(c, pid)
    return int(r[8:12]) % 4 if r.startswith("cam/IMG_") else None


def test_a_group_starts_from_photos_with_a_name_and_deals_likely_matches(client):
    st = client.get("/api/draw/board").get_json()
    assert st["drawn"] == 0 and st["total"] > 40 and st["groups"] == []
    seed = single(client, 0)
    t = post(client, "/api/draw/new", {"photos": [seed]}).get_json()["theme"]
    assert t["name"] and t["emoji"] and t["size"] == 1
    d = client.get(f"/api/draw/deck?theme={t['id']}&n=10").get_json()
    dealt = d["bulk"] + d["cards"]
    assert [look(client, x["photo"]) for x in dealt[:8]] == [look(client, seed)] * 8   # its own look first
    for x in dealt[:5]:
        post(client, "/api/draw/call", {"theme": t["id"], "photo": x["photo"], "call": "in", "ms": 700})
    other = dealt[5]
    post(client, "/api/draw/call", {"theme": t["id"], "photo": other["photo"], "call": "out"})
    d2 = client.get(f"/api/draw/deck?theme={t['id']}").get_json()
    assert other["photo"] not in [x["photo"] for x in d2["bulk"] + d2["cards"]]    # "out" isn't offered again
    assert d2["theme"]["size"] == 6
    st = client.get("/api/draw/board").get_json()
    assert st["drawn"] >= 6 and len(st["groups"]) == 1 and "draw1" in st["game"]["unlocked"]
    b = client.get("/api/draw/board?per=4").get_json()
    assert b["groups"][0]["count"] == 6 and len(b["groups"][0]["shots"]) == 4
    assert b["unsorted"]["count"] == st["total"] - st["drawn"] and [x["id"] for x in b["bins"]] == [t["id"]]
    many = post(client, "/api/draw/new", {"photos": [single(client, 1), single(client, 5)]}).get_json()["theme"]
    assert many["size"] == 2


def test_every_draw_step_undoes_in_order(client):
    seed = single(client, 2)
    t = post(client, "/api/draw/new", {"photos": [seed]}).get_json()["theme"]
    d = client.get(f"/api/draw/deck?theme={t['id']}").get_json()
    a, b = (d["bulk"] + d["cards"])[:2]
    post(client, "/api/draw/call", {"theme": t["id"], "photo": a["photo"], "call": "in"})
    post(client, "/api/draw/call", {"theme": t["id"], "photo": b["photo"], "call": "out"})
    post(client, "/api/draw/rename", {"theme": t["id"], "name": "Testing Testing"})
    xp = client.get("/api/draw/board").get_json()["game"]["xp"]
    assert post(client, "/api/draw/undo").get_json()["undone"] == "rename"
    assert client.get(f"/api/draw/deck?theme={t['id']}").get_json()["theme"]["name"] == t["name"]
    assert post(client, "/api/draw/undo").get_json()["undone"] == "not this one"
    assert b["photo"] in [x["photo"] for x in sum((lambda d: [d["bulk"], d["cards"]])(
        client.get(f"/api/draw/deck?theme={t['id']}&n=20").get_json()), [])]
    assert post(client, "/api/draw/undo").get_json()["undone"] == "add"
    assert client.get(f"/api/draw/deck?theme={t['id']}").get_json()["theme"]["size"] == 1
    assert client.get("/api/draw/board").get_json()["game"]["xp"] < xp                  # the XP goes back too
    assert post(client, "/api/draw/undo").get_json()["undone"] == "new group"
    st = client.get("/api/draw/board").get_json()
    assert st["groups"] == [] and st["drawn"] == 0


def test_a_near_twin_asks_same_moment_and_stacks_into_the_group(client):
    s = client.matcher.session
    s.ensure_ranker()
    first = s.store.one("SELECT id FROM photos WHERE rel='cam/IMG_0000.jpg'")["id"]
    twin = s.store.one("SELECT id FROM photos WHERE rel='cam/IMG_0004.jpg'")["id"]
    assert s.photo_group[first] != s.photo_group[twin]                           # the stacking left them apart
    t = post(client, "/api/draw/new", {"photos": [first]}).get_json()["theme"]
    d = client.get(f"/api/draw/deck?theme={t['id']}").get_json()
    card = next(x for x in d["cards"] if x["photo"] == twin)
    assert card["twin"]["of"] == first
    post(client, "/api/draw/call", {"theme": t["id"], "photo": twin, "call": "twin", "twin": first})
    s = client.matcher.session
    assert s.photo_group[first] == s.photo_group[twin]                           # one stack now…
    assert client.get(f"/api/draw/deck?theme={t['id']}").get_json()["theme"]["size"] == 1   # …one shot in the group
    assert post(client, "/api/draw/undo").get_json()["undone"] == "twin"
    s = client.matcher.session
    assert s.photo_group[first] != s.photo_group[twin]


def test_the_auto_draw_puts_every_shot_in_a_sealed_group(client):
    r = post(client, "/api/draw/auto").get_json()
    assert r["groups"] >= 4
    st = client.get("/api/draw/board").get_json()
    assert st["done"] and st["drawn"] == st["total"]
    assert all(g["sealed"] for g in st["groups"])
    s = client.matcher.session
    tm = s.draw.theme_of()
    for g in st["groups"]:  # the four looks never share a group (the wildcards are a mixed bag by design)
        if g["concept"] == "wild":
            continue
        looks = {look(client, s.reps[i]) for i in np.flatnonzero(tm == g["id"])} - {None}
        assert len(looks) <= 1, (g["name"], looks)
    assert client.get("/api/journey").get_json()["stages"]["draw"]["done"]


def test_the_group_stage_plays_inside_groups_then_hands_over_to_the_knockouts(client):
    post(client, "/api/draw/auto")
    s = client.matcher.session
    nxt = post(client, "/api/deal?n=1").get_json()
    assert nxt["stage"] == "groups"
    seen_settle = False
    for _ in range(400):
        cards = nxt["cards"]
        if not cards:
            break
        card = cards[0]
        if card["type"] == "duel":
            assert card["group"]["letter"]
            tm = s.draw.theme_of()
            assert tm[s._item(card["a"])] == tm[s._item(card["b"])] == card["group"]["id"]
        outcome = "a" if card["type"] != "duel" or rel_of(client, card["a"]) < rel_of(client, card["b"]) else "b"
        nxt = post(client, "/api/vote", {"card": card["id"], "outcome": outcome, "ms": 900, "stage": "groups"}).get_json()
        if nxt.get("group", {}).get("just_settled"):
            seen_settle = True
            tab = nxt["group"]
            assert sum(r["through"] for r in tab["rows"]) == tab["adv"]
            assert sum(r["w"] for r in tab["rows"]) == sum(r["l"] for r in tab["rows"])
    assert seen_settle
    j = client.get("/api/journey").get_json()["stages"]["groups"]
    assert j["done"] and j["settled"] == j["groups"]
    assert post(client, "/api/deal?n=1").get_json()["stage"] == "knockouts"
    out = s.draw.outside_knockouts()
    assert out                                                                   # someone went home…
    for _ in range(10):
        nxt = post(client, "/api/deal?n=2&stage=knockouts").get_json()
        for card in nxt["cards"]:
            if card["type"] == "duel":
                assert s._item(card["a"]) not in out and s._item(card["b"]) not in out   # …and doesn't play on
    g = client.get("/api/game").get_json()["stats"]
    assert {"group1", "ko", "drawn"} <= set(g["unlocked"])


def test_undo_in_the_duels_never_takes_back_a_draw_call(client):
    nxt = post(client, "/api/deal?n=1&stage=open").get_json()
    card = nxt["cards"][0]
    post(client, "/api/vote", {"card": card["id"], "outcome": "a", "ms": 800})
    post(client, "/api/draw/new", {"photos": [single(client, 3)]})
    r = post(client, "/api/undo", {}).get_json()
    assert r["undone"] in ("duel", "mini", "frame")
    assert len(client.get("/api/draw/board").get_json()["groups"]) == 1


def test_names_taglines_places_and_letters():
    assert themes.letter(0) == "A" and themes.letter(25) == "Z" and themes.letter(26) == "AA"
    d = lambda *a: datetime(*a).timestamp()  # noqa: E731
    assert themes.tagline([d(2024, 7, 3, 10), d(2024, 7, 3, 18)]) == "3 Jul 2024"
    assert themes.tagline([d(2024, 7, 3), d(2024, 7, 20)]) == "July 2024"
    assert themes.tagline([d(2024, 6, 25), d(2024, 7, 20), d(2024, 8, 10)]) == "Summer 2024"
    assert themes.tagline([d(2019, 1, 1), d(2023, 1, 1)]) == "2019–2023"
    assert themes.tagline([None, None, d(2024, 1, 1)]) == ""                       # too few dated to say
    adv = themes.advancers({1: 10, 2: 30, 3: 1, 4: 3}, k=8)
    assert adv[3] == 1 and adv[4] == 1 and adv[2] > adv[1] >= 1 and adv[1] <= 5
    assert sum(adv.values()) <= 2 * 8 + 2


def test_auto_draw_keeps_clusters_apart_and_caps_big_ones():
    rng = np.random.default_rng(3)
    centers = [_unit(rng.normal(0, 1, 64)) for _ in range(3)]
    E = np.stack([_unit(centers[k] + rng.normal(0, 0.03, 64)) for k in (0,) * 90 + (1,) * 12 + (2,) * 12])
    E = np.vstack([E, np.stack([_unit(rng.normal(0, 1, 64)) for _ in range(30)])])  # noise
    groups, wild = themes.auto_draw(E.astype(np.float32), np.arange(len(E)), cap=40)
    for g in groups:
        assert len(g) <= 40 + 10
        assert len({min(i // 90, 1) if i < 90 else (1 if i < 102 else 2 if i < 114 else 3 + i) for i in g}) == 1
    assert sum(len(g) for g in groups if g[0] < 90) >= 85                        # the big look in three runs
    assert 3 <= len([g for g in groups if g[0] < 90]) <= 5
    assert len(wild) >= 20


def test_each_folder_is_a_save_with_its_own_level_and_you_can_switch(tmp_path, fake_prompts, monkeypatch):
    # These libraries already have synthetic analysis; switching saves must not launch real model workers.
    monkeypatch.setattr("matcher.server.Analyzer.start", lambda self: None)
    data = tmp_path / "data"
    srcs = [tmp_path / "trips", tmp_path / "pets"]
    for k, src in enumerate(srcs):
        store, _ = build_library(src, data / _slug(src.resolve()), n_singles=12, bursts=(), seed=k)
        library.refresh(store)
        store.set_meta("analyzed_at", time.time())
        store.set_meta("source", str(src.resolve()))
        store.set_meta("settings", {"mode": "gallery" if k == 0 else "me"})
    app = create_app(data, allowed_hosts={"localhost"})
    c = app.test_client()
    for src in srcs:
        assert post(c, "/api/library", {"path": str(src)}).status_code == 200
    duels_left = 6
    nxt = post(c, "/api/deal?n=1&stage=open").get_json()
    while duels_left:  # play a little in "pets" (open now): its level moves, "trips" stays put
        card = nxt["cards"][0]
        nxt = post(c, "/api/vote", {"card": card["id"], "outcome": "a", "ms": 700}).get_json()
        duels_left -= 1
    saves = {s["name"]: s for s in c.get("/api/saves").get_json()["saves"]}
    assert set(saves) == {"trips", "pets"}
    assert saves["pets"]["current"] and not saves["trips"]["current"]
    assert saves["trips"]["mode"] == "gallery" and saves["pets"]["mode"] == "me"
    assert saves["pets"]["xp"] > saves["trips"]["xp"] == 0
    assert saves["pets"]["photos"] > 0 and saves["pets"]["cover"]
    cover = c.get(f"/img/save/{saves['pets']['slug']}/{saves['pets']['cover']}.jpg")
    assert cover.status_code == 200 and cover.mimetype == "image/jpeg"
    assert c.get(f"/img/save/not-a-save-123/{saves['pets']['cover']}.jpg").status_code == 404
    st = post(c, "/api/library", {"path": str(srcs[0])}).get_json()               # switch back to "trips"
    assert st["library"]["mode"] == "gallery" and st["library"]["save"]["name"] == "trips"
    assert [s["current"] for s in c.get("/api/saves").get_json()["saves"] if s["name"] == "trips"] == [True]
    for session in app.config["MATCHER"]._sessions.values():
        session.shutdown()


def test_the_group_stage_finishes_with_two_cards_queued_like_the_duel_screen(client):
    """The screen keeps the next card waiting while you call this one, so that card's shots are off limits: in a small
    group this used to leave one pairing, replayed forever."""
    post(client, "/api/draw/auto")
    s = client.matcher.session
    queue = post(client, "/api/deal?n=2&stage=groups").get_json()["cards"]
    dealt = []
    for _ in range(300):
        if not queue:
            break
        card = queue.pop(0)
        if card["type"] == "duel":
            dealt.append(frozenset((card["a"], card["b"])))
        r = post(client, "/api/vote", {"card": card["id"], "outcome": "a", "ms": 800, "stage": "groups",
                                      "pending": [c["id"] for c in queue]}).get_json()
        queue += r["cards"]
    assert not queue, "the group stage never ran out of matches"
    assert client.get("/api/journey").get_json()["stages"]["groups"]["done"]
    assert len(dealt) - len(set(dealt)) <= len(dealt) // 4                       # rematches are the exception


def test_look_for_words_steer_which_photos_come_first(client, fake_prompts):
    s = client.matcher.session
    s.ensure_ranker()
    laptop = _unit(fake_prompts(["a photo of laptops"])[0] + 0.0)
    target = s.store.one("SELECT id FROM photos WHERE rel='cam/IMG_0013.jpg'")["id"]  # another look than the seed's
    with s.store.tx() as c:
        c.execute("UPDATE photos SET emb=? WHERE id=?", (f16(laptop), target))
    library.refresh(s.store)
    seed = s.store.one("SELECT id FROM photos WHERE rel='cam/IMG_0000.jpg'")["id"]
    t = post(client, "/api/draw/new", {"photos": [seed]}).get_json()["theme"]
    before = [x["photo"] for x in client.get(f"/api/draw/deck?theme={t['id']}").get_json()["cards"]]
    assert before[0] != target
    r = post(client, "/api/draw/hint", {"theme": t["id"], "hint": "laptops, screens"}).get_json()
    assert r["theme"]["hint"] == "laptops, screens"
    after = client.get(f"/api/draw/deck?theme={t['id']}").get_json()["cards"]
    assert after[0]["photo"] == target and not after[0]["long"]
    assert post(client, "/api/draw/undo").get_json()["undone"] == "look for"
    assert client.get(f"/api/draw/deck?theme={t['id']}").get_json()["theme"]["hint"] is None
    post(client, "/api/draw/rename", {"theme": t["id"], "emoji": "💻"})
    assert client.get(f"/api/draw/deck?theme={t['id']}").get_json()["theme"]["emoji"] == "💻"
    assert post(client, "/api/draw/undo").get_json()["undone"] == "emoji"


def test_the_journey_organizes_first_then_plays(client):
    j = client.get("/api/journey").get_json()
    assert j["order"] == ["filter", "stacks", "crown", "draw", "groups", "duels", "finals", "reveal"] and j["side"] == ["sweep"]
    # stacks: the near-twins the stacking left apart are there to check, and a "not twins" call can be undone
    twins = j["stages"]["stacks"]["twins"]
    assert twins >= 1
    sug = client.get("/api/groups?view=suggest").get_json()["suggestions"][0]
    post(client, "/api/groups/dismiss", {"a": sug["a"], "b": sug["b"]})
    assert client.get("/api/journey").get_json()["stages"]["stacks"]["twins"] == twins - 1
    assert post(client, "/api/draw/undo").get_json()["undone"] == "not twins"
    assert client.get("/api/journey").get_json()["stages"]["stacks"]["twins"] == twins
    # crown: every stack, and the best guesses can finish it (undoably)
    crown = j["stages"]["crown"]
    assert crown["left"] == crown["total"] >= 1                                     # every burst, not just likely winners
    r = post(client, "/api/stacks/auto").get_json()
    assert r["crowned"] == crown["left"]
    assert client.get("/api/journey").get_json()["stages"]["crown"]["left"] == 0
    assert post(client, "/api/draw/undo").get_json()["undone"] == "best guesses"
    assert client.get("/api/journey").get_json()["stages"]["crown"]["left"] == crown["left"]


def test_a_deal_lists_every_group_as_a_bin_with_the_best_fits(client):
    post(client, "/api/draw/auto")
    st = client.get("/api/draw/board").get_json()
    first = st["groups"][0]
    s = client.matcher.session
    # free one shot from another group so there's something to deal
    other = next(g for g in st["groups"] if g["id"] != first["id"] and g["size"] > 1)
    post(client, "/api/draw/move", {"photos": [other["cover"]], "theme": None})
    d = client.get(f"/api/draw/deck?theme={first['id']}").get_json()
    assert {b["id"] for b in d["bins"]} == {g["id"] for g in st["groups"]}
    card = (d["cards"] or d["bulk"])[0]
    if d["cards"]:
        assert card["fits"] and first["id"] not in card["fits"]
    r = post(client, "/api/draw/place", {"photo": card["photo"], "theme": other["id"]}).get_json()
    assert r["theme"] == other["id"]
    assert s.draw.theme_of()[s._item(card["photo"])] == other["id"]


def test_a_group_that_loses_its_last_shot_goes_away_and_undo_brings_it_back(client):
    seed = single(client, 0)
    t = post(client, "/api/draw/new", {"photos": [seed]}).get_json()["theme"]
    post(client, "/api/draw/hint", {"theme": t["id"], "hint": "dogs"})
    post(client, "/api/draw/move", {"photos": [seed], "theme": None})          # its only shot moves out
    assert client.get("/api/draw/board").get_json()["groups"] == []                   # no empty group left behind
    assert client.get(f"/api/draw/deck?theme={t['id']}").status_code == 404
    assert post(client, "/api/draw/undo").get_json()["undone"] == "unsort"
    st = client.get("/api/draw/board").get_json()
    assert [(g["id"], g["name"], g["hint"], g["size"]) for g in st["groups"]] == [(t["id"], t["name"], "dogs", 1)]


def test_your_order_of_groups_sets_their_place_and_undoes(client):
    a = post(client, "/api/draw/new", {"photos": [single(client, 0)]}).get_json()["theme"]
    b = post(client, "/api/draw/new", {"photos": [single(client, 1)]}).get_json()["theme"]
    c = post(client, "/api/draw/new", {"photos": [single(client, 2)]}).get_json()["theme"]
    ids = lambda: [g["id"] for g in client.get("/api/draw/board").get_json()["groups"]]  # noqa: E731
    assert ids() == [a["id"], b["id"], c["id"]]                                  # made order to start with
    post(client, "/api/draw/order", {"order": [c["id"], a["id"], b["id"]]})
    assert ids() == [c["id"], a["id"], b["id"]]
    assert [x["id"] for x in client.get(f"/api/draw/deck?theme={a['id']}").get_json()["bins"]] == [c["id"], a["id"], b["id"]]
    d = post(client, "/api/draw/new", {"photos": [single(client, 3)]}).get_json()["theme"]
    assert ids()[-1] == d["id"]                                                  # a new group goes last
    post(client, "/api/draw/undo")                                               # (the new group)
    assert post(client, "/api/draw/undo").get_json()["undone"] == "reorder"
    assert ids() == [a["id"], b["id"], c["id"]]


def test_quick_sort_toss_sets_a_straggler_aside_and_undo_brings_it_back(client):
    s = client.matcher.session
    first = client.get("/api/draw/stragglers").get_json()
    pid = first["cards"][0]["photo"]
    r = post(client, "/api/draw/toss", {"photo": pid}).get_json()
    assert r["tossed"] == pid and r["undo"] == "toss"
    after = client.get("/api/draw/stragglers").get_json()
    assert after["left"] == first["left"] - 1 and pid not in [c["photo"] for c in after["cards"]]
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "toss"
    assert post(client, "/api/draw/undo").get_json()["undone"] == "toss"
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] is None
    back = client.get("/api/draw/stragglers").get_json()
    assert back["left"] == first["left"] and pid in [c["photo"] for c in back["cards"]]
    assert post(client, "/api/undo").get_json()["undone"] != "toss"              # the duel's undo doesn't take it back twice


def test_the_analysis_tags_every_photo_and_your_edits_and_names_survive_a_refresh(client):
    s = client.matcher.session
    single(client, 0)
    rows, eff = tags.rows(s.store), tags.effective(s.store)
    p0, p1, p3 = single(client, 0), single(client, 1), single(client, 3)
    assert {"me", "y:2026", "season:spring"} <= eff[p0]                      # who, and when
    assert "night" in eff[p3] and "night" not in eff[p1]                       # IMG_0003 was taken at 9 pm
    friend = next(k for k in rows if k.startswith("person:"))                 # the friend in every sixth photo
    assert friend in eff[p0] and friend not in eff[p1]
    assert rows[friend]["label"] == "Person 1" and rows[friend]["family"] == "people"
    assert all(any(t.startswith("kind:") for t in eff[pid]) for pid in (p0, p1, p3))
    t = client.get("/api/draw/board?per=400&uper=600&tags=1").get_json()["tagging"]
    assert set(t["shot_tags"][str(p0)]) == eff[p0]
    assert {"key", "label", "emoji", "family", "count"} <= set(t["tags"][0])
    assert t["visible"] and all(k in {x["key"] for x in t["tags"]} for k in t["visible"])
    assert sorted(k for d in t["diagrams"] for k in d) == sorted(t["visible"])
    r = post(client, "/api/tags/set", {"photos": [p1], "on": ["night"], "off": [friend, "smiling"]}).get_json()
    assert r["undo"] == "tags" and "night" in r["on"]
    assert "night" in tags.effective(s.store)[p1]
    post(client, "/api/tags/meta", {"key": friend, "label": "Sam", "pinned": True})
    library.refresh(s.store)                                                   # automatic tags are rewritten...
    rows, eff = tags.rows(s.store), tags.effective(s.store)
    assert rows[friend]["label"] == "Sam" and rows[friend]["pinned"]          # ...your names and edits stay
    assert "night" in eff[p1]
    assert friend in client.get("/api/draw/board?per=400&uper=600&tags=1").get_json()["tagging"]["visible"]
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit tag"
    assert post(client, "/api/draw/undo").get_json()["undone"] == "tags"
    assert "night" not in tags.effective(s.store)[p1]


def test_your_own_tag_and_a_group_from_a_tag_suggestion(client):
    s = client.matcher.session
    open_reps = [x["rep"] for x in client.get("/api/draw/board?per=400&uper=600").get_json()["unsorted"]["shots"]]
    six = open_reps[:6]
    r = post(client, "/api/tags/new", {"label": "Beach day", "emoji": "🏖️", "photos": six}).get_json()
    assert r["key"] == "u:beach-day" and r["shots"] == 6
    t = client.get("/api/draw/board?per=400&uper=600&tags=1").get_json()["tagging"]
    assert t["shot_tags"][str(six[0])] and "u:beach-day" in t["shot_tags"][str(six[0])]
    seen = set()
    for sg in t["suggestions"]:                                                # suggestions split the open shots
        assert set(sg["shots"]) <= set(open_reps) and not seen & set(sg["shots"])
        seen |= set(sg["shots"])
        assert sum(1 for rep in sg["shots"] if set(sg["tags"]) & set(t["shot_tags"][str(rep)])) >= len(sg["shots"]) / 2
    g = post(client, "/api/tags/group", {"photos": six, "name": "Beach day", "emoji": "🏖️"}).get_json()["theme"]
    assert g["name"] == "Beach day" and g["emoji"] == "🏖️" and g["size"] == 6
    assert all(s.draw.theme_of()[s._item(p)] == g["id"] for p in six)
    assert post(client, "/api/tags/group", {"photos": six}).status_code == 400   # nothing left to group there
    assert post(client, "/api/draw/undo").get_json()["undone"] == "new group"


def test_visible_tags_diagrams_suggestions_and_names_from_tag_sets():
    sets, n = {}, iter(range(1, 1000))

    def add(k, *ts):
        for _ in range(k):
            sets[next(n)] = set(ts)
    add(8, "beach", "sunset"), add(6, "beach"), add(5, "sunset"), add(7, "cats"), add(2, "cats", "beach"), add(20)
    meta = {k: {"label": k.title(), "emoji": "x", "family": "what"} for k in ("beach", "sunset", "cats")}
    vis = tags.choose_visible(sets, meta)
    assert vis == ["beach", "cats", "sunset"]                                # most new coverage first
    assert tags.diagrams(vis, sets) == [["beach", "cats", "sunset"]]           # cats touch the beach: one diagram
    sug = tags.cluster(sets, set(sets), vis, meta, set())                     # k-means on the tags: mutually exclusive
    groups = [set(x["shots"]) for x in sug]
    assert sum(map(len, groups)) == len(set().union(*groups)) == 28            # every tagged shot once (untagged left out)
    cats = next(x for x in sug if set(range(20, 27)) <= set(x["shots"]))      # the seven cats together...
    assert "cats" in cats["tags"] and not set(range(1, 9)) & set(cats["shots"])   # ...apart from the beach sunsets
    assert any(set(range(1, 9)) <= g for g in groups)
    grouped = set(range(1, 9))                                                # once the beach sunsets are in a group
    assert not any(grouped & set(x["shots"]) for x in tags.cluster(sets, set(sets) - grouped, vis, meta, set()))
    apart = {1: {"a"}, 2: {"a"}, 3: {"b"}, 4: {"b"}, 5: {"a"}}
    assert sorted(map(sorted, tags.diagrams(["a", "b"], apart))) == [["a"], ["b"]]   # nothing shared: two diagrams
    when = {"season:summer": {"label": "Summer", "family": "when"}, "y:2024": {"label": "2024", "family": "when"},
            "beach": {"label": "Beach", "family": "what", "emoji": "🏖️"}, "person:5": {"label": "Sam", "family": "people"}}
    assert tags.name_for(["beach", "y:2024", "season:summer"], when, set()) == ("Beach Bum Era · Summer 2024", "🏖️")
    assert tags.name_for(["beach"], when, {"beach bum era"})[0] == "Salt & Sand"
    assert tags.name_for(["person:5"], when, set())[0] == "Sam"


def test_making_one_suggested_group_leaves_the_other_suggestions_where_they_were(client):
    single(client, 0)
    t = client.get("/api/draw/board?per=400&uper=600&tags=1").get_json()["tagging"]
    sugg = t["suggestions"]
    assert len(sugg) >= 2
    first, rest = sugg[0], sugg[1:]
    post(client, "/api/tags/group", {"photos": first["shots"], "name": first["name"], "emoji": first["emoji"]})
    after = client.get("/api/draw/board?per=400&uper=600&tags=1").get_json()["tagging"]["suggestions"]
    assert [(x["key"], x["name"], x["shots"]) for x in after] == [(x["key"], x["name"], x["shots"]) for x in rest]
