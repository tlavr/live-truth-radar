"""Suggest beam thresholds c_lo / c_hi for the current embedder (docs/signal-processing.md 3.2a).

The defaults in detect/config.py are tuned for the offline hashing embedder; Gemini
vectors have a different cosine scale. Run with the production embedder (network +
cache/embeddings, never in tests):

    LTR_EMBEDDER=gemini python -m detect.calibrate_beam [--items fixtures/items_live_sample.json]

Rule (close to detect(), whose beam is a robust mean dominated by the window's organic posts):
per topic with organic items, the beam is the steering vector of the topic's ORGANIC posts
only (synthetic swarms and synth variations never shape it); off-topic posts are every text
of the other topics (their items and variations). c_lo = OFF_LO_Q quantile and c_hi =
OFF_HI_Q quantile of the off-topic projections: half of off-topic posts get zero gain, and
anything above 90% of off-topic posts gets full gain. A topic's own swarm/synthetic texts never set
its thresholds (the detector does not learn from the test target). On Gemini, coordinated on-topic narratives
sit between off-topic posts and the organic centre, so a c_hi taken from on-topic posts cuts
their gain (sat 14.11: c_hi 0.88 halved the gain of injected posts, Pd of a 3-account swarm 0.28).
Prints the suggestion; does not edit the config.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from pydantic import TypeAdapter

from contracts.models import Item
from detect.beam import steering_vector
from detect.embed import embed_with_backend
from synth.variations import available_topics, load_variations

ROOT = Path(__file__).resolve().parent.parent
OFF_LO_Q = 0.5
OFF_HI_Q = 0.9
ORGANIC_Q = 0.1  # reported: c_hi above this share of organic posts would cut organic gain


@dataclass
class TopicTexts:
    organic: list[str] = field(default_factory=list)  # organic posts: build this topic's beam
    organic_authors: list[str] = field(default_factory=list)
    other: list[str] = field(default_factory=list)  # synthetic posts and variations: off-topic for other beams only


def corpus(item_files: list[Path]) -> dict[str, TopicTexts]:
    """topic -> organic posts (with authors) and the remaining texts, from item files plus synth variations."""
    out: dict[str, TopicTexts] = {}
    for path in item_files:
        for it in TypeAdapter(list[Item]).validate_json(path.read_text(encoding="utf-8")):
            t = out.setdefault(it.topic, TopicTexts())
            if it.synthetic or it.campaign_id is not None:
                t.other.append(it.text)
            else:
                t.organic.append(it.text)
                t.organic_authors.append(it.author)
    for topic in available_topics():
        t = out.setdefault(topic, TopicTexts())
        t.other.extend(text for msg in load_variations(topic).messages for text in msg.variations)
    return out


def thresholds(E_on: np.ndarray, authors: list[str], E_off: np.ndarray) -> tuple[float, float, float]:
    """(c_lo, c_hi, organic q10) for one beam: off-topic quantiles of projections on the organic beam."""
    a = steering_vector(E_on, authors)
    off = E_off @ a
    return float(np.quantile(off, OFF_LO_Q)), float(np.quantile(off, OFF_HI_Q)), float(np.quantile(E_on @ a, ORGANIC_Q))


def suggest(topics: dict[str, TopicTexts]) -> tuple[float, float, list[str]]:
    """(c_lo, c_hi, report lines), averaged over topics that have organic posts and other topics to compare with.

    The first report line names the embedder that actually ran (a Gemini failure falls back to hash).
    """
    names = sorted(topics)
    beams = [t for t in names if topics[t].organic]
    if not beams or len(names) < 2:
        raise ValueError("need a topic with organic posts and at least one other topic (on-topic vs off-topic)")
    E_org, E_all, backends = {}, {}, set()
    for t in names:
        texts = topics[t].organic + topics[t].other
        E, backend = embed_with_backend(texts)
        backends.add(backend)
        E_org[t], E_all[t] = E[: len(topics[t].organic)], E
    lines = [f"embedder: {'+'.join(sorted(backends))} (requested: {os.environ.get('LTR_EMBEDDER') or 'gemini'})"]
    los, his = [], []
    for t in beams:
        off_parts = [E_all[o] for o in names if o != t and len(E_all[o])]
        if not off_parts:
            raise ValueError(f"no off-topic texts to calibrate the beam of {t}")
        E_off = np.concatenate(off_parts)
        lo, hi, org_q = thresholds(E_org[t], topics[t].organic_authors, E_off)
        los.append(lo)
        his.append(hi)
        lines.append(
            f"{t}: organic n={len(topics[t].organic)} q{ORGANIC_Q:.2f}={org_q:.3f} | off-topic n={len(E_off)} "
            f"q{OFF_LO_Q:.2f}={lo:.3f} q{OFF_HI_Q:.2f}={hi:.3f}"
        )
        if hi > org_q:
            lines.append(f"WARNING: {t}: c_hi {hi:.3f} is above the organic q{ORGANIC_Q:.2f}; organic posts lose gain")
    return float(np.mean(los)), float(np.mean(his)), lines


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--items", type=Path, action="append", default=None, help="item JSON files (default: fixtures/items.json)")
    args = ap.parse_args(argv)
    files = args.items or [ROOT / "fixtures" / "items.json"]
    c_lo, c_hi, lines = suggest(corpus(files))
    print("\n".join(lines))
    print(f"suggested: c_lo = {c_lo:.2f}, c_hi = {c_hi:.2f}")
    if c_lo >= c_hi:
        print("WARNING: c_lo >= c_hi, topics overlap; keep the current defaults and check the topic queries")


if __name__ == "__main__":
    main()
