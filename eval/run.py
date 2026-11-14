"""Eval: ROC, Neyman-Pearson operating point, Pd by swarm size, live precision/FPR -> MetricsReport (T13).

One trial = one 6-hour window of one topic (docs/signal-processing.md section 3.10).
  * Background windows (no target): organic items of the topic (fixtures + live sample if present),
    multiplied by two resampling modes, half each:
      - "shift": a random 6 h slice of the timeline, then every author is moved by its own random
        circular shift inside the window (keeps each author's cadence, breaks cross-author alignment);
      - "subset": original timing kept, a random 80% of the authors, a random 6 h slice of the
        timeline (keeps real organic co-bursts such as reactions to news, the main source of false alarms).
    Pfa = share of background windows with any `coordinated` finding.
    Plus "real" windows: the topic's live timeline cut into consecutive, non-overlapping 6 h pieces with
    the original timing (no resampling; pieces too small to ever alarm are skipped). Only these are
    independent experiments, so the operating points also give Pfa and its 95% bound on them alone
    (n_independent). The pooled Pfa and its bound mix them with resampled windows of the same items,
    which are correlated, so the pooled bound is optimistic.
  * Inject windows: a background window plus `make_campaign` (held-out phrases), ROC_SWARM_ACCOUNTS
    accounts for the ROC, time to decision and purity.
    Pd = share of inject windows with a `coordinated` finding whose accounts are >= half injected
    AND which covers >= half of the injected accounts.
  * ROC: (Pfa, Pd) while sweeping the CFAR threshold k (alpha, beta fixed); the same windows are
    reused for every k. Operating point: the k with the largest Pd among those with Pfa <= 2% (ties: larger k).

Run: `make eval` (LTR_EMBEDDER=gemini with the cache in cache/embeddings/; network only for
missing embeddings). The hashing embedder is refused unless --dev.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import os
import sys
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from pydantic import TypeAdapter

from contracts.models import FailureExample, Finding, Item, MetricsReport
from detect.config import DEFAULT, AnalyzerConfig
from detect.operating import POINTS_PATH, SLIDER_ALPHAS, OperatingPoint, OperatingPoints, pfa_upper95, write_points
from detect.pipeline import detect
from synth.campaign import make_campaign
from synth.variations import VARIATIONS_DIR

log = logging.getLogger("eval")

ROOT = Path(__file__).resolve().parent.parent
FIXTURES_DIR = ROOT / "fixtures"
EVAL_DIR = ROOT / "eval"
# The first copy of an id wins: the e-mail-masked live background goes before the older live sample.
BACKGROUND_FILES = ("items.json", "items_live_background.json", "items_live_sample.json")

WINDOW = timedelta(hours=6)
WINDOW_BASE = datetime(2026, 11, 14, 0, 0, tzinfo=timezone.utc)  # window clock; only relative times matter
SUBSET_SHARE = 0.8
INJECT_MARGIN = timedelta(minutes=15)  # make_campaign spans [now - 15 min, now]

TARGET_PFA = 0.02
K_GRID = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0)
SIZES = (3, 4, 6, 8, 12)
# ROC target: a weak swarm, so the curve does not saturate at Pd = 1 on the easy fixture background
# (12 accounts gave Pfa = 0, Pd = 1 for every k). Agreed with the human; pd_by_size still covers 3..12.
ROC_SWARM_ACCOUNTS = 4

LABELS = ("suspicious", "organic", "unclear")
MAX_FALSE_POSITIVES, MAX_EXAMPLES = 3, 5


# ---------------------------------------------------------------- windows


@dataclass(frozen=True)
class Window:
    topic: str
    mode: str  # "shift" | "subset" | "real"
    items: list[Item]
    injected: frozenset[str] = frozenset()  # injected account names (empty: background window)
    n_injected: int = 0


def load_background(fixtures_dir: Path = FIXTURES_DIR) -> dict[str, list[Item]]:
    """Organic (synthetic=False) items by topic from the fixtures and the live sample, if present."""
    by_topic: dict[str, list[Item]] = {}
    seen: set[str] = set()  # the live background export overlaps the live sample: keep each item once
    adapter = TypeAdapter(list[Item])
    for name in BACKGROUND_FILES:
        path = fixtures_dir / name
        if not path.exists():
            continue
        for it in adapter.validate_json(path.read_text(encoding="utf-8")):
            if not it.synthetic and it.campaign_id is None and it.id not in seen:
                seen.add(it.id)
                by_topic.setdefault(it.topic, []).append(it)
    return {t: sorted(v, key=lambda it: (it.published_at, it.id)) for t, v in by_topic.items() if v}


def window_slice(items: list[Item], rel: dict[str, float], rng: np.random.Generator) -> tuple[list[Item], float]:
    """A random 6 h slice of the timeline: (items inside it, offset that maps rel into [0, width]).

    A timeline shorter than the window is placed at a random offset; a longer one is cut, never folded
    or clamped. The slice is never empty (anchored on a random post if the first draw hits a gap)."""
    width = WINDOW.total_seconds()
    span = max(rel[it.id] for it in items)
    if span <= width:
        return items, float(rng.uniform(0.0, width - span))
    shift = -float(rng.uniform(0.0, span - width))
    if not any(0.0 <= rel[it.id] + shift <= width for it in items):  # empty slice: anchor on a post
        r = rel[items[int(rng.integers(len(items)))].id]
        shift = -float(rng.uniform(max(0.0, r - width), min(r, span - width)))
    return [it for it in items if 0.0 <= rel[it.id] + shift <= width], shift


def background_window(items: list[Item], rng: np.random.Generator, mode: str) -> list[Item]:
    """One 6-hour window without a target, resampled from the topic's organic items (see module doc)."""
    t0 = min(it.published_at for it in items)
    width = WINDOW.total_seconds()
    rel = {it.id: (it.published_at - t0).total_seconds() for it in items}
    if mode == "shift":
        chosen, shift = window_slice(items, rel, rng)
        offset = {a: float(rng.uniform(0.0, width)) for a in sorted({it.author for it in chosen})}
        when = {it.id: (rel[it.id] + shift + offset[it.author]) % width for it in chosen}
    elif mode == "subset":
        authors = sorted({it.author for it in items})
        keep = set(rng.choice(authors, size=max(1, round(SUBSET_SHARE * len(authors))), replace=False).tolist())
        chosen, shift = window_slice([it for it in items if it.author in keep], rel, rng)
        when = {it.id: rel[it.id] + shift for it in chosen}
    else:
        raise ValueError(f"unknown background mode {mode!r}")
    return [it.model_copy(update={"published_at": WINDOW_BASE + timedelta(seconds=when[it.id])}) for it in chosen]


def real_windows(background: dict[str, list[Item]], topics: list[str], min_authors: int = DEFAULT.min_swarm_accounts
                 ) -> list[Window]:
    """Consecutive non-overlapping 6 h pieces of each topic's timeline, original timing (mode "real").

    Pieces are [t0 + m*W, t0 + (m+1)*W) from the topic's first item. Pieces with fewer than min_authors
    authors are skipped: they can never alarm, so counting them would only flatter the Pfa bound. Each piece is
    moved to the window clock (WINDOW_BASE) by one common shift, so cross-author alignment is untouched."""
    out: list[Window] = []
    width = WINDOW.total_seconds()
    for topic in topics:
        items = background[topic]
        t0 = min(it.published_at for it in items)
        pieces: dict[int, list[Item]] = {}
        for it in items:
            pieces.setdefault(int((it.published_at - t0).total_seconds() // width), []).append(it)
        for m in sorted(pieces):
            if len({it.author for it in pieces[m]}) < min_authors:
                continue
            start = t0 + m * WINDOW
            out.append(Window(topic, "real", [it.model_copy(update={"published_at": WINDOW_BASE + (it.published_at - start)})
                                              for it in pieces[m]]))
    return out


def make_windows(
    background: dict[str, list[Item]], topics: list[str], n: int, rng: np.random.Generator, *, n_accounts: int = 0
) -> list[Window]:
    """n windows per topic, modes alternating; n_accounts > 0 adds an injected swarm of that size."""
    out: list[Window] = []
    for topic in topics:
        for i in range(n):
            mode = ("shift", "subset")[i % 2]
            items = background_window(background[topic], rng, mode)
            if n_accounts <= 0:
                out.append(Window(topic, mode, items))
                continue
            lo = (WINDOW_BASE + INJECT_MARGIN).timestamp()
            hi = (WINDOW_BASE + WINDOW).timestamp()
            now = datetime.fromtimestamp(float(rng.uniform(lo, hi)), tz=timezone.utc).replace(microsecond=0)
            campaign = make_campaign(topic, now, n_accounts=n_accounts, seed=int(rng.integers(2**63)))
            injected = frozenset(it.author for it in campaign)
            out.append(Window(topic, mode, items + campaign, injected, len(injected)))
    return out


# ---------------------------------------------------------------- scoring


def overlap(f: Finding, injected: frozenset[str]) -> int:
    return len(set(f.accounts) & injected)


def is_hit(f: Finding, injected: frozenset[str]) -> bool:
    """coordinated, >= half of the group is injected AND the group covers >= half of the inject."""
    if f.verdict != "coordinated" or not injected:
        return False
    common = overlap(f, injected)
    return 2 * common >= len(f.accounts) and 2 * common >= len(injected)


@dataclass
class Trial:
    window: Window
    findings: list[Finding]

    @property
    def alarm(self) -> bool:
        return any(f.verdict == "coordinated" for f in self.findings)

    def best_hit(self) -> Finding | None:
        hits = [f for f in self.findings if is_hit(f, self.window.injected)]
        return max(hits, key=lambda f: overlap(f, self.window.injected), default=None)


def run_trials(windows: list[Window], cfg: AnalyzerConfig) -> list[Trial]:
    return [Trial(w, detect(w.items, alpha=cfg.alpha, beta=cfg.beta, cfg=cfg)) for w in windows]


def rate(flags: list[bool]) -> float:
    return sum(flags) / len(flags) if flags else 0.0


def roc_curve(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Sort by Pfa and take the running max of Pd (a better k can always be chosen): monotone ROC."""
    out: list[tuple[float, float]] = []
    best = 0.0
    for pfa, pd in sorted(points):
        best = max(best, pd)
        out.append((round(pfa, 4), round(best, 4)))
    return out


def decision_cost(f: Finding, items: dict[str, Item]) -> tuple[int, float] | None:
    """(posts, seconds) from the group's first post to the SPRT decision."""
    if f.decided_at_item is None:
        return None
    k = f.decided_at_item
    t_decided = items[f.item_ids[k]].published_at
    return k + 1, (t_decided - f.first_seen).total_seconds()


def purity(trial: Trial) -> float | None:
    """Share of the most-overlapping coordinated group's accounts that are truly injected."""
    groups = [f for f in trial.findings if f.verdict == "coordinated" and overlap(f, trial.window.injected) > 0]
    if not groups:
        return None
    f = max(groups, key=lambda g: overlap(g, trial.window.injected))
    return overlap(f, trial.window.injected) / len(f.accounts)


def miss_reason(trial: Trial) -> str:
    inj = trial.window.injected
    touching = [f for f in trial.findings if overlap(f, inj) > 0]
    if not touching:
        return "CFAR assembled no group with the injected accounts"
    f = max(touching, key=lambda g: overlap(g, inj))
    common = overlap(f, inj)
    if f.verdict == "coordinated":
        return f"group of {len(f.accounts)} is coordinated but covers {common}/{len(inj)} injected accounts"
    if f.note:
        return f"{f.note.split(':')[0]} capped the group at watching ({common}/{len(inj)} injected accounts)"
    state = "SPRT undecided (watching, " if f.verdict == "watching" else f"SPRT stopped at {f.verdict} ("
    return f"{state}LLR {f.llr:.2f}) on a group with {common}/{len(inj)} injected accounts"


def failure_examples(background: list[Trial], injected: list[Trial]) -> list[FailureExample]:
    out: list[FailureExample] = []
    for i, t in enumerate(background):
        if len(out) >= MAX_FALSE_POSITIVES:
            break
        f = next((f for f in t.findings if f.verdict == "coordinated"), None)
        if f is not None:
            out.append(FailureExample(
                kind="false_positive", finding_id=f.id,
                note=(f"background window {i} ({t.window.topic}, {t.window.mode}): {len(f.accounts)} organic "
                      f"accounts flagged coordinated, SNR {f.snr_db} dB, LLR {f.llr:.2f}"),
            ))
    for t in injected:
        if len(out) >= MAX_EXAMPLES:
            break
        if t.best_hit() is None:
            out.append(FailureExample(
                kind="false_negative",
                note=f"injected swarm of {t.window.n_injected} accounts ({t.window.topic}) missed: {miss_reason(t)}",
            ))
    return out


# ---------------------------------------------------------------- live labels (T14)


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion."""
    if n <= 0:
        return 0.0, 1.0
    p = successes / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, center - half), min(1.0, center + half)


@dataclass(frozen=True)
class LiveMetrics:
    precision: float | None
    precision_ci: tuple[float, float] | None
    fpr: float | None
    n_labelled: int
    n_unclear: int


def live_metrics(labels_csv: Path, meta_json: Path) -> LiveMetrics | None:
    """Live precision (Wilson CI) and reweighted live FPR from the T14 labels; None if no labels yet.

    Rows with verdict=watching (filled up from watching) and "unclear" labels enter neither formula.
    """
    if not labels_csv.exists():
        return None
    with labels_csv.open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    meta = json.loads(meta_json.read_text(encoding="utf-8")) if meta_json.exists() else {}

    # counts[topic][alerted][label]
    counts: dict[str, dict[bool, dict[str, int]]] = {}
    n_labelled = n_unclear = 0
    for row in rows:
        label = (row.get("label") or "").strip().lower()
        if not label:
            continue
        if label not in LABELS:
            raise ValueError(f"unknown label {label!r} in {labels_csv} (expected one of {', '.join(LABELS)})")
        verdict = (row.get("verdict") or "").strip().lower()
        if verdict == "watching":
            continue
        alerted = (row.get("alerted") or "").strip() == "1"
        n_labelled += 1
        n_unclear += label == "unclear"
        by_label = counts.setdefault(row["topic"], {True: {}, False: {}})[alerted]
        by_label[label] = by_label.get(label, 0) + 1

    sus = sum(c[True].get("suspicious", 0) for c in counts.values())
    org = sum(c[True].get("organic", 0) for c in counts.values())
    precision = sus / (sus + org) if sus + org else None
    ci = wilson(sus, sus + org) if sus + org else None

    false_alarms = organic_total = 0.0
    for topic, c in counts.items():
        sizes = meta.get(topic)
        if not sizes:
            log.warning("labels_meta.json has no strata sizes for topic %s; skipped in live FPR", topic)
            continue
        n_all, n_alerted = int(sizes["n_accounts"]), int(sizes["n_alerted"])

        def organic_share(stratum: dict[str, int]) -> float | None:
            known = stratum.get("organic", 0) + stratum.get("suspicious", 0)
            return stratum.get("organic", 0) / known if known else None

        p_alerted, p_quiet = organic_share(c[True]), organic_share(c[False])
        if (n_alerted > 0 and p_alerted is None) or (n_all - n_alerted > 0 and p_quiet is None):
            log.warning("topic %s lacks labelled accounts in a stratum; skipped in live FPR", topic)
            continue
        fa = n_alerted * (p_alerted or 0.0)
        false_alarms += fa
        organic_total += fa + (n_all - n_alerted) * (p_quiet or 0.0)
    fpr = false_alarms / organic_total if organic_total > 0 else None
    return LiveMetrics(precision, ci, fpr, n_labelled, n_unclear)


# ---------------------------------------------------------------- report


def _embedder_name() -> str:
    return (os.environ.get("LTR_EMBEDDER") or "gemini").strip().lower()


def _prefetch_embeddings(windows: list[Window]) -> None:
    """Gemini only: embed every text once up front, so detect() never silently falls back to hash."""
    if _embedder_name() != "gemini":
        return
    from detect.embed import gemini_embed

    texts = list(dict.fromkeys(it.text for w in windows for it in w.items))
    gemini_embed(texts)  # raises on failure: an eval on mixed embedders would be meaningless


def build_report(
    *,
    n_windows: int = 200,
    n_size_windows: int = 100,
    ks: tuple[float, ...] = K_GRID,
    sizes: tuple[int, ...] = SIZES,
    seed: int = 20261114,
    dev: bool = False,
    fixtures_dir: Path = FIXTURES_DIR,
    labels_dir: Path = EVAL_DIR,
    cfg: AnalyzerConfig = DEFAULT,
) -> MetricsReport:
    embedder = _embedder_name()
    if embedder != "gemini" and not dev:
        raise SystemExit(f"refusing to write a report on LTR_EMBEDDER={embedder!r}: production uses gemini (use --dev)")
    background = load_background(fixtures_dir)
    if not background:
        raise SystemExit(f"no organic items in {fixtures_dir}")
    inject_topics = [t for t in background if (VARIATIONS_DIR / f"{t}.json").exists()]
    if not inject_topics:
        raise SystemExit("no topic has both organic items and synth variations")
    log.info("background topics: %s; inject topics: %s", sorted(background), inject_topics)

    rng = np.random.default_rng(seed)
    bg_windows = make_windows(background, sorted(background), n_windows, rng) + real_windows(
        background, sorted(background), cfg.min_swarm_accounts)
    inj_windows = make_windows(background, inject_topics, n_windows, rng, n_accounts=ROC_SWARM_ACCOUNTS)
    size_windows = {n: make_windows(background, inject_topics, n_size_windows, rng, n_accounts=n) for n in sizes}
    _prefetch_embeddings(bg_windows + inj_windows + [w for ws in size_windows.values() for w in ws])

    sweep: dict[float, tuple[list[Trial], list[Trial]]] = {}
    points: list[tuple[float, float]] = []
    for k in ks:
        kcfg = replace(cfg, cfar_k=k)
        bg, inj = run_trials(bg_windows, kcfg), run_trials(inj_windows, kcfg)
        pfa, pd = rate([t.alarm for t in bg]), rate([t.best_hit() is not None for t in inj])
        sweep[k] = (bg, inj)
        points.append((pfa, pd))
        log.info("k=%.2f  Pfa=%.3f  Pd=%.3f", k, pfa, pd)

    ok = [k for k, (pfa, _) in zip(ks, points) if pfa <= TARGET_PFA]
    if ok:
        # Neyman-Pearson: the largest Pd among the admissible k; a tie goes to the larger (safer) k.
        # Pd is not monotone in k here: a very low k merges the swarm with background accounts (purity fails).
        k_op = max(ok, key=lambda k: (points[ks.index(k)][1], k))
        if len(ok) == len(ks):
            log.warning("every k on the grid has Pfa <= %.0f%%: the constraint does not bind on this background, "
                        "k=%.2f is chosen by Pd alone", 100 * TARGET_PFA, k_op)
    else:
        k_op = max(ks)
        log.warning("no k reaches Pfa <= %.0f%%; operating point = largest k %.2f", 100 * TARGET_PFA, k_op)
    op_pfa, op_pd = points[ks.index(k_op)]
    bg_op, inj_op = sweep[k_op]
    log.info("operating point: k=%.2f (Pfa %.3f, Pd %.3f); set cfar_k in detect/config.py in T15", k_op, op_pfa, op_pd)

    costs = []
    for t in inj_op:
        f = t.best_hit()
        if f is not None:
            c = decision_cost(f, {it.id: it for it in t.window.items})
            if c is not None:
                costs.append(c)
    purities = [p for p in (purity(t) for t in inj_op) if p is not None]

    op_cfg = replace(cfg, cfar_k=k_op)
    pd_by_size: list[tuple[int, float]] = []
    size_trials: list[Trial] = []
    for n in sizes:
        trials = run_trials(size_windows[n], op_cfg)
        size_trials.extend(trials)
        pd_by_size.append((n, round(rate([t.best_hit() is not None for t in trials]), 4)))
    log.info("Pd by swarm size: %s", pd_by_size)

    live = live_metrics(labels_dir / "labels.csv", labels_dir / "labels_meta.json")
    if live is not None:
        log.info("live: n_labelled=%d (unclear %d), precision=%s, fpr=%s",
                 live.n_labelled, live.n_unclear, live.precision, live.fpr)

    return MetricsReport(
        generated_at=datetime.now(timezone.utc).replace(microsecond=0),
        roc=roc_curve(points),
        detection_rate=round(op_pd, 4),
        operating_pfa=round(op_pfa, 4),
        mean_posts_to_decision=round(float(np.mean([c[0] for c in costs])), 2) if costs else None,
        mean_seconds_to_decision=round(float(np.mean([c[1] for c in costs])), 1) if costs else None,
        live_fpr=None if live is None or live.fpr is None else round(live.fpr, 4),
        live_precision=None if live is None or live.precision is None else round(live.precision, 4),
        live_precision_ci=None if live is None or live.precision_ci is None
        else (round(live.precision_ci[0], 4), round(live.precision_ci[1], 4)),
        n_labelled=0 if live is None else live.n_labelled,
        failure_examples=failure_examples(bg_op, inj_op + size_trials),
        embedder=embedder,
        pd_by_size=pd_by_size,
        swarm_purity=round(float(np.mean(purities)), 4) if purities else None,
    )


def build_operating_points(
    *,
    n_windows: int = 200,
    alphas: tuple[float, ...] = SLIDER_ALPHAS,
    seed: int = 20261114,
    dev: bool = False,
    fixtures_dir: Path = FIXTURES_DIR,
    cfg: AnalyzerConfig = DEFAULT,
) -> OperatingPoints:
    """T12c slider: measured Pfa / Pd / decision time at each SPRT alpha, CFAR k as configured (live)."""
    embedder = _embedder_name()
    if embedder != "gemini" and not dev:
        raise SystemExit(f"refusing to write operating points on LTR_EMBEDDER={embedder!r} (use --dev)")
    background = load_background(fixtures_dir)
    inject_topics = [t for t in background if (VARIATIONS_DIR / f"{t}.json").exists()]
    if not background or not inject_topics:
        raise SystemExit(f"no background / inject topics in {fixtures_dir}")
    rng = np.random.default_rng(seed + 1)  # its own windows: the report's random stream is unchanged
    bg_windows = make_windows(background, sorted(background), n_windows, rng) + real_windows(
        background, sorted(background), cfg.min_swarm_accounts)
    inj_windows = make_windows(background, inject_topics, n_windows, rng, n_accounts=ROC_SWARM_ACCOUNTS)
    small_windows = make_windows(background, inject_topics, n_windows, rng, n_accounts=min(SIZES))
    _prefetch_embeddings(bg_windows + inj_windows + small_windows)

    points = []
    for alpha in alphas:
        acfg = replace(cfg, alpha=alpha)
        bg, inj, small = (run_trials(w, acfg) for w in (bg_windows, inj_windows, small_windows))
        alarms = sum(t.alarm for t in bg)
        real = [t for t in bg if t.window.mode == "real"]
        real_alarms = sum(t.alarm for t in real)
        costs = []
        for t in inj:
            f = t.best_hit()
            c = None if f is None else decision_cost(f, {it.id: it for it in t.window.items})
            if c is not None:
                costs.append(c[0])
        point = OperatingPoint(
            alpha=alpha,
            pfa=round(alarms / len(bg), 4),
            pfa_upper95=round(pfa_upper95(alarms, len(bg)), 4),
            pd=round(rate([t.best_hit() is not None for t in inj]), 4),
            pd_small=round(rate([t.best_hit() is not None for t in small]), 4),
            posts_to_decision=round(float(np.mean(costs)), 2) if costs else None,
            n_background=len(bg),
            n_independent=len(real),
            pfa_independent=round(real_alarms / len(real), 4) if real else None,
            pfa_independent_upper95=round(pfa_upper95(real_alarms, len(real)), 4) if real else None,
        )
        log.info("alpha=%.3f  Pfa=%.3f (<= %.3f)  Pd=%.3f  Pd(%d acc)=%.3f  posts=%s  real windows: %d alarms / %d",
                 alpha, point.pfa, point.pfa_upper95, point.pd, min(SIZES), point.pd_small, point.posts_to_decision,
                 real_alarms, len(real))
        points.append(point)
    return OperatingPoints(generated_at=datetime.now(timezone.utc).replace(microsecond=0), embedder=embedder,
                           cfar_k=cfg.cfar_k, points=points)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Write eval/report.json (MetricsReport).")
    ap.add_argument("--dev", action="store_true", help="allow a non-production embedder (hash)")
    ap.add_argument("--windows", type=int, default=200, help="background and inject windows per topic")
    ap.add_argument("--size-windows", type=int, default=100, help="inject windows per swarm size")
    ap.add_argument("--seed", type=int, default=20261114)
    ap.add_argument("--out", type=Path, default=EVAL_DIR / "report.json")
    ap.add_argument("--points-out", type=Path, default=POINTS_PATH, help="T12c slider operating points")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("detect").setLevel(logging.WARNING)
    report = build_report(n_windows=args.windows, n_size_windows=args.size_windows, seed=args.seed, dev=args.dev)
    args.out.write_text(report.model_dump_json(indent=1) + "\n", encoding="utf-8")
    log.info("wrote %s", args.out)
    points = build_operating_points(n_windows=args.windows, seed=args.seed, dev=args.dev)
    write_points(points, args.points_out)
    log.info("wrote %s", args.points_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
