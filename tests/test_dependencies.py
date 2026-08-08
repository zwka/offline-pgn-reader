"""Dependency compatibility checks for the Python rollback/oracle runtime."""

from __future__ import annotations

import subprocess
import sys


def test_oracle_imports_without_deprecation_warnings():
    result = subprocess.run(
        [
            sys.executable,
            "-W",
            "error::DeprecationWarning",
            "-c",
            "from fastapi.testclient import TestClient\n"
            "from pgnreader.api import create_app\n",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
