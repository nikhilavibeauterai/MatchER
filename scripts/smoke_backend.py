"""Check the actual executable, private HTTP link, offline sample and graceful shutdown."""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("executable", type=Path)
    ap.add_argument("--analyze", action="store_true", help="also download models into the scratch dir and analyze the public sample")
    a = ap.parse_args()
    executable = a.executable.resolve()
    command = [str(executable)] + (["-X", "utf8", "-m", "matcher"] if executable.name.lower() == "python.exe" else [])
    with tempfile.TemporaryDirectory(prefix="matcher package Zoë ") as tmp:
        env = {**os.environ, "MATCHER_DATA": str(Path(tmp) / "saves"), "MATCHER_MODELS": str(Path(tmp) / "models"), "PYTHONUTF8": "1"}
        if env.get("MATCHER_DIAGNOSTICS") == "1":
            env["MATCHER_DIAGNOSTIC_DIR"] = str(Path(tmp) / "diagnostics")
        subprocess.run([*command, "--self-test"], check=True, env=env, timeout=120)
        lines = queue.Queue()
        with (Path(tmp) / "startup.log").open("w+", encoding="utf-8") as log:
            child = subprocess.Popen([*command, "--desktop", "--port", "0"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8", env=env)
            def read():
                for line in child.stdout:
                    lines.put(line)
                lines.put(None)
            threading.Thread(target=read, daemon=True).start()
            try:
                line = lines.get(timeout=120)
                assert line and line.startswith("MATCHER_READY "), "backend did not become ready"
                url = json.loads(line.removeprefix("MATCHER_READY "))["url"]
                base = url.split("/?")[0]
                try:
                    urllib.request.urlopen(base + "/api/state", timeout=10)
                    raise AssertionError("unkeyed access was accepted")
                except urllib.error.HTTPError as e:
                    assert e.code == 403
                browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                assert browser.open(url, timeout=10).status == 200
                def request(path, body=None):
                    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                                 headers={"Content-Type": "application/json", "X-MatchER": "1"})
                    return json.loads(browser.open(req, timeout=30).read())
                assert request("/api/state")["library"] is None
                assert browser.open(base + "/static/fonts/caveat.woff2", timeout=10).status == 200
                request("/api/sample", {})
                deadline = time.monotonic() + 30
                sample = request("/api/sample")
                while sample["state"] not in ("done", "error") and time.monotonic() < deadline:
                    time.sleep(.1)
                    sample = request("/api/sample")
                assert sample["state"] == "done", sample
                assert len(list(Path(sample["path"]).rglob("*.jpg"))) == 13
                if a.analyze:
                    request("/api/library", {"path": sample["path"], "mode": "gallery"})
                    deadline = time.monotonic() + 240
                    phase, reported, reading_since = None, 0, None
                    while time.monotonic() < deadline:
                        state = request("/api/state")["library"]
                        progress = state.get("progress") or {}
                        if progress.get("phase") == "reading" and progress.get("done") == 0:
                            reading_since = reading_since or time.monotonic()
                            if env.get("MATCHER_DIAGNOSTICS") == "1" and time.monotonic() - reading_since > 70:
                                raise AssertionError("The public sample's first reading result stalled.")
                        if progress.get("phase") != phase or time.monotonic() - reported > 10:
                            phase, reported = progress.get("phase"), time.monotonic()
                            print(json.dumps({k: progress.get(k) for k in ("phase", "done", "total")}), flush=True)
                        if not state["analyzing"]:
                            assert state["analyzed"], state.get("progress")
                            break
                        time.sleep(.5)
                    else:
                        raise AssertionError(f"public sample analysis timed out: {state.get('progress')}")
                child.stdin.write("stop\n")
                child.stdin.flush()
                assert child.wait(timeout=120) == 0, "backend did not stop cleanly"
                try:
                    urllib.request.urlopen(base + "/", timeout=2)
                    raise AssertionError("HTTP port stayed open after quit")
                except (urllib.error.URLError, ConnectionError, TimeoutError):
                    pass
                print(json.dumps({"ok": True, "authenticated_http": True, "offline_sample": 13, "analysis": a.analyze, "clean_exit": True}))
            except BaseException:
                log.flush()
                log.seek(0)
                sys.stderr.write(re.sub(r"([?&]k=)[A-Za-z0-9_-]+", r"\1[private]", log.read()))
                for trace in sorted((Path(tmp) / "diagnostics").glob("*.log")):
                    sys.stderr.write(trace.name + "\n" + trace.read_text(encoding="utf-8", errors="replace"))
                raise
            finally:
                if child.poll() is None:
                    child.stdin.close()
                    try:
                        child.wait(timeout=120)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()


if __name__ == "__main__":
    main()
