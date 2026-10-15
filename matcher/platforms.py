"""Writable homes and desktop integration, including when the app is bundled."""
from __future__ import annotations

import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def worker_stdin(desktop: bool):
    """Keep the desktop's control pipe out of Windows worker startup."""
    if not desktop or sys.platform != "win32":
        yield
        return
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.SetStdHandle.argtypes = [wintypes.DWORD, wintypes.HANDLE]
    kernel.SetStdHandle.restype = wintypes.BOOL
    original = kernel.GetStdHandle(wintypes.DWORD(-10))
    with open(os.devnull, "rb") as empty:
        # A pending ReadFile on the control pipe can block a child's CRT startup. Python's existing
        # sys.stdin keeps that pipe; future children get NUL through the process's standard handle.
        if not kernel.SetStdHandle(wintypes.DWORD(-10), msvcrt.get_osfhandle(empty.fileno())):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            yield
        finally:
            kernel.SetStdHandle(wintypes.DWORD(-10), original)


def storage_paths(root: Path, *, env=None, platform=None, home=None, frozen=None) -> tuple[Path, Path]:
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    home = Path.home() if home is None else Path(home)
    frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    # Existing checkouts keep their saves; installed apps never write beside their executable.
    if not frozen and (root / ".git").exists():
        data, models = root / "data", root / "models"
    elif platform == "win32":
        base = Path(env.get("LOCALAPPDATA") or home / "AppData" / "Local") / "MatchER"
        data, models = base / "data", base / "models"
    elif platform == "darwin":
        data = home / "Library" / "Application Support" / "MatchER" / "data"
        models = home / "Library" / "Caches" / "MatchER" / "models"
    else:
        data = Path(env.get("XDG_DATA_HOME") or home / ".local" / "share") / "matcher"
        models = Path(env.get("XDG_CACHE_HOME") or home / ".cache") / "matcher" / "models"
    return (Path(env.get("MATCHER_DATA") or data).expanduser(),
            Path(env.get("MATCHER_MODELS") or models).expanduser())


def desktop_env() -> dict:
    """System programs need their system libraries, rather than PyInstaller's copies."""
    env = os.environ.copy()
    if getattr(sys, "frozen", False) and sys.platform.startswith("linux"):
        original = env.pop("LD_LIBRARY_PATH_ORIG", None)
        if original:
            env["LD_LIBRARY_PATH"] = original
        else:
            env.pop("LD_LIBRARY_PATH", None)
    return env


def open_directory(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(str(path))
    else:
        cmd = "open" if sys.platform == "darwin" else "xdg-open"
        subprocess.Popen([cmd, str(path)], env=desktop_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
