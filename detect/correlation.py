"""Pair correlator in time x meaning: docs/signal-processing.md 3.4.

For posts p (account i) and q (account j) the semantic closeness is
c_pq = sqrt(b_p * b_q) * max(0, <e~_p, e~_q>) (b = beam gain, e~ = whitened code),
the delay is dt_pq = t_q - t_p. Then

    R_ij(tau) = sum_{p,q} c_pq * g(dt_pq - tau) / sqrt(n_i * n_j)    g = window of width lag_step
    R_ij      = max_{|tau| <= tau_max} w(tau) * R_ij(tau)              w(tau) = exp(-|tau| / lag_kernel)
    lag_ij    = tau at the maximum (positive: j posts after i)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from detect.beam import beam_gain, steering_vector, whiten
from detect.config import DEFAULT, AnalyzerConfig


@dataclass
class TopicSignal:
    """Vector signal of one topic window, posts sorted by time."""

    t: np.ndarray  # (n,) seconds since the first post
    acct: np.ndarray  # (n,) account index into `accounts`
    accounts: list[str]  # account names, in order of their first post
    gain: np.ndarray  # (n,) beam gain b
    code: np.ndarray  # (n, d) whitened unit residuals e~ (zero rows for "pure topic" posts)
    close: np.ndarray  # (n, n) c_pq, zero on the diagonal and between posts of one account

    @property
    def n_posts(self) -> int:
        return len(self.t)


def topic_signal(E: np.ndarray, t: np.ndarray, authors: list[str], cfg: AnalyzerConfig = DEFAULT) -> TopicSignal:
    """Build the topic signal from embeddings E (rows in time order), times t (s) and authors."""
    E = np.asarray(E, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)
    accounts = list(dict.fromkeys(authors))
    index = {a: k for k, a in enumerate(accounts)}
    acct = np.array([index[a] for a in authors], dtype=np.int64)
    a = steering_vector(E, authors, cfg)
    gain = beam_gain(E, a, cfg)
    code = whiten(E, a, cfg)
    close = np.sqrt(np.outer(gain, gain)) * np.clip(code @ code.T, 0.0, None)
    close[acct[:, None] == acct[None, :]] = 0.0  # same account (incl. diagonal) never correlates with itself
    return TopicSignal(t=t, acct=acct, accounts=accounts, gain=gain, code=code, close=close)


def lag_grid(cfg: AnalyzerConfig = DEFAULT) -> np.ndarray:
    """Lag cells tau = -tau_max .. +tau_max with step lag_step_sec."""
    half = round(cfg.tau_max_sec / cfg.lag_step_sec)
    return np.arange(-half, half + 1, dtype=np.float64) * cfg.lag_step_sec


def pair_correlation(sig: TopicSignal, cfg: AnalyzerConfig = DEFAULT) -> tuple[np.ndarray, np.ndarray]:
    """Account x account matrices (R, lag_sec): R symmetric, lag antisymmetric, diagonal R = 1, lag = 0."""
    n_acc = len(sig.accounts)
    R = np.zeros((n_acc, n_acc))
    lag = np.zeros((n_acc, n_acc))
    taus = lag_grid(cfg)
    half = (len(taus) - 1) // 2
    if n_acc:
        np.fill_diagonal(R, 1.0)
    if sig.n_posts < 2 or n_acc < 2:
        return R, lag

    p, q = np.triu_indices(sig.n_posts, k=1)  # p earlier than q (time order)
    c = sig.close[p, q]
    keep = c > 0
    p, q, c = p[keep], q[keep], c[keep]
    dt = sig.t[q] - sig.t[p]
    ai, aj = sig.acct[p], sig.acct[q]
    # Canonical pair i < j, delay measured as t(j) - t(i).
    swap = ai > aj
    i = np.where(swap, aj, ai)
    j = np.where(swap, ai, aj)
    delay = np.where(swap, -dt, dt)
    cell = np.floor(delay / cfg.lag_step_sec + 0.5).astype(np.int64) + half  # rectangular window of width lag_step
    inside = (cell >= 0) & (cell < len(taus))
    i, j, cell, c = i[inside], j[inside], cell[inside], c[inside]
    if len(c) == 0:
        return R, lag

    counts = np.bincount(sig.acct, minlength=n_acc).astype(np.float64)
    key = (i * n_acc + j) * len(taus) + cell
    ukey, inv = np.unique(key, return_inverse=True)
    acc = np.bincount(inv, weights=c)
    pi, rest = np.divmod(ukey, n_acc * len(taus))
    pj, pc = np.divmod(rest, len(taus))
    score = acc / np.sqrt(counts[pi] * counts[pj]) * np.exp(-np.abs(taus[pc]) / cfg.lag_kernel_sec)

    # Max over lag cells per account pair (ties -> the cell seen first, i.e. most negative lag).
    pair = pi * n_acc + pj
    order = np.lexsort((-score, pair))
    first = np.ones(len(order), dtype=bool)
    first[1:] = pair[order][1:] != pair[order][:-1]
    best = order[first]
    bi, bj, bs, bl = pi[best], pj[best], score[best], taus[pc[best]]
    R[bi, bj] = bs
    R[bj, bi] = bs
    lag[bi, bj] = bl
    lag[bj, bi] = -bl
    return R, lag
