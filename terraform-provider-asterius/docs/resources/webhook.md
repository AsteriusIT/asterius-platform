---
page_title: "asterius_webhook Resource - asterius"
subcategory: ""
description: |-
  An outbound webhook: catalog and run events delivered to a URL.
---

# asterius_webhook (Resource)

An outbound webhook: catalog and run events delivered to a URL.

## Example Usage

```terraform
resource "asterius_webhook" "catalog_events" {
  identifier = "catalog-events"
  title      = "Catalog events to the CMDB"
  url        = "https://cmdb.example.com/hooks/asterius"
  events     = ["entity.created", "entity.updated", "entity.deleted"]
  blueprints = [asterius_blueprint.service.identifier]

  # A reference: the value is managed by asterius_secret.
  secret  = "$${secret:${asterius_secret.webhook_signing.name}}"
  headers = { X-Source = "asterius" }
}
```

## Schema

### Required

- `events` (List of String) Events delivered (`entity.created`, `run.completed`…).
- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `title` (String) Display name.
- `url` (String) Destination URL.

### Optional

- `blueprints` (List of String) Only events of these blueprints (default: all).
- `enabled` (Boolean) Enabled (default: `true`).
- `filter` (String) JSONata condition over the event.
- `headers` (Map of String) Extra request headers.
- `secondary_secret` (String) Second signing secret during a rotation, as a `${secret:NAME}` reference.
- `secret` (String) Signing secret, as a `${secret:NAME}` reference.
- `transform` (String) JSONata transformation of the payload.

### Read-Only

- `has_secret` (Boolean) A signing secret is set.
- `id` (String) Same as `identifier`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.

## Import

Import is supported using the following syntax:

```shell
terraform import asterius_webhook.catalog_events catalog-events
```
