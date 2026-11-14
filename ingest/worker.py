"""Ingest/detect worker (P1).

T4: heartbeat stub. T8: detect loop on the DB and inject handling. T6 plugs Context.dev polling
into `ingest_cycle()` (and calls store.set_last_poll after a successful cycle).

Loop:
  * every INJECT_CHECK_SEC (~10 s): pending inject_requests -> detect() on that topic -> findings;
  * every POLL_INTERVAL_SEC: ingest_cycle(), then detect() on every topic.
Detector: LTR_DETECTOR = "mock" (default until I1: fixtures/findings.json) | "real" (detect.pipeline).

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
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import TypeAdapter

from contracts.models import Finding, Item
from ingest import store

log = logging.getLogger("ltr.worker")

INJECT_CHECK_SEC = 10
FIXTURE_ITEMS = Path(__file__).resolve().parent.parent / "fixtures" / "items.json"

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


def load_detector() -> tuple[str, Detector]:
    name = (os.environ.get("LTR_DETECTOR") or "mock").strip().lower()
    if name == "real":
        from detect.pipeline import detect
        return name, detect
    if name != "mock":
        log.warning("unknown LTR_DETECTOR=%r; using mock", name)
    from api.mock_detect import detect as mock_detect
    return "mock", mock_detect


def seed_fixtures(conn) -> list[str]:
    """Mock mode: load fixtures/items.json, so /api/items resolves the ids of fixtures/findings.json.

    Returns the fixture topics: the mock runs on them too, since their posts are older than the window.
    """
    items = TypeAdapter(list[Item]).validate_json(FIXTURE_ITEMS.read_text(encoding="utf-8"))
    store.upsert_items(conn, items)
    log.info("mock mode: %d fixture items loaded (existing ids kept)", len(items))
    return list(dict.fromkeys(it.topic for it in items))


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
    findings = detector(items)  # detect.pipeline.detect([]) == []; the mock ignores its input
    # posts by id, not from the window: mock findings point at fixture posts older than the window
    posts = {f.id: store.get_items(conn, f.item_ids) for f in findings if _needs_explanation(f)}
    if posts:
        conn.commit()  # end the read-only transaction: no idle-in-transaction during slow LLM calls
        findings = [_with_explanation(f, posts[f.id]) if f.id in posts else f for f in findings]
    # the mock ignores its input and may return other topics: store each under its own topic
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


def ingest_cycle(conn) -> None:
    """T6: poll Context.dev for every topic, upsert items, then store.set_last_poll(conn)."""


@dataclass
class LoopState:
    detector_name: str
    detector: Detector
    interval: float
    window_hours: float
    seeded: bool = False
    extra_topics: list[str] = field(default_factory=list)
    next_poll: float = 0.0


def tick(conn, st: LoopState, now: float) -> None:
    """One worker iteration (~every INJECT_CHECK_SEC); each topic and the injects fail independently."""
    if st.detector_name == "mock" and not st.seeded:
        st.extra_topics = seed_fixtures(conn)
        conn.commit()
        st.seeded = True
    if now >= st.next_poll:
        st.next_poll = now + st.interval  # set first: a failing cycle must not rerun (and burn quota) every tick
        _guarded(conn, "ingest cycle", ingest_cycle, conn)
        for topic in dict.fromkeys(topics() + st.extra_topics):
            _guarded(conn, f"detect on {topic}", detect_topic, conn, topic, st.detector, st.window_hours)
    _guarded(conn, "inject processing", process_injects, conn, st.detector, st.window_hours)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    detector_name, detector = load_detector()
    st = LoopState(detector_name, detector, _positive("POLL_INTERVAL_SEC", 180), _positive("DETECT_WINDOW_HOURS", 6))
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    log.info("worker started: detector=%s interval=%ss window=%sh topics=%s",
             detector_name, st.interval, st.window_hours, topics() or "(none)")

    while not stop.is_set():
        try:
            with store.connect() as conn:
                tick(conn, st, time.monotonic())
        except Exception:  # keep the worker alive: DB down, seeding failed
            log.exception("worker cycle failed; retrying in %ss", INJECT_CHECK_SEC)
        stop.wait(INJECT_CHECK_SEC)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
