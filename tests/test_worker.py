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
    calls = {"detect": [], "cleanup": []}
    monkeypatch.setattr(worker.store, "delete_findings_except", lambda conn, keep: calls["cleanup"].append(keep))

    def detector(items: list) -> list[Finding]:
        calls["detect"].append(items[0])
        if items[0] == "bad":
            raise RuntimeError("detector blew up")
        return []

    monkeypatch.setenv("TOPICS", "bad,good")
    st = worker.LoopState(detector=detector, interval=180, window_hours=6)
    conn = FakeConn()
    for k in range(5):  # 5 steps of ~10 s, no ingest wake-up: one full pass only
        worker.step(conn, st, now=10.0 * k)

    assert calls["cleanup"] == [["bad", "good"]]  # stale topics' findings removed once per full pass
    assert calls["detect"].count("good") == 2  # full pass + inject
    assert calls["detect"].count("bad") == 2
    assert "good" in fake.replaced and "bad" not in fake.replaced
    assert sorted(fake.processed) == [1, 2]  # a failed inject is marked too: no permanent 429
    assert conn.rollbacks >= 2  # the bad topic in the full pass and in the inject (ingest has its own thread)

    st.polled.set()  # the ingest thread finished a cycle: full pass at once, not at the fallback deadline
    worker.step(conn, st, now=60.0)
    assert len(calls["cleanup"]) == 2 and not st.polled.is_set()
    worker.step(conn, st, now=60.0 + 2 * 180)  # fallback deadline when ingest is stuck
    assert len(calls["cleanup"]) == 3


def test_plan_runs_fast_topics_on_their_own_interval():
    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6, next_poll=1e9, scan_interval=10)
    assert worker.plan(st, 0.0, []) == (False, [])
    assert worker.plan(st, 0.0, ["a"]) == (False, ["a"])
    st.next_fast = 10.0
    assert worker.plan(st, 5.0, ["a"]) == (False, [])
    assert worker.plan(st, 10.0, ["a", "b"]) == (False, ["a", "b"])
    st.polled.set()
    assert worker.plan(st, 5.0, ["a"]) == (True, [])


def test_fast_topics_get_frequent_runs_at_the_design_alpha_only(monkeypatch):
    runs = []
    monkeypatch.setattr(worker.store, "window_items", lambda conn, t, h: [t])
    monkeypatch.setattr(worker.store, "replace_findings", lambda conn, t, fs: None)
    monkeypatch.setattr(worker.store, "replace_findings_alpha", lambda conn, t, a, fs: runs.append((t, a)))
    monkeypatch.setattr(worker.store, "ensure_schema", lambda conn: None)
    monkeypatch.setattr(worker.store, "delete_findings_except", lambda conn, keep: None)
    monkeypatch.setattr(worker, "process_injects", lambda *a: 0)
    monkeypatch.setattr(worker, "fast_topics", lambda conn: ["a"])
    monkeypatch.setenv("TOPICS", "a,b")

    def detector(items, alpha=0.02):
        runs.append((items[0], alpha))
        return []

    st = worker.LoopState(detector=detector, interval=300, window_hours=6, alphas=(0.05,), scan_interval=10)
    worker.step(FakeConn(), st, now=0.0)  # full pass: both topics, both alphas; "a" not run twice
    assert sorted(r for r in runs if r[1] == 0.02) == [("a", 0.02), ("b", 0.02)]
    runs.clear()
    wait = worker.step(FakeConn(), st, now=10.0)
    assert runs == [("a", 0.02)]  # fast frame: the scanned topic, design alpha, no slider points
    assert 0.2 <= wait <= 10
    runs.clear()
    worker.step(FakeConn(), st, now=15.0)
    assert runs == []  # not due yet


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
    assert worker.alpha_points() == (0.005, 0.01, 0.05, 0.1)  # slider stops without the design alpha (findings table)
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
    monkeypatch.setattr(worker, "_get_client", lambda: object())
    monkeypatch.setenv("BLUESKY_ENABLED", "0")
    monkeypatch.delenv("REDDIT_ENABLED", raising=False)
    # no Context.dev request units spent on the failing reddit scrape
    assert [s.name for s in worker.active_sources(6)] == ["news"]
    monkeypatch.setenv("REDDIT_ENABLED", "1")
    assert [s.name for s in worker.active_sources(6)] == ["news", "reddit"]


def test_no_stale_cleanup_without_topics(monkeypatch):
    cleaned = []
    monkeypatch.setattr(worker.store, "delete_findings_except", lambda conn, keep: cleaned.append(keep))
    monkeypatch.setattr(worker, "process_injects", lambda *a: 0)
    monkeypatch.setenv("TOPICS", "")
    worker.step(FakeConn(), worker.LoopState(detector=lambda items: [], interval=300, window_hours=6), now=0.0)
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


def _coordinated(topic="t", accounts=("x", "y", "z")):
    from pathlib import Path

    from pydantic import TypeAdapter

    from contracts.models import finding_id

    f = next(f for f in TypeAdapter(list[Finding]).validate_json(
        (Path(__file__).resolve().parent.parent / "fixtures" / "findings.json").read_text())
        if f.verdict == "coordinated")
    return f.model_copy(update={"topic": topic, "accounts": list(accounts), "id": finding_id(topic, list(accounts)),
                                "explanation": None})


def test_explain_queue_dedups_keeps_the_newest_per_topic_and_drops_stale_ids():
    q = worker.ExplainQueue()
    a, b = _coordinated(accounts=("x", "y", "z")), _coordinated(accounts=("x", "y", "z", "w"))
    assert q.submit(a, []) and not q.submit(a, [])  # already queued
    assert q.submit(b, [])  # the swarm grew: replaces a
    job = q.take(timeout=0)
    assert job[0].id == b.id and q.take(timeout=0) is None
    assert not q.submit(b, [])  # in flight
    q.done(b, ok=True)
    assert q.take_dirty() == {"t"} and q.take_dirty() == set()

    q.submit(a, [])
    q.set_wanted("t", [b.id])  # a is no longer among the topic's latest findings
    assert q.take(timeout=0) is None
    q.submit(a, [])
    q.done(a, ok=False)
    assert q.take_dirty() == set()


def test_explain_queue_thread_explains_and_marks_the_topic_dirty():
    import threading

    seen = []
    q = worker.ExplainQueue(explain_fn=lambda f, posts: seen.append(f.id) or "exp")
    stop = threading.Event()
    t = threading.Thread(target=q.run, args=(stop,))
    t.start()
    f = _coordinated()
    q.submit(f, [])
    for _ in range(200):
        if seen:
            break
        stop.wait(0.01)
    stop.set()
    q.stop()  # wakes take() at once (main() calls it on shutdown)
    t.join(timeout=2)
    assert not t.is_alive() and seen == [f.id] and q.take_dirty() == {"t"}


def test_queued_explanations_come_from_cache_and_are_never_wiped(monkeypatch):
    import ingest.explain as ex

    f = _coordinated()
    old = _coordinated().model_copy(update={"explanation": {"technique": "copypasta", "quote": "q",
                                                             "confidence": 0.9, "summary": "s"}})
    q = worker.ExplainQueue()
    monkeypatch.setattr(worker, "_explain_queue", q)
    monkeypatch.setattr(worker.store, "get_items", lambda conn, ids: [])
    monkeypatch.setattr(ex, "explain_safe", lambda *a: (_ for _ in ()).throw(AssertionError("LLM in detect thread")))
    monkeypatch.setattr(ex, "cached_explanation", lambda finding, posts: None)

    monkeypatch.setattr(worker.store, "load_findings", lambda conn, topic: [old])
    kept = worker._explained(FakeConn(), [f])
    assert kept[0].explanation == old.explanation  # the stored explanation survives a frequent frame
    assert q.take(timeout=0) is None  # nothing to explain

    monkeypatch.setattr(worker.store, "load_findings", lambda conn, topic: [])
    out = worker._explained(FakeConn(), [f])
    assert out[0].explanation is None and q.take(timeout=0)[0].id == f.id  # missing: queued, not called


def test_ingest_loop_wakes_the_detect_loop(monkeypatch):
    """The warm-up moved into ingest_cycle (per topic, before the upsert): see the test below."""
    import threading
    from contextlib import contextmanager

    from contracts.models import Item

    items = [Item(id="n1", source="context_news", author="a.com", published_at="2026-11-14T12:00:00Z", text="t",
                  topic="x")]
    warmed = []

    @contextmanager
    def connect():
        yield FakeConn()

    stop = threading.Event()
    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6)

    def cycle(conn):
        stop.set()  # one cycle only
        return items

    monkeypatch.setattr(worker.store, "connect", connect)
    monkeypatch.setattr(worker, "ingest_cycle", cycle)
    monkeypatch.setattr(worker, "warm_embeddings", lambda its: warmed.extend(its))
    worker.ingest_loop(stop, st)
    assert warmed == [] and st.polled.is_set()  # no second, late warm-up after the whole cycle


def test_failed_re_store_keeps_the_topic_dirty(monkeypatch):
    q = worker.ExplainQueue()
    monkeypatch.setattr(worker, "_explain_queue", q)
    monkeypatch.setattr(worker, "fast_topics", lambda conn: [])
    monkeypatch.setattr(worker, "process_injects", lambda *a: 0)
    monkeypatch.setattr(worker, "_ensure_schema_once", lambda conn: None)
    monkeypatch.setenv("TOPICS", "t")
    calls = []

    def detect_topic(conn, topic, *a):
        calls.append(topic)
        raise RuntimeError("DB hiccup")

    monkeypatch.setattr(worker, "detect_topic", detect_topic)
    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6, next_poll=1e9)
    q._dirty.add("t")
    worker.step(FakeConn(), st, now=0.0)
    assert calls == ["t"] and q.take_dirty() == {"t"}  # not lost: retried on the next step


def _step_fakes(monkeypatch, q, fast=()):
    monkeypatch.setattr(worker, "_explain_queue", q)
    monkeypatch.setattr(worker, "fast_topics", lambda conn: list(fast))
    monkeypatch.setattr(worker, "process_injects", lambda *a: 0)
    monkeypatch.setattr(worker, "_ensure_schema_once", lambda conn: None)
    monkeypatch.setattr(worker.store, "delete_findings_except", lambda conn, keep: None)
    monkeypatch.setattr(worker.store, "prune_frames", lambda conn, h: 0)


def test_explanation_arriving_during_the_full_pass_is_re_stored_next_step(monkeypatch):
    q = worker.ExplainQueue()
    _step_fakes(monkeypatch, q)
    monkeypatch.setenv("TOPICS", "T,U")
    f = _coordinated(topic="T")
    runs = []

    def detect_topic(conn, topic, detector, hours, alphas=(), scanner=None):
        runs.append((topic, tuple(alphas)))
        if topic == "U":  # T's explanation lands while the pass is still on U
            q.done(f, ok=True)

    monkeypatch.setattr(worker, "detect_topic", detect_topic)
    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6)
    worker.step(FakeConn(), st, now=0.0)  # full pass
    assert runs == [("T", ()), ("U", ())]
    runs.clear()
    worker.step(FakeConn(), st, now=10.0)  # no full pass: T is re-stored with its new explanation
    assert runs == [("T", ())]


def test_alpha_point_jobs_are_wanted_and_never_evict_the_design_job(monkeypatch):
    import ingest.explain as ex

    a = _coordinated(accounts=("x", "y", "z"))  # coordinated at the design alpha
    b = _coordinated(accounts=("p", "q", "r"))  # coordinated only at the loose point
    c = _coordinated(accounts=("x", "y", "z", "w"))  # a's swarm, bigger at the loose point
    q = worker.ExplainQueue()
    monkeypatch.setattr(worker, "_explain_queue", q)
    monkeypatch.setattr(worker.store, "window_items", lambda conn, t, h: ["item"])
    monkeypatch.setattr(worker.store, "get_items", lambda conn, ids: [])
    monkeypatch.setattr(worker.store, "load_findings", lambda conn, t: [])
    monkeypatch.setattr(worker.store, "replace_findings", lambda conn, t, fs: None)
    monkeypatch.setattr(worker.store, "replace_findings_alpha", lambda conn, t, al, fs: None)
    monkeypatch.setattr(worker.store, "ensure_schema", lambda conn: None)
    monkeypatch.setattr(ex, "cached_explanation", lambda f, posts: None)

    def detector(items, alpha=0.02):
        return [a] if alpha == 0.02 else [b, c]

    worker.detect_topic(FakeConn(), "t", detector, 6, alphas=(0.1,))
    taken = [q.take(timeout=0)[0].id for _ in range(2)]
    assert taken == [a.id, b.id] and q.take(timeout=0) is None  # design first; c did not replace a
    q.done(a, ok=False)
    q.done(b, ok=True)
    assert q.take_dirty_split() == ({"t"}, {"t"})  # an alpha-point explanation: re-store with the points

    # two campaigns on one topic at the design alpha: both explained
    d = _coordinated(accounts=("k", "l", "m"))
    worker.detect_topic(FakeConn(), "t", lambda items, alpha=0.02: [a, d] if alpha == 0.02 else [], 6)
    assert {q.take(timeout=0)[0].id for _ in range(2)} == {a.id, d.id}


def test_full_pass_that_scanned_the_fast_topics_restarts_their_interval(monkeypatch):
    _step_fakes(monkeypatch, None, fast=["a"])
    monkeypatch.setenv("TOPICS", "a")
    runs = []
    monkeypatch.setattr(worker, "detect_topic", lambda conn, topic, *a: runs.append(topic))
    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6, scan_interval=10)
    worker.step(FakeConn(), st, now=0.0)
    st.polled.set()
    worker.step(FakeConn(), st, now=5.0)  # ingest finished: full pass, "a" scanned with its frame
    assert st.next_fast == 15.0
    runs.clear()
    worker.step(FakeConn(), st, now=10.0)
    assert runs == []  # no second frame 5 s after the one of the full pass


def test_ingest_cycle_warms_each_topic_before_its_items_become_visible(monkeypatch):
    from datetime import datetime, timezone

    from contracts.models import Item

    ev = []

    class Conn(FakeConn):
        broken = closed = False

        def commit(self):
            ev.append("commit")

    def fetch(sources, topic, sinces):
        return [Item(id=topic, source="context_news", author="x.com", published_at=datetime.now(timezone.utc),
                     text=f"text {topic}", topic=topic)]

    def warm(texts):
        ev.append(f"warm {texts[0]}")
        raise RuntimeError("Gemini down")  # must not block the upsert

    monkeypatch.setenv("TOPICS", "a,b")
    monkeypatch.setattr(worker, "active_sources", lambda window_h: [worker.Source("news", lambda conn, t, now: None, lambda t, since: [])])
    monkeypatch.setattr(worker, "fetch_topic", fetch)
    monkeypatch.setattr(worker.store, "upsert_items", lambda conn, items: ev.append(f"upsert {items[0].topic}") or 1)
    monkeypatch.setattr(worker.store, "set_last_poll", lambda conn: ev.append("last_poll"))
    import detect.embed

    monkeypatch.setattr(detect.embed, "embed_with_backend", warm)
    assert [it.id for it in worker.ingest_cycle(Conn())] == ["a", "b"]
    assert ev == ["warm text a", "upsert a", "commit", "warm text b", "upsert b", "commit", "last_poll"]


def test_attack_texts_of_monitored_topics_are_warmed_once(monkeypatch):
    warmed = []
    monkeypatch.setattr(worker, "warm_embeddings", lambda items: warmed.extend(it.text for it in items))
    monkeypatch.setenv("TOPICS", "helsinki-tram-fares,no-variations-here")
    from synth.variations import load_variations

    want = {v for m in load_variations("helsinki-tram-fares").messages for v in m.variations}
    assert worker.warm_attack_texts() == len(warmed) > 0 and set(warmed) == want
    monkeypatch.setenv("TOPICS", "")
    warmed.clear()
    assert worker.warm_attack_texts() == 0 and warmed == []


def test_attack_topic_stays_fast_a_little_past_its_ttl(monkeypatch):
    seen = {}
    monkeypatch.setattr(worker.store, "scanned_topics", lambda conn, stale: set())
    monkeypatch.setattr(worker.store, "active_attack_topics", lambda conn, ttl: seen.setdefault("ttl", ttl) and {"a"})
    monkeypatch.setenv("TOPICS", "a")
    assert worker.fast_topics(FakeConn()) == ["a"]
    assert seen["ttl"] == worker._synthetic_ttl() + worker.ATTACK_TAIL_SEC
