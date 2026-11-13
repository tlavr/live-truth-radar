"""Swarm detector entry point (P2).

Intended stages (radar analogy):
  1. Embed item texts (Gemini embeddings), group by topic.            [T7]
  2. Topic beam (steering vector, main-lobe gain) and whitening:
     remove the projection on the beam, keep the residual "code".      [T7]
  3. Pair correlator in time x meaning over lags -> R and lag
     matrices (no template bank).                                      [T10]
  4. CFAR over all account pairs of the topic (median / MAD with a
     floor) -> groups of >= 3 accounts, coherent integration, SNR dB.  [T10]
  5. SPRT (Wald) on the causal per-post "echo" feature with error
     rates alpha/beta -> coordinated / organic / watching, sprt_trace;
     news-echo check caps a group at "watching".                       [T10]
  6. Emit Finding objects with the ambiguity map and note
     (explanation is filled later by P1, T11).

Design and parameters: docs/signal-processing.md section 3.
"""

from __future__ import annotations

from contracts.models import Finding, Item


def detect(items: list[Item], *, alpha: float = 0.02, beta: float = 0.1) -> list[Finding]:
    """Run the detector over items and return findings.

    alpha: target false-alarm probability (SPRT upper threshold A = (1-beta)/alpha).
    beta: target miss probability (SPRT lower threshold B = beta/(1-alpha)).
    """
    raise NotImplementedError("T7/T10")
