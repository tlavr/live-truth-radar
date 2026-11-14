# Архитектура Live Swarm Radar

*Урезанный объём под хакатон: делаем ядро глубоко, а не всё поверхностно. Нас двое: P1 «Труба» и P2 «Мозг». План, сроки и чекпоинты: [HANDOFF.md](HANDOFF.md#5-план-по-задачам), карточки задач: [tasks.md](tasks.md).*

## Как работает (для ребёнка)
Представь **дежурного детектива**, который сидит на Hostinger и **каждые несколько минут смотрит в интернет** через бинокль Context.dev.
1. Собирает новые статьи и посты по нескольким темам.
2. Замечает, что **17 аккаунтов за 10 минут написали почти одно и то же** → «рой!».
3. Читает тексты и говорит: «Тут **запугивание**: „если не сделаете X, завтра будет катастрофа“, без фактов».
4. Честно говорит, **насколько уверен**, и показывает, как часто он ошибается (метрики).

## Объём: MUST / SHOULD / CUT
| Уровень | Что | Когда |
|---|---|---|
| **MUST** | Ingest (Context.dev news search + social scrape, поллинг каждые 2–5 мин, 3–5 тем), Swarm Detector (эмбеддинги → луч на тему (бимформинг) → отбеливание → коррелятор пар «время × смысл» → CFAR → SPRT, SNR в дБ; дизайн: [signal-processing.md §3](signal-processing.md)), объяснение вердикта Gemini (приём + цитата + уверенность), Eval (инжекция синтетического роя + ~50 размеченных живых аккаунтов), дашборд на одну страницу + `/metrics` (с T12d — live-сканирование по Check) + инжекция только через Bot Hive `/redteam` (в продукте кнопки нет), деплой на Hostinger | К Сб 19:00–20:30 (T0–T14, I1) |
| **SHOULD** | Только **S1** — Source Trust через Context.dev brand/company (P1) | Только если весь MUST, кроме T14, готов к Сб 20:00; дедлайн Вс 01:00; отдельный `GET /api/source/{domain}` |
| **CUT** | Oxylabs (целиком, включая гео-`/search`); SemEval; Context.dev scrape полного текста, monitors/webhooks (заменены поллингом), research, structured extraction; Fact-check, Change Watch; Gemma, Nemotron, Modal / Verda, Aiven, CRACI; спектрограммы, карта delay-Doppler (задержка от первого поста × скорость роста; не путать с телом неопределённости «задержка × смысловая расстройка», оно MUST), MMSE-фьюжн; бот-датасеты TwiBot/Cresci | Только в слайд «что дальше» |

*Это канонический список уровней: остальные файлы на него ссылаются.*

## Схема (MUST)
```
          ┌──────────────── Hostinger VPS (Docker Compose, публичный HTTPS-домен) ───────────┐
 ВЕБ      │                                                                                   │
 новости ─┼─► worker: поллинг Context.dev и Bluesky каждые N мин ──► db: Postgres   │
 соцсети  │   (news search) + Bluesky searchPosts            (items, actors, inject_req.,    │
          │                                                   findings, labels)              │
          │   worker: эмбеддинги Gemini → отбеливание → корреляция аккаунтов                │
          │           → CFAR → SPRT → вердикт → объяснение Gemini (приём + цитата)           │
          │                                                                                   │
          │   api: FastAPI (REST + отдаёт дашборд)  ──►  дашборд: алерты, карточка, метрики │
          │   eval: синтетический рой в живом потоке → ROC, precision, FPR, время до решения │
          └───────────────────────────────────────────────────────────────────────────────────┘
             LLM: Gemini (основной) · Hostinger AI Router (запасной, клиент `openai`, модель из `HOSTINGER_AI_ROUTER_MODEL`)
```

## Модули
| # | Модуль | Уровень | Кто | Папка | Что делает | Тулы |
|---|---|---|---|---|---|---|
| 0 | **Live Ingest** | MUST | P1 | `ingest/` | Каждые 2–5 мин тянет свежие статьи и посты по 3–5 темам, сохраняет текст, автора, время, URL как `Item` (T6b: у каждого источника свой клиент и свой `since`; `BLUESKY_ENABLED=0` выключает Bluesky) | Context.dev news search + Bluesky `searchPosts` (без логина; Reddit через Context.dev — за флагом, по умолчанию выкл) |
| 1 | **Swarm Detector** | MUST | P2 | `detect/` | Эмбеддинги + луч на тему (бимформинг) + отбеливание (режекция клаттера темы) → коррелятор пар аккаунтов «время × смысл» с лагом → CFAR по парам → рой ≥ 3, когерентное накопление, SNR в дБ → SPRT (решение) + проверка «эхо новости» → `Finding` | Gemini embeddings + numpy/scipy (возможно, Codex) |
| 2 | **Explain / Technique** | MUST | P1 | `ingest/explain.py` (в worker) | Для `Finding`: приём манипуляции + цитата-доказательство + уверенность + объяснение простыми словами → `Explanation` | Gemini structured output; AI Router запасной |
| S | **Synthetic Swarm** | MUST | P2 | `synth/` | ~30 вариаций для нескольких месседжей (часть отложена для eval), фейковые аккаунты с лагами, `synthetic = true`, `campaign_id` | Gemini |
| E | **Eval Harness** | MUST | P2 | `eval/` | ROC (Pd vs Pfa), доля найденных, постов/секунд до решения → `MetricsReport`; live FPR / precision по разметке | numpy |
| UI | **Radar Dashboard** | MUST | P1 | `web/` | Главный экран: выбор темы (луча), лента алертов, карточка со светофором, фразой и телом неопределённости, посты, приём; вкладка «Детали»: heatmap корреляции, SNR, SPRT-трасса; `/metrics`, live-сканирование по Check (инжекция — только Bot Hive `/redteam`) | Статический HTML + JS + Chart.js, отдаёт FastAPI |
| Ops | **Deploy** | MUST | P1 | `infra/` | Docker Compose, caddy HTTPS, Hostinger VPS, `tests/smoke.py` | Hostinger |
| 3 | **Source Trust** | SHOULD (S1) | P1 | `ingest/` | Кто стоит за доменом: компания, возраст, чужое лого | Context.dev brand + company |
| — | Geo Echo (Oxylabs), Fact-check, Change Watch | CUT | — | — | — | — |

## Репо и контракт
```
CLAUDE.md                 общее: инструкции агентам
contracts/models.py       ОБЩЕЕ — меняем только вдвоём
fixtures/items.json       тестовые данные (генерирует `make fixtures`, руками не править)
fixtures/items_live_sample.json  реальный сэмпл из БД (T2, обновляется на синках), авторы псевдонимизированы
fixtures/items_live_background.json  живой фон для eval за 48 ч (T15), авторы псевдонимизированы, email замаскированы
fixtures/findings.json    пример находок (их отдаёт мок-детектор P1 до I1)
ingest/  api/  web/  infra/      P1
detect/  synth/  eval/           P2
tests/                    test_contracts.py (общий), test_detect_*.py (P2), smoke.py (P1)
docs/                     план и workflow
Makefile                  `make test` (pytest, без сети, <5 с), `make smoke URL=...`
```
Слои связаны **одним контрактом** — pydantic v2 в [`contracts/models.py`](../contracts/models.py) (источник истины, здесь только кратко):
- `Item` — пост/статья: `source` (`context_social` / `context_news` / `synthetic`), `author`, `published_at` (UTC), `text`, `url`, `topic`, `synthetic`, `campaign_id` (ground truth только у синтетики).
- `Finding` — вердикт (`coordinated` / `organic` / `watching`), `accounts`, `item_ids`, `llr`, `sprt_trace`, `sprt_upper` / `sprt_lower` (пороги для графика), `decided_at_item`, `first_seen` / `last_seen`, `correlation` и `lag_sec` (квадратные матрицы в порядке `accounts`, для heatmap), `id` = `finding_id(topic, accounts)` (стабильный), `snr_db` (весь рой после накопления) и `snr_db_single` (средняя пара до накопления: «x → y дБ»), `explanation: Explanation | None` (`technique`, `quote`, `confidence`, `summary`), `synthetic`, необязательные `ambiguity` (сетка «задержка × смысловая расстройка» для главного экрана) и `note` (например, «эхо новости»).
- `AlertsResponse` (+ `last_poll_at`: «обновлено N мин назад»), `MetricsReport` (ROC, detection rate, рабочая Pfa, постов/секунд до решения, live FPR / precision, `n_labelled`, `failure_examples`; необязательные `pd_by_size`, `swarm_purity`, `live_precision_ci`).
- Вход детектора (P2): `detect.pipeline.detect(items, *, alpha=0.02, beta=0.1) -> list[Finding]`.
- API (P1): `GET /health`, `GET /api/alerts` → `AlertsResponse`, `GET /api/metrics` → `MetricsReport`, `GET /api/items?ids=…` → `list[Item]` (тексты для карточки), `POST /api/inject` (API без кнопки в продукте; детектор запускает worker через `inject_requests`).

Интерфейсы вне контракта (генератор для `/api/inject`, `eval/report.json`, `eval/labels.csv`, `/api/source/{domain}`, расположение worker): [HANDOFF.md §5](HANDOFF.md#5-план-по-задачам).

P2 работает офлайн на `fixtures/` (без сети и БД), P1 — с мок-детектором до интеграции **I1 (Сб 15:00)**. Подробнее: [workflow.md](workflow.md).

## Стек на VPS (Docker Compose)
| Сервис | Что внутри |
|---|---|
| `caddy` | Reverse proxy + автоматический HTTPS для домена Hostinger |
| `api` | Python, FastAPI: REST для дашборда, отдаёт статический дашборд |
| `worker` | Python (`ingest/worker.py`): поллинг Context.dev, `detect()` (numpy/scipy), объяснения Gemini. Eval гоняет P2 отдельно (`python -m eval.run` → `eval/report.json`) |
| `db` | Postgres |

Фронт без сборки (HTML + JS + Chart.js), чтобы не тратить время на тулчейн. Это решение по умолчанию: если в команде есть человек, который быстро делает React, можно поменять, не трогая остальное.

## Хранилище
Эмбеддинги кэшируются на диске (`cache/`, volume, в git не попадает); векторный поиск в БД не нужен, поэтому pgvector не берём.
Таблицы: `actors` (аккаунт/автор), `items` (пост/статья: текст, автор, время, URL, источник, флаг `synthetic`), `findings` (вердикт, LLR, SNR, объяснение), `labels` (ручная разметка).
Ответы Context.dev кэшируем у себя (повторный запрос стоит тех же кредитов). Схема БД — P1 (T4), но поля `items` / `findings` повторяют контракт.

## Данные для метрик (40% оценки!)
| Уровень | Набор | Для чего |
|---|---|---|
| MUST | **Синтетический рой:** LLM пишет ~30 вариаций для нескольких месседжей (часть отложена для eval; детектор на синтетике не обучается), разносим по фейковым аккаунтам с лагами, прячем в реальные посты (`synthetic = true`) | ROC и время до решения для Swarm Detector |
| MUST | **Ручная разметка ~50 живых аккаунтов (T14, оба):** рубрика 15 мин, единица — аккаунт, классы «органика / подозрительно / не понятно»; **~25 из алертов** (→ live precision) + **~25 случайных без алерта** из тех же тем (→ live FPR) | Precision и FPR на реальных людях, отдельно от синтетики |
| CUT | SemEval-2020 Task 11 (корпус приёмов) | Вдвоём не успеем; приёмы показываем объяснением с цитатой, без отдельной метрики |
| CUT | TwiBot-20/22, Cresci-2017 | Доступ по запросу, не успеем |

## Демо-сценарий на 2 минуты
1. Открываем `https://<домен Hostinger>`: лента живых алертов по 3–5 темам (обновляется поллингом).
2. Выбираем тему и жмём Check → идёт live-сканирование (строка «Live · …», фон спокоен). В соседней вкладке Bot Hive (`/redteam`) жмём Attack → посты ботов появляются там по одному, а на экране темы за ~30 с собирается рой и появляется алерт «🐝 Рой: [N] аккаунтов, SNR из [x] дБ (одна пара) до [y] дБ (весь рой)» (числа — реальные, из демо); в Bot Hive метки «Detected» и «Caught N / M».
3. Карточка: светофор и фраза, тело неопределённости (острый пик в углу карты «задержка × смысловая расстройка»), посты, приём «🎭 Fear appeal» с цитатой; на вкладке «Детали» heatmap корреляции аккаунтов и SPRT-трасса («решение на [k]-м посте»).
4. (SHOULD S1) «🔗 Источник: …» — кто стоит за доменом, от Context.dev brand/company.
5. Страница `/metrics`: ROC, рабочая точка, Pd от размера роя, чистота роя, live precision с интервалом и FPR, примеры ошибок.

## Главные риски
| Риск | Что делаем |
|---|---|
| Social scrape Context.dev не отдаёт автора или время | Подтвердилось в T2 (reddit-search падает с WEBSITE_ACCESS_ERROR). Решение T6b: соцсеть = Bluesky `searchPosts` (автор = хэндл, время = `createdAt`/`indexedAt`). Без логина `cursor` даёт 403, листаем по `until`. Запасной вариант: `BLUESKY_ENABLED=0` → только новости + синтетический рой, авторы = домены |
| Мало реальных роёв за выходные | Инжекция тестовой цели: это и метрика, и демо |
| Лимиты Gemini | Hostinger AI Router как запасной LLM; эмбеддинги кэшируем |
| Деплой ломается в последний момент | Деплой скелета к Сб 03:00 (T5), smoke после каждого деплоя, фича-фриз кода (F) в Вс 02:00 |
| Детектор не готов к интеграции | Чекпоинт T10 Сб 14:00: P1 работает на моке, при отставании S1 не делаем, P1 помогает P2 |

Зачем каждый тул и условия призов: [tech-challenges.md](tech-challenges.md).
