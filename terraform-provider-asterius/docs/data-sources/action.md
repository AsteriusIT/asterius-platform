---
page_title: "asterius_action Data Source - asterius"
subcategory: ""
description: |-
  Reads a Action.
---

# asterius_action (Data Source)

Reads a Action. A self-service action (workflow): its trigger and form, invoker or steps, approvals and options.

## Example Usage

```terraform
data "asterius_action" "example" {
  identifier = "example"
}
```

## Schema

### Required

- `identifier` (String) Identifier.

### Read-Only

- `blackout_mode` (String) Behaviour during a blackout window.
- `blackouts` (String, JSON) Blackout windows, as JSON. Decode it with jsondecode().
- `concurrency` (String, JSON) Concurrency limits, as JSON. Decode it with jsondecode().
- `description` (String) Description (default: empty).
- `enabled` (Boolean) Enabled (default: `true`).
- `icon` (String) Icon: a name from the icon set, an `https://` URL or a `data:image/…;base64,` URI.
- `id` (String) Same as the resource's `id`.
- `invoker` (String, JSON) Single-step invoker (`{ type, … }`), as JSON. Prefer `steps`. Decode it with jsondecode().
- `managed` (Boolean) Declared in the server's configuration directory (CONFIG_DIR): read-only through the API.
- `outputs` (String, JSON) Outputs of a run, as JSON. Decode it with jsondecode().
- `priority` (Number) Queue priority of runs.
- `secrets` (List of String) Secrets the steps may reference.
- `sla_minutes` (Number) Expected duration of a run, in minutes.
- `steps` (String, JSON) Steps of the workflow, as JSON. Decode it with jsondecode().
- `tests` (String, JSON) Workflow tests, as JSON. Decode it with jsondecode().
- `title` (String) Display name.
- `trigger` (String, JSON) Trigger (`form`, `event`, `schedule`, `webhook`…) with its inputs, as JSON. Decode it with jsondecode().
- `vars` (String, JSON) Variables available to the steps, as JSON. Decode it with jsondecode().
- `version` (Number) Version, incremented on every change.
