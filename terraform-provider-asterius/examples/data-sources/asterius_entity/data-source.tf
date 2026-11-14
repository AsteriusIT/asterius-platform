data "asterius_entity" "payments" {
  blueprint  = "service"
  identifier = "payments-api"
}

output "payments_tier" {
  value = jsondecode(data.asterius_entity.payments.properties).tier
}
