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
    # (for_embedder). Gemini values: `python -m detect.calibrate_beam` on fixtures (sat 14.11):
    # off-topic q50 / q90 on the organic beam. The earlier 0.81/0.88 cut the gain of on-topic
    # swarm posts in half (eval/report.json pd_by_size, 3 accounts: 0.28 -> 0.60).
    # T15 (sat 14.11): same rule on live data (--items items_live_sample.json + items_live_background.json,
    # 289 organic posts, 6 topics) gives 0.78 / 0.80. Eval windows (alpha 2%): 0 / 313 background alarms
    # either way; Pd of a 3 / 4-account swarm 0.57 / 0.86 -> 0.94 / 0.99 (0.81 / 0.83 left attack posts
    # that name the topic at the edge of the beam).
    c_lo: float = 0.15
    c_hi: float = 0.35
    gemini_c_lo: float = 0.78
    gemini_c_hi: float = 0.80
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
    # 2000 (was 200): two or three demo injects in one live topic (24-36 accounts, 276-630 pairs) are
    # still a "quiet" topic, otherwise the swarm pairs outnumber the padding and become the background.
    # Topics above ~1000 pairs (~45 accounts) keep the background median (busy topic, test_detect_swarm).
    cfar_min_ref_cells: int = 2000
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

    # Injected campaigns count for detection this long after their newest post, then drop out, so
    # repeated demo injects do not pile up in the window. Applied only when detect() gets `now`.
    # Measured from the newest post, which make_campaign puts ~4-6 min before the click: 900 s keeps
    # an inject in effect ~9-11 min after the click (target ~10 min).
    synthetic_ttl_sec: float = 900.0

    # News echo (3.8).
    news_echo_cos: float = 0.8
    news_echo_max_age_sec: float = 3600.0
    news_echo_enabled: bool = True
    # News reprint (3.8): a group made only of context_news articles is capped at "watching".
    news_reprint_enabled: bool = True
    # Viral echo (3.8, T6b): >= viral_echo_min_accounts outside accounts of the live stream posted the group's
    # message (cos > viral_echo_cos) within viral_echo_max_age_sec before its first post -> "watching".
    viral_echo_cos: float = 0.8
    viral_echo_min_accounts: int = 3
    viral_echo_max_age_sec: float = 6 * 3600.0
    viral_echo_enabled: bool = True

    def for_embedder(self, backend: str) -> AnalyzerConfig:
        """Same config with the beam thresholds of the embedder that produced the vectors."""
        if backend == "gemini":
            return replace(self, c_lo=self.gemini_c_lo, c_hi=self.gemini_c_hi)
        return self


DEFAULT = AnalyzerConfig()
# Optional second, "slow" analyzer (3.12): same numbers, wider lag window.
SLOW = AnalyzerConfig(tau_max_sec=3600.0)
