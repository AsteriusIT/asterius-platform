data "asterius_blueprint" "service" {
  identifier = "service"
}

output "service_properties" {
  value = keys(jsondecode(data.asterius_blueprint.service.schema).properties)
}
