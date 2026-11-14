"""Skeleton of the T14 live labelling sample (P1): eval/labels.csv + eval/labels_meta.json.

Per topic, the real accounts of the detector window form two strata (docs/signal-processing.md 3.10):
  * alerted: accounts of `coordinated` findings, alerted=1, verdict=coordinated: all of them if they fit in
             n_alerted, else n_alerted split over topics in proportion to their alerts (>= 1 per topic, so
             no topic drops out of live FPR; proportional, as live precision pools the topics);
  * quiet:   random accounts without a `coordinated` finding, alerted=0, verdict empty (~n_quiet rows), round
             robin over topics (live FPR is reweighted per topic), even if they sit in a `watching` finding:
             they stand for the whole quiet stratum.
If there are fewer alerted accounts than n_alerted, the gap is filled from `watching` findings with the
highest LLR (verdict=watching; eval.run leaves those rows out of both formulas).
Synthetic data is excluded: synthetic items and their authors; findings with synthetic=True are skipped and
their real accounts leave the population (alerted together with an inject, not live), unless a real
`coordinated` finding alerted them too.
labels_meta.json holds the strata sizes {topic: {n_accounts, n_alerted}} over ALL real accounts of the
detector window: DETECT_WINDOW_HOURS (as the worker reads it) ending at the topic's last detector run.
Rows carry contracts.pseudonym(author, LTR_HASH_SALT); the pseudonym,handle map is written only to
cache/label_handles.csv (git-ignored; new pairs are merged in, so older samples stay resolvable).
A labels.csv that already holds labels is never overwritten.

On the VPS (eval/ is mounted read-only in the containers, cache/ is writable):
    ssh $VPS 'cd live-truth-radar && docker compose -f infra/docker-compose.yml exec -T api \
        python -m ingest.label_sample'
    mkdir -p cache/labels && scp $VPS:live-truth-radar/cache/labels/'labels*' cache/labels/
    scp $VPS:live-truth-radar/cache/label_handles.csv cache/
    cp -n cache/labels/labels.csv cache/labels/labels_meta.json eval/   # -n: never clobbers labelled files
(to replace an unlabelled eval/labels.csv, delete it first).
Then fill the `label` column (suspicious / organic / unclear; rubric: docs/labelling.md) and run `make eval`.

`--review` also writes <out-dir>/review.md (real handles and their window posts per row, in labels.csv order),
so the rows can be labelled without the DB; it holds real handles, so --out-dir must stay under cache/:
    scp $VPS:live-truth-radar/cache/labels/review.md cache/labels/
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from contracts.models import Finding, Item, pseudonym

COLUMNS = ("account", "topic", "alerted", "verdict", "label", "note")
CACHE = Path(__file__).resolve().parent.parent / "cache"
DEFAULT_OUT = CACHE / "labels"
HANDLES = CACHE / "label_handles.csv"


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


def _allocate(sizes: dict[str, int], n: int) -> dict[str, int]:
    """Split n picks over topics: everything if it fits, else >= 1 per topic and the rest by size."""
    sizes = {t: k for t, k in sizes.items() if k > 0}
    if sum(sizes.values()) <= n:
        return sizes
    order = sorted(sizes, key=lambda t: (-sizes[t], t))
    share = {t: 0 for t in sizes}
    for t in order[:n]:
        share[t] = 1
    rest = n - sum(share.values())
    if rest > 0:
        spare = {t: sizes[t] - share[t] for t in order}
        total = sum(spare.values())
        exact = {t: rest * spare[t] / total for t in order}
        for t in order:
            share[t] += int(exact[t])
        left = n - sum(share.values())
        for t in sorted(order, key=lambda t: (-(exact[t] - int(exact[t])), t))[:left]:
            share[t] += 1
    return share


def build_sample(
    items: Iterable[Item], findings: Iterable[Finding], salt: str, *, n_alerted: int = 25, n_quiet: int = 25,
    seed: int = 20261114,
) -> Sample:
    """Stratified labelling sample from the window items and the stored findings (offline, no DB)."""
    if not salt:
        raise ValueError("LTR_HASH_SALT is empty: refusing to write labels without pseudonyms")
    items, findings = list(items), list(findings)
    fake: dict[str, set[str]] = {}  # topic -> injected authors and real accounts alerted with an inject
    for it in items:
        if it.synthetic:
            fake.setdefault(it.topic, set()).add(it.author)
    really_alerted = {(f.topic, a) for f in findings if f.verdict == "coordinated" and not f.synthetic for a in f.accounts}
    for f in findings:
        if f.synthetic:
            fake.setdefault(f.topic, set()).update(a for a in f.accounts if (f.topic, a) not in really_alerted)
    real: dict[str, set[str]] = {}  # topic -> real authors of the window
    for it in items:
        if not it.synthetic and it.author not in fake.get(it.topic, ()):
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
    share = _allocate({t: len(alerted[t]) for t in topics}, n_alerted)
    picked_alerted = [(t, a) for t in topics for a in shuffled(alerted[t])[: share.get(t, 0)]]
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


def render_review(rows: Iterable[dict[str, str]], handles: dict[str, str], items: Iterable[Item], *,
                  max_posts: int = 8, max_chars: int = 240) -> str:
    """Markdown labelling sheet: per row (labels.csv order) its real handle and its real posts in the window.

    Holds real handles: write it only under cache/ (git-ignored).
    """
    posts: dict[tuple[str, str], list[Item]] = {}
    for it in sorted(items, key=lambda it: (it.published_at, it.id)):
        if not it.synthetic:
            posts.setdefault((it.topic, it.author), []).append(it)
    out = ["# T14 labelling sheet (real handles: never commit)", "",
           "Labels go into labels.csv: suspicious / organic / unclear; rubric in docs/labelling.md.", ""]
    topic = None
    for n, r in enumerate(rows, start=1):
        if r["topic"] != topic:
            topic = r["topic"]
            out += [f"## {topic}", ""]
        handle = handles.get(r["account"], "?")
        mine = posts.get((r["topic"], handle), [])
        out.append(f"### {n}. {r['account']} · {handle} · {r['verdict'] or 'quiet'} · {len(mine)} posts")
        for it in mine[:max_posts]:
            text = re.sub(r"\s+", " ", it.text).strip()
            text = text if len(text) <= max_chars else text[: max_chars - 1] + "…"
            out.append(f"- {it.published_at.astimezone(timezone.utc):%Y-%m-%d %H:%M} UTC · {text}"
                       + (f" · <{it.url}>" if it.url else ""))
        if len(mine) > max_posts:
            out.append(f"- … {len(mine) - max_posts} more")
        out.append("")
    return "\n".join(out)


def write_review(text: str, out_dir: Path) -> Path:
    """review.md into out_dir, which must lie under cache/ (it holds real handles)."""
    if not out_dir.resolve().is_relative_to(root := CACHE.resolve()):
        raise ValueError(f"review.md holds real handles: --out-dir must be under {root}, not {out_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "review.md"
    path.unlink(missing_ok=True)  # a planted symlink must not redirect the handles out of cache/
    path.write_text(text, encoding="utf-8")
    return path


def _has_labels(path: Path) -> bool:
    if not path.exists():
        return False
    with path.open(encoding="utf-8", newline="") as fh:
        return any((r.get("label") or "").strip() for r in csv.DictReader(fh))


def write_sample(sample: Sample, out_dir: Path, *, handles: Path = HANDLES, force: bool = False) -> None:
    """labels.csv + labels_meta.json into out_dir, the handle map into cache/ only.

    Refuses to overwrite a labels.csv that already holds labels (unless force) and to write handles outside cache/.
    """
    if not handles.resolve().is_relative_to(handles_root := HANDLES.parent.resolve()):
        raise ValueError(f"real handles go only under {handles_root} (git-ignored), not {handles}")
    labels = out_dir / "labels.csv"
    if _has_labels(labels) and not force:
        raise FileExistsError(f"{labels} already holds labels; pass --force to overwrite them")
    out_dir.mkdir(parents=True, exist_ok=True)
    handles.parent.mkdir(parents=True, exist_ok=True)
    with labels.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(sample.rows)
    (out_dir / "labels_meta.json").write_text(json.dumps(sample.meta, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    known: dict[str, str] = {}
    if handles.exists():
        with handles.open(encoding="utf-8", newline="") as fh:
            known = {r["pseudonym"]: r["handle"] for r in csv.DictReader(fh)}
    known.update(sample.handles)
    with handles.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(("pseudonym", "handle"))
        w.writerows(sorted(known.items()))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Write the T14 labelling skeleton (labels.csv, labels_meta.json).")
    ap.add_argument("--hours", type=float, default=None, help="default: DETECT_WINDOW_HOURS, as the worker reads it")
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--n-alerted", type=int, default=25)
    ap.add_argument("--n-quiet", type=int, default=25)
    ap.add_argument("--force", action="store_true", help="overwrite a labels.csv that already holds labels")
    ap.add_argument("--review", action="store_true", help="also write <out-dir>/review.md (real handles; cache/ only)")
    args = ap.parse_args(argv)
    if args.review and not args.out_dir.resolve().is_relative_to(CACHE.resolve()):
        ap.error(f"--review writes real handles: --out-dir must be under {CACHE}")
    from ingest import store  # DB only for the CLI: build_sample() stays importable offline
    from ingest.worker import _positive, topics

    hours = args.hours if args.hours is not None else _positive("DETECT_WINDOW_HOURS", 6)
    if not (math.isfinite(hours) and hours > 0):
        ap.error(f"--hours must be a positive number, got {hours}")
    now = datetime.now(timezone.utc)
    with store.connect() as conn:
        findings = store.load_findings(conn)
        # the population the detector saw: its window, ending at the topic's last run (findings.created_at);
        # a topic without findings: now
        end = {t: max((f.created_at for f in findings if f.topic == t), default=now) for t in topics()}
        items = [it for t, e in end.items() for it in store.window_items(conn, t, hours, now=e)]
    sample = build_sample(items, findings, os.environ.get("LTR_HASH_SALT") or "",
                          n_alerted=args.n_alerted, n_quiet=args.n_quiet)
    write_sample(sample, args.out_dir, force=args.force)
    if args.review:
        print(f"review -> {write_review(render_review(sample.rows, sample.handles, items), args.out_dir)}", file=sys.stderr)
    n = {v: sum(r["verdict"] == v for r in sample.rows) for v in ("coordinated", "watching", "")}
    print(f"window {hours:g} h; {len(sample.rows)} rows -> {args.out_dir}: coordinated={n['coordinated']} watching={n['watching']} "
          f"quiet={n['']}; topics={len(sample.meta)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
