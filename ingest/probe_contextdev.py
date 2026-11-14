"""T2 probe: which fields Context.dev really returns, plus a pseudonymized live sample for P2.

Run: python -m ingest.probe_contextdev   (needs CONTEXT_DEV_API_KEY, TOPICS, LTR_HASH_SALT in env)
Raw responses go to cache/contextdev/ (git-ignored); the sample goes to fixtures/items_live_sample.json
with authors replaced by contracts.pseudonym(), @handles / u/names in the text masked, and post URLs
dropped (they can identify accounts).
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from contracts.models import pseudonym
from ingest.contextdev import (
    ContextDevClient,
    ContextDevError,
    mask_handles,
    news_to_items,
    on_topic,
    parse_topics,
    topic_query,
    reddit_to_items,
)

SAMPLE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "items_live_sample.json"
SAMPLE_MAX = 20  # eval tests load this file: keep make test < 5 s


def _field_stats(name: str, rows: list[dict], fields: list[str]) -> None:
    n = len(rows)
    present = {f: sum(1 for r in rows if r.get(f) not in (None, "", [])) for f in fields}
    print(f"  {name}: {n} raw, " + ", ".join(f"{f}={present[f]}/{n}" for f in fields))


def main() -> int:
    key, salt = os.environ.get("CONTEXT_DEV_API_KEY"), os.environ.get("LTR_HASH_SALT")
    topics = parse_topics(os.environ.get("TOPICS"))
    if not (key and salt and topics):
        print("need CONTEXT_DEV_API_KEY, LTR_HASH_SALT and TOPICS in env", file=sys.stderr)
        return 2
    since = datetime.now(timezone.utc) - timedelta(hours=int(os.environ.get("DETECT_WINDOW_HOURS") or 6))
    items = []
    with ContextDevClient(key, cache_ttl_sec=24 * 3600) as c:
        for topic in topics:
            query = topic_query(topic)
            print(f"[{topic}] {query!r}")
            try:
                news = c.news_search(query, since=since)
                _field_stats("news", news.get("data") or [], ["authors", "published_at", "description", "source"])
                items += news_to_items(news, topic)
            except ContextDevError as e:
                print(f"  news FAILED: {e}")
            try:
                red = c.reddit_search(query)
                posts = ((red.get("parsed") or {}).get("data") or {}).get("posts") or []
                _field_stats("reddit", posts, ["author", "posted_at", "body", "subreddit"])
                items += reddit_to_items(red, topic)
            except ContextDevError as e:
                print(f"  reddit FAILED: {e}")
    print("normalized:", Counter((i.topic, i.source) for i in items))
    items = [i for i in items if on_topic(i.text, i.topic)]
    print("on topic:", Counter((i.topic, i.source) for i in items))
    print("distinct authors:", len({i.author for i in items}))
    # spread the sample across topics/sources, newest first
    items.sort(key=lambda i: i.published_at, reverse=True)
    by_group: dict[tuple[str, str], list] = {}
    for it in items:
        by_group.setdefault((it.topic, it.source), []).append(it)
    sample = []
    while len(sample) < SAMPLE_MAX and any(by_group.values()):
        for g in list(by_group):
            if by_group[g] and len(sample) < SAMPLE_MAX:
                sample.append(by_group[g].pop(0))
    out = [
        it.model_copy(
            update={"author": pseudonym(it.author, salt), "text": mask_handles(it.text), "url": None}
        ).model_dump(mode="json")
        for it in sample
    ]
    SAMPLE_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(out)} items -> {SAMPLE_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
