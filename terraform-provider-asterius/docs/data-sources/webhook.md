---
page_title: "asterius_webhook Data Source - asterius"
subcategory: ""
description: |-
  Reads a Webhook.
---

# asterius_webhook (Data Source)

Reads a Webhook. An outbound webhook: catalog and run events delivered to a URL.

## Example Usage

```terraform
data "asterius_webhook" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `blueprints` (List of String) Only events of these blueprints (default: all).
- `enabled` (Boolean) Enabled (default: `true`).
- `events` (List of String) Events delivered (`entity.created`, `run.completed`…).
- `filter` (String) JSONata condition over the event.
- `has_secret` (Boolean) A signing secret is set.
- `headers` (Map of String) Extra request headers.
- `id` (String) Same as the resource's `id`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `secondary_secret` (String) Second signing secret during a rotation, as a `${secret:NAME}` reference.
- `secret` (String) Signing secret, as a `${secret:NAME}` reference.
- `title` (String) Display name.
- `transform` (String) JSONata transformation of the payload.
- `url` (String) Destination URL.
