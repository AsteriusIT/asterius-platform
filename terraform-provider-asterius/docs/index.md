---
page_title: "asterius Provider"
description: |-
  Manages the configuration of an Asterius Platform organization.
---

# asterius Provider

Manages the configuration of an [Asterius Platform](https://github.com/AsteriusIT/asterius-platform) organization (catalog blueprints and entities, self-service actions, integrations, webhooks, teams, secrets, scorecards, policies, dashboards, connectors and connections) through its REST API.

Authenticate with a personal API token or a service account token (Admin → Tokens). Resources declared in the server's configuration directory (`CONFIG_DIR`) are read-only through the API (409 Conflict): import them to read them, manage them in the configuration files.

Works with Terraform and OpenTofu (`asterius_secret.value_wo` needs 1.11 or later).

## Example Usage

```terraform
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
```

## Schema

### Optional

- `endpoint` (String) Base URL of the platform, e.g. `https://portal.example.com`. Default: `ASTERIUS_ENDPOINT`.
- `organization` (String) Organization (slug) the resources belong to, sent as `X-Asterius-Org`. Default: `ASTERIUS_ORG`, else the organization of the token.
- `token` (String, Sensitive) Personal API token or service account token (Admin → Tokens). Default: `ASTERIUS_TOKEN`.
