"""P1: Context.dev responses -> contracts.Item (offline; shapes from the Context.dev OpenAPI / parser docs)."""

from datetime import datetime, timezone

from ingest.contextdev import news_to_items, parse_topics, reddit_to_items

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)  # fixed clock: items after now + skew are dropped

NEWS = {
    "data": [
        {"id": "a1", "url": "https://ex.com/1", "title": "Fares up", "description": "HSL raises fares",
         "authors": ["Jane"], "published_at": "2026-11-14T08:00:00Z", "source": {"domain": "Ex.com"}},
        {"id": "a2", "title": "No byline", "description": None, "authors": [],
         "published_at": "2026-11-14T09:00:00+02:00", "source": {"domain": "news.fi"}},
        {"id": "a3", "title": "No time", "authors": [], "published_at": None, "source": {"domain": "x.fi"}},
    ]
}

REDDIT = {
    "parsed": {"success": True, "data": {"posts": [
        {"id": "p1", "title": "Tram fares?", "body": "So expensive", "author": "alice",
         "posted_at": "2026-11-14T07:00:00.000Z", "url": "https://reddit.com/r/x/comments/p1"},
        {"id": "p2", "title": "deleted", "body": None, "author": None, "posted_at": "2026-11-14T07:00:00Z"},
        {"id": "p3", "title": "", "body": None, "author": "bob", "posted_at": "2026-11-14T07:00:00Z"},
    ]}}
}


def test_news_to_items():
    items = news_to_items(NEWS, "t", now=NOW)
    assert [i.id for i in items] == ["news-t-a1", "news-t-a2"]  # no published_at -> dropped
    a1, a2 = items
    assert a1.source == "context_news" and a1.author == "ex.com" and a1.text == "Fares up\n\nHSL raises fares"
    assert a2.published_at.tzinfo == timezone.utc and a2.published_at.hour == 7
    assert a2.text == "No byline"


def test_reddit_to_items():
    items = reddit_to_items(REDDIT, "t", now=NOW)
    assert [i.id for i in items] == ["reddit-t-p1"]  # deleted author and empty text dropped
    (p,) = items
    assert p.source == "context_social" and p.platform == "reddit" and p.author == "u/alice"
    assert p.published_at.tzinfo is not None and p.topic == "t"


def test_parse_topics():
    assert parse_topics("a, b-c ,,") == ["a", "b-c"]
    assert parse_topics(None) == []


def test_on_topic_keyword_gate():
    from ingest.contextdev import on_topic, topic_query

    assert topic_query("france-riots") == "France riots" and topic_query("some-new-topic") == "some new topic"
    # agreed topics: every keyword group must match
    assert on_topic("Riots spread across French suburbs", "france-riots")
    assert not on_topic("France stuns world champion Springboks 21-19", "france-riots")
    assert on_topic("Zelensky says Ukraine ready for ceasefire talks", "ukraine-peace-talks")
    assert not on_topic("Tanker collides with cruise ship on Mississippi", "ukraine-peace-talks")
    assert on_topic("Microsoft services begin recovering after global outage", "microsoft-global-outage")
    # other slugs: at least half of the query words (crude stems)
    assert on_topic("HSL raises Helsinki trams ticket prices", "helsinki-trams-fares")  # 2 of 3
    assert not on_topic("Airlines waive change fares after ground stop", "helsinki-trams-fares")  # 1 of 3
    assert on_topic("anything", "a-b")  # no usable words -> keep
    assert not on_topic("SpaceX launch setback\n\nRelated: Microsoft global outage", "microsoft-global-outage")
    # loose substrings must not let unrelated news through
    assert not on_topic("Microsoft Edge adds faster downloads", "microsoft-global-outage")
    assert not on_topic("Paris Saint-Germain clash with Lyon", "france-riots")
    assert not on_topic("Jensen Huang unveils new GPU", "jensen-huang-resignation")
    assert on_topic("Jensen Huang steps down as Nvidia CEO", "jensen-huang-resignation")
    # keywords match at a word start only, so stems still work but words inside other words do not
    assert not on_topic("Jensen Huang sells $1B in Nvidia equity", "jensen-huang-resignation")
    assert not on_topic("Jensen Huang is quite optimistic about AI", "jensen-huang-resignation")
    assert not on_topic("French patriots celebrate national day", "france-riots")
    assert not on_topic("Helsinki debates welfare cuts", "helsinki-tram-fares")
    assert on_topic("Jensen Huang resignation rumours denied", "jensen-huang-resignation")
    assert on_topic("Board votes to reinstate Jensen Huang", "jensen-huang-resignation")
    assert on_topic("Ukrainian envoy says negotiations resume", "ukraine-peace-talks")
    assert on_topic("Bomb scare: station evacuated", "europe-bomb-threat-hoaxes")
    assert on_topic("Office 365 outage hits users", "microsoft-global-outage")
    assert on_topic("Jensen Huang quits Nvidia", "jensen-huang-resignation")
    assert on_topic("Will Jensen Huang quit?", "jensen-huang-resignation")


def test_nul_bytes_stripped():
    # Postgres text cannot hold NUL: psycopg raises DataError on insert, which used to kill the worker
    news = {"data": [{"id": "n\x00", "url": "https://ex.com/\x00x", "title": "Fa\x00res", "description": "up\x00",
                      "published_at": "2026-11-14T08:00:00Z", "source": {"domain": "ex\x00.com"}}]}
    red = {"parsed": {"success": True, "data": {"posts": [
        {"id": "p\x00", "title": "Tram\x00", "body": "b", "author": "al\x00ice",
         "posted_at": "2026-11-14T07:00:00Z", "url": "https://reddit.com/\x00"}]}}}
    for it in news_to_items(news, "t", now=NOW) + reddit_to_items(red, "t", now=NOW):
        for v in (it.id, it.author, it.text, it.url):
            assert "\x00" not in v


def test_lone_surrogates_replaced():
    # JSON "\ud83d" (JS-truncated emoji) decodes to a lone surrogate: psycopg's utf-8 encode raises
    # UnicodeEncodeError while binding, which used to kill the worker
    s = "\ud83d"
    news = {"data": [{"id": "n" + s, "url": "https://ex.com/" + s, "title": "Fa" + s, "description": "up" + s,
                      "published_at": "2026-11-14T08:00:00Z", "source": {"domain": "ex" + s + ".com"}}]}
    red = {"parsed": {"success": True, "data": {"posts": [
        {"id": "p" + s, "title": "Tram" + s, "body": "b" + s, "author": "al" + s + "ice",
         "posted_at": "2026-11-14T07:00:00Z", "url": "https://reddit.com/" + s}]}}}
    items = news_to_items(news, "t", now=NOW) + reddit_to_items(red, "t", now=NOW)
    assert len(items) == 2
    for it in items:
        for v in (it.id, it.author, it.text, it.url):
            v.encode("utf-8")  # raises UnicodeEncodeError if a surrogate survived


def test_future_items_dropped():
    now = datetime(2026, 11, 14, 8, 0, tzinfo=timezone.utc)
    news = {"data": [
        {"id": "ok", "title": "a", "published_at": "2026-11-14T08:05:00Z", "source": {"domain": "x.fi"}},  # skew
        {"id": "fut", "title": "b", "published_at": "2026-11-15T08:00:00Z", "source": {"domain": "x.fi"}},
    ]}
    assert [i.id for i in news_to_items(news, "t", now=now)] == ["news-t-ok"]
    red = {"parsed": {"success": True, "data": {"posts": [
        {"id": "fut", "title": "b", "author": "a", "posted_at": "2026-11-15T08:00:00Z"}]}}}
    assert reddit_to_items(red, "t", now=now) == []


def test_news_since_never_in_future():
    from datetime import timedelta

    from ingest.worker import NEWS_OVERLAP, news_since

    now = datetime(2026, 11, 14, 8, 0, tzinfo=timezone.utc)
    assert news_since(now, 6, None) == now - timedelta(hours=6)
    assert news_since(now, 6, now - timedelta(hours=1)) == now - timedelta(hours=1) - NEWS_OVERLAP
    assert news_since(now, 6, now + timedelta(days=1)) == now - NEWS_OVERLAP  # future-dated row must not stall


def test_mask_handles():
    from ingest.contextdev import mask_handles

    assert mask_handles("Said (@agency) and X/@_photo_cred, see u/bob_1") == "Said (@***) and X/@***, see @***"
    assert mask_handles("mail me at a.b@ex.com") == "mail me at a.b@ex.com"  # e-mail domains untouched
    # Reddit names may contain "-"; profile URLs carry the name too
    assert (mask_handles("thanks u/john-doe and @x_y, mail a@b.com, see reddit.com/user/alice, /u/Some-Name")
            == "thanks @*** and @***, mail a@b.com, see @***, /@***")
    # Instagram/TikTok handles may contain dots; a trailing sentence dot stays
    assert mask_handles("via @john.doe and @jane_d.") == "via @*** and @***."
    assert mask_handles("C-3PO@home, bob@example.com") == "C-3PO@home, bob@example.com"


def test_ingest_cycle_survives_bad_topic(monkeypatch):
    import psycopg
    import pytest

    from ingest import worker

    class Conn:
        commits = rollbacks = 0
        broken = closed = False

        def commit(self):
            Conn.commits += 1

        def rollback(self):
            Conn.rollbacks += 1

    upserted, polled = [], []
    monkeypatch.setenv("TOPICS", "a,c,q,dead,b")
    monkeypatch.setattr(worker, "active_sources", lambda window_h: [worker.Source("news", lambda conn, t, now: None, lambda t, since: [])])
    monkeypatch.setattr(worker, "fetch_topic", lambda srcs, topic, sinces: None if topic == "dead" else [topic])
    monkeypatch.setattr(worker.store, "set_last_poll", lambda conn: polled.append(1))

    def bad_upsert(conn, items):
        if items == ["a"]:
            raise psycopg.DataError("bad row")
        if items == ["c"]:
            raise UnicodeEncodeError("utf-8", "\ud83d", 0, 1, "surrogates not allowed")  # raised while binding
        if items == ["q"]:
            raise psycopg.errors.QueryCanceled("statement timeout")  # OperationalError, connection still fine
        upserted.append(items[0])
        return 1

    monkeypatch.setattr(worker.store, "upsert_items", bad_upsert)
    worker.ingest_cycle(Conn())
    assert upserted == ["b"]  # bad rows in a and c, timeout in q, all sources down for "dead": b still ingested
    assert Conn.commits == 1 and Conn.rollbacks == 4 and polled == [1]

    monkeypatch.setattr(worker.store, "upsert_items", lambda conn, items: [][0])  # every topic fails
    polled.clear()
    worker.ingest_cycle(Conn())
    assert polled == []  # last_poll_at only after a successful topic

    def lost(conn, items):
        raise psycopg.OperationalError("gone")

    monkeypatch.setattr(worker.store, "upsert_items", lost)
    dead = Conn()
    dead.broken = True
    with pytest.raises(psycopg.OperationalError):  # connection loss still reaches the reconnect loop
        worker.ingest_cycle(dead)


def test_export_sample_masks_handles_in_text():
    from datetime import datetime, timezone

    from contracts.models import Item
    from ingest.export_sample import pseudonymize

    it = Item(id="n1", source="context_news", author="ex.com", published_at=datetime(2026, 11, 14, tzinfo=timezone.utc),
              text="Reported by (@newsdesk)", url="https://ex.com/1", topic="t")
    (out,) = pseudonymize([it], "salt")
    assert out.text == "Reported by (@***)" and out.author.startswith("acct-")


def test_export_sample_masks_emails_in_text():
    from ingest.export_sample import mask_emails

    text = "Outage hits Azure. By Kim (jane.doe@yna.co.kr), reporter@news-site.com; follow @MSFT"
    assert mask_emails(text) == "Outage hits Azure. By Kim ([email]), [email]; follow @MSFT"
