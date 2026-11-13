# Junction 2026: шпаргалка и идеи для The Kerfufflers

## 1. Что важно знать (время Хельсинки, UTC+2)

| Когда | Что |
|---|---|
| Пт 13.11, 16:00 | Двери открыты, Hype Areena, Kivenlahti, Espoo |
| Пт 18:00 | Открытие (keynote Google DeepMind), тут раскроют челленджи |
| Пт 19:30 | Старт хакинга |
| Пт 20:00–21:30 | Воркшопы: Google DeepMind, Verda, Arduino, MLH x GitHub |
| **Пт 23:59** | **Предварительная заявка (preliminary submission)** |
| Сб 12:00 | Открывается форма сабмита; воркшоп Intel x Ignite Next |
| Сб 13:30–18:30 | Воркшопы Modal, Exa и др. |
| **Вс 15.11, 10:00** | **Финальный сабмит** |
| Вс 14:00 | Финал, 15:10 победители челленджей, 15:50 главный победитель |

- Команда до 4 человек. Призы всего €100k. Код уходит в open source под MIT.
- Судейство: каждый партнёр выбирает своих победителей → peer review выбирает топ-5 → топ-5 питчат жюри (Supercell, Lifeline Ventures, DeepMind, Verda, Context.dev, AfterQuery...).
- Спать на площадке негде, площадка открыта 24/7.
- Hardware Lab от Arduino: платы UNO Q, компоненты, 3D-принтеры, роборуки LeRobot.

## 2. Что могут значить челленджи (догадки до открытия)

| Челлендж | Вероятный партнёр | Что, скорее всего, попросят |
|---|---|---|
| The Internet Butler / Personal Assistant | Exa / Hostinger / Meta (?) | Агент, который сам делает дела в вебе: бронирует, сравнивает, заполняет формы |
| Wikipedia Through Time | Wikimedia / Aalto (?) | Показать, как меняются статьи и факты во времени (история правок, споры, тренды) |
| Personal Economic Trainer | S-Pankki (S-Bank) | Финансовый тренер: учит копить и тратить с умом, как фитнес-тренер, но для денег |
| Rethinking Recruitment | AfterQuery / Tieto (?) | Найм по реальным навыкам, а не по резюме; честный матчинг |
| Give the Robot a Brain | Arduino (LeRobot) | LLM/VLM, который понимает команду «убери кубик» и управляет рукой |
| The Robot Teleoperation Challenge | Rokoko (motion capture) | Управлять роботом движениями своего тела/перчаткой |
| Trusted Trade Agents | Valio Aimo / Bahn Express (?) | AI-агенты покупателя и продавца договариваются о сделке, но так, чтобы им можно было доверять |
| Break the Agent | AfterQuery / CRACI (?) | Red-teaming: найти, как сломать AI-агента (prompt injection, утечки) |
| Intel Physical AI: See it, Detect it, Act on it | Intel x Ignite Next | Камера → распознавание на edge-железе Intel (OpenVINO) → реальное действие |
| The Web Is Your Real-Time Database | Exa / Context.dev / Oxylabs | Делать запросы к вебу как к базе данных, свежие структурированные данные |
| Make Blueprints Talk | City of Espoo / строители (?) | Чертежи и планы зданий → понятные ответы, проверки, 3D |
| AI Glasses for Everyone, Everyday | Meta | Приложение для умных очков: помощь в быту, доступность для слабовидящих |
| Beyond the Clinic | AstraZeneca | Здоровье дома, после больницы: мониторинг, приём лекарств, связь с врачом |
| Equal Care Across Finland | Aalto / регионы здравоохранения | Равный доступ к медицине в городе и в глуши |
| Spread | Valio Aimo (?) | Загадка: «распространение» (информация, эпидемии) или буквально спред/масло 🧈 |
| Make Unicorns Real | Cala (подтверждено) | Продукт для фаундеров/VC на данных Cala о компаниях и инвестициях |
| Earned Trust in AI Code | OpenAI Codex / CRACI / Qualia (?) | Как доказать, что код от AI безопасен и правилен |
| Verda Compute Track | Verda (подтверждено) | Что-то тяжёлое на их GPU-облаке: обучение, инференс, свои модели |
| The Green European Renaissance | City of Espoo (?) | Климат, энергия, переработка в Европе |
| Decode the Noise | Stoa / Tieto (?) | Вытащить сигнал из шума: данные, аудио, новости, сенсоры |

## 3. Что делают тех-партнёры (простыми словами)

- **Oxylabs Web API**: «пылесос для интернета». Скрейпинг любых сайтов через прокси, без блокировок. Пример: собрать цены 50 магазинов каждый час.
- **Context.dev**: даёшь URL → получаешь чистый Markdown, скриншот или JSON по твоей схеме. По домену отдаёт бренд: логотип, цвета, шрифты, соцсети. Есть MCP для агентов.
- **Modal**: запускаешь Python-функцию на GPU в облаке одной строкой, платишь по секундам. Пример: свой Whisper или VLM без настройки серверов.
- **Cloudinary**: всё про картинки и видео: хранение, обрезка, AI-теги, удаление фона, генерация превью по URL.
- **Aiven**: готовые базы в облаке (Postgres, Kafka, Valkey/Redis, OpenSearch, ClickHouse). Пример: Kafka для потока событий + Postgres с pgvector.
- **CRACI**: безопасность цепочки поставок ПО и соответствие EU Cyber Resilience Act. Сканирует зависимости, CI/GitHub Actions.
- **Arduino UNO Q**: «двухмозговая» плата: Linux-компьютер (Qualcomm) + микроконтроллер для моторов и датчиков. На ней можно крутить небольшие AI-модели и сразу дёргать железо.
- **Atech**: конструктор электроники: описываешь устройство в чате → получаешь схему и прошивку ESP32, модули просто защёлкиваются.

## 4. Переиспользуемые «движки» идей

Идея простая: строим **одно ядро**, а под конкретный челлендж меняем «обёртку». Как Lego: один мотор, разные машинки.

### A. «Web Watcher»: агент, который следит за вебом и складывает всё в базу
Собирает страницы → превращает в структурированные данные → хранит историю → шлёт алерты и отвечает на вопросы.
- Подходит к: The Web Is Your Real-Time Database, Internet Butler, Make Unicorns Real, Wikipedia Through Time, Trusted Trade Agents.
- Тех: Oxylabs + Context.dev + Aiven (+ Modal).
- Пример: «Скажи, когда конкурент поменял цены или нанял CTO» для фаундеров (Cala).

### B. «Time Machine»: показать, как правда меняется со временем
Берём версии документа (правки Википедии, сайты компаний, законы) → находим, что и когда поменялось, кто спорил.
- Подходит к: Wikipedia Through Time, Decode the Noise, Spread (как распространялся факт/фейк), Make Unicorns Real.
- Тех: Context.dev, Oxylabs, Aiven (ClickHouse для таймлайнов), Cloudinary (визуальные таймлайны).
- Пример: ползунок по годам, и карта знаний «перерисовывается» как в кино.

### C. «Agent Shield»: проверка и защита AI-агентов и AI-кода
Автоматический red-team: подсовывает агенту ловушки (prompt injection на веб-странице, фальшивый инвойс) и выдаёт «паспорт доверия».
- Подходит к: Break the Agent, Earned Trust in AI Code, Trusted Trade Agents, Internet Butler (безопасный дворецкий).
- Тех: CRACI, Modal (параллельный запуск атак), Aiven (лог атак), Oxylabs/Context.dev (реальные страницы с ловушками).
- Пример: «Мы взломали 7 из 10 популярных агентов за 3 минуты, вот как это закрыть».

### D. «See → Detect → Act»: камера, которая видит и действует
Камера/очки → модель распознаёт → плата или робот делает действие.
- Подходит к: Intel Physical AI, Give the Robot a Brain, Teleoperation, AI Glasses, Beyond the Clinic, Green Renaissance.
- Тех: Arduino UNO Q, Atech, Modal (тяжёлая модель), Cloudinary (кадры), Verda.
- Пример: робот-рука сортирует мусор по типам; или очки говорят пожилому человеку «ты уже принял таблетку утром».

### E. «Money Coach»: финансовый тренер с игрой
Тренирует привычки: челленджи «неделя без доставки», симулятор «что будет, если откладывать 50 € в месяц», объяснение как ребёнку.
- Подходит к: Personal Economic Trainer, Internet Butler, Make Unicorns Real (тренер для фаундера: runway).
- Тех: Aiven, Oxylabs (реальные цены в магазинах), Context.dev.

### F. «Blueprint Talker»: чертёж, с которым можно поговорить
Загружаешь план здания → спрашиваешь «где ближайший выход без ступенек?», «сколько стоит утеплить?».
- Подходит к: Make Blueprints Talk, Green Renaissance (энергоэффективность), Equal Care (доступность клиник), AI Glasses (навигация внутри здания).
- Тех: Cloudinary (обработка изображений), Modal/Verda (vision-модель).

### G. «Skill Proof»: найм по делу, а не по резюме
Кандидат решает короткую реальную задачу, AI оценивает и объясняет почему; заодно проверка, что код написан честно.
- Подходит к: Rethinking Recruitment, Earned Trust in AI Code.
- Тех: Modal (песочница запуска кода), CRACI, Aiven, Context.dev (профиль компании-работодателя).

## 5. Лучшие комбинации (основной + тех)

| Основной челлендж | Ядро | Тех-челленджи, которые естественно ложатся |
|---|---|---|
| The Web Is Your Real-Time Database | A | Oxylabs + Context.dev + Aiven + Modal (4 шт.!) |
| Make Unicorns Real | A/B | Context.dev + Oxylabs + Aiven |
| Break the Agent | C | CRACI + Modal + Oxylabs + Aiven |
| Intel Physical AI | D | Arduino UNO Q + Atech + Cloudinary |
| Give the Robot a Brain | D | Arduino UNO Q + Modal |
| Wikipedia Through Time | B | Context.dev + Aiven + Cloudinary |
| Personal Economic Trainer | E | Aiven + Oxylabs |

Самые «жирные» по числу тех-челленджей: **ядро A** (веб-данные) и **ядро C** (безопасность агентов). Для любителей железа: **ядро D**.

## 6. Советы по форме сабмита
- **Name ≤ 30 символов**, Punchline ≤ 200: придумать сразу, пример: «Agent Shield» / «We break AI agents before hackers do, and show you how to fix them.»
- **Description** (markdown): Проблема → Решение → Как работает → Какие тех-партнёры и зачем (по абзацу на каждого, судьи партнёров ищут именно это) → Что дальше.
- **Video**: 2 минуты, Loom/YouTube, начинать с демо, а не со слайдов.
- **Presentation**: 5–7 слайдов в PDF.
- Каждый тех-челлендж ставить, только если инструмент реально нужен в продукте; «прикрученный для галочки» судьи видят.
- Предварительная заявка сегодня до 23:59, её можно потом поменять.
