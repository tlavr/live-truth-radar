"""Experiment: wave split of a detected group (cfg.wave_gap_sec) and the time x meaning map."""

import json
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

from contracts.models import Item
from detect.config import DEFAULT
from detect.pipeline import detect
from detect.timemap import time_map

TOPIC = "helsinki-tram-fares"


def _items() -> list[Item]:
    raw = json.loads((Path(__file__).resolve().parent.parent / "fixtures" / "items.json").read_text(encoding="utf-8"))
    return [Item.model_validate(r) for r in (raw if isinstance(raw, list) else raw["items"])]


def test_wave_split_keeps_the_decision_and_cuts_the_group_at_pauses():
    items = _items()
    (whole,) = detect(items, cfg=replace(DEFAULT, wave_gap_sec=0))
    waves = detect(items, cfg=replace(DEFAULT, wave_gap_sec=120))
    assert len(waves) > 1 and len({f.id for f in waves}) == len(waves)
    assert [i for f in waves for i in f.item_ids] == whole.item_ids  # this swarm has no stragglers
    assert [x for f in waves for x in f.sprt_trace] == whole.sprt_trace
    assert sum(f.decided_at_item is not None for f in waves) == 1
    by_id = {it.id: it for it in items}
    for f in waves:
        assert (f.verdict, f.llr, set(f.accounts)) == (whole.verdict, whole.llr, set(whole.accounts))
        times = sorted(by_id[i].published_at for i in f.item_ids)
        assert all((b - a).total_seconds() <= 120 for a, b in zip(times, times[1:]))
    starts = [f.first_seen for f in waves]
    assert starts == sorted(starts) and all((b - a).total_seconds() > 120 for a, b in zip(starts, starts[1:]))


def test_time_map_puts_each_wave_at_its_own_time():
    items = [it for it in _items() if it.topic == TOPIC]
    waves = detect(items, cfg=replace(DEFAULT, wave_gap_sec=120))
    now = max(it.published_at for it in items)
    m = time_map(TOPIC, items, {f.id: f.item_ids for f in waves}, now=now, step_sec=120)
    assert len(m.total) == 20 and all(len(row) == m.n_bins for row in m.total)
    cols = []
    for f in waves:
        grid = m.groups[f.id]
        assert all(v <= t for row, trow in zip(grid, m.total) for v, t in zip(row, trow))
        hit = sorted({c for row in grid for c, v in enumerate(row) if v})
        assert hit and hit[-1] - hit[0] <= 1  # one wave: one or two neighbouring 2-minute bins
        expected = int((f.last_seen - m.start).total_seconds() // m.step_sec)
        assert hit[-1] == expected
        cols.append(hit[0])
    assert len(set(cols)) == len(waves)


def test_time_map_span_keeps_only_the_last_minutes():
    items = [it for it in _items() if it.topic == TOPIC]
    now = max(it.published_at for it in items)
    full = time_map(TOPIC, items, {}, now=now)
    last = time_map(TOPIC, items, {}, now=now, span_sec=600)
    assert last.n_bins == 20 and last.mismatch_edges[1] == 0.05
    assert [row[-20:] for row in full.total] == last.total  # same pairs, only the newest 10 min


def test_time_map_rewound_to_an_old_wave_shows_it_near_the_origin():
    items = [it for it in _items() if it.topic == TOPIC]
    waves = detect(items, cfg=replace(DEFAULT, wave_gap_sec=120))
    first = min(waves, key=lambda f: f.first_seen)
    at = first.last_seen + timedelta(seconds=60)  # what the dashboard asks for an off-map group
    m = time_map(TOPIC, items, {f.id: f.item_ids for f in waves}, now=at, span_sec=600)
    assert m.now == at and m.n_bins == 20
    hit = sorted({c for row in m.groups[first.id] for c, v in enumerate(row) if v})
    assert hit and hit[-1] == m.n_bins - 2  # last post exactly 60 s before `at`: the 30-60 s bin
    assert all(not any(row) for fid, g in m.groups.items() if fid != first.id and min(
        w.first_seen for w in waves if w.id == fid) > at for row in g)  # later waves are not on the map yet
