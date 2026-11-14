variable "ingest_token" {
  type      = string
  sensitive = true
}

# Kept (sensitive) in the Terraform state.
resource "asterius_secret" "ingest_token" {
  name        = "CI_INGEST_TOKEN"
  value       = var.ingest_token
  description = "Token of the CI services webhook"
}

# Terraform 1.11+ / OpenTofu 1.11+: the value is never stored in the state. Bump value_wo_version to rotate it.
resource "asterius_secret" "webhook_signing" {
  name             = "CMDB_WEBHOOK_SECRET"
  value_wo         = var.ingest_token
  value_wo_version = 1
}
