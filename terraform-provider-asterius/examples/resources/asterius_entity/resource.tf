resource "asterius_entity" "payments_system" {
  blueprint  = asterius_blueprint.system.identifier
  identifier = "payments"
  title      = "Payments"
}

resource "asterius_entity" "payments" {
  blueprint  = asterius_blueprint.service.identifier
  identifier = "payments-api"
  title      = "Payments API"
  team       = asterius_team.platform.identifier

  properties = jsonencode({
    tier          = "gold"
    language      = "go"
    repositoryUrl = "https://github.com/acme/payments-api"
  })

  relations = jsonencode({
    system = asterius_entity.payments_system.identifier
  })
}
