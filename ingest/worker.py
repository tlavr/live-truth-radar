"""Ingest/detect worker (P1). T4: stub that only logs a heartbeat; T6 adds polling and detect().

Run: python -m ingest.worker
"""

from __future__ import annotations

import logging
import os
import signal
import threading

log = logging.getLogger("ltr.worker")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    interval = int(os.environ.get("POLL_INTERVAL_SEC") or 180)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    log.info("worker stub started, interval=%ss", interval)
    while not stop.is_set():
        log.info("heartbeat (stub: no ingest yet)")
        stop.wait(interval)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
