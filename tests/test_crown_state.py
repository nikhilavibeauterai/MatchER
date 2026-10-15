"""Crown follows the editable stacks and groups, including changes made during a run."""
import pytest

from matcher import library
from matcher.server import Session

from tests.test_server import client, post
from tests.test_game_flow import gallery


def stacks(c):
    s = c.matcher.session
    s.ensure_ranker()
    return sorted((g for g in s.groups.values() if len(g["members"]) > 1), key=lambda g: -len(g["members"]))


def call(c, path, body=None):
    r = post(c, path, body)
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()


def deal(c, photo):
    r = call(c, f"/api/deal?stack={photo}&n=1")
    assert r["stage"] == "stacks"
    return r["cards"][0]


def finish(c, card, winner=None):
    winner = winner or card["champ"]
    for _ in range(card["total"]):
        pick = winner if winner in (card["a"], card["b"]) else card["champ"]
        r = call(c, "/api/vote", {"card": card["id"], "outcome": "a" if card["a"] == pick else "b", "stage": "stacks"})
        if r.get("crowned"):
            assert r["crowned"]["photo"] == winner
            return r
        card = r["cards"][0]
    pytest.fail("Crown did not finish its stack")


def group(c, photos):
    return call(c, "/api/draw/new", {"photos": photos})["theme"]["id"]


def test_skip_defers_a_challenger_without_a_vote_or_crown_and_survives_reload(client):
    s = client.matcher.session
    stack = stacks(client)[0]
    card = deal(client, stack["rep"])
    assert card["total"] >= 2
    champ = card["champ"]
    challenger = card["b"] if card["a"] == champ else card["a"]
    votes = len(s.store.votes())
    result = call(client, "/api/vote", {"card": card["id"], "outcome": "skip", "stage": "stacks"})
    deferred = result["cards"][0]
    assert result["mini"] == {"skipped": True} and not result.get("crowned")
    assert len(s.store.votes()) == votes
    assert deferred["round"] == card["round"] and deferred["beaten"] == [] and deferred["champ"] == champ
    assert challenger not in (deferred["a"], deferred["b"])
    # A new session reads the same pending order, not the original first challenger.
    replacement = Session(s.source, s.workdir.parent)
    try:
        replacement.ensure_ranker()
        saved = replacement.minis[replacement.photo_group[champ]]
        assert saved["frames"][saved["next"]] != challenger
        assert saved["frames"][-1] == challenger and saved["beaten"] == []
    finally:
        replacement.shutdown()
    # The deferred take still gets its decision before the stack can be crowned.
    result = finish(client, deferred, winner=challenger)
    assert result["crowned"]["photo"] == challenger


def test_skip_last_challenger_preserves_the_pair_and_previous_win_undo(client):
    s = client.matcher.session
    card = deal(client, stacks(client)[0]["rep"])
    previous = None
    while card["round"] < card["total"]:
        previous = card
        result = call(client, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "stacks"})
        card = result["cards"][0]
    votes = len(s.store.votes())
    for _ in range(3):
        skipped = call(client, "/api/vote", {"card": card["id"], "outcome": "skip", "stage": "stacks"})
        nxt = skipped["cards"][0]
        assert {nxt["a"], nxt["b"]} == {card["a"], card["b"]}
        assert nxt["champ"] == card["champ"] and nxt["beaten"] == card["beaten"]
        assert not skipped.get("crowned") and len(s.store.votes()) == votes
        card = nxt
    undone = call(client, "/api/undo", {"stage": "stacks"})["cards"][0]
    assert {undone["a"], undone["b"]} == {previous["a"], previous["b"]}
    assert undone["round"] == previous["round"] and undone["champ"] == previous["champ"]


def test_merging_crowned_stacks_reopens_combined_crown_and_undo_restores_picks(client):
    s = client.matcher.session
    a, b = stacks(client)
    pa, pb = a["members"][-1], b["members"][-1]
    finish(client, deal(client, pa), pa)
    finish(client, deal(client, pb), pb)
    assert s.progress()["crown_left"] == 0
    members = set(a["members"] + b["members"])
    call(client, "/api/groups/merge", {"photos": [pa, pb]})
    assert s.progress()["crown_left"] == 1
    assert not any(pref for _, _, pref in s.draw.snapshot(members))
    card = deal(client, pa)
    assert set(card["frames"]) == members and card["round"] == 1
    assert s.progress()["crown_left"] == 1  # A dealt question is still unfinished.
    finish(client, card, pa)
    assert s.progress()["crown_left"] == 0
    call(client, "/api/draw/undo")
    assert s.photo_group[pa] != s.photo_group[pb]
    assert {g["rep"] for g in stacks(client)} == {pa, pb}
    assert all(g["checked"] for g in stacks(client))
    assert s.progress()["crown_left"] == 0


def test_merge_during_crown_discards_old_round_and_persisted_membership(client):
    s = client.matcher.session
    a, b = stacks(client)
    first = deal(client, a["rep"])
    old = call(client, "/api/vote", {"card": first["id"], "outcome": "a", "stage": "stacks"})["cards"][0]
    call(client, "/api/groups/merge", {"photos": [a["rep"], b["rep"]]})
    before = len(s.store.votes())
    assert post(client, "/api/vote", {"card": old["id"], "outcome": "a"}).status_code == 409
    assert len(s.store.votes()) == before and not s.store.get_meta("mini_state")["minis"]
    fresh = deal(client, a["rep"])
    assert fresh["round"] == 1 and set(fresh["frames"]) == set(a["members"] + b["members"])


def test_manual_keep_expires_crown_and_explicit_recrown_uses_current_pick(client):
    s = client.matcher.session
    a, _ = stacks(client)
    group(client, [a["rep"]])  # Explicit Crown must override the group's default stage.
    old = deal(client, a["rep"])
    chosen = a["members"][-1]
    call(client, "/api/frame", {"photo": chosen})
    assert post(client, "/api/vote", {"card": old["id"], "outcome": "a"}).status_code == 409
    fresh = deal(client, chosen)
    assert fresh["champ"] == chosen and fresh["round"] == 1
    assert s.progress()["crown_left"] == 2  # Explicitly reopened, plus the other untouched stack.


@pytest.mark.parametrize("edit", ["merge", "keep"])
def test_undo_old_crown_cannot_restore_its_pick_over_newer_stack_edit(client, edit):
    s = client.matcher.session
    a, b = stacks(client)
    previous, winner, latest = a["members"][:3]
    call(client, "/api/frame", {"photo": previous})
    finish(client, deal(client, previous), winner)
    if edit == "merge":
        call(client, "/api/groups/merge", {"photos": [winner, b["rep"]]})
    else:
        call(client, "/api/frame", {"photo": latest})
    before = s.draw.snapshot(a["members"] + b["members"])
    call(client, "/api/undo", {"stage": "stacks"})
    assert s.draw.snapshot(a["members"] + b["members"]) == before
    if edit == "merge":
        assert s.progress()["crown_left"] == 1
    else:
        assert s.groups[s.photo_group[latest]]["rep"] == latest


@pytest.mark.parametrize("assigned", [False, True])
def test_moving_take_reopens_stacks_and_winner_keeps_destination_group(client, assigned):
    s = client.matcher.session
    a, b = stacks(client)
    moving = a["members"][-1]
    source_group = group(client, [a["rep"]])
    dest_group = group(client, [b["rep"]]) if assigned else None
    call(client, "/api/frame", {"photo": a["rep"]})
    call(client, "/api/frame", {"photo": b["rep"]})
    call(client, "/api/groups/move", {"photo": moving, "target": b["rep"]})
    assert s.progress()["crown_left"] == 2
    joined = s.groups[s.photo_group[moving]]["members"]
    assert {s.store.one("SELECT theme_id FROM photos WHERE id=?", (p,))[0] for p in joined} == {dest_group}
    finish(client, deal(client, moving), moving)
    assert s.draw.theme_of()[s._item(moving)] == (dest_group if assigned else -1)
    call(client, "/api/draw/undo")
    assert s.photo_group[moving] == s.photo_group[a["rep"]] != s.photo_group[b["rep"]]
    assert s.store.one("SELECT theme_id FROM photos WHERE id=?", (moving,))[0] == source_group
    assert s.progress()["crown_left"] == 0


def test_merge_into_unassigned_does_not_resurrect_old_group_on_crown(client):
    s = client.matcher.session
    a, b = stacks(client)
    old_group = group(client, [a["rep"]])
    winner = a["rep"]
    call(client, "/api/groups/merge", {"photos": [a["rep"], b["rep"]]})
    finish(client, deal(client, winner), winner)
    assert s.draw.theme_of()[s._item(winner)] == -1
    assert not s.store.one("SELECT id FROM themes WHERE id=?", (old_group,))
    call(client, "/api/draw/undo")
    assert s.draw.theme_of()[s._item(winner)] == old_group
    assert s.store.one("SELECT id FROM themes WHERE id=?", (old_group,))


@pytest.mark.parametrize("edit", ["move", "rename", "merge", "dissolve"])
def test_in_progress_crown_keeps_current_group_after_group_edits(client, edit):
    s = client.matcher.session
    a, b = stacks(client)
    ta, tb = group(client, [a["rep"]]), group(client, [b["rep"]])
    first = deal(client, a["rep"])
    card = call(client, "/api/vote", {"card": first["id"], "outcome": "a", "stage": "stacks"})["cards"][0]
    expected = ta
    if edit == "move":
        call(client, "/api/draw/move", {"photos": [a["rep"]], "theme": tb})
        expected = tb
    elif edit == "merge":
        call(client, "/api/draw/merge", {"from": ta, "into": tb})
        expected = tb
    elif edit == "rename":
        call(client, "/api/draw/rename", {"theme": ta, "name": "Current group"})
    else:
        call(client, "/api/draw/dissolve", {"theme": ta})
        expected = -1
    # Group edits do not change the takes being compared, so an honest round can continue.
    result = finish(client, card, card["frames"][-1])
    winner = result["crowned"]["photo"]
    assert int(s.draw.theme_of()[s._item(winner)]) == expected
    assert all(s.store.one("SELECT theme_id FROM photos WHERE id=?", (p,))[0] == (None if expected < 0 else expected)
               for p in a["members"])


def test_group_stage_drops_held_duel_after_its_stacks_move_apart(client):
    s = client.matcher.session
    a, b = stacks(client)
    tid = group(client, [a["rep"], b["rep"]])
    with s.lock:
        first = s._public(s._pair_card(s._item(a["rep"]), s._item(b["rep"])))
    assert s.followups and first["type"] == "mini"
    call(client, "/api/draw/move", {"photos": [a["rep"]], "theme": None})
    call(client, "/api/stacks/auto")
    r = call(client, "/api/deal?stage=groups&n=1")
    assert not r["cards"] and not s.followups


def test_best_guesses_includes_dealt_stacks_and_undo_restores_counter(client):
    s = client.matcher.session
    before = len(stacks(client))
    r = call(client, "/api/deal?stage=stacks&n=2")
    assert len(r["cards"]) == before == r["progress"]["crown_left"]
    r = call(client, "/api/stacks/auto")
    assert r["crowned"] == before and r["progress"]["crown_left"] == 0
    call(client, "/api/draw/undo")
    assert s.progress()["crown_left"] == before


@pytest.mark.parametrize("change_pick", [False, True])
def test_crown_updates_cached_stack_group_and_world_covers_immediately(client, monkeypatch, change_pick):
    s = client.matcher.session
    a, _ = stacks(client)
    tid = group(client, [a["rep"]])
    old = a["rep"]
    winner = next(p for p in a["members"] if p != old) if change_pick else old
    client.get("/api/groups?view=stacks")  # Prime the page cache before Crown changes its cover.
    monkeypatch.setattr(s, "refresh_async", lambda full=True: None)
    finish(client, deal(client, old), winner)
    shot = next(x for x in client.get("/api/groups?view=stacks").get_json()["shots"] if winner in x["members"])
    assert shot["rep"] == winner and shot["kept"]
    board = client.get("/api/draw/board").get_json()
    roster = next(g for g in board["groups"] if g["id"] == tid)
    assert roster["shots"][0]["rep"] == winner
    world = client.get("/api/world").get_json()["photos"]
    assert {p["rep"] for p in world if p["id"] in a["members"]} == {winner}
    row = s.store.one("SELECT rep, frame_checked FROM groups WHERE id=?", (s.photo_group[winner],))
    assert row["rep"] == winner and row["frame_checked"]


def test_crown_suspends_across_cups_and_rejects_set_aside_stack(gallery):
    s = gallery.matcher.session
    a, _ = stacks(gallery)
    card = deal(gallery, a["rep"])
    card = call(gallery, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "stacks"})["cards"][0]
    other_cup = next(c["key"] for c in s.cups() if c["key"] != "all" and c["key"] != s.cats[s._item(a["rep"])] )
    call(gallery, "/api/cup", {"cup": other_cup})
    assert post(gallery, "/api/vote", {"card": card["id"], "outcome": "a"}).status_code == 409
    assert post(gallery, f"/api/deal?stack={a['rep']}").status_code == 400
    call(gallery, "/api/cup", {"cup": "all"})
    resumed = deal(gallery, a["rep"])
    assert resumed["round"] == card["round"] and resumed["champ"] == card["champ"]
    call(gallery, "/api/draw/toss", {"photo": a["rep"]})
    assert post(gallery, "/api/vote", {"card": resumed["id"], "outcome": "a"}).status_code == 409
    assert post(gallery, f"/api/deal?stack={a['rep']}").status_code == 400


def big_picked_stacks(c, n=3, size=10):
    s = c.matcher.session
    s.ensure_ranker()
    singles = [g["rep"] for gid, g in s.groups.items() if len(g["members"]) == 1 and s.ranker.active[s.gidx[gid]]]
    picks = []
    for k in range(n):
        members = singles[k * size:(k + 1) * size]
        assert len(members) == size
        call(c, "/api/groups/merge", {"photos": members})
        current = s.groups[s.photo_group[members[0]]]
        pick = current["members"][-1]  # A manual favourite that quality sampling alone would drop.
        call(c, "/api/frame", {"photo": pick})
        picks.append(pick)
    return picks


def test_large_merge_keeps_former_winners_across_restart_chained_merge_and_undo(client):
    s = client.matcher.session
    a, b, c = big_picked_stacks(client)
    call(client, "/api/groups/merge", {"photos": [a, b]})
    assert set(deal(client, a)["frames"][:2]) == {a, b}
    s.shutdown()
    restored = Session(s.source, s.workdir.parent)
    client.matcher.session = restored
    client.matcher._sessions[str(s.source)] = restored
    assert set(deal(client, a)["frames"][:2]) == {a, b}
    call(client, "/api/groups/merge", {"photos": [a, c]})
    card = deal(client, a)
    assert set(card["frames"][:3]) == {a, b, c} and len(card["frames"]) == 8
    call(client, "/api/draw/undo")
    assert set(deal(client, a)["frames"][:2]) == {a, b}
    assert restored.groups[restored.photo_group[c]]["checked"]


def test_merging_more_than_eight_winners_keeps_every_distinct_winner(client):
    picks = big_picked_stacks(client, n=9, size=2)
    call(client, "/api/groups/merge", {"photos": picks})
    card = deal(client, picks[0])
    assert set(card["frames"]) == set(picks) and card["total"] == 8


def test_draw_twin_merge_seeds_both_former_winners(client):
    a, b = big_picked_stacks(client, n=2)
    tid = group(client, [b])
    call(client, "/api/draw/call", {"theme": tid, "photo": a, "call": "twin", "twin": b})
    assert set(deal(client, a)["frames"][:2]) == {a, b}


def test_duplicate_only_stack_is_not_crownable_and_manual_pick_is_preserved(client):
    s = client.matcher.session
    a, _ = stacks(client)
    members = a["members"][:2]
    call(client, "/api/groups/unstack", {"photo": a["rep"]})
    with s.store.tx() as c:
        c.execute("UPDATE photos SET phash='1234' WHERE id IN (?,?)", members)
    library.release(s.store)
    call(client, "/api/groups/merge", {"photos": members})
    call(client, "/api/frame", {"photo": members[1]})
    gid = s.photo_group[members[1]]
    assert s.distinct[gid] == [members[1]]
    assert client.get(f"/api/group/{members[1]}").get_json()["crownable"] is False
    shot = next(x for x in client.get("/api/groups?view=stacks").get_json()["shots"] if members[1] in x["members"])
    assert shot["crownable"] is False and shot["rep"] == members[1]


def test_distinct_sampling_keeps_preferred_file_of_pixel_twins():
    rows = {1: {"sha256": "first", "phash": "ffff"}, 2: {"sha256": "other", "phash": "0000"},
            3: {"sha256": "first", "phash": "ffff"}}
    assert Session._distinct_takes([1, 2, 3], rows, preferred=[3]) == [3, 2]
