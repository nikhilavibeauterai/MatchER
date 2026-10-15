"""PyInstaller's entry point must dispatch spawn children before importing the app."""
import multiprocessing
import os

if __name__ == "__main__":
    if os.environ.get("MATCHER_DIAGNOSTICS") == "1":
        import faulthandler
        import sys
        from pathlib import Path
        directory = os.environ.get("MATCHER_DIAGNOSTIC_DIR")
        if directory:
            Path(directory).mkdir(parents=True, exist_ok=True)
            trace = open(Path(directory) / f"process-{os.getpid()}.log", "a", encoding="utf-8", buffering=1)
            sys.stderr = trace
            print(f"Process {os.getpid()}: {sys.argv[1:]!r}", file=trace)
        faulthandler.dump_traceback_later(45, file=sys.stderr)
    multiprocessing.freeze_support()
    from matcher.__main__ import main
    main()
