"""The web API end to end on a synthetic, already-analyzed library."""
import json
import time
import zipfile
from pathlib import Path

import pytest

from matcher import library
from matcher.server import _slug, create_app
from tests.conftest import build_library

H = {"X-MatchER": "1"}


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
    c.matcher = app.config["MATCHER"]
    c.src = src
    yield c
    c.matcher.close()
    for session in c.matcher._sessions.values():
        session.shutdown()


def post(c, path, body=None, **kw):
    return c.post(path, json=body or {}, headers=H, **kw)


def crown_stacks(c):
    """Play every stack's mini-tournament first, so the cards that follow are plain duels."""
    cards = post(c, "/api/deal?n=1&stage=stacks").get_json()["cards"]
    while cards:
        cards = post(c, "/api/vote", {"card": cards[0]["id"], "outcome": "a", "stage": "stacks"}).get_json()["cards"]


def wait_refresh(c, pred, timeout=10):
    s = c.matcher.session
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred(s):
            return True
        time.sleep(0.05)
    return False


def test_guards(client):
    assert client.post("/api/vote", json={}).status_code == 403                  # no app header
    assert client.get("/api/state", headers={"Host": "evil.example"}).status_code == 403
    assert client.get("/api/state").status_code == 200


def test_state_and_first_cards(client):
    st = client.get("/api/state").get_json()
    assert st["library"]["analyzed"] and st["library"]["votes"] == 0
    r = post(client, "/api/deal?n=2").get_json()
    assert len(r["cards"]) == 2 and all(c["type"] == "duel" for c in r["cards"])
    a = r["cards"][0]
    assert a["a"] != a["b"]
    assert {r["cards"][0]["a"], r["cards"][0]["b"]}.isdisjoint({r["cards"][1]["a"], r["cards"][1]["b"]})


def test_duel_flow_with_undo(client):
    crown_stacks(client)
    cards = post(client, "/api/deal?n=2").get_json()["cards"]
    first = cards[0]
    r = post(client, "/api/vote", {"card": first["id"], "outcome": "a", "ms": 900, "pending": [cards[1]["id"]]}).get_json()
    assert r["progress"]["votes"] == 1 and len(r["cards"]) == 1
    for outcome in ("great", "meh", "skip"):
        nxt = r["cards"][0]
        r = post(client, "/api/vote", {"card": nxt["id"], "outcome": outcome, "ms": 700}).get_json()
    assert r["progress"]["votes"] == 4
    u = post(client, "/api/undo").get_json()
    assert u["undone"] == "skip" and u["progress"]["votes"] == 3
    assert u["cards"][0]["type"] == "duel"                                       # the undone pair comes back first
    assert post(client, "/api/vote", {"card": first["id"], "outcome": "a"}).status_code == 409  # spent card


def test_toss_takes_effect_and_undo_restores(client):
    card = post(client, "/api/deal?n=1").get_json()["cards"][0]
    tossed = card["b"]
    r = post(client, "/api/vote", {"card": card["id"], "outcome": "toss_b", "ms": 500}).get_json()
    for c in r["cards"]:
        assert tossed not in (c.get("a"), c.get("b"))
    s = client.matcher.session
    assert s.store.one("SELECT override FROM photos WHERE id=?", (tossed,))["override"] == "toss"
    assert wait_refresh(client, lambda s: s.store.one("SELECT cut FROM photos WHERE id=?", (tossed,))["cut"] == "tossed")
    post(client, "/api/undo")
    assert s.store.one("SELECT override FROM photos WHERE id=?", (tossed,))["override"] is None
    assert s.store.one("SELECT cut FROM photos WHERE id=?", (tossed,))["cut"] is None


def test_frame_card_sets_the_representative(client):
    s = client.matcher.session
    s.ensure_ranker()
    gid, g = next((gid, g) for gid, g in s.groups.items() if len(g["members"]) == 5)
    pick = [m for m in g["members"] if m != g["rep"]][0]
    card = s._card("frame", gid=gid, members=g["members"], current=g["rep"])
    r = post(client, "/api/vote", {"card": card["id"], "outcome": "frame", "choice": pick})
    assert r.status_code == 200
    assert wait_refresh(client, lambda s: s.store.one("SELECT rep FROM groups WHERE id=?", (gid,))["rep"] == pick)


def test_shortlist_pick_and_export(client):
    for _ in range(12):
        card = post(client, "/api/deal?n=1").get_json()["cards"][0]
        post(client, "/api/vote", {"card": card["id"], "outcome": "a", "ms": 600})
    sl = client.get("/api/shortlist").get_json()
    k = client.matcher.session.settings["finalists"]
    assert 0 < len(sl["items"]) <= k
    assert [it["rank"] for it in sl["items"]] == list(range(1, len(sl["items"]) + 1))
    if sl["bubble"]:
        extra = sl["bubble"][0]["photo"]
        post(client, "/api/pick", {"photo": extra, "on": True})
        assert extra in [a["photo"] for a in client.get("/api/shortlist").get_json()["added"]]
    r = post(client, "/api/export").get_json()
    with zipfile.ZipFile(r["zip"]) as z:
        assert len(z.namelist()) == r["count"] == len(sl["items"]) + (1 if sl["bubble"] else 0)
    key = Path(r["dir"], "KEY.PRIVATE.csv").read_text()
    assert str(client.src) in key and "review_photos.zip" not in key


def test_cuts_rescue_and_people(client):
    cuts = client.get("/api/cuts").get_json()
    stranger = next(p for p in cuts["photos"] if p["reason"] == "not_you")
    post(client, "/api/rescue", {"ids": [stranger["id"]], "on": True})
    s = client.matcher.session
    assert wait_refresh(client, lambda s: s.store.one("SELECT cut FROM photos WHERE id=?", (stranger["id"],))["cut"] is None)
    ppl = client.get("/api/people").get_json()
    assert ppl["me"]["n_photos"] > 30 and ppl["me"]["faces"]
    assert client.get(f"/img/f/{ppl['me']['faces'][0]}.jpg").status_code == 200
    assert client.get(f"/img/t/{stranger['id']}.jpg").status_code == 200


def test_settings_change_resizes_the_shortlist(client):
    post(client, "/api/settings", {"finalists": 10, "per_scene": 1})
    sl = client.get("/api/shortlist").get_json()
    assert len(sl["items"]) == 10
    scenes = [it["scene"] for it in sl["items"]]
    assert len(set(scenes)) == len(scenes)


def test_browse_and_open_library_validation(client, tmp_path, monkeypatch):
    monkeypatch.setattr("matcher.server.suggestions", lambda: [])
    b = client.get(f"/api/browse?path={client.src}").get_json()
    assert {d["name"] for d in b["dirs"]} >= {"cam", "other"}
    assert b["crumbs"][0] == {"label": "/", "path": "/"}
    assert b["crumbs"][-1] == {"label": client.src.name, "path": str(client.src.resolve())}
    assert post(client, "/api/library", {"path": str(tmp_path / "nope")}).status_code == 400
    empty = tmp_path / "empty"
    empty.mkdir()
    assert post(client, "/api/library", {"path": str(empty)}).status_code == 200
    client.matcher.session.analyzer.thread.join(timeout=5)
    assert "No photos" in client.get("/api/state").get_json()["library"]["progress"]["error"]


def test_the_secret_link_is_the_only_way_in(tmp_path, fake_prompts):
    app = create_app(tmp_path / "data", secret="sekrit", allowed_hosts={"localhost"}, cookie="mk")
    c = app.test_client()
    assert c.get("/api/state").status_code == 403
    assert c.get("/").status_code == 403 and b"locked" in c.get("/").data
    assert c.get("/?k=wrong").status_code == 403
    r = c.get("/?k=sekrit")
    assert r.status_code == 303 and r.headers["Location"].endswith("/")                # a clean URL after the trade
    cookie = r.headers.get("Set-Cookie", "")
    assert "mk=sekrit" in cookie and "HttpOnly" in cookie and "SameSite=Strict" in cookie
    assert c.get("/api/state").status_code == 200                                 # cookie now set
    assert c.post("/api/cup", data="x", headers={"Content-Type": "text/plain"}).status_code == 403  # header still needed
    assert c.get("/api/state", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    h = c.get("/api/state").headers
    assert "frame-ancestors 'none'" in h["Content-Security-Policy"] and h["Cross-Origin-Resource-Policy"] == "same-origin"


def test_undoing_a_burst_toss_restores_every_frame(client):
    s = client.matcher.session
    s.ensure_ranker()
    gid, g = next((gid, g) for gid, g in s.groups.items() if len(g["members"]) == 5)
    with s.lock:
        card = s._card("duel", ia=s.gidx[gid], ib=s.gidx[s.gids[0] if s.gids[0] != gid else s.gids[1]],
                       a=g["rep"], b=s.reps[0] if s.reps[0] != g["rep"] else s.reps[1])
    post(client, "/api/vote", {"card": card["id"], "outcome": "toss_a"})
    q = "SELECT COUNT(*) AS n FROM photos WHERE override='toss' AND id IN (%s)" % ",".join("?" * 5)
    assert s.store.one(q, g["members"])["n"] == 5
    assert wait_refresh(client, lambda s: s.store.one("SELECT cut FROM photos WHERE id=?", (g["members"][-1],))["cut"] == "tossed")
    post(client, "/api/undo")
    assert s.store.one(q, g["members"])["n"] == 0
    assert all(s.store.one("SELECT cut FROM photos WHERE id=?", (m,))["cut"] is None for m in g["members"])


def test_taste_summary(client):
    for _ in range(6):
        card = post(client, "/api/deal?n=1").get_json()["cards"][0]
        post(client, "/api/vote", {"card": card["id"], "outcome": "a"})
    taste = client.get("/api/shortlist").get_json()["taste"]
    assert taste and {"feature", "effect", "prior"} <= set(taste[0])


def test_frame_pick_applies_immediately(client, monkeypatch):
    """Regression: after picking a burst's best frame, the very next duels must show that frame."""
    s = client.matcher.session
    s.ensure_ranker()
    monkeypatch.setattr(s, "refresh_async", lambda full=True: None)  # the background regroup hasn't landed yet
    gid, g = next((gid, g) for gid, g in s.groups.items() if len(g["members"]) == 5)
    i, members = s.gidx[gid], set(g["members"])
    old = g["rep"]
    pick = next(m for m in g["members"] if m != old)
    with s.lock:
        frame = s._card("frame", gid=gid, item=i, members=g["members"], current=old)
        # pairs fetched while the frame question is still on its way must not feature that shot at all
        seen_excludes = []
        real = s.ranker.next_pair
        monkeypatch.setattr(s.ranker, "next_pair",
                            lambda *a, **kw: (seen_excludes.append(set(kw.get("exclude", ()))), real(*a, **kw))[1])
        for _ in range(25):
            for c in s.next_cards(2, [frame["id"]]):
                assert c["type"] != "duel" or not ({c["a"], c["b"]} & members)
        assert seen_excludes and all(i in ex for ex in seen_excludes)
    r = post(client, "/api/vote", {"card": frame["id"], "outcome": "frame", "choice": pick}).get_json()
    assert {k: r["swap"][k] for k in ("from", "to")} == {"from": old, "to": pick} and r["swap"]["photo"]["dims"]
    assert s.reps[i] == pick and s.groups[gid]["rep"] == pick           # applied at once, not after a refresh
    with s.lock:
        s.version = None                                                # a rebuild from the stale features file
        s.ensure_ranker()
    assert s.reps[s.gidx[gid]] == pick                                  # ...still honours your pick


def test_bring_back_all_then_set_all_aside(client):
    cuts = client.get("/api/cuts").get_json()["photos"]
    not_you = [p["id"] for p in cuts if p["reason"] == "not_you"]
    assert len(not_you) == 3
    s = client.matcher.session
    q = "SELECT COUNT(*) AS n FROM photos WHERE cut='not_you' AND id IN (%s)" % ",".join("?" * len(not_you))
    assert post(client, "/api/rescue", {"ids": not_you, "on": True, "reason": "not_you"}).get_json()["changed"] == 3
    assert wait_refresh(client, lambda s: s.store.one(q, not_you)["n"] == 0)
    listed = {p["id"]: p for p in client.get("/api/cuts").get_json()["photos"]}
    assert all(listed[i]["rescued"] and listed[i]["reason"] == "not_you" for i in not_you)  # still listed, marked back in
    assert post(client, "/api/rescue", {"ids": not_you, "on": False, "reason": "not_you"}).get_json()["changed"] == 3
    assert wait_refresh(client, lambda s: s.store.one(q, not_you)["n"] == 3)


def test_tossed_photos_can_come_back_and_go_again(client):
    card = post(client, "/api/deal?n=1").get_json()["cards"][0]
    post(client, "/api/vote", {"card": card["id"], "outcome": "toss_a"})
    s = client.matcher.session
    pid = card["a"]
    assert wait_refresh(client, lambda s: s.store.one("SELECT cut FROM photos WHERE id=?", (pid,))["cut"] == "tossed")
    tossed = [p["id"] for p in client.get("/api/cuts").get_json()["photos"] if p["reason"] == "tossed"]
    assert pid in tossed
    active_tosses = "SELECT COUNT(*) AS n FROM votes WHERE kind='toss' AND undone=0"
    assert s.store.one(active_tosses)["n"] == 1
    post(client, "/api/rescue", {"ids": tossed, "on": True, "reason": "tossed"})
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "keep"
    assert s.store.one(active_tosses)["n"] == 0                       # the model forgets the toss
    assert wait_refresh(client, lambda s: s.store.one("SELECT cut FROM photos WHERE id=?", (pid,))["cut"] is None)
    post(client, "/api/rescue", {"ids": [pid], "on": False, "reason": "tossed"})
    assert s.store.one("SELECT override FROM photos WHERE id=?", (pid,))["override"] == "toss"
    assert s.store.one(active_tosses)["n"] == 1


def _stack_and_single(s):
    gid, g = next((gid, g) for gid, g in s.groups.items() if len(g["members"]) == 5)
    other = next(i for i, gg in enumerate(s.gids) if gg in s.groups and len(s.groups[gg]["members"]) == 1)
    return gid, g, s.gidx[gid], other


def _play_mini(client, card, pick_challenger=True):
    """Play a stack's mini-tournament to the end; returns (last response, rounds played)."""
    rounds = 0
    while card["type"] == "mini":
        challenger = card["b"] if card["a"] == card["champ"] else card["a"]
        side = "a" if (card["a"] == challenger) == pick_challenger else "b"
        r = post(client, "/api/vote", {"card": card["id"], "outcome": side, "ms": 900}).get_json()
        rounds += 1
        card = r["cards"][0]
    return r, rounds


def test_stacks_play_a_mini_tournament_before_their_first_duel(client, monkeypatch):
    s = client.matcher.session
    s.ensure_ranker()
    monkeypatch.setattr(s, "refresh_async", lambda full=True: None)
    gid, g, stack, other = _stack_and_single(s)
    monkeypatch.setattr(s.ranker, "next_pair", lambda *a, **kw: (stack, other))
    with s.lock:
        first = s.next_cards(1)[0]
    assert first["type"] == "mini" and first["round"] == 1 and first["champ"] == g["rep"]
    assert first["total"] == len(first["frames"]) - 1 and set(first["frames"]) <= set(g["members"])
    r, rounds = _play_mini(client, first, pick_challenger=True)        # every challenger wins: the last frame
    assert rounds == first["total"]
    crowned = r["crowned"]["photo"]
    assert crowned == first["frames"][-1] and s.groups[gid]["rep"] == crowned
    duel = r["cards"][0]
    assert duel["type"] == "duel" and crowned in (duel["a"], duel["b"])  # the held duel, with the champion
    with s.lock:
        assert s.next_cards(1)[0]["type"] == "duel"                     # crowned once, not asked again


def test_mini_undo_steps_back_a_round_and_uncrowns(client, monkeypatch):
    s = client.matcher.session
    s.ensure_ranker()
    gid, g, stack, other = _stack_and_single(s)
    earlier = next(m for m in g["members"] if m != g["rep"])
    post(client, "/api/frame", {"photo": earlier})                      # a choice made from the shortlist
    gid = s.photo_group[earlier]
    s.groups[gid]["checked"] = False
    monkeypatch.setattr(s, "refresh_async", lambda full=True: None)
    monkeypatch.setattr(s.ranker, "next_pair", lambda *a, **kw: (s.gidx[gid], other))
    with s.lock:
        r1 = s.next_cards(1)[0]
    challenger = r1["b"] if r1["a"] == r1["champ"] else r1["a"]
    r2 = post(client, "/api/vote", {"card": r1["id"], "outcome": "a" if r1["a"] == challenger else "b"}).get_json()["cards"][0]
    assert r2["type"] == "mini" and r2["round"] == 2 and r2["champ"] == challenger
    u = post(client, "/api/undo").get_json()
    back = u["cards"][0]
    assert back["type"] == "mini" and back["round"] == 1 and back["champ"] == r1["champ"]   # round 1 again
    r, _ = _play_mini(client, back, pick_challenger=False)              # the champion defends every round
    assert r["crowned"]["photo"] == earlier
    u = post(client, "/api/undo").get_json()                            # undo the crowning...
    last = u["cards"][0]
    assert last["type"] == "mini" and last["round"] == last["total"]    # ...brings back the deciding round
    assert s.groups[s.photo_group[earlier]]["rep"] == earlier           # and your earlier choice is intact


def test_crown_now_from_the_groups_page(client):
    s = client.matcher.session
    s.ensure_ranker()
    gid, g, stack, other = _stack_and_single(s)
    cards = post(client, f"/api/deal?n=2&stack={g['members'][2]}").get_json()["cards"]
    assert cards[0]["type"] == "mini" and set(cards[0]["frames"]) <= set(g["members"])


def test_drag_a_frame_onto_another_shot(client):
    s = client.matcher.session
    s.ensure_ranker()
    gid, g, stack, other = _stack_and_single(s)
    moving = next(m for m in g["members"] if m != g["rep"])
    target = s.reps[other]
    assert post(client, "/api/groups/move", {"photo": moving, "target": target}).get_json()["size"] == 2
    assert s.photo_group[moving] == s.photo_group[target]
    rest = [m for m in g["members"] if m != moving]
    assert len({s.photo_group[m] for m in rest}) == 1 and s.photo_group[rest[0]] != s.photo_group[moving]


def test_game_progress(client):
    p = post(client, "/api/deal?n=1").get_json()["progress"]["game"]
    assert p["xp"] == 0 and p["level"] == 1 and p["level_name"] == "Swipe Rookie" and p["unlocked"] == []
    for _ in range(3):
        card = post(client, "/api/deal?n=1").get_json()["cards"][0]
        if card["type"] == "duel":
            p = post(client, "/api/vote", {"card": card["id"], "outcome": "a", "ms": 1200}).get_json()["progress"]["game"]
    assert p["xp"] >= 15 and p["streak"] >= 1 and "first" in p["unlocked"]
    g = client.get("/api/game").get_json()
    assert {a["id"] for a in g["achievements"] if a["unlocked"]} == set(p["unlocked"])
    assert len(g["levels"]) >= 10


def test_identical_copies_never_ask(client):
    s = client.matcher.session
    s.ensure_ranker()
    gid, g = next((gid, g) for gid, g in s.groups.items() if len(g["members"]) == 3)
    with s.store.tx() as c:
        c.execute("UPDATE photos SET sha256='same' WHERE id IN (%s)" % ",".join("?" * 3), g["members"])
    with s.lock:
        s.version = None
        s.ensure_ranker()
        assert not s._needs_frame(s.gidx[gid])


def test_cards_carry_crop_info(client):
    card = post(client, "/api/deal?n=1").get_json()["cards"][0]
    info = card["photos"][str(card["a"])]
    assert len(info["dims"]) == 2 and info["frames"] >= 1
    x, y, w, h = info["box"]
    assert w > 0 and h > 0


def test_older_library_refreshes_itself_on_open(client):
    s = client.matcher.session
    with s.store.tx() as c:
        c.execute("UPDATE photos SET subject=NULL")
    s.store.set_meta("derived_version", 1)
    with s.lock:
        s.version = None
        s.ensure_ranker()
    assert s.store.get_meta("derived_version") == library.DERIVED_VERSION
    assert s.store.one("SELECT COUNT(*) AS n FROM photos WHERE subject IS NOT NULL AND subject != 'null'")["n"] > 30


# ---------------------------------------------------------------- undo puts things back exactly
def _vote_count(s):
    return s.store.one("SELECT COUNT(*) AS n FROM votes WHERE undone=0")["n"]


def test_undo_chain_walks_back_in_order(client):
    s = client.matcher.session
    crown_stacks(client)                                                   # duels only after this
    n0 = _vote_count(s)
    shown = []
    for outcome in ("a", "great", "b"):
        card = post(client, "/api/deal?n=1").get_json()["cards"][0]
        assert card["type"] == "duel"
        shown.append((card["a"], card["b"]))
        post(client, "/api/vote", {"card": card["id"], "outcome": outcome})
    assert _vote_count(s) == n0 + 3
    for expect in reversed(shown):
        u = post(client, "/api/undo").get_json()
        first = u["cards"][0]
        assert (first["a"], first["b"]) == expect                      # the decision you undid, same sides
    assert _vote_count(s) == n0
    assert all(n == 0 for n in s.ranker.post.n_obs)                   # and the model forgot all three


def test_undo_toss_brings_the_pair_back(client):
    s = client.matcher.session
    card = post(client, "/api/deal?n=1").get_json()["cards"][0]
    post(client, "/api/vote", {"card": card["id"], "outcome": "toss_b"})
    u = post(client, "/api/undo").get_json()
    assert u["undone"] == "toss"
    assert (u["cards"][0]["a"], u["cards"][0]["b"]) == (card["a"], card["b"])
    assert s.store.one("SELECT override FROM photos WHERE id=?", (card["b"],))["override"] is None


# ---------------------------------------------------------------- groups page
def test_groups_views(client):
    stacks = client.get("/api/groups?view=stacks").get_json()
    assert stacks["counts"]["stacks"] == len(stacks["shots"]) == 2
    assert sorted(len(x["members"]) for x in stacks["shots"]) == [3, 5]
    every = client.get("/api/groups?view=all&order=time").get_json()
    assert len(every["shots"]) == every["counts"]["shots"]
    ts = [x["ts"] for x in every["shots"] if x["ts"] is not None]
    assert ts == sorted(ts)                                                 # by date: in the order they were taken


def test_stacks_can_be_ordered_by_look(client):
    """The Stacks page defaults to look order, so similar stacks sit together in a dashed family box."""
    s = client.matcher.session
    s.ensure_ranker()
    reps = [g["rep"] for g in s.groups.values() if len(g["members"]) > 1]
    assert len(reps) >= 2
    emb = s.store.one("SELECT emb FROM photos WHERE id=?", (reps[0],))["emb"]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET emb=? WHERE id=?", (emb, reps[1]))
    look = client.get("/api/groups?view=stacks&order=look").get_json()["shots"]
    by_date = client.get("/api/groups?view=stacks&order=time").get_json()["shots"]
    assert sorted(x["rep"] for x in look) == sorted(x["rep"] for x in by_date)
    assert all("family" in x for x in look)
    assert not any("family" in x for x in by_date)
    assert look[0]["family"] == look[1]["family"]


def test_merge_split_reset_round_trip(client):
    s = client.matcher.session
    s.ensure_ranker()
    singles = [g["rep"] for g in s.groups.values() if len(g["members"]) == 1][:3]
    r = post(client, "/api/groups/merge", {"photos": singles}).get_json()
    assert r["size"] == 3
    gid = s.photo_group[singles[0]]
    assert sorted(s.groups[gid]["members"]) == sorted(singles)
    stack = next(x for x in client.get("/api/groups?view=stacks").get_json()["shots"] if x["gid"] == gid)
    assert stack["manual"] and not stack["kept"]                           # yours, frame still to choose
    assert s._needs_frame(s.gidx[gid])                                      # so it asks before the next duel
    post(client, "/api/groups/split", {"photo": singles[0]})
    assert s.photo_group[singles[0]] != s.photo_group[singles[1]] == s.photo_group[singles[2]]
    solo = next(x for x in client.get("/api/groups?view=all").get_json()["shots"] if x["rep"] == singles[0])
    assert solo["solo"]
    post(client, "/api/groups/reset", {"photos": [singles[0], singles[1]]})
    keys = s.store.q("SELECT stack_key FROM photos WHERE id IN (?,?,?)", singles)
    assert all(k["stack_key"] is None for k in keys)                        # all back to automatic
    assert len({s.photo_group[p] for p in singles}) == 3                    # ...which never stacked them


def test_split_all_apart(client):
    s = client.matcher.session
    s.ensure_ranker()
    gid, g = next((gid, g) for gid, g in s.groups.items() if len(g["members"]) == 5)
    post(client, "/api/groups/unstack", {"photo": g["rep"]})
    assert len({s.photo_group[m] for m in g["members"]}) == 5


def test_suggestions_skip_stacked_and_dismissed_pairs(client):
    s = client.matcher.session
    s.ensure_ranker()
    a, b = [g["rep"] for g in s.groups.values() if len(g["members"]) == 1][:2]
    emb = s.store.one("SELECT emb FROM photos WHERE id=?", (a,))["emb"]
    with s.store.tx() as c:                                                 # make b look just like a
        c.execute("UPDATE photos SET emb=? WHERE id=?", (emb, b))
    pairs = lambda: {tuple(sorted((x["a"], x["b"]))) for x in client.get("/api/groups?view=suggest").get_json()["suggestions"]}
    assert tuple(sorted((a, b))) in pairs()
    post(client, "/api/groups/dismiss", {"a": a, "b": b})
    assert tuple(sorted((a, b))) not in pairs()


def test_groups_can_put_look_alikes_together(client):
    look = client.get("/api/groups?view=all").get_json()["shots"]
    by_date = client.get("/api/groups?view=all&order=time").get_json()["shots"]
    assert sorted(x["rep"] for x in look) == sorted(x["rep"] for x in by_date)
    assert all("family" in x for x in look) and not any("family" in x for x in by_date)
    seen, last = set(), None                                   # each family shows up as one contiguous run
    for x in look:
        if x["family"] != last:
            assert x["family"] not in seen
            seen.add(x["family"])
            last = x["family"]


def test_groups_come_in_pages_that_add_up_to_everything(client):
    first = client.get("/api/groups?view=all&per=10").get_json()
    assert first["pages"] > 1 and first["page"] == 0 and len(first["shots"]) >= 10
    seen = [x["rep"] for x in first["shots"]]
    for page in range(1, first["pages"]):
        seen += [x["rep"] for x in client.get(f"/api/groups?view=all&per=10&page={page}").get_json()["shots"]]
    assert len(seen) == len(set(seen)) == first["total"] == first["counts"]["shots"]
    assert client.get(f"/api/groups?view=all&per=10&page={first['pages']}").get_json()["shots"] == []
    assert client.get("/api/groups?view=all&per=abc").status_code == 400            # bad input is a 400, not a crash
