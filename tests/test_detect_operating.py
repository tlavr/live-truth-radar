"""T12c: false-alarm slider operating points (offline, hash embedder)."""

from datetime import datetime, timezone

import pytest

from detect.operating import OperatingPoint, OperatingPoints, alpha_for_pfa, load_points, pfa_upper95, write_points
from eval.run import build_operating_points


def _p(alpha, pfa, pd=0.9):
    return OperatingPoint(alpha=alpha, pfa=pfa, pfa_upper95=pfa_upper95(round(pfa * 200), 200), pd=pd,
                          pd_small=pd / 2, posts_to_decision=4.0, n_background=200)


def test_alpha_for_pfa_is_monotone_and_picks_the_largest_admissible():
    points = [_p(0.01, 0.0), _p(0.02, 0.0), _p(0.05, 0.0)]
    assert alpha_for_pfa(points, 0.02) == 0.02
    assert alpha_for_pfa(points, 0.05) == 0.05
    assert alpha_for_pfa(points, 0.03) == 0.02  # between stops: the lower one
    picked = [alpha_for_pfa(points, x) for x in (0.0, 0.005, 0.01, 0.015, 0.02, 0.04, 0.05, 0.5)]
    assert picked == sorted(picked)


def test_alpha_for_pfa_edges_and_measured_pfa():
    points = [_p(0.05, 0.0), _p(0.01, 0.0), _p(0.02, 0.0)]  # order does not matter
    assert alpha_for_pfa(points, 0.001) == 0.01  # below every stop: most conservative
    assert alpha_for_pfa(points, 0.9) == 0.05  # above every stop: the largest
    # a stop whose measured Pfa exceeds the request is skipped even if its design alpha fits
    assert alpha_for_pfa([_p(0.01, 0.0), _p(0.02, 0.03), _p(0.05, 0.03)], 0.025) == 0.01
    # every stop measured too high: still the most conservative one
    assert alpha_for_pfa([_p(0.01, 0.2), _p(0.05, 0.2)], 0.05) == 0.01
    with pytest.raises(ValueError):
        alpha_for_pfa([], 0.02)


def test_pfa_upper_bound():
    assert pfa_upper95(0, 1000) == pytest.approx(0.003, abs=1e-4)  # ~ rule of three
    assert pfa_upper95(1, 1000) == pytest.approx(0.00473, abs=1e-4)  # exact, not the normal approximation
    assert pfa_upper95(1, 1) == 1.0
    bounds = [pfa_upper95(k, 200) for k in range(0, 201)]
    assert bounds == sorted(bounds) and all(k / 200 <= b <= 1 for k, b in enumerate(bounds))
    for bad in ((0, 0), (5, 4), (-1, 10)):
        with pytest.raises(ValueError):
            pfa_upper95(*bad)


def test_points_round_trip_and_missing_file(tmp_path):
    pts = OperatingPoints(generated_at=datetime(2026, 11, 14, tzinfo=timezone.utc), embedder="hash",
                          cfar_k=3.0, points=[_p(0.01, 0.0), _p(0.02, 0.0)])
    write_points(pts, tmp_path / "op.json")
    assert load_points(tmp_path / "op.json") == pts
    assert load_points(tmp_path / "missing.json") is None
    (tmp_path / "bad.json").write_text("{", encoding="utf-8")
    assert load_points(tmp_path / "bad.json") is None


def test_eval_operating_points_on_fixtures(monkeypatch, tmp_path):
    from tests.test_eval_report import _two_inject_topics

    import eval.run as run

    seen = []
    real_run_trials = run.run_trials

    def spy(windows, cfg):
        seen.append(cfg.alpha)
        return real_run_trials(windows, cfg)

    monkeypatch.setattr(run, "run_trials", spy)
    monkeypatch.setattr(run, "BACKGROUND_FILES", ("items.json", "items_live_sample.json"))  # small, fast
    _two_inject_topics(monkeypatch, tmp_path)
    pts = build_operating_points(n_windows=3, alphas=(0.005, 0.05), dev=True)
    assert seen == [0.005] * 3 + [0.05] * 3  # background, ROC swarm, small swarm at each alpha
    assert [p.alpha for p in pts.points] == [0.005, 0.05]
    strict, loose = pts.points
    assert strict.pd_small <= loose.pd_small  # holds on these fixed windows (not a theorem: B moves too)
    assert all(0 <= p.pfa <= p.pfa_upper95 <= 1 for p in pts.points)
    for p in pts.points:  # the fixture timelines give a few real (independent) windows
        assert p.n_independent > 0 and 0 <= p.pfa_independent <= p.pfa_independent_upper95 <= 1
