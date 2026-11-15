# Submission Draft v4 · Live Swarm Radar · The Kerfufflers
## Main: Decode the Noise (Hostinger) · tech: Context.dev, Gemini (Codex: maybe later, not using yet) · idea: signal processing

*Scope is cut down to the core, see [architecture.md](architecture.md). There are two of us. P2 "Brain" handles the preliminary (T3) and final text (T17). Rule: the final text only includes what actually works in the demo.*

# ⏰ BLOCK FOR PRELIMINARY SUBMISSION (T3, by Fri 23:59), copy as is

**Project Name:** `Live Swarm Radar`

**Punchline (197/200):**
```
Bots whisper below the noise floor. Live Swarm Radar is a spread-spectrum receiver for the web: it despreads coordinated campaigns, names propaganda techniques and reports honest false-alarm rates.
```

**Challenge Picker:** `Decode the Noise`

**Description (short version, 640 characters):**
```markdown
Propaganda campaigns behave like a spread-spectrum signal: each bot account is too weak to flag alone, but together they carry one message. **Live Swarm Radar** applies radar and signal-processing math to the live web: matched filters find a narrative even when reworded, cross-correlation of account activity "despreads" hidden swarms, a CFAR threshold raises alerts, and a sequential likelihood-ratio test (SPRT) decides "coordinated / organic / keep watching" at a false-alarm rate we choose. Every verdict is explained in plain language with evidence and sources. Live web data comes from Context.dev; the system runs live on Hostinger.
```

**Source Code:** link to GitHub repo (can be empty)

**Tech Challenges (select now, can be changed until Sun 10:00):** Best Use of Context.dev: Fully Structured Web · Best Use of Gemini API
*Not selecting Codex yet: we are writing code with Claude. We will select it only if we connect it later and have a log. Not selecting Oxylabs (CUT).*

---

# FINAL VERSION (by Sun 10:00)

## Description (~4599/5000 with [SHOULD] / [ONLY IF TRUE] tags, markdown), replace the short one with this
*Replace `[brackets]` with real numbers, do not invent anything. Delete any line or fragment tagged `[SHOULD]` (Source Trust, S1) / `[ONLY IF TRUE]` (Codex) if it does not work live. Otherwise, remove the tag itself. The `[ALT]` replacement is right below the block.*
```markdown
## The idea: propaganda is a signal hidden in noise
In radio, a spread-spectrum (CDMA) signal sits **below the noise floor**: no single sample stands out, but a receiver that knows the code adds the pieces coherently and the signal rises out of the noise.

Coordinated campaigns work the same way. Each bot posts too little to flag alone, but together they share one "code": the same moments of activity, the same message in different words. Detectors that judge **one post at a time** cannot see them. **Live Swarm Radar is a receiver for that signal.**

## The receiver chain
`Antenna + topic beam (live web) → front-end (embeddings, clutter whitening) → pair correlator (time × meaning) → CFAR + SPRT detector → explained verdict`

- 📡 **Beamforming on a topic**: each watched topic is a beam. The Context.dev query steers the antenna, and a steering vector in embedding space keeps on-topic posts in the main lobe and suppresses off-topic sidelobes. Several topics run as parallel beams, each with its own noise floor.
- 🎯 **Matched filtering in meaning space**: every post is correlated with every other post in embedding space, after whitening out the topic's common background (clutter rejection), so a message is found even when reworded, with no pre-built template bank.
- 🐝 **CDMA despreading (Spot the swarm)**: each account is a vector signal in time × meaning. Organic users behave like independent random codes; a coordinated group shows a cross-correlation peak at a common lag. Coherently combining the M account pairs of a cluster gives a processing gain of 10·log10(M) dB, shown as SNR before and after.
- 📈 **CFAR alerting**: like radar, the alarm threshold adapts to each topic's own background (median and spread over all account pairs, an order-statistic CFAR), keeping the false-alarm rate constant for busy and quiet topics alike.
- ⚖️ **SPRT decision**: a sequential likelihood-ratio test accumulates evidence (text similarity and timing) post by post and decides *coordinated*, *organic* or *keep watching* as early as possible, with error rates α and β that we set.
- 🎭 **Name the technique**: Gemini reads the whole cluster, labels loaded language, fear appeal, whataboutism and fabricated authority, quotes the key phrase and explains *why* in plain language.
- 🔗 **Trust the source** [SHOULD]: company identity and cloned branding behind a domain, from Context.dev enrichment.

## Honest, measurable detection
We report detection the way radar engineers do:
- **ROC curves (Pd vs Pfa)** and a Neyman–Pearson operating point, e.g. *"at [2]% false alarms we detect [X]% of injected test campaigns"*.
- **Test-target injection**: we hide a synthetic coordinated campaign inside the real live stream and measure whether, and how fast, it is detected (**[N] posts / [T] seconds** to decision).
- A hand-labelled live test set of [N] real accounts, so the false-alarm rate is measured on real people, separately from the synthetic tests.

Current results: **detection [X]% of injected campaigns at [Pfa]%; live FPR [Z], precision [P] (95% interval [lo–hi])** on the labelled set. Known failure cases are listed on the metrics page. When evidence is weak, the verdict stays *"keep watching"* instead of accusing a real person. The detector has no template bank and is never trained on the synthetic campaigns, so the scores are not circular. Precision is reported only on hand-labelled live accounts, because on synthetic tests it depends on how often we inject.

## Explainable verdicts
Each alert shows the evidence a human can check in seconds: the correlated accounts and their timing, the reworded posts that matched, the quoted key phrase, the source data, and an ambiguity map (time delay × semantic mismatch) where a coordinated group shows up as one sharp peak; the SNR and the SPRT trace showing when the decision was made sit on a details tab.

## Deployed live on Hostinger
Docker Compose on a Hostinger VPS with a public HTTPS domain: FastAPI, a detector worker and Postgres. The worker polls Context.dev every few minutes, so alerts follow the live web. Gemini is the main model, with Hostinger AI Router as a fallback. Public dashboard and REST API.

## Who it is for
- **Fact-checkers and journalists**: know in minutes whether a trend is organic or coordinated.
- **Moderators**: see campaigns aimed at their community.

## Partner technology
- **Hostinger**: VPS, domain and AI Router host the whole live system.
- **Context.dev**: our antenna for the news. News search gives the fresh articles, which also let us tell a real coordinated push from an honest reaction to breaking news. Social posts with authors and timestamps, which turn accounts into activity codes for despreading, come from Bluesky public search on the same topics. [SHOULD: Brand and company enrichment tells who is behind a domain.]
- **Gemini**: embeddings for the matched filters, and long-context reasoning over a whole swarm cluster to name the technique and explain the verdict with quoted evidence. It judges the group, not one post, which is exactly what despreading needs, and it also writes the synthetic test campaigns we inject. Without long context we could only explain single posts.
- **[ONLY IF TRUE] OpenAI Codex**: wrote [the detectors]; see `docs/codex-log.md`.

## What's next
Fact-checking with source fusion, cross-country geo echo, change watch for silently edited articles, spectral fingerprints of scheduled bots, delay-Doppler maps of narrative spread, and a browser extension.

*Team The Kerfufflers · Junction 2026*
```

**[ALT] — only if `BLUESKY_ENABLED=0` remains on the VPS (T6b, Bluesky disabled):** in the Context.dev item, replace the sentence "Social posts … same topics." with *"News search gives fresh articles with authors and timestamps, which become the activity codes for despreading."* And add to "Honest, measurable detection": *"Swarm detection is demonstrated on injected synthetic accounts; in the live stream, 'accounts' are news authors and domains."*

## How the text covers Hostinger criteria
| Criterion | Weight | Where |
|---|---|---|
| Detection quality: accuracy, FP, explainability | 40% | "Honest, measurable detection" (ROC, Neyman–Pearson, target injection), "keep watching", "Explainable verdicts" |
| Tech + live deployment on Hostinger | 25% | "Deployed live on Hostinger" + Demo link |
| Originality and impact | 20% | The entire radar framing: CDMA despreading, CFAR, SPRT |
| Demo clarity | 15% | Video below |

## Links
| Field | What to insert |
|---|---|
| Project Demo | `https://[hostinger-domain]` (**must be Hostinger**) |
| Source Code | `https://github.com/[org]/live-truth-radar` |
| Video | YouTube or Loom, ~2 min |
| Other Link | `https://[domain]/metrics`: ROC and latency |

## Video (2 min)
| Time | Shot |
|---|---|
| 0:00–0:15 | "Bots whisper below the noise floor": individual accounts are invisible |
| 0:15–0:50 | Injecting a test campaign into the live stream → a sharp peak grows on the "delay × semantic detuning" map → SNR from [x] dB (single pair) to [y] dB (entire swarm) (real numbers from the demo) |
| 0:50–1:10 | SPRT trace: "coordinated" decision on post [k] |
| 1:10–1:30 | Card: manipulation technique with highlighted phrases (+ source, if S1 is done) |
| 1:30–1:50 | ROC curve and operating point |
| 1:50–2:00 | Hostinger + Context.dev + Gemini, what's next |

## Presentation (7 slides)
1. Propaganda = signal below the noise floor. 2. Receiver chain. 3. Swarm despreading (SNR). 4. SPRT and CFAR: early and with a target false-alarm rate. 5. ROC + target injection. 6. Architecture on Hostinger + partners. 7. Who it's for and what's next.

## Tech Challenges
| Tech Challenge | Eligibility requirement | Status |
|---|---|---|
| ✅ Context.dev | ≥1 endpoint in the core + a note on "which ones and why" (in the description + README section, T17) | MUST, core |
| ✅ Gemini | Why it matters (in the description) | MUST |
| ◐ Codex | Links to issues/PRs, screenshots, `docs/codex-log.md` (maintained by P2 along the way) | Maybe later: writing code with Claude for now. Only select if actually used |
| ❌ Oxylabs, Gemma, Nemotron, Modal / Verda, Aiven, CRACI | — | CUT (see [architecture.md](architecture.md#scope-must--should--cut)) |
