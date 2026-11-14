# Деплой на Hostinger VPS

VPS: `root@179.67.199.112`, домен `srv2159471.hstgr.cloud` (имя от Hostinger, A-запись уже на IP). HTTPS выдаёт caddy (Let's Encrypt) по `DOMAIN` из `.env`.

**Разово на сервере:**
1. Освободить 80/443 от Traefik из шаблона Hostinger: `cd /docker/traefik && docker compose down` (вернуть: `up -d`).
2. Read-only deploy key: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/ltr_deploy`, в `~/.ssh/config` — `Host github.com` + `IdentityFile ~/.ssh/ltr_deploy`, `ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts`; публичный ключ добавить локально: `gh repo deploy-key add <файл.pub> --title ltr-vps`.
3. `git clone git@github.com:tlavr/live-truth-radar.git ~/live-truth-radar`.
4. Положить `.env` (не в git): `scp .env root@179.67.199.112:live-truth-radar/.env`; на сервере в нём `DOMAIN=srv2159471.hstgr.cloud` и непустой `POSTGRES_PASSWORD`.

**Каждый деплой (с ноутбука, из корня репо):**
`make deploy` (= ssh + `git pull --ff-only` + `compose up -d --build`), затем `make smoke URL=https://srv2159471.hstgr.cloud`.

Логи: `ssh root@179.67.199.112 'cd live-truth-radar && docker compose -f infra/docker-compose.yml --env-file .env logs -f caddy api'`.
