# V2 read side: catalog watcher, feeds, run timeline, scorecards, SLOs

What the portal reads (V2.md §3.2, §6, §7, §9, §13), built against the contract in [V2-KIND.md](V2-KIND.md).

**Lean path (default).** There is no watcher and no Kubernetes object per service: the lifecycle comes from the portal's
own run (Requested → Committed → Reconciling → Ready | Degraded, Rejected, Deleting; [V2-WRITE-SIDE.md](V2-WRITE-SIDE.md)),
the observed properties from the Azure DevOps feed and the drift feed, and the run timeline shows the apply pipeline's
stages, jobs and tasks. **Crossplane profile.** The catalog watcher (§1) adds the cluster's view (XR and managed resources).

| Part | Where | Profile |
|---|---|---|
| Lifecycle and apply outcome | the V2 actions (`examples/v2/config/actions.yaml`) | lean (both) |
| ADO feed | `examples/v2/config/ado.yaml` (`ado-services`) | both |
| Drift feed | `examples/v2/config/drift.yaml` (`ado-drift`) | both |
| Catalog watcher (agent) | `apps/agent` (standalone package, no dependencies), `deploy/kind/manifests/crossplane/agent.yaml`, feed `examples/v2/crossplane/config/watcher.yaml` | crossplane |
| Scorecards | `examples/v2/config/scorecards.yaml` | both |
| Run timeline | `apps/server/src/v2/read/` (`GET /api/v1/runs/:id/timeline`), `apps/web/src/components/RunTimeline.tsx` | both |
| Entity panels | `apps/web/src/components/ObjectList.tsx`, `apps/web/src/pages/EntityPage.tsx` | both |
| SLO dashboard | `deploy/kind/manifests/crossplane/dashboard.yaml` (Grafana), PodMonitor + PrometheusRule in `agent.yaml` | crossplane |

The kind install mounts `examples/v2/config/*.yaml` always and `examples/v2/crossplane/config/*.yaml` in the crossplane
profile, so the lean configuration never declares the `crossplane-watcher` integration.

## 1. Catalog watcher (`apps/agent`, crossplane profile)

A Node process (TypeScript run directly by Node's type stripping, Node ≥ 22.18; image `node:24-alpine`, uid 1000,
read-only root filesystem) in namespace `portal-agent`. It talks to the Kubernetes API with `fetch`, the
ServiceAccount token (re-read every minute, projected tokens rotate) and the cluster CA through `NODE_EXTRA_CA_CERTS`.

**Watched types.** Discovered from the CRDs at start and at every resync, so new providers and constraint templates
are picked up without a restart:

| Type | How it is found |
|---|---|
| Service XRs | CRD `services.platform.asterius.io` (fallback `v1alpha1`) |
| Managed resources | every CRD whose `categories` include `managed` (Crossplane MRs, v1 and v2 namespaced) |
| Gatekeeper constraints | every CRD of group `constraints.gatekeeper.sh` |
| Compositions | `apiextensions.crossplane.io` Composition (golden-path labels) |
| Argo CD Applications | `argoproj.io` Application (sync failures → Rejected) |
| Events | core `v1` Events (→ OTLP logs) |

Each type is an informer (`src/informer.ts`): list, then watch from the list's `resourceVersion` with bookmarks; a 410
Gone (HTTP or watch `ERROR` event) re-lists and emits the differences, so nothing is lost across watch restarts. RBAC:
`get/list/watch` only (ClusterRole `asterius-catalog-watcher` + binding to Crossplane's aggregated `crossplane-view`,
which covers every provider's MR kinds; no Secrets).

**Delivery.** Changes are debounced (`DEBOUNCE_MS` 2 s, at most `MAX_DELAY_MS` 10 s after the first change); every
flush recomputes all services from the caches and sends only those whose status changed. Every `RESYNC_MINUTES` (5)
the watcher re-discovers types, re-lists every informer and re-sends every service (`mode: full`) — the backstop for a
lost watch event or a lost delivery. A failed POST is retried with exponential backoff (max 60 s). Unchanged services
keep their `observedAt`, so a full resync rewrites nothing in the catalog (no history versions, no events).

**Per service** (`src/state.ts`, pure and unit tested). Identity: team = label `portal.asterius.io/team`, else the
namespace minus `team-`; service = label `portal.asterius.io/service`, else the XR name; identifier `<team>/<service>`.

| Field | Rule |
|---|---|
| `xrReady` / `xrSynced` | XR conditions `Ready` / `Synced` = True |
| `conditions` | XR conditions (+ `Admission` False when Argo CD failed to apply the Service) |
| `resources` | MRs of the XR (by `spec.crossplane.resourceRefs`, label `crossplane.io/composite`, or the team/service labels; same namespace): `apiVersion, kind, name, namespace, externalName` (`crossplane.io/external-name`), `ready`, `synced`, `message` (first non-True condition), `runId` |
| `violations` | `Constraint.status.violations` whose kind/namespace/name is the XR or one of its MRs: `{policy, message, resource, enforcementAction, source: audit}`; policy = label `platform.asterius.io/policy` or the constraint name. Gatekeeper denials quoted by Argo CD (`[policy] message`) are added with `source: admission` |
| `goldenPathVersion` | label `platform.asterius.io/version` of the Composition in `spec.crossplane.compositionRef` (fallback: `<name>-v<N>`) |
| `observedRunId` | annotation (else label) `portal.asterius.io/run-id` of the XR |
| `managedBy` | `crossplane` |
| `lifecycle` | `Deleting` (deletion timestamp, or the XR disappeared — sent once) · `Rejected` (the team's Argo CD app's last operation has `SyncFailed` for this Service; also when the XR never reached the cluster) · `Degraded` (XR `Synced=False` or any MR `Synced=False`) · `Ready` (XR `Ready=True`) · `Synced` (applied, no conditions and no MRs yet) · `Reconciling` (otherwise) |

**Payload** (`POST $PORTAL_URL/api/v1/ingest/crossplane-watcher`, or `/ingest/<PORTAL_ORG>/crossplane-watcher`):

```json
{ "source": "crossplane-watcher", "sentAt": "2026-11-08T09:42:31Z", "mode": "delta",
  "services": [ { "identifier": "payments/payments-api", "team": "payments", "service": "payments-api",
    "namespace": "team-payments", "name": "payments-api", "exists": true, "lifecycle": "Reconciling",
    "managedBy": "crossplane", "xrReady": false, "xrSynced": true, "conditions": [ … ],
    "resources": [ { "apiVersion": "…", "kind": "Project", "name": "…", "externalName": "…", "ready": true, "synced": true } ],
    "violations": [], "goldenPath": "java-api", "goldenPathVersion": "3", "compositionRef": "java-api-v3",
    "observedRunId": "r-8f2c", "observedAt": "…" } ] }
```

At most 100 services per POST. Headers: `X-Watcher-Signature: sha256=<hex HMAC-SHA256(raw body, CROSSPLANE_WATCHER_SECRET)>`
(the portal's generic `signatureHeader` verification) and a unique `X-Asterius-Delivery` (the portal drops replays).
The mapping ignores deliveries whose `sentAt` is older than 15 minutes (replays and long-queued events cannot roll
the state back).

**Events → OTLP logs.** Events about a cached XR, MR or Argo CD Application (and, for an Application, one record per
rejected Service its message names) are posted as OTLP/HTTP JSON to `$OTEL_EXPORTER_OTLP_ENDPOINT/v1/logs`
(`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` as is), batched every 2 s, best effort (bounded buffer). Attributes: `run_id`
(object's run-id annotation/label), `service`, `team`, `namespace`, `source` (`k8s_events` | `argocd`), `step` (the
object kind, e.g. the MR kind), `provider` (from the API group, `crossplane` for XRs, `argocd`), `k8s.event.reason`,
`k8s.event.type`, `k8s.object.kind/name/api_group`. The collector's `groupbyattrs` turns `run_id, service, source,
namespace, step, provider` into Loki labels. Events listed at start-up are not exported (they predate the watcher;
the collector's own `k8s_events` receiver has them without run id), repeats are exported once per occurrence (`count`).

**Metrics** (`:9464/metrics`, scraped by the PodMonitor; `/healthz`, `/readyz`):

| Series | Meaning |
|---|---|
| `asterius_watcher_time_to_ready_seconds{golden_path,version}` | histogram: first sight of a run id on an XR → that XR Ready (runs already Ready when first seen, e.g. after a restart, are not measured) |
| `asterius_watcher_reconcile_errors_total{provider,kind,reason}` | Warning events on managed resources |
| `asterius_watcher_admission_rejections_total{policy}` | new Argo CD sync rejections |
| `asterius_watcher_services{lifecycle}`, `asterius_watcher_managed_resources{provider,kind,state}`, `asterius_watcher_policy_violations{policy}` | gauges from the last computation |
| `asterius_watcher_ingest_posts_total{result}`, `asterius_watcher_otlp_log_records_total{result}`, `asterius_watcher_watch_restarts_total{resource,reason}`, `asterius_watcher_last_full_resync_timestamp_seconds` | operation |

Recording rules / alerts (`PrometheusRule` in `agent.yaml`): p90 time to Ready, reconcile error rate, no full resync for
15 minutes, services Degraded for 30 minutes. Dashboard "Asterius platform SLOs (V2)" (`dashboard.yaml`, ConfigMap in
`observability` labelled `grafana_dashboard: "1"`), with a Loki panel for a `run_id` variable.

**Environment (agent).** `PORTAL_URL` (required), `CROSSPLANE_WATCHER_SECRET` (required, Secret `portal-agent/watcher`
key `secret`), `PORTAL_ORG`, `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `NODE_EXTRA_CA_CERTS`
(in cluster: the ServiceAccount `ca.crt`), `RESYNC_MINUTES` (5), `DEBOUNCE_MS` (2000), `MAX_DELAY_MS` (10000),
`METRICS_PORT` (9464), `LOG_LEVEL`; outside a cluster `KUBE_API_URL` (e.g. `kubectl proxy`) and `KUBE_TOKEN` /
`KUBE_TOKEN_FILE`.

Develop: `cd apps/agent && npm test` (node:test, no install needed); type check with the repository's TypeScript
(`../../node_modules/.bin/tsc -p apps/agent`); run locally with `kubectl proxy` and
`KUBE_API_URL=http://127.0.0.1:8001 PORTAL_URL=… CROSSPLANE_WATCHER_SECRET=… node src/index.ts`. Image:
`docker build -t asterius-agent:dev apps/agent` (context: the package folder).

## 2. Feeds and ownership (`examples/v2/config/ado.yaml`, `drift.yaml`; `examples/v2/crossplane/config/watcher.yaml`)

Integrations write `platform-service` entities; the portal writes the intent and the apply outcome (through its actions,
`source: action`). **Every feed writes with `merge: true`**: an ingest merges the mapped properties into the stored entity and
keeps every other property, so the watcher never wipes the portal's intent (owner, golden path, cost centre,
`lastRunId`…) nor the tool properties, and the reverse. Field-level ownership between integrations is the existing
mechanism (`entities.field_owners`, `priority`): the watcher (priority 100) outranks Azure DevOps (50) where both could
write.

New, opt-in: **`setOnce`** on a mapping (zod-validated, requires `merge: true`) — properties written only while the
entity has no value for them, whoever wrote it. The ADO feed sets `managedBy: legacy` (and `team`) that way, so it
never overwrites the portal's `opentofu` (written by every successful apply, whatever was there before: a legacy
service adopted through a spec becomes `opentofu`) nor the watcher's `crossplane` (V2.md §13), while services without a
spec still get `legacy`.

| Integration | Type | Writes |
|---|---|---|
| `crossplane-watcher` | `webhook` (secret `${env:CROSSPLANE_WATCHER_SECRET}`, `signatureHeader: x-watcher-signature`) | `lifecycle`, `managedBy`, `xrReady`, `xrSynced`, `goldenPathVersion`, `conditions`, `resources`, `violations`, `observedRunId`, `observedAt`; `team` set-once |
| `ado-services` | `azure-devops` pull every 15 min (org `https://dev.azure.com/AsteriusIT`, token `${env:ADO_PAT}`, project `Platform` excluded) | repositories of projects `<team>-<service>` → `repoUrl`, `adoProjectUrl`; pipelines `<service>-ci` → `pipelineId`, `pipelineUrl`; `managedBy: legacy` + `team` set-once; projects outside the convention → `<project>/<repo>` legacy entities |
| `ado-drift` | `azure-devops` kind `build`, pull every 60 min: the latest 50 completed runs of `portal-services-drift` (project `Platform`) | `drift` (boolean), `driftCheckedAt` (the run's finish time), `driftRunUrl`; merge, nothing else |

**Drift tags.** The drift pipeline reports through build tags; both formats are read, also mixed in one run:
`service:<team>/<service>` + `drift:yes|no` (one run per service), and `drift:<team>/<service>=yes|no` (one run for many
services, one tag each; `true`/`false` accepted, case-insensitive). Tags without a `<team>/<service>` (e.g.
`service:all`) are ignored. The source answers the runs **oldest first**, so the newest check of a service is written
last and wins. Drift never changes the lifecycle.

The `azure-devops` source's kind `build` (config `project` + `pipeline`, a name or an id; `buildsTop`, default 50, max
500): `GET _apis/build/definitions?name=` (when a name) then `GET _apis/build/builds?definitions=<id>&statusFilter=completed&queryOrder=finishTimeDescending&$top=<n>`;
each item is the Build (`id`, `buildNumber`, `result`, `finishTime`, `tags`, `_links.web.href`…) plus `project: { name }`.

The `azure-devops` source now lists pipelines of **every project** when no `project` is configured (each V2 service has
its own project); each pipeline item carries `project: { id, name }`.

The portal's own writes must merge as well (catalog invoker `merge: true`), otherwise an intent write replaces the
observed properties until the next watcher resync.

## 3. Run timeline

`GET /api/v1/runs/:id/timeline` (any user who may see the run; `?refresh=true` lets an admin drop the cached copy):

```json
{ "runId": "r-8f2c", "terminal": false, "cached": false,
  "entity": { "blueprint": "platform-service", "identifier": "payments/payments-api", "lifecycle": "Degraded" },
  "sources": [ { "name": "portal", "status": "ok", "count": 3 }, { "name": "catalog", "status": "ok", "count": 5 },
               { "name": "loki", "status": "ok", "count": 12 }, { "name": "tempo", "status": "unconfigured", "count": 0 } ],
  "events": [ { "time": "…", "step": "SonarProject s", "status": "failure", "symbol": "✗",
                "message": "quality gate 'acme-default' not found → retrying", "source": "catalog" } ] }
```

Sources, merged by time (portal first at equal times, duplicates removed, at most 1000 events):

- **ado** (lean path) — for every `azure-pipeline` step of the run that started a pipeline run (its link
  `…/_build/results?buildId=<id>`): `GET <org>/<project>/_apis/build/builds/<id>/timeline` with the step's own token
  (its `${env:…}` / `${secret:…}` reference resolved with the run's allow-list; sent only to the step's configured
  organization). Records of type Stage, Job and Task that started become events: step `Stage apply` / `Job plan` /
  `Task tofu apply`, status from the result (failed / canceled → ✗, running while in progress), message `<portal step> ·
  <result> · <duration> · <first error>`. Pending and skipped records are left out. The source is listed only for runs
  with pipeline steps; a failing call reports `error` (the rest is still returned).

- **portal** — the run: requested, approvals, each step at its end (or start while running), run end.
- **catalog** — the entity history (`entity_versions`) of the run's `platform-service` entity (its target, else the
  entity whose `lastRunId` / `observedRunId` is the run) from the run's creation, until a newer run takes the entity
  over: lifecycle transitions (Committed, Synced "applied by Argo CD", Reconciling, Ready, Degraded, Rejected with the
  admission message) and managed resources becoming ready or failing. This works with no telemetry backend at all.
  Shown only to callers who may read the entity.
- **loki** — `GET $LOKI_URL/loki/api/v1/query_range?query={run_id="<id>"}` (run start − 1 min → now + 1 min, 1000
  lines; `LOKI_TENANT` → `X-Scope-OrgID`); step = `step` label (else provider/source), status from the level and the
  text (✓ Created/Ready/Synced…, ✗ errors/denied/warnings).
- **tempo** — `GET $TEMPO_URL/api/search?tags=run_id=<id>`: one event per trace (root span name, service, duration).

Unset `LOKI_URL` / `TEMPO_URL` report `unconfigured`; a failing backend reports `error` (the rest is still returned).
Timeouts: `TIMELINE_TIMEOUT_MS` (8000).

**Caching.** Stored in `run_timelines` (migration 2, SQLite and Postgres, cascades with the run) when the run is
finished, every configured source answered, and the service is final for this run: Ready with `observedRunId` = the
run, Rejected, Degraded for 30 minutes, superseded by a newer run, or nothing was committed (the run failed while the
entity was still `Requested`); each with a 60 s settle delay for late log lines. For runs with pipeline steps (lean path)
Degraded is final once settled (the portal recorded it from its own pipeline; no watcher changes it later). Runs without a platform-service entity
are cached 60 s after they end.

**UI.** The run page has a **Timeline** button (drawer next to the graph); the entity page shows **Latest run** (the
last 15 events of `lastRunId`, link to the run). Properties holding lists of objects (managed resources, violations,
conditions — any blueprint) are rendered as tables below the properties instead of inline JSON.

## 4. Scorecards (`examples/v2/config/scorecards.yaml`)

Scorecard `platform-service-health` (Bronze → Silver → Gold):

| Rule | Level | Expression (summary) |
|---|---|---|
| Managed by platform | Bronze | `managedBy in ["opentofu", "crossplane"]` |
| Has owner and on-call | Bronze | entity team or `team`, and `onCall` |
| On current golden path | Silver | `goldenPathVersion` (written by a successful apply, or observed by the watcher) = latest of `goldenPath`; latest is the `$latest` object (`{"java-api": "3"}`) at the top of the file (`x-current-golden-path`) |
| No policy violations | Silver | no `violations` and not `Rejected` |
| Up to date (no drift) | Silver | `drift = false` and `driftCheckedAt` within the last 3 days |
| Secrets from Vault | Silver | `vaultSecrets = true` |
| Quality gate passes | Gold | `qualityGate` in OK / PASSED (the SonarQube feed's status; off on kind, so Gold is not reachable there) |

No rule needs a Crossplane-only property: a lean service reaches Silver.

## 5. Portal environment

`ADO_PAT` (integrations, the ado timeline source through the steps' references), `LOKI_URL`, `TEMPO_URL`, optional
`LOKI_TENANT`, `TIMELINE_TIMEOUT_MS`; crossplane profile: `CROSSPLANE_WATCHER_SECRET`. Loki and Tempo are operator-configured in-cluster endpoints and are called without the outbound
SSRF guard.

## 6. Limits

- Rejected is derived from the latest Argo CD operation only; the run id of a Service that never reached the cluster is
  unknown to the watcher (the run page still shows it through the entity history: `lastRunId` is the run).
- A Service removed from Git after a rejection stays `Rejected` in the catalog (no XR, no Argo result to observe).
- Time to Ready is measured from the watcher's first sight of the run id; a watcher restart in the middle measures from
  the restart.
- Tempo search returns trace roots only (no per-span status).
