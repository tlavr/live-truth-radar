"""Export the live sample for offline work (P1, T8): last N hours of real items -> JSON on stdout.

Authors are replaced by contracts.pseudonym(author, LTR_HASH_SALT): real handles never reach git.
Social post URLs contain the handle and are dropped; article URLs (news) are kept.
Synthetic (injected) items are left out.

On the VPS (writes fixtures/items_live_sample.json locally):
    ssh $VPS 'cd live-truth-radar && docker compose -f infra/docker-compose.yml exec -T api \
        python -m ingest.export_sample --hours 6' > fixtures/items_live_sample.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from contracts.models import Item, pseudonym


def pseudonymize(items: list[Item], salt: str) -> list[Item]:
    if not salt:
        raise ValueError("LTR_HASH_SALT is empty: refusing to export without pseudonyms")
    out = []
    for it in items:
        if it.synthetic:
            continue
        url = None if it.source == "context_social" else it.url
        out.append(it.model_copy(update={"author": pseudonym(it.author, salt), "url": url}))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Last N hours of real items, pseudonymized, as JSON on stdout.")
    ap.add_argument("--hours", type=float, default=6.0)
    args = ap.parse_args(argv)
    from ingest import store  # DB only for the CLI: pseudonymize() stays importable offline

    with store.connect() as conn:
        items = store.recent_items(conn, args.hours)
    sample = pseudonymize(items, os.environ.get("LTR_HASH_SALT") or "")
    json.dump([it.model_dump(mode="json") for it in sample], sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")
    print(f"exported {len(sample)} items from the last {args.hours:g} h", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
