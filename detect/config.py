"""Analyzer parameters: the single list from docs/signal-processing.md section 3.12.

T7 uses only the beam thresholds (c_lo, c_hi) and whiten_eps; the rest is here so
that every stage (T10) reads its numbers from one place.
"""

from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class AnalyzerConfig:
    # Detector window (worker reads DETECT_WINDOW_HOURS; this is the default).
    window_hours: float = 6.0

    # Topic beam (3.2a): gain b = clip((<e, a> - c_lo) / (c_hi - c_lo), 0, 1).
    # c_lo/c_hi are for the hashing embedder (tests, fallback); Gemini cosines live on another
    # scale, so detect() switches to gemini_c_lo/gemini_c_hi when Gemini produced the vectors
    # (for_embedder). Gemini values: `python -m detect.calibrate_beam` on fixtures (sat 14.11);
    # recheck on the live sample (T15).
    c_lo: float = 0.15
    c_hi: float = 0.35
    gemini_c_lo: float = 0.81
    gemini_c_hi: float = 0.88
    # Share of accounts (least aligned with the beam) dropped by the robust mean.
    beam_trim: float = 0.2
    # Whitening (3.3): residual norm below this -> zero vector ("pure topic" post).
    whiten_eps: float = 1e-3

    # Pair correlator (3.4).
    tau_max_sec: float = 600.0
    lag_step_sec: float = 30.0
    lag_kernel_sec: float = 120.0  # w(tau) = exp(-|tau| / lag_kernel_sec)

    # CFAR over account pairs (3.5) and swarm assembly (3.6).
    cfar_k: float = 3.0  # threshold in MAD sigmas
    cfar_sigma_floor: float = 0.05
    # Minimum reference cells: a sparse topic is padded with R = 0 pairs (the H0 value of
    # two unrelated accounts), so a swarm that is most of a quiet topic cannot become its own background.
    cfar_min_ref_cells: int = 200
    min_swarm_accounts: int = 3

    # SPRT (3.7).
    alpha: float = 0.02
    beta: float = 0.1
    sprt_mu1: float = 0.5
    sprt_llr_clip: tuple[float, float] = (-1.0, 1.5)
    sprt_sigma_floor: float = 0.15
    # H0 echo is measured on posts of accounts OUTSIDE the group under test (guard cells),
    # padded with echo = 0 (an isolated post) up to this many posts in a quiet topic.
    sprt_min_ref_posts: int = 30

    # News echo (3.8).
    news_echo_cos: float = 0.8
    news_echo_max_age_sec: float = 3600.0
    news_echo_enabled: bool = True

    def for_embedder(self, backend: str) -> AnalyzerConfig:
        """Same config with the beam thresholds of the embedder that produced the vectors."""
        if backend == "gemini":
            return replace(self, c_lo=self.gemini_c_lo, c_hi=self.gemini_c_hi)
        return self


DEFAULT = AnalyzerConfig()
# Optional second, "slow" analyzer (3.12): same numbers, wider lag window.
SLOW = AnalyzerConfig(tau_max_sec=3600.0)
