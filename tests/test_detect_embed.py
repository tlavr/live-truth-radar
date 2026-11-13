"""T7: embeddings, topic beam, whitening. Offline (hashing embedder via tests/conftest.py)."""

from itertools import combinations
from pathlib import Path

import numpy as np
from pydantic import TypeAdapter

from contracts.models import Item
from detect.beam import beam_gain, steering_vector, whiten
from detect.embed import embed

FIX = Path(__file__).resolve().parent.parent / "fixtures" / "items.json"
WAVE_SEC = 1200  # swarm waves in the fixture are >= 20 min apart


def _fixture():
    items = TypeAdapter(list[Item]).validate_json(FIX.read_text(encoding="utf-8"))
    E = embed([it.text for it in items])
    a = steering_vector(E, [it.author for it in items])
    return items, E, a


def _mean_cos(X, items):
    """Mean cosine over cross-account pairs: (same swarm wave, organic-organic)."""
    t0 = min(it.published_at for it in items if it.synthetic)
    wave = [int((it.published_at - t0).total_seconds() // WAVE_SEC) if it.synthetic else None for it in items]
    C = X @ X.T
    swarm, organic = [], []
    for i, j in combinations(range(len(items)), 2):
        if items[i].author == items[j].author:
            continue
        if items[i].synthetic and items[j].synthetic and wave[i] == wave[j]:
            swarm.append(C[i, j])
        elif not items[i].synthetic and not items[j].synthetic:
            organic.append(C[i, j])
    return float(np.mean(swarm)), float(np.mean(organic))


def test_paraphrase_closer_than_unrelated():
    base, paraphrase, unrelated = embed(
        [
            "The fare hike is a scam to fund politicians' pet projects.",
            "This fare increase is a scam to pay for politicians' pet projects!",
            "Great hockey game tonight, Jokerit scored in overtime.",
        ]
    )
    assert np.isclose(np.linalg.norm(base), 1.0)
    assert base @ paraphrase > 0.5
    assert base @ paraphrase > base @ unrelated + 0.4
    assert np.array_equal(embed(["same text"]), embed(["same text"]))  # deterministic


def test_whitening_drops_organic_keeps_paraphrases():
    items, E, a = _fixture()
    W = whiten(E, a)
    assert np.allclose(W @ a, 0.0, atol=1e-9)  # nothing left along the beam
    swarm_raw, organic_raw = _mean_cos(E, items)
    swarm_white, organic_white = _mean_cos(W, items)
    assert organic_raw > 0.12  # topic clutter is there before whitening
    assert abs(organic_white) < 0.08  # ... and gone after
    assert swarm_white > 0.6  # paraphrases of one wave stay correlated
    assert swarm_white - organic_white > swarm_raw - organic_raw  # contrast grew

    pure_topic = whiten(a[None, :], a)  # a post that is the beam itself has no residual
    assert not pure_topic.any()


def test_off_topic_post_gets_no_beam_gain():
    items, E, a = _fixture()
    off_topic = embed(
        [
            "Great hockey game tonight, Jokerit scored in overtime!",
            "Recipe: cinnamon buns with cardamom, bake for 12 minutes.",
        ]
    )
    assert np.all(beam_gain(off_topic, a) < 0.05)
    assert beam_gain(E, a).mean() > 0.7
