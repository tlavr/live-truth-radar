"""Text embeddings: Gemini with an on-disk cache, or an offline hashing embedder.

Backend is chosen by LTR_EMBEDDER: "gemini" (default) or "hash" (tests, offline).
If Gemini is unavailable (no key, API error) the WHOLE call falls back to the
hashing embedder with a warning: vectors of the two backends are never mixed
inside one result.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

HASH_DIM = 1024
DEFAULT_GEMINI_MODEL = "gemini-embedding-001"
GEMINI_BATCH = 100
CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "embeddings"

_TOKEN = re.compile(r"[^\W_]+")
# In-process memo over the disk cache: eval calls detect() thousands of times on the same texts.
_MEMO: dict[tuple[str, str], np.ndarray] = {}


def _normalize(E: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(E, axis=1, keepdims=True)
    return np.divide(E, norms, out=np.zeros_like(E), where=norms > 0)


def _hash_features(text: str) -> list[str]:
    """Words plus character 3/4-grams inside word boundaries (robust to small rewordings)."""
    feats: list[str] = []
    for tok in _TOKEN.findall(text.lower()):
        feats.append("w:" + tok)
        padded = f"<{tok}>"
        for n in (3, 4):
            feats.extend("c:" + padded[i : i + n] for i in range(len(padded) - n + 1))
    return feats


def hash_embed(texts: list[str], dim: int = HASH_DIM) -> np.ndarray:
    """Deterministic signed feature hashing; rows are unit vectors (zero for empty text)."""
    E = np.zeros((len(texts), dim), dtype=np.float64)
    for row, text in enumerate(texts):
        for feat in _hash_features(text):
            h = int.from_bytes(hashlib.blake2b(feat.encode("utf-8"), digest_size=8).digest(), "little")
            E[row, h % dim] += 1.0 if h >> 63 else -1.0
    return _normalize(E)


def _cache_path(model: str, text: str) -> Path:
    safe_model = re.sub(r"[^A-Za-z0-9._-]", "_", model)
    return CACHE_DIR / safe_model / (hashlib.sha1(text.encode("utf-8")).hexdigest() + ".npy")


GEMINI_TIMEOUT_MS = 20_000


def _gemini_call(texts: list[str], model: str, api_key: str) -> list[list[float]]:
    """One network round per batch; the only place that talks to Gemini."""
    from google import genai
    from google.genai import types

    # explicit timeout (ms): a hung request must not freeze the worker's radar frames (T12d)
    client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS))
    out: list[list[float]] = []
    for start in range(0, len(texts), GEMINI_BATCH):
        resp = client.models.embed_content(
            model=model,
            contents=texts[start : start + GEMINI_BATCH],
            config=types.EmbedContentConfig(task_type="SEMANTIC_SIMILARITY"),
        )
        out.extend(e.values for e in resp.embeddings)
    return out


def gemini_embed(texts: list[str]) -> np.ndarray:
    """Gemini embeddings, unit rows; only texts missing from the disk cache hit the network."""
    model = os.environ.get("GEMINI_EMBED_MODEL") or DEFAULT_GEMINI_MODEL
    vectors: dict[str, np.ndarray] = {}
    missing: list[str] = []
    for text in dict.fromkeys(texts):
        path = _cache_path(model, text)
        if (model, text) in _MEMO:
            vectors[text] = _MEMO[(model, text)]
        elif path.exists():
            vectors[text] = _MEMO[(model, text)] = np.load(path)
        else:
            missing.append(text)

    if missing:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        fresh = _gemini_call(missing, model, api_key)
        if len(fresh) != len(missing):
            raise RuntimeError(f"Gemini returned {len(fresh)} embeddings for {len(missing)} texts")
        for text, values in zip(missing, fresh):
            vec = np.asarray(values, dtype=np.float64)
            path = _cache_path(model, text)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.stem}.{os.getpid()}.tmp.npy")
            np.save(tmp, vec)
            os.replace(tmp, path)  # atomic: a concurrent reader never sees a partial file
            vectors[text] = _MEMO[(model, text)] = vec

    return _normalize(np.stack([vectors[t] for t in texts]))


def embed_with_backend(texts: list[str]) -> tuple[np.ndarray, str]:
    """Like embed(), plus the backend that actually produced the vectors ("gemini" | "hash").

    Beam thresholds depend on the backend (detect.config.AnalyzerConfig.for_embedder), and a
    Gemini failure silently falls back to hashing, so callers that tune by backend use this.
    """
    texts = list(texts)
    backend = (os.environ.get("LTR_EMBEDDER") or "gemini").strip().lower()
    if backend not in ("gemini", "hash"):
        raise ValueError(f"unknown LTR_EMBEDDER={backend!r} (expected 'gemini' or 'hash')")
    if not texts:
        return np.zeros((0, HASH_DIM), dtype=np.float64), backend
    if backend == "hash":
        return hash_embed(texts), "hash"
    try:
        return gemini_embed(texts), "gemini"
    except Exception as exc:  # keep the live demo running: degrade, do not crash
        log.warning("Gemini embeddings unavailable (%s: %s); using the hashing embedder", type(exc).__name__, exc)
        return hash_embed(texts), "hash"


def embed(texts: list[str]) -> np.ndarray:
    """Embed texts -> array (n, d) with unit rows. Backend: LTR_EMBEDDER ("gemini" | "hash")."""
    return embed_with_backend(texts)[0]
