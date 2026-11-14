"""Reworded swarm messages per topic: committed cache + Gemini generator.

`load_variations(topic)` reads synth/variations/<topic>.json (in git, offline).
The network is used only to BUILD that file:

    python -m synth.variations <topic-slug> "<what the topic is about>"

The detector never trains on these texts and has no template bank; held-out
messages are the ones used for eval and for the live inject.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import warnings
from pathlib import Path

from pydantic import BaseModel, Field

VARIATIONS_DIR = Path(__file__).resolve().parent / "variations"
DEFAULT_LLM_MODEL = "gemini-2.5-flash"
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

PROMPT = """You help test a detector of coordinated posting ("astroturfing") on social media.
Topic: {description}

Write {n_messages} different short talking points that a coordinated group of accounts might push
on this topic, and for each one {n_variations} reworded versions, as different people would post
them (1-2 sentences, under 240 characters, casual social-media style, same meaning, different wording).

Rules:
- Talking points are opinions, slogans or calls to action (share, boycott, sign, don't believe the hype).
- Do NOT state or imply unverified factual allegations about real, named people or organisations
  (no claims about crimes, private life, health, espionage and the like).
- No hate speech, no calls for violence, no real @handles, no URLs.

Return JSON only: {{"messages": [{{"claim": "<talking point>", "variations": ["...", "..."]}}]}}"""


class Message(BaseModel):
    claim: str
    held_out: bool = False  # reserved for eval and live inject
    variations: list[str] = Field(min_length=2)


class VariationSet(BaseModel):
    topic: str
    description: str = ""
    source: str  # who wrote the texts: a Gemini model name or "handwritten"
    messages: list[Message] = Field(min_length=1)


def check_slug(topic: str) -> str:
    """Topic slugs become file names and ids: keep them to [a-z0-9-]."""
    if not _SLUG.match(topic):
        raise ValueError(f"bad topic slug {topic!r}: use lowercase letters, digits and '-'")
    return topic


def available_topics() -> list[str]:
    return sorted(p.stem for p in VARIATIONS_DIR.glob("*.json"))


def load_variations(topic: str) -> VariationSet:
    path = VARIATIONS_DIR / f"{check_slug(topic)}.json"
    if not path.exists():
        raise ValueError(
            f"no variations for topic {topic!r} (available: {', '.join(available_topics()) or 'none'}); "
            f'build them with: python -m synth.variations {topic} "<description>"'
        )
    return VariationSet.model_validate_json(path.read_text(encoding="utf-8"))


def save_variations(vs: VariationSet) -> Path:
    path = VARIATIONS_DIR / f"{check_slug(vs.topic)}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(vs.model_dump(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return path


def generate(topic: str, description: str, *, n_messages: int = 5, n_variations: int = 30,
             n_held_out: int = 2) -> VariationSet:
    """Ask Gemini for talking points and their rewordings (network; needs GEMINI_API_KEY)."""
    from google import genai
    from google.genai import types

    check_slug(topic)
    if not 0 <= n_held_out < n_messages:
        raise ValueError(f"n_held_out must be in 0..{n_messages - 1} (got {n_held_out}): keep at least one message for tuning")
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set (see .env.example)")
    model = os.environ.get("GEMINI_LLM_MODEL") or DEFAULT_LLM_MODEL
    # Keep the client in a `with`: a temporary Client is garbage-collected (and its HTTP
    # session closed) while the request is still running.
    with genai.Client(api_key=api_key) as client:
        resp = client.models.generate_content(
            model=model,
            contents=PROMPT.format(description=description, n_messages=n_messages, n_variations=n_variations),
            config=types.GenerateContentConfig(response_mime_type="application/json", temperature=1.0),
        )
    if not resp.text:
        raise RuntimeError(f"{model} returned no text (blocked or empty response)")
    try:
        raw_messages = json.loads(resp.text)["messages"]
        if not isinstance(raw_messages, list) or not raw_messages:
            raise ValueError("'messages' is empty or not a list")
        # the last n_held_out messages are kept away from any tuning (count what the model
        # actually returned, not what we asked for)
        if len(raw_messages) <= n_held_out:
            raise ValueError(f"only {len(raw_messages)} messages, cannot hold out {n_held_out}")
        messages = []
        for k, raw in enumerate(raw_messages):
            texts = list(dict.fromkeys(t.strip() for t in raw["variations"] if t.strip()))
            if len(texts) < n_variations * 2 // 3:
                warnings.warn(f"message {k} has only {len(texts)} distinct variations (asked for {n_variations})",
                              stacklevel=2)
            messages.append(Message(claim=raw["claim"].strip(), variations=texts,
                                    held_out=k >= len(raw_messages) - n_held_out))
    except (ValueError, KeyError, TypeError, AttributeError) as e:  # JSONDecodeError and pydantic's ValidationError are ValueErrors
        raise RuntimeError(f"{model} returned an unusable reply: {type(e).__name__}: {e}") from e
    return VariationSet(topic=check_slug(topic), description=description, source=model, messages=messages)


def main() -> None:
    ap = argparse.ArgumentParser(description="Build synth/variations/<topic>.json with Gemini.")
    ap.add_argument("topic", help="topic slug, e.g. helsinki-tram-fares")
    ap.add_argument("description", help="one sentence: what the topic is about")
    ap.add_argument("--messages", type=int, default=5)
    ap.add_argument("--variations", type=int, default=30)
    ap.add_argument("--held-out", type=int, default=2)
    args = ap.parse_args()
    vs = generate(args.topic, args.description, n_messages=args.messages, n_variations=args.variations,
                  n_held_out=args.held_out)
    path = save_variations(vs)
    sizes = ", ".join(str(len(m.variations)) for m in vs.messages)
    print(f"wrote {path} ({len(vs.messages)} messages; variations: {sizes}). Read it before committing.")


if __name__ == "__main__":
    main()
