---
page_title: "asterius_connection Data Source - asterius"
subcategory: ""
description: |-
  Reads a Connection.
---

# asterius_connection (Data Source)

Reads a Connection. A connection: an instance of a connector (its field values and credentials references).

## Example Usage

```terraform
data "asterius_connection" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `access` (String) `read` or `read-write` (default `read`).
- `allowed` (String, JSON) Workflows and teams allowed to use it in automation, as JSON. Decode it with jsondecode().
- `api` (String, JSON) Raw API calls allowed through the connection, as JSON. Decode it with jsondecode().
- `auth` (String, JSON) Authentication (`{ type, … }`), as JSON. Credentials must be `${secret:NAME}` references. Decode it with jsondecode().
- `connector` (String) Connector definition (identifier).
- `created_at` (String) Creation time (ISO 8601).
- `description` (String) Description (default: empty).
- `fields` (String, JSON) Values of the connector's fields, as JSON. Decode it with jsondecode().
- `id` (String) Same as the resource's `id`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `title` (String) Display name.
- `updated_at` (String) Last change (ISO 8601).
- `version` (Number) Version, incremented on every change.
