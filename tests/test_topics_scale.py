"""50 topics: per-topic news schedule, fast frames during a long full pass, window cap, topic table (offline)."""

import re
from datetime import datetime, timedelta, timezone

from contracts.models import Finding, Item
from ingest import store, worker
from ingest.bluesky import BSKY_QUERIES
from ingest.contextdev import TOPIC_SPECS, on_topic, topic_query


class FakeConn:
    broken = closed = False

    def __init__(self):
        self.commits = 0

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


def _sched(**kw):
    args = dict(hot_sec=300, background_sec=7200, alarm_sec=600, max_per_cycle=2)
    args.update(kw)
    return worker.NewsSchedule(**args)


def test_background_news_is_capped_per_cycle_and_spread_over_the_cycles():
    s = _sched()
    topics = ["a", "b", "c", "d", "e"]
    seen = []
    for k in range(3):  # 3 cycles 5 min apart: 2 + 2 + 1, nobody twice
        now = 300.0 * k
        due = s.due(topics, now)
        assert len(due) <= 2
        for t in due:
            s.mark(t, now)
        seen += due
    assert sorted(seen) == topics
    assert s.due(topics, 900.0) == []  # nothing until background_sec has passed
    assert s.due(topics, 7200.0) == ["a", "b"]  # the longest-waiting first
    assert s.due(topics, 7500.0) == ["a", "b"]  # not marked: still due (a failed cycle is retried)


def test_selected_topic_gets_news_every_poll_and_is_not_counted_as_background():
    s = _sched(max_per_cycle=1)
    s.set_hot(["x"])
    assert s.urgent(0.0) == ["x"]  # just opened: fetched by the next urgent check
    s.mark("x", 0.0)
    assert s.urgent(100.0) == []
    assert s.due(["x", "y", "z"], 100.0) == ["y"]  # the hot topic does not take a background slot
    assert s.urgent(300.0) == ["x"]
    assert s.due(["x", "y"], 300.0) == ["x", "y"]  # due hot topics come with the full cycle too
    s.set_hot([])
    s.mark("x", 300.0)
    assert s.urgent(600.0) == []  # closed: back to the background interval


def test_alarm_fetches_news_once_per_alarm_interval():
    s = _sched()
    s.mark("t", 0.0)
    s.alarm("t")
    assert s.urgent(100.0) == []  # news fetched 100 s ago: the article is already in, alarm dropped
    s.alarm("t")
    assert s.urgent(700.0) == ["t"]
    s.mark("t", 700.0)
    assert s.urgent(710.0) == []  # mark clears the alarm
    s.alarm("u")
    s.mark("u", 0.0)  # fetched before any urgent check saw the alarm
    assert s.urgent(600.0) == []  # mark cleared it: not urgent again an alarm_sec later


def test_hot_topic_never_takes_a_background_slot_even_when_background_is_shorter():
    s = _sched(hot_sec=300, background_sec=100)
    s.set_hot(["x"])
    s.mark("x", 0.0)
    assert s.urgent(200.0) == []  # hot interval not up yet
    assert s.due(["x", "y"], 200.0) == ["y"]  # not fetched through the background part either


def _sources(calls):
    def src(name, whole=False):
        def fetch(topic, since):
            calls.append((name, topic))
            return [Item(id=f"{name}-{topic}", source="context_news" if name == "news" else "context_social",
                         author="a", published_at=datetime(2026, 11, 14, tzinfo=timezone.utc), text="x", topic=topic)]
        return worker.Source(name, lambda conn, t, now: None, fetch, whole_text=whole)
    return [src("news"), src("bluesky", True)]


def _cycle_fakes(monkeypatch, calls, polls):
    monkeypatch.setattr(worker, "active_sources", lambda window_h: _sources(calls))
    monkeypatch.setattr(worker, "on_topic", lambda text, topic, whole=False: True)
    monkeypatch.setattr(worker, "warm_embeddings", lambda items, since=None: None)
    monkeypatch.setattr(worker.store, "upsert_items", lambda conn, items: len(items))
    monkeypatch.setattr(worker.store, "set_last_poll", lambda conn: polls.append(1))
    monkeypatch.setenv("TOPICS", "a,b,c")


def test_full_cycle_polls_bluesky_for_every_topic_and_news_only_where_due(monkeypatch):
    calls, polls = [], []
    _cycle_fakes(monkeypatch, calls, polls)
    s = _sched(max_per_cycle=1)
    worker.ingest_cycle(FakeConn(), s)
    assert [t for n, t in calls if n == "bluesky"] == ["a", "b", "c"]
    assert [t for n, t in calls if n == "news"] == ["a"]
    assert polls == [1] and s.take_fresh() == set()  # a full cycle wakes the whole detect pass instead
    calls.clear()
    worker.ingest_cycle(FakeConn(), s)  # right after: "a" was marked, the next background topic is fetched
    assert [t for n, t in calls if n == "news"] == ["b"]
    calls.clear()
    worker.ingest_cycle(FakeConn())  # no schedule (tests, old behaviour): news for every topic
    assert [t for n, t in calls if n == "news"] == ["a", "b", "c"]


def test_urgent_cycle_fetches_news_only_and_hands_the_topics_to_the_detect_loop(monkeypatch):
    calls, polls = [], []
    _cycle_fakes(monkeypatch, calls, polls)
    s = _sched()
    s.set_hot(["b"])  # hot: urgent until its news fetch is marked
    assert s.urgent(0.0) == ["b"]
    worker.ingest_cycle(FakeConn(), s, only=["b"])
    assert calls == [("news", "b")] and polls == []
    assert s.take_fresh() == {"b"} and s.urgent(1.0) == []  # marked: not fetched again at the next check


def _step_fakes(monkeypatch, fast):
    monkeypatch.setattr(worker, "_explain_queue", None)
    monkeypatch.setattr(worker, "fast_topics", lambda conn: list(fast))
    monkeypatch.setattr(worker, "process_injects", lambda *a: 0)
    monkeypatch.setattr(worker, "_ensure_schema_once", lambda conn: None)
    monkeypatch.setattr(worker.store, "delete_findings_except", lambda conn, keep: None)
    monkeypatch.setattr(worker.store, "prune_frames", lambda conn, h: 0)


def test_long_full_pass_keeps_the_fast_frames_coming(monkeypatch):
    _step_fakes(monkeypatch, fast=["f"])
    monkeypatch.setenv("TOPICS", ",".join(["f"] + [f"t{k}" for k in range(10)]))
    clock = [0.0]
    runs = []

    def detect_topic(conn, topic, detector, hours, alphas=(), scanner=None):
        runs.append((topic, scanner is not None))
        clock[0] += 4.0  # every topic takes 4 s

    monkeypatch.setattr(worker, "detect_topic", detect_topic)
    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6, scan_interval=10,
                          scanner=lambda items, topic: ([], []), clock=lambda: clock[0])
    worker.step(FakeConn(), st, now=0.0)
    assert runs[0] == ("f", True)  # the fast topic first
    frames = [k for k, (t, scanned) in enumerate(runs) if t == "f"]
    assert len(frames) >= 4  # ~44 s pass: a frame every ~10 s, not one at the end
    assert all(scanned for t, scanned in runs if t == "f")
    assert {t for t, _ in runs} == {"f"} | {f"t{k}" for k in range(10)}


def test_step_reports_hot_topics_and_re_runs_freshly_fetched_ones(monkeypatch):
    _step_fakes(monkeypatch, fast=["h"])
    monkeypatch.setenv("TOPICS", "h,x")
    s = _sched()
    monkeypatch.setattr(worker, "_news", s)
    runs = []
    monkeypatch.setattr(worker, "detect_topic",
                        lambda conn, topic, detector, hours, alphas=(), scanner=None: runs.append((topic, alphas)))
    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6, alphas=(0.05,), next_poll=1e9,
                          next_fast=1e9)
    s.add_fresh(["x"])
    worker.step(FakeConn(), st, now=0.0)
    assert s.urgent(0.0) == ["h"]  # the open topic is hot now
    assert runs == [("x", (0.05,))]  # fresh news: re-run with the slider points, not a whole pass


def test_real_coordinated_alert_raises_a_news_alarm_synthetic_does_not(monkeypatch):
    s = _sched()
    monkeypatch.setattr(worker, "_news", s)
    monkeypatch.setattr(worker, "_explain_queue", None)
    monkeypatch.setattr(worker, "_explained", lambda conn, fs, design=True: fs)
    monkeypatch.setattr(worker.store, "window_items", lambda conn, t, h: [])
    monkeypatch.setattr(worker.store, "replace_findings", lambda conn, t, fs: None)

    from tests.test_worker import _coordinated

    def finding(topic, synthetic):
        return _coordinated(topic=topic).model_copy(update={"synthetic": synthetic})

    s.mark("real", 0.0)
    s.mark("fake", 0.0)
    worker.detect_topic(FakeConn(), "real", lambda items: [finding("real", False)], 6)
    worker.detect_topic(FakeConn(), "fake", lambda items: [finding("fake", True)], 6)
    assert s.urgent(1000.0) == ["real"]


def test_window_cap_is_bound_as_a_parameter(monkeypatch):
    seen = {}

    class Cur:
        def fetchall(self):
            return [{"id": "old"}, {"id": "new"}]

    class Conn:
        def execute(self, sql, params):
            seen["sql"], seen["params"] = sql, params
            return Cur()

    monkeypatch.setattr(store, "_item", lambda r: r["id"])
    monkeypatch.delenv("WINDOW_MAX_ITEMS", raising=False)
    assert store.window_items(Conn(), "t", 6) == ["old", "new"]
    assert "LIMIT %s" in seen["sql"] and "800" not in seen["sql"] and seen["params"][-1] == 800
    assert seen["sql"].count("%s") == len(seen["params"]) == 7
    monkeypatch.setenv("WINDOW_MAX_ITEMS", "0")
    store.window_items(Conn(), "t", 6)
    assert "LIMIT" not in seen["sql"] and len(seen["params"]) == 3
    monkeypatch.setenv("WINDOW_MAX_ITEMS", "junk")
    assert store.window_max_items() == 800


def test_topic_table_is_consistent():
    assert len(TOPIC_SPECS) >= 50
    assert set(BSKY_QUERIES) == set(TOPIC_SPECS)  # every topic has a short Bluesky query
    for slug, (query, groups) in TOPIC_SPECS.items():
        assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", slug), slug
        assert groups and all(groups), slug
        assert on_topic(topic_query(slug), slug), slug  # the news query passes its own keyword gate


def test_only_posts_of_the_detector_window_are_warmed(monkeypatch):
    from datetime import timedelta

    now = datetime.now(timezone.utc)
    items = [Item(id=i, source="context_social", author="a", published_at=now - timedelta(hours=h), text=i, topic="a")
             for i, h in (("fresh", 1), ("backfill", 30))]
    warmed, stored = [], []
    monkeypatch.setenv("TOPICS", "a")
    monkeypatch.setenv("DETECT_WINDOW_HOURS", "6")
    monkeypatch.setattr(worker, "active_sources", lambda window_h: _sources([]))
    monkeypatch.setattr(worker, "fetch_topic", lambda sources, topic, sinces: items)
    import detect.embed

    monkeypatch.setattr(detect.embed, "embed_with_backend", lambda texts: warmed.extend(texts))
    monkeypatch.setattr(worker.store, "upsert_items", lambda conn, its: stored.extend(it.id for it in its) or 0)
    monkeypatch.setattr(worker.store, "set_last_poll", lambda conn: None)
    worker.ingest_cycle(FakeConn())
    assert warmed == ["fresh"] and stored == ["fresh", "backfill"]  # the backfill is stored, embedded by eval later


class _SqliteConn:
    """window_items' SQL on an in-memory sqlite table (psycopg %s -> ?, datetimes as ISO text)."""

    def __init__(self, rows):
        import sqlite3

        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE items (id text PRIMARY KEY, source text, platform text, author text, "
                        "published_at text, text text, url text, topic text, synthetic boolean, campaign_id text)")
        for id_, source, minutes_ago, synthetic in rows:
            self.db.execute("INSERT INTO items VALUES (?, ?, NULL, 'a', ?, 'x', NULL, 't', ?, NULL)",
                            (id_, source, (self.now - timedelta(minutes=minutes_ago)).isoformat(), synthetic))

    now = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)

    def execute(self, sql, params):
        params = [p.isoformat() if isinstance(p, datetime) else p for p in params]
        return self.db.execute(sql.replace("%s", "?"), params)


def test_window_cap_keeps_every_news_and_synthetic_row_and_caps_social_posts_only(monkeypatch):
    rows = [("news-old", "context_news", 50, False), ("syn-old", "synthetic", 40, True),
            ("syn-social", "context_social", 45, True)]
    rows += [(f"p{k:02d}", "context_social", 30 - k, False) for k in range(10)]  # p09 is the newest post
    conn = _SqliteConn(rows)
    monkeypatch.setattr(store, "_item", lambda r: r["id"])
    monkeypatch.setenv("WINDOW_MAX_ITEMS", "3")
    got = store.window_items(conn, "t", 6, now=conn.now)
    assert got == ["news-old", "syn-social", "syn-old", "p07", "p08", "p09"]  # time order, old news kept
    monkeypatch.setenv("WINDOW_MAX_ITEMS", "0")
    assert len(store.window_items(conn, "t", 6, now=conn.now)) == len(rows)


def _timed_pass(monkeypatch, fast_at):
    """A full pass over f + t0..t9, 4 s per detect; fast_topics() answers fast_at(clock)."""
    monkeypatch.setattr(worker, "_explain_queue", None)
    monkeypatch.setattr(worker, "process_injects", lambda *a: 0)
    monkeypatch.setattr(worker, "_ensure_schema_once", lambda conn: None)
    monkeypatch.setattr(worker.store, "delete_findings_except", lambda conn, keep: None)
    monkeypatch.setattr(worker.store, "prune_frames", lambda conn, h: 0)
    monkeypatch.setenv("TOPICS", ",".join(["f"] + [f"t{k}" for k in range(10)]))
    clock = [0.0]
    runs = []
    monkeypatch.setattr(worker, "fast_topics", lambda conn: fast_at(clock[0]))

    def detect_topic(conn, topic, detector, hours, alphas=(), scanner=None):
        runs.append((clock[0], topic, scanner is not None))
        clock[0] += 4.0

    monkeypatch.setattr(worker, "detect_topic", detect_topic)
    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6, scan_interval=10,
                          scanner=lambda items, topic: ([], []), clock=lambda: clock[0])
    return st, runs


def test_topic_opened_mid_pass_gets_hot_news_and_frames_before_the_pass_ends(monkeypatch):
    s = _sched()
    monkeypatch.setattr(worker, "_news", s)
    st, runs = _timed_pass(monkeypatch, lambda t: ["f"] if t >= 8 else [])
    worker.step(FakeConn(), st, now=0.0)
    end = runs[-1][0] + 4.0
    frames = [t for t, topic, scanned in runs if topic == "f" and scanned]
    assert frames and frames[0] < end - 10  # framed during the pass, not only at its end
    assert s.urgent(end) == ["f"]  # its news is fetched by the next urgent check


def test_interleaved_frames_set_the_next_frame_from_their_start(monkeypatch):
    st, runs = _timed_pass(monkeypatch, lambda t: ["f"])
    worker.step(FakeConn(), st, now=0.0)  # next_fast = 0: "f" is also due at the start
    last_frame = max(t for t, topic, scanned in runs if topic == "f" and scanned)
    assert st.next_fast == last_frame + 10  # not regressed to now + scan_interval
    st, runs = _timed_pass(monkeypatch, lambda t: ["f"])
    wait = worker.step(FakeConn(), st, now=0.0)
    assert wait == st.next_fast - (runs[-1][0] + 4.0)  # counted from the end of the pass


def test_no_urgent_cycles_without_a_paid_source(monkeypatch):
    import contextlib

    s = _sched()
    s.set_hot(["h"])
    monkeypatch.setattr(worker, "_news", s)
    monkeypatch.setattr(worker, "warm_attack_texts", lambda: 0)
    monkeypatch.setattr(worker.store, "connect", lambda: contextlib.nullcontext(FakeConn()))
    cycles = []
    monkeypatch.setattr(worker, "ingest_cycle", lambda conn, news, only=None: cycles.append(only))

    class Stop:
        n = 0

        def is_set(self):
            return self.n >= 5

        def wait(self, sec):
            self.n += 1

    st = worker.LoopState(detector=lambda items: [], interval=300, window_hours=6)
    monkeypatch.setattr(worker, "_get_client", lambda: None)
    worker.ingest_loop(Stop(), st)
    assert cycles == [None]  # the full cycle only: no news source, nothing to fetch urgently
    cycles.clear()
    monkeypatch.setattr(worker, "_get_client", lambda: object())
    worker.ingest_loop(Stop(), st)
    assert cycles[:2] == [None, ["h"]]


GATE_CASES = [  # (topic, headline, passes the keyword gate)
    ("deportations", "Real Madrid beat Deportivo 3-1", False),
    ("deportations", "Judge halts deportations to Sudan", True),
    ("deportations", "Migrants deported overnight", True),
    ("musk", "Colonial musket found in a barn", False),
    ("musk", "Musk's xAI raises funds", True),
    ("bitcoin-crypto", "New cryptographic standard for TLS", False),
    ("bitcoin-crypto", "Crypto market slides", True),
    ("bitcoin-crypto", "Cryptocurrency exchange hacked", True),
    ("poland-russia-border", "Polished floors and Russian dolls at the border fair", False),
    ("poland-russia-border", "Polish army reinforces the Russia border", True),
    ("turkey-qatar-defense-pact", "Military families get a free Thanksgiving turkey", False),
    ("turkey-qatar-defense-pact", "Turkey and Qatar sign a defense pact", True),
    ("midterm-vote-count", "Election in the country: county leader resigns", False),
    ("midterm-vote-count", "Midterm recount ordered in Arizona", True),
    ("midterm-vote-count", "Democrat leads as ballots are counted", True),
    ("sudan-war", "RSF condemns journalist arrests", False),
    ("sudan-war", "RSF fighters killed in Darfur clash", True),
    ("hormuz-tankers", "Oil tanker fire off the Texas coast", False),
    ("hormuz-tankers", "Tanker hit by a mine in the Strait of Hormuz", True),
    ("rfk-vaccines", "Kennedy Center gala raises funds for health charities", False),
    ("rfk-vaccines", "RFK Jr. changes the CDC vaccine panel", True),
    ("ice-overhaul", "Ice cream bill passes", False),
    ("ice-overhaul", "House votes to overhaul ICE detention", True),
    ("midterm-vote-count", "Japan election results called", False),
    ("midterm-vote-count", "Midterm results: Democrats lead in key House race", True),
    ("faa-ground-stop", "Airport outage in Manila", False),
    ("faa-ground-stop", "Air traffic control outage halts flights in the Northeast", True),
]


def test_keyword_gates_reject_look_alike_words():
    bad = [(t, h) for t, h, ok in GATE_CASES if on_topic(h, t) != ok]
    assert bad == []
