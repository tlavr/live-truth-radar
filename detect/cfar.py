"""CFAR over account pairs and swarm assembly: docs/signal-processing.md 3.5, 3.6.

Reference cells = all account pairs of the topic window (order-statistic CFAR):
z_ij = (R_ij - median) / max(1.4826 * MAD, sigma_floor). A pair "lights up" when
z_ij > k; a swarm is a connected group of >= min_swarm_accounts accounts in that
graph. Coherent integration over all M pairs of the group: Z = sum z / sqrt(M).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from detect.config import DEFAULT, AnalyzerConfig

MIN_LINEAR = 0.1  # floor for the dB conversion: 20*lg(0.1) = -20 dB


def robust_scale(x: np.ndarray, floor: float) -> tuple[float, float]:
    """(median, max(1.4826 * MAD, floor)); (0, floor) for an empty sample."""
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return 0.0, floor
    med = float(np.median(x))
    mad = float(np.median(np.abs(x - med)))
    return med, max(1.4826 * mad, floor)


def pair_z(R: np.ndarray, cfg: AnalyzerConfig = DEFAULT) -> np.ndarray:
    """z-score of every account pair against the background of all pairs; diagonal = 0."""
    n = R.shape[0]
    z = np.zeros_like(R, dtype=np.float64)
    if n < 2:
        return z
    iu = np.triu_indices(n, k=1)
    med, sigma = robust_scale(R[iu], cfg.cfar_sigma_floor)
    z = (R - med) / sigma
    np.fill_diagonal(z, 0.0)
    return z


def swarm_groups(z: np.ndarray, cfg: AnalyzerConfig = DEFAULT) -> list[list[int]]:
    """Connected components of the graph z > k with >= min_swarm_accounts nodes (sorted index lists)."""
    n = z.shape[0]
    adj = z > cfg.cfar_k
    np.fill_diagonal(adj, False)
    seen = np.zeros(n, dtype=bool)
    groups: list[list[int]] = []
    for start in range(n):
        if seen[start] or not adj[start].any():
            continue
        stack, comp = [start], []
        seen[start] = True
        while stack:
            v = stack.pop()
            comp.append(v)
            for u in np.flatnonzero(adj[v] & ~seen):
                seen[u] = True
                stack.append(int(u))
        if len(comp) >= cfg.min_swarm_accounts:
            groups.append(sorted(comp))
    return groups


@dataclass(frozen=True)
class Integration:
    Z: float  # coherent sum over all M pairs / sqrt(M)
    mean_z: float
    snr_db: float  # 20*lg(Z)
    snr_db_single: float  # 20*lg(mean z)


def _db(x: float) -> float:
    return 20.0 * math.log10(max(x, MIN_LINEAR))


def integrate(z: np.ndarray, group: list[int]) -> Integration:
    """Coherent integration over all pairs of the group (pairs without an edge included)."""
    idx = np.asarray(group)
    sub = z[np.ix_(idx, idx)]
    vals = sub[np.triu_indices(len(idx), k=1)]
    m = len(vals)
    if m == 0:
        return Integration(Z=0.0, mean_z=0.0, snr_db=_db(0.0), snr_db_single=_db(0.0))
    Z = float(vals.sum() / math.sqrt(m))
    mean_z = float(vals.mean())
    return Integration(Z=Z, mean_z=mean_z, snr_db=_db(Z), snr_db_single=_db(mean_z))
