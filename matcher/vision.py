"""Thin wrappers around the four models. Everything runs locally on the CPU."""
from __future__ import annotations

import math
import re
import string

import cv2
import numpy as np
from PIL import Image

from .models import MODELS, SIGLIP_LOGIT_BIAS, SIGLIP_LOGIT_SCALE


def _nms(faces: np.ndarray, iou: float = 0.35) -> np.ndarray:
    if len(faces) < 2:
        return faces
    faces = faces[np.argsort(-faces[:, 14])]
    keep = []
    for f in faces:
        x1, y1, w1, h1 = f[:4]
        ok = True
        for k in keep:
            x2, y2, w2, h2 = k[:4]
            ix = max(0.0, min(x1 + w1, x2 + w2) - max(x1, x2))
            iy = max(0.0, min(y1 + h1, y2 + h2) - max(y1, y2))
            inter = ix * iy
            if inter / (w1 * h1 + w2 * h2 - inter + 1e-9) > iou:
                ok = False
                break
        if ok:
            keep.append(f)
    return np.array(keep, dtype=np.float32)


class FaceDetector:
    """YuNet at two scales: the full preview finds small faces, a 640 px copy finds selfie-sized ones."""

    def __init__(self, score: float = 0.6):
        self.score = score
        self.det = cv2.FaceDetectorYN.create(str(MODELS["yunet"].path), "", (320, 320), score, 0.3, 5000)

    def _run(self, bgr: np.ndarray) -> np.ndarray:
        h, w = bgr.shape[:2]
        self.det.setInputSize((w, h))
        _, faces = self.det.detect(bgr)
        return np.zeros((0, 15), np.float32) if faces is None else faces.astype(np.float32)

    def _scaled(self, bgr: np.ndarray, long_target: int) -> np.ndarray:
        h, w = bgr.shape[:2]
        s = long_target / max(h, w)
        if s >= 1:
            return self._run(bgr)
        small = cv2.resize(bgr, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
        f = self._run(small)
        f[:, :14] /= s
        return f

    def detect(self, bgr: np.ndarray) -> np.ndarray:
        """Rows of [x, y, w, h, 5 landmark x/y pairs, score] in bgr's pixel coordinates.

        A 640 px pass finds selfie-sized faces. Only when no large face turns up (full-body shots,
        groups) does a 1280 px pass look for small ones; a selfie gains nothing from it.
        """
        w = bgr.shape[1]
        found = [self._scaled(bgr, 640)]
        if not len(found[0]) or found[0][:, 2].max() < 0.12 * w:
            found.append(self._scaled(bgr, 1280))
        faces = np.concatenate(found)
        faces = faces[faces[:, 14] >= self.score]
        return _nms(faces)


class FaceEmbedder:
    """SFace identity embedding (128-d, unit length); cosine above ~0.36 means same person."""

    def __init__(self):
        self.rec = cv2.FaceRecognizerSF.create(str(MODELS["sface"].path), "")

    def embed(self, bgr: np.ndarray, face_row: np.ndarray) -> np.ndarray:
        aligned = self.rec.alignCrop(bgr, face_row.reshape(1, -1))
        f = self.rec.feature(aligned).astype(np.float32).ravel()
        return f / (np.linalg.norm(f) + 1e-9)


def _euler(m: np.ndarray) -> tuple[float, float, float]:
    r = np.asarray(m, dtype=np.float64)[:3, :3]
    sy = math.hypot(r[0, 0], r[1, 0])
    pitch = math.degrees(math.atan2(r[2, 1], r[2, 2]))
    yaw = math.degrees(math.atan2(-r[2, 0], sy))
    roll = math.degrees(math.atan2(r[1, 0], r[0, 0]))
    return yaw, pitch, roll


class FaceMesh:
    """MediaPipe face landmarker: blink, smile and head pose for one face crop."""

    def __init__(self):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self._mp = mp
        opts = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(MODELS["landmarker"].path)),
            running_mode=vision.RunningMode.IMAGE, num_faces=1,
            min_face_detection_confidence=0.3, min_face_presence_confidence=0.3,
            output_face_blendshapes=True, output_facial_transformation_matrixes=True)
        self.lm = vision.FaceLandmarker.create_from_options(opts)

    @staticmethod
    def crop(rgb: np.ndarray, face_row: np.ndarray, size: int = 320, margin: float = 1.9) -> np.ndarray:
        """Square crop centred on the face, padded with black at image edges."""
        x, y, w, h = face_row[:4]
        cx, cy, half = x + w / 2, y + h / 2, max(w, h) * margin / 2
        x0, y0, x1, y1 = int(round(cx - half)), int(round(cy - half)), int(round(cx + half)), int(round(cy + half))
        H, W = rgb.shape[:2]
        canvas = np.zeros((y1 - y0, x1 - x0, 3), np.uint8)
        sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if sx1 > sx0 and sy1 > sy0:
            canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = rgb[sy0:sy1, sx0:sx1]
        return cv2.resize(canvas, (size, size), interpolation=cv2.INTER_AREA if canvas.shape[0] > size else cv2.INTER_CUBIC)

    def analyze(self, rgb_crop: np.ndarray) -> dict | None:
        img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb_crop))
        r = self.lm.detect(img)
        if not r.face_blendshapes:
            return None
        bs = {c.category_name: float(c.score) for c in r.face_blendshapes[0]}
        yaw, pitch, roll = _euler(r.facial_transformation_matrixes[0]) if r.facial_transformation_matrixes else (0.0, 0.0, 0.0)
        return {
            "blink_l": bs.get("eyeBlinkLeft", 0.0), "blink_r": bs.get("eyeBlinkRight", 0.0),
            "smile": (bs.get("mouthSmileLeft", 0.0) + bs.get("mouthSmileRight", 0.0)) / 2,
            "jaw": bs.get("jawOpen", 0.0),
            "squint": (bs.get("eyeSquintLeft", 0.0) + bs.get("eyeSquintRight", 0.0)) / 2,
            "yaw": yaw, "pitch": pitch, "roll": roll,
        }


class SigLIP:
    """SigLIP base/16 image and text towers (ONNX). Embeddings are unit length, 768-d."""

    SIZE = 224

    def __init__(self, threads: int = 6, text: bool = True):
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        prov = ["CPUExecutionProvider"]
        self.vision = ort.InferenceSession(str(MODELS["siglip_vision"].path), so, providers=prov)
        self.text = ort.InferenceSession(str(MODELS["siglip_text"].path), so, providers=prov) if text else None
        self._tok = None

    @classmethod
    def preprocess(cls, im: Image.Image) -> np.ndarray:
        """SiglipImageProcessor: bicubic resize to 224x224, scale to [-1, 1], CHW."""
        a = np.asarray(im.convert("RGB").resize((cls.SIZE, cls.SIZE), Image.Resampling.BICUBIC), dtype=np.float32)
        return (a / 127.5 - 1.0).transpose(2, 0, 1)

    def embed_images(self, batch: np.ndarray) -> np.ndarray:
        out = self.vision.run(["pooler_output"], {"pixel_values": batch.astype(np.float32)})[0]
        return out / (np.linalg.norm(out, axis=1, keepdims=True) + 1e-9)

    def _tokenizer(self):
        if self._tok is None:
            from tokenizers import Tokenizer

            self._tok = Tokenizer.from_file(str(MODELS["siglip_tokenizer"].path))
        return self._tok

    @staticmethod
    def canonical(text: str) -> str:
        """SiglipTokenizer's text cleanup: lowercase, strip punctuation, collapse spaces."""
        text = text.lower().translate(str.maketrans("", "", string.punctuation))
        return re.sub(r"\s+", " ", text).strip()

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        tok = self._tokenizer()
        ids = np.ones((len(texts), 64), dtype=np.int64)  # </s> (id 1) is also the pad token
        for i, t in enumerate(texts):
            enc = tok.encode(self.canonical(t)).ids[:64]
            if enc and enc[-1] != 1:
                enc = enc[:63] + [1]
            ids[i, :len(enc)] = enc
        out = self.text.run(["pooler_output"], {"input_ids": ids})[0]
        return out / (np.linalg.norm(out, axis=1, keepdims=True) + 1e-9)

    @staticmethod
    def logits(img: np.ndarray, txt: np.ndarray) -> np.ndarray:
        return SIGLIP_LOGIT_SCALE * (img @ txt.T) + SIGLIP_LOGIT_BIAS
