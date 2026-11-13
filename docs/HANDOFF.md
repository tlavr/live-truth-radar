# HANDOFF: Junction 2026 · The Kerfufflers

*Состояние на пт 13.11.2026, 21:05 (Хельсинки). Этот файл — всё, что нужно, чтобы продолжить на другом компьютере или в новой сессии AI.*

## 1. Как продолжить за 1 минуту
1. Все файлы лежат в папке `docs/`.
2. Открой этот файл и `core-noise-wikipedia.md` — там текущий план.
3. Новому AI-ассистенту дай промпт из раздела 7 и приложи файлы из архива.

## 2. Событие
- **Junction 2026**, 13–15.11.2026, **Hype Areena, Kivenlahti, Espoo** (метро ~30 мин от центра Хельсинки). Площадка 24/7, спальных мест нет.
- Команда до 4 человек. Код уходит в open source (MIT), владение у команды. Призы всего €100k.
- Судейство: победителей треков выбирают партнёры → peer review выбирает топ-5 → живой питч перед гранд-жюри.
- Форма сабмита: Project Name (≤30 символов), Punchline (≤200), Description (≤5000, markdown), один основной челлендж, Demo link, Source code, Video, Other link, презентация (PDF/PPTX/PPT/ODP/KEY ≤20 МБ), тех-челленджи (несколько).

## 3. Ключевые сроки
| Когда | Что |
|---|---|
| **Пт 23:59** | **Preliminary submission** |
| Сб 11:00 | Воркшоп Cala |
| Сб 12:00 | Открывается форма сабмита; воркшоп Intel |
| Сб 13:00 | Доклад Hostinger «Vibe Coding Solved Building…» |
| Сб 13:30–18:30 | Воркшопы Modal, Exa и др. |
| **Сб 14:00** | 🧭 Наше решение: основной челлендж #4 или #19 |
| **Вс 10:00** | **Финальный сабмит** |
| Вс 14:00 / 15:10 / 15:50 | Финал / победители челленджей / победитель Junction |

## 4. Что решили
1. Из 19 основных челленджей понравились #4, #11, #12, #19 → **сузили до #4 Decode the Noise (Hostinger) и #19 Wikipedia Through Time (MariaDB).**
2. Общее ядро **«Truth Rewind»** — машина времени для текста: хранит версии (MariaDB system-versioned tables), ищет похожие тексты (MariaDB VECTOR), находит переписывание смысла, координированные «рои» акторов и приёмы манипуляции, объясняет с доказательствами, считает метрики (precision/FPR).
3. Деплой на **Hostinger VPS** (обязательно для #4, полезно для #19).
4. Строим ядро на данных Википедии (готовые датасеты, бесплатная разметка через reverts), основной челлендж выбираем в **сб к 14:00**.
5. Тех-челленджи (план): **Gemini, Codex, Gemma, Verda или Modal, Nemotron, Context.dev, Oxylabs**, + CRACI по времени. Aiven не берём (основная БД MariaDB).

## 5. Открытые вопросы
- Состав команды и навыки (кто данные/БД, ML, бэкенд/деплой, фронт/питч).
- Финальное имя проекта (рабочее: Truth Rewind) и punchline.
- Какие открытые датасеты пропаганды/ботов брать для метрик #4 (кандидаты: SemEval-2020 Task 11, TwiBot, Cresci — проверить лицензии).
- Формат датасетов MariaDB (посмотреть репозитории ниже).

## 6. Ссылки, коды и требования по выбранным

### #4 Decode the Noise (Hostinger) · €2000/1000/500
- Обязательно: живой публичный URL на Hostinger. Судят: 40% качество детекции, 25% техника+деплой, 20% оригинальность, 15% демо.
- Даёт: VPS KVM 2 (2 vCPU, 8 ГБ, 100 ГБ, Docker, домен), AI Router (150+ моделей), AI Builder, MCP: github.com/hostinger/api-mcp-server, docs.hostinger.com/hostinger-connector. Менторы на стенде Hostinger.

### #19 Wikipedia Through Time (MariaDB) · €1000 + €1000 UpCloud / 500 / 250
- Треки: RAG (vector search), SVT (system-versioned tables), оба = бонус. Судят по 20%: MariaDB, реализация/масштаб, польза, дизайн, оригинальность.
- Данные: финская Википедия, история Финляндии, 3 размера. Нужны мультиязычные эмбеддинги.
- Репозитории: github.com/MariaDB/mariadb-wikipedia-datasets · github.com/MariaDB/mariadb-vector-wikipedia-rag · github.com/MariaDB/mariadb-system-versioning-wikipedia

### Кредиты и коды тех-партнёров
| Партнёр | Как получить | Условие зачёта |
|---|---|---|
| Gemini | Google AI Studio, инструкция от DeepMind на месте (18+) | Объяснить, почему Gemini важен |
| Codex | Личная ссылка в Hackerpacks на hackjunction.app ($100/чел) | Показать, как помог строить |
| Gemma | Через Featherless / Modal / Verda / Hugging Face | Креативное использование |
| Verda | console.verda.com + форма из Hackerpack (€200/команда), QR на столе; стенд 6, 3 этаж | Документировать процесс + саммари в их Discord |
| Modal | modal.com, код **VVX-2QX-8HW** ($100/чел) | Modal в ядре, живой деплой |
| Nemotron | build.nvidia.com (OpenAI-совм., base `https://integrate.api.nvidia.com/v1`, ~40 req/мин на ключ) или эндпоинт Verda | Текст в форме: модель, что делает, как улучшали |
| Context.dev | context.dev/signup, код **[код в Junction Hackerpack]** (50 000 кредитов) | ≥1 эндпоинт в ядре + заметка какие и зачем; `maxAgeMs: 0` для свежести |
| Oxylabs | dashboard.oxylabs.io, план Flexible $500 с кодом **JUNCTION2026** (100% скидка) | Живой /search или /scrape + URL источников. ⚠️ **Отменить подписку после!** |
| CRACI | Код в Discord `#craci` или на стенде; platform.craci.com | CI на `runs-on: craci` + креативное использование API |
| Exa | dashboard.exa.ai/billing, код **[код в Junction Hackerpack]** | (ассет, не наш челлендж) |
| Claude | $20/чел, ссылка в Hackerpacks | — |
| Featherless | Купон [код в Junction Hackerpack] ($50), base `https://api.featherless.ai/v1` | — |
| IronShard | console.ironshard.dev, код [код в Junction Hackerpack] (S3 для больших файлов/датасетов) | — |

Исходник с описаниями и ключами в репо не кладём (там секреты), он лежит у команды отдельно.

## 7. Промпт для нового AI-ассистента
```
Мы команда "The Kerfufflers" на хакатоне Junction 2026 (Espoo, 13–15.11.2026).
Прочитай HANDOFF.md (текущее состояние и решения) и core-noise-wikipedia.md (архитектура ядра "Truth Rewind").
Полные описания челленджей и ключи: исходник у команды (не в репо).
Мы выбираем между #4 Decode the Noise (Hostinger) и #19 Wikipedia Through Time (MariaDB), решение в субботу к 14:00.
Финальный сабмит: воскресенье 10:00 (Хельсинки).
Отвечай по-русски: коротко, точно, с примерами, объясняй просто, дружелюбно.
Следующий шаг: <впиши, что нужно>.
```

## 8. Файлы в архиве
| Файл | Что внутри |
|---|---|
| `HANDOFF.md` | Этот файл: состояние, решения, коды |
| `core-noise-wikipedia.md` | ⭐ Текущий план: ядро Truth Rewind для #4 и #19, схема данных, модули, тех-челленджи, план на 48 ч |
| `core-4-challenges.md` | Общее ядро для 4 челленджей (#4, #11, #12, #19), матрица тех-челленджей |
| `challenges-table.md` | Все челленджи в таблицах |
| `challenges-detailed.md` | Подробные карточки всех 19 основных и всех тех-челленджей |
| `challenges-analysis.md` | Первое саммари + топ-идеи |
| `ideas.md` | Самые первые догадки по названиям (до публикации описаний, частично устарели) |
| `Junction-2026-Challenges-and-Developer-Assets.md` | Исходник (не в репо, есть ключи) |
