# Live Swarm Radar like a real radar: signal processing against propaganda

*The Kerfufflers · brainstorm · Fri 13.11*

## 0. Core metaphor (one-sentence pitch)

> **Propaganda is a wideband signal hidden below the noise floor. Each bot "whispers" quietly, but if you add them up the right way, the campaign emerges from the noise. We built a receiver that does this in real time.**

Why this is strong for the Context.dev tech challenge: there is 30% for technical execution (accuracy, latency, changes over time) and 30% for centrality of live data. Radar theory is specifically about **detecting as early as possible at a given false-alarm probability**. And the name already matches: *Live Swarm Radar*.

*What we are actually building: **§3 (agreed engine design)**. Weekend scope: §4 and the canonical list in [architecture.md](architecture.md). §1–2 below is a map of ideas, not a plan.*

### "Radio → Internet" translation dictionary
| Radiophysics | World of propaganda |
|---|---|
| Noise | Ordinary organic human chatter |
| Signal | Coordinated campaign / narrative |
| Antenna, receiver | Context.dev news search + Bluesky `searchPosts` (polling every 2–5 min) |
| Signal sample | Post / article with time, author, text |
| Distorted channel | Platform or media outlet that distorts a fact |
| Multipath | The same text arrives via reposts along different paths |
| False alarm (Pfa) | Accused an honest person |
| Probability of detection (Pd) | Found a real campaign |

---

## 1. Map: concept → detector → doable in a weekend

⭐ = realistic to build over the weekend · 🎤 = very strong for the pitch

| # | Concept | What it catches | How to build | ⭐ | 🎤 |
|---|---|---|---|---|---|
| 1 | **Correlation receiver / matched filter** | Narrative, even paraphrased | Post embedding · "template" embedding = cosine correlation | ⭐⭐⭐ | 🎤🎤 |
| 2 | **Spreading sequences (CDMA) + "despreading"** | Bot swarm where each one is below the threshold | Account activity time series → cross-correlation with lag search → clusters | ⭐⭐ | 🎤🎤🎤 |
| 3 | **CFAR threshold** (Constant False Alarm Rate) | Topic surge against background "noise" | Moving average of background over neighboring windows × coefficient | ⭐⭐⭐ | 🎤🎤 |
| 4 | **Likelihood ratio + SPRT (Wald test)** | "Campaign / organic / wait" decision as early as possible | Sum of LLR over incoming features, two thresholds from α and β | ⭐⭐⭐ | 🎤🎤🎤 |
| 5 | **Spectral analysis (FFT, spectrogram)** | Scheduled bots (cron) | FFT of an account's post series → sharp peaks = robot | ⭐⭐⭐ | 🎤🎤 |
| 6 | **SNR in decibels** | "How loud the campaign signal is" | Energy of coordinated part / background energy, in dB | ⭐⭐⭐ | 🎤🎤 |
| 7 | **MMSE / Kalman filter** | Whether a claim is true, across many noisy sources | Weighted combination of sources by their "noise" (reliability) | ⭐⭐ | 🎤🎤 |
| 8 | **Multipath + RAKE receiver** | Original source and echo copies | Earliest "arrival" = direct path, the rest = echoes | ⭐⭐ | 🎤🎤 |
| 9 | **OFDM: subcarriers + pilots** | Which topic is being "pumped", how media distort facts | Topics = subcarriers. Reliable sources = pilots for estimating the media "channel" | ⭐ | 🎤🎤 |
| 10 | **OTFS: delay-Doppler** | Spread shape: organic vs. planted drop | 2D map: delay from first post × growth rate | ⭐⭐ | 🎤🎤🎤 |
| 11 | **Successive interference cancellation (SIC)** | Quiet campaign under a loud news story | Subtract the dominant narrative, search the residual | ⭐ | 🎤 |
| 12 | **Channel with errors (BER)** | How a fact mutates along a repost chain | Semantic distance at each "hop" | ⭐⭐ | 🎤 |
| 13 | **ROC, Neyman–Pearson** | Honest metrics | Fix Pfa (FPR), maximize Pd | ⭐⭐⭐ | 🎤🎤 |
| 14 | **Test target injection** | Detector validation | Mix in a synthetic campaign and see if we find it | ⭐⭐⭐ | 🎤🎤 |

---

## 2. In detail, with examples

### 2.1. Matched filter = searching for a narrative by "template" ⭐⭐⭐
**In radio:** you know the pulse shape → correlate the input with it → peak = target.
**In our setup:** "template" = embedding of a known message (for example, "vaccines cause X" or the first post of a new campaign). We correlate each new post with the template:
`corr = cos(e_post, e_template)`
Peak above threshold → the post belongs to the narrative, **even if the words are different** (embeddings capture meaning).
**Example:** template "Finland closes border because of NATO provocation". The post "Border shut down — thanks to NATO games" gives corr 0.83 → ours.
**"Filter bank" bonus:** we keep N templates (known narratives) and run every post through all of them, like a filter bank in a radar.

### 2.2. CDMA and "despreading": the main star of the pitch 🎤🎤🎤
**In radio (CDMA):** the signal is "smeared" by a spreading sequence across a wide band, and its power is **below the noise**. A receiver that knows the code multiplies and sums → the signal grows by a factor of N (**processing gain**), while the noise does not.
**In our setup:**
- Each bot posts little, below the threshold of any "single-account detector".
- But bots in the same campaign share a **common "code"**: the same activity timestamps, the same links, similar texts.
- Let's represent an account's activity as a 0/1 sequence by minute: `a_i[t] = 1` if account i posted on the topic at minute t.
- **Organic humans ≈ independent random codes** → their cross-correlation is near zero (like orthogonal codes).
- **Bots in the same campaign ≈ one code** (sometimes with a shift: "bot 2 posts 3 minutes after bot 1") → **cross-correlation peak at lag τ**.

```
R_ij(τ) = Σ_t a_i[t] · a_j[t+τ]   (normalized)
```
We build the max_τ R_ij matrix → graph → clusters = swarms.
**"Despreading":** we sum the signals of the cluster's accounts coherently (accounting for lags) → total SNR grows ~N times. We show this in the demo: "individually each bot is at −8 dB, together +11 dB, campaign detected".
**Combining with 2.1:** the code is not only time, but also the text vector. Coincidence in time **and** in meaning = a very strong feature.
**Risk:** Timestamps and post authors are needed. Context.dev social endpoints did not provide them (T2), so as of T6b, the social network = Bluesky (author = handle, time = `createdAt`/`indexedAt`). Fallback option (`BLUESKY_ENABLED=0`): news search (authors = domains/article authors) + synthetic swarm.

### 2.3. CFAR: adaptive alarm threshold ⭐⭐⭐
**In radar:** Noise varies everywhere, so the threshold is computed from **neighboring cells**: `T = k · mean(neighbors)`. This maintains a **constant probability of false alarm**.
**In our system:** For each topic, we count the number of mentions in a window of 5 minutes. Threshold = k × average across 10 neighboring windows (with guard cells around them). *k is the CFAR multiplier, not to be confused with α from SPRT.*
**Example:** The topic "elections" has a background of 200 posts/5 min, while the topic "farm in Lapland" has a background of 2. A spike to 260 for elections is normal, whereas a spike to 30 for the farm is an alarm. A fixed threshold would get this wrong, whereas CFAR does not.
**Why for Context.dev:** CFAR is recomputed on each new polling batch, so an alert appears within minutes = real-time operation.

### 2.4. Likelihood ratio and SPRT (Wald test) 🎤🎤🎤
**Idea:** Two hypotheses: H0 = "organic", H1 = "coordinated campaign". Each new feature (text similarity, synchronicity, and identical links — if present in the data) adds an increment:
```
Λ = Σ log( P(feature | H1) / P(feature | H0) )
```
**SPRT (Wald):** We do not wait until the end, but decide **as soon as there is enough evidence**:
- `Λ ≥ log((1−β)/α)` → "campaign!"
- `Λ ≤ log(β/(1−α))` → "organic"
- otherwise → "keep watching"

**Where α** is the acceptable false alarm rate (for example, 2%), and **β** is the acceptable miss rate (10%). At α=0.02, β=0.1: upper threshold log(45) ≈ 3.8, lower ≈ −2.3.
**Example (illustrative numbers):** Post 1 is close to the narrative template (+1.2), post 2 is an almost verbatim repeat (+1.5), and post 3 arrives in the same minute as post 2 (+1.4) → Λ = 4.1 > 3.8 → alarm on the **third** post instead of an hour later.
**Why this is a killer feature:** SPRT mathematically yields the **minimum expected time to decision** for given error bounds. This is the ideal answer to "real-time operation" (Context.dev) and to "honesty about false positives" (we set α ourselves).
**How to obtain the probabilities:** Feature histograms on labeled data (organic vs synthetic/known swarms), or a simple logistic regression → its logits are the LLR.

### 2.5. Spectral analysis: bots "tick" ⭐⭐⭐
**In radio:** FFT shows frequencies, and a spectrogram shows how they change over time.
**In our system:** An account's post time series → FFT.
- **Human:** A peak at 24 hours (circadian rhythm), with the rest spread out (broad spectrum).
- **Cron-based bot:** **Sharp lines** at a period of 15 min, 1 hr, and their harmonics.
**Feature:** Spectral flatness and "peakiness." Little flat noise + sharp lines = bot.
**Demo example:** Spectrograms of two accounts side by side: one shows a "rainbow," the other a "comb."

### 2.6. SNR in decibels ⭐⭐⭐
For each narrative: `SNR = 10·log10(P_coordinated / P_background)`.
It is simply a clean, intuitive number on the dashboard: "Narrative X: +14 dB above noise, rising."

### 2.7. MMSE / Kalman: combining sources for fact-checking ⭐⭐
**In radio:** Multiple noisy measurements of one quantity → optimal estimate = weighting by inverse noise variance.
**In our system:** A claim "the law was passed on November 12." Each source provides a "measurement" (confirms +1 / refutes −1 / does not know 0) with its own reliability σ²:
```
x̂ = Σ (y_k / σ_k²) / Σ (1 / σ_k²)
```
A reliable agency (small σ²) carries high weight, while an anonymous blog carries little. **Kalman over time:** The estimate updates with each new source, and at the same time the reliability of the sources themselves is learned (if a source frequently disagrees with the consensus, its σ² increases).
**Example:** Reuters +1 (σ²=0.1), blog −1 (σ²=2), newspaper +1 (σ²=0.3) → x̂ ≈ +0.9 → "confirmed."

### 2.8. Multipath + RAKE: finding the primary source ⭐⭐
**In radio:** A signal arrives via a direct path and delayed echoes, and a RAKE receiver collects all the paths with its "fingers."
**In our system:** A single story arrives through dozens of reposts. We sort the "arrivals" by time: **first arrival = direct path (primary source)**, and the rest = echoes. The delay spread shows:
- organic: echoes spread out over hours.
- coordinated push: dozens of "echoes" within 2 minutes from new accounts = suspicious.

### 2.9. OFDM: subcarriers and pilots ⭐
**Subcarriers:** We decompose the discussion stream into orthogonal "subcarriers" = topics (embedding clusters or principal components). We monitor the power of each one. A campaign = a sudden **power injection into a single subcarrier**.
**Pilots and channel estimation:** In OFDM, known pilot symbols let us estimate how the channel distorts the signal. In our system, "pilots" = facts we know for sure (official statistics). We observe how a specific media outlet reports them → we obtain the **media outlet's "impulse response"** (how much it exaggerates or distorts). Then we "equalize" its new statements.
Great for the pitch, but too complex for the weekend. Put the pilots idea on the "what's next" slide.

### 2.10. OTFS: delay-Doppler map of a narrative 🎤🎤🎤
**In radio:** OTFS operates in the "delay × Doppler" plane, where each target/reflector is a point.
**In our system:** For each post in a narrative:
- **delay** = time elapsed since the first post of the narrative.
- **Doppler** = rate of change (acceleration) of the stream at that moment, or the growth rate of the account's reach.
2D histogram → image:
- **Organic:** A "diffuse cloud," delays from minutes to days, moderate "Doppler."
- **Coordinated push:** A **bright spot** near zero delay with huge "Doppler" (everyone at once and abruptly).
It is easy to build (2D histogram + heatmap) and looks striking. A great visual "wow" for the judges.

### 2.11. SIC: strong-signal cancellation ⭐
First we subtract the dominant organic narrative (the big news of the day), then we look for a weak hidden campaign in the residual. Optional for the weekend.

### 2.12. Channel with errors: fact mutation ⭐⭐
A repost chain = a communication channel. At each "hop", we measure the semantic distance from the original (like bit error rate). A fact that turned into its opposite at hop 3 = a "high-BER channel", and the node where this happened is suspicious.

### 2.13–2.14. ROC + test target injection ⭐⭐⭐
- We show metrics as a **ROC curve (Pd vs Pfa)**, as in radar, and a **Neyman–Pearson operating point**: "at [x]% false alarms, we catch [y]% of injected campaigns" (real numbers from eval).
- **Test target injection:** as in radar, where a test signal is injected. We generate a synthetic campaign (an LLM writes 30 variations, distributed across fake accounts with lags), mix it into the live stream, and measure whether we found it and **after how many seconds**. This is both an honest metric and a live demo.

---

## 3. Agreed engine v1 design (what to build)

*P2 decisions from Sat 14.11 (question by question). **This section is the main one:** where it diverges from §1–2 (idea map), this one is correct. All numbers in the examples are illustrative. Real ones will come from `make eval`.*

```
ANTENNA + BEAM    FRONT END              CORRELATOR              DETECTOR                       DECISION                 DISPLAY
Context.dev,    → Post embedding       → Account pairs:        → Background across all pairs  → SPRT over group posts  → Delay × semantic detuning map,
beam = topic      + whitening            R_ij = max_τ R_ij(τ)    (OS-CFAR) → z_ij →             (α, β)                   traffic light,
(beamforming)     (clutter rejection)    (time × meaning)        swarm ≥ 3 → integration        + news echo              and details
```

### 3.1. Goal (H1)
**Account swarm:** a group of N ≥ 3 accounts posts the same thing in meaning and synchronously in time. The target is not a "narrative" and not a "single bot account" (an account has 3–6 posts per window, which is too few samples for a spectrum).
The verdict is called **"coordinated behavior"**, not "bots" or "propaganda": we measure synchronicity, not intent.

### 3.2. Signal: time × meaning
A post = a sample with two coordinates: time `t` and a unit meaning vector `e` (embedding). An account's signal is vector-valued: `s_i[t] = ẽ` of the post at time t, otherwise 0.
A bank of pre-known templates is **not needed**: each post serves as a reference signal for the others (as in passive radar), and meaning itself works as the code. The narrative template (the centroid of the swarm's posts) comes out as a byproduct, for the card.

### 3.2a. Beamforming: topic = beam
A radar does not listen to the whole sky at once. It steers a beam. Our beam = **the topic we are watching**.
- **Mechanical steering:** a Context.dev query for the topic (the antenna was turned in the right direction). There are 3–5 topics, so this is **multibeam reception**: each beam is processed separately, with its own background and its own CFAR threshold (§3.5), so a noisy topic does not drown out a quiet one.
- **Digital beamforming:** a topic has a steering vector `â_topic` in meaning space. A post's gain = its projection onto the beam: `b_p = clip((⟨e_p, â⟩ − c_lo) / (c_hi − c_lo), 0, 1)`. A post in the main lobe (on-topic) gets weight 1, while junk that search caught by accident falls into the **sidelobes** and is suppressed. In the correlator, a pair of posts enters with weight `√(b_p · b_q)`.
- **Deriving `â`:** Compute `ē_topic`, the robust mean of the topic embeddings in the window. Give each account one vote so a swarm cannot pull the beam toward itself. Normalize the mean to unit length using `â = ē_topic / ‖ē_topic‖`. Each post is decomposed into two parts: the projection onto the beam `⟨e, â⟩` answers "is the post on-topic?", and the residual `e − ⟨e, â⟩·â` carries the "code" for the correlator (§3.3). One decomposition, two roles.
- **On the display:** the topic switcher = beam selection ("where the radar is looking"). Each beam has its own background level, but that is an internal detector value and is not shown on screen.
*Example:* the "tram fares" topic. The post "fare hike is a scam" has projection 0.6 → in the beam, weight 1. A post about hockey that landed in the results because of the word Helsinki has projection 0.1 → sidelobe, weight 0, excluded from correlation.
Start: `c_lo` = 0.15, `c_hi` = 0.35. These numbers are tuned for the hash embedder. For Gemini, the cosine "floor" is higher, so we will recalibrate the beam thresholds on a live sample (I1) and in T15.
**Calibration (`detect/calibrate_beam.py`):** the topic beam is built only from organic posts (in the detector window, the beam is also anchored on organic posts: one vote per account and 20% cutoff), while swarm posts and synthetic variations do not form it. `c_lo` = median and `c_hi` = q90 of the projections of posts from **other** topics onto this beam: half of other-topic posts get weight 0, and everything above 90% of other-topic posts gets weight 1. The topic's own swarm posts and synthetics do not participate in choosing its thresholds (the detector does not train on the target). Other topics may also be synthetic. Why not from posts of the topic itself: with Gemini, cosines are compressed (other topic 0.79–0.83, on-topic swarm 0.82–0.87, organic 0.87–0.91), and `c_hi` taken from organic posts (it was 0.88) cut the weight of swarm posts in half: Pd of a swarm of 3 accounts 0.28 instead of 0.60 (`eval/report.json`, Sat 14.11). T15 (Sat 14.11): recomputed on live data (6 topics, 289 organic posts): 0.78 / 0.80.
**Known beam limitation (Sat 14.11, before T15; resolution below):** in Gemini, the projections for "on-topic propaganda, but far from the organic center" and "unrelated topic" overlap and cannot be separated by a threshold. Example: variations of the message "fare hike is a scam to fund politicians' pet projects" have a projection ≈ 0.80 (unrelated-topic median 0.807) and receive beam weight 0.00–0.34, even though their similarity to each other is 0.92–0.96. A volley of this message produces no echo, SPRT accumulates −3 over three posts (lower threshold −2.28), and calls `organic` before the second volley. These account for all misses on small swarms (60 windows per size: Pd 3 accts. 0.75, 4 accts. 1.00 at 0.81/0.83). Verified: relaxing the SPRT clamp (−0.5) does not help. Beam 0.78/0.84 yields Pd 3 accts. 0.98, but unrelated-topic posts pass through with weight ≈ 0.47 (was 0.22). The cost of this leakage cannot be measured on fixtures (they contain no search junk, so Pfa = 0 under either option), so we are not changing the thresholds until we have a live sample. Options for T15: relax the thresholds based on Pfa on live data, or steer the beam using the topic query text instead of the organic center (changes §3.2a). The 12-account inject (demo) is unaffected: Pd = 1.0.

**Resolution T15 (Sat 14.11):** the thresholds are taken from the same calibration, but on live data: 0.78 / 0.80. On eval windows (α = 2%, 4 inject topics, 313 background windows, 200 windows per swarm size): false alarms are 0 / 313 under both old and new thresholds, and the number of `watching` on background is the same (32). Swarm Pd for 3 / 4 / 6 / 12 accounts: 0.57 / 0.86 / 0.97 / 0.99 → 0.94 / 0.99 / 1.00 / 0.99. Eval windows contain a single topic, so Pfa = 0 covers in-topic search junk, but not unrelated-topic posts. Cost: the threshold is shared across all topics (mean of quantiles), and a topic beam with high background lets unrelated-topic posts through: for `helsinki-tram-fares`, weight > 0 on 98% unrelated-topic posts (weight 1 on 73%), and for live topics 11–51% (weight 1 on 2–22%). Under 0.81/0.83 it was 1–40%. In a live window, unrelated-topic posts rarely appear: the worker selects topic posts by headline keywords, and `helsinki-tram-fares` is synthetic-only. Topic-query beam steering and per-topic thresholds were not implemented.

### 3.3. Noise (H0) and clutter suppression
The noise is not white: people in the same topic are similar (cos of two random posts ≈ 0.3–0.4). This is clutter. We remove it via **whitening**: we subtract the projection onto beam `â` (§3.2a) from each post and normalize the residual,
`ẽ = norm(e − ⟨e, â⟩·â)`.
If the residual is near zero (the post is purely "general topic"), `ẽ = 0`: such a post correlates with nothing.
*Intuitively:* an air conditioner is humming in the room, so all microphones hear it and appear "similar." Subtract the hum, and only speech remains.
*Example (3 coordinates: "about fares", "politicians' scam", "crowded tram"):* humans `(0.9, 0.44, 0)` and `(0.9, 0, 0.44)`: cos 0.81 → after subtracting the projection onto beam `(1, 0, 0)`, `(0, 1, 0)` and `(0, 0, 1)` remain, cos 0. Bots `(0.9, 0.44, 0)` and `(0.9, 0.40, 0.17)`: cos 0.98 → 0.92. Contrast increased.

### 3.4. Pairwise correlator
For posts p (account i) and q (account j): semantic similarity `c_pq = √(b_p·b_q) · max(0, ⟨ẽ_p, ẽ_q⟩)` (b = beam gain, §3.2a), delay `Δt_pq = t_q − t_p`.
```
R_ij(τ) = Σ_{p,q} c_pq · g(Δt_pq − τ) / √(n_i · n_j)      g = window of width Δ = 30 s
R_ij    = max_{|τ| ≤ τ_max} w(τ) · R_ij(τ)                  w(τ) = exp(−|τ| / 2 min),  τ_max = 10 min
lag_ij  = τ at the maximum
```
Only a pair of posts close **in both time and meaning** contributes. Repeated volleys with the same lag accumulate in a single τ bin (this is the "shared code"), but they are not required: the detector must trigger on **a single dense volley** (the inject places the campaign within 15 minutes).
*Example:* bot 1 at 12:00:10, bot 2 at 12:01:30, cos 0.9 → contribution 0.9 at lag 80 s (weight ≈ 0.5). Same response after 40 minutes → 0.
The parameters (`τ_max`, `Δ`, kernel) live in the config: you can run **a second analyzer in parallel** ("slow", `τ_max` = 60 min), like a filter bank with different passbands.
*Limitation (for the slide):* the main channel does not see a slow campaign posting once an hour.

### 3.5. Background and threshold (pairwise CFAR)
Reference cells = all other account pairs in the same topic and window (OS-CFAR, order statistics):
`z_ij = (R_ij − median) / σ_R`, where `σ_R = max(1.4826 · MAD, σ_R,min)`. A pair "lights up" if `z_ij > k` (initial k = 3).
**The floor `σ_R,min` = 0.05 is required:** in a sparse live stream, most pairs have `R_ij` = 0 (no posts closer than 10 minutes), so both the median and MAD are zero, and without the floor there would be division by zero.
**Minimum reference cells (2000):** if there are fewer pairs in the topic, the background is padded with pairs having `R` = 0 (two unrelated accounts, the value under H0). Otherwise, in a quiet topic where the swarm makes up the majority of accounts (an inject into a topic with 0–3 live accounts), the median settles at the swarm's own level and it goes undetected. Previously it was 200: two consecutive injects (24 accounts, 276 pairs) were already enough for the swarm pairs to outweigh the padding, leaving the topic with no detections (found on VPS 14.11). At 2000, a topic is considered quiet up to roughly 45 accounts (2–3 injects). In a large topic (≥ 2000 pairs), the median remains the background, and a uniformly "noisy" topic produces no alarms.

**Inject lifetime (`synthetic_ttl_sec` = 900 s):** a synthetic campaign participates in detection for 900 s after its last post (which is 4–6 min before the click, i.e., ~9–11 min after the click), and then drops out of the window completely. Repeated injects do not accumulate in the 6-hour window. This works when the worker passes `now` to `detect` (`ingest/worker.py::load_detector`, added with Timur's approval 14.11). Nothing is dropped in tests and eval (`now=None`).
Swarms are few and pairs are many, so the median is robust to the targets themselves. The threshold adapts automatically: the false alarm rate is the same during peak hours and in a quiet topic.

### 3.6. Swarm assembly, integration, SNR
- Graph: edges exist where `z_ij > k`. A swarm is a connected group of **≥ 3 accounts** (a pair can be coincidental or a dialogue).
- Coherent integration over **all** M = N(N−1)/2 pairs in the group (including pairs without an edge): `Z = Σ z_ij / √M`. Signal grows as M, noise as √M, processing gain is `10·lg(M)` dB.
- **`snr_db_single` = 20·lg(mean z_ij)**, **`snr_db` = 20·lg(Z)**. This is the same statistic before and after integration, and the difference equals the gain exactly. If mean `z_ij` ≤ 0.1, we take 0.1 (−20 dB) so the logarithm is defined. (The option "account post rate vs. background" was rejected as non-rigorous.)
*Example:* 6 accounts, 15 pairs at 4σ (+12 dB, slightly above threshold k = 3) → Z = 15·4/√15 ≈ 15.5σ (+23.8 dB), gain 11.8 dB = 10·lg(15).

### 3.7. Decision: SPRT
Observations = posts from group accounts ordered by time, **starting from the second** (the swarm's first post is the "probing pulse" and has nothing to respond to). The post feature, **"echo"**, is causal (looks backward only, as in real time): `x_k = max` over **earlier** posts from other accounts in the group from `c_pq · exp(−Δt/2 min)` at `0 ≤ Δt ≤ τ_max`. If there are none, `x_k = 0`.
Gaussian model with mean shift (Wald's classic):
- H0: `x ~ N(μ0, σ²)`. We measure μ0 and σ robustly over the background: the same causal feature for each post in the topic relative to posts from **all** other accounts in the topic, but only over posts from accounts **outside** the group under test (guard cells, as in CFAR: the target is excluded from its own background). If there are fewer than 30 such posts, the background is padded with echo 0 (single post). μ0 = median, σ = max(1.4826·MAD, σ_min), `σ_min` = 0.15. The median prevents the swarm from "pulling up" the background, and the floor is needed because most organic posts have echo equal to 0.
- H1: `x ~ N(μ1, σ²)`, μ1 = **design parameter "minimum target"** (initial: 0.5), not learned.
```
ΔΛ_k = (μ1 − μ0)/σ² · (x_k − (μ0 + μ1)/2),   clipped to ΔΛ_k ∈ [−1, +1.5]
Λ ≥ ln((1−β)/α) → coordinated;   Λ ≤ ln(β/(1−α)) → organic;   otherwise watching
```
Clamp = robustness to outliers (one post does not decide everything). Nothing is trained on synthetic data, so eval is not circular.
*Example (μ0 = 0.1, σ = 0.25, μ1 = 0.5; thresholds +3.8 / −2.3):* three echoes of 0.65 → +1.5 ×3 = 4.5 ≥ 3.8 → alarm on **swarm post 4** (first post has no echo, followed by three observations). Three echoes of 0.05 → −1 ×3 = −3 ≤ −2.3 → organic.

### 3.8. False target: "news echo"
Breaking news excites everyone with a single external pulse, and honest people post the headline synchronously. Check: if an article (`source = context_news`, author not from the group) with the same meaning (cos > 0.8 between the **whitened** vectors of the article and the group centroid) was published within 60 minutes before the group's first post in the topic, the group is labeled "news echo" and cannot become `coordinated` (at most `watching`). In `Finding.note`: "news echo: <first 80 characters of the article text>". Remaining errors go to `failure_examples`.
Articles participate in the correlator like regular posts (author = outlet). In fallback mode `[ALT]` (no social authors, all accounts are outlets), the rule turns itself off: it runs only if the topic window contains `context_social` posts (before T6b, the live stream consisted only of news. Since T6b, the window includes Bluesky posts, and the rule is enabled). Otherwise it would block every injection into a news topic. The `news_echo_enabled` flag in the config disables it everywhere.

**News reprint.** A group in which **all** posts (since 15.11, at least half) are `context_news` articles (outlets reprint the same wire story minutes apart) also cannot become `coordinated` (at most `watching`). In `Finding.note`: `news reprint: <first 80 characters of the earliest article in the group>`. The rule also works in `[ALT]`: outlets are not people, and a swarm consisting solely of outlets is syndication, not a campaign. A group with at least one synthetic post is unaffected by it (before 15.11, also one with a social post, see below), so an injection into a news topic remains `coordinated`. Found on VPS 14.11: microsoft-global-outage, 7 outlets with AP text in one minute produced `coordinated`. With the rule on the same window, `watching`. Flag `news_reprint_enabled`. **Since 15.11 (50 topics):** the rule triggers if articles make up **at least half** of the group's posts (`news_reprint_min_share = 0.5`; 1.0 is the former "all posts") and there are no synthetic posts in the group. Reason: live false alarms on new topics. Outlets publish a wire story and simultaneously post it to Bluesky from their accounts, so a group has 30 articles + 1 post (new-orleans-cruise-tanker), 14 + 12 (spacex-starship), 4 + 2 (faa-ground-stop), and the "all posts" rule did not trigger. "News echo" does not catch such groups: after whitening, the cosine of the article to the post centroid is ≈ 0 (raw ≈ 0.9), while the threshold is 0.8. On a live window of 49 topics (15.11, read-only): real `coordinated` 11 → 4. The remaining ones are groups with no articles inside (3 sports accounts with verbatim AP text, 7 Czech news accounts): indistinguishable in form from copy-paste, a limitation. Cost: a real campaign whose group has at least half articles will also become `watching`. Eval (15.11, same 48 h background): with live `cfar_k` = 3, Pfa 0.038 → 0.013, Pd 0.91 → 0.909. Operating point k = 3.5 (Pfa 0.010, Pd 0.912; previously k = 6, 0.013 / 0.856). Pd by swarm size 3/4/6/8/12: 0.82/0.89/0.94/0.92/0.93 (previously 0.72/0.83/0.92/0.91/0.88). `cfar_k` was not changed.

**Viral echo (T6b).** Dozens of real people repeat a meme ("The person responsible for the Microsoft Outage. Wrong answers only.") almost verbatim over the course of hours. The correlator cuts this stream into dense groups, and each looks like copypasta (on the VPS on 14.11 with Bluesky, 8 false `coordinated` on microsoft). Difference from a campaign: the same message circulates in the live stream outside the group as well. If ≥ `viral_echo_min_accounts` (3) accounts **outside the group** before or after the group's first (non-news) post (±`viral_echo_max_age_sec` = ±6 h, or up to the current moment in live mode) wrote the same thing (cos > `viral_echo_cos` = 0.8 between the whitened vectors and the group centroid), the group cannot become `coordinated` (at most `watching`). In `Finding.note`: `viral echo: <first 80 characters of the earliest matching post>`. Why both directions: the window has an edge — the first wave of the meme (or the first reposts of a headline) has nothing earlier inside the window, while subsequent waves from other people follow after it. A fresh campaign brings its own new message, and no one repeats it outside the campaign. Eval 14.11 (48 h of Bluesky background, k = 3): the microsoft background triggers an alert in 21/34 windows without the rule, 9/34 with the "backward-only" rule (version `a227016`), and 4/34 in both directions. Pd did not change. However, eval injects have `source = synthetic` and are not counted as part of the stream by the rule, so this does not prove the rule is safe for real (non-synthetic) campaigns. "Live stream" means only `context_social` / `context_news`. Excluding `source = synthetic` is an intentional asymmetry: demo and eval injects are not part of the live stream, so a repeated red-team attack on the same topic within the window (with the same variation texts) is not suppressed by the previous attack (and vice versa). A real campaign arriving as `context_social` is counted as part of the stream — this is a documented limitation. Limitations: a second wave of a real campaign using new accounts that repeats the first wave drops to `watching`. When later waves are already present in the window, the first wave also drops. In live operation, the first wave manages to raise an alert before the next waves appear, whereas in retrospect (eval, full window) it does not. Like the news echo, it only works when `context_social` posts are in the window. Flag `viral_echo_enabled`, code `detect/viral_echo.py`.

### 3.9. Display
**Main screen (for a general audience):**
- traffic light + one sentence: "🔴 6 accounts are saying the same thing almost simultaneously. Target false-alarm rate: 2%" (number = measured `MetricsReport.operating_pfa`, or design α = 2% until a report is available).
- topic switcher = beam selection (§3.2a).
- **ambiguity surface**: 2D map over pairs of posts from different accounts. X = delay |τ| (0–10 min, step 30 s), Y = semantic detuning `1 − max(0, cos)` after whitening (0–1, step 0.1; the second mismatch coordinate, like Doppler in radar), brightness = number of pairs. Two layers: pairs inside the swarm (`counts`) and all other pairs in the topic (`background`). Organic = a flat, low "carpet", and a swarm = a sharp peak in the corner ("thumbtack"). This is an internal detector statistic (§3.4), not a separate image. The map includes pairs with `|τ| ≤ τ_max` (the boundary is included in the last bin). *Do not confuse with the delay-Doppler map from §2.10 (delay from the first post × growth rate): that one is in CUT.*

**Details tab:** `correlation` heatmap with `lag_sec`, SPRT trace with thresholds, SNR "before → after" in dB.

### 3.10. Metrics (Pd, Pfa, precision)
One trial = one window (6 h of a single topic).
- **Pfa** = fraction of windows **without a target** (background: live sample, live background over 48 h `fixtures/items_live_background.json`, and fixture organic data, augmented by time shuffling) that contain at least one `coordinated`. Plus **"honest" windows** (`real`): a topic's live feed sliced into non-overlapping 6-hour chunks without shuffling. Only these are independent trials, so in `eval/operating_points.json` we separately report `n_independent`, `pfa_independent`, and the 95%-bound `pfa_independent_upper95` for them (augmented windows are correlated, and their "3/N" bound is too optimistic).
- **Pd** = fraction of windows **with an inject** (held-out phrases) where a `coordinated` is found in which ≥ half of the accounts are actually from the inject **and** which covers ≥ half of the inject's accounts.
- **ROC** = (Pfa, Pd) curve as the CFAR threshold `k` sweeps (via `detect/config.py`, with α and β fixed). **Neyman–Pearson operating point:** among `k` with Pfa ≤ 2%, we take the one with the highest Pd (on ties, the larger `k`). Pd as a function of `k` is not monotonic: at very low `k`, the swarm merges with background accounts and fails the purity check. We report Pd at this operating point. T15: on our background, the Pfa constraint has no effect (Pfa = 0 for any `k`), the operating point comes out to `k` = 4 based on Pd alone (at 2–4, Pd is the same), and the default was kept at `k` = 3. `pd_by_size` and time to decision in the report are computed at `k` = 4 (at 3, the difference is ≤ 0.5 pp).
- **Time to decision:** posts and seconds from the first post of the swarm to the SPRT threshold (the feature is causal, §3.7, so the figure is valid for real time).
- **Detection curve:** Pd versus the number of accounts in the swarm (3, 4, 6, 8, 12) at a fixed Pfa. Ready-made slide on limitations.
- **Precision on live data only.** `precision = Pd·π / (Pd·π + Pfa·(1−π))` depends on the fraction π of windows with a swarm, which we set ourselves in synthetic data (at Pd 87%, Pfa 2%: π = 0.5 → 98%, π = 0.01 → ≈ 31%), so we do not publish "synthetic precision".
  - **Live precision** (unit = account): real accounts from `coordinated` (target ~25), labeled "suspicious / organic / unclear". `precision = suspicious / (suspicious + organic)`. Accounts additionally sampled from `watching` are labeled, but **not** included in the formula. We write the "unclear" count on the slide and in the report note (there is no separate field in the contract). Always include the Wilson interval (16/21 = 76%, 55–89%).
  - **Live FPR** = `P(alert | organic)` with **reweighting** of the stratified sample by the actual alert share (example: 400 accounts, 20 with an alert, 24% organic among alerts → ≈ 5 false; organic without an alert ≈ 350 → FPR ≈ 1.4%). "Alert" here = `coordinated`. Reweighting requires stratum sizes: total accounts and accounts with an alert per topic (`eval/labels_meta.json`, see T14).
  - **Swarm purity** (synthetic, auxiliary): fraction of accounts in the detected group that are actually from the injection (6 out of 7 → 86%). Does not depend on π.
- Caveat for the slide: we do the labeling ourselves using a rubric. This is not an independent expert review.

### 3.11. Contract fields for this design (agreed by P1 + P2, Sat 14.11)
All fields are **optional**. Old code and old fixtures do not break. Source of truth: `contracts/models.py`.
- `Finding.ambiguity: AmbiguityMap | None` = `{lag_edges_sec, mismatch_edges, counts[][], background[][] | None}`: grid for the ambiguity surface (there are no embeddings on the frontend, so only the detector can compute it). `counts[m][l]` = number of swarm post pairs in cell (detuning m, lag l).
- `Finding.note: str | None`: detector annotation, for example "news echo: <beginning of article text>".
- `MetricsReport.pd_by_size: list[(n_accounts, pd)]`, `swarm_purity: float | None`, `live_precision_ci: (lo, hi) | None`.

### 3.12. Analyzer parameters (initial; single list, lives in `detect/config.py`)
| Parameter | Value | Where |
|---|---|---|
| Detector window | 6 h (`DETECT_WINDOW_HOURS`) | worker |
| `τ_max` / `Δ` / kernel | 10 min / 30 s / `exp(−\|τ\|/2 min)` | §3.4, §3.7 |
| Beam `c_lo` / `c_hi` | hash: 0.15 / 0.35; Gemini: 0.78 / 0.80 (`LTR_EMBEDDER=gemini python -m detect.calibrate_beam` on live sample and live background over 48 h, T15, Sat 14.11: q50 / q90 of projections of other topics onto the organic beam; before T15 it was 0.81 / 0.83 on fixtures). `detect()` takes the pair for the embedder that actually succeeded (on Gemini failure, that is hash) | §3.2a |
| CFAR `k` / floor `σ_R,min` / min reference cells | 3 (in MAD sigmas) / 0.05 / 2000 pairs | §3.5 |
| Injection lifetime | 900 s from the campaign's last post (`synthetic_ttl_sec`, only when `now`) | §3.5 |
| Min swarm size | 3 accounts | §3.6 |
| SPRT `α` / `β` | 0.02 / 0.1 → thresholds ln 45 ≈ +3.81 / ln(0.1/0.98) ≈ −2.28 | §3.7 |
| SPRT `μ1` / clamp / floor `σ_min` / min background | 0.5 / [−1, +1.5] / 0.15 / 30 posts | §3.7 |
| "News echo" | cos > 0.8 (whitened vectors) with group centroid, article no older than 60 min before the first post; off in `[ALT]` | §3.8 |
| "News reprint" | ≥ 50% group posts `context_news` and no synthetics (`news_reprint_min_share`) → max `watching`; also active in `[ALT]` (`news_reprint_enabled`) | §3.8 |
| "Viral echo" | ≥ 3 live-stream accounts (not `synthetic`) outside the group, cos > 0.8 (whitened vectors) with group centroid, ±6 h from its first post → max `watching`; off in `[ALT]` (`viral_echo_enabled`). With `DETECT_WINDOW_HOURS` = 6, the ±6 h limit filters nothing out and only matters for longer windows | §3.8 |
| Operating point | Pfa ≤ 2% | §3.10 |
| Second analyzer (optional) | `τ_max` = 60 min, everything else the same | §3.4 |

## 4. What to pick for the weekend

**MVP (required), details in §3:**
1. Topic beam (beamforming) + embeddings + whitening (topic clutter rejection).
2. "Time × semantics" pair correlator with lag search (despreading).
3. Pairwise CFAR (median + k·MAD) → swarm ≥ 3 → coherent integration, SNR in dB.
4. SPRT (Gaussian model, clamp) → decision with specified α, β; "news echo" check.
5. ROC + test target injection → Pd, Pfa, time to decision. Precision and FPR on live labels only.
6. Display: "delay × semantic detuning" ambiguity surface on the main screen, details in a tab.

**Wow layer: CUT.** Scope trimmed down to the core (see [architecture.md](architecture.md)).

**For the "what's next" slide (not building):** delay-Doppler, account spectrograms, MMSE fact-checking, OFDM pilots for estimating the media "channel", SIC, mutation BER.

## 5. How this sells the project to Context.dev judges (tech challenge)
| Their criterion | Our signal-theory answer |
|---|---|
| Creativity, endpoint combination (40%) | Web = airwaves, Context.dev = antenna: news search + social scrape (+ brand/company, SHOULD S1) combined from many weak sources into one strong signal |
| Centrality of live data (30%) | Without the live stream there is not a single alert: CFAR is recomputed on every new polling batch |
| Technical execution: accuracy, latency, changes over time (30%) | **Neyman–Pearson ROC** + "seconds to detection" measurement via target injection. **SPRT** decides in a few posts rather than an hour later |

**Pitch line:** *"Bots whisper below the noise floor. We built a spread-spectrum receiver for the web: Context.dev is our antenna, and a sequential likelihood test tells you a campaign is coordinated after a few posts, at a false-alarm rate you choose."*

## 6. Risks and how to work around them
| Risk | Mitigation |
|---|---|
| No timestamps or authors in the data | Check Context.dev social and news endpoint responses immediately (task T2). Fallback — news search + synthetic swarm |
| Few real swarms over the weekend | Test target injection (serves as both a metric and a demo) |
| Nowhere to get probabilities for LLR | Wald's Gaussian model (§3.7): we measure the background from data, and μ1 = design parameter. We do not train on synthetic data |
| Judges do not know radio engineering | Every term on the dashboard has a plain-language caption ("SNR = how much louder the campaign is than the background") |
