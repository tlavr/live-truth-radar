# Live Swarm Radar

**The Kerfufflers · Junction 2026 (Espoo, 13–15.11.2026)**

> Bots whisper below the noise floor. Live Swarm Radar is a spread-spectrum receiver for the web: it despreads coordinated campaigns, names propaganda techniques and reports honest false-alarm rates.

## Challenges
- **Main:** Decode the Noise (Hostinger)
- **Tech:** Context.dev (core: live news search), Bluesky public search (live social posts), Gemini (embeddings, explanations, synthetic test campaigns); OpenAI Codex not used for now (code is written with Claude); maybe later, only if we genuinely build with it

## The idea
Coordinated propaganda behaves like a spread-spectrum (CDMA) signal: each bot account is too weak to flag alone, but together they carry one "code". Live Swarm Radar applies radar and signal-processing math to the live web:

- **Beamforming**: each watched topic is a beam; off-topic posts fall into the sidelobes.
- **Matched filtering in meaning space** finds a message even when it is reworded (embeddings, with the topic's common background whitened out).
- **Cross-correlation** of accounts in time × meaning "despreads" hidden swarms.
- **CFAR** thresholding raises alerts at a controlled false-alarm rate.
- **SPRT** (sequential likelihood-ratio test) decides *coordinated / organic / keep watching*.
- Every verdict is explained in plain language with evidence and sources.

Receiver chain: `live web (Context.dev news + Bluesky posts) + topic beam → embeddings, clutter whitening → pair correlator (time × meaning) → CFAR + SPRT → explained verdict`

## Context.dev endpoints & why
Context.dev is the receiver's antenna: every live news article on the radar comes from it, and it also answers "who is behind this outlet?" on the evidence screen.

| Endpoint | What we use it for | Where |
|---|---|---|
| **News search** `POST /v1/news/search` (`natural_language` query + `filterBy.date.from`) | The live news stream for ~50 watched topics. Every article becomes an `Item` whose account is the publisher domain. Articles go into the detector as ordinary posts. Articles also drive two rules that stop false alarms: a group that only repeats a fresh article becomes *news echo*, and a group made mostly of articles becomes a *reprint*. Neither can raise a "coordinated" alert. | `ingest/contextdev.py`, `ingest/worker.py` |
| **Brand** `POST /v1/brand/retrieve` (`by_domain`) | Source Trust: under each news article in the posts sheet the dashboard shows the outlet's name, logo, country and industry. | `ingest/source_trust.py`, `GET /api/source/{domain}` |
| **Company Search** `POST /v1/company/search` (`fast`) | Source Trust: founded year (shown as the outlet's age) and headquarters country, which is more reliable than the Brand address. | same |
| Web scrape `POST /v1/web/scrape` (prebuilt `reddit-search` parser) | Tried as the social source. Every URL returned `WEBSITE_ACCESS_ERROR`, so the code is kept but switched off (`REDDIT_ENABLED=0`). Live social posts come from Bluesky public search instead. | `ingest/contextdev.py` |

**Why these, and how we keep the credits:**
- *Account × time × meaning needs a timestamp and an author.* News search gave `published_at` for 100 of 100 probe articles. `authors` was often empty, so the publisher domain is the account.
- *Relevance, not recency.* Search fills the limit with unrelated fresh news. The worker keeps only articles whose **headline** passes the topic's keyword gate.
- *News is polled where people are looking:*
  - a topic someone has open on the dashboard (or one under a simulated attack): within ~10–20 s, then every 5 min;
  - a topic with a fresh real alert: right away, at most every 10 min (the article that explains the burst may only just have appeared);
  - every other topic: every 2 h, at most 8 topics per cycle.

  That comes to about 3,000 credits a day for the background (5 credits per search).
- *Source Trust is lazy and capped:*
  - Only outlets that already have articles in our database are looked up, so the public endpoint cannot spend credits on arbitrary domains.
  - It costs about 12 credits per new outlet (Brand 10 + Company Search 2), cached for 30 days, with at most 30 new outlets an hour.
- *Everything is cached and checked.* Raw responses are cached on disk (`cache/`, git-ignored). A 200 response with `success: false` is treated as an error.

## Repository layout
```
CLAUDE.md            instructions for AI agents (read first)
contracts/models.py  shared data contract (Item, Finding, AlertsResponse, MetricsReport)
fixtures/            shared test data
ingest/ api/ web/ infra/   P1 "Pipe": Context.dev ingest, FastAPI, dashboard, Docker/Hostinger deploy
detect/ synth/ eval/       P2 "Brain": swarm detector, synthetic campaigns, metrics
tests/               `make test` (offline, fast), `make smoke URL=...`
```

Docs (in Russian):
- `docs/HANDOFF.md` – start here: what we build, roles, deadlines, task plan.
- `docs/workflow.md` – how we work: agents, branches, per-task cycle, testing.
- `docs/tasks.md` – task cards (T0–T18, I1, S1, F).
- `docs/challenge-decode-the-noise.md` – main challenge (Hostinger): task, requirements, judging.
- `docs/tech-challenges.md` – Context.dev, Gemini, Codex: what counts, MUST/SHOULD/CUT.
- `docs/signal-processing.md` – the signal-processing approach.
- `docs/architecture.md` – scope (MUST/SHOULD/CUT), modules and owners, contract, stack, data, demo script.
- `docs/submission-draft.md` – Junction submission text.

## Secrets
Never commit API keys, credit codes or `.env` files. Keep them in `.env` (git-ignored).

## License
MIT (the project goes open source at submission).
