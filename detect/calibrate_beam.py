"""Suggest beam thresholds c_lo / c_hi for the current embedder (docs/signal-processing.md 3.2a).

The defaults in detect/config.py are tuned for the offline hashing embedder; Gemini
vectors have a different cosine scale. Run with the production embedder (network +
cache/embeddings, never in tests):

    LTR_EMBEDDER=gemini python -m detect.calibrate_beam [--items fixtures/items_live_sample.json]

Per topic: the beam is built from the topic's own posts; c_hi = the ON_TOPIC_Q quantile of
on-topic projections (that share of on-topic posts gets less than full gain), c_lo = the
OFF_TOPIC_Q quantile of projections of other topics' posts (that share of off-topic posts
gets zero gain). Prints the suggestion; does not edit the config.
"""

from __future__ import annotations

import argparse
import os
from collections import defaultdict
from pathlib import Path

import numpy as np
from pydantic import TypeAdapter

from contracts.models import Item
from detect.beam import steering_vector
from detect.embed import embed
from synth.variations import available_topics, load_variations

ROOT = Path(__file__).resolve().parent.parent
ON_TOPIC_Q = 0.25
OFF_TOPIC_Q = 0.5


def corpus(item_files: list[Path]) -> dict[str, tuple[list[str], list[str]]]:
    """topic -> (texts, authors) from item files plus the committed swarm variations."""
    out: dict[str, tuple[list[str], list[str]]] = defaultdict(lambda: ([], []))
    for path in item_files:
        for it in TypeAdapter(list[Item]).validate_json(path.read_text(encoding="utf-8")):
            out[it.topic][0].append(it.text)
            out[it.topic][1].append(it.author)
    for topic in available_topics():
        for m, msg in enumerate(load_variations(topic).messages):
            for v, text in enumerate(msg.variations):
                out[topic][0].append(text)
                out[topic][1].append(f"variation-{m}-{v}")  # one pseudo-account per text
    return dict(out)


def suggest(topics: dict[str, tuple[list[str], list[str]]]) -> tuple[float, float, list[str]]:
    """(c_lo, c_hi, report lines), averaged over topics that have another topic to compare with."""
    if len(topics) < 2:
        raise ValueError("need at least two topics (on-topic vs off-topic)")
    names = sorted(topics)
    E = {t: embed(topics[t][0]) for t in names}
    lines, los, his = [], [], []
    for t in names:
        a = steering_vector(E[t], topics[t][1])
        on = E[t] @ a
        off = np.concatenate([E[o] @ a for o in names if o != t])
        lo, hi = float(np.quantile(off, OFF_TOPIC_Q)), float(np.quantile(on, ON_TOPIC_Q))
        los.append(lo)
        his.append(hi)
        lines.append(
            f"{t}: on-topic n={len(on)} median={np.median(on):.3f} q{ON_TOPIC_Q:.2f}={hi:.3f} | "
            f"off-topic n={len(off)} median={np.median(off):.3f} q{OFF_TOPIC_Q:.2f}={lo:.3f}"
        )
    return float(np.mean(los)), float(np.mean(his)), lines


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--items", type=Path, action="append", default=None, help="item JSON files (default: fixtures/items.json)")
    args = ap.parse_args(argv)
    files = args.items or [ROOT / "fixtures" / "items.json"]
    c_lo, c_hi, lines = suggest(corpus(files))
    print(f"embedder: {os.environ.get('LTR_EMBEDDER') or 'gemini'}")
    print("\n".join(lines))
    print(f"suggested: c_lo = {c_lo:.2f}, c_hi = {c_hi:.2f}")
    if c_lo >= c_hi:
        print("WARNING: c_lo >= c_hi, topics overlap; keep the current defaults and check the topic queries")


if __name__ == "__main__":
    main()
