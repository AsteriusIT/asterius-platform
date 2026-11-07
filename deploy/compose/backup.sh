#!/bin/sh
# Nightly logical backup of both databases (platform + keycloak), kept 14 days. Cron (root):
#   15 3 * * * /opt/asterius/deploy/compose/backup.sh >> /var/log/asterius-backup.log 2>&1
# Copy BACKUP_DIR off the VM (Hetzner Storage Box, S3 via rclone...): a snapshot alone dies with the server.
# Restore: gunzip -c platform-<date>.sql.gz | docker compose exec -T postgres psql -U platform -d platform
set -eu
cd "$(dirname "$0")"
BACKUP_DIR=${BACKUP_DIR:-/var/backups/asterius}
mkdir -p "$BACKUP_DIR"
stamp=$(date +%Y%m%d-%H%M%S)
for db in platform keycloak; do
  docker compose exec -T postgres pg_dump -U platform --clean --if-exists "$db" | gzip > "$BACKUP_DIR/$db-$stamp.sql.gz"
done
find "$BACKUP_DIR" -name '*.sql.gz' -mtime +14 -delete
echo "$(date -Is) backup ok: $BACKUP_DIR/*-$stamp.sql.gz"
