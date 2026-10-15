"""An offline check of the bundled native libraries, resources and spawn workers."""
from __future__ import annotations

import hashlib
import importlib
import json
import multiprocessing
from pathlib import Path


def _worker(queue):
    import numpy as np
    queue.put(float(np.dot([1., 2.], [3., 4.])))


def check_runtime() -> dict:
    from . import __version__
    from .sample import BUNDLE
    from .server import STATIC, create_app
    import tempfile

    modules = ["numpy", "PIL.Image", "pillow_heif", "rawpy", "exifread", "cv2", "mediapipe",
               "onnxruntime", "tokenizers", "flask", "waitress"]
    for name in modules:
        importlib.import_module(name)
    photos = json.loads((BUNDLE / "manifest.json").read_text(encoding="utf-8"))
    for photo in photos:
        assert hashlib.sha256((BUNDLE / photo["file"]).read_bytes()).hexdigest() == photo["sha256"], photo["file"]
    assert (STATIC / "index.html").is_file() and (STATIC / "fonts" / "caveat.woff2").is_file()
    with tempfile.TemporaryDirectory(prefix="matcher-self-test-") as tmp:
        client = create_app(Path(tmp)).test_client()
        assert client.get("/").status_code == 200
        assert client.get("/static/sea-gl.js").status_code == 200
        assert client.get("/api/state").get_json()["library"] is None
    ctx = multiprocessing.get_context("spawn")
    queue = ctx.Queue()
    child = ctx.Process(target=_worker, args=(queue,))
    child.start()
    try:
        assert queue.get(timeout=30) == 11.
        child.join(timeout=30)
        assert child.exitcode == 0, "spawn worker did not exit cleanly"
    finally:
        if child.is_alive():
            child.terminate()
            child.join()
        queue.close()
    return {"ok": True, "version": __version__, "modules": modules, "sample_photos": len(photos), "spawn": True}
