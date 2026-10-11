"""Start MatchER:  python -m matcher  (or ./matcher from the project folder)."""
from __future__ import annotations

import argparse
import logging
import os
import secrets
import socket
import sys
import threading
import webbrowser
from pathlib import Path

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
    ap = argparse.ArgumentParser(prog="matcher", description="Photo tournaments that find your best shots.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true",
                    help="also serve on your home network behind a secret link, e.g. to duel from your phone")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--data", type=Path, help="where to keep the database, previews and exports")
    a = ap.parse_args()

    from .config import DATA_DIR
    from .server import create_app

    host = "0.0.0.0" if a.lan else "127.0.0.1"
    port = _free_port(a.port, host)
    allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
    data = Path(a.data or DATA_DIR)
    secret = _secret(data)
    url = f"http://127.0.0.1:{port}/?k={secret}"
    if a.lan:
        ip = _lan_ip()
        allowed.add(f"{ip}:{port}")
    app = create_app(data, secret=secret, allowed_hosts=allowed, cookie=f"matcher_k{port}")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    print(f"\n  MatchER is running:  {url}")
    if a.lan:
        print(f"  On your phone (same Wi-Fi):  http://{ip}:{port}/?k={secret}")
    print("  That link is the key (it sets a cookie, then the address bar is clean); don't share it.")
    print("  Stop it with Ctrl+C. Your progress is saved after every choice.\n", flush=True)
    if not a.no_browser:
        threading.Timer(0.8, webbrowser.open, (url,)).start()
    try:
        app.run(host=host, port=port, threaded=True, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
