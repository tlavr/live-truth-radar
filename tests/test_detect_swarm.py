"""T10: pair correlator, CFAR, SPRT, news echo and the full detect() on fixtures (offline, hash embedder)."""

import time
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
from pydantic import TypeAdapter

from contracts.models import Item
from detect import cfar, sprt
from detect.config import DEFAULT, SLOW
from detect.correlation import TopicSignal, build_signal, pair_correlation
from detect.pipeline import detect, drop_expired_synthetic
from synth.campaign import make_campaign

FIX = Path(__file__).resolve().parent.parent / "fixtures"
TOPIC = "helsinki-tram-fares"


def _items(name: str) -> list[Item]:
    return TypeAdapter(list[Item]).validate_json((FIX / name).read_text(encoding="utf-8"))


def _signal(t, acct, code, gain=None) -> TopicSignal:
    """Hand-made topic signal; posts are put in time order (stable), as the pipeline does."""
    t, acct, code = np.asarray(t, float), np.asarray(acct), np.asarray(code, float)
    order = np.argsort(t, kind="stable")
    t, acct, code = t[order], acct[order], code[order]
    gain = np.ones(len(t)) if gain is None else np.asarray(gain, float)[order]
    return build_signal(t, acct, [f"a{k}" for k in range(acct.max() + 1)], gain, code)


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
    n = 70  # 2415 pairs: enough reference cells, no padding
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


def test_news_echo_off_in_news_only_stream():
    # [ALT]: no context_social posts at all; an injected swarm that happens to repeat a headline
    # must still be caught, otherwise the rule would block every inject into a live news topic.
    alt = [
        it.model_copy(update={"source": "context_news"})  # organic background: outlets
        if it.id.startswith("fx-")
        else it.model_copy(update={"source": "synthetic", "synthetic": True})
        if it.source == "context_social"
        else it
        for it in _news_burst(with_article=True)
    ]
    assert not any(it.source == "context_social" for it in alt)
    hits = [f for f in detect(alt) if "reader_0" in f.accounts]
    assert hits and hits[0].verdict == "coordinated" and hits[0].note is None


def test_second_inject_in_the_same_topic_does_not_mask_the_first():
    """Two injected swarms in one window: each must stay coordinated (the other one is not its H0)."""
    now = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
    first = make_campaign("helsinki-tram-fares", now)
    second = make_campaign("helsinki-tram-fares", now + timedelta(minutes=20))
    found = [f for f in detect(first + second) if f.verdict == "coordinated"]
    assert len(found) == 2
    assert {frozenset(f.accounts) for f in found} == {
        frozenset(it.author for it in first),
        frozenset(it.author for it in second),
    }
    assert all(f.synthetic for f in found)


def _dense_reference(sig: TopicSignal, members=None, cfg=DEFAULT):
    """The former (n, n) implementation of echo and the near-pair set, for the equivalence test."""
    n = sig.n_posts
    close = np.sqrt(np.outer(sig.gain, sig.gain)) * np.clip(sig.code @ sig.code.T, 0.0, None)
    close[sig.acct[:, None] == sig.acct[None, :]] = 0.0
    dt = sig.t[:, None] - sig.t[None, :]
    ok = np.tril(np.ones((n, n), dtype=bool), k=-1) & (dt >= 0) & (dt <= cfg.tau_max_sec)
    if members is not None:
        ok &= members[sig.acct][None, :]
    x = np.where(ok, close * np.exp(-np.clip(dt, 0.0, None) / cfg.lag_kernel_sec), 0.0).max(axis=1)
    p, q = np.triu_indices(n, k=1)
    near = (sig.acct[p] != sig.acct[q]) & (sig.t[q] - sig.t[p] <= sig.pair_window)
    return x, set(zip(p[near].tolist(), q[near].tolist())), close


def test_near_pairs_match_the_dense_computation():
    rng = np.random.default_rng(7)
    n = 700  # several PAIR_BLOCK blocks
    t = np.sort(np.round(rng.uniform(0, 4 * 3600, n) / 15) * 15)  # 15 s grid: ties, gaps at tau_max and 615 s
    acct = rng.integers(0, 120, n)
    code = rng.normal(size=(n, 8))
    code /= np.linalg.norm(code, axis=1, keepdims=True)
    sig = _signal(t, acct, code, gain=rng.uniform(0.2, 1.0, n))
    members = rng.random(120) < 0.3
    for m in (None, members):
        x_ref, pairs_ref, close = _dense_reference(sig, m)
        np.testing.assert_allclose(sprt.echo(sig, m), x_ref, rtol=0, atol=1e-12)
    assert sig.pair_window == 615.0  # last lag cell edge: (20 + 0.5) * 30 s
    assert set(zip(sig.pair_p.tolist(), sig.pair_q.tolist())) == pairs_ref  # the whole window, beyond tau_max too
    np.testing.assert_allclose(sig.pair_close, close[sig.pair_p, sig.pair_q], rtol=0, atol=1e-12)
    # pair correlation over all pairs equals the one over near pairs: farther pairs fall outside the lag grid
    full = _signal(t, acct, code, gain=sig.gain)
    p, q = np.triu_indices(n, k=1)
    keep = sig.acct[p] != sig.acct[q]
    full.pair_p, full.pair_q = p[keep], q[keep]
    full.pair_dt = sig.t[full.pair_q] - sig.t[full.pair_p]
    full.pair_close = close[full.pair_p, full.pair_q]
    full.pair_cos = np.einsum("ij,ij->i", code[full.pair_p], code[full.pair_q])
    full.pair_window = np.inf
    for got, want in zip(pair_correlation(sig), pair_correlation(full)):
        np.testing.assert_array_equal(got, want)
    with pytest.raises(ValueError):  # a wider cfg must not silently read a narrow signal
        sprt.echo(sig, cfg=SLOW)
    with pytest.raises(ValueError):
        pair_correlation(sig, SLOW)


def test_large_window_needs_no_post_by_post_matrices():
    """A busy topic (4000 posts in 6 h) must not blow up the worker: one dense (n, n) float matrix alone is 128 MB."""
    import tracemalloc

    from detect.correlation import topic_signal
    from detect.embed import embed_with_backend

    rng = np.random.default_rng(1)
    n = 4000
    t = np.sort(rng.uniform(0, 6 * 3600, n))
    authors = [f"u{k}" for k in rng.integers(0, 2000, n)]
    E, _ = embed_with_backend([f"tram fare post {i} {rng.integers(50)}" for i in range(n)])
    tracemalloc.start()
    sig = topic_signal(E, t, authors)
    sprt.echo(sig)
    pair_correlation(sig)
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    # legit: embeddings + codes (n x 1024, ~64 MB), account x account R and lag (~50 MB); the dense version
    # held several (n, n) matrices at once (> 700 MB)
    assert peak < 250 * 2**20
    assert len(sig.pair_p) < n * n / 20  # only pairs within the lag window


def test_two_injects_in_a_row_stay_coordinated():
    # Two campaigns 16 s apart in a quiet topic: 24 swarm accounts, more pairs than the old cfar_min_ref_cells=200.
    organic = [it for it in _items("items.json") if not it.synthetic]
    quiet = sorted({it.author for it in organic})[:2]
    t = datetime(2026, 11, 13, 19, 30, tzinfo=timezone.utc)
    first = make_campaign(TOPIC, t, n_accounts=12, seed=3)
    second = make_campaign(TOPIC, t + timedelta(seconds=16), n_accounts=12, seed=4)
    items = [it for it in organic if it.author in quiet] + first + second
    hits = [f for f in detect(items) if f.verdict == "coordinated"]
    assert len(hits) == 1 and hits[0].synthetic
    assert set(hits[0].accounts) == {it.author for it in first + second}


def test_injected_campaign_expires_after_ttl_in_live_runs():
    organic = [it for it in _items("items.json") if not it.synthetic]
    click = datetime(2026, 11, 13, 19, 30, tzinfo=timezone.utc)
    injected = make_campaign(TOPIC, click, n_accounts=12, seed=1)
    t = max(it.published_at for it in injected)  # the TTL runs from the newest campaign post
    ttl = timedelta(seconds=DEFAULT.synthetic_ttl_sec)

    def coordinated(now):
        return [f for f in detect(organic + injected, now=now) if f.verdict == "coordinated"]

    # the newest post is 4-6 min before the click, so the inject lasts at least 9 min after the click
    assert [f.synthetic for f in coordinated(click + timedelta(minutes=9))] == [True]
    assert [f.synthetic for f in coordinated(t + ttl - timedelta(seconds=1))] == [True]
    assert not [f for f in coordinated(t + ttl + timedelta(seconds=1)) if f.synthetic]
    assert [f.synthetic for f in coordinated(None)] == [True]  # tests and eval keep every item


def test_naive_now_is_rejected():
    with pytest.raises(ValueError, match="timezone-aware"):
        detect(_items("items.json"), now=datetime(2026, 11, 13, 19, 30))


def test_synthetic_items_without_campaign_id_expire_one_by_one():
    now = datetime(2026, 11, 13, 19, 30, tzinfo=timezone.utc)
    old, fresh = make_campaign(TOPIC, now, n_accounts=3, seed=1)[:2]
    old = old.model_copy(update={"campaign_id": None, "published_at": now - timedelta(hours=1)})
    fresh = fresh.model_copy(update={"campaign_id": None, "published_at": now})
    kept = drop_expired_synthetic([old, fresh], now, DEFAULT.synthetic_ttl_sec)
    assert [it.id for it in kept] == [fresh.id]


def _wire_story(with_social: bool = True) -> list[Item]:
    # Outlets reprint one wire story within about a minute (the live microsoft-global-outage false alarm):
    # the _news_burst headline, posted by context_news outlets instead of readers. with_social=False
    # drops the organic social posts: the news-only [ALT] stream, where the news-echo rule is off.
    burst = [it for it in _news_burst(with_article=False) if it.author.startswith("reader_")]
    news = [it.model_copy(update={"source": "context_news", "author": f"outlet{it.author[-1]}.example"}) for it in burst]
    organic = [it for it in _items("items.json") if not it.synthetic]
    background = organic if with_social else [it.model_copy(update={"source": "context_news"}) for it in organic]
    return background + news


def test_news_reprint_is_capped_at_watching():
    for with_social in (True, False):
        control = [f for f in detect(_wire_story(with_social), cfg=replace(DEFAULT, news_reprint_enabled=False))
                   if any(a.startswith("outlet") for a in f.accounts)]
        assert [f for f in control if f.verdict == "coordinated"], with_social  # the rule is what caps it
        findings = [f for f in detect(_wire_story(with_social)) if any(a.startswith("outlet") for a in f.accounts)]
        assert findings, with_social
        for f in findings:
            assert f.verdict != "coordinated"
            if all(a.startswith("outlet") for a in f.accounts):
                by_id = {it.id: it for it in _wire_story(with_social)}
                earliest = min((by_id[i] for i in f.item_ids), key=lambda it: (it.published_at, it.id))
                assert f.note == "news reprint: " + earliest.text[:80], f.note


def test_inject_into_news_only_topic_stays_coordinated():
    news = _wire_story(with_social=False)
    injected = make_campaign(TOPIC, datetime(2026, 11, 13, 19, 30, tzinfo=timezone.utc), n_accounts=12, seed=2)
    hits = [f for f in detect(news + injected) if f.verdict == "coordinated"]
    assert len(hits) == 1 and hits[0].synthetic and hits[0].note is None
    assert set(hits[0].accounts) == {it.author for it in injected}
