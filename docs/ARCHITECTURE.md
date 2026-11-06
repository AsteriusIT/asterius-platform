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

Every transition is a conditional `UPDATE … WHERE status IN (…)`: the engine (`actions/engine.ts`) can be called concurrently by workers, callbacks and API pods. Each step has a lease while executing and a deadline (`timeoutMinutes`; approvals 7 days, others `RUN_TIMEOUT_HOURS`). Housekeeping fails steps whose worker died mid-start (invokers are not retried: the external call may have happened), times out steps, and resumes interrupted runs. Runs keep a snapshot of the workflow: editing an action never changes runs in flight.

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
- **Runs always end.** `RUN_TIMEOUT_HOURS` fails runs that never report a final status.
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
| Work distribution | Conditional UPDATEs and leases in PostgreSQL for runs, polls, syncs and deliveries. A cluster-wide advisory lock covers the rare singleton tasks (migrations, config apply, housekeeping). |
| Load | At 500 users and tens of thousands of entities, the busiest paths are catalog list pages: indexed by `(blueprint, title)` with a `search` column and paging. A 2-vCPU PostgreSQL is enough. |
| Failure | A pod restart loses no event (outbox) and no run state. Runs are failed explicitly when their state is unknown. |
| Retention | `RETENTION_DAYS` purges finished runs, deliveries, audit entries and old sync history every hour (one replica). |

## Security

- **Authentication.** Entra ID uses OIDC code + PKCE; the ID token's signature, issuer, audience, nonce and tenant are verified. Local accounts use scrypt hashes, per-IP rate limits and per-account lockout. Sessions and API tokens are stored as SHA-256 hashes only.
- **Authorization.** Roles are admin and member. Entity writes are limited to the owning team (admins: everything). Each workflow's trigger carries its own `allowed` and `approval` subjects; approval steps carry their approvers.
- **Secrets.** Stored with AES-256-GCM using `SECRETS_KEY`, and referenced by name in configuration. `${env:…}` cannot read platform settings such as `DATABASE_URL` or `SECRETS_KEY`.
- **Run callbacks.** The token is an HMAC of the run id, so it is valid for that run only and verifiable by any replica without storage.
- **Templates.** Admin-written text is tokenized once; user inputs and secret values are never evaluated as expressions or references.
- **Outbound requests.** Webhooks and invokers are signed (`X-Asterius-Signature: sha256=…`), with timeouts. Inbound webhooks are verified the same way.
- **Audit.** The audit log records definition changes, catalog writes, runs, approvals, tokens, secrets and sign-ins.

## Observability

- `/healthz` (liveness), `/readyz` (database), `/metrics` (Prometheus; optional `METRICS_TOKEN`).
- Metrics: `asterius_runs_finished_total{action,status}`, `asterius_run_duration_seconds{invoker}`, `asterius_syncs_total{integration,status}`, `asterius_sync_entities_total`, `asterius_webhook_deliveries_total{result}`, `asterius_events_total{type}`. Cluster-wide gauges: `asterius_queue_runs{status}`, `asterius_queue_deliveries_pending`, `asterius_catalog_entities{blueprint}`.
- Further metrics (labels are bounded: route patterns, configured integration ids and upstream hosts, never raw URLs or entity ids):
  - `asterius_http_request_duration_seconds{method,route,status}` histogram of inbound requests (rate is `_count`; `/metrics` and probes excluded).
  - `asterius_sync_duration_seconds{integration}` histogram; `asterius_integration_last_success_timestamp_seconds{integration}` gauge read from `sync_runs` (cluster-wide, alert on `time() - value`).
  - `asterius_webhook_delivery_latency_seconds` histogram from event creation to successful delivery.
  - `asterius_db_pool_connections`, `asterius_db_pool_idle_connections`, `asterius_db_pool_waiting_requests` (per process; waiting > 0 means pool saturation, see `DATABASE_POOL_SIZE`).
  - `asterius_upstream_responses_total{host,class}` and `asterius_upstream_rate_limited_total{host}` (429s from GitHub, GitLab, ADO, webhook targets).
- OpenTelemetry tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`): one `http.server` span per request (named `METHOD route`, continues an inbound `traceparent`), `db.<OP>` spans per query, `action.run`, `integration.sync` and `webhook.deliver` spans, with outgoing HTTP calls as children. Outgoing calls (CI pipelines, outbound webhooks, sources) carry a W3C `traceparent` header so a run can be followed into the CI system. Log lines include `trace_id` and `span_id` while a span is active.
- Logging: pino JSON lines with a `component` field (`config`, `audit`, `events`, `db`, `worker`, ...) and `trace_id`/`span_id` when traced. `LOG_FORMAT=pretty` (needs the `pino-pretty` dev dependency) gives readable output locally. Stored sync logs (`sync_runs.logs`) are masked: resolved secret values and common credential shapes (Bearer tokens, `token=`, `password=`, GitHub/GitLab tokens, URL passwords) are replaced by `****` before persisting.
