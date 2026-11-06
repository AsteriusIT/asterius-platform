# Terraform provider groundwork

There is no provider yet; this page fixes the contract it can be built on, so the provider is mostly mechanical.

## Resources

Every configurable resource is a document validated by the schemas in `apps/server/src/schemas.ts` and published as a component of [`openapi.json`](openapi.json). Terraform resource attributes are the properties of that component, so a provider can be generated from the spec.

| Terraform resource | Create / update | Read | Delete | Schema (request / response) |
|---|---|---|---|---|
| `asterius_blueprint` | `PUT /api/v1/blueprints/{bp}` | `GET /api/v1/blueprints/{bp}` | `DELETE /api/v1/blueprints/{bp}` | `Blueprint` / `Blueprint` |
| `asterius_action` | `PUT /api/v1/actions/{id}` | `GET /api/v1/actions/{id}` | `DELETE /api/v1/actions/{id}` | `Action` / `Action` |
| `asterius_integration` | `PUT /api/v1/integrations/{id}` | `GET /api/v1/integrations/{id}` | `DELETE /api/v1/integrations/{id}` | `Integration` / `IntegrationView` |
| `asterius_webhook` | `PUT /api/v1/webhooks/{id}` | `GET /api/v1/webhooks/{id}` | `DELETE /api/v1/webhooks/{id}` | `Webhook` / `WebhookView` |
| `asterius_team` | `PUT /api/v1/teams/{id}` | `GET /api/v1/teams` (filter) | `DELETE /api/v1/teams/{id}` | `Team` / `Team` |
| `asterius_secret` | `PUT /api/v1/secrets/{id}` (write only) | `GET /api/v1/secrets` (names only) | `DELETE /api/v1/secrets/{id}` | n/a |
| `asterius_entity` | `PUT /api/v1/blueprints/{bp}/entities/{id}` | `GET /api/v1/blueprints/{bp}/entities/{id}` | `DELETE …` | `EntityInput` / `Entity` |

## Properties the provider relies on

- **Idempotent `PUT` by identifier**: the identifier is the resource id, `terraform import asterius_integration.cmdb cmdb` needs no lookup.
- **Output-only fields** (`managed`, `lastSync`, `lastSuccessAt`, `webhookUrl`, `hasSecret`, timestamps) are in the response components but not in the request components: mark them `Computed`.
- **Secrets are references** (`${secret:NAME}`) in every configuration. Manage values with `asterius_secret` (write-only attribute, never read back) and keep references in the other resources.
- **Managed resources**: resources declared in `CONFIG_DIR` answer 409 to writes. Do not manage the same identifier from both Terraform and configuration files.
- **Stable shapes**: component schemas are the compatibility surface. Additions are optional fields with defaults; removals follow a deprecation period.

## Authentication

A personal API token (`Authorization: Bearer …`), created under Admin → Tokens. Provider configuration: `endpoint` and `token` (also `ASTERIUS_ENDPOINT`, `ASTERIUS_TOKEN`).

## Building it

The provider is a Go module using the Terraform Plugin Framework. The generated clients in `clients/` show the full operation list; for Go, run `oapi-codegen` on `docs/openapi.json` and wrap the operations above in CRUD functions. Regenerate the spec with `npm run openapi:export` and the clients with `npm run clients:generate`.
