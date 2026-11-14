resource "asterius_dashboard" "platform_home" {
  identifier = "platform-home"
  title      = "Platform team"
  team       = asterius_team.platform.identifier

  widgets = jsonencode([
    {
      type  = "insights"
      title = "DORA metrics (30 days)"
      width = 12
      days  = 30
    }
  ])
}
