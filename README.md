# Live Truth Radar

**The Kerfufflers · Junction 2026 (Espoo, 13–15.11.2026)**

> Bots whisper below the noise floor. Live Truth Radar is a spread-spectrum receiver for the web: it despreads coordinated campaigns, names propaganda techniques and reports honest false-alarm rates.

## Challenges
- **Main:** Decode the Noise (Hostinger)
- **Tech:** Context.dev (core: live news search + social scrape), Gemini (embeddings, explanations, synthetic test campaigns); OpenAI Codex not used for now (code is written with Claude); maybe later, only if we genuinely build with it

## The idea
Coordinated propaganda behaves like a spread-spectrum (CDMA) signal: each bot account is too weak to flag alone, but together they carry one "code". Live Truth Radar applies radar and signal-processing math to the live web:

- **Matched filters** find a narrative even when it is reworded (embeddings).
- **Cross-correlation** of account activity "despreads" hidden swarms.
- **CFAR** thresholding raises alerts at a controlled false-alarm rate.
- **SPRT** (sequential likelihood-ratio test) decides *coordinated / organic / keep watching*.
- Every verdict is explained in plain language with evidence and sources.

Receiver chain: `live web (Context.dev) → embeddings + activity time series → filters → detector → explained verdict`

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
