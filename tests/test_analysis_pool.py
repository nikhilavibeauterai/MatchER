"""Analysis scheduling and resume checks use synthetic results, never photos or models."""
import json
import os
from pathlib import Path
from queue import Empty, Queue
import signal
import subprocess
import sys
import threading
from concurrent.futures import Future

import pytest

from matcher import analyze
from matcher.store import Store


def _photo(task):
    return {"id": task[0], "status": "analyzed", "n_faces": 0, "faces": []}


class _Pool:
    def __init__(self, **kwargs):
        self.kwargs, self.tasks, self.pending, self.peak, self.closed = kwargs, [], 0, 0, False
        assert "max_tasks_per_child" not in kwargs
        assert kwargs["mp_context"].get_start_method() == "spawn"

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def submit(self, fn, task):
        pool = self

        class Result(Future):
            consumed = False

            def result(self, *args, **kwargs):
                if not self.consumed:
                    self.consumed = True
                    pool.pending -= 1
                return super().result(*args, **kwargs)

        self.tasks.append(task)
        self.pending += 1
        self.peak = max(self.peak, self.pending)
        future = Result()
        future.set_result(fn(task))
        return future


def _pools(monkeypatch):
    pools = []

    def create(**kwargs):
        assert all(p.closed for p in pools), "The previous generation must finish before replacement"
        pool = _Pool(**kwargs)
        pools.append(pool)
        return pool

    monkeypatch.setattr(analyze, "ProcessPoolExecutor", create)
    return pools


def test_reading_continues_past_3200_and_persists_every_result(tmp_path, monkeypatch):
    pools = _pools(monkeypatch)
    monkeypatch.setattr(analyze, "analyze_one", _photo)
    store = Store(tmp_path / "synthetic.db")
    try:
        with store.tx() as c:
            c.executemany("INSERT INTO photos(id,rel) VALUES(?,?)", ((i, f"{i}.jpg") for i in range(1, 3300)))
        analyzer = analyze.Analyzer(store, tmp_path / "source", tmp_path / "work", workers=8)
        analyzer._phase1()
        assert [len(p.tasks) for p in pools] == [3200, 99]
        assert max(p.peak for p in pools) <= 16
        assert all(p.closed for p in pools)
        assert analyzer.progress["done"] == analyzer.progress["total"] == 3299
        assert sorted(row[0] for row in analyzer.feed["read"]) == list(range(1, 3300))
        assert store.one("SELECT COUNT(*) AS n FROM photos WHERE status='analyzed'")["n"] == 3299
        analyzer._phase1()
        assert analyzer.progress["done"] == analyzer.progress["total"] == 0
        assert len(pools) == 2, "Resuming a completed read should not launch any decoder workers"
    finally:
        store.close()


def test_cancellation_does_not_submit_the_remaining_library(monkeypatch):
    pools = _pools(monkeypatch)
    cancel = threading.Event()
    results = analyze._process_results(abs, list(range(-3299, 0)), 8, cancel)
    next(results)
    cancel.set()
    assert list(results) == []
    assert len(pools) == 1 and len(pools[0].tasks) == 16 and pools[0].closed


@pytest.mark.parametrize("failure", [False, True], ids=["cancel", "worker-error"])
def test_partial_results_survive_interruption_and_resume(tmp_path, monkeypatch, failure):
    store = Store(tmp_path / "synthetic.db")
    analyzer = analyze.Analyzer(store, tmp_path / "source", tmp_path / "work", workers=2)
    seen = []

    def interrupted(fn, tasks, workers, cancel, initializer):
        for task in tasks[:7]:
            yield _photo(task)
        if failure:
            raise RuntimeError("synthetic worker failure")
        cancel.set()

    def resumed(fn, tasks, workers, cancel, initializer):
        seen.extend(t[0] for t in tasks)
        yield from (_photo(t) for t in tasks)

    try:
        with store.tx() as c:
            c.executemany("INSERT INTO photos(id,rel) VALUES(?,?)", ((i, f"{i}.jpg") for i in range(1, 22)))
        monkeypatch.setattr(analyze, "_process_results", interrupted)
        if failure:
            with pytest.raises(RuntimeError, match="synthetic worker failure"):
                analyzer._phase1()
        else:
            analyzer._phase1()
        assert store.one("SELECT COUNT(*) AS n FROM photos WHERE status='analyzed'")["n"] == 7
        monkeypatch.setattr(analyze, "_process_results", resumed)
        analyzer.cancel.clear()
        analyzer._phase1()
        assert seen == list(range(8, 22))
        assert analyzer.progress["done"] == analyzer.progress["total"] == 14
        assert store.one("SELECT COUNT(*) AS n FROM photos WHERE status='new'")["n"] == 0
    finally:
        store.close()


def test_real_spawn_pool_finishes_a_3299_task_read(tmp_path):
    # A separate session lets the timeout clean up only our synthetic workers if this regresses into a hang.
    script = tmp_path / "spawn_check.py"
    script.write_text('''\
import json
import threading
from matcher.analyze import _process_results

if __name__ == "__main__":
    values = list(_process_results(abs, list(range(-3299, 0)), 8, threading.Event()))
    assert sorted(values) == list(range(1, 3300))
    print(json.dumps({"completed": len(values)}))
''')
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1]), "OPENBLAS_NUM_THREADS": "1"}
    proc = subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env=env, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=45)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
        out, err = proc.communicate()
        pytest.fail(f"The synthetic read stalled after worker recycling: {out}\n{err}")
    assert proc.returncode == 0, err
    assert json.loads(out) == {"completed": 3299}


def test_desktop_control_pipe_does_not_block_worker_startup(tmp_path):
    script = tmp_path / "desktop_workers.py"
    script.write_text('''\
import json
import sys
import threading
from matcher.analyze import _process_results
from matcher.platforms import worker_stdin

if __name__ == "__main__":
    with worker_stdin(True):
        control = threading.Thread(target=sys.stdin.readline)
        control.start()
        def analyze():
            values = list(_process_results(abs, [-2, -1], 2, threading.Event()))
            print(json.dumps(sorted(values)), flush=True)
        work = threading.Thread(target=analyze)
        work.start()
        work.join()
        control.join()
''')
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1]), "OPENBLAS_NUM_THREADS": "1"}
    proc = subprocess.Popen([sys.executable, str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
    output = Queue()
    threading.Thread(target=lambda: output.put(proc.stdout.readline()), daemon=True).start()
    try:
        # communicate() would close stdin first and hide the Windows startup deadlock.
        line = output.get(timeout=30)
        assert json.loads(line) == [1, 2]
        proc.stdin.write("stop\n")
        proc.stdin.flush()
        _, err = proc.communicate(timeout=10)
        assert proc.returncode == 0, err
    except (Empty, subprocess.TimeoutExpired):
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
        out, err = proc.communicate()
        pytest.fail(f"Desktop analysis workers did not start with the control pipe open: {out}\n{err}")
    finally:
        if proc.poll() is None:
            proc.stdin.close()
            proc.wait(timeout=10)
