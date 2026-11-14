# An inbound webhook: CI pipelines POST services to its webhook_url.
resource "asterius_integration" "ci_services" {
  identifier = "ci-services"
  title      = "Services pushed by CI"
  type       = "webhook"

  config = jsonencode({
    secret = "$${secret:${asterius_secret.ingest_token.name}}"
  })

  mappings = jsonencode([
    {
      entity = {
        blueprint  = asterius_blueprint.service.identifier
        identifier = "body.name"
        title      = "body.title"
        properties = { tier = "body.tier" }
      }
    }
  ])
}

output "ci_services_webhook_url" {
  value = asterius_integration.ci_services.webhook_url
}
