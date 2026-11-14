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
    st = worker.LoopState(detector_name="real", detector=detector, interval=180, window_hours=6)
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
