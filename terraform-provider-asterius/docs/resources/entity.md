---
page_title: "asterius_entity Resource - asterius"
subcategory: ""
description: |-
  A catalog entity of a blueprint.
---

# asterius_entity (Resource)

A catalog entity of a blueprint. The import identifier is `<blueprint>/<identifier>`. Destroying it moves it to the deleted entities of the server (restorable by an admin until purged).

## Example Usage

```terraform
resource "asterius_entity" "payments_system" {
  blueprint  = asterius_blueprint.system.identifier
  identifier = "payments"
  title      = "Payments"
}

resource "asterius_entity" "payments" {
  blueprint  = asterius_blueprint.service.identifier
  identifier = "payments-api"
  title      = "Payments API"
  team       = asterius_team.platform.identifier

  properties = jsonencode({
    tier          = "gold"
    language      = "go"
    repositoryUrl = "https://github.com/acme/payments-api"
  })

  relations = jsonencode({
    system = asterius_entity.payments_system.identifier
  })
}
```

## Schema

### Required

- `blueprint` (String) Blueprint of the entity. Changing it replaces the entity.
- `identifier` (String) Identifier of the entity in its blueprint. Changing it replaces the entity.

### Optional

- `properties` (String, JSON) Property values, validated by the blueprint schema, as JSON.
- `relations` (String, JSON) Related entities (`{ relation: "id" | ["id"…] }`), as JSON.
- `team` (String) Owning team (identifier).
- `title` (String) Display name (default: the identifier).

### Read-Only

- `computed` (String, JSON) Values of the blueprint's computed properties, as JSON.
- `created_at` (String) Creation time (ISO 8601).
- `id` (String) `<blueprint>/<identifier>`.
- `source` (String) What wrote the entity last (`api`, `ui`, an integration…).
- `updated_at` (String) Last change (ISO 8601).
- `version` (Number) Version, incremented on every change.

-> **JSON attributes.** Nested documents (marked *String, JSON*) are written with `jsonencode()` and read with
`jsondecode()`. A document read from the API is equal to the configured one when it contains it: the defaults the
API fills in (nested keys the configuration does not set) are not a difference, nor are formatting and key order.
Changes made outside Terraform to keys the configuration sets are detected; keys it does not set are not.

## Import

Import is supported using the following syntax:

```shell
# <blueprint>/<identifier>
terraform import asterius_entity.payments service/payments-api
```
