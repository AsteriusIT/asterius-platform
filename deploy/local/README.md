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
| https://sonarqube.k8s.orb.local | SonarQube Community Build (user `admin`) |
| https://nexus.k8s.orb.local | Nexus Repository Community Edition (user `admin`) |

TLS certificates come from the cluster's `local-ca` ClusterIssuer (cert-manager).

## What is installed

| Namespace | Release / objects | Role |
| --- | --- | --- |
| kube-system | metrics-server | CPU metrics (`kubectl top`) |
| observability | kube-prometheus-stack (`kps`) | Prometheus Operator, Prometheus, Alertmanager, Grafana; picks up every ServiceMonitor, PodMonitor, PrometheusRule and dashboard ConfigMap of the cluster |
| openbao | openbao | OpenBao (Vault API), KV v2 at `secret/`, Kubernetes auth, static auto-unseal |
| external-secrets | external-secrets | External Secrets Operator: OpenBao → Kubernetes Secrets |
| sonarqube | sonarqube | SonarQube Community Build (latest), its CNPG database, PodMonitor; global webhook to the platform |
| nexus | (manifests/nexus.yaml) | Nexus Repository Community Edition 3.98 (embedded database), read-only user for the platform |
| asterius-platform | asterius-platform | API and worker Deployments (one replica each), CNPG PostgreSQL (1 instance), Keycloak and its CNPG database, migration Job, Ingress, NetworkPolicy, RBAC, ServiceMonitor, PrometheusRule, Grafana dashboard |
| asterius-jobs | (empty) | Target namespace of the Kubernetes Job invoker |

The platform's configuration is the ConfigMap `asterius-platform-config-files`: the repository's `config/` plus the
Grafana integration of `examples/grafana/platform/` (blueprints and integrations for Grafana folders, dashboards,
data sources, alert rules and alert notifications) and the SonarQube integration of `examples/sonarqube/platform/`
(projects, quality gates, analyses) and the Nexus integration of `examples/nexus/platform/` (repositories,
components). The script also provisions the Grafana, SonarQube and Nexus sides; see
[examples/grafana/README.md](../../examples/grafana/README.md),
[examples/sonarqube/README.md](../../examples/sonarqube/README.md) and
[examples/nexus/README.md](../../examples/nexus/README.md). It accepts the Nexus Community Edition EULA on your behalf.

## Secrets and the `.env` file

```
.env + generated values ──install.sh──▶ OpenBao KV ──External Secrets──▶ Kubernetes Secrets ──▶ pods
```

| OpenBao path | Kubernetes Secret | Content |
| --- | --- | --- |
| `secret/asterius-platform/env` | asterius-platform/asterius-platform-secrets (chart `secrets.existingSecret`) | the `.env` variables, plus generated `SECRETS_KEY`, `METRICS_TOKEN`, `BOOTSTRAP_TOKEN` |
| `secret/asterius-platform/keycloak` | asterius-platform/asterius-platform-keycloak, keycloak-db-credentials | Keycloak database owner, admin and platform client secret |
| `secret/observability/grafana` | observability/grafana-admin | Grafana admin |
| `secret/sonarqube/server` | sonarqube/sonarqube-secrets, sonarqube-db-credentials | SonarQube database owner, monitoring passcode, admin password |
| `secret/nexus/server` | nexus/nexus-secrets | Nexus initial admin password |
| `secret/apps/demo` | (none) | sample for `${vault:secret/apps/demo#token}` in actions |
| `secret/apps/grafana` | (none) | Grafana service account token and webhook token, read by the Grafana integrations as `${vault:…}` |
| `secret/apps/sonarqube` | (none) | SonarQube token of the `asterius-platform` user and webhook secret, read by the SonarQube integrations |
| `secret/apps/nexus` | (none) | Password of the `asterius-platform` Nexus user, read by the Nexus integrations |

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
kubectl -n sonarqube get secret sonarqube-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d
kubectl -n nexus get secret nexus-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d
```

The first admin: sign up with a local account on the platform and paste the `BOOTSTRAP_TOKEN`. Keycloak accounts
(self-registration enabled) can then be promoted. The Keycloak admin console is at
https://platform-id.k8s.orb.local/admin/ (user `admin`, password `KC_BOOTSTRAP_ADMIN_PASSWORD` above), exposed by
`keycloak.ingress.exposeAdmin: true` in the local values.

## Uninstall

```bash
helm -n asterius-platform uninstall asterius-platform
kubectl delete namespace asterius-platform asterius-jobs   # databases included
helm -n sonarqube uninstall sonarqube && kubectl delete namespace sonarqube   # database included
kubectl delete -f deploy/local/manifests/nexus.yaml && kubectl delete namespace nexus   # data volume included
helm -n external-secrets uninstall external-secrets
helm -n openbao uninstall openbao && kubectl delete namespace openbao   # deletes all secrets and the unseal key
helm -n observability uninstall kps && kubectl delete namespace observability
helm -n kube-system uninstall metrics-server
```
