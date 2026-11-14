"""T12d live-scan session rules (P1). Frames come from detect.pipeline.scan (detect/radar.py, P2)."""

from __future__ import annotations

from datetime import datetime, timedelta

SESSION_STALE_SEC = 60.0  # a session without a heartbeat (GET /api/radar) for this long is closed
MAX_SESSION_TOPICS = 2
MAX_SCANNED_TOPICS = 4  # cap on the union of scanned topics, not on the number of sessions
FRAME_KEEP_HOURS = 2.0


def is_stale(last_seen_at: datetime, now: datetime, stale_sec: float = SESSION_STALE_SEC) -> bool:
    return last_seen_at < now - timedelta(seconds=stale_sec)
