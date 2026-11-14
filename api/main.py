"""FastAPI app (P1): /health (T4), /api/* (T8), dashboard web/ at / and /metrics (T12).

Run: uvicorn api.main:app --host 0.0.0.0 --port 8000

Handles of real (non-synthetic) accounts are masked here, in the API, not only on the
dashboard: the API is public, so an unmasked JSON would leak them. Full handles stay in the DB
(local labelling, T14). Synthetic account names are fake and are returned as is.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from contracts.models import AlertsResponse, Finding, Item, MetricsReport
from detect import operating
from ingest import store

log = logging.getLogger("ltr.api")

REPORT_PATH = Path(__file__).resolve().parent.parent / "eval" / "report.json"
POINTS_PATH = operating.POINTS_PATH
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_ITEM_IDS = 200

app = FastAPI(title="Live Swarm Radar")


def mask_handle(author: str) -> str:
    """'helsinki_rider' -> 'he***' (the dashboard prefixes '@')."""
    return author[:2] + "***"


def public_item(it: Item) -> Item:
    if it.synthetic:
        return it
    # a social post URL contains the handle; article URLs (news) are public and kept
    url = None if it.source == "context_social" else it.url
    return it.model_copy(update={"author": mask_handle(it.author), "url": url})


def public_finding(f: Finding, fake: set[str]) -> Finding:
    """Mask every account of the finding that is not a synthetic author (`fake`)."""
    return f.model_copy(update={"accounts": [a if a in fake else mask_handle(a) for a in f.accounts]})


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe for caddy / smoke; does not touch the DB."""
    return {"status": "ok"}


@app.get("/api/alerts", response_model=AlertsResponse)
def alerts(
    topic: str | None = None,
    alpha: float | None = Query(None, gt=0, lt=1, description="T12c: SPRT alpha of the slider (default 0.02)"),
) -> AlertsResponse:
    """Latest detector run per topic (all topics, or one with ?topic=), newest first.

    ?alpha= picks an operating point of the false-alarm slider: the design alpha (or none) reads the
    findings table as before; another alpha reads what the worker stored for it (ALPHA_POINTS).
    """
    with store.connect() as conn:
        if alpha is None or round(alpha, 6) == operating.DEFAULT_ALPHA:
            findings = store.load_findings(conn, topic)
        else:
            findings = store.load_findings_alpha(conn, round(alpha, 6), topic)
        fake = store.synthetic_authors(conn, [i for f in findings for i in f.item_ids])
        last_poll = store.get_last_poll(conn)
    return AlertsResponse(
        generated_at=datetime.now(timezone.utc),
        last_poll_at=last_poll,
        findings=[public_finding(f, fake) for f in findings],
    )


@app.get("/api/operating_points", response_model=operating.OperatingPoints | None)
def operating_points() -> operating.OperatingPoints | None:
    """T12c: eval/operating_points.json (measured Pfa / Pd per slider alpha); null until make eval wrote it."""
    return operating.load_points(POINTS_PATH)


@app.get("/api/metrics", response_model=MetricsReport)
def metrics() -> MetricsReport:
    """eval/report.json (committed by `make eval`); an empty report until it exists or if it is invalid."""
    if REPORT_PATH.exists():
        try:
            return MetricsReport.model_validate_json(REPORT_PATH.read_text(encoding="utf-8"))
        except (ValidationError, OSError) as exc:
            log.warning("eval/report.json unusable (%s); serving an empty report", exc)
    return MetricsReport(generated_at=datetime.now(timezone.utc), roc=[])


@app.get("/api/items", response_model=list[Item])
def items(ids: str = Query(..., description="comma-separated item ids")) -> list[Item]:
    wanted = list(dict.fromkeys(i.strip() for i in ids.split(",") if i.strip()))
    if len(wanted) > MAX_ITEM_IDS:
        raise HTTPException(status_code=400, detail=f"at most {MAX_ITEM_IDS} ids per request")
    with store.connect() as conn:
        return [public_item(it) for it in store.get_items(conn, wanted)]


class InjectRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=64)


class InjectResponse(BaseModel):
    campaign_id: str
    n_items: int


@app.post("/api/inject", response_model=InjectResponse)
def inject(req: InjectRequest) -> InjectResponse:
    """Add a synthetic swarm (synth.campaign.make_campaign) to the topic; the worker runs detect() within ~10 s."""
    from synth.campaign import make_campaign  # heavy import (numpy) only when used

    monitored = topics()
    if monitored and req.topic not in monitored:  # the worker would delete its finding at the next poll
        raise HTTPException(status_code=400, detail=f"topic {req.topic!r} is not monitored (TOPICS)")
    with store.connect() as conn:
        if store.has_pending_inject(conn, req.topic):
            raise HTTPException(status_code=429, detail="an inject for this topic is still being processed")
        try:
            campaign = make_campaign(req.topic, datetime.now(timezone.utc))
        except ValueError as exc:  # no variations for the topic, bad slug
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if store.upsert_items(conn, campaign) == 0:  # same-second campaign: every id already exists
            raise HTTPException(status_code=409, detail="inject collided with the previous one, retry")
        store.add_inject_request(conn, req.topic, campaign[0].campaign_id)
    return InjectResponse(campaign_id=campaign[0].campaign_id, n_items=len(campaign))


@app.get("/api/topics", response_model=list[str])
def topics() -> list[str]:
    """Monitored topics (TOPICS, comma-separated, same parsing as the worker), for the dashboard switcher."""
    return [t.strip() for t in (os.environ.get("TOPICS") or "").split(",") if t.strip()]


@app.get("/metrics", include_in_schema=False)
def metrics_page() -> FileResponse:
    return FileResponse(WEB_DIR / "metrics.html")


@app.get("/explain", include_in_schema=False)
def explain_page() -> FileResponse:
    """T12b: step-by-step "How we got here" page for one alert (?id=&topic=&alpha=)."""
    return FileResponse(WEB_DIR / "explain.html")


# last: serves web/index.html at / and its assets; the routes above take precedence
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
