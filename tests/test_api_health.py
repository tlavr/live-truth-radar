"""P1: /health answers offline (catches import errors in api.main before deploy)."""

from fastapi.testclient import TestClient

from api.main import app


def test_health_ok():
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
