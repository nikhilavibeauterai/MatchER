"""Run with `python -m tests.benchmark_performance`: synthetic metadata only, no photo files."""
import cProfile
import json
import pstats
import statistics
import tempfile
import time
from pathlib import Path

import numpy as np

from matcher.ranker import Ranker
from matcher.server import Session, create_app


def catalogue(path, n):
    s = Session(path / "synthetic", path / "scratch")
    with s.store.tx() as c:
        c.executemany("INSERT INTO photos(id,rel,status,group_id,category,theme_id,taken_ts) VALUES(?,?,'analyzed',?,'things',?,?)",
                      [(i, f"synthetic/{i}.jpg", i, (i - 1) // 600 + 1, 1700000000 + i) for i in range(1, n + 1)])
        c.executemany("INSERT INTO groups(id,rep,members) VALUES(?,?,?)", [(i, i, f"[{i}]") for i in range(1, n + 1)])
        c.executemany("INSERT INTO themes(id,name,emoji,seed) VALUES(?,?,?,?)",
                      [(i, f"Synthetic group {i}", "🌈", (i - 1) * 600 + 1) for i in range(1, (n + 599) // 600 + 1)])
    s.reps = list(range(1, n + 1)); s.gids = s.reps.copy(); s.gidx = {p: i for i, p in enumerate(s.reps)}
    s.groups = {p: {"rep": p, "members": [p], "scene": p, "checked": True} for p in s.reps}
    s.photo_group = {p: p for p in s.reps}; s.base_active = np.ones(n, bool); s.cats = ["things"] * n
    s.names = ["sharp", "light"]; s.n_hand = 2; s.store.set_meta("settings", {"mode": "gallery"})
    s.ranker = Ranker(np.zeros((n, 2)), np.zeros(2), np.ones(2), np.arange(n), k=8); s.ranker.fit([])
    s.n_votes = 0; s.compared = set()
    s.ensure_ranker = lambda **kw: s.ranker
    s.draw._space = (s.version, np.zeros((n, 1)), np.zeros((n, 1)), None, np.zeros(n, bool), [], np.arange(n, dtype=float))
    return s


def run(n):
    with tempfile.TemporaryDirectory(prefix="matcher-benchmark-") as tmp:
        path = Path(tmp); s = catalogue(path, n); app = create_app(path / "scratch", allowed_hosts={"localhost"})
        app.config["MATCHER"].session = s; client = app.test_client(); results = []
        try:
            for name, url in [("board", "/api/draw/board?per=24&uper=24"),
                              ("expanded", "/api/draw/board?per=24&full=1"),
                              ("world", "/api/world?per=1000"), ("tags", "/api/tags?all=1"),
                              ("journey", "/api/journey"), ("shortlist", "/api/shortlist"),
                              ("filter", "/api/filter"), ("notes", "/api/photo/1/notes"), ("state", "/api/state")]:
                times = []; profile = cProfile.Profile()
                for _ in range(4):
                    start = time.perf_counter(); reply = client.get(url)
                    assert reply.status_code == 200, (url, reply.get_json())
                    times.append(round((time.perf_counter() - start) * 1000, 1))
                profile.enable(); client.get(url); profile.disable()
                hot = sorted(pstats.Stats(profile).stats.items(), key=lambda x: x[1][2], reverse=True)[:8]
                results.append({"name": name, "coldMs": times[0], "warmMedianMs": statistics.median(times[1:]),
                                "bytes": len(reply.data), "hot": [{"function": f"{k[0].split('/')[-1]}:{k[2]}", "selfMs": round(v[2] * 1000, 1), "calls": v[1]} for k, v in hot]})
            return {"photos": n, "results": results}
        finally:
            s.shutdown()


if __name__ == "__main__":
    print(json.dumps([run(n) for n in (3600, 20000)], indent=2))
