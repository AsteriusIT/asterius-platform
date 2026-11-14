---
page_title: "asterius_policy Data Source - asterius"
subcategory: ""
description: |-
  Reads a Policy.
---

# asterius_policy (Data Source)

Reads a Policy. A policy: a JSONata guard evaluated on writes (entities, runs…).

## Example Usage

```terraform
data "asterius_policy" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `description` (String) Description (default: empty).
- `enabled` (Boolean) Enabled (default: `true`).
- `expression` (String) JSONata expression: the write is allowed when it is truthy.
- `id` (String) Same as the resource's `id`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `match` (String, JSON) Which writes it applies to, as JSON. Decode it with jsondecode().
- `message` (String) Message of a denial.
- `target` (String) What the policy guards (e.g. `entity`, `run`).
- `title` (String) Display name.
