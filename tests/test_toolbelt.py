"""The eraser cuts real strokes; rapid drawing preserves every saved gesture."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_toolbelt_engine():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is also required by the browser suites")
    result = subprocess.run([node, "--test", "tests/toolbelt_checks.cjs"],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
