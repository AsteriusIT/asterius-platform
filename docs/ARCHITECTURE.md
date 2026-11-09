# Architecture

## Components

| Path | Role |
|---|---|
| `apps/server/src/app.ts` | Fastify app: security headers (CSP, HSTS), rate limiting, raw-body JSON parser (webhook signatures), routes, static UI. |
| `apps/server/src/index.ts` | Process entry: role (`all` / `api` / `worker`), config loader, workers, graceful shutdown. |
| `apps/server/src/db.ts` | PostgreSQL (production) or SQLite (development) behind one driver; baseline schema (`schema.ts`) plus numbered migrations under an advisory lock. |
| `apps/server/src/schemas.ts` | zod schemas of every configurable resource, shared by the API and the configuration files. |
| `apps/server/src/config-loader.ts` | Configuration as code: reads `CONFIG_DIR`, applies it every minute when it changes, prunes removed resources, exports the current state as YAML. |
| `apps/server/src/catalog/` | Blueprints, entities (Ajv validation, relations index, search), JSON Schema helpers. |
| `apps/server/src/actions/` | Action definitions, run lifecycle and approvals (`runs.ts`), worker (`worker.ts`), invokers (`invokers/`). |
| `apps/server/src/integrations/` | Sources (`sources/`), JSONata mapping, sync engine and inbound webhooks (`sync.ts`). |
| `apps/server/src/webhooks/` | Outbound webhooks and delivery worker (outbox). |
| `apps/server/src/events.ts` | Domain events → outbox rows per matching webhook. |
| `apps/server/src/auth/` | Local accounts, Entra ID OIDC (PKCE), sessions, API tokens, service accounts, teams, authorization helpers. |
| `apps/server/src/secrets.ts` | AES-256-GCM secret store, `${secret:…}` / `${env:…}` references, run callback tokens. |
| `apps/server/src/lib/expr.ts` | JSONata expressions and `{{ }}` templates (single tokenizer: user input is never re-interpreted). |
| `apps/web/src/components/` | Shared UI kit on Mantine: `DataTable`, `SchemaForm`, `PropertyValue`, `ResourceEditor`, `ActionRunModal`, `ui.tsx`. |

## Data model

```
teams ─< team_members >─ users ─< api_tokens / sessions
blueprints ─< entities ─< entity_relations (blueprint, identifier, relation → target_blueprint, target_identifier)
actions ─< runs ─< run_logs, run_approvals          (runs keep a snapshot of the invoker and approval policy)
integrations ─< sync_runs                           entities.source = integration:<id> | ui | api | action | config
webhooks ─< deliveries (outbox)
secrets (encrypted) · audit_log
```

Entity properties and relations are JSON documents validated against the blueprint. The `entity_relations` table indexes relations for reverse lookups ("referenced by"). Relation targets may be missing, because ingestion order is not guaranteed; the UI shows them as such.

## Organizations (multi-tenancy)

One deployment serves many organizations; data is separated by an `org_id` on every resource (part of the primary key
of named resources, so identifiers are per organization). Users are global identities with `memberships` (role per
organization) and an optional platform `superadmin` flag.

- **Request scope.** `orgs/context.ts` keeps the organization in an `AsyncLocalStorage` context: authentication enters it
  (API tokens are bound to the organization they were created in; browser sessions send `X-Asterius-Org`, else the last
  one used), every org-scoped query reads it with `orgId()`, which throws outside a context: a query cannot silently
  run across tenants. Background work enters the organization of what it processes (`inRunOrg` for run workers and
  housekeeping, the sync and schedule schedulers, the inbound-event and delivery workers, the config loader) or loops
  over organizations (`forEachOrg`: scorecard passes, AI catalog reviews). Caches are keyed by organization.
- **Data.** Named resources have `org_id` in their primary key (teams, blueprints, entities, actions, integrations,
  webhooks, secrets, scorecards, dashboards, action versions, tombstones, AI budgets…); records keyed by an id carry an
  `org_id` column (runs, tokens, audit, entity history, AI usage and reviews, inbox notifications); notification
  settings and the config-as-code status are one row per organization. Model prices, rate limits and login counters
  are platform-wide. The whole schema is created by the baseline migration (`apps/server/src/schema.ts`).
- **Tenant boundaries.** `${env:NAME}` references (pod environment), the SQL source's `sqlite` driver (local files)
  and, unless listed otherwise, the platform's Kubernetes credentials (`KUBERNETES_ORGS`) and its own cloud identity
  (`PLATFORM_IDENTITY_ORGS`: external secret managers, auth blocks without credentials) are reserved to the default
  organization; secrets resolve in their own organization only; inbound webhooks and workflow webhook triggers are
  addressed per organization (`/api/v1/ingest/<org>/<integration>`, `/api/v1/hooks/<org>/<action>`); SCIM tokens
  provision their own organization; email domains need DNS verification before they route SSO sign-ins or grant
  membership. Super-admins see platform-level audit entries, verify the audit hash chain and edit model prices.
- **Identity.** Keycloak (optional) is the identity broker: OIDC code flow + PKCE, `organization` claim → memberships
  (`via = 'sso'`), single sign-out with `id_token_hint`. The admin REST API (client service account) creates Keycloak
  Organizations, invitations and identity providers.
- **Configuration as code.** `config-loader.ts` applies each organization's sources (platform `CONFIG_DIR`,
  `CONFIG_DIR/orgs/<slug>`, or a Git repository pulled by `orgs/git-source.ts`) inside that organization's context.
- **MCP.** `ai/mcp-server.ts` (`POST /api/mcp`, also `/api/v1/mcp`): stateless JSON-RPC MCP server; tools run with the
  token owner's permissions in the token's organization.

## Workflows

A workflow (action) is a trigger — a form submission: `trigger: { type: form, on, blueprint, inputs, allowed, approval }` — followed by steps. Without a trigger or steps it is a draft that cannot run. The steps form a graph (`apps/server/src/actions/workflow.ts`): `needs` omitted → after the previous step; `needs: []` → at the start; `needs: [a, b]` → after both. A step may only depend on earlier steps, so a workflow cannot contain a cycle. A single-`invoker` action is a one-step workflow.

```
PENDING ──deps terminal──▶ if false ─────────────▶ SKIPPED
   │                       a dependency failed ──▶ SKIPPED (blocked: its dependents are skipped too)
   ├─ approval ─────────▶ WAITING_APPROVAL ─ approvals ≥ min ─▶ SUCCESS · reject ─▶ FAILURE · expiry ─▶ FAILURE
   └─ others ───────────▶ QUEUED ─worker claims─▶ RUNNING ─▶ SUCCESS | FAILURE
                            ▲                       │ invoke: poll (RUN_POLL_SECONDS) or callback PATCH /runs/:id/steps/:step
                            └── retry with backoff ─┘ (retries × retryDelaySeconds·2^n; agent & transform errors, retryable invoker errors)
run: all steps terminal → SUCCESS, or FAILURE if a step failed without continueOnError; result = outputs by step id
```

Every transition is a conditional `UPDATE … WHERE status IN (…)`: the engine (`actions/engine.ts`) can be called concurrently by workers, callbacks and API pods. Workers claim runs, steps and polls with a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *` (SQLite: the same statement without the lock hint), so replicas never race for the same rows; everything in flight counts against `WORKER_CONCURRENCY`, and an idle worker backs off up to `WORKER_IDLE_MAX_MS`, woken at once by new work (in-process, or Postgres `LISTEN/NOTIFY` across replicas).

Each claimed step has a **lease** (`locked_until`, by type) that its executor renews with a heartbeat while it runs; the heartbeat also notices a cancelled run or a lost lease and stops the step (agent loops stop between turns and abort the API call). A claim increments `attempt`, which is a fencing token: a worker that lost its lease can no longer write the step's result. Deadlines: a step times out after its `timeoutMinutes` (approvals 7 days, others `STEP_TIMEOUT_MINUTES`); a **run** is failed after `RUN_TIMEOUT_HOURS` from its start, extended by the timeouts of its approval steps (`runs.deadline_at`). **Housekeeping** (every 30 s, one replica at a time under an advisory lock) only visits work that is due: stale leases (the worker died mid-start; invokers are not retried because the external call may have happened), passed step and run deadlines, interrupted cancellations, and runs nothing drives anymore. Healthy in-flight runs, including ones waiting days for an approval, are never touched. Runs keep a snapshot of the workflow: editing an action never changes runs in flight.

Cancelling is two-phase: the run gets `cancel_requested` (workers stop starting and continuing steps), its steps are cancelled and external jobs asked to stop (also a job that was still starting), and then the run turns `CANCELLED`. Approvals insert, count and transition under a row lock in one transaction, so concurrent approvers cannot leave a run below `minApprovals`. `POST /actions/:id/runs` accepts an `Idempotency-Key` header (same key and request returns the original run); the webhook invoker sends `Idempotency-Key: <run>/<step>`, stable across retries. **SLAs** (`slaMinutes` on steps and actions) store a due time (`sla_due_at`) when the clock starts; housekeeping reads only due rows (partial index) and claims each with a conditional UPDATE that clears it, so a breach is reported once across replicas and healthy runs are never scanned. **Artifacts** live in `run_artifacts` (content in a BLOB / BYTEA column, cascade-deleted with the run); the per-run cap is checked under a row lock on the run. **Workflow tests** reuse the dry-run simulator (`actions/workflow-tests.ts`) with graph semantics and mocks. Run logs are capped (`RUN_LOG_MAX_LINES`); `GET /runs/:id` returns the newest lines (`?after=<seq>` for incremental polling) and `GET /runs/:id/logs?after=&limit=` pages through the rest.

**Agent steps** (`actions/agent.ts`) call Claude through the official SDK (`@anthropic-ai/sdk`): default model `claude-opus-5-5` (adaptive thinking, `effort` per step), structured output via `output_config.format` (the step's output fields as a JSON Schema; constraints the API doesn't support are checked locally with Ajv), and optional read-only catalog tools (`list_blueprints`, `search_catalog`, `get_entity`) in a bounded tool loop (`maxTurns`). Refusals use the server-side fallback where supported. Tokens and an estimated cost are logged per step and exported as `asterius_llm_tokens_total`. Rate limits, overload and network errors are retryable; authentication and invalid requests are not.

## Run lifecycle

```
POST /actions/:id/runs
   ├─ the action has a trigger and steps; permission (trigger.allowed: roles / teams / users / ownerTeam); input validation (trigger.inputs, JSON Schema)
   ├─ approval required → PENDING_APPROVAL ── approve × minApprovals → QUEUED
   │                                       └─ reject (with reason)    → REJECTED
   └─ otherwise → QUEUED
worker: UPDATE … SET status='IN_PROGRESS' WHERE id=? AND status='QUEUED'      (claim; any number of workers)
   create the step rows → the engine runs the workflow (above); for each invoke step:
   render invoker config ({{ }} templates against {run, action, inputs, entity, trigger}; ${secret:…} resolved)
   invoker.start → SUCCESS | FAILURE | IN_PROGRESS (+ state, e.g. pipeline run id)
   IN_PROGRESS: poll every RUN_POLL_SECONDS (claimed by moving next_poll_at)  ─┐
                or wait for PATCH /api/v1/runs/:id from the external system  ─┴→ SUCCESS | FAILURE
   CANCELLED by the requester or an admin (best-effort cancel of the external run)
```

Guarantees:
- **One transition per run.** Every transition is a conditional `UPDATE … WHERE status = <expected>`.
- **No duplicate external calls.** A run is claimed before its invoker starts. If the worker dies between the claim and the invoker's answer, the run is failed rather than retried, because the external call may already have happened. The user can simply run it again.
- **Runs always end.** A run deadline (`RUN_TIMEOUT_HOURS` plus its approval timeouts) fails runs that never report a final status; step deadlines (`STEP_TIMEOUT_MINUTES`, `timeoutMinutes`) bound each step.
- **Secrets stay out of logs.** Secret values and the callback token are redacted from run logs. Non-admins only see an action's invoker type, never its configuration.

## Ingestion

- **Pull:** `integrations.next_sync_at` drives the scheduler, and a lease (`locked_until`) gives each sync to exactly one worker. Each kind is listed once and shared by the mappings of that kind. Pages are streamed, so memory use stays flat. Unchanged entities are not rewritten and emit no event.
- **`deleteMissing`:** after a fully successful listing, entities owned by the integration that were not seen are deleted. If the listing is empty, nothing is deleted (an expired token often returns nothing). Entities that fail validation count as seen and are never deleted.
- **Push:** `POST /api/v1/ingest/:integration` is authenticated by a shared token or an HMAC signature over the raw body. Mappings may filter on `$headers` and delete via a `delete` expression.
- **Ownership:** entities written by an integration are read-only for humans, since manual edits would be overwritten at the next sync.

## Scaling and availability

| Concern | Choice |
|---|---|
| Statelessness | No in-memory state shared between requests. The UI polls (2.5 s on active runs, 15–30 s elsewhere), so there are no sticky sessions or pub/sub. |
| Work distribution | Conditional UPDATEs and leases in PostgreSQL for runs, polls, syncs and deliveries. A cluster-wide advisory lock covers the rare singleton tasks (migrations, config apply, housekeeping). `/healthz` fails when a worker loop (runs, syncs, deliveries) stops iterating, so the orchestrator restarts a replica whose scheduler is stuck. |
| Load | At 500 users and tens of thousands of entities, the busiest paths are catalog list pages: indexed by `(blueprint, title)` with a `search` column and paging. A 2-vCPU PostgreSQL is enough. |
| Failure | A pod restart loses no event (outbox) and no run state. Runs are failed explicitly when their state is unknown. |
| Retention | `RETENTION_DAYS` purges finished runs, deliveries, audit entries and old sync history every hour (one replica), in chunks with short pauses. Pending deliveries older than 7 days are marked failed; `RUN_LOG_MAX_LINES` caps stored log lines per run. |
| Caches | Blueprints, teams and webhook subscriptions are LRU caches invalidated across replicas through the `config_version` row (checked at most once per second per process). |
| Rate limiting | `RATE_LIMIT_STORE=database` shares counters between API replicas (one upsert per request); account lockout is always stored in the database. |

### Catalog queries

`GET /entities` and `GET /blueprints/:bp/entities` take `search` (substring plus trigram fuzzy matching on PostgreSQL, ranked by relevance), `filter.<property>[op]=value`
(`eq`, `neq`, `in`, `contains`, `gt`, `gte`, `lt`, `lte`, `between`, `exists`; lists are comma-separated), `relation.<name>=<target>[,<target>]`,
`sort=title|updated|identifier|relevance|prop:<name>` with `dir`, `limit`, `offset` (capped at 10,000) or `cursor`, and `count=false`. `POST /entities/query` accepts the same
structure as a JSON body (`EntityQueryBody` in `@asterius/shared`). Responses carry `nextCursor` (and `Link` / `X-Next-Cursor` headers on list endpoints); cursor pages skip the total.
Entities carry a `version` served as the `ETag`; `PUT`/`PATCH` honour `If-Match` (412 on mismatch) and concurrent creates answer 409. `GET /blueprints/:bp/entities/:id/graph?depth=&direction=out|in|both`
walks relations transitively (dependencies, or what depends on the entity for impact analysis).

## Security

- **Authentication.** Entra ID uses OIDC code + PKCE; the ID token's signature, issuer, audience, nonce and tenant are verified. Local accounts use scrypt hashes, per-IP rate limits and per-account lockout. Sessions and API tokens are stored as SHA-256 hashes only.
- **Identity providers and access.** `AUTH_PROVIDERS` accepts `local,entra,oidc,github`. Generic OIDC (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_GROUPS_CLAIM`, `OIDC_ADMIN_GROUPS`, `OIDC_ALLOWED_DOMAINS`) uses discovery, PKCE and nonce and keys accounts by `issuer|sub`; GitHub OAuth requires `GITHUB_ALLOWED_ORGS` and maps `org` / `org/team` to teams through the team `entraGroupId` field. Blueprints may carry `permissions` (read, write, delete, run subjects); users may hold delegated roles (`integration-admin`, `blueprint-owner`, `approver`) or custom role names. API tokens accept `scopes` (`catalog:read`, `catalog:write`, `runs:read`, `runs:trigger`, `admin`), `blueprints` and `ipAllow`; `API_TOKEN_MAX_DAYS` and `SESSION_IDLE_MINUTES` set the lifetime policy.
- **External secret managers.** Besides `${secret:NAME}` and `${env:NAME}`, configuration may reference `${vault:mount/path#key}`, `${awssm:name[#key]}`, `${azkv:vault/name}`, `${gcpsm:project/name[/version]}` and `${k8s:namespace/secret/key}`, resolved at execution time with workload identity (Vault Kubernetes auth, IRSA, Azure workload identity, GKE metadata server, the pod service account; no static credentials needed), a `SECRET_CACHE_SECONDS` in-memory cache and path validation. Kubernetes Secrets are limited to `K8S_SECRET_NAMESPACES` (default: own namespace). AWS SigV4 is implemented without the SDK and was verified against a fake endpoint only.
- **Audit.** Filter by actor/action (`token.*`)/target/date, facets, CSV and NDJSON export (formula-injection safe), `AUDIT_RETENTION_DAYS` (default 365), optional streaming to a SIEM (`AUDIT_STREAM_URL` HTTPS, `AUDIT_SYSLOG_URL` udp/tcp; at-least-once through a `streamed_at` marker) and an optional hash chain (`AUDIT_HASH_CHAIN`, HMAC-keyed by `AUDIT_CHAIN_KEY`) verified at `GET /api/v1/audit/verify`. Each row carries a `chain_version`: v1 (legacy) hashes `[prev, seq, id, at, action, actor_id, actor_email, target, detail]`; v2 hashes `[2, org_id, prev, seq, id, at, action, actor_id, actor_email, target, detail]` so moving an entry to another organization is detected. Verification picks the formula per row and accepts one v1-to-v2 switch, never a downgrade. Failed audit writes are counted (`asterius_audit_write_failures_total`) and retried.
- **SAML and SCIM.** `AUTH_PROVIDERS=…,saml` (`SAML_ENTRY_POINT`, `SAML_IDP_CERT`, `SAML_*_ATTR`, `SAML_ADMIN_GROUPS`; SP metadata at `/api/auth/saml/metadata`) uses @node-saml with signed assertions required, SP-initiated flow only and single-use request ids in the shared database. `POST /api/v1/scim/token` issues a `scim`-scoped token for `/scim/v2` (Users and Groups; groups are teams); deactivation revokes sessions and API tokens immediately, and a provisioned account is adopted by the first SSO sign-in with the same verified email.
- **Cookie sessions.** `SESSION_COOKIE=true` moves browser sessions to an httpOnly SameSite=Lax cookie (`__Host-` prefixed on https); state-changing cookie requests need a same-origin `Origin` and the session-bound `X-CSRF-Token` (returned by login and `/api/auth/me`). Bearer tokens are unaffected.
- **Entra and the generic OIDC client.** `auth/entra.ts` is intentionally still its own implementation (tenant check, `tid:oid` identities, Entra group claims) so that parallel security-hardening changes to it do not conflict. Entra also works through the generic client (`OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0`, `OIDC_EMAIL_CLAIM=preferred_username` if needed), but identities there are `issuer|sub`, so switching an existing deployment would create new accounts.
- **Authorization.** Roles are admin and member. Entity writes are limited to the owning team (admins: everything). Each workflow's trigger carries its own `allowed` and `approval` subjects; approval steps carry their approvers.
- **Secrets.** Stored with AES-256-GCM (values are `v2:<keyId>:…`; rotate with the `SECRETS_KEYS` ring `id:key,…` where the first key encrypts and all decrypt, then run `node dist/index.js reencrypt-secrets` or `POST /api/v1/secrets/reencrypt`; run callback tokens use the independent `CALLBACK_KEYS` ring, `derived` = the historical key), and referenced by name in configuration. `${env:…}` cannot read platform settings such as `DATABASE_URL` or `SECRETS_KEY`.
- **Run callbacks.** The token is an HMAC of the run id, so it is valid for that run only and verifiable by any replica without storage.
- **Templates.** Admin-written text is tokenized once; user inputs and secret values are never evaluated as expressions or references.
- **Outbound requests.** Outbound webhooks are signed over a timestamp and the body (`X-Asterius-Signature: t=…,v1=…`, replay window 5 min, dual-secret rotation), the webhook invoker signs the body (`sha256=…`); all calls have timeouts and go through the SSRF guard (private, loopback and link-local destinations need `OUTBOUND_ALLOW`). Inbound webhooks are verified the same way.
- **Audit.** The audit log records definition changes, catalog writes, runs, approvals, tokens, secrets and sign-ins.

## Observability

- `/healthz` (liveness), `/readyz` (database), `/metrics` (Prometheus; optional `METRICS_TOKEN`). With `METRICS_PORT` (the chart sets 9090) `/metrics` is served on that separate port only, so the ingress never exposes it.
- Metrics: `asterius_runs_finished_total{action,status}`, `asterius_run_duration_seconds{invoker}`, `asterius_syncs_total{integration,status}`, `asterius_sync_entities_total`, `asterius_webhook_deliveries_total{result}`, `asterius_events_total{type}`, `asterius_sla_breaches_total{kind,action}`. Cluster-wide gauges: `asterius_queue_runs{status}`, `asterius_queue_deliveries_pending`, `asterius_catalog_entities{blueprint}`.
- Further metrics (labels are bounded: route patterns, configured integration ids and upstream hosts, never raw URLs or entity ids):
  - `asterius_http_request_duration_seconds{method,route,status}` histogram of inbound requests (rate is `_count`; `/metrics` and probes excluded).
  - `asterius_sync_duration_seconds{integration}` histogram; `asterius_integration_last_success_timestamp_seconds{integration}` gauge read from `sync_runs` (cluster-wide, alert on `time() - value`).
  - `asterius_webhook_delivery_latency_seconds` histogram from event creation to successful delivery.
  - `asterius_db_pool_connections`, `asterius_db_pool_idle_connections`, `asterius_db_pool_waiting_requests` (per process; waiting > 0 means pool saturation, see `DATABASE_POOL_SIZE`).
  - `asterius_upstream_responses_total{host,class}` and `asterius_upstream_rate_limited_total{host}` (429s from GitHub, GitLab, ADO, webhook targets).
- OpenTelemetry tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`): one `http.server` span per request (named `METHOD route`, continues an inbound `traceparent`), `db.<OP>` spans per query, `action.run`, `integration.sync` and `webhook.deliver` spans, with outgoing HTTP calls as children. Outgoing calls (CI pipelines, outbound webhooks, sources) carry a W3C `traceparent` header so a run can be followed into the CI system. Log lines include `trace_id` and `span_id` while a span is active.
- Logging: pino JSON lines with a `component` field (`config`, `audit`, `events`, `db`, `worker`, ...) and `trace_id`/`span_id` when traced. `LOG_FORMAT=pretty` (needs the `pino-pretty` dev dependency) gives readable output locally. Stored sync logs (`sync_runs.logs`) are masked: resolved secret values and common credential shapes (Bearer tokens, `token=`, `password=`, GitHub/GitLab tokens, URL passwords) are replaced by `****` before persisting.
- OpenTelemetry tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`): `action.run`, `integration.sync` and `webhook.deliver` spans, with outgoing HTTP calls as children.

## Database migrations

The schema history was flattened on 2026-11-07, before the first production release: migration 1 (`baseline schema`, `apps/server/src/schema.ts`) creates the final schema in one step and there is no upgrade path from earlier development databases. From now on append migrations (2, 3…) to `MIGRATIONS` in `db.ts` and never edit the released baseline.

Migrations are numbered, additive and each runs in its own transaction together with its `schema_migrations` row. By default every pod applies pending ones at startup under an advisory lock. Because rolling updates run old and new pods side by side, write them **expand/contract**:

1. *Expand* (release N): add nullable columns, new tables and indexes only; code reads and writes both old and new shapes. Never rename, drop or tighten a column in the same release that stops using it.
2. *Migrate data* in the background or in the same additive migration if small.
3. *Contract* (release N+1 or later, once no old pod runs): drop the unused column or add the `NOT NULL`/constraint.

For large tables or stricter change control set `migrations.job.enabled=true` in the Helm chart: a hook Job (`node dist/migrate.js`, also `npm run migrate`) migrates before the upgrade and pods start with `MIGRATE_ON_START=false`, waiting for the schema instead of migrating themselves.
