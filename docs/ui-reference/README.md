# UI-референс (прототип фронтенда)

Скриншоты прототипа из `web/` на демо-данных (`python web/build_mock.py`). Это референс для задачи T12: прототип **подключаем к живому API, а не переписываем**.

| Файл | Что на экране |
|---|---|
| `home-desktop-dark.png` | Главная: поиск темы, живой статус скана, ответ «1 coordinated group», карточка группы с постами как доказательством |
| `home-phone-light.png` | То же на телефоне, светлая тема |
| `howweknow-desktop-dark.png` | Раскрытый блок «How we know»: тепловая карта корреляции, SPRT, SNR |
| `calm-topic-desktop-dark.png` | Тема без находок: «No coordinated groups so far» |
| `metrics-desktop-dark.png` | «How accurate is it?»: три числа, «Where we get it wrong» (цифры — пример, eval ещё нет) |

Как посмотреть вживую локально: `python -m http.server 8000` из корня репо → http://localhost:8000/web/index.html (данные из `web/mock-data.js`).
