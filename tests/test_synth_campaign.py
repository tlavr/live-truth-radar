"""T9: synthetic swarm generator. Offline (committed variations file)."""

from datetime import datetime, timedelta, timezone

import pytest

from contracts.models import Item
from synth.campaign import make_campaign

TOPIC = "helsinki-tram-fares"
NOW = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)


def test_make_campaign_shape_and_ids():
    items = make_campaign(TOPIC, NOW, seed=7)
    assert len(items) == 2 * 12  # 2 volleys x n_accounts
    assert all(isinstance(it, Item) and it.synthetic and it.source == "synthetic" for it in items)
    assert {it.campaign_id for it in items} == {f"inj-{TOPIC}-120000"}
    assert len({it.id for it in items}) == len(items)
    assert len({it.author for it in items}) == 12
    assert all(NOW - timedelta(minutes=15) <= it.published_at <= NOW for it in items)

    # Volley shape: two bursts, each account once per burst, burst width <= 2 minutes.
    split = NOW - timedelta(minutes=10)
    for volley in ([it for it in items if it.published_at < split], [it for it in items if it.published_at >= split]):
        times = [it.published_at for it in volley]
        assert len({it.author for it in volley}) == len(volley) == 12
        assert (max(times) - min(times)).total_seconds() <= 120

    assert make_campaign(TOPIC, NOW, seed=7) == items  # deterministic for one seed
    later = make_campaign(TOPIC, NOW + timedelta(seconds=30))
    assert not {it.id for it in later} & {it.id for it in items}  # every inject is new

    with pytest.raises(ValueError):
        make_campaign("no-such-topic", NOW)
    with pytest.raises(ValueError):
        make_campaign("../etc/passwd", NOW)
