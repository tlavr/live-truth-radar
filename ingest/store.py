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


def get_items(conn: psycopg.Connection, ids: list[str]) -> list[Item]:
    """Items by id, in time order; unknown ids are skipped."""
    if not ids:
        return []
    rows = conn.execute(
        f"SELECT {', '.join(ITEM_COLS)} FROM items WHERE id = ANY(%s) ORDER BY published_at, id", (list(ids),)
    ).fetchall()
    return [_item(r) for r in rows]


def window_items(conn: psycopg.Connection, topic: str, hours: float, now: datetime | None = None) -> list[Item]:
    """Items of one topic published in [now - hours, now], in time order."""
    now = now or datetime.now(timezone.utc)
    rows = conn.execute(
        f"SELECT {', '.join(ITEM_COLS)} FROM items WHERE topic = %s AND published_at >= %s AND published_at <= %s "
        "ORDER BY published_at, id",
        (topic, now - timedelta(hours=hours), now),
    ).fetchall()
    return [_item(r) for r in rows]


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
