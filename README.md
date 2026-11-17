# ClipFarm

Автоматически нарезает Twitch-стримы по всплескам чата. Всё работает в облаке: GitHub Actions и Cloudflare.

**Как это работает**

1. **Панель на Cloudflare.** Вставляешь ссылку на стрим и жмёшь ▶.
2. **GitHub Actions** (`clip.yml`):
   - пишет стрим через Streamlink и анонимно читает чат;
   - каждые 10 секунд ищет всплески чата;
   - режет клип 1080×1920: вебка сверху, игра по центру, субтитры Whisper, размытый низ;
   - кладёт клип в релиз `clips` (и пингует в Telegram, если заданы секреты).
3. **Решение в панели.**
   - ✅ переименовывает клип в `ok_*.mp4`. Отсюда его потом заберёт автопостинг.
   - ❌ удаляет клип.

Одна сессия длится до 5,4 часа. Если стрим ещё идёт, workflow сам запускает следующую. Если стрим оффлайн 15 минут, сессия завершается.

## Настройка

**GitHub репо → Settings → Secrets and variables → Actions**

- Secrets, по желанию: `TG_BOT_TOKEN`, `TG_CHAT_ID`. Нужны для уведомления «🎬 Новый клип».
- Variables, по желанию: `PANEL_URL` — ссылка на панель, она добавится в уведомление.

**Воркер Cloudflare `clipfarm`.** Код лежит в `worker/clipfarm-panel.js`. Секреты воркера:

- `GH_REPO`: `zxcmd-qq/clipfarm`;
- `GH_PAT`: fine-grained token на это репо с правами **Actions: Read and write** и **Contents: Read and write**;
- `PANEL_PASS`: пароль от панели.

## Локально (Mac)

```
python3 clipfarm.py --channel shadowkekw
```
