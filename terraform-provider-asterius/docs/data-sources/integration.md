---
page_title: "asterius_integration Data Source - asterius"
subcategory: ""
description: |-
  Reads a Integration.
---

# asterius_integration (Data Source)

Reads a Integration. An ingestion integration: a pull source or an inbound webhook, and its JSONata mappings to entities.

## Example Usage

```terraform
data "asterius_integration" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `config` (String, JSON) Configuration of the source type, as JSON. Credentials must be `${secret:NAME}` references. Decode it with jsondecode().
- `delete_dry_run` (Boolean) Only report what would be deleted (default `false`).
- `delete_max_percent` (Number) Cancel a deletion above this share of the existing entities (default 20).
- `delete_missing` (Boolean) Delete the entities it created and no longer sees (default `false`).
- `enabled` (Boolean) Enabled (default: `true`).
- `id` (String) Same as the resource's `id`.
- `interval_minutes` (Number) Minutes between synchronisations (0: manual only; default 60).
- `last_success_at` (String) Time of the last successful synchronisation.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `mappings` (String, JSON) Mappings from source items to entities, as JSON. Decode it with jsondecode().
- `primary_for` (List of String) Blueprints this integration is the primary source of.
- `priority` (Number) Ownership priority when several integrations write the same entity (default 0).
- `schedule` (String) Cron expression (5 fields, UTC) replacing `interval_minutes`.
- `title` (String) Display name.
- `type` (String) Source type (`webhook`, `github`, `azure-devops`, `kubernetes`, `connector`…).
- `webhook_url` (String) Inbound URL (webhook integrations).
