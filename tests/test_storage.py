"""Drive connectivity uses directory metadata, without opening a library or scanning photos."""
import json

from matcher import server


def test_disconnected_saves_survive_startup_and_follow_reconnection(tmp_path, monkeypatch):
    data = tmp_path / "saves"
    data.mkdir()
    card = tmp_path / "0123-4567"
    recent = [{"path": str(card), "opened": 123}]
    saved = {"current": str(card), "recent": recent}
    (data / "state.json").write_text(json.dumps(saved))
    app = server.create_app(data)
    c = app.test_client()
    matcher = app.config["MATCHER"]
    assert c.get("/api/state").get_json()["recent"] == recent
    assert c.get("/api/saves").get_json()["saves"][0]["exists"] is False
    monkeypatch.setattr(server, "save_card", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("save database read")))
    monkeypatch.setattr(matcher, "open", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("library opened")))
    monkeypatch.setattr(server, "suggestions", lambda: (_ for _ in ()).throw(AssertionError("drive discovery not requested")))
    def available():
        response = c.get("/api/storage")
        assert response.headers["Cache-Control"] == "no-store"
        return response.get_json()["saves"]
    assert available() == [{"path": str(card), "exists": False}]
    card.mkdir()
    assert available() == [{"path": str(card), "exists": True}]
    card.rename(tmp_path / "unmounted")
    assert available() == [{"path": str(card), "exists": False}]
    (tmp_path / "unmounted").rename(card)
    assert available() == [{"path": str(card), "exists": True}]
    assert matcher.session is None
    assert json.loads((data / "state.json").read_text()) == saved


def test_browser_shortcuts_and_current_folder_follow_media(tmp_path, monkeypatch):
    monkeypatch.setattr(server.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(server.sys, "platform", "linux")
    monkeypatch.setattr(server.Path, "glob", lambda *a: [])  # No real phone mounts in this test.
    roots = []
    monkeypatch.setattr(server, "mounted_folders", lambda: list(roots))
    c = server.create_app(tmp_path / "saves").test_client()
    card = tmp_path / "Photo card"
    url = "/api/storage?browse=1&path=" + str(card)
    assert c.get(url).get_json()["suggestions"] == [{"label": "Home", "path": str(tmp_path)}]
    card.mkdir()
    roots.extend([str(card), str(card)])
    response = c.get(url).get_json()
    assert response["suggestions"][-1] == {"label": "Photo card", "path": str(card)}
    assert len(response["suggestions"]) == 2
    assert response["folder"] == {"path": str(card), "exists": True}
    browse = c.get("/api/browse", query_string={"path": str(card)}).get_json()
    assert browse["suggestions"] == response["suggestions"]
    assert browse["crumbs"][-1] == {"label": "Photo card", "path": str(card)}
    roots.clear()
    card.rmdir()
    assert c.get(url).get_json()["folder"]["exists"] is False
    monkeypatch.setattr(server.sys, "platform", "win32")
    roots.extend(["C:\\", "E:\\"])
    assert c.get(url).get_json()["suggestions"][-2:] == [
        {"label": "C:", "path": "C:\\"}, {"label": "E:", "path": "E:\\"}]
