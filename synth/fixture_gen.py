"""Deterministic fixture generator -> fixtures/items.json.

One topic, ~3 hours, ~12 organic accounts posting at random times with varied
texts, plus one injected synthetic swarm (~6 accounts) posting near-identical
reworded messages with small, account-specific lags.

This is a small offline fixture for tests and the mock pipeline; the real
Gemini-based swarm generator is T9.

Usage: python synth/fixture_gen.py [out_path]
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from contracts.models import Item  # noqa: E402

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
    for i, r in enumerate(raw):
        ts = START + timedelta(seconds=r["t"])
        syn = r["synthetic"]
        items.append(
            Item(
                id=f"fx-{i:04d}",
                source="synthetic",  # whole fixture is generated; ground truth via campaign_id
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


def main(argv: list[str]) -> None:
    out = Path(argv[1]) if len(argv) > 1 else ROOT / "fixtures" / "items.json"
    items = generate()
    data = [it.model_dump(mode="json") for it in items]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n_syn = sum(it.synthetic for it in items)
    print(f"wrote {len(items)} items ({n_syn} synthetic) -> {out}")


if __name__ == "__main__":
    main(sys.argv)
