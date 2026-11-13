"""Pydantic v2 models: the ONE contract between P1 (pipe) and P2 (brain).

Change only by agreement of both people.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class Item(BaseModel):
    """One public post / article, normalized from Context.dev or the synthetic generator."""

    id: str
    source: Literal["context_social", "context_news", "synthetic"]
    platform: str | None = None
    author: str
    published_at: datetime  # tz-aware UTC
    text: str
    url: str | None = None
    topic: str
    synthetic: bool = False
    campaign_id: str | None = None  # ground truth, only for synthetic items

    @field_validator("published_at")
    @classmethod
    def _tz_aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None or v.utcoffset() is None:
            raise ValueError("published_at must be timezone-aware")
        return v


class Explanation(BaseModel):
    """LLM (Gemini) explanation of a finding."""

    technique: str
    quote: str
    confidence: float = Field(ge=0.0, le=1.0)
    summary: str


def finding_id(topic: str, accounts: list[str]) -> str:
    """Stable Finding id: same topic + same account set -> same id (API dedups by id, latest wins)."""
    key = topic + "|" + ",".join(sorted(accounts))
    return "f-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


class Finding(BaseModel):
    """A detector decision about a group of accounts within a topic."""

    id: str  # use finding_id(topic, accounts)
    topic: str
    created_at: datetime
    verdict: Literal["coordinated", "organic", "watching"]
    accounts: list[str]
    item_ids: list[str]
    llr: float
    snr_db: float
    # sprt_trace[k] = cumulative LLR after item_ids[k] (time order); may stop at the decision,
    # so len(sprt_trace) <= len(item_ids).
    sprt_trace: list[float]
    sprt_upper: float  # ln((1-beta)/alpha): "coordinated" threshold, for the chart
    sprt_lower: float  # ln(beta/(1-alpha)): "organic" threshold, for the chart
    decided_at_item: int | None  # index k where a threshold was crossed; None while "watching"
    first_seen: datetime  # earliest published_at among item_ids
    last_seen: datetime  # latest published_at among item_ids
    correlation: list[list[float]]  # square, row/col order == accounts (heatmap): peak normalized xcorr
    lag_sec: list[list[float]] | None = None  # same shape: lag (s) at the correlation peak
    explanation: Explanation | None = None
    synthetic: bool = False  # true if it contains injected items

    @model_validator(mode="after")
    def _square_correlation(self) -> Finding:
        n = len(self.accounts)
        for name in ("correlation", "lag_sec"):
            m = getattr(self, name)
            if m is None:
                continue
            if len(m) != n or any(len(row) != n for row in m):
                raise ValueError(f"{name} must be {n}x{n} (len(accounts))")
        if self.sprt_lower >= self.sprt_upper:
            raise ValueError("sprt_lower must be < sprt_upper")
        return self


class AlertsResponse(BaseModel):
    """GET /api/alerts payload."""

    generated_at: datetime
    findings: list[Finding]


class MetricsReport(BaseModel):
    """GET /api/metrics payload (eval output)."""

    generated_at: datetime
    roc: list[tuple[float, float]]  # (pfa, pd) points
    detection_rate: float | None = None
    operating_pfa: float | None = None
    mean_posts_to_decision: float | None = None
    mean_seconds_to_decision: float | None = None
    live_fpr: float | None = None
    live_precision: float | None = None
    n_labelled: int = 0
