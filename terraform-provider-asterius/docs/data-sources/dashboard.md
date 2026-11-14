---
page_title: "asterius_dashboard Data Source - asterius"
subcategory: ""
description: |-
  Reads a Dashboard.
---

# asterius_dashboard (Data Source)

Reads a Dashboard. A dashboard of widgets (home page of a team, of everyone, or of a blueprint's catalog page).

## Example Usage

```terraform
data "asterius_dashboard" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `blueprint` (String) Shown on the catalog page of this blueprint.
- `default` (Boolean) Home page for everyone (default `false`).
- `description` (String) Description (default: empty).
- `id` (String) Same as the resource's `id`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `team` (String) Default home dashboard of this team.
- `title` (String) Display name.
- `widgets` (String, JSON) Widgets, as JSON. Decode it with jsondecode().
