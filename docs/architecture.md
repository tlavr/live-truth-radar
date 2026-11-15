# Live Swarm Radar Architecture

*Scope trimmed for the hackathon: we build the core deeply rather than everything shallowly. The two roles are P1 "Pipe" and P2 "Brain." See [HANDOFF.md](HANDOFF.md#5-task-plan) for the plan, deadlines, and checkpoints and [tasks.md](tasks.md) for the task cards.*

## How it works (for a kid)
Imagine an **on-duty detective** sitting on Hostinger who **looks at the internet every few minutes** through Context.dev binoculars.
1. Collects new articles and posts across several topics.
2. Notices that **17 accounts wrote almost the same thing in 10 minutes** → "swarm!".
3. Reads the texts and says: "Here is **fear appeal**: 'if you don't do X, tomorrow will be a catastrophe,' with no facts."
4. Honestly states **how confident** it is and shows how often it makes mistakes (metrics).

## Scope: MUST / SHOULD / CUT
| Tier | What | When |
|---|---|---|
| **MUST** | Ingest (Context.dev news search + social scrape, polling every 2–5 min, 3–5 topics), Swarm Detector (embeddings → topic beam (beamforming) → whitening → "time × meaning" pair correlator → CFAR → SPRT, SNR in dB; design: [signal-processing.md §3](signal-processing.md)), Gemini verdict explanation (technique + quote + confidence), Eval (synthetic swarm injection + ~50 labeled live accounts), single-page dashboard + `/metrics` (with T12d — live scan on Check) + injection only via Bot Hive `/redteam` (no button in the product), deploy to Hostinger | By Sat 19:00–20:30 (T0–T14, I1) |
| **SHOULD** | Only **S1** — Source Trust via Context.dev brand/company (P1) | Only if all MUST except T14 is ready by Sat 20:00. Deadline Sun 01:00. Separate `GET /api/source/{domain}` |
| **CUT** | Oxylabs (completely, including geo-`/search`); SemEval; Context.dev full-text scrape, monitors/webhooks (replaced by polling), research, structured extraction; Fact-check, Change Watch; Gemma, Nemotron, Modal / Verda, Aiven, CRACI; spectrograms, delay-Doppler map (delay from first post × growth rate — not to be confused with the "delay × semantic detuning" ambiguity surface, which is MUST), MMSE fusion; TwiBot/Cresci bot datasets | Only for the "What's Next" slide |

*This is the canonical tier list: the other files reference it.*

## Diagram (MUST)
```
          ┌──────────────────── Hostinger VPS (Docker Compose, public HTTPS domain) ─────────────────────┐
 WEB      │                                                                                              │
 news ─── ┼─► worker: poll Context.dev and Bluesky every N min ──► db: Postgres                          │
 social   │   (news search) + Bluesky searchPosts               (items, actors, inject_req.,             │
          │                                                       findings, labels)                      │
          │   worker: Gemini embeddings → whitening → account correlation                                │
          │           → CFAR → SPRT → verdict → Gemini explanation (technique + quote)                   │
          │                                                                                              │
          │   api: FastAPI (REST + serves dashboard) ──► dashboard: alerts, cards, metrics               │
          │   eval: synthetic swarm in live stream → ROC, precision, FPR, time to decision               │
          └──────────────────────────────────────────────────────────────────────────────────────────────┘
             LLM: Gemini (primary) · Hostinger AI Router (fallback, `openai` client, model from `HOSTINGER_AI_ROUTER_MODEL`)
```

## Modules
| # | Module | Tier | Who | Folder | What It Does | Tools |
|---|---|---|---|---|---|---|
| 0 | **Live Ingest** | MUST | P1 | `ingest/` | Pulls fresh articles and posts across 3–5 topics every 2–5 min, saves text, author, timestamp, and URL as `Item` (T6b: each source has its own client and its own `since`. `BLUESKY_ENABLED=0` disables Bluesky) | Context.dev news search + Bluesky `searchPosts` (no login required. Reddit via Context.dev is behind a flag, off by default) |
| 1 | **Swarm Detector** | MUST | P2 | `detect/` | Embeddings + topic beam (beamforming) + whitening (topic clutter rejection) → lagged "time × meaning" account-pair correlator → pairwise CFAR → swarm ≥ 3, coherent integration, SNR in dB → SPRT (decision) + "news echo" check → `Finding` | Gemini embeddings + numpy/scipy (possibly Codex) |
| 2 | **Explain / Technique** | MUST | P1 | `ingest/explain.py` (in worker) | For `Finding`: manipulation technique + evidence quote + confidence + plain-language explanation → `Explanation` | Gemini structured output, AI Router fallback |
| S | **Synthetic Swarm** | MUST | P2 | `synth/` | ~30 variations across several messages (some held out for eval), fake accounts with lags, `synthetic = true`, `campaign_id` | Gemini |
| E | **Eval Harness** | MUST | P2 | `eval/` | ROC (Pd vs Pfa), detection rate, posts/seconds to decision → `MetricsReport`, live FPR / precision from labels | numpy |
| UI | **Radar Dashboard** | MUST | P1 | `web/` | Main screen: topic (beam) selector, alert feed, card with traffic light, phrase, and ambiguity surface, posts, technique. "Details" tab: correlation heatmap, SNR, SPRT trace. `/metrics`, live scan on Check (injection is Bot Hive `/redteam` only) | Static HTML + JS + Chart.js, served by FastAPI |
| Ops | **Deploy** | MUST | P1 | `infra/` | Docker Compose, caddy HTTPS, Hostinger VPS, `tests/smoke.py` | Hostinger |
| 3 | **Source Trust** | SHOULD (S1) | P1 | `ingest/` | Who is behind the domain: company, age, someone else's logo | Context.dev brand + company |
| — | Geo Echo (Oxylabs), Fact-check, Change Watch | CUT | — | — | — | — |

## Repo and Contract
```
CLAUDE.md                           Shared agent instructions
contracts/models.py                 SHARED. Changes require both owners.
fixtures/items.json                 Test data generated by `make fixtures`. Never edit by hand.
fixtures/items_live_sample.json     Live DB sample (T2, refreshed at sync points). Authors are pseudonymized.
fixtures/items_live_background.json 48 h of live background for eval (T15). Authors are pseudonymized and emails masked.
fixtures/findings.json              Sample findings served by the P1 mock detector until I1.
ingest/  api/  web/  infra/          P1
detect/  synth/  eval/               P2
tests/                              test_contracts.py (shared), test_detect_*.py (P2), smoke.py (P1)
docs/                               Plan and workflow
Makefile                            `make test` (pytest, offline, <5 s), `make smoke URL=...`
```
Layers are connected by a **single contract** — pydantic v2 in [`contracts/models.py`](../contracts/models.py) (source of truth; summarized here only):
- `Item` — post/article: `source` (`context_social` / `context_news` / `synthetic`), `author`, `published_at` (UTC), `text`, `url`, `topic`, `synthetic`, `campaign_id` (ground truth for synthetic data only).
- `Finding` — verdict (`coordinated` / `organic` / `watching`), `accounts`, `item_ids`, `llr`, `sprt_trace`, `sprt_upper` / `sprt_lower` (chart thresholds), `decided_at_item`, `first_seen` / `last_seen`, `correlation` and `lag_sec` (square matrices in `accounts` order, for the heatmap), `id` = `finding_id(topic, accounts)` (stable), `snr_db` (entire swarm after integration) and `snr_db_single` (average pair before integration: "x → y dB"), `explanation: Explanation | None` (`technique`, `quote`, `confidence`, `summary`), `synthetic`, optional `ambiguity` ("delay × semantic detuning" grid for the main screen) and `note` (e.g., "news echo").
- `AlertsResponse` (+ `last_poll_at`: "updated N min ago"), `MetricsReport` (ROC, detection rate, operating Pfa, posts/seconds to decision, live FPR / precision, `n_labelled`, `failure_examples`; optional `pd_by_size`, `swarm_purity`, `live_precision_ci`).
- Detector input (P2): `detect.pipeline.detect(items, *, alpha=0.02, beta=0.1) -> list[Finding]`.
- API (P1): `GET /health`, `GET /api/alerts` → `AlertsResponse`, `GET /api/metrics` → `MetricsReport`, `GET /api/items?ids=…` → `list[Item]` (card text), `POST /api/inject` (API without a button in the product. The worker runs the detector via `inject_requests`).

Out-of-contract interfaces (generator for `/api/inject`, `eval/report.json`, `eval/labels.csv`, `/api/source/{domain}`, worker location): [HANDOFF.md §5](HANDOFF.md#5-task-plan).

P2 works offline on `fixtures/` (no network or DB), while P1 works with a mock detector until **I1 (Sat 15:00)** integration. Details: [workflow.md](workflow.md).

## VPS Stack (Docker Compose)
| Service | What's inside |
|---|---|
| `caddy` | Reverse proxy + automatic HTTPS for the Hostinger domain |
| `api` | Python, FastAPI: REST for the dashboard, serves the static dashboard |
| `worker` | Python (`ingest/worker.py`): Context.dev polling, `detect()` (numpy/scipy), Gemini explanations. P2 runs eval separately (`python -m eval.run` → `eval/report.json`) |
| `db` | Postgres |

Buildless frontend (HTML + JS + Chart.js) so we don't waste time on a toolchain. This is the default choice: if someone on the team can build React quickly, we can swap it out without touching the rest.

## Storage
Embeddings are cached on disk (`cache/`, volume, excluded from git). Vector search in the DB isn't needed, so we skip pgvector.
Tables: `actors` (account/author), `items` (post/article: text, author, time, URL, source, `synthetic` flag), `findings` (verdict, LLR, SNR, explanation), `labels` (manual labeling).
We cache Context.dev responses locally (a repeat request costs the same credits). The DB schema is P1 (T4), but the `items` / `findings` fields mirror the contract.

## Data for metrics (40% of the score!)
| Tier | Dataset | Purpose |
|---|---|---|
| MUST | **Synthetic swarm:** An LLM writes ~30 variations for several messages (a subset is held out for eval, and the detector is not trained on synthetic data), which we distribute across fake accounts with lags and hide among real posts (`synthetic = true`) | ROC and time-to-decision for the Swarm Detector |
| MUST | **Manual labeling of ~50 live accounts (T14, both):** 15 min rubric, unit is an account, classes "organic / suspicious / unclear"; **~25 from alerts** (→ live precision) + **~25 random non-alert accounts** from the same topics (→ live FPR) | Precision and FPR on real people, separate from synthetic data |
| CUT | SemEval-2020 Task 11 (techniques corpus) | With just the two of us, we won't have time. We show techniques via an explanation with a quote, without a separate metric |
| CUT | TwiBot-20/22, Cresci-2017 | Access by request, won't have time |

## 2-minute demo script
1. Open `https://<Hostinger-domain>`: a feed of live alerts across 3–5 topics (updated via polling).
2. Select a topic and click Check → live scanning runs ("Live · …" line, calm background). In the adjacent Bot Hive tab (`/redteam`), click Attack → bot posts appear there one by one, while on the topic screen a swarm assembles in ~30 s and an alert appears: "🐝 Swarm: [N] accounts, SNR from [x] dB (single pair) to [y] dB (entire swarm)" (the numbers are real, from the demo). Bot Hive shows the labels "Detected" and "Caught N / M".
3. Card: traffic light and phrase, ambiguity surface (sharp peak in the corner of the "delay × semantic detuning" map), posts, technique "🎭 Fear appeal" with a quote. On the "Details" tab, an account correlation heatmap and SPRT trace ("decision at post [k]").
4. (SHOULD S1) "🔗 Source: …" — who is behind the domain, from Context.dev brand/company.
5. `/metrics` page: ROC, operating point, Pd vs. swarm size, swarm purity, live precision with an interval and FPR, error examples.

## Key Risks
| Risk | What we do |
|---|---|
| Context.dev social scrape does not return author or time | Confirmed in T2 (reddit-search fails with WEBSITE_ACCESS_ERROR). Decision T6b: social network = Bluesky `searchPosts` (author = handle, time = `createdAt`/`indexedAt`). Without login, `cursor` gives 403, paginated via `until`. Fallback: `BLUESKY_ENABLED=0` → news only + synthetic swarm, authors = domains |
| Few real swarms over the weekend | Test target injection: this is both a metric and a demo |
| Gemini limits | Hostinger AI Router as a fallback LLM, and we cache embeddings |
| Deployment breaks at the last minute | Skeleton deploy by Sat 03:00 (T5), smoke test after every deploy, code feature freeze (F) on Sun 02:00 |
| Detector is not ready for integration | Checkpoint T10 Sat 14:00: P1 runs on a mock, if behind schedule we skip S1, and P1 helps P2 |

Why each tool is used and prize requirements: [tech-challenges.md](tech-challenges.md).
