"""Bluesky source (P1, T6b): public `app.bsky.feed.searchPosts`, no login.

Polled from the same `ingest_cycle` as Context.dev news. Posts become Items with source="context_social",
platform="bluesky", author = handle (masked in the API like every real account). The last raw page of each
query is kept in cache/bluesky/ (git-ignored: real handles) for debugging; nothing is served from it.
Normalization is a pure function (tested offline).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from contracts.models import Item
from ingest.contextdev import _clean, _future, _parse_ts, topic_query

log = logging.getLogger("ltr.bluesky")

BASE_URL = "https://api.bsky.app/xrpc"  # public.api.bsky.app answers 403 to searchPosts (probe 14.11)
DEFAULT_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "bluesky"
PAGE_LIMIT = 100  # API maximum
INVALID_HANDLE = "handle.invalid"  # what the AppView shows for any account whose handle failed verification
CLOCK_SKEW = timedelta(minutes=5)  # createdAt is client-set: trust it only within 5 min of indexedAt

# Short queries (as in the 14.11 probe): searchPosts matches all words, long phrases find almost nothing.
# The full post text still passes the topic's keyword gate (contextdev.on_topic) afterwards.
BSKY_QUERIES: dict[str, str] = {
    "jensen-huang-resignation": "Jensen Huang",
    "france-riots": "France riots",
    "us-midterms-ai-fakes": "midterms deepfake",
    "europe-bomb-threat-hoaxes": "bomb threat hoax",
    "microsoft-global-outage": "Microsoft outage",
    "ukraine-peace-talks": "Ukraine peace talks",
    "helsinki-tram-fares": "Helsinki tram",
    "faa-ground-stop": "ground stop",
    "sean-duffy-faa": "Duffy FAA",
    "new-orleans-cruise-tanker": "cruise ship tanker",
    "midterm-vote-count": "midterms",
    "schumer-leadership": "Schumer",
    "ice-overhaul": "ICE Congress",
    "trump-cuba": "Trump Cuba",
    "measles-outbreak": "measles",
    "rfk-vaccines": "RFK",
    "epstein-files": "Epstein files",
    "tariffs": "tariffs",
    "deportations": "deportation",
    "trump-xi-putin-summit": "Trump Xi Putin",
    "us-iran-strikes": "Iran",
    "hormuz-tankers": "Hormuz",
    "gaza-ceasefire": "Gaza",
    "turkey-qatar-defense-pact": "Qatar Turkey",
    "ukraine-territory-nato": "Ukraine territory NATO",
    "poland-russia-border": "Poland",
    "sudan-war": "Sudan",
    "south-sudan-elections": "South Sudan",
    "pakistan-militants": "Pakistan",
    "taiwan-china": "Taiwan China",
    "north-korea": "North Korea",
    "venezuela": "Venezuela",
    "uk-starmer": "Starmer",
    "chile-fuel-protests": "Chile",
    "israel": "Israel",
    "putin-russia": "Putin",
    "nato": "NATO",
    "cop31-climate": "COP31",
    "climate-change": "climate change",
    "vaccines": "vaccine",
    "abortion": "abortion",
    "bird-flu": "bird flu",
    "earthquake": "earthquake",
    "wildfire": "wildfire",
    "openai-chatgpt": "OpenAI",
    "musk": "Elon Musk",
    "spacex-starship": "Starship",
    "ai-data-centers": "data center",
    "cyberattacks": "cyberattack",
    "bitcoin-crypto": "bitcoin",
    "russell-brand-trial": "Russell Brand",
}


def bsky_query(slug: str) -> str:
    return BSKY_QUERIES.get(slug) or topic_query(slug)


class BlueskyError(RuntimeError):
    """searchPosts returned a non-200 status or a body that is not a post list."""


def _iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class BlueskyClient:
    def __init__(self, *, base_url: str = BASE_URL, timeout: float = 15, cache_dir: Path = DEFAULT_CACHE_DIR,
                 transport: httpx.BaseTransport | None = None) -> None:
        self.cache_dir = cache_dir
        self._http = httpx.Client(base_url=base_url, timeout=timeout, transport=transport,
                                  headers={"User-Agent": "live-swarm-radar/0.1"})

    def close(self) -> None:
        self._http.close()

    def _save(self, q: str, page: int, data: dict[str, Any]) -> None:
        try:
            key = hashlib.sha1(q.encode("utf-8")).hexdigest()[:12]
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            (self.cache_dir / f"{key}-p{page}.json").write_text(json.dumps({"q": q, "response": data}),
                                                                 encoding="utf-8")
        except OSError as e:  # the debug copy must never fail the poll
            log.warning("bluesky cache write failed: %s", e)

    def search(self, q: str, since: datetime, max_pages: int = 3) -> dict[str, Any]:
        """Newest posts matching `q` since `since`, at most `max_pages` pages of PAGE_LIMIT.
        Paging goes by `until` = the oldest post time of the previous page: without login the AppView answers
        403 to any request with `cursor` (checked 14.11). Posts sharing that exact boundary timestamp can be
        returned twice (ids dedupe them) or, rarely, skipped. A failure on a later page keeps the pages already
        read (the next cycle overlaps anyway); a failure on the first page raises."""
        posts: list[dict[str, Any]] = []
        until: datetime | None = None
        for page in range(max_pages):
            params: dict[str, Any] = {"q": q, "sort": "latest", "since": _iso(since), "limit": PAGE_LIMIT}
            if until is not None:
                params["until"] = _iso_ms(until)
            try:
                r = self._http.get("/app.bsky.feed.searchPosts", params=params)
                if r.status_code != 200:
                    raise BlueskyError(f"searchPosts: HTTP {r.status_code}: {r.text[:300]}")
                data = r.json()
                if not isinstance(data, dict) or not isinstance(data.get("posts"), list):
                    raise BlueskyError(f"searchPosts: unexpected body: {str(data)[:300]}")
            except (BlueskyError, httpx.HTTPError, ValueError) as e:
                if page == 0:
                    raise
                log.warning("bluesky q=%r page=%d failed (%s), keeping %d posts", q, page, e, len(posts))
                break
            self._save(q, page, data)
            batch = data["posts"]
            posts += batch
            oldest = _oldest(batch)
            # the cursor itself is unusable, but its presence still says "more results" (pages often hold 99:
            # the AppView filters some posts out after the limit)
            if not data.get("cursor") or oldest is None or oldest <= since or (until and oldest >= until):
                break  # last page, nothing datable, past the window, or no progress
            until = oldest
        return {"posts": posts}


def _dict(v: Any) -> dict[str, Any]:
    """A JSON field that should be an object; anything else (null, a string from a broken record) -> {}."""
    return v if isinstance(v, dict) else {}


def _ts(v: Any) -> datetime | None:
    """_parse_ts for a JSON field that should be an ISO string (a number or object from a broken record -> None)."""
    return _parse_ts(v) if isinstance(v, str) else None


def _iso_ms(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _oldest(posts: list[Any]) -> datetime | None:
    """Earliest of createdAt / indexedAt over a page (the AppView sorts and filters by the earlier of the two)."""
    times = []
    for p in posts:
        if isinstance(p, dict):
            for ts in (_dict(p.get("record")).get("createdAt"), p.get("indexedAt")):
                t = _ts(ts)
                if t is not None:
                    times.append(t)
    return min(times) if times else None


# -- normalization (pure, offline-testable) ---------------------------------

# full links and the shortened ones Bluesky clients write into the text ("nytimes.com/2026/11/...")
_LINK_RE = re.compile(r"https?://\S+|\b(?:[\w-]+\.)+[a-z]{2,}/\S*", re.IGNORECASE)


def _post_time(created: datetime | None, indexed: datetime | None) -> datetime | None:
    if created is None:
        return indexed
    if indexed is not None and abs(created - indexed) > CLOCK_SKEW:
        return indexed  # backdated or clock-skewed client: the AppView's index time is the reliable one
    return created


def posts_to_items(resp: dict[str, Any], topic: str, *, now: datetime | None = None) -> list[Item]:
    """searchPosts posts -> Items. Text = record.text only (a shared link card's title would make everyone who
    shares one article look like copy-paste); posts empty once links are removed, without a time, dated in the
    future, or without uri/handle are dropped."""
    out: list[Item] = []
    seen: set[str] = set()
    for p in resp.get("posts") or []:
        if not isinstance(p, dict):
            continue
        uri = _clean(p.get("uri")).strip()
        author = _dict(p.get("author"))
        handle = _clean(author.get("handle")).strip().lstrip("@").lower()
        if handle == INVALID_HANDLE:  # unverified handle, shared by many accounts: key the account by its DID
            handle = _clean(author.get("did")).strip().lower()
        record = _dict(p.get("record"))
        text = _clean(record.get("text")).strip()
        ts = _post_time(_ts(record.get("createdAt")), _ts(p.get("indexedAt")))
        if not uri or not handle or ts is None or _future(ts, now) or not _LINK_RE.sub("", text).strip():
            continue
        iid = f"bsky-{topic}-{hashlib.sha1(uri.encode('utf-8')).hexdigest()[:16]}"
        if iid in seen:
            continue
        seen.add(iid)
        rkey = uri.rsplit("/", 1)[-1]
        out.append(
            Item(
                id=iid,
                source="context_social",
                platform="bluesky",
                author=handle,
                published_at=ts,
                text=text,
                url=f"https://bsky.app/profile/{handle}/post/{rkey}",
                topic=topic,
            )
        )
    return out
