---
page_title: "asterius_integration Resource - asterius"
subcategory: ""
description: |-
  An ingestion integration: a pull source or an inbound webhook, and its JSONata mappings to entities.
---

# asterius_integration (Resource)

An ingestion integration: a pull source or an inbound webhook, and its JSONata mappings to entities.

## Example Usage

```terraform
# An inbound webhook: CI pipelines POST services to its webhook_url.
resource "asterius_integration" "ci_services" {
  identifier = "ci-services"
  title      = "Services pushed by CI"
  type       = "webhook"

  config = jsonencode({
    secret = "$${secret:${asterius_secret.ingest_token.name}}"
  })

  mappings = jsonencode([
    {
      entity = {
        blueprint  = asterius_blueprint.service.identifier
        identifier = "body.name"
        title      = "body.title"
        properties = { tier = "body.tier" }
      }
    }
  ])
}

output "ci_services_webhook_url" {
  value = asterius_integration.ci_services.webhook_url
}
```

## Schema

### Required

- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `title` (String) Display name.
- `type` (String) Source type (`webhook`, `github`, `azure-devops`, `kubernetes`, `connector`…).

### Optional

- `config` (String, JSON) Configuration of the source type, as JSON. Credentials must be `${secret:NAME}` references.
- `delete_dry_run` (Boolean) Only report what would be deleted (default `false`).
- `delete_max_percent` (Number) Cancel a deletion above this share of the existing entities (default 20).
- `delete_missing` (Boolean) Delete the entities it created and no longer sees (default `false`).
- `enabled` (Boolean) Enabled (default: `true`).
- `interval_minutes` (Number) Minutes between synchronisations (0: manual only; default 60).
- `mappings` (String, JSON) Mappings from source items to entities, as JSON.
- `primary_for` (List of String) Blueprints this integration is the primary source of.
- `priority` (Number) Ownership priority when several integrations write the same entity (default 0).
- `schedule` (String) Cron expression (5 fields, UTC) replacing `interval_minutes`.

### Read-Only

- `id` (String) Same as `identifier`.
- `last_success_at` (String) Time of the last successful synchronisation.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `webhook_url` (String) Inbound URL (webhook integrations).

-> **JSON attributes.** Nested documents (marked *String, JSON*) are written with `jsonencode()` and read with
`jsondecode()`. A document read from the API is equal to the configured one when it contains it: the defaults the
API fills in (nested keys the configuration does not set) are not a difference, nor are formatting and key order.
Changes made outside Terraform to keys the configuration sets are detected; keys it does not set are not.

## Import

Import is supported using the following syntax:

```shell
terraform import asterius_integration.ci_services ci-services
```
