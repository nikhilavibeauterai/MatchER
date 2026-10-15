"""Exercise the actual off-thread swarm engine without a browser or photo library."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_sea_engine():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is also required by the browser suites")
    result = subprocess.run([node, "--test", "tests/sea_checks.cjs"],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
