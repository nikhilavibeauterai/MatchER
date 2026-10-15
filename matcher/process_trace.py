"""Opt-in process traces for native CI checks; normal launches do nothing."""
import faulthandler
import os
from pathlib import Path
import sys


def install():
    if os.environ.get("MATCHER_DIAGNOSTICS") != "1":
        return
    directory = os.environ.get("MATCHER_DIAGNOSTIC_DIR")
    if directory:
        Path(directory).mkdir(parents=True, exist_ok=True)
        trace = open(Path(directory) / f"process-{os.getpid()}.log", "a", encoding="utf-8", buffering=1)
        sys.stderr = trace
        print(f"Process {os.getpid()}: {sys.argv[1:]!r}", file=trace, flush=True)
    if sys.stderr is not None:
        faulthandler.dump_traceback_later(35, file=sys.stderr)
