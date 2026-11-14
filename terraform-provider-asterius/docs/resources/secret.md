---
page_title: "asterius_secret Resource - asterius"
subcategory: ""
description: |-
  An encrypted secret, referenced as `${secret:NAME}` in the other resources.
---

# asterius_secret (Resource)

An encrypted secret, referenced as `${secret:NAME}` in the other resources. The value is write only: the API never returns it, so changes made outside Terraform are not detected. Set either `value` (kept, sensitive, in the Terraform state) or `value_wo` (Terraform 1.11+: never stored; bump `value_wo_version` to send a new value).

## Example Usage

```terraform
variable "ingest_token" {
  type      = string
  sensitive = true
}

# Kept (sensitive) in the Terraform state.
resource "asterius_secret" "ingest_token" {
  name        = "CI_INGEST_TOKEN"
  value       = var.ingest_token
  description = "Token of the CI services webhook"
}

# Terraform 1.11+ / OpenTofu 1.11+: the value is never stored in the state. Bump value_wo_version to rotate it.
resource "asterius_secret" "webhook_signing" {
  name             = "CMDB_WEBHOOK_SECRET"
  value_wo         = var.ingest_token
  value_wo_version = 1
}
```

## Schema

### Required

- `name` (String) Name (`${secret:NAME}`). Changing it replaces the secret.

### Optional

- `description` (String) Description (default: empty).
- `value` (String, Sensitive) Value. Stored in the Terraform state; never read back from the API.
- `value_wo` (String, Sensitive, Write-only) Write-only value (Terraform 1.11+): sent on create and when `value_wo_version` changes, never stored.
- `value_wo_version` (Number) Change it to send `value_wo` again.

### Read-Only

- `id` (String) Same as `name`.
- `updated_at` (String) Last change of the value (ISO 8601).

## Import

Import is supported using the following syntax:

```shell
# The value is not imported (the API never returns it): the next apply sends the configured value.
terraform import asterius_secret.ingest_token CI_INGEST_TOKEN
```
