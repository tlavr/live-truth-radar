"""Ingest/detect worker (P1).

T4: heartbeat stub. T8: detect loop on the DB and inject handling. T6: Context.dev polling in
`ingest_cycle()` (news search + Reddit search -> on-topic Items -> items/actors, then last_poll_at).

Loop:
  * every INJECT_CHECK_SEC (~10 s): pending inject_requests -> detect() on that topic -> findings;
  * every POLL_INTERVAL_SEC: ingest_cycle(), then detect() on every topic.
Detector: detect.pipeline.detect (I1; the mock detector is no longer on the worker path).

Run: python -m ingest.worker
"""

from __future__ import annotations

import logging
import math
import os
import signal
import threading
import time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
import psycopg

from contracts.models import Finding, Item
from ingest import store
from ingest.contextdev import (
    ContextDevClient,
    ContextDevError,
    news_to_items,
    on_topic,
    reddit_to_items,
    topic_query,
)

log = logging.getLogger("ltr.worker")

INJECT_CHECK_SEC = 10
NEWS_OVERLAP = timedelta(minutes=15)

Detector = Callable[[list[Item]], list[Finding]]


def _positive(name: str, default: float) -> float:
    raw = os.environ.get(name) or ""
    try:
        value = float(raw)
    except ValueError:
        return default
    # bad config (<= 0, nan, inf, absurdly large) must not spin, stall or crash-loop
    return value if math.isfinite(value) and 0 < value <= 1e6 else default


def topics() -> list[str]:
    """Topics from TOPICS (comma-separated)."""
    return [t.strip() for t in (os.environ.get("TOPICS") or "").split(",") if t.strip()]


def load_detector() -> Detector:
    """The real detector (I1). LTR_DETECTOR is obsolete: any value other than "real" is only warned about."""
    name = (os.environ.get("LTR_DETECTOR") or "real").strip().lower()
    if name != "real":
        log.warning("LTR_DETECTOR=%r is no longer supported; using detect.pipeline", name)
    from detect.pipeline import detect

    # live run: pass the wall clock so injected campaigns expire (synthetic_ttl_sec, ~10 min after the click)
    return lambda items: detect(items, now=datetime.now(timezone.utc))


def _needs_explanation(f: Finding) -> bool:
    return f.verdict == "coordinated" and f.explanation is None


def _with_explanation(f: Finding, posts: list[Item]) -> Finding:
    """T11: coordinated findings get an LLM explanation (cached by id); never fails the detect step."""
    from ingest.explain import explain_safe

    exp = explain_safe(f, posts)
    return f if exp is None else f.model_copy(update={"explanation": exp})


def detect_topic(conn, topic: str, detector: Detector, window_hours: float) -> int:
    """Run the detector on the topic window and replace its findings; returns the number of findings."""
    items = store.window_items(conn, topic, window_hours)
    findings = detector(items)  # detect.pipeline.detect([]) == []
    posts = {f.id: store.get_items(conn, f.item_ids) for f in findings if _needs_explanation(f)}
    if posts:
        conn.commit()  # end the read-only transaction: no idle-in-transaction during slow LLM calls
        findings = [_with_explanation(f, posts[f.id]) if f.id in posts else f for f in findings]
    # a detector may return findings of other topics: store each under its own topic
    by_topic: dict[str, list[Finding]] = defaultdict(list)
    for f in findings:
        by_topic[f.topic].append(f)
    store.replace_findings(conn, topic, by_topic.pop(topic, []))
    for other, group in by_topic.items():
        store.replace_findings(conn, other, group)
    return len(findings)


def _guarded(conn, what: str, fn: Callable, *args) -> bool:
    """Run one unit of work and commit it; on failure log, roll back and carry on with the next unit."""
    try:
        fn(*args)
        conn.commit()
        return True
    except Exception:  # one bad topic / detector error / ingest error must not stall the others
        log.exception("%s failed", what)
        conn.rollback()
        return False


def process_injects(conn, detector: Detector, window_hours: float) -> int:
    """Handle pending inject requests: one detect() per topic, then mark them processed.

    A failed topic is marked processed too (and logged): otherwise /api/inject answers 429 forever.
    """
    pending = store.pending_injects(conn)
    if not pending:
        return 0
    for topic in dict.fromkeys(r["topic"] for r in pending):
        if not _guarded(conn, f"inject detect on {topic}", detect_topic, conn, topic, detector, window_hours):
            log.error("inject on %s: detect failed; requests marked processed", topic)
    store.mark_injects_processed(conn, [r["id"] for r in pending])
    conn.commit()
    return len(pending)


_client: ContextDevClient | None = None


def _get_client() -> ContextDevClient | None:
    global _client
    if _client is None and os.environ.get("CONTEXT_DEV_API_KEY"):
        # cache shorter than the poll interval: every cycle asks for fresh data, retries within a cycle are free
        ttl = max(30.0, _positive("POLL_INTERVAL_SEC", 300) - 30)
        _client = ContextDevClient(os.environ["CONTEXT_DEV_API_KEY"], cache_ttl_sec=ttl)
    return _client


def news_since(now: datetime, window_h: float, latest: datetime | None) -> datetime:
    """Lower bound for the news query: the detector window, or just before the newest stored article.
    News search is relevance-ranked with a result cap, so asking for the whole window every cycle would return
    the same top-N forever. `latest` is capped at now: one future-dated row cannot stall polling.
    Trade-off: an article indexed later than NEWS_OVERLAP after its published_at can be missed."""
    since = now - timedelta(hours=window_h)
    if latest is not None:
        since = max(since, min(latest, now) - NEWS_OVERLAP)
    return since


def reddit_enabled() -> bool:
    """REDDIT_ENABLED=1/true/yes turns the reddit-search source on (default off)."""
    return (os.environ.get("REDDIT_ENABLED") or "").strip().lower() in ("1", "true", "yes", "on")


def fetch_topic(client: ContextDevClient, topic: str, since: datetime) -> list[Item] | None:
    """All sources for one topic, on-topic items only; None if every source failed."""
    query = topic_query(topic)
    items: list[Item] = []
    ok = False
    sources = [("news", lambda: client.news_search(query, since=since), news_to_items)]
    if reddit_enabled():  # off by default: reddit-search fails (WEBSITE_ACCESS_ERROR) and costs rate-limit units
        sources.append(("reddit", lambda: client.reddit_search(query), reddit_to_items))
    for name, call, norm in sources:
        try:
            got = norm(call(), topic)
        except (ContextDevError, httpx.HTTPError, ValueError, OSError) as e:  # API, network, bad JSON, cache I/O
            log.warning("topic=%s source=%s failed: %s", topic, name, e)
            continue
        except Exception:  # one bad response must not stop the other source or topics
            log.exception("topic=%s source=%s unexpected error", topic, name)
            continue
        ok = True
        kept = [it for it in got if on_topic(it.text, topic)]
        log.info("topic=%s source=%s items=%d on_topic=%d", topic, name, len(got), len(kept))
        items += kept
    return items if ok else None


def ingest_cycle(conn) -> None:
    """Poll Context.dev for every topic and upsert its items (one commit per topic: a bad topic is rolled
    back alone), then store.set_last_poll if at least one topic was fetched.
    A lost (broken/closed) connection propagates."""
    client = _get_client()
    if client is None:
        log.warning("CONTEXT_DEV_API_KEY is empty: no ingest")
        return
    window_h = _positive("DETECT_WINDOW_HOURS", 6)
    any_ok = False
    for topic in topics():
        try:
            now = datetime.now(timezone.utc)
            since = news_since(now, window_h, store.latest_published(conn, topic, "context_news"))
            items = fetch_topic(client, topic, since)
            if items is None:
                conn.rollback()  # ends the read transaction opened by latest_published
                continue
            new = store.upsert_items(conn, items)
            conn.commit()
            any_ok = True
            log.info("topic=%s new_items=%d", topic, new)
        except psycopg.OperationalError:
            if conn.broken or conn.closed:
                raise  # connection lost: main() reconnects
            log.exception("ingest of %s failed", topic)  # timeout, deadlock, ...: connection still usable
            conn.rollback()
        except Exception:  # bad row (NUL, encoding), constraint, ...: skip this topic only
            log.exception("ingest of %s failed", topic)
            conn.rollback()
    if any_ok:
        store.set_last_poll(conn)


@dataclass
class LoopState:
    detector: Detector
    interval: float
    window_hours: float
    next_poll: float = 0.0


def tick(conn, st: LoopState, now: float) -> None:
    """One worker iteration (~every INJECT_CHECK_SEC); each topic and the injects fail independently."""
    if now >= st.next_poll:
        st.next_poll = now + st.interval  # set first: a failing cycle must not rerun (and burn quota) every tick
        if topics():  # findings of topics dropped from TOPICS are never recomputed: remove them
            _guarded(conn, "stale findings cleanup", store.delete_findings_except, conn, topics())
        _guarded(conn, "ingest cycle", ingest_cycle, conn)
        for topic in topics():
            _guarded(conn, f"detect on {topic}", detect_topic, conn, topic, st.detector, st.window_hours)
    _guarded(conn, "inject processing", process_injects, conn, st.detector, st.window_hours)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    st = LoopState(load_detector(), _positive("POLL_INTERVAL_SEC", 300), _positive("DETECT_WINDOW_HOURS", 6))
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    log.info("worker started: detector=real interval=%ss window=%sh topics=%s",
             st.interval, st.window_hours, topics() or "(none)")

    while not stop.is_set():
        try:
            with store.connect() as conn:
                tick(conn, st, time.monotonic())
        except Exception:  # keep the worker alive: DB down
            log.exception("worker cycle failed; retrying in %ss", INJECT_CHECK_SEC)
        stop.wait(INJECT_CHECK_SEC)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
