"""Deterministic fixture generator -> fixtures/items.json + fixtures/findings.json.

One topic, ~3 hours, ~12 organic accounts posting at random times with varied
texts, plus one injected synthetic swarm (~6 accounts) posting near-identical
reworded messages with small, account-specific lags.

This is a small offline fixture for tests and the mock pipeline; the real
Gemini-based swarm generator is T9. Do NOT hand-edit the JSON outputs: change
this script and run `make fixtures`. Item ids are derived from content, so they
stay stable when items are added.

Usage: python synth/fixture_gen.py [out_dir]
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from contracts.models import AmbiguityMap, Finding, Item, finding_id  # noqa: E402

SEED = 2026
TOPIC = "helsinki-tram-fares"
START = datetime(2026, 11, 13, 18, 0, 0, tzinfo=timezone.utc)
DURATION_S = 3 * 3600
CAMPAIGN_ID = "swarm-001"

ORGANIC_ACCOUNTS = [
    "aino_k", "mikko.v", "helsinki_rider", "laura_s", "jussi88", "commuter_eero",
    "sanna_writes", "petri_h", "kallio_local", "tiina.m", "urban_otto", "ville_news",
]
SWARM_ACCOUNTS = [
    "truthfinland_01", "realvoice_fi", "citizen_watch22",
    "nordic_patriot7", "fair_fares_now", "helsinki_truth9",
]

ORGANIC_OPENERS = [
    "Just saw that", "Honestly,", "Not sure how I feel, but", "Heads up:",
    "Interesting —", "Hmm,", "From my commute today:", "FYI",
]
ORGANIC_BODIES = [
    "the new tram fare zones start next month",
    "my monthly pass price went up a couple of euros",
    "line 4 was packed again this morning",
    "HSL says the increase covers maintenance costs",
    "the ticket app finally works offline",
    "students still get the discount, which is good",
    "the council meeting on fares is on Thursday",
    "night trams are running less often this winter",
    "I prefer cycling anyway when it's not icy",
    "the price is still cheaper than Stockholm",
    "they should fix the heating on the old trams first",
    "fare inspectors were out at Rautatientori today",
]
ORGANIC_CLOSERS = ["", "", " Thoughts?", " Anyone else?", " #Helsinki", " 🚋", "."]

# Each wave = one talking point; swarm accounts post rewordings of it.
SWARM_WAVES = [
    [
        "The fare hike is a scam to fund politicians' pet projects. Share before they delete this!",
        "This fare increase is a scam to pay for politicians' pet projects. Share before it's deleted!",
        "Fare hike = scam funding the politicians' pet projects. Share this before they delete it!",
        "The tram fare hike is just a scam for politicians' pet projects. Share before deletion!",
        "Fare increase is a scam to fund pet projects of politicians. Share before they remove it!",
        "The fare hike is a scam funding politicians' pet projects. Share it before they delete this!",
    ],
    [
        "Ordinary Helsinki families can't afford trams anymore. The city doesn't care about us.",
        "Normal Helsinki families can no longer afford the tram. The city does not care about us.",
        "Ordinary families in Helsinki can't afford trams any more. City hall doesn't care about us.",
        "Helsinki's ordinary families can't afford the trams anymore. The city does not care.",
        "Regular Helsinki families can't afford trams now. The city doesn't care about us at all.",
        "Ordinary Helsinki families cannot afford trams anymore. The city doesn't care about us.",
    ],
    [
        "Boycott the trams on Friday! Show them we won't pay more. #StopTheFareHike",
        "Boycott trams this Friday! Show them we will not pay more. #StopTheFareHike",
        "Friday tram boycott! Let's show them we won't pay more. #StopTheFareHike",
        "Boycott the trams Friday — show them we won't pay any more! #StopTheFareHike",
        "Join the Friday tram boycott! Show them we refuse to pay more. #StopTheFareHike",
        "Boycott the trams on Friday and show them we won't pay more! #StopTheFareHike",
    ],
    [
        "Leaked memo: fares will double next year. Mainstream media is hiding it.",
        "Leaked memo says fares will double next year. The mainstream media is hiding this.",
        "A leaked memo shows fares doubling next year. Mainstream media hides it.",
        "Leaked memo: tram fares to double next year. Media is hiding it from you.",
        "According to a leaked memo, fares double next year. Mainstream media keeps it hidden.",
        "Leaked memo: fares will double next year and the mainstream media is hiding it.",
    ],
]


def _iso(t: datetime) -> str:
    return t.isoformat().replace("+00:00", "Z")


def generate(seed: int = SEED) -> list[Item]:
    rng = np.random.default_rng(seed)
    raw: list[dict] = []

    # Organic: Poisson-ish counts, uniform random times, random template combos.
    for acc in ORGANIC_ACCOUNTS:
        n = int(rng.integers(2, 7))
        times = np.sort(rng.integers(0, DURATION_S, size=n))
        for t in times:
            text = (
                f"{ORGANIC_OPENERS[rng.integers(len(ORGANIC_OPENERS))]} "
                f"{ORGANIC_BODIES[rng.integers(len(ORGANIC_BODIES))]}"
                f"{ORGANIC_CLOSERS[rng.integers(len(ORGANIC_CLOSERS))]}"
            )
            raw.append(dict(author=acc, t=int(t), text=text, synthetic=False))

    # Swarm: waves spread over the window; each account has a fixed base lag
    # (bot schedule) plus small jitter.
    base_lags = rng.integers(15, 120, size=len(SWARM_ACCOUNTS))
    wave_times = np.linspace(1800, DURATION_S - 1800, num=len(SWARM_WAVES)).astype(int)
    for w, (t0, variants) in enumerate(zip(wave_times, SWARM_WAVES)):
        for a, acc in enumerate(SWARM_ACCOUNTS):
            lag = int(base_lags[a] + rng.integers(-10, 11))
            raw.append(dict(author=acc, t=int(t0) + lag, text=variants[(a + w) % len(variants)], synthetic=True))

    raw.sort(key=lambda r: (r["t"], r["author"]))
    items = []
    for r in raw:
        ts = START + timedelta(seconds=r["t"])
        syn = r["synthetic"]
        key = f"{r['author']}|{r['t']}|{r['text']}"
        items.append(
            Item(
                id="fx-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10],
                # organic posts imitate live social data; only the injected swarm is "synthetic"
                source="synthetic" if syn else "context_social",
                platform="x",
                author=r["author"],
                published_at=ts,
                text=r["text"],
                url=None,
                topic=TOPIC,
                synthetic=syn,
                campaign_id=CAMPAIGN_ID if syn else None,
            )
        )
    return items


ALPHA, BETA = 0.02, 0.1
UPPER = round(math.log((1 - BETA) / ALPHA), 4)
LOWER = round(math.log(BETA / (1 - ALPHA)), 4)


LAG_EDGES = [float(x) for x in range(0, 601, 30)]  # |lag| bins, tau_max = 10 min, 30 s step
MISMATCH_EDGES = [round(0.1 * k, 1) for k in range(11)]  # 1 - cos bins


def _ambiguity(items: list[Item], accounts: list[str], *, seed: int) -> AmbiguityMap:
    """Mock ambiguity map: real lags from the items, hand-shaped semantic mismatch (no embeddings here)."""
    rng = np.random.default_rng(seed)
    rows, cols = len(MISMATCH_EDGES) - 1, len(LAG_EDGES) - 1
    counts = [[0] * cols for _ in range(rows)]
    background = [[0] * cols for _ in range(rows)]
    group = set(accounts)
    ordered = sorted(items, key=lambda it: it.published_at)
    for i, p in enumerate(ordered):
        for q in ordered[i + 1:]:
            lag = (q.published_at - p.published_at).total_seconds()
            if lag > LAG_EDGES[-1]:
                break
            if p.author == q.author:
                continue
            inside = p.author in group and q.author in group
            same_campaign = p.campaign_id is not None and p.campaign_id == q.campaign_id
            lo, hi = (0.03, 0.2) if same_campaign else (0.5, 1.0)
            m = min(int(rng.uniform(lo, hi) * rows), rows - 1)
            (counts if inside else background)[m][min(int(lag // 30), cols - 1)] += 1
    return AmbiguityMap(lag_edges_sec=LAG_EDGES, mismatch_edges=MISMATCH_EDGES, counts=counts, background=background)


def _finding(items: list[Item], accounts: list[str], *, verdict: str, llr_steps: list[float],
             corr_level: float, snr_db: float, snr_db_single: float, explanation: dict | None,
             seed: int) -> Finding:
    """Hand-shaped sample finding (for the mock detector), consistent with the items."""
    rng = np.random.default_rng(seed)
    acc_items = sorted((it for it in items if it.author in accounts), key=lambda it: it.published_at)
    first = {a: min(it.published_at for it in acc_items if it.author == a) for a in accounts}
    n = len(accounts)
    corr = [[1.0 if i == j else round(corr_level + float(rng.uniform(-0.04, 0.04)), 2)
             for j in range(n)] for i in range(n)]
    corr = [[corr[min(i, j)][max(i, j)] for j in range(n)] for i in range(n)]  # symmetric
    coordinated = verdict == "coordinated"
    # coordinated: lag between first posts; otherwise a small arbitrary lag inside tau_max
    off = {a: float(rng.integers(0, 300)) for a in accounts}
    lag = [[round((first[b] - first[a]).total_seconds(), 1) if coordinated else off[b] - off[a]
            for b in accounts] for a in accounts]
    trace, total, decided = [], 0.0, None
    # after a decision the trace stops; while watching it covers every item (steps repeat)
    for k in range(len(acc_items)):
        step = llr_steps[k % len(llr_steps)]
        total = round(total + step, 2)
        trace.append(total)
        if decided is None and (total >= UPPER or total <= LOWER):
            decided = k
            break
    last_seen = acc_items[-1].published_at
    return Finding(
        id=finding_id(TOPIC, accounts), topic=TOPIC, created_at=last_seen + timedelta(seconds=30),
        verdict=verdict, accounts=accounts, item_ids=[it.id for it in acc_items],
        llr=trace[-1], snr_db=snr_db, snr_db_single=snr_db_single, sprt_trace=trace,
        sprt_upper=UPPER, sprt_lower=LOWER, decided_at_item=decided,
        first_seen=acc_items[0].published_at, last_seen=last_seen,
        correlation=corr, lag_sec=lag, explanation=explanation,
        synthetic=any(it.synthetic for it in acc_items),
        ambiguity=_ambiguity(items, accounts, seed=seed),
    )


def mock_findings(items: list[Item]) -> list[Finding]:
    """Two sample findings: the injected swarm (coordinated) and 3 organic accounts (watching)."""
    first_post = {}
    for it in sorted(items, key=lambda it: it.published_at):
        first_post.setdefault(it.author, it)
    swarm_quote = next(it.text for it in items if it.synthetic)
    coordinated = _finding(
        items, SWARM_ACCOUNTS, verdict="coordinated",
        llr_steps=[0.4, 0.5, 0.3, 0.6, 0.5, 0.4, 0.7, 0.6, 0.5, 0.4, 0.5, 0.6],
        corr_level=0.5, snr_db=23.8, snr_db_single=12.0, seed=1,  # mean pair z = 4 (> CFAR k = 3); 15 pairs: +11.8 dB
        explanation=dict(
            technique="Fear appeal + call to action",
            quote=swarm_quote.split(".")[0].split("!")[0],
            confidence=0.82,
            summary="Six new accounts post reworded versions of the same claims within two minutes "
                    "of each other, four times in a row, urging people to share before deletion.",
        ),
    )
    watching = _finding(
        items, ORGANIC_ACCOUNTS[:3], verdict="watching",
        llr_steps=[-0.3, 0.2, -0.4, 0.3, 0.1, -0.3, 0.3],
        corr_level=0.3, snr_db=15.7, snr_db_single=10.9, seed=2, explanation=None,  # mean pair z = 3.5; 3 pairs: +4.8 dB
    )
    return [coordinated, watching]


def main(argv: list[str]) -> None:
    out_dir = Path(argv[1]) if len(argv) > 1 else ROOT / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    items = generate()
    data = [it.model_dump(mode="json") for it in items]
    (out_dir / "items.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    findings = [f.model_dump(mode="json") for f in mock_findings(items)]
    (out_dir / "findings.json").write_text(json.dumps(findings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    n_syn = sum(it.synthetic for it in items)
    print(f"wrote {len(items)} items ({n_syn} synthetic) and {len(findings)} findings -> {out_dir}")


if __name__ == "__main__":
    main(sys.argv)
