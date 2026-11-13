# HANDOFF: Live Truth Radar · The Kerfufflers · Junction 2026

*Всё, что нужно, чтобы продолжить в новой сессии или на другом компьютере.*

## 1. Что мы строим
**Live Truth Radar** — «радар» для онлайн-манипуляций: смотрит на живой веб, находит координированные бот-кампании и приёмы пропаганды и объясняет каждый вердикт с источниками и честными метриками ложных срабатываний. Подход взят из обработки сигналов (matched filter, CDMA-деспрединг, CFAR, SPRT).

- **Основной челлендж:** Decode the Noise (Hostinger) → [challenge-decode-the-noise.md](challenge-decode-the-noise.md)
- **Тех-челленджи:** Context.dev (ядро), Oxylabs, Gemini (Codex: возможно позже) → [tech-challenges.md](tech-challenges.md)
- **Подход:** [signal-processing.md](signal-processing.md) · **Архитектура:** [architecture.md](architecture.md)
- **Текст сабмита:** [submission-draft.md](submission-draft.md)

## 2. Событие
- **Junction 2026**, 13–15.11.2026, **Hype Areena, Kivenlahti, Espoo** (метро ~30 мин от центра Хельсинки). Площадка 24/7, спальных мест нет.
- Команда до 4 человек. Код уходит в open source (MIT), владение у команды. Призы всего €100k.
- Судейство: победителей треков выбирают партнёры → peer review выбирает топ-5 → живой питч перед гранд-жюри.
- Форма сабмита: Project Name (≤30 символов), Punchline (≤200), Description (≤5000, markdown), один основной челлендж, Demo link, Source code, Video, Other link, презентация (PDF/PPTX/PPT/ODP/KEY ≤20 МБ), тех-челленджи (несколько).

## 3. Ключевые сроки
| Когда | Что |
|---|---|
| **Пт 23:59** | **Preliminary submission** |
| Сб 12:00 | Открывается форма сабмита |
| Сб 13:00 | Доклад Hostinger «Vibe Coding Solved Building…» |
| **Вс 10:00** | **Финальный сабмит** |
| Вс 14:00 / 15:10 / 15:50 | Финал / победители челленджей / победитель Junction |

## 4. Обязательно не забыть
- Живой **публичный URL на Hostinger VPS** к концу хакатона.
- **Метрики** (precision, FPR) на размеченных данных: это 40% оценки Hostinger.
- Для Context.dev: заметка «какие эндпоинты и зачем»; `maxAgeMs: 0` для свежих данных.
- Для Oxylabs: живой вызов в демо + URL источников; **отменить подписку после**.
- Codex пока не используем (код пишем с Claude). Если подключим, ведём скриншоты и лог.
- Коды и ключи **не коммитим**: они в Junction Hackerpack и в `.env` (git-ignored).

## 5. Открытые вопросы
- Роли в команде (данные, ML, бэкенд/деплой, фронт/питч).
- Датасеты для метрик: SemEval-2020 Task 11, TwiBot, Cresci (проверить лицензии) + своя мини-разметка и синтетический рой.

## 6. Промпт для нового AI-ассистента
```
Мы команда "The Kerfufflers" на Junction 2026 (Espoo, 13–15.11.2026), проект Live Truth Radar.
Прочитай docs/HANDOFF.md, затем docs/signal-processing.md и docs/architecture.md.
Основной челлендж: Decode the Noise (Hostinger). Тех: Context.dev, Oxylabs, Gemini (Codex возможно позже).
Финальный сабмит: воскресенье 10:00 (Хельсинки).
Отвечай по-русски: коротко, точно, с примерами, дружелюбно.
Следующий шаг: <впиши, что нужно>.
```
