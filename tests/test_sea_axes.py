"""Sea display preferences and measured axes use synthetic libraries, without touching photo content."""
import pytest

from matcher import imageio, sea_axes
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


def test_axis_picker_and_server_accept_the_same_measurements():
    import json
    import subprocess
    from pathlib import Path
    result = subprocess.run(["node", "-e", "console.log(JSON.stringify(require('./matcher/static/sea-axes.js').options.map(o=>o.key)))"],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, check=True)
    assert set(json.loads(result.stdout)) == sea_axes.KEYS
    assert len(sea_axes.KEYS) > 35


@pytest.mark.parametrize("wrapped", [False, True])
def test_extended_axes_use_local_dates_saved_faces_and_distinct_rankings(client, monkeypatch, wrapped):
    import json
    s = client.matcher.session
    s.ensure_ranker()
    pid = s.store.one("SELECT id FROM photos WHERE n_faces>0 ORDER BY id LIMIT 1")["id"]
    with s.store.tx() as c:
        c.execute("UPDATE photos SET taken='2021-02-07T23:30:00',taken_ts=1612740600,prior=.7,zs=?,"
                  "luma_lo=20,luma_hi=220,saturation=.8,hue=.65,make='Nikon',model='Z 6',size=123456,"
                  "subject='[0.1,0.2,0.3,0.4]',edits=? WHERE id=?",
                  (json.dumps({"scores": {"aesthetic": .91}, "version": 1} if wrapped else {"aesthetic": .91}), json.dumps({"title": "My picture", "grade": {"shadows": {"hue": 200, "amount": .1}}}), pid))
        c.execute("UPDATE faces SET w=.2,h=.3,smile=.8,blink_l=.1,blink_r=.2,yaw=-25,roll=-4 WHERE photo_id=?", (pid,))
    before = s.store.conn().total_changes
    monkeypatch.setattr(imageio, "decode", lambda *_a, **_k: pytest.fail("Arranging the sea cannot decode photos"))
    p = next(p for p in client.get('/api/world?per=1000').get_json()['photos'] if p['id'] == pid)
    m = p['measurements']
    assert m['quality'] == .7 and m['aesthetic'] == .91
    assert m['ranking'] == float(s.ranker.post.mu[s.gidx[s.photo_group[pid]]])
    assert m['time'] == 23.5 and m['weekday'] == 6 and m['month'] == 2 and m['year'] == 2021
    assert m['camera'] == 'Nikon Z 6' and m['file_size'] == 123456
    assert m['face_size'] == pytest.approx(.06) and m['eyes_open'] == .8 and m['face_angle'] == 25 and m['head_tilt'] == 4
    assert m['subject_size'] == pytest.approx(.12) and m['subject_x'] == .25 and m['subject_y'] == .4
    assert m['edited'] == 1 and m['contrast'] == pytest.approx(200 / 255) and m['warmth'] < 0
    assert s.store.conn().total_changes == before
    for x, y in [('quality', 'aesthetic'), ('folder', 'camera'), ('time', 'smile'), ('shortlist', 'uncertainty'), ('stack_size', 'decision')]:
        response = post(client, '/api/settings', {'sea_axes': {'x': x, 'y': y}})
        assert response.status_code == 200
