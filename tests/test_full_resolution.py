"""Full-size image requests must contain original-resolution pixels, including browser-unsupported formats."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO

import numpy as np
from PIL import Image
import pytest

from matcher import imageio
from matcher.server import Session, create_app
from tests.test_raw import _fake_raw


@pytest.fixture
def images(tmp_path):
    source = tmp_path / "Synthetic photos Café"
    source.mkdir()
    session = Session(source, tmp_path / "save")
    app = create_app(tmp_path / "app", allowed_hosts={"localhost"})
    app.config["MATCHER"].session = session
    for folder in ("previews", "thumbs"):
        (session.workdir / folder).mkdir()
        Image.new("RGB", (1600, 1000) if folder == "previews" else (400, 250), "red").save(session.workdir / folder / "1.jpg")
    with session.store.tx() as c:
        c.execute("INSERT INTO photos(id,rel,status,width,height) VALUES(1, '旅行.tiff', 'analyzed', 2200, 1400)")
    Image.new("RGB", (2200, 1400), (20, 120, 220)).save(source / "旅行.tiff")
    yield app.test_client(), session, source
    session.shutdown()


def pixels(response):
    assert response.status_code == 200
    with Image.open(BytesIO(response.data)) as im:
        return im.size, im.convert("RGB").getpixel((0, 0))


def test_tiff_full_size_is_not_the_preview_and_is_cached(images, monkeypatch):
    client, session, source = images
    decode, calls = imageio.decode, []
    def counted(path, *args, **kwargs):
        calls.append((path, args, kwargs))
        return decode(path, *args, **kwargs)
    monkeypatch.setattr(imageio, "decode", counted)
    before = (source / "旅行.tiff").read_bytes(), session.store.conn().total_changes
    assert pixels(client.get("/img/p/1.jpg"))[0] == (1600, 1000)
    assert pixels(client.get("/img/p/1.jpg?m=800"))[0] == (800, 500)
    full = client.get("/img/p/1.jpg?m=full")
    assert pixels(full)[0] == (2200, 1400)
    assert full.mimetype == "image/png"
    assert pixels(client.get("/img/p/1.jpg?m=full"))[0] == (2200, 1400)
    assert len(calls) == 1 and calls[0][1] == () and calls[0][2].get("max_edge") is None
    assert before == ((source / "旅行.tiff").read_bytes(), session.store.conn().total_changes)


def test_browser_supported_original_is_sent_unchanged(images):
    client, session, source = images
    original = source / "original.png"
    Image.new("RGB", (2400, 1800), "blue").save(original)
    with session.store.tx() as c:
        c.execute("UPDATE photos SET rel=? WHERE id=1", (original.name,))
    response = client.get("/img/p/1.jpg?m=full")
    assert response.mimetype == "image/png" and response.data == original.read_bytes()
    assert pixels(response)[0] == (2400, 1800)


def test_raw_original_decodes_at_full_size(images, monkeypatch):
    client, session, source = images
    raws = _fake_raw(monkeypatch, 2200, 1400)
    original = source / "旅行.NEF"
    original.write_bytes(b"synthetic RAW bytes")
    with session.store.tx() as c:
        c.execute("UPDATE photos SET rel=? WHERE id=1", (original.name,))
    assert pixels(client.get("/img/p/1.jpg?m=full"))[0] == (2200, 1400)
    assert len(raws) == 1 and not raws[0].calls[0]["half_size"]


def test_full_size_conversion_preserves_every_decoded_pixel(images, monkeypatch):
    client, session, source = images
    raw = source / "fine detail.NEF"
    raw.write_bytes(b"synthetic RAW bytes")
    with session.store.tx() as c:
        c.execute("UPDATE photos SET rel=? WHERE id=1", (raw.name,))
    pixels = np.random.default_rng(17).integers(0, 256, (384, 512, 3), dtype=np.uint8)
    decode = imageio.decode

    def detailed(path, *args, **kwargs):
        result = decode(source / "旅行.tiff")
        result.image.close()
        result.image = Image.fromarray(pixels)
        result.width, result.height = 512, 384
        return result

    monkeypatch.setattr(imageio, "decode", detailed)
    # Ignore an older lossy full-size cache left by a previous version of MatchER.
    stamp = raw.stat()
    key = hashlib.sha256(f"{raw}:{stamp.st_mtime_ns}:{stamp.st_size}".encode()).hexdigest()[:16]
    (session.workdir / "full").mkdir()
    Image.new("RGB", (512, 384), "red").save(session.workdir / "full" / f"1-{key}.jpg")
    response = client.get("/img/p/1.jpg?m=full")
    assert response.mimetype == "image/png"
    with Image.open(BytesIO(response.data)) as im:
        assert np.array_equal(np.asarray(im), pixels)


def test_full_size_cache_tracks_original_changes(images):
    client, _, source = images
    assert pixels(client.get("/img/p/1.jpg?m=full"))[0] == (2200, 1400)
    Image.new("RGB", (2300, 1500), "green").save(source / "旅行.tiff")
    assert pixels(client.get("/img/p/1.jpg?m=full"))[0] == (2300, 1500)


def test_concurrent_full_size_requests_decode_once(images, monkeypatch):
    client, _, _ = images
    decode, calls = imageio.decode, []
    def counted(*args, **kwargs):
        calls.append(1)
        return decode(*args, **kwargs)
    monkeypatch.setattr(imageio, "decode", counted)
    def request(_):
        with client.application.test_client() as c:
            return pixels(c.get("/img/p/1.jpg?m=full"))[0]
    with ThreadPoolExecutor(3) as pool:
        assert list(pool.map(request, range(3))) == [(2200, 1400)] * 3
    assert len(calls) == 1


def test_missing_or_unreadable_original_does_not_masquerade_as_full_size(images, monkeypatch):
    client, _, source = images
    def fail(*args, **kwargs):
        raise ValueError("synthetic decode failure")
    with monkeypatch.context() as m:
        m.setattr(imageio, "decode", fail)
        assert client.get("/img/p/1.jpg?m=full").status_code == 422
    assert pixels(client.get("/img/p/1.jpg?m=full"))[0] == (2200, 1400)
    (source / "旅行.tiff").unlink()
    assert client.get("/img/p/1.jpg?m=full").status_code == 404
    assert client.get("/img/p/1.jpg").status_code == 200
