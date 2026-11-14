---
page_title: "asterius_connector Resource - asterius"
subcategory: ""
description: |-
  A connector definition: a declarative HTTP API (connection form, authentication, kinds to ingest, operations).
---

# asterius_connector (Resource)

A connector definition: a declarative HTTP API (connection form, authentication, kinds to ingest, operations).

## Example Usage

```terraform
resource "asterius_connector" "inventory" {
  identifier  = "inventory"
  title       = "Inventory"
  description = "Hosts of the in-house inventory API."
  category    = "other"

  fields = jsonencode({
    properties = {
      baseUrl = { type = "string", title = "Server URL", default = "https://inventory.example.com" }
    }
  })

  auth = jsonencode([{ type = "bearer", title = "API token" }])

  test = jsonencode({ method = "GET", path = "/health" })

  kinds = jsonencode({
    host = { title = "Hosts", method = "GET", path = "/hosts", itemsPath = "items" }
  })
}
```

## Schema

### Required

- `fields` (String, JSON) Connection form (object schema declaring `baseUrl`), as JSON.
- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `title` (String) Display name.

### Optional

- `auth` (String, JSON) Supported authentication methods, as JSON.
- `auth_optional` (Boolean) Connections may omit authentication (default `false`).
- `category` (String) Category (default `other`).
- `description` (String) Description (default: empty).
- `example` (String, JSON) Example connection, as JSON.
- `headers` (String, JSON) Headers sent with every request, as JSON.
- `icon` (String) Icon: a name from the icon set, an `https://` URL or a `data:image/…;base64,` URI.
- `kinds` (String, JSON) Item kinds an integration can ingest, as JSON.
- `operations` (String, JSON) Operations workflow steps can call, as JSON.
- `test` (String, JSON) Request of "Test connection", as JSON.

### Read-Only

- `builtin` (Boolean) Shipped with the platform.
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
terraform import asterius_connector.inventory inventory
```
