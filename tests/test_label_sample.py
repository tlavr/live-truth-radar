"""T14 prep: labelling sample skeleton (offline, no DB)."""

import csv
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from contracts.models import Finding, Item
from eval.run import live_metrics
from ingest import label_sample
from ingest.label_sample import COLUMNS, build_sample, write_sample

FIX = Path(__file__).resolve().parent.parent / "fixtures" / "findings.json"
SALT = "test-salt"
T = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)


def _item(topic: str, author: str, k: int, synthetic: bool = False) -> Item:
    return Item(id=f"{topic}-{author}-{k}", source="synthetic" if synthetic else "context_social", author=author,
                published_at=T, text="x", topic=topic, synthetic=synthetic)


TEMPLATE = TypeAdapter(list[Finding]).validate_json(FIX.read_text())[0]


def _finding(topic: str, verdict: str, accounts: list[str], llr: float = 0.0, synthetic: bool = False) -> Finding:
    return TEMPLATE.model_copy(update={"id": f"{topic}-{verdict}-{accounts[0]}", "topic": topic, "verdict": verdict,
                                       "accounts": accounts, "llr": llr, "synthetic": synthetic})


@pytest.fixture
def world():
    """Topic a: 3 real alerted, 2 watching (llr 2.0 / 1.0), real5 alerted with an inject, 14 quiet; 4 bots.
    Topic b: 10 quiet, one of them shares a handle with a bot of topic a."""
    a = [f"real{i}" for i in range(20)]
    bots = [f"bot{i}" for i in range(4)]
    b = [f"user{i}" for i in range(9)] + ["bot0"]
    items = [_item("a", x, 0) for x in a] + [_item("a", x, 0, synthetic=True) for x in bots] + [_item("b", x, 0) for x in b]
    findings = [
        _finding("a", "coordinated", a[:3]),
        _finding("a", "coordinated", bots, synthetic=True),
        _finding("a", "coordinated", ["real5", "bot0"], synthetic=True),  # mixed with an inject: out of population
        _finding("a", "watching", ["real3"], llr=1.0),
        _finding("a", "watching", ["real4"], llr=2.0),
        _finding("a", "organic", ["real6"]),
    ]
    return items, findings, a, bots


def test_strata_meta_and_watching_fill(world):
    items, findings, a, bots = world
    s = build_sample(items, findings, SALT, n_alerted=5, n_quiet=6)
    by = {v: [r for r in s.rows if r["verdict"] == v] for v in ("coordinated", "watching", "")}

    assert {s.handles[r["account"]] for r in by["coordinated"]} == set(a[:3])
    assert all(r["alerted"] == "1" for r in by["coordinated"]) and all(r["alerted"] == "0" for r in by[""] + by["watching"])
    assert len(by[""]) == 6 and {r["topic"] for r in by[""]} == {"a", "b"}  # round robin over topics
    assert all(s.handles[r["account"]] not in a[:3] for r in by[""])
    quiet = {s.handles[r["account"]] for r in by[""]}
    # fill only up to n_alerted, highest LLR first, never an account already in the quiet sample
    assert {s.handles[r["account"]] for r in by["watching"]} == {"real3", "real4"} - quiet
    one = build_sample(items, findings, SALT, n_alerted=4, n_quiet=0)  # one slot: the highest LLR wins
    assert [one.handles[r["account"]] for r in one.rows if r["verdict"] == "watching"] == ["real4"]
    assert s.meta == {"a": {"n_accounts": 19, "n_alerted": 3}, "b": {"n_accounts": 10, "n_alerted": 0}}
    assert not {h for acct, h in s.handles.items() if any(r["account"] == acct and r["topic"] == "a" for r in s.rows)} & (
        set(bots) | {"real5"})
    assert all(r["account"].startswith("acct-") for r in s.rows)
    assert not {r["account"] for r in s.rows} & (set(a) | set(bots))  # no real handle in the rows
    assert len({(r["topic"], r["account"]) for r in s.rows}) == len(s.rows)


def test_no_fill_when_enough_alerts_and_deterministic(world):
    items, findings, *_ = world
    s = build_sample(items, findings, SALT, n_alerted=2, n_quiet=4)
    assert sum(r["verdict"] == "coordinated" for r in s.rows) == 2
    assert not any(r["verdict"] == "watching" for r in s.rows)
    assert build_sample(items, findings, SALT, n_alerted=2, n_quiet=4) == s


def test_refuses_without_salt(world):
    items, findings, *_ = world
    with pytest.raises(ValueError):
        build_sample(items, findings, "")


def test_alerted_split_is_proportional_and_keeps_every_topic():
    """Precision pools topics (big topic keeps its share); live FPR needs >= 1 alerted label per topic."""
    sizes = {"big": 40, "mid": 8, "small": 2}
    items = [_item(t, f"{t}{i}", 0) for t, k in sizes.items() for i in range(k)]
    findings = [_finding(t, "coordinated", [f"{t}{i}" for i in range(k)]) for t, k in sizes.items()]
    picks = [r["topic"] for r in build_sample(items, findings, SALT, n_alerted=10, n_quiet=0).rows]
    assert len(picks) == 10 and {t: picks.count(t) for t in sizes} == {"big": 7, "mid": 2, "small": 1}
    assert len(build_sample(items, findings, SALT, n_alerted=60, n_quiet=0).rows) == 50  # all fit: take all


def test_real_alert_survives_a_mixed_inject_finding():
    items = [_item("a", x, 0) for x in ("r1", "r2", "r3", "r4")] + [_item("a", "bot", 0, synthetic=True)]
    findings = [_finding("a", "coordinated", ["r1", "r2", "r3"]),
                _finding("a", "coordinated", ["r1", "r4", "bot"], synthetic=True)]
    s = build_sample(items, findings, SALT, n_alerted=5, n_quiet=5)
    assert s.meta == {"a": {"n_accounts": 3, "n_alerted": 3}}  # r4 out (inject only), r1 stays alerted


def test_written_files_feed_eval_and_labels_are_never_overwritten(world, tmp_path, monkeypatch):
    items, findings, *_ = world
    handles = tmp_path / "cache" / "label_handles.csv"
    monkeypatch.setattr(label_sample, "HANDLES", handles)
    s = build_sample(items, findings, SALT, n_alerted=5, n_quiet=6)
    write_sample(s, tmp_path, handles=handles)
    old = build_sample([_item("z", "old_user", 0)], [], SALT, n_quiet=1)
    write_sample(old, tmp_path, handles=handles)
    write_sample(s, tmp_path, handles=handles)  # an unlabelled skeleton may be regenerated
    with pytest.raises(ValueError):
        write_sample(s, tmp_path, handles=tmp_path / "eval" / "label_handles.csv")  # handles only under cache/

    with (tmp_path / "labels.csv").open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    assert tuple(rows[0]) == COLUMNS
    for r in rows:  # alerts suspicious, quiet organic -> precision 1, FPR 0
        r["label"] = "suspicious" if r["alerted"] == "1" else "organic"
    with (tmp_path / "labels.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    with pytest.raises(FileExistsError):
        write_sample(s, tmp_path, handles=handles)  # labels are there now
    m = live_metrics(tmp_path / "labels.csv", tmp_path / "labels_meta.json")
    assert m.precision == 1.0 and m.fpr == 0.0
    assert m.n_labelled == sum(r["verdict"] != "watching" for r in rows)
    assert json.loads((tmp_path / "labels_meta.json").read_text()) == s.meta
    with handles.open(newline="") as fh:
        assert {r["pseudonym"]: r["handle"] for r in csv.DictReader(fh)} == {**old.handles, **s.handles}  # merged
