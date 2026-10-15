"""PyInstaller's entry point must dispatch spawn children before importing the app."""
import multiprocessing
import os

if __name__ == "__main__":
    if os.environ.get("MATCHER_DIAGNOSTICS") == "1":
        import faulthandler
        faulthandler.dump_traceback_later(45)
    multiprocessing.freeze_support()
    from matcher.__main__ import main
    main()
