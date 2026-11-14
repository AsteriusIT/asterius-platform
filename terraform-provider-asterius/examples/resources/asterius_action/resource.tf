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
