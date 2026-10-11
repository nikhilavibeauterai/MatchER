"""Model files: where each comes from, what it must hash to, and fetching it once."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .config import MODELS_DIR

SIGLIP_REV = "4649052661e53c7000355844105f8a1792088239"
_HF = f"https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/{SIGLIP_REV}/"
_ZOO = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/"

# exp(logit_scale) and logit_bias of google/siglip-base-patch16-224 (read from its safetensors).
SIGLIP_LOGIT_SCALE = 117.330765
SIGLIP_LOGIT_BIAS = -12.932437


@dataclass(frozen=True)
class ModelFile:
    key: str
    filename: str
    url: str
    sha256: str
    size: int

    @property
    def path(self) -> Path:
        return MODELS_DIR / self.filename


MODELS = {m.key: m for m in (
    ModelFile("yunet", "face_detection_yunet_2023mar.onnx",
              _ZOO + "face_detection_yunet/face_detection_yunet_2023mar.onnx",
              "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", 232_589),
    ModelFile("sface", "face_recognition_sface_2021dec.onnx",
              _ZOO + "face_recognition_sface/face_recognition_sface_2021dec.onnx",
              "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79", 38_696_353),
    ModelFile("landmarker", "face_landmarker.task",
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
              "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff", 3_758_596),
    ModelFile("siglip_vision", "siglip_vision_model_quantized.onnx", _HF + "onnx/vision_model_quantized.onnx",
              "ef14a954f3d57e1806666432bd9785004c1dc27100aa260eee0cb0f10a5de058", 99_499_129),
    ModelFile("siglip_text", "siglip_text_model_quantized.onnx", _HF + "onnx/text_model_quantized.onnx",
              "ad0329b1f35acc66d8953ff2559ce358da8eb0a7011794cf951523d63a4dbce2", 111_475_220),
    ModelFile("siglip_tokenizer", "siglip_tokenizer.json", _HF + "tokenizer.json",
              "4a17c975210be5ab4c36b47d8dae4eefb866dbfb1e676e394aad85dc30a3ae08", 2_398_744),
)}

_STAMP = "verified.json"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _load_stamp() -> dict:
    try:
        return json.loads((MODELS_DIR / _STAMP).read_text())
    except (OSError, ValueError):
        return {}


def _verified(m: ModelFile, stamp: dict) -> bool:
    """Hash each file once; afterwards trust it while its size and mtime are unchanged."""
    try:
        st = m.path.stat()
    except OSError:
        return False
    if st.st_size != m.size:
        return False
    key = f"{st.st_size}:{st.st_mtime_ns}"
    if stamp.get(m.filename) == key:
        return True
    if _sha256(m.path) != m.sha256:
        return False
    stamp[m.filename] = key
    return True


def missing() -> list[ModelFile]:
    stamp = _load_stamp()
    out = [m for m in MODELS.values() if not _verified(m, stamp)]
    try:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        (MODELS_DIR / _STAMP).write_text(json.dumps(stamp, indent=1))
    except OSError:
        pass
    return out


def ensure(progress: Callable[[str, int, int], None] | None = None) -> None:
    """Download any missing model, verifying size and SHA-256 before it is used."""
    todo = missing()
    if not todo:
        return
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    total = sum(m.size for m in todo)
    done = 0
    for m in todo:
        fd, tmp = tempfile.mkstemp(prefix=f".{m.filename}.", dir=MODELS_DIR)
        os.close(fd)
        try:
            h = hashlib.sha256()
            req = urllib.request.Request(m.url, headers={"User-Agent": "MatchER/0.1"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
                got = 0
                while block := resp.read(1 << 20):
                    got += len(block)
                    if got > m.size:
                        raise RuntimeError(f"{m.filename}: download is larger than expected; refusing it")
                    out.write(block)
                    h.update(block)
                    done += len(block)
                    if progress:
                        progress(m.filename, done, total)
            if os.path.getsize(tmp) != m.size or h.hexdigest() != m.sha256:
                raise RuntimeError(f"{m.filename}: download failed verification (size or SHA-256 mismatch)")
            os.replace(tmp, m.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    if missing():
        raise RuntimeError("model files still missing after download")
