"""Sequential decision (Wald SPRT) on the causal "echo" feature: docs/signal-processing.md 3.7.

Echo of post p: x_p = max over EARLIER posts q of other accounts (0 <= t_p - t_q <= tau_max)
of c_pq * exp(-(t_p - t_q) / lag_kernel). It only looks back, so it works in real time.

H0: x ~ N(mu0, sigma^2), mu0 and sigma measured robustly on the posts of the topic's
other accounts (the group under test is left out, like guard cells in CFAR; a quiet topic is
padded with echo = 0 up to sprt_min_ref_posts);
H1: x ~ N(mu1, sigma^2), mu1 = design "minimum target".
dLLR = (mu1 - mu0) / sigma^2 * (x - (mu0 + mu1) / 2), clipped to sprt_llr_clip.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np

from detect.cfar import robust_scale
from detect.config import DEFAULT, AnalyzerConfig
from detect.correlation import TopicSignal


def thresholds(alpha: float, beta: float) -> tuple[float, float]:
    """(upper, lower) = (ln((1-beta)/alpha), ln(beta/(1-alpha)))."""
    if not (0 < alpha < 1 and 0 < beta < 1) or alpha + beta >= 1:
        raise ValueError("need 0 < alpha, beta < 1 and alpha + beta < 1")
    return math.log((1 - beta) / alpha), math.log(beta / (1 - alpha))


def echo(sig: TopicSignal, members: np.ndarray | None = None, cfg: AnalyzerConfig = DEFAULT) -> np.ndarray:
    """Causal echo x_p of every post. members: bool mask over accounts; None = all accounts.

    With a mask, only earlier posts of member accounts count as possible sources.
    """
    n = sig.n_posts
    x = np.zeros(n)
    if n < 2:
        return x
    dt = sig.t[:, None] - sig.t[None, :]  # dt[p, q] = t_p - t_q
    earlier = np.tril(np.ones((n, n), dtype=bool), k=-1)  # q comes before p in time order
    ok = earlier & (dt >= 0) & (dt <= cfg.tau_max_sec)
    if members is not None:
        ok &= members[sig.acct][None, :]
    contrib = np.where(ok, sig.close * np.exp(-np.clip(dt, 0.0, None) / cfg.lag_kernel_sec), 0.0)
    return contrib.max(axis=1)


def background(x_ref: np.ndarray, cfg: AnalyzerConfig = DEFAULT) -> tuple[float, float]:
    """(mu0, sigma) of the echo under H0: median and floored MAD over the reference posts.

    x_ref: echo of the posts outside the group under test; padded with zeros (isolated
    posts) up to cfg.sprt_min_ref_posts, so a swarm in a quiet topic is not its own background.
    """
    x_ref = np.asarray(x_ref, dtype=np.float64)
    if x_ref.size < cfg.sprt_min_ref_posts:
        x_ref = np.concatenate([x_ref, np.zeros(cfg.sprt_min_ref_posts - x_ref.size)])
    return robust_scale(x_ref, cfg.sprt_sigma_floor)


@dataclass(frozen=True)
class SprtResult:
    trace: list[float]  # cumulative LLR after each post (first post: 0); stops at the decision
    verdict: Literal["coordinated", "organic", "watching"]
    llr: float
    decided_at: int | None  # index into trace where a threshold was crossed
    upper: float
    lower: float


def run(x: np.ndarray, mu0: float, sigma: float, *, alpha: float, beta: float, cfg: AnalyzerConfig = DEFAULT) -> SprtResult:
    """SPRT over the group's posts in time order; x[0] (first post, the "probe") is not an observation."""
    upper, lower = thresholds(alpha, beta)
    # Guard: a topic whose background echo already reaches the target keeps a positive slope.
    mu1 = cfg.sprt_mu1 if cfg.sprt_mu1 > mu0 else mu0 + sigma
    slope = (mu1 - mu0) / sigma**2
    mid = (mu0 + mu1) / 2
    lo, hi = cfg.sprt_llr_clip
    llr = 0.0
    trace: list[float] = []
    for k, xk in enumerate(np.asarray(x, dtype=np.float64)):
        if k > 0:
            llr += float(np.clip(slope * (xk - mid), lo, hi))
        trace.append(round(llr, 6))
        if llr >= upper:
            return SprtResult(trace, "coordinated", llr, k, upper, lower)
        if llr <= lower:
            return SprtResult(trace, "organic", llr, k, upper, lower)
    return SprtResult(trace, "watching", llr, None, upper, lower)
