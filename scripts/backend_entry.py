"""PyInstaller's entry point must dispatch spawn children before importing the app."""
import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from matcher.__main__ import main
    main()
