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
     news-echo check caps a group at "watching".                       [detect.sprt, detect.news_echo]
  6. Emit Finding objects with the ambiguity map and note
     (explanation is filled later by P1, T11).

Design and parameters: docs/signal-processing.md section 3.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timezone

import numpy as np

from contracts.models import AmbiguityMap, Finding, Item, finding_id
from detect import cfar, sprt
from detect.config import DEFAULT, AnalyzerConfig
from detect.correlation import TopicSignal, n_lag_steps, pair_correlation, topic_signal
from detect.embed import embed_with_backend
from detect.news_echo import news_echo_note

MISMATCH_EDGES = [round(0.1 * k, 1) for k in range(11)]


def detect(
    items: list[Item], *, alpha: float = 0.02, beta: float = 0.1, cfg: AnalyzerConfig = DEFAULT
) -> list[Finding]:
    """Run the detector over items and return findings (one per swarm candidate group).

    alpha: target false-alarm probability (SPRT upper threshold A = (1-beta)/alpha).
    beta: target miss probability (SPRT lower threshold B = beta/(1-alpha)).
    cfg: analyzer parameters (eval sweeps cfar_k through it); its alpha/beta are overridden.
    """
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
    now = datetime.now(timezone.utc)

    findings: list[Finding] = []
    start = 0
    for topic, group in ordered.items():
        findings.extend(_detect_topic(topic, group, E[start : start + len(group)], now, cfg))
        start += len(group)
    return findings


def _detect_topic(topic: str, items: list[Item], E: np.ndarray, now: datetime, cfg: AnalyzerConfig) -> list[Finding]:
    authors = [it.author for it in items]
    if len(set(authors)) < cfg.min_swarm_accounts:
        return []
    t0 = items[0].published_at
    t = np.array([(it.published_at - t0).total_seconds() for it in items])
    sig = topic_signal(E, t, authors, cfg)
    R, lag = pair_correlation(sig, cfg)
    z = cfar.pair_z(R, cfg)
    groups = cfar.swarm_groups(z, cfg)
    if not groups:
        return []

    echo_all = sprt.echo(sig, None, cfg)
    is_news = np.array([it.source == "context_news" for it in items])
    has_social = any(it.source == "context_social" for it in items)  # False: [ALT] news-only stream
    texts = [it.text for it in items]
    pair_bins = _pair_bins(sig, cfg)

    out: list[Finding] = []
    for group in groups:
        members = np.zeros(len(sig.accounts), dtype=bool)
        members[group] = True
        in_group = members[sig.acct]
        posts = np.flatnonzero(in_group)  # time order
        mu0, sigma = sprt.background(echo_all[~in_group], cfg)
        x = sprt.echo(sig, members, cfg)[posts]
        res = sprt.run(x, mu0, sigma, alpha=cfg.alpha, beta=cfg.beta, cfg=cfg)
        note = news_echo_note(sig, is_news, texts, posts, cfg, has_social=has_social)
        verdict, decided = res.verdict, res.decided_at
        if note is not None and verdict == "coordinated":
            verdict, decided = "watching", None

        # Accounts in order of their first post (sig.accounts is already in that order).
        idx = sorted(group)
        accounts = [sig.accounts[k] for k in idx]
        integ = cfar.integrate(z, idx)
        group_items = [items[p] for p in posts]
        last_seen = max(it.published_at for it in group_items)
        out.append(
            Finding(
                id=finding_id(topic, accounts),
                topic=topic,
                created_at=max(now, last_seen),
                verdict=verdict,
                accounts=accounts,
                item_ids=[it.id for it in group_items],
                llr=round(res.llr, 4),
                snr_db=round(integ.snr_db, 2),
                snr_db_single=round(integ.snr_db_single, 2),
                sprt_trace=res.trace,
                sprt_upper=res.upper,
                sprt_lower=res.lower,
                decided_at_item=decided,
                first_seen=min(it.published_at for it in group_items),
                last_seen=last_seen,
                correlation=[[round(float(R[a, b]), 4) for b in idx] for a in idx],
                lag_sec=[[float(lag[a, b]) for b in idx] for a in idx],
                synthetic=any(it.synthetic for it in group_items),
                ambiguity=_ambiguity(pair_bins, members, cfg),
                note=note,
            )
        )
    return out


def _pair_bins(sig: TopicSignal, cfg: AnalyzerConfig) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Cross-account post pairs with |lag| <= tau_max: (account p, account q, |lag|, mismatch)."""
    p, q = np.triu_indices(sig.n_posts, k=1)
    keep = sig.acct[p] != sig.acct[q]
    p, q = p[keep], q[keep]
    dt = np.abs(sig.t[q] - sig.t[p])
    near = dt <= cfg.tau_max_sec
    p, q, dt = p[near], q[near], dt[near]
    cos = np.einsum("ij,ij->i", sig.code[p], sig.code[q]) if len(p) else np.zeros(0)
    mismatch = 1.0 - np.clip(cos, 0.0, 1.0)
    return sig.acct[p], sig.acct[q], dt, mismatch


def _ambiguity(pair_bins, members: np.ndarray, cfg: AnalyzerConfig) -> AmbiguityMap:
    """Lag x semantic-mismatch histogram: pairs inside the group vs all other pairs (docs 3.9)."""
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
