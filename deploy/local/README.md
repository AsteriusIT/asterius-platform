# Local cluster (OrbStack)

The Helm chart with every Kubernetes component turned on, plus the ecosystem a real installation has around it.
Local trial only: secrets bootstrap material (OpenBao unseal key and root token) is kept in Kubernetes Secrets.

```bash
deploy/local/install.sh           # install or update (idempotent); builds asterius-platform:local if missing
deploy/local/install.sh --build   # rebuild the image from the working tree and restart the pods
```

| URL | What |
| --- | --- |
| https://platform.k8s.orb.local | Asterius Platform (API + UI) |
| https://platform-id.k8s.orb.local | Keycloak (realm `asterius`) |
| https://platform-grafana.k8s.orb.local | Grafana, dashboard "Asterius Platform" |
| https://openbao.k8s.orb.local | OpenBao UI |

TLS certificates come from the cluster's `local-ca` ClusterIssuer (cert-manager).

## What is installed

| Namespace | Release / objects | Role |
| --- | --- | --- |
| kube-system | metrics-server | CPU metrics for the API HorizontalPodAutoscaler |
| observability | kube-prometheus-stack (`kps`) | Prometheus Operator, Prometheus, Alertmanager, Grafana; picks up every ServiceMonitor, PodMonitor, PrometheusRule and dashboard ConfigMap of the cluster |
| openbao | openbao | OpenBao (Vault API), KV v2 at `secret/`, Kubernetes auth, static auto-unseal |
| external-secrets | external-secrets | External Secrets Operator: OpenBao → Kubernetes Secrets |
| asterius-platform | asterius-platform | API (HPA, PDB) and worker Deployments, CNPG PostgreSQL (2 instances), Keycloak and its CNPG database, migration Job, Ingress, NetworkPolicy, RBAC, ServiceMonitor, PrometheusRule, Grafana dashboard |
| asterius-jobs | (empty) | Target namespace of the Kubernetes Job invoker |

The platform's configuration is the ConfigMap `asterius-platform-config-files`: the repository's `config/` plus the
Grafana integration of `examples/grafana/platform/` (blueprints and integrations for Grafana folders, dashboards,
data sources, alert rules and alert notifications). The script also provisions the Grafana side; see
[examples/grafana/README.md](../../examples/grafana/README.md).

## Secrets and the `.env` file

```
.env + generated values ──install.sh──▶ OpenBao KV ──External Secrets──▶ Kubernetes Secrets ──▶ pods
```

| OpenBao path | Kubernetes Secret | Content |
| --- | --- | --- |
| `secret/asterius-platform/env` | asterius-platform/asterius-platform-secrets (chart `secrets.existingSecret`) | the `.env` variables, plus generated `SECRETS_KEY`, `METRICS_TOKEN`, `BOOTSTRAP_TOKEN` |
| `secret/asterius-platform/keycloak` | asterius-platform/asterius-platform-keycloak, keycloak-db-credentials | Keycloak database owner, admin and platform client secret |
| `secret/observability/grafana` | observability/grafana-admin | Grafana admin |
| `secret/apps/demo` | (none) | sample for `${vault:secret/apps/demo#token}` in actions |
| `secret/apps/grafana` | (none) | Grafana service account token and webhook token, read by the Grafana integrations as `${vault:…}` |

- **Not every `.env` key is copied.** Keys the chart already sets in its ConfigMap (`PUBLIC_URL`, `AUTH_PROVIDERS`,
  `KEYCLOAK_URL`…) and local-only ones (`KUBECONFIG_PATH`, `DATABASE_URL`, `KEYCLOAK_CLIENT_SECRET`) are skipped,
  because the Secret would override the in-cluster values. `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` and `ADMIN_EMAILS`
  become chart values.
- **Generated values are kept.** A rerun never replaces `SECRETS_KEY` (stored secrets would become unreadable) or the
  generated passwords. To change a value, edit it in OpenBao: External Secrets refreshes every minute; restart the
  pods to load it.
- **The platform reads OpenBao itself.** `${vault:secret/apps/...#key}` references are resolved with Kubernetes
  auth (role `asterius-platform`, policy limited to `secret/data/apps/*`).

Credentials:

```bash
kubectl -n asterius-platform get secret asterius-platform-secrets -o jsonpath='{.data.BOOTSTRAP_TOKEN}' | base64 -d
kubectl -n observability get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
kubectl -n openbao get secret openbao-init -o jsonpath='{.data.root-token}' | base64 -d
kubectl -n asterius-platform get secret asterius-platform-keycloak -o jsonpath='{.data.KC_BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d
```

The first admin: sign up with a local account on the platform and paste the `BOOTSTRAP_TOKEN`. Keycloak accounts
(self-registration enabled) can then be promoted. The Keycloak admin console is at
https://platform-id.k8s.orb.local/admin/ (user `admin`, password `KC_BOOTSTRAP_ADMIN_PASSWORD` above), exposed by
`keycloak.ingress.exposeAdmin: true` in the local values.

## Uninstall

```bash
helm -n asterius-platform uninstall asterius-platform
kubectl delete namespace asterius-platform asterius-jobs   # databases included
helm -n external-secrets uninstall external-secrets
helm -n openbao uninstall openbao && kubectl delete namespace openbao   # deletes all secrets and the unseal key
helm -n observability uninstall kps && kubectl delete namespace observability
helm -n kube-system uninstall metrics-server
```
