"""Swarm detector entry point (P2).

Intended stages (radar analogy):
  1. Embed item texts (Gemini embeddings), group by topic.            [T7]
  2. Matched filter: cosine similarity vs per-topic template bank,
     per-account time series of filter output.                         [T7]
  3. Account cross-correlation over lags -> pairwise peak matrix.      [T10]
  4. CFAR: adaptive threshold vs local background -> candidate groups,
     SNR in dB.                                                        [T10]
  5. SPRT (Wald) on per-item LLR with error rates alpha/beta ->
     verdict coordinated / organic / watching, sprt_trace.             [T10]
  6. Emit Finding objects (explanation is filled later by P1, T11).
"""

from __future__ import annotations

from contracts.models import Finding, Item


def detect(items: list[Item], *, alpha: float = 0.02, beta: float = 0.1) -> list[Finding]:
    """Run the detector over items and return findings.

    alpha: target false-alarm probability (SPRT upper threshold A = (1-beta)/alpha).
    beta: target miss probability (SPRT lower threshold B = beta/(1-alpha)).
    """
    raise NotImplementedError("T7/T10")
