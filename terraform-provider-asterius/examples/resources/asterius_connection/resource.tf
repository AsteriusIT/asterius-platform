resource "asterius_connection" "inventory_prod" {
  identifier = "inventory-prod"
  title      = "Inventory (production)"
  connector  = asterius_connector.inventory.identifier
  fields     = jsonencode({ baseUrl = "https://inventory.example.com" })

  # Credentials are references to asterius_secret values.
  auth = jsonencode({
    type  = "bearer"
    token = "$${secret:${asterius_secret.ingest_token.name}}"
  })
}
