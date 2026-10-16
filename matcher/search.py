"""Local text-to-photo search over the image understanding already saved by analysis."""
from collections import OrderedDict
import json
import threading

import numpy as np

from .store import unblob

_lock = threading.Lock()
_encoder = None
_queries = OrderedDict()


def encode(query):
    """Keep the text tower in memory; searching never reopens or reanalyzes a photograph."""
    global _encoder
    with _lock:
        if query not in _queries:
            from .vision import SigLIP
            if _encoder is None:
                _encoder = SigLIP(threads=2, vision=False)
            _queries[query] = _encoder.embed_texts([f"a photo of {query}"])[0]
            if len(_queries) > 64:
                _queries.popitem(last=False)
        _queries.move_to_end(query)
        return _queries[query]


class PhotoSearch:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.version = None

    def find(self, query, limit=60):
        query = " ".join(query.split())
        if not query:
            return []
        text = encode(query.casefold())
        with self.lock:
            version = (self.store.get_meta("state_version"), self.store.get_meta("analyzed_at"))
            if version != self.version:
                rows = self.store.q("SELECT id,emb,crop_emb FROM photos WHERE status='analyzed' AND emb IS NOT NULL ORDER BY id")
                self.ids = [r["id"] for r in rows]
                self.full = np.stack([unblob(r["emb"]) for r in rows]) if rows else np.empty((0, len(text)), np.float32)
                self.crop = np.stack([unblob(r["crop_emb"] or r["emb"]) for r in rows]) if rows else self.full
                for matrix in (self.full, self.crop):
                    matrix /= np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-9)
                self.version = version
            scores = np.maximum(self.full @ text, self.crop @ text)
            order = {pid: float(score) for pid, score in zip(self.ids, scores)}
        # Names, captions and tag corrections work alongside visual phrases. These small text rows stay live
        # independently of the embedding cache, so a freshly written title is searchable immediately.
        from . import tags
        meta = tags.rows(self.store)
        matching = {key for key, tag in meta.items() if query.casefold() in tag["label"].casefold()}
        tagged = tags.effective(self.store) if matching else {}
        found = []
        for row in self.store.q("SELECT id,rel,taken,cut,group_id,edits FROM photos WHERE status IN ('analyzed','error')"):
            p = dict(row)
            edits = json.loads(p.pop("edits") or "{}")
            title = edits.get("title", "")
            fields = [p["rel"], title, edits.get("description", "")]
            named = any(query.casefold() in value.casefold() for value in fields)
            tag_match = matching & tagged.get(p["id"], set())
            score = order.get(p["id"], -1)
            if named or tag_match:
                score += 1
            if p["id"] not in order and not (named or tag_match):
                continue
            found.append({**p, "photo": p["id"], "title": title, "score": score,
                          "match": "name" if named else "tag" if tag_match else "visual"})
        found.sort(key=lambda p: (-p["score"], p["id"]))
        return found[:limit]
