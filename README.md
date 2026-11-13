# Live Truth Radar

**The Kerfufflers · Junction 2026 (Espoo, 13–15.11.2026)**

> Bots whisper below the noise floor. Live Truth Radar is a spread-spectrum receiver for the web: it despreads coordinated campaigns, names propaganda techniques and reports honest false-alarm rates.

## Challenges
- **Main:** Decode the Noise (Hostinger)
- **Tech:** Best Use of Context.dev: Fully Structured Web (plus Oxylabs, Gemini, Codex candidates)

## The idea
Coordinated propaganda behaves like a spread-spectrum (CDMA) signal: each bot account is too weak to flag alone, but together they carry one "code". Live Truth Radar applies radar and signal-processing math to the live web:

- **Matched filters** find a narrative even when it is reworded (embeddings).
- **Cross-correlation** of account activity "despreads" hidden swarms.
- **CFAR** thresholding raises alerts at a controlled false-alarm rate.
- **SPRT** (sequential likelihood-ratio test) decides *coordinated / organic / keep watching*.
- Every verdict is explained in plain language with evidence and sources.

Receiver chain: `live web (Context.dev) → embeddings + activity time series → filters → detector → explained verdict`

## Repository layout
- `docs/` – planning notes, challenge analysis, signal-processing design, submission draft (mostly in Russian).
  - `docs/HANDOFF.md` – start here.
  - `docs/submission-draft.md` – Junction submission text.
  - `docs/signal-processing-for-noise.md`, `docs/noise-plus-realtime.md` – technical approach.

## Secrets
Never commit API keys, credit codes or `.env` files. Keep them in `.env` (git-ignored).

## License
MIT (the project goes open source at submission).
