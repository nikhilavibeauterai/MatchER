"""The documentation collection stays distinct, credited and safe to download again."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from PIL import Image

FIXTURES = Path(__file__).parent / "ui" / "fixtures"
spec = importlib.util.spec_from_file_location("fetch_showcase", FIXTURES / "fetch_showcase.py")
showcase = importlib.util.module_from_spec(spec)
spec.loader.exec_module(showcase)


def test_documentation_has_a_full_collection_of_distinct_photographs():
    manifest = json.loads((FIXTURES / "showcase.json").read_text())
    photos = manifest["photos"]
    assert len(photos) == 320
    for field in ("file", "source", "image", "sha256"):
        assert len({p[field] for p in photos}) == len(photos), field
    assert manifest["license"] == "Public domain"
    assert manifest["photographer"] == "Carol M. Highsmith"
    assert all(urlsplit(p["source"]).hostname == "www.loc.gov" for p in photos)
    assert all(urlsplit(p["image"]).hostname == "tile.loc.gov" for p in photos)
    assert all(not Path(p["file"]).is_absolute() and ".." not in Path(p["file"]).parts for p in photos)
    assert all(len(bytes.fromhex(p["sha256"])) == 32 for p in photos)
    assert all(p["date_precision"] == "year" and p["date"][5:] == "01-01" and p["date"][:4] in p["catalogue_date"] for p in photos)
    scenes = json.loads((FIXTURES / "showcase-scenes.json").read_text())
    files = {p["file"] for p in photos}
    assert scenes["featured"] in files
    assert all(2 <= len(stack) <= 8 and set(stack) <= files for stack in scenes["stacks"])


def proof():
    buf = io.BytesIO()
    Image.new("RGB", (16, 12), (40, 90, 130)).save(buf, "JPEG")
    return buf.getvalue()


def test_repeat_download_is_offline_and_keeps_the_recorded_date_and_credit(tmp_path):
    data = proof()
    photo = {"file": "coast/7.jpg", "title": "The coast", "date": "2021-07-10",
             "image": "https://tile.loc.gov/example.jpg", "source": "https://www.loc.gov/item/7/",
             "sha256": hashlib.sha256(data).hexdigest()}
    calls = []
    class Fetcher:
        def get(self, url):
            calls.append(url)
            return data
    manifest = {"rights": showcase.RIGHTS, "photos": [photo]}
    showcase.download(tmp_path, manifest, Fetcher())
    before = (tmp_path / photo["file"]).stat().st_mtime
    showcase.download(tmp_path, manifest, Fetcher())
    assert calls == [photo["image"]]
    assert (tmp_path / photo["file"]).stat().st_mtime == before
    assert (tmp_path / photo["file"]).read_bytes() == data
    credits = (tmp_path / "ATTRIBUTION.txt").read_text()
    assert photo["source"] in credits and "Carol M. Highsmith" in credits


def test_checksum_failure_does_not_replace_an_existing_file(tmp_path):
    file = tmp_path / "existing.jpg"
    file.write_bytes(proof())
    class Fetcher:
        def get(self, url):
            raise AssertionError("An existing file must be checked before requesting anything")
    with pytest.raises(ValueError, match="checksum mismatch"):
        showcase.download(tmp_path, {"photos": [{"file": file.name, "sha256": "0" * 64}]}, Fetcher())
    assert file.read_bytes() == proof()
    assert not (tmp_path / "ATTRIBUTION.txt").exists()
