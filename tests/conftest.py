"""Keep `make test` offline: no API keys, hashing embedder instead of Gemini."""

import os

for _key in ("GEMINI_API_KEY", "CONTEXT_DEV_API_KEY", "HOSTINGER_AI_ROUTER_KEY", "DATABASE_URL"):
    os.environ.pop(_key, None)
os.environ["LTR_EMBEDDER"] = "hash"  # detect.embed must honour this (T7)
os.environ["LTR_OFFLINE"] = "1"
