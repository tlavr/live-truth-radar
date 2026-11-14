"""T6b: Bluesky source, offline (made-up handles, fake clients, httpx.MockTransport; no network, no sleep)."""

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from contracts.models import Item
from ingest import bluesky, worker
from ingest.bluesky import BlueskyClient, BlueskyError, posts_to_items
from ingest.contextdev import mask_handles

NOW = datetime(2026, 11, 14, 20, 0, tzinfo=timezone.utc)
TOPIC = "microsoft-global-outage"


def post(rkey="3kabc", handle="alice.example.social", text="Microsoft outage again, Outlook is down",
         created="2026-11-14T21:00:00+02:00", indexed="2026-11-14T19:00:30Z"):
    return {
        "uri": f"at://did:plc:fake{rkey}/app.bsky.feed.post/{rkey}",
        "author": {"did": f"did:plc:fake{rkey}", "handle": handle},
        "record": {"text": text, "createdAt": created},
        "indexedAt": indexed,
        "embed": {"external": {"title": "Card title must not leak into text"}},
    }


def test_posts_to_items_maps_fields_and_keeps_a_stable_id():
    [it] = posts_to_items({"posts": [post(handle="@Alice.example.social")]}, TOPIC, now=NOW)
    assert it.source == "context_social" and it.platform == "bluesky"
    assert it.author == "alice.example.social"  # no "@": mask_handle keeps 2 real chars
    assert it.published_at == datetime(2026, 11, 14, 19, 0, tzinfo=timezone.utc)  # createdAt, in UTC
    assert it.text == "Microsoft outage again, Outlook is down"  # record.text only, no link card
    assert it.url == "https://bsky.app/profile/alice.example.social/post/3kabc"
    assert it.id.startswith(f"bsky-{TOPIC}-") and len(it.id) == len(f"bsky-{TOPIC}-") + 16
    assert posts_to_items({"posts": [post()]}, TOPIC, now=NOW)[0].id == it.id
    assert posts_to_items({"posts": [post(rkey="other")]}, TOPIC, now=NOW)[0].id != it.id


def test_created_at_is_replaced_by_indexed_at_when_they_disagree():
    def ts(**kw):
        return posts_to_items({"posts": [post(**kw)]}, TOPIC, now=NOW)[0].published_at

    assert ts(created="2026-11-14T19:04:00Z", indexed="2026-11-14T19:00:00Z") == datetime(
        2026, 11, 14, 19, 4, tzinfo=timezone.utc)  # 4 min apart: createdAt kept
    assert ts(created="2026-11-10T08:00:00Z", indexed="2026-11-14T19:00:00Z") == datetime(
        2026, 11, 14, 19, 0, tzinfo=timezone.utc)  # backdated client: indexedAt
    assert ts(created=None, indexed="2026-11-14T19:00:00Z") == datetime(2026, 11, 14, 19, 0, tzinfo=timezone.utc)


def test_future_empty_link_only_and_handle_less_posts_are_dropped():
    posts = [
        post(rkey="fut", created="2026-11-15T10:00:00Z", indexed="2026-11-15T10:00:00Z"),
        post(rkey="empty", text="   "),
        post(rkey="link", text="https://example.com/a/b nytimes.com/2026/11/outage…"),
        post(rkey="nohandle", handle=""),
        post(rkey="ok"),
        post(rkey="ok"),  # duplicate uri in one response
        "garbage",
    ]
    assert [it.url.rsplit("/", 1)[-1] for it in posts_to_items({"posts": posts}, TOPIC, now=NOW)] == ["ok"]


def _client(tmp_path, handler):
    return BlueskyClient(cache_dir=tmp_path, transport=httpx.MockTransport(handler))


def _page(n, cursor="c"):
    """Page n of a fake search: one post, n hours before NOW (newest first)."""
    ts = (NOW - timedelta(hours=n)).isoformat()
    body = {"posts": [post(rkey=f"p{n}", created=ts, indexed=ts)]}
    if cursor:
        body["cursor"] = cursor
    return httpx.Response(200, json=body)


def test_search_pages_by_until_because_the_cursor_is_forbidden_without_login(tmp_path):
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        if "cursor" in req.url.params:
            return httpx.Response(403, text="Request forbidden by administrative rules.")
        return _page(len(seen))

    since = NOW - timedelta(hours=12)
    got = _client(tmp_path, handler).search("Microsoft outage", since, max_pages=3)
    assert len(got["posts"]) == 3 and len(seen) == 3
    assert seen[0] == {"q": "Microsoft outage", "sort": "latest", "since": "2026-11-14T08:00:00Z", "limit": "100"}
    assert [s.get("until") for s in seen] == [None, "2026-11-14T19:00:00.000Z", "2026-11-14T18:00:00.000Z"]
    assert len(list(tmp_path.glob("*.json"))) == 3  # raw pages in cache/, not in git


def test_search_stops_at_the_last_page_the_window_or_a_failure(tmp_path):
    def call(handler, since=NOW - timedelta(hours=12), pages=10):
        return len(_client(tmp_path, handler).search("q", since, max_pages=pages)["posts"])

    assert call(lambda req: _page(1, cursor=None)) == 1  # no cursor: last page
    assert call(lambda req: _page(1), since=NOW - timedelta(minutes=30)) == 1  # page reached `since`
    assert call(lambda req: _page(1)) == 2  # no progress (same oldest time): stop after the repeat

    calls = []

    def flaky(req):
        calls.append(1)
        return _page(1) if len(calls) == 1 else httpx.Response(502, text="bad gateway")

    assert call(flaky) == 1  # page 2 failed: page 1 kept

    with pytest.raises(BlueskyError):
        call(lambda req: httpx.Response(403, text="forbidden"))
    with pytest.raises(BlueskyError):
        call(lambda req: httpx.Response(200, json={"error": "x"}))


def _src(name, fetch, whole=False):
    return worker.Source(name, lambda conn, topic, now: None, fetch, whole_text=whole)


def _item(i, text, platform="bluesky"):
    return Item(id=i, source="context_social" if platform == "bluesky" else "context_news", platform=platform,
                author="a.example", published_at=NOW, text=text, topic=TOPIC)


def test_failing_source_never_drops_the_other_and_posts_use_the_whole_text_gate():
    def boom(topic, since):
        raise httpx.ConnectError("down")

    news = _src("news", lambda t, s: [_item("n1", "Microsoft outage hits Outlook", "news")])
    second_para = _item("b1", "Is anyone else seeing this?\n\nMicrosoft says the outage is fixed")
    bsky = _src("bluesky", lambda t, s: [second_para, _item("b2", "nothing on topic")], whole=True)
    assert [it.id for it in worker.fetch_topic([news, _src("bluesky", boom)], TOPIC, {})] == ["n1"]
    assert [it.id for it in worker.fetch_topic([_src("news", boom), bsky], TOPIC, {})] == ["b1"]
    assert worker.fetch_topic([_src("news", boom), _src("bluesky", boom)], TOPIC, {}) is None


class FakeConn:
    broken = closed = False

    def commit(self):
        pass

    def rollback(self):
        pass


def test_ingest_cycle_without_context_dev_key_reads_bluesky_with_a_backfill_then_by_platform(monkeypatch):
    searches, latest_calls, upserted = [], [], []
    latest = {"value": None}

    class FakeBsky:
        def search(self, q, since, max_pages=3):
            searches.append((q, since, max_pages))
            ts = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()  # fetch_bluesky uses the real clock
            return {"posts": [post(created=ts, indexed=ts)]}

    def latest_published(conn, topic, source, platform=None):
        latest_calls.append((source, platform))
        return latest["value"]

    monkeypatch.setenv("TOPICS", TOPIC)
    monkeypatch.delenv("CONTEXT_DEV_API_KEY", raising=False)
    monkeypatch.delenv("BLUESKY_ENABLED", raising=False)  # default on
    monkeypatch.setattr(worker, "_client", None)
    monkeypatch.setattr(worker, "_get_bluesky", lambda: FakeBsky())
    monkeypatch.setattr(worker, "_bsky_backfilled", set())
    monkeypatch.setattr(worker.store, "latest_published", latest_published)
    monkeypatch.setattr(worker.store, "upsert_items", lambda conn, items: upserted.extend(items) or len(items))
    monkeypatch.setattr(worker.store, "set_last_poll", lambda conn: None)

    got = worker.ingest_cycle(FakeConn())
    assert [it.platform for it in got] == ["bluesky"] and upserted == got
    assert latest_calls == [("context_social", "bluesky")]  # Reddit posts must not move Bluesky's since
    q, since, pages = searches[0]
    assert q == bluesky.BSKY_QUERIES[TOPIC] and pages == worker.BLUESKY_BACKFILL_PAGES
    assert timedelta(hours=47.9) < datetime.now(timezone.utc) - since < timedelta(hours=48.1)  # first poll

    latest["value"] = datetime.now(timezone.utc) - timedelta(minutes=30)
    worker.ingest_cycle(FakeConn())
    _, since, pages = searches[1]
    assert pages == worker.BLUESKY_PAGES and since == latest["value"] - worker.NEWS_OVERLAP

    monkeypatch.setenv("BLUESKY_ENABLED", "0")  # quick rollback to news only (here: no source at all)
    assert worker.ingest_cycle(FakeConn()) == [] and len(searches) == 2


def test_latest_published_filters_by_platform_only_when_asked():
    from ingest import store

    class Conn:
        def execute(self, sql, params):
            self.sql, self.params = sql, params
            return self

        def fetchone(self):
            return {"latest": None}

    c = Conn()
    store.latest_published(c, "t", "context_social", "bluesky")
    assert "platform = %s" in c.sql and c.params == ("t", "context_social", "bluesky")
    store.latest_published(c, "t", "context_news")
    assert "platform" not in c.sql and c.params == ("t", "context_news")


def test_bluesky_mentions_and_profile_links_are_masked_in_text_and_api():
    text = ("cc @bob.example.social see https://bsky.app/profile/carol.example.social/post/3k "
            "and bsky.app/profile/did:plc:abc123, mail x@y.com")
    masked = mask_handles(text)
    assert "bob" not in masked and "carol" not in masked and "abc123" not in masked
    assert masked.endswith("mail x@y.com")

    from api.main import public_item

    it = _item("b1", text).model_copy(update={"url": "https://bsky.app/profile/a.example/post/1"})
    pub = public_item(it)
    assert pub.text == masked and pub.url is None and pub.author == "a.***"
    fake = it.model_copy(update={"synthetic": True})
    assert public_item(fake).text == text  # synthetic posts are shown as generated


def test_bluesky_queries_cover_every_agreed_topic():
    from ingest.contextdev import TOPIC_SPECS

    assert set(bluesky.BSKY_QUERIES) == set(TOPIC_SPECS)
    assert bluesky.bsky_query("some-new-topic") == "some new topic"


def test_backfill_runs_once_per_topic_even_if_nothing_is_stored_and_is_retried_after_a_failure(monkeypatch):
    calls = []

    class FakeBsky:
        fail = True

        def search(self, q, since, max_pages=3):
            calls.append(max_pages)
            if self.fail:
                raise BlueskyError("HTTP 502")
            return {"posts": []}  # nothing on topic: the DB keeps no Bluesky post for this topic

    monkeypatch.setattr(worker, "_bsky_backfilled", set())
    monkeypatch.setattr(worker, "_get_bluesky", lambda: FakeBsky())
    monkeypatch.setattr(worker, "_get_client", lambda: None)
    monkeypatch.setenv("BLUESKY_ENABLED", "1")
    monkeypatch.setattr(worker.store, "latest_published", lambda *a: None)
    [src] = worker.active_sources(6)

    def poll():
        return worker.fetch_topic([src], TOPIC, {"bluesky": src.since(None, TOPIC, NOW)})

    assert poll() is None and calls == [worker.BLUESKY_BACKFILL_PAGES]  # failed backfill
    FakeBsky.fail = False
    assert poll() == [] and calls[-1] == worker.BLUESKY_BACKFILL_PAGES  # retried
    assert poll() == [] and calls[-1] == worker.BLUESKY_PAGES  # done once: a normal poll now
    assert src.since(None, TOPIC, NOW) == NOW - timedelta(hours=6)  # the detector window


def test_accounts_with_an_invalid_handle_are_keyed_by_did_and_broken_fields_do_not_crash():
    a = post(rkey="1", handle="handle.invalid")
    b = post(rkey="2", handle="handle.invalid")
    items = posts_to_items({"posts": [a, b]}, TOPIC, now=NOW)
    assert [it.author for it in items] == ["did:plc:fake1", "did:plc:fake2"]  # two accounts, not one
    assert items[0].url == "https://bsky.app/profile/did:plc:fake1/post/1"

    broken = [post(rkey="3"), post(rkey="4")]
    broken[0]["author"] = "not a dict"
    broken[1]["record"] = "not a dict"
    assert posts_to_items({"posts": broken}, TOPIC, now=NOW) == []
    assert bluesky._oldest(broken + ["junk"]) is not None  # indexedAt of the post with a broken record


def test_masking_is_case_insensitive_and_covers_bare_dids():
    assert mask_handles("Bsky.app/Profile/alice.example.social") == "@***"
    assert mask_handles("at://did:plc:xyz123/app.bsky.feed.post/1") == "at://@***/app.bsky.feed.post/1"
    assert mask_handles("see did:web:alice.example.") == "see @***."


def test_reddit_branch_stays_case_sensitive_so_news_text_is_not_over_masked():
    assert mask_handles("U/S dollar and the U/turn") == "U/S dollar and the U/turn"
    assert mask_handles("thanks u/john-doe") == "thanks @***"


def test_non_string_timestamps_drop_only_that_post():
    bad = post(rkey="bad", created=1731600000, indexed={"x": 1})
    good = post(rkey="good")
    assert [it.url.rsplit("/", 1)[-1] for it in posts_to_items({"posts": [bad, good]}, TOPIC, now=NOW)] == ["good"]
    assert bluesky._oldest([bad]) is None and bluesky._oldest([bad, good]) is not None
