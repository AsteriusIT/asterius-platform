resource "asterius_policy" "gold_needs_team" {
  identifier  = "gold-needs-team"
  title       = "Gold services have an owner"
  description = "A gold-tier service must name its owning team."
  target      = "entity"
  match       = jsonencode({ blueprints = [asterius_blueprint.service.identifier], operations = ["create", "update"] })
  expression  = "entity.properties.tier != 'gold' or $exists(entity.team)"
  message     = "Gold services need an owning team."
}
