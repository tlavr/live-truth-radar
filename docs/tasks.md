# Карточки задач

*Одна карточка = одна сессия агента. Как работать с карточкой: [workflow.md](workflow.md#3-цикл-одной-задачи). Типы данных: `contracts/models.py`. Время: Europe/Helsinki.*
*P2 до I1 работает офлайн на `fixtures/items.json` (без сети и БД в тестах). P1 до I1 использует mock-детектор (`fixtures/findings.json`).*
*Пометка «⚙» = интерфейс вне `contracts/models.py`, уже решён (список в [HANDOFF §5](HANDOFF.md#5-план-по-задачам)); менять только вдвоём.*

| ID | Владелец | Дедлайн | Коротко |
|---|---|---|---|
| T0 | оба | пт 22:00 | Кикофф |
| T1 | оба | пт 22:30 | Ключи в `.env` |
| T2 | P1 | пт 23:15 | Проба Context.dev |
| T3 | P2 | пт 23:59 | Предварительный сабмит |
| T4 | P1 | сб 01:00 | Compose-скелет + /health + схема БД |
| T5 | P1 | сб 03:00 | Деплой на Hostinger + HTTPS |
| T6 | P1 | сб 04:30 | Ingest-поллинг → БД |
| T7 | P2 | сб 09:00 | Эмбеддинги + matched filter |
| T8 | P1 | сб 11:00 | API на БД + mock-детектор |
| T9 | P2 | сб 11:00 | Генератор синтетического роя |
| T10 | P2 | сб 14:00 | Корреляция → CFAR → SPRT → Finding (чекпоинт) |
| I1 | оба | сб 15:00 | Интеграция на VPS |
| T11 | P1 | сб 16:00 | Объяснение Gemini |
| T12 | P1 | сб 19:00 | Дашборд + /metrics + кнопка инжекта |
| T13 | P2 | сб 19:00 | Eval → MetricsReport |
| T14 | оба | сб 20:30 | Разметка ~50 живых аккаунтов |
| S1 | P1 | вс 01:00 | SHOULD: Source Trust |
| T15 | оба | вс 02:00 | Тюнинг порогов, стабильность |
| F | оба | вс 02:00 | Feature freeze |
| T16 | оба | вс 03:00 | Видео 2 мин |
| T17 | P2 | вс 08:00 | Слайды, описание, README |
| T18 | оба | вс 10:00 | Финальный сабмит |

---

### T0 · оба · пт 22:00
**Цель:** за 45 минут договориться обо всём, что потом дорого менять.
**Вход/выход:** `contracts/models.py`, `fixtures/*.json`, `CLAUDE.md` → решения записаны в `docs/HANDOFF.md` (темы, Codex да/нет, подтверждение интерфейсов ⚙).
**Готово, когда:** чек-лист [workflow.md §2](workflow.md#2-t0--кикофф-45-мин-до-пт-2200) пройден; `make test` зелёный у обоих; тиммейт в GitHub.
**Тесты:** нет (только прогнать `make test`).
**Зависит от:** —

### T1 · оба · пт 22:30
**Цель:** все ключи и доступы на руках.
**Вход/выход:** Context.dev API key, Gemini (AI Studio, аккаунт 18+), Hostinger VPS + домен, Hostinger AI Router → `.env` по образцу `.env.example` (у обоих; в git не попадает).
**Готово, когда:** у каждого ключа есть один ручной успешный запрос (curl/python), есть SSH на VPS, домен резолвится на IP VPS.
**Тесты:** нет.
**Зависит от:** T0

### T2 · P1 · пт 23:15
**Цель:** понять, дают ли Context.dev news search и social scrape **автора и время** (без них нет корреляции аккаунтов).
**Вход/выход:** скрипт-проба `ingest/probe_contextdev.py` → сырые ответы в `cache/` (git-ignored), 20–50 нормализованных `Item` с псевдонимами авторов (`contracts.pseudonym`) в `fixtures/items_live_sample.json`; результат одной строкой в HANDOFF §«Открытые вопросы».
**Fallback:** если в соцсетях нет автора/времени → берём news search (автор = домен/автор статьи, время публикации) + синтетические аккаунты из T9; это **честно** пишем в HANDOFF, в слайдах и описании.
**Готово, когда:** сэмпл парсится в `Item` (`tz-aware UTC`, `source` = `context_social`/`context_news`), в HANDOFF записано, какие поля реально есть.
**Тесты:** `test_contracts.py` уже парсит все `fixtures/items*.json`, новый файл подхватится сам.
**Зависит от:** T1

### T3 · P2 · пт 23:59
**Цель:** отправить предварительный сабмит.
**Вход/выход:** блок из `docs/submission-draft.md` → форма Junction.
**Готово, когда:** форма отправлена, подтверждение получено; в HANDOFF отмечено.
**Тесты:** нет.
**Зависит от:** T0

### T4 · P1 · сб 01:00
**Цель:** скелет сервисов, который поднимается одной командой.
**Вход/выход:** `infra/docker-compose.yml` (caddy, api, worker, db=Postgres), `infra/Caddyfile`, `infra/schema.sql` (таблицы `actors`, `items`, `findings`, `labels`; без pgvector), `api/main.py` с `GET /health` → `{"status":"ok"}`, заглушка `ingest/worker.py`.
**Готово, когда:** `docker compose -f infra/docker-compose.yml up` локально → `curl localhost/health` = 200 (через caddy, порт 80), схема применилась (таблицы видны в `psql`); `./eval` смонтирован в api read-only, `cache/` — volume.
**Тесты:** нет новых (схема БД → ревью вторым агентом, это рискованное).
**Зависит от:** T1

### T5 · P1 · сб 03:00
**Цель:** живой публичный HTTPS-URL на Hostinger (обязательное требование челленджа).
**Вход/выход:** VPS + домен; `.env` на сервере (не в git); `tests/smoke.py`, `make smoke URL=...`. Инструкция деплоя 5–10 строк в `infra/README.md`; `make deploy VPS=...` работает (ssh + `git pull` + `compose up -d --build`).
**Готово, когда:** `https://<домен>/health` = 200 с валидным сертификатом; `make smoke URL=https://<домен>` проходит (`/api/alerts` пока может отдавать пустой `AlertsResponse`).
**Тесты:** `tests/smoke.py` (/health, схема /api/alerts).
**Зависит от:** T4

### T6 · P1 · сб 04:30
**Цель:** живой поток данных в БД.
**Вход/выход:** `ingest/contextdev.py` (news search + social scrape, кэш ответов), `ingest/worker.py`: каждые 2–5 мин по 3–5 темам из `.env` → нормализация в `Item` → upsert в `items`/`actors` (дедуп по `id`) → запоминает `last_poll_at`. Детектор (пока mock) вызывается на окне `DETECT_WINDOW_HOURS` по теме, findings темы заменяются атомарно.
**Готово, когда:** на VPS worker крутится ≥ 2 циклов, в `items` растёт число строк по всем темам, повторный цикл не дублирует; кэш не дёргает API на одинаковый запрос.
**Тесты:** нет (сеть). Нормализация проверяется парсингом в `Item`.
**Зависит от:** T2, T5

### T7 · P2 · сб 09:00
**Цель:** «согласованный фильтр»: насколько каждый пост похож на шаблоны нарративов темы.
**Вход/выход:** `detect/embed.py`: `embed(texts) -> np.ndarray` (Gemini embeddings + кэш на диск; офлайн-фолбэк — детерминированный hashing-эмбеддер для тестов), `detect/matched_filter.py`: банк шаблонов на тему → score на `Item`. Шаблоны строятся **из данных** (центроиды кластеров почти-дубликатов в окне) + опционально ручные `detect/templates/<topic>.json`; инжектируемых сообщений из `synth/variations/` в банке быть не должно (иначе eval «круговой»). `embed()` читает `LTR_EMBEDDER` (`hash` в тестах, ставит `tests/conftest.py`), кэш в `cache/embeddings/`.
**Готово, когда:** на `fixtures/items.json` посты синтетической кампании (`campaign_id` не `None`) имеют заметно более высокий score, чем органика; работает без сети (фолбэк).
**Тесты:** 1–2 в `tests/test_detect_matched_filter.py` (похожий текст > непохожего), без сети.
**Зависит от:** T0 (фикстуры), T1 (ключ Gemini для живых эмбеддингов)

### T8 · P1 · сб 11:00
**Цель:** API, на котором можно строить дашборд, до готовности детектора.
**Вход/выход:** `api/mock_detect.py` с той же сигнатурой, что `detect.pipeline.detect`, отдаёт `fixtures/findings.json`; worker сохраняет findings в БД; `GET /api/alerts` → `AlertsResponse`, `GET /api/metrics` → `MetricsReport` (пока заглушка с `None`), `POST /api/inject` → кладёт синтетические items в БД и сразу запускает детектор по теме. ⚙ правила инжекта — HANDOFF §5 (окно 15 мин до «сейчас», новые `campaign_id`/id на каждый инжект); до T9 берёт синтетику из `fixtures/items.json`, после T9 — `synth.campaign.make_campaign(...)`; `/api/metrics` читает `eval/report.json` (смонтирован read-only), если он есть. Плюс `ingest/export_sample.py`: последние N часов `items` → `fixtures/items_live_sample.json` с псевдонимами (для P2, обновлять на каждом синке).
**Готово, когда:** на VPS `/api/alerts` и `/api/metrics` проходят валидацию моделей; два `POST /api/inject` подряд оба добавляют новые items с `synthetic=true`; `fixtures/items_live_sample.json` закоммичен; `make smoke` зелёный.
**Тесты:** `tests/smoke.py` расширить на `/api/metrics`.
**Зависит от:** T6

### T9 · P2 · сб 11:00
**Цель:** тестовая цель для радара: синтетический рой с известной правдой.
**Вход/выход:** `synth/variations.py`: Gemini пишет ~30 вариаций для **нескольких** месседжей на тему (часть — отложенные для eval) → кэш `synth/variations/<topic>.json` (в git, чтобы офлайн; сеть нужна только чтобы построить кэш). `synth/campaign.py` (можно переиспользовать `synth/fixture_gen.py`, который генерирует `fixtures/items.json` через `make fixtures`): ⚙ `make_campaign(topic: str, now: datetime, *, n_accounts: int = 12, seed: int | None = None) -> list[Item]` — фейковые аккаунты, лаги, `source="synthetic"`, `synthetic=True`; правила времени и id — HANDOFF §5 (`published_at` в `[now − 15 мин, now]`, `campaign_id = inj-<topic>-<HHMMSS>`, id `<campaign_id>-<k>`).
**Готово, когда:** `make_campaign` детерминирован при одном `seed`, работает без сети по кэшу; результат можно вмешать в `fixtures/items.json`.
**Тесты:** 1 тест: все items валидны, `synthetic=True`, общий `campaign_id`, времена в окне 15 мин, два вызова с разным `now` дают разные id.
**Зависит от:** T1 (Gemini для генерации кэша), T7 не обязателен

### T10 · P2 · сб 14:00 · ЧЕКПОИНТ
**Цель:** полный детектор: корреляция аккаунтов → CFAR → SPRT → `Finding`.
**Вход/выход:** `detect/correlation.py` (временные ряды активности аккаунтов по нарративу, кросс-корреляция с лагом → матрица), `detect/cfar.py` (адаптивный порог по фону), `detect/sprt.py` (LLR, пороги из `alpha`/`beta`, трасса), `detect/pipeline.py`: `detect(items, *, alpha=0.02, beta=0.1) -> list[Finding]` (`id = finding_id(topic, accounts)`, `verdict` coordinated/organic/watching, `llr`, `snr_db`, `sprt_trace` + `sprt_upper`/`sprt_lower`, `decided_at_item`, `first_seen`/`last_seen`, `correlation` и `lag_sec` квадратные в порядке `accounts`, `explanation=None`). Математика: `docs/signal-processing.md` §2.2–2.6.
**Готово, когда:** на `fixtures/items.json` синтетический рой → `coordinated`, органика → без `coordinated`; на `fixtures/items_live_sample.json` (если уже есть) не падает и не даёт `coordinated` на органике; заполнены `snr_db` (кластер) и `snr_db_single` (среднее по аккаунту); функция < 2 с на фикстурах.
**Тесты:** 5–8 в `tests/test_detect_*.py`: пик корреляции на лаге; независимые аккаунты без тревоги; SPRT верх/низ на известной LLR; CFAR молчит на ровном фоне и срабатывает на всплеске. Ревью вторым агентом (математика).
**Зависит от:** T7 (T9 не обязателен: в `fixtures/items.json` уже есть рой `swarm-001`)
**Если не готово к 14:00:** S1 вырезаем, P1 подключается к P2 (см. [workflow §9](workflow.md#9-если-отстаём)).

### I1 · оба · сб 15:00
**Цель:** настоящий детектор на живых данных на VPS.
**Вход/выход:** в `ingest/worker.py` импорт `api.mock_detect` → `detect.pipeline.detect`; эмбеддинги Gemini с кэшем `cache/embeddings/` (volume) в worker; `POST /api/inject` → `synth.campaign.make_campaign` + немедленный `detect()` по теме.
**Готово, когда:** на VPS после инжекта в течение минуты в `/api/alerts` появляется `coordinated` с `synthetic=true` (второй инжект тоже срабатывает); живые темы дают findings без падений; mock удалён из пути worker; `make smoke` зелёный.
**Тесты:** `make test` + `make smoke`.
**Зависит от:** T8, T10

### T11 · P1 · сб 16:00
**Цель:** объяснимость: приём манипуляции + цитата + уверенность.
**Вход/выход:** `ingest/explain.py`: `explain(finding: Finding, items: list[Item]) -> Explanation` (Gemini structured output по JSON-схеме `Explanation`; при ошибке/лимите — тот же клиент через Hostinger AI Router; кэш по `finding.id`). Worker заполняет `finding.explanation` для `coordinated`.
**Готово, когда:** у `coordinated`-findings на VPS есть `explanation`, `quote` — дословная подстрока одного из постов, `confidence` в 0..1; при отключённом Gemini срабатывает фолбэк.
**Тесты:** нет (сеть); ответ валидируется pydantic.
**Зависит от:** I1 (можно начать на mock findings после T8)

### T12 · P1 · сб 19:00
**Цель:** одна страница для судей и видео.
**Вход/выход:** `web/index.html` + `web/app.js` (Chart.js): лента алертов из `/api/alerts`, карточка вердикта (посты, heatmap `correlation` с `lag_sec` в подсказке, SNR дБ, SPRT-трасса с порогами `sprt_upper`/`sprt_lower`, приём + цитата); `web/metrics.html` из `/api/metrics` (ROC, рабочая точка, precision/FPR, `failure_examples`), отдаётся по пути `/metrics`; вердикт `watching` подписан «keep watching / не уверены»; в шапке «обновлено N мин назад» из `last_poll_at`; SNR в карточке «`snr_db_single` → `snr_db` дБ»; кнопка «inject test campaign» → `POST /api/inject`. Отдаёт FastAPI.
**Готово, когда:** на `https://<домен>` всё видно без консольных ошибок; инжект → алерт появляется в ленте (обновление поллингом); работает на телефоне.
**Тесты:** нет (UI не тестируем), `make smoke`.
**Зависит от:** T8 (данные mock), I1, T11

### T13 · P2 · сб 19:00
**Цель:** честные цифры для 40% оценки.
**Вход/выход:** `eval/run.py`: многократная инжекция `make_campaign` в фон из живого сэмпла/фикстур → прогон `detect` при разных порогах → ROC (pfa, pd), detection rate, рабочая `operating_pfa`, `mean_posts_to_decision`, `mean_seconds_to_decision` → `eval/report.json` (`MetricsReport`, в git; запуск `make eval`); инжектируются только **отложенные** сообщения, которых нет в банке шаблонов; `failure_examples` — 3–5 реальных промахов/ложных тревог; `live_fpr`/`live_precision`/`n_labelled` — из разметки T14 (⚙ `eval/labels.csv`); после T14 отчёт пересчитать (может и P1: `make eval` читает только `labels.csv` и фикстуры).
**Готово, когда:** `make eval` офлайн на фикстурах пишет валидный `MetricsReport`; после коммита и `make deploy` `/api/metrics` на VPS его отдаёт.
**Тесты:** 1 тест: отчёт валиден, ROC монотонна, значения в [0,1].
**Зависит от:** T9, T10

### T14 · оба · сб 20:30
**Цель:** live precision и live FPR на реальных людях.
**Вход/выход:** рубрика (15 мин) органика / подозрительно / непонятно; `ingest/label_sample.py` (P1, заранее) делает скелет `eval/labels.csv` (`account, topic, alerted, label, note`; `account` — псевдоним): ~25 аккаунтов из алертов + ~25 случайных без алерта из тех же тем, **синтетика исключена**; если реальных алертов < 25 — добираем из `watching` с наибольшим LLR и честно пишем n. Размечаем по реальным хэндлам в БД/дашборде, в файл пишется только псевдоним. До 20:00 разметка, 20:00–20:30 `make eval` + коммит + `make deploy`.
**Готово, когда:** размечено ≥ 40 аккаунтов, `/api/metrics` показывает `live_precision`, `live_fpr`, `n_labelled`.
**Тесты:** нет.
**Зависит от:** I1 (живые алерты), T13

### S1 · P1 · вс 01:00 · SHOULD
**Цель:** «кто стоит за источником» в карточке. Только если все MUST, кроме T14, готовы к сб 20:00 и чекпоинт T10 пройден.
**Вход/выход:** `ingest/source_trust.py` (Context.dev brand/company по домену, кэш) → ⚙ отдельный `GET /api/source/{domain}`, чтобы не менять контракт `Finding`; блок в карточке на дашборде.
**Готово, когда:** для доменов из алертов в карточке видно компанию/возраст/лого или «нет данных»; падение S1 не ломает карточку.
**Тесты:** нет.
**Зависит от:** T12, все MUST

### T15 · оба · вс 02:00
**Цель:** стабильная работа и разумная рабочая точка.
**Вход/выход:** подбор `alpha`, `beta`, параметров CFAR по ROC из T13 и разметке T14 → дефолты в `detect/pipeline.py`/`.env`; `restart: always` в compose; проверка перезапуска VPS.
**Готово, когда:** после `docker compose restart` и ребута всё поднимается само; FPR на живой разметке в пределах выбранной рабочей точки; дефолты записаны в HANDOFF.
**Тесты:** `make test` + `make smoke`.
**Зависит от:** T13, T14

### F · оба · вс 02:00 · FEATURE FREEZE
**Цель:** зафиксировать код для демо.
**Вход/выход:** `main` → тег `freeze`, задеплоен на VPS.
**Готово, когда:** `make test` и `make smoke` зелёные на теге; дальше только багфиксы демо.
**Тесты:** `make test`, `make smoke`.
**Зависит от:** I1, T11–T13, T15

### T16 · оба · вс 03:00
**Цель:** видео 2 минуты на живом демо.
**Вход/выход:** сценарий из `docs/architecture.md` «Демо-сценарий» → видео (живой URL, инжект, карточка, /metrics). Числа только реальные.
**Готово, когда:** видео ≤ 2:00 загружено, ссылка в HANDOFF.
**Тесты:** нет.
**Зависит от:** F

### T17 · P2 · вс 08:00
**Цель:** материалы для судей с реальными числами.
**Вход/выход:** 7 слайдов; финальное описание (из `docs/submission-draft.md`, числа из `/api/metrics`); `docs/codex-log.md` — только если Codex реально использовали. README-раздел «Context.dev endpoints & why» пишет **P1** (его знание; P1 не спит с 07:00).
**Готово, когда:** все числа в слайдах совпадают с живым `/api/metrics`; fallback из T2 (если был) описан честно.
**Тесты:** нет.
**Зависит от:** T13, T14, T16

### T18 · оба · вс 10:00
**Цель:** финальный сабмит.
**Вход/выход:** форма Junction: живой URL, репо, видео, слайды, описание, тех-челленджи (Context.dev, Gemini; Codex только при логе).
**Готово, когда:** форма отправлена до 10:00, живой URL отвечает, `make smoke` зелёный в момент сабмита.
**Тесты:** `make smoke`.
**Зависит от:** T16, T17
