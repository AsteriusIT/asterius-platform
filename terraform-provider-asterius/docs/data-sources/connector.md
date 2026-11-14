---
page_title: "asterius_connector Data Source - asterius"
subcategory: ""
description: |-
  Reads a Connector.
---

# asterius_connector (Data Source)

Reads a Connector. A connector definition: a declarative HTTP API (connection form, authentication, kinds to ingest, operations).

## Example Usage

```terraform
data "asterius_connector" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `auth` (String, JSON) Supported authentication methods, as JSON. Decode it with jsondecode().
- `auth_optional` (Boolean) Connections may omit authentication (default `false`).
- `builtin` (Boolean) Shipped with the platform.
- `category` (String) Category (default `other`).
- `description` (String) Description (default: empty).
- `example` (String, JSON) Example connection, as JSON. Decode it with jsondecode().
- `fields` (String, JSON) Connection form (object schema declaring `baseUrl`), as JSON. Decode it with jsondecode().
- `headers` (String, JSON) Headers sent with every request, as JSON. Decode it with jsondecode().
- `icon` (String) Icon: a name from the icon set, an `https://` URL or a `data:image/…;base64,` URI.
- `id` (String) Same as the resource's `id`.
- `kinds` (String, JSON) Item kinds an integration can ingest, as JSON. Decode it with jsondecode().
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `operations` (String, JSON) Operations workflow steps can call, as JSON. Decode it with jsondecode().
- `test` (String, JSON) Request of "Test connection", as JSON. Decode it with jsondecode().
- `title` (String) Display name.
- `updated_at` (String) Last change (ISO 8601).
- `version` (Number) Version, incremented on every change.
