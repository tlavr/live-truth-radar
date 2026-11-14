"""T12d: scan-session staleness and radar frames stored by the worker (offline)."""

from datetime import datetime, timedelta, timezone

from contracts.models import Item
from ingest import radar, worker

T = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)


def test_is_stale():
    assert not radar.is_stale(T - timedelta(seconds=59), T)
    assert radar.is_stale(T - timedelta(seconds=61), T)


def test_detect_topic_stores_the_scan_frame_of_scanned_topics_only(monkeypatch):
    stored, findings = [], []
    item = Item(id="i1", source="context_news", author="a.com", published_at=T, text="x", topic="t")
    monkeypatch.setattr(worker.store, "window_items", lambda conn, t, h: [item])
    monkeypatch.setattr(worker.store, "replace_findings", lambda conn, t, fs: findings.append((t, fs)))
    monkeypatch.setattr(worker.store, "add_frame", lambda conn, fr: stored.append(fr))

    class Conn:
        def commit(self):
            pass

    worker.detect_topic(Conn(), "t", lambda items: [], 6)
    assert stored == []  # not scanned: no frame

    from detect.pipeline import scan

    def scanner(items, topic):
        return scan(items, topics=[topic], now=T)

    worker.detect_topic(Conn(), "t", lambda items: (_ for _ in ()).throw(AssertionError("detect")), 6,
                        scanner=scanner)
    assert len(stored) == 1 and stored[0]["topic"] == "t" and stored[0]["n_items"] == 1
    assert isinstance(stored[0]["at"], str)  # JSON-ready (jsonb)
    assert findings[-1] == ("t", [])


def test_load_scanner_returns_one_frame_for_the_topic():
    findings, frames = worker.load_scanner()([], "t")
    assert findings == [] and [f.topic for f in frames] == ["t"] and frames[0].n_items == 0
