"""S1 Source Trust (P1): who is behind a news publisher's domain, from Context.dev.

Two calls per new domain: Brand (`POST /brand/retrieve`, 10 credits: name, logo, industry, country,
employees) and Company Search (`POST /company/search`, fast mode, 2 credits, free when empty: founded
year -> age). The parsed result is cached on disk per domain (cache/source_trust/, git-ignored):
30 days when found, 1 day for "no such brand" (404, or a 400 naming NOT_FOUND). Outages (no key,
timeout, 5xx, 429, other 400s, odd bodies, a 200 without a brand name) are not cached.
Served by `GET /api/source/{domain}` (api/main.py); outside contracts.Finding on purpose.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
from pydantic import BaseModel, ValidationError

from ingest.contextdev import ContextDevClient, ContextDevError

log = logging.getLogger("ltr.source_trust")

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "source_trust"
FOUND_TTL_SEC = 30 * 86400
MISSING_TTL_SEC = 86400
MAX_NEW_PER_HOUR = 30  # at most ~30 x 12 = 360 credits an hour, whatever the dashboard asks for
_DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$")


class SourceInfo(BaseModel):
    """What the dashboard shows under a news article; `found=False` = "no source data"."""

    domain: str
    found: bool = False
    name: str | None = None
    description: str | None = None
    logo_url: str | None = None
    founded_year: int | None = None
    age_years: int | None = None
    industry: str | None = None
    country: str | None = None
    employees: str | None = None


def normalize_domain(raw: str) -> str | None:
    """'WWW.Reuters.com.' -> 'reuters.com'; None if it is not a plain host name."""
    d = (raw or "").strip().lower().rstrip(".")
    if d.startswith("www."):
        d = d[4:]
    return d if _DOMAIN_RE.match(d) else None


# -- parsing (pure, offline-testable) -----------------------------------------

def _s(v: object) -> str | None:
    return (v.strip() or None) if isinstance(v, str) else None


def _https(v: object) -> str | None:
    s = _s(v)
    return s if s and s.lower().startswith("https://") else None


def _pick_logo(logos: object) -> str | None:
    """Prefer an icon (square, fits a 16 px line), then any logo; dark-mode variants suit the dark dashboard."""
    if not isinstance(logos, list):
        return None
    cands = [lg for lg in logos if isinstance(lg, dict) and _https(lg.get("url"))]
    rank = lambda lg: (lg.get("type") != "icon", lg.get("mode") not in ("dark", "has_opaque_background"))
    return _https(min(cands, key=rank).get("url")) if cands else None


def parse_brand(resp: dict[str, Any], domain: str) -> SourceInfo:
    b = resp.get("brand") if isinstance(resp, dict) else None
    if not isinstance(b, dict):
        return SourceInfo(domain=domain)
    ind = None
    eic = (b.get("industries") or {}).get("eic") if isinstance(b.get("industries"), dict) else None
    if isinstance(eic, list) and eic and isinstance(eic[0], dict):
        ind = _s(eic[0].get("industry"))
    addr = b.get("address") if isinstance(b.get("address"), dict) else {}
    emp = b.get("employees") if isinstance(b.get("employees"), dict) else {}
    info = SourceInfo(
        domain=domain,
        name=_s(b.get("title")),
        description=_s(b.get("description")),
        logo_url=_pick_logo(b.get("logos")),
        industry=ind,
        country=_s(addr.get("country_code")) or _s(addr.get("country")),
        employees=_s(emp.get("range")),
    )
    info.found = info.name is not None
    return info


def parse_company(resp: dict[str, Any], domain: str) -> int | None:
    """Founded year of the Company Search result for exactly this domain (search hits can be other firms)."""
    for r in (resp.get("results") or []) if isinstance(resp, dict) else []:
        if isinstance(r, dict) and normalize_domain(str(r.get("domain") or "")) == domain:
            y = r.get("founded_year")
            if isinstance(y, int) and 1400 <= y <= datetime.now(timezone.utc).year:
                return y
    return None


def with_age(info: SourceInfo, founded: int | None, now: datetime | None = None) -> SourceInfo:
    if founded is None:
        return info
    year = (now or datetime.now(timezone.utc)).year
    return info.model_copy(update={"founded_year": founded, "age_years": year - founded})


def _brand_missing(exc: Exception) -> bool:
    """404, or a 400 whose text names NOT_FOUND / WEBSITE_NOT_FOUND; any other 400 may be our own bad request."""
    status = getattr(exc, "status", None)
    return status == 404 or (status == 400 and "NOT_FOUND" in str(exc))


# -- lookup with cache, rate limit and per-domain locks ---------------------------

class SourceTrust:
    def __init__(self, client_factory: Callable[[], ContextDevClient] | None = None, *,
                 cache_dir: Path = CACHE_DIR, max_new_per_hour: int = MAX_NEW_PER_HOUR) -> None:
        self._factory = client_factory or self._default_client
        self.cache_dir = cache_dir
        self.max_new_per_hour = max_new_per_hour
        self._recent: deque[float] = deque()
        self._lock = threading.Lock()
        self._domain_locks: dict[str, threading.Lock] = {}

    @staticmethod
    def _default_client() -> ContextDevClient:
        # ttl 0: the client neither reads nor writes raw-response files; the parsed SourceInfo is cached here instead
        return ContextDevClient(os.environ.get("CONTEXT_DEV_API_KEY", ""),
                                cache_dir=CACHE_DIR / "raw", cache_ttl_sec=0, timeout=25)

    def _path(self, domain: str) -> Path:
        return self.cache_dir / f"{domain}.json"

    def cached(self, domain: str) -> SourceInfo | None:
        try:
            entry = json.loads(self._path(domain).read_text(encoding="utf-8"))
            info = SourceInfo.model_validate(entry["info"])
            ttl = FOUND_TTL_SEC if info.found else MISSING_TTL_SEC
            return info if time.time() - entry["fetched_at"] < ttl else None
        except (OSError, ValueError, KeyError, TypeError, ValidationError):
            return None

    def _store(self, info: SourceInfo) -> None:
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            p = self._path(info.domain)
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps({"fetched_at": time.time(), "info": info.model_dump()}), encoding="utf-8")
            tmp.replace(p)
        except OSError as exc:
            log.warning("source cache write failed for %s: %s", info.domain, type(exc).__name__)

    def _take_budget(self) -> bool:
        now = time.time()
        with self._lock:
            while self._recent and now - self._recent[0] > 3600:
                self._recent.popleft()
            if len(self._recent) >= self.max_new_per_hour:
                return False
            self._recent.append(now)
            return True

    def lookup(self, domain: str) -> SourceInfo:
        """Never raises: any failure is "no data" (not cached unless the API said the brand does not exist)."""
        hit = self.cached(domain)
        if hit is not None:
            return hit
        with self._lock:
            dlock = self._domain_locks.setdefault(domain, threading.Lock())
        with dlock:  # two sheets opening at once pay for one lookup
            hit = self.cached(domain)
            if hit is not None:
                return hit
            try:
                client = self._factory()  # no key -> raises here, before a budget slot is taken
            except Exception as exc:  # noqa: BLE001 - lookup never raises
                log.warning("source client unavailable: %s", type(exc).__name__)
                return SourceInfo(domain=domain)
            with client:
                if not self._take_budget():
                    log.warning("source lookup budget spent, %s skipped", domain)
                    return SourceInfo(domain=domain)
                try:
                    info = self._fetch(client, domain)
                except (ContextDevError, httpx.HTTPError, ValueError) as exc:
                    status = getattr(exc, "status", None)
                    log.warning("source lookup %s failed: %s %s", domain, type(exc).__name__, status or "")
                    info = SourceInfo(domain=domain)
                    if _brand_missing(exc):  # the answer, not an outage: cached for a day
                        self._store(info)
                    return info
                except Exception as exc:  # noqa: BLE001 - e.g. OSError, an odd body: "no data", not cached
                    log.warning("source lookup %s failed: %s", domain, type(exc).__name__)
                    return SourceInfo(domain=domain)
            if info.found:  # a 200 without a brand name (e.g. a partial answer after the timeout): not cached
                self._store(info)
            return info

    def _fetch(self, client: ContextDevClient, domain: str) -> SourceInfo:
        info = parse_brand(client.post("/brand/retrieve", {
            "type": "by_domain", "domain": domain, "maxSpeed": True,
            "timeoutOpts": {"milliseconds": 15000, "behavior": "return-partial"},
        }), domain)
        if not info.found:
            return info
        try:  # the age is a bonus: a failed search keeps the brand
            founded = parse_company(client.post("/company/search", {"query": domain, "mode": "fast"}), domain)
        except (ContextDevError, httpx.HTTPError, ValueError) as exc:
            log.warning("company search %s failed: %s", domain, type(exc).__name__)
            founded = None
        return with_age(info, founded)
