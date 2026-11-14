"""T8: worker loop on a fake store (offline, no DB): one failing topic must not stall the others."""

from contracts.models import Finding
from ingest import worker


class FakeConn:
    def __init__(self):
        self.commits = 0
        self.rollbacks = 0

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class FakeWorkerStore:
    def __init__(self, pending):
        self.pending = list(pending)
        self.processed: list[int] = []
        self.replaced: list[str] = []

    def window_items(self, conn, topic, hours):
        return [topic]  # the fake detector only needs the topic

    def replace_findings(self, conn, topic, findings):
        self.replaced.append(topic)

    def pending_injects(self, conn):
        return [r for r in self.pending if r["id"] not in self.processed]

    def mark_injects_processed(self, conn, ids):
        self.processed.extend(ids)


def test_failing_topic_does_not_stall_other_topics_injects_or_poll_interval(monkeypatch):
    fake = FakeWorkerStore([{"id": 1, "topic": "good"}, {"id": 2, "topic": "bad"}])
    for name in ("window_items", "replace_findings", "pending_injects", "mark_injects_processed"):
        monkeypatch.setattr(worker.store, name, getattr(fake, name))
    calls = {"ingest": 0, "detect": []}

    def ingest_cycle(conn):
        calls["ingest"] += 1
        raise RuntimeError("Context.dev down")

    def detector(items: list) -> list[Finding]:
        calls["detect"].append(items[0])
        if items[0] == "bad":
            raise RuntimeError("detector blew up")
        return []

    monkeypatch.setattr(worker, "ingest_cycle", ingest_cycle)
    monkeypatch.setenv("TOPICS", "bad,good")
    st = worker.LoopState(detector=detector, interval=180, window_hours=6)
    conn = FakeConn()
    for k in range(5):  # 5 ticks of ~10 s, all inside one poll interval
        worker.tick(conn, st, now=10.0 * k)

    assert calls["ingest"] == 1  # a failed cycle is not retried every tick
    assert calls["detect"].count("good") == 2  # poll + inject
    assert calls["detect"].count("bad") == 2
    assert "good" in fake.replaced and "bad" not in fake.replaced
    assert sorted(fake.processed) == [1, 2]  # a failed inject is marked too: no permanent 429
    assert conn.rollbacks >= 3

    worker.tick(conn, st, now=180.0)  # next interval: polled again
    assert calls["ingest"] == 2


def test_detect_topic_ends_the_read_transaction_before_the_llm_call(monkeypatch):
    from pathlib import Path

    from pydantic import TypeAdapter

    import ingest.explain as ex

    findings = TypeAdapter(list[Finding]).validate_json(
        (Path(__file__).resolve().parent.parent / "fixtures" / "findings.json").read_text())
    f = next(f for f in findings if f.verdict == "coordinated").model_copy(update={"explanation": None})
    conn = FakeConn()
    seen = {}
    monkeypatch.setattr(worker.store, "window_items", lambda conn, topic, hours: [])
    monkeypatch.setattr(worker.store, "get_items", lambda conn, ids: [])
    monkeypatch.setattr(worker.store, "replace_findings",
                        lambda conn, topic, fs: seen.setdefault("stored", fs))

    def explain_safe(finding, items):
        seen["commits"] = conn.commits
        return None

    monkeypatch.setattr(ex, "explain_safe", explain_safe)

    assert worker.detect_topic(conn, f.topic, lambda items: [f], 6) == 1
    assert seen["commits"] == 1  # no DB transaction is held open during the slow provider call
    assert [x.id for x in seen["stored"]] == [f.id]  # the write still happens, in the unit's own transaction


def test_real_detector_alerts_on_each_of_two_injects(monkeypatch):
    """I1 offline: inject -> process_injects -> coordinated synthetic finding; the second inject alerts too."""
    from datetime import datetime, timedelta, timezone

    from synth.campaign import make_campaign

    topic, now = "helsinki-tram-fares", datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
    window: list = []
    stored: dict[str, list[Finding]] = {}
    pending: list[dict] = []
    monkeypatch.setattr(worker.store, "window_items", lambda conn, t, h: [it for it in window if it.topic == t])
    monkeypatch.setattr(worker.store, "replace_findings", lambda conn, t, fs: stored.__setitem__(t, fs))
    monkeypatch.setattr(worker.store, "pending_injects", lambda conn: list(pending))
    monkeypatch.setattr(worker.store, "mark_injects_processed", lambda conn, ids: pending.clear())
    monkeypatch.setattr(worker, "_with_explanation", lambda f, posts: f)  # no LLM in tests
    monkeypatch.setattr(worker.store, "get_items", lambda conn, ids: [], raising=False)
    detector = worker.load_detector()

    for k in range(2):
        window += make_campaign(topic, now + timedelta(minutes=20 * k))
        pending.append({"id": k, "topic": topic})
        assert worker.process_injects(FakeConn(), detector, window_hours=6) == 1
        alerts = [f for f in stored[topic] if f.verdict == "coordinated" and f.synthetic]
        assert len(alerts) == k + 1
