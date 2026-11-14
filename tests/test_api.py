"""T8: API on a fake store (offline, no DB) and the live-sample pseudonymization."""

import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

import api.main as main
from contracts.models import AlertsResponse, Finding, Item, MetricsReport, pseudonym
from ingest.export_sample import pseudonymize

FIX = Path(__file__).resolve().parent.parent / "fixtures"


class FakeStore:
    """In-memory stand-in for ingest.store with the functions the API uses."""

    def __init__(self):
        self.items = {it.id: it for it in TypeAdapter(list[Item]).validate_json((FIX / "items.json").read_text())}
        self.findings = TypeAdapter(list[Finding]).validate_json((FIX / "findings.json").read_text())
        self.injects: list[tuple[str, str]] = []
        self.pending: set[str] = set()

    @contextmanager
    def connect(self):
        yield self

    def load_findings(self, conn, topic=None):
        return [f for f in self.findings if topic is None or f.topic == topic]

    def synthetic_authors(self, conn, ids):
        return {self.items[i].author for i in ids if i in self.items and self.items[i].synthetic}

    def get_last_poll(self, conn):
        return datetime(2026, 11, 14, 4, 0, tzinfo=timezone.utc)

    def get_items(self, conn, ids):
        return [self.items[i] for i in ids if i in self.items]

    def has_pending_inject(self, conn, topic):
        return topic in self.pending

    def upsert_items(self, conn, items):
        new = [it for it in items if it.id not in self.items]
        self.items.update((it.id, it) for it in new)
        return len(new)

    def add_inject_request(self, conn, topic, campaign_id):
        self.injects.append((topic, campaign_id))
        self.pending.add(topic)
        return len(self.injects)


@pytest.fixture
def client(monkeypatch):
    fake = FakeStore()
    for name in ("connect", "load_findings", "synthetic_authors", "get_last_poll", "get_items",
                 "has_pending_inject", "upsert_items", "add_inject_request"):
        monkeypatch.setattr(main.store, name, getattr(fake, name))
    return TestClient(main.app), fake


def test_alerts_items_and_metrics_validate_and_mask_real_handles(client, monkeypatch, tmp_path):
    c, fake = client
    resp = AlertsResponse.model_validate(c.get("/api/alerts").json())
    assert resp.findings and resp.last_poll_at is not None
    real = {it.author for it in fake.items.values() if not it.synthetic}
    fake_names = {it.author for it in fake.items.values() if it.synthetic}
    for f in resp.findings:
        assert not set(f.accounts) & real  # no real handle leaks
        assert all(a in fake_names or a.endswith("***") for a in f.accounts)

    ids = [it.id for it in fake.items.values()][:30]
    got = TypeAdapter(list[Item]).validate_python(c.get("/api/items", params={"ids": ",".join(ids)}).json())
    assert len(got) == len(ids)
    assert all(it.synthetic or (it.author.endswith("***") and it.author not in real) for it in got)
    assert c.get("/api/items", params={"ids": ",".join(f"x{k}" for k in range(201))}).status_code == 400

    # metrics: committed report if valid, an empty report otherwise
    report = tmp_path / "report.json"
    monkeypatch.setattr(main, "REPORT_PATH", report)
    assert MetricsReport.model_validate(c.get("/api/metrics").json()).roc == []
    report.write_text("{not json")
    assert MetricsReport.model_validate(c.get("/api/metrics").json()).roc == []
    report.write_text((Path(main.__file__).resolve().parent.parent / "eval" / "report.json").read_text())
    assert MetricsReport.model_validate(c.get("/api/metrics").json()).roc


def test_inject_adds_synthetic_items_and_rejects_bad_or_repeated_requests(client, monkeypatch):
    c, fake = client
    before = len(fake.items)
    r = c.post("/api/inject", json={"topic": "helsinki-tram-fares"})
    assert r.status_code == 200
    body = r.json()
    new = [it for it in fake.items.values() if it.campaign_id == body["campaign_id"]]
    assert body["n_items"] == len(new) == len(fake.items) - before > 0
    assert all(it.synthetic and it.source == "synthetic" for it in new)
    assert fake.injects == [("helsinki-tram-fares", body["campaign_id"])]
    # still pending -> 429; after the worker processed it a second inject adds new items
    assert c.post("/api/inject", json={"topic": "helsinki-tram-fares"}).status_code == 429
    fake.pending.clear()
    later = datetime(2026, 11, 14, 12, 34, 56, tzinfo=timezone.utc)

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return later

    monkeypatch.setattr(main, "datetime", Later)
    mid = len(fake.items)
    r2 = c.post("/api/inject", json={"topic": "helsinki-tram-fares"})
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["campaign_id"] != body["campaign_id"]
    new2 = [it for it in fake.items.values() if it.campaign_id == body2["campaign_id"]]
    assert body2["n_items"] == len(new2) == len(fake.items) - mid > 0
    assert all(it.synthetic for it in new2)
    # same second again -> every id collides -> 409 instead of a fake "n_items"
    fake.pending.clear()
    assert c.post("/api/inject", json={"topic": "helsinki-tram-fares"}).status_code == 409
    fake.pending.clear()
    assert c.post("/api/inject", json={"topic": "no-such-topic"}).status_code == 400
    assert c.post("/api/inject", json={"topic": ""}).status_code == 422


def test_export_sample_pseudonymizes_and_drops_synthetic():
    items = TypeAdapter(list[Item]).validate_json((FIX / "items.json").read_text())
    out = pseudonymize(items, "salt")
    real = {it.author for it in items if not it.synthetic}
    organic = [it for it in items if not it.synthetic]
    assert len(out) == len(organic)
    assert all(not it.synthetic and it.author.startswith("acct-") for it in out)
    assert [it.author for it in out] == [pseudonym(it.author, "salt") for it in organic]
    dumped = json.dumps([it.model_dump(mode="json") for it in out])
    assert not any(handle in dumped for handle in real)
    with pytest.raises(ValueError):
        pseudonymize(items, "")
