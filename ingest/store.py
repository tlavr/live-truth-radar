"""Postgres access for the API and the worker (P1, T8). Tables: infra/schema.sql.

One small function per query, so neither the API nor the worker writes SQL. Every function
takes an open connection; callers own transactions via `with connect() as conn:` (psycopg 3
commits on a clean exit and rolls back on an exception).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from contracts.models import Finding, Item

ITEM_COLS = ("id", "source", "platform", "author", "published_at", "text", "url", "topic", "synthetic", "campaign_id")
FINDING_SCALARS = (
    "id", "topic", "created_at", "verdict", "llr", "snr_db", "snr_db_single", "sprt_upper", "sprt_lower",
    "decided_at_item", "first_seen", "last_seen", "synthetic", "note",
)
FINDING_JSON = ("accounts", "item_ids", "sprt_trace", "correlation", "lag_sec", "explanation", "ambiguity")
LAST_POLL = "last_poll_at"


def connect() -> psycopg.Connection:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg.connect(url, row_factory=dict_row)


# ---------------------------------------------------------------- items


def upsert_items(conn: psycopg.Connection, items: list[Item]) -> int:
    """Insert items (dedup by id: an existing id is left as is) and touch their actors; returns the number inserted."""
    if not items:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            f"INSERT INTO items ({', '.join(ITEM_COLS)}) VALUES ({', '.join(['%s'] * len(ITEM_COLS))}) "
            "ON CONFLICT (id) DO NOTHING",
            [tuple(getattr(it, c) for c in ITEM_COLS) for it in items],
        )
        inserted = max(cur.rowcount, 0)  # psycopg 3: executemany sums the rows of every statement
        seen: dict[str, tuple[str | None, datetime, datetime]] = {}  # author -> (platform, first, last)
        for it in items:
            prev = seen.get(it.author)
            if prev is None:
                seen[it.author] = (it.platform, it.published_at, it.published_at)
            else:
                seen[it.author] = (prev[0], min(prev[1], it.published_at), max(prev[2], it.published_at))
        cur.executemany(
            "INSERT INTO actors (author, platform, first_seen_at, last_seen_at) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (author) DO UPDATE SET first_seen_at = LEAST(actors.first_seen_at, EXCLUDED.first_seen_at), "
            "last_seen_at = GREATEST(actors.last_seen_at, EXCLUDED.last_seen_at)",
            [(a, p, first, last) for a, (p, first, last) in seen.items()],
        )
    return inserted


def _item(row: dict) -> Item:
    return Item.model_validate({c: row[c] for c in ITEM_COLS})


def get_items(conn: psycopg.Connection, ids: list[str], until: datetime | None = None) -> list[Item]:
    """Items by id, in time order; unknown ids are skipped. `until`: only items published by then (T12d: an
    attack's future posts stay hidden until their time)."""
    if not ids:
        return []
    sql = f"SELECT {', '.join(ITEM_COLS)} FROM items WHERE id = ANY(%s)"
    params: tuple = (list(ids),)
    if until is not None:
        sql += " AND published_at <= %s"
        params += (until,)
    rows = conn.execute(sql + " ORDER BY published_at, id", params).fetchall()
    return [_item(r) for r in rows]


DEFAULT_WINDOW_MAX_ITEMS = 800


def window_max_items() -> int:
    """WINDOW_MAX_ITEMS (default 800; 0 = no cap): the pair correlator grows with the square of the accounts, and
    a loud topic (Putin, NATO) fills Bluesky's 300 posts per cycle, so the detector sees only the newest N real
    social posts (news and synthetic rows are never capped)."""
    raw = (os.environ.get("WINDOW_MAX_ITEMS") or "").strip()
    try:
        n = int(raw) if raw else DEFAULT_WINDOW_MAX_ITEMS
    except ValueError:
        return DEFAULT_WINDOW_MAX_ITEMS
    return max(0, n)


def window_items(conn: psycopg.Connection, topic: str, hours: float, now: datetime | None = None) -> list[Item]:
    """Items of one topic published in [now - hours, now], in time order. Real social posts are capped to the
    newest window_max_items(); news and synthetic rows of the window are always kept (news_echo needs the
    articles behind a burst, and an injected campaign must stay whole)."""
    now = now or datetime.now(timezone.utc)
    cap = window_max_items()
    span = (topic, now - timedelta(hours=hours), now)
    where = "topic = %s AND published_at >= %s AND published_at <= %s"
    capped = ""
    if cap:
        capped = (f" AND (source <> 'context_social' OR synthetic OR id IN (SELECT id FROM items WHERE {where} "
                  "AND source = 'context_social' AND NOT synthetic ORDER BY published_at DESC, id DESC LIMIT %s))")
    rows = conn.execute(
        f"SELECT {', '.join(ITEM_COLS)} FROM items WHERE {where}{capped} ORDER BY published_at, id",
        (*span, *((*span, cap) if cap else ())),
    ).fetchall()
    return [_item(r) for r in rows]


def latest_published(
    conn: psycopg.Connection, topic: str, source: str, platform: str | None = None
) -> datetime | None:
    """Newest published_at of one topic from one source, optionally one platform of it (context_social holds
    both Reddit and Bluesky); None if nothing stored yet."""
    sql = "SELECT max(published_at) AS latest FROM items WHERE topic = %s AND source = %s"
    params: tuple = (topic, source)
    if platform is not None:
        sql += " AND platform = %s"
        params += (platform,)
    row = conn.execute(sql, params).fetchone()
    return None if row is None else row["latest"]


def recent_items(conn: psycopg.Connection, hours: float, *, include_synthetic: bool = False) -> list[Item]:
    """All items of the last `hours` (all topics), in time order."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    sql = f"SELECT {', '.join(ITEM_COLS)} FROM items WHERE published_at >= %s"
    if not include_synthetic:
        sql += " AND NOT synthetic"
    rows = conn.execute(sql + " ORDER BY published_at, id", (since,)).fetchall()
    return [_item(r) for r in rows]


def synthetic_authors(conn: psycopg.Connection, item_ids: list[str]) -> set[str]:
    """Authors of the synthetic items among item_ids (their names are fake: never masked)."""
    if not item_ids:
        return set()
    rows = conn.execute(
        "SELECT DISTINCT author FROM items WHERE synthetic AND id = ANY(%s)", (list(item_ids),)
    ).fetchall()
    return {r["author"] for r in rows}


# ---------------------------------------------------------------- findings


def replace_findings(conn: psycopg.Connection, topic: str, findings: list[Finding]) -> None:
    """Replace all findings of a topic in one transaction (the latest detector run only)."""
    if any(f.topic != topic for f in findings):
        raise ValueError(f"findings of another topic passed to replace_findings({topic!r})")
    cols = FINDING_SCALARS + FINDING_JSON
    rows = []
    for f in findings:
        data = f.model_dump(mode="json")
        rows.append(
            tuple(getattr(f, c) for c in FINDING_SCALARS)
            + tuple(None if data[c] is None else Jsonb(data[c]) for c in FINDING_JSON)
        )
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("DELETE FROM findings WHERE topic = %s", (topic,))
        if rows:
            cur.executemany(
                f"INSERT INTO findings ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) "
                # two topics' runs cannot collide (id includes the topic); keep the newest on a repeat
                f"ON CONFLICT (id) DO UPDATE SET {', '.join(f'{c} = EXCLUDED.{c}' for c in cols if c != 'id')}",
                rows,
            )


FINDINGS_ALPHA_DDL = (
    "CREATE TABLE IF NOT EXISTS findings_alpha (alpha double precision NOT NULL, topic text NOT NULL, "
    "id text NOT NULL, created_at timestamptz NOT NULL, finding jsonb NOT NULL, PRIMARY KEY (alpha, id))",
    "CREATE INDEX IF NOT EXISTS findings_alpha_topic_idx ON findings_alpha (alpha, topic)",
)


T12D_DDL = (
    "CREATE TABLE IF NOT EXISTS scan_sessions (id bigserial PRIMARY KEY, topics text[] NOT NULL, "
    "started_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), "
    "stopped_at timestamptz)",
    "CREATE INDEX IF NOT EXISTS scan_sessions_open_idx ON scan_sessions (last_seen_at) WHERE stopped_at IS NULL",
    "CREATE TABLE IF NOT EXISTS radar_frames (topic text NOT NULL, at timestamptz NOT NULL, frame jsonb NOT NULL)",
    "CREATE INDEX IF NOT EXISTS radar_frames_topic_at_idx ON radar_frames (topic, at)",
    "CREATE TABLE IF NOT EXISTS attacks (campaign_id text PRIMARY KEY, topic text NOT NULL, "
    "n_accounts integer NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, "
    "created_at timestamptz NOT NULL DEFAULT now())",
    "CREATE INDEX IF NOT EXISTS attacks_topic_idx ON attacks (topic, created_at)",
)


def ensure_schema(conn: psycopg.Connection) -> None:
    """Tables added after the first deploy (infra/schema.sql runs only on a fresh DB volume)."""
    with conn.transaction():
        for ddl in FINDINGS_ALPHA_DDL + T12D_DDL:
            conn.execute(ddl)


def replace_findings_alpha(conn: psycopg.Connection, topic: str, alpha: float, findings: list[Finding]) -> None:
    """T12c: replace the findings of one topic at one extra SPRT alpha, in one transaction."""
    if any(f.topic != topic for f in findings):
        raise ValueError(f"findings of another topic passed to replace_findings_alpha({topic!r})")
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("DELETE FROM findings_alpha WHERE topic = %s AND alpha = %s", (topic, alpha))
        if findings:
            cur.executemany(
                "INSERT INTO findings_alpha (alpha, topic, id, created_at, finding) VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT (alpha, id) DO UPDATE SET topic = EXCLUDED.topic, created_at = EXCLUDED.created_at, "
                "finding = EXCLUDED.finding",
                [(alpha, f.topic, f.id, f.created_at, Jsonb(f.model_dump(mode="json"))) for f in findings],
            )


def load_findings_alpha(conn: psycopg.Connection, alpha: float, topic: str | None = None) -> list[Finding]:
    """Findings at one extra SPRT alpha, newest first; [] if the table does not exist yet."""
    sql = "SELECT finding FROM findings_alpha WHERE alpha = %s"
    params: tuple = (alpha,)
    if topic is not None:
        sql += " AND topic = %s"
        params += (topic,)
    try:
        with conn.transaction():  # a savepoint: a missing table must not abort the caller's transaction
            rows = conn.execute(sql + " ORDER BY created_at DESC, id", params).fetchall()
    except psycopg.errors.UndefinedTable:
        return []
    return [Finding.model_validate(json.loads(r["finding"]) if isinstance(r["finding"], str) else r["finding"])
            for r in rows]


def delete_findings_except(conn: psycopg.Connection, topics: list[str]) -> int:
    """Delete findings (also T12c findings_alpha) of every topic not in `topics`; returns the count."""
    if not topics:
        raise ValueError("delete_findings_except needs at least one topic to keep")
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("DELETE FROM findings WHERE NOT (topic = ANY(%s))", (list(topics),))
        n = cur.rowcount
        try:
            with conn.transaction():  # savepoint: findings_alpha (T12c) may not exist yet on an old volume
                cur.execute("DELETE FROM findings_alpha WHERE NOT (topic = ANY(%s))", (list(topics),))
                n += cur.rowcount
        except psycopg.errors.UndefinedTable:
            pass
        return n


def load_findings(conn: psycopg.Connection, topic: str | None = None) -> list[Finding]:
    """Stored findings, newest first; optionally one topic."""
    cols = FINDING_SCALARS + FINDING_JSON
    sql = f"SELECT {', '.join(cols)} FROM findings"
    params: tuple = ()
    if topic is not None:
        sql += " WHERE topic = %s"
        params = (topic,)
    rows = conn.execute(sql + " ORDER BY created_at DESC, id", params).fetchall()
    out = []
    for r in rows:
        data = {c: r[c] for c in cols}
        for c in FINDING_JSON:  # jsonb comes back decoded; tolerate text just in case
            if isinstance(data[c], str):
                data[c] = json.loads(data[c])
        out.append(Finding.model_validate(data))
    return out


# ---------------------------------------------------------------- inject requests


def add_inject_request(conn: psycopg.Connection, topic: str, campaign_id: str) -> int:
    row = conn.execute(
        "INSERT INTO inject_requests (topic, campaign_id) VALUES (%s, %s) RETURNING id", (topic, campaign_id)
    ).fetchone()
    return int(row["id"])


def has_pending_inject(conn: psycopg.Connection, topic: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM inject_requests WHERE topic = %s AND processed_at IS NULL LIMIT 1", (topic,)
    ).fetchone()
    return row is not None


def pending_injects(conn: psycopg.Connection) -> list[dict]:
    """Unprocessed inject requests, oldest first: [{id, topic, campaign_id, created_at}]."""
    return conn.execute(
        "SELECT id, topic, campaign_id, created_at FROM inject_requests WHERE processed_at IS NULL ORDER BY created_at, id"
    ).fetchall()


def mark_injects_processed(conn: psycopg.Connection, ids: list[int]) -> None:
    if ids:
        conn.execute("UPDATE inject_requests SET processed_at = now() WHERE id = ANY(%s)", (list(ids),))


# ---------------------------------------------------------------- worker state


def get_last_poll(conn: psycopg.Connection) -> datetime | None:
    row = conn.execute("SELECT value FROM worker_state WHERE key = %s", (LAST_POLL,)).fetchone()
    return None if row is None else row["value"]


def set_last_poll(conn: psycopg.Connection, ts: datetime | None = None) -> None:
    conn.execute(
        "INSERT INTO worker_state (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        (LAST_POLL, ts or datetime.now(timezone.utc)),
    )


def last_inject_at(conn: psycopg.Connection, topic: str) -> datetime | None:
    """T12d: time of the newest inject request on the topic (the public inject is rate-limited per topic)."""
    row = conn.execute("SELECT max(created_at) AS at FROM inject_requests WHERE topic = %s", (topic,)).fetchone()
    return None if row is None else row["at"]


# ---------------------------------------------------------------- T12d: scan sessions, radar frames, attacks


def open_scan(conn: psycopg.Connection, topics: list[str]) -> int:
    row = conn.execute("INSERT INTO scan_sessions (topics) VALUES (%s) RETURNING id", (list(topics),)).fetchone()
    return int(row["id"])


def touch_scan(conn: psycopg.Connection, session_id: int, stale_sec: float) -> list[str] | None:
    """Heartbeat: the session's topics if it is open and fresh (last_seen_at moves to now), else None."""
    row = conn.execute(
        "UPDATE scan_sessions SET last_seen_at = now() WHERE id = %s AND stopped_at IS NULL "
        "AND last_seen_at >= now() - %s * interval '1 second' RETURNING topics",
        (session_id, stale_sec),
    ).fetchone()
    return None if row is None else list(row["topics"])


def stop_scan(conn: psycopg.Connection, session_id: int) -> bool:
    row = conn.execute(
        "UPDATE scan_sessions SET stopped_at = now() WHERE id = %s AND stopped_at IS NULL RETURNING id", (session_id,)
    ).fetchone()
    return row is not None


def scanned_topics(conn: psycopg.Connection, stale_sec: float) -> set[str]:
    """Union of the topics of open sessions with a heartbeat in the last stale_sec."""
    rows = conn.execute(
        "SELECT DISTINCT unnest(topics) AS topic FROM scan_sessions WHERE stopped_at IS NULL "
        "AND last_seen_at >= now() - %s * interval '1 second'",
        (stale_sec,),
    ).fetchall()
    return {r["topic"] for r in rows}


def add_frame(conn: psycopg.Connection, frame: dict) -> None:
    conn.execute("INSERT INTO radar_frames (topic, at, frame) VALUES (%s, %s, %s)",
                 (frame["topic"], frame["at"], Jsonb(frame)))


def load_frames(conn: psycopg.Connection, topic: str, since: datetime) -> list[dict]:
    rows = conn.execute(
        "SELECT frame FROM radar_frames WHERE topic = %s AND at > %s ORDER BY at", (topic, since)
    ).fetchall()
    return [json.loads(r["frame"]) if isinstance(r["frame"], str) else r["frame"] for r in rows]


def prune_frames(conn: psycopg.Connection, keep_hours: float) -> int:
    cur = conn.execute("DELETE FROM radar_frames WHERE at < now() - %s * interval '1 hour'", (keep_hours,))
    return max(cur.rowcount, 0)


def add_attack(conn: psycopg.Connection, campaign_id: str, topic: str, n_accounts: int, starts_at: datetime,
               ends_at: datetime) -> None:
    conn.execute(
        "INSERT INTO attacks (campaign_id, topic, n_accounts, starts_at, ends_at) VALUES (%s, %s, %s, %s, %s)",
        (campaign_id, topic, n_accounts, starts_at, ends_at),
    )


def last_attack_at(conn: psycopg.Connection, topic: str) -> datetime | None:
    """T12d: time of the newest attack on the topic (one attack per 5 min per topic)."""
    row = conn.execute("SELECT max(created_at) AS at FROM attacks WHERE topic = %s", (topic,)).fetchone()
    return None if row is None else row["at"]


def active_attack_topics(conn: psycopg.Connection, ttl_sec: float) -> set[str]:
    rows = conn.execute(
        "SELECT DISTINCT topic FROM attacks WHERE ends_at + %s * interval '1 second' > now()", (ttl_sec,)
    ).fetchall()
    return {r["topic"] for r in rows}


def get_attack(conn: psycopg.Connection, campaign_id: str) -> dict | None:
    return conn.execute(
        "SELECT campaign_id, topic, n_accounts, starts_at, ends_at FROM attacks WHERE campaign_id = %s", (campaign_id,)
    ).fetchone()


def campaign_items(conn: psycopg.Connection, campaign_id: str, until: datetime) -> list[Item]:
    rows = conn.execute(
        f"SELECT {', '.join(ITEM_COLS)} FROM items WHERE campaign_id = %s AND published_at <= %s "
        "ORDER BY published_at, id",
        (campaign_id, until),
    ).fetchall()
    return [_item(r) for r in rows]
