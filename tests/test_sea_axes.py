"""Sea display preferences and measured axes use synthetic libraries, without touching photo content."""
import pytest

from matcher import imageio
from tests.test_draw import client, post  # noqa: F401


def test_sea_axes_are_saved_without_rebuilding_the_library_or_undo_history(client, monkeypatch):
    s = client.matcher.session
    before = s.store.get_meta("state_version"), s.store.get_meta("settings", {}), s.draw.ver
    axes = {"x": "date", "y": "ranking", "reverseX": True, "reverseY": False}
    with monkeypatch.context() as patch:
        patch.setattr(s, "refresh_async", lambda *_a, **_k: pytest.fail("View preferences cannot rebuild analysis"))
        patch.setattr(s, "ensure_ranker", lambda *_a, **_k: pytest.fail("View preferences cannot rebuild rankings"))
        result = post(client, "/api/settings", {"sea_axes": axes, "help": False})
    assert result.status_code == 200
    assert result.get_json()["settings"]["sea_axes"] == axes
    assert s.store.get_meta("settings")["sea_axes"] == axes
    assert s.store.get_meta("settings")["help"] is False
    assert (s.store.get_meta("state_version"), s.draw.ver) == (before[0], before[2])


@pytest.mark.parametrize("axes", [None, [], "date", {}, {"x": [], "y": "brightness"},
                                  {"x": "unknown", "y": "brightness"},
                                  {"x": "date", "y": "brightness", "reverseX": "false"},
                                  {"x": "date", "y": "brightness", "extra": True}])
def test_invalid_axes_cannot_partly_change_saved_preferences(client, axes):
    before = client.matcher.session.store.get_meta("settings", {})
    assert post(client, "/api/settings", {"sea_axes": axes, "help": False}).status_code == 400
    assert client.matcher.session.store.get_meta("settings", {}) == before


def test_world_exposes_saved_axis_measurements_without_decoding_or_changing_photos(client, monkeypatch):
    s = client.matcher.session
    s.ensure_ranker()
    pid = s.store.one("SELECT id FROM photos ORDER BY id LIMIT 1")["id"]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET taken='2020-02-03T12:00:00',taken_ts=1580731200,prior=.7,sharp=250,width=300,height=600,n_faces=2 WHERE id=?", (pid,))
    before = [tuple(r) for r in s.store.q("SELECT id,group_id,theme_id,override FROM photos")]
    monkeypatch.setattr(imageio, "decode", lambda *_a, **_k: pytest.fail("Axes must use saved measurements"))
    result = client.get("/api/world?per=1").get_json()["photos"][0]
    assert result["taken"] == "2020-02-03T12:00:00"
    values = result["measurements"]
    assert values["date"] == 1580731200 and values["quality"] == .7
    assert values["sharpness"] == 250 and values["aspect"] == .5 and values["faces"] == 2
    assert values["ranking"] is None or isinstance(values["ranking"], float)
    assert [tuple(r) for r in s.store.q("SELECT id,group_id,theme_id,override FROM photos")] == before
