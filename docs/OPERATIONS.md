# Operations runbook

What to back up, how to restore, and how to rotate keys. Observability (metrics, alerts, tracing) is described in
[ARCHITECTURE.md](ARCHITECTURE.md).

## What holds state

| State                                                              | Where                                   | Protected by                                                                |
| ------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------- |
| Catalog, runs, audit, users, API tokens, encrypted secrets, config | PostgreSQL                              | Database backups (CloudNativePG `database.cnpg.backup`, or your DBA's own) |
| `SECRETS_KEY` (decrypts stored secrets, derives run-callback keys) | Kubernetes Secret / your secret manager | A copy **outside** the cluster and outside the database backup              |
| Configuration as code                                              | Git (`CONFIG_DIR`)                      | Git                                                                         |
| Resource definitions and entities (portable copy)                  | Archive file                            | `cli export` / `GET /api/v1/archive`, stored with your other backups        |

Losing the database loses everything not in Git or in an archive. Losing `SECRETS_KEY` makes every stored secret
unreadable (you must re-enter them) but nothing else.

## Backups

### Database (primary, point-in-time)

With the bundled CloudNativePG cluster:

```yaml
database:
  cnpg:
    enabled: true
    backup:
      enabled: true
      destinationPath: s3://my-bucket/asterius # or https://<account>.blob.core.windows.net/<container>, gs://…
      s3Credentials: { secretName: asterius-backup-s3 } # Secret with ACCESS_KEY_ID / ACCESS_SECRET_KEY
      retentionPolicy: 30d
      schedule: "0 0 2 * * *" # daily base backup; WAL is archived continuously
```

The chart creates the Cluster `backup` section and a `ScheduledBackup`. The `AsteriusDatabaseBackupMissing` alert
(`metrics.prometheusRule.enabled`) fires when no backup succeeded for two days. Check with
`kubectl get backup,scheduledbackup -n <ns>`.

With an external PostgreSQL, use the provider's snapshots plus WAL archiving (RDS/Azure/Cloud SQL point-in-time restore).

### Archive (portable, logical)

An archive holds resource definitions (teams, blueprints, actions, integrations, webhooks), all entities with
relations, and the **names** of secrets. It never contains secret values, run history, users or tokens. Use it to
move a catalog between environments, to keep a readable copy of the catalog, or as a second line of defence.

```bash
# in a pod (same image, same environment as the server)
kubectl exec deploy/<release>-asterius-platform-worker -- node dist/cli.js export /tmp/archive.json
kubectl cp <ns>/<pod>:/tmp/archive.json ./archive-$(date +%F).json

# or through the API (admin token)
curl -H "Authorization: Bearer $TOKEN" https://platform.example.com/api/v1/archive -o archive.json
```

Import options: `--mode skip` (default, keep what exists) or `--mode overwrite`; `--dry-run` reports what would
happen. The API equivalent is `POST /api/v1/archive/import?mode=skip|overwrite&dryRun=true` with the archive as body.
Resources managed by configuration files (`CONFIG_DIR`) cannot be overwritten and are reported as failures; keep
those in Git. The report lists `missingSecrets`: secrets the imported resources reference that do not exist yet.

```bash
node dist/cli.js import archive.json --dry-run
node dist/cli.js import archive.json --mode overwrite
```

## Disaster recovery

### Scenario A: database lost or corrupted (CloudNativePG)

1. Scale the platform to zero: `kubectl scale deploy -l app.kubernetes.io/instance=<release> --replicas=0`.
2. Choose the recovery point: latest, or a time just before the incident (`database.cnpg.recovery.targetTime`).
3. Redeploy with a **new** cluster name bootstrapped from the object store:

```yaml
database:
  cnpg:
    enabled: true
    backup: { enabled: true, destinationPath: s3://my-bucket/asterius-restored, s3Credentials: { secretName: asterius-backup-s3 } }
    recovery:
      enabled: true
      sourceClusterName: <old cluster name> # e.g. <release>-asterius-platform-db
      destinationPath: s3://my-bucket/asterius # where the OLD cluster archived
      targetTime: "2026-11-06 10:15:00+00" # optional
```

   Use a different `backup.destinationPath` for the restored cluster so new WAL does not mix with the old archive.

4. Wait for the Cluster to become healthy (`kubectl get cluster`), then scale the platform back up. Migrations run at start.
5. Verify (see "Restore drill" below), then remove `recovery.enabled` on the next release.

### Scenario B: only the catalog is damaged (bad import, mass deletion)

Prefer a point-in-time restore into a **separate** cluster (Scenario A with another release name), export an archive
from it, and import into production with `--mode overwrite`. This avoids rewinding unrelated data (runs, audit).

### Scenario C: no database backup, only an archive and Git

1. Deploy a fresh database and the platform with the **same** `SECRETS_KEY` if you still have it, a new one otherwise.
2. Config as code is re-applied from Git at start.
3. `node dist/cli.js import archive.json --mode overwrite`.
4. Re-create secrets (names are in the report's `missingSecrets` and in `archive.secrets`): Admin → Secrets or
   `PUT /api/v1/secrets/<name>`. Run history, audit entries, users and API tokens are lost; users sign in again via Entra.

### Scenario D: SECRETS_KEY lost

Stored secrets cannot be decrypted. Deploy with a new `SECRETS_KEY` (the chart generates one when none is given), then
re-enter every secret listed in Admin → Secrets (`secrets` in the archive gives the names). Integrations and
actions referencing `${secret:NAME}` keep working as soon as the value is set. Prevent this: keep a copy of the key in
your secret manager (the chart marks its Secret `helm.sh/resource-policy: keep`, but that does not survive namespace deletion).

## Key rotation

### SECRETS_KEY

Rotation re-encrypts all stored secrets. It is offline: workers and API must not run while the key changes, and
runs in flight lose their callback tokens (derived from the key) and should be re-triggered.

1. Generate a key: `openssl rand -hex 32`. Store it in your secret manager.
2. Take a database backup (`kubectl create -f` a `Backup` resource, or wait for the scheduled one).
3. Scale the platform to zero.
4. Run the rotation with the OLD key as `SECRETS_KEY` and the new one as `NEW_SECRETS_KEY`, e.g. in a one-off Job from the same image
   and env as the server: `NEW_SECRETS_KEY=<new> node dist/cli.js rotate-secrets-key`. It is transactional: either all secrets are
   re-encrypted or none is.
5. Update the Secret (`SECRETS_KEY`) and scale back up. Check a secret-dependent integration sync.

### API tokens, Entra client secret, database credentials

- Personal and service API tokens: revoke and re-issue in the UI (tokens expire after 90 days by default).
- `ENTRA_CLIENT_SECRET`, `METRICS_TOKEN`, database password: update the Secret, then `kubectl rollout restart` both Deployments.
  CloudNativePG rotates its generated `<cluster>-app` credentials with `kubectl cnpg` or by deleting the Secret (the operator recreates it).

## Restore drill (do this quarterly)

1. Restore the latest backup into a scratch namespace (Scenario A with a different release name and `ingress.enabled=false`).
2. `helm test <release>` passes and `/readyz` returns 200.
3. Compare counts: `curl .../api/v1/blueprints` entity counts vs production (`asterius_catalog_entities` metric).
4. Export an archive from the restored instance and `import --dry-run` it into another scratch instance: `failed` must be all zero.
5. Record the restore duration; it is your measured RTO. The recovery point you chose is your RPO.
6. Delete the scratch namespace.

## Run artifacts and SLAs

Run artifacts (files attached to run steps) are stored in the database (`run_artifacts`), so they are in the database
backups (not in archives) and are deleted with their run by `RETENTION_DAYS`. Size them with:

| Variable                 | Default                                         | Meaning                                                    |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------- |
| `ARTIFACT_MAX_BYTES`     | `10485760` (10 MB)                              | Largest artifact; larger uploads answer 413.               |
| `RUN_ARTIFACTS_MAX`      | `20`                                            | Artifacts per run; more answer 409.                        |
| `ARTIFACT_CONTENT_TYPES` | text, JSON, YAML, XML, PDF, archives, raster images | Accepted content types (comma-separated, `type/*` allowed). |

SLA breaches (`slaMinutes` on actions and steps) are detected by housekeeping (every 30 s) and counted in
`asterius_sla_breaches_total{kind,action}`: alert on `increase(asterius_sla_breaches_total[1h]) > 0` for the workflows
that matter.

## Checklists

- Before an upgrade: database backup completed in the last 24 h, archive exported, `helm lint` and `helm template` clean.
- After an incident: confirm `AsteriusDatabaseBackupMissing` and `AsteriusTargetDown` are quiet, and that the oldest queued
  run and webhook backlog gauges are back to zero (`asterius_queue_oldest_run_age_seconds`, `asterius_queue_oldest_delivery_age_seconds`).
