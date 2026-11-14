resource "asterius_webhook" "catalog_events" {
  identifier = "catalog-events"
  title      = "Catalog events to the CMDB"
  url        = "https://cmdb.example.com/hooks/asterius"
  events     = ["entity.created", "entity.updated", "entity.deleted"]
  blueprints = [asterius_blueprint.service.identifier]

  # A reference: the value is managed by asterius_secret.
  secret  = "$${secret:${asterius_secret.webhook_signing.name}}"
  headers = { X-Source = "asterius" }
}
