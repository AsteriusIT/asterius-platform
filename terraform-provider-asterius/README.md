# Terraform / OpenTofu provider for the Asterius Platform

Manages the configuration of an Asterius Platform organization through its REST API, with the
[Terraform Plugin Framework](https://developer.hashicorp.com/terraform/plugin/framework) (protocol 6: Terraform 1.0+,
OpenTofu 1.6+; `asterius_secret.value_wo` needs 1.11+).

| Resources | Data sources |
|---|---|
| `asterius_blueprint`, `asterius_entity`, `asterius_action`, `asterius_integration`, `asterius_webhook`, `asterius_team`, `asterius_secret`, `asterius_scorecard`, `asterius_policy`, `asterius_dashboard`, `asterius_connector`, `asterius_connection` | the same, except `asterius_secret` |

Documentation per resource: [docs/](docs/) (Terraform Registry layout, generated). Examples: [examples/](examples/).

```hcl
terraform {
  required_providers {
    asterius = { source = "asteriusit/asterius" }
  }
}

provider "asterius" {
  endpoint     = "https://portal.example.com" # or ASTERIUS_ENDPOINT
  organization = "acme"                       # or ASTERIUS_ORG; default: the token's organization
  # token: ASTERIUS_TOKEN (a personal or service account token, Admin → Tokens)
}

resource "asterius_blueprint" "service" {
  identifier = "service"
  title      = "Service"
  schema     = jsonencode({ properties = { tier = { type = "string", enum = ["gold", "silver"] } } })
}
```

## Design

- **One document per resource**, written with the idempotent `PUT /api/v1/<collection>/<identifier>`, read with `GET`
  (teams: the list, filtered; secrets: the list of names), deleted with `DELETE`. After each write the document is
  read back, so the state is what the server stores.
- **Typed top-level attributes, JSON for nested documents.** Scalars and string lists/maps (identifier, title,
  description, icon, enabled, url, events, team…) are typed attributes. Nested documents whose shape is rich and
  evolving (blueprint `schema` / `relations` / `computed` / `permissions`, action `trigger` / `steps`, integration
  `config` / `mappings`, scorecard `levels` / `rules`, connector `kinds` / `operations`…) are JSON strings written with
  `jsonencode()`. Their type has a semantic equality: a document read from the API equals the configured one when it
  *contains* it, so the defaults the API fills into nested objects (`retries: 0`, `query: {}`…), key order and
  formatting never make a plan churn. Changes made outside Terraform to keys the configuration sets are detected;
  keys it does not set are not. The schema of every document is the `components` of
  [`docs/openapi.json`](../docs/openapi.json) (validated by `apps/server/src/schemas.ts`).
- **Server defaults**: an optional attribute left out takes the server's default (Optional + Computed), except the
  nullable ones (icon, team of a dashboard, webhook secret references…), which a removal clears. Removing an
  Optional + Computed attribute from the configuration keeps the last value; set it explicitly to change it.
- **Output-only fields** (`managed`, `version`, `created_at`, `updated_at`, `webhook_url`, `has_secret`, …) are
  Computed.
- **Create never takes over**: `PUT` is an upsert, so a create first checks the identifier is free and otherwise asks
  for `terraform import`.
- **Managed resources** (declared in the server's `CONFIG_DIR` or the organization's configuration repository) are
  read-only through the API, which answers 409: the provider reports *"… is managed by configuration (CONFIG_DIR)"*.
  They can be imported (to read them) but not changed.
- **Import** by identifier (`terraform import asterius_team.platform platform`); entities by
  `<blueprint>/<identifier>`. Imported JSON attributes hold the full document of the server (with its defaults): the
  first apply after an import rewrites them as configured (the same content), later plans are empty.
- **Secrets are write-only**: `value` is sent and kept (sensitive) in the state, never read back; `value_wo` (with
  `value_wo_version`) is never stored. Other resources hold `${secret:NAME}` references, never values.

## Development

```bash
make build            # bin/terraform-provider-asterius
make vet test         # go vet, gofmt, terraform fmt; unit tests (no server: an in-process fake API; terraform CLI in PATH)
make docs             # regenerate docs/ from the schema and examples/ (a unit test fails when it is stale)

# Acceptance tests against a real server:
make testacc-local    # starts a throwaway server (npm install at the repository root), runs TF_ACC tests and the examples
# or, against a running server:
eval "$(scripts/local-server.sh start)"   # fresh SQLite, admin account, API token → ASTERIUS_* and TF_ACC
make testacc
scripts/examples-e2e.sh                   # every example: apply, empty plan, data sources, import, destroy (TF=tofu works)
scripts/local-server.sh stop
```

From the repository root: `npm run tf:test` (unit) and `npm run tf:testacc` (acceptance).

Use a local build with Terraform through a `dev_overrides` block in `~/.terraformrc`:

```hcl
provider_installation {
  dev_overrides { "asteriusit/asterius" = "/path/to/terraform-provider-asterius/bin" }
  direct {}
}
```

### Adding a resource

A document resource is a `resourceSpec` in `internal/provider/spec.go` (collection, attributes with their JSON keys and
kinds); the generic resource and data source do the rest. Add an example under `examples/resources/<type>/`, an
acceptance test, and run `make docs`.

## Releasing

`.goreleaser.yml` builds the zips, the `SHA256SUMS` (GPG-signed with `GPG_FINGERPRINT`) and the registry manifest the
Terraform and OpenTofu registries expect: `goreleaser release --snapshot --clean --skip=sign` (`make release-snapshot`)
builds them locally into `dist/`. Nothing is published yet: the public registries need a repository named
`terraform-provider-asterius` (a mirror of this directory), a GPG key registered with them, and a tag-triggered release
workflow.
