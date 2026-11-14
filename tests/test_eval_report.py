"""T13: eval report on fixtures (offline, hash embedder, small run)."""

import json
from collections import Counter

import numpy as np

from contracts.models import MetricsReport
from eval.run import WINDOW, WINDOW_BASE, background_window, build_report, load_background, roc_curve


def test_report_valid_roc_monotone_values_in_unit_interval(tmp_path):
    (tmp_path / "labels.csv").write_text(
        "account,topic,alerted,verdict,label,note\n"
        "acct-1,helsinki-tram-fares,1,coordinated,suspicious,\n"
        "acct-2,helsinki-tram-fares,1,coordinated,organic,\n"
        "acct-3,helsinki-tram-fares,1,coordinated,unclear,\n"
        "acct-4,helsinki-tram-fares,0,watching,organic,\n"
        "acct-5,helsinki-tram-fares,0,,organic,\n"
        "acct-6,helsinki-tram-fares,0,,suspicious,\n",
        encoding="utf-8",
    )
    (tmp_path / "labels_meta.json").write_text(
        json.dumps({"helsinki-tram-fares": {"n_accounts": 40, "n_alerted": 4}}), encoding="utf-8"
    )
    report = build_report(n_windows=6, n_size_windows=3, ks=(2.0, 3.0, 5.0), sizes=(3, 12), dev=True,
                          labels_dir=tmp_path)
    report = MetricsReport.model_validate_json(report.model_dump_json())  # survives the JSON round trip

    assert report.embedder == "hash"
    pfa = [p for p, _ in report.roc]
    pd = [d for _, d in report.roc]
    assert pfa == sorted(pfa) and pd == sorted(pd)
    # Hash-embedder points can all coincide, so check the sort + running max on hand-made points too.
    assert roc_curve([(0.3, 0.5), (0.0, 0.2), (0.1, 0.1)]) == [(0.0, 0.2), (0.1, 0.2), (0.3, 0.5)]
    shares = pfa + pd + [d for _, d in report.pd_by_size] + list(report.live_precision_ci)
    shares += [report.detection_rate, report.operating_pfa, report.live_precision, report.live_fpr]
    shares += [] if report.swarm_purity is None else [report.swarm_purity]
    assert all(0.0 <= x <= 1.0 for x in shares)
    # 1 suspicious / (1 suspicious + 1 organic); unclear and watching rows are excluded.
    assert report.live_precision == 0.5 and report.n_labelled == 5
    # FPR = 4*0.5 / (4*0.5 + 36*0.5) = 0.1
    assert abs(report.live_fpr - 0.1) < 1e-9

    # "subset" background on a topic longer than the window: a slice of the timeline, never clamped into
    # a fake zero-lag burst at the window edge.
    items = max(load_background().values(), key=len)
    t0 = min(it.published_at for it in items)
    stretched = [it.model_copy(update={"published_at": t0 + 5 * (it.published_at - t0)}) for it in items]
    worst = Counter(it.published_at for it in stretched).most_common(1)[0][1]
    rng = np.random.default_rng(0)
    for _ in range(10):
        window = background_window(stretched, rng, "subset")
        assert window and all(WINDOW_BASE <= it.published_at <= WINDOW_BASE + WINDOW for it in window)
        assert Counter(it.published_at for it in window).most_common(1)[0][1] <= worst
    # "shift" background on the same stretched topic: a 6 h slice first, then the per-author shift, so the
    # timeline is never folded onto itself (more posts and close pairs than any real 6 h window has).
    for _ in range(10):
        window = background_window(stretched, rng, "shift")
        assert window and all(WINDOW_BASE <= it.published_at <= WINDOW_BASE + WINDOW for it in window)
        assert len(window) < len(stretched)


def _item(i, topic, author, minutes, **kw):
    from datetime import timedelta

    from contracts.models import Item

    return Item(id=f"i{i}", source="context_news", author=author, topic=topic, text=f"post {i}",
                published_at=WINDOW_BASE + timedelta(minutes=minutes), **kw)


def test_load_background_keeps_each_item_once_across_files(tmp_path):
    from pydantic import TypeAdapter

    from contracts.models import Item

    a = [_item(1, "t", "x", 0), _item(2, "t", "y", 5)]
    b = [_item(2, "t", "y", 5), _item(3, "t", "z", 9), _item(4, "t", "s", 1, synthetic=True)]
    dump = TypeAdapter(list[Item]).dump_json
    (tmp_path / "items_live_sample.json").write_bytes(dump(a))
    (tmp_path / "items_live_background.json").write_bytes(dump(b))
    bg = load_background(tmp_path)
    assert [it.id for it in bg["t"]] == ["i1", "i2", "i3"]  # duplicate and synthetic dropped, time order


def test_real_windows_are_non_overlapping_pieces_with_original_timing():
    from eval.run import real_windows

    items = [_item(k, "t", f"a{k % 3}", 50 * k) for k in range(20)]  # ~16 h timeline, a post every 50 min
    items.append(_item(99, "t", "late", 50 * 19 + 720))  # after a 12 h gap: an empty piece is skipped
    wins = real_windows({"t": items}, ["t"])
    width = WINDOW.total_seconds()
    assert all(w.mode == "real" and not w.injected for w in wins)
    ids = [it.id for w in wins for it in w.items]
    assert sorted(ids) == sorted(it.id for it in items) and len(ids) == len(set(ids))  # a partition
    assert [len(w.items) for w in wins] == [8, 7, 5, 1]
    for w in wins:
        rel = [(it.published_at - WINDOW_BASE).total_seconds() for it in w.items]
        assert all(0 <= r < width for r in rel)
    orig = {it.id: it.published_at for it in items}
    first = wins[0].items
    assert all(it.published_at - first[0].published_at == orig[it.id] - orig[first[0].id] for it in first)
