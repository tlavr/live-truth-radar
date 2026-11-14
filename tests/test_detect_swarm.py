"""T10: pair correlator, CFAR, SPRT, news echo and the full detect() on fixtures (offline, hash embedder)."""

import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
from pydantic import TypeAdapter

from contracts.models import Item
from detect import cfar, sprt
from detect.config import DEFAULT
from detect.correlation import TopicSignal, pair_correlation
from detect.pipeline import detect
from synth.campaign import make_campaign

FIX = Path(__file__).resolve().parent.parent / "fixtures"
TOPIC = "helsinki-tram-fares"


def _items(name: str) -> list[Item]:
    return TypeAdapter(list[Item]).validate_json((FIX / name).read_text(encoding="utf-8"))


def _signal(t, acct, code, gain=None) -> TopicSignal:
    """Hand-made topic signal (posts already in time order)."""
    t, acct, code = np.asarray(t, float), np.asarray(acct), np.asarray(code, float)
    gain = np.ones(len(t)) if gain is None else np.asarray(gain, float)
    close = np.sqrt(np.outer(gain, gain)) * np.clip(code @ code.T, 0, None)
    close[acct[:, None] == acct[None, :]] = 0
    return TopicSignal(t=t, acct=acct, accounts=[f"a{k}" for k in range(acct.max() + 1)],
                       gain=gain, code=code, close=close)


def test_correlation_peaks_at_true_lag():
    # Account 1 echoes account 0 ninety seconds later, three volleys with three different codes.
    codes = np.eye(4)
    t, acct, code = [], [], []
    for v, start in enumerate((0.0, 2000.0, 4000.0)):
        t += [start, start + 90.0]
        acct += [0, 1]
        code += [codes[v], codes[v]]
    t += [900.0]  # an unrelated post of a third account
    acct += [2]
    code += [codes[3]]
    R, lag = pair_correlation(_signal(t, acct, code))
    assert lag[0, 1] == 90.0 and lag[1, 0] == -90.0
    # Three volleys add up in one lag cell: 3 * 1.0 / sqrt(3 * 3) * exp(-90 / 120).
    assert R[0, 1] == pytest.approx(np.exp(-90 / 120))
    assert R[0, 2] == 0.0 and R[1, 2] == 0.0
    assert np.allclose(R, R.T) and np.allclose(np.diag(R), 1.0)


def test_independent_accounts_raise_no_alarm():
    rng = np.random.default_rng(7)
    n_posts, n_acc, dim = 300, 30, 64
    t = np.sort(rng.uniform(0, 6 * 3600, n_posts))
    acct = rng.integers(0, n_acc, n_posts)
    acct[:n_acc] = np.arange(n_acc)  # every account posts at least once
    code = rng.normal(size=(n_posts, dim))
    code /= np.linalg.norm(code, axis=1, keepdims=True)
    R, _ = pair_correlation(_signal(t, acct, code))
    assert cfar.swarm_groups(cfar.pair_z(R)) == []


def test_cfar_silent_on_flat_background_and_finds_planted_group():
    n = 12
    flat = np.zeros((n, n))
    np.fill_diagonal(flat, 1.0)
    z = cfar.pair_z(flat)  # median = MAD = 0: the sigma floor keeps z finite
    assert np.isfinite(z).all() and cfar.swarm_groups(z) == []

    R = flat.copy()
    for i in (2, 5, 7, 9):
        for j in (2, 5, 7, 9):
            if i != j:
                R[i, j] = 0.6
    z = cfar.pair_z(R)
    assert cfar.swarm_groups(z) == [[2, 5, 7, 9]]
    integ = cfar.integrate(z, [2, 5, 7, 9])
    # 6 pairs at z = 0.6 / 0.05 = 12 -> Z = 6 * 12 / sqrt(6); gain = 10 lg 6 dB.
    assert integ.mean_z == pytest.approx(12.0)
    assert integ.snr_db - integ.snr_db_single == pytest.approx(10 * np.log10(6))


def test_two_accounts_are_never_a_swarm():
    R = np.zeros((10, 10))
    np.fill_diagonal(R, 1.0)
    R[3, 4] = R[4, 3] = 0.9  # a perfect pair (dialogue or chance), but only N = 2
    assert cfar.swarm_groups(cfar.pair_z(R)) == []


def test_sprt_crosses_upper_and_lower_on_known_echo():
    upper, lower = sprt.thresholds(0.02, 0.1)
    assert upper == pytest.approx(np.log(45)) and lower == pytest.approx(np.log(0.1 / 0.98))
    # docs 3.7 example: mu0 = 0.1, sigma = 0.25, mu1 = 0.5; first post is the probe.
    hit = sprt.run(np.array([0.0, 0.65, 0.65, 0.65, 0.65]), 0.1, 0.25, alpha=0.02, beta=0.1)
    assert hit.verdict == "coordinated" and hit.decided_at == 3
    assert hit.trace == [0.0, 1.5, 3.0, 4.5]  # clipped at +1.5, stops at the decision
    miss = sprt.run(np.array([0.9, 0.05, 0.05, 0.05]), 0.1, 0.25, alpha=0.02, beta=0.1)
    assert miss.verdict == "organic" and miss.decided_at == 3 and miss.trace == [0.0, -1.0, -2.0, -3.0]
    wait = sprt.run(np.array([0.0, 0.65]), 0.1, 0.25, alpha=0.02, beta=0.1)
    assert wait.verdict == "watching" and wait.decided_at is None


def test_fixture_swarm_coordinated_organic_quiet_and_fast():
    items = _items("items.json")
    swarm = {it.author for it in items if it.synthetic}
    t0 = time.perf_counter()
    findings = detect(items)
    assert time.perf_counter() - t0 < 2.0
    hits = [f for f in findings if f.verdict == "coordinated"]
    assert len(hits) == 1 and set(hits[0].accounts) == swarm
    f = hits[0]
    assert f.synthetic and f.snr_db > f.snr_db_single and f.llr >= f.sprt_upper
    assert f.ambiguity is not None and sum(map(sum, f.ambiguity.counts)) > 0
    assert f.lag_sec is not None and all(f.lag_sec[i][i] == 0 for i in range(len(f.accounts)))

    organic = [it for it in items if not it.synthetic]
    assert not [f for f in detect(organic) if f.verdict == "coordinated"]


def test_live_sample_has_no_coordinated_if_present():
    path = FIX / "items_live_sample.json"
    if not path.exists():
        pytest.skip("live sample not committed yet (T2)")
    assert not [f for f in detect(_items(path.name)) if f.verdict == "coordinated"]


def test_injected_15_minute_campaign_is_caught():
    organic = [it for it in _items("items.json") if not it.synthetic]
    injected = make_campaign(TOPIC, datetime(2026, 11, 13, 19, 30, tzinfo=timezone.utc), n_accounts=12, seed=1)
    hits = [f for f in detect(organic + injected) if f.verdict == "coordinated"]
    assert len(hits) == 1
    assert set(hits[0].accounts) == {it.author for it in injected}
    assert hits[0].synthetic


def _news_burst(with_article: bool) -> list[Item]:
    organic = [it for it in _items("items.json") if not it.synthetic]
    t0 = datetime(2026, 11, 13, 19, 0, tzinfo=timezone.utc)
    headline = "HSL board approves 20 percent tram fare rise from January after budget vote"
    burst = [
        Item(id=f"echo-{k}", source="context_social", author=f"reader_{k}", topic=TOPIC,
             published_at=t0 + timedelta(minutes=10, seconds=20 * k + 7 * k * k),
             text=f"{prefix} {headline}")
        for k, prefix in enumerate(["Wow:", "Ugh,", "Breaking:", "Seriously?", "Just read:", "Noooo"])
    ]
    for k, it in enumerate(burst[:3]):  # a second wave: people keep discussing it
        burst.append(it.model_copy(update={"id": f"echo2-{k}", "published_at": it.published_at + timedelta(minutes=40),
                                           "text": f"Still can't believe it: {headline}"}))
    article = Item(id="news-1", source="context_news", author="hs.fi", topic=TOPIC, published_at=t0,
                   text=headline)
    return organic + burst + ([article] if with_article else [])


def test_news_echo_is_never_coordinated():
    control = [f for f in detect(_news_burst(with_article=False)) if f.verdict == "coordinated"]
    assert control and control[0].note is None  # without the article this burst does look coordinated
    findings = [f for f in detect(_news_burst(with_article=True)) if "reader_0" in f.accounts]
    assert findings
    for f in findings:
        assert f.verdict != "coordinated"
        assert f.note is not None and f.note.startswith("news echo: HSL board approves")
        assert f.decided_at_item is None or f.verdict == "organic"


def test_news_echo_rule_can_be_switched_off():
    from dataclasses import replace

    cfg = replace(DEFAULT, news_echo_enabled=False)
    findings = [f for f in detect(_news_burst(with_article=True), cfg=cfg) if "reader_0" in f.accounts]
    assert findings and all(f.note is None for f in findings)


def test_cfar_subtracts_the_background_median():
    n = 25  # 300 pairs: enough reference cells, no padding
    R = np.full((n, n), 0.2)
    np.fill_diagonal(R, 1.0)
    assert cfar.swarm_groups(cfar.pair_z(R)) == []  # uniformly busy topic: nothing stands out
    for i in (1, 4, 8):
        for j in (1, 4, 8):
            if i != j:
                R[i, j] = 0.5
    assert cfar.swarm_groups(cfar.pair_z(R)) == [[1, 4, 8]]


def test_injected_campaign_caught_in_quiet_topic():
    organic = [it for it in _items("items.json") if not it.synthetic]
    quiet = sorted({it.author for it in organic})[:2]
    for n_org, n in ((0, 12), (2, 12), (2, 4)):
        background = [it for it in organic if it.author in quiet[:n_org]]
        injected = make_campaign(TOPIC, datetime(2026, 11, 13, 19, 30, tzinfo=timezone.utc), n_accounts=n, seed=3)
        hits = [f for f in detect(background + injected) if f.verdict == "coordinated"]
        assert len(hits) == 1 and set(hits[0].accounts) == {it.author for it in injected}, (n_org, n)


def test_small_organic_topic_raises_no_alarm():
    organic = [it for it in _items("items.json") if not it.synthetic]
    accounts = sorted({it.author for it in organic})
    for k in range(3, len(accounts) + 1, 2):
        sub = set(accounts[:k])
        assert not [f for f in detect([it for it in organic if it.author in sub]) if f.verdict == "coordinated"]


@pytest.mark.parametrize("shift", [timedelta(minutes=-70), timedelta(minutes=20)])
def test_news_echo_needs_article_shortly_before_burst(shift):
    items = [
        it.model_copy(update={"published_at": it.published_at + shift}) if it.id == "news-1" else it
        for it in _news_burst(with_article=True)
    ]  # article 80 min before the burst (too old) or 10 min after it (cannot be the cause)
    hits = [f for f in detect(items) if f.verdict == "coordinated" and "reader_0" in f.accounts]
    assert hits and hits[0].note is None


def test_lag_grid_never_exceeds_tau_max():
    from dataclasses import replace

    from detect.correlation import lag_grid

    cfg = replace(DEFAULT, tau_max_sec=615.0)
    assert lag_grid(cfg).max() == 600.0 and lag_grid(replace(DEFAULT, tau_max_sec=50.0)).max() == 30.0
    f = next(f for f in detect(_items("items.json"), cfg=cfg) if f.verdict == "coordinated")
    assert f.ambiguity.lag_edges_sec[-1] == 615.0


def test_beam_calibration_suggests_ordered_thresholds():
    from detect.calibrate_beam import ROOT, corpus, suggest

    topics = corpus([ROOT / "fixtures" / "items.json"])
    c_lo, c_hi, lines = suggest(topics)
    assert 0 <= c_lo < c_hi <= 1 and len(lines) >= 2
    # The beam is built from organic posts only: the fixture swarm (swarm-001) is never in it.
    tram = topics["helsinki-tram-fares"]
    assert len(tram.organic) == 56 and len(tram.organic_authors) == 56
    assert all(t not in tram.organic for t in tram.other)


def test_beam_thresholds_are_off_topic_quantiles_on_the_organic_beam():
    from detect.calibrate_beam import thresholds

    rng = np.random.default_rng(0)
    d = 16
    axis = np.eye(d)[0]
    # Organic posts close to the axis; off-topic posts with known projections 0.0 .. 0.9 on it.
    E_on = axis + 0.05 * rng.standard_normal((20, d))
    E_on /= np.linalg.norm(E_on, axis=1, keepdims=True)
    proj = np.linspace(0.0, 0.9, 10)
    E_off = np.outer(proj, axis) + np.outer(np.sqrt(1 - proj**2), np.eye(d)[1])
    c_lo, c_hi, organic_q = thresholds(E_on, [f"a{k}" for k in range(20)], E_off)
    a = E_on.mean(axis=0) / np.linalg.norm(E_on.mean(axis=0))
    assert abs(c_lo - np.quantile(E_off @ a, 0.5)) < 0.02 and abs(c_hi - np.quantile(E_off @ a, 0.9)) < 0.02
    assert c_lo < c_hi < organic_q  # organic posts keep full gain


def test_beam_thresholds_follow_the_embedder_that_ran(monkeypatch):
    import detect.pipeline as pipeline
    from detect.embed import embed_with_backend, hash_embed

    # Gemini requested, no key (conftest): falls back to hashing and says so, no network.
    monkeypatch.setenv("LTR_EMBEDDER", "gemini")
    _, backend = embed_with_backend(["a post", "another post"])
    assert backend == "hash"
    assert DEFAULT.for_embedder("hash") is DEFAULT
    gem = DEFAULT.for_embedder("gemini")
    assert (gem.c_lo, gem.c_hi) == (DEFAULT.gemini_c_lo, DEFAULT.gemini_c_hi)

    # The same vectors labelled "gemini" get the Gemini beam: hash cosines (~0.4) fall
    # below gemini_c_lo, every post loses its beam gain and the swarm disappears.
    items = _items("items.json")
    monkeypatch.setattr(pipeline, "embed_with_backend", lambda texts: (hash_embed(texts), "gemini"))
    assert not [f for f in detect(items) if f.verdict == "coordinated"]
    monkeypatch.setattr(pipeline, "embed_with_backend", lambda texts: (hash_embed(texts), "hash"))
    assert [f for f in detect(items) if f.verdict == "coordinated"]
