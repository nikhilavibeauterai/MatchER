"""Forward replay restores recorded edits, without reinterpreting a vote or touching a real save."""
import json
from matcher import filtering, library
from matcher.server import Session
from tests.test_filtering import apply, client, fetch, post


def call(client, path, body=None):
    response = post(client, path, body)
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def state(client):
    data = fetch(client)
    return data["policy"], data["scores"], client.session.store.get_meta("filter_reviews"), client.session.store.get_meta("filter_preferences")


def test_tuning_undo_and_redo_restore_source_and_teaching_together(client):
    pid = fetch(client)["ids"]["kept"][0]
    before = state(client)
    call(client, "/api/filter/tune", {"photo": pid, "direction": "away"})
    taught = state(client)
    undo = client.get("/api/draw/history").get_json()["undo"]
    assert undo["label"] == "filter tune away" and undo["photo"] == pid
    result = call(client, "/api/draw/undo")
    assert state(client) == before
    assert result["history"]["redo"] == undo
    result = call(client, "/api/draw/redo")
    assert result["redone"] == "filter tune away" and result["history"]["redo"] is None
    assert result["history"]["undo"] == undo and state(client) == taught
    call(client, "/api/draw/undo")
    assert state(client) == before


def test_multiple_undo_redo_keeps_policy_overrides_and_order(client):
    data = fetch(client)
    pid = data["ids"]["kept"][0]
    original = state(client)
    call(client, "/api/filter/decision", {"photos": [pid], "action": "keep"})
    chosen = state(client)
    apply(client, {**data["policy"], "min_pixels": 3000})
    applied = state(client)
    assert applied[1][str(pid)] == 1
    call(client, "/api/draw/undo")
    assert state(client) == chosen
    call(client, "/api/draw/undo")
    assert state(client) == original
    call(client, "/api/draw/redo")
    assert state(client) == chosen
    assert client.get("/api/draw/history").get_json()["redo"]["label"] == "filter rules"
    call(client, "/api/draw/redo")
    assert state(client) == applied


def test_new_edit_or_game_vote_invalidates_redo(client):
    first, second = fetch(client)["ids"]["kept"][:2]
    call(client, "/api/filter/tune", {"photo": first, "direction": "away"})
    call(client, "/api/draw/undo")
    call(client, "/api/filter/decision", {"photos": [second], "action": "keep"})
    assert client.get("/api/draw/history").get_json()["redo"] is None
    assert post(client, "/api/draw/redo").status_code == 409
    call(client, "/api/draw/undo")
    client.session.store.add_vote("duel", first, second, first, 250)
    assert client.get("/api/draw/history").get_json()["redo"] is None
    assert post(client, "/api/draw/redo").status_code == 409


def test_redo_refuses_a_modified_undo_target(client):
    pid = fetch(client)["ids"]["kept"][0]
    call(client, "/api/filter/decision", {"photos": [pid], "action": "aside"})
    call(client, "/api/draw/undo")
    with client.session.store.tx() as c:
        c.execute("UPDATE photos SET override='keep' WHERE id=?", (pid,))
    assert post(client, "/api/draw/redo").status_code == 409
    assert client.session.store.one("SELECT override FROM photos WHERE id=?", (pid,))[0] == "keep"


def test_stack_edits_and_group_rows_replay_without_new_votes(client):
    s = client.session
    first, second = map(int, s.reps[:2])
    before = s.draw.snapshot([first, second])
    call(client, "/api/groups/merge", {"photos": [first, second]})
    merged = s.draw.snapshot([first, second])
    count = s.store.one("SELECT COUNT(*) FROM votes")[0]
    call(client, "/api/draw/undo")
    assert s.draw.snapshot([first, second]) == before
    call(client, "/api/draw/redo")
    assert s.draw.snapshot([first, second]) == merged
    assert s.photo_group[first] == s.photo_group[second]
    assert s.store.one("SELECT COUNT(*) FROM votes")[0] == count
    theme = call(client, "/api/draw/new", {"photos": [first]})["theme"]
    call(client, "/api/draw/rename", {"theme": theme["id"], "name": "My team"})
    call(client, "/api/draw/undo")
    call(client, "/api/draw/undo")
    assert not s.store.one("SELECT id FROM themes WHERE id=?", (theme["id"],))
    call(client, "/api/draw/redo")
    call(client, "/api/draw/redo")
    assert s.store.one("SELECT name FROM themes WHERE id=?", (theme["id"],))[0] == "My team"


def test_help_preference_is_save_specific_and_does_not_refresh(client, monkeypatch):
    s = client.session
    assert s.settings["help"] is True
    signature = library._inputs_sig(s.store)
    monkeypatch.setattr(s, "refresh_async", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Help must not rescan")))
    assert call(client, "/api/settings", {"help": False})["settings"]["help"] is False
    assert s.store.get_meta("settings")["help"] is False
    assert library._inputs_sig(s.store) == signature
    assert post(client, "/api/settings", {"help": "false"}).status_code == 400
    assert s.settings["help"] is False
    reopened = Session(s.source, s.workdir.parent)
    other = Session(s.source.parent / "other-library", s.workdir.parent)
    try:
        assert reopened.settings["help"] is False
        assert other.settings["help"] is True
    finally:
        reopened.shutdown()
        other.shutdown()


def test_coverage_outlives_the_bounded_learning_sample_and_replays(client, monkeypatch):
    monkeypatch.setattr(filtering, "LEARNING_LIMIT", 2)
    ids = fetch(client)["ids"]["kept"][:3]
    for pid in ids:
        call(client, "/api/filter/decision", {"photos": [pid], "action": "keep"})
    s = client.session
    assert len(s.store.get_meta("filter_reviews")) == 2
    assert s.progress()["game"]["filter_considered"] == 3
    call(client, "/api/draw/undo")
    assert s.progress()["game"]["filter_considered"] == 2
    call(client, "/api/draw/redo")
    assert s.progress()["game"]["filter_considered"] == 3


def test_game_duels_replay_the_recorded_votes_and_new_edits_clear_redo(client):
    from tests.test_tournament_consistency import field
    field(client, 4)
    s = client.session
    for _ in range(2):
        card = call(client, "/api/deal?n=1")["cards"][0]
        assert card["type"] == "duel"
        call(client, "/api/vote", {"card": card["id"], "outcome": "a"})
    recorded = [tuple(row) for row in s.store.votes()]
    last = client.get("/api/history").get_json()["undo"]
    assert last["photo"] == card["a"] and last["label"] == "duel"
    call(client, "/api/undo")
    assert client.get("/api/history").get_json()["redo"] == last
    call(client, "/api/undo")
    assert not s.store.votes()
    call(client, "/api/redo")
    assert len(s.store.votes()) == 1
    call(client, "/api/redo")
    assert [tuple(row) for row in s.store.votes()] == recorded
    assert s.progress()["votes"] == 2
    call(client, "/api/undo")
    call(client, "/api/filter/decision", {"photos": [card["a"]], "action": "keep"})
    assert client.get("/api/history").get_json()["redo"] is None
    assert post(client, "/api/redo").status_code == 409


def test_crown_redo_restores_rounds_and_the_final_cover(client):
    s = client.session
    stack = next(g for g in s.groups.values() if len(g["members"]) >= 3)
    card = call(client, f"/api/deal?stack={stack['rep']}&n=1")["cards"][0]
    winner = card["champ"]
    first = True
    while True:
        result = call(client, "/api/vote", {"card": card["id"], "outcome": "a" if card["a"] == winner else "b", "stage": "stacks"})
        s.wait_refresh()
        if first or result.get("crowned"):
            forward = s.store.get_meta("mini_state")
            rows = s.draw.snapshot(stack["members"])
            votes = [tuple(row) for row in s.store.votes()]
            call(client, "/api/undo", {"stage": "stacks"})
            call(client, "/api/redo", {"stage": "stacks"})
            assert s.draw.snapshot(stack["members"]) == rows
            assert [tuple(row) for row in s.store.votes()] == votes
            assert s.store.get_meta("mini_state") == forward
            first = False
        if result.get("crowned"):
            break
        card = call(client, f"/api/deal?stack={stack['rep']}&n=1")["cards"][0]
    assert s.groups[s.photo_group[winner]]["rep"] == winner
    assert s.groups[s.photo_group[winner]]["checked"]


def test_knockout_redo_restores_qualifiers_and_dependent_finals(client):
    from tests.test_tournament_consistency import field
    field(client, 7)
    s = client.session
    run = call(client, "/api/knockouts/start")
    while run["cards"]:
        card = run["cards"][0]
        run = call(client, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "knockouts"})
    final = call(client, "/api/finals/start")["finals"]
    knockout = s.store.get_meta("knockouts:all")
    call(client, "/api/undo", {"stage": "knockouts"})
    assert s.finals_state() is None
    call(client, "/api/redo", {"stage": "knockouts"})
    assert s.finals_state() == final
    assert s.store.get_meta("knockouts:all") == knockout
    run = client.get("/api/finals").get_json()
    while run["card"]:
        card = run["card"]
        run = call(client, "/api/vote", {"card": card["id"], "outcome": "a"})
    finished = s.finals_state()
    champions = s.store.get_meta("champions")
    call(client, "/api/undo")
    assert not s.finals_state().get("champion")
    call(client, "/api/redo")
    assert s.finals_state() == finished and s.store.get_meta("champions") == champions


def test_sweep_redo_and_group_qualification_keep_their_original_scope(client):
    from tests.test_tournament_consistency import field
    ids = field(client, 7)
    s = client.session
    call(client, "/api/sweep", {"photo": ids[0], "keep": False, "wait": True})
    assert ids[0] in fetch(client)["ids"]["aside"]
    call(client, "/api/undo")
    assert ids[0] in fetch(client)["ids"]["kept"]
    call(client, "/api/redo")
    assert ids[0] in fetch(client)["ids"]["aside"]
    call(client, "/api/draw/new", {"photos": ids[1:]})
    preview = client.get("/api/draw/qualify").get_json()
    call(client, "/api/draw/qualify", {"basis": preview["basis"]})
    qualified = s.store.get_meta("group_qualification:all")
    assert client.get("/api/history?stage=groups").get_json()["undo"]["label"] == "qualify leaders"
    call(client, "/api/undo", {"stage": "groups"})
    assert not s.store.get_meta("group_qualification:all")
    call(client, "/api/redo", {"stage": "groups"})
    assert s.store.get_meta("group_qualification:all") == qualified
    assert s.draw.last_step() == "qualify leaders"


def test_tag_redo_restores_edits_and_label_metadata(client):
    from matcher import tags
    s = client.session
    pid = fetch(client)["ids"]["kept"][0]
    tag = call(client, "/api/tags/new", {"label": "Road trip", "photos": [pid]})
    key = tag["key"]
    call(client, "/api/tags/meta", {"key": key, "label": "Summer", "pinned": True})
    call(client, "/api/draw/undo")
    call(client, "/api/draw/undo")
    assert key not in tags.effective(s.store, [pid])[pid]
    call(client, "/api/draw/redo")
    call(client, "/api/draw/redo")
    assert key in tags.effective(s.store, [pid])[pid]
    row = s.store.one("SELECT label,pinned FROM tags WHERE key=?", (key,))
    assert tuple(row) == ("Summer", 1)


def test_home_orders_editor_and_game_history_and_reports_each_forward_stream(client):
    from tests.test_tournament_consistency import field
    ids = field(client, 4)
    def history():
        return client.get("/api/history?stage=home").get_json()
    call(client, "/api/filter/decision", {"photos": [ids[0]], "action": "keep"})
    assert history()["undo_stream"] == "group"
    card = call(client, "/api/deal?n=1")["cards"][0]
    call(client, "/api/vote", {"card": card["id"], "outcome": "a"})
    assert history()["stream"] == history()["undo_stream"] == "vote"
    call(client, "/api/undo")
    assert history()["undo_stream"] == "group" and history()["redo_stream"] == "vote"
    call(client, "/api/draw/undo")
    assert history()["undo"] is None and history()["redo_stream"] == "group"
    call(client, "/api/draw/redo")
    assert history()["undo_stream"] == "group" and history()["redo_stream"] == "vote"
    call(client, "/api/redo")
    assert history()["undo_stream"] == "vote" and history()["redo"] is None
    call(client, "/api/filter/decision", {"photos": [ids[1]], "action": "keep"})
    assert history()["undo_stream"] == "group"
    call(client, "/api/draw/undo")
    assert history()["undo_stream"] == "vote" and history()["redo_stream"] == "group"


def test_home_does_not_guess_the_order_of_old_unsequenced_edits(client):
    s = client.session
    pid = fetch(client)["ids"]["kept"][0]
    s.store.add_vote("duel", pid, pid + 1, pid)
    s.store.set_meta("group_history", [{"label": "rename", "before": []}])
    result = client.get("/api/history?stage=home").get_json()
    assert result["ambiguous"] and result["undo"] is None and result["undo_stream"] is None


def test_one_choice_stores_only_its_provenance_delta_in_a_large_history(client):
    s = client.session
    pid = fetch(client)["ids"]["kept"][0]
    prior = {str(i + 100000): {"action": "keep", "kind": "individual", "seq": i + 1} for i in range(10000)}
    s.store.set_meta("filter_decisions", prior)
    call(client, "/api/filter/decision", {"photos": [pid], "action": "keep"})
    entry = s.store.get_meta("group_history")[-1]
    assert "decisions" not in entry["filter_before"]
    assert entry["filter_before"]["decision_patch"] == [[str(pid), None]]
    assert len(json.dumps(entry)) < 20000
    call(client, "/api/draw/undo")
    assert s.store.get_meta("filter_decisions") == prior
    redo = s.store.get_meta("group_redo")[-1]
    assert len(json.dumps(redo)) < 20000
    assert [key for table, key, *_ in redo["patch"] if table == "meta" and key.startswith("filter_decision:")] == [f"filter_decision:{pid}"]
    call(client, "/api/draw/redo")
    assert {key: value for key, value in s.store.get_meta("filter_decisions").items() if key != str(pid)} == prior
