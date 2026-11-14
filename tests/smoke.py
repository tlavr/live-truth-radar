"""Smoke check for a deployed instance (not collected by pytest).

Usage: python tests/smoke.py https://example.com
Exits non-zero on any failure.
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pydantic import TypeAdapter  # noqa: E402

from contracts.models import AlertsResponse, Item, MetricsReport  # noqa: E402


def main(base: str) -> int:
    base = base.rstrip("/")
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as c:
            r = c.get(f"{base}/health")
            r.raise_for_status()
            print(f"OK  /health {r.status_code}")
            r = c.get(f"{base}/api/alerts")
            r.raise_for_status()
            resp = AlertsResponse.model_validate(r.json())
            print(f"OK  /api/alerts {len(resp.findings)} findings, generated_at={resp.generated_at.isoformat()}")
            r = c.get(f"{base}/api/metrics")
            r.raise_for_status()
            rep = MetricsReport.model_validate(r.json())
            print(f"OK  /api/metrics roc={len(rep.roc)} points, embedder={rep.embedder}, generated_at={rep.generated_at.isoformat()}")
            ids = [i for f in resp.findings for i in f.item_ids][:20]
            if ids:
                r = c.get(f"{base}/api/items", params={"ids": ",".join(ids)})
                r.raise_for_status()
                got = TypeAdapter(list[Item]).validate_python(r.json())
                if not got:
                    raise RuntimeError("/api/items returned no items for ids taken from /api/alerts")
                print(f"OK  /api/items {len(got)}/{len(ids)} items")
    except Exception as e:  # noqa: BLE001
        print(f"FAIL {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python tests/smoke.py BASE_URL", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
