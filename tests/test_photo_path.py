"""Original-path lookup uses saved synthetic metadata, never opens or needs an original image."""
from pathlib import Path

import pytest

from matcher.server import Session, create_app


@pytest.fixture
def paths(tmp_path, monkeypatch):
    source = tmp_path / "Original photos Café" / "旅行 🎞"
    session = Session(source, tmp_path / "save")
    app = create_app(tmp_path / "app", secret="synthetic-key", allowed_hosts={"localhost"})
    app.config["MATCHER"].session = session
    with session.store.tx() as c:
        c.executemany("INSERT INTO photos(id,rel,status,override,group_id) VALUES(?,?,?,?,?)", [
            (1, "Day one/cover.jpg", "analyzed", None, 91),
            (2, "Day one/猫's photo 100%.jpg", "analyzed", "toss", 91),
            (3, "still reading.heic", "new", None, None),
            (4, "gone away.jpg", "missing", None, None),
            (5, "could not read.jpg", "error", None, None)])
    session.groups = {91: {"rep": 1, "members": [1, 2]}}
    session.photo_group = {1: 91, 2: 91}
    monkeypatch.setattr(session, "ensure_ranker", lambda *a, **kw: pytest.fail("Path lookup must not run the ranker"))
    client = app.test_client()
    yield client, session, source
    session.shutdown()


def test_original_path_requires_install_authentication(paths):
    client, _, _ = paths
    assert client.get("/api/photo/2").status_code == 403
    assert client.get("/?k=synthetic-key").status_code == 303
    assert client.get("/api/photo/2").status_code == 200


def test_original_path_is_exact_take_unicode_and_read_only(paths, monkeypatch):
    client, session, source = paths
    client.get("/?k=synthetic-key")
    before = session.store.conn().total_changes
    # Resolving symlinks or checking file metadata would touch a photo path unnecessarily.
    monkeypatch.setattr(Path, "resolve", lambda *a, **kw: pytest.fail("Original path must remain lexical"))
    for pid in range(1, 6):
        reply = client.get(f"/api/photo/{pid}")
        assert reply.status_code == 200, reply.get_json()
        row = session.store.one("SELECT rel FROM photos WHERE id=?", (pid,))
        assert reply.get_json() == {"photo": pid, "rel": row["rel"], "original_path": str(source / row["rel"])}
    assert session.store.conn().total_changes == before
    assert client.get("/api/photo/2").get_json()["original_path"].endswith(str(Path("Day one") / "猫's photo 100%.jpg"))


@pytest.mark.parametrize("value", ["0", "99999", "-1", "not-a-number", "1.5"])
def test_original_path_rejects_unknown_or_invalid_ids(paths, value):
    client, _, _ = paths
    client.get("/?k=synthetic-key")
    assert client.get(f"/api/photo/{value}").status_code == 404


@pytest.mark.parametrize("rel", ["../outside.jpg", "/outside.jpg", "folder/../../outside.jpg", "", ".", "bad\0name.jpg",
                                 "C:/outside.jpg", "C:outside.jpg", "\\outside.jpg", "folder\\..\\outside.jpg"])
def test_original_path_rejects_absolute_or_traversing_stored_paths(paths, rel):
    client, session, _ = paths
    client.get("/?k=synthetic-key")
    with session.store.tx() as c:
        c.execute("UPDATE photos SET rel=? WHERE id=2", (rel,))
    assert client.get("/api/photo/2").status_code == 400
