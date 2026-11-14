"""FastAPI app (P1). T4: /health; T5: empty /api/alerts stub for smoke; T8 reads the DB.

Run: uvicorn api.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import FastAPI

from contracts.models import AlertsResponse

app = FastAPI(title="Live Truth Radar")


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe for caddy / smoke; does not touch the DB."""
    return {"status": "ok"}


@app.get("/api/alerts", response_model=AlertsResponse)
def alerts() -> AlertsResponse:
    """T5 stub: valid empty payload until T8 serves findings from the DB."""
    return AlertsResponse(generated_at=datetime.now(UTC), findings=[])
