# V2 lean: implementation contract (default profile)

V2 keeps the ideas of [V2.md](V2.md) — intent in Git, one spec per service, run ID everywhere, one Rego enforced in
the portal and in CI, catalog filled from observed state, deterministic names — and runs them on the **lean path**
(V2.md §14): **portal + Git + Azure DevOps pipelines + OpenTofu + OPA + OpenTelemetry**.

- **Argo Workflows is removed.** One-shot operations are portal workflows calling ADO pipelines or Kubernetes Jobs.
- **Crossplane is optional** (`deploy/kind/install.sh --profile crossplane`, contract in
  [V2-CROSSPLANE.md](V2-CROSSPLANE.md)): Crossplane, Gatekeeper and the catalog watcher. The spec format and the
  catalog feeds are the same on both paths, so a service can move from one to the other.

Fixed values below are shared by the portal, the Portal repo and the kind install. Change one only with every user.

## Shape

```
Developer ─▶ Portal form (fields from the spec schema)
              ├─ pre-check: OPA (shared Rego) + preview = real `tofu plan` (plan service)
              ├─ entity lifecycle Requested, lastRunId
              ├─ commit services/team-<team>/<service>.yaml to main (serialized queue, trailers Run-Id / On-Behalf-Of)
              └─ queues pipeline portal-services-apply (service, runId) and follows it
                    └─ conftest on spec + plan JSON → tofu apply (adopts existing resources by name) → ADO
              ◀─ result: lifecycle Ready | Degraded; outputs (projectUrl, repoUrl, pipelineId…)
Nightly pipeline portal-services-drift: tofu plan -detailed-exitcode per service → build tags → portal feed (drift)
ADO pull integration: observed repos/pipelines/projects → entity (managedBy legacy for projects without a spec)
OTel: portal traces + logs (run_id) → collector → Loki / Tempo / Prometheus
```

## Names

| Thing | Value |
|---|---|
| kind cluster | `asterius-v2` (context `kind-asterius-v2`; never touch `blackbox`) |
| Ingress | host ports 18080 / 18443; hosts `portal`, `argocd`, `grafana`, `openbao` `.localtest.me` |
| Namespaces (lean) | `argocd`, `external-secrets`, `observability`, `otel`, `openbao`, `asterius-platform`, `asterius-jobs` (Kubernetes Job invoker) |
| Portal repo | `https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources`, branch `main` |
| Spec | unchanged: `apiVersion: platform.asterius.io/v1alpha1`, `kind: Service`, path `services/team-<team>/<service>.yaml`, same annotations/labels as V2-CROSSPLANE.md; `spec.crossplane` is optional and ignored by OpenTofu |
| Golden path | OpenTofu module `golden-paths/java-api/v3` (= `<goldenPath.name>/v<goldenPath.version>`) |
| Deterministic names | ADO project `<team>-<service>`, repo `<service>`, pipeline `<service>-ci`, environments `<env>` |
| Entity | blueprint `platform-service`, identifier `<team>/<service>` |

## OpenTofu

- Root module `tofu/service/` reads the spec (`var.spec_path`, `yamldecode`) and calls the golden-path module.
- Backend `azurerm`: storage account `staitplatformtfstates` (resource group `rg-platform`), container `tfstate`,
  key `portal-services/<team>/<service>.tfstate`, Entra auth (OIDC from the service connection). **Existing Azure
  storage — no new Azure resource.**
- Adoption: `import` blocks driven by lookups of the deterministic names (and `spec.adopt` ids), so a lost state or a
  legacy project is adopted, never duplicated. `prevent_destroy` on project and repo.
- Pause: `portal.asterius.io/paused` with a future expiry → apply is skipped (plan only, reported as paused).
- Decommission: annotation `portal.asterius.io/decommission-run-id` + operation `decommission`: destroy pipeline and
  environments; project and repo are archived (removed from state, kept in ADO) unless `deleteData=true`.

## Pipelines (ADO project Platform)

| Pipeline | File | Trigger | Parameters |
|---|---|---|---|
| `portal-resources-ci` | `azure-pipelines.yml` | PRs + main | — (fmt/validate, opa test, conftest on specs, tofu validate) |
| `portal-services-apply` | `pipelines/apply.yml` | main, paths `services/**` (changed specs) + queued by the portal | `service` (`<team>/<service>` or `changed`), `runId`, `operation` (`apply` \| `decommission`), `deleteData` (bool) |
| `portal-services-drift` | `pipelines/drift.yml` | nightly 02:00 UTC + manual | `service` (`all` or one) |
| `portal-operations` | `pipelines/operations.yml` | queued by the portal | `operation` (`grant-temporary-access`), `service`, `runId`, `user`, `group`, `duration` |

- Credentials: service connection `sc-platform-terraform` (workload identity federation) for the state backend;
  the azuredevops provider uses the same identity when it is an ADO org member, else the secret variable group
  `portal-services` (`ADO_PAT`).
- Every run sets its build number to include the run ID and adds build tags `service:<team>/<service>`,
  `run:<runId>`, and `result:applied|nochange|paused|failed` (apply) or `drift:yes|no` (drift).
- Apply publishes `outputs.json` (`projectId`, `projectUrl`, `repoUrl`, `pipelineId`, `pipelineUrl`, `environments`).

## Portal

- Actions (`examples/v2/config/actions.yaml`): create (pre-check → approval if prod → commit → queue
  `portal-services-apply` → lifecycle Ready/Degraded), update/upgrade golden path, pause/resume, decommission
  (approval, operation `decommission`, then remove the spec), rerun pipeline (queue `<service>-ci` in project
  `<team>-<service>`), grant temporary access (`portal-operations`), rotate secret (Kubernetes Job in `asterius-jobs`
  writing to OpenBao `secret/teams/<team>/<service>`).
- Lifecycle: `Requested → Committed → Reconciling (apply running) → Ready | Degraded`, `Rejected` (pre-check),
  `Deleting`; drift sets property `drift` (`true|false`) and `driftCheckedAt`, not the lifecycle.
- Preview: plan service `POST $RENDER_URL/render {service}` → `{resources: [{kind, name, externalName, action}], raw}`
  where `action` ∈ `create|import|update|delete|no-op` — a real `tofu plan` against ADO with a throwaway local state
  (imports show what already exists). Same response shape as the Crossplane render, so the UI is shared.

## Verified live (2026-11-08)

- Portal create of `v2test/inventory-api`: pre-check (schema + OPA + real `tofu plan`: 6 creates) → commit with
  `Run-Id` → apply build 162 `result:applied` → entity `Ready`, `managedBy: opentofu`, URLs filled; the push-triggered
  build 163 skipped the portal's commit (`result:nochange`). Timeline: portal steps + ADO stages/tasks.
- Rebuild drill: the Crossplane-era projects (hello-api, orders-api, my-service-v2) adopted by import — inventory of
  24 ADO objects identical before/after; second apply `result:nochange`.
- Drift found only on the service changed by hand and fixed by apply; pause → `result:paused`; temporary access
  granted then revoked; decommission archives project + repo (`deleteData=false`); removing a spec deletes nothing.
- Pipelines (27–29) authenticate with workload identity federation (`sc-platform-terraform`): no PAT in ADO.

Deviations: build tags set through the REST API (`##vso[build.addbuildtag]` rejects `:`); `import` blocks live in
the root module (OpenTofu forbids them in child modules); several changed specs in one push fan out to one child run
each (not yet exercised live); `deleteData=true` covered by plan checks and Rego tests, not a live run.

## In-cluster endpoints (lean)

Portal `asterius-platform.asterius-platform.svc:8080`, OPA `opa.asterius-platform.svc:8181`, plan service
`render.asterius-platform.svc:8080`, Loki `loki.observability.svc:3100`, Tempo `tempo.observability.svc:3200`,
Prometheus `prometheus.observability.svc:9090`, OTel Collector `otel-collector.otel.svc:4317/4318`, OpenBao
`openbao.openbao.svc:8200` (ADO PAT at `secret/platform/ado`).
