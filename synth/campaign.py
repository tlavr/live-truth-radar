"""Synthetic swarm with known ground truth: the radar's test target (T9).

`make_campaign` is called by POST /api/inject (P1). Interface and rules are fixed
in docs/HANDOFF.md section 5: change only by agreement of both people.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import numpy as np

from contracts.models import Item
from synth.variations import load_variations

# Two volleys inside the 15-minute window: volley start, seconds before `now`.
VOLLEY_START_BEFORE_NOW_SEC = (840, 360)
FUTURE_SHIFT_SEC = 840  # T12d schedule="future": the same volleys moved to [now, now + ~10 min]
LAG_RANGE_SEC = (15, 120)  # per-account posting lag inside a volley
LAG_JITTER_SEC = 10

_NAME_A = ["true", "real", "free", "honest", "proud", "awake", "loyal", "bold", "plain", "sharp"]
_NAME_B = ["voice", "citizen", "watch", "patriot", "facts", "eagle", "report", "truth", "signal", "people"]


def _seed_from(topic: str, now: datetime) -> int:
    digest = hashlib.sha1(f"{topic}|{now.isoformat()}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "little")


def _accounts(rng: np.random.Generator, n: int) -> list[str]:
    names: list[str] = []
    while len(names) < n:
        name = f"{_NAME_A[rng.integers(len(_NAME_A))]}_{_NAME_B[rng.integers(len(_NAME_B))]}_{rng.integers(100, 1000)}"
        if name not in names:
            names.append(name)
    return names


def make_campaign(
    topic: str, now: datetime, *, n_accounts: int = 12, seed: int | None = None, schedule: str = "past"
) -> list[Item]:
    """One injected swarm: 2 volleys in [now - 15 min, now], every account posts one rewording per volley.

    schedule="future" (T12d live attack) moves both volleys by +840 s: the first post lands ~15-60 s
    after `now` with 12 accounts (later with fewer), the last <= 10 min after; everything else (accounts, lags, texts, campaign_id) is the
    same as "past", the default for /api/inject, eval and tests.

    Each account has its own lag of 15-120 s after the volley start ("bot schedule") with a
    small jitter, so pairs stay within ~2 minutes of each other. Same (topic, now, seed) ->
    same items; seed=None derives the seed from topic and now, so every inject is new.
    """
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    if n_accounts < 1:
        raise ValueError("n_accounts must be >= 1")
    if schedule not in ("past", "future"):
        raise ValueError(f"schedule must be 'past' or 'future', not {schedule!r}")
    shift = timedelta(seconds=FUTURE_SHIFT_SEC if schedule == "future" else 0)
    now = now.astimezone(timezone.utc)
    variation_set = load_variations(topic)
    rng = np.random.default_rng(_seed_from(topic, now) if seed is None else seed)

    pool = [m for m in variation_set.messages if m.held_out] or variation_set.messages
    order = rng.permutation(len(pool))
    volleys = [pool[order[v % len(pool)]] for v in range(len(VOLLEY_START_BEFORE_NOW_SEC))]

    accounts = _accounts(rng, n_accounts)
    lo, hi = LAG_RANGE_SEC
    base_lag = rng.integers(lo + LAG_JITTER_SEC, hi - LAG_JITTER_SEC + 1, size=n_accounts)

    posts: list[tuple[datetime, str, str]] = []
    for start_before, message in zip(VOLLEY_START_BEFORE_NOW_SEC, volleys):
        texts = rng.permutation(len(message.variations))
        for a, account in enumerate(accounts):
            lag = int(base_lag[a] + rng.integers(-LAG_JITTER_SEC, LAG_JITTER_SEC + 1))
            when = now - timedelta(seconds=start_before - lag) + shift
            posts.append((when, account, message.variations[texts[a % len(texts)]]))

    posts.sort(key=lambda p: (p[0], p[1]))
    campaign_id = f"inj-{topic}-{now:%H%M%S}"
    return [
        Item(
            id=f"{campaign_id}-{k}",
            source="synthetic",
            platform="x",
            author=account,
            published_at=when,
            text=text,
            url=None,
            topic=topic,
            synthetic=True,
            campaign_id=campaign_id,
        )
        for k, (when, account, text) in enumerate(posts)
    ]
