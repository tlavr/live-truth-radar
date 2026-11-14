"""False target "news echo": docs/signal-processing.md 3.8.

A loud news article excites everybody with one external pulse, so honest people
post the headline almost together. If a context_news article appeared at most
news_echo_max_age_sec before the group's first post and its whitened vector has
cos > news_echo_cos with the group centroid, the group is capped at "watching".

Articles are not counted as the group's own posts here (first post, centroid):
the outlet itself correlates with its echoes and often lands in the group, so
"author not in the group" is read as "the article is not one of the posts being echoed".
"""

from __future__ import annotations

import numpy as np

from detect.config import DEFAULT, AnalyzerConfig
from detect.correlation import TopicSignal

NOTE_PREFIX = "news echo: "
NOTE_CHARS = 80


def news_echo_note(
    sig: TopicSignal,
    is_news: np.ndarray,
    texts: list[str],
    group_posts: np.ndarray,
    cfg: AnalyzerConfig = DEFAULT,
) -> str | None:
    """Note "news echo: <first 80 chars of the article>" if the group echoes an article, else None.

    is_news: bool per post (source == context_news); group_posts: indices of the group's posts.
    """
    if not cfg.news_echo_enabled:
        return None
    own = np.asarray([p for p in group_posts if not is_news[p]], dtype=np.int64)
    if own.size == 0:
        return None
    t0 = sig.t[own].min()
    centroid = sig.code[own].mean(axis=0)
    norm = float(np.linalg.norm(centroid))
    if norm == 0:
        return None
    centroid /= norm
    best, best_cos = None, cfg.news_echo_cos
    for a in np.flatnonzero(is_news):
        age = t0 - sig.t[a]
        if not 0 <= age <= cfg.news_echo_max_age_sec:
            continue
        cos = float(sig.code[a] @ centroid)
        if cos > best_cos:
            best, best_cos = a, cos
    if best is None:
        return None
    return NOTE_PREFIX + texts[best][:NOTE_CHARS]
