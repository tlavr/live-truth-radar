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


def pseudonym(author: str, salt: str) -> str:
    """Pseudonymous account id for anything committed to the public repo (live samples, labels)."""
    return "acct-" + hashlib.sha1((salt + "|" + author).encode("utf-8")).hexdigest()[:10]


class Finding(BaseModel):
    """A detector decision about a group of accounts within a topic."""

    id: str  # use finding_id(topic, accounts)
    topic: str
    created_at: datetime  # detector run time (>= last_seen)
    verdict: Literal["coordinated", "organic", "watching"]
    accounts: list[str]
    item_ids: list[str]
    llr: float
    snr_db: float  # SNR of the coherently combined cluster ("despread")
    snr_db_single: float | None = None  # mean per-account SNR (before despreading), for "−x dB -> +y dB"
    # sprt_trace[k] = cumulative LLR after item_ids[k] (time order); may stop at the decision,
    # so len(sprt_trace) <= len(item_ids).
    sprt_trace: list[float]
    sprt_upper: float  # ln((1-beta)/alpha): "coordinated" threshold, for the chart
    sprt_lower: float  # ln(beta/(1-alpha)): "organic" threshold, for the chart
    decided_at_item: int | None  # index k where a threshold was crossed; None while "watching"
    first_seen: datetime  # earliest published_at among item_ids
    last_seen: datetime  # latest published_at among item_ids
    correlation: list[list[float]]  # square, row/col order == accounts (heatmap): peak normalized xcorr
    # same shape: lag_sec[i][j] = seconds account j posts after account i at the correlation peak
    # (positive = j follows i; antisymmetric)
    lag_sec: list[list[float]] | None = None
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
        if len(self.sprt_trace) > len(self.item_ids):
            raise ValueError("len(sprt_trace) must be <= len(item_ids)")
        if self.decided_at_item is not None and not 0 <= self.decided_at_item < len(self.sprt_trace):
            raise ValueError("decided_at_item must index into sprt_trace")
        if self.first_seen > self.last_seen:
            raise ValueError("first_seen must be <= last_seen")
        return self


class TopicStatus(BaseModel):
    """A topic the user asked us to watch (POST /api/topics); GET /api/topics returns these."""

    topic: str  # slug, equals Item.topic / Finding.topic
    query: str  # what the user typed
    status: Literal["scanning", "watching", "expired", "error"]  # scanning = first backfill running
    created_at: datetime
    last_poll_at: datetime | None = None
    next_poll_at: datetime | None = None
    n_items: int = 0
    n_accounts: int = 0
    n_coordinated: int = 0
    window_hours: float | None = None  # detector window (DETECT_WINDOW_HOURS), for "in the last N hours"
    poll_interval_sec: int | None = None  # for "we scan every N minutes"
    note: str | None = None  # e.g. "social search returned no authors; using news only"


class AlertsResponse(BaseModel):
    """GET /api/alerts payload."""

    generated_at: datetime
    last_poll_at: datetime | None = None  # last successful ingest cycle ("updated 2 min ago")
    findings: list[Finding]  # latest detector run only


class FailureExample(BaseModel):
    """A known detector error shown on the metrics page (honesty about false positives/negatives)."""

    kind: Literal["false_positive", "false_negative"]
    finding_id: str | None = None
    account: str | None = None  # pseudonym for live data
    note: str


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
    failure_examples: list[FailureExample] = []
    embedder: str | None = None  # embedder used for this report; must match production ("gemini"), not "hash"
