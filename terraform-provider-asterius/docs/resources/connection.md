---
page_title: "asterius_connection Resource - asterius"
subcategory: ""
description: |-
  A connection: an instance of a connector (its field values and credentials references).
---

# asterius_connection (Resource)

A connection: an instance of a connector (its field values and credentials references).

## Example Usage

```terraform
resource "asterius_connection" "inventory_prod" {
  identifier = "inventory-prod"
  title      = "Inventory (production)"
  connector  = asterius_connector.inventory.identifier
  fields     = jsonencode({ baseUrl = "https://inventory.example.com" })

  # Credentials are references to asterius_secret values.
  auth = jsonencode({
    type  = "bearer"
    token = "$${secret:${asterius_secret.ingest_token.name}}"
  })
}
```

## Schema

### Required

- `connector` (String) Connector definition (identifier).
- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `title` (String) Display name.

### Optional

- `access` (String) `read` or `read-write` (default `read`).
- `allowed` (String, JSON) Workflows and teams allowed to use it in automation, as JSON.
- `api` (String, JSON) Raw API calls allowed through the connection, as JSON.
- `auth` (String, JSON) Authentication (`{ type, … }`), as JSON. Credentials must be `${secret:NAME}` references.
- `description` (String) Description (default: empty).
- `fields` (String, JSON) Values of the connector's fields, as JSON.

### Read-Only

- `created_at` (String) Creation time (ISO 8601).
- `id` (String) Same as `identifier`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `updated_at` (String) Last change (ISO 8601).
- `version` (Number) Version, incremented on every change.

-> **JSON attributes.** Nested documents (marked *String, JSON*) are written with `jsonencode()` and read with
`jsondecode()`. A document read from the API is equal to the configured one when it contains it: the defaults the
API fills in (nested keys the configuration does not set) are not a difference, nor are formatting and key order.
Changes made outside Terraform to keys the configuration sets are detected; keys it does not set are not.

## Import

Import is supported using the following syntax:

```shell
terraform import asterius_connection.inventory_prod inventory-prod
```
