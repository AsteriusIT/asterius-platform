---
page_title: "asterius_action Resource - asterius"
subcategory: ""
description: |-
  A self-service action (workflow): its trigger and form, invoker or steps, approvals and options.
---

# asterius_action (Resource)

A self-service action (workflow): its trigger and form, invoker or steps, approvals and options.

## Example Usage

```terraform
resource "asterius_action" "register_service" {
  identifier  = "register-service"
  title       = "Register a service"
  description = "Add an existing service to the catalog."
  icon        = "plus"

  trigger = jsonencode({
    type      = "form"
    on        = "create"
    blueprint = asterius_blueprint.service.identifier
    inputs = {
      properties = {
        name = { type = "string", title = "Name", pattern = "^[a-z][a-z0-9-]{2,40}$" }
        team = { type = "string", title = "Owning team", format = "team" }
        tier = { type = "string", title = "Tier", enum = ["gold", "silver", "bronze"] }
      }
      required = ["name", "team", "tier"]
    }
  })

  steps = jsonencode([
    {
      id   = "register"
      name = "Register the service"
      type = "invoke"
      invoker = {
        type       = "catalog"
        operation  = "upsert"
        blueprint  = asterius_blueprint.service.identifier
        identifier = "{{ inputs.name }}"
        team       = "{{ inputs.team }}"
        properties = { tier = "{{ inputs.tier }}" }
      }
    }
  ])
}
```

## Schema

### Required

- `identifier` (String) Identifier (lowercase letters, digits, `-` and `_`, starting with a letter). Changing it replaces the resource.
- `title` (String) Display name.

### Optional

- `blackout_mode` (String) Behaviour during a blackout window.
- `blackouts` (String, JSON) Blackout windows, as JSON.
- `concurrency` (String, JSON) Concurrency limits, as JSON.
- `description` (String) Description (default: empty).
- `enabled` (Boolean) Enabled (default: `true`).
- `icon` (String) Icon: a name from the icon set, an `https://` URL or a `data:image/…;base64,` URI.
- `invoker` (String, JSON) Single-step invoker (`{ type, … }`), as JSON. Prefer `steps`.
- `outputs` (String, JSON) Outputs of a run, as JSON.
- `priority` (Number) Queue priority of runs.
- `secrets` (List of String) Secrets the steps may reference.
- `sla_minutes` (Number) Expected duration of a run, in minutes.
- `steps` (String, JSON) Steps of the workflow, as JSON.
- `tests` (String, JSON) Workflow tests, as JSON.
- `trigger` (String, JSON) Trigger (`form`, `event`, `schedule`, `webhook`…) with its inputs, as JSON.
- `vars` (String, JSON) Variables available to the steps, as JSON.

### Read-Only

- `id` (String) Same as `identifier`.
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `version` (Number) Version, incremented on every change.

-> **JSON attributes.** Nested documents (marked *String, JSON*) are written with `jsonencode()` and read with
`jsondecode()`. A document read from the API is equal to the configured one when it contains it: the defaults the
API fills in (nested keys the configuration does not set) are not a difference, nor are formatting and key order.
Changes made outside Terraform to keys the configuration sets are detected; keys it does not set are not.

## Import

Import is supported using the following syntax:

```shell
terraform import asterius_action.register_service register-service
```
