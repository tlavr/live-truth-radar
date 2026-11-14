"""P1: /health answers offline (catches import errors in api.main before deploy)."""

from fastapi.testclient import TestClient

from api.main import app


def test_health_ok():
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_dashboard_pages_are_served():
    c = TestClient(app)
    for path, marker in [("/", 'src="/app.js"'), ("/app.js", "openTopic"), ("/metrics", "/api/metrics")]:
        r = c.get(path)
        assert r.status_code == 200, path
        assert marker in r.text, path
        assert r.headers["cache-control"] == "no-cache", path  # a deploy shows without a hard reload


def test_topics_from_env(monkeypatch):
    monkeypatch.setenv("TOPICS", " jensen-huang, ukraine-peace-talks ,,")
    assert TestClient(app).get("/api/topics").json() == ["jensen-huang", "ukraine-peace-talks"]
