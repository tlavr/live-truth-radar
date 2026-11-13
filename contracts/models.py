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


class AmbiguityMap(BaseModel):
    """2D histogram of cross-account post pairs: |lag| (x) vs semantic mismatch 1 - cos (y).

    A coordinated group shows a sharp peak near the origin; organic pairs form a flat carpet.
    counts[m][l] = pairs with mismatch in [mismatch_edges[m], mismatch_edges[m+1]) and
    |lag| in [lag_edges_sec[l], lag_edges_sec[l+1]).
    """

    lag_edges_sec: list[float]
    mismatch_edges: list[float]
    counts: list[list[int]]  # pairs inside the finding's group
    background: list[list[int]] | None = None  # all other pairs of the topic window, same grid

    @model_validator(mode="after")
    def _grid_shape(self) -> AmbiguityMap:
        rows, cols = len(self.mismatch_edges) - 1, len(self.lag_edges_sec) - 1
        if rows < 1 or cols < 1:
            raise ValueError("need at least two edges per axis")
        for name in ("counts", "background"):
            m = getattr(self, name)
            if m is None:
                continue
            if len(m) != rows or any(len(row) != cols for row in m):
                raise ValueError(f"{name} must be {rows}x{cols} (mismatch bins x lag bins)")
        return self


class Finding(BaseModel):
    """A detector decision about a group of accounts within a topic."""

    id: str  # use finding_id(topic, accounts)
    topic: str
    created_at: datetime  # detector run time (>= last_seen)
    verdict: Literal["coordinated", "organic", "watching"]
    accounts: list[str]
    item_ids: list[str]
    llr: float
    snr_db: float  # 20*log10(Z): all account pairs of the cluster coherently combined ("despread")
    snr_db_single: float | None = None  # 20*log10(mean pair z): same statistic before combining, for "x dB -> y dB"
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
    ambiguity: AmbiguityMap | None = None  # main-screen map: lag x semantic mismatch
    note: str | None = None  # detector remark, e.g. "news echo: <headline>" (such a finding is never "coordinated")

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
    pd_by_size: list[tuple[int, float]] = []  # (accounts in the injected swarm, pd) at operating_pfa
    swarm_purity: float | None = None  # synthetic runs: share of accounts in a detected group that are truly injected
    live_precision_ci: tuple[float, float] | None = None  # Wilson 95% interval for live_precision
