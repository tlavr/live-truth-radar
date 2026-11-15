"""S1 Source Trust: parsing, domain checks, cache and the never-failing endpoint (offline)."""

from contextlib import contextmanager

import httpx
from fastapi.testclient import TestClient

import api.main as main
from ingest.contextdev import ContextDevError
from ingest.source_trust import SourceTrust, normalize_domain, parse_brand, parse_company

BRAND = {"status": "ok", "brand": {
    "domain": "reuters.com", "title": "Reuters", "description": "News agency",
    "logos": [{"url": "https://x/logo.png", "type": "logo", "mode": "light"},
              {"url": "https://x/icon-dark.png", "type": "icon", "mode": "dark"},
              {"url": "http://x/insecure.png", "type": "icon", "mode": "dark"}],
    "industries": {"eic": [{"industry": "Media", "subindustry": "News"}]},
    "address": {"country_code": "GB"}, "employees": {"range": "10001+"}}}
COMPANY = {"results": [{"domain": "other.com", "founded_year": 2001},
                       {"domain": "www.reuters.com", "founded_year": 1851}]}


class FakeClient:
    def __init__(self, brand=BRAND, company=COMPANY, brand_exc=None):
        self.brand, self.company, self.brand_exc, self.calls = brand, company, brand_exc, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass

    def post(self, path, body):
        self.calls.append(path)
        if path == "/brand/retrieve":
            if self.brand_exc:
                raise self.brand_exc
            return self.brand
        return self.company


def trust(tmp_path, client, **kw):
    return SourceTrust(lambda: client, cache_dir=tmp_path, **kw)


def test_normalize_domain():
    assert normalize_domain("WWW.Reuters.com.") == "reuters.com"
    assert normalize_domain("edition.cnn.com") == "edition.cnn.com"
    for bad in ("", "localhost", "../etc/passwd", "a b.com", "x.com/path", "1.2.3.4"):
        assert normalize_domain(bad) is None


def test_parse_brand_and_company():
    info = parse_brand(BRAND, "reuters.com")
    assert info.found and info.name == "Reuters" and info.country == "GB" and info.industry == "Media"
    assert info.logo_url == "https://x/icon-dark.png"  # icon, dark, https only
    assert parse_company(COMPANY, "reuters.com") == 1851  # the hit for this domain, not the first one
    assert not parse_brand({"brand": {"title": 5}}, "x.com").found
    assert parse_company({"results": [{"domain": "reuters.com", "founded_year": "1851"}]}, "reuters.com") is None


def test_lookup_caches_and_survives_failures(tmp_path):
    c = FakeClient()
    st = trust(tmp_path, c)
    a = st.lookup("reuters.com")
    assert a.found and a.founded_year == 1851 and a.age_years is not None and a.age_years > 170
    assert st.lookup("reuters.com") == a and len(c.calls) == 2  # second call from the disk cache

    down = FakeClient(brand_exc=httpx.ConnectTimeout("t"))
    st2 = trust(tmp_path / "b", down)
    assert not st2.lookup("bbc.com").found
    st2.lookup("bbc.com")
    assert len(down.calls) == 2  # an outage is not cached

    missing = FakeClient(brand_exc=ContextDevError("NOT_FOUND", status=400))
    st3 = trust(tmp_path / "c", missing)
    assert not st3.lookup("tiny.site").found and not st3.lookup("tiny.site").found
    assert len(missing.calls) == 1  # "no such brand" is the answer: cached


def test_company_failure_keeps_brand_and_budget_caps_calls(tmp_path):
    c = FakeClient(company=None)
    c.post = lambda path, body: BRAND if path == "/brand/retrieve" else (_ for _ in ()).throw(ContextDevError("x", 500))
    info = trust(tmp_path, c).lookup("reuters.com")
    assert info.found and info.founded_year is None

    c2 = FakeClient()
    st = trust(tmp_path / "b", c2, max_new_per_hour=1)
    assert st.lookup("a.com").found and not st.lookup("b.com").found
    assert c2.calls.count("/brand/retrieve") == 1


class SourceStore:
    def __init__(self, publishers=(), fail=False):
        self.publishers, self.fail = set(publishers), fail

    @contextmanager
    def connect(self):
        if self.fail:
            raise RuntimeError("db down")
        yield self

    def news_publisher(self, conn, host):
        hits = [p for p in self.publishers if host == p or host.endswith("." + p)]
        return max(hits, key=len) if hits else None


def test_endpoint_only_known_publishers_and_never_fails(tmp_path, monkeypatch):
    c = FakeClient()
    monkeypatch.setattr(main, "SOURCES", trust(tmp_path, c))
    monkeypatch.setattr(main, "store", SourceStore({"reuters.com"}))
    api = TestClient(main.app)
    r = api.get("/api/source/www.uk.reuters.com")
    assert r.status_code == 200 and r.json()["found"] and r.json()["domain"] == "reuters.com"
    for host in ("unknown.com", "not a domain"):
        r = api.get(f"/api/source/{host}")
        assert r.status_code == 200 and r.json()["found"] is False
    assert c.calls.count("/brand/retrieve") == 1  # unknown hosts never reach Context.dev

    monkeypatch.setattr(main, "store", SourceStore(fail=True))
    r = api.get("/api/source/reuters.com")
    assert r.status_code == 200 and r.json()["found"] is False


def test_lookup_never_raises_and_skips_raw_writes(tmp_path):
    from ingest.contextdev import ContextDevClient

    def client(handler, raw):
        c = ContextDevClient("k", cache_dir=raw, cache_ttl_sec=0)
        c._http = httpx.Client(base_url="https://x", transport=httpx.MockTransport(handler))
        return c

    ok = lambda req: httpx.Response(200, json={"brand": {"title": "Reuters"}})
    (tmp_path / "blocker").write_text("x")  # an unwritable raw dir: ttl 0 must not touch it
    st = SourceTrust(lambda: client(ok, tmp_path / "blocker" / "raw"), cache_dir=tmp_path / "c1")
    assert st.lookup("reuters.com").found
    st = SourceTrust(lambda: client(ok, tmp_path / "raw"), cache_dir=tmp_path / "c2")
    st.lookup("reuters.com")
    assert not (tmp_path / "raw").exists()  # no raw response files with ttl 0

    listy = lambda req: httpx.Response(200, json=["oops"])
    st = SourceTrust(lambda: client(listy, tmp_path / "raw3"), cache_dir=tmp_path / "c3")
    assert not st.lookup("reuters.com").found and st.cached("reuters.com") is None

    boom = FakeClient(brand_exc=AttributeError("x"))
    st = trust(tmp_path / "c4", boom)
    assert not st.lookup("bbc.com").found and st.cached("bbc.com") is None  # unexpected error: not cached


def test_only_not_found_400_is_cached(tmp_path):
    bad = FakeClient(brand_exc=ContextDevError("/brand/retrieve: HTTP 400: invalid body", status=400))
    st = trust(tmp_path / "a", bad)
    st.lookup("tiny.site"), st.lookup("tiny.site")
    assert len(bad.calls) == 2  # a 400 for another reason is an outage, not "no brand"
    gone = FakeClient(brand_exc=ContextDevError('HTTP 400: {"code":"WEBSITE_NOT_FOUND"}', status=400))
    st = trust(tmp_path / "b", gone)
    st.lookup("tiny.site"), st.lookup("tiny.site")
    assert len(gone.calls) == 1


def test_no_key_does_not_burn_budget(tmp_path):
    def no_key():
        raise ContextDevError("CONTEXT_DEV_API_KEY is empty")
    st = SourceTrust(no_key, cache_dir=tmp_path, max_new_per_hour=1)
    assert not st.lookup("a.com").found and not st.lookup("b.com").found
    assert len(st._recent) == 0


def test_punycode_tld():
    assert normalize_domain("xn--80aswg.xn--p1ai") == "xn--80aswg.xn--p1ai"


def test_brand_without_name_is_not_cached(tmp_path):
    c = FakeClient(brand={"status": "ok", "brand": {"domain": "x.com"}})  # e.g. a partial answer after the timeout
    st = trust(tmp_path, c)
    assert not st.lookup("x.com").found and not st.lookup("x.com").found
    assert c.calls.count("/brand/retrieve") == 2 and not list(tmp_path.glob("*.json"))
