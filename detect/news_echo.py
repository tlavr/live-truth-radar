"""False target "news echo": docs/signal-processing.md 3.8.

A loud news article excites everybody with one external pulse, so honest people
post the headline almost together. If a context_news article appeared at most
news_echo_max_age_sec before the group's first post and its whitened vector has
cos > news_echo_cos with the group centroid, the group is capped at "watching".

Articles are not counted as the group's own posts here (first post, centroid):
the outlet itself correlates with its echoes and often lands in the group, so
"author not in the group" is read as "the article is not one of the posts being echoed".

[ALT] mode (no social authors, docs 3.8): the rule exists for real people echoing a headline,
so it only runs when the topic window has context_social posts. In a news-only stream the
"accounts" are outlets plus injected synthetic accounts, and the rule would only block injects.
"""

from __future__ import annotations

import numpy as np

from detect.config import DEFAULT, AnalyzerConfig
from detect.correlation import TopicSignal

NOTE_PREFIX = "news echo: "
REPRINT_PREFIX = "news reprint: "
NOTE_CHARS = 80


def news_echo_note(
    sig: TopicSignal,
    is_news: np.ndarray,
    texts: list[str],
    group_posts: np.ndarray,
    cfg: AnalyzerConfig = DEFAULT,
    *,
    has_social: bool = True,
) -> str | None:
    """Note "news echo: <first 80 chars of the article>" if the group echoes an article, else None.

    is_news: bool per post (source == context_news); group_posts: indices of the group's posts;
    has_social: the topic window has context_social posts (False = [ALT] news-only stream: rule off).
    """
    if not cfg.news_echo_enabled or not has_social:
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


def news_reprint_note(
    is_news: np.ndarray, texts: list[str], group_posts: np.ndarray, cfg: AnalyzerConfig = DEFAULT
) -> str | None:
    """Note "news reprint: <first 80 chars of the earliest article>" if every post of the group is
    a context_news article (outlets syndicating one wire story), else None.

    Works in the news-only [ALT] stream too: outlets are not people, so a group of outlets alone is
    never a coordinated swarm. A group with any synthetic or social post is left alone.
    group_posts is in time order, so its first post is the earliest article.
    """
    if not cfg.news_reprint_enabled or len(group_posts) == 0 or not is_news[group_posts].all():
        return None
    return REPRINT_PREFIX + texts[int(group_posts[0])][:NOTE_CHARS]
