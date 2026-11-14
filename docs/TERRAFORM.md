# Terraform / OpenTofu provider

[`terraform-provider-asterius/`](../terraform-provider-asterius/) is a Go provider on the Terraform Plugin Framework
(module `github.com/AsteriusIT/terraform-provider-asterius`, registry address `asteriusit/asterius`). It manages the
configuration of an organization through the REST API; its own [README](../terraform-provider-asterius/README.md)
covers development, tests and releases, and [docs/](../terraform-provider-asterius/docs/) every resource.

```hcl
terraform {
  required_providers {
    asterius = { source = "asteriusit/asterius" }
  }
}

provider "asterius" {
  endpoint     = "https://portal.example.com" # ASTERIUS_ENDPOINT
  organization = "acme"                       # ASTERIUS_ORG (X-Asterius-Org); default: the token's organization
  # token: ASTERIUS_TOKEN
}
```

## Resources

Every configurable resource is a document validated by the schemas in `apps/server/src/schemas.ts` and published as a
component of [`openapi.json`](openapi.json). Each resource and data source maps one document:

| Terraform resource | Create / update | Read | Delete | Schema (request / response) |
|---|---|---|---|---|
| `asterius_blueprint` | `PUT /api/v1/blueprints/{bp}` | `GET /api/v1/blueprints/{bp}` | `DELETE /api/v1/blueprints/{bp}` | `Blueprint` / `Blueprint` |
| `asterius_entity` | `PUT /api/v1/blueprints/{bp}/entities/{id}` | `GET /api/v1/blueprints/{bp}/entities/{id}` | `DELETE …` | `EntityInput` / `Entity` |
| `asterius_action` | `PUT /api/v1/actions/{id}` | `GET /api/v1/actions/{id}` | `DELETE /api/v1/actions/{id}` | `Action` / `Action` |
| `asterius_integration` | `PUT /api/v1/integrations/{id}` | `GET /api/v1/integrations/{id}` | `DELETE /api/v1/integrations/{id}` | `Integration` / `IntegrationView` |
| `asterius_webhook` | `PUT /api/v1/webhooks/{id}` | `GET /api/v1/webhooks/{id}` | `DELETE /api/v1/webhooks/{id}` | `Webhook` / `WebhookView` |
| `asterius_team` | `PUT /api/v1/teams/{id}` | `GET /api/v1/teams` (filtered) | `DELETE /api/v1/teams/{id}` | `Team` / `Team` |
| `asterius_secret` | `PUT /api/v1/secrets/{id}` (write only) | `GET /api/v1/secrets` (names only) | `DELETE /api/v1/secrets/{id}` | n/a |
| `asterius_scorecard` | `PUT /api/v1/scorecards/{id}` | `GET /api/v1/scorecards/{id}` | `DELETE /api/v1/scorecards/{id}` | `scorecardDef` (no OpenAPI component yet) |
| `asterius_policy` | `PUT /api/v1/policies/{id}` | `GET /api/v1/policies/{id}` | `DELETE /api/v1/policies/{id}` | `Policy` / `PolicyView` |
| `asterius_dashboard` | `PUT /api/v1/dashboards/{id}` | `GET /api/v1/dashboards/{id}` | `DELETE /api/v1/dashboards/{id}` | `dashboardDef` (no OpenAPI component yet) |
| `asterius_connector` | `PUT /api/v1/connectors/{id}` | `GET /api/v1/connectors/{id}` | `DELETE /api/v1/connectors/{id}` | `Connector` / `ConnectorView` |
| `asterius_connection` | `PUT /api/v1/connections/{id}` | `GET /api/v1/connections/{id}` | `DELETE /api/v1/connections/{id}` | `Connection` / `ConnectionView` |

Data sources of the same names (all but `asterius_secret`) read one document by identifier.

**Attributes.** Top-level scalars and string lists/maps of a document are typed attributes (`camelCase` keys become
`snake_case`: `intervalMinutes` → `interval_minutes`). Nested documents (blueprint `schema`, action `trigger` and
`steps`, integration `config` and `mappings`, scorecard `rules`, dashboard `widgets`, connector `kinds`…) are JSON
strings written with `jsonencode()`. Their semantic equality treats a document read from the API as equal to the
configured one when it contains it: the defaults the API fills in, key order and formatting do not make plans churn,
while changes to the keys the configuration sets are detected.

## Properties the provider relies on

- **Idempotent `PUT` by identifier**: the identifier is the resource id, `terraform import asterius_integration.cmdb cmdb`
  needs no lookup (entities: `terraform import asterius_entity.api service/payments-api`). A create first checks the
  identifier is free, so Terraform never silently takes over an existing resource.
- **Output-only fields** (`managed`, `version`, `lastSuccessAt`, `webhookUrl`, `hasSecret`, timestamps) are in the
  response components but not in the request components: they are `Computed`.
- **Secrets are references** (`${secret:NAME}`) in every configuration. Manage values with `asterius_secret` (`value`,
  sensitive and never read back, or the write-only `value_wo`) and keep references in the other resources.
- **Managed resources**: resources declared in `CONFIG_DIR` answer 409 to writes; the provider reports them as *managed
  by configuration (CONFIG_DIR)*. Do not manage the same identifier from both Terraform and configuration files.
- **Stable shapes**: component schemas are the compatibility surface. Additions are optional fields with defaults;
  removals follow a deprecation period. A new configurable resource is a `resourceSpec` in
  `terraform-provider-asterius/internal/provider/spec.go`.

## Authentication

A personal API token or a service account token (`Authorization: Bearer …`), created under Admin → Tokens; most
resources need an organization admin. Provider configuration: `endpoint`, `token` and `organization` (also
`ASTERIUS_ENDPOINT`, `ASTERIUS_TOKEN`, `ASTERIUS_ORG`).

## Tests

```bash
npm run tf:test       # go vet, gofmt, unit tests (in-process fake API), docs freshness
npm run tf:testacc    # throwaway server (fresh SQLite, scripts/local-server.sh) + TF_ACC acceptance tests + every example applied, imported and destroyed with the CLI
```

The acceptance tests create, update, import, detect drift on and destroy every resource against a real server, and
check the 409 diagnostic on a blueprint declared in the server's configuration directory.
