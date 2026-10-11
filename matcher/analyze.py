"""Turn a folder of photos into numbers: previews, faces, identity, and scene embeddings.

Phase 1 (process pool): decode, write previews, measure exposure/sharpness, detect faces,
    embed each face (identity), read blink/smile/head pose.
Phase 2 (one ONNX session): SigLIP embedding of every photo, then of an upper-body crop
    around *your* face once identity is known.
Every result lands in SQLite as it arrives, so an interrupted scan resumes where it stopped.
"""
from __future__ import annotations

import multiprocessing
import os
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import imageio
from .config import PHOTO_EXTS, PREVIEW_EDGE, THUMB_EDGE
from .store import Store, f16, unblob, f32

_W: dict = {}


def _init_worker() -> None:
    cv2.setNumThreads(1)
    from .vision import FaceDetector, FaceEmbedder, FaceMesh

    _W["det"], _W["emb"], _W["mesh"] = FaceDetector(), FaceEmbedder(), FaceMesh()


def phash(gray: np.ndarray) -> str:
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    d = cv2.dct(small)[:8, :8].ravel()[1:]  # drop the DC term: 63 bits
    bits = d > np.median(d)
    return f"{int(''.join('1' if b else '0' for b in bits), 2):016x}"


def lap_var(gray: np.ndarray, width: int) -> float:
    """Laplacian variance at a fixed width, so sharpness is comparable across sizes."""
    if gray.size == 0:
        return 0.0
    h, w = gray.shape[:2]
    if w > width:
        gray = cv2.resize(gray, (width, max(1, round(h * width / w))), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def analyze_one(task: tuple[int, str, str, str, str]) -> dict:
    pid, path, rel, preview, thumb = task
    out: dict = {"id": pid, "status": "error", "faces": []}
    try:
        st = os.stat(path)
        if st.st_size > MAX_FILE_BYTES:
            raise ValueError(f"{st.st_size // 2**20} MB is too large to open safely")
        with open(path, "rb") as f:
            data = f.read()
        out.update(size=st.st_size, mtime_ns=st.st_mtime_ns, sha256=imageio.sha256_bytes(data))
        d = imageio.decode(data, PREVIEW_EDGE, name=os.path.basename(rel))
        im = d.image
        imageio.save_jpeg(im, preview, 86)
        imageio.save_jpeg(im, thumb, 80, THUMB_EDGE)

        rgb = np.asarray(im)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        H, W = gray.shape
        small = cv2.resize(bgr, (max(1, W * 384 // max(H, W)), max(1, H * 384 // max(H, W))), interpolation=cv2.INTER_AREA)
        ycc = cv2.cvtColor(small, cv2.COLOR_BGR2YCrCb).astype(np.float32)
        lo, hi = np.percentile(ycc[..., 0], (5, 95))
        out.update(
            width=d.width, height=d.height, fmt=d.fmt, make=d.make, model=d.model,
            taken=d.taken.isoformat(timespec="seconds") if d.taken else None,
            taken_ts=d.taken.timestamp() if d.taken else None, taken_src=d.taken_src,
            phash=phash(gray), luma=float(ycc[..., 0].mean()), luma_lo=float(lo), luma_hi=float(hi),
            sharp=lap_var(gray, 800),
            chroma=float(np.abs(ycc[..., 1] - 128).mean() + np.abs(ycc[..., 2] - 128).mean()),
        )

        faces = _W["det"].detect(bgr)
        faces = sorted(faces, key=lambda r: -r[2] * r[3])[:8]
        for i, f in enumerate(faces):
            x, y, w, h = (float(v) for v in f[:4])
            x0, y0 = max(0, int(x)), max(0, int(y))
            x1, y1 = min(W, int(x + w)), min(H, int(y + h))
            roi = gray[y0:y1, x0:x1]
            row = {
                "idx": i, "x": x / W, "y": y / H, "w": w / W, "h": h / H, "score": float(f[14]),
                "lm": [round(float(v) / (W if j % 2 == 0 else H), 5) for j, v in enumerate(f[4:14])],
                "emb": _W["emb"].embed(bgr, f),
                "sharp": lap_var(roi, 256), "luma": float(roi.mean()) if roi.size else None,
            }
            if i < 4 and min(w, h) >= 36:
                m = _W["mesh"].analyze(_W["mesh"].crop(rgb, f))
                if m:
                    row.update(m)
            out["faces"].append(row)
        out["n_faces"] = len(faces)
        out["status"] = "analyzed"
    except Exception as e:  # one bad file must not stop 2,000 others
        out["error"] = f"{type(e).__name__}: {e}"[:300]
    return out


MAX_FILE_BYTES = 300 * 2**20  # a photo bigger than this is refused rather than read into memory
MAX_PHOTOS = 200_000          # a folder with more is almost certainly not a photo folder (e.g. "/")


class TooManyPhotos(ValueError):
    pass


def list_photos(root: Path, limit: int = MAX_PHOTOS) -> list[tuple[str, Path]]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in filenames:
            if not name.startswith(".") and os.path.splitext(name)[1].lower() in PHOTO_EXTS:
                p = Path(dirpath) / name
                found.append((p.relative_to(root).as_posix(), p))
                if len(found) > limit:
                    raise TooManyPhotos(f"More than {limit:,} photos under {root}: pick a narrower folder.")
    found.sort()
    return found


_FACE_COLS = ("idx", "x", "y", "w", "h", "score", "lm", "emb", "sharp", "luma",
              "blink_l", "blink_r", "smile", "jaw", "squint", "yaw", "pitch", "roll")
_PHOTO_COLS = ("status", "error", "size", "mtime_ns", "sha256", "width", "height", "fmt", "make", "model",
               "taken", "taken_ts", "taken_src", "phash", "luma", "luma_lo", "luma_hi", "sharp", "chroma", "n_faces")


def _save_phase1(store: Store, results: list[dict]) -> None:
    import json

    with store.tx() as c:
        for r in results:
            c.execute("DELETE FROM faces WHERE photo_id=?", (r["id"],))
            vals = [r.get(k) for k in _PHOTO_COLS]
            c.execute(f"UPDATE photos SET {', '.join(k + '=?' for k in _PHOTO_COLS)}, emb=NULL, crop_emb=NULL, "
                      f"crop_face=NULL WHERE id=?", (*vals, r["id"]))
            for fr in r["faces"]:
                fr = dict(fr)
                fr["lm"] = json.dumps(fr["lm"])
                fr["emb"] = f32(fr["emb"])
                c.execute(f"INSERT INTO faces(photo_id, {', '.join(_FACE_COLS)}) "
                          f"VALUES(?, {', '.join('?' for _ in _FACE_COLS)})",
                          (r["id"], *[fr.get(k) for k in _FACE_COLS]))


def crop_box(face: dict) -> list[float]:
    """Where upper_body_crop cuts from, as fractions of the photo (x, y, w, h; may run past the edges)."""
    W, H = face.get("width") or 1, face.get("height") or 1
    half = 1.6 * max(face["w"] * W, face["h"] * H)
    cx, cy = (face["x"] + face["w"] / 2) * W, (face["y"] + face["h"] / 2) * H + 0.55 * face["h"] * H
    return [round((cx - half) / W, 4), round((cy - half) / H, 4), round(2 * half / W, 4), round(2 * half / H, 4)]


def upper_body_crop(im: Image.Image, face: dict) -> Image.Image:
    """Square crop of face + shoulders + hands-near-face, padded at edges (for sunglasses/cigarette cues)."""
    W, H = im.size
    fw, fh = face["w"] * W, face["h"] * H
    cx, cy = (face["x"] + face["w"] / 2) * W, (face["y"] + face["h"] / 2) * H + 0.55 * fh
    half = 1.6 * max(fw, fh)
    box = (int(cx - half), int(cy - half), int(cx + half), int(cy + half))
    canvas = Image.new("RGB", (box[2] - box[0], box[3] - box[1]))
    canvas.paste(im.crop((max(0, box[0]), max(0, box[1]), min(W, box[2]), min(H, box[3]))),
                 (max(0, -box[0]), max(0, -box[1])))
    return canvas


class Analyzer:
    """Runs a scan in a background thread and exposes progress for the UI."""

    def __init__(self, store: Store, source: Path, workdir: Path, workers: int | None = None):
        self.store, self.source, self.workdir = store, Path(source), Path(workdir)
        self.workers = workers or max(2, min(8, (os.cpu_count() or 4) - 2))
        # what the analysis screen shows while it works: counts, the latest photos, the faces, kinds and you it found
        self.progress = {"phase": "idle", "done": 0, "total": 0, "started": None, "recent": [], "error": None,
                         "faces": 0, "smiles": 0, "blinks": 0, "recent_faces": [], "cats": {}, "recent_cats": [],
                         "me": None, "found": None, "recent_crops": [], "org": {}, "listed": 0, "new": 0}
        # ...and everything it found, photo by photo, in order (the screen reads it from where it left off, so no
        # photo is skipped however fast they go): read [id, face boxes, smiles, blinks]; kinds [id, kind, themes];
        # a closer look [id, head-and-shoulders box, what it found]
        self.feed: dict[str, list] = {"read": [], "cats": [], "seen": []}
        self.cancel = threading.Event()
        self.thread: threading.Thread | None = None
        self.on_finished = None

    @property
    def previews(self) -> Path:
        return self.workdir / "previews"

    @property
    def thumbs(self) -> Path:
        return self.workdir / "thumbs"

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.cancel.clear()
        self.feed = {"read": [], "cats": [], "seen": []}
        self.thread = threading.Thread(target=self._run, name="analyzer", daemon=True)
        self.thread.start()

    def running(self) -> bool:
        return bool(self.thread and self.thread.is_alive())

    def _set(self, phase: str, done: int = 0, total: int = 0) -> None:
        self.progress.update(phase=phase, done=done, total=total, started=time.time())

    def _run(self) -> None:
        try:
            self.previews.mkdir(parents=True, exist_ok=True)
            self.thumbs.mkdir(parents=True, exist_ok=True)
            self._set("models")
            from . import models

            models.ensure(lambda name, done, total: self.progress.update(phase="models", done=done, total=total, detail=name))
            self._set("listing")
            self._sync_files()
            self._phase1()
            if self.cancel.is_set():
                return
            self._embed_full()
            if self.cancel.is_set():
                return
            from . import library

            self._set("identity")
            library.refresh(self.store, identity_only=True)
            self._found_people()
            self._embed_crops()
            if self.cancel.is_set():
                return
            self._set("organizing")
            library.refresh(self.store, report=lambda step, **found: self.progress["org"].update({step: found}))
            self._found_all()
            self.store.set_meta("analyzed_at", time.time())
            self._set("done")
        except Exception as e:
            import traceback

            traceback.print_exc()
            self.progress.update(phase="error", error=f"{type(e).__name__}: {e}")
        finally:
            if self.on_finished:
                try:
                    self.on_finished()
                except Exception:
                    pass

    def _found_people(self) -> None:
        """For the analysis screen: a few of your faces, how many photos you're in, how many other people."""
        me = self.store.q("SELECT me_face FROM photos WHERE me_face IS NOT NULL")
        sample = [r["me_face"] for r in self.store.q(
            "SELECT me_face FROM photos WHERE me_face IS NOT NULL ORDER BY RANDOM() LIMIT 12")]
        others = self.store.one("SELECT COUNT(*) AS n FROM people WHERE is_me=0")
        self.progress["me"] = {"photos": len(me), "faces": sample, "people": others["n"] if others else 0}

    def _found_all(self) -> None:
        """For the analysis screen's reveal: what the whole run found."""
        summary = self.store.get_meta("summary") or {}
        cats = {r["category"]: r["n"] for r in self.store.q(
            "SELECT category, COUNT(*) AS n FROM photos WHERE category IS NOT NULL AND category != '' AND cut IS NULL GROUP BY category")}
        stacked = [r["id"] for r in self.store.q("SELECT rep AS id FROM groups WHERE members LIKE '%,%' LIMIT 6")]
        cut = [r["id"] for r in self.store.q("SELECT id FROM photos WHERE cut IS NOT NULL AND status='analyzed' LIMIT 6")]
        self.progress["found"] = {**summary, "cats": cats, "stacked": stacked, "cut_photos": cut,
                                  "faces": self.progress["faces"], "me": self.progress["me"]}

    def _sync_files(self) -> None:
        on_disk = list_photos(self.source)
        self.progress["listed"] = len(on_disk)
        known = {r["rel"]: r for r in self.store.q("SELECT id, rel, size, mtime_ns, status FROM photos")}
        with self.store.tx() as c:
            for rel, p in on_disk:
                try:
                    st = p.stat()
                except OSError:
                    continue
                r = known.get(rel)
                if r is None:
                    c.execute("INSERT INTO photos(rel, size, mtime_ns) VALUES(?,?,?)", (rel, st.st_size, st.st_mtime_ns))
                elif (r["size"], r["mtime_ns"]) != (st.st_size, st.st_mtime_ns) and r["status"] != "new":
                    c.execute("UPDATE photos SET status='new', size=?, mtime_ns=? WHERE id=?",
                              (st.st_size, st.st_mtime_ns, r["id"]))
            present = {rel for rel, _ in on_disk}
            for rel, r in known.items():
                if rel not in present and r["status"] != "missing":
                    c.execute("UPDATE photos SET status='missing' WHERE id=?", (r["id"],))
                elif rel in present and r["status"] == "missing":
                    c.execute("UPDATE photos SET status='new' WHERE id=?", (r["id"],))
        self.progress["new"] = self.store.one("SELECT COUNT(*) AS n FROM photos WHERE status='new'")["n"]

    def _phase1(self) -> None:
        todo = self.store.q("SELECT id, rel FROM photos WHERE status='new' ORDER BY id")
        total = len(todo)
        self._set("reading", 0, total)
        if not total:
            return
        tasks = [(r["id"], str(self.source / r["rel"]), r["rel"], str(self.previews / f"{r['id']}.jpg"),
                  str(self.thumbs / f"{r['id']}.jpg")) for r in todo]
        buf, done = [], 0
        ctx = multiprocessing.get_context("spawn")  # forking a multithreaded server process is unsafe
        with ProcessPoolExecutor(max_workers=self.workers, initializer=_init_worker, mp_context=ctx,
                                 max_tasks_per_child=400) as pool:  # recycled now and then: no slow leaks
            futures = [pool.submit(analyze_one, t) for t in tasks]
            try:
                for fut in as_completed(futures):
                    if self.cancel.is_set():
                        break
                    res = fut.result()
                    buf.append(res)
                    done += 1
                    if res["status"] == "analyzed":
                        self.progress["recent"] = (self.progress["recent"] + [res["id"]])[-24:]
                        fs = res.get("faces") or []
                        self.feed["read"].append([res["id"], [[round(f["x"], 3), round(f["y"], 3), round(f["w"], 3), round(f["h"], 3)] for f in fs[:6]],
                                                  sum(1 for f in fs if (f.get("smile") or 0) > 0.5),
                                                  sum(1 for f in fs if min(f.get("blink_l") or 0, f.get("blink_r") or 0) > 0.5)])
                        self.progress["faces"] += len(fs)
                        self.progress["smiles"] += sum(1 for f in fs if (f.get("smile") or 0) > 0.5)
                        self.progress["blinks"] += sum(1 for f in fs if min(f.get("blink_l") or 0, f.get("blink_r") or 0) > 0.5)
                        if fs:
                            boxes = [[round(f["x"], 3), round(f["y"], 3), round(f["w"], 3), round(f["h"], 3)] for f in fs[:6]]
                            self.progress["recent_faces"] = (self.progress["recent_faces"] + [[res["id"], boxes]])[-8:]
                    if len(buf) >= 16:
                        _save_phase1(self.store, buf)
                        buf = []
                    self.progress.update(done=done)
            finally:
                for fut in futures:
                    fut.cancel()
        if buf:
            _save_phase1(self.store, buf)

    def _siglip(self):
        from .vision import SigLIP

        if not hasattr(self, "_sig"):
            self._sig = SigLIP(threads=6, text=False)
        return self._sig

    def _embed(self, rows: list, load, column: str, phase: str, kinds: bool = False, closer: bool = False) -> None:
        total = len(rows)
        self._set(phase, 0, total)
        if not total:
            return
        sig, bs = self._siglip(), 8
        T, edges, keys = None, None, []
        if kinds:  # show each photo's kind as it's recognized (the same prompts the cups use), and the themes it shows
            from . import library
            from . import tags as tagmod
            from . import themes

            keys = list(library.CATEGORIES)
            T = library._prompt_embeddings([q for k in keys for q in library.CATEGORIES[k]])
            edges = np.cumsum([0] + [len(library.CATEGORIES[k]) for k in keys])[:-1]
            CT, cstarts = themes._prompts()
            cmeta = {**tagmod.concept_meta(), **tagmod.FIXED}
            ckeys = [tagmod.ALIAS.get(k, k) for k, _, _, _ in themes.CONCEPTS]
        looks = None
        if closer:  # everything it can tell about each photo, read off as its crop is embedded (the screen shows it):
            from . import library  # the same things that become its tags
            from . import tags as tagmod
            from . import themes
            from .models import SIGLIP_LOGIT_SCALE

            looks = [(name, *library.ATTRS[name]) for name in library.ATTRS]
            prompts = sorted({q for _, _, pos, neg in looks for q in pos + neg})
            P = library._prompt_embeddings(prompts)
            col = {q: i for i, q in enumerate(prompts)}
            CT, starts = themes._prompts()  # the concepts, against what's usual in this library
            allE = [unblob(r_["emb"]) for r_ in self.store.q("SELECT emb FROM photos WHERE emb IS NOT NULL")]
            M = np.stack(allE).astype(np.float32) if allE else np.zeros((1, 768), np.float32)
            M /= np.maximum(np.linalg.norm(M, axis=1, keepdims=True), 1e-9)
            Cs = np.maximum.reduceat(M @ CT.T, starts, axis=1)
            cmu, csd = Cs.mean(0), Cs.std(0) + 1e-6
            ckeys = [tagmod.ALIAS.get(k, k) for k, _, _, _ in themes.CONCEPTS]
            tmeta = {**tagmod.concept_meta(), **tagmod.FIXED}

        def prep(chunk):
            return [(r, load(r)) for r in chunk]

        chunks = [rows[i:i + bs] for i in range(0, total, bs)]
        done = 0
        with ThreadPoolExecutor(max_workers=3) as io_pool:
            pending = [io_pool.submit(prep, ch) for ch in chunks[:3]]
            nxt = 3
            while pending:
                batch = pending.pop(0).result()
                if nxt < len(chunks):
                    pending.append(io_pool.submit(prep, chunks[nxt]))
                    nxt += 1
                ok = [(r, x) for r, x in batch if x is not None]
                if ok:
                    embs = sig.embed_images(np.stack([x[1] if isinstance(x, tuple) else x for _, x in ok]))
                    ids = [r["id"] for r, _ in ok]
                    self.progress["recent"] = (self.progress["recent"] + ids)[-24:]
                    if looks is not None:
                        q = ','.join('?' * len(ids))
                        full = {r_["id"]: unblob(r_["emb"]) for r_ in self.store.q(
                            f"SELECT id, emb FROM photos WHERE id IN ({q})", ids) if r_["emb"] is not None}
                        fcs: dict[int, list] = {}
                        for f_ in self.store.q(f"SELECT photo_id, smile, blink_l, blink_r FROM faces WHERE photo_id IN ({q})", ids):
                            fcs.setdefault(f_["photo_id"], []).append(f_)
                        seen = []
                        for (r, x), e in zip(ok, embs):
                            found: dict[str, float] = {}
                            v_full = full.get(r["id"])
                            for name, src, pos, neg in looks:
                                v = e if src == "crop" else v_full
                                if v is None or name not in tagmod.ATTR_TAGS:
                                    continue
                                lg = SIGLIP_LOGIT_SCALE * (P[[col[q_] for q_ in pos + neg]] @ (v / (np.linalg.norm(v) + 1e-9)))
                                pr = np.exp(lg - lg.max())
                                prob = float(pr[:len(pos)].sum() / pr.sum())
                                tag, t = tagmod.ATTR_TAGS[name]
                                if prob >= t:
                                    found[tag] = max(found.get(tag, 0.0), prob)
                            if v_full is not None:  # the concepts it stands out for in this library
                                z = (np.maximum.reduceat((v_full / (np.linalg.norm(v_full) + 1e-9)) @ CT.T, starts) - cmu) / csd
                                for j in np.argsort(-z)[:4]:
                                    if z[j] >= 1.5:
                                        found.setdefault(ckeys[j], min(1.0, float(z[j]) / 4))
                            fs = fcs.get(r["id"], [])
                            if fs and max((f_["smile"] or 0) for f_ in fs) > 0.5:
                                found.setdefault("smiling", max(f_["smile"] or 0 for f_ in fs))
                            if any(min(f_["blink_l"] or 0, f_["blink_r"] or 0) >= 0.55 for f_ in fs):
                                found.setdefault("eyes_closed", 0.9)
                            if len(fs) >= 3:
                                found.setdefault("group_shot", 1.0)
                            top = sorted(found.items(), key=lambda kv: -kv[1])[:7]
                            seen.append([r["id"], crop_box(dict(r)), [[*(tmeta.get(k, ("🏷️", k, ""))[:2]), round(c_, 2)] for k, c_ in top]])
                        self.progress["recent_crops"] = (self.progress["recent_crops"] + seen)[-12:]
                        self.feed["seen"].extend(seen)
                    if T is not None:
                        kind = np.maximum.reduceat(embs @ T.T, edges, axis=1).argmax(1)
                        cats = self.progress["cats"]
                        for pid, k in zip(ids, kind):
                            cats[keys[k]] = cats.get(keys[k], 0) + 1
                        self.progress["recent_cats"] = (self.progress["recent_cats"] + [[pid, keys[k]] for pid, k in zip(ids, kind)])[-240:]
                        En = embs / np.maximum(np.linalg.norm(embs, axis=1, keepdims=True), 1e-9)
                        C = np.maximum.reduceat(En @ CT.T, cstarts, axis=1)
                        Z = (C - C.mean(1, keepdims=True)) / (C.std(1, keepdims=True) + 1e-6)  # what stands out in each photo
                        for row, (pid, k) in enumerate(zip(ids, kind)):
                            top = [j for j in np.argsort(-Z[row])[:4] if Z[row, j] >= 2.2]
                            self.feed["cats"].append([pid, keys[k], [list(cmeta.get(ckeys[j], ("🏷️", ckeys[j]))[:2]) for j in top]])
                    with self.store.tx() as c:
                        for (r, x), e in zip(ok, embs):
                            if isinstance(x, tuple):
                                c.execute(f"UPDATE photos SET {column}=?, crop_face=? WHERE id=?", (f16(e), x[0], r["id"]))
                            else:
                                c.execute(f"UPDATE photos SET {column}=? WHERE id=?", (f16(e), r["id"]))
                done += len(batch)
                self.progress.update(done=done)
                if self.cancel.is_set():
                    return

    def _embed_full(self) -> None:
        from .vision import SigLIP

        # newest first: the photos the reading step left on screen are the first to find their kind (and swim to it)
        rows = self.store.q("SELECT id FROM photos WHERE status='analyzed' AND emb IS NULL ORDER BY id DESC")

        def load(r):
            try:
                with Image.open(self.previews / f"{r['id']}.jpg") as im:
                    return SigLIP.preprocess(im)
            except OSError:
                return None

        self._embed(rows, load, "emb", "understanding", kinds=True)

    def _embed_crops(self) -> None:
        from .vision import SigLIP

        rows = self.store.q(
            "SELECT p.id, p.me_face, p.width, p.height, f.x, f.y, f.w, f.h FROM photos p JOIN faces f ON f.id = p.me_face "
            "WHERE p.status='analyzed' AND (p.crop_emb IS NULL OR p.crop_face IS NOT p.me_face) ORDER BY p.id")

        def load(r):
            try:
                with Image.open(self.previews / f"{r['id']}.jpg") as im:
                    return r["me_face"], SigLIP.preprocess(upper_body_crop(im.convert("RGB"), dict(r)))
            except OSError:
                return None

        self._embed(rows, load, "crop_emb", "details", closer=True)
