---
page_title: "asterius_entity Data Source - asterius"
subcategory: ""
description: |-
  Reads a Entity.
---

# asterius_entity (Data Source)

Reads a Entity. A catalog entity of a blueprint. The import identifier is `<blueprint>/<identifier>`. Destroying it moves it to the deleted entities of the server (restorable by an admin until purged).

## Example Usage

```terraform
data "asterius_entity" "payments" {
  blueprint  = "service"
  identifier = "payments-api"
}

output "payments_tier" {
  value = jsondecode(data.asterius_entity.payments.properties).tier
}
```

## Schema

### Required

- `blueprint` (String) Identifier of the blueprint.
- `identifier` (String) Identifier.

### Read-Only

- `computed` (String, JSON) Values of the blueprint's computed properties, as JSON. Decode it with jsondecode().
- `created_at` (String) Creation time (ISO 8601).
- `id` (String) Same as the resource's `id`.
- `properties` (String, JSON) Property values, validated by the blueprint schema, as JSON. Decode it with jsondecode().
- `relations` (String, JSON) Related entities (`{ relation: "id" | ["id"…] }`), as JSON. Decode it with jsondecode().
- `source` (String) What wrote the entity last (`api`, `ui`, an integration…).
- `team` (String) Owning team (identifier).
- `title` (String) Display name (default: the identifier).
- `updated_at` (String) Last change (ISO 8601).
- `version` (Number) Version, incremented on every change.
