"""A tournament stays about the current contenders, and a small field can actually finish its journey."""
import pytest
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import numpy as np

from matcher import library, tournament
from matcher.draw import Draw
from matcher.store import Store
from tests.test_filtering import client, post


def call(c, path, body=None):
    result = post(c, path, body)
    assert result.status_code == 200, result.get_data(as_text=True)
    return result.get_json()


def field(c, n):
    s = c.session
    ids = [r["id"] for r in s.store.q("SELECT id FROM photos WHERE rel LIKE 'cam/IMG_%' ORDER BY id")][:n]
    assert len(ids) == n
    with s.store.tx() as db:
        db.execute("UPDATE photos SET override='toss'")
        db.executemany("UPDATE photos SET override='keep' WHERE id=?", [(p,) for p in ids])
    library.refresh(s.store)
    s.ensure_ranker()
    return ids


@pytest.mark.parametrize("n", [4, 5, 6, 7, 8])
def test_small_group_reaches_a_real_final_without_losing_qualifiers(client, n):
    ids = field(client, n)
    group = call(client, "/api/draw/new", {"photos": ids})["theme"]
    tab = client.session.draw.table(group["id"])
    assert tab["adv"] == 4
    run = call(client, "/api/knockouts/start")
    assert set(run["knockouts"]["qualified"]) == {r["photo"] for r in tab["rows"][:4]}
    assert client.get("/api/finals").get_json()["seed_source"] == "knockouts"
    final = call(client, "/api/finals/start")
    assert final["finals"]["size"] == 4
    assert final["finals"]["seeds"] == run["knockouts"]["qualified"]


def test_partial_grouping_preserves_unassigned_contenders_and_real_byes(client):
    ids = field(client, 7)
    call(client, "/api/draw/new", {"photos": ids[:2]})
    run = call(client, "/api/knockouts/start")
    assert set(run["knockouts"]["seeds"]) == set(ids)
    played = 0
    while run["cards"]:
        card = run["cards"][0]
        run = call(client, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "knockouts"})
        played += 1
    assert played == 3
    assert len(run["knockouts"]["qualified"]) == 4
    assert call(client, "/api/finals/start")["finals"]["seeds"] == run["knockouts"]["qualified"]


def test_undo_knockout_retires_dependent_finals_and_reseeds_the_actual_winners(client):
    field(client, 7)
    s = client.session
    run = call(client, "/api/knockouts/start")
    while run["cards"]:
        last = run["cards"][0]
        run = call(client, "/api/vote", {"card": last["id"], "outcome": "a", "stage": "knockouts"})
    original = call(client, "/api/finals/start")["finals"]
    s.store.set_meta("champions", {"food": 99})
    undone = call(client, "/api/undo", {"stage": "knockouts"})
    assert undone["undone"] == "knockout" and undone["cards"][0]["id"] == last["id"]
    assert s.finals_state() is None
    archived = s.store.get_meta("tournament_archive")[-1]["cups"]["all"]
    assert archived["finals"] == original and "knockouts" not in archived
    assert s.store.get_meta("champions") == {"food": 99}
    changed = call(client, "/api/vote", {"card": last["id"], "outcome": "b", "stage": "knockouts"})
    new = call(client, "/api/finals/start")["finals"]
    assert new["seeds"] == changed["knockouts"]["qualified"]
    assert last["b"] in new["seeds"] and last["a"] not in new["seeds"]
    assert new["id"] != original["id"]


def test_undo_old_knockout_cannot_retire_a_replacement_tournament(client):
    field(client, 7)
    s = client.session
    card = call(client, "/api/knockouts/start")["cards"][0]
    call(client, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "knockouts"})
    s.knockouts_start()
    replacement = call(client, "/api/finals/start")["finals"]
    call(client, "/api/undo", {"stage": "knockouts"})
    assert s.finals_state() == replacement


@pytest.mark.parametrize("kind,n", [("knockouts", 7), ("finals", 8)])
def test_bracket_skip_defers_without_choosing_a_winner_and_survives_reload(client, kind, n):
    field(client, n)
    s = client.session
    run = call(client, f"/api/{kind}/start")
    card = run["cards"][0] if kind == "knockouts" else run["card"]
    before = len(s.store.votes())
    skipped = call(client, "/api/vote", {"card": card["id"], "outcome": "skip"})
    next_card = skipped["cards"][0] if kind == "knockouts" else skipped["card"]
    assert skipped["skipped"] and len(s.store.votes()) == before
    assert next_card["id"] != card["id"]
    assert client.get(f"/api/{kind}").get_json()["card"]["id"] == next_card["id"]
    seen = []
    run = skipped
    while True:
        current = run["cards"][0] if kind == "knockouts" and run["cards"] else run.get("card")
        if not current:
            break
        seen.append(current["id"])
        run = call(client, "/api/vote", {"card": current["id"], "outcome": "a"})
    assert card["id"] in seen
    assert len(s.store.votes()) == before + len(seen)


@pytest.mark.parametrize("kind", ["knockouts", "finals"])
def test_skip_with_one_playable_match_keeps_it_unresolved(client, kind):
    field(client, 5)
    run = call(client, f"/api/{kind}/start")
    if kind == "finals":
        while run["card"]["round"] != "final":
            run = call(client, "/api/vote", {"card": run["card"]["id"], "outcome": "a"})
    card = run["cards"][0] if kind == "knockouts" else run["card"]
    votes = len(client.session.store.votes())
    skipped = call(client, "/api/vote", {"card": card["id"], "outcome": "skip"})
    same = skipped["cards"][0] if kind == "knockouts" else skipped["card"]
    assert same["id"] == card["id"] and len(client.session.store.votes()) == votes
    assert not skipped[kind].get("champion") and not skipped[kind].get("qualified")


def test_old_three_qualifier_save_reopens_without_get_writes(client):
    ids = field(client, 6)
    call(client, "/api/draw/new", {"photos": ids})
    broken = {"id": "old", "cup": "all", "seeds": ids[:3], "rounds": [], "target": 4, "qualified": ids[:3]}
    client.session.store.set_meta("knockouts:all", broken)
    assert not client.get("/api/journey").get_json()["stages"]["duels"]["done"]
    assert client.session.store.get_meta("knockouts:all") == broken
    repaired = call(client, "/api/knockouts/start")["knockouts"]
    assert repaired["id"] != "old" and len(repaired["qualified"]) == 4


def test_optional_leaders_are_exact_undoable_and_not_fake_votes(client):
    ids = field(client, 8)
    call(client, "/api/draw/new", {"photos": ids})
    s = client.session
    before = len(s.store.votes())
    preview = client.get("/api/draw/qualify").get_json()
    assert preview["remaining"] == 1 and preview["total"] == 4
    result = call(client, "/api/draw/qualify", {"basis": preview["basis"]})
    assert result["qualified"] and len(s.store.votes()) == before
    stage = s.draw.journey()["groups"]
    assert stage["done"] and stage["chosen"] and stage["selected"] == 1
    assert call(client, "/api/deal?stage=groups")["cards"] == []
    undone = call(client, "/api/undo", {"stage": "groups"})
    assert undone["undone"] == "qualification" and undone["cards"]
    assert not s.draw.journey()["groups"]["done"]
    assert len(s.store.votes()) == before


def test_stale_qualification_preview_cannot_select_different_leaders(client):
    ids = field(client, 8)
    call(client, "/api/draw/new", {"photos": ids})
    preview = client.get("/api/draw/qualify").get_json()
    call(client, "/api/draw/move", {"photos": [ids[0]], "theme": None})
    assert post(client, "/api/draw/qualify", {"basis": preview["basis"]}).status_code == 409


def test_group_edit_retires_bracket_and_undo_restores_exact_progress(client):
    ids = field(client, 8)
    original = call(client, "/api/finals/start")["finals"]
    call(client, "/api/draw/new", {"photos": ids[:4]})
    assert client.session.finals_state() is None
    assert client.session.store.get_meta("tournament_archive")
    call(client, "/api/draw/undo")
    assert client.session.finals_state() == original


def test_legacy_bracket_gets_pre_edit_group_basis_and_still_undoes(client):
    ids = field(client, 8)
    original = call(client, "/api/finals/start")["finals"]
    old = {k: v for k, v in original.items() if k != "basis"}
    client.session.store.set_meta("finals:all", old)
    call(client, "/api/draw/new", {"photos": ids[:4]})
    assert client.session.finals_state() is None
    call(client, "/api/draw/undo")
    assert client.session.finals_state() == original


def test_stack_merge_retires_bracket_and_undo_cannot_replace_a_new_run(client):
    ids = field(client, 8)
    original = call(client, "/api/finals/start")["finals"]
    call(client, "/api/groups/merge", {"photos": ids[:2]})
    assert client.session.finals_state() is None
    replacement = call(client, "/api/finals/start")["finals"]
    assert replacement["id"] != original["id"]
    call(client, "/api/draw/undo")
    # The replacement belongs to the merged field, so neither old result is silently transplanted.
    assert client.session.finals_state() is None


def test_sweep_eligibility_edit_and_undo_restore_bracket(client):
    ids = field(client, 8)
    original = call(client, "/api/finals/start")["finals"]
    call(client, "/api/sweep", {"photo": ids[0], "keep": False})
    client.session.wait_refresh()
    assert client.session.finals_state() is None
    call(client, "/api/undo")
    assert client.session.finals_state() == original


def test_toss_can_wait_for_dependent_brackets_to_retire_before_reloading(client, monkeypatch):
    ids = field(client, 8)
    s = client.session
    original = call(client, "/api/finals/start")["finals"]
    entered, release = threading.Event(), threading.Event()
    refresh = library.refresh

    def paused(store):
        entered.set()
        assert release.wait(3)
        return refresh(store)

    monkeypatch.setattr(library, "refresh", paused)
    with ThreadPoolExecutor(1) as pool:
        pending = pool.submit(call, client, "/api/sweep", {"photo": ids[0], "keep": False, "wait": True})
        try:
            assert entered.wait(2)
            assert not pending.done()
        finally:
            release.set()
        assert pending.result(timeout=3)["change"] == "toss"
    assert s.finals_state() is None
    call(client, "/api/undo")
    assert s.finals_state() == original


def test_group_name_and_regular_votes_do_not_retire_brackets(client):
    ids = field(client, 8)
    group = call(client, "/api/draw/new", {"photos": ids})["theme"]
    original = call(client, "/api/finals/start")["finals"]
    call(client, "/api/draw/rename", {"theme": group["id"], "name": "Our favourites"})
    assert client.session.finals_state() == original
    card = call(client, "/api/deal?stage=open&n=1")["cards"][0]
    call(client, "/api/vote", {"card": card["id"], "outcome": "a"})
    assert client.session.finals_state() == original


def test_crown_cover_change_reopens_finals_and_undo_restores_the_old_run(client):
    s = client.session
    stack = next(g for g in s.groups.values() if len(g["members"]) > 1)
    old_cover = stack["rep"]
    winner = next(p for p in stack["members"] if p != old_cover)
    original = call(client, "/api/finals/start")["finals"]
    card = call(client, f"/api/deal?stack={old_cover}&n=1")["cards"][0]
    for _ in range(8):
        wanted = winner if winner in (card["a"], card["b"]) else card["champ"]
        result = call(client, "/api/vote", {"card": card["id"], "outcome": "a" if wanted == card["a"] else "b", "stage": "stacks"})
        if result.get("crowned"):
            break
        card = result["cards"][0]
    assert result["crowned"]["photo"] == winner
    s.wait_refresh()
    assert s.finals_state() is None
    assert not client.get("/api/reveal").get_json()["from_finals"]
    call(client, "/api/undo", {"stage": "stacks"})
    assert s.finals_state() == original and s.groups[s.photo_group[old_cover]]["rep"] == old_cover


def test_chosen_leaders_stay_fixed_but_membership_edits_reopen_the_group(client):
    ids = field(client, 8)
    group = call(client, "/api/draw/new", {"photos": ids})["theme"]
    s = client.session
    preview = client.get("/api/draw/qualify").get_json()
    leaders = preview["groups"][0]["photos"]
    call(client, "/api/draw/qualify", {"basis": preview["basis"]})
    loser = next(p for p in ids if p not in leaders)
    s.ranker.post.mu[s._item(loser)] = 1000
    s.draw._stage = None
    assert [r["photo"] for r in s.draw.table(group["id"])["rows"][:4]] == leaders
    call(client, "/api/draw/move", {"photos": [ids[0]], "theme": None})
    assert not s.draw.journey()["groups"]["chosen"]
    call(client, "/api/draw/undo")
    assert s.draw.journey()["groups"]["chosen"]


def test_undo_a_final_does_not_resurrect_another_cups_retired_champion(client):
    ids = field(client, 8)
    s = client.session
    s.store.set_meta("champions", {"food": ids[0]})
    run = call(client, "/api/finals/start")
    while run["card"]:
        run = call(client, "/api/vote", {"card": run["card"]["id"], "outcome": "a"})
    tournament.retire(s.store, {"food"})
    assert "food" not in s.store.get_meta("champions")
    call(client, "/api/undo")
    assert s.store.get_meta("champions") == {}


def test_qualification_of_ten_thousand_uses_bounded_queries_and_no_votes(tmp_path, monkeypatch):
    store = Store(tmp_path / "test.sqlite")
    with store.tx() as db:
        db.executemany("INSERT INTO photos(id,rel,status,theme_id) VALUES(?,?,'analyzed',?)",
                       [(i + 1, f"synthetic-{i}.jpg", i // 100) for i in range(10000)])
        db.executemany("INSERT INTO groups(id,rep,members,scene) VALUES(?,?,?,0)",
                       [(i + 1, i + 1, f"[{i+1}]") for i in range(10000)])
    s = SimpleNamespace(store=store, cup="all", reps=list(range(1, 10001)), cards={}, groups_cache={})
    draw = Draw(s)
    groups = {i: {"id": i, "name": f"Group {i}", "emoji": "📷", "n": 100, "adv": 1,
                  "order": np.arange(i * 100, (i + 1) * 100), "settled": False} for i in range(100)}
    monkeypatch.setattr(draw, "stage", lambda: {"groups": groups})
    original, queries = store.q, []
    def query(sql, args=()):
        queries.append(sql)
        return original(sql, args)
    monkeypatch.setattr(store, "q", query)
    preview = draw.qualification()
    assert preview["total"] == 100 and sum(len(g["photos"]) for g in preview["groups"]) == 100
    result = draw.qualify(preview["basis"])
    assert result["qualified"] and store.votes() == ()
    assert len(queries) < 30  # No per-photo SQL, model run, or ranker update.
    store.close()


def test_set_aside_favorite_stays_out_of_exports_and_rescue_restores_intent(client):
    field(client, 8)
    photo = client.get("/api/shortlist").get_json()["bubble"][0]["photo"]
    call(client, "/api/pick", {"photo": photo, "on": True})
    assert photo in [r["photo"] for r in client.get("/api/shortlist").get_json()["added"]]
    call(client, "/api/filter/decision", {"photos": [photo], "action": "aside"})
    board = client.get("/api/shortlist").get_json()
    assert photo not in [r["photo"] for r in board["items"] + board["added"]]
    result = call(client, "/api/export", {"kind": "bestof"})
    assert result["count"] == len(board["items"])
    assert client.session.store.one("SELECT pick FROM photos WHERE id=?", (photo,))["pick"]
    call(client, "/api/filter/decision", {"photos": [photo], "action": "keep"})
    board = client.get("/api/shortlist").get_json()
    assert next(r for r in board["items"] + board["added"] if r["photo"] == photo)["added"]


def test_merged_favorites_export_the_current_stack_cover_once(client):
    field(client, 8)
    photos = [r["photo"] for r in client.get("/api/shortlist").get_json()["bubble"][:2]]
    for photo in photos:
        call(client, "/api/pick", {"photo": photo, "on": True})
    call(client, "/api/groups/merge", {"photos": photos})
    s = client.session
    cover = s.groups[s.photo_group[photos[0]]]["rep"]
    board = client.get("/api/shortlist").get_json()
    out = board["items"] + board["added"]
    assert len([r for r in out if r["photo"] == cover]) == 1
    assert next(r for r in out if r["photo"] == cover)["added"]
    assert call(client, "/api/export", {"kind": "bestof"})["count"] == len(out)
    call(client, "/api/pick", {"photo": cover, "on": False})
    board = client.get("/api/shortlist").get_json()
    assert not any(r["added"] for r in board["items"] + board["added"] + board["bubble"])
