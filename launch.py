"""Source launcher shared by matcher.sh and matcher.cmd. Requires Python 3.13."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parent


def main():
    os.environ.setdefault("PYTHONUTF8", "1")
    if sys.version_info[:2] != (3, 13):
        print("MatchER needs Python 3.13. Install it from https://www.python.org/downloads/ then run this again.\n"
              "The desktop installer needs no Python: https://github.com/nikhilavibeauterai/MatchER/releases", file=sys.stderr)
        return 1
    folder = ROOT / ".venv"
    python = folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    stamp = folder / ".requirements.sha256"
    want = hashlib.sha256((ROOT / "requirements.lock").read_bytes()).hexdigest()
    if not python.is_file():
        print("Setting up MatchER (one time)…", flush=True)
        venv.EnvBuilder(with_pip=True).create(folder)
    if not stamp.is_file() or stamp.read_text().strip() != want:
        print("Installing checked dependencies. This may take a few minutes…", flush=True)
        subprocess.run([str(python), "-m", "pip", "install", "--require-hashes", "--only-binary=:all:",
                        "-r", str(ROOT / "requirements.lock")], check=True)
        stamp.write_text(want + "\n")
    cmd = [str(python), "-m", "matcher", *sys.argv[1:]]
    if os.name == "nt":
        return subprocess.call(cmd, cwd=ROOT)
    os.chdir(ROOT)
    os.execv(str(python), cmd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"Couldn't start MatchER: {e}\nSee docs/install.md for help.", file=sys.stderr)
        sys.exit(1)
