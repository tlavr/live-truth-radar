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
    calls = {"ingest": 0, "detect": [], "cleanup": []}
    monkeypatch.setattr(worker.store, "delete_findings_except", lambda conn, keep: calls["cleanup"].append(keep))

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
    assert calls["cleanup"] == [["bad", "good"]]  # stale topics' findings removed once per poll
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
    """I1 offline: inject -> process_injects -> coordinated synthetic finding; the second inject alerts too.

    The worker passes the wall clock to detect(), and an inject expires ~10 min after the click
    (synthetic_ttl_sec), so the clock is frozen one minute after each click: 20 min later the first
    campaign has expired and only the new one is alerted.
    """
    from datetime import datetime, timedelta, timezone

    from synth.campaign import make_campaign

    topic, click0 = "helsinki-tram-fares", datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
    clock = {"now": click0}

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock["now"]

    window: list = []
    stored: dict[str, list[Finding]] = {}
    pending: list[dict] = []
    monkeypatch.setattr(worker, "datetime", FrozenDatetime)
    monkeypatch.setattr(worker.store, "window_items", lambda conn, t, h: [it for it in window if it.topic == t])
    monkeypatch.setattr(worker.store, "replace_findings", lambda conn, t, fs: stored.__setitem__(t, fs))
    monkeypatch.setattr(worker.store, "pending_injects", lambda conn: list(pending))
    monkeypatch.setattr(worker.store, "mark_injects_processed", lambda conn, ids: pending.clear())
    monkeypatch.setattr(worker, "_with_explanation", lambda f, posts: f)  # no LLM in tests
    monkeypatch.setattr(worker.store, "get_items", lambda conn, ids: [], raising=False)
    detector = worker.load_detector()

    for k in range(2):
        click = click0 + timedelta(minutes=20 * k)
        campaign = make_campaign(topic, click)
        window += campaign
        clock["now"] = click + timedelta(minutes=1)
        pending.append({"id": k, "topic": topic})
        assert worker.process_injects(FakeConn(), detector, window_hours=6) == 1
        alerts = [f for f in stored[topic] if f.verdict == "coordinated" and f.synthetic]
        assert len(alerts) == 1  # the earlier inject (20 min ago) has expired
        assert set(alerts[0].accounts) == {it.author for it in campaign}


def test_detect_topic_stores_each_slider_alpha(monkeypatch):
    from datetime import datetime, timezone

    from synth.campaign import make_campaign

    topic = "helsinki-tram-fares"
    window = make_campaign(topic, datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc), n_accounts=3, seed=5)
    main, extra, alphas_seen = {}, {}, []
    monkeypatch.setattr(worker.store, "window_items", lambda conn, t, h: list(window))
    monkeypatch.setattr(worker.store, "replace_findings", lambda conn, t, fs: main.__setitem__(t, fs))
    monkeypatch.setattr(worker.store, "replace_findings_alpha", lambda conn, t, a, fs: extra.__setitem__((t, a), fs))
    monkeypatch.setattr(worker.store, "ensure_schema", lambda conn: None)
    monkeypatch.setattr(worker, "_with_explanation", lambda f, posts: f)
    monkeypatch.setattr(worker.store, "get_items", lambda conn, ids: [], raising=False)
    from detect.pipeline import detect

    def detector(items, *, alpha=0.02):
        alphas_seen.append(alpha)
        return detect(items, alpha=alpha)

    worker.detect_topic(FakeConn(), topic, detector, 6, alphas=(0.005, 0.05))
    assert alphas_seen == [0.02, 0.005, 0.05]
    assert set(extra) == {(topic, 0.005), (topic, 0.05)}
    # the design point and the loose point catch this 3-account swarm, the strict point does not
    verdicts = {a: [f.verdict for f in fs] for (_, a), fs in extra.items()}
    assert "coordinated" in [f.verdict for f in main[topic]] and "coordinated" in verdicts[0.05]
    assert "coordinated" not in verdicts[0.005]

    # the production wrapper passes alpha through (a slider whose points all equal 2% must fail here)
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 14, 12, 1, tzinfo=timezone.utc)  # 1 min after the click: not expired

    monkeypatch.setattr(worker, "datetime", Frozen)
    real = worker.load_detector()
    assert "coordinated" in [f.verdict for f in real(window, alpha=0.05)]
    assert "coordinated" not in [f.verdict for f in real(window, alpha=0.005)]


def test_alpha_points_from_env(monkeypatch):
    monkeypatch.delenv("ALPHA_POINTS", raising=False)
    assert worker.alpha_points() == (0.01, 0.05)  # slider stops without the design alpha (findings table)
    monkeypatch.setenv("ALPHA_POINTS", "0.05, 0.02,bad,1.5,0,0.1")
    assert worker.alpha_points() == (0.05, 0.1)
    monkeypatch.setenv("ALPHA_POINTS", "")
    assert worker.alpha_points() == ()


def test_failing_extra_alpha_never_loses_the_main_findings(monkeypatch):
    stored, attempts = {}, []
    monkeypatch.setattr(worker.store, "window_items", lambda conn, t, h: [])
    monkeypatch.setattr(worker.store, "replace_findings", lambda conn, t, fs: stored.__setitem__(t, fs))

    def broken(conn, t, a, fs):
        attempts.append(a)
        raise RuntimeError("findings_alpha missing")

    monkeypatch.setattr(worker.store, "replace_findings_alpha", broken)
    monkeypatch.setattr(worker.store, "ensure_schema", lambda conn: None)
    conn = FakeConn()
    worker.detect_topic(conn, "t", lambda items, alpha=0.02: [], 6, alphas=(0.01, 0.05))
    assert "t" in stored and attempts == [0.01, 0.05]  # each point tried, the error swallowed
    assert conn.commits >= 1  # the main findings are committed before the extra points run


def test_reddit_source_is_off_by_default(monkeypatch):
    calls = []

    class Client:
        def news_search(self, query, since):
            calls.append("news")
            return {}

        def reddit_search(self, query):
            calls.append("reddit")
            return {}

    monkeypatch.setattr(worker, "news_to_items", lambda resp, topic: [])
    monkeypatch.setattr(worker, "reddit_to_items", lambda resp, topic: [])
    monkeypatch.delenv("REDDIT_ENABLED", raising=False)
    assert worker.fetch_topic(Client(), "jensen-huang-resignation", since=None) == []
    assert calls == ["news"]  # no Context.dev request units spent on the failing reddit scrape

    calls.clear()
    monkeypatch.setenv("REDDIT_ENABLED", "1")
    worker.fetch_topic(Client(), "jensen-huang-resignation", since=None)
    assert calls == ["news", "reddit"]


def test_no_stale_cleanup_without_topics(monkeypatch):
    cleaned = []
    monkeypatch.setattr(worker.store, "delete_findings_except", lambda conn, keep: cleaned.append(keep))
    monkeypatch.setattr(worker, "ingest_cycle", lambda conn: None)
    monkeypatch.setattr(worker, "process_injects", lambda conn, d, h: 0)
    monkeypatch.setenv("TOPICS", "")
    worker.tick(FakeConn(), worker.LoopState(detector=lambda items: [], interval=300, window_hours=6), now=0.0)
    assert cleaned == []  # an empty TOPICS must never wipe every finding


def test_stale_cleanup_also_covers_findings_alpha_and_survives_its_absence():
    from contextlib import contextmanager

    import psycopg

    from ingest import store

    class Cur:
        rowcount = 2

        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, params):
            if "findings_alpha" in sql and self.conn.no_alpha_table:
                raise psycopg.errors.UndefinedTable("findings_alpha")
            self.conn.sql.append((sql.split()[2], params, self.conn.depth))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class Conn:
        def __init__(self, no_alpha_table):
            self.sql, self.no_alpha_table, self.depth = [], no_alpha_table, 0

        @contextmanager
        def transaction(self):
            self.depth += 1
            try:
                yield
            finally:
                self.depth -= 1

        def cursor(self):
            return Cur(self)

    conn = Conn(no_alpha_table=False)
    assert store.delete_findings_except(conn, ("a", "b")) == 4
    # findings_alpha inside a nested savepoint: a missing table must not abort the findings DELETE
    assert conn.sql == [("findings", (["a", "b"],), 1), ("findings_alpha", (["a", "b"],), 2)]
    old = Conn(no_alpha_table=True)  # a DB volume from before T12c
    assert store.delete_findings_except(old, ["a"]) == 2 and old.sql == [("findings", (["a"],), 1)]
