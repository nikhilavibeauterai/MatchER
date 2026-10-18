"""Request and analysis workers release resources without losing a requested continuation."""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from matcher.analyze import Analyzer
from matcher.server import App, create_app
from matcher.store import ClosedStoreError, Store


def test_browser_refresh_reads_running_analysis_without_restarting_it(tmp_path, monkeypatch):
    entered, finish = threading.Event(), threading.Event()
    visits = []
    def work(analyzer):
        visits.append(analyzer.started)
        analyzer.progress.update(phase="reading", done=7, total=21)
        analyzer.feed["read"] = [[7, [], 0, 0, None, [800, 600]]]
        entered.set()
        finish.wait(3)
    monkeypatch.setattr(Analyzer, "_run", work)
    source = tmp_path / "synthetic-source"
    source.mkdir()
    app = create_app(tmp_path / "saves", allowed_hosts={"localhost"})
    session = app.config["MATCHER"].open(source)
    try:
        assert entered.wait(2)
        worker, generation = session.analyzer.thread, session.analyzer.started
        client = app.test_client()
        for _ in range(3):
            assert client.get("/").status_code == 200
            state = client.get("/api/state").get_json()["library"]
            assert state["analyzing"] and state["progress"]["done"] == 7
            assert client.get("/api/analysis/feed?read=0").get_json()["read"][0][0] == 7
            assert session.analyzer.thread is worker and session.analyzer.started == generation
        assert len(visits) == 1
    finally:
        finish.set()
        session.shutdown()


def test_transient_threads_share_one_connection_and_serialize_writes(tmp_path):
    store = Store(tmp_path / "synthetic.db")
    original = store.conn()
    connections = []
    store.set_meta("count", 0)

    def request():
        with store.tx() as conn:
            connections.append(conn)
            value = store.get_meta("count")
            store.set_meta("count", value + 1)

    try:
        # A fresh thread for each call reproduces the server's request lifecycle.
        for _ in range(100):
            worker = threading.Thread(target=request)
            worker.start()
            worker.join(2)
            assert not worker.is_alive()
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(lambda _: request(), range(100)))
        assert len(connections) == 200 and all(c is original for c in connections)
        assert store.get_meta("count") == 200
    finally:
        store.close()
    assert store._connection is None
    with pytest.raises(ClosedStoreError):
        store.conn()


@pytest.mark.parametrize("leave_again", [False, True])
def test_reopen_waits_for_canceled_analysis_then_resumes_once(tmp_path, monkeypatch, leave_again):
    first_entered, drain, restarted = threading.Event(), threading.Event(), threading.Event()
    visits = []
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()

    def work(analyzer):
        if analyzer.source != first:
            return
        visits.append(analyzer.started)
        if len(visits) == 1:
            first_entered.set()
            assert drain.wait(3)
        else:
            assert not analyzer.cancel.is_set()
            analyzer.store.set_meta("synthetic_analysis_done", True)
            restarted.set()

    monkeypatch.setattr(Analyzer, "_run", work)
    app = App(tmp_path / "saves")
    try:
        session = app.open(first)
        assert first_entered.wait(2)
        worker, generation = session.analyzer.thread, session.analyzer.started
        app.open(second)
        assert session.analyzer.cancel.is_set()
        assert app.open(first) is session
        session.analyzer.start()  # repeated polls must not create extra runs
        assert session.analyzer.thread is worker and session.analyzer.started == generation
        assert session.analyzer.cancel.is_set()
        if leave_again:
            app.close()
        drain.set()
        worker.join(3)
        assert not worker.is_alive()
        assert len(visits) == (1 if leave_again else 2)
        assert restarted.is_set() is (not leave_again)
        assert not session.analyzer.running()
        assert session.store.get_meta("synthetic_analysis_done") is (None if leave_again else True)
    finally:
        drain.set()
        for session in app._sessions.values():
            session.shutdown()
