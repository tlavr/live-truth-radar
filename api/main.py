"""FastAPI app (P1): /health (T4), /api/* (T8), dashboard web/ at / and /metrics (T12).

Run: uvicorn api.main:app --host 0.0.0.0 --port 8000

Handles of real (non-synthetic) accounts are masked here, in the API, not only on the
dashboard: the API is public, so an unmasked JSON would leak them. Full handles stay in the DB
(local labelling, T14). Synthetic account names are fake and are returned as is.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, field_validator

from contracts.models import AlertsResponse, Finding, Item, MetricsReport
from detect import operating
from detect.config import DEFAULT as DEFAULT_CFG
from detect.pipeline import drop_expired_synthetic
from detect.timemap import TimeMap, time_map
from ingest import radar, store

log = logging.getLogger("ltr.api")

REPORT_PATH = Path(__file__).resolve().parent.parent / "eval" / "report.json"
POINTS_PATH = operating.POINTS_PATH
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_ITEM_IDS = 200
INJECT_MIN_GAP = timedelta(minutes=5)  # T12d: inject API and red team attack, each once per 5 min per topic
DEMO_SPEED = 4  # T12d red team attack: the agreed schedule="future" campaign played 4x faster (2 posts per bot: ~2.5 min, not ~10)
RADAR_DEFAULT_SINCE = timedelta(minutes=15)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """T12d tables on an existing DB volume (schema.sql runs only on a fresh one); the worker does it too."""
    try:
        with store.connect() as conn:
            store.ensure_schema(conn)
    except Exception as exc:  # DB not up yet / no DATABASE_URL (tests): the worker creates them
        log.warning("ensure_schema at startup skipped: %s", type(exc).__name__)
    yield


app = FastAPI(title="Live Swarm Radar", lifespan=lifespan)


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


@app.get("/api/alphas", response_model=list[float])
def served_alphas() -> list[float]:
    """T12c: slider alphas with stored findings: the design alpha + the worker's ALPHA_POINTS (same .env)."""
    from ingest.worker import alpha_points  # same parsing as the worker; light import (no DB at import)

    return sorted({operating.DEFAULT_ALPHA, *alpha_points()})


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
    with store.connect() as conn:  # T12d: an attack's future posts stay hidden until their time
        return [public_item(it) for it in store.get_items(conn, wanted, until=datetime.now(timezone.utc))]


class InjectRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=64)


class InjectResponse(BaseModel):
    campaign_id: str
    n_items: int


@app.get("/api/timemap", response_model=TimeMap)
def timemap(
    topic: str = Query(..., min_length=1, max_length=64),
    alpha: float | None = Query(None, gt=0, lt=1),
    minutes: float | None = Query(None, gt=0, le=1440),
    at: datetime | None = Query(None, description="draw the map as of this moment (UTC) instead of now"),
) -> TimeMap:
    """Experiment: time x meaning map of the topic window with one layer per stored finding (detect/timemap.py).

    `at` rewinds the map to an older moment of the window (a group that is already off the live map):
    the map ends at `at` and holds only the posts published by then.
    """
    now = datetime.now(timezone.utc)
    hours = float(os.environ.get("DETECT_WINDOW_HOURS") or DEFAULT_CFG.window_hours)
    end = now
    if at is not None:
        end = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
        if end < now - timedelta(hours=hours):
            raise HTTPException(422, "at must lie inside the detector window")
        end = min(end, now)  # a browser clock ahead of the server asks for a moment slightly in the future
    with store.connect() as conn:
        posts = store.window_items(conn, topic, hours, now)
        if alpha is None or round(alpha, 6) == operating.DEFAULT_ALPHA:
            findings = store.load_findings(conn, topic)
        else:
            findings = store.load_findings_alpha(conn, round(alpha, 6), topic)
    posts = drop_expired_synthetic(posts, now, DEFAULT_CFG.synthetic_ttl_sec)  # what the detector saw
    return time_map(topic, posts, {f.id: f.item_ids for f in findings}, now=end, window_hours=hours,
                    span_sec=minutes * 60 if minutes else None)


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
        now = datetime.now(timezone.utc)
        _rate_limit("inject", store.last_inject_at(conn, req.topic), now)
        try:
            campaign = make_campaign(req.topic, now)
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


# ---------------------------------------------------------------- T12d: live scan + red team console


class ScanRequest(BaseModel):
    topics: list[str] = Field(min_length=1, max_length=radar.MAX_SESSION_TOPICS)

    @field_validator("topics", mode="before")
    @classmethod
    def _dedup(cls, v):  # ["a", "a"] is one topic: dedup before the per-session cap
        if isinstance(v, list) and all(isinstance(t, str) for t in v):
            return list(dict.fromkeys(t.strip() for t in v if t.strip()))
        return v


class ScanResponse(BaseModel):
    session_id: int
    topics: list[str]


@app.post("/api/scan", response_model=ScanResponse)
def open_scan(req: ScanRequest) -> ScanResponse:
    """Open a live scan session: the worker runs detect() on its topics every SCAN_INTERVAL_SEC while the page
    sends heartbeats (GET /api/radar?session=). The cap is on the union of scanned topics, not on sessions."""
    wanted = list(dict.fromkeys(t.strip() for t in req.topics if t.strip()))
    monitored = set(topics())
    bad = [t for t in wanted if t not in monitored]
    if not wanted or bad:
        raise HTTPException(status_code=400, detail=f"not monitored (TOPICS): {bad or req.topics}")
    with store.connect() as conn:
        scanned = store.scanned_topics(conn, radar.SESSION_STALE_SEC)
        if len(scanned | set(wanted)) > radar.MAX_SCANNED_TOPICS:
            raise HTTPException(status_code=429, detail=f"at most {radar.MAX_SCANNED_TOPICS} topics are scanned "
                                "at once; pick one of: " + ", ".join(sorted(scanned)))
        return ScanResponse(session_id=store.open_scan(conn, wanted), topics=wanted)


@app.post("/api/scan/{session_id}/stop")
def stop_scan(session_id: int) -> dict[str, bool]:
    with store.connect() as conn:
        return {"stopped": store.stop_scan(conn, session_id)}


@app.get("/api/radar")
def radar_frames(
    session: int,
    topic: str,
    since: datetime | None = Query(None, description="frames after this time (default: the last 15 min)"),
) -> list[dict]:
    """Radar frames of one topic (heartbeat of the session: 410 once it is closed or stale)."""
    if since is not None and (since.tzinfo is None or since.utcoffset() is None):
        raise HTTPException(status_code=422, detail="since must be timezone-aware")
    with store.connect() as conn:
        session_topics = store.touch_scan(conn, session, radar.SESSION_STALE_SEC)
        if session_topics is None:
            raise HTTPException(status_code=410, detail="scan session closed or unknown; open a new one")
        if topic not in session_topics:
            raise HTTPException(status_code=400, detail=f"topic not in this scan session: {session_topics}")
        return store.load_frames(conn, topic, since or datetime.now(timezone.utc) - RADAR_DEFAULT_SINCE)


def _rate_limit(what: str, last: datetime | None, now: datetime) -> None:
    """429 with Retry-After if the topic had one `what` in the last INJECT_MIN_GAP (the time comes from the DB)."""
    if last is not None and now - last < INJECT_MIN_GAP:
        wait = int((INJECT_MIN_GAP - (now - last)).total_seconds()) + 1
        raise HTTPException(status_code=429, detail=f"one {what} per {INJECT_MIN_GAP.seconds // 60} min per topic; "
                            f"retry in {wait} s", headers={"Retry-After": str(wait)})


def _attack_topics() -> list[str]:
    from synth.variations import available_topics

    monitored = set(topics())
    return [t for t in available_topics() if t in monitored]


Scenario = Literal["paraphrase", "copypasta", "drift"]
# drift runs at the real schedule (~10 min): its ridge needs the whole 0-10 min lag axis
SCENARIO_SPEED: dict[str, float] = {"paraphrase": DEMO_SPEED, "copypasta": DEMO_SPEED, "drift": 1}


def _drift_texts(topic: str, posts: list[Item]) -> list[Item]:
    """Texts that drift away from the first post over time: all variation texts of the topic ordered by meaning
    (cosine to the first post's text, most similar first), the k-th post in time gets the matching rung."""
    from detect.embed import embed
    from synth.variations import load_variations

    texts = list(dict.fromkeys([posts[0].text] + [v for m in load_variations(topic).messages for v in m.variations]))
    E = embed(texts)  # unit rows; the worker warmed these texts into cache/embeddings/ at start
    sim = E @ E[0]
    ladder = [texts[k] for k in sorted(range(len(texts)), key=lambda k: (-float(sim[k]), k))]
    last = max(1, len(posts) - 1)
    return [it.model_copy(update={"text": ladder[round(r * (len(ladder) - 1) / last)]}) for r, it in enumerate(posts)]


def _more_rounds(base: list[Item], n_accounts: int, posts_per_bot: int) -> list[Item]:
    """posts_per_bot > 2: the same bots post more volleys, repeating P2's two volleys (texts, lags) one volley
    period later each time. Extra posts add no new account pairs, so a big campaign does not blind CFAR."""
    base = sorted(base, key=lambda it: (it.published_at, it.id))
    v1, v2 = base[:n_accounts], base[n_accounts:]
    period = 2 * (v2[0].published_at - v1[0].published_at)  # one pair of volleys
    posts, cid = list(base), base[0].campaign_id
    for r in range(2, posts_per_bot):
        for it in (v1 if r % 2 == 0 else v2):
            posts.append(it.model_copy(update={"id": f"{cid}-{len(posts)}", "published_at": it.published_at + (r // 2) * period}))
    return posts


def _attack_campaign(topic: str, click: datetime, n_accounts: int, scenario: str = "paraphrase",
                     posts_per_bot: int = 2) -> list[Item]:
    """make_campaign(schedule="future") (P2: same swarm shape, accounts and lags as eval), then per scenario:
    * paraphrase: P2's texts (rewordings of one message per volley), clock DEMO_SPEED x faster from the click
      (lags 15-120 s -> 4-30 s, second volley after ~2 min);
    * copypasta: every post carries the very same text, DEMO_SPEED x faster (spike at zero lag, zero wording gap);
    * drift: real speed, texts drift away from the first one over time (ridge along lag x wording gap).
    Labelled in the console; eval and /metrics keep P2's real schedule and texts."""
    from synth.campaign import make_campaign

    speed = SCENARIO_SPEED[scenario]
    base = _more_rounds(make_campaign(topic, click, n_accounts=n_accounts, schedule="future"), n_accounts, posts_per_bot)
    posts = [it.model_copy(update={"published_at": click + (it.published_at - click) / speed}) for it in base]
    posts.sort(key=lambda it: (it.published_at, it.id))
    if scenario == "copypasta":
        # one identical text per volley (n_accounts posts each): with a single text for the whole campaign every
        # bot votes the same vector, the beam whitens it to zero and nothing is detected in a quiet topic
        posts = [it.model_copy(update={"text": posts[(k // n_accounts) * n_accounts].text}) for k, it in enumerate(posts)]
    elif scenario == "drift":
        posts = _drift_texts(topic, posts)
    return posts


class AttackRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=64)
    # <= 40: with ~50 bots the swarm's own pairs fill most of the 2000 CFAR reference cells
    # (cfar_min_ref_cells) and raise the threshold above the swarm itself, so it is not detected (40 still is)
    n_accounts: Literal[12, 25, 40] = 25
    posts_per_bot: Literal[2, 4, 6] = 4  # more posts, not more bots: e.g. 25 x 4 = 100 posts
    scenario: Scenario = "paraphrase"


class AttackResponse(BaseModel):
    campaign_id: str
    n_items: int
    starts_at: datetime
    ends_at: datetime


class AttackPost(BaseModel):
    item: Item
    detected: bool


class AttackStatus(BaseModel):
    campaign_id: str
    topic: str
    n_accounts: int
    starts_at: datetime
    ends_at: datetime
    now: datetime  # server clock: posts appear by it, not by the browser's
    posts: list[AttackPost]
    n_detected_accounts: int


@app.get("/api/attack/topics", response_model=list[str])
def attack_topics() -> list[str]:
    return _attack_topics()


@app.post("/api/attack", response_model=AttackResponse)
def attack(req: AttackRequest) -> AttackResponse:
    """Red team console (public; the product itself has no inject button): a synthetic swarm whose posts appear one
    by one from now on (at DEMO_SPEED ~2.5 / 6.5 / 10.5 min for 2 / 4 / 6 posts per bot); one attack per 5 min per topic (429 with Retry-After)."""
    if req.topic not in _attack_topics():
        raise HTTPException(status_code=400, detail=f"topic {req.topic!r} is not monitored or has no variations")
    click = datetime.now(timezone.utc)
    with store.connect() as conn:
        _rate_limit("attack", store.last_attack_at(conn, req.topic), click)
        campaign = _attack_campaign(req.topic, click, req.n_accounts, req.scenario, req.posts_per_bot)
        cid = campaign[0].campaign_id
        starts, ends = min(it.published_at for it in campaign), max(it.published_at for it in campaign)
        if store.upsert_items(conn, campaign) == 0:  # same-second campaign: every id already exists
            raise HTTPException(status_code=409, detail="attack collided with the previous one, retry")
        store.add_attack(conn, cid, req.topic, req.n_accounts, starts, ends)
    return AttackResponse(campaign_id=cid, n_items=len(campaign), starts_at=starts, ends_at=ends)


@app.get("/api/attack/{campaign_id}", response_model=AttackStatus)
def attack_status(campaign_id: str) -> AttackStatus:
    """Posts of the attack published so far (server clock) and which of them the detector has in a coordinated
    finding right now."""
    now = datetime.now(timezone.utc)
    with store.connect() as conn:
        a = store.get_attack(conn, campaign_id)
        if a is None:
            raise HTTPException(status_code=404, detail="unknown attack")
        posts = store.campaign_items(conn, campaign_id, now)
        found = [f for f in store.load_findings(conn, a["topic"]) if f.verdict == "coordinated"]
    hit = {i for f in found for i in f.item_ids}
    authors = {it.author for it in posts if it.id in hit}
    return AttackStatus(
        campaign_id=campaign_id, topic=a["topic"], n_accounts=a["n_accounts"], starts_at=a["starts_at"],
        ends_at=a["ends_at"], now=now, posts=[AttackPost(item=it, detected=it.id in hit) for it in posts],
        n_detected_accounts=len(authors),
    )


@app.get("/redteam", include_in_schema=False)
def redteam_page() -> FileResponse:
    return FileResponse(WEB_DIR / "redteam.html")


@app.get("/metrics", include_in_schema=False)
def metrics_page() -> FileResponse:
    return FileResponse(WEB_DIR / "metrics.html")


@app.get("/explain", include_in_schema=False)
def explain_page() -> FileResponse:
    """T12b: step-by-step "How we got here" page for one alert (?id=&topic=&alpha=)."""
    return FileResponse(WEB_DIR / "explain.html")


# last: serves web/index.html at / and its assets; the routes above take precedence
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
