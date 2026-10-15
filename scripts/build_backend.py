"""Bundle the backend on the current OS, including native-library license notices."""
from __future__ import annotations

import importlib.metadata as metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def licenses():
    dest = ROOT / "build" / "licenses"
    dest.mkdir(parents=True, exist_ok=True)
    inventory = []
    for dist in sorted(metadata.distributions(), key=lambda d: d.metadata["Name"].lower()):
        name = dist.metadata["Name"]
        files = []
        for entry in dist.files or []:
            parts = [p.lower() for p in entry.parts]
            if not any("license" in p or "copying" in p or p.startswith("notice") for p in parts):
                continue
            src = Path(dist.locate_file(entry))
            if not src.is_file() or src.suffix.lower() in {".py", ".pyc", ".so", ".dll", ".pyd"}:
                continue
            # Preserve the wheel's hierarchy: native libraries often carry their own notices.
            rel = Path(*[p for p in entry.parts if p not in (".", "..")])
            target = dest / name / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, target)
            files.append(str(target.relative_to(dest)).replace("\\", "/"))
        inventory.append({"name": name, "version": dist.version, "license": dist.metadata.get("License-Expression") or dist.metadata.get("License"), "notices": files})
    (dest / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")


def main():
    if sys.version_info[:2] != (3, 13):
        raise SystemExit("Build with Python 3.13, matching the runtime lock.")
    licenses()
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", str(ROOT / "dist" / "backend"),
                    "--workpath", str(ROOT / "build" / "pyinstaller"), str(ROOT / "packaging" / "backend.spec")], check=True, cwd=ROOT)


if __name__ == "__main__":
    main()
