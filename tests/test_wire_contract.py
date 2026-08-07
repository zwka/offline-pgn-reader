"""Shared wire fixtures keep the Python oracle aligned with TypeScript."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pgnreader.api import create_app


WIRE_FIXTURE = Path(__file__).parent / "fixtures" / "wire_contract.json"


@pytest.fixture
def api_client(settings):
    with TestClient(create_app(settings)) as client:
        yield client


def test_python_health_and_error_wire_contract(api_client):
    expected = json.loads(WIRE_FIXTURE.read_text(encoding="utf-8"))

    assert api_client.get("/api/health").json() == expected["healthOk"]
    assert api_client.get("/api/missing").json() == expected["notFound"]
