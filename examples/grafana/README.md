# Grafana integration

Brings a Grafana instance into the catalog and its alert notifications into the platform, as JSON files.

```
Grafana API  ──pull every 15 min──▶  folders, dashboards, data sources, alert rules
Grafana alerting ──webhook contact point──▶  /api/v1/ingest/default/grafana-alerts  ──▶  alerts
```

| File | Side | What |
| --- | --- | --- |
| `platform/grafana-blueprints.json` | platform (configuration as code) | Blueprints `grafana-folder`, `grafana-dashboard`, `grafana-datasource`, `grafana-alert-rule`, `grafana-alert` |
| `platform/grafana-integrations.json` | platform | Integrations `grafana` (built-in source: folders and dashboards), `grafana-datasources` and `grafana-alert-rules` (HTTP source), `grafana-alerts` (inbound webhook) |
| `grafana/service-account.json` | Grafana | Viewer service account whose token the pull integrations use |
| `grafana/folder.json`, `grafana/alert-rules.json` | Grafana | Folder "Asterius Platform" and three alert rules on the platform's metrics (API down, runs waiting, an always-firing heartbeat) |
| `grafana/contact-point.json` | Grafana | Webhook contact point calling the platform with a Bearer token |
| `grafana/notification-policy.json` | Grafana | Notification policy sending every alert to that contact point |

## Relations in the catalog

- A dashboard belongs to its folder; a folder to its parent folder.
- An alert rule belongs to its folder and points to the dashboard of its `__dashboardUid__` annotation.
- An alert points to its rule (parsed from `generatorURL`) and its dashboard (from `dashboardURL`). Its identifier is
  Grafana's fingerprint: the resolved notification updates the same entity (`status: resolved`, `endsAt`).

## Secrets

Nothing secret is in the files. The integrations read OpenBao through the platform's Vault provider:

| Reference | Value |
| --- | --- |
| `${vault:secret/apps/grafana#token}` | Grafana service account token (Viewer) |
| `${vault:secret/apps/grafana#webhookToken}` | Token Grafana sends as `Authorization: Bearer …` to the webhook |

Without OpenBao, use `${secret:GRAFANA_TOKEN}` (Admin → Secrets) or `${env:GRAFANA_TOKEN}` instead.

## On the local OrbStack cluster

`deploy/local/install.sh` does everything: creates the service account and its token, the folder, the alert rules,
the contact point and the notification policy (Grafana provisioning API), stores both tokens in OpenBao, allows
Grafana to reach the API pods (NetworkPolicy), and mounts `config/` plus `platform/*.json` as the platform's
configuration. The files use the local addresses:

| Setting | Local value |
| --- | --- |
| Grafana API (in-cluster) | `http://kps-grafana.observability.svc` |
| Grafana links in the catalog (`publicUrl`) | `https://platform-grafana.k8s.orb.local` |
| Platform webhook (contact point) | `http://asterius-platform.asterius-platform.svc/api/v1/ingest/default/grafana-alerts` |

## Elsewhere

1. Replace the three addresses above in `platform/grafana-integrations.json` and `grafana/contact-point.json`.
   `publicUrl` is read by the mappings as written, so it must be a plain URL (no `${…}` reference).
2. In Grafana, create the service account from `grafana/service-account.json` and a token; store it and a random
   webhook token where the references above point.
3. Provision the Grafana side (`X-Disable-Provenance: true` keeps the objects editable in the Grafana UI):

   ```bash
   G=https://grafana.example.com; AUTH="Authorization: Bearer <admin token>"; J='content-type: application/json'
   curl -H "$AUTH" -H "$J" -X POST $G/api/folders --data @grafana/folder.json
   jq -c '.[]' grafana/alert-rules.json | while read -r r; do
     curl -H "$AUTH" -H "$J" -H 'X-Disable-Provenance: true' -X POST $G/api/v1/provisioning/alert-rules --data "$r"; done
   jq --arg t "<webhook token>" '.settings.authorization_credentials = $t' grafana/contact-point.json |
     curl -H "$AUTH" -H "$J" -H 'X-Disable-Provenance: true' -X POST $G/api/v1/provisioning/contact-points --data @-
   # Replaces the whole policy tree: on a shared Grafana, add a child route to the contact point instead.
   curl -H "$AUTH" -H "$J" -H 'X-Disable-Provenance: true' -X PUT $G/api/v1/provisioning/policies --data @grafana/notification-policy.json
   ```

4. Put `platform/*.json` in the platform's configuration directory (`CONFIG_DIR`, Helm `config.files` /
   `config.existingConfigMap`), and check them first:

   ```bash
   npm run config:validate -w apps/server -- path/to/config
   ```

The alert rules query the platform's own metrics with the Prometheus data source uid `prometheus` and link panels of
the chart's "Asterius Platform" dashboard (uid `asterius-platform`); adjust both for another Grafana.
