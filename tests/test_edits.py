"""The Leaderboard's finishing choices: saved per photo, one undo step each, baked into Save my best."""
from pathlib import Path

import pytest
from PIL import Image

from tests.test_game_flow import _app, play_duels, post


@pytest.fixture
def client(tmp_path, fake_prompts):
    c = _app(tmp_path, "gallery")
    yield c
    for session in c.matcher._sessions.values():
        session.shutdown()


def top_edits(c):
    return c.get("/api/shortlist").get_json()["items"][0]["edits"]


def test_edits_are_saved_normalised_and_undone_one_at_a_time(client):
    play_duels(client, 5)
    top = client.get("/api/shortlist").get_json()["items"][0]
    assert top["edits"] == {}
    r = post(client, "/api/edit", {"photo": top["photo"], "rotate": 90, "enhance": False}).get_json()
    assert r["edits"] == {"rotate": 90, "enhance": False} and r["undo"] == "edit" and r["photo"] == top["photo"]
    assert top_edits(client) == {"rotate": 90, "enhance": False}
    r = post(client, "/api/edit", {"photo": top["photo"], "crop": "auto"}).get_json()
    assert r["edits"] == {"rotate": 90, "enhance": False, "crop": "subject"}  # "auto" is the old word for subject
    # Back to the defaults is stored as nothing at all.
    r = post(client, "/api/edit", {"photo": top["photo"], "rotate": 360, "enhance": True, "crop": "none"}).get_json()
    assert r["edits"] == {} and top_edits(client) == {}
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit"
    assert top_edits(client) == {"rotate": 90, "enhance": False, "crop": "subject"}
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit"
    assert top_edits(client) == {"rotate": 90, "enhance": False}
    assert post(client, "/api/draw/redo").get_json()["redone"] == "edit"
    assert top_edits(client) == {"rotate": 90, "enhance": False, "crop": "subject"}
    assert post(client, "/api/edit", {"photo": top["photo"], "rotate": 45}).status_code == 400
    assert post(client, "/api/edit", {"photo": top["photo"], "crop": "square"}).status_code == 400
    assert post(client, "/api/edit", {"photo": 10**9, "rotate": 90}).status_code == 404


def test_the_export_bakes_the_edits_in(client):
    play_duels(client, 5)
    top = client.get("/api/shortlist").get_json()["items"][0]
    post(client, "/api/edit", {"photo": top["photo"], "rotate": 90, "enhance": False})
    r = post(client, "/api/export", {"kind": "bestof"}).get_json()
    out = Path(r["dir"])
    first = sorted(p for p in out.iterdir() if p.is_file())[0]
    touched = out / "touched up" / (first.stem + ".jpg")
    assert first.name.startswith("01 - ") and touched.exists() and r["touched"] == r["count"]
    with Image.open(client.src / top["rel"]) as original, Image.open(touched) as copy:
        assert copy.size == (original.height, original.width)  # turned a quarter
    assert (client.src / top["rel"]).read_bytes() == first.read_bytes()  # the original itself is untouched


def test_the_note_keeps_its_spot_without_an_undo_step(client):
    play_duels(client, 5)
    top = client.get("/api/shortlist").get_json()["items"][0]
    r = post(client, "/api/edit", {"photo": top["photo"], "note": [-20, 30.25]}).get_json()
    assert r["edits"] == {"note": [-20.0, 30.2]} and r["undo"] is None  # where your note is, not a change to the shot
    assert top_edits(client) == {"note": [-20.0, 30.2]}
    r = post(client, "/api/edit", {"photo": top["photo"], "rotate": 90}).get_json()
    assert r["edits"] == {"note": [-20.0, 30.2], "rotate": 90} and r["undo"] == "edit"
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit" and top_edits(client) == {"note": [-20.0, 30.2]}
    assert post(client, "/api/edit", {"photo": top["photo"], "note": None}).get_json()["edits"] == {}
    assert post(client, "/api/edit", {"photo": top["photo"], "note": "left"}).status_code == 400
    assert post(client, "/api/edit", {"photo": top["photo"], "note": [1, True]}).status_code == 400


def test_crop_modes_and_look_knobs_are_kept_normalised(client):
    play_duels(client, 5)
    top = client.get("/api/shortlist").get_json()["items"][0]
    for word, kept in (("auto", "subject"), ("best", "best"), ("height", "height"), ("width", "width")):
        assert post(client, "/api/edit", {"photo": top["photo"], "crop": word}).get_json()["edits"]["crop"] == kept
    assert post(client, "/api/edit", {"photo": top["photo"], "crop": "off"}).get_json()["edits"] == {}
    assert post(client, "/api/edit", {"photo": top["photo"], "crop": "square"}).status_code == 400
    r = post(client, "/api/edit", {"photo": top["photo"], "look": {"levels": 1.5, "light": 0, "warmth": -3}}).get_json()
    assert r["edits"] == {"look": {"levels": 1.5, "warmth": -1.0}} and r["undo"] == "edit"
    assert post(client, "/api/edit", {"photo": top["photo"], "look": {"levels": 1, "warmth": -1}}).get_json()["edits"] == {"look": {"warmth": -1.0}}  # a look is the whole knob set
    assert post(client, "/api/edit", {"photo": top["photo"], "look": None}).get_json()["edits"] == {}
    assert post(client, "/api/edit", {"photo": top["photo"], "look": {"sparkle": 1}}).status_code == 400
    assert post(client, "/api/edit", {"photo": top["photo"], "look": {"levels": True}}).status_code == 400
    assert post(client, "/api/edit", {"photo": top["photo"], "look": "warm"}).status_code == 400


def test_marks_and_your_notes_are_kept_and_undone_but_moving_a_note_is_not_a_step(client):
    play_duels(client, 5)
    top = client.get("/api/shortlist").get_json()["items"][0]
    strokes = [{"t": "pen", "c": "ink", "p": [[10, 10], [20.26, 30]]}, {"t": "marker", "c": "coral", "p": [[5, 5]]}]
    r = post(client, "/api/edit", {"photo": top["photo"], "marks": strokes}).get_json()
    assert r["edits"]["marks"] == [{"t": "pen", "c": "ink", "p": [[10.0, 10.0], [20.3, 30.0]]}, {"t": "marker", "c": "coral", "p": [[5.0, 5.0]]}]
    assert r["undo"] == "edit"
    assert post(client, "/api/edit", {"photo": top["photo"], "marks": [{"t": "crayon", "c": "ink", "p": [[1, 1]]}]}).status_code == 400
    assert post(client, "/api/edit", {"photo": top["photo"], "marks": [{"t": "pen", "c": "pink", "p": [[1, 1]]}]}).status_code == 400
    assert post(client, "/api/edit", {"photo": top["photo"], "marks": [{"t": "pen", "c": "ink", "p": [[1, "a"]]}]}).status_code == 400
    r = post(client, "/api/edit", {"photo": top["photo"], "notes": [{"x": 10, "y": 20, "text": "nice light"}]}).get_json()
    assert r["edits"]["notes"] == [{"x": 10.0, "y": 20.0, "text": "nice light"}]
    r = post(client, "/api/edit", {"photo": top["photo"], "notes": [{"x": 50, "y": 60, "text": "nice light"}]}).get_json()
    assert r["edits"]["notes"][0]["x"] == 50.0
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit"  # the move was no step: this undoes the note itself
    assert "notes" not in top_edits(client) and len(top_edits(client)["marks"]) == 2
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit" and "marks" not in top_edits(client)
    assert post(client, "/api/edit", {"photo": top["photo"], "notes": [{"x": 1, "y": 1, "text": "x" * 401}]}).status_code == 400
    assert post(client, "/api/edit", {"photo": top["photo"], "notes": "hi"}).status_code == 400


def test_edits_can_be_read_back_for_any_pane(client):
    play_duels(client, 3)
    top = client.get("/api/shortlist").get_json()["items"][0]
    assert client.get(f"/api/edit?photo={top['photo']}").get_json() == {"photo": top["photo"], "edits": {}}
    post(client, "/api/edit", {"photo": top["photo"], "marks": [{"t": "pen", "c": "ink", "p": [[1, 1], [2, 2]]}]})
    assert len(client.get(f"/api/edit?photo={top['photo']}").get_json()["edits"]["marks"]) == 1
    assert client.get("/api/edit?photo=999999").status_code == 404


def test_drawing_undo_redo_preserves_the_pending_duel(client):
    card = post(client, "/api/deal?n=1&stage=open").get_json()["cards"][0]
    marks = [{"t": "pen", "c": "ink", "p": [[10, 20], [80, 20]]}]
    before = client.get("/api/state").get_json()["library"]["votes"]
    post(client, "/api/edit", {"photo": card["a"], "marks": marks})
    assert client.get("/api/history?stage=home").get_json()["undo"]["label"] == "edit"
    assert post(client, "/api/draw/undo").get_json()["undone"] == "edit"
    assert post(client, "/api/draw/redo").get_json()["redone"] == "edit"
    assert client.get("/api/state").get_json()["library"]["votes"] == before
    reply = post(client, "/api/vote", {"card": card["id"], "outcome": "a", "stage": "open", "ms": 900})
    assert reply.status_code == 200
    assert client.get("/api/state").get_json()["library"]["votes"] > before


def test_the_pyramid_serves_halvings_made_on_first_request(client):
    from io import BytesIO

    from PIL import Image

    pid = client.get("/api/shortlist").get_json()["items"][0]["photo"] if client.get("/api/shortlist").get_json()["items"] else None
    pid = pid or client.get("/api/world").get_json()["photos"][0]["id"]
    for level, origin in ((100, "thumbs"), (800, "previews")):
        r = client.get(f"/img/t/{pid}.jpg?v=1&m={level}" if level < 400 else f"/img/p/{pid}.jpg?v=1&m={level}")
        assert r.status_code == 200
        with Image.open(BytesIO(r.data)) as im:
            assert max(im.size) <= level
            with Image.open(client.matcher.session.workdir / origin / f"{pid}.jpg") as src:
                assert max(im.size) == min(level, max(src.size))  # a halving, never an enlargement
        assert (client.matcher.session.workdir / "mips" / str(level) / f"{pid}.jpg").is_file()
    assert client.get(f"/img/t/{pid}.jpg?v=1&m=333").status_code == 200  # an unknown level is just the thumbnail
