"""Hash only the finished installers, not the unpacked development tree."""
import hashlib
from pathlib import Path
import sys

folder = Path(__file__).resolve().parent.parent / "dist" / "desktop"
installers = sorted(p for p in folder.iterdir() if p.suffix.lower() in {".exe", ".deb", ".appimage"})
if not installers:
    raise SystemExit("No installers to checksum.")
name = "windows" if sys.platform == "win32" else "linux"
with (folder / f"SHA256SUMS-{name}-x64.txt").open("w", encoding="utf-8", newline="\n") as out:
    for path in installers:
        with path.open("rb") as src:
            digest = hashlib.file_digest(src, "sha256").hexdigest()
        out.write(f"{digest}  {path.name}\n")
print(f"Checksummed {len(installers)} installers")
