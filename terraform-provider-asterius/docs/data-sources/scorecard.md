---
page_title: "asterius_scorecard Data Source - asterius"
subcategory: ""
description: |-
  Reads a Scorecard.
---

# asterius_scorecard (Data Source)

Reads a Scorecard. A scorecard: levels and rules (JSONata) evaluated on the entities of a blueprint.

## Example Usage

```terraform
data "asterius_scorecard" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `blueprint` (String) Blueprint whose entities are evaluated.
- `description` (String) Description (default: empty).
- `id` (String) Same as the resource's `id`.
- `levels` (String, JSON) Levels from the lowest to the highest (`[{ name, color }]`), as JSON. Decode it with jsondecode().
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `rules` (String, JSON) Rules (`[{ identifier, title, level, expression }]`), as JSON. Decode it with jsondecode().
- `title` (String) Display name.
