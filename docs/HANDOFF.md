# HANDOFF: Live Swarm Radar · The Kerfufflers · Junction 2026

*Всё, что нужно, чтобы продолжить в новой сессии или на другом компьютере.*

## 1. Что мы строим
**Live Swarm Radar** — «радар» для онлайн-манипуляций: смотрит на живой веб, находит координированные бот-кампании и приёмы пропаганды и объясняет каждый вердикт с источниками и честными метриками ложных срабатываний. Подход взят из обработки сигналов (matched filter, CDMA-деспрединг, CFAR, SPRT).

- **Основной челлендж:** Decode the Noise (Hostinger) → [challenge-decode-the-noise.md](challenge-decode-the-noise.md)
- **Тех-челленджи:** Context.dev (ядро), Gemini; Codex — пока не используем (код пишем с Claude), возможно позже; Oxylabs — CUT → [tech-challenges.md](tech-challenges.md)
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
- Codex пока не используем (код пишем с Claude), в preliminary не отмечаем. Если подключим позже — с этого момента ведём `docs/codex-log.md`, задним числом не пишем.
- Oxylabs — CUT: не активируем, не отмечаем, отменять нечего.
- `contracts/models.py` меняем **только вдвоём**; остальное — каждый в своих папках.
- Коды и ключи **не коммитим**: они в Junction Hackerpack и в `.env` (git-ignored).

## 5. План по задачам
Объём урезан до ядра (MUST / SHOULD / CUT): [architecture.md](architecture.md#объём-must--should--cut). Нас двое, работа разделена по слоям через один контракт (`contracts/`): P2 работает офлайн на `fixtures/` (без сети и БД), P1 — с мок-детектором, который отдаёт `fixtures/findings.json`, до интеграции I1. Подробные карточки задач («что сделать / файлы / готово, когда»): [tasks.md](tasks.md). Цикл работы агента и правила веток: [workflow.md](workflow.md).

**Роли:**
- **P1 «Труба»** — Context.dev ingest, Postgres, Docker Compose + деплой на Hostinger (caddy, HTTPS), FastAPI, объяснения Gemini, дашборд, smoke. Папки: `ingest/`, `api/`, `web/`, `infra/`. Работает в Claude Code.
- **P2 «Мозг»** — эмбеддинги Gemini, matched filter, корреляция аккаунтов, CFAR, SPRT, генератор синтетического роя, eval (ROC, метрики), preliminary и финальный текст. Папки: `detect/`, `synth/`, `eval/`. Пишет с Claude (Codex — возможно позже).

| ID | Задача | Кто | Дедлайн |
|---|---|---|---|
| T0 | **Кикофф 45 мин:** контракт + fixtures, `CLAUDE.md`, 3–5 тем, тиммейт в GitHub; имена в роли (§6) | оба | Пт 22:00 |
| T1 | Ключи: Context.dev, Gemini (AI Studio, 18+), Hostinger VPS + домен, AI Router → `.env` | оба | Пт 22:30 |
| T2 | **Проба Context.dev:** отдают ли news search / social scrape автора и время? Реальный пример → `fixtures/`, вывод → §6 | P1 | Пт 23:15 |
| T3 | **Preliminary submission:** блок из [submission-draft.md](submission-draft.md) | P2 | **Пт 23:59** |
| T4 | Docker Compose (caddy, api, worker, db) + FastAPI `/health` + схема БД | P1 | Сб 01:00 |
| T5 | Деплой скелета на Hostinger, HTTPS-домен, smoke проходит | P1 | Сб 03:00 |
| T6 | Ingest: поллинг Context.dev → БД (`items`), кэш ответов | P1 | Сб 04:30 |
| T7 | Эмбеддинги Gemini + луч на тему (бимформинг) + отбеливание на fixtures | P2 | Сб 09:00 |
| T8 | API `/api/alerts`, `/api/metrics`, `/api/inject` на БД + мок-детектор | P1 | Сб 11:00 |
| T9 | Генератор синтетического роя (Gemini ~30 вариаций, фейковые аккаунты с лагами) + инжекция | P2 | Сб 11:00 |
| T10 | Коррелятор пар «время × смысл» → CFAR по парам → рой ≥ 3 → SPRT → `Finding` (LLR, SNR, вердикт, «watching»). **Чекпоинт: находит синтетический рой в fixtures** | P2 | **Сб 14:00** |
| I1 | **Интеграция:** настоящий `detect()` в worker на живых данных на VPS; мок убран | оба | **Сб 15:00** |
| T11 | Объяснение Gemini (structured output) + AI Router как запасной | P1 | Сб 16:00 |
| T12 | Дашборд (одна страница) + `/metrics` + кнопка инжекции | P1 | Сб 19:00 |
| T12b | Подстраница «Как мы пришли к выводу» (пошагово: луч → корреляция → CFAR → SPRT → эхо новости) | P1 + P2 | после главной страницы |
| T12c | Выбор вероятности ложной тревоги (alpha SPRT 1/2/5%, измеренные Pfa/Pd) | P1 + P2 | код 14.11, VPS после деплоя |
| T13 | Eval: ROC, доля найденных, время до решения на инжектированных → `MetricsReport` | P2 | Сб 19:00 |
| T14 | Разметка ~50 живых аккаунтов (рубрика 15 мин; ~25 из алертов + ~25 случайных, без синтетики) до 20:00 → 20:00–20:30 `make eval` + `make deploy` → live FPR / precision | оба | Сб 20:30 |
| S1 | SHOULD: Source Trust через Context.dev brand/company — только если весь MUST, кроме T14, готов к Сб 20:00 | P1 | Вс 01:00 |
| T15 | Тюнинг порогов (α, β, CFAR `k`, луч) в `detect/config.py`, стабильность, `restart: always` | оба | Вс 02:00 |
| F | **Фича-фриз кода.** Дальше только баги | оба | **Вс 02:00** |
| T16 | Видео 2 мин на живом демо | оба | Вс 03:00 |
| T17 | 7 слайдов + финальный текст с реальными числами; `docs/codex-log.md` (только если Codex); README «Context.dev endpoints & why» — пишет P1 | P2 (+P1) | Вс 08:00 |
| T18 | Финальная форма сабмита | оба | **Вс 10:00** |

**Синки (10 мин: мёрж, деплой `main`, проверка цепочки вживую):** Сб 04:30 (до сна P1) · Сб 11:00 · I1 Сб 15:00 · Сб 19:00 · Вс 01:00.

**Интерфейсы вне контракта (решены заранее, менять только вдвоём; в tasks.md помечены ⚙):**
- `synth.campaign.make_campaign(topic, now, *, n_accounts=12, seed=None, schedule="past") -> list[Item]` (P2, T9; `schedule` — T12d) — его вызывает `POST /api/inject` (P1). Правила: `published_at` в окне `[now − 15 мин, now]` (исключение — `schedule="future"` для консоли атаки T12d: посты от клика вперёд на ~10 мин); `campaign_id = f"inj-{topic}-{now:%H%M%S}"`; id постов `f"{campaign_id}-{k}"` (каждый инжект новый, upsert не съедает повтор); текст — из отложенных вариаций; форма: 2 залпа, в каждом каждый аккаунт постит один перефраз с лагом 15–120 с; детектор на синтетике не обучается и банка шаблонов не имеет (честный eval, см. [signal-processing.md §3](signal-processing.md)). До T9 inject берёт синтетику из `fixtures/items.json` с теми же правилами (время сжато в 15 мин, новые id). После инжекта API **не** запускает детектор сам: пишет строку в `inject_requests`, worker проверяет её каждые ~10 с и сразу гоняет `detect()` по теме (детектор живёт только в worker, без гонок).
- Окно детектора: worker каждый цикл вызывает `detect(items за последние DETECT_WINDOW_HOURS=6 ч по теме)` и атомарно заменяет findings этой темы; `/api/alerts` отдаёт только последний прогон + `last_poll_at`.
- `eval/report.json` (`MetricsReport`, пишет `make eval`, P2 в T13; пересчёт после T14 может сделать любой) — **коммитим в git**; compose (`infra/docker-compose.yml`, build context `..`) монтирует `../eval:/app/eval:ro` и `../cache:/app/cache`, поэтому доставка на VPS = `git pull` (`make deploy`), без пересборки. Пока файла нет — `/api/metrics` отдаёт заглушку с `None`.
- `eval/labels.csv` (`account,topic,alerted,verdict,label,note`; `verdict` = `coordinated`/`watching`/пусто) и `eval/labels_meta.json` (`{topic: {n_accounts, n_alerted}}`, размеры слоёв для перевзвешивания live FPR) — общая разметка T14; `account` — псевдоним `contracts.pseudonym(author, LTR_HASH_SALT)`, реальные хэндлы в публичный репо **не попадают**. Скелет файла делает `ingest/label_sample.py` (P1).
- `fixtures/items_live_sample.json` — живой сэмпл из БД для офлайн-работы P2 (`ingest/export_sample.py`, P1; авторы псевдонимизированы); обновляется на каждом синке.
- `fixtures/items_live_background.json` — живой фон для eval (T15): та же выгрузка за 48 ч (`export_sample --hours 48`), авторы псевдонимизированы, email в текстах замаскированы (`mask_emails`); eval убирает дубли с живым сэмплом по id.
- `GET /api/items?ids=…` (P1, T8) → `list[Item]`: тексты постов для карточки вердикта. С I1 worker работает только на `detect.pipeline.detect` (mock и загрузка `fixtures/items.json` в БД убраны; `LTR_DETECTOR` больше не используется).
- `detect(items, *, alpha, beta, cfg, now=None)` (P2): worker передаёт `now=datetime.now(timezone.utc)` (`ingest/worker.py::load_detector`, одна строка; файл P1 изменён с согласия Тимура 14.11, Никите на просмотр). С `now` инжект истекает через 900 с после последнего поста кампании (~10 мин после клика; при `schedule="future"` из T12d — после последнего **видимого** поста, то есть ~25 мин после клика). `now` должен быть с таймзоной, иначе `ValueError`.
- `GET /api/alerts?alpha=0.005|0.01|0.02|0.05|0.1`, `GET /api/alphas` (какие `alpha` считает воркер: 0.02 + `ALPHA_POINTS`) и `GET /api/operating_points` (T12c): находки при выбранной `alpha` SPRT (таблица `findings_alpha`, worker считает точки из `ALPHA_POINTS`; без `alpha` — как раньше) и измеренные Pfa/Pd по точкам из `eval/operating_points.json` (`make eval`; `null`, пока файла нет).
- `GET /api/topics` (P1, T12) → `list[str]`: темы из `TOPICS` (тот же разбор, что в worker), для переключателя тем на дашборде. Дашборд: `web/` раздаёт FastAPI (`/` и `/metrics`).
- Хэндлы реальных (не синтетических) аккаунтов маскирует **API** (`/api/alerts`, `/api/items` отдают `ab***`, дашборд дописывает `@`; у постов `context_social` убирается `url`, в нём хэндл): API публичный, маскировка только на фронте не защищает (решение сб 14.11, T8). Полные хэндлы видны только в БД, локально для разметки T14. `ingest/label_sample.py` пишет соответствие `псевдоним,хэндл` в `cache/label_handles.csv` (git-ignored).
- Метрики считаются тем же эмбеддером, что работает вживую: `make eval` идёт с `LTR_EMBEDDER=gemini` и кэшем `cache/embeddings/`; `MetricsReport.embedder` фиксирует, каким; `eval.run` отказывается писать отчёт на `hash` без `--dev`.
- `GET /api/source/{domain}` (S1) — Source Trust отдельным эндпоинтом, контракт `Finding` не меняем.
- T12d (согласовано P1 + P2 14.11, подробно в карточке): `detect.pipeline.scan(items, *, topics, now, alpha=0.02, beta=0.1, cfg=DEFAULT) -> tuple[list[Finding], list[RadarFrame]]` (P2; находки те же, что у `detect(..., now=now)`; параметр `topics` — кадр на каждую тему, в том числе пустую; `RadarFrame` в `detect/radar.py` (+ `best_candidate`): `topic, at, n_items, n_accounts, n_lit_pairs, max_pair_z, n_watching, top_verdict, top_n_accounts, top_llr, top_trace, top_capped, sprt_upper, sprt_lower, top_campaign_ids`); `detect`/`scan` при заданном `now` не видят посты с `published_at > now`; у клиента Gemini для эмбеддингов таймаут 20 с (`detect/embed.py`); `make_campaign(..., schedule="past" | "future")` (P2; `future` = залпы сдвинуты на +840 с: посты от клика вперёд на ~10 мин, форма роя та же; `past` по умолчанию для eval и тестов); атака с токеном `ATTACK_TOKEN` (P1, пустой → 503): `POST /api/attack` (409, пока на теме идёт атака), `GET /api/attack/{campaign_id}`, `GET /api/attack/topics`; `POST /api/inject` остаётся публичным (`past`, ≤ 1 раза в 5 мин на тему, иначе 429); `POST /api/scan`, `POST /api/scan/{id}/stop`, `GET /api/radar?session=` (410 для закрытой сессии). Таблицу `findings` пишет только основной цикл worker'а; ingest и LLM-объяснения — в своих потоках.
- **Деплой = мерж в `main`** (T15, P1): GitHub Actions `.github/workflows/deploy.yml` гоняет `make test`, затем по SSH deploy-ключу выкатывает ровно протестированный коммит (`git merge --ff-only <sha>` + `compose up --build`, как `make deploy`) и гоняет `make smoke`; красный job = демо, возможно, сломано, чинить `git revert` + мерж. Docs-only мержи не деплоятся. Ручной путь `make deploy VPS=…` остаётся; повтор деплоя — кнопка «Run workflow».
- **Дефолты детектора после T15 (P2, сб 14.11; `detect/config.py`, подробно [signal-processing.md §3.12](signal-processing.md)):** SPRT `α` 2% (ползунок 0.5–10%), `β` 0.1; CFAR `k` = 3 (на сетке 2–4 Pd одинаковый, Pfa = 0 при любом `k`, так что `make eval` выбирает `k` = 4 только по Pd; оставили 3; цифры отчёта ниже — при `k` = 4, при 3 разница ≤ 0.5 п.п.); порог луча Gemini `c_lo/c_hi` = 0.78/0.80 (было 0.81/0.83; калибровка `detect.calibrate_beam` на живом сэмпле и фоне за 48 ч); `τ_max` 10 мин при ядре задержки 2 мин. Прогон чувствительности (офлайн, α 2%): `τ_max` 5–20 мин даёт одинаковый Pd (окно на деле задаёт ядро 2 мин; ядро 1 мин −10 п.п. Pd, 4–10 мин +1–3 п.п.), жёсткая отсечка по wording gap только снижает Pd (0.3 → Pd роя из 4: 0.75 → 0.33), поэтому ползунков для окна и gap нет. `eval/report.json` после T15 (темы инжекта: helsinki, jensen, microsoft, europe): Pfa 0 (≤ 0.25% с 95% уверенностью, 1213 окон фона), доля найденных 0.99, Pd по размеру роя 3/4/6/8/12: 0.92/0.99/1.00/0.995/0.995 (было 0.78/0.98/1/1/1), постов до решения 4.1, секунд до решения 70 (было 94). Вариации атаки Microsoft/Europe перегенерированы (PR #40): каждый текст называет предмет темы, иначе пост выпадал из луча.
- Worker: `ingest/worker.py`; объяснение Gemini: `ingest/explain.py`; схема БД: `infra/schema.sql` (всё P1).
- Офлайн для P2: эмбеддинги с кэшем на диск + детерминированный hashing-эмбеддер для тестов (T7); вариации Gemini для роя кэшируются в `synth/variations/` (в git, T9).
- `Finding.id` = `contracts.models.finding_id(topic, accounts)` — стабильный при неизменном составе аккаунтов (пока рой растёт, как в постепенном инжекте T12d, id меняется — UI ищет такую находку по `campaign_id`), API дедуплицирует по нему.


**Сон (~4 ч на человека за ночь):**
| Ночь | P1 «Труба» | P2 «Мозг» |
|---|---|---|
| Пт→Сб | Сб 05:00–09:00 (ingest уже крутится, T6) | Сб 00:00–04:00 (сразу после T3) |
| Сб→Вс | Вс 03:00–07:00 (после видео T16) | Сб 20:30–Вс 00:30 (после T14 и пересчёта `eval/report.json`) |

Оба не спят на F (Вс 02:00) и Вс 07:00–10:00.

**Если отстаём:** на чекпоинте T10 (Сб 14:00) без работающего детектора S1 не делаем вообще, P1 помогает P2, I1 сдвигаем. Если на T2 у social нет автора или времени — работаем на news search + синтетике и честно пишем это в сабмите (`[ALT]` в submission-draft.md).

## 6. Открытые вопросы
*Заполняем на T0 и T2.*
- Роли: P1 «Труба» = Никита (`makarovns`), включая T4 и референс фронтенда; P2 «Мозг» = Тимур (`tlavr`).
- Темы для поллинга (решено 14.11, 6 шт., `TOPICS` в `.env` локально и на VPS): `jensen-huang-resignation`, `france-riots`, `us-midterms-ai-fakes`, `europe-bomb-threat-hoaxes`, `microsoft-global-outage`, `ukraine-peace-talks`. Slug → запрос Context.dev и ключевые слова фильтра — таблица `TOPIC_SPECS` в `ingest/contextdev.py` (проба 14.11, заголовков по теме из 50 за 6 ч: outage 43, resignation 9, bomb-hoaxes 9, ukraine 5, france-riots 0, midterms 0 — у последних двух живого потока сейчас нет); для slug вне таблицы запрос = slug через пробелы. `helsinki-tram-fares` живых новостей не даёт, только синтетика/инжект. Соль `LTR_HASH_SALT` — общая для команды, передаётся лично (не в git).
- Codex: пока нет (код пишем с Claude). Подключаем ли позже — решить не позже Сб 11:00; иначе в сабмит не идёт.
- Результат T2 (14.11): **news search** (`natural_language`) отдаёт `published_at` 100/100, `authors` 74/100 (часто пусто) → аккаунт = домен издателя; поиск ранжирует по релевантности и добивает лимит (50) свежими нерелевантными новостями → worker (и для news, и для Reddit) оставляет только элементы, у которых **заголовок** проходит фильтр темы (в описании часто блок «похожие статьи»): для тем из `TOPIC_SPECS` в тексте должно быть хотя бы одно слово из каждой группы ключевых слов, для остальных — ≥ половины слов запроса длиной ≥ 3 букв; 5 кредитов за запрос. **Social:** отдельного поиска по теме нет; Reddit через `/web/scrape` (`reddit-search`, `reddit-subreddit`) сейчас даёт `WEBSITE_ACCESS_ERROR` на всех URL (0 кредитов), TikTok/Instagram — только профили/посты, не по теме. Итог: fallback — news + синтетический рой (код Reddit оставлен, но выключен по умолчанию (запросы падали с WEBSITE_ACCESS_ERROR и тратили половину лимита Context.dev 10 запросов в минуту); включить `REDDIT_ENABLED=1` в `.env`, если доступ появится).

## 7. Промпт для нового AI-ассистента
```
Мы команда "The Kerfufflers" на Junction 2026 (Espoo, 13–15.11.2026), проект Live Swarm Radar. Нас двое: P1 «Труба» (ingest, БД, деплой, API, дашборд) и P2 «Мозг» (детектор, синтетика, eval).
Прочитай CLAUDE.md, затем docs/workflow.md (как работаем) и карточку своей задачи в docs/tasks.md. Контракт: contracts/models.py (меняем только вдвоём).
Шире контекст — только если нужно: docs/HANDOFF.md (план и сроки), docs/architecture.md (MUST/SHOULD/CUT), docs/signal-processing.md, docs/submission-draft.md.
Основной челлендж: Decode the Noise (Hostinger). Тех: Context.dev (ядро), Gemini; Codex пока не используем (возможно позже).
Финальный сабмит: воскресенье 10:00 (Хельсинки).
Отвечай по-русски: коротко, точно, с примерами, дружелюбно.
Я — <P1/P2>. Текущая задача: <ID из docs/tasks.md>.
```
