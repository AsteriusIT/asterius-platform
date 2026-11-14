resource "asterius_scorecard" "production_readiness" {
  identifier = "production-readiness"
  title      = "Production readiness"
  blueprint  = asterius_blueprint.service.identifier

  levels = jsonencode([
    { name = "Bronze", color = "orange" },
    { name = "Silver", color = "gray" },
    { name = "Gold", color = "yellow" },
  ])

  rules = jsonencode([
    { identifier = "has_team", title = "Has an owning team", level = "Bronze", expression = "$exists(team)" },
    { identifier = "has_repo", title = "Has a repository", level = "Silver", expression = "$exists(properties.repositoryUrl)" },
    { identifier = "gold_tier", title = "Gold tier", level = "Gold", expression = "properties.tier = 'gold'" },
  ])
}
