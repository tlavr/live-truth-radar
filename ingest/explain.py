"""Explanation of a coordinated finding (P1, T11): manipulation technique + verbatim quote + confidence.

Gemini (structured output, model GEMINI_LLM_MODEL) is the main provider; on any Gemini error the
same prompt goes to the Hostinger AI Router (OpenAI-compatible client, HOSTINGER_AI_ROUTER_*).
Results are cached on disk by finding.id (cache/explanations/, git-ignored, a volume on the VPS).

Authors get anonymous labels. Links, explicit @mentions and recognizable references to
known handles are redacted in the input and rejected in explanations. Quotes must be verbatim
substrings of unredacted post text; case, whitespace and quote marks can be repaired to match.
"""

from __future__ import annotations

import json
import logging
import os
import re
import string
import time
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from contracts.models import Explanation, Finding, Item

log = logging.getLogger("ltr.explain")

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "explanations"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
MAX_POSTS = 40
MAX_POST_CHARS = 400
FAILURE_BACKOFF_SEC = 600.0
TECHNIQUES = (
    "fear appeal", "call to action", "conspiracy / hidden truth", "loaded language", "bandwagon",
    "discrediting", "exaggeration", "whataboutism", "other",
)

PROMPT = """You analyse a group of social media posts that a statistical detector flagged as a
coordinated campaign on the topic "{topic}". Detector facts: {n_accounts} accounts, {n_posts} posts
within {span}; typical delay between accounts {lag}; coherent SNR {snr} dB; verdict: {verdict}.

Posts (oldest first; authors are anonymised):
{posts}

Answer in English with a JSON object:
- "technique": the main manipulation technique, one of: {techniques}. Two may be joined with " + ".
- "quote": a short phrase copied EXACTLY, character for character, from one of the posts above,
  that best shows the technique (at most 160 characters). Choose an excerpt without any redactions.
- "confidence": 0..1, how sure you are that these posts are a coordinated manipulation campaign
  (not ordinary people reacting to news).
- "summary": one or two plain sentences for a non-expert: what the accounts do and why it looks coordinated.
"""


class _Reply(BaseModel):
    """Schema for structured output (same fields as contracts.Explanation)."""

    technique: str
    quote: str
    confidence: float = Field(ge=0.0, le=1.0)
    summary: str


# ---------------------------------------------------------------- prompt


def _span(seconds: float) -> str:
    return f"{seconds / 60:.0f} minutes" if seconds >= 120 else f"{seconds:.0f} seconds"


# Treat a dotted domain after an adjacent @ as an email address.
_MENTION = (
    r"(?:"
    r"(?<!\w)@"
    r"|(?<=\w)@(?![\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?![\w-]))"
    r")[\w]+(?:[.-][\w]+)*"
)


# Links can encode profile identifiers anywhere in their path or query.
_URL = (
    r"""(?:https?://|(?<![\w@:/])//)[^\s<>"']+"""
    r"""|(?<![\w@.-])(?:[\w-]+\.)+[a-z]{2,}(?::[0-9]+)?[/\?#][^\s<>"']*"""
)


def _redaction_pattern(finding: Finding, items: list[Item]) -> re.Pattern[str]:
    synthetic = {it.author for it in items if it.synthetic}
    authors = (set(finding.accounts) - synthetic) | {it.author for it in items if not it.synthetic}
    handles = {author.strip().lstrip("@") for author in authors} - {""}
    patterns = [_URL, _MENTION]
    # A bare alphabetic word could be ordinary prose.
    recognizable = sorted((handle for handle in handles if not handle.isalpha()), key=lambda h: (-len(h), h))
    if recognizable:
        alternatives = "|".join(map(re.escape, recognizable))
        patterns.append(rf"(?<!\w)(?:{alternatives})(?!\w)")
    return re.compile("|".join(patterns), re.IGNORECASE)


def build_prompt(finding: Finding, items: list[Item]) -> str:
    handles = _redaction_pattern(finding, items)
    posts = sorted(items, key=lambda it: (it.published_at, it.id))[:MAX_POSTS]
    alias: dict[str, str] = {}
    lines = []
    for it in posts:
        if it.author not in alias:
            k = len(alias)
            alias[it.author] = "account " + (string.ascii_uppercase[k] if k < 26 else str(k + 1))
        text = handles.sub("[redacted]", it.text)
        text = " ".join(text.split())[:MAX_POST_CHARS]
        lines.append(f"- [{it.published_at:%H:%M:%S}] {alias[it.author]}: {text}")
    lags = [abs(v) for row in (finding.lag_sec or []) for v in row if v]
    lag = _span(sorted(lags)[len(lags) // 2]) if lags else "unknown"
    return PROMPT.format(
        topic=handles.sub("[redacted]", finding.topic),
        n_accounts=len(finding.accounts),
        n_posts=len(finding.item_ids),
        span=_span((finding.last_seen - finding.first_seen).total_seconds()),
        lag=lag,
        snr=finding.snr_db,
        verdict=finding.verdict,
        posts="\n".join(lines) or "(no post texts available)",
        techniques=", ".join(TECHNIQUES),
    )


# ---------------------------------------------------------------- quote check

_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "«": '"', "»": '"'})


def _norm(s: str) -> str:
    return " ".join(s.translate(_QUOTES).split()).casefold()


def fix_quote(quote: str, texts: list[str]) -> str | None:
    """The quote as it appears verbatim in one of the texts, or None if it is not there.

    Tolerates case, whitespace and typographic quote marks; strips surrounding quote marks.
    """
    q = quote.strip().strip("\"'“”‘’«»").strip()
    if not q:
        return None
    for t in texts:
        if q in t:
            return q
    target = _norm(q)
    for t in texts:
        # map positions of the normalized text back to the original text
        chars, index = [], []
        prev_space = True
        for i, ch in enumerate(t.translate(_QUOTES)):
            if ch.isspace():
                if not prev_space:
                    chars.append(" ")
                    index.append(i)
                prev_space = True
            else:
                folded = ch.casefold()
                chars.append(folded)
                index.extend([i] * len(folded))  # one entry per output char ("İ" folds to "i̇")
                prev_space = False
        norm = "".join(chars)
        pos = norm.find(target)
        if pos >= 0:
            return t[index[pos] : index[pos + len(target) - 1] + 1]
    return None


def _validate(raw: str, texts: list[str], handles: re.Pattern[str]) -> Explanation:
    """Validate provider and cache replies against the current posts."""
    try:
        reply = _Reply.model_validate_json(_strip_fences(raw))
    except ValidationError as exc:
        raise ValueError("reply does not match the schema") from exc
    technique, summary = reply.technique.strip(), reply.summary.strip()
    if not technique or not summary:
        raise ValueError("reply is missing a technique or summary")
    quote = fix_quote(reply.quote, texts)
    if quote is None:
        raise ValueError("quote is not a verbatim excerpt without redactions")
    labels = technique.casefold().split(" + ")
    canonical = len(labels) <= 2 and all(label in TECHNIQUES for label in labels)
    # A fixed label such as "fear appeal" may overlap a bare handle like "fear".
    if handles.search(quote) or handles.search(summary) or (not canonical and handles.search(technique)):
        raise ValueError("reply exposes a link or account handle")
    return Explanation(technique=technique, quote=quote, confidence=reply.confidence, summary=summary)


def _strip_fences(raw: str) -> str:
    m = re.search(r"\{.*\}", raw or "", re.S)
    return m.group(0) if m else (raw or "")


# ---------------------------------------------------------------- providers


def _gemini(prompt: str) -> str:
    from google import genai
    from google.genai import types

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    model = os.environ.get("GEMINI_LLM_MODEL") or DEFAULT_GEMINI_MODEL
    # keep the client in a `with`: a temporary client may close its session mid-request (see T9)
    # bounded request (HttpOptions.timeout is in ms): a hung call must not stall the worker loop
    with genai.Client(api_key=key, http_options=types.HttpOptions(timeout=30_000)) as client:
        resp = client.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json", response_schema=_Reply, temperature=0.2
            ),
        )
    if not resp.text:
        raise RuntimeError(f"{model} returned no text (blocked or empty response)")
    return resp.text


def _router(prompt: str) -> str:
    from openai import OpenAI

    key = os.environ.get("HOSTINGER_AI_ROUTER_KEY")
    base = os.environ.get("HOSTINGER_AI_ROUTER_BASE_URL")
    model = os.environ.get("HOSTINGER_AI_ROUTER_MODEL")
    if not (key and base and model):
        raise RuntimeError("HOSTINGER_AI_ROUTER_KEY / _BASE_URL / _MODEL are not all set")
    # no client-side retries: _ask already retries once, and the worker loop must not stall
    with OpenAI(api_key=key, base_url=base, timeout=30, max_retries=0) as client:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.2,
        )
    text = resp.choices[0].message.content if resp.choices else None
    if not text:
        raise RuntimeError(f"AI Router {model} returned no text")
    return text


PROVIDERS = (("gemini", _gemini), ("ai-router", _router))


def _ask(provider, prompt: str, texts: list[str], handles: re.Pattern[str]) -> Explanation:
    """One provider, one retry if the reply is unusable."""
    raw = provider(prompt)
    try:
        return _validate(raw, texts, handles)
    except ValueError:
        log.info("unusable reply; retrying once")
        retry = prompt + "\nOmit links and account handles. The quote MUST be copied exactly from one post."
        return _validate(provider(retry), texts, handles)


# ---------------------------------------------------------------- public


def _cache_path(finding_id: str) -> Path:
    return CACHE_DIR / f"{re.sub(r'[^A-Za-z0-9_-]', '_', finding_id)}.json"


def _prepare(finding: Finding, items: list[Item]) -> tuple[list[Item], list[str], re.Pattern[str]]:
    item_ids = set(finding.item_ids)
    group = [it for it in items if it.id in item_ids]
    if not group:
        raise ValueError(f"no post texts for finding {finding.id}")
    handles = _redaction_pattern(finding, group)
    # Do not accept an excerpt spanning or cutting through a redaction.
    texts = [excerpt for it in group for excerpt in handles.split(it.text)]
    return group, texts, handles


def _from_cache(finding: Finding, texts: list[str], handles: re.Pattern[str]) -> Explanation | None:
    path = _cache_path(finding.id)
    try:
        # Cached quotes must still be valid for the current posts of this finding.
        return _validate(path.read_text(encoding="utf-8"), texts, handles)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        log.warning("bad cached explanation %s; regenerating", path.name)
        return None


def cached_explanation(finding: Finding, items: list[Item]) -> Explanation | None:
    """T12d: the disk-cached explanation only (no LLM call, never raises); None if missing or no longer valid."""
    try:
        _, texts, handles = _prepare(finding, items)
    except ValueError:
        return None
    return _from_cache(finding, texts, handles)


def explain(finding: Finding, items: list[Item]) -> Explanation:
    """Explanation for the finding: disk cache, then Gemini, then AI Router. Raises if all fail."""
    group, texts, handles = _prepare(finding, items)
    path = _cache_path(finding.id)
    cached = _from_cache(finding, texts, handles)
    if cached is not None:
        return cached
    prompt = build_prompt(finding, group)
    errors = []
    for name, provider in PROVIDERS:
        try:
            exp = _ask(provider, prompt, texts, handles)
        except Exception as exc:  # provider down, quota, bad replies twice: try the next one
            # Provider error details can contain the SDK's raw response or request URL.
            error_type = type(exc).__name__
            errors.append(f"{name}: {error_type}")
            log.warning("explanation via %s failed (%s)", name, error_type)
            continue
        tmp = path.with_name(f"{path.stem}.{os.getpid()}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps({**exp.model_dump(), "provider": name}, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:  # a full/read-only disk must not discard a paid-for result
            log.warning("could not cache explanation %s: %s", finding.id, exc)
            try:
                tmp.unlink(missing_ok=True)
            except OSError as cleanup_error:
                log.warning("could not remove temporary explanation %s: %s", tmp.name, cleanup_error)
        log.info("explained %s via %s: %s (%.2f)", finding.id, name, exp.technique, exp.confidence)
        return exp
    raise RuntimeError("; ".join(errors))


_failed_at: dict[str, float] = {}


def explain_safe(finding: Finding, items: list[Item]) -> Explanation | None:
    """explain() for the worker: never raises; a failed finding is not retried for FAILURE_BACKOFF_SEC."""
    last = _failed_at.get(finding.id)
    if last is not None and time.monotonic() - last < FAILURE_BACKOFF_SEC:
        return None
    try:
        exp = explain(finding, items)
    except Exception as exc:  # keep the worker alive; the card shows no explanation for now
        _failed_at[finding.id] = time.monotonic()
        log.warning("no explanation for %s: %s", finding.id, exc)
        return None
    _failed_at.pop(finding.id, None)
    return exp
