# Драфт сабмита v3 · Live Truth Radar · The Kerfufflers
## Основной: Decode the Noise (Hostinger) · тех: Context.dev и другие · идея: обработка сигналов

# ⏰ БЛОК ДЛЯ PRELIMINARY SUBMISSION (до 23:59), копировать как есть

**Project Name:** `Live Truth Radar`

**Punchline (192/200):**
```
Bots whisper below the noise floor. Live Truth Radar is a spread-spectrum receiver for the web: it despreads coordinated campaigns, names propaganda techniques and reports honest false-alarm rates.
```

**Challenge Picker:** `Decode the Noise`

**Description (короткая версия, 635 символов):**
```markdown
Propaganda campaigns behave like a spread-spectrum signal: each bot account is too weak to flag alone, but together they carry one message. **Live Truth Radar** applies radar and signal-processing math to the live web: matched filters find a narrative even when reworded, cross-correlation of account activity "despreads" hidden swarms, a CFAR threshold raises alerts, and a sequential likelihood-ratio test (SPRT) decides "coordinated / organic / keep watching" at a false-alarm rate we choose. Every verdict is explained in plain language with evidence and sources. Live web data comes from Context.dev; the system runs live on Hostinger.
```

**Source Code:** ссылка на GitHub-репо (можно пустой)

**Tech Challenges (отметить сейчас, можно поменять):** Best Use of Context.dev: Fully Structured Web · Best agentic usecase of Oxylabs Web API · Best Use of Gemini API *(Codex: возможно позже, пока не отмечаем)*

---

# ФИНАЛЬНАЯ ВЕРСИЯ (до вс 10:00)

## Description (4485/5000, markdown), заменить короткую на эту
*`[скобки]` заменить реальными цифрами и эндпоинтами, ничего не выдумывать.*
```markdown
## The idea: propaganda is a signal hidden in noise
In radio, a spread-spectrum (CDMA) signal is transmitted **below the noise floor**: no single sample stands out, but a receiver that knows the code adds the pieces coherently and the signal rises out of the noise.

Coordinated campaigns work the same way. Each bot or sock-puppet posts a little, too weakly to flag alone. Together they share one "code": the same moments of activity, the same links, the same message in different words. Detectors that judge **one post at a time** cannot see them.

**Live Truth Radar is a receiver for that signal.** We took the math of radar and signal processing and applied it to the live web.

## The receiver chain
`Antenna (live web) → front-end (embeddings + activity time series) → filters → detector → explained verdict`

- 🎯 **Matched filter bank**: each post is correlated with narrative templates in embedding space, so a message is found even when reworded.
- 🐝 **CDMA despreading (Spot the swarm)**: account activity becomes 0/1 sequences per minute. Organic users behave like independent random codes with near-zero cross-correlation; a coordinated group shows a correlation peak at a common lag. Combining the cluster gives a processing gain of roughly N, so a swarm invisible per account becomes clearly visible. We show it as SNR in dB.
- 📈 **CFAR alerting**: like radar, the alarm threshold adapts to each topic's own background noise, keeping the false-alarm rate constant for busy and quiet topics alike.
- ⚖️ **SPRT decision**: a sequential likelihood-ratio test accumulates evidence (text similarity, timing, account age, shared links) post by post and decides *coordinated*, *organic* or *keep watching* as early as possible, with error rates α and β that we set.
- 🎵 **Spectral analysis**: an FFT of each account's posting series; scheduled bots show sharp spectral lines, humans a broad daily rhythm.
- 🎭 **Name the technique**: a classifier labels loaded language, fear appeal, whataboutism and fabricated authority, highlights the exact phrases and explains *why* in plain language.
- 🔗 **Trust the source**: domain age, cloned branding and company identity, from live web data.

## Honest, measurable detection
We report detection the way radar engineers do:
- **ROC curves (Pd vs Pfa)** and a Neyman–Pearson operating point, e.g. *"at [2]% false alarms we detect [X]% of campaigns"*.
- **Test-target injection**: we hide a synthetic coordinated campaign inside the real live stream and measure whether, and how fast, it is detected (**[N] posts / [T] seconds** to decision).
- Public labelled datasets for propaganda techniques and bot accounts, plus a hand-labelled live test set.

Current results: **precision [X], recall [Y], FPR [Z]**. Known failure cases are listed on the metrics page. When evidence is weak, the system says *"uncertain"* instead of accusing a real person.

## Explainable verdicts
Each alert shows the evidence a human can check in seconds: the correlated accounts and their timing, the reworded posts that matched, the highlighted phrases, the source data, the SNR and the SPRT trace showing when the decision was made.

## Deployed live on Hostinger
Docker on a Hostinger VPS with a public domain. Models via Hostinger AI Router. Context.dev webhooks arrive directly on the VPS, so alerts appear in real time. Public dashboard and REST API.

## Who it is for
- **Fact-checkers and journalists**: know in minutes whether a trend is organic or coordinated.
- **Moderators and site owners**: see campaigns aimed at their community.
- **Readers**: a plain answer to *"who is behind this?"*

## Partner technology
- **Hostinger**: VPS, domain and AI Router host the whole live system.
- **Context.dev**: our antenna. [News search], [social and page scrape], [monitors + webhooks] for real-time ingest, [brand and company enrichment] for source trust, [structured extraction] for claims.
- **Oxylabs Web API**: `/search` and `/scrape` as an independent second source, with URLs.
- **Gemini**: grounded plain-language explanations.
- **Gemma**: low-cost technique classification and embeddings.
- **NVIDIA Nemotron**: reads screenshots and memes.
- **[Modal / Verda]**: GPU for embeddings and classifiers.
- **[OpenAI Codex]**: *(only if we use it later)* used in development.

## What's next
OFDM-style "pilot" facts to estimate how each outlet distorts information, delay-Doppler maps of how narratives spread, and a browser extension.

*Team The Kerfufflers · Junction 2026*
```

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
| 0:15–0:50 | Инжекция тестовой кампании в живой поток → корреляционная матрица загорается → SNR из −8 дБ в +11 дБ |
| 0:50–1:10 | SPRT-трасса: решение «coordinated» на 3-м посте |
| 1:10–1:30 | Карточка: приём манипуляции с подсветкой фраз + источник |
| 1:30–1:50 | ROC-кривая и рабочая точка |
| 1:50–2:00 | Hostinger + Context.dev, что дальше |

## Презентация (7 слайдов)
1. Пропаганда = сигнал под уровнем шума. 2. Приёмная цепочка. 3. Деспрединг роя (SNR). 4. SPRT и CFAR: рано и с заданной ложной тревогой. 5. ROC + инжекция цели. 6. Архитектура на Hostinger + партнёры. 7. Кому и что дальше.

## Тех-челленджи
| Тех-челлендж | Условие зачёта | Статус |
|---|---|---|
| ✅ Context.dev | ≥1 эндпоинт в ядре + заметка «какие и зачем» (в описании) | Ядро |
| ✅ Oxylabs | Живой `/search` или `/scrape` + URL источников. ⚠️ Отменить подписку после | Ядро |
| ✅ Gemini | Почему важен (в описании) | Ядро |
| ◐ Codex | Возможно позже: пока код пишем с Claude. Если возьмём, нужны скрины и лог | Если сделали |
| ◐ Gemma | Если классификатор/эмбеддинги на Gemma | Если сделали |
| ◐ Nemotron | Отдельный текст в форме | Если сделали |
| ◐ Modal **или** Verda | Modal: живой эндпоинт; Verda: саммари в Discord | Выбрать одно |
| ◐ CRACI | CI на `runs-on: craci` + API | По времени |

### Заготовка для Nemotron
```
Model: NVIDIA Nemotron 3.5 Super VL (via [build.nvidia.com / Verda]).
What it does: reads screenshots, memes and image posts and extracts text and claims, so image-based posts enter the same receiver chain as text.
Why it matters: text-only detectors are blind to image propaganda.
How we improved outputs: [JSON prompt, few-shot, OCR cross-check, eval on N labelled images].
```
