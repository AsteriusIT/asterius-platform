# Make your app platform-ready

How a team brings its own internal application into the platform: its resources in the catalog, its actions in
self-service, without writing platform code. The application exposes a small, predictable HTTP API; a **connector
definition** (YAML, data only) tells the platform how to call it; a **connection** points at one instance with a
credential reference; integrations and workflows use the connection.

A complete working example is in [examples/inhouse-app/](../examples/inhouse-app/): a mock "database as a service"
(one Node script), its definition, connection, blueprint, integration and workflows, deployed by the local cluster.
The architecture of connectors is in [ARCHITECTURE.md](ARCHITECTURE.md#connectors).

## 1. What the application should expose

None of this is specific to the platform: it is what any automation client needs.

| Need | Expose | Why |
| --- | --- | --- |
| **List resources** | `GET /api/v1/<things>` returning `{ items: [...], nextCursor }` (or `page` / `offset` paging, or a `Link` header) | The integration pages through it. Any of the `http` source vocabularies works: `cursor` (`cursorPath` or `cursorHeader`), `page` / `offset` (with `totalPath` or a short last page), `link` (RFC 8288), `next` (a URL in the body). |
| **Stable ids** | An immutable `id` per item, in a stable sort order | The id becomes the entity identifier: a rename must not create a second entity, and pages must not skip or repeat items while they are read. |
| **Incremental listing** | `?updatedSince=<ISO 8601>` returning items changed since then, and an `updatedAt` per item | Syncs then only read what changed; the platform still runs a periodic full listing to detect deletions (only a full listing deletes). |
| **Who owns what** | A `team` (or owner) field using the platform's team identifiers | The mapping sets the entity's owning team, which drives day-2 permissions (`allowed: { ownerTeam: true }`). |
| **Authentication** | A service credential: `Authorization: Bearer <key>` or an API key header; OAuth2 client credentials if you have an identity provider | The connection stores a reference (`${secret:…}`, `${vault:…}`), never the value. Give the platform its own key with the rights it needs (read-only for ingestion; write only if workflows act). |
| **Idempotent actions** | `POST`/`PATCH` endpoints that accept an `Idempotency-Key` header (replay the first answer) or that are naturally idempotent (PUT by name, `409` on an existing name) | A step can be retried (timeouts, worker restarts, `retry` policies). Pass `{{ run.id }}` as the key: one run never creates twice. |
| **Long actions** | Answer `202 { jobId, status }` at once, and `GET /api/v1/jobs/:id` → `{ status: queued \| running \| succeeded \| failed, error? }` | The operation's `poll` follows the job (`done` / `failed` expressions); the run page shows it in progress. Synchronous calls must stay well under the HTTP timeout. |
| **Health** | `GET /api/v1/health` that **checks the credential** (and `/healthz` without auth for probes) | It is the definition's `test` request: "Test connection" then tells a wrong URL from a wrong key. |
| **Errors** | JSON `{ "error": { "code", "message" } }` with the right status (400 invalid input, 401/403, 404, 409 conflict, 429 with `Retry-After`, 5xx only for server faults) | The run log and the step error show the status and the start of the body. 429 and 5xx on reads are retried with backoff; 4xx are not. |

Also: JSON everywhere (`content-type: application/json`), no redirects on API calls, and the same base URL for every
endpoint (a connection's requests cannot leave its `baseUrl`).

## 2. Write the connector definition

A definition is a YAML document (Admin → Connectors → New, or `connectors:` in a `CONFIG_DIR` file). Abridged from
[examples/inhouse-app/platform/dbaas-connector.yaml](../examples/inhouse-app/platform/dbaas-connector.yaml):

```yaml
connectors:
  - identifier: inhouse-dbaas
    title: DBaaS (in-house)
    category: internal
    fields: # the connection form; baseUrl is required
      properties:
        baseUrl: { type: string, title: API URL, format: url }
      required: [baseUrl]
    auth: # supported methods, the first is the default
      - type: bearer
        title: API key (Authorization Bearer)
      - type: header
        title: API key (X-Api-Key header)
        headers: { X-Api-Key: '{apiKey}' } # {apiKey}: a credential the connection supplies
    test: # "Test connection"
      path: /api/v1/health
      expect: { condition: body.status = "ok" }
    kinds: # ingestion
      database:
        path: /api/v1/databases
        query: { limit: '100' }
        itemsPath: items
        pagination: { type: cursor, param: cursor, cursorPath: nextCursor }
        since: { param: updatedSince } # incremental syncs
    operations: # actions
      create-database:
        title: Create a database
        kind: database # offered on entities mapped from this kind
        inputs:
          properties:
            name: { type: string }
            team: { type: string }
            requestId: { type: string }
          required: [name, team]
        method: POST
        path: /api/v1/databases
        headers: { Idempotency-Key: '{{ inputs.requestId }}' }
        body: { name: '{{ inputs.name }}', team: '{{ inputs.team }}' }
        output: { jobId: body.jobId, databaseId: body.resourceId }
        poll:
          path: /api/v1/jobs/{{ output.jobId }}
          intervalSeconds: 5
          timeoutMinutes: 15
          done: body.status = "succeeded"
          failed: body.status = "failed"
          output: { status: body.status, error: body.error.message }
```

- **Templates** are `{{ JSONata }}` over `connection` (the connection's fields), `inputs` (the operation's inputs,
  defaults applied) and, in `poll`, `output` (the operation's mapped output). In a path, each `{{ }}` value is one
  URL-encoded segment; query values that render empty are left out; a body string that is only `{{ expr }}` keeps the
  value's type (and an undefined value drops the key).
- **Outputs** are JSONata over `{ connection, inputs, status, body }`. A `url` (or `link`) output that is an absolute
  URL becomes the step's link on the run page.
- **Read-only operations** (`method: GET`, or `readOnly: true`) work with a read connection; any other needs
  `access: read-write`.
- No credentials in a definition: `${secret:…}` is refused there.
- Admin → Connectors → the definition → *Try* renders a request against a connection before anything uses it.

The built-in definitions in [apps/server/connectors/](../apps/server/connectors/) (Argo CD, Azure DevOps, Grafana,
SonarQube, Nexus, Jira, PagerDuty…) are good models; they are read-only, so copy one under a new identifier to change
it.

## 3. Create the connection

```yaml
connections:
  - identifier: inhouse-dbaas
    title: DBaaS (production)
    connector: inhouse-dbaas
    fields: { baseUrl: https://dbaas.internal.example.com }
    auth: { type: bearer, token: '${secret:DBAAS_API_KEY}' } # references only: ${secret:…}, ${vault:…}, ${env:…}…
    access: read-write # read: ingestion and read-only operations only
    # allowed: { workflows: [create-inhouse-database], teams: [data] }   # who may use it in workflows (empty: any)
```

Admin → Connections offers the same form, **Test connection** and the list of integrations and workflows using it (a
used connection cannot be deleted). Internal hosts: private and cluster addresses must be allowed by `OUTBOUND_ALLOW`
(Helm `outbound.allow`, e.g. `*.svc` for in-cluster services), and an egress NetworkPolicy, if you set one, must let
the worker pods reach the app.

`allowed` in the current release also applies to ingestion: an integration using a connection whose `allowed` lists
workflows or teams fails its sync. Until that changes, leave `allowed` empty on a connection shared with an
integration, or declare a second connection (same app, its own credential) for the workflows.

## 4. Map kinds to blueprints

```yaml
integrations:
  - identifier: inhouse-dbaas
    title: In-house DBaaS databases
    type: connector
    config: { connection: inhouse-dbaas }
    intervalMinutes: 5
    deleteMissing: true # entities whose item disappeared are removed (full listings only)
    mappings:
      - kind: database
        entity:
          blueprint: inhouse-database
          identifier: id
          title: name
          team: team
          properties: { engine: engine, size: size, status: status }
```

Mappings are JSONata over each item (`docs/EXTENDING.md`, "Expressions and templates"). They see the integration's
own config as `$integration.config`, not the connection's fields: put values the mappings need (a public URL for
links, for instance) in the integration's `config` next to `connection`, as the Grafana, SonarQube and Nexus
examples do with `publicUrl`.

## 5. Use the operations in workflows

```yaml
steps:
  - id: create
    type: invoke
    timeoutMinutes: 20
    invoker:
      type: connector
      connection: inhouse-dbaas
      operation: create-database
      inputs: { name: '{{ inputs.name }}', team: '{{ inputs.team }}', requestId: '{{ run.id }}' }
  - id: register # show it in the catalog now; the next sync takes the entity over and keeps it current
    type: invoke
    invoker:
      type: catalog
      operation: upsert
      blueprint: inhouse-database
      identifier: '{{ steps.create.output.databaseId }}'
      title: '{{ inputs.name }}'
      team: '{{ inputs.team }}'
```

In the workflow editor, a step of type "Connection operation" lists the connections with their operations; on a day-2
workflow it offers to prefill inputs whose names match properties of the blueprint the operation's `kind` is mapped to
(`{{ entity.properties.<name> }}`). Literal inputs are validated when the workflow is saved, templated ones when the
step runs. Dry runs and workflow tests render the request without sending it.

For a one-off call the definition does not cover, `type: connector-api` sends a raw request through a connection
whose `api` allow-list permits that method and path prefix.

## When a connector is not the right tool

A connector definition describes **independent HTTP requests with JSON bodies**: one request per operation, plus its
status polling. Use something else when:

| Situation | Use |
| --- | --- |
| Several dependent calls (create, then configure with the returned id, then wait on a second resource), compensation on failure | A workflow with several connector steps (each step sees `steps.<id>.output`), or a code plugin when the logic is real code |
| Request signing beyond the auth methods (bespoke HMAC schemes, signed URLs), binary payloads, multipart uploads, streaming | A code plugin (`docs/EXTENDING.md`, "Writing a code plugin") or the **external plugin contract**: your own service implements `POST /list` and `POST /start` / `/poll` in any language |
| Not HTTP (a database, a message queue, gRPC, SSH, a CLI) | The external plugin contract (a small adapter service), the `kubernetes-job` invoker for a containerised CLI, or a code plugin |
| The app pushes events rather than being polled | An inbound webhook integration (`/api/v1/ingest/<org>/<integration>`, HMAC verified) or the bulk catalog API |
| The work already lives in a pipeline | The `azure-pipeline`, `github-workflow` or `gitlab-pipeline` invokers (they accept `connection:` too) |

The webhook invoker (the platform POSTs the run to your service, which answers or calls back) remains the simplest
way to receive a request whose handling is entirely yours.
