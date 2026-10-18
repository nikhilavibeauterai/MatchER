"""The sheet keeps writing through latency and failure without needing a browser or any photos."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_photo_notes_writing():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is also required by the browser suites")
    result = subprocess.run([node, "--test", "tests/photo_notes_checks.cjs"],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
