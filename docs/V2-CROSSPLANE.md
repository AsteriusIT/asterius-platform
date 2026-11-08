# V2 on kind — Crossplane profile (optional): implementation contract

This file fixes the interfaces between the parts of the V2 build (see [V2.md](V2.md)), so that each part can be
built and tested on its own. Change a value here only together with every part that uses it.

Target: a local **kind** cluster plays the management cluster. Azure DevOps (org `AsteriusIT`, project `Platform`)
plays the tools zone and holds the Portal repo. **No Azure resources are created** (an Azure Storage account is the
only allowed exception). Hence no ACR, no AKS, no Entra objects, no Azure resource groups.

## Deviations from V2.md (local target)

| V2.md | Here | Why |
|---|---|---|
| AKS | kind cluster `asterius-v2` (context `kind-asterius-v2`) | Local |
| ACR (Configuration package, provider images) | CI builds and validates the package as a pipeline artifact; Argo CD applies `platform/` manifests directly | No Azure resources |
| ADO webhook → Argo CD | Argo CD polls the repo every 30 s; the portal also requests a refresh after its commit | ADO cloud cannot reach kind |
| Vault | OpenBao (Vault API) | Same API, open source |
| Entra / Azure / SonarQube resources in the Composition | Only Azure DevOps resources; SonarQube behind `quality.sonarqube` and off by default | No Azure resources; SonarQube is heavy on kind |
| ADO repo `portal-platform` in project "Portal" | `portal-resources` in project `Platform` | Existing repo given |
| Crossplane project (custom/Upjet providers) | Not built (phase 6) | Upstream / Terraform-based provider covers ADO |
| Native ADO managed resources | `upbound/provider-opentofu` namespaced `Workspace` (one per ADO resource) running the `microsoft/azuredevops` Terraform provider; state in Kubernetes Secrets | No official ADO provider; community Upjet packages are not pullable anonymously; OpenTofu ≥ 1.10 imports by deterministic name (rebuild = adoption) |
| `deletionPolicy: Orphan` | Management policies without `Delete` on project and repo | Crossplane v2 namespaced MRs have no `deletionPolicy` |
| `costCenter` required in the XRD | Enforced by policy only (`cost-center-required`) | A schema `required` would reject before Gatekeeper/OPA can explain why |

Verified live on 2026-11-08: portal form (from the XRD) → preview (OPA + real `crossplane render`) → commit with
`Run-Id`/`On-Behalf-Of` trailers → Argo CD → Gatekeeper → Crossplane → ADO project, repo, pipeline, environments →
watcher → entity `Ready` (≈ 70 s), run timeline from portal steps + Loki events by `run_id`; Gatekeeper denials
(missing cost centre, non-Argo writer, protected delete); prune protection; pause; Argo Workflows actions
`rerun-pipeline`, `grant-temporary-access`, `rotate-secret`; legacy ADO projects ingested as `managedBy: legacy`.

Known limits: the preview lists only the first wave of resources (the others wait for the project ID, which
`crossplane render` cannot observe); after a cluster rebuild, pipeline and environments are recreated rather than
adopted (project and repo are adopted); SonarQube is not composed.

## Names

| Thing | Value |
|---|---|
| kind cluster | `asterius-v2` (never touch the other kind cluster `blackbox`) |
| Ingress | ingress-nginx, host ports **18080** (http) / **18443** (https) |
| Hosts | `portal.localtest.me`, `argocd.localtest.me`, `grafana.localtest.me`, `workflows.localtest.me`, `openbao.localtest.me` (all resolve to 127.0.0.1) |
| Namespaces | `argocd`, `crossplane-system`, `gatekeeper-system`, `otel`, `portal-agent`, `external-secrets`, `argo-workflows`, `observability`, `openbao`, `asterius-platform`, one `team-<team>` per team |
| Portal repo | `https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources`, branch `main`, local clone `/home/qrodic/workspace/azuredevops/AsteriusIT/portal-resources` |
| API group | `platform.asterius.io`, version `v1alpha1`, kind `Service`, **namespaced** (Crossplane v2 XRD `apiextensions.crossplane.io/v2`) |
| Golden path | Composition `java-api-v3`, labels `platform.asterius.io/golden-path: java-api`, `platform.asterius.io/version: "3"` |
| Annotations | `portal.asterius.io/run-id`, `portal.asterius.io/requested-by`, `portal.asterius.io/paused: "<RFC3339 expiry>"`, `portal.asterius.io/paused-reason`, `portal.asterius.io/decommission-run-id` |
| Labels on XR and every MR | `portal.asterius.io/run-id`, `portal.asterius.io/team`, `portal.asterius.io/service` (service name only; label values cannot hold `/`); `protected: "true"` on the XR when `prod` is in environments |
| Entity identifier | `<team>/<service>` (blueprint `platform-service`) |
| Deterministic external names | ADO project `<team>-<service>`; repo `<service>`; pipeline `<service>-ci`; ADO environments `<env>`; Sonar key `<team>-<service>` |

## Spec written by the portal

`services/team-<team>/<service>.yaml`:

```yaml
apiVersion: platform.asterius.io/v1alpha1
kind: Service
metadata:
  name: payments-api
  namespace: team-payments
  annotations:
    portal.asterius.io/run-id: <portal run id>
    portal.asterius.io/requested-by: jane@asterius.fr
  labels:
    portal.asterius.io/team: payments
    portal.asterius.io/service: payments-api
    portal.asterius.io/run-id: <portal run id>
    protected: "true"              # only when prod is in environments
spec:
  owner: payments
  goldenPath: { name: java-api, version: "3" }
  repository: { template: java-spring-api }
  quality: { sonarqube: false, qualityGate: acme-default }
  secrets: { vault: true }
  environments: [dev, staging, prod]
  costCenter: CC-4711
  onCall: payments-oncall          # required when prod is in environments
  crossplane:
    compositionRef: { name: java-api-v3 }   # = <goldenPath.name>-v<goldenPath.version>
    compositionUpdatePolicy: Manual
```

Team folder `services/team-<team>/team.yaml`, written by the portal with the first service of a team if missing:
a `Namespace` `team-<team>` labelled `portal.asterius.io/team: <team>`, plus a `ResourceQuota` (the template is in
the Portal repo at `services/_templates/team.yaml`; `<team>` is the only placeholder).

Commits: one commit per request on `main`, message `<verb> <team>/<service>`, trailers `Run-Id: <id>` and
`On-Behalf-Of: <email>`. Pushed through a serialized queue (rebase and retry on non-fast-forward).

## Portal repo layout (portal-resources)

As in V2.md §4.1, plus:

- `platform/packages/` — Crossplane `Provider`, `Function`, `ProviderConfig`, `DeploymentRuntimeConfig` (synced by Argo CD).
- `policies/rego/` — shared Rego (see OPA contract).
- `argocd/root.yaml` is **not** in the repo: the bootstrap applies an app-of-apps `asterius-root` on path `argocd/`.
- `deploy/portal/` — kustomization that generates, in namespace `asterius-platform`, ConfigMap `portal-rego` (files of
  `policies/rego/`) and ConfigMap `portal-compositions` (XRD, Compositions and Function manifests for the render
  service). Synced by the platform app.

## Secrets (OpenBao → External Secrets)

| Item | Value |
|---|---|
| OpenBao | `http://openbao.openbao.svc:8200`, KV v2 mount `secret/` |
| ClusterSecretStore | `openbao` |
| ADO credentials | `secret/platform/ado`: `pat` (PAT, created by the bootstrap through the PAT API with the az CLI token), `org_url` = `https://dev.azure.com/AsteriusIT` |
| Portal env | Secret `portal-ado` in `asterius-platform` (key `ADO_PAT`), from an ExternalSecret |
| Argo CD repo credential | Secret in `argocd` labelled `argocd.argoproj.io/secret-type: repository` (from the same PAT) |

## In-cluster endpoints (stable Service names)

| Service | URL |
|---|---|
| Portal API | `http://asterius-platform.asterius-platform.svc:8080` |
| OPA (portal pre-check) | `http://opa.asterius-platform.svc:8181` (loads ConfigMap `portal-rego`) |
| Render service (preview) | `http://render.asterius-platform.svc:8080` |
| Loki | `http://loki.observability.svc:3100` |
| Tempo | `http://tempo.observability.svc:3200` (OTLP gRPC `tempo.observability.svc:4317`) |
| Prometheus | `http://prometheus.observability.svc:9090` |
| OTel Collector | OTLP `otel-collector.otel.svc:4317` (gRPC) / `:4318` (HTTP) |
| Argo Workflows server | `http://argo-workflows-server.argo-workflows.svc:2746`; the portal's token is Secret `portal-argo-token` (key `token`) in `asterius-platform` |
| Argo CD server | `http://argocd-server.argocd.svc` |

Charts may name Services differently: the bootstrap adds alias Services so these names work.

## OPA contract (one Rego, three entry points)

- Core rules: `package platform.rules`, `violations contains {"policy": <id>, "msg": <text>}` over `input.service`
  (a `Service` manifest as above).
- Portal adapter: `package platform.portal`, `result := {"allowed": count(v) == 0, "violations": v}`.
  The portal calls `POST /v1/data/platform/portal/result` with `{"input": {"service": <manifest>}}`.
- CI: `conftest test --policy policies/rego --namespace platform.conftest services/` (adapter turns violations into `deny`).
- Gatekeeper: ConstraintTemplates embed the same rules through `libs`, input adapter `input.review.object`.

First policies: `prod-requires-oncall`, `cost-center-required` (pattern `^CC-[0-9]+$`), `approved-composition`
(compositionRef ∈ approved list and = `<goldenPath.name>-v<goldenPath.version>`), `mr-has-service-label`,
`protected-delete` (DELETE on `protected=true` XR needs `portal.asterius.io/decommission-run-id`), and
`only-argocd-writes-xr` (in cluster only).

## Render service (preview)

`POST /render` with `{"service": <manifest>}` → `{"resources": [{"apiVersion","kind","name","externalName"}], "raw": [...]}`.
Runs the real `crossplane render` with functions as sidecars in Development runtime (insecure gRPC on localhost),
composition files from ConfigMap `portal-compositions`.

## Catalog watcher → portal

- Agent in `portal-agent` (ServiceAccount: `get/list/watch` on Service XRs, Crossplane MRs, Gatekeeper constraints).
- Posts to the portal inbound webhook `POST /api/v1/ingest/crossplane-watcher` (default organization, HMAC secret
  `CROSSPLANE_WATCHER_SECRET`, integration declared in `examples/v2/config/`).
- Owns the observed properties: `xrReady`, `xrSynced`, `managedBy`, `goldenPathVersion`, `conditions`, `resources`,
  `violations`, `observedRunId`, `lifecycle` transitions Synced/Reconciling/Ready/Degraded/Deleting. A feed never
  overwrites another feed's properties.

## Lifecycle

`Requested → Committed → Synced → Reconciling → Ready → Deleting`, plus `Rejected` and `Degraded` (V2.md §6.2).
Portal sets `Requested`, `Committed`, `Rejected` (pre-check); the watcher sets the rest; `Rejected` on admission
denial comes from the Argo CD application status via the watcher.

## Telemetry

Every record carries `run_id`, `service`, `step`, `provider` where known. Loki labels: `run_id`, `service`,
`namespace`, `source` (`k8s_events` | `provider` | `argocd` | `action-runner`). The run page queries
`{run_id="<id>"}` in Loki and `run_id=<id>` in Tempo.

## Portal configuration

V2 portal config lives in `examples/v2/config/` (blueprint `platform-service`, actions, integrations, scorecards).
The kind deployment mounts it together with `config/`.
