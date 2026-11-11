# In-house app, end to end

The reference for teams who want their own application in the platform: a tiny "database as a service" API, its
connector definition, a connection, a blueprint with an integration, and two self-service workflows. No platform code
is involved. The guide that explains each choice is [docs/PLATFORM-READY.md](../../docs/PLATFORM-READY.md).

```
                     connector definition inhouse-dbaas (how to talk to the app)
                                   │
 DBaaS API ◀── connection inhouse-dbaas (URL, API key reference, read-write)
   │   ▲              │                                   │
   │   │   integration inhouse-dbaas                workflows create-inhouse-database (create)
   │   │   kind database → blueprint inhouse-database   resize-inhouse-database (day-2)
   │   └── GET /api/v1/databases?updatedSince=…   POST /api/v1/databases → job → GET /api/v1/jobs/:id …
```

| File | What |
| --- | --- |
| `app/server.mjs` | The app: one Node script, no dependencies, data in memory (five seeded databases, team `platform`) |
| `platform/dbaas-connector.yaml` | Connector definition `inhouse-dbaas`: connection fields, two auth methods, test request, kind `database` (paged, incremental), operations `create-database` and `resize-database` (asynchronous, polled) |
| `platform/dbaas-catalog.yaml` | Connection `inhouse-dbaas`, blueprint `inhouse-database`, integration `inhouse-dbaas` (every 5 minutes, incremental) |
| `platform/dbaas-workflows.yaml` | Workflows *Create a database* (self-service page) and *Resize* (on a database) |

## The app's API

| Endpoint | What |
| --- | --- |
| `GET /healthz` | Liveness, no authentication (Kubernetes probes) |
| `GET /api/v1/health` | Authenticated health: the connector's "Test connection" (a wrong key fails it) |
| `GET /api/v1/databases?limit=&cursor=&updatedSince=` | `{ items, nextCursor }`, stable order by id, opaque cursor, only items updated since the date when given |
| `GET /api/v1/databases/:id` | One database |
| `POST /api/v1/databases` | `{ name, engine, size, team }` → `202 { jobId, status, resourceId, statusUrl }`; `Idempotency-Key` replays the first answer; an existing name is `409` |
| `PATCH /api/v1/databases/:id` | `{ size }` → `202` job (resize) |
| `GET /api/v1/jobs/:id` | `{ id, status: queued \| running \| succeeded \| failed, resourceId, error? }` |

Authentication: `Authorization: Bearer <key>` or `X-Api-Key: <key>`. Errors: `{ "error": { "code", "message" } }` with
a meaningful status (400, 401, 404, 409). Jobs take `JOB_SECONDS` (default 6).

## On the local OrbStack cluster

`deploy/local/install.sh` deploys the app (namespace `inhouse-app`, `node:22-alpine` running the script from a
ConfigMap, API key generated in OpenBao `secret/apps/inhouse-app#apiKey` and handed to the pod by External Secrets) and
adds `platform/*.yaml` to the platform's configuration. The platform calls
`http://inhouse-app.inhouse-app.svc:8080` (allowed by the chart's `outbound.allow: ["*.svc", …]`) with the key read as
`${vault:secret/apps/inhouse-app#apiKey}`.

Try it:

1. Admin → Connections → *DBaaS (local cluster)* → **Test connection**: OK.
2. Catalog → Database: the five seeded databases (the integration runs every 5 minutes; Admin → Integrations →
   *In-house DBaaS databases* → Sync now to see them at once).
3. Self-service → **Create a database** (`billing`, Postgres, M, team Platform). The run shows the operation step
   (`POST /api/v1/databases → 202`, then the job polls) and the catalog step; the database appears in the catalog.
4. On the database: **⋯ → Resize** to L. The next sync confirms the size and the `available` status.

## On your machine

```bash
PORT=8090 API_KEY=dev-key node examples/inhouse-app/app/server.mjs
curl -H 'Authorization: Bearer dev-key' 'http://127.0.0.1:8090/api/v1/databases?limit=2'
```

Copy `platform/*.yaml` into your `CONFIG_DIR` (or paste each part in the admin UI: Admin → Connectors, Connections,
Blueprints, Integrations, Actions) and change the connection to `baseUrl: http://127.0.0.1:8090` and
`token: ${secret:DBAAS_API_KEY}` (Admin → Secrets: `DBAAS_API_KEY` = `dev-key`). Loopback addresses are refused by
the SSRF guard unless allowed: start the platform with `OUTBOUND_ALLOW=127.0.0.0/8`. Check the files with
`npm run config:validate -- <dir>`.

## Adapting it to your app

Copy `platform/dbaas-connector.yaml`, rename the identifier, and change the paths, `itemsPath`, the pagination
vocabulary (`cursor`, `page`, `offset`, `link`, `next`) and the operations to your API. The guide lists what to
expose when you can still change the app, and when a code plugin or the external plugin contract fits better.
