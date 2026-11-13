# HANDOFF: Live Truth Radar · The Kerfufflers · Junction 2026

*Всё, что нужно, чтобы продолжить в новой сессии или на другом компьютере.*

## 1. Что мы строим
**Live Truth Radar** — «радар» для онлайн-манипуляций: смотрит на живой веб, находит координированные бот-кампании и приёмы пропаганды и объясняет каждый вердикт с источниками и честными метриками ложных срабатываний. Подход взят из обработки сигналов (matched filter, CDMA-деспрединг, CFAR, SPRT).

- **Основной челлендж:** Decode the Noise (Hostinger) → [challenge-decode-the-noise.md](challenge-decode-the-noise.md)
- **Тех-челленджи:** Context.dev (ядро), Gemini; Codex — только если на T0 решили, что P2 реально пишет им `detect/`; Oxylabs — CUT → [tech-challenges.md](tech-challenges.md)
- **Подход:** [signal-processing.md](signal-processing.md) · **Архитектура:** [architecture.md](architecture.md)
- **Текст сабмита:** [submission-draft.md](submission-draft.md)
- **Как работаем (агенты, ветки, тесты):** [workflow.md](workflow.md) · **Карточки задач:** [tasks.md](tasks.md) · **Инструкции агентам:** [`CLAUDE.md`](../CLAUDE.md) · **Контракт:** [`contracts/models.py`](../contracts/models.py)

## 2. Событие
- **Junction 2026**, 13–15.11.2026, **Hype Areena, Kivenlahti, Espoo** (метро ~30 мин от центра Хельсинки). Площадка 24/7, спальных мест нет.
- Команда до 4 человек (нас **2**, у каждого свой AI-агент). Код уходит в open source (MIT), владение у команды. Призы всего €100k.
- Судейство: победителей треков выбирают партнёры → peer review выбирает топ-5 → живой питч перед гранд-жюри.
- Форма сабмита: Project Name (≤30 символов), Punchline (≤200), Description (≤5000, markdown), один основной челлендж, Demo link, Source code, Video, Other link, презентация (PDF/PPTX/PPT/ODP/KEY ≤20 МБ), тех-челленджи (несколько).

## 3. Ключевые сроки
*Всё время — Хельсинки (Europe/Helsinki, EET).*

| Когда | Что |
|---|---|
| **Пт 23:59** | **Preliminary submission** |
| Сб 12:00 | Открывается форма сабмита |
| Сб 13:00 | Доклад Hostinger «Vibe Coding Solved Building…» |
| **Вс 10:00** | **Финальный сабмит** |
| Вс 14:00 / 15:10 / 15:50 | Финал / победители челленджей / победитель Junction |

## 4. Обязательно не забыть
- Живой **публичный URL на Hostinger VPS** к концу хакатона. Деплоим с первого часа (T5 к Сб 03:00), а не в конце; `make smoke URL=...` после каждого деплоя.
- **Метрики** (precision, FPR, ROC) на размеченных данных: это 40% оценки Hostinger.
- Для Context.dev: заметка «какие эндпоинты и зачем» (README, T17); проверять флаг `success`; ответы кэшировать.
- Для Codex: только если на T0 решили, что P2 реально пишет им `detect/`; лог в `docs/codex-log.md` по ходу, задним числом не пишем. Иначе снимаем галочку (в том числе в preliminary).
- Oxylabs — CUT: не активируем, не отмечаем, отменять нечего.
- `contracts/models.py` меняем **только вдвоём**; остальное — каждый в своих папках.
- Коды и ключи **не коммитим**: они в Junction Hackerpack и в `.env` (git-ignored).

## 5. План по задачам
Объём урезан до ядра (MUST / SHOULD / CUT): [architecture.md](architecture.md#объём-must--should--cut). Нас двое, работа разделена по слоям через один контракт (`contracts/`): P2 работает офлайн на `fixtures/` (без сети и БД), P1 — с мок-детектором, который отдаёт `fixtures/findings.json`, до интеграции I1. Подробные карточки задач («что сделать / файлы / готово, когда»): [tasks.md](tasks.md). Цикл работы агента и правила веток: [workflow.md](workflow.md).

**Роли:**
- **P1 «Труба»** — Context.dev ingest, Postgres, Docker Compose + деплой на Hostinger (caddy, HTTPS), FastAPI, объяснения Gemini, дашборд, smoke. Папки: `ingest/`, `api/`, `web/`, `infra/`. Работает в Claude Code.
- **P2 «Мозг»** — эмбеддинги Gemini, matched filter, корреляция аккаунтов, CFAR, SPRT, генератор синтетического роя, eval (ROC, метрики), preliminary и финальный текст. Папки: `detect/`, `synth/`, `eval/`. `detect/` может писать в Codex (решение на T0).

| ID | Задача | Кто | Дедлайн |
|---|---|---|---|
| T0 | **Кикофф 45 мин:** контракт + fixtures, `CLAUDE.md`, 3–5 тем, решение по Codex, тиммейт в GitHub; имена в роли (§6) | оба | Пт 22:00 |
| T1 | Ключи: Context.dev, Gemini (AI Studio, 18+), Hostinger VPS + домен, AI Router → `.env` | оба | Пт 22:30 |
| T2 | **Проба Context.dev:** отдают ли news search / social scrape автора и время? Реальный пример → `fixtures/`, вывод → §6 | P1 | Пт 23:15 |
| T3 | **Preliminary submission:** блок из [submission-draft.md](submission-draft.md) | P2 | **Пт 23:59** |
| T4 | Docker Compose (caddy, api, worker, db) + FastAPI `/health` + схема БД | P1 | Сб 01:00 |
| T5 | Деплой скелета на Hostinger, HTTPS-домен, smoke проходит | P1 | Сб 03:00 |
| T6 | Ingest: поллинг Context.dev → БД (`items`), кэш ответов | P1 | Сб 04:30 |
| T7 | Эмбеддинги Gemini + matched filter (банк шаблонов по темам) на fixtures | P2 | Сб 09:00 |
| T8 | API `/api/alerts`, `/api/metrics`, `/api/inject` на БД + мок-детектор | P1 | Сб 11:00 |
| T9 | Генератор синтетического роя (Gemini ~30 вариаций, фейковые аккаунты с лагами) + инжекция | P2 | Сб 11:00 |
| T10 | Корреляция → CFAR → SPRT → `Finding` (LLR, SNR, вердикт, «watching»). **Чекпоинт: находит синтетический рой в fixtures** | P2 | **Сб 14:00** |
| I1 | **Интеграция:** настоящий `detect()` в worker на живых данных на VPS; мок убран | оба | **Сб 15:00** |
| T11 | Объяснение Gemini (structured output) + AI Router как запасной | P1 | Сб 16:00 |
| T12 | Дашборд (одна страница) + `/metrics` + кнопка инжекции | P1 | Сб 19:00 |
| T13 | Eval: ROC, доля найденных, время до решения на инжектированных → `MetricsReport` | P2 | Сб 19:00 |
| T14 | Разметка ~50 живых аккаунтов (рубрика 15 мин; ~25 из алертов + ~25 случайных, без синтетики) до 20:00 → 20:00–20:30 `make eval` + `make deploy` → live FPR / precision | оба | Сб 20:30 |
| S1 | SHOULD: Source Trust через Context.dev brand/company — только если весь MUST, кроме T14, готов к Сб 20:00 | P1 | Вс 01:00 |
| T15 | Тюнинг порогов (α, β, CFAR), стабильность, `restart: always` | оба | Вс 02:00 |
| F | **Фича-фриз кода.** Дальше только баги | оба | **Вс 02:00** |
| T16 | Видео 2 мин на живом демо | оба | Вс 03:00 |
| T17 | 7 слайдов + финальный текст с реальными числами; `docs/codex-log.md` (только если Codex); README «Context.dev endpoints & why» — пишет P1 | P2 (+P1) | Вс 08:00 |
| T18 | Финальная форма сабмита | оба | **Вс 10:00** |

**Синки (10 мин: мёрж, деплой `main`, проверка цепочки вживую):** Сб 04:30 (до сна P1) · Сб 11:00 · I1 Сб 15:00 · Сб 19:00 · Вс 01:00.

**Интерфейсы вне контракта (решены заранее, менять только вдвоём; в tasks.md помечены ⚙):**
- `synth.campaign.make_campaign(topic, now, *, n_accounts=12, seed=None) -> list[Item]` (P2, T9) — его вызывает `POST /api/inject` (P1). Правила: `published_at` в окне `[now − 15 мин, now]`; `campaign_id = f"inj-{topic}-{now:%H%M%S}"`; id постов `f"{campaign_id}-{k}"` (каждый инжект новый, upsert не съедает повтор); текст — сообщение, которого **нет** в банке шаблонов (честный eval). До T9 inject берёт синтетику из `fixtures/items.json` с теми же правилами (время сжато в 15 мин, новые id). После инжекта API **не** запускает детектор сам: пишет строку в `inject_requests`, worker проверяет её каждые ~10 с и сразу гоняет `detect()` по теме (детектор живёт только в worker, без гонок).
- Окно детектора: worker каждый цикл вызывает `detect(items за последние DETECT_WINDOW_HOURS=6 ч по теме)` и атомарно заменяет findings этой темы; `/api/alerts` отдаёт только последний прогон + `last_poll_at`.
- `eval/report.json` (`MetricsReport`, пишет `make eval`, P2 в T13; пересчёт после T14 может сделать любой) — **коммитим в git**; compose (`infra/docker-compose.yml`, build context `..`) монтирует `../eval:/app/eval:ro` и `../cache:/app/cache`, поэтому доставка на VPS = `git pull` (`make deploy`), без пересборки. Пока файла нет — `/api/metrics` отдаёт заглушку с `None`.
- `eval/labels.csv` (`account,topic,alerted,label,note`) — общая разметка T14; `account` — псевдоним `contracts.pseudonym(author, LTR_HASH_SALT)`, реальные хэндлы в публичный репо **не попадают**. Скелет файла делает `ingest/label_sample.py` (P1).
- `fixtures/items_live_sample.json` — живой сэмпл из БД для офлайн-работы P2 (`ingest/export_sample.py`, P1; авторы псевдонимизированы); обновляется на каждом синке.
- `GET /api/items?ids=…` (P1, T8) → `list[Item]`: тексты постов для карточки вердикта. Пока работает mock, T8 загружает `fixtures/items.json` в БД, чтобы id из `fixtures/findings.json` находились.
- Публичный дашборд маскирует хэндлы реальных (не синтетических) аккаунтов (`@ab***`); полные хэндлы видны только локально для разметки T14. `ingest/label_sample.py` пишет соответствие `псевдоним,хэндл` в `cache/label_handles.csv` (git-ignored).
- Метрики считаются тем же эмбеддером, что работает вживую: `make eval` идёт с `LTR_EMBEDDER=gemini` и кэшем `cache/embeddings/`; `MetricsReport.embedder` фиксирует, каким; `eval.run` отказывается писать отчёт на `hash` без `--dev`.
- `GET /api/source/{domain}` (S1) — Source Trust отдельным эндпоинтом, контракт `Finding` не меняем.
- Worker: `ingest/worker.py`; объяснение Gemini: `ingest/explain.py`; схема БД: `infra/schema.sql` (всё P1).
- Офлайн для P2: эмбеддинги с кэшем на диск + детерминированный hashing-эмбеддер для тестов (T7); вариации Gemini для роя кэшируются в `synth/variations/` (в git, T9).
- `Finding.id` = `contracts.models.finding_id(topic, accounts)` — стабильный, API дедуплицирует по нему.


**Сон (~4 ч на человека за ночь):**
| Ночь | P1 «Труба» | P2 «Мозг» |
|---|---|---|
| Пт→Сб | Сб 05:00–09:00 (ingest уже крутится, T6) | Сб 00:00–04:00 (сразу после T3) |
| Сб→Вс | Вс 03:00–07:00 (после видео T16) | Сб 20:30–Вс 00:30 (после T14 и пересчёта `eval/report.json`) |

Оба не спят на F (Вс 02:00) и Вс 07:00–10:00.

**Если отстаём:** на чекпоинте T10 (Сб 14:00) без работающего детектора S1 не делаем вообще, P1 помогает P2, I1 сдвигаем. Если на T2 у social нет автора или времени — работаем на news search + синтетике и честно пишем это в сабмите (`[ALT]` в submission-draft.md).

## 6. Открытые вопросы
*Заполняем на T0 и T2.*
- Роли: P1 «Труба» = ?, P2 «Мозг» = ?
- Темы для поллинга (3–5): ?
- Codex: P2 пишет им `detect/` (да / нет)? Если нет — снимаем Codex из тех-челленджей, в том числе в preliminary.
- Результат T2: что реально отдают news search и social scrape Context.dev (автор? время?): ?

## 7. Промпт для нового AI-ассистента
```
Мы команда "The Kerfufflers" на Junction 2026 (Espoo, 13–15.11.2026), проект Live Truth Radar. Нас двое: P1 «Труба» (ingest, БД, деплой, API, дашборд) и P2 «Мозг» (детектор, синтетика, eval).
Прочитай CLAUDE.md, затем docs/workflow.md (как работаем) и карточку своей задачи в docs/tasks.md. Контракт: contracts/models.py (меняем только вдвоём).
Шире контекст — только если нужно: docs/HANDOFF.md (план и сроки), docs/architecture.md (MUST/SHOULD/CUT), docs/signal-processing.md, docs/submission-draft.md.
Основной челлендж: Decode the Noise (Hostinger). Тех: Context.dev (ядро), Gemini; Codex — только если реально используем.
Финальный сабмит: воскресенье 10:00 (Хельсинки).
Отвечай по-русски: коротко, точно, с примерами, дружелюбно.
Я — <P1/P2>. Текущая задача: <ID из docs/tasks.md>.
```
