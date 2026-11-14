terraform {
  required_providers {
    asterius = {
      source  = "asteriusit/asterius"
      version = "~> 0.1"
    }
  }
}

# endpoint and token default to ASTERIUS_ENDPOINT and ASTERIUS_TOKEN, organization to ASTERIUS_ORG.
provider "asterius" {
  endpoint     = "https://portal.example.com"
  organization = "acme"
}
