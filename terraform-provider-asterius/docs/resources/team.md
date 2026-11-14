---
page_title: "asterius_team Resource - asterius"
subcategory: ""
description: |-
  A team: owner of entities, approver of requests.
---

# asterius_team (Resource)

A team: owner of entities, approver of requests.

## Example Usage

```terraform
resource "asterius_team" "platform" {
  identifier  = "platform"
  title       = "Platform"
  description = "Builds and runs the internal developer platform."
  # Members of this Entra ID group join the team at sign-in.
  # entra_group_id = "00000000-0000-0000-0000-000000000000"
}
```

## Schema

### Required

- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `title` (String) Display name.

### Optional

- `description` (String) Description (default: empty).
- `entra_group_id` (String) Entra ID group whose members join the team at sign-in.

### Read-Only

- `id` (String) Same as `identifier`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.

## Import

Import is supported using the following syntax:

```shell
terraform import asterius_team.platform platform
```
