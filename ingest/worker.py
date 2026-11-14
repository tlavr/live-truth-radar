"""Ingest/detect worker (P1).

T4: heartbeat stub. T8: detect loop on the DB and inject handling. T6: Context.dev polling in
`ingest_cycle()` (news search + Reddit search -> on-topic Items -> items/actors, then last_poll_at).
T6b: Bluesky searchPosts as a second source (BLUESKY_ENABLED, default on); every source has its own client
and lower bound, so one failing source (or a missing CONTEXT_DEV_API_KEY) never stops the others.

Threads (T12d), so a slow Context.dev or LLM call never freezes the radar:
  * ingest (`ingest_loop`, own DB connection): every POLL_INTERVAL_SEC ingest_cycle(), which warms the
    embedding cache for each topic's fetched texts before upserting them, then wakes the detect loop;
  * explain (`ExplainQueue.run`, no DB access): LLM explanations of coordinated findings -> cache/explanations/;
  * detect (main thread, `step`), the only writer of findings / findings_alpha: after every ingest (or at the
    latest every 2 x POLL_INTERVAL_SEC) detect() on every topic incl. the ALPHA_POINTS; every SCAN_INTERVAL_SEC
    on the fast topics (open scan sessions, running attacks) at the design alpha; topics whose explanation just
    arrived are re-stored; pending inject_requests every INJECT_CHECK_SEC.
Findings take explanations from the cache only; missing ones are queued, and a stored explanation is never
overwritten with None. Detector: detect.pipeline.detect (I1).

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
from datetime import datetime, timedelta, timezone

import httpx
import psycopg

from contracts.models import Finding, Item
from detect.operating import DEFAULT_ALPHA, SLIDER_ALPHAS
from ingest import radar, store
from ingest.bluesky import BlueskyClient, BlueskyError, bsky_query, posts_to_items
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
BLUESKY_BACKFILL = timedelta(hours=48)  # first poll of a topic: background for eval (T6b)
BLUESKY_BACKFILL_PAGES = 10
BLUESKY_PAGES = 3  # per topic and cycle afterwards

Detector = Callable[..., list[Finding]]  # detector(items) at the design alpha, detector(items, alpha=a)


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
    def run(items: list[Item], *, alpha: float = DEFAULT_ALPHA) -> list[Finding]:
        return detect(items, alpha=alpha, now=datetime.now(timezone.utc))

    return run


Scanner = Callable[[list[Item], str], tuple[list[Finding], list]]  # (items, topic) -> (findings, [RadarFrame])


def load_scanner() -> Scanner:
    """T12d: detect.pipeline.scan at the design alpha, one RadarFrame for the topic from the same run."""
    from detect.pipeline import scan

    def run(items: list[Item], topic: str):
        return scan(items, topics=[topic], now=datetime.now(timezone.utc), alpha=DEFAULT_ALPHA)

    return run


def alpha_points() -> tuple[float, ...]:
    """T12c: extra SPRT alphas computed besides the design one (ALPHA_POINTS, default the slider stops).

    Findings at the design alpha go to the findings table as before; each extra alpha to findings_alpha.
    Bad values are skipped; ALPHA_POINTS="" (set but empty) turns the extra points off.
    """
    raw = os.environ.get("ALPHA_POINTS")
    values = list(SLIDER_ALPHAS) if raw is None else []
    if raw is not None:
        for part in raw.split(","):
            try:
                a = float(part)
            except ValueError:
                continue
            if 0 < a < 1:
                values.append(a)
    return tuple(sorted({round(a, 6) for a in values} - {DEFAULT_ALPHA}))


def _needs_explanation(f: Finding) -> bool:
    return f.verdict == "coordinated" and f.explanation is None


def _with_explanation(f: Finding, posts: list[Item]) -> Finding:
    """T11: coordinated findings get an LLM explanation (cached by id); never fails the detect step."""
    from ingest.explain import explain_safe

    exp = explain_safe(f, posts)
    return f if exp is None else f.model_copy(update={"explanation": exp})


class ExplainQueue:
    """T12d: LLM explanations off the detect thread. Never touches the DB: jobs carry their posts.

    Per topic one pending job per swarm: a finding whose accounts overlap a pending one replaces it (a growing
    swarm changes its id every few frames), except that a slider-point job never replaces a design-alpha one;
    disjoint swarms (two campaigns, or a group found only at a slider point) each keep their job, at most
    MAX_PENDING_PER_TOPIC. Design-alpha jobs are taken first. Ids in flight or already queued are not queued
    again; a job whose id is no longer among the topic's latest findings (at any alpha) is dropped before the
    LLM call. Topics with a new explanation become "dirty": the detect loop re-stores them (with the slider
    points too if the finding is one of theirs) so the explanation reaches findings / findings_alpha.
    """

    MAX_PENDING_PER_TOPIC = 8

    def __init__(self, explain_fn: Callable[[Finding, list[Item]], object] | None = None):
        self._explain_fn = explain_fn
        self._cv = threading.Condition()
        self._pending: dict[str, dict[str, tuple[Finding, list[Item], bool]]] = {}  # topic -> id -> (f, posts, design)
        self._busy: set[str] = set()
        self._wanted: dict[tuple[str, float], set[str]] = {}  # (topic, alpha) -> ids of its latest findings
        self._dirty: set[str] = set()
        self._dirty_alpha: set[str] = set()  # dirty topics whose slider points need the explanation too
        self._stopped = False

    def submit(self, finding: Finding, posts: list[Item], design: bool = True) -> bool:
        with self._cv:
            jobs = self._pending.setdefault(finding.topic, {})
            if finding.id in self._busy:
                return False
            if finding.id in jobs:
                if design and not jobs[finding.id][2]:
                    jobs[finding.id] = (finding, posts, True)
                return False
            accounts = set(finding.accounts)
            same = [i for i, (f, _, d) in jobs.items() if accounts & set(f.accounts)]
            if not design and any(jobs[i][2] for i in same):
                return False  # the design job of this swarm goes first; this point is re-queued on the next pass
            for i in same:
                del jobs[i]
            jobs[finding.id] = (finding, posts, design)
            while len(jobs) > self.MAX_PENDING_PER_TOPIC:
                del jobs[next((i for i, j in jobs.items() if not j[2]), next(iter(jobs)))]
            self._cv.notify()
            return True

    def set_wanted(self, topic: str, ids: list[str], alpha: float = DEFAULT_ALPHA) -> None:
        with self._cv:
            self._wanted[(topic, alpha)] = set(ids)

    def _is_wanted(self, topic: str, fid: str) -> bool:
        sets = [ids for (t, _), ids in self._wanted.items() if t == topic]
        return not sets or any(fid in ids for ids in sets)

    def take(self, timeout: float) -> tuple[Finding, list[Item]] | None:
        """Next job still wanted (design-alpha jobs first), marked busy; None after `timeout` without one."""
        with self._cv:
            if not any(self._pending.values()) and not self._stopped:
                self._cv.wait(timeout)
            for design in (True, False):
                for topic, jobs in self._pending.items():
                    for fid in [i for i in jobs if not self._is_wanted(topic, i)]:
                        del jobs[fid]
                    fid = next((i for i, j in jobs.items() if j[2] == design), None)
                    if fid is not None:
                        f, posts, _ = jobs.pop(fid)
                        self._busy.add(fid)
                        return f, posts
            return None

    def done(self, finding: Finding, ok: bool) -> None:
        with self._cv:
            self._busy.discard(finding.id)
            if ok:
                self._dirty.add(finding.topic)
                if any(finding.id in ids for (t, a), ids in self._wanted.items()
                       if t == finding.topic and a != DEFAULT_ALPHA):
                    self._dirty_alpha.add(finding.topic)

    def take_dirty_split(self) -> tuple[set[str], set[str]]:
        """(dirty topics, those of them whose slider points need a re-store too)."""
        with self._cv:
            dirty, alpha = self._dirty, self._dirty_alpha
            self._dirty, self._dirty_alpha = set(), set()
            return dirty, alpha

    def take_dirty(self) -> set[str]:
        return self.take_dirty_split()[0]

    def mark_dirty(self, topic: str, alphas: bool = False) -> None:
        """Put a topic back (its re-store failed): retried on the next step."""
        with self._cv:
            self._dirty.add(topic)
            if alphas:
                self._dirty_alpha.add(topic)

    def stop(self) -> None:
        """Wake run() at once on shutdown."""
        with self._cv:
            self._stopped = True
            self._cv.notify_all()

    def run(self, stop: threading.Event) -> None:
        if self._explain_fn is None:
            from ingest.explain import explain_safe

            self._explain_fn = explain_safe
        while not stop.is_set() and not self._stopped:
            job = self.take(timeout=1.0)
            if job is None:
                continue
            f, posts = job
            ok = False
            try:
                ok = self._explain_fn(f, posts) is not None  # explain_safe caches the result on disk
            except Exception:  # keep the thread alive
                log.exception("explanation of %s failed", f.id)
            self.done(f, ok)


_explain_queue: ExplainQueue | None = None  # set by main(); None = synchronous LLM calls (tests, fallback)


def _explained(conn, findings: list[Finding], design: bool = True) -> list[Finding]:
    posts = {f.id: store.get_items(conn, f.item_ids) for f in findings if _needs_explanation(f)}
    if not posts:
        return findings
    queue = _explain_queue
    if queue is None:
        conn.commit()  # end the read-only transaction: no idle-in-transaction during slow LLM calls
        return [_with_explanation(f, posts[f.id]) if f.id in posts else f for f in findings]
    from ingest.explain import cached_explanation

    stored = {s.id: s.explanation for t in {f.topic for f in findings if f.id in posts}
              for s in store.load_findings(conn, t) if s.explanation is not None}
    conn.commit()
    out = []
    for f in findings:
        if f.id in posts:
            exp = cached_explanation(f, posts[f.id]) or stored.get(f.id)  # never overwrite with None
            if exp is None:
                queue.submit(f, posts[f.id], design)
            else:
                f = f.model_copy(update={"explanation": exp})
        out.append(f)
    return out


def detect_topic(conn, topic: str, detector: Detector, window_hours: float, alphas: tuple[float, ...] = (),
                 scanner: Scanner | None = None) -> int:
    """Run the detector on the topic window and replace its findings; returns the number of findings.

    scanner: T12d scanned or attacked topic: run detect.pipeline.scan instead (same findings at the design
    alpha) and also store its radar frame, in the same unit.

    alphas: extra SPRT alphas for the T12c slider, each stored in findings_alpha (explanations are
    cached by finding id, so a group found at several alphas costs one LLM call).
    """
    items = store.window_items(conn, topic, window_hours)
    frames: list = []
    if scanner is None:
        raw = detector(items)  # detect.pipeline.detect([]) == []
    else:
        raw, frames = scanner(items, topic)
    if _explain_queue is not None:
        _explain_queue.set_wanted(topic, [f.id for f in raw if f.topic == topic])
    findings = _explained(conn, raw)
    # a detector may return findings of other topics: store each under its own topic
    by_topic: dict[str, list[Finding]] = defaultdict(list)
    for f in findings:
        by_topic[f.topic].append(f)
    mine = by_topic.pop(topic, [])
    store.replace_findings(conn, topic, mine)
    for other, group in by_topic.items():
        store.replace_findings(conn, other, group)
    for fr in frames:
        if fr.topic == topic:
            store.add_frame(conn, fr.model_dump(mode="json"))
    conn.commit()  # the main findings never depend on the extra points below
    for alpha in alphas:  # each point is its own unit: a failure (e.g. no findings_alpha table) is logged only
        _guarded(conn, f"detect on {topic} at alpha={alpha}", _store_alpha, conn, topic, items, detector, alpha)
    return len(findings)


_schema_ready = False


def _store_alpha(conn, topic: str, items: list[Item], detector: Detector, alpha: float) -> None:
    global _schema_ready
    if not _schema_ready:  # creates findings_alpha on a DB volume that predates T12c; retried until it works
        store.ensure_schema(conn)
        _schema_ready = True
    raw = [f for f in detector(items, alpha=alpha) if f.topic == topic]
    if _explain_queue is not None:
        _explain_queue.set_wanted(topic, [f.id for f in raw], alpha)
    extra = _explained(conn, raw, design=False)
    store.replace_findings_alpha(conn, topic, alpha, extra)


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


def process_injects(conn, detector: Detector, window_hours: float, alphas: tuple[float, ...] = ()) -> int:
    """Handle pending inject requests: one detect() per topic, then mark them processed.

    A failed topic is marked processed too (and logged): otherwise /api/inject answers 429 forever.
    """
    pending = store.pending_injects(conn)
    if not pending:
        return 0
    for topic in dict.fromkeys(r["topic"] for r in pending):
        if not _guarded(conn, f"inject detect on {topic}", detect_topic, conn, topic, detector, window_hours,
                        alphas):
            log.error("inject on %s: detect failed; requests marked processed", topic)
    store.mark_injects_processed(conn, [r["id"] for r in pending])
    conn.commit()
    return len(pending)


_client: ContextDevClient | None = None
_bsky: BlueskyClient | None = None
# topics whose 48 h Bluesky backfill already ran in this process: a topic whose posts never pass the keyword gate
# stores nothing, and without this it would repeat the backfill every cycle
_bsky_backfilled: set[str] = set()


def _get_client() -> ContextDevClient | None:
    global _client
    if _client is None and os.environ.get("CONTEXT_DEV_API_KEY"):
        # cache shorter than the poll interval: every cycle asks for fresh data, retries within a cycle are free
        ttl = max(30.0, _positive("POLL_INTERVAL_SEC", 300) - 30)
        _client = ContextDevClient(os.environ["CONTEXT_DEV_API_KEY"], cache_ttl_sec=ttl)
    return _client


def _get_bluesky() -> BlueskyClient:
    global _bsky
    if _bsky is None:
        _bsky = BlueskyClient()
    return _bsky


def news_since(now: datetime, window_h: float, latest: datetime | None) -> datetime:
    """Lower bound for the news query: the detector window, or just before the newest stored article.
    News search is relevance-ranked with a result cap, so asking for the whole window every cycle would return
    the same top-N forever. `latest` is capped at now: one future-dated row cannot stall polling.
    Trade-off: an article indexed later than NEWS_OVERLAP after its published_at can be missed."""
    since = now - timedelta(hours=window_h)
    if latest is not None:
        since = max(since, min(latest, now) - NEWS_OVERLAP)
    return since


def _flag(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def reddit_enabled() -> bool:
    """REDDIT_ENABLED=1/true/yes turns the reddit-search source on (default off)."""
    return _flag("REDDIT_ENABLED", False)


def bluesky_enabled() -> bool:
    """BLUESKY_ENABLED=0/false/no/off turns the Bluesky source off (default on): quick fallback to news only."""
    return _flag("BLUESKY_ENABLED", True)


def bluesky_since(now: datetime, window_h: float, latest: datetime | None, backfilled: bool = False
                  ) -> datetime | None:
    """None on a topic's first poll (no Bluesky post stored yet, no backfill in this process): fetch_bluesky then
    backfills BLUESKY_BACKFILL. Later polls: like news_since, from the newest stored Bluesky post of the topic
    (the detector window if there is none)."""
    if latest is None and not backfilled:
        return None
    return news_since(now, window_h, latest)


def fetch_bluesky(client: BlueskyClient, topic: str, since: datetime | None, now: datetime | None = None
                  ) -> list[Item]:
    """searchPosts (newest first) -> Items. First poll: BLUESKY_BACKFILL back, up to BLUESKY_BACKFILL_PAGES pages
    (background for eval); then BLUESKY_PAGES per cycle. Posts beyond the page cap are skipped, not queued."""
    now = now or datetime.now(timezone.utc)
    backfill = since is None
    if backfill:
        since, pages = now - BLUESKY_BACKFILL, BLUESKY_BACKFILL_PAGES
    else:
        pages = BLUESKY_PAGES
    items = posts_to_items(client.search(bsky_query(topic), since, max_pages=pages), topic, now=now)
    if backfill:
        _bsky_backfilled.add(topic)  # only after a successful search: a failed backfill is retried next cycle
    return items


@dataclass(frozen=True)
class Source:
    """One ingest source with its own client and lower bound: `since(conn, topic, now)` reads the DB,
    `fetch(topic, since)` calls the API and normalizes. whole_text: the keyword gate checks the full text
    (social posts) instead of the headline (news)."""

    name: str
    since: Callable[[object, str, datetime], datetime | None]
    fetch: Callable[[str, datetime | None], list[Item]]
    whole_text: bool = False


def active_sources(window_h: float) -> list[Source]:
    """news (+ reddit) when CONTEXT_DEV_API_KEY is set; bluesky unless BLUESKY_ENABLED=0."""
    out: list[Source] = []
    client = _get_client()
    if client is None:
        log.warning("CONTEXT_DEV_API_KEY is empty: news source off")
    else:
        out.append(Source(
            "news",
            lambda conn, topic, now: news_since(now, window_h, store.latest_published(conn, topic, "context_news")),
            lambda topic, since: news_to_items(client.news_search(topic_query(topic), since=since), topic),
        ))
        if reddit_enabled():  # off by default: reddit-search fails (WEBSITE_ACCESS_ERROR) and costs rate-limit units
            out.append(Source(
                "reddit",
                lambda conn, topic, now: None,
                lambda topic, since: reddit_to_items(client.reddit_search(topic_query(topic)), topic),
            ))
    if bluesky_enabled():
        bsky = _get_bluesky()
        out.append(Source(
            "bluesky",
            # by platform, not by the whole context_social: Reddit posts must not move Bluesky's lower bound
            lambda conn, topic, now: bluesky_since(
                now, window_h, store.latest_published(conn, topic, "context_social", "bluesky"),
                topic in _bsky_backfilled),
            lambda topic, since: fetch_bluesky(bsky, topic, since),
            whole_text=True,
        ))
    return out


def fetch_topic(sources: list[Source], topic: str, sinces: dict[str, datetime | None]) -> list[Item] | None:
    """All sources for one topic, on-topic items only; None if every source failed (a failing source never
    drops the others' items)."""
    items: list[Item] = []
    ok = False
    for src in sources:
        try:
            got = src.fetch(topic, sinces.get(src.name))
        except (ContextDevError, BlueskyError, httpx.HTTPError, ValueError, OSError) as e:  # API, network, JSON, I/O
            log.warning("topic=%s source=%s failed: %s", topic, src.name, e)
            continue
        except Exception:  # one bad response must not stop the other sources or topics
            log.exception("topic=%s source=%s unexpected error", topic, src.name)
            continue
        ok = True
        kept = [it for it in got if on_topic(it.text, topic, whole=src.whole_text)]
        log.info("topic=%s source=%s items=%d on_topic=%d", topic, src.name, len(got), len(kept))
        items += kept
    return items if ok else None


def ingest_cycle(conn) -> list[Item]:
    """Poll every active source for every topic and upsert its items (one commit per topic: a bad topic is
    rolled back alone), then store.set_last_poll if at least one topic was fetched. Returns the fetched items.
    A lost (broken/closed) connection propagates."""
    window_h = _positive("DETECT_WINDOW_HOURS", 6)
    sources = active_sources(window_h)
    if not sources:
        log.warning("no ingest source (CONTEXT_DEV_API_KEY empty and BLUESKY_ENABLED=0)")
        return []
    any_ok = False
    fetched: list[Item] = []
    for topic in topics():
        try:
            now = datetime.now(timezone.utc)
            sinces = {src.name: src.since(conn, topic, now) for src in sources}
            items = fetch_topic(sources, topic, sinces)
            if items is None:
                conn.rollback()  # ends the read transaction opened by latest_published
                continue
            warm_embeddings(items)  # before the items are visible: the 10 s scan must not call the embedder
            new = store.upsert_items(conn, items)
            conn.commit()
            any_ok = True
            fetched += items
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
    return fetched


@dataclass
class LoopState:
    detector: Detector
    interval: float  # POLL_INTERVAL_SEC
    window_hours: float
    next_poll: float = 0.0  # fallback deadline of the full pass if no ingest wakes the loop
    alphas: tuple[float, ...] = ()  # T12c extra SPRT alphas (main() sets alpha_points())
    scan_interval: float = 10.0  # T12d SCAN_INTERVAL_SEC
    scanner: Scanner | None = None  # T12d: frames of the fast topics (main() sets load_scanner())
    next_fast: float = 0.0
    polled: threading.Event = field(default_factory=threading.Event)  # set by the ingest thread


def _synthetic_ttl() -> float:
    from detect.config import DEFAULT

    return DEFAULT.synthetic_ttl_sec


ATTACK_TAIL_SEC = 30.0


def fast_topics(conn) -> list[str]:
    """T12d: topics of open scan sessions and of running attacks (frequent frames), monitored ones only."""
    # + ATTACK_TAIL_SEC: a few frames after the campaign leaves the TTL, so its expired alert is cleared at once
    found = (store.scanned_topics(conn, radar.SESSION_STALE_SEC)
             | store.active_attack_topics(conn, _synthetic_ttl() + ATTACK_TAIL_SEC))
    conn.commit()
    monitored = set(topics())
    return sorted(t for t in found if t in monitored)


def _ensure_schema_once(conn) -> None:
    global _schema_ready
    if not _schema_ready:
        store.ensure_schema(conn)
        _schema_ready = True


def plan(st: LoopState, now: float, fast: list[str]) -> tuple[bool, list[str]]:
    """Pure: (run the full pass?, fast topics to run now)."""
    full = st.polled.is_set() or now >= st.next_poll
    return full, (list(fast) if fast and now >= st.next_fast else [])


def step(conn, st: LoopState, now: float) -> float:
    """One detect-loop iteration; returns the seconds until something is due (each unit fails on its own)."""
    _guarded(conn, "schema", _ensure_schema_once, conn)
    fast: list[str] = []
    _guarded(conn, "fast topics", lambda: fast.extend(fast_topics(conn)))
    full, due = plan(st, now, fast)
    # explanations that arrived before this step; one landing during it stays dirty for the next step
    dirty, dirty_alpha = _explain_queue.take_dirty_split() if _explain_queue is not None else (set(), set())
    done: set[str] = set()  # detected at the design alpha in this step (explanations read from the cache)
    done_full: set[str] = set()  # ... and at the slider points
    if full:
        st.polled.clear()
        st.next_poll = now + 2 * st.interval  # the ingest thread normally wakes us first
        if topics():  # findings of topics dropped from TOPICS are never recomputed: remove them
            _guarded(conn, "stale findings cleanup", store.delete_findings_except, conn, topics())
        _guarded(conn, "radar frame pruning", store.prune_frames, conn, radar.FRAME_KEEP_HOURS)
        for topic in topics():
            _guarded(conn, f"detect on {topic}", detect_topic, conn, topic, st.detector, st.window_hours, st.alphas,
                     st.scanner if topic in fast else None)
            done.add(topic)
            done_full.add(topic)
        if fast:
            st.next_fast = now + st.scan_interval  # the pass stored their frames
    if due:
        st.next_fast = now + st.scan_interval
        for topic in due:
            if topic not in done:  # frequent frames: design alpha only (T12c points stay on the full pass)
                _guarded(conn, f"scan detect on {topic}", detect_topic, conn, topic, st.detector, st.window_hours,
                         (), st.scanner)
                done.add(topic)
    if _explain_queue is not None:
        for topic in sorted((dirty - done) | (dirty_alpha - done_full)):  # an explanation arrived: store it now
            alphas = st.alphas if topic in dirty_alpha else ()
            if not _guarded(conn, f"re-store {topic}", detect_topic, conn, topic, st.detector, st.window_hours,
                            alphas):
                _explain_queue.mark_dirty(topic, alphas=topic in dirty_alpha)
    _guarded(conn, "inject processing", process_injects, conn, st.detector, st.window_hours, st.alphas)
    wait = INJECT_CHECK_SEC
    if fast:
        wait = min(wait, max(0.0, st.next_fast - now))
    return max(0.2, min(wait, st.next_poll - now))


def warm_embeddings(items: list[Item]) -> None:
    """Embed fetched texts in the ingest thread, so the detect loop only reads cache/embeddings/. Never raises."""
    if not items:
        return
    try:
        from detect.embed import embed_with_backend

        embed_with_backend([it.text for it in items])
    except Exception:  # the detect loop embeds again if this failed
        log.exception("embedding warm-up failed")


def warm_attack_texts() -> int:
    """T12d: embed the red team texts (synth/variations) of the monitored topics once at start, so the first frames
    of an attack read cache/embeddings/ instead of calling Gemini in the detect thread. Never raises."""
    try:
        from synth.variations import available_topics, load_variations

        monitored = set(topics())
        texts = [v for t in available_topics() if t in monitored
                 for m in load_variations(t).messages for v in m.variations]
    except Exception:
        log.exception("loading attack variations for the warm-up failed")
        return 0
    if texts:
        warm_embeddings([Item(id=f"warm-{k}", source="synthetic", author="warm", topic="warm", text=t,
                              published_at=datetime.now(timezone.utc), synthetic=True) for k, t in enumerate(texts)])
        log.info("warmed %d attack texts", len(texts))
    return len(texts)


def ingest_loop(stop: threading.Event, st: LoopState) -> None:
    """T12d ingest thread: warms the attack texts once, then own DB connection per cycle; wakes the detect loop
    after every cycle."""
    warm_attack_texts()
    while not stop.is_set():
        started = time.monotonic()
        try:
            with store.connect() as conn:
                ingest_cycle(conn)
                conn.commit()  # set_last_poll
        except Exception:  # DB down, connection lost: retried next interval
            log.exception("ingest cycle failed")
        st.polled.set()
        stop.wait(max(1.0, st.interval - (time.monotonic() - started)))


def main() -> None:
    global _explain_queue
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    st = LoopState(load_detector(), _positive("POLL_INTERVAL_SEC", 300), _positive("DETECT_WINDOW_HOURS", 6),
                   alphas=alpha_points(), scan_interval=_positive("SCAN_INTERVAL_SEC", 10), scanner=load_scanner())
    stop = threading.Event()

    def on_signal(*_):
        stop.set()
        st.polled.set()  # wake the detect loop

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, on_signal)
    _explain_queue = ExplainQueue()
    threads = [threading.Thread(target=ingest_loop, args=(stop, st), name="ingest", daemon=True),
               threading.Thread(target=_explain_queue.run, args=(stop,), name="explain", daemon=True)]
    for t in threads:
        t.start()
    log.info("worker started: detector=real interval=%ss scan=%ss window=%sh topics=%s extra alphas=%s",
             st.interval, st.scan_interval, st.window_hours, topics() or "(none)", st.alphas)

    while not stop.is_set():
        wait = INJECT_CHECK_SEC
        try:
            with store.connect() as conn:
                t0 = time.monotonic()
                wait = step(conn, st, t0) - (time.monotonic() - t0)  # step() counts from its start
        except Exception:  # keep the worker alive: DB down. Sleep on `stop`: `polled` may stay set (no busy loop)
            log.exception("detect cycle failed; retrying in %ss", INJECT_CHECK_SEC)
            stop.wait(INJECT_CHECK_SEC)
            continue
        if wait > 0:
            st.polled.wait(wait)
    _explain_queue.stop()
    for t in threads:
        t.join(timeout=5)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
