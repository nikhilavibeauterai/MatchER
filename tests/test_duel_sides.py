"""The displayed winner stays put without changing the server's card or vote meaning."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_duel_sides():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is also required by the browser suites")
    result = subprocess.run([node, "--test", "tests/duel_checks.cjs"],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
