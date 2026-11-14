---
page_title: "asterius_team Data Source - asterius"
subcategory: ""
description: |-
  Reads a Team.
---

# asterius_team (Data Source)

Reads a Team. A team: owner of entities, approver of requests.

## Example Usage

```terraform
data "asterius_team" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `description` (String) Description (default: empty).
- `entra_group_id` (String) Entra ID group whose members join the team at sign-in.
- `id` (String) Same as the resource's `id`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `title` (String) Display name.
