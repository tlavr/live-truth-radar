# Питч и описание · Live Truth Radar · T17 (черновик v1)

*Основа: речь Тимура (`pitch-draft.md`, 14.11), [submission-draft.md](submission-draft.md), числа из `eval/report.json` (generated_at 2026-11-14T11:31:50Z, embedder `gemini`). Текст слайдов и заметки спикера на английском, потому что питч для судей на английском.*

**Правила черновика**
- В слайдах только то, что реально работает в демо. Всё из бэклога помечено как *roadmap*.
- Перед сабмитом сверить каждое число с живым `/api/metrics` (таблица в конце). Если число поменялось, меняем его здесь и в описании.
- Fallback из T2 говорим честно: в живом потоке «аккаунт» = домен издателя (news search), рой ботов показываем на синтетических аккаунтах, которые мы подмешиваем в живой поток.
- Хронометраж: ~3 минуты, 8 слайдов (в карточке было 7: при нехватке времени слайд 7 сливаем с 6).

---

## Слайд 1 · Two wars

**On the slide**
- Title: **Two wars, two battlefields**
- Left half (photo/icon): *Visible war*: drones, bullets, explosions.
- Right half: *Invisible war*: attacks on opinion, on public support, on how laws get passed.
- Footer: Live Truth Radar · The Kerfufflers · Junction 2026

**Speaker notes (~20 s)**
> Every war today is fought on two fields. On the visible one, drones fly and people die. On the invisible one, the target is what people believe: who they support, which laws pass. The second war has no explosions, so it is much harder to see.

---

## Слайд 2 · The battlefield already solved this

**On the slide**
- Title: **Radar engineers solved "signal vs noise" 100 years ago**
- A soldier needs two things: **communication** (get fresh data through a noisy channel) and **detection** (see the incoming drone).
- Signal processing answers both: how to pull a weak signal out of noise, and how to decide *target or not*.
- Our move: **noise** = ordinary people posting; **target** = a coordinated bot swarm pushing one message.
- One line: *Bots whisper below the noise floor. Alone, no account stands out; together they carry one message.*

**Speaker notes (~25 s)**
> On the real battlefield this problem is solved. Radar tells a drone from background clutter, and radio pulls a weak signal out of noise. The math has been refined for about a hundred years. We take that math to the information war. Real people are the noise. A bot swarm is the target: each bot is too quiet to flag alone, but together they carry one message. AI is what makes this possible now: embeddings turn text into signals we can correlate.

---

## Слайд 3 · Two hypotheses, four outcomes

**On the slide**
- Title: **Is there an attack? A radar decision, not a guess**
- H0: no coordinated campaign · H1: coordinated campaign.
- 2×2 grid: detection · miss · **false alarm** · correct rejection.
- **Likelihood ratio** for each group of accounts.
- **Neyman–Pearson**: we *fix* the false-alarm rate first (target 2%), then detect as much as possible.

**Speaker notes (~25 s)**
> Like a radar, we test two hypotheses: H1, there is a coordinated campaign, and H0, there is not. There are four outcomes, and the dangerous one for a real person is the false alarm: calling a human a bot. So we use the Neyman–Pearson rule. We choose the false-alarm rate in advance, two percent, and inside that limit we catch as much as we can.

---

## Слайд 4 · Adaptive threshold and early decision

**On the slide**
- Title: **CFAR + SPRT: adapts to the noise, decides early**
- **CFAR** (constant false-alarm rate): the threshold follows each topic's own background. World Cup final or breaking news: the noise floor rises, the threshold rises with it, bots still stand out.
- **SPRT** (sequential likelihood-ratio test): evidence adds up post by post; three answers: *coordinated*, *organic*, *keep watching*.
- Number: **decision after 4.2 posts on average** (synthetic tests).

**Speaker notes (~25 s)**
> Two classic radar tricks. First, CFAR: the threshold is not fixed. When everybody talks about a football final, the background gets loud, and the threshold rises so we do not panic about real fans. Second, SPRT: we do not wait for the end of the window. Each new post adds evidence, and the test stops as soon as it is sure, on average after about four posts. If it is not sure, it says "keep watching" instead of accusing anyone.

---

## Слайд 5 · Meaning as a signal

**On the slide**
- Title: **Embeddings turn posts into signals we can correlate**
- Every post → Gemini embedding. Every account → a signal in **time × meaning**.
- Pair correlator: same message in different words, at the same moment → correlation peak.
- **Ambiguity surface** (screenshot of the dashboard): axis 1 = time lag, axis 2 = semantic mismatch. A swarm = one sharp peak; organic talk = flat.
- Gemini reads the whole cluster and explains the verdict in plain language, quoting the key phrase.

**Speaker notes (~25 s)**
> Here is where AI comes in. Every post becomes a vector with Gemini embeddings, so a reworded message still matches. Every account becomes a signal in time and meaning. When a swarm posts the same idea at the same moment, the correlation shows one sharp peak on this surface: time lag on one axis, difference in meaning on the other. Organic talk looks flat. Then Gemini reads the whole cluster and explains to a human, in plain words, why we raised the alarm.

---

## Слайд 6 · Honest numbers

**On the slide**
- Title: **Measured like a radar: Pd at a fixed Pfa**
- ROC curve (from `/metrics`) with the operating point.
- **0 false alarms** in tests (limit we set: 2%) · **98.5% of injected campaigns detected** (swarms of 6, 8, 12 bots → 100%).
- Smallest swarm, **3 bots: 78%**: our honest weak spot.
- **Swarm purity 99.4%**: accounts we flag together really belong to the same swarm.
- Live test: two campaigns injected back to back into the live stream, **caught in 13 s and 21 s**.
- A real news reprint (many outlets copying one wire story) was **downgraded to "keep watching"**, not called a bot attack.
- Small print: *live precision is measured on a very small labelled set, so we do not claim a number yet.*

**Speaker notes (~30 s)**
> We report results the way radar engineers do: detection probability at a fixed false-alarm rate. On our test campaigns we got zero false alarms, under the two percent limit, and caught 98.5 percent of the swarms. Swarms of four bots or more we catch almost always. Three bots is hard, 78 percent, and we say so. On the live system we injected two campaigns back to back, and both were caught, in 13 and 21 seconds. And when many news sites reprinted the same agency story, the radar did not shout "bots": it said "keep watching". On real accounts our labelled set is still very small, so we do not claim a live precision number.

---

## Слайд 7 · Live on Hostinger

**On the slide**
- Title: **Running live, right now**
- Diagram: Context.dev (news search) → worker → detector (Gemini embeddings, CFAR, SPRT) → Postgres → FastAPI → dashboard, all in Docker Compose on a **Hostinger VPS** with HTTPS.
- QR code + URL of the live dashboard.
- Partners: **Hostinger** (VPS, domain, AI Router fallback) · **Context.dev** (live web antenna) · **Gemini** (embeddings + explanations of whole clusters).
- Honest line: *live accounts are news publishers; bot swarms are synthetic accounts injected into the live stream.*

**Speaker notes (~20 s)**
> This is not a slide demo. It runs live on a Hostinger VPS. Context.dev is our antenna to the live web, Gemini gives the embeddings and explanations, and Hostinger AI Router is the backup. One honesty note: the live feed is news, so the "accounts" there are publishers, and the bot swarms you see are test campaigns we inject into that live stream. Scan the code and try it yourself.

---

## Слайд 8 · What's next and finale

**On the slide**
- Title: **Signal processing for the invisible war**
- Coming next (roadmap, not in the demo yet):
  - **"How we reached the verdict"** page: step by step from topic beam to correlation, CFAR, SPRT and the final explanation.
  - **Your own false-alarm level**: a slider so a fact-checker chooses how cautious the radar is.
  - Then: real social feeds, source trust, browser extension.
- For: **fact-checkers, journalists, moderators**.
- Closing line: *We show, with known probabilities, where an attack is and where it is not.*

**Speaker notes (~20 s)**
> Next, every alert gets a step-by-step page that shows exactly how the radar reached its verdict, and users get a slider to choose their own false-alarm level. The math that protects soldiers from drones can protect people from invisible attacks on what they think. We show, with known probabilities, where an attack is and where it is not. Thank you.

---

## Описание проекта (финальный кандидат, вставить в форму Junction)

*Сделано из [submission-draft.md](submission-draft.md) с подставленными числами и честным fallback T2. Source Trust (S1) и Codex убраны, потому что их нет в демо; если S1 заработает вживую, вернуть строку из драфта.*

```markdown
## The idea: propaganda is a signal hidden in noise
Every war today has a visible battlefield and an invisible one: attacks on what people believe. On the visible one, radar engineers solved "signal or noise?" long ago. We bring that math to the invisible one.

A coordinated campaign behaves like a spread-spectrum signal: each bot posts too little to flag alone, but together they share one "code", the same moments of activity and the same message in different words. Detectors that judge one post at a time cannot see them. **Live Truth Radar is a receiver for that signal.**

## The receiver chain
`Live web (Context.dev) → Gemini embeddings → pair correlator (time × meaning) → CFAR + SPRT detector → explained verdict`

- 🎯 **Matched filtering in meaning space**: posts are compared in embedding space after removing the topic's common background, so a message is found even when reworded, with no template bank.
- 🐝 **Spot the swarm**: each account is a signal in time × meaning. Organic users look like independent random codes; a coordinated group shows a correlation peak at a common lag. Combining the account pairs of a cluster raises the SNR, shown before and after.
- 📈 **CFAR alerting**: the threshold adapts to each topic's own background, so the false-alarm rate stays constant for busy and quiet topics alike.
- ⚖️ **SPRT decision**: a sequential likelihood-ratio test adds evidence post by post and decides *coordinated*, *organic* or *keep watching* as early as possible, with error rates we set.
- 🎭 **Explain the technique**: Gemini reads the whole cluster, names the manipulation technique, quotes the key phrase and explains why in plain language.

## Honest, measurable detection
We follow Neyman–Pearson: fix the false-alarm rate first (2%), then maximise detection.
- On injected test campaigns: **0 false alarms, 98.5% of campaigns detected**, a decision after **4.2 posts** on average. Swarms of 6+ bots: 100%; the smallest, **3-bot swarms: 78%**, our known weak spot. Swarm purity 99.4%.
- **Live test-target injection**: two campaigns injected back to back into the live stream were caught in **13 s and 21 s**.
- A real news reprint (many outlets copying one story) was downgraded to *keep watching* instead of being called coordinated.
- Live precision on real accounts: our hand-labelled set is still very small, so we do not report a number yet.

The detector has no template bank and is never trained on the synthetic campaigns, so the scores are not circular. When evidence is weak, the verdict stays *keep watching* instead of accusing a real person. Known failure cases are listed on the metrics page.

**Honesty note on data:** Context.dev news search gives fresh articles with timestamps; social feeds were not reachable by topic during the hackathon. So in the live stream an "account" is a news publisher, and swarm detection is demonstrated on synthetic accounts that we inject into the real live stream.

## Explainable verdicts
Each alert shows evidence a human can check in seconds: the correlated accounts and their timing, the reworded posts that matched, the quoted key phrase, and an ambiguity surface (time lag × semantic mismatch) where a swarm shows up as one sharp peak.

## Deployed live on Hostinger
Docker Compose on a Hostinger VPS with a public HTTPS domain: FastAPI, a detector worker and Postgres. The worker polls Context.dev every few minutes, so alerts follow the live web. Gemini is the main model, with Hostinger AI Router as a fallback. Public dashboard and REST API.

## Who it is for
Fact-checkers, journalists and moderators: know in minutes whether a trend is organic or coordinated.

## Partner technology
- **Hostinger**: VPS, domain and AI Router host the whole live system.
- **Context.dev**: our antenna to the live web. News search gives fresh articles with publish times, which become activity signals, and also lets us tell a coordinated push from an honest reaction to breaking news.
- **Gemini**: embeddings for the matched filter, and long-context reasoning over a whole cluster to explain the verdict with quoted evidence. It judges the group, not one post.

## What's next
A step-by-step "how we reached the verdict" page for every alert, a user-chosen false-alarm level, real social feeds, source trust, and a browser extension.

*Team The Kerfufflers · Junction 2026*
```

---

## Сверка чисел перед сабмитом

| Число | Где в тексте | Откуда сейчас | Проверить в живом `/api/metrics` |
|---|---|---|---|
| 0 ложных тревог при лимите 2% | слайд 6, описание | `operating_pfa` = 0.0, alpha = 0.02 | `operating_pfa` |
| Обнаружение 98.5% | слайд 6, описание | `detection_rate` = 0.985 | `detection_rate` |
| 4.2 поста до решения | слайд 4, описание | `mean_posts_to_decision` = 4.16 | `mean_posts_to_decision` |
| Рой из 3 ботов 78%, 6+ ботов 100% | слайд 6, описание | `pd_by_size` | `pd_by_size` |
| Чистота роя 99.4% | слайд 6, описание | `swarm_purity` = 0.9942 | `swarm_purity` |
| Живые инжекты пойманы за 13 с и 21 с | слайд 6, описание | проверка деплоя на VPS (не из report.json) | повторить инжект перед питчем, обновить секунды |
| Перепечатка новости → «keep watching» | слайд 6, описание | проверка на живом потоке (не из report.json) | показать на дашборде или убрать |
| Live precision | слайд 6, описание | `n_labelled` = 0, `live_precision` = null | если T14 дал разметку, подставить число и интервал |
