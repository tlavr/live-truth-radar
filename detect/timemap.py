"""Time x meaning map of one topic (experiment): where in time the look-alike post pairs sit.

A cell counts the pairs of posts by different accounts published within `pair_gap_sec` of each
other: x = time of the later post (bins of `step_sec`), y = semantic mismatch 1 - cos of the
whitened codes (0 = same meaning, 1 = unrelated), the same measure as AmbiguityMap. `total` holds
all such pairs of the window; `groups[id]` the pairs whose two posts both belong to that finding,
so a wave shows up as a peak at its own time. Not a contract model: the API only passes it on.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
from pydantic import BaseModel

from contracts.models import Item
from detect.config import DEFAULT, AnalyzerConfig
from detect.correlation import topic_signal
from detect.embed import embed_with_backend

STEP_SEC = 30.0
PAIR_GAP_SEC = 120.0
N_MISMATCH = 20


class TimeMap(BaseModel):
    topic: str
    start: datetime  # left edge of bin 0
    now: datetime  # right edge of the last bin: the moment the map was computed for
    step_sec: float
    n_bins: int
    mismatch_edges: list[float]
    total: list[list[int]]  # [mismatch bin][time bin]: all near pairs of the window
    groups: dict[str, list[list[int]]]  # finding id -> same grid, pairs inside that finding


def time_map(
    topic: str,
    items: list[Item],
    groups: dict[str, list[str]],
    *,
    now: datetime,
    window_hours: float = DEFAULT.window_hours,
    span_sec: float | None = None,
    step_sec: float = STEP_SEC,
    pair_gap_sec: float = PAIR_GAP_SEC,
    cfg: AnalyzerConfig = DEFAULT,
) -> TimeMap:
    """items: the topic window (any order); groups: finding id -> its item ids.

    span_sec: the map covers only the last span_sec before now (default: the whole window). Pairs are
    still found over the whole window, so a pair whose earlier post is older than the span still counts.
    """
    n_bins = max(1, int(np.ceil(min(span_sec or 1e18, window_hours * 3600) / step_sec)))
    start_ts = now.timestamp() - n_bins * step_sec  # bins end exactly at now: the last bin is "0 to step_sec ago"
    edges = [round(k / N_MISMATCH, 2) for k in range(N_MISMATCH + 1)]
    empty = lambda: np.zeros((N_MISMATCH, n_bins), dtype=int)  # noqa: E731
    out = TimeMap(topic=topic, now=now, start=datetime.fromtimestamp(start_ts, timezone.utc), step_sec=step_sec,
                  n_bins=n_bins, mismatch_edges=edges, total=empty().tolist(),
                  groups={fid: empty().tolist() for fid in groups})
    first_ts = now.timestamp() - window_hours * 3600
    items = sorted((it for it in items if first_ts <= it.published_at.timestamp() <= now.timestamp()),
                   key=lambda it: (it.published_at, it.id))
    if len({it.author for it in items}) < 2:
        return out

    E, backend = embed_with_backend([it.text for it in items])
    ts = np.array([it.published_at.timestamp() for it in items])
    sig = topic_signal(E, ts - ts[0], [it.author for it in items], cfg.for_embedder(backend))
    near = (sig.pair_dt <= pair_gap_sec) & (ts[sig.pair_q] >= start_ts)  # near pairs are already cross-account
    p, q = sig.pair_p[near], sig.pair_q[near]
    col = np.clip(((ts[q] - start_ts) // step_sec).astype(int), 0, n_bins - 1)
    row = np.clip(((1.0 - np.clip(sig.pair_cos[near], 0.0, 1.0)) * N_MISMATCH).astype(int), 0, N_MISMATCH - 1)

    def hist(mask: np.ndarray) -> list[list[int]]:
        h = empty()
        np.add.at(h, (row[mask], col[mask]), 1)
        return h.tolist()

    out.total = hist(np.ones(len(p), dtype=bool))
    index = {it.id: k for k, it in enumerate(items)}
    for fid, ids in groups.items():
        inside = np.zeros(len(items), dtype=bool)
        inside[[index[i] for i in ids if i in index]] = True
        out.groups[fid] = hist(inside[p] & inside[q])
    return out
