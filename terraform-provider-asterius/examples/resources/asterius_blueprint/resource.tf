resource "asterius_blueprint" "system" {
  identifier = "system"
  title      = "System"
  icon       = "sitemap"
}

resource "asterius_blueprint" "service" {
  identifier  = "service"
  title       = "Service"
  description = "A deployable service"
  icon        = "server"

  schema = jsonencode({
    properties = {
      tier          = { type = "string", title = "Tier", enum = ["gold", "silver", "bronze"] }
      language      = { type = "string", title = "Language" }
      repositoryUrl = { type = "string", title = "Repository", format = "url" }
    }
    required = ["tier"]
  })

  relations = jsonencode({
    system = { title = "System", target = asterius_blueprint.system.identifier, many = false }
  })
}
