"""P1: /health answers offline (catches import errors in api.main before deploy)."""

from fastapi.testclient import TestClient

from api.main import app
from contracts.models import AlertsResponse


def test_health_ok():
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_alerts_stub_matches_contract():
    r = TestClient(app).get("/api/alerts")
    assert r.status_code == 200
    assert AlertsResponse.model_validate(r.json()).findings == []
