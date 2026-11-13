"""Detector tests live here / in tests/test_detect_*.py (P2, T7/T10).

For now only a sanity check that the synthetic swarm in fixtures/items.json
is what detector tests will rely on.
"""

from collections import defaultdict
from pathlib import Path

from pydantic import TypeAdapter

from contracts.models import Item

FIX = Path(__file__).resolve().parent.parent / "fixtures" / "items.json"


def test_fixture_swarm_sanity():
    items = TypeAdapter(list[Item]).validate_json(FIX.read_text(encoding="utf-8"))
    swarm = [it for it in items if it.synthetic]
    assert {it.campaign_id for it in swarm} == {"swarm-001"}
    swarm_accounts = {it.author for it in swarm}
    assert len(swarm_accounts) >= 5
    assert not swarm_accounts & {it.author for it in items if not it.synthetic}
    # Swarm posts come in waves: within a wave all accounts post within a few minutes.
    waves = defaultdict(list)
    t0 = min(it.published_at for it in swarm)
    for it in swarm:
        waves[int((it.published_at - t0).total_seconds() // 1200)].append(it.published_at)
    assert len(waves) >= 3
    for times in waves.values():
        assert (max(times) - min(times)).total_seconds() <= 300
