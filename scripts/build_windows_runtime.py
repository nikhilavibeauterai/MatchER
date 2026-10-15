"""Bundle CPython's official portable runtime and the normal Windows wheels."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def build():
    pin = json.loads((ROOT / "packaging" / "python-windows.json").read_text(encoding="utf-8"))
    archive = ROOT / "build" / f"python-{pin['version']}-embed-amd64.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != pin["sha256"]:
        print("Downloading the pinned portable Python runtime…", flush=True)
        with urllib.request.urlopen(pin["url"], timeout=60) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != pin["sha256"]:
            raise RuntimeError("The portable Python archive failed its published SHA-256 check.")
        archive.write_bytes(content)
    dest = ROOT / "dist" / "backend" / "matcher-backend"
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(dest)
    # Isolated from system Python, with our wheels and their normal DLL loaders enabled.
    pth = next(dest.glob("python*._pth"))
    stdlib = next(dest.glob("python*.zip")).name
    pth.write_text(f"{stdlib}\n.\nLib/site-packages\nimport site\n", encoding="utf-8")
    packages = dest / "Lib" / "site-packages"
    subprocess.run([sys.executable, "-m", "pip", "install", "--require-hashes", "--only-binary=:all:",
                    "--no-compile", "--target", str(packages), "-r", str(ROOT / "requirements.lock")], check=True)
    shutil.copytree(ROOT / "matcher", packages / "matcher", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(ROOT / "build" / "licenses", dest / "_internal" / "licenses")
    for name in ("LICENSE", "SOURCE.md", "THIRD_PARTY_NOTICES.md"):
        shutil.copyfile(ROOT / name, dest / "_internal" / name)
    (dest / "matcher-backend.cmd").write_text('@echo off\n"%~dp0python.exe" -X utf8 -m matcher %*\n', encoding="utf-8")
    print(f"Portable Windows backend ready: {dest}", flush=True)


if __name__ == "__main__":
    build()
