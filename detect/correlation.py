"""Pair correlator in time x meaning: docs/signal-processing.md 3.4.

For posts p (account i) and q (account j) the semantic closeness is
c_pq = sqrt(b_p * b_q) * max(0, <e~_p, e~_q>) (b = beam gain, e~ = whitened code),
the delay is dt_pq = t_q - t_p. Then

    R_ij(tau) = sum_{p,q} c_pq * g(dt_pq - tau) / sqrt(n_i * n_j)    g = window of width lag_step
    R_ij      = max_{|tau| <= tau_max} w(tau) * R_ij(tau)              w(tau) = exp(-|tau| / lag_kernel)
    lag_ij    = tau at the maximum (positive: j posts after i)

Only post pairs close in time ever matter (the lag grid, the SPRT echo and the ambiguity map all stop
near tau_max), so the signal keeps a sparse list of near pairs instead of an (n, n) matrix: memory and
time grow with n * (posts per window), not n^2.
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
    # Near pairs: posts p < q (time order) of different accounts with t_q - t_p <= pair_window_sec(cfg).
    pair_p: np.ndarray  # (m,) int
    pair_q: np.ndarray  # (m,) int
    pair_dt: np.ndarray  # (m,) t_q - t_p >= 0
    pair_cos: np.ndarray  # (m,) <e~_p, e~_q> (raw, may be negative)
    pair_close: np.ndarray  # (m,) c_pq = sqrt(b_p * b_q) * max(0, cos)

    @property
    def n_posts(self) -> int:
        return len(self.t)


PAIR_BLOCK = 256  # posts per block in near_pairs: the dense product is at most block x (block + window)


def n_lag_steps(cfg: AnalyzerConfig = DEFAULT) -> int:
    """Whole lag steps inside tau_max (the grid never goes past tau_max)."""
    return int(np.floor(cfg.tau_max_sec / cfg.lag_step_sec + 1e-9))


def pair_window_sec(cfg: AnalyzerConfig = DEFAULT) -> float:
    """Widest time gap any stage reads: tau_max (echo, ambiguity) and the outer edge of the last lag cell."""
    return max(cfg.tau_max_sec, (n_lag_steps(cfg) + 1) * cfg.lag_step_sec)


def build_signal(
    t: np.ndarray, acct: np.ndarray, accounts: list[str], gain: np.ndarray, code: np.ndarray,
    cfg: AnalyzerConfig = DEFAULT,
) -> TopicSignal:
    """TopicSignal from per-post arrays (posts in time order) with its near pairs.

    Blocks of PAIR_BLOCK posts are multiplied only with the posts that follow them within the window,
    so the full (n, n) product is never built.
    """
    t = np.asarray(t, dtype=np.float64)
    acct = np.asarray(acct, dtype=np.int64)
    gain = np.asarray(gain, dtype=np.float64)
    code = np.asarray(code, dtype=np.float64)
    n, window = len(t), pair_window_sec(cfg)
    if n > 1 and np.any(np.diff(t) < 0):
        raise ValueError("posts must be in time order")
    ps, qs, coss = [], [], []
    for start in range(0, n, PAIR_BLOCK):
        stop = min(start + PAIR_BLOCK, n)
        end = int(np.searchsorted(t, t[stop - 1] + window, side="right"))
        rows, cols = np.arange(start, stop)[:, None], np.arange(start, end)[None, :]
        mask = (cols > rows) & (t[cols] - t[rows] <= window) & (acct[rows] != acct[cols])
        r, c = np.nonzero(mask)
        cos = code[start:stop] @ code[start:end].T  # rows: p in the block, columns: q in [start, end)
        ps.append(r + start)
        qs.append(c + start)
        coss.append(cos[r, c])
    if ps:
        p, q, cos = np.concatenate(ps), np.concatenate(qs), np.concatenate(coss)
    else:
        p = q = np.zeros(0, dtype=np.int64)
        cos = np.zeros(0)
    close = np.sqrt(gain[p] * gain[q]) * np.clip(cos, 0.0, None)
    return TopicSignal(t=t, acct=acct, accounts=accounts, gain=gain, code=code,
                       pair_p=p, pair_q=q, pair_dt=t[q] - t[p], pair_cos=cos, pair_close=close)


def topic_signal(E: np.ndarray, t: np.ndarray, authors: list[str], cfg: AnalyzerConfig = DEFAULT) -> TopicSignal:
    """Build the topic signal from embeddings E (rows in time order), times t (s) and authors."""
    E = np.asarray(E, dtype=np.float64)
    accounts = list(dict.fromkeys(authors))
    index = {a: k for k, a in enumerate(accounts)}
    acct = np.array([index[a] for a in authors], dtype=np.int64)
    a = steering_vector(E, authors, cfg)
    return build_signal(t, acct, accounts, beam_gain(E, a, cfg), whiten(E, a, cfg), cfg)


def lag_grid(cfg: AnalyzerConfig = DEFAULT) -> np.ndarray:
    """Lag cells tau = -tau_max .. +tau_max with step lag_step_sec."""
    half = n_lag_steps(cfg)
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

    keep = sig.pair_close > 0  # p earlier than q (time order); pairs beyond the window fall outside the lag grid
    p, q, c, dt = sig.pair_p[keep], sig.pair_q[keep], sig.pair_close[keep], sig.pair_dt[keep]
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
