# SonarQube integration

Brings a SonarQube instance's projects and quality gates into the catalog, and every analysis result into the
platform, as JSON files.

```
SonarQube API  ──pull every 15 min──▶  projects, quality gates
SonarQube global webhook ──HMAC-signed POST──▶  /api/v1/ingest/default/sonarqube-analyses  ──▶  analyses,
                                                                                   project quality gate status
```

| File | What |
| --- | --- |
| `platform/sonarqube-blueprints.json` | Blueprints `sonarqube-project`, `sonarqube-quality-gate`, `sonarqube-analysis` |
| `platform/sonarqube-integrations.json` | Integrations `sonarqube` (built-in `sonarqube` source: projects and quality gates) and `sonarqube-analyses` (inbound webhook) |

## What the catalog shows

- **Projects** come from the pull integration (`/api/components/search`). Their quality gate status, last analysis
  date and revision come from the webhook: the second mapping of `sonarqube-analyses` merges them into the project
  (main branch only). A project is created on its first analysis even before the next pull.
- **Analyses** are one entity per background task (`taskId`), with the quality gate status, the failed conditions
  (`new_coverage LT 80 (actual 42.1)`), the branch and the revision, linked to their project.
- **Quality gates** are identified by their name in lowercase with dashes (`Sonar way` → `sonar-way`).

## Secrets

Nothing secret is in the files. The integrations read OpenBao through the platform's Vault provider:

| Reference | Value |
| --- | --- |
| `${vault:secret/apps/sonarqube#token}` | User token of the `asterius-platform` SonarQube user (Browse on projects) |
| `${vault:secret/apps/sonarqube#webhookSecret}` | Secret of the global webhook; SonarQube signs every delivery with it (`X-Sonar-Webhook-HMAC-SHA256`) |

Without OpenBao, use `${secret:SONAR_TOKEN}` (Admin → Secrets) or `${env:SONAR_TOKEN}` instead.

## On the local OrbStack cluster

`deploy/local/install.sh` does everything. It installs the latest SonarQube Community Build (namespace `sonarqube`,
database on CloudNativePG, secrets from OpenBao). It then sets the admin password, creates the `asterius-platform`
user and its token, and creates the global webhook. It stores the token and the webhook secret in OpenBao, allows
SonarQube to reach the API pods (NetworkPolicy), and mounts `platform/*.json` in the platform's configuration. The
files use the local addresses:

| Setting | Local value |
| --- | --- |
| SonarQube API (in-cluster) | `http://sonarqube-sonarqube.sonarqube.svc:9000` |
| SonarQube links in the catalog (`publicUrl`, `sonar.core.serverBaseURL`) | `https://sonarqube.k8s.orb.local` |
| Platform webhook | `http://asterius-platform.asterius-platform.svc/api/v1/ingest/default/sonarqube-analyses` |

To see an analysis arrive, scan any repository. The admin password is in the Secret `sonarqube/sonarqube-secrets`.
In SonarQube, create a project, then use the token it gives you:

```bash
docker run --rm -v "$PWD:/usr/src" -e SONAR_HOST_URL=https://sonarqube.k8s.orb.local -e SONAR_TOKEN=<token> \
  sonarsource/sonar-scanner-cli -Dsonar.projectKey=<key>
```

## Elsewhere

1. Replace the addresses above in `platform/sonarqube-integrations.json`. `publicUrl` is read by the mappings as
   written, so it must be a plain URL (no `${…}` reference).
2. In SonarQube, create a user for the platform (Browse permission on the projects to list) and a user token. Store
   the token and a random webhook secret where the references above point.
3. Create the webhook (Administration → Configuration → Webhooks, or per project). Use the platform's
   `/api/v1/ingest/<organization>/sonarqube-analyses` URL and the same secret:

   ```bash
   curl -u <admin token>: -X POST https://sonar.example.com/api/webhooks/create \
     --data-urlencode name=asterius-platform \
     --data-urlencode url=https://platform.example.com/api/v1/ingest/default/sonarqube-analyses \
     --data-urlencode secret=<webhook secret>
   ```

4. Put `platform/*.json` in the platform's configuration directory (`CONFIG_DIR`, Helm `config.files` /
   `config.existingConfigMap`), and check them first:

   ```bash
   npm run config:validate -w apps/server -- path/to/config
   ```
