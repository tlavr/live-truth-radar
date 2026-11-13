"""Build web/mock-data.js (window.LTR_MOCK) from fixtures, validated against contracts.models.

Usage: python web/build_mock.py

The dashboard falls back to this file when the API is not reachable.
The MetricsReport here is a PLACEHOLDER (no evaluation has run yet); the UI labels it as such.
"""

from __future__ import annotations

import json
import sys
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from contracts.models import (  # noqa: E402
    AlertsResponse,
    FailureExample,
    Finding,
    Item,
    MetricsReport,
    TopicStatus,
)

OUT = Path(__file__).resolve().parent / "mock-data.js"
POLL_INTERVAL_SEC = 180


def build() -> dict:
    findings = [Finding.model_validate(f) for f in json.loads((ROOT / "fixtures/findings.json").read_text("utf-8"))]
    items = [Item.model_validate(i) for i in json.loads((ROOT / "fixtures/items.json").read_text("utf-8"))]

    generated_at = max(f.created_at for f in findings) + timedelta(minutes=1)
    alerts = AlertsResponse(
        generated_at=generated_at,
        last_poll_at=generated_at - timedelta(seconds=60),
        findings=findings,
    )

    # Topics the page pretends to watch. Only the fixture topic has data; the others show the calm
    # "nothing coordinated" state. Poll times are relative to generated_at (the mock clock starts there).
    fixture_topic = findings[0].topic
    topic_items = [i for i in items if i.topic == fixture_topic]

    def topic(slug: str, query: str, age_min: int, last_ago: int, n_items: int, n_accounts: int, n_coord: int) -> TopicStatus:
        last = generated_at - timedelta(seconds=last_ago)
        return TopicStatus(
            topic=slug,
            query=query,
            status="watching",
            created_at=generated_at - timedelta(minutes=age_min),
            last_poll_at=last,
            next_poll_at=last + timedelta(seconds=POLL_INTERVAL_SEC),
            n_items=n_items,
            n_accounts=n_accounts,
            n_coordinated=n_coord,
        )

    topics = [
        topic(
            fixture_topic,
            "Helsinki tram fares",
            175,
            60,
            len(topic_items),
            len({i.author for i in topic_items}),
            sum(1 for f in findings if f.topic == fixture_topic and f.verdict == "coordinated"),
        ),
        topic("nordic-electricity-prices", "Nordic electricity prices", 140, 95, 214, 163, 0),
        topic("finland-school-meals", "Finland school meals", 65, 130, 57, 49, 0),
    ]

    by_id = {i.id: i for i in items}
    missing = [iid for f in findings for iid in f.item_ids if iid not in by_id]
    if missing:
        raise SystemExit(f"findings reference unknown items: {missing[:5]}")

    watching = next((f for f in findings if f.verdict == "watching"), None)

    # PLACEHOLDER numbers: shaped like a real report, not measured. embedder="hash" marks it as a dev run.
    metrics = MetricsReport(
        generated_at=generated_at,
        roc=[
            (0.0, 0.0),
            (0.005, 0.42),
            (0.01, 0.61),
            (0.02, 0.78),
            (0.05, 0.88),
            (0.1, 0.93),
            (0.2, 0.96),
            (0.4, 0.98),
            (0.7, 0.995),
            (1.0, 1.0),
        ],
        detection_rate=0.78,
        operating_pfa=0.02,
        mean_posts_to_decision=8.4,
        mean_seconds_to_decision=212.0,
        live_fpr=0.08,
        live_precision=0.83,
        n_labelled=48,
        failure_examples=[
            FailureExample(
                kind="false_positive",
                account="acct-3f9a1c07d2",
                note="A local news outlet and two of its reporters shared the same headline within a minute. "
                "Same text and tight timing, but it is ordinary newsroom behaviour, not a hidden campaign.",
            ),
            FailureExample(
                kind="false_positive",
                finding_id=watching.id if watching else None,
                account="acct-b81e55a0c4",
                note="Fans live-posting the same quote during a televised council debate. "
                "A real-world event synchronised them; the detector saw the timing and raised an alert.",
            ),
            FailureExample(
                kind="false_negative",
                note="Injected campaign with only 3 accounts posting 20+ minutes apart with heavy rewording. "
                "The evidence score never reached the decision line, so it stayed on 'keep watching'.",
            ),
        ],
        embedder="hash",
    )

    return {
        "topics": [t.model_dump(mode="json") for t in topics],
        "alerts": alerts.model_dump(mode="json"),
        "items": {i.id: i.model_dump(mode="json") for i in items},
        "metrics": metrics.model_dump(mode="json"),
    }


def main() -> None:
    mock = build()
    # Round-trip check: what we ship must parse with the contract.
    AlertsResponse.model_validate(mock["alerts"])
    slugs = [TopicStatus.model_validate(raw).topic for raw in mock["topics"]]
    assert len(slugs) == len(set(slugs)), "mock topics must be unique"
    assert {f["topic"] for f in mock["alerts"]["findings"]} <= set(slugs), "every finding needs a watched topic"
    for raw in mock["items"].values():
        Item.model_validate(raw)
    report = MetricsReport.model_validate(mock["metrics"])
    pfas = [p for p, _ in report.roc]
    pds = [d for _, d in report.roc]
    assert pfas == sorted(pfas) and pds == sorted(pds), "mock ROC must be monotone"

    body = json.dumps(mock, ensure_ascii=False, indent=1).replace("</", "<\\/")
    OUT.write_text(
        "// GENERATED by web/build_mock.py from fixtures/ — do not hand-edit.\n"
        "// Demo data for offline use. `metrics` is a PLACEHOLDER, not an evaluation result.\n"
        f"window.LTR_MOCK = {body};\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT.relative_to(ROOT)}: {len(mock['topics'])} topics, {len(mock['alerts']['findings'])} findings, {len(mock['items'])} items")


if __name__ == "__main__":
    main()
