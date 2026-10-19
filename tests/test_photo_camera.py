"""The popup and stage share bounded decoding and cancellation."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_photo_camera():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is also required by the browser suites")
    result = subprocess.run([node, "--test", "tests/photo_camera_checks.cjs"],
                            cwd=Path(__file__).parents[1], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
