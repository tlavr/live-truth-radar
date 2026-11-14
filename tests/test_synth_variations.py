"""T9: variations generator and committed variation sets. Offline: Gemini is faked."""

import json
import re
import warnings
from datetime import datetime, timezone

import pytest

import synth.variations as sv
from synth.campaign import make_campaign

pytestmark = pytest.mark.filterwarnings("ignore:message .* distinct variations")  # fake replies are tiny


class FakeClient:
    """Stands in for google.genai.Client; fails if used after it was closed."""

    instances: list["FakeClient"] = []
    reply = ""

    def __init__(self, api_key=None):
        self.closed = False
        self.models = self
        FakeClient.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True

    def generate_content(self, **kwargs):
        assert not self.closed, "client used after it was closed"
        return type("Resp", (), {"text": FakeClient.reply})()


@pytest.fixture
def fake_gemini(monkeypatch):
    from google import genai

    FakeClient.instances = []
    FakeClient.reply = ""
    monkeypatch.setattr(genai, "Client", FakeClient)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    return FakeClient


def _reply(n_messages: int) -> str:
    return json.dumps({"messages": [
        {"claim": f"claim {k}", "variations": [f"text {k}-a", f"text {k}-b", f"text {k}-a"]}
        for k in range(n_messages)
    ]})


def test_generate_uses_open_client_and_marks_last_messages_held_out(fake_gemini):
    fake_gemini.reply = _reply(5)
    vs = sv.generate("some-topic", "desc")
    assert fake_gemini.instances[0].closed  # closed only after the request finished
    assert [m.held_out for m in vs.messages] == [False, False, False, True, True]
    assert vs.messages[0].variations == ["text 0-a", "text 0-b"]  # duplicates dropped


def test_held_out_follows_actual_message_count(fake_gemini):
    fake_gemini.reply = _reply(3)  # fewer than the 5 requested
    vs = sv.generate("some-topic", "desc")
    assert [m.held_out for m in vs.messages] == [False, True, True]


def test_generate_fails_clearly_without_text(fake_gemini):
    with pytest.raises(RuntimeError, match="no text"):
        sv.generate("some-topic", "desc")


def test_generate_fails_clearly_without_key(fake_gemini, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY")
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        sv.generate("some-topic", "desc")


def _msgs(*entries) -> str:
    return json.dumps({"messages": list(entries)})


_OK = {"claim": "c", "variations": ["a", "b"]}
UNUSABLE = [
    "not json", "{}", '{"messages": []}', '{"messages": "x"}',
    _msgs(_OK, _OK, {"claim": "c"}),                         # KeyError: no variations
    _msgs(_OK, _OK, {"variations": ["a", "b"]}),             # KeyError: no claim
    _msgs(_OK, _OK, "just a string"),                        # TypeError: message is not an object
    _msgs(_OK, _OK, {"claim": "c", "variations": ["a", 1]}),  # AttributeError: non-string variation
    _msgs(_OK, _OK, {"claim": 5, "variations": ["a", "b"]}),  # AttributeError: non-string claim
    _msgs(_OK, _OK, {"claim": "c", "variations": "abcdef"}),  # string instead of a list
    _msgs(_OK, _OK, {"claim": "c", "variations": ["only one"]}),  # pydantic: < 2 variations
]


@pytest.mark.parametrize("reply", UNUSABLE)
def test_unusable_replies_raise_one_clear_error(fake_gemini, reply):
    fake_gemini.reply = reply
    with pytest.raises(RuntimeError, match="unusable reply"):
        sv.generate("some-topic", "desc")


def test_bad_arguments_fail_before_any_request(fake_gemini):
    with pytest.raises(ValueError, match="slug"):
        sv.generate("Bad Slug", "desc")
    with pytest.raises(ValueError, match="n_messages"):
        sv.generate("some-topic", "desc", n_messages=0, n_held_out=0)
    assert not fake_gemini.instances  # no client was even created


def test_cli_prints_a_clean_error(fake_gemini, monkeypatch):
    monkeypatch.setattr("sys.argv", ["synth.variations", "some-topic", "desc", "--messages", "2", "--held-out", "2"])
    with pytest.raises(SystemExit, match="error: .*n_held_out"):
        sv.main()


def test_full_sized_reply_does_not_warn(fake_gemini):
    fake_gemini.reply = json.dumps({"messages": [
        {"claim": f"c{k}", "variations": [f"text {k}-{j}" for j in range(30)]} for k in range(5)]})
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        assert len(sv.generate("some-topic", "desc").messages) == 5


def test_cannot_hold_out_every_message(fake_gemini):
    with pytest.raises(ValueError, match="n_held_out"):
        sv.generate("some-topic", "desc", n_messages=2, n_held_out=2)
    fake_gemini.reply = _reply(2)  # the model returned fewer messages than asked
    with pytest.raises(RuntimeError, match="cannot hold out"):
        sv.generate("some-topic", "desc", n_held_out=2)


def test_warns_when_model_returns_few_variations(fake_gemini):
    fake_gemini.reply = _reply(5)  # 2 distinct variations each, 30 requested
    with pytest.warns(UserWarning, match="distinct variations"):
        sv.generate("some-topic", "desc")


@pytest.mark.parametrize("topic", sv.available_topics())
def test_committed_variation_sets_are_clean(topic):
    vs = sv.load_variations(topic)
    assert vs.topic == topic
    for m in vs.messages:
        assert len({t.lower() for t in m.variations}) == len(m.variations) >= 2
        assert not [t for t in m.variations if re.search(r"@|https?://|www\.", t)]


def test_jensen_huang_swarm_builds_offline():
    now = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)
    vs = sv.load_variations("jensen-huang")
    assert [len(m.variations) for m in vs.messages] == [30] * 5
    assert [m.held_out for m in vs.messages] == [False, False, False, True, True]
    items = make_campaign("jensen-huang", now, seed=1)
    assert len(items) == 24 and len({i.author for i in items}) == 12
