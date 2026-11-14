resource "asterius_team" "platform" {
  identifier  = "platform"
  title       = "Platform"
  description = "Builds and runs the internal developer platform."
  # Members of this Entra ID group join the team at sign-in.
  # entra_group_id = "00000000-0000-0000-0000-000000000000"
}
