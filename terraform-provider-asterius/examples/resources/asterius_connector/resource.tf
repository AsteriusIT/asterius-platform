resource "asterius_connector" "inventory" {
  identifier  = "inventory"
  title       = "Inventory"
  description = "Hosts of the in-house inventory API."
  category    = "other"

  fields = jsonencode({
    properties = {
      baseUrl = { type = "string", title = "Server URL", default = "https://inventory.example.com" }
    }
  })

  auth = jsonencode([{ type = "bearer", title = "API token" }])

  test = jsonencode({ method = "GET", path = "/health" })

  kinds = jsonencode({
    host = { title = "Hosts", method = "GET", path = "/hosts", itemsPath = "items" }
  })
}
