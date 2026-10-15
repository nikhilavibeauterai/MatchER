"""Regressions for the sea, editable tags, persisted Crown and elimination rounds."""
import threading
import time
import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from matcher import game, tags, library
from matcher.server import Session
from tests.test_draw import client, post, single  # noqa: F401 (shared synthetic library fixture)


def test_analysis_atlas_can_show_read_photos_in_requested_order(client):
    from io import BytesIO
    from PIL import Image
    s = client.matcher.session
    a, b = single(client, 0), single(client, 1)
    (s.workdir / "thumbs").mkdir(exist_ok=True)
    Image.new("RGB", (32, 32), (220, 30, 30)).save(s.workdir / "thumbs" / f"{a}.jpg")
    Image.new("RGB", (32, 32), (30, 30, 220)).save(s.workdir / "thumbs" / f"{b}.jpg")
    with s.store.tx() as c:
        c.execute("UPDATE photos SET status='read' WHERE id IN (?,?)", (a, b))
    r = client.get(f"/img/atlas.jpg?ids={b},{a}")
    assert r.status_code == 200
    with Image.open(BytesIO(r.data)) as sheet:
        assert sheet.size == (800, 16)
        assert sheet.getpixel((8, 8))[2] > 180
        assert sheet.getpixel((24, 8))[0] > 180
    for query in ["", "-1", "x", "1/2", ",".join([str(a)] * 1001)]:
        assert client.get(f"/img/atlas.jpg?ids={query}").status_code == 400


def test_image_cache_scope_survives_tag_edits_and_changes_on_rescan(client):
    s = client.matcher.session
    key = client.get("/api/state").get_json()["library"]["image_key"]
    post(client, "/api/tags/new", {"label": "Public fixture", "photos": [single(client, 0)]})
    assert client.get("/api/state").get_json()["library"]["image_key"] == key
    s.store.set_meta("analyzed_at", time.time() + 10)
    assert client.get("/api/state").get_json()["library"]["image_key"] != key


def test_every_analysis_discovery_survives_refresh_and_tag_corrections(client):
    s=client.matcher.session
    photo=single(client,0)
    found={"beach":0.41,"hat":0.39,"sunglasses":0.42}
    with s.store.tx() as c:
        c.execute("UPDATE photos SET recognized_tags=?, n_faces=1 WHERE id=?",(tags.discovery_json(found),photo))
    library.refresh(s.store)
    s.ensure_ranker(wait=True)
    assert set(found)|{"faces"} <= tags.effective(s.store)[photo]
    listed={t["key"] for t in client.get("/api/tags?all=1").get_json()["tags"]}
    assert set(found)|{"faces"} <= listed
    post(client,"/api/tags/set",{"photos":[photo],"off":["hat"],"on":[]})
    library.refresh(s.store)
    assert "hat" not in tags.effective(s.store)[photo]
    post(client,"/api/draw/undo")
    assert "hat" in tags.effective(s.store)[photo]


def test_sample_is_offline_and_has_verified_public_domain_sources(tmp_path,monkeypatch):
    from matcher import sample
    def offline(*args,**kwargs):
        raise AssertionError("The bundled sample must work without the network.")
    monkeypatch.setattr(sample,"_get",offline)
    fetcher=sample.SampleFetcher(tmp_path/"public-sample")
    fetcher._run()
    assert fetcher.status["state"] == "done",fetcher.status
    assert fetcher.status["done"] == fetcher.status["total"] == 13
    assert len(list(fetcher.dest.rglob("*.jpg"))) == 13
    credits=(fetcher.dest/"ATTRIBUTION.txt").read_text()
    assert "Public-domain" in credits and "Ducreux" in credits and "NASA" in credits


def test_old_cached_photos_get_their_discovery_tags_backfilled(client,monkeypatch):
    s=client.matcher.session
    old,cached=single(client,0),single(client,1)
    s.store.set_meta("settings",{"mode":"gallery"})
    with s.store.tx() as c:
        for photo,found in [(old,None),(cached,"{}")]:
            c.execute("UPDATE photos SET crop_emb=emb, crop_face=me_face, recognized_tags=? WHERE id=?",(found,photo))
    selected=[]
    monkeypatch.setattr(s.analyzer,"_embed",lambda rows,*args,**kwargs:selected.extend(r["id"] for r in rows))
    s.analyzer._embed_crops()
    assert old in selected and cached not in selected


def test_save_cards_load_after_sweep_rescues_and_tosses(client):
    s=client.matcher.session
    photo=single(client,0)
    for change in ("keep","toss"):
        s.store.add_vote("sweep",photo,None,None,None,extra={"change":change})
        r=client.get("/api/state")
        assert r.status_code == 200 and r.get_json()["library"]["save"]["xp"] >= 3


def test_small_knockouts_eliminate_to_four_finalists(client):
    s=client.matcher.session;s.ensure_ranker()
    s.ranker.active[:]=False;s.ranker.active[:7]=True;s.ranker.n_active=7;s.base_active=s.ranker.active.copy()
    st=s.knockouts_start()
    assert st["target"]==4 and not st["qualified"]
    eliminated=set()
    for _ in range(10):
        card=s.knockouts_card()
        if card is None:break
        eliminated.add(card["b"])
        s.knockouts_vote(card,"a",1000,"knockouts")
    st=s.store.get_meta(f"knockouts:{s.cup}")
    assert len(st["qualified"])==4 and not eliminated&set(st["qualified"])
    assert s.finals_start()["finals"]["seeds"]==st["qualified"]


def test_world_and_board_pages_include_every_photo_and_shot(client):
    s = client.matcher.session
    first = [single(client, k) for k in range(12)]
    second = [single(client, k) for k in range(12, 25)]
    post(client, "/api/draw/new", {"photos": first})
    post(client, "/api/draw/new", {"photos": second})
    seen, after = {}, 0
    while True:
        r = client.get(f"/api/world?after={after}&per=7").get_json()
        assert not set(seen) & {p["id"] for p in r["photos"]}
        seen.update((p["id"], p) for p in r["photos"])
        after = r["after"]
        if not r["more"]:
            break
    expected = {r["id"] for r in s.store.q("SELECT id FROM photos WHERE status IN ('analyzed','error')")}
    assert set(seen) == expected and r["total"] == len(expected)
    assert any(p["cut"] for p in seen.values())
    assert any(p["id"] != p["rep"] for p in seen.values())
    sections = {}
    for page in range(30):
        board = client.get(f"/api/draw/board?per=3&uper=4&page={page}").get_json()
        for part in [board["unsorted"], *board["groups"]]:
            key = part.get("id", "unsorted")
            items = sections.setdefault(key, set())
            assert not items & {p["rep"] for p in part["shots"]}
            items.update(p["rep"] for p in part["shots"])
        if not board["more"]:
            break
    assert sum(map(len, sections.values())) == board["total"]
    assert all(len(sections[g["id"]]) == g["count"] for g in board["groups"])


def test_tags_merge_delete_and_canonical_correction_undo(client):
    s = client.matcher.session
    a, b = single(client, 0), single(client, 1)
    first = post(client, "/api/tags/new", {"label": "Beach", "photos": [a]}).get_json()["key"]
    second = post(client, "/api/tags/new", {"label": "Seaside", "photos": [b]}).get_json()["key"]
    before = tags.effective(s.store)
    r = post(client, "/api/tags/merge", {"source": first, "key": second})
    assert r.status_code == 200 and r.get_json()["undo"] == "merge tags"
    effective = tags.effective(s.store)
    assert second in effective[a] and second in effective[b] and first not in effective[a]
    assert first not in tags.rows(s.store)
    post(client, "/api/tags/set", {"photos": [a], "on": [], "off": [second]})
    assert second not in tags.effective(s.store)[a]
    post(client, "/api/draw/undo")
    assert second in tags.effective(s.store)[a]
    post(client, "/api/draw/undo")
    assert tags.effective(s.store) == before
    post(client, "/api/tags/delete", {"source": first})
    assert first not in tags.effective(s.store)[a]
    post(client, "/api/draw/undo")
    assert tags.effective(s.store) == before
    empty = post(client, "/api/tags/new", {"label": "Empty", "photos": []}).get_json()["key"]
    assert any(t["key"] == empty and t["count"] == 0 for t in client.get("/api/tags?all=1").get_json()["tags"])
    # A bad selection must not leave a new tag behind.
    assert post(client, "/api/tags/new", {"label": "Invalid", "photos": [999999]}).status_code == 404
    assert "u:invalid" not in tags.rows(s.store)


def test_tag_check_is_finite_and_remembers_explicit_calls(client):
    key = post(client, "/api/tags/new", {"label": "Sunny", "photos": []}).get_json()["key"]
    deck = client.get(f"/api/tags/deck?key={key}").get_json()["cards"]
    assert 0 < len(deck) <= 30
    photo = deck[0]["photo"]
    post(client, "/api/tags/set", {"photos": [photo], "on": [key], "off": []})
    assert photo not in {c["photo"] for c in client.get(f"/api/tags/deck?key={key}").get_json()["cards"]}
    post(client, "/api/draw/undo")
    assert photo in {c["photo"] for c in client.get(f"/api/tags/deck?key={key}").get_json()["cards"]}


def test_gets_preserve_deals_minis_followups_and_achievements(client):
    s = client.matcher.session
    post(client, "/api/deal?stage=open&n=2")
    before = (list(s.cards), dict(s.minis), list(s.followups), s.store.get_meta("achievements"))
    for _ in range(4):
        for path in ("/api/next?stack=1&n=50", "/api/finals", "/api/tournament", "/api/groups", "/api/game"):
            assert client.get(path).status_code == 200
    assert before == (list(s.cards), dict(s.minis), list(s.followups), s.store.get_meta("achievements"))


def test_half_played_crown_survives_restart_without_duplicate_votes(client):
    s = client.matcher.session
    c = post(client, "/api/deal?stage=stacks&n=1").get_json()["cards"][0]
    assert c["type"] == "mini"
    reply = post(client, "/api/vote", {"card": c["id"], "outcome": "a", "stage": "stacks"}).get_json()
    next_card = reply["cards"][0]
    assert next_card["round"] == 2
    count = len(s.store.votes())
    s.shutdown()
    restored = Session(s.source, s.workdir.parent)
    client.matcher.session = restored
    client.matcher._sessions[str(s.source)] = restored
    try:
        c2 = post(client, "/api/deal?stage=stacks&n=1").get_json()["cards"][0]
        assert c2["round"] == next_card["round"] and c2["champ"] == next_card["champ"]
        assert len(restored.store.votes()) == count
    finally:
        restored.shutdown()


def test_elimination_rounds_have_byes_undo_persistence_and_eight_finalists(client):
    s = client.matcher.session
    data = post(client, "/api/deal?stage=knockouts&n=2").get_json()
    card = data["cards"][0]
    state = s.store.get_meta("knockouts:all")
    assert any(m["bye"] for m in state["rounds"][0]["matches"])
    assert post(client, "/api/vote", {"card": card["id"], "outcome": "great"}).status_code == 400
    data = post(client, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "knockouts"}).get_json()
    undo = post(client, "/api/undo", {"stage": "knockouts"}).get_json()
    assert undo["undone"] == "knockout" and s.store.get_meta("knockouts:all") == state
    assert undo["cards"][0]["id"] == card["id"]
    lost = set()
    for _ in range(100):
        card = s.knockouts_card()
        if card is None:
            break
        assert not lost & {card["a"], card["b"]}
        lost.add(card["b"])
        r = post(client, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "knockouts"})
        assert r.status_code == 200, r.get_json()
    done = s.store.get_meta("knockouts:all")
    assert len(done["qualified"]) == 8 and not lost & set(done["qualified"])
    finals = post(client, "/api/finals/start").get_json()["finals"]
    assert finals["seeds"] == done["qualified"]
    restored = Session(s.source, s.workdir.parent)
    try:
        restored.ensure_ranker()
        assert restored.store.get_meta("knockouts:all") == done
        assert restored.knockouts_card() is None
        assert restored.finals_state()["seeds"] == done["qualified"]
    finally:
        restored.shutdown()


def test_bracket_and_group_links_deal_the_chosen_match(client):
    s = client.matcher.session
    post(client, "/api/stacks/auto")
    a = post(client, "/api/draw/new", {"photos": [single(client, k) for k in range(4)]}).get_json()["theme"]["id"]
    b = post(client, "/api/draw/new", {"photos": [single(client, k) for k in range(4, 8)]}).get_json()["theme"]["id"]
    cards = post(client, f"/api/deal?stage=groups&group={b}&n=1").get_json()["cards"]
    assert cards[0]["group"]["id"] == b and s.draw.focus == b
    post(client, "/api/draw/dissolve", {"theme": a})
    post(client, "/api/draw/dissolve", {"theme": b})
    post(client, "/api/knockouts/start")
    state = s.store.get_meta("knockouts:all")
    match = next(k for k, m in reversed(list(enumerate(state["rounds"][-1]["matches"]))) if not m["winner"])
    card = post(client, f"/api/deal?stage=knockouts&match={match}&n=1").get_json()["cards"][0]
    assert card["id"].endswith(f":{match}")
    assert post(client, "/api/vote", {"card": card["id"], "outcome": "b"}).status_code == 200
    undo = post(client, "/api/undo", {"stage": "knockouts"}).get_json()
    assert undo["cards"][0]["id"] == card["id"]
    assert s.store.get_meta("knockouts:all") == state


def test_rescue_and_bulk_toss_each_have_one_complete_undo(client):
    s = client.matcher.session
    a, b = single(client, 0), single(client, 1)
    post(client, "/api/rescue", {"ids": [a], "on": True})
    s.wait_refresh(); s.ensure_ranker(wait=True)
    assert s.store.one("SELECT override FROM photos WHERE id=?", (a,))["override"] == "keep"
    r = post(client, "/api/draw/toss", {"photos": [a, b]}).get_json()
    assert r["undo"] == "toss" and set(r["tossed"]) == {a, b}
    post(client, "/api/draw/undo")
    assert s.store.one("SELECT override FROM photos WHERE id=?", (a,))["override"] == "keep"
    assert s.store.one("SELECT override FROM photos WHERE id=?", (b,))["override"] is None
    post(client, "/api/draw/undo")
    assert s.store.one("SELECT override FROM photos WHERE id=?", (a,))["override"] is None


def test_wrong_json_types_return_400_and_preserve_state(client):
    cases = [("/api/deal", []), ("/api/vote", {"card": []}), ("/api/frame", {"photo": None}),
             ("/api/groups/merge", {"photos": "1,2"}), ("/api/tags/set", {"on": True}),
             ("/api/draw/rename", {"name": {}}), ("/api/rescue", {"ids": [None]}),
             ("/api/cup", {"cup": []}), ("/api/settings", {"finalists": True}),
             ("/api/settings", {"finalists": 10**100}), ("/api/vote", {"ms": -1}),
             ("/api/pick-native", {"start": []}), ("/api/people/1", {"action": 42}),
             ("/api/tags/new", {"label": None, "photos": []})]
    for path, body in cases:
        r = client.post(path, json=body, headers={"X-MatchER": "1"})
        assert r.status_code == 400, (path, r.get_json())
        assert r.is_json


def test_concurrent_calls_consume_a_card_once(client):
    s = client.matcher.session
    s.ensure_ranker()
    post(client, "/api/stacks/auto")
    card = post(client, "/api/deal?stage=open&n=1").get_json()["cards"][0]
    before = len(s.store.votes())
    app = client.application
    def vote(outcome):
        with app.test_client() as c:
            return post(c, "/api/vote", {"card": card["id"], "outcome": outcome}).status_code
    with ThreadPoolExecutor(2) as pool:
        codes = list(pool.map(vote, ["a", "b"]))
    assert sorted(codes) == [200, 409]
    assert len(s.store.votes()) == before + 1


def test_tag_clustering_runs_outside_the_vote_lock_and_is_cached(client, monkeypatch):
    s = client.matcher.session
    post(client, "/api/stacks/auto")
    card = post(client, "/api/deal?stage=open&n=1").get_json()["cards"][0]
    entered, release = threading.Event(), threading.Event()
    cluster = tags.cluster
    calls = []
    def paused(*args, **kw):
        calls.append(1); entered.set()
        assert release.wait(5)
        return cluster(*args, **kw)
    monkeypatch.setattr(tags, "cluster", paused)
    def board():
        with client.application.test_client() as c:
            return c.get("/api/draw/board?tags=1").status_code
    with ThreadPoolExecutor(2) as pool:
        pending = pool.submit(board)
        assert entered.wait(3)
        try:
            vote = pool.submit(lambda: post(client, "/api/vote", {"card": card["id"], "outcome": "a"}).status_code)
            assert vote.result(timeout=2) == 200
        finally:
            release.set()
        assert pending.result(timeout=3) == 200
    assert client.get("/api/draw/board?tags=1").status_code == 200
    assert len(calls) == 1


def test_forget_joins_workers_and_closes_all_connections(client, monkeypatch):
    s = client.matcher.session
    entered, release = threading.Event(), threading.Event()
    def refreshing(store):
        store.conn(); entered.set(); assert release.wait(5)
    monkeypatch.setattr("matcher.server.library.refresh", refreshing)
    s.refresh_async()
    assert entered.wait(2)
    with ThreadPoolExecutor(1) as pool:
        pending = pool.submit(client.matcher.forget, s.source)
        time.sleep(0.05)
        assert not pending.done()
        release.set(); pending.result(timeout=3)
    assert s.closed and not s.workdir.exists()
    with pytest.raises(RuntimeError):
        s.store.conn()


def test_history_accumulates_exactly_and_undo_rebuilds(client):
    s = client.matcher.session
    post(client, "/api/stacks/auto")
    nxt = post(client, "/api/deal?stage=open&n=1").get_json()
    for _ in range(5):
        card = nxt["cards"][0]
        nxt = post(client, "/api/vote", {"card": card["id"], "outcome": "a", "ms": 1000}).get_json()
    post(client, "/api/undo", {"stage": "open"})
    p = s.progress()
    all_rows = [dict(v) for v in s.store.q("SELECT * FROM votes ORDER BY id")]
    expected = game.History(); expected.extend(all_rows)
    assert s._game_history.values == expected.values
    assert p["votes"] == expected.duels == 4
    assert p["minutes"] == round(expected.active_ms/60000,1)
    assert p["game"]["welcomed"] is False
    post(client, "/api/welcome")
    assert client.get("/api/game").get_json()["stats"]["welcomed"] is True
