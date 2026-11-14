"""Radar frame (T12d): one detector snapshot of one topic for the live /live chart.

detect.pipeline.scan() returns one RadarFrame per requested topic next to the findings; P1 stores
it (radar_frames) and serves it from GET /api/radar. Not a contract model: P1 only passes it on.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from contracts.models import Finding

VERDICT_RANK = {"coordinated": 2, "watching": 1, "organic": 0}


class RadarFrame(BaseModel):
    topic: str
    at: datetime  # scan time (now)
    n_items: int  # posts in the window (after future / expired-synthetic posts are dropped)
    n_accounts: int
    n_lit_pairs: int  # account pairs above the CFAR threshold (z > k); 0 below min_swarm_accounts
    max_pair_z: float | None  # largest pair z; None below min_swarm_accounts accounts (no CFAR run)
    n_watching: int  # candidates held at "watching" (news echo / reprint, undecided)
    top_verdict: Literal["coordinated", "watching", "organic"] | None  # best candidate: coordinated > watching > organic, then llr, then size
    top_n_accounts: int | None
    top_llr: float | None
    top_trace: list[tuple[datetime, float]]  # SPRT trace of the best candidate against its posts' times
    top_capped: bool  # trace reached sprt_upper but the verdict was capped (news echo / reprint)
    sprt_upper: float
    sprt_lower: float
    top_campaign_ids: list[str]  # campaign ids of the synthetic posts in the best candidate


def best_candidate(findings: list[Finding]) -> Finding | None:
    """coordinated > watching > organic, then the larger llr, then more accounts."""
    return max(findings, key=lambda f: (VERDICT_RANK[f.verdict], f.llr, len(f.accounts)), default=None)
