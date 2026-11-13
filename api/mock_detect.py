"""Mock detector for P1: returns the sample findings from fixtures/findings.json.

Used by the API/worker until integration (I1) swaps in detect.pipeline.detect.
"""

from __future__ import annotations

import json
from pathlib import Path

from contracts.models import Finding, Item

FINDINGS_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "findings.json"


def detect(items: list[Item] | None = None, *, alpha: float = 0.02, beta: float = 0.1) -> list[Finding]:
    """Same signature as detect.pipeline.detect; ignores inputs."""
    data = json.loads(FINDINGS_PATH.read_text(encoding="utf-8"))
    return [Finding.model_validate(f) for f in data]
