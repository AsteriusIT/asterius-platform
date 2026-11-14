---
page_title: "asterius_policy Resource - asterius"
subcategory: ""
description: |-
  A policy: a JSONata guard evaluated on writes (entities, runs…).
---

# asterius_policy (Resource)

A policy: a JSONata guard evaluated on writes (entities, runs…).

## Example Usage

```terraform
resource "asterius_policy" "gold_needs_team" {
  identifier  = "gold-needs-team"
  title       = "Gold services have an owner"
  description = "A gold-tier service must name its owning team."
  target      = "entity"
  match       = jsonencode({ blueprints = [asterius_blueprint.service.identifier], operations = ["create", "update"] })
  expression  = "entity.properties.tier != 'gold' or $exists(entity.team)"
  message     = "Gold services need an owning team."
}
```

## Schema

### Required

- `expression` (String) JSONata expression: the write is allowed when it is truthy.
- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `target` (String) What the policy guards (e.g. `entity`, `run`).
- `title` (String) Display name.

### Optional

- `description` (String) Description (default: empty).
- `enabled` (Boolean) Enabled (default: `true`).
- `match` (String, JSON) Which writes it applies to, as JSON.
- `message` (String) Message of a denial.

### Read-Only

- `id` (String) Same as `identifier`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.

-> **JSON attributes.** Nested documents (marked *String, JSON*) are written with `jsonencode()` and read with
`jsondecode()`. A document read from the API is equal to the configured one when it contains it: the defaults the
API fills in (nested keys the configuration does not set) are not a difference, nor are formatting and key order.
Changes made outside Terraform to keys the configuration sets are detected; keys it does not set are not.

## Import

Import is supported using the following syntax:

```shell
terraform import asterius_policy.gold_needs_team gold-needs-team
```
