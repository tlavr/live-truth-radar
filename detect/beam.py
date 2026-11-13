"""Topic beam (beamforming) and clutter rejection: docs/signal-processing.md 3.2a, 3.3.

Every post embedding e is split in two parts relative to the topic steering
vector a: the projection <e, a> says "is the post on topic?" (beam gain), the
residual e - <e, a>*a carries the "code" used by the pair correlator.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from detect.config import DEFAULT, AnalyzerConfig


def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else np.zeros_like(v)


def steering_vector(E: np.ndarray, accounts: Sequence[str], cfg: AnalyzerConfig = DEFAULT) -> np.ndarray:
    """Unit steering vector of the topic: robust mean with one vote per account.

    Posts are averaged per account first, so a swarm that posts a lot cannot pull
    the beam onto itself; then the accounts least aligned with the current beam
    (share cfg.beam_trim) are dropped and the mean is recomputed.
    """
    E = np.asarray(E, dtype=np.float64)
    if E.shape[0] != len(accounts):
        raise ValueError("accounts must have one entry per row of E")
    if E.shape[0] == 0:
        return np.zeros(E.shape[1] if E.ndim == 2 else 0)

    _, inverse = np.unique(np.asarray(accounts, dtype=object).astype(str), return_inverse=True)
    votes = np.zeros((inverse.max() + 1, E.shape[1]))
    np.add.at(votes, inverse, E)
    norms = np.linalg.norm(votes, axis=1, keepdims=True)
    votes = np.divide(votes, norms, out=np.zeros_like(votes), where=norms > 0)

    a = _unit(votes.mean(axis=0))
    n_keep = max(1, int(np.ceil(len(votes) * (1.0 - cfg.beam_trim))))
    if n_keep < len(votes):
        for _ in range(2):
            keep = np.argsort(votes @ a)[-n_keep:]
            a = _unit(votes[keep].mean(axis=0))
    return a


def beam_gain(E: np.ndarray, a: np.ndarray, cfg: AnalyzerConfig = DEFAULT) -> np.ndarray:
    """Per-post beam gain b in [0, 1]: 1 in the main lobe (on topic), 0 in the side lobes."""
    proj = np.asarray(E, dtype=np.float64) @ a
    return np.clip((proj - cfg.c_lo) / (cfg.c_hi - cfg.c_lo), 0.0, 1.0)


def whiten(E: np.ndarray, a: np.ndarray, cfg: AnalyzerConfig = DEFAULT) -> np.ndarray:
    """Remove the projection on the beam and normalize the residual.

    A post that is (almost) entirely "common topic" becomes the zero vector and
    therefore correlates with nobody.
    """
    E = np.asarray(E, dtype=np.float64)
    residual = E - np.outer(E @ a, a)
    norms = np.linalg.norm(residual, axis=1, keepdims=True)
    return np.divide(residual, norms, out=np.zeros_like(residual), where=norms > cfg.whiten_eps)
