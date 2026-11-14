"""T11: explanation prompt, quote check, provider fallback and cache (offline: providers are fakes)."""

import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter

import ingest.explain as ex
from contracts.models import Finding, Item

FIX = Path(__file__).resolve().parent.parent / "fixtures"


@pytest.fixture
def case(tmp_path, monkeypatch):
    monkeypatch.setattr(ex, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(ex, "_failed_at", {})
    items = TypeAdapter(list[Item]).validate_json((FIX / "items.json").read_text())
    f = next(f for f in TypeAdapter(list[Finding]).validate_json((FIX / "findings.json").read_text())
             if f.verdict == "coordinated")
    f = f.model_copy(update={"explanation": None})
    group = [it for it in items if it.id in set(f.item_ids)]
    return f, items, group


def _reply(quote, technique="fear appeal", confidence=0.8):
    return json.dumps({"technique": technique, "quote": quote, "confidence": confidence, "summary": "s"})


def test_prompt_hides_handles_and_quote_must_come_from_a_post(case):
    f, items, group = case
    prompt = ex.build_prompt(f, group)
    assert "account A" in prompt
    assert not any(it.author in prompt for it in group)
    text = group[0].text
    piece = text[5:40].strip()
    assert ex.fix_quote(piece, [text]) == piece
    garbled = "  “" + piece.upper().replace(" ", "   ") + "” "
    assert ex.fix_quote(garbled, [text]) == piece  # case, spaces, curly quotes repaired to the real text
    assert ex.fix_quote("the moon is made of cheese", [it.text for it in group]) is None


def test_gemini_failure_falls_back_to_router_and_result_is_cached(case, monkeypatch):
    f, items, group = case
    calls = []

    def gemini(prompt):
        calls.append("gemini")
        raise RuntimeError("quota")

    def router(prompt):
        calls.append("router")
        return "```json\n" + _reply(group[1].text[:30]) + "\n```"

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", gemini), ("ai-router", router)))
    exp = ex.explain(f, items)
    assert calls == ["gemini", "router"]
    assert exp.quote in group[1].text and 0 <= exp.confidence <= 1
    assert ex.explain(f, items) == exp and calls == ["gemini", "router"]  # cache hit: no provider call


def test_invented_quote_is_retried_then_rejected_and_explain_safe_never_raises(case, monkeypatch):
    f, items, group = case
    calls = []

    def liar(prompt):
        calls.append(prompt.endswith("from one post."))
        return _reply("words nobody posted")

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", liar), ("ai-router", liar)))
    assert ex.explain_safe(f, items) is None
    assert calls == [False, True, False, True]  # one retry per provider
    assert ex.explain_safe(f, items) is None and len(calls) == 4  # backoff: no new calls
    assert not list(ex.CACHE_DIR.glob("*.json"))


def test_fix_quote_keeps_positions_when_lowercasing_changes_length():
    # "İ".lower() is two chars: the normalized-to-original index map must not drift
    assert ex.fix_quote("IS LOST", ["İİİ is lost forever"]) == "is lost"
    assert ex.fix_quote("is  lost", ["İstanbul is lost"]) == "is lost"
    assert ex.fix_quote("i̇stanbul IS", ["İstanbul is lost"]) == "İstanbul is"
    # case repair maps back to the post's own (mixed) case and spacing
    assert ex.fix_quote("news: the mayor", ["Breaking NEWS:  the  Mayor   lied"]) == "NEWS:  the  Mayor"


def test_cached_quote_absent_from_current_posts_is_regenerated(case, monkeypatch):
    f, items, group = case
    ex._cache_path(f.id).write_text(json.dumps(
        {"technique": "fear appeal", "quote": "words nobody posted", "confidence": 0.5, "summary": "old"}))
    calls = []

    def gemini(prompt):
        calls.append("gemini")
        return _reply(group[0].text[:30])

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", gemini),))
    exp = ex.explain(f, items)
    assert calls == ["gemini"] and exp.quote in group[0].text
    assert ex.explain(f, items) == exp and calls == ["gemini"]  # the regenerated result was cached


def test_cached_quote_is_repaired_to_current_post_text(case, monkeypatch):
    f, items, group = case
    piece = group[0].text[:30].strip()
    ex._cache_path(f.id).write_text(json.dumps(
        {"technique": "fear appeal", "quote": piece.upper(), "confidence": 0.5, "summary": "old"}))
    monkeypatch.setattr(ex, "PROVIDERS", ())
    assert ex.explain(f, items).quote == piece


def test_unreadable_cache_or_failed_cache_write_still_returns_an_explanation(case, monkeypatch):
    f, items, group = case
    ex._cache_path(f.id).write_bytes(b"\xff\xfe not utf-8")
    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", lambda p: _reply(group[0].text[:30])),))
    assert ex.explain(f, items).quote in group[0].text  # undecodable cache -> regenerated

    def broken(*a, **k):
        raise OSError("disk full")

    ex._cache_path(f.id).unlink()
    monkeypatch.setattr(ex.Path, "write_text", broken)
    assert ex.explain(f, items).quote in group[0].text  # write failure does not lose the result


@pytest.fixture
def post_with_known_handle(case):
    f, _, group = case
    handle = "example_handle_for_test"
    post = group[0].model_copy(update={
        "source": "context_social",
        "synthetic": False,
        "author": handle,
        "text": f"Urgent warning from @{handle.upper()}: https://social.example/{handle}/post/1",
    })
    return f.model_copy(update={"item_ids": [post.id], "accounts": [handle]}), post, handle


@pytest.mark.parametrize("field", ["quote", "technique", "summary"])
def test_fresh_and_cached_explanations_cannot_expose_a_known_handle(
    post_with_known_handle, monkeypatch, field
):
    f, post, handle = post_with_known_handle
    safe_quote = "Urgent warning"
    valid = _reply(safe_quote)
    unsafe = json.loads(valid)
    unsafe[field] = f"@{handle.upper()}" if field == "quote" else f"https://social.example/{handle}"
    ex._cache_path(f.id).write_text(json.dumps(unsafe))
    calls = []

    def provider(prompt):
        calls.append(prompt)
        return json.dumps(unsafe) if len(calls) == 1 else valid

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", provider),))
    result = ex.explain(f, [post])

    assert len(calls) == 2  # reject the cached value and the first provider reply
    assert all(handle not in prompt.casefold() for prompt in calls)
    assert result.quote == safe_quote and result.quote in post.text
    assert handle not in result.model_dump_json().casefold()


def test_prompt_redacts_a_short_handle_without_changing_longer_words(post_with_known_handle):
    f, post, _ = post_with_known_handle
    post = post.model_copy(update={"author": "am", "text": "The campaign cites @AM."})
    f = f.model_copy(update={"accounts": ["am"]})
    prompt = ex.build_prompt(f, [post])
    assert "@AM" not in prompt
    assert "The campaign cites" in prompt


def test_cache_write_and_cleanup_errors_keep_the_valid_reply(case, monkeypatch):
    f, items, group = case
    quote = group[0].text[:30]
    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", lambda _: _reply(quote)),))

    def read_only(*args, **kwargs):
        raise PermissionError("read-only cache")

    monkeypatch.setattr(ex.Path, "write_text", read_only)
    monkeypatch.setattr(ex.Path, "unlink", read_only)
    assert ex.explain_safe(f, items).quote == quote


def test_explain_rejects_items_from_another_finding(case, monkeypatch):
    f, _, group = case
    unrelated = group[0].model_copy(update={"id": "outside-finding", "text": "Unrelated post"})

    def provider(_):
        pytest.fail("unrelated posts must not be sent to providers")

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", provider),))
    with pytest.raises(ValueError, match="no post texts"):
        ex.explain(f, [unrelated])


@pytest.mark.parametrize("field", ["technique", "summary"])
def test_blank_explanation_fields_are_rejected_in_cache_and_provider_response(case, monkeypatch, field):
    f, items, group = case
    valid = _reply(group[0].text[:30].strip())
    invalid = json.loads(valid)
    invalid[field] = "   "
    ex._cache_path(f.id).write_text(json.dumps(invalid))
    replies = iter((json.dumps(invalid), valid))
    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", lambda _: next(replies)),))

    assert getattr(ex.explain(f, items), field) == json.loads(valid)[field]


@pytest.mark.parametrize("technique", ["fear appeal", "fear appeal + call to action"])
def test_known_handle_can_overlap_a_canonical_technique(post_with_known_handle, monkeypatch, technique):
    f, post, _ = post_with_known_handle
    post = post.model_copy(update={"author": "fear", "text": "Urgent warning from @fear."})
    f = f.model_copy(update={"accounts": [post.author]})
    calls = []

    def provider(prompt):
        calls.append(prompt)
        return _reply("Urgent warning", technique=technique)

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", provider),))
    assert ex.explain(f, [post]).technique == technique
    assert ex.explain(f, [post]).technique == technique
    assert len(calls) == 1


def test_inaccessible_cache_path_does_not_stop_provider_calls(case, monkeypatch):
    f, items, group = case
    quote = group[0].text[:30].strip()
    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", lambda _: _reply(quote)),))

    def inaccessible(*args, **kwargs):
        raise PermissionError("cannot access cache")

    monkeypatch.setattr(ex.Path, "exists", inaccessible)
    monkeypatch.setattr(ex.Path, "read_text", inaccessible)
    assert ex.explain(f, items).quote == quote


@pytest.mark.parametrize("field", ["quote", "technique", "summary"])
def test_third_party_mentions_rejected_in_prompt_quote_or_reply(post_with_known_handle, monkeypatch, field):
    f, post, _ = post_with_known_handle
    mention = "@third_party_for_test"
    adjacent = "@reply_account_for_test"
    email = "desk@example.test"
    post = post.model_copy(update={"text": f"Contact {email} or {mention}; reply{adjacent}."})
    valid = _reply(f"Contact {email}")
    unsafe = json.loads(valid)
    unsafe[field] = mention
    ex._cache_path(f.id).write_text(json.dumps(unsafe))
    calls = []

    def provider(prompt):
        calls.append(prompt)
        return json.dumps(unsafe) if len(calls) == 1 else valid

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", provider),))
    result = ex.explain(f, [post])

    assert len(calls) == 2
    assert all(mention not in prompt and adjacent not in prompt and email in prompt for prompt in calls)
    assert result.quote in post.text
    assert mention not in result.model_dump_json()


@pytest.mark.parametrize("technique", ["FEAR APPEAL", "Fear Appeal + Call to Action"])
def test_words_overlapping_author_names_remain_valid_prose(post_with_known_handle, monkeypatch, technique):
    f, post, _ = post_with_known_handle
    quote = "The campaign feeds fear."
    summary = "The group appeals to fear."
    post = post.model_copy(update={"author": "fear", "text": f"{quote} Repost from @FEAR."})
    f = f.model_copy(update={"accounts": [post.author]})

    def provider(prompt):
        assert quote in prompt
        assert "@FEAR" not in prompt
        reply = json.loads(_reply(quote, technique=technique))
        reply["summary"] = summary
        return json.dumps(reply)

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", provider),))
    result = ex.explain(f, [post])
    assert (result.technique, result.quote, result.summary) == (technique, quote, summary)


@pytest.mark.parametrize("field", ["quote", "technique", "summary"])
def test_alphabetic_handles_remain_private_in_profile_urls(post_with_known_handle, monkeypatch, field):
    f, post, _ = post_with_known_handle
    url = "https://social.example/profiles/FEAR/post/1"
    quote = "A public warning"
    post = post.model_copy(update={"author": "fear", "text": f"{quote} from {url}"})
    f = f.model_copy(update={"accounts": [post.author]})
    invalid = json.loads(_reply(quote))
    invalid[field] = url
    replies = iter([json.dumps(invalid), _reply(quote)])

    def provider(prompt):
        assert url not in prompt
        return next(replies)

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", provider),))
    result = ex.explain(f, [post])
    assert result == ex.explain(f, [post])  # the rejected reply is never cached
    assert url not in result.model_dump_json()


def test_fix_quote_repairs_greek_final_sigma_and_preserves_original_text():
    assert ex.fix_quote("λόγος", ["The original says ΛΌΓΟΣ here"]) == "ΛΌΓΟΣ"
    assert ex.fix_quote("ΛΌΓΟΣ", ["The original says λόγος here"]) == "λόγος"


@pytest.mark.parametrize("url", [
    "https://social.example/profiles/%66ear",
    "https://social.example/?user=fear",
    "//social.example/?user=%66ear",
    "social.example/profiles/%66ear",
])
def test_profile_links_are_excluded_from_prompt_and_verbatim_quotes(post_with_known_handle, monkeypatch, url):
    f, post, _ = post_with_known_handle
    quote = "A public warning"
    post = post.model_copy(update={"author": "fear", "text": f"{quote} from {url}"})
    f = f.model_copy(update={"accounts": [post.author]})
    ex._cache_path(f.id).write_text(_reply(url))
    prompts = []

    def provider(prompt):
        prompts.append(prompt)
        return _reply(url if len(prompts) == 1 else quote)

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", provider),))
    assert ex.explain(f, [post]).quote == quote
    assert len(prompts) == 2
    assert all(url not in prompt and quote in prompt for prompt in prompts)


@pytest.mark.parametrize("error_type", [ValueError, RuntimeError])
def test_provider_error_details_are_never_logged_or_raised(case, monkeypatch, caplog, error_type):
    f, items, _ = case
    diagnostic = "raw SDK response @private_handle_for_test"
    calls = []

    def provider(_):
        calls.append(error_type)
        raise error_type(diagnostic)

    monkeypatch.setattr(ex, "PROVIDERS", (("gemini", provider), ("ai-router", provider)))
    with caplog.at_level("INFO", logger=ex.log.name):
        with pytest.raises(RuntimeError) as failure:
            ex.explain(f, items)
        assert ex.explain_safe(f, items) is None
    assert len(calls) >= 4
    assert diagnostic not in str(failure.value)
    assert diagnostic not in caplog.text
    assert f"gemini: {error_type.__name__}" in str(failure.value)
    assert f"ai-router: {error_type.__name__}" in str(failure.value)
