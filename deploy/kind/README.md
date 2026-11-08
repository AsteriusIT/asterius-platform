# V2 management cluster on kind

Local stand-in for the V2 management cluster ([docs/V2.md](../../docs/V2.md)). Two profiles:

- **lean** (default) — portal + Git + Azure DevOps pipelines + OpenTofu + OPA + OpenTelemetry. Contract:
  [docs/V2-KIND.md](../../docs/V2-KIND.md).
- **crossplane** (optional) — lean plus Crossplane v2, Gatekeeper and the catalog watcher. Contract:
  [docs/V2-CROSSPLANE.md](../../docs/V2-CROSSPLANE.md).

Argo Workflows is not part of V2 any more (one-shot operations are portal workflows calling ADO pipelines or
Kubernetes Jobs); `install.sh` removes it from clusters built by an earlier version.

Local trial only: the OpenBao unseal key and root token are kept in Kubernetes Secrets.

```bash
deploy/kind/install.sh                        # create / update (idempotent), keeps the cluster's profile (new cluster: lean)
deploy/kind/install.sh --profile crossplane   # choose / switch the profile (remembered in the cluster)
deploy/kind/install.sh --build                # rebuild the portal and render (+ agent) images from the working tree, restart them
deploy/kind/install.sh --skip-verify
deploy/kind/verify.sh                         # end-to-end checks only (exit code = number of failed checks)

ADO_PAT_FILE=~/ado-pat deploy/kind/install.sh # seed OpenBao with an existing Azure DevOps PAT (or ADO_PAT=<pat>)
```

The profile is stored in ConfigMap `kube-system/asterius-install` (`profile`, `updated`); a re-run without
`--profile` keeps it.

Requirements: docker, kind, kubectl, helm (v3 or v4), jq, curl, openssl. The Azure CLI (`az login`) is needed only
when no usable PAT is available (see Secrets); no Azure resource is created. The script only talks to the context
`kind-asterius-v2`; other kind clusters (`blackbox`) are never touched.

Rebuild from scratch:

```bash
kind delete cluster --name asterius-v2                              # only this cluster
ADO_PAT_FILE=~/ado-pat deploy/kind/install.sh --build               # lean; add --profile crossplane for the other one
```

## Switching an existing service between profiles

Both paths can manage the same Azure DevOps resources (same deterministic names, both adopt what exists). Before
switching, **pause the service on the side it leaves** (annotation `portal.asterius.io/paused: "<RFC3339 expiry>"`
on its spec, committed through the portal) so the OpenTofu apply pipeline and Crossplane never reconcile the same
project / repo / pipeline at the same time; un-pause it on the new side once it has adopted the resources.
`crossplane → lean` leaves Crossplane, Gatekeeper and the watcher installed (no longer updated): delete the cluster
for a clean lean install.

## URLs

`*.localtest.me` resolves to 127.0.0.1; ingress-nginx listens on host ports 18080 (http) and 18443 (https, no
certificate configured), bound to 127.0.0.1.

| URL | What | Credentials |
|---|---|---|
| http://portal.localtest.me:18080 | Portal (API + UI) | sign up with a local account and the `BOOTSTRAP_TOKEN` → first admin |
| http://argocd.localtest.me:18080 | Argo CD | `admin` / initial admin secret |
| http://grafana.localtest.me:18080 | Grafana (Prometheus, Loki, Tempo data sources) | `admin` / grafana-admin |
| http://openbao.localtest.me:18080 | OpenBao UI | root token |

```bash
kubectl --context kind-asterius-v2 -n asterius-platform get secret asterius-platform-secrets -o jsonpath='{.data.BOOTSTRAP_TOKEN}' | base64 -d
kubectl --context kind-asterius-v2 -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
kubectl --context kind-asterius-v2 -n observability get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
kubectl --context kind-asterius-v2 -n openbao get secret openbao-init -o jsonpath='{.data.root-token}' | base64 -d
kubectl --context kind-asterius-v2 -n asterius-platform get secret portal-ado -o jsonpath='{.data.ADO_PAT}' | base64 -d
```

## What is installed

Versions are pinned at the top of `install.sh`.

| Namespace | Component | Profile | Notes |
|---|---|---|---|
| ingress-nginx | ingress-nginx 1.15.1 | both | kind provider manifest (hostPorts 80/443 on the node) |
| argocd | Argo CD v3.6.1 (chart 10.15.0) | both | `timeout.reconciliation: 30s`, insecure server behind the ingress, local account `portal` (API token), app of apps `asterius-root` (portal-resources, path `argocd/`) |
| openbao | OpenBao v2.7.2 (chart 0.30.7) | both | standalone, pebbledb on a PVC, static auto-unseal; KV v2 at `secret/`, Kubernetes auth |
| external-secrets | External Secrets Operator v2.14.0 | both | ClusterSecretStore `openbao` |
| observability | Loki 3.7.9 (grafana-community chart 21.0.0), Tempo 3.1.1 (grafana-community chart 3.2.1), kube-prometheus-stack 93.1.0 (Prometheus, Grafana) | both | see Telemetry |
| otel | OTel Collector contrib 0.163.2 (chart 0.178.2) | both | Deployment + Service `otel-collector`; DaemonSet `otel-agent` (logs of `asterius-jobs` pods; + `crossplane-system` in the crossplane profile) |
| asterius-platform | Portal (chart `deploy/helm/asterius-platform`, image `asterius-platform:v2-dev` from the root `Dockerfile`), PostgreSQL 17 StatefulSet `postgres`; OPA and the plan service from `manifests/` | both | |
| asterius-jobs | ServiceAccount `rotate-secret` | both | target namespace of the portal's Kubernetes Job invoker |
| crossplane-system | Crossplane v2.4.3 core | crossplane | providers / functions / ProviderConfigs come from portal-resources |
| gatekeeper-system | Gatekeeper v3.23.1 | crossplane | `enableDeleteOperations: true`, audit every 60 s; constraints come from portal-resources |
| portal-agent | catalog watcher (`manifests/crossplane/`, image `asterius-agent:dev` from `apps/agent`), Secret `watcher` | crossplane | |

The crossplane profile also registers the Crossplane health checks in Argo CD and mounts
`examples/v2/crossplane/config/*` in the portal.

Files:

| Path | Content |
|---|---|
| `kind-config.yaml` | cluster `asterius-v2`: one node, port mappings 18080→80 / 18443→443, `maxPods: 250` |
| `values/*.yaml` | Helm values per component; `crossplane.yaml`, `gatekeeper.yaml`, `otel-agent-crossplane.yaml`, `crossplane-health.lua` (Argo CD health check) are used by the crossplane profile only |
| `bootstrap/*.yaml` | namespaces, alias Services, ExternalSecrets, `asterius-jobs` ServiceAccount, PostgreSQL, `asterius-root` |
| `bootstrap/crossplane/*.yaml` | crossplane profile: its namespaces and the watcher ExternalSecrets |
| `manifests/` | extension point (below) |
| `verify.sh` | the checks below |

## Secrets

```
generated / given PAT ──install.sh──▶ OpenBao KV ──External Secrets (ClusterSecretStore openbao)──▶ Secrets ──▶ pods
```

| OpenBao (`secret/`) | Kubernetes Secret | Keys | Profile |
|---|---|---|---|
| `platform/ado` (`pat`, `org_url`, `valid_to`, …) | `asterius-platform/portal-ado` | `ADO_PAT` | both |
| | `argocd/repo-portal-resources` (label `argocd.argoproj.io/secret-type: repository`) | `url`, `username`, `password` | both |
| `platform/argocd` (`token`) | (env of the portal only) | | both |
| `asterius-platform/env` | `asterius-platform/asterius-platform-secrets` (chart `secrets.existingSecret`) | `DATABASE_URL`, `SECRETS_KEY`, `METRICS_TOKEN`, `BOOTSTRAP_TOKEN` + `ADO_PAT`, `ARGOCD_TOKEN` (+ `CROSSPLANE_WATCHER_SECRET`) | both |
| `asterius-platform/postgres` | `asterius-platform/portal-postgres` | `username`, `password` | both |
| `observability/grafana` | `observability/grafana-admin` | `admin-user`, `admin-password` | both |
| `apps/*` | (none) | read by the portal itself as `${vault:secret/apps/<path>#key}` (role `asterius-platform`) | both |
| `teams/<team>/<service>` | (none) | written by the `rotate-secret` Job (role `asterius-jobs`) | both |
| `platform/watcher` (`secret`) | `asterius-platform/portal-v2` (`CROSSPLANE_WATCHER_SECRET`), `portal-agent/watcher` (`secret`) | | crossplane |

OpenBao Kubernetes auth roles and policies:

| Role | Bound to | Policy | Rights |
|---|---|---|---|
| `eso` | `external-secrets/openbao-reader` | `eso` | read the whole KV mount; create/update/read on `secret/data/teams/*`, + list on `secret/metadata/teams/*` (PushSecret) |
| `asterius-platform` | `asterius-platform/asterius-platform-{api,worker}` | `asterius-platform` | read `secret/data/apps/*` |
| `asterius-jobs` | `asterius-jobs/rotate-secret` | `asterius-jobs` | create/update/read on `secret/data/teams/*`; create/update/read/list on `secret/metadata/teams/*` |

- **ADO PAT** (`secret/platform/ado`), in this order:
  1. `ADO_PAT=<pat>` or `ADO_PAT_FILE=<file>` (optional `ADO_PAT_VALID_TO=<date>`): an existing PAT; it must
     authenticate against `https://dev.azure.com/AsteriusIT`, and replaces the stored one. Never printed.
  2. otherwise the stored PAT, while it authenticates and is valid for more than 7 days (or its expiry is unknown);
  3. otherwise a new PAT through the PAT lifecycle API (`POST https://vssps.dev.azure.com/AsteriusIT/_apis/tokens/pats`)
     with the Azure CLI's Azure DevOps token: display name `asterius-v2-kind`, 90 days, scopes `vso.code_full
     vso.project_manage vso.build_execute vso.serviceendpoint_manage vso.environment_manage vso.graph_manage
     vso.variablegroups_manage` (falls back to `app_token`). Revoke old ones in Azure DevOps (User settings →
     Personal access tokens).
- **Generated values are kept**: `SECRETS_KEY`, the watcher secret, passwords. Change a value in OpenBao and re-run
  (the script forces a refresh of the ExternalSecrets and restarts the portal when its Secret changed).
- The ClusterSecretStore reads the whole KV mount (policy `eso`): fine for a local trial, restrict per namespace in a
  real installation.

## Portal

Chart `deploy/helm/asterius-platform` with `values/asterius-platform.yaml` (no template change):

- Image `asterius-platform:v2-dev`: the repository's root `Dockerfile` built from the working tree, then `kind load docker-image` (`pullPolicy: Never`).
- Service port 8080 → `http://asterius-platform.asterius-platform.svc:8080`; ingress `portal.localtest.me`.
- `CONFIG_DIR` = ConfigMap `asterius-platform-config-files`, rebuilt at every run from `config/*.yaml`, plus
  `examples/v2/config/*.{yaml,yml,json}` (prefixed `v2-`), plus in the crossplane profile
  `examples/v2/crossplane/config/*` (prefixed `v2cp-`). The portal re-reads it every minute.
- Kubernetes Job invoker: `rbac.jobNamespaces: [asterius-jobs]` → Role/RoleBinding `asterius-platform-jobs` in
  `asterius-jobs` for the worker's ServiceAccount (create/get/delete Jobs, create/patch/delete the per-run Secret,
  get/list pods and logs), `KUBE_JOB_NAMESPACES=asterius-jobs`. Jobs may run as any ServiceAccount of the namespace;
  `rotate-secret` is the one OpenBao trusts.
- Sign-in: local accounts (`AUTH_PROVIDERS=local`, registration open; the `BOOTSTRAP_TOKEN` makes the first account admin).
- No NetworkPolicy (OPA, the plan service, Job pods and the watcher call the API or OpenBao from other pods).

Environment (non-secret, chart `extraEnv`):

| Variable | Value |
|---|---|
| `LOKI_URL` | `http://loki.observability.svc:3100` |
| `TEMPO_URL` | `http://tempo.observability.svc:3200` |
| `PROMETHEUS_URL` | `http://prometheus.observability.svc:9090` |
| `OPA_URL` | `http://opa.asterius-platform.svc:8181` |
| `RENDER_URL` | `http://render.asterius-platform.svc:8080` (plan service; `RENDER_MODE` is set on its Deployment, `manifests/render.yaml`) |
| `ARGOCD_URL` / `ARGOCD_APP` | `http://argocd-server.argocd.svc` / `asterius-root` |
| `GRAFANA_URL` | `http://grafana.localtest.me:18080` |
| `ADO_ORG_URL` / `ADO_PROJECT` | `https://dev.azure.com/AsteriusIT` / `Platform` |
| `PORTAL_REPO_URL` / `PORTAL_REPO_BRANCH` | `https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources` / `main` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` | `http://otel-collector.otel.svc:4318` / `asterius-platform` / `k8s.cluster.name=asterius-v2` |
| `KUBE_JOB_NAMESPACES` | `asterius-jobs` (chart `rbac.jobNamespaces`) |
| `VAULT_ADDR`, `VAULT_K8S_ROLE`, `VAULT_K8S_JWT_PATH` | OpenBao, Kubernetes auth role `asterius-platform` |

Secret (from `asterius-platform-secrets`): `ADO_PAT`, `ARGOCD_TOKEN`, `DATABASE_URL`, `SECRETS_KEY`,
`METRICS_TOKEN`, `BOOTSTRAP_TOKEN`; crossplane profile: + `CROSSPLANE_WATCHER_SECRET` (the overlay
`bootstrap/crossplane/secrets.yaml` replaces the ExternalSecret).

## Argo CD

- App of apps `asterius-root`: `portal-resources`, branch `main`, path `argocd/`, not recursive, automated sync (prune,
  self-heal). It is the only thing Argo CD syncs from the bootstrap; what it contains is owned by the Portal repo.
- Repository credential: ExternalSecret `argocd/repo-portal-resources` (username `asterius-v2-kind`, password = PAT).
- Local account `portal` (`apiKey` only, RBAC `get` + `sync` on applications): its token is `ARGOCD_TOKEN`, for the
  refresh after a commit (`GET /api/v1/applications/asterius-root?refresh=normal`).
- Crossplane profile only: health checks (`values/crossplane-health.lua`) in `resource.customizations` for
  `platform.asterius.io/Service`, `platform.asterius.io/*`, `*.upbound.io/*`, `*.crossplane.io/*` (paused →
  Suspended; `Synced=False` or `LastAsyncOperation=False` → Degraded; `Ready=True` → Healthy, `Ready=False` →
  Progressing; XRDs by `Established`/`Offered`; packages by `Installed`+`Healthy`; objects without conditions →
  Healthy), and `ProviderConfigUsage` objects excluded. Wildcards only work in the `resource.customizations` block.

## Telemetry

```
portal ─OTLP─▶ otel-collector (Deployment) ─▶ Loki /otlp (logs) · Tempo :4317 (traces) · Prometheus remote write (metrics)
k8s events ─▶ otel-collector (k8s_events receiver)
asterius-jobs pod logs (+ crossplane-system in the crossplane profile) ─▶ otel-agent (DaemonSet, file_log) ─OTLP─▶ otel-collector
```

- Loki promotes the **resource** attributes `run_id`, `service`, `source`, `namespace`, `step`, `provider` to index
  labels (`limits_config.otlp_config`). The gateway moves these keys from log-record attributes to the resource
  (`groupbyattrs`), so producers can send them either way.
- `source`: `action-runner` (Job pods in `asterius-jobs`; `run_id` from the invoker's pod label `asterius.io/run-id`
  or `portal.asterius.io/run-id`, `step` = the Job name), `k8s_events` (events; `argocd` for `argoproj.io` objects),
  `provider` (crossplane profile: crossplane-system pods, `provider` = pod label `pkg.crossplane.io/provider` or
  `.../function`, else `crossplane`).
- Grafana data sources: `prometheus`, `loki`, `tempo` (uids), with trace ↔ log links on `run_id`.
- Collector component names are the current contrib ones (`file_log`, `k8s_attributes`, `otlp_http`, `otlp_grpc`,
  `prometheus_remote_write`).

## Extension hook

After the core install, `install.sh`:

1. builds `asterius-render:dev` from `apps/render-service/Dockerfile` (and, crossplane profile, `asterius-agent:dev`
   from `apps/agent/Dockerfile`) when they exist (build context: the repository root when the Dockerfile copies
   `apps/…` or `packages/…`, else the app folder) and loads them into the node;
2. `kubectl apply -f` every `deploy/kind/manifests/*.{yaml,yml,json}` (not recursive: render.yaml, opa.yaml,
   jobs-rbac.yaml…), and in the crossplane profile `deploy/kind/manifests/crossplane/*`, in alphabetical order.
   A failing build or apply is reported as a warning. With `--build`, Deployments using those images are restarted.

## Checks (`verify.sh`)

Both profiles: all pods Ready, no Argo Workflows left; the ingress hosts answer on :18080; OpenBao holds the PAT and
it authenticates against Azure DevOps; every ExternalSecret is synced and the contract Secrets have their keys; Argo
CD's repository connection is Successful and `asterius-root` is on path `argocd/`; the portal worker can create Jobs
in `asterius-jobs` only and `KUBE_JOB_NAMESPACES=asterius-jobs`; the contract's in-cluster URLs answer (portal
`/healthz`, OPA, plan service, Loki, Tempo, Prometheus, Argo CD, OpenBao) and the OTLP ports are open; a
`rotate-secret` token logs in to OpenBao with role `asterius-jobs`, may write `secret/teams/*` and is denied
elsewhere; Loki accepts OTLP logs (directly and through the collector) and `{run_id="test"}` returns them; a pod in
`asterius-jobs` labelled `asterius.io/run-id` has its stdout in Loki under that `run_id` (otel-agent); a trace sent
through the collector is in Tempo; a metric reaches Prometheus by remote write; Grafana's three data sources are
healthy. Lean: no Crossplane health checks in Argo CD. Crossplane: the watcher Secrets, the four health checks,
Crossplane and Gatekeeper ready, Gatekeeper sees DELETE operations.

## Deviations and local choices

| Item | Choice | Why |
|---|---|---|
| ingress-nginx | kind provider manifest (not the Helm chart) | the project's release downloads on github.com were failing (HTTP 504) while raw.githubusercontent.com works; same controller |
| Charts | pulled from OCI registries (ghcr.io) where available | same reason |
| Loki / Tempo charts | `grafana-community` charts | the `grafana/loki` and `grafana/tempo` charts moved there |
| Alertmanager, etcd / scheduler / controller-manager / kube-proxy scraping | off | not needed / not reachable on kind |
| Portal database | plain PostgreSQL 17 StatefulSet | no operator needed for one local database |
| `ADO_PAT` etc. in the portal | via `asterius-platform-secrets` (same OpenBao values as `portal-ado` / `portal-v2`) | the chart loads one Secret with `envFrom`; no template change |
| `ARGOCD_TOKEN` (extra) | Argo CD account `portal` | the portal requests a refresh after its commit |

## Uninstall

```bash
kind delete cluster --name asterius-v2   # only this cluster
```

A PAT created by the script stays valid in Azure DevOps until it expires (90 days): revoke `asterius-v2-kind` there if needed.
