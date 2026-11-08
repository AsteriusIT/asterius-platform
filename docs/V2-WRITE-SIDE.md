# V2 write side: self-service that commits Service specs and applies them

How the portal turns a form into a commit in the Portal repo and an OpenTofu apply (docs/V2.md §5, §6, §8, §10.3–10.5,
§11), within the lean contract of [V2-KIND.md](V2-KIND.md) (the Crossplane profile, [V2-CROSSPLANE.md](V2-CROSSPLANE.md),
uses the same specs). The read side (feeds, run timeline, scorecards) is described in [V2-READ-SIDE.md](V2-READ-SIDE.md).

```
form ──▶ preview (POST /actions/:id/preview)   spec + schema check + OPA verdict + tofu plan (create / import / update / delete)
  │
  └─▶ run: precheck (schema + OPA, fail closed) ─▶ catalog Requested ─▶ approval if prod ─▶ commit (queue) ─▶ Committed
                 │ denied                                                                                       │
                 └─▶ run FAILURE, entity Rejected                     Reconciling ◀── queue portal-services-apply ┘
                                                                           │ (azure-pipeline invoker, followed until done)
                                                       succeeded ──▶ Ready (managedBy opentofu, outputs)  │  failed ──▶ Degraded + run FAILURE
```

## Actions (`examples/v2/config/actions.yaml`, blueprint `platform-service`)

Shared settings are YAML anchors at the top of the file (`x-schema-path`, `x-portal-repo`, `x-apply`, `x-ready`,
`x-degraded`, `x-outcome`; the loader resolves `<<:` merge keys). **The schema path is one line**:
`x-schema-path: &schema-path schema/service-xrd.yaml` (form fields and pre-check validation).

| Action | Trigger | Steps |
|---|---|---|
| `create-platform-service` — Create a service | form, `create`; inputs from the schema (`fromXrd`); name 2–30, team 2–20 characters | `precheck` (service-precheck: schema + OPA + plan; Rejected on denial) → `requested` (Requested + intent, `lastRunId`) → `approval` (`if "prod" in environments`, team platform / admins) → `commit` (service-spec `create`) → `committed` (Committed, `specPath`, `specUrl`, `lastCommit`) → `reconciling` (Reconciling) → **`apply`** → `ready` \| `degraded` → `outcome` |
| `update-platform-service` | day-2 (owner team, admins); environments, cost centre, on-call, quality gate (empty = unchanged) | `precheck` (`update`) → `commit` (`update`) → `committed` → `reconciling` → `apply` → `ready` \| `degraded` → `outcome` |
| `upgrade-platform-service` | day-2; target version from the schema enum (`fromXrd`, `others: false`) | `precheck` (`upgrade`) → `commit` (`upgrade`) → `committed` (`goldenPathRequested`) → `reconciling` → `apply` → `ready` \| `degraded` → `outcome` |
| `pause-platform-service` | day-2; `duration` or `until`, `reason` | `commit` (`pause`) → catalog `paused`, `pausedReason` → `apply` (plan only while paused; reported as paused by the pipeline) → `lastApplyUrl` |
| `resume-platform-service` | day-2 | `commit` (`resume`) → catalog clears `paused`, Reconciling → `apply` → `ready` \| `degraded` → `outcome` |
| `decommission-platform-service` | `delete`; **approval required** (platform / admins); `reason`, `deleteData` (default false: archive project and repository) | `mark` (`mark-decommission`) → `deleting` (Deleting) → `apply` (operation `decommission`, `deleteData`) → `remove` (`decommission`: the spec is deleted, only if the pipeline succeeded) → `drop` (catalog delete) \| `degraded` → `outcome`. Replaces the former fixed 2-minute wait (ap-nae.5): the pipeline is the signal. |
| `rerun-pipeline` | day-2; `branch` (default main) | `azure-pipeline`: project `<team>-<service>`, pipeline **name** `<service>-ci` (no queue-time variables: ADO refuses those a pipeline does not declare settable) |
| `grant-temporary-access` | day-2, owner-team approval; `user` (email), `group` (Readers / Contributors / Build Administrators), `duration`, `justification` | `azure-pipeline`: Platform / `portal-operations`, template parameters `operation=grant-temporary-access`, `service`, `runId`, `user`, `group`, `duration` |
| `rotate-secret` | day-2; `secret` (key), `length` | `kubernetes-job` in `asterius-jobs`, ServiceAccount `rotate-secret`, image `quay.io/openbao/openbao:2.7.2` (uid 65534): logs in with OpenBao Kubernetes auth role `asterius-jobs`, writes a generated value to `secret/teams/<team>/<service>` key `<secret>` (`kv patch`, or `kv put` for a new path); the value is never logged |

**Apply step** (`x-apply`): `azure-pipeline` invoker, organization `https://dev.azure.com/AsteriusIT`, project `Platform`,
`pipeline: portal-services-apply` (name, resolved to its id), branch `main`, token `${env:ADO_PAT}`, template parameters
`service: <team>/<service>`, `runId: {{ run.id }}`, `operation: apply | decommission` (+ `deleteData: "true" | "false"`),
`outputs: { artifact: outputs, file: outputs.json }`; `continueOnError: true`, `timeoutMinutes: 60`. Then:

- `ready` (`if: steps.apply.status = "SUCCESS"`): lifecycle Ready, **`managedBy: opentofu`** (written by the portal on
  every successful apply; the ADO feed's `legacy` is set-once and never overwrites it), `goldenPathVersion` (from the
  committed spec), `lastApplyUrl` (the pipeline run), `lastApplyResult`, and from `outputs.json` when published:
  `adoProjectUrl`, `repoUrl`, `pipelineId`, `pipelineUrl`.
- `degraded` (`if: steps.apply.status != "SUCCESS"`, `needs: [apply]`): lifecycle Degraded, `lastApplyUrl`,
  `lastApplyResult` (`failed`, `canceled`…).
- `outcome` (transform, same condition): `$error(…)` so that the **run fails** after the catalog recorded Degraded with
  the pipeline link.

Team and service come from the form on create (`inputs.team`, `inputs.name`) and from the entity identifier
`<team>/<service>` on day-2 actions (`$substringBefore(entity.identifier, "/")`). No action uses Argo Workflows any more
(the `argo-workflows` invoker stays in the product as a generic invoker).

## Invokers

### `service-spec` — commit to the Portal repo

| Field | |
|---|---|
| `repository` | Portal repo web URL `https://dev.azure.com/<org>/<project>/_git/<repo>` |
| `branch` | default `main` |
| `token` | `${env:ADO_PAT}` / `${secret:ADO_PAT}`: PAT with Code (Read & write), or `Bearer <Entra token>` |
| `operation` | `create`, `update`, `pause`, `resume`, `upgrade`, `mark-decommission`, `decommission` |
| `team`, `service` | DNS labels; the spec is `services/team-<team>/<service>.yaml` |
| `inputs` | create / update: the form values (`'{{ inputs }}'`) |
| `fields` | input name → spec path; default (contract): `goldenPath`→`goldenPath.name`, `goldenPathVersion`→`goldenPath.version`, `repositoryTemplate`→`repository.template`, `sonarqube`→`quality.sonarqube`, `qualityGate`→`quality.qualityGate`, `vaultSecrets`→`secrets.vault`, `environments`, `costCenter`, `onCall`. Inputs named `spec__a__b` land in `spec.a.b` (fields generated from the XRD). |
| `pause` | `{ until, reason }`: `until` is RFC 3339 or a duration (`30m`, `4h`, `2d`), in the future, at most 30 days |
| `goldenPath` | upgrade: `{ version, name? }` |
| `requestedBy` | default: the requester's email |
| `argocd` | optional `{ url, token, applications: [...] }`: `GET /api/v1/applications/<app>?refresh=normal` after a commit (best effort; Argo CD polls every 30 s anyway) |

Output: `{ operation, commitId, commitUrl, specPath, specUrl, noop, attempts, runId, runIdLabel, teamFileCreated,
pausedUntil, pausedReason, goldenPath, removed }`; link = the commit.

What it writes:

- **create** renders the spec of the contract (`apiVersion platform.asterius.io/v1alpha1`, `kind Service`, namespace
  `team-<team>`, annotations `run-id` + `requested-by`, labels `team`, `service`, `run-id`, `protected: "true"` when `prod`
  is in `environments`; `spec.owner = team`; `spec.crossplane.compositionRef.name = <goldenPath.name>-v<goldenPath.version>`
  (always derived, never taken from inputs) and `compositionUpdatePolicy: Manual`). With the first service of a team it
  also adds `services/team-<team>/team.yaml` from `services/_templates/team.yaml` (`<team>` replaced; a built-in
  Namespace + ResourceQuota when the template is missing), in the same commit. A file that already exists fails the
  run unless it carries the same run id (a retried step is a no-op).
- **day-2 edits** are made on the YAML document read at the branch head (comments and layout outside the edited keys
  are kept) and stamp the run id annotation + label. `update` merges the inputs into `spec` and recomputes `protected`;
  `pause` sets `portal.asterius.io/paused` (expiry) and `paused-reason`; `resume` removes both; `upgrade` sets
  `goldenPath.version` (and name) with the matching `compositionRef`; `mark-decommission` sets
  `portal.asterius.io/decommission-run-id`; `decommission` deletes the file and refuses when the annotation is absent
  (an already removed file is a no-op).
- **Commit**: one commit per operation on the branch, message `<Verb> <team>/<service>` and trailers
  `Run-Id: <run id>` / `On-Behalf-Of: <email>`.

### Serialized commit queue (`apps/server/src/v2/ado-git.ts`)

Azure DevOps Git REST only (no git binary): `GET …/refs?filter=heads/<branch>`, `GET …/items?path=…&versionDescriptor…`
(content at the head commit), `POST …/pushes` with `refUpdates[0].oldObjectId = <head read>`.

1. In-process: one promise chain per `<org>/<project>/<repo>#<branch>`, writers queue in arrival order.
2. Across replicas: a lease row in the shared database (`ai_leases`, name `v2-commit:<org>/<project>/<repo>#<branch>`),
   claimed with a conditional `UPDATE … WHERE locked_until < now`, holder token in `last_run_at`, released only by its
   holder, expires after 2 min (crashed replica). Waiting is bounded (90 s), then the step fails and is retried.
3. Push: the change is *planned* against the head it read. A stale push (409 / `TF401028`) means someone else moved the
   branch (a human, another tool): the queue re-reads the head, re-plans (so a concurrent manual edit is kept and the
   operation applied on top — the "rebase") and pushes again, with exponential backoff and jitter, at most 6 attempts.
   Pushes are never blindly resent (`retry: false`).

The lease only avoids contention; correctness comes from `oldObjectId`.

### `azure-pipeline` — queue and follow an ADO pipeline (by id or by name)

`pipelineId` (number) **or** `pipeline` (name, or `\\folder\\name`; a non-numeric `pipelineId` is read as a name). A name is
resolved with `GET {org}/{project}/_apis/build/definitions?name=<name>` (pipeline id = build definition id), cached
10 minutes per organization / project / name; a bare name must be unique in the project. The id is kept in the step
state (polls never look it up again); a `404` when queuing a cached id (pipeline deleted and recreated) triggers one fresh
lookup. Queuing is sent once (`retry: false`, step retries decide). Output `{ runId, result, url, organization, project,
pipelineId, outputs? }`, link = the run's web page (`…/_build/results?buildId=<id>`), also on failure. `outputs:
{ artifact, file }` reads a JSON file of a build artifact once the run succeeded (`GET …/builds/<id>/artifacts?artifactName=`,
then the artifact's download URL with `$format=file&subPath=/<file>`), best effort (a warning when absent).

### `service-precheck` — schema, policies and plan before the commit

Same fields as `service-spec` plus `opaUrl` (`${env:OPA_URL}`), `renderUrl` (`${env:RENDER_URL}`, the plan service),
`requireRender` (default false), `rejectEntity: { blueprint, identifier, team }` and `schema` (`{ path }` in the Portal
repo — same repository, branch and token — or `{ source: url, url }` / `{ source: file, file }`; `kind`, `version`,
`ttlSeconds`).

It computes the spec the run will commit (create: rendered from inputs; day-2: read from the branch head and edited);
team and service names are checked first (team 2–20, service 2–30 characters, DNS labels starting with a letter — the
`spec.owner` limit of the schema and the deterministic ADO names `<team>-<service>`, `<service>-ci`; issue ap-nae.6), then
in parallel:

- the **schema**: `spec` validated with Ajv against `openAPIV3Schema.properties.spec` of the Service schema (an XRD, a
  CRD, or a plain file with `openAPIV3Schema` / `properties.spec`; cached like the form's XRD; `x-kubernetes-*` ignored,
  defaults not applied). Each error is a violation `{policy: service-schema, msg: "spec.costCenter: must NOT have more
  than 16 characters"}` that **denies** the request; an unreadable schema is only a warning (OPA still decides);
- OPA `POST <opaUrl>/v1/data/platform/portal/result` with `{"input": {"service": <manifest>}}` → `{allowed, violations}`;
- the plan service `POST <renderUrl>/render` with `{"service": <manifest>}` → `{resources, raw}` (informative unless
  `requireRender`; skipped for decommission).

Outcome: allowed → SUCCESS (output `{allowed, policy, render, schema, service, specPath}`); denied → FAILURE with one log line
per violation, and on a **create** the entity is set `lifecycle: Rejected`, `lastRunId` (never an entity that exists
with another lifecycle: a second create of a live service fails without touching it); **OPA unreachable, an error status
or an undefined result (policies not loaded) → FAILURE: fail closed** (the entity is left as is, the run can be resumed).
Spec problems (create over an existing service, decommission without the mark, invalid names) are reported as the
`portal-spec` violation.

## Preview in the self-service form

`POST /api/v1/actions/:id/preview { inputs, entity? }` (signed-in users allowed to run the action; 30/min). For an action
with a `service-precheck` step, the step's configuration is rendered with the submitted inputs exactly as the run will
(secrets resolved server side, never returned), and the pre-check runs without writing anything:

```json
{ "supported": true, "step": "precheck", "canSubmit": true, "inputErrors": [],
  "operation": "create", "specPath": "services/team-payments/payments-api.yaml", "specYaml": "apiVersion: …",
  "service": { … }, "allowed": true,
  "policy": { "status": "allowed|denied|unavailable", "allowed": true, "violations": [{ "policy": "…", "msg": "…" }], "error": "…" },
  "schema": { "status": "valid|invalid|unavailable|skipped", "violations": [], "version": "v1alpha1", "source": "…" },
  "render": { "status": "ok|error|unavailable|skipped", "resources": [{ "kind", "name", "externalName", "action", "apiVersion?" }], "error": "…" } }
```

Other actions answer `{ "supported": false }`. In the preview the run id is the placeholder `preview`.

UI (`ActionRunModal` + `ServicePreview`): when the workflow has a `service-precheck` step, the submit button reads
**Preview**. It validates the form, calls the endpoint and shows, under the form: the policy verdict (green "Policies
passed", red "Denied by policy" with each violation — schema violations included —, or yellow "Policy check unavailable"
— the run checks again and stops if it still cannot), the **planned changes** (plan service: an Action column — create,
import = "already exists, will be adopted", update, replace, delete, no change —, type, address, name in Azure DevOps,
and a summary "2 to create, 1 already exists (adopted)"; Crossplane render: kind, name, external name, API version) and
the spec YAML with its path. The button becomes **Confirm** (disabled when a policy denies it or inputs are invalid); **Edit**
or any change in the form drops the preview.

## Form generated from the XRD (`inputs.fromXrd`)

A form trigger may declare where its fields come from (validated by `xrdFormSource` in `schemas.ts`):

```yaml
inputs:
  fromXrd:
    source: ado                  # ado (Portal repo, Git REST) | url (e.g. the render service's GET /xrd) | file
    repository: https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources
    branch: main
    path: schema/service-xrd.yaml   # lean Portal repo (crossplane layout: platform/xrds/service.yaml)
    token: ${env:ADO_PAT}        # a reference only
    # kind: Service, version: <XRD version> (default: referenceable, else first served)
    # fields: { inputName: spec.path } (default: the contract mapping above)
    # others: true               # also XRD fields not in `fields`, as spec__<path> inputs
    # exclude: [adopt]           # owner and crossplane are always excluded (derived by the portal)
    # ttlSeconds: 300
  properties: { … }              # fallback while the XRD cannot be read + fields the XRD does not hold (name, team)
  required: [ … ]
```

`getAction` / `listActions` resolve it (so the form, the API, run validation and the preview all follow the XRD): the
`openAPIV3Schema.properties.spec` of the XRD (or of a CRD, or of a plain schema file with `openAPIV3Schema` / `properties.spec`) is walked; every scalar leaf (and arrays of scalars) becomes an input
with `type`, `title` (`x-portal-title`, `title`, or the humanized key), `description`, `enum`, `default`, `pattern`,
`minimum`/`maximum`, `minLength`/`maxLength`, `items`, `minItems`/`maxItems`, `format` (`date-time`, `date`, `email`,
`uri`→`url`, or `x-portal-format`), `x-portal-hidden` to skip a field; `required` follows the nesting. The XRD wins on
those keys, the declared property keeps its title and UI hints (`format: team`…). The resolved schema carries
`xrd: { status: loaded|unavailable, source, version, loadedAt, error }`. Cache per source: refreshed every `ttlSeconds`
in the background (stale served meanwhile), errors retried after 30 s, first load waited at most 3 s.

Admin endpoints: `GET /api/v1/v2/xrd-form?action=<id>[&refresh=true]` (resolved form and source status),
`POST /api/v1/v2/xrd-form { fromXrd, properties?, refresh? }` (try a source).

## Run id

The portal run id (a UUID) is in: the run record; the spec annotation `portal.asterius.io/run-id` and label
`portal.asterius.io/run-id` (rewritten by every operation); the commit trailer `Run-Id`; the entity property
`lastRunId`; the pipeline template parameter `runId` (and the build tag `run:<id>` set by the Portal repo pipelines); the Kubernetes Job label `asterius.io/run-id` and env `PORTAL_RUN_ID`.

Label values are at most 63 characters of `[A-Za-z0-9-_.]` starting and ending with an alphanumeric. A UUID qualifies
and is used as is (label = annotation). Any other id is turned into `<sanitized prefix ≤ 52 chars>-<first 10 hex of
sha256(id)>` (`labelSafeRunId` in `apps/server/src/v2/labels.ts`): deterministic, so every hop computes the same value;
the annotation keeps the full id. The service output exposes it as `runIdLabel`.

## Plan service (`apps/render-service`, `deploy/kind/manifests/render.yaml`)

Standalone Node service (not an npm workspace; one dependency, `yaml`), Service `render` (unchanged name and contract).
Image `asterius-render:dev` (`docker build -t asterius-render:dev apps/render-service`): Node 24, git, **OpenTofu 1.10.8**
(build arg `TOFU_VERSION`, the Portal repo's pin in `hack/install-tools.sh`) and the Crossplane CLI v2.1.0 (build arg
`CROSSPLANE_VERSION`), both checksum verified. Two modes, `RENDER_MODE`:

**`tofu` (default, lean path).** `POST /render {service}` → `{mode: "tofu", commit, root, resources: [{kind, name,
externalName, action}], raw, tofuVersion}`:

1. The Portal repo is a cached shallow clone (`REPO_URL` `#REPO_BRANCH`, HTTPS; `ADO_PAT` sent as a per-command
   `http.extraHeader`, never stored in `.git/config`) in `REPO_CACHE_DIR`, refreshed (`fetch --depth 1` + `reset --hard`)
   at most every `REPO_REFRESH_SECONDS` (60); concurrent requests share one refresh; a failed refresh keeps the last
   good checkout (503 only before the first clone). `REPO_DIR` uses a checkout as is (tests, local runs).
2. Per request, in a private temp dir: a copy of the checkout (without `.git`), the spec written to
   `services/team-<team>/<service>.yaml` (team and service validated as DNS labels), and
   `<TOFU_ROOT>/zz_plan_service_override.tf` overriding the backend with `backend "local"` on a throwaway state file
   (`-backend=false` alone is refused by `plan`); then `tofu init -input=false -reconfigure`, `tofu plan -input=false
   -lock=false -out=plan.bin -var <TOFU_SPEC_VAR>=<spec file> [-var TOFU_EXTRA_VARS…]`, `tofu show -json plan.bin`. The
   temp dir is removed afterwards. **Never runs apply**; the shared azurerm state is never touched.
3. `resource_changes` (managed only; data sources left out) → `kind` = resource type, `name` = address, `externalName` =
   the `name` attribute when known (after, else before), `action` = `import` when `change.importing` (exists already,
   will be adopted), else `create` / `delete` / `update` (a delete+create replacement is `update` with `replace: true`) /
   `no-op`.

The azuredevops provider authenticates with `AZDO_PERSONAL_ACCESS_TOKEN` = `ADO_PAT` and `AZDO_ORG_SERVICE_URL` =
`ADO_ORG_URL`; provider plugins are cached in `TF_PLUGIN_CACHE_DIR` (an emptyDir). At most `RENDER_MAX_CONCURRENCY` (2)
plans at a time, each bounded by `PLAN_TIMEOUT_SECONDS` (120, → 504). The PAT is masked in every error. 400 bad body,
422 init/plan error (CLI output), 503 no checkout / no root module. `GET /xrd` serves `SCHEMA_PATH`
(`schema/service-xrd.yaml`) of the checkout (a `fromXrd` `url` source); `GET /readyz` = `tofu version` answers (plus the
checkout status); `GET /healthz`.

**`crossplane` (optional profile, `deploy/kind/manifests/crossplane/render-crossplane.yaml`).** Unchanged Crossplane render:

| Endpoint | |
|---|---|
| `POST /render {service}` | selects the Composition `spec.crossplane.compositionRef.name` in the bundle, the Functions of its pipeline, and the XRD of the XR's group/kind (`--xrd`, so schema defaults apply); runs `crossplane render xr.yaml composition.yaml functions.yaml --include-function-results --timeout=60s` in a private temp dir; answers `{mode: "crossplane", composition, functions, resources: [{apiVersion, kind, name, externalName, resourceName, action: "create"}], raw, results}`. 400 bad body, 422 unknown Composition / missing Function / render error (CLI stderr), 503 empty bundle. Two renders at a time. |
| `GET /xrd[?kind=Service]` | the bundle's XRD(s) as YAML (a `fromXrd` `url` source) |
| `GET /compositions` | files, Compositions, Functions, XRDs of the bundle |
| `GET /healthz`, `GET /readyz` | readiness = every function sidecar port accepts connections |

The bundle is ConfigMap `portal-compositions` mounted at `/compositions` (`optional: true`; re-read on every render, so a
ConfigMap update needs no restart). Functions run as **sidecars** with `--insecure --address=:<port>`; each selected
Function gets `render.crossplane.io/runtime: Development` and `render.crossplane.io/runtime-development-target`, taken from
`FUNCTION_TARGETS` (`key=host:port,…`, key = Function name or package name), else an annotation already on the Function,
else `localhost:<FUNCTION_BASE_PORT + index>` (sorted names). The manifest runs `function-auto-ready:v0.7.3` (:9443),
`function-go-templating:v0.13.2` (:9444), `function-patch-and-transform:v0.11.2` (:9445).

Env: `RENDER_MODE`, `PORT`; tofu: `REPO_URL`, `REPO_BRANCH`, `REPO_DIR`, `REPO_CACHE_DIR`, `REPO_REFRESH_SECONDS`,
`TOFU_BIN`, `TOFU_ROOT` (`tofu/service`), `TOFU_SPEC_VAR` (`spec_path`), `TOFU_EXTRA_VARS`, `TF_PLUGIN_CACHE_DIR`,
`PLAN_TIMEOUT_SECONDS`, `SCHEMA_PATH`, `ADO_PAT`, `ADO_ORG_URL`, `GIT_BIN`; crossplane: `COMPOSITIONS_DIR`,
`CROSSPLANE_BIN`, `RENDER_TIMEOUT`, `FUNCTION_TARGETS`, `FUNCTION_BASE_PORT`; both: `RENDER_MAX_CONCURRENCY`. Tests:
`npm test` in `apps/render-service` (fake `tofu` and `crossplane` CLIs, a local git origin for the clone cache); the
tofu flow (backend override, `-var`, `show -json`) was also checked against the real OpenTofu 1.10.8 in the image.

## OPA (`deploy/kind/manifests/opa.yaml`)

`openpolicyagent/opa:1.22.2-static` `run --server --addr=:8181 --watch --ignore=.* /policies`, ConfigMap `portal-rego`
mounted with `optional: true` (starts before Argo CD syncs it; until then `platform.portal.result` is undefined and the
portal fails closed). `--watch` reloads when kubelet swaps the files, `--ignore=.*` skips the `..data` links of the mount.
Health on the diagnostic port `:8282/health`.

## Environment (portal)

| Variable | Used by |
|---|---|
| `ADO_PAT` | `service-spec`, `service-precheck` (day-2 reads, schema), `fromXrd`, `azure-pipeline` (apply, operations, `<service>-ci`), the ADO and drift feeds (`${env:ADO_PAT}`) |
| `OPA_URL` | `service-precheck` (`http://opa.asterius-platform.svc:8181`) |
| `RENDER_URL` | `service-precheck` (the plan service, `http://render.asterius-platform.svc:8080`) |
| `KUBE_JOB_NAMESPACES` (Helm `rbac.jobNamespaces: [asterius-jobs]`) | `rotate-secret` (`kubernetes-job` invoker) |
| `OUTBOUND_ALLOW` | must allow the in-cluster hosts (the kind values allow `*.svc`, the cluster CIDRs) — the SSRF guard blocks private addresses otherwise |

`${env:…}` references are only resolved in the default organization (platform rule).

## Code map

- `apps/server/src/v2/`: `labels.ts` (contract names and name limits, label-safe run id), `spec.ts` (render / edit the
  spec, commit message, team file, `checkNames`), `ado-git.ts` (Git REST + commit queue), `service-ops.ts` (operations:
  next state, commit), `checks.ts` (OPA, plan/render and schema adapters), `xrd.ts` (schema → form, cache; XRD, CRD or
  plain schema files), `preview.ts`, `routes.ts`.
- `apps/server/src/actions/invokers/service-spec.ts`: the two invokers (registered in `invokers/index.ts`);
  `azure-pipelines.ts`: pipeline by name (cached lookup), `outputs` artifact, pipeline id in the output.
- Small additive edits: `schemas.ts` (`xrdFormSource`, form `inputs.fromXrd`), `actions/actions.ts` (resolve `fromXrd`
  on load), `app.ts` (routes), `invokers/orchestrators.ts` (`labels` on `argo-workflows`),
  `integrations/sources/azure-devops.ts` (kind `build`, see the read side).
- Plan service: `apps/render-service/src/tofu.mjs` (checkout cache, plan, plan JSON mapping), `server.mjs` (modes),
  `render.mjs` (Crossplane render helpers).
- Web: `components/ServicePreview.tsx` (planned actions), `components/ActionRunModal.tsx` (preview stage), `lib/api.ts`.
- Tests: `apps/server/test/v2-*.test.ts` (`v2-precheck` runs the shipped workflows against fake ADO Git + Pipelines,
  `v2-lean` the building blocks), `apps/web/test/service-preview.test.tsx`, `apps/render-service/test/`.

## Assumptions and open points

- `portal-services-apply` also triggers on `main` for changed `services/**`: the portal's commit therefore starts a CI
  run in addition to the one the portal queues. The Portal repo pipeline must serialize per service (state lock wait) or
  skip commits carrying a `Run-Id` trailer that the portal applies itself; the portal only follows the run it queued.
- `outputs.json` is read from the build artifact `outputs` (`$format=file&subPath=/outputs.json` on the artifact's
  download URL); when the pipeline publishes it differently, the Ready step simply leaves the ADO feed's values.
- The decommission keeps the spec (and the entity, Degraded) when the pipeline fails; a re-run of the action resumes.
  After an archive (`deleteData=false`) the project still exists in ADO, so the ADO feed lists it again as a `legacy`
  service.
- `rotate-secret` needs the OpenBao role `asterius-jobs` (see `deploy/kind/manifests/jobs-rbac.yaml`) and an image with
  `sh` and `bao` (`quay.io/openbao/openbao:2.7.2`, run as uid 65534).
- Day-2 pre-checks never set `Rejected` (a running service is not rejected by a refused change); the run fails.
