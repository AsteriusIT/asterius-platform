---
page_title: "asterius_blueprint Data Source - asterius"
subcategory: ""
description: |-
  Reads a Blueprint.
---

# asterius_blueprint (Data Source)

Reads a Blueprint. A blueprint: the type of catalog entities (its property schema, relations and computed properties).

## Example Usage

```terraform
data "asterius_blueprint" "service" {
  identifier = "service"
}

output "service_properties" {
  value = keys(jsondecode(data.asterius_blueprint.service.schema).properties)
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `computed` (String, JSON) Computed properties (JSONata over the entity), as JSON. Decode it with jsondecode().
- `created_at` (String) Creation time (ISO 8601).
- `description` (String) Description (default: empty).
- `icon` (String) Icon: a name from the icon set, an `https://` URL or a `data:image/…;base64,` URI.
- `id` (String) Same as the resource's `id`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `permissions` (String, JSON) Per-blueprint permissions (`{ read, create, update, delete }`), as JSON. Decode it with jsondecode().
- `relations` (String, JSON) Relations to other blueprints (`{ name: { target, many, title… } }`), as JSON. Decode it with jsondecode().
- `schema` (String, JSON) Property schema (JSON Schema subset: `{ properties, required }`), as JSON. Decode it with jsondecode().
- `title` (String) Display name.
- `ttl_property` (String) Date property after which entities expire.
- `updated_at` (String) Last change (ISO 8601).
