"""Writable homes and desktop integration, including when the app is bundled."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


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
