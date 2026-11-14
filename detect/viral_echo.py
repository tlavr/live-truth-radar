"""False target "viral echo": docs/signal-processing.md 3.8.

A viral meme ("The person responsible for the Microsoft outage. Wrong answers only.") is copied
almost verbatim by dozens of real people over hours. The correlator cuts that spread into several
tight groups, and each one looks like copypasta. What tells it from a campaign: the message also
circulates in the live stream outside the group. If at least viral_echo_min_accounts accounts outside
the group posted, within viral_echo_max_age_sec of the group's first non-news post (before OR after it),
something whose whitened vector has cos > viral_echo_cos with the group centroid, the group is capped
at "watching".

Both directions, because the window has an edge: the first wave of a meme (or the first shares of a
headline) has nothing before it inside the window, but later waves by other people follow it. Live,
"after" means up to now. A fresh campaign brings its own message: nobody outside it repeats it
(eval 14.11 on the 48 h background with Bluesky: microsoft background alarms 21/34 windows without the
rule, 9/34 looking back only, 4/34 both ways; Pd unchanged).
Only live-stream posts (context_social / context_news) count as prior spread: an injected test
campaign (source "synthetic") is not part of the stream, so a second inject into the same topic is
not read as an echo of the first one (a deliberate asymmetry: a real campaign arriving as context_social
does count as spread). Limitations: a real campaign whose second wave uses new accounts and repeats its
own first wave is capped too, and once later waves are in the window so is the first wave; live, the
first wave raises the alarm before the later waves appear, in a retrospective window (eval) it does not.

Like news echo, the rule runs only when the topic window has context_social posts ([ALT] off).
"""

from __future__ import annotations

import numpy as np

from detect.config import DEFAULT, AnalyzerConfig
from detect.correlation import TopicSignal

NOTE_PREFIX = "viral echo: "
NOTE_CHARS = 80


def viral_echo_note(
    sig: TopicSignal,
    is_news: np.ndarray,
    is_stream: np.ndarray,
    texts: list[str],
    group_posts: np.ndarray,
    members: np.ndarray,
    cfg: AnalyzerConfig = DEFAULT,
    *,
    has_social: bool = True,
) -> str | None:
    """Note "viral echo: <first 80 chars of the earliest matching outside post>" if the group's message is
    also posted by enough outside accounts, else None.

    is_news / is_stream: bool per post (source == context_news / source is a live-stream source);
    group_posts: indices of the group's posts; members: bool per account (sig.accounts) in the group.
    """
    if not cfg.viral_echo_enabled or not has_social:
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
    near = np.abs(sig.t - t0) <= cfg.viral_echo_max_age_sec
    idx = np.flatnonzero(is_stream & ~members[sig.acct] & near)
    if idx.size == 0:
        return None
    hits = idx[sig.code[idx] @ centroid > cfg.viral_echo_cos]
    if len(set(sig.acct[hits].tolist())) < cfg.viral_echo_min_accounts:
        return None
    return NOTE_PREFIX + texts[int(hits.min())][:NOTE_CHARS]  # posts are in time order: min = earliest
