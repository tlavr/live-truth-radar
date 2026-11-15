# Deploying to a Hostinger VPS

The VPS is `root@179.67.199.112`, and the public domain is `liveswarmradar.tech`. The original Hostinger hostname `srv2159471.hstgr.cloud` already has an A record pointing to the VPS IP address. Caddy provisions HTTPS through Let's Encrypt using `DOMAIN` from `.env`.

**One-time server setup:**
1. Free ports 80 and 443 by stopping Traefik from the Hostinger template: `cd /docker/traefik && docker compose down` (to restore it, run `up -d`).
2. Set up a read-only deploy key: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/ltr_deploy`. Add `Host github.com` and `IdentityFile ~/.ssh/ltr_deploy` to `~/.ssh/config`, and run `ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts`. Add the public key from your local machine: `gh repo deploy-key add <file.pub> --title ltr-vps`.
3. `git clone git@github.com:tlavr/live-truth-radar.git ~/live-truth-radar`.
4. Copy the untracked `.env` file with `scp .env root@179.67.199.112:live-truth-radar/.env`. On the server, it must contain `DOMAIN=liveswarmradar.tech` and a nonempty `POSTGRES_PASSWORD`.

**For each deployment, run these commands from the repository root on your laptop:**
`make deploy` (SSH, `git pull --ff-only`, and `compose up -d --build`), then `make smoke URL=https://liveswarmradar.tech`.

View logs with `ssh root@179.67.199.112 'cd live-truth-radar && docker compose -f infra/docker-compose.yml --env-file .env logs -f caddy api'`.
