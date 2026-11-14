"""T8: API on a fake store (offline, no DB) and the live-sample pseudonymization."""

import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

import api.main as main
from contracts.models import AlertsResponse, Finding, Item, MetricsReport, pseudonym
from ingest.export_sample import pseudonymize

FIX = Path(__file__).resolve().parent.parent / "fixtures"


class FakeStore:
    """In-memory stand-in for ingest.store with the functions the API uses."""

    def __init__(self):
        self.items = {it.id: it for it in TypeAdapter(list[Item]).validate_json((FIX / "items.json").read_text())}
        self.findings = TypeAdapter(list[Finding]).validate_json((FIX / "findings.json").read_text())
        self.injects: list[tuple[str, str]] = []
        self.pending: set[str] = set()
        self.inject_at: dict[str, datetime] = {}
        self.sessions: dict[int, dict] = {}
        self.frames: list[dict] = []
        self.attacks: dict[str, dict] = {}

    @contextmanager
    def connect(self):
        yield self

    def load_findings(self, conn, topic=None):
        return [f for f in self.findings if topic is None or f.topic == topic]

    def load_findings_alpha(self, conn, alpha, topic=None):
        return [f for f in self.findings[:1] if alpha == 0.05 and (topic is None or f.topic == topic)]

    def synthetic_authors(self, conn, ids):
        return {self.items[i].author for i in ids if i in self.items and self.items[i].synthetic}

    def get_last_poll(self, conn):
        return datetime(2026, 11, 14, 4, 0, tzinfo=timezone.utc)

    def get_items(self, conn, ids, until=None):
        return [self.items[i] for i in ids if i in self.items and (until is None or self.items[i].published_at <= until)]

    def last_inject_at(self, conn, topic):
        return self.inject_at.get(topic)

    def open_scan(self, conn, topics):
        sid = len(self.sessions) + 1
        self.sessions[sid] = {"topics": list(topics), "open": True}
        return sid

    def touch_scan(self, conn, sid, stale_sec):
        s = self.sessions.get(sid)
        return list(s["topics"]) if s and s["open"] else None

    def stop_scan(self, conn, sid):
        s = self.sessions.get(sid)
        if not s or not s["open"]:
            return False
        s["open"] = False
        return True

    def scanned_topics(self, conn, stale_sec):
        return {t for s in self.sessions.values() if s["open"] for t in s["topics"]}

    def load_frames(self, conn, topic, since):
        return [f for f in self.frames if f["topic"] == topic]

    def add_attack(self, conn, cid, topic, n, starts, ends):
        self.attacks[cid] = {"campaign_id": cid, "topic": topic, "n_accounts": n, "starts_at": starts, "ends_at": ends,
                             "created_at": main.datetime.now(timezone.utc)}

    def last_attack_at(self, conn, topic):
        return max((a["created_at"] for a in self.attacks.values() if a["topic"] == topic), default=None)

    def get_attack(self, conn, cid):
        return self.attacks.get(cid)

    def campaign_items(self, conn, cid, until):
        return sorted((it for it in self.items.values() if it.campaign_id == cid and it.published_at <= until),
                      key=lambda it: (it.published_at, it.id))

    def has_pending_inject(self, conn, topic):
        return topic in self.pending

    def upsert_items(self, conn, items):
        new = [it for it in items if it.id not in self.items]
        self.items.update((it.id, it) for it in new)
        return len(new)

    def add_inject_request(self, conn, topic, campaign_id):
        self.injects.append((topic, campaign_id))
        self.pending.add(topic)
        self.inject_at[topic] = main.datetime.now(timezone.utc)
        return len(self.injects)


@pytest.fixture
def client(monkeypatch):
    fake = FakeStore()
    for name in ("connect", "load_findings", "load_findings_alpha", "synthetic_authors", "get_last_poll", "get_items",
                 "has_pending_inject", "upsert_items", "add_inject_request", "last_inject_at", "open_scan",
                 "touch_scan", "stop_scan", "scanned_topics", "load_frames", "add_attack", "last_attack_at", "get_attack",
                 "campaign_items"):
        monkeypatch.setattr(main.store, name, getattr(fake, name))
    return TestClient(main.app), fake


def test_alerts_items_and_metrics_validate_and_mask_real_handles(client, monkeypatch, tmp_path):
    c, fake = client
    resp = AlertsResponse.model_validate(c.get("/api/alerts").json())
    assert resp.findings and resp.last_poll_at is not None
    real = {it.author for it in fake.items.values() if not it.synthetic}
    fake_names = {it.author for it in fake.items.values() if it.synthetic}
    for f in resp.findings:
        assert not set(f.accounts) & real  # no real handle leaks
        assert all(a in fake_names or a.endswith("***") for a in f.accounts)

    ids = [it.id for it in fake.items.values()][:30]
    got = TypeAdapter(list[Item]).validate_python(c.get("/api/items", params={"ids": ",".join(ids)}).json())
    assert len(got) == len(ids)
    assert all(it.synthetic or (it.author.endswith("***") and it.author not in real) for it in got)
    assert c.get("/api/items", params={"ids": ",".join(f"x{k}" for k in range(201))}).status_code == 400

    # metrics: committed report if valid, an empty report otherwise
    report = tmp_path / "report.json"
    monkeypatch.setattr(main, "REPORT_PATH", report)
    assert MetricsReport.model_validate(c.get("/api/metrics").json()).roc == []
    report.write_text("{not json")
    assert MetricsReport.model_validate(c.get("/api/metrics").json()).roc == []
    report.write_text((Path(main.__file__).resolve().parent.parent / "eval" / "report.json").read_text())
    assert MetricsReport.model_validate(c.get("/api/metrics").json()).roc


class _Clock:
    """Patches api.main.datetime with a settable clock."""

    def __init__(self, monkeypatch, at):
        clock = self
        self.at = at

        class Frozen(datetime):
            @classmethod
            def now(cls, tz=None):
                return clock.at

        monkeypatch.setattr(main, "datetime", Frozen)


def test_inject_adds_synthetic_items_and_rejects_bad_or_repeated_requests(client, monkeypatch):
    from datetime import timedelta

    c, fake = client
    clock = _Clock(monkeypatch, datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc))
    before = len(fake.items)
    r = c.post("/api/inject", json={"topic": "helsinki-tram-fares"})
    assert r.status_code == 200
    body = r.json()
    new = [it for it in fake.items.values() if it.campaign_id == body["campaign_id"]]
    assert body["n_items"] == len(new) == len(fake.items) - before > 0
    assert all(it.synthetic and it.source == "synthetic" for it in new)
    assert fake.injects == [("helsinki-tram-fares", body["campaign_id"])]
    # still pending -> 429; processed but within 5 min -> 429 with Retry-After (T12d public limit)
    assert c.post("/api/inject", json={"topic": "helsinki-tram-fares"}).status_code == 429
    fake.pending.clear()
    clock.at += timedelta(minutes=4)
    r = c.post("/api/inject", json={"topic": "helsinki-tram-fares"})
    assert r.status_code == 429 and 0 < int(r.headers["Retry-After"]) <= 61
    clock.at += timedelta(minutes=2)  # 6 min after the first: a new campaign
    mid = len(fake.items)
    r2 = c.post("/api/inject", json={"topic": "helsinki-tram-fares"})
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["campaign_id"] != body["campaign_id"]
    new2 = [it for it in fake.items.values() if it.campaign_id == body2["campaign_id"]]
    assert body2["n_items"] == len(new2) == len(fake.items) - mid > 0
    assert all(it.synthetic for it in new2)
    # same second without the limit (e.g. its row gone) -> every id collides -> 409 instead of a fake "n_items"
    fake.pending.clear()
    fake.inject_at.clear()
    assert c.post("/api/inject", json={"topic": "helsinki-tram-fares"}).status_code == 409
    fake.pending.clear()
    assert c.post("/api/inject", json={"topic": "no-such-topic"}).status_code == 400
    assert c.post("/api/inject", json={"topic": ""}).status_code == 422


def test_inject_rejects_topics_outside_topics(client, monkeypatch):
    c, fake = client
    monkeypatch.setenv("TOPICS", "jensen-huang-resignation")
    r = c.post("/api/inject", json={"topic": "helsinki-tram-fares"})  # has variations, not monitored
    assert r.status_code == 400 and "not monitored" in r.json()["detail"]
    assert fake.injects == []
    assert c.post("/api/inject", json={"topic": "jensen-huang-resignation"}).status_code == 200


def test_export_sample_pseudonymizes_and_drops_synthetic():
    items = TypeAdapter(list[Item]).validate_json((FIX / "items.json").read_text())
    out = pseudonymize(items, "salt")
    real = {it.author for it in items if not it.synthetic}
    organic = [it for it in items if not it.synthetic]
    assert len(out) == len(organic)
    assert all(not it.synthetic and it.author.startswith("acct-") for it in out)
    assert [it.author for it in out] == [pseudonym(it.author, "salt") for it in organic]
    dumped = json.dumps([it.model_dump(mode="json") for it in out])
    assert not any(handle in dumped for handle in real)
    with pytest.raises(ValueError):
        pseudonymize(items, "")


def test_alerts_per_slider_alpha_and_operating_points(client, monkeypatch, tmp_path):
    from detect.operating import OperatingPoint, OperatingPoints, write_points

    c, fake = client
    default = c.get("/api/alerts").json()["findings"]
    assert c.get("/api/alerts?alpha=0.02").json()["findings"] == default  # design alpha = the findings table
    assert len(c.get("/api/alerts?alpha=0.05").json()["findings"]) == 1  # findings_alpha
    assert c.get("/api/alerts?alpha=0.01").json()["findings"] == []  # no stored point
    assert c.get("/api/alerts?alpha=0").status_code == 422 and c.get("/api/alerts?alpha=1.5").status_code == 422

    monkeypatch.setattr(main, "POINTS_PATH", tmp_path / "op.json")
    assert c.get("/api/operating_points").json() is None  # before make eval
    pts = OperatingPoints(generated_at=datetime(2026, 11, 14, tzinfo=timezone.utc), embedder="gemini", cfar_k=3.0,
                          points=[OperatingPoint(alpha=0.02, pfa=0.0, pfa_upper95=0.003, pd=0.98, pd_small=0.8,
                                                 n_background=1000)])
    write_points(pts, tmp_path / "op.json")
    assert OperatingPoints.model_validate(c.get("/api/operating_points").json()) == pts


def test_served_alphas_follow_worker_env(client, monkeypatch):
    """T12c: the slider shows only the alphas the worker computes (same .env as the api container)."""
    c, _ = client
    monkeypatch.setenv("ALPHA_POINTS", "0.01,0.05")  # an old VPS .env
    assert c.get("/api/alphas").json() == [0.01, 0.02, 0.05]  # design alpha always served
    monkeypatch.setenv("ALPHA_POINTS", "")
    assert c.get("/api/alphas").json() == [0.02]
    monkeypatch.delenv("ALPHA_POINTS")
    assert c.get("/api/alphas").json() == [0.005, 0.01, 0.02, 0.05, 0.1]


def test_scan_sessions_cap_the_union_of_topics_and_answer_410_when_closed(client, monkeypatch):
    c, fake = client
    monkeypatch.setenv("TOPICS", "a,b,c,d,e")
    assert c.post("/api/scan", json={"topics": ["x"]}).status_code == 400  # not monitored
    assert c.post("/api/scan", json={"topics": ["a", "b", "c"]}).status_code == 422  # > 2 per session
    sid = c.post("/api/scan", json={"topics": ["a", "b"]}).json()["session_id"]
    assert c.post("/api/scan", json={"topics": ["c", "d"]}).status_code == 200
    assert c.post("/api/scan", json={"topics": ["a", "b"]}).status_code == 200  # already scanned: always accepted
    assert c.post("/api/scan", json={"topics": ["e"]}).status_code == 429  # a 5th topic
    fake.frames.append({"topic": "a", "at": "2026-11-14T12:00:00+00:00"})
    assert c.get(f"/api/radar?session={sid}&topic=a").json() == fake.frames
    assert c.post(f"/api/scan/{sid}/stop").json() == {"stopped": True}
    assert c.get(f"/api/radar?session={sid}&topic=a").status_code == 410
    assert c.get("/api/radar?session=999&topic=a").status_code == 410
    assert c.get(f"/api/radar?session={sid}&topic=a&since=2026-11-14T12:00:00").status_code == 422  # naive


def test_attack_is_public_once_per_5_min_per_topic_and_reveals_posts_over_time(client, monkeypatch):
    from datetime import timedelta

    c, fake = client
    monkeypatch.setenv("TOPICS", "helsinki-tram-fares")
    body = {"topic": "helsinki-tram-fares", "n_accounts": 12, "posts_per_bot": 2}
    assert c.get("/api/attack/topics").json() == ["helsinki-tram-fares"]  # monitored and with variations
    assert c.post("/api/attack", json={**body, "n_accounts": 50}).status_code == 422  # 12 / 25 / 40 (CFAR self-masking)
    assert c.post("/api/attack", json={**body, "posts_per_bot": 3}).status_code == 422
    r0 = c.post("/api/attack", json={"topic": "helsinki-tram-fares"})
    assert r0.status_code == 200 and r0.json()["n_items"] == 100  # default: 25 bots x 4 posts
    fake.attacks.clear()
    assert c.post("/api/attack", json={**body, "topic": "jensen-huang-resignation"}).status_code == 400

    click = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
    clock = _Clock(monkeypatch, click)
    r = c.post("/api/attack", json=body)
    assert r.status_code == 200
    a = r.json()
    starts, ends = datetime.fromisoformat(a["starts_at"]), datetime.fromisoformat(a["ends_at"])
    # demo speed: the future campaign (first post 15-60 s, last <= 600 s) played 4x faster
    assert click < starts <= click + timedelta(seconds=15) and ends <= click + timedelta(seconds=150)
    assert a["n_items"] == 24  # 12 accounts x 2 volleys
    clock.at = click + timedelta(minutes=4)
    again = c.post("/api/attack", json=body)
    assert again.status_code == 429 and 0 < int(again.headers["Retry-After"]) <= 61

    cid = a["campaign_id"]
    clock.at = click
    assert c.get(f"/api/attack/{cid}").json()["posts"] == []  # nothing published yet
    ids = [it.id for it in fake.items.values() if it.campaign_id == cid]
    assert c.get(f"/api/items?ids={','.join(ids)}").json() == []  # future posts hidden from the public API too
    clock.at = ends
    status = c.get(f"/api/attack/{cid}").json()
    assert len(status["posts"]) == 24 and not any(p["detected"] for p in status["posts"])
    assert status["n_detected_accounts"] == 0 and status["now"].startswith("2026-11-14T12:")
    assert len(c.get(f"/api/items?ids={','.join(ids)}").json()) == 24

    fake.findings = [fake.findings[0].model_copy(update={"topic": "helsinki-tram-fares", "verdict": "coordinated",
                                                         "item_ids": ids[:4]})]
    status = c.get(f"/api/attack/{cid}").json()
    assert sum(p["detected"] for p in status["posts"]) == 4
    assert c.get("/api/attack/nope").status_code == 404

    clock.at = click + timedelta(minutes=6)  # 5 min later: the next attack on the topic is accepted
    assert c.post("/api/attack", json=body).status_code == 200


def test_scan_dedups_topics_and_radar_rejects_a_topic_outside_the_session(client, monkeypatch):
    c, fake = client
    monkeypatch.setenv("TOPICS", "a,b,c")
    r = c.post("/api/scan", json={"topics": ["a", "a", " a"]})
    assert r.status_code == 200 and r.json()["topics"] == ["a"]  # duplicates are not "> 2 per session"
    assert c.post("/api/scan", json={"topics": ["a", "x", "x"]}).status_code == 400  # still: not monitored
    sid = r.json()["session_id"]
    assert c.get(f"/api/radar?session={sid}&topic=b").status_code == 400  # monitored, but not in this session
    assert c.get(f"/api/radar?session={sid}&topic=a").status_code == 200


def test_attack_scenarios_copypasta_and_drift():
    from datetime import timedelta

    import numpy as np

    from detect.embed import embed

    click = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
    para = main._attack_campaign("helsinki-tram-fares", click, 12)
    copy = main._attack_campaign("helsinki-tram-fares", click, 12, "copypasta")
    assert [it.published_at for it in copy] == [it.published_at for it in para]  # same bots, same 4x schedule
    assert len({it.text for it in copy[:12]}) == 1 and len({it.text for it in copy[12:]}) == 1  # one text per volley
    from detect.pipeline import detect
    found = detect(copy, now=max(it.published_at for it in copy))
    assert any(f.verdict == "coordinated" and len(f.accounts) == 12 for f in found)  # caught even in a quiet topic

    drift = main._attack_campaign("helsinki-tram-fares", click, 12, "drift")
    assert max(it.published_at for it in drift) <= click + timedelta(seconds=600)  # real speed: ~10 min
    assert max(it.published_at for it in drift) > click + timedelta(seconds=400)
    times = [it.published_at for it in drift]
    assert times == sorted(times)
    E = embed([it.text for it in drift])
    sim = E @ E[0]
    assert float(sim[0]) == pytest.approx(1.0) and np.all(np.diff(sim) <= 1e-9)  # meaning drifts away over time
    assert len({it.text for it in drift}) == len(drift)
    with pytest.raises(KeyError):
        main._attack_campaign("helsinki-tram-fares", click, 12, "nope")


def test_attack_rejects_unknown_scenario(client, monkeypatch):
    c, _ = client
    monkeypatch.setenv("TOPICS", "helsinki-tram-fares")
    assert c.post("/api/attack", json={"topic": "helsinki-tram-fares", "scenario": "nope"}).status_code == 422


def test_more_posts_per_bot_repeat_the_volleys_with_the_same_bots():
    click = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
    two = main._attack_campaign("helsinki-tram-fares", click, 25)
    four = main._attack_campaign("helsinki-tram-fares", click, 25, posts_per_bot=4)
    assert len(two) == 50 and len(four) == 100 and len({it.id for it in four}) == 100
    assert {it.author for it in four} == {it.author for it in two}  # more posts, not more bots
    assert {it.campaign_id for it in four} == {two[0].campaign_id}
    times = [it.published_at for it in four]
    assert times == sorted(times) and times[49] < times[50]  # extra volleys come after the first two
