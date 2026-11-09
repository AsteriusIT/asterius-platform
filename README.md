# Asterius Platform

An internal developer portal in the spirit of Port, Backstage or Cycloid. It covers the features those tools have in common and leaves out the rest:

| Feature | What you get |
|---|---|
| **Software catalog** | Blueprints (entity types: JSON Schema properties + relations) and entities, with search, filters, team ownership, and relation graph in both directions. |
| **Self-service** | Actions with generated forms (from JSON Schema), three triggers (create, day-2 on an entity, delete), and per-action permissions. |
| **Workflows** | Each action runs a workflow: steps in sequence or in parallel (`needs`), with conditions (`if`), retries with backoff, timeouts and `continueOnError`; concurrency groups (queue, cancel in progress, reject), priorities, pause / unpause and operator skip / complete of a step. Step types: **integration** (any invoker), **approval** (mid-workflow gate), **AI agent** (Claude, optional structured output and read-only catalog tools), **transform** (JSONata). Later steps use earlier outputs: `{{ steps.review.output.risk }}`. |
| **Approvals** | Before a request starts and/or as workflow steps: approvers by role, team, user or *owning team*, a minimum number of approvals, no self-approval by default, a message templated from earlier steps (e.g. an AI summary). |
| **Pipelines & webhooks** | Invokers: GitHub Actions, Azure Pipelines, GitLab CI, Kubernetes Job, generic webhook (sync or async with callback), and the catalog itself. Runs are followed live with logs. |
| **Ingestion** | Pull from GitHub, Azure DevOps, GitLab, Kubernetes (any resource or CRD) or any JSON API on a schedule. Push via inbound webhooks (HMAC verified) or the bulk API. Mappings are JSONata. |
| **Outbound events** | Signed webhooks on catalog changes and runs, with an outbox, retries and a redelivery UI. |
| **Governance** | Teams (bound to Entra ID groups), admin/member roles, service accounts and API tokens, encrypted secrets, audit log. |

```
           ┌──────────── Ingress ────────────┐
 Browser ─▶│  api pods (HPA, stateless)      │◀── CI/CD, scripts (API tokens) · third-party webhooks · run callbacks
           │  UI · /api/v1 · /api/v1/ingest  │
           └───────────────┬─────────────────┘
                           │              PostgreSQL (catalog, runs, outbox, secrets [AES-256-GCM])
           ┌───────────────┴─────────────────┐
           │  worker pods                    │──▶ GitHub · Azure DevOps · GitLab · Kubernetes · any HTTP service
           │  runs · syncs · deliveries      │
           └─────────────────────────────────┘
```

## Quick start (local)

```bash
cp .env.example .env
npm install
npm run dev          # UI http://localhost:5173 · API :8080 · SQLite under ./data
```

Create an account; the first one becomes admin. New users get a short guided tour on first sign-in (replay it from the account menu → *Take the tour*). The configuration in [config/](config/) is **Azure DevOps self-service**: create a project, add members and repositories, and the matching deletions. Each workflow runs one Azure DevOps pipeline and records the result in the catalog. Set it up and test it end to end with [examples/azure-devops/README.md](examples/azure-devops/README.md). The previous demo (a sample catalog, GitHub / Kubernetes examples and an AI-reviewed request) is kept in [examples/demo-config/](examples/demo-config/): run with `CONFIG_DIR=$PWD/examples/demo-config`.

## Extending by configuration

Everything is declared in YAML: in [config/](config/) (configuration as code, GitOps) or in the admin UI (same format, exportable to Git). Blueprints (Admin → Blueprints: properties with option colors and a display preview, relations) and self-service workflows have **guided builders**. Integrations (connection fields per source type, mappings), webhooks, teams and catalog entities are edited in **form dialogs** too, each with JSON / YAML views of the same document. Blueprint and action icons are picked from **official service logos** (Azure, Azure DevOps, Kubernetes, Helm, Argo CD, Terraform, GitHub, Prometheus, PostgreSQL… — `icon: azure-devops`; regenerate with `npm run icons:vendor -w apps/web`), generic icons, or are a **custom image** (an https:// URL or an uploaded PNG / JPEG / GIF / WebP / SVG up to 48 KB, stored in the definition). A workflow is a **trigger** followed by **steps**: Admin → Actions → New only asks for a title and a description; the editor then shows the workflow as nodes, where you add the trigger (a *form submission*: where it is offered, form fields with a live preview, who can submit it, approval before it starts) and the steps one by one (integration call, approval, AI agent, transform). JSON and YAML views edit the same document, and an unfinished workflow can be saved as a draft (users don't see it until it has a trigger and a step). For example, a day-2 workflow that runs an Azure pipeline after the owning team approves it:

```yaml
actions:
  - identifier: deploy-service
    title: Deploy
    trigger:                       # what starts it: a form, here in the "⋯" menu of service entities
      type: form
      on: day-2                    # create (self-service page) | day-2 | delete (on an entity)
      blueprint: service
      allowed: { ownerTeam: true }
      inputs:
        properties:
          environment: { type: string, format: entity, blueprint: environment }
          version: { type: string }
        required: [environment, version]
      approval: { required: true, approvers: { ownerTeam: true } }
    steps:                         # what it does, in order (see docs/EXTENDING.md → Workflows)
      - id: deploy
        type: invoke
        invoker:
          type: azure-pipeline
          organization: https://dev.azure.com/my-org
          project: Platform
          pipelineId: 42
          token: ${secret:ADO_PAT}
          templateParameters: { service: "{{ entity.identifier }}", environment: "{{ inputs.environment }}", version: "{{ inputs.version }}" }
```

And an integration that keeps repositories in sync from GitHub:

```yaml
integrations:
  - identifier: github
    title: GitHub repositories
    type: github
    intervalMinutes: 60
    deleteMissing: true
    config: { org: my-org, token: ${secret:GITHUB_TOKEN} }
    mappings:
      - kind: repository
        filter: archived = false
        entity: { blueprint: repository, identifier: name, properties: { url: html_url, language: language } }
```

To plug in a **custom service**, use one of three paths:
1. **Webhook invoker.** The platform POSTs the run (inputs, entity, requester) to your service. Your service answers synchronously, or later through the run callback API.
2. **HTTP source / inbound webhook / bulk API.** Use these to bring your service's data into the catalog without writing code.
3. **Code plugin.** Implement the `Invoker` or `Source` interface (~50 lines) and register it.

See [docs/EXTENDING.md](docs/EXTENDING.md) for the API, the callback contract and the plugin interfaces.

## Organizations, sign-in and AI assistants

**Organizations (tenants).** Everything (catalog and its history, scorecards, dashboards, workflows and their versions, runs, integrations, webhooks, secrets, notifications, AI budgets and usage, audit log, API tokens) belongs to an organization. People belong to several organizations with a role in each (admin or member) and switch from the sidebar. Platform super-admins (`ADMIN_EMAILS`, the bootstrap account) see every organization under *Platform → All organizations*. Existing installs are migrated into the `default` organization. A new account belongs to no organization: it lands on *Create your organization*, unless it was invited or came in through an organization's SSO. Anyone signed in can create an organization (`ORG_CREATION=superadmin` restricts it); `AUTO_JOIN_DEFAULT_ORG=true` restores the single-tenant behaviour (everyone joins the default organization). Inbound webhooks and workflow webhook triggers carry the organization in their URL (`/api/v1/ingest/<org>/<integration>`, `/api/v1/hooks/<org>/<action>`; without it: the default organization). The platform's own Kubernetes access and cloud identity (external secret managers, `auth` blocks without credentials) are reserved to the organizations listed in `KUBERNETES_ORGS` and `PLATFORM_IDENTITY_ORGS` (default: the default organization). Platform-wide sign-in providers (Entra ID, generic OIDC, GitHub, SAML) serve the default organization; SCIM tokens provision the organization they were created in.

**Registration, login and SSO per organization: Keycloak.** With `AUTH_PROVIDERS=keycloak` (and `KEYCLOAK_URL`), Keycloak handles registration, password reset, MFA and passkeys. Each platform organization is a Keycloak *Organization*. Organization admins connect their own identity provider (Entra ID, Okta, Google, any OIDC or SAML) and invite people from *Organization → Single sign-on / Members*: the platform drives Keycloak's admin API. Email domains must be verified with a DNS TXT record before they route sign-ins or let people join, so no organization can claim someone else's domain. Typing an email on the sign-in page goes straight to the identity provider connected for its domain (no Keycloak page): people who come through an organization's identity provider with an email of its verified domains become members on their first sign-in (and are mirrored in the Keycloak Organization), nobody manages members in Keycloak. Registering with a password, even with a matching email, joins nothing. Locally: `docker compose -f deploy/keycloak/docker-compose.yaml up -d` (realm `asterius` imported from [deploy/keycloak/realm-asterius.json](deploy/keycloak/realm-asterius.json)). In Kubernetes: `keycloak.enabled=true` in the chart, or `keycloak.url` for an existing Keycloak. Local accounts and the direct Entra integration (default organization) remain available.

**Configuration as code per organization.** The default organization reads `CONFIG_DIR`; another organization reads `CONFIG_DIR/orgs/<slug>/` (mounted by the operators) or **its own Git repository** (https, read-only token kept as an organization secret, pulled every 2 minutes). Organizations can also be declared in the platform files (`organizations: [{ slug, name, domains, admins }]`).

**MCP server.** `POST /api/mcp` (also `/api/v1/mcp`, Streamable HTTP) lets AI assistants search the catalog, read entities, start self-service actions and follow runs, with the permissions of the token's owner in the token's organization:

```bash
claude mcp add --transport http acme https://platform.example.com/api/mcp --header "Authorization: Bearer ast_…"
```

Remote clients (Claude.ai, ChatGPT connectors) sign in with OAuth 2.1 against the Keycloak realm: the server publishes RFC 9728 metadata at `/.well-known/oauth-protected-resource` and accepts the realm's access tokens; see [docs/MCP.md](docs/MCP.md).

`whoami` and `list_approvals` show the token's organization and what waits for a decision; approving requests is deliberately not exposed to assistants.

## Deploying on Kubernetes

```bash
kubectl create namespace asterius
kubectl -n asterius create secret generic asterius-platform \
  --from-literal=DATABASE_URL='postgres://…' \
  --from-literal=SECRETS_KEY="$(openssl rand -base64 32)" \
  --from-literal=ENTRA_CLIENT_SECRET=…
helm upgrade --install asterius deploy/helm/asterius-platform -n asterius \
  --set secrets.existingSecret=asterius-platform \
  --set publicUrl=https://platform.example.com --set ingress.host=platform.example.com \
  --set auth.entra.tenantId=… --set auth.entra.clientId=… \
  --set config.existingConfigMap=platform-config     # or --set-file config.files.catalog\.yaml=config/catalog.yaml
```

What the chart does:
- **Separate API and worker Deployments.** API pods are stateless with an HPA (2–6). Workers can run any number of replicas. Work is claimed through conditional database updates, so there is no leader election and no sticky state.
- **Pod hardening.** Non-root UID 10001, read-only root filesystem, all capabilities dropped, seccomp `RuntimeDefault`. The service account token is mounted only on workers, and only when they need Kubernetes RBAC.
- **Availability.** Startup, readiness (`/readyz`: database) and liveness (`/healthz`) probes; a `preStop` drain; graceful shutdown that lets in-flight runs record their state; PodDisruptionBudgets; topology spread across nodes and zones.
- **Configuration.** Non-secret settings come from a ConfigMap and secrets from a Secret, ideally an existing one from External Secrets or Sealed Secrets. A checksum annotation rolls pods when settings change. `SECRETS_KEY` is generated once and kept (`resource-policy: keep`).
- **Network.** A NetworkPolicy allows ingress only from the ingress controller, Prometheus and the release itself; egress can optionally be restricted.
- **Database.** Bring your own PostgreSQL (`database.url` / `DATABASE_URL`), or let the chart create a **CloudNativePG** cluster (`database.cnpg.enabled=true`).
- **Branding.** `branding.name` / `branding.logo` (`BRAND_NAME` / `BRAND_LOGO`: an https:// image URL or a `data:image/…` URI) set the product name and logo shown in the sidebar, the sign-in page, the browser tab and the favicon.
- **Optional extras.** Least-privilege RBAC for the Kubernetes source (cluster read) and the Job invoker (per-namespace Role), a ServiceMonitor, OpenTelemetry tracing, and `helm test`.
- **Optional extras.** Least-privilege RBAC for the Kubernetes source (cluster read) and the Job invoker (per-namespace Role) bound to a worker-only ServiceAccount (the API pods get no Kubernetes token), a ServiceMonitor, a PrometheusRule (queue age, failed/stale syncs, delivery failures, worker loop age, database), a Grafana dashboard ConfigMap, CloudNativePG backups to an object store with scheduled base backups and point-in-time recovery (`database.cnpg.backup` / `database.cnpg.recovery`), `values.schema.json`, `extraVolumes` / `extraVolumeMounts` / `extraContainers`, OpenTelemetry tracing, and `helm test`.

**Sizing (≈500 users, tens of thousands of entities):** 2–3 API pods and 2 worker pods at 100m CPU / 256 Mi each, plus a small PostgreSQL instance (2 vCPU, 4 GB) cover this comfortably. The UI polls instead of holding long-lived connections, so any replica can serve any request. Reproducible load test and latency budgets: [docs/PERFORMANCE.md](docs/PERFORMANCE.md); backups and disaster recovery: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Development

```bash
npm run dev            # server (tsx watch) + web (Vite)
npm test               # server (SQLite) + web; TEST_DATABASE_URL=postgres://… runs the server suite on Postgres
npm run lint && npm run typecheck
npm run build && docker build -t asterius-platform .
```

| Path | |
|---|---|
| `apps/server` | Fastify API and workers (TypeScript): catalog, actions/runs/invokers, integrations/sources, webhooks, config loader |
| `apps/web` | React + Mantine UI (shared components in `src/components`) |
| `packages/shared` | API types shared by server and web |
| `config/` | Example configuration as code |
| `deploy/helm/asterius-platform` | Helm chart |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [extending & API](docs/EXTENDING.md) |
