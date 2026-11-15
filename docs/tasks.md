# Task cards

*One card = one agent session. How to work with a card: [workflow.md](workflow.md#3-single-task-cycle). Data types: `contracts/models.py`. Time: Europe/Helsinki.*
*P2 before I1 runs offline on `fixtures/items.json` (with no network or DB in tests). P1 before I1 uses a mock detector (`fixtures/findings.json`).*
*The "⚙" marker = an interface outside `contracts/models.py` that is already decided (listed in [HANDOFF §5](HANDOFF.md#5-task-plan)). Change only together.*

| ID | Owner | Deadline | Summary |
|---|---|---|---|
| T0 | both | Fri 22:00 | Kickoff |
| T1 | both | Fri 22:30 | Keys in `.env` |
| T2 | P1 | Fri 23:15 | Context.dev probe |
| T3 | P2 | Fri 23:59 | Preliminary submission |
| T4 | P1 | Sat 01:00 | Compose skeleton + /health + DB schema |
| T5 | P1 | Sat 03:00 | Deploy to Hostinger + HTTPS |
| T6 | P1 | Sat 04:30 | Ingest polling → DB |
| T6b | P1 + P2 | Sun 01:00 | Bluesky as second source (social network on top of news) |
| T7 | P2 | Sat 09:00 | Embeddings + topic beam + whitening |
| T8 | P1 | Sat 11:00 | DB-backed API + mock detector |
| T9 | P2 | Sat 11:00 | Synthetic swarm generator |
| T10 | P2 | Sat 14:00 | Pair correlator → CFAR → swarm → SPRT → Finding (checkpoint) |
| I1 | both | Sat 15:00 | VPS integration |
| T11 | P1 | Sat 16:00 | Gemini explanation |
| T12 | P1 | Sat 19:00 | Dashboard + /metrics (injection — `/redteam`, T12d only) |
| T13 | P2 | Sat 19:00 | Eval → MetricsReport |
| T14 | both | Sat 20:30 | Labeling ~50 live accounts |
| S1 | P1 | Sun 01:00 | SHOULD: Source Trust |
| T15 | both | Sun 02:00 | Threshold tuning, stability |
| F | both | Sun 02:00 | Feature freeze |
| T16 | both | Sun 03:00 | 2 min video |
| T17 | P2 | Sun 08:00 | Slides, description, README |
| T18 | both | Sun 10:00 | Final submission |

---

### T0 · both · Fri 22:00
**Goal:** Agree within 45 minutes on everything that would be expensive to change later.
**Inputs and outputs:** `contracts/models.py`, `fixtures/*.json`, `CLAUDE.md` → decisions recorded in `docs/HANDOFF.md` (topics, confirmation of ⚙ interfaces).
**Done when:** the [workflow.md §2](workflow.md#2-t0--kickoff-45-min-by-fri-2200) checklist is complete, `make test` is green for both, and the teammate is on GitHub.
**Tests:** None (just run `make test`).
**Depends on:** —

### T1 · both · Fri 22:30
**Goal:** All keys and credentials in hand.
**Inputs and outputs:** Context.dev API key, Gemini (AI Studio, 18+ account), Hostinger VPS + domain, Hostinger AI Router → `.env` following the `.env.example` template (both have it, not committed to git).
**Done when:** each key has one successful manual request (curl/Python), SSH access to the VPS works, and the domain resolves to the VPS IP.
**Tests:** None.
**Depends on:** T0

### T2 · P1 · Fri 23:15
**Goal:** Find out whether Context.dev news search and social scrape provide **author and timestamp** (without them, account correlation is impossible).
**Inputs and outputs:** Probe script `ingest/probe_contextdev.py` → raw responses in `cache/` (git-ignored), 20–50 normalized `Item` with pseudonymized authors (`contracts.pseudonym`) in `fixtures/items_live_sample.json`. Record the result as a single line in HANDOFF §"Open Questions".
**Fallback:** If social posts lack author/timestamp → use news search (author = domain/article author, publication time) + synthetic accounts from T9. Document this **honestly** in HANDOFF, in the slides, and in the description.
**Done when:** the sample parses into `Item` (`tz-aware UTC`, `source` = `context_social`/`context_news`), and HANDOFF records which fields are actually present.
**Tests:** `test_contracts.py` already parses all `fixtures/items*.json`, so the new file will be picked up automatically.
**Depends on:** T1

### T3 · P2 · Fri 23:59
**Goal:** Submit the preliminary submission.
**Inputs and outputs:** Block from `docs/submission-draft.md` → Junction form.
**Done when:** the form is submitted, confirmation is received, and it is noted in HANDOFF.
**Tests:** None.
**Depends on:** T0

### T4 · P1 · Sat 01:00
**Goal:** A service skeleton that spins up with a single command.
**Inputs and outputs:** `infra/docker-compose.yml` (caddy, api, worker, db=Postgres), `infra/Caddyfile`, `infra/schema.sql` (tables `actors`, `items`, `findings`, `labels`, `inject_requests`; no pgvector), `api/main.py` with `GET /health` → `{"status":"ok"}`, `ingest/worker.py` stub.
**Done when:** `docker compose -f infra/docker-compose.yml up` runs locally → `curl localhost/health` = 200 (via caddy, port 80) and the schema is applied (tables are visible in `psql`, including `inject_requests`). Paths in compose are relative to `infra/`: build context `..`, mounts `../eval:/app/eval:ro` and `../cache:/app/cache`.
**Tests:** No new tests (DB schema is high-risk: the verification loop from workflow §3 is mandatory, both focus areas).
**Depends on:** T1

### T5 · P1 · Sat 03:00
**Goal:** A live public HTTPS URL on Hostinger (mandatory challenge requirement).
**Inputs and outputs:** VPS + domain, `.env` on the server (not in git), `tests/smoke.py`, `make smoke URL=...`. Deployment guide (5–10 lines) in `infra/README.md`. `make deploy VPS=...` works (ssh + `git pull` + `compose up -d --build`).
**Done when:** `https://<domain>/health` = 200 with a valid certificate, and `make smoke URL=https://<domain>` passes (`/api/alerts` can return an empty `AlertsResponse` for now).
**Tests:** `tests/smoke.py` (/health, /api/alerts schema).
**Depends on:** T4

### T6 · P1 · Sat 04:30
**Goal:** A live data stream into the DB.
**Inputs and outputs:** `ingest/contextdev.py` (news search + social scrape, response cache), `ingest/worker.py`: every 2–5 min for topics from `TOPICS` in `.env` (currently 6, see HANDOFF §6) → normalize into `Item` → upsert into `items`/`actors` (deduplicated by `id`) → stores `last_poll_at`. The detector (currently mock) is called on a `DETECT_WINDOW_HOURS` window per topic, and the topic's findings are replaced atomically.
**Done when:** on the VPS, the worker runs ≥ 2 cycles, the row count in `items` grows across all topics, a repeat cycle creates no duplicates, and the cache does not hit the API for an identical request.
**Tests:** None (network). Normalization is verified by parsing into `Item`.
**Depends on:** T2, T5

### T7 · P2 · Sat 09:00
**Goal:** receiver front end: post embedding + topic beam (beamforming) + topic clutter suppression (design: [signal-processing.md §3.2–3.3](signal-processing.md#3-agreed-engine-v1-design-what-to-build)).
**Inputs and outputs:** `detect/embed.py`: `embed(texts) -> np.ndarray` (Gemini embeddings + disk cache; offline fallback is a deterministic hashing embedder for tests), reads `LTR_EMBEDDER` (`tests/conftest.py` sets it to `hash`), cache in `cache/embeddings/`. `detect/beam.py`: topic steering vector (robust mean, one vote per account), beam gain `b_p`, and `whiten(E) -> np.ndarray` — remove the projection onto the beam and normalize the residual. `detect/config.py`: all analyzer parameters from §3.12 in a single dataclass (T7 uses `c_lo`/`c_hi`). There is **no** template bank: the posts themselves serve as the reference signal (§3.2). The swarm centroid is computed later for the card.
**Done when:** on `fixtures/items.json` after whitening, the mean cos between posts in the same swarm wave is noticeably higher than between organic posts (organic ≈ 0). Works offline (fallback).
**Tests:** 3 in `tests/test_detect_embed.py` (paraphrase > dissimilar; whitening drops organic cos and preserves paraphrase cos; off-topic post gets beam gain ≈ 0), offline.
**Depends on:** T0 (fixtures), T1 (Gemini key for live embeddings)

### T8 · P1 · Sat 11:00
**Goal:** an API to build the dashboard on before the detector is ready.
**Inputs and outputs:** `api/mock_detect.py` with the same signature as `detect.pipeline.detect` returns `fixtures/findings.json`. The worker saves findings to the DB. `GET /api/alerts` → `AlertsResponse`, `GET /api/metrics` → `MetricsReport` (currently a stub with `None`), `POST /api/inject` → puts synthetic items into the DB and a row into `inject_requests` (the worker picks it up in ~10 s), and `GET /api/items?ids=…` → `list[Item]` for the card. While mocked, `fixtures/items.json` is loaded into the DB. ⚙ Inject rules: HANDOFF §5 (15 min window up to "now", new `campaign_id`/id per inject). Before T9 it takes synthetic data from `fixtures/items.json`, and after T9 it uses `synth.campaign.make_campaign(...)`. `/api/metrics` reads `eval/report.json` (mounted read-only) if present. Plus `ingest/export_sample.py`: the last N hours of `items` → `fixtures/items_live_sample.json`, pseudonymized (for P2, update on every sync).
**Done when:** on the VPS, `/api/alerts` and `/api/metrics` pass model validation. Two consecutive `POST /api/inject` both add new items with `synthetic=true`. `fixtures/items_live_sample.json` is committed. `make smoke` is green.
**Tests:** extend `tests/smoke.py` to `/api/metrics`.
**Depends on:** T6

### T9 · P2 · Sat 11:00
**Goal:** test target for the radar: a synthetic swarm with known ground truth.
**Inputs and outputs:** `synth/variations.py`: Gemini writes ~30 variations for **several** messages per topic (some are held out for eval and inject; the detector is not trained on the variations and has no template bank) → cache `synth/variations/<topic>.json` (in git for offline use; network is only needed to build the cache). `synth/campaign.py` (you can reuse `synth/fixture_gen.py`, which generates `fixtures/items.json` via `make fixtures`): ⚙ `make_campaign(topic: str, now: datetime, *, n_accounts: int = 12, seed: int | None = None) -> list[Item]` — fake accounts, `source="synthetic"`, `synthetic=True`. Volley shape like a real swarm: 2 volleys within 15 minutes, and in each volley every account posts one paraphrase with its own lag of 15–120 s (**not** uniformly across 15 minutes, otherwise pairs drift apart by 5+ minutes and correlation is weak). Time and id rules: HANDOFF §5 (`published_at` in `[now − 15 min, now]`, `campaign_id = inj-<topic>-<HHMMSS>`, id `<campaign_id>-<k>`).
**Done when:** `make_campaign` is deterministic for a given `seed` and works offline from the cache. The result can be mixed into `fixtures/items.json`.
**Tests:** 1 test: all items are valid, `synthetic=True`, shared `campaign_id`, timestamps within a 15 min window, and two calls with different `now` yield different ids.
**Depends on:** T1 (Gemini for cache generation). T7 is optional.

### T10 · P2 · Sat 14:00 · CHECKPOINT
**Goal:** full detector: pair correlator → pair CFAR → swarm → SPRT → `Finding`. Math and parameters: [signal-processing.md §3.4–3.8](signal-processing.md#3-agreed-engine-v1-design-what-to-build).
**Inputs and outputs:** `detect/correlation.py` (vector signal "time × meaning", `R_ij = max_τ w(τ)·R_ij(τ)`, `τ_max` = 10 min, `Δ` = 30 s → matrices `R` and `lag`), `detect/cfar.py` (background across all topic pairs: `z_ij = (R_ij − median)/max(1.4826·MAD, 0.05)`; graph `z > k` → groups of ≥ 3 accounts; integration `Z = Σz/√M`), `detect/sprt.py` (causal "echo" feature, Gaussian LLR with clamp [−1, +1.5] and σ floor, thresholds from `alpha`/`beta`, trace), `detect/news_echo.py` (`context_news` article with the same meaning before the volley → max `watching`), `detect/config.py` (extend with correlator, CFAR, and SPRT parameters; a second, "slow" analyzer can be run), `detect/pipeline.py`: `detect(items, *, alpha=0.02, beta=0.1) -> list[Finding]` (`id = finding_id(topic, accounts)`, `verdict` coordinated/organic/watching, `llr`, `snr_db = 20·lg Z`, `snr_db_single = 20·lg(mean z_ij)`, `ambiguity` (grid §3.9), `note` ("news echo"), `sprt_trace` + `sprt_upper`/`sprt_lower`, `decided_at_item`, `first_seen`/`last_seen`, square `correlation` and `lag_sec` in `accounts` order, `explanation=None`).
**Done when:** on `fixtures/items.json`, a synthetic swarm → `coordinated` and organic → no `coordinated`. A volley compressed into 15 minutes (like an inject) also → `coordinated`. On `fixtures/items_live_sample.json` (if already available), it does not crash and does not produce `coordinated` on organic. The function runs in < 2 s on fixtures.
**Tests:** 6–8 in `tests/test_detect_*.py`: correlation peak at the expected lag; independent accounts trigger no alarm; SPRT upper/lower bounds on a known "echo" sequence; CFAR stays quiet on a flat background and highlights the group; a pair of accounts (N = 2) does not form a swarm; "news echo" does not become `coordinated`. Verification loop from workflow §3, `logic` focus per §3.4–3.8.
**Depends on:** T7 (T9 is optional: `fixtures/items.json` already has swarm `swarm-001`)
**If not ready by 14:00:** we cut S1, and P1 joins P2 to help (see [workflow §9](workflow.md#9-if-we-fall-behind)).

### I1 · both · Sat 15:00
**Goal:** real detector on live data on the VPS.
**Inputs and outputs:** in `ingest/worker.py`, import `api.mock_detect` → `detect.pipeline.detect`. Gemini embeddings with `cache/embeddings/` cache (volume) in the worker. `POST /api/inject` → `synth.campaign.make_campaign`. The worker sees `inject_requests` and immediately runs `detect()` on the topic.
**Done when:** on the VPS, within a minute after an inject, `coordinated` with `synthetic=true` appears in `/api/alerts` (the second inject works too). Live topics produce findings without crashes. The mock is removed from the worker path. `make smoke` is green.
**Tests:** `make test` + `make smoke`.
**Depends on:** T8, T10

### T11 · P1 · Sat 16:00
**Goal:** explainability: manipulation technique + quote + confidence.
**Inputs and outputs:** `ingest/explain.py`: `explain(finding: Finding, items: list[Item]) -> Explanation` (Gemini structured output using the `Explanation` JSON schema; on error/rate limit, the same client via Hostinger AI Router; cached by `finding.id`). The worker populates `finding.explanation` for `coordinated`.
**Done when:** `coordinated` findings on the VPS have `explanation`, `quote` is a verbatim substring of one of the posts, and `confidence` is in 0..1. When Gemini is disabled, the fallback triggers.
**Tests:** none (network). The response is validated by pydantic.
**Depends on:** I1 (can start on mock findings after T8)

### T12 · P1 · Sat 19:00
**Goal:** one page for judges and the video.
**Inputs and outputs:** `web/index.html` + `web/app.js` (Chart.js), layout agreed upon by P1 + P2 ([signal-processing.md §3.9](signal-processing.md#3-agreed-engine-v1-design-what-to-build)). **Main screen (simple):** topic switcher (= beam selection), alert feed from `/api/alerts`, traffic light + one sentence in the card ("N accounts are saying the same thing almost simultaneously. Target false alarm rate: X%", where X = `operating_pfa` from `/api/metrics`, with a 2% fallback when no report is available), "ambiguity surface" (heatmap from `Finding.ambiguity`: delay × semantic detuning, layers `counts` and `background`), posts, technique + quote, and `Finding.note` (for example, "news echo"). **Details tab:** `correlation` heatmap with `lag_sec` in the tooltip, SNR in dB, and SPRT trace with `sprt_upper`/`sprt_lower` thresholds. `web/metrics.html` from `/api/metrics` (ROC, operating point, Pd vs. swarm size `pd_by_size`, swarm purity, live precision with `live_precision_ci` interval, live FPR, `failure_examples`) is served at `/metrics`. The `watching` verdict is labeled "keep watching / unsure". Post texts come from `/api/items`. Real account handles are masked (`@ab***`). The header shows "updated N min ago" from `last_poll_at`. SNR in the card shows "`snr_db_single` → `snr_db` dB". The "inject test campaign" button → `POST /api/inject` (as of T12d, this button is not in the product: injection is only from `/redteam`). Served by FastAPI.
**Done when:** everything is visible on `https://<domain>` with no console errors. Inject → alert appears in the feed (updated via polling). It works on mobile.
**Tests:** none (we do not test the UI), `make smoke`.
**Depends on:** T8 (mock data), I1, T11

### T12b · P1 + P2 · after the main page is ready · BACKLOG
**Goal:** a second subpage "How we reached the conclusion": a step-by-step explanation of how the detector arrived at the verdict shown on the main screen.
**Inputs and outputs:** a page linked from the alert card (`web/`, data from `/api/alerts` via `Finding.id` and `/api/items`). Steps by `Finding` fields: (1) topic beam: posts that landed in the topic; (2) pairwise correlation: `correlation` + `lag_sec` heatmap; (3) CFAR: which pairs are above threshold k, `snr_db_single` → `snr_db`; (4) SPRT: `sprt_trace` with `sprt_upper`/`sprt_lower` thresholds, `decided_at_item`; (5) "news echo" check: `note`; summary: verdict and `explanation`. Each step: one plain-language sentence + a chart.
**Done when:** for any alert on the VPS, the page opens from the card, walks through all steps with no console errors, and works on mobile.
**Tests:** none (UI), `make smoke`.
**Depends on:** T12

### T12c · P1 + P2 · code ready 14.11 (branch p2/T12c-alpha-slider), VPS verification after deploy
**Goal:** the user chooses the false alarm probability themselves (selecting from several values).
**Decision:** the selection sets the SPRT `alpha` (1% / 2% / 5%) rather than the CFAR threshold `k`. On the eval background, Pfa = 0 for any `k` from 0.5 to 8, so "Pfa → k via ROC" would yield the same `k` regardless of the choice. In contrast, `alpha` actually changes sensitivity to small swarms and decision speed (Gemini, 14.11, across 1000 windows): Pd of a 3-account swarm is 0.80 / 0.83 / 0.92, and posts to decision (swarm of 4, detected) are 4.2 / 4.1 / 3.1. Windows are constructed as in the report, but with their own seed, so Pd(3) at 2% (0.83) differs slightly from `pd_by_size` in `/metrics`. Measured Pfa at all three points is 0 (≤ 0.3% at 95% confidence, rule of three: the background is still too small to measure lower).

**Update (14.11):** a slider instead of a dropdown, 5 steps: 0.5% / 1% / 2% / 5% / 10% (`SLIDER_ALPHAS`). Steps 0.5% and 10% will get measured numbers after the next `make eval`. Until then, the tooltip says "Not measured yet". On the VPS, `.env` needs `ALPHA_POINTS=0.005,0.01,0.05,0.1` (or remove the line), otherwise the worker does not compute the new steps.

**Inputs and outputs:**
- P2: `make eval` writes `eval/operating_points.json` (`detect/operating.py`: `OperatingPoints`, `alpha_for_pfa`, `pfa_upper95`). Tests: `tests/test_detect_operating.py`.
- P1: the worker computes `detect` for each `alpha` from `ALPHA_POINTS` (defaults are 0.005, 0.01, 0.05, 0.1; 0.02 is as before, table `findings`) and writes them to the `findings_alpha` table (created on worker startup, `store.ensure_schema`). The LLM explanation is cached by `finding.id`: a group found across multiple `alpha` values costs one call (a new call is made only for groups that are coordinated only at looser alpha values (5%, 10%)). Each point is written as a separate step after the main findings: a point failure does not touch the `findings` table. API: `GET /api/alerts?alpha=0.05` (without `alpha` or 0.02, behavior is as before), `GET /api/operating_points`. Dashboard: "False alarm limit" slider on the main page above the feed (steps are only the `alpha` values computed by the worker: `GET /api/alphas`), "False alarm X%" chip in the topic page header, and the card sentence "False alarm target: X% (measured Y%, ≤ Z% at 95%)".
**Done when:** changing the value updates the alert feed and phrase in sync (verified in the browser on a fake store). On the VPS after deployment, `/api/alerts?alpha=0.05` returns findings.
**Next:** larger background for eval (live-window export, pseudonymized) so Pfa becomes measurable.
**Depends on:** T12, T13

### T12d · P1 + P2 · by F (Sun 02:00) · live scanning + Bot Hive
**Goal:** "real-time radar" demo. The operator opens a topic on the home page and clicks **Check**: live scanning starts, the result screen updates on its own, and the background is quiet. In a separate attack tool (Bot Hive, `/redteam`), they select a prepared topic and click **Attack**: bot posts appear there one by one at their `published_at`. Meanwhile, on the topic screen, the swarm assembles frame by frame (4 → 12 accounts), and there is an SPRT decision and an alert. Its posts show the same bot names (for example, `true_voice_123`) as in the console. Agreed by P1 + P2, 14.11 (decisions below under "Decided" take priority over sections A–J).

**What the chart shows (from measurements, not expectations):**
- **Swarm growth is visible, while LLR growth between frames is not.** SPRT stops at the moment of decision (`detect/sprt.py`), and a candidate appears only once CFAR has collected ≥ 3 accounts. Simulation (12 bots, one frame every 10 s): `t+0` no candidate → `t+40` `coordinated`, 4 accounts → `t+110` 12 accounts → after the campaign ends + TTL (~`t+1500`), the alert clears. Therefore, on the chart (the frame-by-frame chart was later removed, see "Decided, demo attack"): **best swarm size by frame** (steps) + **best candidate SPRT trace by post** (`Finding.sprt_trace` vs. post time, with thresholds) — this is the "buildup to threshold".
- **The background is not the CFAR noise level.** `noise_floor`/`cfar_threshold` on live topics are structurally constant (zero-padded to `cfar_min_ref_cells=2000`: median 0, sigma 0.05, threshold 0.15 across all 6 topics), while raw pair correlation in the background is already above threshold due to news reprints (they are capped at `watching`). We **do not plot** them. Background = number of "highlighted" pairs above CFAR, number of candidates `watching`, maximum pair z. Caption: "background: the detector keeps news reprints in `watching`, not in alerts".
- **Swarm size for the demo is 25 by default (see "Decided, demo attack").** Live, CFAR sees an incomplete campaign: 12 bots → `coordinated` in 40–60 s, 6 → 80–90 s, 3 → often only near the end of the second volley (~9–10 min) or `organic`. Bot Hive does not have size 3 (only 12 / 25 / 40). Live time-to-decision ≠ `mean_seconds_to_decision` from eval (where the full campaign is present).

**Components (MVP):**
- **A. Worker: three threads, one writer for `findings` (P1).** Currently `tick()` is single-threaded: `ingest_cycle` (Context.dev timeout of 60 s per request × 6 topics), explanations (Gemini 30 s + router 30 s), and detection run sequentially, so frames would freeze for minutes.
  - The **ingest** thread: `ingest_cycle` once every `POLL_INTERVAL_SEC`, writes only `items` and `last_poll_at`, with **its own DB connection** (psycopg: threads on one connection share a transaction). Before upserting each topic, it computes embeddings for all fetched texts (warming `cache/embeddings/`) so that detection only reads them from cache. P2: explicit timeout on the Gemini client in `detect/embed.py` (currently `genai.Client` without `HttpOptions`).
  - The **explain** thread: **does not touch the DB**. The main loop enqueues `(finding, posts)`. The queue maintains a set of "in-progress/queued" IDs (duplicates are not enqueued) and one pending task per swarm (a finding with overlapping accounts replaces the previous one as the swarm grows, with up to 8 distinct swarms per topic, while main `alpha` tasks go first and a slider-point task does not preempt them). Before calling the LLM, it skips IDs that are no longer among the topic's latest findings. The result goes to the `cache/explanations/<id>` cache (as currently in `ingest/explain.py`). When the explanation is ready, the main loop rewrites that topic on the next tick (otherwise an out-of-session topic would wait up to `POLL_INTERVAL_SEC`).
  - The main **detect** loop (sole writer to `findings`/`findings_alpha`/`radar_frames`, stale topic cleanup `delete_findings_except` moves here too, per-thread DB reconnection, `tick()` tests in `tests/test_worker.py` to be rewritten) uses deadline-based scheduling (`next_scan`, `next_poll`) rather than a fixed sleep: topics in an active session or under attack run once every `SCAN_INTERVAL_SEC` (10 s) at the main `alpha` 0.02, while other topics and `ALPHA_POINTS` points (T12c) run once every `POLL_INTERVAL_SEC`. Frequent frames fetch explanations **only from cache** and enqueue missing ones. They never overwrite a saved explanation with `None` (`replace_findings` = DELETE + INSERT).
  - The `alpha` slider on `/` lags by up to `POLL_INTERVAL_SEC` during an attack for `alpha` ≠ 2%: note this in the tooltip.
- **B. Scan session (P1, API + DB).** `POST /api/scan {topics}` → `{session_id}`. Topics must be a subset of `TOPICS` only, ≤ 2 per session. The limit applies to the **union** of scanned topics (≤ 4), not the number of sessions: a new session for topics already being scanned is always accepted, a new topic above the limit returns 429. Topics outside `TOPICS` return 400 (more than 2 per session is rejected by validation with 422). Heartbeat: `GET /api/radar?session=<id>&topic=&since=` updates `last_seen_at`. A session with `last_seen_at < now() − 60 s` is closed (the rule is a pure function `is_stale(last_seen_at, now)`). `POST /api/scan/{id}/stop` closes it immediately. `/api/radar` with an unknown or closed session → 410: the page automatically opens a new one (phones throttle background tabs).
- **C. Radar frame (P2 + P1, ⚙).** P2: `detect.pipeline.scan(items, *, topics, now, alpha=0.02, beta=0.1, cfg=DEFAULT) -> tuple[list[Finding], list[RadarFrame]]` — parameter `topics: list[str]` — a frame for **each** of them, including an empty one if there are no posts in the window or only expired synthetic posts. Single pass. Findings are the same as `detect(items, alpha=, beta=, cfg=, now=now)`. The signature of `detect()` does not change. When `now` is set, it drops posts with `published_at > now`, just like `scan`. `RadarFrame` (Pydantic in `detect/`, P1 only forwards it, `contracts/` is left untouched): `topic, at, n_items, n_accounts, n_lit_pairs, max_pair_z: float | None, n_watching, top_verdict: Verdict | None, top_n_accounts: int | None, top_llr: float | None, top_trace: list[tuple[datetime, float]], top_capped: bool, sprt_upper, sprt_lower, top_campaign_ids: list[str]`. "Best" candidate: `coordinated` > `watching` > `organic`, then larger `llr`, then more accounts. Without a candidate, `top_*` = `None`, `top_trace = []`, `top_campaign_ids = []`. `top_capped = True` if the trace crossed `sprt_upper`, but the verdict was downgraded (news echo → `watching`): the chart draws such a trace in gray so the background does not look like an alert. P1: table `radar_frames (topic, at, frame jsonb)` with index `(topic, at)`, and deleting rows older than 2 h is a separate step of the main loop. `GET /api/radar` → `list[RadarFrame]`.
- **D. Gradual injection (P2 + P1, ⚙ changes the injection rule from HANDOFF §5).** P2: `make_campaign(..., schedule="past" | "future")`. `future` ≡ shifting volleys by +840 s: first post 15–55 s after click, last post at 558–599 s (200 seeds). Swarm shape, lags, texts, `campaign_id`, and seed match `past` (default for eval and tests). Future posts are written to the DB immediately. `store.window_items` already returns only `published_at <= now` (whereas `scan`/`detect` when `now` is set do not drop future posts themselves — P2: drop them so tests and eval are not fooled), and `drop_expired_synthetic` computes TTL from the newest **visible** post (verified: early posts are not cut off, and the alert lives for ~`t+40`…`t+1500`). `GET /api/items` also returns only `published_at <= now` (otherwise future posts are visible via predictable IDs).
- **E. Attack (P1, API + DB).** Table `attacks (campaign_id, topic, n_accounts, starts_at, ends_at)`. An active attack = `ends_at + synthetic_ttl_sec > now()` — the main loop reads it on every tick, so frequent frames for the attack topic continue after a worker restart. `POST /api/attack {topic, n_accounts ∈ {12, 25, 40}, posts_per_bot ∈ {2, 4, 6}} (defaults: 25 and 4)` → `{campaign_id, n_items, starts_at, ends_at}`. Repeat on a topic is at most 1 time per 5 min (section F, "Decided"). `GET /api/attack/{campaign_id}` → posts with `published_at <= now` (server time) + IDs of posts included in `item_ids` of current `coordinated` findings. `GET /api/attack/topics` → `TOPICS` ∩ topics with variations.
- **F. Rate limits (P1).** No token (see "Decided"). `POST /api/attack` and `POST /api/inject` are public, each at most 1 time per 5 min per topic: the last timestamp is in the DB (`attacks.created_at`, `inject_requests.created_at`), not in API memory. If earlier, 429 with `Retry-After`. `SCAN_INTERVAL_SEC` is in `.env.example`.
- **G. Bot Hive (P1, `web/redteam.html` + `web/redteam.js`, path `/redteam`; called Red Team Console before 15.11).** We are not creating a subdomain: Bot Hive lives at a path on the main domain `liveswarmradar.tech`. Main dashboard style (tokens, glass cards, and pill buttons as in `index.html` / `how.html`, pink accent for bots), with no links to it from the product, and from it to a topic there is a `/?q=<topic>` link "Watch it on the radar". Uses relative URLs (same origin, no CORS). Controls: topic (`/api/attack/topics`, select), swarm size (12 / 25 / 40, default 25), posts per bot (2 / 4 / 6, default 4), and scenario as segmented controls. Below them is one scenario hint and summary "N posts · ~T min · 4× speed". **Attack** (while a rate limit is active on the topic, a countdown "Again in m:ss" appears on the button). The attack progress panel appears after launch: "Caught by the radar N / M" with a progress bar, Posts, Active bots, First catch, and status line. Post feed (polls `/api/attack/{id}` every 2 s), with posts labeled "Detected" / "Unseen".
- **H. Live scan on the main page (P1, `web/index.html` + `web/app.js`).** See "Decided": Check opens a topic session, the result screen updates every 2.5 s, with a Stop / Resume live scan button and a live status line from the radar frame. There is no inject button. Source line and outlet list were not implemented (not in the previous UI).
- **I. DB schema (P1).** `schema.sql` is only applied when creating the volume: new tables (`scan_sessions`, `radar_frames`, `attacks`) go in `store.ensure_schema` (`CREATE TABLE IF NOT EXISTS`, like `findings_alpha`), called on API and worker startup.
- **J. Attack variations (P2).** Currently only `jensen-huang-resignation` and `helsinki-tram-fares` exist (the latter is not in `TOPICS`). Add `microsoft-global-outage` (most live articles) and `europe-bomb-threat-hoaxes`. Generate with Gemini and commit to `synth/variations/` (rule 4). Warm up embeddings for all variation texts once on worker startup in `cache/embeddings/` (detection lives only there), not in the attack request.

**Decided (P1 + P2, 14.11):** Product without injection: there is **no** "Inject test campaign" button on `/` (removed in T12d). Attacks are launched only from a separate tool — Bot Hive `/redteam`, **without a token**, at most 1 time per 5 min per topic (429 with `Retry-After`). We are not implementing 409 for 25 min or `ATTACK_TOKEN`. `POST /api/inject` (`past`, instant alert) remains API-only without a button, with the same 5 min limit.

**Decided (P1, 14.11, demo attack):** `/api/attack` takes the P2 `make_campaign(schedule="future")` campaign unchanged and runs its time 4× faster (`DEMO_SPEED` in `api/main.py`; we do not touch the P2 code or eval): lags 4–30 s, second volley in ~2 min; 2 posts per bot ≈ 2.5 min, default 4 posts ≈ 6.5 min, 6 posts ≈ 10.5 min; labeled "4× speed" in Bot Hive. Sizes of 12 / 25 / 40 bots (default 25) and 2 / 4 / 6 posts per bot (default 4, i.e., 100 posts): extra posts repeat volleys from the same bots and do not add account pairs. At ~50 bots, swarm pairs occupy most of the 2000 CFAR reference cells (`cfar_min_ref_cells`), so the threshold rises above the swarm itself and it breaks up into fragments (14.11 measurement with Gemini: 50 bots → alert in ~19 s, then 16/4/4; reproduced on `detect/cfar.py`; offline, 40 bots are caught whole, 50 are not). The 25-bot measurement with Gemini is still to be done on the VPS. On the topic screen: alerts (largest first), weak groups collapsed into "+N weaker groups · not alerts", and the "simulated attack" label. There is no separate chart overlaid on the 3D field (removed at P1's request): live scan updates the screen itself and the status bar.

**Decided (P1, 14.11, attack scenarios):** In Bot Hive, `scenario` selection (`POST /api/attack`): **paraphrase** (default: P2 texts, paraphrases of a single message, ×4), **copypasta** (in each volley, all posts are the same text, ×4; the detector misses campaigns that repeat a single text throughout because the beam whitens that text to zero; we expect a peak in the "0 s / same meaning" corner of the 3D field), **drift** (actual speed ~10 min; texts of all topic variations are ordered by cosine similarity to the first post, and the k-th post in time takes the k-th step; we expect a ridge along the "time between posts × difference in meaning" diagonal, and late posts may drop out of the swarm). Everything is on the P1 side (`_attack_campaign` in `api/main.py`) on top of `make_campaign(schedule="future")`. The P2 code and eval do not change.

**Decided (P1, 14.11, instead of section H):** There is no separate `/live` page. The frontend stays the same (`web/index.html` + `web/app.js`): instead of a one-off check, the **Check** button (and topic selection) opens a live session for the topic. The result screen (verdict, groups, 3D field, posts, correlation, SPRT, SNR) updates every 2.5 s from `/api/alerts`, and the radar frame (`/api/radar`) provides a live status bar (frame time, posts and accounts in the window, news echo). There is a **Stop** / **Resume live scan** button in the action bar (the inject button has been removed). Navigating to the home page, switching to another topic, or closing the tab closes the session.

**Honesty:** Attack posts have `synthetic=True` in the DB (TTL, exclusion from T14 labeling, metrics). The detector does not use this flag for its decision. The "synthetic" badge in the card stays small and gray. In the demo and video, we explicitly say "launching the attack simulator". Noise is not mixed into the background; what it means is labeled (see above).

**Done when (on VPS):**
- Home page: Check on a topic → session is open, a frame for the topic roughly every 10 s (including for an empty topic), **including while Context.dev polling and Gemini calls are running**. The status bar updates. Before the attack, there are no new `coordinated`. Stop, navigating to the home page, or closing the tab → within ≤ 60 s the session is closed and frames for the topic stop (unless an attack is running on it).
- Attack (25) in `/redteam` → posts appear in Bot Hive one by one; a repeat Attack on the same topic before 5 min → 429 (the button shows the countdown "Again in m:ss"). There is no inject button on `/`. `POST /api/inject` repeated on a topic before 5 min → 429.
- Within ≤ 2 min after the click (Gemini), `coordinated` appears on the topic screen, the swarm size grows across updates, and the SPRT trace crosses the upper threshold. Posts and names in the card match Bot Hive, which shows the "Detected" and "Caught N / M" labels.
- After the end of the campaign + TTL (at ×4: ~17–18 min after the click for 2 posts per bot, ~21–22 min for the default 4), the alert clears. Restarting the worker mid-attack does not stop frames. `make smoke` is green. The home page and `/redteam` are readable on a phone, and the browser console has no errors.

**Tests (offline, `make test`):**
- P2: `scan()` on a **synthetic background** (like `tests/test_detect_swarm.py`, hash embedder from `conftest.py`): with no target, `top_verdict != coordinated`; swarm 12 with `schedule="future"`, in `now` steps of 10 s (input contains only posts with `published_at <= now`, or a check that `scan` drops them itself) → ultimately `coordinated` with all accounts of the swarm (not "LLR grows monotonically"); `scan(...)[0] == detect(..., now=now)`; one frame per topic from `topics`, including an empty one; selecting the "best" candidate and `top_capped` on a news echo. Keep new tests fast: `make test` is already ~7 s against a target of < 5 s. `make_campaign(schedule="future")`: posts in `[click, click + 600 s]`, shape like `past`.
- P1: API on `FakeStore` (`tests/test_api.py`): attack is public, repeat on a topic before 5 min → 429, later → 200; attack posts before their time are also hidden in `/api/items`; inject without a token → 200, a second one before 5 min → 429; `/api/radar` with a closed session → 410; `/api/scan` with a topic outside `TOPICS` → 400; `is_stale()`; the worker scheduler (which topics are scanned and when) is a pure function. SQL for the new tables is verified only on the VPS.

**Manual (P1):** `SCAN_INTERVAL_SEC=10` in `.env` on the VPS if something other than the default is needed (deploy does not write `.env`). After deploy, measure the cycle duration in the worker logs.

**Cut in this order if we're short on time:**
0. The explain thread → explanations are produced by a slow loop once every `POLL_INTERVAL_SEC` for all topics, including the attack topic (the attack alert explanation will arrive with a delay of up to 5 min); frequent frames take them from cache. We do not cut the ingest thread.
1. Background metrics in the frame (`n_lit_pairs`, `max_pair_z`, `n_watching`) → only swarm size and SPRT trace.
2. Multiple topics in a session → one.
3. The "Detected" labels and "Caught N / M" counter in Bot Hive.

Do not cut: ingest thread (otherwise the radar freezes on polling), gradual injection, Bot Hive with a 5 min limit, and matching posts in Bot Hive and the card.

**After MVP (if time remains):**
- Custom topic for background scanning only: input field, Context.dev query by phrase (already works for a slug outside `TOPIC_SPECS`), ≤ 2 custom topics simultaneously, and the topic lives while the session is open. Status "collecting background…" on cold start (~10–30 s). Attacks are only on prepared topics.
- Sandbox source: the attack console posts to a separate feed, and ingest reads it as another source.

**Update along with the code:** API list in `CLAUDE.md`, demo script in `docs/architecture.md` (step 2 — attack from the console), T16.

**Depends on:** T12, T12b, T12c, T15 (CD)

### T6b · P1 + P2 · code Sat 22:00, eval Sun 01:00 (P1) · before F · MUST (decided 14.11)
**Goal:** In addition to Context.dev news, read a live social network: Bluesky posts on the same topics. Accounts become people rather than publisher domains. The "news echo" rule (`detect/news_echo.py`, currently off: the stream is news-only) starts working. The demo and video run on a "news + Bluesky" background.

**Probe (14.11, 18:55, without login):** `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts` responds with 200 (`public.api.bsky.app` — 403). Fields: `uri`, `author.did`/`handle`, `record.text`, `record.createdAt`, `indexedAt`, `embed`. Posts in 6 h for a short query (posts / authors): Microsoft outage 100+ / 93, Ukraine peace talks 99+ / 73, France riots 13 / 12, Jensen Huang resign 7 / 7, bomb threat hoax 4 / 4, midterms deepfake 0, Helsinki tram 0.

**Decided (14.11):**
- Reading is polling `searchPosts` in the same `ingest_cycle` (not Jetstream, no app password): `q`, `sort=latest`, `since` = like `news_since`, but by the topic's latest post with `platform='bluesky'` (not across all of `context_social`: with `REDDIT_ENABLED=1`, Reddit posts would shift `since`. New parameter `platform` on `store.latest_published` or a separate function). On the first poll of a topic (no Bluesky in the DB yet) — backfill with `now − 48 h`, ≤ 10 pages (see "Background for eval" below), `limit=100`, ≤ 3 pages per topic per cycle. Paginate by `until` (earliest timestamp of the previous page): without login, a request with `cursor` returns 403 (verified 14.11, see HANDOFF §6).
- Do not change the contract: `source="context_social"`, `platform="bluesky"`. Handle masking and `url` in the API (`api/main.py`) and `news_echo` work as is.
- Recompute eval on the background with Bluesky (P2). Do not relabel T14. State in the report and slides that `live_precision`/`live_fpr` were computed before Bluesky.

**Inputs and outputs:**
- P1, `ingest/bluesky.py`: `BlueskyClient.search(q, since, max_pages=3)` (httpx, timeout, raw responses in `cache/`). `posts_to_items(resp, topic, now=None) -> list[Item]`:
  - `id` = `bsky-{topic}-{sha1(uri)[:16]}`. `author` = `handle` without `@`, same as news (`api/main.py` `mask_handle` keeps the first 2 characters → `@al***` on the dashboard. With `@` at the beginning, only one letter would remain). A publisher's handle on Bluesky often matches its domain (`nytimes.com`), and in `actors` it will be the same account as the author of its articles: it is the same organization, so leave it as is. `url` = `https://bsky.app/profile/{handle}/post/{rkey}`.
  - `published_at` = `createdAt`, but if it differs from `indexedAt` by more than 5 min — `indexedAt` (the client can set any time). Drop posts from the future (`_future`).
  - `text` = `record.text` only (do not mix in the link card title, otherwise everyone sharing the same article looks like copy-paste). Drop posts with no text left after removing links.
- P1, queries: `BSKY_QUERIES` in `ingest/bluesky.py` (short ones, as in the probe), and for a slug outside the table — `topic_query`. Then the same `on_topic` across the full post text.
- P1, `ingest/worker.py`: source `bluesky` in `fetch_topic` under flag `BLUESKY_ENABLED` (**on** by default, `0` is a quick rollback to news). A Bluesky failure does not affect news and vice versa. `ingest_cycle` without `CONTEXT_DEV_API_KEY` still reads Bluesky. To do this, refactor: `fetch_topic(client: ContextDevClient, topic, since)` (one client and one `since` for all sources) → each source gets its own client and its own `since`. Early `return []` in `ingest_cycle` when the key is empty → skip only the news source. New posts go through `warm_embeddings` as they do now.
- **P1, handles in post text:** The API currently hides the author and `url`, but returns `text` as is: `@bob.bsky.social` mentions and `bsky.app/profile/<handle>` links in the text are visible to everyone (reproduced on `public_item`, `api/main.py`). `public_item` runs `text` through `mask_handles` (`ingest/contextdev.py`). Add `bsky.app/profile/[\w.:-]+` links to `_HANDLE_RE` so `ingest/export_sample.py` does not commit them to git. Test both cases. Gemini explanations can quote post text: they must go to the card after the same masking (check `ingest/explain.py` and the API).
- P1: `.env.example` (`BLUESKY_ENABLED`), `make smoke` does not change.
- **Background for eval (decided 14.11):** 48 h of Bluesky will not accumulate by F (code at 22:00, F at 02:00 → ≤ 4 h of live polling). Background = 48 h of news + all Bluesky data in the DB (initial poll backfill + live polling). Record the number of Bluesky hours per topic in HANDOFF and in the report description.
- **Who and when (decided 14.11):** P2 sleeps Sat 20:30 – Sun 00:30 (HANDOFF §3), so the export and `make eval` are done by **P1 on Sun ~01:00** (by T13 this is allowed: `make eval` reads only the export, `labels.csv`, `labels_meta.json`, and fixtures). Commit `eval/report.json` before F. The offline check of `news_echo` below can also be run by P1 (run only, without editing `detect/`). If the rule needs changing, P2 does that after 00:30.
- **P2, before deploying with Bluesky (offline, blocks enabling):** With `context_social` posts in the window, `news_echo` (`detect/pipeline.py` `has_social`) activates: a group that has an article within ≤ 1 h before the first post with cos > 0.8 to the centroid (`news_echo_cos`, `news_echo_max_age_sec`) is downgraded to `watching`. Attack posts name the topic subject, so on a topic with heavy news volume (Microsoft: 100+ articles), the attack may stop producing `coordinated`. Verify: `scan` with a 25 attack (`schedule="future"`, variations from `synth/variations/`) on a live "news + Bluesky" window for each attack topic (helsinki, jensen, microsoft, europe) → `coordinated`, not `watching` with `note` "news echo". If it suppresses it, P2 decides what to change in the rule (not the `synthetic` flag: the detector does not use it) and writes the decision to HANDOFF. Until then, `BLUESKY_ENABLED=0`.
- P2: run `detect` on a live window with Bluesky (what `news_echo` does, how many `watching`/`coordinated` appear on real people). `ingest/export_sample.py` → new background window (pseudonymized with `contracts.pseudonym()`) → `make eval` → `eval/report.json` + `eval/operating_points.json` in git. Record defaults in HANDOFF if they shifted. Optional: `platform="bluesky"` on attack posts in `synth/campaign.py` (currently `"x"`) so the attack looks like the rest of the background.

**Done when (on VPS):**
- `items` has `platform=bluesky` for at least 4 topics from `TOPICS`. `/api/items` returns handles as `ab***` and without `url`.
- 2 h of Bluesky background: there are no new `coordinated` on real accounts, or each one has been investigated and recorded in HANDOFF §6 (what it is and why).
- Attack (25) in `/redteam` still yields `coordinated` ≤ 2 min on a topic with Bluesky background (and with heavy news volume), without `note` "news echo". `make smoke` is green.
- `eval/report.json` is recomputed on the background with Bluesky, and `/api/metrics` serves it.

**Tests (offline, `make test`, P1):** `tests/test_bluesky.py`: `searchPosts` response (short JSON inline in the test, fictional handles) → `Item` (UTC, `source`, `platform`, stable `id`), the `createdAt`/`indexedAt` rule, and a future post and an empty post dropped. `fetch_topic` on fake clients: a Bluesky failure does not drop news, `ingest_cycle` reads Bluesky without a Context.dev key, `since` by `platform`, and masking of handles and `bsky.app/profile/` links in `text` (`public_item`, `mask_handles`). Without network or `sleep`, using fake clients only: `make test` is already 7.6 s against a < 5 s target, and new tests add ≤ 0.3 s.

**Privacy:** Real handles only in the DB. In git and fixtures: `contracts.pseudonym()`. Raw responses: `cache/`.

**If the background produces false alarms / we fall behind:**
0. `news_echo` suppresses the attack (see P2’s check above) and the rule cannot be fixed quickly → `BLUESKY_ENABLED=0`, demo on news.
1. Sort out with P2: a news echo without an article in Context.dev (everyone shares the same article that is not in news) → candidate for `watching`, not an alert.
2. `BLUESKY_ENABLED=0` on VPS, demo and eval stay on news, and Bluesky goes onto the "what's next" slide with probe numbers.

**Update alongside the code:** `docs/architecture.md` (diagram, line 26; MUST and Ingest row, 40; risk "social does not return author", 108), HANDOFF :87 (masking: now also `text`), :106 (news-only fallback), §6 (T2 summary for social), `docs/signal-processing.md` (:18, :75, :232 — it says the live stream is news-only), `docs/tech-challenges.md` (Social row, :39), `docs/submission-draft.md` (`[ALT]` news-only no longer applies to us), README "Context.dev endpoints & why" from T17 (+ Bluesky), and the Stack row in `CLAUDE.md`.

**Depends on:** T6, T15

### T13 · P2 · Sat 19:00
**Goal:** Honest numbers for the 40% of the score. Definitions: [signal-processing.md §3.10](signal-processing.md#3-agreed-engine-v1-design-what-to-build).
**Inputs and outputs:** `eval/run.py`: trial = a 6 h window of a single topic. Windows **without target** (live sample, live background over 48 h, and fixture organic data multiplied by time-shuffling, plus "honest" non-overlapping windows of the live feed) → Pfa = fraction of windows with any `coordinated`. Windows **with injection** of `make_campaign` (held-out phrases) → Pd = fraction of windows where a `coordinated` is found that has ≥ half of its accounts from the injection and covers ≥ half of the injected accounts. ROC (pfa, pd) by sweeping the CFAR threshold `k` through `detect/config.py`, `operating_pfa` (Neyman–Pearson: highest Pd among `k` with Pfa ≤ 2%), `detection_rate`, `mean_posts_to_decision`, `mean_seconds_to_decision`, Pd vs. swarm size (3, 4, 6, 8, 12) → `pd_by_size`, swarm purity → `swarm_purity` → `eval/report.json` (`MetricsReport`, in git. Run `make eval` with `LTR_EMBEDDER=gemini` and cache, network allowed. `embedder` is written to the report, and on `hash` only with `--dev`). "Synthetic precision" is not computed (it depends on the fraction of windows with a target). `failure_examples` — 3–5 real misses/false alarms. From the T14 labeling (⚙ `eval/labels.csv`): `live_precision` = suspicious/(suspicious + organic) with a Wilson interval (`live_precision_ci`), and `live_fpr` = P(alert | organic) with stratified sample reweighting by `eval/labels_meta.json`, `n_labelled`. Rows supplemented from `watching` are excluded from both formulas. After T14, recompute the report (P1 can do this too: `make eval` reads only `labels.csv`, `labels_meta.json`, and fixtures).
**Done when:** `make eval` writes a valid `MetricsReport` offline on fixtures. After commit and `make deploy`, `/api/metrics` on VPS serves it.
**Tests:** 1 test: the report is valid, the ROC is monotonic, and values are in [0,1].
**Depends on:** T9, T10

### T14 · both · Sat 20:30
**Goal:** Live precision and live FPR on real people.
**Inputs and outputs:** rubric (15 min) is organic / suspicious / unclear. `ingest/label_sample.py` (P1, in advance) creates the `eval/labels.csv` skeleton (`account, topic, alerted, verdict, label, note`; `verdict` = `coordinated` / `watching` / empty, `alerted` = 1 for `coordinated` only) and `eval/labels_meta.json` with stratum sizes per topic `{topic: {n_accounts, n_alerted}}` (real topic accounts in the window and how many of them are in `coordinated`; needed for reweighting live FPR, see [signal-processing.md §3.10](signal-processing.md#3-agreed-engine-v1-design-what-to-build); agreed by P1 + P2). `account` is a pseudonym; `pseudonym,handle` → `cache/label_handles.csv` mapping, git-ignored): ~25 accounts from alerts + ~25 random non-alert accounts from the same topics, **synthetic excluded**. If real alerts < 25, backfill from `watching` with the highest LLR (`verdict = watching`; these rows are excluded from precision and FPR formulas) and state n honestly. Label using real handles in the DB/dashboard; only the pseudonym is written to the file. Labeling by 20:00, 20:00–20:30 `make eval` + commit + `make deploy`.
**Done when:** ≥ 40 accounts are labeled, and `/api/metrics` shows `live_precision` with interval `live_precision_ci`, `live_fpr`, `n_labelled`.
**Tests:** none.
**Depends on:** I1 (live alerts), T13

### S1 · P1 · Sun 01:00 · SHOULD
**Goal:** "who is behind the source" in the card. Only if all MUST items except T14 are ready by Sat 20:00 and checkpoint T10 is passed.
**Inputs and outputs:** `ingest/source_trust.py` (Context.dev brand/company by domain, cache) → ⚙ separate `GET /api/source/{domain}` so the `Finding` contract stays unchanged; a block in the dashboard card.
**Done when:** for domains from alerts, the card displays company/age/logo or "no data". An S1 failure does not break the card.
**Tests:** none.
**Depends on:** T12, all MUST

**Done (P1, 15.11, branch `p1/S1-source-trust`):** `ingest/source_trust.py` (Brand + Company Search, per-domain cache, limit of 30 new domains/h), `GET /api/source/{domain}` (interface in HANDOFF §5), and a line under each news article in the posts list (`web/app.js`): logo, name, "founded 1851 (175 y)", country, industry, or "no source data". The domain is extracted from the article URL because the publisher handle is masked in the API. Usage is ≈ 12 credits per new domain once every 30 days. Tests are `tests/test_source_trust.py`, and SQL was verified on the local DB. Live verification will happen after deploying to the VPS.

### T15 · both · Sun 02:00
**Goal:** stable operation and a reasonable operating point.
**Inputs and outputs:** tuning `alpha`, `beta`, CFAR `k`, beam thresholds `c_lo`/`c_hi`, and `μ1` from the ROC in T13 and T14 labeling → defaults in `detect/config.py`; `restart: always` in compose; VPS restart check. CD: `.github/workflows/deploy.yml` — every push to `main` (except pushes that change only `docs/**` and `*.md`) → `make test` → rollout of the tested commit (like `make deploy`) → wait for `/health` → `make smoke`. Repo secrets are `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`, `VPS_HOST`, and variable `PUBLIC_URL` (auto-deploy stays on until the end; do not merge during video recording or in the final hour before submission).
**Done when:** everything comes back up automatically after `docker compose restart` and a reboot. FPR on live labeling is within the chosen operating point, and defaults are recorded in HANDOFF.
**Tests:** `make test` + `make smoke`.
**Depends on:** T13, T14

### F · both · Sun 02:00 · FEATURE FREEZE
**Goal:** freeze code for the demo.
**Inputs and outputs:** `main` → tag `freeze`, deployed to the VPS.
**Done when:** `make test` and `make smoke` are green on the tag. Only demo bugfixes are allowed afterward.
**Tests:** `make test`, `make smoke`.
**Depends on:** I1, T11–T13, T15

### T16 · both · Sun 03:00
**Goal:** a 2-minute video on the live demo.
**Inputs and outputs:** script from `docs/architecture.md` "Demo script" → video (live URL, Check with live scanning, attack from `/redteam`, card, /metrics). The attack runs ~6.5 min at 4 posts per bot (~2.5 min at 2; ×4 speedup, labeled in Bot Hive), and the alert is expected within the first ~30 s. Real numbers only.
**Done when:** video ≤ 2:00 is uploaded and the link is in HANDOFF.
**Tests:** none.
**Depends on:** F

### T17 · P2 · Sun 08:00
**Goal:** materials for judges with real numbers.
**Inputs and outputs:** 7 slides, final description (from `docs/submission-draft.md`, numbers from `/api/metrics`), and `docs/codex-log.md` only if Codex was actually used. The README section "Context.dev endpoints & why" is written by **P1** (his expertise; P1 is awake from 07:00).
**Done when:** all numbers in the slides match the live `/api/metrics`. Any fallback from T2 (if used) is described honestly.
**Tests:** none.
**Depends on:** T13, T14, T16

### T18 · both · Sun 10:00
**Goal:** final submission.
**Inputs and outputs:** Junction form: live URL, repo, video, slides, description, and tech challenges (Context.dev, Gemini; Codex only with a log).
**Done when:** the form is submitted before 10:00, the live URL responds, and `make smoke` is green at the time of submission.
**Tests:** `make smoke`.
**Depends on:** T16, T17

### T19 · P1 · 14.11 evening · 50 topics (branch `p1/topics-50`)
**Goal:** monitor the 50 most discussed topics instead of 6 (all available in search on the home page: `datalist` fetches `TOPICS`) without burning Context.dev credits or freezing the radar.

**Selection (14.11):** candidates from Bluesky trending (`app.bsky.unspecced.getTrendingTopics`), news digests from 14.11, and "evergreen" disinformation topics; Bluesky `searchPosts` probe over 6 h (≤ 3 pages, same keyword filter as in the worker). Topics with ≥ ~10 authors after filtering were kept, plus 6 previous ones (france-riots, bomb-hoaxes, and midterms-ai-fakes have almost no stream, but carry attack variations and history). No news probe was run (no local key): check the headline filter for new topics in the logs after deploy. Tables: `TOPIC_SPECS` (`ingest/contextdev.py`), `BSKY_QUERIES` (`ingest/bluesky.py`). "Event of the day" topics (FAA, cruise ship, Schumer) will die down in 1–3 days — refresh the list.

**Usage and polling frequency:**
- Bluesky (free) — all topics every `POLL_INTERVAL_SEC` (5 min), as before.
- Context.dev news (5 credits per request, 10 requests/min) — `NewsSchedule` in `ingest/worker.py`:
  - **selected topic** (live scan session: the UI opens it in `openTopic` → `POST /api/scan` and keeps it alive with `/api/radar` requests, or an ongoing attack) — ~10–20 s after opening (the detect cycle marks the topic at least once every 10 s, and ingest checks urgent topics every `URGENT_CHECK_SEC` = 10 s), then every `POLL_INTERVAL_SEC` while the session is alive.
  - **alert**: a real (non-`synthetic`) `coordinated` on a topic → immediate news request, no more often than `NEWS_ALARM_SEC` (10 min): the article on which `news_echo` lowers the group to `watching` may not have arrived yet. After such a request, the topic is restarted in the detect cycle.
  - **others** — once every `NEWS_POLL_SEC` (2 h), no more than `NEWS_MAX_PER_CYCLE` (8) topics per cycle, longest-waiting first (a restart does not trigger a volley of 50 requests).
  - Total ≈ 50 × 12 × 5 = **3 000 credits/day** background + 1 440/day per topic while it is being watched. A persistent alert adds up to 144 × 5 = 720/day for that topic (a request every `NEWS_ALARM_SEC`). Polling timestamps live in process memory: after a restart, background polling is spread out anew over ~30 min.
- Urgent checks run between ingest cycles in the same thread: during a long full cycle (especially the first one after deploy, with a 48 h backfill for new topics), a newly opened topic waits for it to finish.
- Cost: on an unselected topic, news arrives with a delay of up to 2 h. A "news echo" false alert persists until the alert-triggered article arrives (seconds to a minute).

**Detector load:**
- `WINDOW_MAX_ITEMS` (800, `ingest/store.py` `window_items`): the limit applies only to real social media posts (`context_social`, not `synthetic`) — the latest 800 posts of the topic window. All `context_news` articles and all synthetic posts in the window are kept (otherwise, on a noisy topic, 800 posts is ~20 min, and `news_echo`, which looks at articles within ≤ 1 h, would lose the triggering article). The pair correlator scales as ~ authors². For ~15 topics, 300 Bluesky posts accumulate faster than 6 h. The same limit is seen by `/api/timemap` (rewinding `at=` past the start of the truncated range shows fewer posts) and verification scripts. `make eval` was computed on windows without a limit.
- Embedding warm-up in the ingest thread covers only detector-window posts: the 48 h Bluesky backfill of a new topic (up to 1000 posts) sits in the DB, and only `make eval` computes embeddings for it.
- A full sweep of 50 topics × 5 alpha is long: topics with open sessions/attacks go first, and between the remaining topics, whenever `SCAN_INTERVAL_SEC` is reached, frames for fast topics (`step`, `LoopState.clock`) are computed again — the radar does not stall. At that point, the fast-topics list is re-read, so a topic opened mid-sweep immediately gets frames and frequent news.

**UI:** is unchanged (the redesign is in another branch). Requirement for the new UI: opening a topic still uses `POST /api/scan` and a `GET /api/radar` heartbeat, otherwise the backend will not know the selected topic. Topic labels are built by `topicLabel` from the slug ("Faa ground stop") — the `web/labels.js` dictionary can be extended in the UI branch.

**Deploy:** `TOPICS` on VPS = 50 slugs, reduced to 49 as of 15.11 (list in HANDOFF §6), `NEWS_POLL_SEC` / `NEWS_ALARM_SEC` / `NEWS_MAX_PER_CYCLE` / `WINDOW_MAX_ITEMS` at defaults. After deploy: `make smoke`, and in worker logs — `ingest cycle: 49 topics, news for N` lines (before 15.11: 50), full sweep duration, `credits=`, and Check frames every ~10 s during the sweep. The first cycle for each new topic is a 48 h Bluesky backfill (10 pages): the first ingest cycle after deploy will take several minutes.
**Tests:** `tests/test_topics_scale.py` (news schedule, full/urgent cycle, alert, frames during a long sweep, window limit, topic table consistency).
**Post-deploy (15.11):** in `/api/alerts` at ~22:05 UTC 14.11 — 14 real `coordinated` (before T19: 0): 7 on `earthquake` (USGS seismograph bots) — the topic was removed from `TOPICS` (49 topics, while the record in `TOPIC_SPECS` was kept). The remaining 7 are mostly reprints of agency briefs by outlets along with their own Bluesky posts → the "reprint" rule was expanded (≥ 50% articles in a group, [signal-processing.md §3.8](signal-processing.md)). Re-running the detector on the 49-topic window at ~00:10 UTC 15.11 (window shifted, new groups): real `coordinated` 11 under the old rule → 4 under the new rule. Open-topic radar during a full sweep: a frame exactly once every 10 s (94 frames in 15 min).
**News filters (15.11, ~01:30):** for 10 topics, the headline filter let through 0 out of 50. Based on Context.dev responses from `cache/contextdev/` on the VPS and testing 18 alternative queries (~90 credits): for 9 topics (abortion, chile-fuel-protests, north-korea, rfk-vaccines, taiwan-china, trump-cuba, turkey-qatar-defense-pact, uk-starmer, us-midterms-ai-fakes), the 6 h results contain not a single on-topic headline (word matches are "Aidan Chiles", Thanksgiving turkey, "midterm" without deepfake) — search fills the limit with irrelevant recent news. The filter is right: these topics simply have no articles (the detector runs on Bluesky, but without relying on "news echo" and "reprint"). Only `climate-change` was fixed: the filter required the phrase "climate change" and dropped "climate justice / deal / inaction" → `climate` (on saved responses, 6 out of 59, all on-topic).
