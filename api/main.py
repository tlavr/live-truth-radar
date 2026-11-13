"""FastAPI app (P1). T4: health endpoint only; T8 adds /api/*.

Run: uvicorn api.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI

app = FastAPI(title="Live Truth Radar")


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe for caddy / smoke; does not touch the DB."""
    return {"status": "ok"}
