---
page_title: "asterius_dashboard Resource - asterius"
subcategory: ""
description: |-
  A dashboard of widgets (home page of a team, of everyone, or of a blueprint's catalog page).
---

# asterius_dashboard (Resource)

A dashboard of widgets (home page of a team, of everyone, or of a blueprint's catalog page).

## Example Usage

```terraform
resource "asterius_dashboard" "platform_home" {
  identifier = "platform-home"
  title      = "Platform team"
  team       = asterius_team.platform.identifier

  widgets = jsonencode([
    {
      type  = "insights"
      title = "DORA metrics (30 days)"
      width = 12
      days  = 30
    }
  ])
}
```

## Schema

### Required

- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `title` (String) Display name.

### Optional

- `blueprint` (String) Shown on the catalog page of this blueprint.
- `default` (Boolean) Home page for everyone (default `false`).
- `description` (String) Description (default: empty).
- `team` (String) Default home dashboard of this team.
- `widgets` (String, JSON) Widgets, as JSON.

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
terraform import asterius_dashboard.platform_home platform-home
```
