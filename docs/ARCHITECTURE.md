# Architecture

## Components

| Path | Role |
|---|---|
| `apps/server/src/app.ts` | Fastify app: security headers (CSP, HSTS), rate limiting, raw-body JSON parser (webhook signatures), routes, static UI. |
| `apps/server/src/index.ts` | Process entry: role (`all` / `api` / `worker`), config loader, workers, graceful shutdown. |
| `apps/server/src/db.ts` | PostgreSQL (production) or SQLite (development) behind one driver; numbered migrations under an advisory lock. |
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

Cancelling is two-phase: the run gets `cancel_requested` (workers stop starting and continuing steps), its steps are cancelled and external jobs asked to stop (also a job that was still starting), and then the run turns `CANCELLED`. Approvals insert, count and transition under a row lock in one transaction, so concurrent approvers cannot leave a run below `minApprovals`. `POST /actions/:id/runs` accepts an `Idempotency-Key` header (same key and request returns the original run); the webhook invoker sends `Idempotency-Key: <run>/<step>`, stable across retries. Run logs are capped (`RUN_LOG_MAX_LINES`); `GET /runs/:id` returns the newest lines (`?after=<seq>` for incremental polling) and `GET /runs/:id/logs?after=&limit=` pages through the rest.

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
- **Authorization.** Roles are admin and member. Entity writes are limited to the owning team (admins: everything). Each workflow's trigger carries its own `allowed` and `approval` subjects; approval steps carry their approvers.
- **Secrets.** Stored with AES-256-GCM using `SECRETS_KEY`, and referenced by name in configuration. `${env:…}` cannot read platform settings such as `DATABASE_URL` or `SECRETS_KEY`.
- **Run callbacks.** The token is an HMAC of the run id, so it is valid for that run only and verifiable by any replica without storage.
- **Templates.** Admin-written text is tokenized once; user inputs and secret values are never evaluated as expressions or references.
- **Outbound requests.** Outbound webhooks are signed over a timestamp and the body (`X-Asterius-Signature: t=…,v1=…`, replay window 5 min, dual-secret rotation), the webhook invoker signs the body (`sha256=…`); all calls have timeouts and go through the SSRF guard (private, loopback and link-local destinations need `OUTBOUND_ALLOW`). Inbound webhooks are verified the same way.
- **Audit.** The audit log records definition changes, catalog writes, runs, approvals, tokens, secrets and sign-ins.

## Observability

- `/healthz` (liveness), `/readyz` (database), `/metrics` (Prometheus; optional `METRICS_TOKEN`).
- Metrics: `asterius_runs_finished_total{action,status}`, `asterius_run_duration_seconds{invoker}`, `asterius_syncs_total{integration,status}`, `asterius_sync_entities_total`, `asterius_webhook_deliveries_total{result}`, `asterius_events_total{type}`. Cluster-wide gauges: `asterius_queue_runs{status}`, `asterius_queue_deliveries_pending`, `asterius_catalog_entities{blueprint}`.
- OpenTelemetry tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`): `action.run`, `integration.sync` and `webhook.deliver` spans, with outgoing HTTP calls as children.

## Database migrations

Migrations (`MIGRATIONS` in `db.ts`) are numbered, additive and each runs in its own transaction together with its `schema_migrations` row. By default every pod applies pending ones at startup under an advisory lock. Because rolling updates run old and new pods side by side, write them **expand/contract**:

1. *Expand* (release N): add nullable columns, new tables and indexes only; code reads and writes both old and new shapes. Never rename, drop or tighten a column in the same release that stops using it.
2. *Migrate data* in the background or in the same additive migration if small.
3. *Contract* (release N+1 or later, once no old pod runs): drop the unused column or add the `NOT NULL`/constraint.

For large tables or stricter change control set `migrations.job.enabled=true` in the Helm chart: a hook Job (`node dist/migrate.js`, also `npm run migrate`) migrates before the upgrade and pods start with `MIGRATE_ON_START=false`, waiting for the schema instead of migrating themselves.
