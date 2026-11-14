"""T12d: radar scan() frames and future-scheduled injects (offline, hash embedder)."""

from datetime import datetime, timedelta, timezone

from pathlib import Path

from pydantic import TypeAdapter

from contracts.models import Finding
from detect.pipeline import detect, scan
from detect.radar import best_candidate
from synth.campaign import FUTURE_SHIFT_SEC, make_campaign
from tests.test_detect_swarm import TOPIC, _items, _wire_story

CLICK = datetime(2026, 11, 13, 19, 30, tzinfo=timezone.utc)


def _organic():
    return [it for it in _items("items.json") if not it.synthetic]


def test_future_schedule_is_the_past_campaign_shifted():
    past = make_campaign(TOPIC, CLICK, n_accounts=12, seed=7)
    future = make_campaign(TOPIC, CLICK, n_accounts=12, seed=7, schedule="future")
    shift = timedelta(seconds=FUTURE_SHIFT_SEC)
    assert [(it.author, it.text, it.id, it.published_at + shift) for it in past] == \
        [(it.author, it.text, it.id, it.published_at) for it in future]
    assert all(CLICK < it.published_at <= CLICK + timedelta(seconds=600) for it in future)
    assert min(it.published_at for it in future) - CLICK <= timedelta(seconds=60)


def test_detect_with_now_does_not_see_future_posts():
    future = make_campaign(TOPIC, CLICK, n_accounts=12, seed=7, schedule="future")
    assert detect(_organic() + future, now=CLICK) == detect(_organic(), now=CLICK)  # nothing published yet


def test_scan_grows_a_future_swarm_to_coordinated_and_matches_detect():
    organic, swarm = _organic(), make_campaign(TOPIC, CLICK, n_accounts=12, seed=7, schedule="future")
    items = organic + swarm  # the DB holds the future posts already; scan must not see them early
    accounts = {it.author for it in swarm}
    sizes, first_alarm = [], None
    for step in range(0, 61, 6):  # a frame every 60 s over the ~10-minute campaign (make test < 5 s)
        now = CLICK + timedelta(seconds=10 * step)
        findings, (frame,) = scan(items, topics=[TOPIC], now=now)
        assert findings == detect(items, now=now)
        assert frame.topic == TOPIC and frame.at == now
        sizes.append(frame.top_n_accounts or 0)
        if frame.top_verdict == "coordinated" and first_alarm is None:
            first_alarm = now
            assert frame.top_campaign_ids == [swarm[0].campaign_id] and not frame.top_capped
            assert frame.top_trace and frame.top_trace[-1][1] >= frame.sprt_upper
            assert [t for t, _ in frame.top_trace] == sorted(t for t, _ in frame.top_trace)
    assert first_alarm is not None and first_alarm < CLICK + timedelta(seconds=600)
    final = [f for f in detect(items, now=CLICK + timedelta(seconds=600)) if f.verdict == "coordinated"]
    assert len(final) == 1 and set(final[0].accounts) == accounts
    assert sizes[0] == 0 and max(sizes) >= 12


def test_scan_without_target_and_with_an_empty_topic():
    findings, frames = scan(_organic(), topics=[TOPIC, "quiet-topic"], now=CLICK)
    assert [f.topic for f in frames] == [TOPIC, "quiet-topic"]
    busy, quiet = frames
    assert busy.top_verdict != "coordinated" and busy.n_items > 0 and busy.max_pair_z is not None
    assert quiet.n_items == 0 and quiet.top_verdict is None and quiet.top_trace == [] and quiet.max_pair_z is None
    assert scan([], topics=["quiet-topic"], now=CLICK)[1][0].n_accounts == 0


def test_scan_marks_a_capped_news_reprint():
    items = _wire_story(with_social=False)
    now = max(it.published_at for it in items)
    _, (frame,) = scan(items, topics=[TOPIC], now=now)
    assert frame.top_verdict == "watching" and frame.n_watching >= 1
    assert frame.top_capped  # the trace crossed sprt_upper, the verdict was capped: drawn grey
    assert frame.top_campaign_ids == []


def test_best_candidate_order():
    base = TypeAdapter(list[Finding]).validate_json(
        (Path(__file__).resolve().parent.parent / "fixtures" / "findings.json").read_text())[0]

    def f(verdict, llr, n):
        return base.model_copy(update={"verdict": verdict, "llr": llr, "accounts": [f"a{k}" for k in range(n)],
                                       "id": f"{verdict}-{llr}-{n}"})

    assert best_candidate([]) is None
    assert best_candidate([f("watching", 9, 9), f("coordinated", 1, 3), f("organic", 5, 5)]).verdict == "coordinated"
    assert best_candidate([f("organic", 9, 9), f("watching", -1, 3)]).verdict == "watching"
    assert best_candidate([f("watching", 1, 9), f("watching", 2, 3)]).llr == 2  # same verdict: larger llr
    assert len(best_candidate([f("watching", 2, 3), f("watching", 2, 7)]).accounts) == 7  # then more accounts
