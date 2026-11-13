"""Contract tests: fixtures parse into the shared models."""

import json
from datetime import datetime, timezone
from pathlib import Path

from pydantic import TypeAdapter

from contracts.models import AlertsResponse, Finding, Item

FIX = Path(__file__).resolve().parent.parent / "fixtures"


def _items() -> list[Item]:
    return TypeAdapter(list[Item]).validate_json((FIX / "items.json").read_text(encoding="utf-8"))


def test_items_parse():
    items = _items()
    assert len(items) > 0
    assert len({it.id for it in items}) == len(items)
    assert all(it.published_at.utcoffset() is not None for it in items)


def test_findings_parse_and_reference_items():
    items = _items()
    ids = {it.id for it in items}
    authors = {it.author for it in items}
    raw = json.loads((FIX / "findings.json").read_text(encoding="utf-8"))
    resp = AlertsResponse(generated_at=datetime.now(timezone.utc), findings=raw)
    assert resp.findings
    for f in resp.findings:
        assert set(f.item_ids) <= ids
        assert set(f.accounts) <= authors
        assert len(f.sprt_trace) <= len(f.item_ids)
        if f.decided_at_item is not None:
            assert 0 <= f.decided_at_item < len(f.sprt_trace)


def test_mock_detect_returns_valid_findings():
    from api.mock_detect import detect

    findings = detect(_items())
    assert findings and all(isinstance(f, Finding) for f in findings)
    assert {f.verdict for f in findings} >= {"coordinated"}


def test_finding_ids_are_stable():
    from contracts.models import finding_id

    raw = json.loads((FIX / "findings.json").read_text(encoding="utf-8"))
    for f in raw:
        assert f["id"] == finding_id(f["topic"], f["accounts"])
        assert f["id"] == finding_id(f["topic"], list(reversed(f["accounts"])))
