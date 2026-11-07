# Single-VM deployment (Docker Compose)

The cheapest production setup: one x86 VM with 4 GB RAM (e.g. a Hetzner Cloud cost-optimized server) running

| Service | Role | Memory limit |
|---|---|---|
| `caddy` | TLS (Let's Encrypt) and reverse proxy for both domains | 128 MB |
| `postgres` | PostgreSQL 16, databases `platform` and `keycloak` | 512 MB |
| `keycloak` | Registration, sign-in, per-organization SSO (realm imported from [../keycloak/realm-asterius.json](../keycloak/realm-asterius.json)) | 1 GB (heap 512 MB) |
| `platform` | API + workers (`PLATFORM_ROLE=all`) | 768 MB |

Measured idle: Keycloak ~690 MB, Postgres ~85 MB. Headroom stays for the OS and a page cache. For several replicas or
zero-downtime upgrades, use the Helm chart instead.

The published image is `linux/amd64` only: pick an x86 server, not Arm64.

## First install

1. DNS: `A`/`AAAA` records for `APP_DOMAIN` and `AUTH_DOMAIN` pointing at the VM (Caddy needs them for certificates).
2. VM (Debian/Ubuntu): install Docker, open ports 22/80/443 only, add swap as a safety net:
   ```bash
   curl -fsSL https://get.docker.com | sh
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```
3. Code and configuration:
   ```bash
   git clone https://github.com/AsteriusIT/asterius-platform /opt/asterius
   cd /opt/asterius/deploy/compose
   cp .env.example .env && chmod 600 .env   # fill in domains and secrets
   ```
4. The image is private on GHCR: log in once with a token that has `read:packages`:
   ```bash
   echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
   ```
5. Start: `docker compose up -d` then `docker compose ps` (Keycloak takes ~1 min the first time).
6. Sign in at `https://APP_DOMAIN` with an account whose email is in `ADMIN_EMAILS` (register through Keycloak).

Never build the image on the VM (`npm run build` needs more memory than it has): CI publishes it.

## Operations

- **Upgrade:** set `PLATFORM_IMAGE` to the new tag (pin a commit SHA or release, not `latest`), then
  `docker compose pull platform && docker compose up -d platform`. Migrations run at start (`MIGRATE_ON_START`).
- **Logs:** `docker compose logs -f platform keycloak`.
- **Keycloak admin console:** set `KEYCLOAK_EXPOSE_ADMIN=true`, `docker compose up -d caddy`, use
  `https://AUTH_DOMAIN/admin` (user `admin`, `KEYCLOAK_ADMIN_PASSWORD`), then set it back to `false`.
- **Email (password reset, invitations):** configure SMTP in the Keycloak admin console (*Realm settings → Email*);
  the imported realm has none, and Hetzner blocks outbound port 25, so use a provider on port 587/465.
- **Backups:** [backup.sh](backup.sh) dumps both databases nightly (cron line in the script). Copy them off the VM.
  Keep `.env` safe too: without `SECRETS_KEY` the stored secrets cannot be decrypted.
- **Pausing the server (Hetzner):** a powered-off server is still billed. Power off, snapshot, delete; recreate
  from the snapshot later (same architecture, disk at least as large). Keep the Primary IP or update DNS.
