"""Skeleton of the T14 live labelling sample (P1): eval/labels.csv + eval/labels_meta.json.

Per topic, the real accounts of the detector window form two strata (docs/signal-processing.md 3.10):
  * alerted: accounts of `coordinated` findings, alerted=1, verdict=coordinated (~n_alerted rows);
  * quiet:   random accounts without a `coordinated` finding, alerted=0, verdict empty (~n_quiet rows),
             even if they sit in a `watching` finding: they stand for the whole quiet stratum in live FPR.
If there are fewer alerted accounts than n_alerted, the gap is filled from `watching` findings with the
highest LLR (verdict=watching; eval.run leaves those rows out of both formulas).
Synthetic data is excluded: synthetic items, their authors, and every finding with synthetic=True.
labels_meta.json holds the strata sizes {topic: {n_accounts, n_alerted}} over ALL real accounts of the window.
Rows carry contracts.pseudonym(author, LTR_HASH_SALT); the pseudonym,handle map goes to label_handles.csv,
which must stay in cache/ (git-ignored).

On the VPS (eval/ is mounted read-only in the containers, cache/ is writable):
    ssh $VPS 'cd live-truth-radar && docker compose -f infra/docker-compose.yml exec -T api \
        python -m ingest.label_sample --hours 6'
    scp $VPS:live-truth-radar/cache/labels/labels.csv $VPS:live-truth-radar/cache/labels/labels_meta.json eval/
    scp $VPS:live-truth-radar/cache/labels/label_handles.csv cache/
Then fill the `label` column (suspicious / organic / unclear) and run `make eval`.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from contracts.models import Finding, Item, pseudonym

COLUMNS = ("account", "topic", "alerted", "verdict", "label", "note")
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "cache" / "labels"


@dataclass(frozen=True)
class Sample:
    rows: list[dict[str, str]]  # COLUMNS, label/note empty
    meta: dict[str, dict[str, int]]  # {topic: {n_accounts, n_alerted}}
    handles: dict[str, str]  # pseudonym -> real handle (cache/ only)


def _round_robin(pools: dict[str, list[str]], n: int) -> list[tuple[str, str]]:
    """Up to n (topic, author) picks, one topic at a time, so every topic gets labels in its stratum."""
    queues = {t: list(p) for t, p in pools.items() if p}
    out: list[tuple[str, str]] = []
    while queues and len(out) < n:
        for topic in list(queues):
            if len(out) >= n:
                break
            out.append((topic, queues[topic].pop(0)))
            if not queues[topic]:
                del queues[topic]
    return out


def build_sample(
    items: Iterable[Item], findings: Iterable[Finding], salt: str, *, n_alerted: int = 25, n_quiet: int = 25,
    seed: int = 20261114,
) -> Sample:
    """Stratified labelling sample from the window items and the stored findings (offline, no DB)."""
    if not salt:
        raise ValueError("LTR_HASH_SALT is empty: refusing to write labels without pseudonyms")
    items = list(items)
    fake = {it.author for it in items if it.synthetic}
    real: dict[str, set[str]] = {}  # topic -> real authors of the window
    for it in items:
        if not it.synthetic and it.author not in fake:
            real.setdefault(it.topic, set()).add(it.author)

    alerted: dict[str, set[str]] = {t: set() for t in real}
    watching: dict[tuple[str, str], float] = {}  # (topic, author) -> highest LLR of its watching findings
    for f in findings:
        if f.synthetic or f.topic not in real:
            continue
        accounts = [a for a in f.accounts if a in real[f.topic]]
        if f.verdict == "coordinated":
            alerted[f.topic].update(accounts)
        elif f.verdict == "watching":
            for a in accounts:
                watching[(f.topic, a)] = max(watching.get((f.topic, a), f.llr), f.llr)

    rng = random.Random(seed)

    def shuffled(xs: Iterable[str]) -> list[str]:
        out = sorted(xs)
        rng.shuffle(out)
        return out

    topics = sorted(real)
    picked_alerted = _round_robin({t: shuffled(alerted[t]) for t in topics}, n_alerted)
    picked_quiet = _round_robin({t: shuffled(real[t] - alerted[t]) for t in topics}, n_quiet)
    taken = set(picked_alerted) | set(picked_quiet)
    fill = sorted(
        (k for k in watching if k not in taken and k[1] not in alerted[k[0]]),
        key=lambda k: (-watching[k], k),
    )[: max(0, n_alerted - len(picked_alerted))]

    handles: dict[str, str] = {}

    def row(topic: str, author: str, is_alerted: bool, verdict: str) -> dict[str, str]:
        acct = pseudonym(author, salt)
        handles[acct] = author
        return {"account": acct, "topic": topic, "alerted": "1" if is_alerted else "0", "verdict": verdict,
                "label": "", "note": ""}

    rows = (
        [row(t, a, True, "coordinated") for t, a in picked_alerted]
        + [row(t, a, False, "watching") for t, a in fill]
        + [row(t, a, False, "") for t, a in picked_quiet]
    )
    rows.sort(key=lambda r: (r["topic"], r["alerted"] != "1", r["verdict"] != "watching", r["account"]))
    meta = {t: {"n_accounts": len(real[t]), "n_alerted": len(alerted[t])} for t in topics}
    return Sample(rows, meta, handles)


def write_sample(sample: Sample, out_dir: Path, *, force: bool = False) -> None:
    """labels.csv, labels_meta.json, label_handles.csv into out_dir; never overwrites labels without force."""
    out_dir.mkdir(parents=True, exist_ok=True)
    labels = out_dir / "labels.csv"
    if labels.exists() and not force:
        raise FileExistsError(f"{labels} exists (it may hold labels already); pass --force to overwrite")
    with labels.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(sample.rows)
    (out_dir / "labels_meta.json").write_text(json.dumps(sample.meta, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    with (out_dir / "label_handles.csv").open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(("pseudonym", "handle"))
        w.writerows(sorted(sample.handles.items()))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Write the T14 labelling skeleton (labels.csv, labels_meta.json).")
    ap.add_argument("--hours", type=float, default=float(os.environ.get("DETECT_WINDOW_HOURS") or 6))
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--n-alerted", type=int, default=25)
    ap.add_argument("--n-quiet", type=int, default=25)
    ap.add_argument("--force", action="store_true", help="overwrite an existing labels.csv")
    args = ap.parse_args(argv)
    from ingest import store  # DB only for the CLI: build_sample() stays importable offline
    from ingest.worker import topics

    with store.connect() as conn:
        items = [it for t in topics() for it in store.window_items(conn, t, args.hours)]
        findings = store.load_findings(conn)
    sample = build_sample(items, findings, os.environ.get("LTR_HASH_SALT") or "",
                          n_alerted=args.n_alerted, n_quiet=args.n_quiet)
    write_sample(sample, args.out_dir, force=args.force)
    n = {v: sum(r["verdict"] == v for r in sample.rows) for v in ("coordinated", "watching", "")}
    print(f"{len(sample.rows)} rows -> {args.out_dir}: coordinated={n['coordinated']} watching={n['watching']} "
          f"quiet={n['']}; topics={len(sample.meta)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
