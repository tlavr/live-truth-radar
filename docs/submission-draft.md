# Драфт сабмита v4 · Live Truth Radar · The Kerfufflers
## Основной: Decode the Noise (Hostinger) · тех: Context.dev, Gemini (+ Oxylabs, Codex, если сделали) · идея: обработка сигналов

*Объём урезан до ядра, см. [architecture.md](architecture.md). Правило: в финальном тексте только то, что реально работает в демо.*

# ⏰ БЛОК ДЛЯ PRELIMINARY SUBMISSION (до 23:59), копировать как есть

**Project Name:** `Live Truth Radar`

**Punchline (197/200):**
```
Bots whisper below the noise floor. Live Truth Radar is a spread-spectrum receiver for the web: it despreads coordinated campaigns, names propaganda techniques and reports honest false-alarm rates.
```

**Challenge Picker:** `Decode the Noise`

**Description (короткая версия, 640 символов):**
```markdown
Propaganda campaigns behave like a spread-spectrum signal: each bot account is too weak to flag alone, but together they carry one message. **Live Truth Radar** applies radar and signal-processing math to the live web: matched filters find a narrative even when reworded, cross-correlation of account activity "despreads" hidden swarms, a CFAR threshold raises alerts, and a sequential likelihood-ratio test (SPRT) decides "coordinated / organic / keep watching" at a false-alarm rate we choose. Every verdict is explained in plain language with evidence and sources. Live web data comes from Context.dev; the system runs live on Hostinger.
```

**Source Code:** ссылка на GitHub-репо (можно пустой)

**Tech Challenges (отметить сейчас, можно поменять до вс 10:00):** Best Use of Context.dev: Fully Structured Web · Best Use of Gemini API · Best agentic usecase of Oxylabs Web API · [Best Use of Codex — только если на шаге 0 = да]
*Codex отмечаем, только если на шаге 0 нашёлся человек, который реально пишет им код. Oxylabs снять в финале, если SHOULD-шаг 13 не сделан.*

---

# ФИНАЛЬНАЯ ВЕРСИЯ (до вс 10:00)

## Description (~4883/5000 с пометками [SHOULD], markdown), заменить короткую на эту
*`[скобки]` заменить реальными цифрами, ничего не выдумывать. Строку или фрагмент с пометкой `[SHOULD]` / `[ONLY IF TRUE]` удалить, если это не работает вживую; иначе убрать саму пометку. Замена `[ALT]` — сразу под блоком.*
```markdown
## The idea: propaganda is a signal hidden in noise
In radio, a spread-spectrum (CDMA) signal sits **below the noise floor**: no single sample stands out, but a receiver that knows the code adds the pieces coherently and the signal rises out of the noise.

Coordinated campaigns work the same way. Each bot posts too little to flag alone, but together they share one "code": the same moments of activity, the same message in different words. Detectors that judge **one post at a time** cannot see them. **Live Truth Radar is a receiver for that signal.**

## The receiver chain
`Antenna (live web) → front-end (embeddings + activity time series) → filters → detector → explained verdict`

- 🎯 **Matched filter bank**: each post is correlated with narrative templates in embedding space, so a message is found even when reworded.
- 🐝 **CDMA despreading (Spot the swarm)**: account activity becomes 0/1 sequences per minute. Organic users behave like independent random codes; a coordinated group shows a cross-correlation peak at a common lag. Combining the cluster gives a processing gain of roughly N, shown as SNR in dB.
- 📈 **CFAR alerting**: like radar, the alarm threshold adapts to each topic's own background noise, keeping the false-alarm rate constant for busy and quiet topics alike.
- ⚖️ **SPRT decision**: a sequential likelihood-ratio test accumulates evidence (text similarity and timing) post by post and decides *coordinated*, *organic* or *keep watching* as early as possible, with error rates α and β that we set.
- 🎭 **Name the technique**: Gemini reads the whole cluster, labels loaded language, fear appeal, whataboutism and fabricated authority, highlights the exact phrases and explains *why* in plain language.
- 🔗 **Trust the source** [SHOULD]: company identity and cloned branding behind a domain, from Context.dev enrichment.
- 🌍 **Geo echo** [SHOULD]: the same narrative surfacing in other countries at the same time, via live Oxylabs search with source URLs.

## Honest, measurable detection
We report detection the way radar engineers do:
- **ROC curves (Pd vs Pfa)** and a Neyman–Pearson operating point, e.g. *"at [2]% false alarms we detect [X]% of injected test campaigns"*.
- **Test-target injection**: we hide a synthetic coordinated campaign inside the real live stream and measure whether, and how fast, it is detected (**[N] posts / [T] seconds** to decision).
- A hand-labelled live test set of [N] real accounts, so the false-alarm rate is measured on real people, separately from the synthetic tests. [SHOULD: plus a subset of the SemEval-2020 propaganda techniques corpus for the technique classifier.]

Current results: **detection [X]% of injected campaigns at [Pfa]%; live FPR [Z], precision [P]** on the labelled set. Known failure cases are listed on the metrics page. When evidence is weak, the system says *"uncertain"* instead of accusing a real person.

## Explainable verdicts
Each alert shows the evidence a human can check in seconds: the correlated accounts and their timing, the reworded posts that matched, the highlighted phrases, the source data, the SNR and the SPRT trace showing when the decision was made.

## Deployed live on Hostinger
Docker Compose on a Hostinger VPS with a public HTTPS domain: FastAPI, a detector worker and Postgres + pgvector. The worker polls Context.dev every few minutes, so alerts follow the live web. Gemini is the main model, with Hostinger AI Router as a fallback. Public dashboard and REST API.

## Who it is for
- **Fact-checkers and journalists**: know in minutes whether a trend is organic or coordinated.
- **Moderators**: see campaigns aimed at their community.

## Partner technology
- **Hostinger**: VPS, domain and AI Router host the whole live system.
- **Context.dev**: our antenna. Social scrape gives posts with authors and timestamps, which is what turns accounts into activity codes for despreading; news search gives the fresh articles that define each narrative. [SHOULD: Brand and company enrichment tells who is behind a domain.]
- **Gemini**: embeddings for the matched filters, and long-context reasoning over a whole swarm cluster to name the technique and explain the verdict with quoted evidence. It judges the group, not one post, which is exactly what despreading needs, and it also writes the synthetic test campaigns we inject. Without long context we could only explain single posts.
- **[SHOULD] Oxylabs Web API**: live geo-targeted `/search` as an independent second antenna, with source URLs on every alert.
- **[ONLY IF TRUE] OpenAI Codex**: wrote [the detectors and the evaluation harness]; see `docs/codex-log.md`.

## What's next
Fact-checking with source fusion, change watch for silently edited articles, spectral fingerprints of scheduled bots, delay-Doppler maps of narrative spread, and a browser extension.

*Team The Kerfufflers · Junction 2026*
```

**[ALT] для Context.dev, если на шаге 2 у social scrape нет автора или времени:** заменить в пункте Context.dev предложение «Social scrape gives … define each narrative.» на *"News search gives fresh articles with authors and timestamps, which become the activity codes for despreading."* И добавить в «Honest, measurable detection»: *"Swarm detection is demonstrated on injected synthetic accounts; in the live stream, 'accounts' are news authors and domains."*

## Как текст закрывает критерии Hostinger
| Критерий | Вес | Где |
|---|---|---|
| Качество детекции: точность, FP, объяснимость | 40% | «Honest, measurable detection» (ROC, Neyman–Pearson, инжекция цели), «uncertain», «Explainable verdicts» |
| Техника + живой деплой на Hostinger | 25% | «Deployed live on Hostinger» + Demo link |
| Оригинальность и эффект | 20% | Вся радарная рамка: CDMA-деспрединг, CFAR, SPRT |
| Ясность демо | 15% | Видео ниже |

## Ссылки
| Поле | Что вставить |
|---|---|
| Project Demo | `https://[домен-hostinger]` (**обязательно Hostinger**) |
| Source Code | `https://github.com/[org]/live-truth-radar` |
| Video | YouTube или Loom, ~2 мин |
| Other Link | `https://[домен]/metrics`: ROC и латентность |

## Видео (2 мин)
| Время | Кадр |
|---|---|
| 0:00–0:15 | «Боты шепчут ниже уровня шума»: поодиночке аккаунты не видны |
| 0:15–0:50 | Инжекция тестовой кампании в живой поток → heatmap корреляции загорается → SNR из [−x] дБ в [+y] дБ (реальные числа из демо) |
| 0:50–1:10 | SPRT-трасса: решение «coordinated» на [k]-м посте |
| 1:10–1:30 | Карточка: приём манипуляции с подсветкой фраз (+ источник и гео, если SHOULD сделан) |
| 1:30–1:50 | ROC-кривая и рабочая точка |
| 1:50–2:00 | Hostinger + Context.dev + Gemini, что дальше |

## Презентация (7 слайдов)
1. Пропаганда = сигнал под уровнем шума. 2. Приёмная цепочка. 3. Деспрединг роя (SNR). 4. SPRT и CFAR: рано и с заданной ложной тревогой. 5. ROC + инжекция цели. 6. Архитектура на Hostinger + партнёры. 7. Кому и что дальше.

## Тех-челленджи
| Тех-челлендж | Условие зачёта | Статус |
|---|---|---|
| ✅ Context.dev | ≥1 эндпоинт в ядре + заметка «какие и зачем» (в описании + README-раздел, шаг 17) | MUST, ядро |
| ✅ Gemini | Почему важен (в описании) | MUST |
| ◐ Oxylabs | Живой `/search` + URL источников в демо. ⚠️ Отменить подписку после (шаг 18) | SHOULD: снять, если не сделали. Приз за *agentic* usecase — шансы скромные |
| ◐ Codex | Ссылки на задачи/PR, скрины, `docs/codex-log.md` | Только если реально писали им код |
| ❌ Gemma, Nemotron, Modal / Verda, Aiven, CRACI | — | CUT (см. [architecture.md](architecture.md#объём-must--should--cut)) |
