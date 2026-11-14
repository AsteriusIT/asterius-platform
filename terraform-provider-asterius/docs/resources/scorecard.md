---
page_title: "asterius_scorecard Resource - asterius"
subcategory: ""
description: |-
  A scorecard: levels and rules (JSONata) evaluated on the entities of a blueprint.
---

# asterius_scorecard (Resource)

A scorecard: levels and rules (JSONata) evaluated on the entities of a blueprint.

## Example Usage

```terraform
resource "asterius_scorecard" "production_readiness" {
  identifier = "production-readiness"
  title      = "Production readiness"
  blueprint  = asterius_blueprint.service.identifier

  levels = jsonencode([
    { name = "Bronze", color = "orange" },
    { name = "Silver", color = "gray" },
    { name = "Gold", color = "yellow" },
  ])

  rules = jsonencode([
    { identifier = "has_team", title = "Has an owning team", level = "Bronze", expression = "$exists(team)" },
    { identifier = "has_repo", title = "Has a repository", level = "Silver", expression = "$exists(properties.repositoryUrl)" },
    { identifier = "gold_tier", title = "Gold tier", level = "Gold", expression = "properties.tier = 'gold'" },
  ])
}
```

## Schema

### Required

- `blueprint` (String) Blueprint whose entities are evaluated.
- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `levels` (String, JSON) Levels from the lowest to the highest (`[{ name, color }]`), as JSON.
- `rules` (String, JSON) Rules (`[{ identifier, title, level, expression }]`), as JSON.
- `title` (String) Display name.

### Optional

- `description` (String) Description (default: empty).

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
terraform import asterius_scorecard.production_readiness production-readiness
```
