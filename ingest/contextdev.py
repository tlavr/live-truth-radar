"""Context.dev client (P1, T6): news search + Reddit search via the prebuilt scrape parser.

Raw responses are cached on disk in cache/contextdev/ (git-ignored: they contain real handles).
A request with the same body within `cache_ttl_sec` is served from the cache and costs no credits.
Normalization to contracts.Item lives here too, as pure functions (tested offline).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from contracts.models import Item

log = logging.getLogger("ltr.contextdev")

BASE_URL = "https://api.context.dev/v1"
DEFAULT_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "contextdev"


class ContextDevError(RuntimeError):
    """API returned an error (HTTP status, or a 200 whose payload reports failure)."""


class ContextDevClient:
    def __init__(
        self,
        api_key: str,
        *,
        cache_dir: Path = DEFAULT_CACHE_DIR,
        cache_ttl_sec: float = 600,
        base_url: str = BASE_URL,
        timeout: float = 60,
    ) -> None:
        if not api_key:
            raise ContextDevError("CONTEXT_DEV_API_KEY is empty")
        self.cache_dir = cache_dir
        self.cache_ttl_sec = cache_ttl_sec
        self._http = httpx.Client(
            base_url=base_url, timeout=timeout, headers={"Authorization": f"Bearer {api_key}"}
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ContextDevClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- transport + cache -------------------------------------------------

    def _cache_path(self, path: str, body: dict[str, Any]) -> Path:
        key = hashlib.sha256((path + "|" + json.dumps(body, sort_keys=True)).encode("utf-8")).hexdigest()
        return self.cache_dir / f"{key[:32]}.json"

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        cp = self._cache_path(path, body)
        if cp.exists():
            try:
                entry = json.loads(cp.read_text(encoding="utf-8"))
                if time.time() - entry["fetched_at"] < self.cache_ttl_sec:
                    log.info("cache hit %s", path)
                    return entry["response"]
            except (ValueError, KeyError, OSError):
                pass  # corrupt cache entry: refetch
        r = self._http.post(path, json=body)
        if r.status_code != 200:
            raise ContextDevError(f"{path}: HTTP {r.status_code}: {r.text[:300]}")
        data = r.json()
        if data.get("success") is False:
            raise ContextDevError(f"{path}: success=false: {str(data)[:300]}")
        credits = (data.get("key_metadata") or {}).get("credits_consumed")
        log.info("fetched %s (credits=%s)", path, credits)
        if (data.get("parsed") or {}).get("success") is False:
            return data  # failed parse (e.g. site blocked): don't cache, retry next cycle
        cp.parent.mkdir(parents=True, exist_ok=True)
        tmp = cp.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"fetched_at": time.time(), "path": path, "body": body, "response": data}),
            encoding="utf-8",
        )
        tmp.replace(cp)
        return data

    # -- endpoints ---------------------------------------------------------

    def news_search(self, query: str, *, since: datetime | None = None, limit: int = 50) -> dict[str, Any]:
        body: dict[str, Any] = {
            "searchBy": {"type": "natural_language", "query": query},
            "limit": limit,
        }
        if since is not None:
            # round down to 10 min so consecutive polls reuse the same request (and the cache)
            ms = int(since.timestamp() * 1000) // 600_000 * 600_000
            body["filterBy"] = {"date": {"from": ms}}
        return self.post("/news/search", body)

    def reddit_search(self, query: str, *, t: str = "day", limit: int = 100) -> dict[str, Any]:
        url = "https://www.reddit.com/search/?" + urlencode({"q": query, "sort": "new", "t": t})
        body = {
            "url": url,
            "formats": {"parse": True},
            "parseParams": {"type": "prebuilt", "parser": "reddit-search", "limit": limit},
            # server-side cache defaults to 3 days: keep it in line with ours so polls see new posts
            "maxAgeMs": int(self.cache_ttl_sec * 1000),
        }
        data = self.post("/web/scrape", body)
        parsed = data.get("parsed") or {}
        if not parsed.get("success"):
            raise ContextDevError(
                f"reddit-search failed: {parsed.get('error_code')}: {parsed.get('message')}"
            )
        return data


# -- normalization (pure, offline-testable) ---------------------------------


def _parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


FUTURE_SKEW = timedelta(minutes=10)  # items dated later than now + skew are dropped (bad tz / embargo)


def _clean(s: object) -> str:
    """str that Postgres text can store: NUL bytes dropped (psycopg raises DataError), and lone UTF-16
    surrogates (JSON "\\ud83d" from a truncated emoji) replaced with "?" (psycopg raises UnicodeEncodeError)."""
    if s is None:
        return ""
    return str(s).replace("\x00", "").encode("utf-8", "replace").decode("utf-8")


def _join(*parts: str | None) -> str:
    cleaned = (_clean(p).strip() for p in parts)
    return "\n\n".join(p for p in cleaned if p)


def _future(ts: datetime, now: datetime | None) -> bool:
    return ts > (now or datetime.now(timezone.utc)) + FUTURE_SKEW


# Reddit names may contain "-"; "-", "." and "+" before "@" mean an e-mail address (left untouched).
# Bluesky profile links carry the handle or the DID; a bare DID ("did:plc:...", also inside at:// URIs) names
# an account too; @alice.bsky.social is a plain @handle. Only the Bluesky branches are case-insensitive
# ("Bsky.app/Profile/..." is the same link); "u/" stays lower-case so news text like "U/S dollar" is left alone.
_HANDLE_RE = re.compile(
    r"(?<![\w.+-])@[\w.-]*\w|\bu/[\w-]+|\breddit\.com/user/[\w-]+"
    r"|(?i:\bbsky\.app/profile/[\w.:-]*\w|\bdid:(?:plc|web):[\w.:-]*\w)"
)


def mask_handles(text: str) -> str:
    """Replace @handles, u/names, reddit.com/user/ and bsky.app/profile/ links in free text with "@***"
    (real handles never go into git or out of the public API)."""
    return _HANDLE_RE.sub("@***", text)


def news_to_items(resp: dict[str, Any], topic: str, *, now: datetime | None = None) -> list[Item]:
    """News articles -> Items. Account = publisher domain (bylines are often empty);
    articles without a reliable published_at, or dated in the future, are dropped (no time = no correlation).
    The id includes the topic: one article can match several topics and must stay in each."""
    out: list[Item] = []
    for a in resp.get("data") or []:
        ts = _parse_ts(a.get("published_at"))
        domain = _clean((a.get("source") or {}).get("domain")).strip().lower()
        text = _join(a.get("title"), a.get("description"))
        aid = _clean(a.get("id"))
        if ts is None or _future(ts, now) or not domain or not text or not aid:
            continue
        out.append(
            Item(
                id=f"news-{topic}-{aid}",
                source="context_news",
                platform="news",
                author=domain,
                published_at=ts,
                text=text,
                url=_clean(a.get("url")) or None,
                topic=topic,
            )
        )
    return out


def reddit_to_items(resp: dict[str, Any], topic: str, *, now: datetime | None = None) -> list[Item]:
    """Reddit search posts -> Items. Deleted authors (null) and posts without a time or dated in the
    future are dropped."""
    data = (resp.get("parsed") or {}).get("data") or {}
    out: list[Item] = []
    for p in data.get("posts") or []:
        ts = _parse_ts(p.get("posted_at"))
        author = _clean(p.get("author")).strip()
        text = _join(p.get("title"), p.get("body"))
        pid = _clean(p.get("id"))
        if ts is None or _future(ts, now) or not author or not text or not pid:
            continue
        out.append(
            Item(
                id=f"reddit-{topic}-{pid}",
                source="context_social",
                platform="reddit",
                author=f"u/{author}",
                published_at=ts,
                text=text,
                url=_clean(p.get("url")) or None,
                topic=topic,
            )
        )
    return out


def _stems(query: str) -> list[str]:
    words = [w for w in re.findall(r"[\w']+", query.lower()) if len(w) >= 3]
    return [w[: max(4, len(w) - 2)] for w in words]  # crude stem: "fares" -> "fare", "trams" -> "tram"


# Agreed topics (HANDOFF §6): slug -> (Context.dev query, keyword groups). An item is on topic when every
# group has at least one keyword at a word start in its headline. Keywords are regex fragments matched as
# prefixes ("resign" matches "resignation", "riot" does not match "patriot"); add r"\b" to end a whole word.
# Other slugs: query = slug with spaces, gate = at least half of the query words (also at word starts).
TOPIC_SPECS: dict[str, tuple[str, list[list[str]]]] = {
    "jensen-huang-resignation": (
        "Jensen Huang resignation",
        [["huang"], ["resign", "step down", "stepped down", "steps down", "ousted", r"quit(?:s|ting)?\b", "departure",
                     "successor", "reinstat"]],
    ),
    "france-riots": ("France riots", [["france", "french", "paris"], ["riot", "protest", "unrest", "looting"]]),
    "us-midterms-ai-fakes": (
        "US midterms AI deepfakes",
        [["midterm", "election", "campaign", "voter"],
         ["deepfake", "ai-generated", "fake", "disinformation", "misinformation"]],
    ),
    "europe-bomb-threat-hoaxes": ("Europe bomb threat hoax", [["bomb"], ["threat", "hoax", "scare", "evacuat"]]),
    "microsoft-global-outage": (
        "Microsoft global outage",
        [["microsoft", "azure", "outlook", "office 365"], ["outage", "disruption"]],
    ),
    "ukraine-peace-talks": ("Ukraine peace talks", [["ukrain"], ["peace", "talks", "negotiat", "ceasefire"]]),
    "helsinki-tram-fares": ("Helsinki tram fares", [["helsinki", "hsl"], ["tram", "fare", "ticket", "transport"]]),
    # 50-topic expansion (probe 14.11, Bluesky 6 h): news of the day, world, long-running narratives, tech
    "faa-ground-stop": (
        "FAA nationwide ground stop",
        [["faa", "ground stop", "air traffic"],
         ["ground stop", "grounded", "outage", "equipment", "l3harris", "telecom", "halt"]],
    ),
    "sean-duffy-faa": (
        "Sean Duffy FAA contract",
        [["duffy"], ["faa", "contract", "son-in-law", "transportation", "aviation"]],
    ),
    "new-orleans-cruise-tanker": (
        "New Orleans cruise ship tanker collision",
        [["cruise"], ["tanker", "collision", "collided", "crash", "new orleans"]],
    ),
    "midterm-vote-count": (
        "midterm close races vote count",
        [["midterm", "house race", "senate race", "ballots"],
         [r"count(?:s|ed|ing)?\b", "recount", "results", "called", r"lead(?:s|ing)?\b", "race", "seat"]],
    ),
    "schumer-leadership": (
        "Schumer leadership challenge",
        [["schumer", "jeffries"], ["leader", "replace", "step down", "leadership", "ousted", "resign"]],
    ),
    "ice-overhaul": (
        "Congress ICE overhaul",
        [[r"ice\b", "immigration and customs"],
         ["immigra", "deport", "agents", "detention", "abolish", "overhaul", "raid"]],
    ),
    "trump-cuba": (
        "Trump Cuba military operation",
        [["cuba", "havana"], ["trump", "military", "invasion", "operation", "regime", "blockade"]],
    ),
    "measles-outbreak": (
        "US measles outbreak elimination status",
        [["measles"], ["case", "outbreak", "elimination", "vaccin", "spread"]],
    ),
    "rfk-vaccines": (
        "RFK Jr vaccines HHS",
        [["kennedy", r"rfk\b"], ["vaccin", "autism", r"hhs\b", r"cdc\b", r"fda\b", "acip"]],
    ),
    "epstein-files": ("Epstein files", [["epstein"]]),
    "tariffs": (
        "Trump tariffs trade war",
        [["tariff"], ["trump", "china", "trade", "court", "canada", "europe", "price"]],
    ),
    "deportations": ("deportations immigration raids", [[r"deport(?:ed|ee|ees|ing|ation|ations|s)?\b", "ice raid", "immigration raid"]]),
    "trump-xi-putin-summit": (
        "Trump Xi Putin summit APEC China",
        [["summit", "apec", "trilateral"], [r"xi\b", "putin"]],
    ),
    "us-iran-strikes": (
        "US Iran strikes",
        [["iran"], ["strike", "drone", "radar", "bahrain", "missile", "attack", "war", "bomb"]],
    ),
    "hormuz-tankers": (
        "Strait of Hormuz tankers mines",
        [["hormuz", "persian gulf", "gulf of oman"], ["tanker", "mine", "oil", "ship", "attack", "iran"]],
    ),
    "gaza-ceasefire": (
        "Gaza ceasefire",
        [["gaza", "hamas"], ["ceasefire", "truce", "hostage", "deal", "phase", "aid", "killed"]],
    ),
    "turkey-qatar-defense-pact": (
        "Turkey Qatar defense pact",
        [["qatar", "turk", "türkiye"], ["defen", "pact", "agreement"]],
    ),
    "ukraine-territory-nato": (
        "Ukraine cede territory NATO membership",
        [["ukrain", "zelensk"], ["territor", "nato", "cede", "donbas", "land"]],
    ),
    "poland-russia-border": (
        "Poland Russia border sabotage",
        [["poland", r"polish\b", "kaliningrad"], ["sabotage", "border", "russia", "drone", "shoot", "gunman"]],
    ),
    "sudan-war": (
        "Sudan war RSF",
        [["sudan", r"rsf\b", "darfur", "el fasher"],
         ["army", "attack", "killed", "famine", "war", "genocide"]],
    ),
    "south-sudan-elections": (
        "South Sudan elections postponed",
        [["south sudan"], ["election", "vote", "postpone", "violence"]],
    ),
    "pakistan-militants": (
        "Pakistan militants border",
        [["pakistan"], ["militant", "raid", "border", "taliban", "killed", "afghan", "attack"]],
    ),
    "taiwan-china": (
        "Taiwan China military pressure",
        [["taiwan"], ["china", "chinese", r"pla\b", "drill", "invasion", "strait"]],
    ),
    "north-korea": ("North Korea", [["north korea", "pyongyang", "kim jong"]]),
    "venezuela": ("Venezuela Maduro", [["venezuela", "maduro"]]),
    "uk-starmer": ("Starmer UK government", [["starmer"]]),
    "chile-fuel-protests": (
        "Chile fuel protests Kast",
        [["chile", "kast"], ["fuel", "protest", "strike", "price", "president"]],
    ),
    "israel": ("Israel", [["israel"]]),
    "putin-russia": ("Putin Russia", [["putin", "kremlin"]]),
    "nato": ("NATO", [[r"nato\b"]]),
    "cop31-climate": (
        "COP31 climate summit",
        [["cop31", "cop 31", "climate summit", "climate talks", "climate conference"]],
    ),
    "climate-change": ("climate change", [["climate change", "global warming", "climate crisis"]]),
    "vaccines": ("vaccines", [["vaccin"]]),
    "abortion": ("abortion", [["abortion"]]),
    "bird-flu": ("H5N1 bird flu", [["bird flu", "h5n1", "avian flu", "avian influenza"]]),
    "earthquake": ("earthquake", [["earthquake", "quake"]]),
    "wildfire": ("wildfire", [["wildfire", "bushfire", "forest fire"]]),
    "openai-chatgpt": ("OpenAI ChatGPT", [["openai", "chatgpt", "altman"]]),
    "musk": ("Elon Musk", [[r"musk\b"]]),
    "spacex-starship": ("SpaceX Starship launch", [["starship", "spacex"]]),
    "ai-data-centers": ("AI data centers", [["data center", "data centre", "datacenter"]]),
    "cyberattacks": (
        "cyberattack ransomware data breach",
        [["cyberattack", "cyber attack", "ransomware", "data breach", "hacked"]],
    ),
    "bitcoin-crypto": ("Bitcoin crypto", [["bitcoin", r"btc\b", r"crypto\b", "cryptocurrenc"]]),
    "russell-brand-trial": ("Russell Brand trial", [["russell brand"]]),
}


def topic_query(slug: str) -> str:
    spec = TOPIC_SPECS.get(slug)
    return spec[0] if spec else slug.replace("-", " ")


# slug -> one compiled pattern per keyword group; every keyword must start at a word boundary
_TOPIC_RES: dict[str, list[re.Pattern[str]]] = {
    slug: [re.compile(r"\b(?:" + "|".join(group) + ")") for group in groups]
    for slug, (_, groups) in TOPIC_SPECS.items()
}


def _has_word(low: str, stem: str) -> bool:
    """True when `stem` occurs in `low` at a word start (stems are prefixes, so no end boundary)."""
    return re.search(r"\b" + re.escape(stem), low) is not None


def on_topic(text: str, slug: str, *, whole: bool = False) -> bool:
    """Natural-language news search fills its result cap with unrelated recent news when few articles match,
    so the worker keeps only items that pass the topic's keyword gate (see TOPIC_SPECS). By default only the
    headline (first paragraph of Item.text) is checked: descriptions often carry "related stories" sidebars.
    whole=True checks the full text (social posts have no headline)."""
    low = (text if whole else text.split("\n\n", 1)[0]).lower()
    groups = _TOPIC_RES.get(slug)
    if groups:
        return all(g.search(low) for g in groups)
    stems = _stems(topic_query(slug))
    if not stems:
        return True
    return sum(1 for st in stems if _has_word(low, st)) * 2 >= len(stems)


def parse_topics(raw: str | None) -> list[str]:
    """TOPICS env: comma-separated slugs (same format as ingest.worker.topics)."""
    return [t.strip() for t in (raw or "").split(",") if t.strip()]
