"""First-run downloads can stop and resume without accepting partial model files."""
import hashlib
import io
import threading

from matcher import models


def test_cancelled_download_discards_partial_file_and_retries(tmp_path, monkeypatch):
    content = b"public test bytes" * 150000
    model = models.ModelFile("test", "test.onnx", "https://example.invalid/model", hashlib.sha256(content).hexdigest(), len(content))
    monkeypatch.setattr(models, "MODELS_DIR", tmp_path)
    monkeypatch.setattr(models, "MODELS", {"test": model})
    calls = []
    def download(*args, **kwargs):
        calls.append(True)
        return io.BytesIO(content)
    monkeypatch.setattr(models.urllib.request, "urlopen", download)
    cancel = threading.Event()
    assert models.ensure(lambda *args: cancel.set(), cancelled=cancel.is_set) is False
    assert not model.path.exists() and not list(tmp_path.glob(".test.onnx.*"))
    cancel.clear()
    assert models.ensure(cancelled=cancel.is_set) is True
    assert model.path.read_bytes() == content and len(calls) == 2
    assert models.ensure() is True and len(calls) == 2  # the verified cache works offline


def test_stopped_scan_does_not_start_a_download(tmp_path, monkeypatch):
    monkeypatch.setattr(models, "MODELS_DIR", tmp_path / "unused")
    monkeypatch.setattr(models, "missing", lambda: (_ for _ in ()).throw(AssertionError("No cache work after stopping")))
    assert models.ensure(cancelled=lambda: True) is False
    assert not (tmp_path / "unused").exists()


def test_empty_folder_needs_no_models(tmp_path, monkeypatch):
    from matcher.analyze import Analyzer
    from matcher.store import Store
    source = tmp_path / "empty"
    source.mkdir()
    store = Store(tmp_path / "save" / "matcher.db")
    monkeypatch.setattr(models, "ensure", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("No model download for an empty folder")))
    try:
        analyzer = Analyzer(store, source, tmp_path / "save")
        analyzer._run()
        assert "No photos" in analyzer.progress["error"]
    finally:
        store.close()
