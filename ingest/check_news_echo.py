"""T6b offline check before enabling Bluesky: does `news_echo` cut the red team attack?

With context_social posts in the window, detect/news_echo.py caps a group at "watching" when an article
published <= 1 h before its first post is close in meaning to it. Attack posts name the topic's subject, so on a
topic with a lot of news (Microsoft) the attack might stop reaching "coordinated". This script replays the
/redteam attack on the live window; nothing is written to the DB or the repo (raw Bluesky pages and embeddings go
to the git-ignored cache/):

    background = the topic's real items in the DB (news) over DETECT_WINDOW_HOURS
               + fresh Bluesky posts fetched into memory (not stored)
    attack     = api.main._attack_campaign(topic, now, 25, "paraphrase", 4), exactly what POST /api/attack builds

and runs detect.pipeline.scan at now + 30 s ... 10 min, with and without the Bluesky posts. For each run it prints
the attack group's verdict and note, plus how many "coordinated" findings have no synthetic account (real people).
A topic is OK when the attack reaches "coordinated" within 120 s with Bluesky posts in the window, FAIL otherwise,
and NOT CHECKED when the window holds no context_social post (news_echo stays off, so the run proves nothing).
Exit code: 1 on any FAIL, else 2 if any topic was NOT CHECKED, else 0.

Run on the VPS inside the worker container (DB read-only, Gemini embeddings through cache/embeddings/):
    docker compose -f infra/docker-compose.yml --env-file .env exec worker python -m ingest.check_news_echo
Options: --topics a,b  --n-accounts 25  --posts-per-bot 4  --pages 10
Output has counts, verdicts and notes (notes quote news headlines, which are public); no account handles.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone

from contracts.models import Finding, Item
from detect.operating import DEFAULT_ALPHA
from detect.pipeline import scan
from ingest import store
from ingest.bluesky import BlueskyClient, bsky_query, posts_to_items
from ingest.contextdev import on_topic
from ingest.worker import _positive

ATTACK_TOPICS = ["helsinki-tram-fares", "jensen-huang-resignation", "microsoft-global-outage",
                 "europe-bomb-threat-hoaxes"]
OFFSETS_SEC = [30, 60, 90, 120, 180, 300, 600]
MAX_FIRST_SEC = 120


def attack_group(findings: list[Finding], attack_ids: set[str]) -> Finding | None:
    """The finding holding most attack posts (None if no finding contains any)."""
    best, best_n = None, 0
    for f in findings:
        n = len(attack_ids.intersection(f.item_ids))
        if n > best_n:
            best, best_n = f, n
    return best


def real_coordinated(findings: list[Finding], synthetic_ids: set[str]) -> int:
    return sum(1 for f in findings if f.verdict == "coordinated" and not synthetic_ids.intersection(f.item_ids))


def topic_status(background: list[Item], first: int | None, limit: int = MAX_FIRST_SEC) -> str:
    """OK / FAIL for the news + bluesky run; NOT CHECKED if no context_social post is in the window (news_echo is
    only on with one, detect.pipeline `has_social`, and attack posts are source="synthetic")."""
    if not any(it.source == "context_social" for it in background):
        return "NOT CHECKED"
    return "OK" if first is not None and first <= limit else "FAIL"


def exit_code(statuses) -> int:
    statuses = list(statuses)
    return 1 if "FAIL" in statuses else 2 if "NOT CHECKED" in statuses else 0


def run_topic(conn, topic: str, now: datetime, window_h: float, n_accounts: int, posts_per_bot: int,
              pages: int) -> str:
    from api.main import _attack_campaign  # the /redteam campaign builder (P1)

    # the window is frozen at `now`: articles that would arrive during the attack are not seen, so the check can be
    # slightly optimistic
    news = [it for it in store.window_items(conn, topic, window_h, now) if not it.synthetic]
    conn.rollback()  # end the read transaction before the slow part
    bsky: list[Item] = []
    client = BlueskyClient()
    try:
        resp = client.search(bsky_query(topic), now - timedelta(hours=window_h), max_pages=pages)
        known = {it.id for it in news}
        bsky = [it for it in posts_to_items(resp, topic, now=now)
                if on_topic(it.text, topic, whole=True) and it.id not in known]
    except Exception as e:  # report and still run the news-only baseline
        print(f"  bluesky fetch failed: {type(e).__name__}: {e}")
    finally:
        client.close()
    attack = _attack_campaign(topic, now, n_accounts, "paraphrase", posts_per_bot)
    attack_ids = {it.id for it in attack}
    n_news = sum(1 for it in news if it.source == "context_news")
    print(f"\n== {topic}: news={n_news} other_db={len(news) - n_news} bluesky={len(bsky)} "
          f"bluesky_authors={len({it.author for it in bsky})} attack_posts={len(attack)}")

    status = "NOT CHECKED"
    for label, background in (("news only", news), ("news + bluesky", news + bsky)):
        first = None
        for off in OFFSETS_SEC:
            at = now + timedelta(seconds=off)
            findings, _ = scan(background + attack, topics=[topic], now=at, alpha=DEFAULT_ALPHA)
            g = attack_group(findings, attack_ids)
            verdict = g.verdict if g else "-"
            note = (g.note or "") if g else ""
            n_att = len(attack_ids.intersection(g.item_ids)) if g else 0
            print(f"  [{label:14}] +{off:>3}s attack: {verdict:11} accounts={len(g.accounts) if g else 0:>2} "
                  f"attack_posts={n_att:>3} llr={(g.llr if g else 0):6.2f} real_coordinated="
                  f"{real_coordinated(findings, attack_ids)}{'  note: ' + note if note else ''}")
            if first is None and verdict == "coordinated":
                first = off
        print(f"  [{label:14}] first coordinated at: {'+' + str(first) + 's' if first is not None else 'never'}")
        if label == "news + bluesky":
            status = topic_status(background, first)
    return status


def default_topics() -> list[str]:
    """What /api/attack/topics serves; the hard-coded list if that cannot be computed."""
    try:
        from api.main import _attack_topics

        return _attack_topics() or ATTACK_TOPICS
    except Exception:
        return ATTACK_TOPICS


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--topics", default=",".join(default_topics()))
    ap.add_argument("--n-accounts", type=int, default=25)
    ap.add_argument("--posts-per-bot", type=int, default=4)
    ap.add_argument("--pages", type=int, default=10, help="Bluesky pages of 100 per topic")
    args = ap.parse_args()
    window_h = _positive("DETECT_WINDOW_HOURS", 6)  # same window as the worker
    now = datetime.now(timezone.utc)
    conn = store.connect()
    results = {}
    try:
        for topic in [t.strip() for t in args.topics.split(",") if t.strip()]:
            results[topic] = run_topic(conn, topic, now, window_h, args.n_accounts, args.posts_per_bot, args.pages)
    finally:
        conn.close()
    print(f"\nSUMMARY (news + bluesky, coordinated <= {MAX_FIRST_SEC} s):")
    for topic, status in results.items():
        print(f"  {topic}: {status}")
    return exit_code(results.values())


if __name__ == "__main__":
    sys.exit(main())
