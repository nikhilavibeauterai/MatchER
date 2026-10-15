"""Start MatchER:  python -m matcher  (or ./matcher from the project folder)."""
from __future__ import annotations

import argparse
import json
import logging
import multiprocessing
import os
import secrets
import socket
import sys
import threading
import webbrowser
from pathlib import Path

if os.name == "posix":
    os.umask(0o077)  # the database holds face data: files MatchER creates are yours only

# Quiet the native libraries before anything imports them (worker processes inherit this).
os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
# numpy's BLAS: on these small matrices two threads are as fast as one per core, and idle OpenBLAS threads
# spin-wait, so the default kept every core busy (measured: ~13 cores burned for the same latency).
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")


def _free_port(start: int, host: str) -> int:
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port between {start} and {start + 19}.")


def _lan_ip() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.0.2.1", 9))  # TEST-NET address: no packet is sent, it just picks the LAN interface
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def _secret(data: Path) -> str:
    """The key in the app's link: made once, kept in the data folder (readable by you only), so a restart doesn't
    lock out the tab you already have open. Delete the file to change it."""
    data.mkdir(parents=True, exist_ok=True)
    f = data / "secret"
    try:
        return f.read_text().strip()
    except FileNotFoundError:
        key = secrets.token_urlsafe(24)
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out:
            out.write(key)
        return key


def main() -> None:
    from . import __version__
    ap = argparse.ArgumentParser(prog="matcher", description="Photo tournaments that find your best shots.")
    ap.add_argument("--version", action="version", version=f"MatchER {__version__}")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true",
                    help="also serve on your home network behind a secret link, e.g. to duel from your phone")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--data", type=Path, help="where to keep the database, previews and exports")
    ap.add_argument("--debug", action="store_true", help="show the developer panel (the sea's macro/micro tuning) on every screen")
    ap.add_argument("--desktop", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--self-test", action="store_true", help="check the installed runtime without reading your photos")
    a = ap.parse_args()
    if a.self_test:
        from .diagnostics import check_runtime
        print(json.dumps(check_runtime()), flush=True)
        return
    if not 0 <= a.port <= 65535 or (a.desktop and a.lan):
        ap.error("use a port between 0 and 65535; desktop mode only serves this computer")

    from .config import DATA_DIR
    from .server import create_app
    from waitress import create_server

    host = "0.0.0.0" if a.lan else "127.0.0.1"
    port = _free_port(a.port, host) if a.port else 0
    allowed = set()
    data = Path(a.data or DATA_DIR)
    secret = _secret(data)
    app = create_app(data, secret=secret, allowed_hosts=allowed, cookie=f"matcher_k{port or secrets.token_hex(4)}",
                     debug_panel=a.debug or os.environ.get("MATCHER_DEBUG") == "1")
    server = create_server(app, host=host, port=port, threads=8, clear_untrusted_proxy_headers=True,
                           max_request_body_size=2 * 1024 * 1024)
    port = int(server.effective_port)
    allowed.update({f"127.0.0.1:{port}", f"localhost:{port}"})
    url = f"http://127.0.0.1:{port}/?k={secret}"
    if a.lan:
        ip = _lan_ip()
        allowed.add(f"{ip}:{port}")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    if a.desktop:
        print("MATCHER_READY " + json.dumps({"url": url}), flush=True)
    else:
        print(f"\n  MatchER is running:  {url}")
        if a.lan:
            print(f"  On your phone (same Wi-Fi):  http://{ip}:{port}/?k={secret}")
        print("  That link is the key (it sets a cookie, then the address bar is clean); don't share it.")
        print("  Stop it with Ctrl+C. Your progress is saved after every choice.\n", flush=True)
    if not a.no_browser and not a.desktop:
        threading.Timer(0.8, webbrowser.open, (url,)).start()
    stopped = threading.Event()

    def serve():
        try:
            server.run()
        finally:
            stopped.set()

    def parent_pipe():
        # EOF also handles a crashed desktop window; there is no network shutdown endpoint.
        try:
            for line in sys.stdin:
                if line.strip() == "stop":
                    break
        finally:
            stopped.set()

    thread = threading.Thread(target=serve, name="matcher-http", daemon=True)
    thread.start()
    if a.desktop:
        threading.Thread(target=parent_pipe, name="matcher-desktop", daemon=True).start()
    try:
        stopped.wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        sessions = list(app.config["MATCHER"]._sessions.values())
        for s in sessions:
            s.analyzer.cancel.set()
        server.task_dispatcher.shutdown(timeout=60)
        for s in list(app.config["MATCHER"]._sessions.values()):
            s.shutdown()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
