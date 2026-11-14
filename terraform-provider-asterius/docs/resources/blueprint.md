---
page_title: "asterius_blueprint Resource - asterius"
subcategory: ""
description: |-
  A blueprint: the type of catalog entities (its property schema, relations and computed properties).
---

# asterius_blueprint (Resource)

A blueprint: the type of catalog entities (its property schema, relations and computed properties).

## Example Usage

```terraform
resource "asterius_blueprint" "system" {
  identifier = "system"
  title      = "System"
  icon       = "sitemap"
}

resource "asterius_blueprint" "service" {
  identifier  = "service"
  title       = "Service"
  description = "A deployable service"
  icon        = "server"

  schema = jsonencode({
    properties = {
      tier          = { type = "string", title = "Tier", enum = ["gold", "silver", "bronze"] }
      language      = { type = "string", title = "Language" }
      repositoryUrl = { type = "string", title = "Repository", format = "url" }
    }
    required = ["tier"]
  })

  relations = jsonencode({
    system = { title = "System", target = asterius_blueprint.system.identifier, many = false }
  })
}
```

## Schema

### Required

- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `title` (String) Display name.

### Optional

- `computed` (String, JSON) Computed properties (JSONata over the entity), as JSON.
- `description` (String) Description (default: empty).
- `icon` (String) Icon: a name from the icon set, an `https://` URL or a `data:image/…;base64,` URI.
- `permissions` (String, JSON) Per-blueprint permissions (`{ read, create, update, delete }`), as JSON.
- `relations` (String, JSON) Relations to other blueprints (`{ name: { target, many, title… } }`), as JSON.
- `schema` (String, JSON) Property schema (JSON Schema subset: `{ properties, required }`), as JSON.
- `ttl_property` (String) Date property after which entities expire.

### Read-Only

- `created_at` (String) Creation time (ISO 8601).
- `id` (String) Same as `identifier`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `updated_at` (String) Last change (ISO 8601).

-> **JSON attributes.** Nested documents (marked *String, JSON*) are written with `jsonencode()` and read with
`jsondecode()`. A document read from the API is equal to the configured one when it contains it: the defaults the
API fills in (nested keys the configuration does not set) are not a difference, nor are formatting and key order.
Changes made outside Terraform to keys the configuration sets are detected; keys it does not set are not.

## Import

Import is supported using the following syntax:

```shell
# The identifier of the blueprint.
terraform import asterius_blueprint.service service
```
