"""Swarm detector entry point (P2).

Stages (radar analogy):
  1. Embed item texts (Gemini embeddings), group by topic.            [T7]
  2. Topic beam (steering vector, main-lobe gain) and whitening:
     remove the projection on the beam, keep the residual "code".      [T7]
  3. Pair correlator in time x meaning over lags -> R and lag
     matrices (no template bank).                                      [detect.correlation]
  4. CFAR over all account pairs of the topic (median / MAD with a
     floor) -> groups of >= 3 accounts, coherent integration, SNR dB.  [detect.cfar]
  5. SPRT (Wald) on the causal per-post "echo" feature with error
     rates alpha/beta -> coordinated / organic / watching, sprt_trace;
     news-echo / viral-echo checks cap a group at "watching".          [detect.sprt, detect.news_echo, detect.viral_echo]
  6. Emit Finding objects with the ambiguity map and note
     (explanation is filled later by P1, T11).

Design and parameters: docs/signal-processing.md section 3.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import numpy as np

from contracts.models import AmbiguityMap, Finding, Item, finding_id
from detect import cfar, sprt
from detect.config import DEFAULT, AnalyzerConfig
from detect.correlation import TopicSignal, n_lag_steps, pair_correlation, require_window, topic_signal
from detect.embed import embed_with_backend
from detect.radar import RadarFrame, best_candidate
from detect.news_echo import news_echo_note, news_reprint_note
from detect.viral_echo import viral_echo_note

MISMATCH_EDGES = [round(0.1 * k, 1) for k in range(11)]


def detect(
    items: list[Item],
    *,
    alpha: float = 0.02,
    beta: float = 0.1,
    cfg: AnalyzerConfig = DEFAULT,
    now: datetime | None = None,
) -> list[Finding]:
    """Run the detector over items and return findings (one per swarm candidate group).

    alpha: target false-alarm probability (SPRT upper threshold A = (1-beta)/alpha).
    beta: target miss probability (SPRT lower threshold B = beta/(1-alpha)).
    cfg: analyzer parameters (eval sweeps cfar_k through it); its alpha/beta are overridden.
    now: live run time (worker). When given, posts published after now are not seen yet (T12d
        "future" injects) and an injected campaign whose newest visible post is older than
        cfg.synthetic_ttl_sec drops out; None (tests, eval) keeps every item.
    """
    return _run(items, alpha=alpha, beta=beta, cfg=cfg, now=now, stats=None)


def scan(
    items: list[Item],
    *,
    topics: list[str],
    now: datetime,
    alpha: float = 0.02,
    beta: float = 0.1,
    cfg: AnalyzerConfig = DEFAULT,
) -> tuple[list[Finding], list[RadarFrame]]:
    """T12d radar scan: the findings of detect(items, alpha=, beta=, cfg=, now=now) plus one RadarFrame
    per topic in `topics` (also for a topic without posts in the window), from the same single run."""
    stats: dict[str, dict] = {}
    findings = _run(items, alpha=alpha, beta=beta, cfg=cfg, now=now, stats=stats)
    upper, lower = sprt.thresholds(alpha, beta)
    frames = []
    for topic in topics:
        st = stats.get(topic, {"n_items": 0, "n_accounts": 0, "n_lit_pairs": 0, "max_pair_z": None, "posts": {}})
        own = [f for f in findings if f.topic == topic]
        top = best_candidate(own)
        trace: list[tuple[datetime, float]] = []
        campaigns: list[str] = []
        if top is not None:
            posts = [st["posts"][i] for i in top.item_ids]  # time order, as the trace
            trace = [(it.published_at, llr) for it, llr in zip(posts, top.sprt_trace)]
            campaigns = sorted({it.campaign_id for it in posts if it.synthetic and it.campaign_id})
        frames.append(RadarFrame(
            topic=topic, at=now, n_items=st["n_items"], n_accounts=st["n_accounts"],
            n_lit_pairs=st["n_lit_pairs"], max_pair_z=st["max_pair_z"],
            n_watching=sum(f.verdict == "watching" for f in own),
            top_verdict=None if top is None else top.verdict,
            top_n_accounts=None if top is None else len(top.accounts),
            top_llr=None if top is None else top.llr,
            top_trace=trace,
            top_capped=top is not None and top.verdict != "coordinated" and bool(top.sprt_trace)
            and max(top.sprt_trace) >= upper - 1e-6,  # the trace is rounded to 1e-6, the decision is not
            sprt_upper=upper, sprt_lower=lower, top_campaign_ids=campaigns,
        ))
    return findings, frames


def _run(
    items: list[Item],
    *,
    alpha: float,
    beta: float,
    cfg: AnalyzerConfig,
    now: datetime | None,
    stats: dict[str, dict] | None,
) -> list[Finding]:
    if now is not None and (now.tzinfo is None or now.utcoffset() is None):
        raise ValueError("now must be timezone-aware")
    if now is not None:
        items = [it for it in items if it.published_at <= now]  # not published yet: not seen yet
        items = drop_expired_synthetic(items, now, cfg.synthetic_ttl_sec)
    if not items:
        return []
    cfg = replace(cfg, alpha=alpha, beta=beta)
    sprt.thresholds(alpha, beta)  # validate early
    by_topic: dict[str, list[Item]] = defaultdict(list)
    for it in items:
        by_topic[it.topic].append(it)

    ordered = {topic: sorted(group, key=lambda it: (it.published_at, it.id)) for topic, group in by_topic.items()}
    flat = [it for group in ordered.values() for it in group]
    E, backend = embed_with_backend([it.text for it in flat])
    cfg = cfg.for_embedder(backend)
    now = now or datetime.now(timezone.utc)

    findings: list[Finding] = []
    start = 0
    for topic, group in ordered.items():
        st = None
        if stats is not None:
            st = stats[topic] = {"n_items": len(group), "n_accounts": len({it.author for it in group}),
                                 "n_lit_pairs": 0, "max_pair_z": None, "posts": {it.id: it for it in group}}
        findings.extend(_detect_topic(topic, group, E[start : start + len(group)], now, cfg, st))
        start += len(group)
    return findings


def drop_expired_synthetic(items: list[Item], now: datetime, ttl_sec: float) -> list[Item]:
    """Items without the synthetic campaigns whose newest post is older than now - ttl_sec.

    The age is that of the campaign's newest post, not of the inject click: make_campaign backdates
    the posts into [click - 15 min, click] and the newest one lands ~4-6 min before the click. So
    the whole campaign counts until newest post + ttl_sec (900 s -> ~9-11 min after the click), then
    leaves at once. A synthetic item without campaign_id is its own campaign.
    """
    def key(it: Item) -> str:
        return it.campaign_id or it.id

    newest: dict[str, datetime] = {}
    for it in items:
        if it.synthetic:
            newest[key(it)] = max(newest.get(key(it), it.published_at), it.published_at)
    cutoff = now - timedelta(seconds=ttl_sec)
    return [it for it in items if not it.synthetic or newest[key(it)] >= cutoff]


def _detect_topic(
    topic: str, items: list[Item], E: np.ndarray, now: datetime, cfg: AnalyzerConfig, stats: dict | None = None
) -> list[Finding]:
    authors = [it.author for it in items]
    if len(set(authors)) < cfg.min_swarm_accounts:
        return []
    t0 = items[0].published_at
    t = np.array([(it.published_at - t0).total_seconds() for it in items])
    sig = topic_signal(E, t, authors, cfg)
    R, lag = pair_correlation(sig, cfg)
    z = cfar.pair_z(R, cfg)
    if stats is not None and len(sig.accounts) >= 2:  # radar background: lit pairs and the loudest pair
        upper = z[np.triu_indices(len(sig.accounts), k=1)]
        stats["n_lit_pairs"] = int((upper > cfg.cfar_k).sum())
        stats["max_pair_z"] = round(float(upper.max()), 3)
    groups = cfar.swarm_groups(z, cfg)
    if not groups:
        return []

    echo_all = sprt.echo(sig, None, cfg)
    is_news = np.array([it.source == "context_news" for it in items])
    has_social = any(it.source == "context_social" for it in items)  # False: [ALT] news-only stream
    is_stream = np.array([it.source != "synthetic" for it in items])  # live posts (viral echo prior spread)
    texts = [it.text for it in items]
    pair_bins = _pair_bins(sig, cfg)

    # SPRT reference = posts of accounts in NO candidate group: another swarm in the topic (e.g. a
    # second inject) would otherwise raise mu0 and mask this one (other targets censored from CFAR cells).
    in_any = np.zeros(len(sig.accounts), dtype=bool)
    for g in groups:
        in_any[list(g)] = True
    censored = in_any[sig.acct]

    out: list[Finding] = []
    used: set[str] = set()
    for group in groups:
        members = np.zeros(len(sig.accounts), dtype=bool)
        members[group] = True
        posts = np.flatnonzero(members[sig.acct])  # time order
        mu0, sigma = sprt.background(echo_all[~censored], cfg)
        x = sprt.echo(sig, members, cfg)[posts]
        res = sprt.run(x, mu0, sigma, alpha=cfg.alpha, beta=cfg.beta, cfg=cfg)
        note = (
            news_reprint_note(is_news, texts, posts, cfg)
            or news_echo_note(sig, is_news, texts, posts, cfg, has_social=has_social)
            or viral_echo_note(sig, is_news, is_stream, texts, posts, members, cfg, has_social=has_social)
        )
        verdict, decided = res.verdict, res.decided_at
        if note is not None and verdict == "coordinated":
            verdict, decided = "watching", None

        # The decision above is for the whole group; each wave reports its own posts, accounts and
        # its slice [a, b) of the group's SPRT trace (empty for a wave after the decision).
        for a, b in split_waves(sig, posts, cfg):
            wave = posts[a:b]
            idx = sorted(set(sig.acct[wave].tolist()))  # accounts in order of their first post in the topic
            in_wave = np.zeros(sig.n_posts, dtype=bool)
            in_wave[wave] = True
            accounts = [sig.accounts[k] for k in idx]
            integ = cfar.integrate(z, idx)
            group_items = [items[p] for p in wave]
            first_seen = min(it.published_at for it in group_items)
            last_seen = max(it.published_at for it in group_items)
            fid = finding_id(topic, accounts)
            if fid in used:  # the same accounts posted an earlier wave: the wave start tells them apart
                fid = finding_id(topic, accounts + [f"wave@{first_seen.isoformat()}"])
            used.add(fid)
            out.append(
                Finding(
                    id=fid,
                    topic=topic,
                    created_at=max(now, last_seen),
                    verdict=verdict,
                    accounts=accounts,
                    item_ids=[it.id for it in group_items],
                    llr=round(res.llr, 4),
                    snr_db=round(integ.snr_db, 2),
                    snr_db_single=round(integ.snr_db_single, 2),
                    sprt_trace=res.trace[a:b],
                    sprt_upper=res.upper,
                    sprt_lower=res.lower,
                    decided_at_item=decided - a if decided is not None and a <= decided < b else None,
                    first_seen=first_seen,
                    last_seen=last_seen,
                    correlation=[[round(float(R[i, j]), 4) for j in idx] for i in idx],
                    lag_sec=[[float(lag[i, j]) for j in idx] for i in idx],
                    synthetic=any(it.synthetic for it in group_items),
                    ambiguity=_ambiguity(pair_bins, in_wave, cfg),
                    note=note,
                )
            )
    return out


def split_waves(sig: TopicSignal, posts: np.ndarray, cfg: AnalyzerConfig) -> list[tuple[int, int]]:
    """Cut a group's posts (indices in time order) into waves at pauses longer than cfg.wave_gap_sec.

    Returns [a, b) ranges into `posts`. Only waves with >= min_swarm_accounts accounts are kept
    (stragglers between waves are dropped); if no wave is that large (a slow drip), or
    wave_gap_sec <= 0, the group stays whole.
    """
    whole = [(0, len(posts))]
    if cfg.wave_gap_sec <= 0 or len(posts) < 2:
        return whole
    cuts = (np.flatnonzero(np.diff(sig.t[posts]) > cfg.wave_gap_sec) + 1).tolist()
    spans = list(zip([0, *cuts], [*cuts, len(posts)]))
    waves = [(a, b) for a, b in spans if len(set(sig.acct[posts[a:b]].tolist())) >= cfg.min_swarm_accounts]
    return waves or whole


def _pair_bins(sig: TopicSignal, cfg: AnalyzerConfig) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Cross-account post pairs with |lag| <= tau_max: (post p, post q, |lag|, mismatch)."""
    require_window(sig, cfg)
    near = sig.pair_dt <= cfg.tau_max_sec  # near pairs are already cross-account
    p, q, dt = sig.pair_p[near], sig.pair_q[near], sig.pair_dt[near]
    mismatch = 1.0 - np.clip(sig.pair_cos[near], 0.0, 1.0)
    return p, q, dt, mismatch


def _ambiguity(pair_bins, members: np.ndarray, cfg: AnalyzerConfig) -> AmbiguityMap:
    """Lag x semantic-mismatch histogram: pairs inside the group vs all other pairs (docs 3.9).

    members: bool mask over posts (the posts of the wave)."""
    ap, aq, dt, mismatch = pair_bins
    lag_edges = [float(k * cfg.lag_step_sec) for k in range(n_lag_steps(cfg) + 1)]
    if lag_edges[-1] < cfg.tau_max_sec:  # tau_max not a multiple of the step: shorter last bin
        lag_edges.append(float(cfg.tau_max_sec))
    if len(lag_edges) < 2:  # degenerate tau_max <= 0: keep a valid one-bin grid
        lag_edges.append(float(cfg.lag_step_sec))
    inside = members[ap] & members[aq]

    def hist(mask: np.ndarray) -> list[list[int]]:
        h, _, _ = np.histogram2d(mismatch[mask], dt[mask], bins=[MISMATCH_EDGES, lag_edges])
        return h.astype(int).tolist()

    return AmbiguityMap(
        lag_edges_sec=lag_edges, mismatch_edges=MISMATCH_EDGES, counts=hist(inside), background=hist(~inside)
    )
