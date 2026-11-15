# Live Swarm Radar Tools and Tech Challenges

We **do not store** codes and keys in the repo: they are in Junction Hackerpack, and in our `.env` (git-ignored).
The scope is trimmed to the core (MUST / SHOULD / CUT). See [architecture.md](architecture.md). Work order: [HANDOFF.md](HANDOFF.md#5-task-plan), cards: [tasks.md](tasks.md). There are two of us: P1 "Pipe", P2 "Brain".

## Summary in 10 seconds
| Tool | Role in the radar | Prize | Tier |
|---|---|---|---|
| **Hostinger VPS + AI Router** | Home: everything runs here, public URL. AI Router = fallback LLM | required for the main challenge | ✅ **MUST** |
| **Context.dev** | Antenna: live news and posts | €750 / €250 / swag | ✅ **MUST, core** |
| **Gemini API** | Embeddings, technique classifier, cluster explanation | €4000 + $1000 GCP/person · €2000 · €1000 | ✅ **MUST** |
| Codex | Could write `detect/` | $10k / $5k / $2.5k credits | ◐ maybe later (writing with Claude for now) |
| Oxylabs, Gemma, Nemotron, Modal / Verda, Aiven, CRACI | — | — | ❌ **CUT** |

Example of how it works together: Context.dev brings in 40 new posts about "power outage" → Gemini turns them into vectors → topic beam, whitening, and pair correlator find a swarm of 17 accounts → CFAR and SPRT say "coordinated" at a given false-alarm rate → Gemini explains the technique ("fear appeal") with a quote → (SHOULD S1) Context.dev brand/company shows who is behind the domain.

**Submission rule:** in the write-up and in the tech-challenges list, keep only what **actually works in the demo**. If we did not build a SHOULD item, cross it out.

---

## 1. Hostinger (main challenge Decode the Noise) · ✅ MUST
**What it provides (1 month free):**
- **VPS KVM 2:** 2 vCPU, 8 GB RAM, 100 GB NVMe, Docker, root, **free domain**.
- **AI Router:** one key for 150+ models (Anthropic, OpenAI, DeepSeek, Mistral, xAI), compatible with the OpenAI and Anthropic SDKs.
- **Connector / API / MCP** (`github.com/hostinger/api-mcp-server`): deploy and domain management straight from the editor.

**Our setup:** Docker Compose on the VPS: `caddy` (HTTPS), `api` (FastAPI + dashboard), `worker` (Context.dev polling, detectors, Gemini, while P2 runs eval separately → `eval/report.json`), `db` (Postgres). AI Router = fallback LLM (if we hit Gemini limits) and shows the judges that we use their stack.

**Required:** live public URL by the end of the hackathon. 40% of the score = detection quality and honest metrics.

## 2. Context.dev · ✅ MUST, core
**Prize requirement:** ≥1 endpoint **in the main flow**, with data **visibly driving the demo**. Submit repo + demo + **a note on "which endpoints and why"**.
**Judging criteria:** 40% creativity (endpoint combination), 30% centrality of live data, 30% technical execution (accuracy, latency, changes over time).
**Limits:** 50 000 credits per team with no expiration, up to 50 concurrent requests, no rate limit.

| Endpoint | What it does for us | Tier |
|---|---|---|
| **News search** | Stream of fresh articles across 3–5 topics (polling every 2–5 min) | MUST |
| **Social scrape** (TikTok, Instagram, Reddit) | Posts + author + timestamp → account "time × meaning" signal for swarm detection | Does not work (T2: Reddit — `WEBSITE_ACCESS_ERROR`, TikTok/Instagram do not search by topic). Starting with T6b, the social source is Bluesky `searchPosts` (not Context.dev), Reddit code behind flag `REDDIT_ENABLED` |
| **Brand + company enrichment** | Who is behind the domain, whether the logo belongs to someone else (Source Trust) → "endpoint combination" for the judges | SHOULD (S1, P1) |
| Full-text scrape, Monitors + webhooks, Research, Structured extraction | Search text is enough / replaced by polling / Fact-check is cut | CUT |

**First check (T2, P1, Fri 23:15):** whether author and timestamp are present in news search / social scrape. If not — `[ALT]` in [submission-draft.md](submission-draft.md).
**Gotchas:** check the `success` flag (200 can come back with an error). Context.dev's own cache (up to 3 days) still charges full credits → cache results locally. Crawl and batch are asynchronous.

## 3. Gemini API · ✅ MUST
**Prize requirement:** go **beyond "we added an LLM"**. In the submission, explain the problem, how Gemini is integrated, what is innovative, and why it does not work without Gemini. Key in Google AI Studio, **18+ only**.

**Role in our stack:**
- **Embeddings** of posts → matched filtering in semantic space: posts are compared against each other, and paraphrasing is detected without a template bank.
- **Technique Classifier** with structured output: technique + supporting quote + confidence.
- **Long context:** the entire swarm cluster (hundreds of posts) in a single call → explanation of "why this is a campaign".
- Generating variations for the synthetic swarm (eval).

**Why Gemini matters (for the submission text):** long context lets us judge a group rather than a single post, and that is literally our "despreading".

## 4. Codex · ◐ maybe later
**Prize requirement:** show **how Codex actually helped build**. $100 per person (personal link in Hackerpack, 30 days).
**How to keep it honest:** P2 "Brain" writes `detect/` in Codex (`cfar`, `sprt`, correlation) — an isolated module with synthetic unit tests and a single contract (`contracts/models.py`), making it a convenient task for Codex. Evidence: links to Codex tasks/PRs, screenshots, and `docs/codex-log.md` ("task → what Codex did → what we fixed"), maintained as we go. In the submission, we state honestly who wrote what.
**Current status:** we are writing code with Claude and are not listing Codex in the preliminary submission. If we adopt it later (decide no later than Sat 11:00), we will maintain `docs/codex-log.md` from that point on. Otherwise, it stays out of the submission. We do not write logs retroactively.

## 5. Oxylabs · ❌ CUT
As a team of two we cannot stretch to cover it, and for the "Best *agentic* usecase" prize with a single geo-`/search`, our chances are low. We are not activating the subscription, so there is nothing to cancel.

## 6. Remaining CUT items (not using)
- **Gemma.** EmbeddingGemma on CPU is an unnecessary integration since Gemini already provides embeddings.
- **Nemotron.** Strong on images and video, whereas we work with text.
- **Modal / Verda.** They require the GPU to be central. We do not need a GPU.
- **Aiven.** Postgres in Docker on the VPS is simpler and keeps everything on Hostinger.
- **CRACI.** CI on their runner adds nothing to detection, and judging is based on depth of integration.

Full canonical CUT list: [architecture.md](architecture.md#scope-must--should--cut).
